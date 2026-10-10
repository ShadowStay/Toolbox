"""Shared drawing board for pages/live.html. It rides on the room in chat.py: the people who are online there are the
people who can draw, and board events travel down the same event stream.

The board is a list of objects in drawing order (a Python dict keeps that order):
  stroke  {id, kind, color, size, points: [[x, y], ...], dx, dy}      dx/dy = how far the stroke was moved
  image   {id, kind, src, cx, cy, w, h, rot}                           src = /api/board/image/<id>

Changes are small operations that every browser applies in the order the server numbers them:
  {t: "add", objs: [...]}   {t: "del", ids: [...]}   {t: "set", items: [{id, patch}]}   {t: "batch", ops: [...]}
A batch is all-or-nothing. Undo and redo are done by the browser sending the opposite operation, so each person
undoes their own actions and never somebody else's.

  GET  /api/board/state          {seq, objs}  the whole board (a browser loads it on joining or after an error)
  POST /api/board/op             {from, op}   change the board; answered to everyone as event "bop" {seq, from, op}
  POST /api/board/live           {from, kind, ...}  throwaway updates that are not stored: cursor, stroke being
                                 drawn, object being dragged. Sent to everyone else as event "blive"
  POST /api/board/image?from=    raw PNG body -> {src}   used when a drawing is turned into an image
  GET  /api/board/image/<id>     the PNG

State lives in memory, like the chat: it is kept while the server runs and starts empty after a restart.
Run a single process (threads are fine)."""
import re
import threading
import time
import uuid

from flask import Blueprint, Response, abort, jsonify, request
from werkzeug.exceptions import HTTPException

from chat import LOCK as ROOM_LOCK, USERS, deliver

bp = Blueprint("board", __name__, url_prefix="/api/board")

MAX_OBJECTS, MAX_POINTS = 5000, 20000
MAX_IMAGE, IMAGE_CAP, IMAGE_GRACE = 8 * 1024 * 1024, 256 * 1024 * 1024, 600   # bytes, bytes, seconds
MAX_BODY = 16 * 1024 * 1024
PNG = b"\x89PNG\r\n\x1a\n"
ID = re.compile(r"^[A-Za-z0-9_-]{4,40}$")
COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
SRC = re.compile(r"^/api/board/image/([0-9a-f]{32})$")
FIELDS = {"stroke": ("dx", "dy"), "image": ("cx", "cy", "w", "h", "rot")}
ALL_FIELDS = {f for fields in FIELDS.values() for f in fields}
LIMITS = {"w": (1, 20000), "h": (1, 20000), "rot": (-1000, 1000)}

_lock = threading.Lock()
OBJECTS = {}                    # id -> object, in drawing order
IMAGES = {}                     # id -> {"data": png bytes, "ts": upload time}
STATE = {"seq": 0}


class Fail(Exception):
    """An error whose message is meant for the person using the page."""


@bp.errorhandler(Fail)
def _fail(e):
    return jsonify(error=str(e)), 400


@bp.errorhandler(HTTPException)
def _http(e):
    return jsonify(error=e.description), e.code


@bp.errorhandler(Exception)
def _boom(e):
    return jsonify(error=f"The server could not do that: {e}"), 500


# ---------- checking what browsers send ----------
def num(v, lo=-100000, hi=100000):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not lo <= v <= hi:
        raise Fail("The drawing data was not valid.")
    return round(float(v), 2)


def patch_of(patch, allowed):
    if not isinstance(patch, dict):
        raise Fail("The drawing data was not valid.")
    out = {k: num(patch[k], *LIMITS.get(k, (-100000, 100000))) for k in allowed if k in patch}
    if not out:
        raise Fail("The drawing data was not valid.")
    return out


def clean_obj(o):
    if not isinstance(o, dict):
        raise Fail("The drawing data was not valid.")
    oid, kind = o.get("id"), o.get("kind")
    if not (isinstance(oid, str) and ID.match(oid)):
        raise Fail("The drawing data was not valid.")
    if kind == "stroke":
        pts, color = o.get("points"), o.get("color")
        if not isinstance(pts, list) or not 1 <= len(pts) <= MAX_POINTS or not (isinstance(color, str) and COLOR.match(color)):
            raise Fail("The drawing data was not valid.")
        points = []
        for p in pts:
            if not isinstance(p, (list, tuple)) or len(p) != 2:
                raise Fail("The drawing data was not valid.")
            points.append([num(p[0]), num(p[1])])
        return {"id": oid, "kind": "stroke", "color": color.lower(), "size": num(o.get("size"), 0.5, 200),
                "points": points, "dx": num(o.get("dx", 0)), "dy": num(o.get("dy", 0))}
    if kind == "image":
        src = o.get("src")
        m = SRC.match(src) if isinstance(src, str) else None
        if not m or m.group(1) not in IMAGES:
            raise Fail("That image is no longer on the server.")
        return {"id": oid, "kind": "image", "src": src, "cx": num(o.get("cx")), "cy": num(o.get("cy")),
                "w": num(o.get("w"), *LIMITS["w"]), "h": num(o.get("h"), *LIMITS["h"]), "rot": num(o.get("rot", 0), *LIMITS["rot"])}
    raise Fail("The drawing data was not valid.")


def listed(value, limit=MAX_OBJECTS):
    if not isinstance(value, list) or not 1 <= len(value) <= limit:
        raise Fail("The drawing data was not valid.")
    return value


