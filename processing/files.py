"""File viewer, mirroring pages/omni-file-viewer.js. Files are uploaded once (POST /api/files/open), kept in a
temporary folder for 30 minutes (or until closed) and referred to by id afterwards.
  POST   /api/files/open               multipart: file -> {id, kind, ...details for that kind}
  DELETE /api/files/<id>
  GET    /api/files/<id>/preview       image -> PNG
  GET    /api/files/<id>/page/<n>      pdf page -> PNG   (?scale=1.5)
  GET    /api/files/<id>/sheet         spreadsheet rows -> JSON   (?name=Sheet1)
  POST   /api/files/<id>/export        {format, ...options} -> bytes
  POST   /api/files/combine            {ids, format, label} -> bytes
Requires: pymupdf, mammoth, pandas, openpyxl, odfpy (and xlrd for old .xls). LibreOffice is optional (Word -> PDF)."""
import atexit
import csv
import io
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
import zipfile
from pathlib import Path

import mammoth
import pandas as pd
import pymupdf
from flask import jsonify, request

from . import image as imaging
from .core import Fail, bp, send_bytes

EXT = {
    "image": "png jpg jpeg jpe jfif gif webp bmp svg avif ico apng tif tiff heic heif",
    "pdf": "pdf",
    "docx": "docx",
    "sheet": "xlsx xlsm xls ods csv tsv",
    "text": "txt md markdown json xml html htm css js mjs ts tsx jsx yml yaml toml ini log py java c cpp h cs go rs rb php sh sql",
}
TTL, MAX_ITEMS = 30 * 60, 80
ROWS, COLS = 1000, 60
csv.field_size_limit(1 << 27)
NUMBER = re.compile(r"^-?(?:0|[1-9]\d{0,14})(?:\.\d+)?$")      # what counts as a number when a CSV becomes a workbook ("007" does not)
ROOT = Path(tempfile.mkdtemp(prefix="spells-files-"))
atexit.register(shutil.rmtree, ROOT, ignore_errors=True)
_store, _lock = {}, threading.Lock()


def ext_of(name):
    m = re.search(r"\.([A-Za-z0-9]+)$", name or "")
    return m.group(1).lower() if m else ""


def kind_of(ext):
    for kind, exts in EXT.items():
        if ext in exts.split():
            return kind
    return "other"


def drop(fid):
    with _lock:
        e = _store.pop(fid, None)
    if e:
        e["path"].unlink(missing_ok=True)


def purge():
    now = time.time()
    with _lock:
        old = [k for k, e in _store.items() if now - e["ts"] > TTL]
        old += sorted(_store, key=lambda k: _store[k]["ts"])[: max(0, len(_store) - MAX_ITEMS)]
    for k in set(old):
        drop(k)


def get(fid):
    with _lock:
        e = _store.get(fid)
        if e: e["ts"] = time.time()
    if not e:
        raise Fail("This file is no longer on the server. Add it again.")
    return e


def read_text(path):
    raw = Path(path).read_bytes()
    for enc in ("utf-8-sig", "cp1252"):
        try: return raw.decode(enc)
        except UnicodeDecodeError: pass
    return raw.decode("latin-1")


def latin1(s):
    return re.sub(r"[^\x20-\x7E\xA0-\xFF\n]", "?", s.replace("\r", "").replace("\t", "    "))


# ---------- PDF helpers ----------
def open_pdf(path):
    try:
        doc = pymupdf.open(path)
    except Exception:
        raise Fail("Could not open this PDF. It may be damaged.")
    if doc.needs_pass:
        raise Fail("This PDF needs a password. Open it with browser processing instead.")
    return doc


def page_png(doc, n, scale, fmt="png"):
    page = doc[n - 1]
    scale = min(scale, 8000 / max(page.rect.width, page.rect.height))
    pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
    return pix.tobytes("jpeg", jpg_quality=92) if fmt == "jpeg" else pix.tobytes("png")


def pdf_text(doc):
    return "\n\n".join(p.get_text().strip() for p in doc).strip()


def image_pdf_page(out, im):
    k = min(0.75, 14000 / max(im.size))
    page = out.new_page(width=im.width * k, height=im.height * k)
    page.insert_image(page.rect, stream=imaging.encode(im, "jpeg", 92)[0] if im.getextrema()[3][0] == 255 else imaging.encode(im, "png")[0])


