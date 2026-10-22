"""Campaigns for the Tabletop and Dungeon Master HQ pages. Everything that belongs to one game (its characters, its
enemies, the map and the saved maps) lives in its own folder, so several campaigns can run side by side:

  data/campaigns/<id>/campaign.json   {id, name, created}
  data/campaigns/<id>/characters/     one JSON file per character   (characters.py)
  data/campaigns/<id>/enemies/        one JSON file per enemy       (enemies.py)
  data/campaigns/<id>/map.json        the shared map               (battlemap.py)
  data/campaigns/<id>/map_saves/      saved maps                   (battlemap.py)

Everybody picks the campaign they are playing right now; the choice is kept in the cookie spells_campaign (a year), so
the next visit opens the same one, and it can be changed at any time (shared/role.js shows the picker). Every other
module asks folder() for its place on disk, which follows that cookie. A cookie that names a campaign that does not
exist (any more) falls back to the first campaign.

The first time this runs, an older install's data/characters, data/enemies, data/map.json and data/map_saves are moved
into a campaign called "Main campaign", so nothing is lost.

  GET  /api/campaigns             -> {campaigns: [{id, name}], current}
  POST /api/campaign              {id} -> {id, name}   choose the campaign you are playing (sets the cookie)
  POST /api/campaigns             {name} -> {id, name}      DM: create
  POST /api/campaigns/<id>/rename {name}                    DM
  POST /api/campaigns/<id>/delete                           DM: removes its characters, enemies and maps for good
"""
import json
import os
import re
import shutil
import threading
import time
import uuid

from flask import jsonify, request

from auth import DATA
from .core import Fail, bp
from .roles import need_dm

ROOT = DATA / "campaigns"
COOKIE = "spells_campaign"
YEAR = 365 * 24 * 3600
ID = re.compile(r"^[a-z0-9]{1,32}$")
FIRST = "main"                                              # id of the campaign that older data is moved into
LEGACY = ("characters", "enemies", "map.json", "map_saves")
MAX_CAMPAIGNS = 50
_lock = threading.RLock()


def meta_file(cid):
    return ROOT / cid / "campaign.json"


def read_meta(cid):
    try:
        d = json.loads(meta_file(cid).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return d if isinstance(d, dict) and isinstance(d.get("name"), str) else None


def write_meta(cid, name, created=None):
    tmp = meta_file(cid).with_suffix(".tmp")
    tmp.write_text(json.dumps({"id": cid, "name": name, "created": created or int(time.time())}, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, meta_file(cid))


def clean_name(value):
    name = re.sub(r"[\x00-\x1f\x7f]", "", str(value or "")).strip()[:60]
    if not name:
        raise Fail("Give the campaign a name.")
    return name


def ensure():
    """Make sure at least one campaign exists; the first time, move an older install's data into it."""
    with _lock:
        if ROOT.is_dir() and any(read_meta(p.name) for p in ROOT.iterdir() if p.is_dir() and ID.match(p.name)):
            return
        DATA.mkdir(exist_ok=True)
        folder = ROOT / FIRST
        folder.mkdir(parents=True, exist_ok=True)
        for name in LEGACY:
            src = DATA / name
            if src.exists() and not (folder / name).exists():
                shutil.move(str(src), str(folder / name))
        write_meta(FIRST, "Main campaign")


def all_campaigns():
    ensure()
    out = []
    for p in ROOT.iterdir():
        meta = read_meta(p.name) if p.is_dir() and ID.match(p.name) else None
        if meta:
            out.append({"id": p.name, "name": meta["name"], "created": meta.get("created", 0)})
    out.sort(key=lambda c: (c["created"], c["name"].casefold()))
    return out


def current_id():
    """The campaign this request is about: the one in the cookie, or the first campaign."""
    cid = request.cookies.get(COOKIE, "")
    if ID.match(cid) and meta_file(cid).is_file():
        return cid
    return all_campaigns()[0]["id"]


def folder(sub=None):
    """Where the current campaign keeps its files (a sub-folder or file name inside it)."""
    base = ROOT / current_id()
    return base / sub if sub else base


def exists(cid):
    return isinstance(cid, str) and bool(ID.match(cid)) and meta_file(cid).is_file()


@bp.get("/campaigns")
def campaigns_list():
    items = all_campaigns()
    return jsonify(campaigns=[{"id": c["id"], "name": c["name"]} for c in items], current=current_id())


@bp.post("/campaign")
def campaign_select():
    cid = (request.get_json(silent=True) or {}).get("id")
    if not exists(cid):
        raise Fail("That campaign does not exist.")
    resp = jsonify(id=cid, name=read_meta(cid)["name"])
    resp.set_cookie(COOKIE, cid, max_age=YEAR, samesite="Lax", secure=request.is_secure)
    return resp


@bp.post("/campaigns")
def campaign_create():
    need_dm()
    name = clean_name((request.get_json(silent=True) or {}).get("name"))
    with _lock:
        items = all_campaigns()
        if len(items) >= MAX_CAMPAIGNS:
            raise Fail("There are too many campaigns. Delete one first.")
        if any(c["name"].casefold() == name.casefold() for c in items):
            raise Fail("A campaign with that name already exists.")
        cid = uuid.uuid4().hex[:12]
        (ROOT / cid).mkdir(parents=True)
        write_meta(cid, name)
    return jsonify(id=cid, name=name)


@bp.post("/campaigns/<cid>/rename")
def campaign_rename(cid):
    need_dm()
    name = clean_name((request.get_json(silent=True) or {}).get("name"))
    with _lock:
        if not exists(cid):
            raise Fail("That campaign does not exist.")
        if any(c["name"].casefold() == name.casefold() and c["id"] != cid for c in all_campaigns()):
            raise Fail("A campaign with that name already exists.")
        write_meta(cid, name, read_meta(cid).get("created"))
    return jsonify(id=cid, name=name)


@bp.post("/campaigns/<cid>/delete")
def campaign_delete(cid):
    need_dm()
    with _lock:
        if not exists(cid):
            raise Fail("That campaign does not exist.")
        if len(all_campaigns()) <= 1:
            raise Fail("This is the only campaign. Create another one before deleting it.")
        shutil.rmtree(ROOT / cid, ignore_errors=True)
    return jsonify(ok=True)
