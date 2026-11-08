"""The shared tabletop map on pages/tabletop.*. One map for everybody. The board is cols x rows squares ("cells"), set by
the dungeon master (default 16 x 10, at most 60 x 60). Tokens, walls, doors and windows are all stored in cells (walls
snapped to half a cell). Older maps stored tokens as 0..1 fractions of a 16 x 10 board; load() converts them.

  tokens  {id, kind: "character" | "enemy", ref, x, y}   ref points at a sheet; name and portrait are read from it.
          A character's HP is read from its sheet. Every enemy token has its own HP (hp, max, fp, fpmax, copied from the
          enemy sheet when it is put on the map and edited per token), so three goblins keep three separate HPs.
  walls   {id, x1, y1, x2, y2}                           block sight and movement
  doors   {id, x1, y1, x2, y2, open}                     a wall part turned into a door: blocks sight and movement while
                                                         closed. Only the dungeon master opens or closes it.
  windows {id, x1, y1, x2, y2}                           a wall part turned into a window: blocks movement, but lets sight
                                                         through, seen only half as far behind it as it would be without it
  vision  how many cells a player character can see by day (the "day sight")      hidden  true = players see nothing (the DM is arranging)
  lights  {id, x, y, r}    a light source: the area around it (radius r, stopped by walls) is lit, and lit areas are seen from
                           twice the day sight away
  areas   {id, name, color, desc, cells: ["x,y,p", ...]}   named, coloured parts of the map. A piece p of the square (x, y) is
                           "f" (the whole square), "q0".."q3" (a quarter: top left, top right, bottom left, bottom right) or
                           "t0".."t3" (a diagonal half: the triangle whose right angle is at that same corner)
  night   true = it is night. night_sight / dark_range: how far a character sees in the dark without / with darkvision (1 / 4)

Light: by day everything outside a building is lit. A building is any space closed in by walls, doors and windows (the walls
are rasterised and the open space that cannot be reached from the edge of the map is "inside"); inside, only light sources and
the spots next to windows and open doors are lit. At night only light sources are lit. A character sees: its own surroundings
(night_sight squares, or dark_range with darkvision), plus lit ground by day sight (day only: the ground lit by the sun) and
lit ground around light sources up to twice the day sight away, always in line of sight.

Players cannot walk through walls, windows or closed doors (the server stops a dragged token at the first one); the dungeon
master can move tokens through anything.

Effects: a token can carry effects {n, t}. At the start of every round of combat (not every turn) t counts down by one for every
participant, and back up when the DM goes back to the previous round. t may go below 0 (shown as ended) so that going back always restores exactly what going forward changed.
Combat: doc["combat"] = {phase: "initiative" | "fighting", order: [token ids], init: {id: {total, roll, bonus, label}}, turn,
round}. Everybody taking part rolls k10 + KÉ (a character without weapon unless it picks one); the order is highest first
and the DM may move anybody. Players only see participants they can see on the map (enemies out of sight are left out).

Fog of war is worked out here, not in the browser, so players are only ever sent what they may see: every character
token sees in a circle around it, stopped by walls and closed doors; what has been seen stays "explored" (dimmed) and
is stored; enemies are only sent while in view; walls and doors only once seen. The fog itself is a small PNG.

  GET  /api/map                       everything the caller may see (see roles.py: players get the filtered version)
  GET  /api/map/fog.png               the fog overlay (black = unexplored, dim = explored, clear = in view); ?sharp=1 for hard edges
  POST /api/map/tokens                {kind, ref, count?}  add (players: characters only; DM: up to 20 enemies at once)
  POST /api/map/tokens/<id>           {x, y}       move, in cells (players: characters only, stopped by walls). -> {x, y} where it ended up
  POST /api/map/tokens/<id>/delete                 take off the map (players: characters only)
  POST /api/map/tokens/<id>/stats     {hp?, max?, fp?, fpmax?}  change Ép / Fp. Enemies: DM. Characters: DM, or whoever
                                      has the sheet open (a locked sheet needs its password). Enemy HP is never sent to players.
  GET  /api/map/tokens/<id>/portrait               the token's portrait (enemy ids are never sent to players)
  POST /api/map/tokens/<id>/effects   {effects: [{n, t}]}  the token's effects (n = name, t = turns left, null = no limit).
                                      Enemies: DM. Characters: DM, or whoever has the sheet open. Everybody who sees a token sees them.
  GET  /api/map/tokens/<id>/initiative  -> {choices: [{choice, label, bonus}]}  what the token can roll initiative with (DM, or its player)
  POST /api/map/tokens/<id>/initiative  {choice}   roll k10 + that bonus for the combat (choice -1 = KÉ without weapon, 0..9 = a weapon)
  POST /api/map/combat                {action, ...}  DM: start {ids} | participants {ids} | begin {force?} | next | prev | end |
                                      move {id, to} | set_init {id, total}  (see "combat" below)
  POST /api/map/walls                 {x1, y1, x2, y2}   DM draws a wall
  POST /api/map/<walls|doors|windows>/<id>/delete   DM
  POST /api/map/<walls|doors|windows>/<id>/convert  {to: "wall" | "door" | "window"}   DM turns that part into something else
  POST /api/map/doors/<id>/toggle     DM opens / closes a door
  POST /api/map/settings              {vision?, hidden?, cols?, rows?, night?, night_sight?, dark_range?}   DM (cols / rows = the board size in squares)
  POST /api/map/lights                {x, y, r?}   DM adds a light source          POST /api/map/lights/<id>  {x?, y?, r?}  change it
  POST /api/map/lights/<id>/delete    DM
  POST /api/map/areas/paint           {name, color, desc, pieces: [{x, y, p}], erase?}   DM paints (or, with erase, clears) pieces. An area
                                      with that name is changed, or made.
  POST /api/map/areas/<id>            {name?, color?, desc?}   DM          POST /api/map/areas/<id>/delete   DM
  POST /api/map/tokens/<id>/darkvision {on}   switch a character's darkvision on or off (DM, or whoever has the sheet open)
  POST /api/map/fog/reset             forget what was explored   DM
  GET  /api/map/saves                 DM    -> {saves: [{id, name, saved, tokens, walls, doors, windows}]}
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
from errors import Fail
from . import bp
from .rolls import make_roll
from .roles import current_role, need_dm

DEF_COLS, DEF_ROWS, MAX_SIDE, PPC = 16, 10, 60, 20     # default board size and the largest side, in cells; fog pixels per cell
WALL, WINDOW = 0, 1                           # what a sight blocker is: opaque, or a window (sight goes through, halved)
SEGS = {"wall": "walls", "door": "doors", "window": "windows"}
MARGIN = 0.12                                 # how close to a wall a player's token may come, in cells
KINDS = {"character": characters, "enemy": enemies}
MAX_TOKENS, MAX_SEGS, MAX_SAVES = 200, 1500, 100
NIGHT_SIGHT, DARK_RANGE, OPEN_R = 1, 4, 3      # defaults: sight at night, darkvision range, how far the day shines in through a window or open door
IN = 6                                         # pixels per cell when working out which space is inside a building
MAX_LIGHTS, MAX_AREAS, MAX_PIECES = 80, 60, 20000
PIECE = re.compile(r"^(?:f|[qt][0-3])$")
COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
HEX = re.compile(r"^[0-9a-f]{32}$")
_lock = threading.RLock()
_cache = {}                                   # sheet path -> (mtime_ns, summary), so polling does not re-read every sheet


class _FogStore:
    """The fog cache, kept separately for every campaign (each has its own map). Used like a dict."""

    def __init__(self):
        self._all = {}

    def _cur(self):
        return self._all.setdefault(campaigns.current_id(), {"sig": None, "key": None, "explored": None, "vis": None,
                                                              "known": None, "png": b"", "hash": "", "isig": None, "indoor": None, "png_sharp": b""})

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
    for key in ("tokens", "walls", "doors", "windows", "lights", "areas"):
        if not isinstance(doc.get(key), list):
            doc[key] = []
    migrate(doc)
    doc["night"] = doc.get("night") is True
    for key, default in (("night_sight", NIGHT_SIGHT), ("dark_range", DARK_RANGE)):
        v = doc.get(key)
        doc[key] = v if isinstance(v, (int, float)) and not isinstance(v, bool) and 1 <= v <= 20 else default
    if isinstance(doc.get("vision"), bool) or not isinstance(doc.get("vision"), (int, float)):
        doc["vision"] = 7
    if not isinstance(doc.get("hidden"), bool):
        doc["hidden"] = False
    if not isinstance(doc.get("explored"), str):
        doc["explored"] = ""
    if not isinstance(doc.get("combat"), dict):
        doc["combat"] = None
    return doc


def side(v, default):
    return int(v) if isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= MAX_SIDE else default


def migrate(doc):
    """Give a map its size. A map from before the board could be resized has tokens as 0..1 fractions of 16 x 10."""
    if "cols" not in doc:
        for t in doc.get("tokens", []):
            if isinstance(t, dict):
                t["x"], t["y"] = round(float(t.get("x", 0.5)) * DEF_COLS, 3), round(float(t.get("y", 0.5)) * DEF_ROWS, 3)
        doc["cols"], doc["rows"] = DEF_COLS, DEF_ROWS
    doc["cols"], doc["rows"] = side(doc["cols"], DEF_COLS), side(doc["rows"], DEF_ROWS)


def dims(doc):
    return doc["cols"], doc["rows"]


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
        st = path.stat()
        stamp = (st.st_mtime_ns, st.st_size, st.st_ino)          # every save replaces the file, so a coarse clock cannot hide a change
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
    """What stops sight: (x1, y1, x2, y2, WALL | WINDOW). Walls and closed doors are opaque; a window lets sight through."""
    segs = [(w["x1"], w["y1"], w["x2"], w["y2"], WALL) for w in doc["walls"]]
    segs += [(d["x1"], d["y1"], d["x2"], d["y2"], WALL) for d in doc["doors"] if not d.get("open")]
    segs += [(w["x1"], w["y1"], w["x2"], w["y2"], WINDOW) for w in doc["windows"]]
    return segs


def movement_blockers(doc):
    """What stops a player's token: walls, windows and closed doors."""
    return [s[:4] for s in blockers(doc)]


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
    """The area one viewer sees: a circle cut short by walls (rays towards every wall end, and a few around). A ray that
    goes through a window carries on, but only half of what it had left: behind a window you see half as far."""
    near = [s for s in segs if max(s[0], s[2]) >= px - radius and min(s[0], s[2]) <= px + radius
            and max(s[1], s[3]) >= py - radius and min(s[1], s[3]) <= py + radius]
    angles = {math.radians(k) for k in range(-180, 180, 4)}      # the same range atan2 gives, so the sorted rays go once round
    for x1, y1, x2, y2, _kind in near:
        for x, y in ((x1, y1), (x2, y2)):
            a = math.atan2(y - py, x - px)
            angles.update((a - 1e-4, a, a + 1e-4))
    pts = []
    for a in sorted(angles):
        dx, dy = math.cos(a), math.sin(a)
        hits = sorted((h, s[4]) for s in near if (h := ray_hit(px, py, dx, dy, *s[:4])) is not None)
        reach = radius
        for h, kind in hits:
            if h >= reach:
                break
            if kind == WALL:
                reach = h
                break
            reach = h + (reach - h) / 2
        pts.append((px + dx * reach, py + dy * reach))
    return pts


