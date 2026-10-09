"""Text tools, mirroring pages/text-tools.js. POST /api/text/<action> with {text, arg, params} -> {text, message}.
POST /api/text/compare with {a, b, mode, ignore_case, ignore_ws} -> {ops: [{t: same|add|del, v}]}."""
import base64
import difflib
import html
import random
import re
import unicodedata
from urllib.parse import quote, unquote

from flask import jsonify, request

from .core import Fail, bp

MAX_TEXT = 50_000_000


def plural(n, word):
    return f"{n:,} {word}{'' if n == 1 else 's'}"


def lines(s):
    return re.split(r"\r?\n", s)


# ---------- search ----------
def _expand(m, rep):
    """JavaScript-style replacement: $1, $<name>, $&, $$."""
    def one(t):
        g = t.group(1)
        if g == "$": return "$"
        if g == "&": return m.group(0)
        if g.startswith("<"):
            try: return m.group(g[1:-1]) or ""
            except (IndexError, error_type): return ""
        n = int(g)
        if n > m.re.groups and len(g) == 2: n, tail = int(g[0]), g[1]
        else: tail = ""
        return ((m.group(n) or "") + tail) if 0 < n <= m.re.groups else t.group(0)
    return re.sub(r"\$(\$|&|<\w+>|\d{1,2})", one, rep)


error_type = re.error


def regex(p, pattern, prefix, glob=True):
    if not pattern:
        raise Fail("Enter something to find.")
    src = pattern if p.get(prefix + "_regex") else re.escape(pattern)
    src = re.sub(r"\(\?<([A-Za-z_]\w*)>", r"(?P<\1>", src)        # JS named groups -> Python
    if p.get(prefix + "_word"):
        src = rf"\b(?:{src})\b"
    try:
        return re.compile(src, re.M | (0 if p.get(prefix + "_case") else re.I))
    except re.error as e:
        raise Fail("Invalid regular expression: " + str(e))


def count(rx, text):
    return sum(1 for _ in rx.finditer(text))


# ---------- case ----------
def words(line):
    out, prev = [], ""
    for ch in line:
        if prev and (prev.islower() or prev.isdigit()) and ch.isupper():
            out.append(" ")
        out.append(ch)
        prev = ch
    return [w for w in re.split(r"[\W_]+", "".join(out)) if w]


def cap(w):
    return w[:1].upper() + w[1:].lower()


def per_line(fn):
    return lambda s: "\n".join(fn(words(l)) for l in lines(s))


def title(s):
    out, prev = [], ""
    for ch in s.lower():
        out.append(ch.upper() if ch.isalpha() and not (prev.isalnum() or prev == "'") else ch)
        prev = ch
    return "".join(out)


CASES = {
    "upper": str.upper,
    "lower": str.lower,
    "title": title,
    "sentence": lambda s: re.sub(r"(^\s*|[.!?]\s+)([^\W\d_])", lambda m: m.group(1) + m.group(2).upper(), s.lower()),
    "swap": lambda s: "".join(c.lower() if c == c.upper() else c.upper() for c in s),
    "camel": per_line(lambda w: "".join(x.lower() if i == 0 else cap(x) for i, x in enumerate(w))),
    "pascal": per_line(lambda w: "".join(map(cap, w))),
    "snake": per_line(lambda w: "_".join(x.lower() for x in w)),
    "kebab": per_line(lambda w: "-".join(x.lower() for x in w)),
    "constant": per_line(lambda w: "_".join(x.upper() for x in w)),
}


# ---------- encoding ----------
def b64dec(s):
    try:
        return base64.b64decode(s.strip(), validate=False).decode("utf-8")
    except Exception:
        raise Fail("Input is not valid Base64 text.")


def urldec(s):
    try:
        return unquote(s, errors="strict")
    except Exception:
        raise Fail("Input is not a valid URL-encoded string.")


