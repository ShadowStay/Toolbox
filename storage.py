"""Cloud storage: one shared drive. 500 GB in total (STORAGE_LIMIT_GB to change it), but no limit on the size of a
single file and no restriction on file types, for uploads or downloads. Only a signed-in person can reach it (auth.py).

Files live on disk under data/storage/blobs/<id> (STORAGE_DIR moves it); names, folders and sizes live in an SQLite
index next to them, so a file name can never be used as a path.

  GET    /api/storage/list?parent=<id>          folder contents, breadcrumb path, space used
  GET    /api/storage/folders                   every folder (for the "Move to" dialog)
  POST   /api/storage/folder                    {parent, name, exist_ok}
  POST   /api/storage/rename                    {id, name}
  POST   /api/storage/move                      {ids, parent}
  POST   /api/storage/delete                    {ids}  (folders are deleted with their contents)
  GET    /api/storage/download/<id>[?inline=1]  a file (range requests work), or a folder as a streamed .zip
  PUT    /api/storage/file?parent=&name=        a whole file in one request (the page uses it up to 32 MB)
  POST   /api/storage/upload                    {parent, name, size} -> {id}  start a chunked upload
  GET    /api/storage/upload/<id>               -> {received}                 where to resume
  PUT    /api/storage/upload/<id>?offset=N      one chunk, raw body
  POST   /api/storage/upload/<id>/finish        -> {id, name}
  DELETE /api/storage/upload/<id>               cancel

Chunked uploads keep every request far below the app's 300 MB request limit, survive dropped connections, and work
behind proxies that cap request bodies. Space for an upload is reserved when it starts, so the 500 GB can't be
overshot by uploads running in parallel. State is in SQLite and on disk, so it survives restarts."""
import io
import mimetypes
import os
import re
import shutil
import sqlite3
import threading
import time
import uuid
import zipfile
from contextlib import contextmanager
from itertools import count
from pathlib import Path
from urllib.parse import quote

from flask import Blueprint, Response, abort, jsonify, request, send_file

from auth import DATA
from errors import Fail, handle_errors

bp = Blueprint("storage", __name__, url_prefix="/api/storage")

LIMIT = int(float(os.environ.get("STORAGE_LIMIT_GB", "500")) * 1024 ** 3)
ROOT = Path(os.environ.get("STORAGE_DIR") or DATA / "storage").resolve()
BLOBS, TMP, DB_FILE = ROOT / "blobs", ROOT / "tmp", ROOT / "index.db"
STALE = 24 * 3600                       # an upload nobody touched for a day is dropped and its space released
HEX = re.compile(r"^[0-9a-f]{32}$")
# Shown in the browser instead of downloaded. SVG and HTML are left out on purpose: they can run scripts.
INLINE = re.compile(r"^(image/(png|jpeg|gif|webp|avif|bmp|x-icon)|audio/|video/|application/pdf$)")

_lock = threading.Lock()                # guards quota checks and tree changes
_locks = {}                             # upload id -> lock, so two requests never write the same temp file at once


handle_errors(bp, "The server could not do that.")


# ---------- database ----------
@contextmanager
def conn():
    c = sqlite3.connect(DB_FILE, timeout=30)
    c.row_factory = sqlite3.Row
    try:
        with c:                         # commit on success, roll back on error
            yield c
    finally:
        c.close()


def _init():
    for d in (BLOBS, TMP):
        d.mkdir(parents=True, exist_ok=True)
    with conn() as c:
        c.execute("PRAGMA journal_mode=WAL")
        c.executescript("""
            CREATE TABLE IF NOT EXISTS items(
                id TEXT PRIMARY KEY, parent TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,
                is_dir INTEGER NOT NULL, size INTEGER NOT NULL DEFAULT 0, mime TEXT NOT NULL DEFAULT '', created REAL NOT NULL);
            CREATE UNIQUE INDEX IF NOT EXISTS items_name ON items(parent, name);
            CREATE TABLE IF NOT EXISTS uploads(
                id TEXT PRIMARY KEY, parent TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL,
                received INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL, touched REAL NOT NULL);
        """)


_init()


# ---------- helpers ----------
def fmt(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} B" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


def body():
    d = request.get_json(silent=True)
    return d if isinstance(d, dict) else {}


def clean_name(value):
    name = re.sub(r"[\x00-\x1f\x7f]", "", str(value or "")).strip()
    if not name or name in (".", ".."):
        raise Fail("Enter a name.")
    if "/" in name or "\\" in name:
        raise Fail("Names can't contain / or \\.")
    if len(name) > 255:
        raise Fail("That name is too long (255 characters at most).")
    return name