def sweep(doc, x0, y0, x1, y1):
    """Where a token that is dragged from (x0, y0) towards (x1, y1) ends up when walls, windows and closed doors stop it:
    the first one in the way, less a small margin. Used for players; the dungeon master moves freely."""
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy)
    if length < 1e-9:
        return x1, y1
    first = 1.0
    for s in movement_blockers(doc):
        h = ray_hit(x0, y0, dx, dy, *s)
        if h is not None and 1e-6 < h < first:
            first = h
    if first >= 1.0:
        return x1, y1
    k = max(0.0, first - MARGIN / length)
    return round(x0 + dx * k, 4), round(y0 + dy * k, 4)


def _decode(b64, size):
    try:
        im = Image.open(io.BytesIO(base64.b64decode(b64))).convert("L") if b64 else None
    except Exception:
        return None
    return im if im is not None and im.size == size else None


def _encode(im):
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


def _pts(poly):
    return [(x * PPC, y * PPC) for x, y in poly]


def _shape(size, px, py, radius, segs):
    im = Image.new("L", size, 0)
    ImageDraw.Draw(im).polygon(_pts(view_polygon(px, py, radius, segs)), fill=255)
    return im


def indoor_mask(doc):
    """255 where a point is inside a building: space closed in by walls, doors (open or shut) and windows, that cannot be
    reached from the edge of the map without crossing one. Worked out on a coarse grid, then scaled to the fog's size."""
    cols, rows = dims(doc)
    segs = [seg_of(o) for key in SEGS.values() for o in doc[key]]
    sig = hashlib.md5(json.dumps([segs, cols, rows]).encode()).hexdigest()
    if _fog["isig"] == sig:
        return _fog["indoor"]
    W, H = cols * IN, rows * IN
    wall = Image.new("L", (W + 1, H + 1), 0)
    d = ImageDraw.Draw(wall)
    for x1, y1, x2, y2 in segs:
        d.line([(x1 * IN, y1 * IN), (x2 * IN, y2 * IN)], fill=255, width=2)
    free = np.asarray(wall) == 0
    reach = np.zeros_like(free)
    reach[0, :] = reach[-1, :] = reach[:, 0] = reach[:, -1] = True
    reach &= free
    while True:                                  # flood in from the edge, one pixel further each round
        n = reach.copy()
        n[1:, :] |= reach[:-1, :]; n[:-1, :] |= reach[1:, :]; n[:, 1:] |= reach[:, :-1]; n[:, :-1] |= reach[:, 1:]
        n &= free
        if (n == reach).all():
            break
        reach = n
    inside = (free & ~reach).astype(np.uint8) * 255
    im = Image.fromarray(inside).crop((0, 0, W, H)).resize((cols * PPC, rows * PPC), Image.NEAREST)
    _fog["isig"], _fog["indoor"] = sig, im
    return im


