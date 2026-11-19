"""Video streaming from the cloud storage (storage.py) for pages/videos.*. Nothing is copied or indexed separately: every
file in the storage with a video extension (mp4, m4v, mov, webm, mkv, avi, wmv, flv, mpg, m2ts, ogv, 3gp ...) is a video,
wherever it sits in the folder tree. Files a browser cannot play as they are (mkv, avi, HEVC, AC3 sound ...) are converted by
transcode.py.
  GET /api/videos/list            -> {items: [{id, name, title, folder, size, created, ext}]}   (id = the storage item id)
  GET /api/videos/file/<id>       the video itself, with HTTP Range support (seeking, and the page's precaching)
  GET /api/videos/thumb/<id>      a poster frame (JPEG), made once with ffmpeg and kept in data/video-thumbs/. 404 without ffmpeg.
Needs nothing new; ffmpeg on the PATH is optional (thumbnails only)."""
import os
import re
import shutil
import subprocess
import threading

from flask import abort, jsonify, send_file

from . import DATA, bp
from .storage import BLOBS, conn as storage_conn

MIME = {".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska",
        ".avi": "video/x-msvideo", ".divx": "video/x-msvideo", ".wmv": "video/x-ms-wmv", ".asf": "video/x-ms-asf", ".flv": "video/x-flv",
        ".mpg": "video/mpeg", ".mpeg": "video/mpeg", ".m2ts": "video/mp2t", ".mts": "video/mp2t", ".ogv": "video/ogg", ".3gp": "video/3gpp"}
HEX = re.compile(r"^[0-9a-f]{32}$")
THUMBS = DATA / "video-thumbs"
MAX_ITEMS = 5000
_slots = threading.BoundedSemaphore(2)          # at most two ffmpeg runs at once


def _ext(name):
    return os.path.splitext(name)[1].lower()


@bp.get("/videos/list")
def videos_list():
    with storage_conn() as c:
        dirs = {r["id"]: (r["parent"], r["name"]) for r in c.execute("SELECT id, parent, name FROM items WHERE is_dir=1")}
        rows = c.execute("SELECT id, parent, name, size, created FROM items WHERE is_dir=0").fetchall()
    memo = {}

    def folder(pid):
        if pid not in memo:
            parts, cur = [], pid
            while cur and cur in dirs and len(parts) < 64:
                cur, name = dirs[cur]
                parts.append(name)
            memo[pid] = " / ".join(reversed(parts))
        return memo[pid]

    items = []
    for r in rows:
        ext = _ext(r["name"])
        if ext in MIME:
            items.append({"id": r["id"], "name": r["name"], "title": os.path.splitext(r["name"])[0], "folder": folder(r["parent"]),
                          "size": r["size"], "created": r["created"], "ext": ext[1:]})
        if len(items) >= MAX_ITEMS:
            break
    resp = jsonify(items=items)
    resp.headers["Cache-Control"] = "no-store"
    return resp


def _video(vid):
    """(blob path, mime, file name) of a video item, or a 404."""
    if not HEX.match(vid):
        abort(404, "No such video.")
    with storage_conn() as c:
        r = c.execute("SELECT name, is_dir FROM items WHERE id=?", (vid,)).fetchone()
    if not r or r["is_dir"] or _ext(r["name"]) not in MIME:
        abort(404, "No such video.")
    path = BLOBS / vid
    if not path.is_file():
        abort(404, "The file is missing on the server.")
    return path, MIME[_ext(r["name"])], r["name"]


@bp.get("/videos/file/<vid>")
def videos_file(vid):
    path, mime, _ = _video(vid)
    resp = send_file(path, mimetype=mime, conditional=True, max_age=3600)      # conditional = Range requests are answered with 206
    resp.cache_control.private, resp.cache_control.public = True, False
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


@bp.get("/videos/thumb/<vid>")
def videos_thumb(vid):
    path, _, _ = _video(vid)
    out, none = THUMBS / f"{vid}.jpg", THUMBS / f"{vid}.none"
    if out.is_file():
        return send_file(out, mimetype="image/jpeg", max_age=30 * 86400)
    exe = shutil.which("ffmpeg")
    if none.exists() or not exe:                 # without ffmpeg nothing is remembered, so installing it later just works
        abort(404, "No poster.")
    THUMBS.mkdir(parents=True, exist_ok=True)
    tmp = THUMBS / f"{vid}.tmp.jpg"
    if not _slots.acquire(timeout=30):
        abort(503, "Busy.")
    try:
        for at in ("5", "0"):                    # a frame five seconds in; the very first one for clips shorter than that
            tmp.unlink(missing_ok=True)
            try:
                subprocess.run([exe, "-v", "error", "-nostdin", "-y", "-ss", at, "-i", str(path), "-frames:v", "1",
                                "-vf", "scale=480:-2", "-q:v", "5", str(tmp)], capture_output=True, timeout=40)
            except (subprocess.SubprocessError, OSError):
                pass
            if tmp.is_file() and tmp.stat().st_size > 0:
                os.replace(tmp, out)
                break
    finally:
        _slots.release()
        tmp.unlink(missing_ok=True)
    if not out.is_file():
        none.touch()
        abort(404, "No poster.")
    return send_file(out, mimetype="image/jpeg", max_age=30 * 86400)
