"""Music library, built on the cloud storage (storage.py). The library is every file inside the cloud storage's root-level
"music" folder (sub-folders included), so music is added, renamed, moved and deleted with the Cloud Storage page. Nothing is
copied: tracks are streamed straight from the storage blobs (data/storage/blobs/<id>) with HTTP Range support.
This module only keeps its own index (data/music.db): tags, playlists, likes, history and the resume point, plus small cached
artwork in data/art/. The page rescans the storage index whenever it opens (cheap: only new files are read).
Needs: pip install mutagen (Pillow is already used)."""
import base64
import io
import os
import re
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from flask import Blueprint, Response, abort, jsonify, request, send_file

from . import DATA
from .errors import Fail, handle_errors
from .storage import BLOBS, _lock as storage_lock, conn as storage_conn

bp = Blueprint("music", __name__, url_prefix="/api/music")
handle_errors(bp, "The server could not do that.")

FOLDER = os.environ.get("MUSIC_FOLDER", "music")          # root-level folder of the cloud storage
DB, ART, TMP = DATA / "music.db", DATA / "art", DATA / "music-tmp"
MIME = {".mp3": "audio/mpeg", ".flac": "audio/flac", ".m4a": "audio/mp4", ".mp4": "audio/mp4",
        ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav"}
SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS tracks(id INTEGER PRIMARY KEY, path TEXT UNIQUE, title TEXT, artist TEXT, album TEXT, genre TEXT,
  no INTEGER, dur REAL, size INTEGER, mtime REAL, s TEXT, ext TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS playlists(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pl_tracks(pl INTEGER, pos INTEGER, track INTEGER, PRIMARY KEY(pl, pos));
CREATE TABLE IF NOT EXISTS likes(track INTEGER PRIMARY KEY, ts REAL);
CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY, track INTEGER, ts REAL);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
CREATE INDEX IF NOT EXISTS tr_album ON tracks(album, no);
CREATE INDEX IF NOT EXISTS h_track ON history(track);
"""
_ready = False
scan_state = {"running": False, "seen": 0, "error": "", "at": 0}
_scan_lock = threading.Lock()


def db():
    global _ready
    DATA.mkdir(exist_ok=True)
    c = sqlite3.connect(DB, timeout=30)
    c.row_factory = sqlite3.Row
    if not _ready:
        c.executescript(SCHEMA)
        try:                                               # a database made by an earlier version
            c.execute("ALTER TABLE tracks ADD COLUMN ext TEXT DEFAULT ''")
        except sqlite3.OperationalError:
            pass
        _ready = True
    return c


def q(sql, p=()):
    """One statement on a short-lived connection -> (rows, lastrowid)."""
    c = db()
    try:
        cur = c.execute(sql, p)
        rows = cur.fetchall()
        c.commit()
        return rows, cur.lastrowid
    finally:
        c.close()


# ---------- the cloud storage's music folder ----------
def ensure_folder():
    """Make sure the "music" folder exists in the cloud storage, so it is there to upload into."""
    with storage_lock, storage_conn() as s:
        if not s.execute("SELECT 1 FROM items WHERE parent='' AND is_dir=1 AND name=? COLLATE NOCASE", (FOLDER,)).fetchone():
            s.execute("INSERT INTO items(id, parent, name, is_dir, created) VALUES(?,?,?,1,?)",
                      (uuid.uuid4().hex, "", FOLDER, time.time()))


def library():
    """Every file below the music folder, straight from the storage index: [(item id, file name)]."""
    with storage_conn() as s:
        root = s.execute("SELECT id FROM items WHERE parent='' AND is_dir=1 AND name=? COLLATE NOCASE", (FOLDER,)).fetchone()
        if not root:
            return []
        return [(r["id"], r["name"]) for r in s.execute(
            "WITH RECURSIVE t(id) AS (SELECT id FROM items WHERE parent=? UNION ALL "
            "SELECT i.id FROM items i JOIN t ON i.parent=t.id) "
            "SELECT i.id, i.name FROM items i JOIN t ON i.id=t.id WHERE i.is_dir=0", (root["id"],))]


@contextmanager
def named(fid, ext):
    """Storage blobs have no file extension, which tag readers use as a hint: give them a short-lived symlink that has one."""
    blob = BLOBS / fid
    link = TMP / (uuid.uuid4().hex + ext)
    try:
        TMP.mkdir(parents=True, exist_ok=True)
        os.symlink(blob, link)
    except OSError:
        link = blob
    try:
        yield link
    finally:
        if link != blob:
            link.unlink(missing_ok=True)


# ---------- metadata ----------
ID3 = {"title": "TIT2", "artist": "TPE1", "album": "TALB", "genre": "TCON", "tracknumber": "TRCK"}


def tag(f, k):
    """Easy keys cover MP3, FLAC, OGG/Opus and M4A; raw ID3 frames cover WAV files that carry ID3 tags."""
    for key in (k, ID3.get(k)):
        try:
            v = f.tags[key]
            v = v.text[0] if hasattr(v, "text") else v[0]
            if str(v).strip():
                return str(v).strip()
        except Exception:
            pass
    return ""


def meta(fid, name, ext):
    import mutagen
    with named(fid, ext) as p:
        try:
            f = mutagen.File(p, easy=True)
        except Exception:
            f = None
    g = (lambda k: tag(f, k)) if f is not None else (lambda k: "")
    title, artist, album, genre = g("title") or Path(name).stem, g("artist") or g("albumartist"), g("album"), g("genre")
    m = re.match(r"\d+", g("tracknumber"))
    dur = getattr(getattr(f, "info", None), "length", 0) or 0
    return title, artist, album, genre, int(m.group()) if m else 0, dur


def scan_body():
    try:
        scan_state["error"] = ""
        ensure_folder()
        c = db()
        known = {r["path"]: r["ext"] for r in c.execute("SELECT path, ext FROM tracks")}
        found = set()
        for fid, name in library():
            ext = Path(name).suffix.lower()
            blob = BLOBS / fid
            if ext not in MIME or not blob.is_file():
                continue
            found.add(fid)
            scan_state["seen"] += 1
            if known.get(fid) == ext:                      # storage ids never change, so a known id is already indexed
                continue
            t = meta(fid, name, ext)
            s = " ".join(t[:4]).lower()
            c.execute("""INSERT INTO tracks(path,title,artist,album,genre,no,dur,size,mtime,s,ext) VALUES(?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(path) DO UPDATE SET title=excluded.title, artist=excluded.artist, album=excluded.album,
                genre=excluded.genre, no=excluded.no, dur=excluded.dur, size=excluded.size, s=excluded.s, ext=excluded.ext""",
                      (fid, *t, blob.stat().st_size, time.time(), s, ext))
            if scan_state["seen"] % 100 == 0:
                c.commit()
        c.executemany("DELETE FROM tracks WHERE path=?", [(k,) for k in known if k not in found])
        c.commit()
        c.close()
    except Exception as e:
        scan_state["error"] = str(e)
    finally:
        scan_state["running"] = False


def start_scan():
    with _scan_lock:
        if scan_state["running"]:
            return
        scan_state.update(running=True, seen=0, at=time.time())
    threading.Thread(target=scan_body, daemon=True).start()


@bp.post("/scan")
def scan():
    start_scan()
    return jsonify(ok=True), 202


@bp.get("/status")
def status():
    n = q("SELECT COUNT(*) n FROM tracks")[0][0]["n"]
    if not scan_state["running"] and (not n or time.time() - scan_state["at"] > 30):   # picks up new cloud uploads
        start_scan()
    return jsonify(count=n, **scan_state)


# ---------- browse and search ----------
COLS = "t.id, t.title, t.artist, t.album, t.genre, t.dur"


def where(text):
    """Every word must appear somewhere in title/artist/album/genre; case-insensitive, partial matches allowed."""
    w, p = [], []
    for tok in text.lower().split():
        w.append("t.s LIKE ? ESCAPE '\\'")
        p.append("%" + tok.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
    return w, p


def paging(a, default=100):
    return max(1, min(int(a.get("limit", default)), 5000)), max(0, int(a.get("offset", 0)))


@bp.get("/tracks")
def tracks():
    a = request.args
    w, p = where(a.get("q", ""))
    j, order = "", "t.artist COLLATE NOCASE, t.album COLLATE NOCASE, t.no, t.title COLLATE NOCASE"
    for k in ("album", "artist", "genre"):
        if a.get(k) is not None:
            w.append(f"t.{k}=?")
            p.append(a[k])
    if a.get("pl"):
        j, order = "JOIN pl_tracks x ON x.track=t.id", "x.pos"
        w.append("x.pl=?")
        p.append(int(a["pl"]))
    elif a.get("liked"):
        j, order = "JOIN likes l ON l.track=t.id", "l.ts DESC"
    elif a.get("hist"):
        j, order = "JOIN history h ON h.track=t.id", "h.id DESC"
    elif a.get("recent"):
        j, order = "JOIN (SELECT track, MAX(id) m FROM history GROUP BY track) h ON h.track=t.id", "h.m DESC"
    limit, off = paging(a)
    sql = (f"SELECT {COLS}, EXISTS(SELECT 1 FROM likes WHERE track=t.id) liked FROM tracks t {j} "
           f"{'WHERE ' + ' AND '.join(w) if w else ''} ORDER BY {order} LIMIT ? OFFSET ?")
    rows = q(sql, p + [limit + 1, off])[0]
    return jsonify(items=[dict(r) for r in rows[:limit]], more=len(rows) > limit)


BROWSE = {
    "albums": "SELECT album, artist, MIN(id) art, COUNT(*) n FROM tracks t {w} GROUP BY album, artist ORDER BY album COLLATE NOCASE",
    "artists": "SELECT artist, MIN(id) art, COUNT(*) n FROM tracks t {w} GROUP BY artist ORDER BY artist COLLATE NOCASE",
    "genres": "SELECT genre, MIN(id) art, COUNT(*) n FROM tracks t WHERE genre!='' GROUP BY genre ORDER BY genre COLLATE NOCASE",
}


@bp.get("/browse/<kind>")
def browse(kind):
    if kind not in BROWSE:
        abort(404)
    w, p = where(request.args.get("q", "")) if kind != "genres" else ([], [])
    limit, off = paging(request.args, 60)
    rows = q(BROWSE[kind].format(w="WHERE " + " AND ".join(w) if w else "") + " LIMIT ? OFFSET ?", p + [limit + 1, off])[0]
    return jsonify(items=[dict(r) for r in rows[:limit]], more=len(rows) > limit)


@bp.get("/search")
def search():
    w, p = where(request.args.get("q", ""))
    if not w:
        return jsonify(tracks=[], albums=[], artists=[], playlists=[])
    cond = "WHERE " + " AND ".join(w)
    c = db()
    try:
        out = {
            "tracks": [dict(r) for r in c.execute(
                f"SELECT {COLS}, EXISTS(SELECT 1 FROM likes WHERE track=t.id) liked FROM tracks t {cond} "
                "ORDER BY t.title COLLATE NOCASE LIMIT 50", p)],
            "albums": [dict(r) for r in c.execute(
                f"SELECT album, artist, MIN(id) art, COUNT(*) n FROM tracks t {cond} AND album!='' GROUP BY album, artist LIMIT 12", p)],
            "artists": [dict(r) for r in c.execute(
                f"SELECT artist, MIN(id) art, COUNT(*) n FROM tracks t {cond} AND artist!='' GROUP BY artist LIMIT 8", p)],
            "playlists": [dict(r) for r in c.execute(
                "SELECT id, name FROM playlists WHERE " + " AND ".join("LOWER(name) LIKE ? ESCAPE '\\'" for _ in w) + " LIMIT 8", p)],
        }
    finally:
        c.close()
    return jsonify(out)


# ---------- files and artwork ----------
def blob_of(tid):
    r = q("SELECT path, ext FROM tracks WHERE id=?", (tid,))[0]
    if not r or not (BLOBS / r[0]["path"]).is_file():
        abort(404, "That song is no longer in the cloud storage.")
    return r[0]["path"], r[0]["ext"]


@bp.get("/file/<int:tid>")
def file(tid):
    fid, ext = blob_of(tid)
    resp = send_file(BLOBS / fid, mimetype=MIME.get(ext, "application/octet-stream"), conditional=True, max_age=86400)
    resp.cache_control.private, resp.cache_control.public = True, False
    return resp


def cover(fid, ext):
    import mutagen
    from mutagen.flac import Picture
    try:
        with named(fid, ext) as p:
            f = mutagen.File(p)
        if f is not None:
            if getattr(f, "pictures", None):
                return f.pictures[0].data                                   # FLAC
            t = f.tags
            if t is not None:
                if hasattr(t, "getall") and t.getall("APIC"):
                    return t.getall("APIC")[0].data                         # MP3 / WAV (ID3)
                if "covr" in t:
                    return bytes(t["covr"][0])                              # M4A
                if "metadata_block_picture" in t:                           # OGG / Opus
                    return Picture(base64.b64decode(t["metadata_block_picture"][0])).data
    except Exception:
        pass
    return None


@bp.get("/art/<int:tid>")
def art(tid):
    f, none = ART / f"{tid}.jpg", ART / f"{tid}.none"
    if none.exists():
        abort(404)
    if not f.exists():
        ART.mkdir(parents=True, exist_ok=True)
        data = cover(*blob_of(tid))
        try:
            from PIL import Image
            im = Image.open(io.BytesIO(data)).convert("RGB")
            im.thumbnail((320, 320))
            im.save(f, "JPEG", quality=82)
        except Exception:
            none.touch()
            abort(404)
    return send_file(f, mimetype="image/jpeg", max_age=30 * 86400)


# ---------- playlists, likes, history, state ----------
def body():
    d = request.get_json(silent=True)
    return d if isinstance(d, dict) else {}


def pl_name(d):
    name = str(d.get("name", "")).strip()[:100]
    if not name:
        raise Fail("Enter a name.")
    return name


@bp.get("/playlists")
def playlists():
    rows = q("""SELECT p.id, p.name, (SELECT COUNT(*) FROM pl_tracks WHERE pl=p.id) n,
                (SELECT track FROM pl_tracks WHERE pl=p.id ORDER BY pos LIMIT 1) art
                FROM playlists p ORDER BY p.name COLLATE NOCASE""")[0]
    return jsonify(items=[dict(r) for r in rows])


def append(c, pid, ids):
    pos = c.execute("SELECT COALESCE(MAX(pos), -1) + 1 FROM pl_tracks WHERE pl=?", (pid,)).fetchone()[0]
    c.executemany("INSERT INTO pl_tracks VALUES(?,?,?)", [(pid, pos + i, int(t)) for i, t in enumerate(ids)])


@bp.post("/playlists")
def playlist_new():
    b = body()
    c = db()
    try:
        pid = c.execute("INSERT INTO playlists(name) VALUES(?)", (pl_name(b),)).lastrowid
        append(c, pid, b.get("ids", []))
        c.commit()
    finally:
        c.close()
    return jsonify(id=pid)


@bp.patch("/playlists/<int:pid>")
def playlist_rename(pid):
    q("UPDATE playlists SET name=? WHERE id=?", (pl_name(body()), pid))
    return "", 204


@bp.delete("/playlists/<int:pid>")
def playlist_delete(pid):
    c = db()
    try:
        c.execute("DELETE FROM pl_tracks WHERE pl=?", (pid,))
        c.execute("DELETE FROM playlists WHERE id=?", (pid,))
        c.commit()
    finally:
        c.close()
    return "", 204


@bp.route("/playlists/<int:pid>/tracks", methods=["POST", "PUT"])
def playlist_tracks(pid):
    """POST appends the ids; PUT replaces the whole ordered list (used for reorder and remove)."""
    ids = body().get("ids", [])
    c = db()
    try:
        if request.method == "PUT":
            c.execute("DELETE FROM pl_tracks WHERE pl=?", (pid,))
        append(c, pid, ids)
        c.commit()
    finally:
        c.close()
    return "", 204


@bp.put("/like/<int:tid>")
def like(tid):
    if body().get("liked"):
        q("INSERT OR IGNORE INTO likes VALUES(?,?)", (tid, time.time()))
    else:
        q("DELETE FROM likes WHERE track=?", (tid,))
    return "", 204


@bp.post("/history")
def history():
    q("INSERT INTO history(track, ts) VALUES(?,?)", (int(body().get("id", 0)), time.time()))
    q("DELETE FROM history WHERE id < (SELECT MAX(id) - 5000 FROM history)")
    return "", 204


@bp.route("/state", methods=["GET", "PUT", "POST"])
def state():
    """Resume point shared by all devices: {cur: track, t: seconds, ts: ms}. POST exists for navigator.sendBeacon."""
    if request.method == "GET":
        r = q("SELECT v FROM kv WHERE k='state'")[0]
        return Response(r[0]["v"] if r else "{}", mimetype="application/json")
    q("INSERT INTO kv VALUES('state', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (request.get_data(as_text=True)[:20000],))
    return "", 204
