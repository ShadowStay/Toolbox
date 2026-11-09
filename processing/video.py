"""Video editor, mirroring pages/video-editor.js.
  POST /api/video/render  multipart: state (JSON) + file0, file1, ... -> the finished file
state: {width, height, fps, format, quality, tracks: [{type, muted, hidden, clips: [{file, type, start, in, dur, vol}]}]}
Tracks are listed top to bottom; upper video tracks are drawn over lower ones. Needs ffmpeg (4.4 or newer) and ffprobe on the PATH."""
import json
import re
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

from flask import request

from .errors import Fail, send_bytes
from . import bp

MAX_SIDE, MAX_SECONDS, MAX_CLIPS, MAX_TRACKS = 3840, 4 * 3600, 80, 40
RENDER_TIMEOUT = 3600
_slots = threading.BoundedSemaphore(2)          # at most two renders at once
QUALITIES = ("high", "medium", "low")


def number(value, lo, hi, what):
    try:
        x = float(value)
    except (TypeError, ValueError):
        raise Fail(f"The project has an invalid {what}.")
    if not (lo <= x <= hi):
        raise Fail(f"The project has an invalid {what}.")
    return x


def spec(q):
    """format -> (video codec args or None for audio-only, audio codec args, mime type)"""
    crf = {"high": 18, "medium": 23, "low": 28}[q]
    vp9 = {"high": 28, "medium": 33, "low": 38}[q]
    qv = {"high": "2", "medium": "5", "low": "9"}[q]
    ab = {"high": "256k", "medium": "192k", "low": "128k"}[q]
    h264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf), "-pix_fmt", "yuv420p"]
    aac = ["-c:a", "aac", "-b:a", ab]
    return {
        "mp4": (h264 + ["-movflags", "+faststart"], aac, "video/mp4"),
        "mov": (h264, aac, "video/quicktime"),
        "mkv": (h264, aac, "video/x-matroska"),
        "webm": (["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", str(vp9), "-deadline", "realtime", "-cpu-used", "5", "-row-mt", "1", "-pix_fmt", "yuv420p"],
                 ["-c:a", "libopus", "-b:a", ab], "video/webm"),
        "avi": (["-c:v", "mpeg4", "-q:v", qv], ["-c:a", "libmp3lame", "-b:a", ab], "video/x-msvideo"),
        "gif": ([], [], "image/gif"),
        "mp3": (None, ["-c:a", "libmp3lame", "-b:a", ab], "audio/mpeg"),
        "wav": (None, ["-c:a", "pcm_s16le"], "audio/wav"),
        "m4a": (None, aac, "audio/mp4"),
        "ogg": (None, ["-c:a", "libvorbis", "-b:a", ab], "audio/ogg"),
        "flac": (None, ["-c:a", "flac"], "audio/flac"),
    }


