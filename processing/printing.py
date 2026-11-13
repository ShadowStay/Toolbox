"""Printing page: upload files, they are converted to PDF and handed to CUPS. CUPS runs in the "cups" docker container
(ydkn/cups) and is reached over IPP on CUPS_URL (default http://localhost:631), see ipp.py. No cups-client is needed on the host.
  GET  /api/print/printers            -> {printers: [{name, info, state, accepting, default}], office: bool}
  POST /api/print/submit              multipart: file, printer?, copies?, pages? ("1-3,5"), fit? -> {job, name, pages}
  GET  /api/print/jobs?printer=       -> {jobs: [{id, name, state, user, created}]}
  POST /api/print/jobs/<id>/cancel    {printer?}
Environment: CUPS_URL, CUPS_PRINTER (default printer name), CUPS_USER / CUPS_PASSWORD (only if CUPS asks for a login).
Supported: PDF, images (PNG, JPEG, WebP, GIF, BMP, TIFF, HEIC with pillow-heif), plain text; Word / Excel / PowerPoint /
OpenDocument files too when LibreOffice (soffice) is on the PATH. Printing needs the printer to be added in CUPS first
(http://<server>:631 -> Administration -> Add Printer)."""
import io
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import quote

import pymupdf
from flask import jsonify, request

from . import bp, ipp
from . import image as imaging
from .errors import Fail
from .files import latin1, text_pdf_pages

CUPS = os.environ.get("CUPS_URL", "http://localhost:631").rstrip("/")
USER, PASSWORD = os.environ.get("CUPS_USER", ""), os.environ.get("CUPS_PASSWORD", "")
MAX_BYTES, MAX_COPIES = 50 * 1024 * 1024, 99
IMAGES = {"png", "jpg", "jpeg", "jpe", "jfif", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif"}
TEXT = {"txt", "log", "md", "csv", "tsv", "json", "xml", "ini", "yml", "yaml", "py", "js", "css", "html", "htm", "c", "cpp", "h", "java", "sh", "sql"}
OFFICE = {"docx", "doc", "odt", "rtf", "xlsx", "xls", "ods", "pptx", "ppt", "odp"}
PRINTER_ATTRS = ("printer-name", "printer-info", "printer-state", "printer-state-reasons", "printer-is-accepting-jobs")
JOB_ATTRS = ("job-id", "job-name", "job-state", "job-originating-user-name", "time-at-creation")
JOB_STATE = {3: "waiting", 4: "held", 5: "printing", 6: "stopped", 7: "cancelled", 8: "failed", 9: "done"}
PRINTER_STATE = {3: "idle", 4: "printing", 5: "stopped"}


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


def printer_uri(p):
    return "ipp://localhost/printers/" + quote(p["name"])


def path_of(p):
    return "/printers/" + quote(p["name"])


# ---------- converting to PDF ----------
def office_pdf(data, ext):
    exe = shutil.which("soffice") or shutil.which("libreoffice")
    if not exe:
        raise Fail("Word, Excel and PowerPoint files need LibreOffice on the server (sudo apt install libreoffice-writer libreoffice-calc libreoffice-impress). Save the file as PDF and upload that instead.")
    with tempfile.TemporaryDirectory(prefix="spells-print-") as d:
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
    im = imaging.load(io.BytesIO(data))
    imaging.check_size(*im.size)
    landscape = im.width > im.height
    W, H = (842, 595) if landscape else (595, 842)
    k = min((W - 36) / im.width, (H - 36) / im.height)           # an A4 page, the picture as large as fits, centred
    w, h = im.width * k, im.height * k
    out = pymupdf.open()
    page = out.new_page(width=W, height=H)
    opaque = im.getextrema()[3][0] == 255
    page.insert_image(pymupdf.Rect((W - w) / 2, (H - h) / 2, (W + w) / 2, (H + h) / 2),
                      stream=imaging.encode(im, "jpeg", 92)[0] if opaque else imaging.encode(im, "png")[0])
    return out.tobytes()


def text_to_pdf(data):
    for enc in ("utf-8-sig", "cp1252"):
        try:
            text = data.decode(enc)
            break
        except UnicodeDecodeError:
            text = data.decode("latin-1")
    out = pymupdf.open()
    text_pdf_pages(out, text)
    return out.tobytes()


def to_pdf(name, data):
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext == "pdf" or data[:5] == b"%PDF-":
        return data
    if ext in IMAGES:
        return image_pdf(data)
    if ext in TEXT:
        return text_to_pdf(data)
    if ext in OFFICE:
        return office_pdf(data, ext)
    raise Fail(f"Files of type .{ext or '?'} can't be printed here. Use PDF, images, text or Office files.")


def page_count(pdf):
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


def parse_pages(text, total):
    """"1-3, 5, 8-" -> [(1, 3), (5, 5), (8, total)], checked against the number of pages."""
    pairs = []
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
        pairs.append((lo, hi))
    return pairs


# ---------- routes ----------
@bp.get("/print/printers")
def print_printers():
    return jsonify(printers=printers(), office=bool(shutil.which("soffice") or shutil.which("libreoffice")))


@bp.post("/print/submit")
def print_submit():
    fs = request.files.get("file")
    if not fs:
        raise Fail("No file received.")
    data = fs.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise Fail("That file is too large to print (50 MB at most).")
    if not data:
        raise Fail("That file is empty.")
    try:
        copies = int(request.form.get("copies") or 1)
    except ValueError:
        raise Fail("Copies must be a number.")
    if not 1 <= copies <= MAX_COPIES:
        raise Fail(f"Copies must be between 1 and {MAX_COPIES}.")
    printer = pick(request.form.get("printer", ""))
    if printer["state"] == "stopped" or not printer["accepting"]:
        raise Fail(f"The printer “{printer['name']}” is not accepting jobs right now.")
    name = re.sub(r"[\x00-\x1f\x7f]", "", fs.filename or "document").strip() or "document"
    pdf = to_pdf(name, data)
    total = page_count(pdf)
    pairs = parse_pages(request.form.get("pages", ""), total)
    job = ipp.integer("copies", copies)
    if pairs:
        job += ipp.ranges("page-ranges", pairs)
    job += ipp.keyword("print-scaling", "fit" if request.form.get("fit") == "1" else "auto")
    op = (ipp.uri("printer-uri", printer_uri(printer)) + ipp.name_("requesting-user-name", "toolbox")
          + ipp.name_("job-name", name) + ipp.mime("document-format", "application/pdf"))
    _, groups = _ipp(path_of(printer), ipp.request(ipp.PRINT_JOB, op, job, pdf))
    jid = next((g[1]["job-id"][0] for g in groups if "job-id" in g[1]), None)
    return jsonify(job=jid, name=name, pages=total, printer=printer["name"])


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
