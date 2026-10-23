"""Password gate. Without a valid session cookie every request is answered with the login page (or a 401 for
/api/), except POST /login and the public home page with its assets (PUBLIC_PATHS). Only a scrypt hash of the password is stored (data/password.hash); set it with set_password.py."""
import functools
import hashlib
import hmac
import os
import threading
import time
from pathlib import Path

from flask import Response, jsonify, redirect, request
from itsdangerous import BadSignature, URLSafeTimedSerializer
from werkzeug.security import check_password_hash

BASE = Path(__file__).parent.resolve()
DATA = BASE / "data"
HASH_FILE = DATA / "password.hash"
KEY_FILE = DATA / "secret.key"
LOGIN_PAGE = BASE / "login.html"

COOKIE = "spell_session"
MAX_AGE = 30 * 24 * 3600          # stay logged in for 30 days
MAX_TRIES = 5                     # failures before a lockout starts
MAX_LOCK = 15 * 60

_fails = {}                       # ip -> [failure count, locked until (epoch seconds)]
_lock = threading.Lock()


@functools.lru_cache(maxsize=1)
def _secret() -> str:
    """The key that signs cookies. Written to a temp file and linked into place, so a second process starting at the same
    moment can never read a half-written key. Read once, then kept in memory."""
    DATA.mkdir(exist_ok=True)
    if not KEY_FILE.exists():
        tmp = KEY_FILE.with_name(f"secret.{os.getpid()}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(os.urandom(32).hex())
        try:
            os.link(tmp, KEY_FILE)                 # fails if another process got there first: then theirs is used
        except FileExistsError:
            pass
        finally:
            tmp.unlink(missing_ok=True)
    return KEY_FILE.read_text().strip()


def password_hash():
    try:
        return HASH_FILE.read_text().strip() or None
    except OSError:
        return None


def _fingerprint(h: str) -> str:
    return hashlib.sha256(h.encode()).hexdigest()[:32]


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(_secret(), salt="spells-session")


def is_authed() -> bool:
    h, token = password_hash(), request.cookies.get(COOKIE)
    if not h or not token:
        return False
    try:
        value = _serializer().loads(token, max_age=MAX_AGE)
    except BadSignature:
        return False
    return isinstance(value, str) and hmac.compare_digest(value, _fingerprint(h))


def login_page() -> Response:
    return Response(LOGIN_PAGE.read_text(encoding="utf-8"), status=401, mimetype="text/html",
                    headers={"Cache-Control": "no-store"})


def _wait_time(ip: str) -> int:
    with _lock:
        entry = _fails.get(ip)
        return max(0, int(entry[1] - time.time())) + 1 if entry and entry[1] > time.time() else 0


def _register_failure(ip: str) -> None:
    with _lock:
        if len(_fails) > 5000:
            _fails.clear()
        count = _fails.get(ip, [0, 0])[0] + 1
        lock = min(MAX_LOCK, 30 * 2 ** (count - MAX_TRIES)) if count >= MAX_TRIES else 0
        _fails[ip] = [count, time.time() + lock]


# Reachable without signing in, so search engines can read the home page. Everything else needs the password.
PUBLIC_PATHS = {"/", "/index.css", "/index.js", "/robots.txt", "/sitemap.xml"}
PUBLIC_PREFIXES = ("/shared/", "/images/")


def init_auth(app):
    @app.before_request
    def gate():
        path = request.path
        if request.method == "POST" and path == "/login":
            return None
        if is_authed():
            return redirect("/") if path == "/login" else None
        if request.method in ("GET", "HEAD") and (path in PUBLIC_PATHS or path.startswith(PUBLIC_PREFIXES)):
            return None
        if path.startswith("/api/"):
            return jsonify(error="Sign in required."), 401
        return login_page()

    @app.post("/login")
    def login():
        h = password_hash()
        if not h:
            return jsonify(error="No password has been set yet. Run: python set_password.py"), 503
        ip = request.remote_addr or "?"
        wait = _wait_time(ip)
        if wait:
            return jsonify(error=f"Too many attempts. Try again in {wait} seconds.", wait=wait), 429, {"Retry-After": str(wait)}
        pw = (request.get_json(silent=True) or {}).get("password")
        if not isinstance(pw, str) or len(pw) > 1024 or not check_password_hash(h, pw):
            _register_failure(ip)
            return jsonify(error="The runes reject that word."), 401
        with _lock:
            _fails.pop(ip, None)
        resp = Response(status=204)
        resp.set_cookie(COOKIE, _serializer().dumps(_fingerprint(h)), max_age=MAX_AGE,
                        httponly=True, samesite="Lax", secure=request.is_secure)
        return resp

    @app.post("/logout")
    def logout():
        resp = Response(status=204)
        resp.delete_cookie(COOKIE)
        return resp
