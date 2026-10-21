"""Character storage for pages/tabletop.*. One JSON file per character in data/characters/ (data/ is git-ignored).
  GET  /api/characters              -> {characters: [{id, name, updated}]}
  POST /api/characters              {data} -> {id}            create
  GET  /api/characters/<id>         -> {id, updated, data}
  POST /api/characters/<id>         {data} -> {updated}       save
  POST /api/characters/<id>/delete  -> 204
  GET  /api/characters/<id>/portrait -> the portrait image (used by the map)
  GET  /api/classes                 -> {classes: [...]}  from rules/classes.json
  GET  /api/races                   -> {races: [...]}    from rules/races.json
  GET  /api/weapons                 -> {category: [weapon, ...]}  from rules/weapons.json
A sheet is a flat {field: text} map, so the page can add fields without changing this file.
The password gate in auth.py already covers /api/, so only signed-in people can reach these routes."""
import base64
import json
import os
import re
import threading
import time
import uuid

from flask import Response, abort, jsonify, request

from auth import BASE, DATA
from .core import Fail, bp

DIR = DATA / "characters"
ID = re.compile(r"^[0-9a-f]{32}$")
MAX_KEYS, MAX_VALUE, MAX_PORTRAIT = 1500, 20_000, 700_000
_lock = threading.Lock()


def path_of(cid):
    if not ID.match(cid):
        raise Fail("That character does not exist.")
    return DIR / f"{cid}.json"


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


def write(cid, data):
    DIR.mkdir(parents=True, exist_ok=True)
    doc = {"id": cid, "updated": int(time.time()), "data": clean(data)}
    target = path_of(cid)
    tmp = target.with_suffix(".tmp")
    with _lock:
        tmp.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, target)
    return doc


def read(cid):
    try:
        return json.loads(path_of(cid).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise Fail("That character does not exist.")


@bp.get("/characters")
def characters_list():
    out = []
    if DIR.is_dir():
        for p in DIR.glob("*.json"):
            try:
                d = json.loads(p.read_text(encoding="utf-8"))
                out.append({"id": d["id"], "name": d["data"].get("name") or "Unnamed", "updated": d["updated"]})
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
    return jsonify(read(cid))


@bp.post("/characters/<cid>")
def characters_save(cid):
    read(cid)                                   # must exist
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
    path_of(cid).unlink(missing_ok=True)
    return "", 204


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
