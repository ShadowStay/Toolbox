"""Printing page: upload files, lay them out on sheets of paper, preview the result and hand it to CUPS. CUPS runs in the "cups"
docker container (ydkn/cups) and is reached over IPP on CUPS_URL (default http://localhost:631), see ipp.py.

A file is first converted to PDF and kept for an hour (POST /api/print/prepare). The layout (paper, scaling, placement,
rotation, margins, pages per sheet, page range) is applied by layout(), and the very same function makes the preview image and the
PDF that is sent to the printer, so what you see is what is printed (CUPS is told not to scale it again).
  GET  /api/print/printers            -> {printers: [{name, info, state, reasons, accepting, default}], office: bool}
  POST /api/print/prepare             multipart: file -> {id, name, kind: "image" | "doc", pages}
  POST /api/print/preview             {id, options, sheet} -> {sheets, sheet, image (data URL), info}
  POST /api/print/submit              {id, printer?, copies?, options} -> {job, name, sheets, printer}
  GET  /api/print/jobs?printer=       -> {jobs: [{id, name, state, user, created}]}
  POST /api/print/jobs/<id>/cancel    {printer?}
options: {paper: a4|letter|a5|legal, orient: auto|portrait|landscape, scale: auto|shrink|fit|fill|actual|custom, zoom: percent,
          place: tl|tc|tr|ml|c|mr|bl|bc|br, rotate: 0|90|180|270 (clockwise), margin: mm or "" for automatic, nup: 1|2|4, pages: "1-3,5"}
scale auto = images are never enlarged (shrunk only when they do not fit), documents are fitted to the page (one page = one sheet).
margin empty = automatic: 5 mm for pictures, none for documents (they have their own margins).
Environment: CUPS_URL, CUPS_PRINTER (default printer name), CUPS_USER / CUPS_PASSWORD (only if CUPS asks for a login).
Printing needs the printer to be added in CUPS first (http://<server>:631 -> Administration -> Add Printer)."""
import atexit
import base64
import io
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import quote

import pymupdf
from flask import jsonify, request
from PIL import Image

from . import bp, ipp
from . import image as imaging
from .errors import Fail
from .files import text_pdf_pages

