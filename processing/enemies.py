"""Enemy storage for the Dungeon Master HQ tab of pages/tabletop.* (the Dungeon Master HQ part of pages/tabletop.js). Same idea as characters.py: one JSON file per enemy in the campaign's enemies folder,
a flat {field: text} sheet, so the page can add fields without changing this file. Enemies use the same HP keys as
characters ("hp.curep" / "hp.maxep"), which is what lets the map draw both the same way.
  GET  /api/enemies              -> {enemies: [{id, name, updated}]}
  POST /api/enemies              {data} -> {id}            create
  GET  /api/enemies/<id>         -> {id, updated, data}
  POST /api/enemies/<id>         {data} -> {updated}       save
  POST /api/enemies/<id>/delete  -> 204
  GET  /api/enemies/<id>/portrait   the portrait image (used by the map)
Enemies belong to the current campaign (data/campaigns/<id>/enemies/, see campaigns.py).
Only the dungeon master can reach these routes (roles.py); players get a 403."""
import json
import os
import threading
import time
import uuid

from flask import jsonify, request

from . import campaigns
from .characters import ID, clean, portrait_response
from .core import Fail, bp
from .roles import need_dm

_lock = threading.Lock()


def directory():
    return campaigns.folder("enemies")


def path_of(eid):
    if not ID.match(eid):
        raise Fail("That enemy does not exist.")
    return directory() / f"{eid}.json"


def write(eid, data):
    directory().mkdir(parents=True, exist_ok=True)
    doc = {"id": eid, "updated": int(time.time()), "data": clean(data)}
    target = path_of(eid)
    tmp = target.with_suffix(".tmp")
    with _lock:
        tmp.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, target)
    return doc


def read(eid):
    try:
        return json.loads(path_of(eid).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise Fail("That enemy does not exist.")


@bp.get("/enemies")
def enemies_list():
    need_dm()
    out = []
    folder = directory()
    if folder.is_dir():
        for p in folder.glob("*.json"):
            try:
                d = json.loads(p.read_text(encoding="utf-8"))
                out.append({"id": d["id"], "name": d["data"].get("name") or "Unnamed", "updated": d["updated"]})
            except (OSError, ValueError, KeyError):
                continue
    out.sort(key=lambda c: c["name"].casefold())
    return jsonify(enemies=out)


@bp.post("/enemies")
def enemies_create():
    need_dm()
    d = request.get_json(silent=True) or {}
    eid = uuid.uuid4().hex
    write(eid, d.get("data") or {})
    return jsonify(id=eid)


@bp.get("/enemies/<eid>")
def enemies_get(eid):
    need_dm()
    return jsonify(read(eid))


@bp.post("/enemies/<eid>")
def enemies_save(eid):
    need_dm()
    read(eid)                                   # must exist
    d = request.get_json(silent=True) or {}
    return jsonify(updated=write(eid, d.get("data"))["updated"])


@bp.post("/enemies/<eid>/delete")
def enemies_delete(eid):
    need_dm()
    path_of(eid).unlink(missing_ok=True)
    return "", 204


@bp.get("/enemies/<eid>/portrait")
def enemies_portrait(eid):
    need_dm()
    return portrait_response(read(eid))