def _is_in(img, x, y):
    return img.getpixel((min(img.width - 1, max(0, int(x * PPC))), min(img.height - 1, max(0, int(y * PPC))))) > 127


def openings(doc, indoor):
    """Windows and open doors that have a building on one side: (x, y, segment) with the point just inside, where daylight comes in."""
    out = []
    for key in ("windows", "doors"):
        for o in doc[key]:
            if key == "doors" and not o.get("open"):
                continue
            x1, y1, x2, y2 = seg_of(o)
            ln = math.hypot(x2 - x1, y2 - y1)
            if ln < 1e-9:
                continue
            mx, my, nx, ny = (x1 + x2) / 2, (y1 + y2) / 2, -(y2 - y1) / ln, (x2 - x1) / ln
            a, b = _is_in(indoor, mx + nx * .3, my + ny * .3), _is_in(indoor, mx - nx * .3, my - ny * .3)
            if a != b:
                k = 1 if a else -1
                out.append((mx + nx * k * .08, my + ny * k * .08, (x1, y1, x2, y2)))
    return out


def ensure_fog(doc):
    """Bring the fog up to date with the characters, walls, doors, lights and the time of day. Returns True when
    doc["explored"] changed (the caller then saves the document)."""
    cols, rows = dims(doc)
    FW, FH = cols * PPC, rows * PPC
    chars = sorted((round(t["x"], 3), round(t["y"], 3), bool(t.get("dark"))) for t in doc["tokens"]
                   if t.get("kind") == "character" and summary("character", t.get("ref")) is not None)
    segs, day_sight = blockers(doc), max(1, min(20, float(doc["vision"])))
    night, dark, ns = doc["night"], float(doc["dark_range"]), float(doc["night_sight"])
    lights = [(l["x"], l["y"], l["r"]) for l in doc["lights"]]
    sig = hashlib.md5(json.dumps([chars, segs, day_sight, cols, rows, night, dark, ns, lights, doc["doors"], doc["windows"]]).encode()).hexdigest()
    if _fog["sig"] == sig:
        return False
    size = (FW, FH)
    indoor = indoor_mask(doc)
    ambient = None                                # the ground the sun lights: everything outside a building, and the spots a window or open door lights
    if not night:
        ambient = ImageChops.invert(indoor)
        da = ImageDraw.Draw(ambient)
        for sx, sy, own in openings(doc, indoor):
            da.polygon(_pts(view_polygon(sx, sy, OPEN_R, [g for g in segs if g[:4] != own])), fill=255)
    pools = None                                  # the ground the light sources light
    if lights:
        pools = Image.new("L", size, 0)
        dp = ImageDraw.Draw(pools)
        for lx, ly, lr in lights:
            dp.polygon(_pts(view_polygon(lx, ly, lr, segs)), fill=255)
    vis = Image.new("L", size, 0)
    draw = ImageDraw.Draw(vis)
    for px, py, dv in chars:
        draw.polygon(_pts(view_polygon(px, py, dark if dv else ns, segs)), fill=255)             # what is close enough to see in the dark
        if ambient is not None:
            vis.paste(255, mask=ImageChops.darker(_shape(size, px, py, day_sight, segs), ambient))  # lit by the sun, within day sight
        if pools is not None:
            vis.paste(255, mask=ImageChops.darker(_shape(size, px, py, min(40.0, day_sight * 2), segs), pools))   # lit by a light source, from twice as far
    if _fog["key"] != doc["explored"] or _fog["explored"] is None or _fog["explored"].size != (FW, FH):
        _fog["explored"], _fog["key"] = _decode(doc["explored"], (FW, FH)) or Image.new("L", (FW, FH), 0), doc["explored"]
    old = _fog["explored"]
    new = ImageChops.lighter(old, vis)
    changed = ImageChops.difference(new, old).getbbox() is not None
    if changed:
        doc["explored"] = _encode(new)
    _fog["explored"], _fog["key"] = new, doc["explored"]
    v, e = np.asarray(vis) > 127, np.asarray(new) > 127
    alpha = np.where(v, 0, np.where(e, 150, 255)).astype(np.uint8)
    dark_im = Image.new("L", (FW, FH), 8)

    def picture(a):
        out = io.BytesIO()
        Image.merge("RGBA", (dark_im, dark_im, dark_im, a)).save(out, "PNG", optimize=True)
        return out.getvalue()
    sharp = Image.fromarray(alpha)                                            # a hard edge between light and darkness
    soft = picture(sharp.filter(ImageFilter.GaussianBlur(1.2)))               # the default: a softened edge
    _fog.update(sig=sig, vis=vis, known=ImageChops.lighter(vis, new), png=soft, png_sharp=picture(sharp),
                hash=hashlib.md5(soft).hexdigest()[:10])
    return changed