def text_pdf_pages(out, text):
    W, H, cols, lh = 595, 842, 95, 12
    wrapped = []
    for raw in latin1(text).split("\n"):
        if not raw: wrapped.append("")
        for c in range(0, len(raw), cols): wrapped.append(raw[c:c + cols])
    per = (H - 80) // lh
    for s in range(0, max(len(wrapped), 1), per):
        page = out.new_page(width=W, height=H)
        for j, l in enumerate(wrapped[s:s + per]):
            if l: page.insert_text((40, 50 + j * lh), l, fontname="cour", fontsize=9)


# ---------- Word helpers ----------
PAGE_CSS = ("body{margin:0 auto;padding:2.2rem 2.6rem;max-width:52rem;font:16px/1.6 Georgia,serif;color:#1d1a24;background:#fff}"
            "img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:.3rem .5rem}"
            "blockquote{margin-left:0;padding-left:1rem;border-left:3px solid #ccc;color:#555}")


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def docx_page(e):
    try:
        with open(e["path"], "rb") as f:
            body = mammoth.convert_to_html(f).value
    except Exception:
        raise Fail("Could not read this document. Is it a valid .docx file?")
    title = esc(re.sub(r"\.[^.]+$", "", e["name"]))
    return f'<!DOCTYPE html><html><head><meta charset="utf-8"><title>{title}</title><style>{PAGE_CSS}</style></head><body>{body}</body></html>'


def docx_text(path):
    with open(path, "rb") as f:
        return mammoth.extract_raw_text(f).value


def docx_pdf(path):
    exe = shutil.which("soffice") or shutil.which("libreoffice")
    if not exe:
        raise Fail("PDF export from Word needs LibreOffice installed on the server. Install it, or switch to browser processing.")
    with tempfile.TemporaryDirectory() as d:
        try:
            subprocess.run([exe, f"-env:UserInstallation=file://{d}/profile", "--headless", "--convert-to", "pdf", "--outdir", d, str(path)],
                           check=True, timeout=120, capture_output=True)
            return next(Path(d).glob("*.pdf")).read_bytes()
        except (subprocess.SubprocessError, StopIteration):
            raise Fail("LibreOffice could not convert this document.")


# ---------- spreadsheet helpers ----------
def sheet_names(e):
    if e["ext"] in ("csv", "tsv"):
        return [re.sub(r"\.[^.]+$", "", e["name"]) or "Sheet1"]
    try:
        return pd.ExcelFile(e["path"]).sheet_names
    except Exception:
        raise Fail("Could not read this spreadsheet.")


def csv_rows(e):
    """The rows of a CSV or TSV file. The separator is guessed (comma, semicolon, tab or bar) and short rows are fine."""
    text = read_text(e["path"])
    delimiter = "\t"
    if e["ext"] == "csv":                                  # whichever of , ; tab | the first line has most of
        first = next((l for l in text.splitlines() if l.strip()), "")
        delimiter = max(",;\t|", key=first.count) if any(d in first for d in ",;\t|") else ","
    return list(csv.reader(io.StringIO(text), delimiter=delimiter))


def read_sheet(e, name=None, typed=False):
    """A sheet as a table of text (what the page shows). typed=True keeps numbers and dates as they are, for exports."""
    try:
        if e["ext"] in ("csv", "tsv"):
            rows = csv_rows(e)
            width = max(map(len, rows), default=0)
            guess = lambda v: (float(v) if "." in v else int(v)) if typed and NUMBER.match(v) else v
            df = pd.DataFrame([[guess(v) for v in r] + [""] * (width - len(r)) for r in rows])
        else:
            df = pd.read_excel(e["path"], sheet_name=name or 0, header=None, keep_default_na=False, **({} if typed else {"dtype": str}))
    except Exception:
        raise Fail("Could not read this spreadsheet.")
    return df.fillna("")


def write_book(frames, engine):
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine=engine) as w:
        for name, df in frames.items():
            df.to_excel(w, sheet_name=name[:31], header=False, index=False)
    return buf.getvalue()


def records(df):
    if df.empty: return "[]"
    head, seen = [], {}
    for i, v in enumerate(df.iloc[0]):
        v = str(v) or "__EMPTY"
        seen[v] = seen.get(v, -1) + 1
        head.append(v if not seen[v] else f"{v}_{seen[v]}")
    body = df.iloc[1:].copy()
    body.columns = head
    return body.to_json(orient="records", indent=2, force_ascii=False)


# ---------- open ----------
def open_image(e):
    im = imaging.load(e["path"])
    return {"width": im.width, "height": im.height}


def open_pdf_info(e):
    doc = open_pdf(e["path"])
    info = {"pages": doc.page_count, "sizes": [[p.rect.width, p.rect.height] for p in doc]}
    doc.close()
    return info