ENCODERS = {
    "b64enc": lambda s: base64.b64encode(s.encode("utf-8")).decode("ascii"),
    "b64dec": b64dec,
    "urlenc": lambda s: quote(s, safe="-_.!~*'()"),
    "urldec": urldec,
    "htmlesc": lambda s: s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;").replace("'", "&#39;"),
    "htmlunesc": html.unescape,
    "reverse": lambda s: s[::-1],
}

PATTERNS = {
    "emails": re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
    "urls": re.compile(r"https?://[^\s<>\"')]+"),
    "numbers": re.compile(r"-?[0-9]+(?:[.,][0-9]+)*"),
}


def natural_key(s):
    return [int(t) if t.isdigit() else t.casefold() for t in re.split(r"(\d+)", s)]


# ---------- actions: (params, text, arg) -> (text, message) ----------
def replace_all(p, t, arg):
    rx = regex(p, p.get("find", ""), "rp")
    use = bool(p.get("rp_regex"))
    rep = p.get("replace", "")
    if use:
        rep = rep.replace("\\n", "\n").replace("\\t", "\t")
    n = count(rx, t)
    return rx.sub((lambda m: _expand(m, rep)) if use else (lambda m: rep), t), f"Replaced {plural(n, 'match')}."


def delete_matches(p, t, arg):
    rx = regex(p, p.get("find", ""), "rp")
    return rx.sub("", t), f"Deleted {plural(count(rx, t), 'match')}."


def delete_something(p, t, arg):
    mode = p.get("del_mode", "text")
    if mode == "text":
        rx = regex(p, p.get("del_find", ""), "del")
        return rx.sub("", t), f"Deleted {plural(count(rx, t), 'occurrence')}."
    rx = regex(p, p.get("del_find", ""), "del", False)
    all_ = lines(t)
    kept = [l for l in all_ if (not rx.search(l) if mode == "contain" else rx.search(l))]
    return "\n".join(kept), f"Deleted {plural(len(all_) - len(kept), 'line')}."


def sort_lines(p, t, arg):
    key = natural_key if p.get("ln_natural") else str.casefold
    out = sorted(lines(t), key=key)
    if arg == "desc": out.reverse()
    return "\n".join(out), f"Sorted {plural(len(out), 'line')}."


def shuffle(p, t, arg):
    a = lines(t)
    random.shuffle(a)
    return "\n".join(a), f"Shuffled {plural(len(a), 'line')}."


def dedupe(p, t, arg):
    ic, seen, kept = p.get("ln_ignorecase"), set(), []
    all_ = lines(t)
    for l in all_:
        k = l.lower() if ic else l
        if k not in seen:
            seen.add(k)
            kept.append(l)
    return "\n".join(kept), f"Removed {plural(len(all_) - len(kept), 'duplicate')}."


def remove_empty(p, t, arg):
    all_ = lines(t)
    kept = [l for l in all_ if l.strip()]
    return "\n".join(kept), f"Removed {plural(len(all_) - len(kept), 'empty line')}."


def number(p, t, arg):
    all_ = lines(t)
    w = len(str(len(all_)))
    return "\n".join(f"{str(i + 1).rjust(w)}. {l}" for i, l in enumerate(all_)), "Lines numbered."


def split(p, t, arg):
    sep = p.get("ln_sep", "")
    if not sep: raise Fail("Enter a separator.")
    parts = t.split(sep)
    return "\n".join(parts), f"Split into {plural(len(parts), 'line')}."


def extract(p, t, arg):
    found = PATTERNS[arg].findall(t) if arg in PATTERNS else []
    found = [m if isinstance(m, str) else m[0] for m in found]
    if p.get("ex_unique"): found = list(dict.fromkeys(found))
    return "\n".join(found), f"Found {plural(len(found), 'result')}." if found else "No matches found."


