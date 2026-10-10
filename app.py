import os
import re
from html import escape
from pathlib import Path

from flask import Flask, Response, abort, jsonify, redirect, request, send_from_directory

from auth import init_auth
from board import bp as board_bp
from chat import bp as chat_bp
from processing import bp as processing_bp
from storage import bp as storage_bp

BASE = Path(__file__).parent.resolve()
PAGES_DIR = BASE / "pages"      # pages/index.*  = home page, pages/<category>/<page>.{html,js,css}
SHARED_DIR = BASE / "shared"    # site.css, site.js
IMAGE_DIR = BASE / "images"

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 300 * 1024 * 1024      # biggest upload accepted by the processing API
init_auth(app)
app.register_blueprint(chat_bp)
app.register_blueprint(board_bp)                           # the drawing board on the Live page
app.register_blueprint(processing_bp)
app.register_blueprint(storage_bp)                         # cloud storage: uploads come in pieces, see storage.py
SAFE = re.compile(r"^[A-Za-z0-9_-]+$")
ASSET = re.compile(r"^[A-Za-z0-9_-]+\.(?:js|css)$")

# What the home page says about each page: glyph and a one-line description. Unlisted pages get FALLBACK.
TOOLS = {
    "text-tools": ("✎", "Find, replace, clean, convert and compare text."),
    "image-tools": ("❖", "Layer, crop, filter and convert images."),
    "omni-file-viewer": ("❂", "View, convert and combine images, PDFs, Word files and spreadsheets."),
    "cloud-storage": ("☁", "Keep files of any size and download them from anywhere. Up to 500 GB."),
    "live": ("☄", "A shared room: chat, voice, screen sharing and a drawing board."),
}
FALLBACK = ("✦", "A spell worth casting.")


def origin() -> str:
    """Public address of the site, for canonical links and the sitemap. Set SITE_URL (e.g. https://spells.example.com)
    when running behind a proxy that hides the real host."""
    return (os.environ.get("SITE_URL") or request.url_root).rstrip("/")


def option(name: str, allowed: tuple, default: str) -> str:
    value = request.cookies.get("spells_" + name)
    return value if value in allowed else default


def label_for(name: str) -> str:
    return name.replace("-", " ").replace("_", " ").title()


def entry(category, name):
    return {"name": name, "label": label_for(name), "path": f"/{category}/{name}" if category else f"/{name}"}


def nav_groups():
    """Pages directly in /pages are uncategorized; every sub-folder is a category. The home page is left out."""
    groups = []
    loose = sorted(p.stem for p in PAGES_DIR.glob("*.html") if p.stem != "index" and SAFE.match(p.stem))
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
    html = re.sub(r"<html\b", f'<html data-motion="{motion}" data-process="{process}"', html, count=1, flags=re.I)
    if not category and name == "index":
        html = html.replace("<!--SPELLBOOK-->", spellbook()).replace("{{ORIGIN}}", origin())
    return Response(html, mimetype="text/html", headers={"Vary": "Cookie"})


@app.route("/")
def home():
    return serve_page(None, "index")


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
