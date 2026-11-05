"""The whole web app: page serving, home-page SEO and the password gate. The API lives in processing/.
Password gate: without a valid session cookie every request is answered with the login page (or a 401 for /api/), except
POST /login and the public home page with its assets (PUBLIC_PATHS). Only a scrypt hash of the password is stored
(data/password.hash); set it with set_password.py."""
import hashlib
import hmac
import os
import re
import threading
import time
from html import escape
from pathlib import Path

from flask import Flask, Response, abort, jsonify, redirect, request, send_from_directory
from itsdangerous import BadSignature, URLSafeTimedSerializer
from werkzeug.security import check_password_hash

import processing
from processing import BASE, HASH_FILE, _secret

PAGES_DIR = BASE / "pages"      # pages/index.*  = home page, pages/<category>/<page>.{html,js,css}
SHARED_DIR = BASE / "shared"    # site.css, site.js
IMAGE_DIR = BASE / "images"
LOGIN_PAGE = PAGES_DIR / "login.html"      # shown by the password gate; never listed as a tool or served as a page
HIDDEN_PAGES = {"index", "login"}          # in /pages but not tools: the home page, and the login page

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 300 * 1024 * 1024      # biggest upload accepted by the processing API
if os.environ.get("BEHIND_PROXY"):                        # nginx, Caddy, a tunnel...: trust its X-Forwarded-* headers, so
    from werkzeug.middleware.proxy_fix import ProxyFix    # the real client address (login lockout) and https (Secure cookies) are seen
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)


COOKIE = "spell_session"
MAX_AGE = 30 * 24 * 3600          # stay logged in for 30 days
MAX_TRIES = 5                     # failures before a lockout starts
MAX_LOCK = 15 * 60

_fails = {}                       # ip -> [failure count, locked until (epoch seconds)]
_lock = threading.Lock()


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


init_auth(app)
for blueprint in (processing.bp, processing.chat.bp, processing.board.bp, processing.storage.bp):
    app.register_blueprint(blueprint)      # chat/board: the Live page; storage: cloud storage (uploads come in pieces)
SAFE = re.compile(r"^[A-Za-z0-9_-]+$")
ASSET = re.compile(r"^[A-Za-z0-9_-]+\.(?:js|css)$")

# What the home page says about each page: glyph and a one-line description. Unlisted pages get FALLBACK.
TOOLS = {
    "text-tools": ("✎", "Regex find and replace, case conversion, line operations, extraction, encoding, text diff."),
    "image-tools": ("❖", "Layered image editor: transform, crop, filters, grid arrangement, tile split, format conversion."),
    "omni-file-viewer": ("❂", "Viewer, converter and merger for images, PDF, DOCX, spreadsheets, text, audio and video."),
    "calculator": ("∑", "Expressions, unit conversion, equations and linear systems."),
    "cloud-storage": ("☁", "Shared file storage, 500 GB, resumable uploads."),
    "fortune-wheel": ("✺", "Random pick from a list of entries."),
    "live": ("☄", "Chat room with voice, screen sharing and a drawing board."),
    "tabletop": ("✠", "Character sheets, dice, a shared battle map with fog of war, and the dungeon master's HQ."),
}
LABELS = {}                                             # names that title-casing the file name would get wrong
FALLBACK = ("✦", "")


def origin() -> str:
    """Public address of the site, for canonical links and the sitemap. Set SITE_URL (e.g. https://spells.example.com)
    when running behind a proxy that hides the real host."""
    return escape((os.environ.get("SITE_URL") or request.url_root).rstrip("/"))    # it ends up in HTML and XML, and the Host header is not trusted


def option(name: str, allowed: tuple, default: str) -> str:
    value = request.cookies.get("spells_" + name)
    return value if value in allowed else default


def label_for(name: str) -> str:
    if name in LABELS:
        return LABELS[name]
    return name.replace("-", " ").replace("_", " ").title()


def entry(category, name):
    return {"name": name, "label": label_for(name), "glyph": TOOLS.get(name, FALLBACK)[0],      # the glyph is the icon in the retracted sidebar
            "path": f"/{category}/{name}" if category else f"/{name}"}


def nav_groups():
    """Pages directly in /pages are uncategorized; every sub-folder is a category. The home page is left out."""
    groups = []
    loose = sorted(p.stem for p in PAGES_DIR.glob("*.html") if p.stem not in HIDDEN_PAGES and SAFE.match(p.stem))
    if loose:
        groups.append({"category": None, "label": None, "pages": [entry(None, n) for n in loose]})
    for folder in sorted(PAGES_DIR.iterdir()):
        if not (folder.is_dir() and SAFE.match(folder.name)):
            continue
        names = sorted(p.stem for p in folder.glob("*.html") if SAFE.match(p.stem))
        if names:
            groups.append({
                "category": folder.name,
                "label": label_for(folder.name),
                "pages": [entry(folder.name, n) for n in names],
            })
    return groups


