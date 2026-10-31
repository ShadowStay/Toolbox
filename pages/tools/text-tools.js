// Page script for pages/text-tools.html. Processing happens in the browser, or on the server (processing/text.py)
// when "On the server" is chosen in Options. Both paths use the same panels and give the same results.
(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const input = $("#input");
  const output = $("#output");
  const status = $("#status");

  const val = (id) => $("#" + id).value;
  const checked = (id) => $("#" + id).checked;
  const splitLines = (s) => s.split(/\r?\n/);
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

  // ---------- shared helpers ----------
  function buildRegex(pattern, prefix, global = true) {
    if (!pattern) throw new Error("Enter something to find.");
    let src = checked(prefix + "-regex") ? pattern : escapeRe(pattern);
    if (checked(prefix + "-word")) src = `\\b(?:${src})\\b`;
    const flags = (global ? "g" : "") + (checked(prefix + "-case") ? "" : "i") + "m";
    try {
      return new RegExp(src, flags);
    } catch (e) {
      throw new Error("Invalid regular expression: " + e.message);
    }
  }

  const countMatches = (re, text) => [...text.matchAll(re)].length;

  function stats(s) {
    const chars = [...s].length;
    const words = (s.trim().match(/\S+/g) || []).length;
    const lineCount = s ? splitLines(s).length : 0;
    return `${plural(chars, "character")}, ${plural(words, "word")}, ${plural(lineCount, "line")}`;
  }

  function updateStats() {
    $("#input-stats").textContent = stats(input.value);
    $("#output-stats").textContent = output.value ? stats(output.value) : "";
  }

  function done(text, message) {
    output.value = text;
    status.textContent = message;
    updateStats();
  }

  // ---------- case conversion ----------
  const words = (line) =>
    line.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  const perLine = (fn) => (s) => splitLines(s).map((l) => fn(words(l))).join("\n");

  const caseOps = {
    upper: (s) => s.toUpperCase(),
    lower: (s) => s.toLowerCase(),
    title: (s) => s.toLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()),
    sentence: (s) => s.toLowerCase().replace(/(^\s*|[.!?]\s+)(\p{L})/gu, (_, a, b) => a + b.toUpperCase()),
    swap: (s) => [...s].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join(""),
    camel: perLine((w) => w.map((x, i) => (i ? cap(x) : x.toLowerCase())).join("")),
    pascal: perLine((w) => w.map(cap).join("")),
    snake: perLine((w) => w.map((x) => x.toLowerCase()).join("_")),
    kebab: perLine((w) => w.map((x) => x.toLowerCase()).join("-")),
    constant: perLine((w) => w.map((x) => x.toUpperCase()).join("_")),
  };

  // ---------- encoding ----------
  const b64enc = (s) => btoa(Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join(""));
  const b64dec = (s) => {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0)));
    } catch {
      throw new Error("Input is not valid Base64 text.");
    }
  };
  const urldec = (s) => {
    try { return decodeURIComponent(s); } catch { throw new Error("Input is not a valid URL-encoded string."); }
  };
  const htmlesc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const htmlunesc = (s) => {
    const t = document.createElement("textarea");
    t.innerHTML = s;
    return t.value;
  };
  const encoders = {
    b64enc, b64dec, urlenc: encodeURIComponent, urldec, htmlesc, htmlunesc,
    reverse: (s) => Array.from(s).reverse().join(""),
  };

  // ---------- extraction ----------
  const patterns = {
    emails: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    urls: /https?:\/\/[^\s<>"')]+/g,
    numbers: /-?\d+(?:[.,]\d+)*/g,
  };

  // ---------- actions (called from buttons via data-action / data-arg) ----------
  const actions = {
    replaceAll() {
      const re = buildRegex(val("find"), "rp");
      const useRegex = checked("rp-regex");
      let rep = val("replace");
      if (useRegex) rep = rep.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
      const n = countMatches(re, input.value);
      done(input.value.replace(re, useRegex ? rep : () => rep), `Replaced ${plural(n, "match")}.`);
    },

    deleteMatches() {
      const re = buildRegex(val("find"), "rp");
      const n = countMatches(re, input.value);
      done(input.value.replace(re, ""), `Deleted ${plural(n, "match")}.`);
    },

    deleteSomething() {
      const mode = val("del-mode");
      if (mode === "text") {
        const re = buildRegex(val("del-find"), "del");
        const n = countMatches(re, input.value);
        return done(input.value.replace(re, ""), `Deleted ${plural(n, "occurrence")}.`);
      }
      const re = buildRegex(val("del-find"), "del", false);
      const all = splitLines(input.value);
      const kept = all.filter((l) => (mode === "contain" ? !re.test(l) : re.test(l)));
      done(kept.join("\n"), `Deleted ${plural(all.length - kept.length, "line")}.`);
    },

    case(kind) {
      done(caseOps[kind](input.value), "Case converted.");
    },

    sort(dir) {
      const opts = { numeric: checked("ln-natural"), sensitivity: "base" };
      const sorted = splitLines(input.value).sort((a, b) => a.localeCompare(b, undefined, opts));
      if (dir === "desc") sorted.reverse();
      done(sorted.join("\n"), `Sorted ${plural(sorted.length, "line")}.`);
    },

    reverseLines() {
      done(splitLines(input.value).reverse().join("\n"), "Line order reversed.");
    },

    shuffle() {
      const a = splitLines(input.value);
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      done(a.join("\n"), `Shuffled ${plural(a.length, "line")}.`);
    },

    dedupe() {
      const ic = checked("ln-ignorecase");
      const seen = new Set();
      const all = splitLines(input.value);
      const kept = all.filter((l) => {
        const k = ic ? l.toLowerCase() : l;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      done(kept.join("\n"), `Removed ${plural(all.length - kept.length, "duplicate")}.`);
    },

    removeEmpty() {
      const all = splitLines(input.value);
      const kept = all.filter((l) => l.trim() !== "");
      done(kept.join("\n"), `Removed ${plural(all.length - kept.length, "empty line")}.`);
    },

    number() {
      const all = splitLines(input.value);
      const pad = String(all.length).length;
      done(all.map((l, i) => `${String(i + 1).padStart(pad, " ")}. ${l}`).join("\n"), "Lines numbered.");
    },

    affix() {
      const p = val("ln-prefix"), s = val("ln-suffix");
      done(splitLines(input.value).map((l) => p + l + s).join("\n"), "Prefix and suffix added.");
    },

    join() {
      done(splitLines(input.value).join(val("ln-sep")), "Lines joined.");
    },

    split() {
      const sep = val("ln-sep");
      if (!sep) throw new Error("Enter a separator.");
      const parts = input.value.split(sep);
      done(parts.join("\n"), `Split into ${plural(parts.length, "line")}.`);
    },

    trimLines() { done(splitLines(input.value).map((l) => l.trim()).join("\n"), "Lines trimmed."); },
    collapseSpaces() { done(input.value.replace(/[^\S\r\n]{2,}/g, " "), "Repeated spaces collapsed."); },
    collapseBlank() { done(input.value.replace(/(\r?\n){3,}/g, "\n\n"), "Repeated blank lines collapsed."); },
    removeBreaks() { done(input.value.replace(/\s*\r?\n\s*/g, " ").trim(), "Line breaks removed."); },
    stripTags() { done(input.value.replace(/<[^>]*>/g, ""), "HTML tags removed."); },
    stripAccents() { done(input.value.normalize("NFD").replace(/\p{M}/gu, ""), "Accents removed."); },
    straightenQuotes() {
      done(input.value.replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"'), "Quotes straightened.");
    },

    extract(kind) {
      let found = input.value.match(patterns[kind]) || [];
      if (checked("ex-unique")) found = [...new Set(found)];
      done(found.join("\n"), found.length ? `Found ${plural(found.length, "result")}.` : "No matches found.");
    },

    wordFreq() {
      const counts = new Map();
      for (const w of input.value.toLowerCase().match(/[\p{L}\p{N}']+/gu) || []) counts.set(w, (counts.get(w) || 0) + 1);
      const rows = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      done(rows.map(([w, n]) => `${n}\t${w}`).join("\n"), `${plural(rows.length, "unique word")}.`);
    },

    encode(kind) {
      done(encoders[kind](input.value), "Done.");
    },

    // input / output housekeeping
    async paste() {
      try {
        input.value = await navigator.clipboard.readText();
        updateStats();
        updateMatchCount();
      } catch {
        throw new Error("Clipboard access was blocked. Paste with Ctrl+V instead.");
      }
    },
    clearInput() { input.value = ""; updateStats(); updateMatchCount(); status.textContent = ""; },
    async copy() {
      if (!output.value) throw new Error("Nothing to copy yet.");
      try {
        await navigator.clipboard.writeText(output.value);
      } catch {
        output.select();
        document.execCommand("copy");
      }
      status.textContent = "Copied to clipboard.";
    },
    useOutput() {
      if (!output.value) throw new Error("There is no output to move yet.");
      input.value = output.value;
      output.value = "";
      status.textContent = "Output moved to input.";
      updateStats();
      updateMatchCount();
    },
    swapSides() {
      const a = $("#cmp-a"), b = $("#cmp-b");
      [a.value, b.value] = [b.value, a.value];
      runCompare();
    },
  };

  // ---------- server mode ----------
  const useServer = () => window.Options.server();
  // Actions that transform the input. The rest (paste, copy, clear...) only move text around and stay local.
  const SERVER_ACTIONS = new Set(["replaceAll", "deleteMatches", "deleteSomething", "case", "sort", "reverseLines", "shuffle",
    "dedupe", "removeEmpty", "number", "affix", "join", "split", "trimLines", "collapseSpaces", "collapseBlank", "removeBreaks",
    "stripTags", "stripAccents", "straightenQuotes", "extract", "wordFreq", "encode"]);
  const params = () => ({
    find: val("find"), replace: val("replace"), rp_case: checked("rp-case"), rp_word: checked("rp-word"), rp_regex: checked("rp-regex"),
    del_find: val("del-find"), del_mode: val("del-mode"), del_case: checked("del-case"), del_word: checked("del-word"), del_regex: checked("del-regex"),
    ln_natural: checked("ln-natural"), ln_ignorecase: checked("ln-ignorecase"), ln_prefix: val("ln-prefix"), ln_suffix: val("ln-suffix"), ln_sep: val("ln-sep"),
    ex_unique: checked("ex-unique"),
  });
  async function viaServer(name, arg) {
    status.textContent = "Working on the server…";
    const d = await window.Options.json("/api/text/" + name, { text: input.value, arg, params: params() });
    done(d.text, d.message);
  }

  async function run(fn) {
    status.classList.remove("error");
    try {
      await fn();
    } catch (err) {
      status.textContent = err.message;
      status.classList.add("error");
    }
  }

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const name = btn.dataset.action, arg = btn.dataset.arg;
    run(() => (useServer() && SERVER_ACTIONS.has(name) ? viaServer(name, arg) : actions[name](arg)));
  });

  // Enter in a text field triggers the panel's primary button.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !e.target.matches('input[type="text"]')) return;
    const primary = e.target.closest(".panel")?.querySelector(".btn.primary");
    if (primary) primary.click();
  });

  // ---------- live match count ----------
  function updateMatchCount() {
    const hint = $("#match-count");
    if (!val("find")) { hint.textContent = ""; return; }
    try {
      hint.textContent = `${plural(countMatches(buildRegex(val("find"), "rp"), input.value), "match")} in the input.`;
    } catch (err) {
      hint.textContent = err.message;
    }
  }
  ["find", "rp-case", "rp-word", "rp-regex"].forEach((id) => $("#" + id).addEventListener("input", updateMatchCount));
  input.addEventListener("input", () => { updateStats(); updateMatchCount(); });

  // ---------- tabs ----------
  function activate(name) {
    $$("[data-tab]").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
    $$("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== name));
    const comparing = name === "compare";
    $("#workspace").hidden = comparing;
    $("#compare").hidden = !comparing;
    status.textContent = "";
    status.classList.remove("error");
    if (comparing) runCompare();
  }
  $$("[data-tab]").forEach((t) => t.addEventListener("click", () => activate(t.dataset.tab)));

  // ---------- compare ----------
  // Longest-common-subsequence diff over token arrays.
  function diff(a, b, ka, kb) {
    const n = a.length, m = b.length, w = m + 1;
    if ((n + 1) * w > 6e6) throw new Error("These texts are too large to compare in the browser.");
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i * w + j] = ka[i] === kb[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (ka[i] === kb[j]) { ops.push({ t: "same", v: b[j] }); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) ops.push({ t: "del", v: a[i++] });
      else ops.push({ t: "add", v: b[j++] });
    }
    while (i < n) ops.push({ t: "del", v: a[i++] });
    while (j < m) ops.push({ t: "add", v: b[j++] });
    return ops;
  }

  let compareSerial = 0;
  async function runCompare() {
    const mine = ++compareSerial;
    const result = $("#cmp-result"), summary = $("#cmp-summary");
    summary.classList.remove("error");
    result.textContent = "";
    const a = $("#cmp-a").value, b = $("#cmp-b").value;
    if (!a && !b) { summary.textContent = "Enter text in both boxes to compare."; return; }

    const byLines = val("cmp-mode") === "lines";
    const tokenize = byLines
      ? (s) => (s === "" ? [] : splitLines(s))
      : (s) => s.split(/(\s+)/).filter(Boolean);
    const key = (t) => {
      let k = t;
      if (checked("cmp-ws")) k = k.replace(/\s+/g, " ").trim();
      if (checked("cmp-case")) k = k.toLowerCase();
      return k;
    };

    const A = tokenize(a), B = tokenize(b);
    let ops;
    try {
      ops = useServer()
        ? (await window.Options.json("/api/text/compare", { a, b, mode: val("cmp-mode"), ignore_case: checked("cmp-case"), ignore_ws: checked("cmp-ws") })).ops
        : diff(A, B, A.map(key), B.map(key));
      if (mine !== compareSerial) return;                // a newer comparison has started
    } catch (err) {
      if (mine !== compareSerial) return;
      summary.textContent = err.message;
      summary.classList.add("error");
      return;
    }

    const counted = ops.filter((o) => byLines || o.v.trim() !== "");
    const added = counted.filter((o) => o.t === "add").length;
    const removed = counted.filter((o) => o.t === "del").length;
    const unit = byLines ? "line" : "word";
    summary.textContent = added || removed
      ? `${plural(added, unit)} added, ${plural(removed, unit)} removed, ${plural(counted.length - added - removed, unit)} unchanged.`
      : "The texts are identical.";

    if (byLines) {
      const hide = checked("cmp-hide");
      const mark = { same: " ", add: "+", del: "\u2212" };
      for (const op of ops) {
        if (hide && op.t === "same") continue;
        const row = document.createElement("div");
        row.className = "dl " + op.t;
        const g = document.createElement("span");
        g.className = "g";
        g.textContent = mark[op.t];
        const t = document.createElement("span");
        t.textContent = op.v === "" ? "\u00a0" : op.v;
        row.append(g, t);
        result.append(row);
      }
    } else {
      const box = document.createElement("div");
      box.className = "words";
      for (const op of ops) {
        if (op.t === "same") { box.append(op.v); continue; }
        const s = document.createElement("span");
        s.className = op.t;
        s.textContent = op.v;
        box.append(s);
      }
      result.append(box);
    }
  }

  let timer;
  const later = () => { clearTimeout(timer); timer = setTimeout(runCompare, 200); };
  ["cmp-a", "cmp-b"].forEach((id) => $("#" + id).addEventListener("input", later));
  ["cmp-mode", "cmp-case", "cmp-ws", "cmp-hide"].forEach((id) => $("#" + id).addEventListener("input", runCompare));

  updateStats();
  document.addEventListener("optionschange", () => { if (!$("#compare").hidden) runCompare(); });
})();