def hexid(value):
    if not HEX.match(str(value)):
        abort(404, "No such item.")
    return str(value)


def guess(name):
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


def need_dir(c, pid):
    if pid and not c.execute("SELECT 1 FROM items WHERE id=? AND is_dir=1", (pid,)).fetchone():
        raise Fail("That folder no longer exists.")


def free_name(c, parent, name):
    """The name itself, or 'name (2).ext' when something in the folder already has it."""
    taken = lambda n: c.execute("SELECT 1 FROM items WHERE parent=? AND name=?", (parent, n)).fetchone()
    if not taken(name):
        return name
    stem, ext = os.path.splitext(name)
    for n in count(2):
        candidate = f"{stem[:200]} ({n}){ext}"
        if not taken(candidate):
            return candidate


def usage(c):
    used = c.execute("SELECT COALESCE(SUM(size),0) FROM items WHERE is_dir=0").fetchone()[0]
    held = c.execute("SELECT COALESCE(SUM(size),0) FROM uploads").fetchone()[0]
    return used, held


def check_room(c, size):
    used, held = usage(c)
    left = LIMIT - used - held
    if size > left:
        raise Fail(f"That does not fit: {fmt(max(left, 0))} free of {fmt(LIMIT)}.")
    if size > shutil.disk_usage(ROOT).free:
        raise Fail("The server's disk does not have room for that file.")


def subtree(c, ids):
    marks = ",".join("?" * len(ids))
    return c.execute(
        f"WITH RECURSIVE t(id) AS (SELECT id FROM items WHERE id IN ({marks}) "
        "UNION ALL SELECT i.id FROM items i JOIN t ON i.parent = t.id) "
        "SELECT i.id, i.is_dir FROM items i JOIN t ON i.id = t.id", ids).fetchall()


def id_list(d):
    ids = d.get("ids")
    if not isinstance(ids, list) or not ids or len(ids) > 1000:
        raise Fail("Nothing was selected.")
    return [str(i) for i in ids]


def disposition(name):
    ascii_name = re.sub(r'[^\x20-\x7e]|["\\]', "_", name)
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name, safe='')}"


# ---------- browsing ----------
@bp.get("/list")
def list_dir():
    parent = request.args.get("parent", "")
    with conn() as c:
        need_dir(c, parent)
        items = c.execute("SELECT id, name, is_dir, size, mime, created FROM items WHERE parent=? "
                          "ORDER BY is_dir DESC, name COLLATE NOCASE", (parent,)).fetchall()
        path, cur = [], parent
        while cur:
            r = c.execute("SELECT id, parent, name FROM items WHERE id=?", (cur,)).fetchone()
            path.append({"id": r["id"], "name": r["name"]})
            cur = r["parent"]
        used, held = usage(c)
    return jsonify(items=[dict(r) for r in items], path=path[::-1], used=used, held=held, limit=LIMIT)


@bp.get("/folders")
def all_folders():
    with conn() as c:
        rows = c.execute("SELECT id, parent, name FROM items WHERE is_dir=1").fetchall()
    return jsonify(folders=[dict(r) for r in rows])


# ---------- changing the tree ----------
@bp.post("/folder")
def make_folder():
    d = body()
    parent, name = str(d.get("parent", "")), clean_name(d.get("name"))
    with _lock, conn() as c:
        need_dir(c, parent)
        old = c.execute("SELECT id, is_dir FROM items WHERE parent=? AND name=?", (parent, name)).fetchone()
        if old:
            if d.get("exist_ok") and old["is_dir"]:
                return jsonify(id=old["id"])
            raise Fail("Something with that name already exists here.")
        fid = uuid.uuid4().hex
        c.execute("INSERT INTO items(id, parent, name, is_dir, created) VALUES(?,?,?,1,?)", (fid, parent, name, time.time()))
    return jsonify(id=fid)


@bp.post("/rename")
def rename():
    d = body()
    iid, name = str(d.get("id", "")), clean_name(d.get("name"))
    with _lock, conn() as c:
        r = c.execute("SELECT parent, is_dir FROM items WHERE id=?", (iid,)).fetchone()
        if not r:
            raise Fail("That item no longer exists.")
        if c.execute("SELECT 1 FROM items WHERE parent=? AND name=? AND id<>?", (r["parent"], name, iid)).fetchone():
            raise Fail("Something with that name already exists here.")
        c.execute("UPDATE items SET name=?, mime=? WHERE id=?", (name, "" if r["is_dir"] else guess(name), iid))
    return jsonify(ok=True)