def spellbook() -> str:
    """The home page's list of tools, rendered on the server so search engines (and visitors without JS) see it."""
    shelves, n = [], 0
    for g in nav_groups():
        cards = []
        for p in g["pages"]:
            glyph, desc = TOOLS.get(p["name"], FALLBACK)
            cards.append(
                f'<li><a class="spell" href="{p["path"]}" style="--i:{n}">'
                f'<span class="glyph" aria-hidden="true">{glyph}</span>'
                f'<span class="s-name">{escape(p["label"])}</span>'
                f'<span class="s-desc">{escape(desc)}</span>'
                f'<span class="s-path">{p["path"]}</span></a></li>'
            )
            n += 1
        head = f"<h3>{escape(g['label'])}</h3>" if g["label"] else ""
        shelves.append(f'<div class="shelf">{head}<ul>{"".join(cards)}</ul></div>')
    return "".join(shelves) or '<p class="empty">The shelves are empty.</p>'


def inject(html: str, closing_tag: str, snippet: str) -> str:
    """Insert snippet just before the first closing_tag (case-insensitive); append if the tag is missing."""
    m = re.search(re.escape(closing_tag), html, re.I)
    return html[: m.start()] + snippet + html[m.start():] if m else html + snippet


def serve_page(category, name):
    """Serve <name>.html and automatically attach <name>.css / <name>.js sitting next to it,
    so the HTML never has to reference its own files. The saved options (cookies) are written onto <html> here,
    so the page is drawn with the right settings from the first paint."""
    folder = PAGES_DIR / category if category else PAGES_DIR
    html_file = folder / f"{name}.html"
    if not html_file.is_file():
        abort(404)
    html = html_file.read_text(encoding="utf-8")
    prefix = f"/{category}/" if category else "/"
    if (folder / f"{name}.css").is_file() and f"{name}.css" not in html:
        html = inject(html, "</head>", f'  <link rel="stylesheet" href="{prefix}{name}.css">\n')
    if (folder / f"{name}.js").is_file() and f"{name}.js" not in html:
        html = inject(html, "</body>", f'  <script src="{prefix}{name}.js"></script>\n')
    motion = option("motion", ("on", "off"), "off")
    process = option("process", ("browser", "server"), "browser")
    nav = option("nav", ("open", "closed"), "closed")        # the sidebar: retracted to a narrow strip unless it was opened
    auth = "yes" if is_authed() else "no"                 # so a signed-in visitor never sees the "Sign in" button flash
    html = re.sub(r"<html\b", f'<html data-motion="{motion}" data-process="{process}" data-nav="{nav}" data-auth="{auth}"', html, count=1, flags=re.I)
    if not category and name == "index":
        html = html.replace("<!--SPELLBOOK-->", spellbook()).replace("{{ORIGIN}}", origin())
    return Response(html, mimetype="text/html", headers={"Vary": "Cookie"})


@app.route("/")
def home():
    return serve_page(None, "index")


@app.after_request
def safe_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    return resp


@app.route("/robots.txt")
def robots():
    return Response(f"User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: {origin()}/sitemap.xml\n", mimetype="text/plain")


@app.route("/sitemap.xml")
def sitemap():
    # Only the home page is public; the tools sit behind the sign-in.
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
           f"  <url><loc>{origin()}/</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>\n</urlset>\n")
    return Response(xml, mimetype="application/xml")


@app.route("/shared/<path:filename>")
def shared(filename):
    return send_from_directory(SHARED_DIR, filename)


@app.route("/images/<path:filename>")
def images(filename):
    return send_from_directory(IMAGE_DIR, filename)


@app.route("/api/pages")
def pages():
    return jsonify(nav_groups())


@app.route("/<path:url>")
def page(url):
    """/<page>, /<category>/<page>, and the page's .js/.css files (/<category>/<page>.js)."""
    if url.endswith("/"):
        return redirect("/" + url.rstrip("/"), 301)
    *category, last = url.split("/")
    if not category and last in HIDDEN_PAGES:              # the home page lives at "/" only, the login page is the gate's
        abort(404)
    if len(category) > 1 or not all(SAFE.match(c) for c in category):
        abort(404)
    folder = PAGES_DIR.joinpath(*category)
    if ASSET.match(last):
        if not (folder / last).is_file():
            abort(404)
        return send_from_directory(folder, last)
    if SAFE.match(last):
        return serve_page(category[0] if category else None, last)
    abort(404)


if __name__ == "__main__":
    app.run(host="0.0.0.0", debug=False, port=5000)