CUPS = os.environ.get("CUPS_URL", "http://localhost:631").rstrip("/")
USER, PASSWORD = os.environ.get("CUPS_USER", ""), os.environ.get("CUPS_PASSWORD", "")
MAX_BYTES, MAX_COPIES, TTL, MAX_ITEMS = 50 * 1024 * 1024, 99, 60 * 60, 40
IMAGES = {"png", "jpg", "jpeg", "jpe", "jfif", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif"}
TEXT = {"txt", "log", "md", "csv", "tsv", "json", "xml", "ini", "yml", "yaml", "py", "js", "css", "html", "htm", "c", "cpp", "h", "java", "sh", "sql"}
OFFICE = {"docx", "doc", "odt", "rtf", "xlsx", "xls", "ods", "pptx", "ppt", "odp"}
PRINTER_ATTRS = ("printer-name", "printer-info", "printer-state", "printer-state-reasons", "printer-is-accepting-jobs")
JOB_ATTRS = ("job-id", "job-name", "job-state", "job-originating-user-name", "time-at-creation")
JOB_STATE = {3: "waiting", 4: "held", 5: "printing", 6: "stopped", 7: "cancelled", 8: "failed", 9: "done"}
PRINTER_STATE = {3: "idle", 4: "printing", 5: "stopped"}

# ---------- layout settings ----------
PAPER = {"a4": (595.276, 841.89, "iso_a4_210x297mm", "A4"), "letter": (612, 792, "na_letter_8.5x11in", "Letter"),
         "a5": (419.528, 595.276, "iso_a5_148x210mm", "A5"), "legal": (612, 1008, "na_legal_8.5x14in", "Legal")}
NUP = {1: (1, 1), 2: (2, 1), 4: (2, 2)}                               # pages per sheet -> (columns, rows)
ANCHOR = {"tl": (0, 0), "tc": (.5, 0), "tr": (1, 0), "ml": (0, .5), "c": (.5, .5), "mr": (1, .5), "bl": (0, 1), "bc": (.5, 1), "br": (1, 1)}
DEFAULTS = {"paper": "a4", "orient": "auto", "scale": "auto", "zoom": 100.0, "place": "c", "rotate": 0, "margin": None, "nup": 1, "pages": ""}


def clean_options(d):
    d = d if isinstance(d, dict) else {}
    pick = lambda k, allowed: d.get(k) if d.get(k) in allowed else DEFAULTS[k]

    def num(k, lo, hi):
        try:
            return min(hi, max(lo, float(d.get(k, DEFAULTS[k]))))
        except (TypeError, ValueError):
            return DEFAULTS[k]                                              # (a margin that is empty or "auto" stays None)
    try:
        nup = int(d.get("nup", 1))
    except (TypeError, ValueError):
        nup = 1
    try:
        rot = int(d.get("rotate", 0)) % 360
    except (TypeError, ValueError):
        rot = 0
    return {"paper": pick("paper", PAPER), "orient": pick("orient", ("auto", "portrait", "landscape")),
            "scale": pick("scale", ("auto", "shrink", "fit", "fill", "actual", "custom")), "zoom": num("zoom", 10, 500),
            "place": pick("place", ANCHOR), "rotate": rot if rot in (0, 90, 180, 270) else 0, "margin": num("margin", 0, 50) if d.get("margin") not in (None, "", "auto") else None,
            "nup": nup if nup in NUP else 1, "pages": str(d.get("pages") or "")[:200]}


def parse_pages(text, total):
    """"1-3, 5, 8-" -> [1, 2, 3, 5, 8, ..., total]; empty = every page."""
    pages = []
    for part in (text or "").replace(" ", "").split(","):
        if not part:
            continue
        m = re.fullmatch(r"(\d+)(?:-(\d*))?", part)
        if not m:
            raise Fail("Pages must look like 1-3,5.")
        lo = int(m.group(1))
        hi = lo if m.group(2) is None else int(m.group(2) or total)
        if not (1 <= lo <= hi <= total):
            raise Fail(f"The page range {part} does not fit: the document has {total} page{'' if total == 1 else 's'}.")
        pages += range(lo, hi + 1)
    return pages or list(range(1, total + 1))


def layout(pdf, kind, o, only=None):
    """The PDF to print: the pages of `pdf` placed on sheets as `o` says. only=k makes just sheet k (for the preview).
    -> (PDF bytes, number of sheets, [scale of each page on the sheets made, in percent])."""
    src = pymupdf.open(stream=pdf, filetype="pdf")
    pages = parse_pages(o["pages"], src.page_count)
    n = o["nup"]
    cols, rows = NUP[n]
    chunks = [pages[i:i + n] for i in range(0, len(pages), n)]
    mode = o["scale"] if o["scale"] != "auto" else ("shrink" if kind == "image" else "fit")
    ax, ay = ANCHOR[o["place"]]
    margin = (o["margin"] if o["margin"] is not None else (5 if kind == "image" else 0)) * 72 / 25.4   # auto: pictures keep 5 mm clear, documents bring their own margins
    out, scales = pymupdf.open(), []

    info = {}                                                              # page number -> (unrotated width, height, the page's own rotation)
    for pn in set(pages):
        pg = src[pn - 1]
        own = pg.rotation
        pg.set_rotation(0)                                                 # show_pdf_page ignores /Rotate, so it is added to ours
        info[pn] = (pg.rect.width, pg.rect.height, own)

    def turn(pn):                                                          # total clockwise turn of the page, and its size after it
        w, h, own = info[pn]
        deg = (o["rotate"] + own) % 360
        return (deg, h, w) if deg in (90, 270) else (deg, w, h)

    for si in ([only] if only is not None else range(len(chunks))):
        chunk = chunks[si]
        orient = o["orient"]
        if orient == "auto":
            first = turn(chunk[0])
            orient = "landscape" if (first[1] > first[2] if n == 1 else n == 2) else "portrait"
        pw, ph = PAPER[o["paper"]][:2]
        W, H = (max(pw, ph), min(pw, ph)) if orient == "landscape" else (min(pw, ph), max(pw, ph))
        sheet = out.new_page(width=W, height=H)
        area = pymupdf.Rect(margin, margin, W - margin, H - margin)
        for k, pn in enumerate(chunk):
            cx, cy = k % cols, k // cols
            pad = 0 if n == 1 else 4
            cell = pymupdf.Rect(area.x0 + cx * area.width / cols + pad, area.y0 + cy * area.height / rows + pad,
                                area.x0 + (cx + 1) * area.width / cols - pad, area.y0 + (cy + 1) * area.height / rows - pad)
            deg, cw, ch = turn(pn)
            fit = min(cell.width / cw, cell.height / ch)
            s = {"fit": fit, "shrink": min(1, fit), "fill": max(cell.width / cw, cell.height / ch), "actual": 1, "custom": o["zoom"] / 100}[mode]
            dw, dh = cw * s, ch * s
            x, y = cell.x0 + (cell.width - dw) * ax, cell.y0 + (cell.height - dh) * ay
            ccw = (360 - deg) % 360                                        # pymupdf turns counter-clockwise
            if dw > cell.width + .5 or dh > cell.height + .5:              # bigger than its cell: crop it through a page of the cell's size
                tmp = pymupdf.open()
                tp = tmp.new_page(width=cell.width, height=cell.height)
                tp.show_pdf_page(pymupdf.Rect(x - cell.x0, y - cell.y0, x - cell.x0 + dw, y - cell.y0 + dh), src, pn - 1, rotate=ccw)
                sheet.show_pdf_page(cell, tmp, 0)
            else:
                sheet.show_pdf_page(pymupdf.Rect(x, y, x + dw, y + dh), src, pn - 1, rotate=ccw)
            scales.append(round(s * 100))
    return out.tobytes(), len(chunks), scales


# ---------- the converted files, kept for an hour ----------
ROOT = Path(tempfile.mkdtemp(prefix="spells-print-"))
atexit.register(shutil.rmtree, ROOT, ignore_errors=True)
_store, _lock = {}, threading.Lock()
HEX = re.compile(r"^[0-9a-f]{32}$")


def purge():
    now = time.time()
    with _lock:
        old = [k for k, e in _store.items() if now - e["ts"] > TTL]
        old += sorted(_store, key=lambda k: _store[k]["ts"])[: max(0, len(_store) - MAX_ITEMS + 1)]
        for k in set(old):
            _store.pop(k, None)
            (ROOT / f"{k}.pdf").unlink(missing_ok=True)


def get(pid):
    with _lock:
        e = _store.get(pid) if isinstance(pid, str) and HEX.match(pid) else None
        if e:
            e["ts"] = time.time()
    if not e:
        raise Fail("This file is no longer on the server. Add it again.")
    return e, (ROOT / f"{pid}.pdf").read_bytes()


# ---------- converting to PDF ----------
def office_pdf(data, ext):
    exe = shutil.which("soffice") or shutil.which("libreoffice")
    if not exe:
        raise Fail("Word, Excel and PowerPoint files need LibreOffice on the server (sudo apt install libreoffice-writer libreoffice-calc libreoffice-impress). Save the file as PDF and upload that instead.")
    with tempfile.TemporaryDirectory(prefix="spells-office-") as d:
        src = Path(d) / f"input.{ext}"
        src.write_bytes(data)
        try:
            subprocess.run([exe, f"-env:UserInstallation=file://{d}/profile", "--headless", "--convert-to", "pdf", "--outdir", d, str(src)],
                           check=True, timeout=180, capture_output=True)
            return next(Path(d).glob("*.pdf")).read_bytes()
        except subprocess.TimeoutExpired:
            raise Fail("LibreOffice took too long to convert that file.")
        except (subprocess.SubprocessError, StopIteration):
            raise Fail("LibreOffice could not convert that file.")


def image_pdf(data):
    """One page the size of the picture on paper (its own resolution, 96 dpi when it has none), so "do not enlarge" means something."""
    try:
        dpi = Image.open(io.BytesIO(data)).info.get("dpi") or (96, 96)
        dpi = float(dpi[0]) if dpi[0] and float(dpi[0]) >= 10 else 96.0
    except Exception:
        dpi = 96.0
    im = imaging.load(io.BytesIO(data))
    imaging.check_size(*im.size)
    k = min(72 / dpi, 14000 / max(im.size))
    out = pymupdf.open()
    page = out.new_page(width=im.width * k, height=im.height * k)
    opaque = im.getextrema()[3][0] == 255
    page.insert_image(page.rect, stream=imaging.encode(im, "jpeg", 92)[0] if opaque else imaging.encode(im, "png")[0])
    return out.tobytes()


def text_to_pdf(data):
    text = None
    for enc in ("utf-8-sig", "cp1252"):
        try:
            text = data.decode(enc)
            break
        except UnicodeDecodeError:
            pass
    out = pymupdf.open()
    text_pdf_pages(out, text if text is not None else data.decode("latin-1"))
    return out.tobytes()


def to_pdf(name, data):
    """-> (PDF bytes, "image" | "doc")"""
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext == "pdf" or data[:5] == b"%PDF-":
        return data, "doc"
    if ext in IMAGES:
        return image_pdf(data), "image"
    if ext in TEXT:
        return text_to_pdf(data), "doc"
    if ext in OFFICE:
        return office_pdf(data, ext), "doc"
    raise Fail(f"Files of type .{ext or '?'} can't be printed here. Use PDF, images, text or Office files.")


def check_pdf(pdf):
    try:
        doc = pymupdf.open(stream=pdf, filetype="pdf")
    except Exception:
        raise Fail("That file could not be read as a document. It may be damaged.")
    if doc.needs_pass:
        raise Fail("That PDF is password protected. Remove the password and upload it again.")
    n = doc.page_count
    doc.close()
    if not n:
        raise Fail("That document has no pages.")
    return n


# ---------- CUPS ----------
def _ipp(path, payload):
    try:
        return ipp.send(CUPS + path, payload, USER, PASSWORD)
    except ipp.IppError as e:
        raise Fail(str(e))


def printers():
    payload = ipp.request(ipp.CUPS_GET_PRINTERS, ipp.keyword("requested-attributes", *PRINTER_ATTRS))
    default = os.environ.get("CUPS_PRINTER", "")
    out = []
    for tag, a in _ipp("/", payload)[1]:
        if tag != 0x04 or "printer-name" not in a:
            continue
        reasons = [r for r in a.get("printer-state-reasons", []) if r != "none"]
        out.append({"name": a["printer-name"][0], "info": (a.get("printer-info") or [""])[0],
                    "state": PRINTER_STATE.get((a.get("printer-state") or [0])[0], "unknown"),
                    "reasons": reasons, "accepting": bool((a.get("printer-is-accepting-jobs") or [True])[0])})
    out.sort(key=lambda p: p["name"].casefold())
    for p in out:
        p["default"] = p["name"] == default
    if out and not any(p["default"] for p in out):
        out[0]["default"] = True
    return out


def pick(name):
    found = printers()
    if not found:
        raise Fail("No printer is set up in CUPS yet. Add the printer at port 631 of the server first.")
    if name:
        for p in found:
            if p["name"] == name:
                return p
        raise Fail("That printer does not exist.")
    return next(p for p in found if p["default"])


printer_uri = lambda p: "ipp://localhost/printers/" + quote(p["name"])
path_of = lambda p: "/printers/" + quote(p["name"])


# ---------- routes ----------
@bp.get("/print/printers")
def print_printers():
    return jsonify(printers=printers(), office=bool(shutil.which("soffice") or shutil.which("libreoffice")))


@bp.post("/print/prepare")
def print_prepare():
    fs = request.files.get("file")
    if not fs:
        raise Fail("No file received.")
    data = fs.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise Fail("That file is too large to print (50 MB at most).")
    if not data:
        raise Fail("That file is empty.")
    name = re.sub(r"[\x00-\x1f\x7f]", "", fs.filename or "document").strip() or "document"
    pdf, kind = to_pdf(name, data)
    pages = check_pdf(pdf)
    purge()
    pid = uuid.uuid4().hex
    (ROOT / f"{pid}.pdf").write_bytes(pdf)
    with _lock:
        _store[pid] = {"name": name, "kind": kind, "pages": pages, "ts": time.time()}
    return jsonify(id=pid, name=name, kind=kind, pages=pages)


@bp.post("/print/preview")
def print_preview():
    d = request.get_json(silent=True) or {}
    entry, pdf = get(d.get("id"))
    o = clean_options(d.get("options"))
    chunks = -(-len(parse_pages(o["pages"], entry["pages"])) // o["nup"])
    try:
        sheet = max(0, min(chunks - 1, int(d.get("sheet", 0))))
    except (TypeError, ValueError):
        sheet = 0
    made, _, scales = layout(pdf, entry["kind"], o, only=sheet)
    doc = pymupdf.open(stream=made, filetype="pdf")
    png = doc[0].get_pixmap(dpi=110, alpha=False).tobytes("png")
    w, h = doc[0].rect.width, doc[0].rect.height
    lo, hi = min(scales), max(scales)
    info = f"{PAPER[o['paper']][3]} {'landscape' if w > h else 'portrait'}, " + (f"printed at {lo}%" if lo == hi else f"printed at {lo}% to {hi}%")
    return jsonify(sheets=chunks, sheet=sheet, image="data:image/png;base64," + base64.b64encode(png).decode(), info=info)


@bp.post("/print/submit")
def print_submit():
    d = request.get_json(silent=True) or {}
    entry, pdf = get(d.get("id"))
    try:
        copies = int(d.get("copies") or 1)
    except (TypeError, ValueError):
        raise Fail("Copies must be a number.")
    if not 1 <= copies <= MAX_COPIES:
        raise Fail(f"Copies must be between 1 and {MAX_COPIES}.")
    printer = pick(str(d.get("printer") or ""))
    if printer["state"] == "stopped" or not printer["accepting"]:
        raise Fail(f"The printer “{printer['name']}” is not accepting jobs right now.")
    o = clean_options(d.get("options"))
    made, sheets, _ = layout(pdf, entry["kind"], o)
    job = ipp.integer("copies", copies) + ipp.keyword("print-scaling", "none") + ipp.keyword("media", PAPER[o["paper"]][2])
    op = (ipp.uri("printer-uri", printer_uri(printer)) + ipp.name_("requesting-user-name", "toolbox")
          + ipp.name_("job-name", entry["name"]) + ipp.mime("document-format", "application/pdf"))
    _, groups = _ipp(path_of(printer), ipp.request(ipp.PRINT_JOB, op, job, made))
    jid = next((g[1]["job-id"][0] for g in groups if "job-id" in g[1]), None)
    return jsonify(job=jid, name=entry["name"], sheets=sheets, printer=printer["name"])


def job_list(printer, which, limit):
    op = (ipp.uri("printer-uri", printer_uri(printer)) + ipp.keyword("which-jobs", which)
          + ipp.integer("limit", limit) + ipp.keyword("requested-attributes", *JOB_ATTRS))
    return [g[1] for g in _ipp(path_of(printer), ipp.request(ipp.GET_JOBS, op))[1] if g[0] == 0x02 and "job-id" in g[1]]


@bp.get("/print/jobs")
def print_jobs():
    printer = pick(request.args.get("printer", ""))
    seen, out = set(), []
    for a in job_list(printer, "not-completed", 20) + job_list(printer, "completed", 10):
        jid = a["job-id"][0]
        if jid in seen:
            continue
        seen.add(jid)
        out.append({"id": jid, "name": (a.get("job-name") or [""])[0], "state": JOB_STATE.get((a.get("job-state") or [0])[0], "unknown"),
                    "user": (a.get("job-originating-user-name") or [""])[0], "created": (a.get("time-at-creation") or [0])[0]})
    out.sort(key=lambda j: -j["id"])
    return jsonify(jobs=out[:20])


@bp.post("/print/jobs/<int:jid>/cancel")
def print_cancel(jid):
    printer = pick((request.get_json(silent=True) or {}).get("printer", ""))
    op = ipp.uri("printer-uri", printer_uri(printer)) + ipp.integer("job-id", jid) + ipp.name_("requesting-user-name", "toolbox")
    _ipp(path_of(printer), ipp.request(ipp.CANCEL_JOB, op))
    return jsonify(ok=True)
