"""The shared tabletop map on pages/tabletop.*. One map for everybody. The board is 16 x 10 squares ("cells"); tokens
are stored as 0..1 fractions of the board, walls and doors in cells (snapped to half a cell).

  tokens  {id, kind: "character" | "enemy", ref, x, y}   ref points at a sheet; name and portrait are read from it.
          A character's HP is read from its sheet. Every enemy token has its own HP (hp, max, fp, fpmax, copied from the
          enemy sheet when it is put on the map and edited per token), so three goblins keep three separate HPs.
  walls   {id, x1, y1, x2, y2}                           block sight
  doors   {id, x1, y1, x2, y2, open, locked}             block sight while closed
  vision  how many cells a player character can see      hidden  true = players see nothing (the DM is arranging)

Effects: a token can carry effects {n, t}. A turn of combat counts t down by one (and back up when the DM goes back), whose
effects depends on the combat's "tick" setting: "own" = the creature whose turn ends / is taken back, "all" = every participant.
t may go below 0 (shown as ended) so that going back always restores exactly what going forward changed.
Combat: doc["combat"] = {phase: "initiative" | "fighting", order: [token ids], init: {id: {total, roll, bonus, label}}, turn,
round, tick}. Everybody taking part rolls k10 + KÉ (a character without weapon unless it picks one); the order is highest first
and the DM may move anybody. Players only see participants they can see on the map (enemies out of sight are left out).

Fog of war is worked out here, not in the browser, so players are only ever sent what they may see: every character
token sees in a circle around it, stopped by walls and closed doors; what has been seen stays "explored" (dimmed) and
is stored; enemies are only sent while in view; walls and doors only once seen. The fog itself is a small PNG.

  GET  /api/map                       everything the caller may see (see roles.py: players get the filtered version)
  GET  /api/map/fog.png               the fog overlay (black = unexplored, dim = explored, clear = in view)
  POST /api/map/tokens                {kind, ref, count?}  add (players: characters only; DM: up to 20 enemies at once)
  POST /api/map/tokens/<id>           {x, y}       move (players: characters only)
  POST /api/map/tokens/<id>/delete                 take off the map (players: characters only)
  POST /api/map/tokens/<id>/stats     {hp?, max?, fp?, fpmax?}  change Ép / Fp. Enemies: DM. Characters: DM, or whoever
                                      has the sheet open (a locked sheet needs its password). Enemy HP is never sent to players.
  GET  /api/map/tokens/<id>/portrait               the token's portrait (enemy ids are never sent to players)
  POST /api/map/tokens/<id>/effects   {effects: [{n, t}]}  the token's effects (n = name, t = turns left, null = no limit).
                                      Enemies: DM. Characters: DM, or whoever has the sheet open. Everybody who sees a token sees them.
  GET  /api/map/tokens/<id>/initiative  -> {choices: [{choice, label, bonus}]}  what the token can roll initiative with (DM, or its player)
  POST /api/map/tokens/<id>/initiative  {choice}   roll k10 + that bonus for the combat (choice -1 = KÉ without weapon, 0..9 = a weapon)
  POST /api/map/combat                {action, ...}  DM: start {ids} | participants {ids} | begin {force?} | next | prev | end |
                                      move {id, to} | set_init {id, total} | tick {mode: "own" | "all"}  (see "combat" below)
  POST /api/map/walls | /doors        {x1, y1, x2, y2}   DM
  POST /api/map/walls/<id>/delete | /doors/<id>/delete   DM
  POST /api/map/doors/<id>/toggle     open / close (players too, unless locked or not yet seen)
  POST /api/map/doors/<id>/lock       {locked}     DM
  POST /api/map/settings              {vision?, hidden?}   DM
  POST /api/map/fog/reset             forget what was explored   DM
  GET  /api/map/saves                 DM    -> {saves: [{id, name, saved, tokens, walls, doors}]}
  POST /api/map/saves                 DM    {name} save the map now (same name = replace)
  POST /api/map/saves/<id>/load       DM    replace the map with a save (it comes back hidden from players)
  POST /api/map/saves/<id>/delete     DM
Every answer is JSON (never an empty body). Each campaign has its own map: data/campaigns/<id>/map.json and map_saves/
(git-ignored), see campaigns.py.
Run a single process (threads are fine)."""
import base64
import hashlib
import io
import json
import math
import os
import re
import threading
import time
import uuid

import numpy as np
from flask import Response, abort, jsonify, request
from PIL import Image, ImageChops, ImageDraw, ImageFilter

from . import campaigns, characters, enemies
from .core import Fail, bp
from .rolls import make_roll
from .roles import current_role, need_dm

CW, CH, PPC = 16, 10, 20                      # board size in cells, fog pixels per cell
FW, FH = CW * PPC, CH * PPC
KINDS = {"character": characters, "enemy": enemies}
MAX_TOKENS, MAX_WALLS, MAX_DOORS, MAX_SAVES = 200, 1500, 300, 100
HEX = re.compile(r"^[0-9a-f]{32}$")
_lock = threading.RLock()
_cache = {}                                   # sheet path -> (mtime_ns, summary), so polling does not re-read every sheet