@bp.post("/move")
def move():
    d = body()
    ids, dest = id_list(d), str(d.get("parent", ""))
    with _lock, conn() as c:
        need_dir(c, dest)
        inside, cur = set(), dest               # the destination and everything above it
        while cur:
            inside.add(cur)
            cur = c.execute("SELECT parent FROM items WHERE id=?", (cur,)).fetchone()["parent"]
        for i in ids:
            r = c.execute("SELECT parent, name FROM items WHERE id=?", (i,)).fetchone()
            if not r:
                raise Fail("An item no longer exists.")
            if i in inside:
                raise Fail("A folder can't be moved into itself.")
            if r["parent"] == dest:
                continue
            if c.execute("SELECT 1 FROM items WHERE parent=? AND name=?", (dest, r["name"])).fetchone():
                raise Fail(f"“{r['name']}” already exists in that folder.")
            c.execute("UPDATE items SET parent=? WHERE id=?", (dest, i))
    return jsonify(ok=True)


@bp.post("/delete")
def delete():
    ids = id_list(body())
    with _lock, conn() as c:
        rows = subtree(c, ids)
        c.executemany("DELETE FROM items WHERE id=?", [(r["id"],) for r in rows])
    for r in rows:
        if not r["is_dir"]:
            (BLOBS / r["id"]).unlink(missing_ok=True)
    return jsonify(deleted=len(rows))


# ---------- uploading ----------
def _begin(parent, name, size):
    with _lock, conn() as c:
        for r in c.execute("SELECT id FROM uploads WHERE touched < ?", (time.time() - STALE,)).fetchall():
            c.execute("DELETE FROM uploads WHERE id=?", (r["id"],))
            (TMP / r["id"]).unlink(missing_ok=True)
            _locks.pop(r["id"], None)
        need_dir(c, parent)
        check_room(c, size)
        uid, now = uuid.uuid4().hex, time.time()
        c.execute("INSERT INTO uploads(id, parent, name, size, received, created, touched) VALUES(?,?,?,?,0,?,?)",
                  (uid, parent, name, size, now, now))
    (TMP / uid).touch()
    return uid


def _receive(uid, offset, stream):
    """Write the stream into the temp file at offset. Returns (accepted, bytes received so far)."""
    with conn() as c:
        u = c.execute("SELECT size, received FROM uploads WHERE id=?", (uid,)).fetchone()
    if not u:
        raise Fail("This upload is no longer on the server. Start it again.")
    with _locks.setdefault(uid, threading.Lock()):
        with conn() as c:                       # read again now that this request owns the upload
            u = c.execute("SELECT size, received FROM uploads WHERE id=?", (uid,)).fetchone()
        if not u:
            raise Fail("This upload is no longer on the server. Start it again.")
        if offset != u["received"]:
            return False, u["received"]
        room, n = u["size"] - offset, 0
        with open(TMP / uid, "r+b") as f:
            f.seek(offset)
            while True:
                piece = stream.read(1 << 20)
                if not piece:
                    break
                n += len(piece)
                if n > room:
                    raise Fail("More data arrived than the upload announced.")
                f.write(piece)
        with conn() as c:
            c.execute("UPDATE uploads SET received=?, touched=? WHERE id=?", (offset + n, time.time(), uid))
        return True, offset + n


def _finish(uid):
    with _lock, conn() as c:
        u = c.execute("SELECT * FROM uploads WHERE id=?", (uid,)).fetchone()
        if not u:
            raise Fail("This upload is no longer on the server. Start it again.")
        if u["received"] != u["size"]:
            raise Fail("The upload is incomplete.")
        need_dir(c, u["parent"])
        name, fid = free_name(c, u["parent"], u["name"]), uuid.uuid4().hex
        c.execute("INSERT INTO items(id, parent, name, is_dir, size, mime, created) VALUES(?,?,?,0,?,?,?)",
                  (fid, u["parent"], name, u["size"], guess(name), time.time()))
        os.replace(TMP / uid, BLOBS / fid)      # if this fails the insert is rolled back
        c.execute("DELETE FROM uploads WHERE id=?", (uid,))
    _locks.pop(uid, None)
    return fid, name


def _abort(uid):
    with _lock, conn() as c:
        c.execute("DELETE FROM uploads WHERE id=?", (uid,))
    (TMP / uid).unlink(missing_ok=True)
    _locks.pop(uid, None)


