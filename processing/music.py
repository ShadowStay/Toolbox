"""Music library. Scans MUSIC_DIR into SQLite (data/music.db), streams files with HTTP Range, extracts artwork lazily
(cached as small JPEGs in data/art/), and keeps playlists, likes, history and resume state on the server.
Set MUSIC_DIR to the folder on the Pi that holds your cloud-storage music. Needs: pip install mutagen (Pillow is already used)."""
import base64
import io
import os
import re
import sqlite3
import threading
import time
from pathlib import Path

from flask import Blueprint, Response, abort, jsonify, request, send_file

from . import DATA

bp = Blueprint("music", __name__, url_prefix="/api/music")
ROOT = Path(os.environ.get("MUSIC_DIR", Path.home() / "Music")).expanduser()
DB, ART = DATA / "music.db", DATA / "art"
MIME = {".mp3": "audio/mpeg", ".flac": "audio/flac", ".m4a": "audio/mp4", ".mp4": "audio/mp4",
        ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav"}
SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS tracks(id INTEGER PRIMARY KEY, path TEXT UNIQUE, title TEXT, artist TEXT, album TEXT, genre TEXT,
  no INTEGER, dur REAL, size INTEGER, mtime REAL, s TEXT);
CREATE TABLE IF NOT EXISTS playlists(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pl_tracks(pl INTEGER, pos INTEGER, track INTEGER, PRIMARY KEY(pl, pos));
CREATE TABLE IF NOT EXISTS likes(track INTEGER PRIMARY KEY, ts REAL);
CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY, track INTEGER, ts REAL);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
CREATE INDEX IF NOT EXISTS tr_album ON tracks(album, no);
CREATE INDEX IF NOT EXISTS h_track ON history(track);
"""
_ready = False
scan_state = {"running": False, "seen": 0, "error": ""}
_scan_lock = threading.Lock()


def db():
    global _ready
    DATA.mkdir(exist_ok=True)
    c = sqlite3.connect(DB, timeout=30)
    c.row_factory = sqlite3.Row
    if not _ready:
        c.executescript(SCHEMA)
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


def meta(p):
    import mutagen
    try:
        f = mutagen.File(p, easy=True)
    except Exception:
        f = None
    g = (lambda k: tag(f, k)) if f is not None else (lambda k: "")
    title, artist, album, genre = g("title") or p.stem, g("artist") or g("albumartist"), g("album"), g("genre")
    m = re.match(r"\d+", g("tracknumber"))
    dur = getattr(getattr(f, "info", None), "length", 0) or 0
    return title, artist, album, genre, int(m.group()) if m else 0, dur


def scan_body():
    try:
        if not ROOT.is_dir():
            scan_state["error"] = f"MUSIC_DIR not found: {ROOT}"
            return
        scan_state["error"] = ""
        c = db()
        known = {r["path"]: (r["mtime"], r["size"]) for r in c.execute("SELECT path, mtime, size FROM tracks")}
        found = set()
        for dp, _, names in os.walk(ROOT):
            for n in names:
                p = Path(dp, n)
                if p.suffix.lower() not in MIME:
                    continue
                rel, st = str(p.relative_to(ROOT)), p.stat()
                found.add(rel)
                scan_state["seen"] += 1
                if known.get(rel) == (st.st_mtime, st.st_size):
                    continue
                t = meta(p)
                s = " ".join((t[0], t[1], t[2], t[3])).lower()
                c.execute("""INSERT INTO tracks(path,title,artist,album,genre,no,dur,size,mtime,s) VALUES(?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(path) DO UPDATE SET title=excluded.title, artist=excluded.artist, album=excluded.album,
                    genre=excluded.genre, no=excluded.no, dur=excluded.dur, size=excluded.size, mtime=excluded.mtime, s=excluded.s""",
                          (rel, *t, st.st_size, st.st_mtime, s))
                if scan_state["seen"] % 200 == 0:
                    c.commit()
        c.executemany("DELETE FROM tracks WHERE path=?", [(r,) for r in known if r not in found])
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
        scan_state.update(running=True, seen=0)
    threading.Thread(target=scan_body, daemon=True).start()


@bp.post("/scan")
def scan():
    start_scan()
    return jsonify(ok=True), 202


@bp.get("/status")
def status():
    n = q("SELECT COUNT(*) n FROM tracks")[0][0]["n"]
    if not n and not scan_state["running"] and not scan_state["error"]:
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
    text = request.args.get("q", "")
    w, p = where(text)
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
def path_of(tid):
    r = q("SELECT path FROM tracks WHERE id=?", (tid,))[0]
    p = ROOT / r[0]["path"] if r else None
    if not p or not p.is_file():
        abort(404)
    return p


@bp.get("/file/<int:tid>")
def file(tid):
    p = path_of(tid)
    resp = send_file(p, mimetype=MIME.get(p.suffix.lower(), "application/octet-stream"), conditional=True, max_age=86400)
    resp.cache_control.private, resp.cache_control.public = True, False
    return resp


def cover(p):
    import mutagen
    from mutagen.flac import Picture
    try:
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
    for n in ("cover", "folder", "front"):                                  # a picture next to the files
        for e in (".jpg", ".jpeg", ".png"):
            if (p.parent / (n + e)).is_file():
                return (p.parent / (n + e)).read_bytes()
    return None


@bp.get("/art/<int:tid>")
def art(tid):
    f, none = ART / f"{tid}.jpg", ART / f"{tid}.none"
    if none.exists():
        abort(404)
    if not f.exists():
        ART.mkdir(parents=True, exist_ok=True)
        data = cover(path_of(tid))
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
    return request.get_json(silent=True) or {}


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
    name = str(b.get("name", "")).strip()[:100]
    if not name:
        abort(400)
    c = db()
    try:
        pid = c.execute("INSERT INTO playlists(name) VALUES(?)", (name,)).lastrowid
        append(c, pid, b.get("ids", []))
        c.commit()
    finally:
        c.close()
    return jsonify(id=pid)


@bp.patch("/playlists/<int:pid>")
def playlist_rename(pid):
    name = str(body().get("name", "")).strip()[:100]
    if not name:
        abort(400)
    q("UPDATE playlists SET name=? WHERE id=?", (name, pid))
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
    tid = int(body().get("id", 0))
    q("INSERT INTO history(track, ts) VALUES(?,?)", (tid, time.time()))
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
