import re
from pathlib import Path

from flask import Flask, Response, abort, jsonify, redirect, send_from_directory

from chat import bp as chat_bp

BASE = Path(__file__).parent.resolve()
PAGES_DIR = BASE / "pages"      # pages/index.*  = home page, pages/<category>/<page>.{html,js,css}
SHARED_DIR = BASE / "shared"    # base.css, tools.css, navigation.js
IMAGE_DIR = BASE / "images"

app = Flask(__name__, static_folder=None)
app.register_blueprint(chat_bp)
SAFE = re.compile(r"^[A-Za-z0-9_-]+$")
ASSET = re.compile(r"^[A-Za-z0-9_-]+\.(?:js|css)$")


def label_for(name: str) -> str:
    return name.replace("-", " ").replace("_", " ").title()


def entry(category, name):
    return {"name": name, "label": label_for(name), "path": f"/{category}/{name}" if category else f"/{name}"}


def inject(html: str, closing_tag: str, snippet: str) -> str:
    """Insert snippet just before the first closing_tag (case-insensitive); append if the tag is missing."""
    m = re.search(re.escape(closing_tag), html, re.I)
    return html[: m.start()] + snippet + html[m.start():] if m else html + snippet


def serve_page(category, name):
    """Serve <name>.html and automatically attach <name>.css / <name>.js sitting next to it,
    so the HTML never has to reference its own files."""
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
    return Response(html, mimetype="text/html")


@app.route("/")
def home():
    return serve_page(None, "index")


@app.route("/shared/<path:filename>")
def shared(filename):
    return send_from_directory(SHARED_DIR, filename)


@app.route("/images/<path:filename>")
def images(filename):
    return send_from_directory(IMAGE_DIR, filename)


@app.route("/api/pages")
def pages():
    """Navigation data. Pages directly in /pages are uncategorized; every sub-folder is a category.
    The home page (pages/index.html) is left out on purpose."""
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
    return jsonify(groups)


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
    app.run(host="0.0.0.0", debug=True, port=80)