def open_text(e):
    text = read_text(e["path"])
    return {"text": text[:2_000_000], "truncated": len(text) > 2_000_000, "lines": len(re.split(r"\r?\n", text)) if text else 0}


OPENERS = {
    "image": open_image,
    "pdf": open_pdf_info,
    "docx": lambda e: {"page": docx_page(e)},
    "sheet": lambda e: {"sheets": sheet_names(e)},
    "text": open_text,
}


@bp.post("/files/open")
def files_open():
    fs = request.files.get("file")
    if not fs:
        raise Fail("No file received.")
    purge()
    name, fid = fs.filename or "file", uuid.uuid4().hex
    ext = ext_of(name)
    e = {"id": fid, "name": name, "ext": ext, "kind": kind_of(ext), "ts": time.time(),
         "path": ROOT / (fid + (("." + ext) if ext else ""))}
    if e["kind"] not in OPENERS:
        raise Fail("The server has no viewer for this kind of file.")
    fs.save(e["path"])
    with _lock:
        _store[fid] = e
    try:
        info = OPENERS[e["kind"]](e)
    except Fail:
        drop(fid)
        raise
    except Exception as err:
        drop(fid)
        raise Fail(f"Could not open this file: {err}")
    return jsonify(id=fid, kind=e["kind"], **info)


@bp.delete("/files/<fid>")
def files_close(fid):
    drop(fid)
    return "", 204


@bp.get("/files/<fid>/preview")
def preview(fid):
    e = get(fid)
    if e["kind"] != "image": raise Fail("Not an image.")
    return send_bytes(imaging.encode(imaging.load(e["path"]), "png")[0], "image/png")


@bp.get("/files/<fid>/page/<int:n>")
def pdf_page(fid, n):
    e = get(fid)
    doc = open_pdf(e["path"])
    try:
        if not 1 <= n <= doc.page_count: raise Fail("No such page.")
        try:
            scale = min(8.0, max(0.1, float(request.args.get("scale", 1.5))))
        except ValueError:
            scale = 1.5
        return send_bytes(page_png(doc, n, scale), "image/png")
    finally:
        doc.close()


@bp.get("/files/<fid>/sheet")
def sheet(fid):
    e = get(fid)
    if e["kind"] != "sheet": raise Fail("Not a spreadsheet.")
    df = read_sheet(e, request.args.get("name"))
    rows = df.iloc[:ROWS, :COLS].values.tolist() if not df.empty else []
    return jsonify(rows=rows, total_rows=len(df), total_cols=df.shape[1] if len(df) else 0)


# ---------- export ----------
def need_text(e, o):
    return o["text"] if isinstance(o.get("text"), str) else read_text(e["path"])


def zip_pages(doc, fmt, base):
    ext = "png" if fmt == "png" else "jpg"
    buf, total = io.BytesIO(), doc.page_count
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        for k in range(1, total + 1):
            z.writestr(f"{base}-page-{str(k).zfill(len(str(total)))}.{ext}", page_png(doc, k, 2, fmt))
    return buf.getvalue(), "application/zip"


def export_image(e, o, fmt):
    im = imaging.load(e["path"])
    if o.get("flip"): im = imaging.ImageOps.mirror(im)
    try:
        turn = float(o.get("rot") or 0)
    except (TypeError, ValueError):
        raise Fail("The rotation is not a number.")
    if turn: im = im.rotate(-turn, expand=True)
    imaging.check_size(*im.size)
    if fmt == "pdf":
        out = pymupdf.open()
        image_pdf_page(out, im)
        return out.tobytes(), "application/pdf"
    return imaging.encode(im, fmt)


def export_pdf(e, o, fmt):
    doc = open_pdf(e["path"])
    try:
        if fmt in ("png-page", "jpg-page"):
            n = int(o.get("page", 1))
            if not 1 <= n <= doc.page_count: raise Fail("No such page.")
            f = "png" if fmt == "png-page" else "jpeg"
            return page_png(doc, n, 2, f), "image/" + f
        if fmt in ("png-all", "jpg-all"):
            return zip_pages(doc, fmt[:3], re.sub(r"\.[^.]+$", "", e["name"]) or "file")
        if fmt == "txt":
            text = pdf_text(doc)
            if not text: raise Fail("No text found. This PDF may be a scan or only contain images.")
            return text.encode("utf-8"), "text/plain"
    finally:
        doc.close()
    raise Fail("Unknown export format.")