class _FogStore:
    """The fog cache, kept separately for every campaign (each has its own map). Used like a dict."""

    def __init__(self):
        self._all = {}

    def _cur(self):
        return self._all.setdefault(campaigns.current_id(), {"sig": None, "key": None, "explored": None, "vis": None,
                                                              "known": None, "png": b"", "hash": ""})

    def __getitem__(self, key):
        return self._cur()[key]

    def __setitem__(self, key, value):
        self._cur()[key] = value

    def update(self, **kw):
        self._cur().update(kw)


_fog = _FogStore()


def map_file():
    return campaigns.folder("map.json")


def saves_dir():
    return campaigns.folder("map_saves")


# ---------- storage ----------
def load():
    try:
        doc = json.loads(map_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        doc = {}
    doc = doc if isinstance(doc, dict) else {}
    for key in ("tokens", "walls", "doors"):
        if not isinstance(doc.get(key), list):
            doc[key] = []
    if isinstance(doc.get("vision"), bool) or not isinstance(doc.get("vision"), (int, float)):
        doc["vision"] = 7
    if not isinstance(doc.get("hidden"), bool):
        doc["hidden"] = False
    if not isinstance(doc.get("explored"), str):
        doc["explored"] = ""
    if not isinstance(doc.get("combat"), dict):
        doc["combat"] = None
    return doc


def save(doc):
    target = map_file()
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc), encoding="utf-8")
    os.replace(tmp, target)


# ---------- what a token shows (read from the sheet) ----------
def number(v):
    try:
        return float(str(v).replace(",", ".").strip())
    except ValueError:
        return None


def summary(kind, ref):
    """What the map shows about a sheet, or None when the sheet is gone."""
    if kind not in KINDS or not isinstance(ref, str) or not characters.ID.match(ref):
        return None
    path = KINDS[kind].directory() / f"{ref}.json"
    try:
        stamp = path.stat().st_mtime_ns
    except OSError:
        return None
    hit = _cache.get(str(path))
    if hit and hit[0] == stamp:
        return hit[1]
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    data = doc.get("data") or {}
    pic = data.get("portrait", "")
    out = {"name": data.get("name") or "Unnamed",
           "hp": number(data.get("hp.curep")), "max": number(data.get("hp.maxep")),      # Ép: left half of the token
           "fp": number(data.get("hp.curfp")), "fpmax": number(data.get("hp.maxfp")),    # Fp: right half
           "portrait": bool(pic), "v": hashlib.md5(pic.encode()).hexdigest()[:10] if pic else "",
           "locked": bool(doc.get("lock"))}
    _cache[str(path)] = (stamp, out)
    return out


# ---------- sight ----------
def blockers(doc):
    segs = [(w["x1"], w["y1"], w["x2"], w["y2"]) for w in doc["walls"]]
    segs += [(d["x1"], d["y1"], d["x2"], d["y2"]) for d in doc["doors"] if not d.get("open")]
    return segs


def ray_hit(px, py, dx, dy, x1, y1, x2, y2):
    """Distance along the ray (px,py)+t(dx,dy) to the segment, or None."""
    ex, ey = x2 - x1, y2 - y1
    den = dx * ey - dy * ex
    if abs(den) < 1e-12:
        return None
    ax, ay = x1 - px, y1 - py
    t = (ax * ey - ay * ex) / den
    u = (ax * dy - ay * dx) / den
    return t if t >= 0 and -1e-9 <= u <= 1 + 1e-9 else None


def view_polygon(px, py, radius, segs):
    """The area one viewer sees: a circle cut short by walls (rays towards every wall end, and a few around)."""
    near = [s for s in segs if max(s[0], s[2]) >= px - radius and min(s[0], s[2]) <= px + radius
            and max(s[1], s[3]) >= py - radius and min(s[1], s[3]) <= py + radius]
    angles = {math.radians(k) for k in range(0, 360, 4)}
    for x1, y1, x2, y2 in near:
        for x, y in ((x1, y1), (x2, y2)):
            a = math.atan2(y - py, x - px)
            angles.update((a - 1e-4, a, a + 1e-4))
    pts = []
    for a in sorted(angles):
        dx, dy = math.cos(a), math.sin(a)
        t = radius
        for s in near:
            h = ray_hit(px, py, dx, dy, *s)
            if h is not None and h < t:
                t = h
        pts.append((px + dx * t, py + dy * t))
    return pts


def _decode(b64):
    try:
        im = Image.open(io.BytesIO(base64.b64decode(b64))).convert("L") if b64 else None
    except Exception:
        return None
    return im if im is not None and im.size == (FW, FH) else None


def _encode(im):
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


