"""Who is at the table: a player or the dungeon master. The Tabletop page asks when it opens (shared/role.js) and the
answer is kept in a signed cookie, so the server can enforce it: players never get the enemy list, enemy sheets,
walls they have not seen, and so on. Anyone can say they are the dungeon master unless a password is set: start the
server with the environment variable DM_PASSWORD and choosing "Dungeon master" asks for it.

  GET  /api/role            -> {role: "player" | "dm" | null, dm_protected}
  POST /api/role            {role, pin?} -> {role}      sets the cookie (a browser-session cookie: it ends with the browser)
Other modules call need_dm() to refuse players and current_role() to tailor an answer."""
import hmac
import os
import time

from flask import abort, jsonify, request
from itsdangerous import BadSignature, URLSafeTimedSerializer

from auth import _secret
from .core import Fail, bp

COOKIE = "spells_role"
MAX_AGE = 30 * 24 * 3600


def _serializer():
    return URLSafeTimedSerializer(_secret(), salt="spells-role")


def current_role():
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    try:
        role = _serializer().loads(token, max_age=MAX_AGE)
    except BadSignature:
        return None
    return role if role in ("player", "dm") else None


def need_dm():
    if current_role() != "dm":
        abort(403, "Only the dungeon master can do that.")


def dm_pin():
    return os.environ.get("DM_PASSWORD", "")


@bp.get("/role")
def role_get():
    return jsonify(role=current_role(), dm_protected=bool(dm_pin()))


@bp.post("/role")
def role_set():
    d = request.get_json(silent=True) or {}
    role = d.get("role")
    if role not in ("player", "dm"):
        raise Fail("Choose player or dungeon master.")
    if role == "dm" and dm_pin() and current_role() != "dm":        # already the DM: no need to type it again
        pin = d.get("pin")
        if not isinstance(pin, str) or not hmac.compare_digest(pin.encode(), dm_pin().encode()):
            time.sleep(1)                                           # slows down guessing
            raise Fail("That is not the dungeon master password.")
    resp = jsonify(role=role)
    resp.set_cookie(COOKIE, _serializer().dumps(role), httponly=True, samesite="Lax", secure=request.is_secure)
    return resp
