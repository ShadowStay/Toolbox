"""Character storage for pages/tabletop.*. One JSON file per character in the current campaign
(data/campaigns/<id>/characters/, see campaigns.py; data/ is git-ignored).
  GET  /api/characters              -> {characters: [{id, name, updated, locked, open}]}
  POST /api/characters              {data} -> {id}            create
  GET  /api/characters/<id>         -> {id, updated, data, locked}
  POST /api/characters/<id>         {data} -> {updated}       save
  POST /api/characters/<id>/delete  -> 204
  GET  /api/characters/<id>/portrait -> the portrait image (used by the map)
  GET  /api/classes                 -> {classes: [...]}  from rules/classes.json
  GET  /api/races                   -> {races: [...]}    from rules/races.json
  GET  /api/weapons                 -> {category: [weapon, ...]}  from rules/weapons.json
A sheet is a flat {field: text} map, so the page can add fields without changing this file.
The password gate in auth.py already covers /api/, so only signed-in people can reach these routes.

Locking: a player can protect a character with a password (stored as a scrypt hash next to the sheet, never sent to a
browser). A locked sheet cannot be read, saved, deleted or have its HP changed from the map until the password was
entered in this browser (POST .../unlock; remembered in the signed cookie spells_unlocked). The dungeon master can open
every sheet. A locked character still shows its name, portrait and HP on the map, like any other.
  POST /api/characters/<id>/unlock       {password}   open it in this browser
  POST /api/characters/<id>/relock                    close it again in this browser
  POST /api/characters/<id>/lock         {password}   set or change the password (needs the sheet to be open)
  POST /api/characters/<id>/lock/remove               take the password away (needs the sheet to be open)"""
import base64
import json
import os
import re
import threading
import time
import uuid

from flask import Response, abort, jsonify, request
from itsdangerous import BadSignature, URLSafeTimedSerializer
from werkzeug.security import check_password_hash, generate_password_hash

from auth import BASE, _secret
from . import campaigns
from .core import Fail, bp
from .roles import current_role

ID = re.compile(r"^[0-9a-f]{32}$")
MAX_KEYS, MAX_VALUE, MAX_PORTRAIT = 1500, 20_000, 700_000
MIN_PW, MAX_PW = 3, 200
UNLOCK_COOKIE, UNLOCK_AGE, MAX_UNLOCKED = "spells_unlocked", 30 * 24 * 3600, 60
_lock = threading.RLock()
_KEEP = object()


def directory():
    return campaigns.folder("characters")


def path_of(cid):
    if not ID.match(cid):
        raise Fail("That character does not exist.")
    return directory() / f"{cid}.json"


def clean(data):
    if not isinstance(data, dict) or len(data) > MAX_KEYS:
        raise Fail("That character sheet is not valid.")
    out = {}
    for k, v in data.items():
        if not isinstance(k, str) or len(k) > 60 or not isinstance(v, str):
            raise Fail("That character sheet is not valid.")
        if k == "portrait":
            if v and not (v.startswith("data:image/") and len(v) <= MAX_PORTRAIT):
                raise Fail("The portrait is not a valid or small enough image.")
        elif len(v) > MAX_VALUE:
            raise Fail(f"The field “{k}” is too long.")
        out[k] = v
    return out