def ensure_fog(doc):
    """Bring the fog up to date with the characters, walls and doors. Returns True when doc["explored"] changed
    (the caller then saves the document)."""
    chars = sorted((round(t["x"] * CW, 3), round(t["y"] * CH, 3)) for t in doc["tokens"]
                   if t.get("kind") == "character" and summary("character", t.get("ref")) is not None)
    segs, radius = blockers(doc), max(1, min(20, float(doc["vision"])))
    sig = hashlib.md5(json.dumps([chars, segs, radius]).encode()).hexdigest()
    if _fog["sig"] == sig:
        return False
    vis = Image.new("L", (FW, FH), 0)
    draw = ImageDraw.Draw(vis)
    for px, py in chars:
        draw.polygon([(x * PPC, y * PPC) for x, y in view_polygon(px, py, radius, segs)], fill=255)
    if _fog["key"] != doc["explored"] or _fog["explored"] is None:
        _fog["explored"], _fog["key"] = _decode(doc["explored"]) or Image.new("L", (FW, FH), 0), doc["explored"]
    old = _fog["explored"]
    new = ImageChops.lighter(old, vis)
    changed = ImageChops.difference(new, old).getbbox() is not None
    if changed:
        doc["explored"] = _encode(new)
    _fog["explored"], _fog["key"] = new, doc["explored"]
    v, e = np.asarray(vis) > 127, np.asarray(new) > 127
    alpha = np.where(v, 0, np.where(e, 150, 255)).astype(np.uint8)
    alpha_im = Image.fromarray(alpha).filter(ImageFilter.GaussianBlur(1.2))
    dark = Image.new("L", (FW, FH), 8)
    png = io.BytesIO()
    Image.merge("RGBA", (dark, dark, dark, alpha_im)).save(png, "PNG", optimize=True)
    _fog.update(sig=sig, vis=vis, known=ImageChops.lighter(vis, new), png=png.getvalue(),
                hash=hashlib.md5(png.getvalue()).hexdigest()[:10])
    return changed


def _lit(img, x, y):
    px, py = min(FW - 1, max(0, int(x * PPC))), min(FH - 1, max(0, int(y * PPC)))
    return img.crop((max(0, px - 1), max(0, py - 1), px + 2, py + 2)).getextrema()[1] > 127


def token_in_view(t):
    return _lit(_fog["vis"], t["x"] * CW, t["y"] * CH)


def seg_known(s):
    """Has any part of this wall or door been in view?"""
    x1, y1, x2, y2 = s
    pts = ((x1, y1), (x2, y2), ((x1 + x2) / 2, (y1 + y2) / 2), (x1 * .75 + x2 * .25, y1 * .75 + y2 * .25), (x1 * .25 + x2 * .75, y1 * .25 + y2 * .75))
    return any(_lit(_fog["known"], x, y) for x, y in pts)


def seg_of(o):
    return (o["x1"], o["y1"], o["x2"], o["y2"])