def export_docx(e, o, fmt):
    if fmt == "html": return docx_page(e).encode("utf-8"), "text/html"
    if fmt == "txt": return docx_text(e["path"]).encode("utf-8"), "text/plain"
    if fmt == "pdf": return docx_pdf(e["path"]), "application/pdf"
    raise Fail("Unknown export format.")


def export_sheet(e, o, fmt):
    names = sheet_names(e)
    cur = o.get("sheet") if o.get("sheet") in names else names[0]
    if fmt in ("xlsx", "ods"):
        if e["ext"] == fmt: return e["path"].read_bytes(), "application/octet-stream"
        frames = {n: read_sheet(e, n, typed=True) for n in names}
        return write_book(frames, "openpyxl" if fmt == "xlsx" else "odf"), "application/octet-stream"
    df = read_sheet(e, cur)
    if fmt == "csv": return df.to_csv(header=False, index=False).encode("utf-8"), "text/csv"
    if fmt == "tsv": return df.to_csv(header=False, index=False, sep="\t").encode("utf-8"), "text/tab-separated-values"
    if fmt == "json": return records(df).encode("utf-8"), "application/json"
    if fmt == "html": return df.to_html(header=False, index=False).encode("utf-8"), "text/html"
    raise Fail("Unknown export format.")


def export_text(e, o, fmt):
    text = need_text(e, o)
    if fmt in ("txt", "json"): return text.encode("utf-8"), "text/plain" if fmt == "txt" else "application/json"
    if fmt == "html":
        return (f'<!DOCTYPE html><html><head><meta charset="utf-8"><title>{esc(e["name"])}</title></head><body>'
                f'<pre style="font:14px/1.5 monospace;white-space:pre-wrap">{esc(text)}</pre></body></html>').encode("utf-8"), "text/html"
    if fmt == "pdf":
        out = pymupdf.open()
        text_pdf_pages(out, text)
        return out.tobytes(), "application/pdf"
    raise Fail("Unknown export format.")


EXPORTERS = {"image": export_image, "pdf": export_pdf, "docx": export_docx, "sheet": export_sheet, "text": export_text}


@bp.post("/files/<fid>/export")
def files_export(fid):
    e, o = get(fid), request.get_json(silent=True) or {}
    data, mime = EXPORTERS[e["kind"]](e, o, o.get("format"))
    return send_bytes(data, mime)


# ---------- combine ----------
def combine_pdf(entries, o):
    out = pymupdf.open()
    for e in entries:
        if e["kind"] == "pdf":
            out.insert_pdf(open_pdf(e["path"]))
        elif e["kind"] == "image":
            im = imaging.load(e["path"])
            imaging.check_size(*im.size)
            image_pdf_page(out, im)
        else:
            text_pdf_pages(out, read_text(e["path"]))
    return out.tobytes()


def combine_txt(entries, o):
    parts = []
    for e in entries:
        if e["kind"] == "docx": t = docx_text(e["path"])
        elif e["kind"] == "pdf": t = pdf_text(open_pdf(e["path"]))
        else: t = read_text(e["path"])
        parts.append((f"=== {e['name']} ===\n\n" if o.get("label") else "") + t.strip())
    return "\n\n".join(parts).encode("utf-8")


def combine_xlsx(entries, o):
    frames, used = {}, set()
    for e in entries:
        names = sheet_names(e)
        for s in names:
            base = re.sub(r"\.[^.]+$", "", e["name"]) or "file"
            stem = re.sub(r"[\[\]:*?/\\]", "_", f"{base}-{s}" if len(names) > 1 else base)
            name, n = stem[:31], 2
            while name.lower() in used:
                name = f"{stem[:28]}-{n}"; n += 1
            used.add(name.lower())
            frames[name] = read_sheet(e, s, typed=True)
    return write_book(frames, "openpyxl")


COMBINE = {
    "pdf": (("image", "pdf", "text"), combine_pdf, "application/pdf"),
    "txt": (("text", "docx", "pdf"), combine_txt, "text/plain"),
    "xlsx": (("sheet",), combine_xlsx, "application/octet-stream"),
}


@bp.post("/files/combine")
def files_combine():
    d = request.get_json(silent=True) or {}
    entries = [get(i) for i in d.get("ids", [])]
    if len(entries) < 2: raise Fail("Tick at least two files.")
    spec = COMBINE.get(d.get("format"))
    if not spec or any(e["kind"] not in spec[0] for e in entries):
        raise Fail("These files can't be joined into that format.")
    return send_bytes(spec[1](entries, d), spec[2])
