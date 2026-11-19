"""Playing any video in a browser (pages/videos.*): what the player is told to do with a file, and the conversions behind it.
For every video, ffprobe decides (and remembers) one of two plans, depending on what the asking browser says it can decode:
  direct   the file is streamed as it is (mp4/m4v/mov with H.264 and AAC/MP3, webm with VP8/VP9, HEVC/AV1/AC3 if the browser can)
  hls      the file is converted once into an HLS stream (6 s MPEG-TS segments) kept in data/video-cache/<id>_<video>_<audio>/:
           video "copy" (H.264 8-bit already: only re-wrapped, fast) or "x264" (re-encoded to H.264, at most 1920 wide),
           audio "copy" (AAC/AC3 the browser can play) or "aac" (stereo AAC). The first segments can be played while ffmpeg is
           still working; a finished conversion is reused for ever (until the cache is over its limit).
Subtitles: text subtitles inside the file and .srt/.vtt files next to it (same folder, same start of name) are offered as WebVTT.
  GET  /api/videos/info/<id>?caps=hevc,vp9,av1,ac3,eac3[&force=1][&warm=1][&retry=1]
         -> {mode: "direct", src, duration, subs} or {mode: "hls", src, key, plan, state, seconds, duration, subs}
            force: the browser failed to play the original, convert it fully. warm: only start the conversion if the server is idle.
  GET  /api/videos/status/<key>       -> {state: running | done | error | none | busy, seconds, duration, speed, error}
  GET  /api/videos/hls/<key>/<file>   index.m3u8 and seg00000.ts ...
  GET  /api/videos/subs/<id>/<sub>    WebVTT (sub = x<stream number> inside the file, f<item id> next to it)
  GET  /api/videos/cache              -> {size, limit, running, ffmpeg}        POST /api/videos/cache/clear
Needs ffmpeg and ffprobe on the PATH. Settings (environment): VIDEO_CACHE_DIR, VIDEO_CACHE_GB (20), VIDEO_MAX_JOBS (2),
VIDEO_ENCODER (libx264; e.g. h264_nvenc or h264_vaapi for a graphics card), VIDEO_PRESET (veryfast)."""
import json
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

from flask import Response, abort, jsonify, request, send_file

from . import DATA, bp
from .errors import Fail
from .storage import BLOBS, conn as storage_conn
from .videos import HEX, _ext, _video

API = "/api/videos"
CACHE = Path(os.environ.get("VIDEO_CACHE_DIR") or DATA / "video-cache").resolve()
LIMIT = int(float(os.environ.get("VIDEO_CACHE_GB", "20")) * 1024 ** 3)
MAX_JOBS = max(1, int(os.environ.get("VIDEO_MAX_JOBS", "2")))
ENCODER = os.environ.get("VIDEO_ENCODER", "libx264")
PRESET = os.environ.get("VIDEO_PRESET", "veryfast")
SEGMENT = 6
KEY = re.compile(r"^([0-9a-f]{32})_(copy|x264)_(copy|aac)$")
FILE = re.compile(r"^(index\.m3u8|seg\d{5}\.ts)$")
CAPS = {"hevc", "vp9", "av1", "ac3", "eac3"}
NATIVE = {".mp4", ".m4v", ".mov", ".webm"}
H264_PROFILES = {"baseline", "constrained baseline", "main", "high"}
TEXT_SUBS = {"subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text", "subviewer"}

_lock = threading.RLock()
_slots = threading.BoundedSemaphore(2)                  # subtitle extractions at once
JOBS = {}                                               # key -> {state, seconds, speed, error, started, ended, proc, cancel}
PROBES = {}


def tools():
    ff, fp = shutil.which("ffmpeg"), shutil.which("ffprobe")
    return (ff, fp) if ff and fp else None