# ---------- checking what browsers send ----------
def unit(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v:
        raise Fail("That position is not valid.")
    return round(min(1.0, max(0.0, float(v))), 4)


def cell(v, top):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or not 0 <= v <= top:
        raise Fail("That point is outside the map.")
    return round(v * 2) / 2


def seg_from(d, longest):
    x1, y1, x2, y2 = cell(d.get("x1"), CW), cell(d.get("y1"), CH), cell(d.get("x2"), CW), cell(d.get("y2"), CH)
    if (x1, y1) == (x2, y2):
        raise Fail("It needs two different points.")
    if math.hypot(x2 - x1, y2 - y1) > longest:
        raise Fail(f"That is too long (at most {longest} squares).")
    return {"x1": x1, "y1": y1, "x2": x2, "y2": y2}


def dm_or_player():
    return "dm" if current_role() == "dm" else "player"


def find(items, oid):
    return next((o for o in items if o.get("id") == oid), None)


# ---------- enemy tokens: numbering and their own HP ----------
STATS = ("hp", "max", "fp", "fpmax")


def enemy_numbers(tokens):
    """token id -> its number among the tokens of the same enemy sheet (Goblin 1, Goblin 2, ...). The number is stored
    when the token is added and never changes, so removing Goblin 2 does not turn Goblin 3 into Goblin 2. Tokens from
    before numbering existed are counted in the order they were added."""
    out, seen = {}, {}
    for t in tokens:
        if t.get("kind") != "enemy":
            continue
        seen[t["ref"]] = seen.get(t["ref"], 0) + 1
        n = t.get("n")
        out[t["id"]] = n if isinstance(n, int) and not isinstance(n, bool) and n > 0 else seen[t["ref"]]
    return out


MAX_EFFECTS = 16


def clean_effects(raw):
    """A token's effects as stored: [{n: name, t: turns left or None}], at most MAX_EFFECTS."""
    out = []
    for e in raw if isinstance(raw, list) else []:
        if not isinstance(e, dict):
            continue
        name = " ".join(re.sub(r"[\x00-\x1f\x7f]", "", str(e.get("n", ""))).split())[:40]
        t = e.get("t")
        if isinstance(t, bool) or not (t is None or isinstance(t, int)):
            t = None if t in (None, "") else stat_int(t)
        if name:
            out.append({"n": name, "t": None if t is None else max(-999, min(999, t))})
    return out[:MAX_EFFECTS]


def stat_int(v):
    try:
        return int(float(str(v).replace(",", ".").strip()))
    except ValueError:
        raise Fail("Turns must be a whole number.")


def token_view(t, role, numbers, shared):
    """One token as the caller may see it. Players never get an enemy's HP: with the numbers missing, the map draws no
    health bars on it, no HP labels and no grey, so nothing about an enemy's health is left to read."""
    s = summary(t["kind"], t["ref"])
    out = {"id": t["id"], "kind": t["kind"], "x": t["x"], "y": t["y"], "effects": clean_effects(t.get("effects")), **s}
    locked = out.pop("locked")
    if t["kind"] == "enemy":
        for k in STATS:
            if k in t:
                out[k] = t[k]                                  # this token's own HP, not the sheet's
        if role != "dm":
            for k in STATS:
                out[k] = None
        if shared.get(t["ref"], 0) > 1:
            out["name"] = f'{s["name"]} {numbers[t["id"]]}'
        out["editable"] = role == "dm"
    else:
        out["ref"] = t["ref"]                                  # a character's id is no secret; it lets the page mark yours
        out["editable"] = role == "dm" or not locked or t["ref"] in characters.unlocked_ids()
    return out


# ---------- reading the map ----------
@bp.get("/map")
def map_get():
    role = dm_or_player()
    with _lock:
        doc = load()
        keep = [t for t in doc["tokens"] if summary(t.get("kind"), t.get("ref")) is not None]    # their sheet was deleted
        pruned = len(keep) != len(doc["tokens"])
        doc["tokens"] = keep
        pruned = prune_combat(doc) or pruned
        if ensure_fog(doc) or pruned:
            save(doc)
        out = {"role": role, "vision": doc["vision"], "hidden": doc["hidden"], "tokens": [], "walls": [], "doors": [], "fog": None, "combat": None}
        if role != "dm" and doc["hidden"]:
            return jsonify(out)
        numbers, shared = enemy_numbers(keep), {}
        for t in keep:
            if t["kind"] == "enemy":
                shared[t["ref"]] = shared.get(t["ref"], 0) + 1
        for t in keep:
            if role != "dm" and t["kind"] == "enemy" and not token_in_view(t):
                continue
            out["tokens"].append(token_view(t, role, numbers, shared))
        out["combat"] = combat_view(doc.get("combat"), role, {v["id"]: v for v in out["tokens"]})
        for key in ("walls", "doors"):
            out[key] = [o for o in doc[key] if role == "dm" or seg_known(seg_of(o))]
        out["fog"] = _fog["hash"]
        return jsonify(out)


@bp.get("/map/fog.png")
def map_fog():
    with _lock:
        doc = load()
        if ensure_fog(doc):
            save(doc)
        png = _fog["png"]
    return Response(png, mimetype="image/png", headers={"Cache-Control": "no-store"})


@bp.get("/map/tokens/<tid>/portrait")
def map_portrait(tid):
    with _lock:
        t = find(load()["tokens"], tid)
    if not t or t.get("kind") not in KINDS:
        abort(404, "No such token.")
    return characters.portrait_response(KINDS[t["kind"]].read(t["ref"]))


# ---------- tokens ----------
@bp.post("/map/tokens")
def map_add():
    d = request.get_json(silent=True) or {}
    kind, ref = d.get("kind"), str(d.get("ref", ""))
    if kind not in KINDS or not characters.ID.match(ref):
        raise Fail("Pick a character or an enemy to add.")
    if kind == "enemy":
        need_dm()
    elif dm_or_player() == "player" and load()["hidden"]:
        abort(403, "The map is hidden right now.")
    sheet = summary(kind, ref)
    if sheet is None:
        raise Fail("That " + kind + " no longer exists.")
    count = d.get("count", 1) if kind == "enemy" else 1
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= 20:
        raise Fail("You can add between 1 and 20 at a time.")
    with _lock:
        doc = load()
        tokens = doc["tokens"]
        if len(tokens) + count > MAX_TOKENS:
            raise Fail("The map is full. Remove some tokens first.")
        if kind == "character" and any(t.get("kind") == "character" and t.get("ref") == ref for t in tokens):
            raise Fail("That character is already on the map.")
        ids = []
        for _ in range(count):
            n = len(tokens)                  # new tokens land in a staggered row so they do not hide each other
            tid = uuid.uuid4().hex
            token = {"id": tid, "kind": kind, "ref": ref, "x": round(0.08 + (n % 10) * 0.09, 4), "y": round(0.12 + (n // 10 % 7) * 0.12, 4)}
            if kind == "enemy":              # every enemy gets its own HP, copied from the sheet (full when the sheet has no current value)
                token["n"] = max(enemy_numbers([t for t in tokens if t.get("ref") == ref]).values(), default=0) + 1
                token["hp"] = sheet["hp"] if sheet["hp"] is not None else sheet["max"]
                token["max"] = sheet["max"]
                token["fp"] = sheet["fp"] if sheet["fp"] is not None else sheet["fpmax"]
                token["fpmax"] = sheet["fpmax"]
            tokens.append(token)
            ids.append(tid)
        ensure_fog(doc)
        save(doc)
    return jsonify(id=ids[0], ids=ids)


@bp.post("/map/tokens/<tid>")
def map_move(tid):
    d = request.get_json(silent=True) or {}
    x, y = unit(d.get("x")), unit(d.get("y"))
    with _lock:
        doc = load()
        t = find(doc["tokens"], tid)
        if not t:
            raise Fail("That token is no longer on the map.")
        if dm_or_player() == "player":
            if t["kind"] != "character":
                abort(403, "Only the dungeon master can move that.")
            if doc["hidden"]:
                abort(403, "The map is hidden right now.")
        t["x"], t["y"] = x, y
        ensure_fog(doc)                      # what the character sees from here is now explored
        save(doc)
    return jsonify(ok=True)


def stat_value(v):
    """A number typed into an HP box, or None for an empty box."""
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    if isinstance(v, bool):
        raise Fail("Type a number.")
    try:
        f = float(str(v).replace(",", ".").strip())
    except ValueError:
        raise Fail("Type a number.")
    if f != f or abs(f) > 1_000_000_000:
        raise Fail("That number is not valid.")
    return round(f, 4)


@bp.post("/map/tokens/<tid>/stats")
def map_stats(tid):
    d = request.get_json(silent=True) or {}
    patch = {k: stat_value(d[k]) for k in STATS if k in d}
    if dm_or_player() == "player":
        if patch.keys() & {"max", "fpmax"}:
            raise Fail("Only the dungeon master can change the maximum Ép and Fp.")
    if not patch:
        raise Fail("Nothing to change.")
    with _lock:
        doc = load()
        t = find(doc["tokens"], tid)
        if not t:
            raise Fail("That token is no longer on the map.")
        if t["kind"] == "enemy":
            need_dm()
            t.update(patch)
            save(doc)
        else:
            if dm_or_player() == "player" and doc["hidden"]:
                abort(403, "The map is hidden right now.")
            characters.update_stats(t["ref"], patch)        # refuses a locked sheet that is not open for this browser
    return jsonify(ok=True)


@bp.post("/map/tokens/<tid>/delete")
def map_remove(tid):
    with _lock:
        doc = load()
        t = find(doc["tokens"], tid)
        if t and dm_or_player() == "player" and t["kind"] != "character":
            abort(403, "Only the dungeon master can remove that.")
        doc["tokens"] = [o for o in doc["tokens"] if o.get("id") != tid]
        prune_combat(doc)
        ensure_fog(doc)
        save(doc)
    return jsonify(ok=True)


# ---------- effects ----------
def may_change(t, doc):
    """Who may change a token's Ép, Fp and effects: enemies the DM; characters the DM or whoever has the sheet open."""
    if t["kind"] == "enemy":
        need_dm()
    elif dm_or_player() == "player":
        if doc["hidden"]:
            abort(403, "The map is hidden right now.")
        s = summary("character", t["ref"])
        if s and s["locked"] and t["ref"] not in characters.unlocked_ids():
            abort(403, "This character is locked. Open it with its password on the Character sheet tab first.")


@bp.post("/map/tokens/<tid>/effects")
def map_effects(tid):
    d = request.get_json(silent=True) or {}
    if not isinstance(d.get("effects"), list):
        raise Fail("Send the list of effects.")
    effects = clean_effects(d["effects"])
    with _lock:
        doc = load()
        t = find(doc["tokens"], tid)
        if not t:
            raise Fail("That token is no longer on the map.")
        may_change(t, doc)
        t["effects"] = effects
        save(doc)
    return jsonify(effects=effects)


# ---------- combat ----------
MAX_FIGHTERS = 60


def prune_combat(doc):
    """Drop fighters whose token is gone; end the combat when nobody is left. True when something changed."""
    c = doc.get("combat")
    if not c:
        return False
    ids = {t["id"] for t in doc["tokens"]}
    order = [i for i in c["order"] if i in ids]
    if len(order) == len(c["order"]):
        return False
    here = c["order"][c["turn"]] if c["order"] and 0 <= c["turn"] < len(c["order"]) else None
    c["order"] = order
    c["init"] = {i: v for i, v in c["init"].items() if i in ids}
    c["turn"] = order.index(here) if here in order else min(c["turn"], max(0, len(order) - 1))
    if not order:
        doc["combat"] = None
    return True


def place(c, tid):
    """Put a fighter who has just rolled where the result belongs: before the first one with a lower total (or none yet)."""
    total = c["init"][tid]["total"]
    here = c["order"][c["turn"]] if c["phase"] == "fighting" and 0 <= c["turn"] < len(c["order"]) else None
    c["order"] = [i for i in c["order"] if i != tid]
    at = next((k for k, i in enumerate(c["order"]) if i not in c["init"] or c["init"][i]["total"] < total), len(c["order"]))
    c["order"].insert(at, tid)
    if here is not None:
        c["turn"] = c["order"].index(here)


def combat_view(c, role, views):
    """The combat as the caller may see it. views: token id -> token_view of what the caller can see."""
    if not c:
        return None
    here = c["order"][c["turn"]] if c["phase"] == "fighting" and c["order"] else None
    order = []
    for tid in c["order"]:
        v = views.get(tid)
        if v is None:                                           # a player does not hear about enemies out of sight
            continue
        i = c["init"].get(tid)
        order.append({"id": tid, "name": v["name"], "kind": v["kind"], "total": i["total"] if i else None,
                      "roll": i["roll"] if i else None, "bonus": i["bonus"] if i else None, "label": i["label"] if i else ""})
    out = {"phase": c["phase"], "round": c["round"], "current": here if here in views else None, "unseen_turn": bool(here) and here not in views,
           "order": order, "pending": sum(1 for tid in c["order"] if tid not in c["init"])}
    if role == "dm":
        out["tick"] = c["tick"]
    return out


def need_combat(doc, phase=None):
    c = doc.get("combat")
    if not c:
        raise Fail("There is no combat.")
    if phase and c["phase"] != phase:
        raise Fail("The combat is " + ("already under way." if phase == "initiative" else "still waiting for initiative rolls."))
    return c


def shift_effects(doc, c, tid, step):
    """A turn counts effects down (step -1) or, going back, up (+1): the creature's own, or everybody's."""
    for t in doc["tokens"]:
        if t["id"] == tid or (c["tick"] == "all" and t["id"] in c["order"]):
            for e in t.get("effects") or []:
                if isinstance(e.get("t"), int):
                    e["t"] = max(-999, min(999, e["t"] + step))


def fighter_ids(doc, raw):
    ids = []
    for i in raw if isinstance(raw, list) else []:
        if isinstance(i, str) and i not in ids and find(doc["tokens"], i):
            ids.append(i)
    if len(ids) > MAX_FIGHTERS:
        raise Fail(f"A combat can have {MAX_FIGHTERS} fighters at most.")
    return ids


@bp.post("/map/combat")
def map_combat():
    need_dm()
    d = request.get_json(silent=True) or {}
    action = d.get("action")
    with _lock:
        doc = load()
        prune_combat(doc)
        c = doc.get("combat")
        if action == "start":
            if c:
                raise Fail("A combat is already going on.")
            ids = fighter_ids(doc, d.get("ids"))
            if not ids:
                raise Fail("Pick at least one player or monster for the combat.")
            doc["combat"] = {"phase": "initiative", "order": ids, "init": {}, "turn": 0, "round": 1, "tick": "own"}
        elif action == "end":
            doc["combat"] = None
        else:
            c = need_combat(doc)
            here = c["order"][c["turn"]] if c["phase"] == "fighting" and c["order"] else None
            if action == "participants":
                ids = fighter_ids(doc, d.get("ids"))
                if not ids:
                    raise Fail("A combat needs at least one fighter. End the combat instead.")
                c["order"] = [i for i in c["order"] if i in ids] + [i for i in ids if i not in c["order"]]
                c["init"] = {i: v for i, v in c["init"].items() if i in ids}      # newcomers wait at the end for their roll
                c["turn"] = c["order"].index(here) if here in c["order"] else min(c["turn"], len(c["order"]) - 1)
            elif action == "begin":
                need_combat(doc, "initiative")
                waiting = [i for i in c["order"] if i not in c["init"]]
                if waiting and not d.get("force"):
                    raise Fail(f"{len(waiting)} still have to roll initiative.")
                c["order"] = [i for i in c["order"] if i in c["init"]]
                if not c["order"]:
                    raise Fail("Nobody has rolled initiative yet.")
                c["phase"], c["turn"], c["round"] = "fighting", 0, 1
            elif action in ("next", "prev"):
                need_combat(doc, "fighting")
                n = len(c["order"])
                if action == "next":
                    shift_effects(doc, c, c["order"][c["turn"]], -1)      # the turn that ends counts its effects down
                    c["turn"] += 1
                    if c["turn"] >= n:
                        c["turn"], c["round"] = 0, c["round"] + 1
                else:
                    if c["turn"] == 0 and c["round"] == 1:
                        raise Fail("This is the first turn of the combat.")
                    c["turn"] -= 1
                    if c["turn"] < 0:
                        c["turn"], c["round"] = n - 1, c["round"] - 1
                    shift_effects(doc, c, c["order"][c["turn"]], +1)      # and the turn that is taken back counts them up again
            elif action == "move":
                tid = d.get("id")
                if tid not in c["order"]:
                    raise Fail("That is not in the combat.")
                to = d.get("to")
                if isinstance(to, bool) or not isinstance(to, int):
                    raise Fail("Say where to move it.")
                c["order"].remove(tid)
                c["order"].insert(max(0, min(len(c["order"]), to)), tid)
                if here is not None:
                    c["turn"] = c["order"].index(here)
            elif action == "set_init":
                tid = d.get("id")
                if tid not in c["order"]:
                    raise Fail("That is not in the combat.")
                if d.get("total") in (None, ""):
                    c["init"].pop(tid, None)
                else:
                    total = stat_value(d.get("total"))
                    c["init"][tid] = {"total": int(round(total)), "roll": None, "bonus": None, "label": "set by the DM"}
                    place(c, tid)
            elif action == "tick":
                if d.get("mode") not in ("own", "all"):
                    raise Fail("Pick whose effects count down.")
                c["tick"] = d["mode"]
            else:
                raise Fail("Unknown combat action.")
        save(doc)
    return jsonify(ok=True)


# ---------- initiative ----------
def initiative_choices(t):
    """What a token can roll initiative with: [{choice, label, bonus}] (KÉ without weapon first)."""
    data = KINDS[t["kind"]].read(t["ref"]).get("data") or {}
    if t["kind"] == "enemy":
        return [{"choice": -1, "label": "KÉ", "bonus": round(number(data.get("ke")) or 0)}]
    base = number(data.get("ke.wpn")) or 0
    mod = number(data.get("ke.mod")) or 0                       # Módosítók is added with every weapon
    out = [{"choice": -1, "label": "Fegyver nélkül", "bonus": round(base)}]
    for i in range(10):
        name, ke = str(data.get(f"w.{i}.n") or "").strip(), number(data.get(f"w.{i}.ke"))
        if name and ke is not None:
            out.append({"choice": i, "label": name, "bonus": round(base + ke + mod)})
    return out


def may_roll_for(t, doc):
    """The DM for anybody; a player for their own character."""
    if dm_or_player() == "dm":
        return
    if t["kind"] != "character":
        abort(403, "Only the dungeon master rolls for that.")
    may_change(t, doc)


@bp.get("/map/tokens/<tid>/initiative")
def initiative_get(tid):
    with _lock:
        doc = load()
        t = find(doc["tokens"], tid)
        if not t:
            raise Fail("That token is no longer on the map.")
        may_roll_for(t, doc)
        return jsonify(choices=initiative_choices(t))


@bp.post("/map/tokens/<tid>/initiative")
def initiative_roll(tid):
    d = request.get_json(silent=True) or {}
    choice = d.get("choice", -1)
    with _lock:
        doc = load()
        t = find(doc["tokens"], tid)
        if not t:
            raise Fail("That token is no longer on the map.")
        c = need_combat(doc)
        if tid not in c["order"]:
            raise Fail("That is not in the combat.")
        may_roll_for(t, doc)
        if dm_or_player() == "player" and (c["phase"] != "initiative" or tid in c["init"]):
            raise Fail("Initiative has been rolled already. Ask the dungeon master to clear it.")
        pick = next((x for x in initiative_choices(t) if x["choice"] == choice), None)
        if not pick:
            raise Fail("Pick one of the offered rolls.")
        numbers, shared = enemy_numbers(doc["tokens"]), {}
        for o in doc["tokens"]:
            if o["kind"] == "enemy":
                shared[o["ref"]] = shared.get(o["ref"], 0) + 1
        name = token_view(t, "dm", numbers, shared)["name"]
        roll = make_roll(f"1d10{pick['bonus']:+d}" if pick["bonus"] else "1d10", name,
                         "Kezdeményezés" + ("" if pick["choice"] == -1 else f" ({pick['label']})"))
        c["init"][tid] = {"total": roll["total"], "roll": roll["dice"][0], "bonus": pick["bonus"], "label": pick["label"]}
        place(c, tid)
        save(doc)
    return jsonify(total=roll["total"], roll=roll)


@bp.post("/map/tokens/<tid>/initiative/clear")
def initiative_clear(tid):
    need_dm()
    with _lock:
        doc = load()
        c = need_combat(doc)
        c["init"].pop(tid, None)
        save(doc)
    return jsonify(ok=True)


# ---------- walls and doors ----------
def add_segment(key, longest, limit, extra):
    need_dm()
    seg = seg_from(request.get_json(silent=True) or {}, longest)
    with _lock:
        doc = load()
        if len(doc[key]) >= limit:
            raise Fail("There are too many of those on the map.")
        oid = uuid.uuid4().hex
        doc[key].append({"id": oid, **seg, **extra})
        ensure_fog(doc)
        save(doc)
    return jsonify(id=oid)


def remove_segment(key, oid):
    need_dm()
    with _lock:
        doc = load()
        doc[key] = [o for o in doc[key] if o.get("id") != oid]
        ensure_fog(doc)
        save(doc)
    return jsonify(ok=True)


@bp.post("/map/walls")
def wall_add():
    return add_segment("walls", 40, MAX_WALLS, {})


@bp.post("/map/walls/<oid>/delete")
def wall_remove(oid):
    return remove_segment("walls", oid)


@bp.post("/map/doors")
def door_add():
    return add_segment("doors", 8, MAX_DOORS, {"open": False, "locked": False})


@bp.post("/map/doors/<oid>/delete")
def door_remove(oid):
    return remove_segment("doors", oid)


@bp.post("/map/doors/<oid>/toggle")
def door_toggle(oid):
    role = dm_or_player()
    with _lock:
        doc = load()
        door = find(doc["doors"], oid)
        if not door:
            raise Fail("That door is gone.")
        if role == "player":
            ensure_fog(doc)
            if doc["hidden"]:
                abort(403, "The map is hidden right now.")
            if door.get("locked"):
                abort(403, "That door is locked.")
            if not seg_known(seg_of(door)):
                abort(403, "You can't reach that door.")
        door["open"] = not door.get("open")
        ensure_fog(doc)                      # opening a door lets sight through at once
        save(doc)
        return jsonify(open=door["open"])


@bp.post("/map/doors/<oid>/lock")
def door_lock(oid):
    need_dm()
    d = request.get_json(silent=True) or {}
    with _lock:
        doc = load()
        door = find(doc["doors"], oid)
        if not door:
            raise Fail("That door is gone.")
        door["locked"] = bool(d.get("locked"))
        save(doc)
    return jsonify(locked=door["locked"])


# ---------- settings and fog ----------
@bp.post("/map/settings")
def map_settings():
    need_dm()
    d = request.get_json(silent=True) or {}
    with _lock:
        doc = load()
        if "vision" in d:
            v = d["vision"]
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not 1 <= v <= 20:
                raise Fail("Vision must be between 1 and 20 squares.")
            doc["vision"] = int(v)
        if "hidden" in d:
            doc["hidden"] = bool(d["hidden"])
        ensure_fog(doc)
        save(doc)
    return jsonify(vision=doc["vision"], hidden=doc["hidden"])


@bp.post("/map/fog/reset")
def fog_reset():
    need_dm()
    with _lock:
        doc = load()
        doc["explored"] = ""
        _fog["sig"] = None
        ensure_fog(doc)                      # what is in view right now is explored again at once
        save(doc)
    return jsonify(ok=True)


# ---------- saved maps ----------
def save_path(sid):
    if not HEX.match(sid):
        abort(404, "No such saved map.")
    return saves_dir() / f"{sid}.json"


def read_save(path):
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) and isinstance(d.get("doc"), dict) else None
    except (OSError, ValueError):
        return None


@bp.get("/map/saves")
def saves_list():
    need_dm()
    out = []
    folder = saves_dir()
    if folder.is_dir():
        for p in folder.glob("*.json"):
            d = read_save(p)
            if d:
                doc = d["doc"]
                out.append({"id": d["id"], "name": d["name"], "saved": d["saved"], "tokens": len(doc.get("tokens", [])),
                            "walls": len(doc.get("walls", [])), "doors": len(doc.get("doors", []))})
    out.sort(key=lambda s: -s["saved"])
    return jsonify(saves=out)


@bp.post("/map/saves")
def saves_create():
    need_dm()
    name = re.sub(r"[\x00-\x1f\x7f]", "", str((request.get_json(silent=True) or {}).get("name", ""))).strip()[:60]
    if not name:
        raise Fail("Give the save a name.")
    with _lock:
        doc = load()
        folder = saves_dir()
        folder.mkdir(parents=True, exist_ok=True)
        old = next((d for d in map(read_save, folder.glob("*.json")) if d and d["name"].casefold() == name.casefold()), None)
        if not old and len(list(folder.glob("*.json"))) >= MAX_SAVES:
            raise Fail("There are too many saved maps. Delete some first.")
        sid = old["id"] if old else uuid.uuid4().hex
        body = {k: doc[k] for k in ("tokens", "walls", "doors", "vision", "explored")}
        tmp = folder / f"{sid}.tmp"
        tmp.write_text(json.dumps({"id": sid, "name": name, "saved": int(time.time()), "doc": body}), encoding="utf-8")
        os.replace(tmp, save_path(sid))
    return jsonify(id=sid, name=name, replaced=bool(old))


@bp.post("/map/saves/<sid>/load")
def saves_load(sid):
    need_dm()
    d = read_save(save_path(sid))
    if not d:
        raise Fail("That saved map could not be read.")
    with _lock:
        doc = load()
        src = d["doc"]
        for key in ("tokens", "walls", "doors"):
            doc[key] = src.get(key) if isinstance(src.get(key), list) else []
        doc["vision"] = src.get("vision") if isinstance(src.get("vision"), (int, float)) else 7
        doc["explored"] = src.get("explored") if isinstance(src.get("explored"), str) else ""
        doc["hidden"] = True                 # check it over first; show it to the players when ready
        doc["combat"] = None                 # the fighters of the old map are gone
        _fog["sig"] = None
        ensure_fog(doc)
        save(doc)
    return jsonify(name=d["name"])


@bp.post("/map/saves/<sid>/delete")
def saves_delete(sid):
    need_dm()
    save_path(sid).unlink(missing_ok=True)
    return jsonify(ok=True)