def _lit(img, x, y):
    px, py = min(img.width - 1, max(0, int(x * PPC))), min(img.height - 1, max(0, int(y * PPC)))
    return img.crop((max(0, px - 1), max(0, py - 1), px + 2, py + 2)).getextrema()[1] > 127


def token_in_view(t):
    return _lit(_fog["vis"], t["x"], t["y"])


def seg_known(s):
    """Has any part of this wall or door been in view?"""
    x1, y1, x2, y2 = s
    pts = ((x1, y1), (x2, y2), ((x1 + x2) / 2, (y1 + y2) / 2), (x1 * .75 + x2 * .25, y1 * .75 + y2 * .25), (x1 * .25 + x2 * .75, y1 * .25 + y2 * .75))
    return any(_lit(_fog["known"], x, y) for x, y in pts)


def seg_of(o):
    return (o["x1"], o["y1"], o["x2"], o["y2"])


# ---------- checking what browsers send ----------
def coord(v, top):
    """A position in cells, kept on the board."""
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v:
        raise Fail("That position is not valid.")
    return round(min(float(top), max(0.0, float(v))), 4)


def cell(v, top):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or not 0 <= v <= top:
        raise Fail("That point is outside the map.")
    return round(v * 2) / 2


def seg_from(d, longest, cols, rows):
    x1, y1, x2, y2 = cell(d.get("x1"), cols), cell(d.get("y1"), rows), cell(d.get("x2"), cols), cell(d.get("y2"), rows)
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
        out["dark"] = bool(t.get("dark"))                      # darkvision switched on
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
        out = {"role": role, "vision": doc["vision"], "hidden": doc["hidden"], "cols": doc["cols"], "rows": doc["rows"],
               "night": doc["night"], "night_sight": doc["night_sight"], "dark_range": doc["dark_range"],
               "tokens": [], "walls": [], "doors": [], "windows": [], "lights": [], "areas": [], "fog": None, "combat": None}
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
        for key in ("walls", "doors", "windows"):
            out[key] = [o for o in doc[key] if role == "dm" or seg_known(seg_of(o))]
        out["lights"] = [l for l in doc["lights"] if role == "dm" or _lit(_fog["known"], l["x"], l["y"])]
        out["areas"] = areas_view(doc, role)
        out["fog"] = _fog["hash"]
        return jsonify(out)