@bp.put("/file")
def put_file():
    parent, name = request.args.get("parent", ""), clean_name(request.args.get("name"))
    size = request.content_length
    if size is None:
        raise Fail("The upload did not say how large it is.")
    uid = _begin(parent, name, size)
    try:
        _, got = _receive(uid, 0, request.stream)
        if got != size:
            raise Fail("The upload was cut short. Try again.")
        fid, final = _finish(uid)
    except BaseException:
        _abort(uid)
        raise
    return jsonify(id=fid, name=final)


@bp.post("/upload")
def upload_start():
    d = body()
    try:
        size = int(d.get("size"))
    except (TypeError, ValueError):
        raise Fail("The upload did not say how large it is.")
    if size < 0:
        raise Fail("The upload did not say how large it is.")
    return jsonify(id=_begin(str(d.get("parent", "")), clean_name(d.get("name")), size))


@bp.get("/upload/<uid>")
def upload_status(uid):
    with conn() as c:
        u = c.execute("SELECT received FROM uploads WHERE id=?", (hexid(uid),)).fetchone()
    if not u:
        raise Fail("This upload is no longer on the server. Start it again.")
    return jsonify(received=u["received"])


@bp.put("/upload/<uid>")
def upload_chunk(uid):
    try:
        offset = int(request.args.get("offset", ""))
    except ValueError:
        raise Fail("Missing offset.")
    ok, received = _receive(hexid(uid), offset, request.stream)
    if not ok:
        return jsonify(error="The server is at a different position. Resuming.", received=received), 409
    return jsonify(received=received)


@bp.post("/upload/<uid>/finish")
def upload_finish(uid):
    fid, name = _finish(hexid(uid))
    return jsonify(id=fid, name=name)


@bp.delete("/upload/<uid>")
def upload_cancel(uid):
    _abort(hexid(uid))
    return jsonify(ok=True)


# ---------- downloading ----------
class _Sink(io.RawIOBase):
    """Collects what zipfile writes so the generator can hand it to the client piece by piece."""
    def __init__(self):
        self.parts = []

    def writable(self):
        return True

    def write(self, b):
        self.parts.append(bytes(b))
        return len(b)

    def take(self):
        data = b"".join(self.parts)
        self.parts.clear()
        return data


def _entries(c, root_id, root_name):
    out = [(root_name + "/", None, time.time(), 0)]

    def walk(pid, prefix):
        for r in c.execute("SELECT id, name, is_dir, size, created FROM items WHERE parent=? ORDER BY name", (pid,)).fetchall():
            path = prefix + r["name"]
            if r["is_dir"]:
                out.append((path + "/", None, r["created"], 0))
                walk(r["id"], path + "/")
            else:
                out.append((path, r["id"], r["created"], r["size"]))
    walk(root_id, root_name + "/")
    return out


def _zip_stream(entries):
    """A zip built on the fly: nothing is staged on disk, so folders of any size download without delay."""
    sink = _Sink()
    with zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED, allowZip64=True) as z:
        for name, fid, created, size in entries:
            info = zipfile.ZipInfo(name, time.localtime(max(created, 315532800))[:6])
            info.compress_type = zipfile.ZIP_STORED
            if fid is None:
                info.external_attr = (0o40755 << 16) | 0x10
                z.writestr(info, b"")
            else:
                path = BLOBS / fid
                if not path.is_file():
                    continue
                info.file_size = size
                with open(path, "rb") as src, z.open(info, "w", force_zip64=True) as dst:
                    while True:
                        piece = src.read(1 << 20)
                        if not piece:
                            break
                        dst.write(piece)
                        data = sink.take()
                        if data:
                            yield data
            data = sink.take()
            if data:
                yield data
    yield sink.take()


@bp.get("/download/<iid>")
def download(iid):
    iid = hexid(iid)
    with conn() as c:
        r = c.execute("SELECT id, name, is_dir, mime FROM items WHERE id=?", (iid,)).fetchone()
        if not r:
            abort(404, "That item no longer exists.")
        entries = _entries(c, iid, r["name"]) if r["is_dir"] else None
    if entries is not None:
        return Response(_zip_stream(entries), mimetype="application/zip",
                        headers={"Content-Disposition": disposition(r["name"] + ".zip"), "X-Accel-Buffering": "no"})
    path = BLOBS / iid
    if not path.is_file():
        abort(404, "The file is missing on the server.")
    inline = bool(request.args.get("inline")) and bool(INLINE.match(r["mime"]))
    resp = send_file(path, mimetype=r["mime"] if inline else "application/octet-stream", as_attachment=not inline,
                     download_name=r["name"], conditional=True, max_age=0)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp
