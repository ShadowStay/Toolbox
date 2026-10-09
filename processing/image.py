"""Image tools, mirroring pages/image-tools.js and the image part of the file viewer.
  POST /api/image/render  multipart: state (JSON) + file0, file1, ... -> image bytes (or a .zip when state.split is set)
  POST /api/image/decode  multipart: file -> PNG, for formats the browser cannot show (TIFF, HEIC, ...)
Other modules use load(), encode() and FORMATS."""
import io
import json
import math
import zipfile

import numpy as np
from flask import request
from PIL import Image, ImageColor, ImageFilter, ImageOps

from .core import Fail, bp, send_bytes

Image.MAX_IMAGE_PIXELS = 200_000_000
MAX_PIXELS, MAX_SIDE = 50_000_000, 16384

try:                                     # optional: lets the server read HEIC photos
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    pass

FORMATS = {                              # id -> (Pillow name, mime type, extension)
    "png": ("PNG", "image/png", "png"),
    "jpeg": ("JPEG", "image/jpeg", "jpg"),
    "webp": ("WEBP", "image/webp", "webp"),
    "avif": ("AVIF", "image/avif", "avif"),
}


def check_size(w, h):
    w, h = int(round(w)), int(round(h))
    if not (w > 0 and h > 0):
        raise Fail("Width and height must be positive numbers.")
    if w * h > MAX_PIXELS or max(w, h) > MAX_SIDE:
        raise Fail("That is bigger than the server will handle (16,384 px per side, 50 megapixels).")
    return w, h


def load(src):
    """Open any image Pillow understands as RGBA, with the camera rotation applied (like the browser does)."""
    try:
        im = Image.open(src)
        im = ImageOps.exif_transpose(im)
        im.load()
    except Exception:
        raise Fail("The server can't read that image.")
    return im.convert("RGBA")


def encode(im, fmt, quality=90, bg="#ffffff"):
    if fmt not in FORMATS:
        raise Fail("Unknown image format.")
    name, mime, _ = FORMATS[fmt]
    if fmt == "jpeg":
        flat = Image.new("RGB", im.size, ImageColor.getrgb(bg))
        flat.paste(im, mask=im.getchannel("A"))
        im = flat
    buf = io.BytesIO()
    try:
        im.save(buf, name, quality=int(max(1, min(100, quality))))
    except (KeyError, OSError, ValueError):
        raise Fail(f"The server can't save {fmt.upper()} files. Pick another format.")
    return buf.getvalue(), mime


# ---------- CSS-style filters (same order and meaning as the sliders in the page) ----------
def _matrix(rgb, m):
    return np.clip(rgb @ np.array(m, dtype=np.float32).T, 0, 1)


def apply_filters(im, f):
    f = f or {}
    steps = [(k, float(f.get(k, d))) for k, d in
             (("brightness", 100), ("contrast", 100), ("saturate", 100), ("hue-rotate", 0), ("blur", 0),
              ("grayscale", 0), ("sepia", 0), ("invert", 0))]
    if all(v == d for (_, v), d in zip(steps, (100, 100, 100, 0, 0, 0, 0, 0))):
        return im
    for k, v in steps:
        if k == "blur":
            if v > 0: im = im.filter(ImageFilter.GaussianBlur(v))
            continue
        a = np.asarray(im, dtype=np.float32) / 255
        rgb, alpha = a[..., :3], a[..., 3:]
        if k == "brightness": rgb = np.clip(rgb * (v / 100), 0, 1)
        elif k == "contrast": rgb = np.clip((rgb - .5) * (v / 100) + .5, 0, 1)
        elif k == "saturate":
            s = v / 100
            rgb = _matrix(rgb, [[.213 + .787 * s, .715 - .715 * s, .072 - .072 * s],
                                [.213 - .213 * s, .715 + .285 * s, .072 - .072 * s],
                                [.213 - .213 * s, .715 - .715 * s, .072 + .928 * s]])
        elif k == "hue-rotate":
            c, sn = math.cos(math.radians(v)), math.sin(math.radians(v))
            rgb = _matrix(rgb, [[.213 + c * .787 - sn * .213, .715 - c * .715 - sn * .715, .072 - c * .072 + sn * .928],
                                [.213 - c * .213 + sn * .143, .715 + c * .285 + sn * .140, .072 - c * .072 - sn * .283],
                                [.213 - c * .213 - sn * .787, .715 - c * .715 + sn * .715, .072 + c * .928 + sn * .072]])
        elif k == "grayscale":
            i = 1 - min(1, v / 100)
            rgb = _matrix(rgb, [[.2126 + .7874 * i, .7152 - .7152 * i, .0722 - .0722 * i],
                                [.2126 - .2126 * i, .7152 + .2848 * i, .0722 - .0722 * i],
                                [.2126 - .2126 * i, .7152 - .7152 * i, .0722 + .9278 * i]])
        elif k == "sepia":
            i = 1 - min(1, v / 100)
            rgb = _matrix(rgb, [[.393 + .607 * i, .769 - .769 * i, .189 - .189 * i],
                                [.349 - .349 * i, .686 + .314 * i, .168 - .168 * i],
                                [.272 - .272 * i, .534 - .534 * i, .131 + .869 * i]])
        elif k == "invert":
            t = min(1, v / 100)
            rgb = rgb * (1 - 2 * t) + t
        if v != {"brightness": 100, "contrast": 100, "saturate": 100}.get(k, 0):
            im = Image.fromarray((np.concatenate([rgb, alpha], axis=2) * 255 + .5).astype(np.uint8), "RGBA")
    return im


