"""The shared tabletop map on pages/tabletop.*. One map for everybody. The board is 16 x 10 squares ("cells"); tokens
are stored as 0..1 fractions of the board, walls and doors in cells (snapped to half a cell).

  tokens  {id, kind: "character" | "enemy", ref, x, y}   ref points at a sheet; name and portrait are read from it.
          A character's HP is read from its sheet. Every enemy token has its own HP (hp, max, fp, fpmax, copied from the
          enemy sheet when it is put on the map and edited per token), so three goblins keep three separate HPs.
  walls   {id, x1, y1, x2, y2}                           block sight
  doors   {id, x1, y1, x2, y2, open, locked}             block sight while closed
  vision  how many cells a player character can see      hidden  true = players see nothing (the DM is arranging)

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


def token_view(t, role, numbers, shared):
    """One token as the caller may see it. Players never get an enemy's HP: with the numbers missing, the map draws no
    health bars on it, no HP labels and no grey, so nothing about an enemy's health is left to read."""
    s = summary(t["kind"], t["ref"])
    out = {"id": t["id"], "kind": t["kind"], "x": t["x"], "y": t["y"], **s}
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
        if ensure_fog(doc) or pruned:
            save(doc)
        out = {"role": role, "vision": doc["vision"], "hidden": doc["hidden"], "tokens": [], "walls": [], "doors": [], "fog": None}
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
        ensure_fog(doc)
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
        _fog["sig"] = None
        ensure_fog(doc)
        save(doc)
    return jsonify(name=d["name"])


@bp.post("/map/saves/<sid>/delete")
def saves_delete(sid):
    need_dm()
    save_path(sid).unlink(missing_ok=True)
    return jsonify(ok=True)