# ---------- looking at a file ----------
def probe(vid):
    if vid in PROBES:
        return PROBES[vid]
    cached = CACHE / "probe" / f"{vid}.json"
    try:
        PROBES[vid] = json.loads(cached.read_text())
        return PROBES[vid]
    except (OSError, ValueError):
        pass
    t = tools()
    if not t:
        raise Fail("This format needs ffmpeg and ffprobe installed on the server.")
    try:
        r = subprocess.run([t[1], "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(BLOBS / vid)],
                           capture_output=True, text=True, timeout=60)
        data = json.loads(r.stdout or "{}")
    except (subprocess.SubprocessError, ValueError, OSError):
        data = {}
    if not data.get("streams"):
        raise Fail("This file could not be read. It may be damaged or not a video.")
    PROBES[vid] = data
    try:
        cached.parent.mkdir(parents=True, exist_ok=True)
        cached.write_text(json.dumps(data))
    except OSError:
        pass
    return data


def _duration(d):
    try:
        return float((d.get("format") or {}).get("duration") or next((s.get("duration") for s in d["streams"] if s.get("duration")), 0))
    except (TypeError, ValueError):
        return 0.0


def plan(d, ext, caps, force):
    """What to do with this file for a browser that can decode `caps` (see the module text)."""
    streams = d.get("streams", [])
    vids = [s for s in streams if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")]
    if not vids:
        raise Fail("This file has no video.")
    v = vids[0]
    auds = [s for s in streams if s.get("codec_type") == "audio"]
    a = next((s for s in auds if (s.get("disposition") or {}).get("default")), auds[0] if auds else None)
    vc, ac = v.get("codec_name"), a.get("codec_name") if a else None
    h264 = vc == "h264" and v.get("pix_fmt") in ("yuv420p", "yuvj420p") and (v.get("profile") or "High").lower() in H264_PROFILES
    audio_ok = {"aac", "mp3"} | ({"ac3"} if "ac3" in caps else set()) | ({"eac3"} if "eac3" in caps else set())
    direct = False
    if not force:
        if ext in (".mp4", ".m4v", ".mov") and (ac is None or ac in audio_ok):
            direct = h264 or (vc == "hevc" and "hevc" in caps and v.get("codec_tag_string") == "hvc1") or (vc in ("vp9", "av1") and vc in caps)
        elif ext == ".webm" and (ac is None or ac in ("opus", "vorbis")):
            direct = vc == "vp8" or (vc in ("vp9", "av1") and vc in caps)
    out = {"duration": _duration(d), "v": v["index"], "a": a["index"] if a else None}
    if direct:
        return {**out, "mode": "direct"}
    vmode = "copy" if (h264 and not force) else "x264"
    stereo = int(a.get("channels") or 2) <= 2 if a else True
    amode = "copy" if a and ((ac == "aac" and stereo) or (ac in ("ac3", "eac3") and ac in audio_ok)) else "aac"
    return {**out, "mode": "hls", "vmode": vmode, "amode": amode}


def embedded_subs(d, vid):
    out = []
    for s in d.get("streams", []):
        if s.get("codec_type") == "subtitle" and s.get("codec_name") in TEXT_SUBS:
            tags = s.get("tags") or {}
            lang = (tags.get("language") or "").lower()
            lang = "" if lang == "und" else lang
            label = " – ".join(x for x in (lang.upper(), tags.get("title") or "") if x) or f"Track {len(out) + 1}"
            out.append({"id": f"x{s['index']}", "label": label, "lang": lang, "src": f"{API}/subs/{vid}/x{s['index']}"})
    return out


def sidecar_subs(vid, name):
    """.srt and .vtt files in the same folder whose name starts like the video's: Movie.srt, Movie.en.srt ..."""
    stem = os.path.splitext(name)[0].lower()
    out = []
    with storage_conn() as c:
        me = c.execute("SELECT parent FROM items WHERE id=?", (vid,)).fetchone()
        if not me:
            return out
        for r in c.execute("SELECT id, name FROM items WHERE parent=? AND is_dir=0 ORDER BY name", (me["parent"],)):
            ext = _ext(r["name"])
            if ext in (".srt", ".vtt") and r["name"].lower().startswith(stem):
                tag = r["name"][len(stem):-len(ext)].strip(" ._-")
                out.append({"id": "f" + r["id"], "label": tag or "Subtitles", "lang": tag.lower() if re.fullmatch(r"[A-Za-z]{2,3}", tag) else "",
                            "src": f"{API}/subs/{vid}/f{r['id']}"})
    return out


# ---------- the conversion ----------
def build_cmd(exe, src, out, pl):
    cmd = [exe, "-v", "error", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", "-fflags", "+genpts", "-i", str(src), "-map", f"0:{pl['v']}"]
    if pl["a"] is not None:
        cmd += ["-map", f"0:{pl['a']}"]
    cmd += ["-sn", "-dn", "-map_chapters", "-1", "-max_muxing_queue_size", "2048"]
    if pl["vmode"] == "copy":
        cmd += ["-c:v", "copy"]
    else:
        cmd += ["-c:v", ENCODER, "-pix_fmt", "yuv420p", "-vf", r"scale=min(1920\,iw):-2",
                "-force_key_frames", f"expr:gte(t,n_forced*{SEGMENT})"]
        cmd += ["-preset", PRESET, "-crf", "22", "-profile:v", "high", "-level", "4.2"] if ENCODER == "libx264" else ["-b:v", "6M"]
    if pl["a"] is not None:
        cmd += ["-c:a", "copy"] if pl["amode"] == "copy" else ["-c:a", "aac", "-b:a", "192k", "-ac", "2"]
    cmd += ["-f", "hls", "-hls_time", str(SEGMENT), "-hls_playlist_type", "event", "-hls_list_size", "0",
            "-hls_flags", "independent_segments+temp_file", "-hls_segment_filename", str(out / "seg%05d.ts"), str(out / "index.m3u8")]
    return cmd


def _nice():
    try:
        os.nice(8)                                   # the website stays quick while ffmpeg works
    except (AttributeError, OSError):
        pass


def _run(cmd, d, job):
    try:
        with open(d / "ffmpeg.log", "wb") as log:
            p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1, preexec_fn=_nice if hasattr(os, "nice") else None)
            job["proc"] = p
            for line in p.stdout:
                k, _, val = line.strip().partition("=")
                try:
                    if k in ("out_time_us", "out_time_ms"):
                        job["seconds"] = int(val) / 1e6
                    elif k == "speed":
                        job["speed"] = float(val.rstrip("x"))
                except ValueError:
                    pass
            rc = p.wait()
        if rc == 0 and (d / "index.m3u8").is_file():
            (d / "done").write_text("1")
            job["state"] = "done"
        else:
            tail = ""
            try:
                tail = (d / "ffmpeg.log").read_text(errors="replace").strip()[-300:]
            except OSError:
                pass
            job["error"] = "Cancelled." if job.get("cancel") else "The conversion failed. " + tail
            job["state"] = "error"
            shutil.rmtree(d, ignore_errors=True)
    except Exception as e:                           # never let a thread die silently: the page would wait for ever
        job["state"], job["error"] = "error", f"The conversion failed: {e}"
        shutil.rmtree(d, ignore_errors=True)
    finally:
        job["ended"], job["proc"] = time.time(), None


def _size(d):
    return sum(f.stat().st_size for f in d.rglob("*") if f.is_file())


def _evict():
    """Delete the least recently used finished conversions until the cache is under its limit (called with _lock held)."""
    if not CACHE.is_dir():
        return
    busy = {k for k, j in JOBS.items() if j["state"] == "running"}
    dirs = [d for d in CACHE.iterdir() if d.is_dir() and KEY.match(d.name)]
    sizes = {d: _size(d) for d in dirs}
    total = sum(sizes.values())
    for d in sorted(dirs, key=lambda x: x.stat().st_mtime):
        if total <= LIMIT * 0.9:
            break
        if d.name not in busy:
            total -= sizes[d]
            shutil.rmtree(d, ignore_errors=True)
            JOBS.pop(d.name, None)


def ensure(vid, pl, warm=False, retry=False):
    """Make sure the conversion for this plan is running or done. Returns (key, state)."""
    key = f"{vid}_{pl['vmode']}_{'copy' if pl['a'] is None else pl['amode']}"
    d = CACHE / key
    with _lock:
        if (d / "done").exists():
            os.utime(d, None)                        # recently used
            return key, "done"
        for k in [k for k, j in JOBS.items() if j["state"] != "running" and time.time() - j["ended"] > 3600]:
            JOBS.pop(k, None)
        job = JOBS.get(key)
        if job and job["state"] == "running":
            return key, "running"
        if job and job["state"] == "error" and not retry and time.time() - job["ended"] < 20:
            return key, "error"
        running = sum(1 for j in JOBS.values() if j["state"] == "running")
        if running >= (1 if warm else MAX_JOBS):
            return key, "none" if warm else "busy"
        t = tools()
        CACHE.mkdir(parents=True, exist_ok=True)
        if shutil.disk_usage(CACHE).free < 2 * 1024 ** 3:
            raise Fail("The server's disk is almost full: there is no room to convert this video.")
        shutil.rmtree(d, ignore_errors=True)         # whatever a stopped server left behind
        _evict()
        d.mkdir(parents=True)
        JOBS[key] = job = {"state": "running", "seconds": 0.0, "speed": 0.0, "error": "", "started": time.time(), "ended": 0, "proc": None}
        threading.Thread(target=_run, args=(build_cmd(t[0], BLOBS / vid, d, pl), d, job), daemon=True).start()
    return key, "running"


# ---------- routes ----------
def _caps():
    return set(filter(None, request.args.get("caps", "").split(","))) & CAPS


@bp.get("/videos/info/<vid>")
def videos_info(vid):
    path, _, name = _video(vid)
    ext = _ext(name)
    direct = {"mode": "direct", "src": f"{API}/file/{vid}", "duration": 0, "subs": []}
    try:
        d = probe(vid)
    except Fail:
        if ext in NATIVE and not request.args.get("force"):      # no ffprobe: mp4 and webm files are simply tried as they are
            return jsonify({**direct, "subs": sidecar_subs(vid, name)})
        raise
    pl = plan(d, ext, _caps(), request.args.get("force") == "1")
    subs = embedded_subs(d, vid) + sidecar_subs(vid, name)
    if pl["mode"] == "direct":
        return jsonify({**direct, "duration": pl["duration"], "subs": subs})
    key, state = ensure(vid, pl, warm=request.args.get("warm") == "1", retry=request.args.get("retry") == "1")
    job = JOBS.get(key) or {}
    return jsonify(mode="hls", src=f"{API}/hls/{key}/index.m3u8", key=key, state=state, seconds=pl["duration"] if state == "done" else job.get("seconds", 0),
                   plan="remux" if pl["vmode"] == "copy" else "transcode", duration=pl["duration"], subs=subs)


@bp.get("/videos/status/<key>")
def videos_status(key):
    m = KEY.match(key)
    if not m:
        abort(404, "No such conversion.")
    try:
        duration = _duration(probe(m.group(1)))
    except Fail:
        duration = 0
    with _lock:
        if (CACHE / key / "done").exists():
            out = {"state": "done", "seconds": duration, "speed": 0, "error": ""}
        elif key in JOBS:
            j = JOBS[key]
            out = {"state": j["state"], "seconds": j["seconds"], "speed": j["speed"], "error": j["error"]}
        else:
            out = {"state": "none", "seconds": 0, "speed": 0, "error": ""}
    resp = jsonify(duration=duration, **out)
    resp.headers["Cache-Control"] = "no-store"
    return resp


@bp.get("/videos/hls/<key>/<name>")
def videos_hls(key, name):
    if not KEY.match(key) or not FILE.match(name):
        abort(404)
    p = CACHE / key / name
    if not p.is_file():
        abort(404, "Not ready yet.")
    playlist = name.endswith(".m3u8")
    resp = send_file(p, mimetype="application/vnd.apple.mpegurl" if playlist else "video/mp2t", conditional=True, max_age=0)
    resp.headers["Cache-Control"] = "no-store" if playlist else "private, max-age=86400"
    return resp


def _srt_to_vtt(raw):
    for enc in ("utf-8-sig", "cp1250", "latin-1"):           # cp1250 covers Hungarian and other Central European files
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if text.lstrip().startswith("WEBVTT"):
        return text
    return "WEBVTT\n\n" + re.sub(r"(\d{2}:\d{2}:\d{2}),(\d{3})", r"\1.\2", text)


@bp.get("/videos/subs/<vid>/<sid>")
def videos_subs(vid, sid):
    path, _, name = _video(vid)
    m = re.fullmatch(r"x(\d{1,3})", sid)
    if m:
        out = CACHE / "subs" / f"{vid}_{m.group(1)}.vtt"
        if not out.is_file():
            t = tools()
            if not t:
                abort(404, "Needs ffmpeg.")
            out.parent.mkdir(parents=True, exist_ok=True)
            tmp = out.with_suffix(".tmp.vtt")
            with _slots:
                try:
                    subprocess.run([t[0], "-v", "error", "-nostdin", "-y", "-i", str(path), "-map", f"0:{m.group(1)}", "-f", "webvtt", str(tmp)],
                                   capture_output=True, timeout=180)
                except (subprocess.SubprocessError, OSError):
                    pass
            if not tmp.is_file():
                abort(404, "These subtitles could not be read.")
            os.replace(tmp, out)
        text = out.read_text(encoding="utf-8", errors="replace")
    else:
        m = re.fullmatch(r"f([0-9a-f]{32})", sid)
        if not m or not any(s["id"] == sid for s in sidecar_subs(vid, name)) or not (BLOBS / m.group(1)).is_file():
            abort(404, "No such subtitles.")
        raw = (BLOBS / m.group(1)).read_bytes()[:5 * 1024 * 1024]
        text = _srt_to_vtt(raw)
    return Response(text, mimetype="text/vtt", headers={"Cache-Control": "private, max-age=3600"})


@bp.get("/videos/cache")
def cache_info():
    with _lock:
        size = sum(_size(d) for d in CACHE.iterdir() if d.is_dir() and KEY.match(d.name)) if CACHE.is_dir() else 0
        running = sum(1 for j in JOBS.values() if j["state"] == "running")
    return jsonify(size=size, limit=LIMIT, running=running, ffmpeg=bool(tools()))


@bp.post("/videos/cache/clear")
def cache_clear():
    with _lock:
        for j in JOBS.values():
            if j["state"] == "running" and j.get("proc"):
                j["cancel"] = True
                j["proc"].terminate()
        if CACHE.is_dir():
            for d in CACHE.iterdir():
                if d.is_dir() and d.name != "probe":
                    shutil.rmtree(d, ignore_errors=True)
        JOBS.clear()
    return jsonify(ok=True)
