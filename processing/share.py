"""Share links for cloud storage files (storage.py). A file can be shared with a link that anyone can open, without signing
in, for 24 hours. The same link is also shown as a QR code and as a barcode (drawn in the browser by pages/cloud-share.js).

  POST /api/storage/share        {id} -> {token, path, expires}   share a file (an existing live link is reused)
  POST /api/storage/share/stop   {id} -> {ok}                     stop sharing it
  GET  /s/<token>                a small public page with the file name and a download button (no sign-in)
  GET  /s/<token>/download       the file itself (range requests work)

Only files can be shared, not folders. Links live in the SQLite index of the storage (table "shares"), so they survive
restarts. A link stops working after 24 hours, when it is stopped, or when the file is deleted. app.py lets /s/ through
the password gate; nothing else in the storage is reachable without signing in."""
import re
import secrets
import time
from html import escape

from flask import Blueprint, Response, jsonify, request, send_file

from .errors import Fail, handle_errors
from .storage import BLOBS, _lock, conn

bp = Blueprint("share", __name__)
handle_errors(bp, "The server could not do that.")

TTL = 24 * 3600
HEX = re.compile(r"^[0-9a-f]{32}$")
TOKEN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
PRIVATE = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow",
           "X-Content-Type-Options": "nosniff"}


def _init():
    with conn() as c:
        c.execute("CREATE TABLE IF NOT EXISTS shares(token TEXT PRIMARY KEY, item TEXT NOT NULL, created REAL NOT NULL, expires REAL NOT NULL)")
        c.execute("CREATE INDEX IF NOT EXISTS shares_item ON shares(item)")


_init()


# ---------- for signed-in people ----------
@bp.post("/api/storage/share")
def share_create():
    iid = str((request.get_json(silent=True) or {}).get("id", ""))
    if not HEX.match(iid):
        raise Fail("That file no longer exists.")
    now = time.time()
    with _lock, conn() as c:
        c.execute("DELETE FROM shares WHERE expires <= ?", (now,))
        it = c.execute("SELECT is_dir FROM items WHERE id=?", (iid,)).fetchone()
        if not it:
            raise Fail("That file no longer exists.")
        if it["is_dir"]:
            raise Fail("Only files can be shared, not folders.")
        if not (BLOBS / iid).is_file():
            raise Fail("The file is missing on the server.")
        row = c.execute("SELECT token, expires FROM shares WHERE item=? ORDER BY expires DESC LIMIT 1", (iid,)).fetchone()
        if not row:
            token, expires = secrets.token_urlsafe(12), now + TTL
            c.execute("INSERT INTO shares(token, item, created, expires) VALUES(?,?,?,?)", (token, iid, now, expires))
        else:
            token, expires = row["token"], row["expires"]
    return jsonify(token=token, path=f"/s/{token}", expires=expires)


@bp.post("/api/storage/share/stop")
def share_stop():
    iid = str((request.get_json(silent=True) or {}).get("id", ""))
    if not HEX.match(iid):
        raise Fail("That file no longer exists.")
    with _lock, conn() as c:
        c.execute("DELETE FROM shares WHERE item=?", (iid,))
    return jsonify(ok=True)


# ---------- for anybody with the link ----------
def lookup(token):
    """(file id, name, size, expires) of a live link, or None."""
    if not TOKEN.match(token):
        return None
    with conn() as c:
        r = c.execute("SELECT s.expires, i.id, i.name, i.size FROM shares s JOIN items i ON i.id = s.item "
                      "WHERE s.token=? AND i.is_dir=0", (token,)).fetchone()
    if not r or r["expires"] <= time.time() or not (BLOBS / r["id"]).is_file():
        return None
    return r["id"], r["name"], r["size"], r["expires"]


def size_text(n):
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} B" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


def left_text(seconds):
    m = max(1, int(seconds // 60))
    h, m = divmod(m, 60)
    return f"{h} h {m} min" if h else f"{m} min"


CSS = """
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.5rem;font:16px/1.6 "Inter",system-ui,sans-serif;color:#f1e9ff;background:#140b22 radial-gradient(ellipse at 75% -10%,#4b2a8566,transparent 60%)}
main{width:min(26rem,100%);padding:1.75rem;text-align:center;background:#22123bcc;border:1px solid #8a5bd855;border-radius:.8rem;box-shadow:0 14px 40px #0008}
.moon{font-size:2.4rem;color:#e9c776;text-shadow:0 0 22px #8a5bd8}
h1{margin:.2rem 0 .3rem;font-size:1.25rem;overflow-wrap:anywhere}
p{margin:.3rem 0;color:#d9cbf2;font-size:.95rem}
a.go{display:inline-block;margin-top:1.1rem;padding:.7rem 1.6rem;font-weight:600;color:#fff;text-decoration:none;background:linear-gradient(135deg,#8a5bd8,#4b2a85);border:1px solid #c9a2ff;border-radius:.5rem}
a.go:hover{filter:brightness(1.12)}
"""


def html_page(body, status=200):
    doc = ('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
           '<meta name="robots" content="noindex, nofollow"><title>Shared file · Iprix\'s Spells</title>'
           f'<style>{CSS}</style></head><body><main><div class="moon" aria-hidden="true">☾</div>{body}</main></body></html>')
    return Response(doc, status=status, mimetype="text/html", headers=PRIVATE)


def gone():
    return html_page("<h1>Link not available</h1><p>This link has expired, was stopped, or never existed.</p>", 404)


@bp.get("/s/<token>")
def shared_page(token):
    f = lookup(token)
    if not f:
        return gone()
    _, name, size, expires = f
    return html_page(f"<h1>{escape(name)}</h1><p>{size_text(size)}</p><p>Available for another {left_text(expires - time.time())}.</p>"
                     f'<a class="go" href="/s/{escape(token)}/download">Download</a>')


@bp.get("/s/<token>/download")
def shared_download(token):
    f = lookup(token)
    if not f:
        return gone()
    iid, name, _, _ = f
    resp = send_file(BLOBS / iid, mimetype="application/octet-stream", as_attachment=True, download_name=name,
                     conditional=True, max_age=0)
    resp.headers.update(PRIVATE)
    return resp