def word_freq(p, t, arg):
    counts = {}
    for w in re.findall(r"(?:[^\W_]|')+", t.lower()):
        counts[w] = counts.get(w, 0) + 1
    rows = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return "\n".join(f"{n}\t{w}" for w, n in rows), f"{plural(len(rows), 'unique word')}."


def encode(p, t, arg):
    if arg not in ENCODERS: raise Fail("Unknown conversion.")
    return ENCODERS[arg](t), "Done."


def change_case(p, t, arg):
    if arg not in CASES: raise Fail("Unknown case.")
    return CASES[arg](t), "Case converted."


ACTIONS = {
    "replaceAll": replace_all,
    "deleteMatches": delete_matches,
    "deleteSomething": delete_something,
    "case": change_case,
    "sort": sort_lines,
    "reverseLines": lambda p, t, a: ("\n".join(reversed(lines(t))), "Line order reversed."),
    "shuffle": shuffle,
    "dedupe": dedupe,
    "removeEmpty": remove_empty,
    "number": number,
    "affix": lambda p, t, a: ("\n".join(p.get("ln_prefix", "") + l + p.get("ln_suffix", "") for l in lines(t)), "Prefix and suffix added."),
    "join": lambda p, t, a: (p.get("ln_sep", "").join(lines(t)), "Lines joined."),
    "split": split,
    "trimLines": lambda p, t, a: ("\n".join(l.strip() for l in lines(t)), "Lines trimmed."),
    "collapseSpaces": lambda p, t, a: (re.sub(r"[^\S\r\n]{2,}", " ", t), "Repeated spaces collapsed."),
    "collapseBlank": lambda p, t, a: (re.sub(r"(\r?\n){3,}", "\n\n", t), "Repeated blank lines collapsed."),
    "removeBreaks": lambda p, t, a: (re.sub(r"\s*\r?\n\s*", " ", t).strip(), "Line breaks removed."),
    "stripTags": lambda p, t, a: (re.sub(r"<[^>]*>", "", t), "HTML tags removed."),
    "stripAccents": lambda p, t, a: ("".join(c for c in unicodedata.normalize("NFD", t) if not unicodedata.category(c).startswith("M")), "Accents removed."),
    "straightenQuotes": lambda p, t, a: (re.sub("[\u201C\u201D\u201E\u201F]", '"', re.sub("[\u2018\u2019\u201A\u201B]", "'", t)), "Quotes straightened."),
    "extract": extract,
    "wordFreq": word_freq,
    "encode": encode,
}


@bp.post("/text/compare")
def compare():
    d = request.get_json(silent=True) or {}
    a, b = str(d.get("a", "")), str(d.get("b", ""))
    by_lines = d.get("mode", "lines") == "lines"
    tok = (lambda s: [] if s == "" else lines(s)) if by_lines else (lambda s: [t for t in re.split(r"(\s+)", s) if t])

    def key(t):
        if d.get("ignore_ws"): t = re.sub(r"\s+", " ", t).strip()
        return t.lower() if d.get("ignore_case") else t

    A, B = tok(a), tok(b)
    if len(A) + len(B) > 200_000:
        raise Fail("These texts are too large to compare.")
    ops = []
    sm = difflib.SequenceMatcher(None, [key(t) for t in A], [key(t) for t in B], autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            ops += [{"t": "same", "v": v} for v in B[j1:j2]]
        else:
            ops += [{"t": "del", "v": v} for v in A[i1:i2]] + [{"t": "add", "v": v} for v in B[j1:j2]]
    return jsonify(ops=ops)


@bp.post("/text/<action>")
def run_action(action):
    fn = ACTIONS.get(action)
    if not fn:
        raise Fail("Unknown action.")
    d = request.get_json(silent=True) or {}
    text = str(d.get("text", ""))
    if len(text) > MAX_TEXT:
        raise Fail("That text is too large for the server.")
    out, message = fn(d.get("params") or {}, text, d.get("arg"))
    return jsonify(text=out, message=message)