def apply(op, nested=False):
    """Apply one operation to OBJECTS and return the cleaned version that is sent to everybody."""
    if not isinstance(op, dict):
        raise Fail("The drawing data was not valid.")
    t = op.get("t")
    if t == "add":
        clean = [clean_obj(o) for o in listed(op.get("objs"))]
        fresh = len({o["id"] for o in clean if o["id"] not in OBJECTS})
        if len(OBJECTS) + fresh > MAX_OBJECTS:
            raise Fail("The board is full. Delete something first.")
        for o in clean:
            OBJECTS[o["id"]] = o                # an id that exists is replaced and keeps its place
        return {"t": "add", "objs": clean}
    if t == "del":
        ids = listed(op.get("ids"))
        if not all(isinstance(i, str) for i in ids):
            raise Fail("The drawing data was not valid.")
        for i in ids:
            OBJECTS.pop(i, None)                # already gone is fine: someone else may have deleted it
        return {"t": "del", "ids": ids}
    if t == "set":
        out = []
        for it in listed(op.get("items")):
            if not isinstance(it, dict):
                raise Fail("The drawing data was not valid.")
            oid = it.get("id")
            obj = OBJECTS.get(oid) if isinstance(oid, str) else None
            if obj:                             # a deleted object is skipped
                patch = patch_of(it.get("patch"), FIELDS[obj["kind"]])
                OBJECTS[oid] = {**obj, **patch}
                out.append({"id": oid, "patch": patch})
        return {"t": "set", "items": out}
    if t == "batch" and not nested:
        return {"t": "batch", "ops": [apply(o, True) for o in listed(op.get("ops"), 10)]}
    raise Fail("The drawing data was not valid.")


def read():
    if (request.content_length or 0) > MAX_BODY:
        raise Fail("That change is too large.")
    d = request.get_json(silent=True)
    return d if isinstance(d, dict) else {}


def who(uid):
    with ROOM_LOCK:
        known = isinstance(uid, str) and uid in USERS
    if not known:
        abort(404, "You are not connected to the room. Reconnecting…")
    return uid


# ---------- the board ----------
@bp.get("/state")
def state():
    with _lock:
        return jsonify(seq=STATE["seq"], objs=list(OBJECTS.values()))


@bp.post("/op")
def op():
    d = read()
    uid = who(d.get("from"))
    with _lock:
        backup = dict(OBJECTS)                  # objects are never edited in place, so a shallow copy is enough
        try:
            clean = apply(d.get("op"))
        except Exception:
            OBJECTS.clear()
            OBJECTS.update(backup)              # a batch is all-or-nothing
            raise
        STATE["seq"] += 1
        seq = STATE["seq"]
        deliver("bop", {"seq": seq, "from": uid, "op": clean})   # inside the lock, so everyone gets them in order
    return jsonify(seq=seq)


@bp.post("/live")
def live():
    d = read()
    uid = who(d.get("from"))
    kind = d.get("kind")
    if kind == "cursor":
        msg = {"kind": "cursor"}                # no x means the pointer left the board
        if d.get("x") is not None:
            msg["x"], msg["y"] = num(d.get("x")), num(d.get("y"))
    elif kind == "stroke":
        pts, sid, color = d.get("pts"), d.get("id"), d.get("color")
        if not (isinstance(pts, list) and len(pts) <= 400 and isinstance(sid, str) and ID.match(sid)
                and isinstance(color, str) and COLOR.match(color)):
            raise Fail("The drawing data was not valid.")
        msg = {"kind": "stroke", "id": sid, "color": color.lower(), "size": num(d.get("size"), 0.5, 200),
               "pts": [[num(p[0]), num(p[1])] for p in pts if isinstance(p, list) and len(p) == 2]}
    elif kind == "set":
        items = []
        for it in listed(d.get("items"), 500):
            if not (isinstance(it, dict) and isinstance(it.get("id"), str)):
                raise Fail("The drawing data was not valid.")
            items.append({"id": it["id"], "patch": patch_of(it.get("patch"), ALL_FIELDS)})
        msg = {"kind": "set", "items": items}
    else:
        raise Fail("The drawing data was not valid.")
    msg["from"] = uid
    deliver("blive", msg, exclude=uid)
    return "", 204


# ---------- images made from drawings ----------
def _collect():
    """Called with _lock held: drop old images that no object uses once the store is over its cap."""
    total = sum(len(i["data"]) for i in IMAGES.values())
    if total <= IMAGE_CAP:
        return True
    used = {m.group(1) for o in OBJECTS.values() if o["kind"] == "image" and (m := SRC.match(o["src"]))}
    for iid, img in sorted(IMAGES.items(), key=lambda kv: kv[1]["ts"]):
        if total <= IMAGE_CAP:
            break
        if iid not in used and img["ts"] < time.time() - IMAGE_GRACE:
            total -= len(img["data"])
            del IMAGES[iid]
    return total <= IMAGE_CAP


@bp.post("/image")
def image_upload():
    who(request.args.get("from"))
    if request.content_length is None or request.content_length > MAX_IMAGE:
        raise Fail("That image is too large (8 MB at most).")
    data = request.get_data()
    if not data.startswith(PNG):
        raise Fail("Only PNG images are accepted here.")
    iid = uuid.uuid4().hex
    with _lock:
        IMAGES[iid] = {"data": data, "ts": time.time()}
        if not _collect():
            del IMAGES[iid]
            raise Fail("The board's image storage is full. Delete some images and try again in a few minutes.")
    return jsonify(src=f"/api/board/image/{iid}")


@bp.get("/image/<iid>")
def image_get(iid):
    if not re.fullmatch(r"[0-9a-f]{32}", iid):
        abort(404)
    with _lock:
        img = IMAGES.get(iid)
    if not img:
        abort(404, "That image is no longer on the server.")
    return Response(img["data"], mimetype="image/png",
                    headers={"Cache-Control": "private, max-age=86400, immutable", "X-Content-Type-Options": "nosniff"})
