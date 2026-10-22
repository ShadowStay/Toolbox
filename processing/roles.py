"""Who is at the table: a player or the dungeon master. The Tabletop page asks when it opens (shared/role.js) and the
answer is kept in a signed cookie (30 days), so the server can enforce it: players never get the enemy list, enemy
sheets, enemy HP, walls they have not seen, and so on.

The dungeon master needs a password:
  * The first person to choose "Dungeon master" picks it (at least 4 characters). Only a scrypt hash is stored, in
    data/dm_password.hash (git-ignored).
  * Or set the environment variable DM_PASSWORD, which wins over the stored one and cannot be changed from the page.
  * The dungeon master can change the stored password later (POST /api/role/password). The signed cookie includes a
    fingerprint of the password, so changing it signs every other browser out of the dungeon master role.

  GET  /api/role           -> {role: "player" | "dm" | null, dm_protected, dm_source: "file" | "env" | null}
  POST /api/role           {role, pin?, create?} -> {role}   sets the cookie; create: true picks the first password
  POST /api/role/password  {current, new} -> {role}          DM: change the stored password
Other modules call need_dm() to refuse players and current_role() to tailor an answer.
"""
import hashlib
import hmac
import os
import threading
import time

from flask import abort, jsonify, request
from itsdangerous import BadSignature, URLSafeTimedSerializer
from werkzeug.security import check_password_hash, generate_password_hash

from auth import DATA, _secret
from .core import Fail, bp

COOKIE = "spells_role"
MAX_AGE = 30 * 24 * 3600
HASH_FILE = DATA / "dm_password.hash"
MIN_PW, MAX_PW = 4, 200
_lock = threading.Lock()


def _serializer():
    return URLSafeTimedSerializer(_secret(), salt="spells-role")


def _env_pin():
    return os.environ.get("DM_PASSWORD", "")


def _file_hash():
    try:
        return HASH_FILE.read_text().strip() or None
    except OSError:
        return None


def dm_source():
    """Where the dungeon master password comes from: "env", "file", or None when nobody has chosen one yet."""
    return "env" if _env_pin() else ("file" if _file_hash() else None)


def _fingerprint():
    src = dm_source()
    secret = _env_pin() if src == "env" else (_file_hash() or "") if src == "file" else ""
    return hashlib.sha256(("dm|" + secret).encode()).hexdigest()[:16]


def _check(pin):
    if not isinstance(pin, str) or not pin or len(pin) > MAX_PW:
        return False
    src = dm_source()
    if src == "env":
        return hmac.compare_digest(pin.encode(), _env_pin().encode())
    if src == "file":
        return check_password_hash(_file_hash(), pin)
    return False


def _valid_new(pw):
    if not isinstance(pw, str) or len(pw) < MIN_PW:
        raise Fail(f"The password needs at least {MIN_PW} characters.")
    if len(pw) > MAX_PW:
        raise Fail("That password is too long.")
    return pw


def _store(pw):
    DATA.mkdir(exist_ok=True)
    tmp = HASH_FILE.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(generate_password_hash(pw))
    os.replace(tmp, HASH_FILE)


def current_role():
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    try:
        value = _serializer().loads(token, max_age=MAX_AGE)
    except BadSignature:
        return None
    if value == "player":
        return "player"
    if isinstance(value, str) and dm_source() and hmac.compare_digest(value.encode(), ("dm|" + _fingerprint()).encode()):
        return "dm"
    return None


def need_dm():
    if current_role() != "dm":
        abort(403, "Only the dungeon master can do that.")


def _answer(role):
    resp = jsonify(role=role)
    value = "player" if role == "player" else "dm|" + _fingerprint()
    resp.set_cookie(COOKIE, _serializer().dumps(value), max_age=MAX_AGE, httponly=True, samesite="Lax", secure=request.is_secure)
    return resp


@bp.get("/role")
def role_get():
    return jsonify(role=current_role(), dm_protected=dm_source() is not None, dm_source=dm_source())


@bp.post("/role")
def role_set():
    d = request.get_json(silent=True) or {}
    role = d.get("role")
    if role not in ("player", "dm"):
        raise Fail("Choose player or dungeon master.")
    if role == "dm" and current_role() != "dm":                    # already the DM: no need to type it again
        pin = d.get("pin")
        with _lock:
            if dm_source() is None:
                if d.get("create") is not True:
                    raise Fail("No dungeon master password has been chosen yet.")
                _store(_valid_new(pin))
            elif not _check(pin):
                time.sleep(1)                                      # slows down guessing
                raise Fail("That is not the dungeon master password.")
    return _answer(role)


@bp.post("/role/password")
def role_password():
    need_dm()
    if dm_source() == "env":
        raise Fail("The password is set by the DM_PASSWORD environment variable. Change it there.")
    d = request.get_json(silent=True) or {}
    new = _valid_new(d.get("new"))
    with _lock:
        if not _check(d.get("current")):
            time.sleep(1)
            raise Fail("The current password is not right.")
        _store(new)
    return _answer("dm")                                          # a fresh cookie for this browser; the others are signed out