def write(cid, data, lock=_KEEP):
    """Store a sheet. The password lock stays as it was unless lock= is given (a hash, or None to remove it)."""
    target = path_of(cid)
    target.parent.mkdir(parents=True, exist_ok=True)
    with _lock:
        if lock is _KEEP:
            try:
                lock = json.loads(target.read_text(encoding="utf-8")).get("lock")
            except (OSError, ValueError):
                lock = None
        doc = {"id": cid, "updated": int(time.time()), "data": clean(data)}
        if lock:
            doc["lock"] = lock
        tmp = target.with_suffix(".tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, target)
    return doc


def read(cid):
    try:
        return json.loads(path_of(cid).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise Fail("That character does not exist.")


# ---------- locks ----------
def _serializer():
    return URLSafeTimedSerializer(_secret(), salt="spells-unlocked")


def unlocked_ids():
    """The locked characters whose password this browser has entered."""
    token = request.cookies.get(UNLOCK_COOKIE)
    if not token:
        return []
    try:
        ids = _serializer().loads(token, max_age=UNLOCK_AGE)
    except BadSignature:
        return []
    return [i for i in ids if isinstance(i, str)] if isinstance(ids, list) else []


def has_access(doc):
    return not doc.get("lock") or current_role() == "dm" or doc.get("id") in unlocked_ids()


def need_access(doc):
    if not has_access(doc):
        abort(403, "That character is locked. Enter its password first.")


def _remember(resp, ids):
    resp.set_cookie(UNLOCK_COOKIE, _serializer().dumps(ids[-MAX_UNLOCKED:]), max_age=UNLOCK_AGE, httponly=True,
                    samesite="Lax", secure=request.is_secure)
    return resp


def _password():
    pw = (request.get_json(silent=True) or {}).get("password")
    return pw if isinstance(pw, str) else ""


def public(doc):
    """A sheet as a browser may see it: the data, never the password hash."""
    return {"id": doc["id"], "updated": doc["updated"], "data": doc["data"], "locked": bool(doc.get("lock"))}


# ---------- routes ----------
@bp.get("/characters")
def characters_list():
    out, mine = [], unlocked_ids()
    dm = current_role() == "dm"
    folder = directory()
    if folder.is_dir():
        for p in folder.glob("*.json"):
            try:
                d = json.loads(p.read_text(encoding="utf-8"))
                locked = bool(d.get("lock"))
                out.append({"id": d["id"], "name": d["data"].get("name") or "Unnamed", "updated": d["updated"],
                            "locked": locked, "open": not locked or dm or d["id"] in mine})
            except (OSError, ValueError, KeyError):
                continue
    out.sort(key=lambda c: c["name"].casefold())
    return jsonify(characters=out)


@bp.post("/characters")
def characters_create():
    d = request.get_json(silent=True) or {}
    cid = uuid.uuid4().hex
    write(cid, d.get("data") or {})
    return jsonify(id=cid)


@bp.get("/characters/<cid>")
def characters_get(cid):
    doc = read(cid)
    need_access(doc)
    return jsonify(public(doc))


@bp.post("/characters/<cid>")
def characters_save(cid):
    need_access(read(cid))                      # must exist, and be open to this browser
    d = request.get_json(silent=True) or {}
    return jsonify(updated=write(cid, d.get("data"))["updated"])


PORTRAIT = re.compile(r"^data:(image/(?:png|jpeg|webp|gif));base64,(.+)$", re.S)


def portrait_response(doc):
    """The portrait of a stored sheet as a real image. Only raster types are served (never SVG, which can carry scripts)."""
    m = PORTRAIT.match((doc.get("data") or {}).get("portrait", ""))
    if not m:
        abort(404, "No portrait.")
    try:
        raw = base64.b64decode(m.group(2), validate=True)
    except ValueError:
        abort(404, "No portrait.")
    return Response(raw, mimetype=m.group(1), headers={"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff"})


@bp.get("/characters/<cid>/portrait")
def characters_portrait(cid):
    return portrait_response(read(cid))


@bp.post("/characters/<cid>/delete")
def characters_delete(cid):
    if path_of(cid).exists():
        need_access(read(cid))
    path_of(cid).unlink(missing_ok=True)
    return "", 204


@bp.post("/characters/<cid>/unlock")
def characters_unlock(cid):
    doc = read(cid)
    pw = _password()
    if doc.get("lock") and not (pw and len(pw) <= MAX_PW and check_password_hash(doc["lock"], pw)):
        time.sleep(1)                           # slows down guessing
        raise Fail("That is not the password of this character.")
    ids = unlocked_ids()
    if cid not in ids:
        ids.append(cid)
    return _remember(jsonify(ok=True), ids)


@bp.post("/characters/<cid>/relock")
def characters_relock(cid):
    path_of(cid)                                # only checks that the id looks right
    return _remember(jsonify(ok=True), [i for i in unlocked_ids() if i != cid])


@bp.post("/characters/<cid>/lock")
def characters_lock(cid):
    doc = read(cid)
    need_access(doc)
    pw = _password()
    if len(pw) < MIN_PW:
        raise Fail(f"The password needs at least {MIN_PW} characters.")
    if len(pw) > MAX_PW:
        raise Fail("That password is too long.")
    write(cid, doc["data"], lock=generate_password_hash(pw))
    ids = unlocked_ids()
    if cid not in ids:
        ids.append(cid)                         # whoever sets the password stays inside
    return _remember(jsonify(ok=True), ids)


@bp.post("/characters/<cid>/lock/remove")
def characters_unlock_forever(cid):
    doc = read(cid)
    need_access(doc)
    write(cid, doc["data"], lock=None)
    return jsonify(ok=True)


# ---------- HP edited from the map ----------
HP_KEYS = {"hp": "hp.curep", "max": "hp.maxep", "fp": "hp.curfp", "fpmax": "hp.maxfp"}


def _num(v):
    return f"{v:.4f}".rstrip("0").rstrip(".")


def update_stats(cid, patch):
    """Change Ép / Fp values of a sheet ({hp, max, fp, fpmax}: number, or None to clear) without touching the rest of it."""
    with _lock:
        doc = read(cid)
        need_access(doc)
        data = dict(doc["data"])
        for key, value in patch.items():
            if value is None:
                data.pop(HP_KEYS[key], None)
            else:
                data[HP_KEYS[key]] = _num(value)
        write(cid, data)


def rules_file(name):
    try:
        return jsonify(json.loads((BASE / "rules" / name).read_text(encoding="utf-8")))
    except (OSError, ValueError):
        raise Fail(f"The rules file rules/{name} could not be read.")


@bp.get("/classes")
def classes():
    return rules_file("classes.json")


@bp.get("/races")
def races():
    return rules_file("races.json")


@bp.get("/weapons")
def weapons():
    return rules_file("weapons.json")