def render_project(state, tmp, exe, probe):
    fmt = state.get("format")
    q = state.get("quality") if state.get("quality") in QUALITIES else "medium"
    table = spec(q)
    if fmt not in table:
        raise Fail("Unknown export format.")
    vargs, aargs, mime = table[fmt]
    with_video = vargs is not None
    W = int(number(state.get("width"), 16, MAX_SIDE, "width")) // 2 * 2
    H = int(number(state.get("height"), 16, MAX_SIDE, "height")) // 2 * 2
    fps = int(number(state.get("fps"), 1, 60, "frame rate"))
    tracks = state.get("tracks")
    if not isinstance(tracks, list):
        raise Fail("The request was not understood.")

    saved = {}
    for key, fs in request.files.items():
        if key.startswith("file") and key[4:].isdigit():
            ext = re.sub(r"[^A-Za-z0-9]", "", Path(fs.filename or "").suffix)[:8]
            path = tmp / (f"in{key[4:]}" + (f".{ext}" if ext else ""))
            fs.save(path)
            saved[int(key[4:])] = path

    audio_cache = {}

    def has_audio(path):
        if path not in audio_cache:
            try:
                r = subprocess.run([probe, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", str(path)],
                                   capture_output=True, text=True, timeout=60)
                audio_cache[path] = bool(r.stdout.strip())
            except subprocess.SubprocessError:
                audio_cache[path] = False
        return audio_cache[path]

    inputs, fc, aparts = [], [], []
    cur, n_in, count, total = "base", 0, 0, 0.0
    for tr in reversed(tracks[:MAX_TRACKS]):                    # bottom track first, so upper tracks end up on top
        if not isinstance(tr, dict):
            continue
        for c in tr.get("clips") or []:
            ctype = c.get("type")
            if ctype not in ("video", "audio", "image"):
                continue
            count += 1
            if count > MAX_CLIPS:
                raise Fail(f"That project has more than {MAX_CLIPS} clips.")
            path = saved.get(int(number(c.get("file"), 0, 1000, "file reference")))
            if not path:
                raise Fail("A file is missing from the upload.")
            start = number(c.get("start"), 0, MAX_SECONDS, "clip start")
            src_in = number(c.get("in", 0), 0, MAX_SECONDS, "clip source start")
            dur = number(c.get("dur"), 0.05, MAX_SECONDS, "clip length")
            vol = number(c.get("vol", 1), 0, 4, "volume")
            visual = with_video and ctype in ("video", "image") and not tr.get("hidden")
            audible = ctype in ("video", "audio") and not tr.get("muted") and vol > 0 and has_audio(path)
            if not (visual or audible):
                continue
            if ctype == "image":
                inputs += ["-loop", "1", "-framerate", str(fps), "-t", f"{dur:.3f}", "-i", str(path)]
            else:
                inputs += ["-ss", f"{src_in:.3f}", "-t", f"{dur:.3f}", "-i", str(path)]
            n, n_in = n_in, n_in + 1
            total = max(total, start + dur)
            if visual:
                pre = "format=yuva420p," if ctype == "image" else ""
                fc.append(f"[{n}:v]fps={fps},scale={W}:{H}:force_original_aspect_ratio=decrease,setsar=1,{pre}"
                          f"setpts=PTS-STARTPTS+{start:.3f}/TB[v{n}]")
                fc.append(f"[{cur}][v{n}]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=pass:"
                          f"enable='between(t,{start:.3f},{start + dur:.3f})'[c{n}]")
                cur = f"c{n}"
            if audible:
                ms = int(round(start * 1000))
                fc.append(f"[{n}:a:0]aformat=sample_rates=44100:channel_layouts=stereo,volume={vol:.3f},adelay={ms}|{ms}[a{n}]")
                aparts.append(f"[a{n}]")

    if not total:
        raise Fail("The timeline is empty, or everything on it is muted or hidden.")
    total = min(total, MAX_SECONDS)
    if not with_video and not aparts:
        raise Fail("There is no audio to export. Add an audio clip or a video with sound.")

    use_audio = bool(aparts) and fmt != "gif"
    if with_video:
        fc.insert(0, f"color=c=black:s={W}x{H}:r={fps}:d={total:.3f}[base]")
        if fmt == "gif":
            fc.append(f"[{cur}]fps=15,scale={min(W, 480)}:-2:flags=lanczos,split[g0][g1];[g0]palettegen[gp];[g1][gp]paletteuse[vout]")
        else:
            fc.append(f"[{cur}]format=yuv420p[vout]")
    if use_audio:
        if len(aparts) == 1:
            fc.append(f"{aparts[0]}anull[aout]")
        else:
            fc.append("".join(aparts) + f"amix=inputs={len(aparts)}:normalize=0:duration=longest[aout]")

    out = tmp / f"out.{fmt}"
    cmd = [exe, "-y", "-v", "error", "-nostdin", *inputs, "-filter_complex", ";".join(fc)]
    if with_video:
        cmd += ["-map", "[vout]"]
    if use_audio:
        cmd += ["-map", "[aout]"]
    elif with_video:
        cmd += ["-an"]
    cmd += (vargs or []) + (aargs if use_audio else []) + ["-t", f"{total:.3f}", str(out)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=RENDER_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise Fail("The render took too long and was stopped.")
    if r.returncode != 0 or not out.is_file():
        tail = " ".join((r.stderr or "").strip().splitlines()[-3:])
        raise Fail("ffmpeg could not render this project: " + tail[:300])
    return out.read_bytes(), mime


@bp.post("/video/render")
def render_video():
    exe, probe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not (exe and probe):
        raise Fail("Video export on the server needs ffmpeg installed. Install it, or switch to browser processing in Options.")
    try:
        state = json.loads(request.form.get("state", "{}"))
    except ValueError:
        raise Fail("The request was not understood.")
    if not isinstance(state, dict):
        raise Fail("The request was not understood.")
    if not _slots.acquire(timeout=30):
        raise Fail("The server is busy rendering other videos. Try again in a moment.")
    try:
        with tempfile.TemporaryDirectory(prefix="spells-video-") as tmp:
            data, mime = render_project(state, Path(tmp), exe, probe)
        return send_bytes(data, mime)
    finally:
        _slots.release()