@bp.get("/map/fog.png")
def map_fog():
    with _lock:
        doc = load()
        if ensure_fog(doc):
            save(doc)
        png = _fog["png_sharp"] if request.args.get("sharp") == "1" else _fog["png"]
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
            cols, rows = dims(doc)
            token = {"id": tid, "kind": kind, "ref": ref, "x": round(min(cols - 0.5, 1.25 + (n % 10) * 1.4), 4),
                     "y": round(min(rows - 0.5, 1.25 + (n // 10 % 7) * 1.2), 4)}
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
    with _lock:
        doc = load()
        cols, rows = dims(doc)
        x, y = coord(d.get("x"), cols), coord(d.get("y"), rows)
        t = find(doc["tokens"], tid)
        if not t:
            raise Fail("That token is no longer on the map.")
        if dm_or_player() == "player":
            if t["kind"] != "character":
                abort(403, "Only the dungeon master can move that.")
            if doc["hidden"]:
                abort(403, "The map is hidden right now.")
            way = d.get("path") if isinstance(d.get("path"), list) else []          # the places the drag went through, in order
            px, py = t["x"], t["y"]
            for pt in [q for q in way[:150] if isinstance(q, (list, tuple)) and len(q) == 2] + [[x, y]]:
                px, py = sweep(doc, px, py, coord(pt[0], cols), coord(pt[1], rows))   # walls, windows and closed doors stop a player
            x, y = px, py                                                           # the DM walks through them
        t["x"], t["y"] = x, y
        ensure_fog(doc)                      # what the character sees from here is now explored
        save(doc)
    return jsonify(ok=True, x=x, y=y)


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
    return out


def need_combat(doc, phase=None):
    c = doc.get("combat")
    if not c:
        raise Fail("There is no combat.")
    if phase and c["phase"] != phase:
        raise Fail("The combat is " + ("already under way." if phase == "initiative" else "still waiting for initiative rolls."))
    return c


def shift_effects(doc, c, step):
    """A new round counts the effects of every fighter down by one (step -1); going back to the round before, up again (+1)."""
    for t in doc["tokens"]:
        if t["id"] in c["order"]:
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
            doc["combat"] = {"phase": "initiative", "order": ids, "init": {}, "turn": 0, "round": 1}
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
                    c["turn"] += 1
                    if c["turn"] >= n:
                        c["turn"], c["round"] = 0, c["round"] + 1
                        shift_effects(doc, c, -1)                        # a new round: every effect has one round less left
                else:
                    if c["turn"] == 0 and c["round"] == 1:
                        raise Fail("This is the first turn of the combat.")
                    c["turn"] -= 1
                    if c["turn"] < 0:
                        c["turn"], c["round"] = n - 1, c["round"] - 1
                        shift_effects(doc, c, +1)                        # back to the round before: they count up again
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


# ---------- walls, doors and windows ----------
# The dungeon master draws walls. Clicking a wall part turns it into a door or a window (and back); a door is opened and
# closed by the dungeon master only.
@bp.post("/map/walls")
def wall_add():
    need_dm()
    with _lock:
        doc = load()
        seg = seg_from(request.get_json(silent=True) or {}, MAX_SIDE, *dims(doc))
        if sum(len(doc[k]) for k in SEGS.values()) >= MAX_SEGS:
            raise Fail("There are too many walls on the map.")
        oid = uuid.uuid4().hex
        doc["walls"].append({"id": oid, **seg})
        ensure_fog(doc)
        save(doc)
    return jsonify(id=oid)


@bp.post("/map/<kind>/<oid>/delete")
def segment_remove(kind, oid):
    need_dm()
    if kind not in SEGS.values():
        abort(404)
    with _lock:
        doc = load()
        doc[kind] = [o for o in doc[kind] if o.get("id") != oid]
        ensure_fog(doc)
        save(doc)
    return jsonify(ok=True)


@bp.post("/map/<kind>/<oid>/convert")
def segment_convert(kind, oid):
    need_dm()
    to = (request.get_json(silent=True) or {}).get("to")
    if kind not in SEGS.values() or to not in SEGS:
        raise Fail("Pick wall, door or window.")
    with _lock:
        doc = load()
        o = find(doc[kind], oid)
        if not o:
            raise Fail("That part of the wall is gone.")
        if SEGS[to] != kind:
            doc[kind] = [x for x in doc[kind] if x is not o]
            new = {"id": o["id"], "x1": o["x1"], "y1": o["y1"], "x2": o["x2"], "y2": o["y2"]}
            if to == "door":
                new["open"] = False
            doc[SEGS[to]].append(new)
            ensure_fog(doc)
            save(doc)
    return jsonify(ok=True)


@bp.post("/map/doors/<oid>/toggle")
def door_toggle(oid):
    need_dm()                                # players cannot open doors
    with _lock:
        doc = load()
        door = find(doc["doors"], oid)
        if not door:
            raise Fail("That door is gone.")
        door["open"] = not door.get("open")
        ensure_fog(doc)                      # opening a door lets sight through at once
        save(doc)
        return jsonify(open=door["open"])


# ---------- light sources ----------
def radius_of(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not 1 <= v <= 20:
        raise Fail("A light reaches 1 to 20 squares.")
    return round(v * 2) / 2


@bp.post("/map/lights")
def light_add():
    need_dm()
    d = request.get_json(silent=True) or {}
    with _lock:
        doc = load()
        cols, rows = dims(doc)
        if len(doc["lights"]) >= MAX_LIGHTS:
            raise Fail("There are too many light sources on the map.")
        oid = uuid.uuid4().hex
        doc["lights"].append({"id": oid, "x": cell(d.get("x"), cols), "y": cell(d.get("y"), rows), "r": radius_of(d.get("r", 3))})
        ensure_fog(doc)
        save(doc)
    return jsonify(id=oid)


@bp.post("/map/lights/<oid>")
def light_change(oid):
    need_dm()
    d = request.get_json(silent=True) or {}
    with _lock:
        doc = load()
        cols, rows = dims(doc)
        light = find(doc["lights"], oid)
        if not light:
            raise Fail("That light is gone.")
        if "x" in d:
            light["x"] = cell(d["x"], cols)
        if "y" in d:
            light["y"] = cell(d["y"], rows)
        if "r" in d:
            light["r"] = radius_of(d["r"])
        ensure_fog(doc)
        save(doc)
    return jsonify(ok=True)


@bp.post("/map/lights/<oid>/delete")
def light_remove(oid):
    need_dm()
    with _lock:
        doc = load()
        doc["lights"] = [o for o in doc["lights"] if o.get("id") != oid]
        ensure_fog(doc)
        save(doc)
    return jsonify(ok=True)


@bp.post("/map/tokens/<tid>/darkvision")
def map_darkvision(tid):
    on = bool((request.get_json(silent=True) or {}).get("on"))
    with _lock:
        doc = load()
        t = find(doc["tokens"], tid)
        if not t or t["kind"] != "character":
            raise Fail("Only a character on the map has darkvision.")
        may_change(t, doc)
        t["dark"] = on
        ensure_fog(doc)
        save(doc)
    return jsonify(on=on)


# ---------- areas ----------
def piece_centre(key):
    """The middle of a piece "x,y,p" in cells (for the triangles, their centre of gravity)."""
    x, y, p = key.split(",")
    x, y = int(x), int(y)
    if p == "f":
        return x + .5, y + .5
    k = int(p[1])
    right, bottom = k % 2, k // 2
    if p[0] == "q":
        return x + .25 + .5 * right, y + .25 + .5 * bottom
    return x + (2 / 3 if right else 1 / 3), y + (2 / 3 if bottom else 1 / 3)


def areas_view(doc, role):
    """Areas as the caller may see them: the DM all of it, players only the pieces they have seen or explored."""
    out = []
    for a in doc["areas"]:
        cells = a["cells"] if role == "dm" else [c for c in a["cells"] if _lit(_fog["known"], *piece_centre(c))]
        if cells:
            out.append({"id": a["id"], "name": a["name"], "color": a["color"], "desc": a["desc"], "cells": cells})
    return out


def clean_text(v, limit, lines=False):
    keep = r"[\x00-\x08\x0b-\x1f\x7f]" if lines else r"[\x00-\x1f\x7f]"
    return re.sub(keep, "", str(v or "")).strip()[:limit]


def area_fields(d, need_name=True):
    name = clean_text(d.get("name"), 40)
    if need_name and not name:
        raise Fail("Give the area a name.")
    color = d.get("color", "#8a5bd8")
    if not isinstance(color, str) or not COLOR.match(color):
        raise Fail("Pick a colour for the area.")
    return name, color.lower(), clean_text(d.get("desc"), 500, lines=True)


@bp.post("/map/areas/paint")
def area_paint():
    need_dm()
    d = request.get_json(silent=True) or {}
    erase = bool(d.get("erase"))
    raw = d.get("pieces") if isinstance(d.get("pieces"), list) else []
    if len(raw) > 400:
        raise Fail("That is too many pieces at once.")
    with _lock:
        doc = load()
        cols, rows = dims(doc)
        keys = []
        for q in raw:
            ok = isinstance(q, dict) and isinstance(q.get("x"), int) and isinstance(q.get("y"), int) and not isinstance(q.get("x"), bool) \
                and 0 <= q["x"] < cols and 0 <= q["y"] < rows and isinstance(q.get("p"), str) and PIECE.match(q["p"])
            if not ok:
                raise Fail("That piece is not on the map.")
            k = f'{q["x"]},{q["y"]},{q["p"]}'
            if k not in keys:
                keys.append(k)
        areas, gone = doc["areas"], set(keys)
        if erase:
            for a in areas:
                a["cells"] = [c for c in a["cells"] if c not in gone]
            doc["areas"] = [a for a in areas if a["cells"]]
            aid = None
        else:
            name, color, desc = area_fields(d)
            area = next((a for a in areas if a["name"].casefold() == name.casefold()), None)
            if not area:
                if len(areas) >= MAX_AREAS:
                    raise Fail("There are too many areas. Delete some first.")
                area = {"id": uuid.uuid4().hex, "name": name, "color": color, "desc": desc, "cells": []}
                areas.append(area)
            area.update(name=name, color=color, desc=desc)
            for a in areas:
                if a is not area:
                    a["cells"] = [c for c in a["cells"] if c not in gone]
            have = set(area["cells"])
            area["cells"] += [k for k in keys if k not in have]
            doc["areas"] = [a for a in areas if a["cells"] or a is area]
            if sum(len(a["cells"]) for a in doc["areas"]) > MAX_PIECES:
                raise Fail("The areas are too big. Delete some first.")
            aid = area["id"]
        save(doc)
    return jsonify(id=aid)


@bp.post("/map/areas/<oid>")
def area_change(oid):
    need_dm()
    d = request.get_json(silent=True) or {}
    with _lock:
        doc = load()
        area = find(doc["areas"], oid)
        if not area:
            raise Fail("That area is gone.")
        name, color, desc = area_fields({**area, **d})
        if any(a is not area and a["name"].casefold() == name.casefold() for a in doc["areas"]):
            raise Fail("Another area already has that name.")
        area.update(name=name, color=color, desc=desc)
        save(doc)
    return jsonify(ok=True)


@bp.post("/map/areas/<oid>/delete")
def area_remove(oid):
    need_dm()
    with _lock:
        doc = load()
        doc["areas"] = [a for a in doc["areas"] if a.get("id") != oid]
        save(doc)
    return jsonify(ok=True)


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
        if "night" in d:
            doc["night"] = bool(d["night"])
        for key, label in (("night_sight", "Night sight"), ("dark_range", "Darkvision")):
            if key in d:
                v = d[key]
                if isinstance(v, bool) or not isinstance(v, (int, float)) or not 1 <= v <= 20:
                    raise Fail(f"{label} must be between 1 and 20 squares.")
                doc[key] = int(v)
        removed = 0
        if "cols" in d or "rows" in d:
            cols, rows = d.get("cols", doc["cols"]), d.get("rows", doc["rows"])
            if side(cols, 0) == 0 or side(rows, 0) == 0:
                raise Fail(f"The map can be 1 to {MAX_SIDE} squares on each side.")
            removed = resize(doc, cols, rows)
        ensure_fog(doc)
        save(doc)
    return jsonify(vision=doc["vision"], hidden=doc["hidden"], cols=doc["cols"], rows=doc["rows"], removed=removed,
                   night=doc["night"], night_sight=doc["night_sight"], dark_range=doc["dark_range"])


def resize(doc, cols, rows):
    """Give the board a new size. Tokens are pulled inside it; walls, doors and windows that reach outside are dropped
    (their number is returned); what was explored stays where it was."""
    old = dims(doc)
    if (cols, rows) == old:
        return 0
    doc["cols"], doc["rows"] = cols, rows
    for t in doc["tokens"]:
        t["x"], t["y"] = min(float(cols), t["x"]), min(float(rows), t["y"])
    removed = 0
    for key in SEGS.values():
        keep = [o for o in doc[key] if max(o["x1"], o["x2"]) <= cols and max(o["y1"], o["y2"]) <= rows]
        removed += len(doc[key]) - len(keep)
        doc[key] = keep
    doc["lights"] = [l for l in doc["lights"] if l["x"] <= cols and l["y"] <= rows]
    for a in doc["areas"]:
        a["cells"] = [c for c in a["cells"] if int(c.split(",")[0]) < cols and int(c.split(",")[1]) < rows]
    doc["areas"] = [a for a in doc["areas"] if a["cells"]]
    before = _decode(doc["explored"], (old[0] * PPC, old[1] * PPC))
    if before is not None:
        after = Image.new("L", (cols * PPC, rows * PPC), 0)
        after.paste(before, (0, 0))
        doc["explored"] = _encode(after)
    else:
        doc["explored"] = ""
    _fog["sig"], _fog["explored"], _fog["key"] = None, None, None
    return removed


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
        ok = isinstance(d, dict) and isinstance(d.get("doc"), dict) and isinstance(d.get("id"), str) \
            and isinstance(d.get("name"), str) and isinstance(d.get("saved"), (int, float))
        return d if ok else None
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
                            "walls": len(doc.get("walls", [])), "doors": len(doc.get("doors", [])),
                            "windows": len(doc.get("windows", []))})
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
        body = {k: doc[k] for k in ("tokens", "walls", "doors", "windows", "lights", "areas", "vision", "night", "night_sight", "dark_range", "explored", "cols", "rows")}
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
        for key in ("tokens", "walls", "doors", "windows", "lights", "areas"):
            doc[key] = src.get(key) if isinstance(src.get(key), list) else []
        for key in ("night", "night_sight", "dark_range"):
            doc[key] = src.get(key)                  # load() puts a default in when a save from before had none
        doc["cols"], doc["rows"] = src.get("cols", None), src.get("rows", None)
        if doc["cols"] is None:
            del doc["cols"], doc["rows"]            # a save from before the board could be resized
        migrate(doc)
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