def render_layers(state, sources):
    """Compose the artboard exactly as the page's canvas does: crop, scale, flip, filter, rotate, then draw."""
    art = state.get("art") or {}
    w, h = check_size(art.get("w", 0), art.get("h", 0))
    base = (0, 0, 0, 0) if art.get("transp") else ImageColor.getrgb(art.get("bg", "#ffffff")) + (255,)
    canvas = Image.new("RGBA", (w, h), base)
    cache = {}
    for L in state.get("layers", []):
        key = L.get("file")
        if key not in sources:
            raise Fail("An image is missing from the upload.")
        if key not in cache:
            cache[key] = load(sources[key])
        src = cache[key]
        sx, sy = max(0, round(L["sx"])), max(0, round(L["sy"]))
        sw, sh = max(1, round(L["sw"])), max(1, round(L["sh"]))
        part = src.crop((sx, sy, min(src.width, sx + sw), min(src.height, sy + sh)))
        lw, lh = check_size(L["w"], L["h"])
        part = part.resize((lw, lh), Image.LANCZOS)
        if L.get("fx"): part = ImageOps.mirror(part)
        if L.get("fy"): part = ImageOps.flip(part)
        part = apply_filters(part, L.get("f"))
        deg = math.degrees(L.get("rot", 0)) % 360
        if deg: part = part.rotate(-deg, expand=True, resample=Image.BICUBIC)
        layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        layer.paste(part, (round(L["cx"] - part.width / 2), round(L["cy"] - part.height / 2)))
        canvas = Image.alpha_composite(canvas, layer)
    return canvas


@bp.post("/image/render")
def render():
    try:
        state = json.loads(request.form.get("state", "{}"))
    except ValueError:
        raise Fail("The request was not understood.")
    sources = {i: request.files[k] for i, k in ((int(k[4:]), k) for k in request.files if k.startswith("file") and k[4:].isdigit())}
    canvas = render_layers(state, sources)
    fmt, q, bg = state.get("format", "png"), state.get("quality", 90), state.get("bg", "#ffffff")
    split = state.get("split")
    if not split:
        data, mime = encode(canvas, fmt, q, bg)
        return send_bytes(data, mime)
    rows, cols = max(1, int(split.get("rows", 1))), max(1, int(split.get("cols", 1)))
    if rows * cols < 2: raise Fail("Choose at least 2 pieces.")
    if rows * cols > 100: raise Fail("That would make more than 100 pieces.")
    w, h = canvas.size
    ext, name, n = FORMATS[fmt][2], state.get("name") or "image", 0
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        for r in range(rows):
            for c in range(cols):
                box = (round(c * w / cols), round(r * h / rows), round((c + 1) * w / cols), round((r + 1) * h / rows))
                n += 1
                z.writestr(f"{name}-{n}.{ext}", encode(canvas.crop(box), fmt, q, bg)[0])
    return send_bytes(buf.getvalue(), "application/zip")


@bp.post("/image/decode")
def decode():
    fs = request.files.get("file")
    if not fs: raise Fail("No file received.")
    im = load(fs.stream)
    check_size(*im.size)
    return send_bytes(encode(im, "png")[0], "image/png")
