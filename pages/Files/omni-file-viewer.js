// Page script for pages/omni-file-viewer.html. Drop a file, look at it, export it as something else.
// Everything runs in the browser. Heavier libraries (pdf.js, mammoth, SheetJS, jsPDF, JSZip) are loaded from
// cdnjs the first time a file needs them.
(function () {
  const $ = (s) => document.querySelector(s);
  const status = $("#status"), host = $("#host"), tools = $("#tools"), fmtSel = $("#fmt"), exportBtn = $("#export");

  // ---------- small helpers ----------
  const say = (text, error) => { status.textContent = text; status.classList.toggle("error", !!error); };
  async function run(fn) {
    try { await fn(); } catch (err) { say(err.message || String(err), true); }
  }
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtSize = (n) => (n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB");
  const extOf = (n) => (n.match(/\.([^.]+)$/) || [, ""])[1].toLowerCase();
  const baseOf = (n) => n.replace(/\.[^.]+$/, "") || "file";
  const safeName = (s) => String(s).replace(/[\\/:*?"<>|]/g, "_");
  const toBlob = (canvas, type, q) => new Promise((r) => canvas.toBlob(r, type, q));
  const textBlob = (text, type) => new Blob([text], { type: type + ";charset=utf-8" });
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pad = (n, total) => String(n).padStart(String(total).length, "0");

  function save(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  // A toolbar button that reports errors in the status line.
  function tbtn(label, fn, title) {
    const b = el("button", "btn small", label);
    b.type = "button";
    if (title) { b.title = title; b.setAttribute("aria-label", title); }
    b.addEventListener("click", () => run(fn));
    return b;
  }
  const lbl = (text) => el("span", "lbl", text);
  const sep = () => el("span", "sep");

  // ---------- libraries, loaded on demand ----------
  const CDN = "https://cdnjs.cloudflare.com/ajax/libs/";
  const LIBS = {
    pdfjs: { label: "PDF", global: "pdfjsLib", src: CDN + "pdf.js/3.11.174/pdf.min.js", worker: CDN + "pdf.js/3.11.174/pdf.worker.min.js" },
    mammoth: { label: "Word", global: "mammoth", src: CDN + "mammoth/1.6.0/mammoth.browser.min.js" },
    xlsx: { label: "spreadsheet", global: "XLSX", src: CDN + "xlsx/0.18.5/xlsx.full.min.js" },
    jspdf: { label: "PDF export", global: "jspdf", src: CDN + "jspdf/2.5.1/jspdf.umd.min.js" },
    jszip: { label: "ZIP", global: "JSZip", src: CDN + "jszip/3.10.1/jszip.min.js" },
    pdflib: { label: "PDF merge", global: "PDFLib", src: CDN + "pdf-lib/1.17.1/pdf-lib.min.js" },
  };
  const pending = {};
  function lib(name) {
    const l = LIBS[name];
    if (window[l.global]) return Promise.resolve(window[l.global]);
    pending[name] ||= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = l.src;
      s.onload = () => resolve(window[l.global]);
      s.onerror = () => { delete pending[name]; s.remove(); reject(new Error(`Could not load the ${l.label} library. Check your connection and try again.`)); };
      document.head.append(s);
    });
    return pending[name];
  }

  // ---------- file kinds ----------
  const EXT = {
    image: "png jpg jpeg jpe jfif gif webp bmp svg avif ico apng",
    pdf: "pdf",
    docx: "docx",
    sheet: "xlsx xlsm xls ods csv tsv",
    text: "txt md markdown json xml html htm css js mjs ts tsx jsx yml yaml toml ini log py java c cpp h cs go rs rb php sh sql",
    audio: "mp3 wav ogg oga m4a aac flac opus",
    video: "mp4 webm mov m4v ogv",
  };
  function kindOf(file, ext) {
    for (const [k, list] of Object.entries(EXT)) if (list.split(" ").includes(ext)) return k;
    const t = file.type || "";
    for (const k of ["image", "audio", "video", "text"]) if (t.startsWith(k + "/")) return k;
    return "other";
  }

  const kinds = {};

  // ---------- image ----------
  kinds.image = {
    label: "Image",
    async open(e) {
      const url = (e.url ||= URL.createObjectURL(e.file));
      const img = new Image();
      img.alt = e.name;
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = () => rej(new Error("This browser can't decode that image."));
        img.src = url;
      });
      const nw = img.naturalWidth || 1024, nh = img.naturalHeight || 1024;
      const root = el("div", "imgview"), wrap = el("div", "imgwrap");
      wrap.append(img);
      root.append(wrap);

      let rot = 0, zoom = 0, flip = false;   // zoom 0 = fit to the window
      const swapped = () => Math.abs(rot / 90) % 2 === 1;
      const dims = () => (swapped() ? [nh, nw] : [nw, nh]);
      const fitScale = () => {
        const [w, h] = dims();
        return Math.min(1, ((root.clientWidth || 800) - 24) / w, (innerHeight * 0.7) / h);
      };
      const scale = () => zoom || fitScale();
      const out = lbl("");
      function layout() {
        const [w, h] = dims(), s = scale();
        wrap.style.width = w * s + "px";
        wrap.style.height = h * s + "px";
        img.style.width = nw * s + "px";
        img.style.height = nh * s + "px";
        img.style.transform = `translate(-50%, -50%) rotate(${rot}deg) scaleX(${flip ? -1 : 1})`;
        out.textContent = Math.round(s * 100) + "%";
      }
      const onResize = () => { if (!zoom) layout(); };
      addEventListener("resize", onResize);

      // Draw the image as it is shown (rotation and flip applied) for export.
      function raster(bg) {
        const [w, h] = dims();
        if (w * h > 1e8 || Math.max(w, h) > 16384) throw new Error("This image is too large for the browser to convert.");
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const x = c.getContext("2d");
        if (bg) { x.fillStyle = bg; x.fillRect(0, 0, w, h); }
        x.translate(w / 2, h / 2);
        x.rotate((rot * Math.PI) / 180);
        x.scale(flip ? -1 : 1, 1);
        x.drawImage(img, -nw / 2, -nh / 2, nw, nh);
        return c;
      }
      const format = (id, label, type, ext, bg) => ({
        id, label,
        async run() {
          const blob = await toBlob(raster(bg), type, 0.92);
          if (!blob || blob.type !== type) throw new Error(`This browser can't save ${label.split(" ")[0]} files. Pick another format.`);
          return { blob, name: `${baseOf(e.name)}.${ext}` };
        },
      });

      return {
        root,
        meta: `${nw} × ${nh} px`,
        ready: layout,
        destroy: () => removeEventListener("resize", onResize),
        tools: [
          tbtn("−", () => { zoom = clamp(scale() / 1.25, 0.02, 16); layout(); }, "Zoom out"),
          out,
          tbtn("+", () => { zoom = clamp(scale() * 1.25, 0.02, 16); layout(); }, "Zoom in"),
          tbtn("Fit", () => { zoom = 0; layout(); }, "Fit to window"),
          tbtn("100%", () => { zoom = 1; layout(); }, "Actual size"),
          sep(),
          tbtn("⟲", () => { rot -= 90; layout(); }, "Rotate left"),
          tbtn("⟳", () => { rot += 90; layout(); }, "Rotate right"),
          tbtn("Flip", () => { flip = !flip; layout(); }, "Flip horizontally"),
        ],
        exports: [
          format("png", "PNG (lossless)", "image/png", "png"),
          format("jpeg", "JPEG", "image/jpeg", "jpg", "#ffffff"),
          format("webp", "WebP", "image/webp", "webp"),
          format("avif", "AVIF (if the browser supports it)", "image/avif", "avif"),
          {
            id: "pdf", label: "PDF",
            async run() {
              const { jsPDF } = await lib("jspdf");
              const c = raster("#ffffff");
              const pdf = new jsPDF({ orientation: c.width > c.height ? "l" : "p", unit: "px", format: [c.width, c.height], hotfixes: ["px_scaling"] });
              pdf.addImage(c.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, c.width, c.height);
              return { blob: pdf.output("blob"), name: baseOf(e.name) + ".pdf" };
            },
          },
        ],
      };
    },
  };

  // ---------- PDF ----------
  kinds.pdf = {
    label: "PDF",
    async open(e) {
      const pdfjs = await lib("pdfjs");
      pdfjs.GlobalWorkerOptions.workerSrc = LIBS.pdfjs.worker;
      const task = pdfjs.getDocument({ data: new Uint8Array(await e.file.arrayBuffer()) });
      task.onPassword = (cb, reason) => {
        const pw = prompt(reason === 2 ? "Wrong password. Try again:" : "This PDF is password protected. Password:");
        if (pw === null) task.destroy(); else cb(pw);
      };
      let doc;
      try { doc = await task.promise; }
      catch (err) { throw new Error(err?.name === "PasswordException" ? "This PDF needs a password." : "Could not open this PDF: " + (err?.message || err)); }

      const total = doc.numPages;
      const root = el("div", "pdfview"), canvas = el("canvas", "pdfpage");
      root.append(canvas);
      let n = 1, zoom = 0, cur = 1, serial = 0, job = null;
      const out = lbl("");
      const num = el("input");
      num.type = "number"; num.min = 1; num.max = total; num.value = 1;
      num.setAttribute("aria-label", "Page number");

      async function render() {
        const my = ++serial;
        job?.cancel();
        const page = await doc.getPage(n);
        if (my !== serial) return;
        const base = page.getViewport({ scale: 1 });
        cur = zoom || clamp(((root.clientWidth || 800) - 32) / base.width, 0.2, 2.5);
        const dpr = Math.min(devicePixelRatio || 1, 2);
        canvas.width = Math.floor(base.width * cur * dpr);
        canvas.height = Math.floor(base.height * cur * dpr);
        canvas.style.width = base.width * cur + "px";
        canvas.style.height = base.height * cur + "px";
        num.value = n;
        out.textContent = Math.round(cur * 100) + "%";
        job = page.render({ canvasContext: canvas.getContext("2d"), viewport: page.getViewport({ scale: cur * dpr }), background: "#ffffff" });
        try { await job.promise; }
        catch (err) { if (err?.name !== "RenderingCancelledException") throw err; }
      }
      const go = (k) => { n = clamp(Math.round(k) || 1, 1, total); root.scrollTop = 0; return render(); };
      const setZoom = (z) => { zoom = clamp(z, 0.2, 5); return render(); };
      num.addEventListener("change", () => run(() => go(+num.value)));
      const onKey = (ev) => {
        if (ev.target.closest?.("input, select, textarea") || ev.ctrlKey || ev.metaKey || ev.altKey) return;
        if (ev.key === "ArrowLeft") run(() => go(n - 1));
        else if (ev.key === "ArrowRight") run(() => go(n + 1));
      };
      document.addEventListener("keydown", onKey);
      const onResize = () => { if (!zoom) run(render); };
      addEventListener("resize", onResize);

      async function pageCanvas(k) {
        const page = await doc.getPage(k);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: Math.min(2, 8000 / Math.max(base.width, base.height)) });
        const c = document.createElement("canvas");
        c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        await page.render({ canvasContext: c.getContext("2d"), viewport: vp, background: "#ffffff" }).promise;
        return c;
      }
      const single = (id, label, type, ext) => ({
        id, label,
        async run() {
          const blob = await toBlob(await pageCanvas(n), type, 0.92);
          return { blob, name: `${baseOf(e.name)}-page-${pad(n, total)}.${ext}` };
        },
      });
      const everyPage = (id, label, type, ext) => ({
        id, label,
        async run(progress) {
          const JSZip = await lib("jszip"), zip = new JSZip();
          for (let k = 1; k <= total; k++) {
            progress(`Rendering page ${k} of ${total}…`);
            const blob = await toBlob(await pageCanvas(k), type, 0.92);
            zip.file(`${baseOf(e.name)}-page-${pad(k, total)}.${ext}`, blob);
          }
          progress("Packing the zip…");
          return { blob: await zip.generateAsync({ type: "blob" }), name: `${baseOf(e.name)}-${ext}.zip` };
        },
      });

      return {
        root,
        meta: `${total} page${total === 1 ? "" : "s"}`,
        ready: render,
        destroy() {
          document.removeEventListener("keydown", onKey);
          removeEventListener("resize", onResize);
          job?.cancel();
          doc.destroy();
        },
        tools: [
          tbtn("◀", () => go(n - 1), "Previous page"), num, lbl(`/ ${total}`), tbtn("▶", () => go(n + 1), "Next page"),
          sep(),
          tbtn("−", () => setZoom(cur / 1.25), "Zoom out"), out, tbtn("+", () => setZoom(cur * 1.25), "Zoom in"),
          tbtn("Fit", () => { zoom = 0; return render(); }, "Fit to width"),
        ],
        exports: [
          single("png-page", "Current page as PNG", "image/png", "png"),
          single("jpg-page", "Current page as JPEG", "image/jpeg", "jpg"),
          everyPage("png-all", "All pages as PNG (.zip)", "image/png", "png"),
          everyPage("jpg-all", "All pages as JPEG (.zip)", "image/jpeg", "jpg"),
          {
            id: "txt", label: "Text (.txt)",
            async run(progress) {
              const parts = [];
              for (let k = 1; k <= total; k++) {
                progress(`Reading page ${k} of ${total}…`);
                const content = await (await doc.getPage(k)).getTextContent();
                parts.push(content.items.map((i) => i.str + (i.hasEOL ? "\n" : " ")).join("").replace(/[ \t]+\n/g, "\n").trim());
              }
              const text = parts.join("\n\n").trim();
              if (!text) throw new Error("No text found. This PDF may be a scan or only contain images.");
              return { blob: textBlob(text, "text/plain"), name: baseOf(e.name) + ".txt" };
            },
          },
        ],
      };
    },
  };

  // ---------- Word (.docx) ----------
  kinds.docx = {
    label: "Word",
    async open(e) {
      const mammoth = await lib("mammoth");
      const buffer = await e.file.arrayBuffer();
      let html;
      try { html = (await mammoth.convertToHtml({ arrayBuffer: buffer })).value; }
      catch { throw new Error("Could not read this document. Is it a valid .docx file?"); }

      const css = "body{margin:0 auto;padding:2.2rem 2.6rem;max-width:52rem;font:16px/1.6 Georgia,serif;color:#1d1a24;background:#fff}" +
        "img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:.3rem .5rem}" +
        "blockquote{margin-left:0;padding-left:1rem;border-left:3px solid #ccc;color:#555}";
      const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(baseOf(e.name))}</title><style>${css}</style></head><body>${html}</body></html>`;

      // No scripts run inside this frame: the sandbox leaves "allow-scripts" out.
      const frame = el("iframe", "docframe");
      frame.setAttribute("sandbox", "allow-same-origin allow-modals");
      frame.title = e.name;
      let z = 1;
      const apply = () => { const b = frame.contentDocument?.body; if (b) b.style.zoom = z; };
      frame.addEventListener("load", apply);
      frame.srcdoc = page;
      const out = lbl("100%");
      const setZoom = (v) => { z = clamp(v, 0.5, 2.5); out.textContent = Math.round(z * 100) + "%"; apply(); };

      return {
        root: frame,
        meta: "Word document",
        tools: [tbtn("−", () => setZoom(z / 1.15), "Zoom out"), out, tbtn("+", () => setZoom(z * 1.15), "Zoom in"), tbtn("100%", () => setZoom(1), "Actual size")],
        exports: [
          { id: "html", label: "Web page (.html)", run: async () => ({ blob: textBlob(page, "text/html"), name: baseOf(e.name) + ".html" }) },
          {
            id: "txt", label: "Plain text (.txt)",
            async run() {
              const { value } = await mammoth.extractRawText({ arrayBuffer: buffer });
              return { blob: textBlob(value, "text/plain"), name: baseOf(e.name) + ".txt" };
            },
          },
          {
            id: "pdf", label: "PDF (opens the print dialog)",
            async run(progress) {
              const win = frame.contentWindow;
              if (!win) throw new Error("The document is not ready yet.");
              const b = frame.contentDocument.body;
              b.style.zoom = 1;
              win.focus();
              win.print();
              apply();
              progress("In the print dialog, choose “Save as PDF” as the destination.");
              return null;
            },
          },
        ],
      };
    },
  };

  // ---------- spreadsheets ----------
  kinds.sheet = {
    label: "Sheet",
    async open(e) {
      const XLSX = await lib("xlsx");
      let wb;
      try {
        wb = e.ext === "csv" || e.ext === "tsv"
          ? XLSX.read((await e.file.text()).replace(/^\uFEFF/, ""), { type: "string", cellDates: true })
          : XLSX.read(await e.file.arrayBuffer(), { type: "array", cellDates: true });
      } catch { throw new Error("Could not read this spreadsheet."); }
      if (!wb.SheetNames.length) throw new Error("This file has no sheets.");

      const MAX_ROWS = 1000, MAX_COLS = 60;
      const root = el("div"), box = el("div", "sheetview"), note = el("p", "hint sheetnote");
      root.append(box, note);
      let name = wb.SheetNames[0];
      const ws = () => wb.Sheets[name];

      function draw() {
        const rows = XLSX.utils.sheet_to_json(ws(), { header: 1, raw: false, defval: "" });
        const cols = Math.min(MAX_COLS, rows.reduce((m, r) => Math.max(m, r.length), 0));
        const table = el("table"), head = table.createTHead().insertRow();
        head.append(el("th"));
        for (let c = 0; c < cols; c++) head.append(el("th", "", XLSX.utils.encode_col(c)));
        const body = table.createTBody();
        rows.slice(0, MAX_ROWS).forEach((r, i) => {
          const tr = body.insertRow();
          tr.append(el("th", "", i + 1));
          for (let c = 0; c < cols; c++) tr.insertCell().textContent = r[c] ?? "";
        });
        box.replaceChildren(rows.length ? table : el("p", "hint note", "This sheet is empty."));
        const cut = [];
        if (rows.length > MAX_ROWS) cut.push(`first ${MAX_ROWS.toLocaleString()} of ${rows.length.toLocaleString()} rows`);
        if (rows.reduce((m, r) => Math.max(m, r.length), 0) > MAX_COLS) cut.push(`first ${MAX_COLS} columns`);
        note.textContent = cut.length ? `Showing the ${cut.join(" and ")}. Exports contain everything.` : "";
      }

      const picker = el("select");
      picker.setAttribute("aria-label", "Sheet");
      wb.SheetNames.forEach((s) => picker.append(new Option(s, s)));
      picker.addEventListener("change", () => { name = picker.value; draw(); });

      const stem = () => baseOf(e.name) + (wb.SheetNames.length > 1 ? "-" + safeName(name) : "");
      const book = (id, label, bookType, ext, type) => ({
        id, label,
        run: async () => ({ blob: new Blob([XLSX.write(wb, { bookType, type: "array" })], { type }), name: `${baseOf(e.name)}.${ext}` }),
      });

      return {
        root,
        meta: `${wb.SheetNames.length} sheet${wb.SheetNames.length === 1 ? "" : "s"}`,
        ready: draw,
        tools: wb.SheetNames.length > 1 ? [picker] : [],
        exports: [
          book("xlsx", "Excel (.xlsx), all sheets", "xlsx", "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
          book("ods", "OpenDocument (.ods), all sheets", "ods", "ods", "application/vnd.oasis.opendocument.spreadsheet"),
          { id: "csv", label: "CSV, current sheet", run: async () => ({ blob: textBlob(XLSX.utils.sheet_to_csv(ws()), "text/csv"), name: stem() + ".csv" }) },
          { id: "tsv", label: "TSV, current sheet", run: async () => ({ blob: textBlob(XLSX.utils.sheet_to_csv(ws(), { FS: "\t" }), "text/tab-separated-values"), name: stem() + ".tsv" }) },
          { id: "json", label: "JSON, current sheet", run: async () => ({ blob: textBlob(JSON.stringify(XLSX.utils.sheet_to_json(ws(), { defval: null }), null, 2), "application/json"), name: stem() + ".json" }) },
          { id: "html", label: "HTML table, current sheet", run: async () => ({ blob: textBlob(XLSX.utils.sheet_to_html(ws()), "text/html"), name: stem() + ".html" }) },
        ],
      };
    },
  };

  // ---------- text and code ----------
  kinds.text = {
    label: "Text",
    async open(e) {
      let text = (await e.file.text()).replace(/^\uFEFF/, "");
      const LIMIT = 2e6;
      const pre = el("pre", "textview");
      let wrap = false, size = 0.9;
      const show = () => { pre.textContent = text.length > LIMIT ? text.slice(0, LIMIT) : text; };
      const wrapBtn = tbtn("Wrap lines", () => {
        wrap = !wrap;
        pre.classList.toggle("wrap", wrap);
        wrapBtn.setAttribute("aria-pressed", String(wrap));
      });
      wrapBtn.setAttribute("aria-pressed", "false");
      const fontSize = (d) => () => { size = clamp(size + d, 0.6, 2); pre.style.fontSize = size + "rem"; };
      const isJson = e.ext === "json";
      const reformat = (indent) => () => {
        try { text = JSON.stringify(JSON.parse(text), null, indent); }
        catch (err) { throw new Error("This is not valid JSON: " + err.message); }
        show();
      };
      show();

      const lines = text ? text.split(/\r?\n/).length : 0;
      const base = baseOf(e.name);
      const listing = () => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(e.name)}</title></head><body><pre style="font:14px/1.5 monospace;white-space:pre-wrap">${esc(text)}</pre></body></html>`;

      return {
        root: pre,
        meta: `${lines.toLocaleString()} line${lines === 1 ? "" : "s"}${text.length > LIMIT ? ", preview cut at 2 MB" : ""}`,
        tools: [
          wrapBtn, tbtn("A−", fontSize(-0.1), "Smaller text"), tbtn("A+", fontSize(0.1), "Larger text"),
          ...(isJson ? [sep(), tbtn("Format JSON", reformat(2)), tbtn("Minify JSON", reformat(0))] : []),
        ],
        exports: [
          { id: "txt", label: "Plain text (.txt)", run: async () => ({ blob: textBlob(text, "text/plain"), name: base + ".txt" }) },
          { id: "html", label: "Web page (.html)", run: async () => ({ blob: textBlob(listing(), "text/html"), name: base + ".html" }) },
          ...(isJson ? [{ id: "json", label: "JSON (.json), as shown", run: async () => ({ blob: textBlob(text, "application/json"), name: base + ".json" }) }] : []),
          {
            id: "pdf", label: "PDF (Latin characters only)",
            async run() {
              const { jsPDF } = await lib("jspdf");
              const pdf = new jsPDF({ unit: "pt", format: "a4" });
              pdf.setFont("courier", "normal");
              pdf.setFontSize(9);
              const width = pdf.internal.pageSize.getWidth() - 80, bottom = pdf.internal.pageSize.getHeight() - 40;
              const clean = text.replace(/\t/g, "    ").replace(/[^\x00-\xFF]/g, "?");
              let y = 50;
              for (const line of pdf.splitTextToSize(clean, width)) {
                if (y > bottom) { pdf.addPage(); y = 50; }
                pdf.text(line, 40, y);
                y += 12;
              }
              return { blob: pdf.output("blob"), name: base + ".pdf" };
            },
          },
        ],
      };
    },
  };

  // ---------- audio and video ----------
  const media = (tag, label) => ({
    label,
    async open(e) {
      const url = (e.url ||= URL.createObjectURL(e.file));
      const root = el("div", "mediaview"), player = el(tag);
      player.controls = true;
      player.src = url;
      player.addEventListener("error", () => say("This browser can't play that file.", true));
      root.append(player);
      return { root, meta: "", tools: [], exports: [], destroy: () => { player.pause(); player.removeAttribute("src"); player.load(); } };
    },
  });
  kinds.audio = media("audio", "Audio");
  kinds.video = media("video", "Video");

  // ---------- anything else ----------
  kinds.other = {
    label: "File",
    async open(e) {
      const hints = {
        doc: "Old .doc files can't be opened here. Save the file as .docx and add it again.",
        ppt: "PowerPoint files can't be opened here yet. Export them to PDF and add the PDF.",
        pptx: "PowerPoint files can't be opened here yet. Export them to PDF and add the PDF.",
        odt: "OpenDocument text files can't be opened here yet. Save as .docx or PDF and add that.",
        rtf: "RTF files can't be opened here yet. Save as .docx or PDF and add that.",
        heic: "HEIC photos can't be decoded by browsers. Convert to JPEG or PNG first.",
        tif: "TIFF images can't be shown by most browsers. Convert to PNG or JPEG first.",
        tiff: "TIFF images can't be shown by most browsers. Convert to PNG or JPEG first.",
      };
      const root = el("p", "hint note", hints[e.ext] || `There is no viewer for .${e.ext || "this"} files yet. You can still download the original.`);
      return { root, meta: "", tools: [], exports: [] };
    },
  };

  // ---------- files and the viewer ----------
  const MAX_FILES = 30, MAX_BYTES = 300 * 1024 * 1024;
  let files = [], current = null, view = null, token = 0, seq = 0, exportList = [];

  function setExports(list) {
    exportList = list;
    fmtSel.replaceChildren(...(list.length ? list : [{ id: "", label: "No conversions for this file" }]).map((x) => new Option(x.label, x.id)));
    fmtSel.disabled = exportBtn.disabled = !list.length;
  }

  function closeView() {
    view?.destroy?.();
    view = null;
    host.replaceChildren();
    tools.replaceChildren();
    setExports([]);
  }

  function renderTray() {
    $("#tray").replaceChildren(...files.map((f) => {
      const li = el("li", f === current ? "on" : "");
      li.dataset.id = f.id;
      const pick = el("button", "pick"), x = el("button", "x", "✕");
      pick.type = x.type = "button";
      pick.dataset.act = "pick"; x.dataset.act = "remove";
      pick.append(el("span", "name", f.name), el("span", "kind", `${kinds[f.kind].label}, ${fmtSize(f.size)}`));
      pick.title = f.name;
      x.title = x.ariaLabel = "Close " + f.name;
      li.append(pick, x);
      return li;
    }));
    renderCombine();
  }

  async function show(entry) {
    const mine = ++token;
    closeView();
    current = entry;
    renderTray();
    $("#viewer").hidden = !entry;
    $("#empty").hidden = !!entry;
    if (!entry) return say("");

    $("#vname").textContent = entry.name;
    const base = `${kinds[entry.kind].label}, ${fmtSize(entry.size)}`;
    $("#vmeta").textContent = base;
    host.replaceChildren(el("p", "hint note", "Opening…"));
    say("");
    try {
      const v = await kinds[entry.kind].open(entry);
      if (mine !== token) return v.destroy?.();       // another file was picked while this one was loading
      view = v;
      host.replaceChildren(v.root);
      tools.replaceChildren(...v.tools);
      setExports(v.exports);
      if (v.meta) $("#vmeta").textContent = `${base}, ${v.meta}`;
      await v.ready?.();
    } catch (err) {
      if (mine !== token) return;
      host.replaceChildren(el("p", "hint note", "This file could not be opened."));
      say(err.message || String(err), true);
    }
  }

  async function addFiles(list) {
    const added = [], skipped = [];
    for (const file of list) {
      if (files.length + added.length >= MAX_FILES) { skipped.push(`${file.name} (limit of ${MAX_FILES} files)`); continue; }
      if (file.size > MAX_BYTES) { skipped.push(`${file.name} (over ${fmtSize(MAX_BYTES)})`); continue; }
      const ext = extOf(file.name);
      added.push({ id: ++seq, file, name: file.name || "pasted-file", ext, kind: kindOf(file, ext), size: file.size, url: null, inc: true });
    }
    files.push(...added);
    if (added.length) await show(added[0]);
    if (skipped.length) say("Skipped: " + skipped.join(", "), true);
  }

  function remove(entry) {
    if (entry.url) URL.revokeObjectURL(entry.url);
    const i = files.indexOf(entry);
    files.splice(i, 1);
    if (entry === current) show(files[Math.min(i, files.length - 1)] || null);
    else renderTray();
  }

  $("#tray").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-act]");
    const entry = b && files.find((f) => f.id === +b.closest("li").dataset.id);
    if (!entry) return;
    if (b.dataset.act === "remove") remove(entry);
    else if (entry !== current) show(entry);
  });

  exportBtn.addEventListener("click", () => run(async () => {
    const item = exportList.find((x) => x.id === fmtSel.value);
    if (!item) return;
    exportBtn.disabled = true;
    say("Exporting…");
    try {
      const out = await item.run(say);
      if (!out) return;                                // the exporter has already told the person what to do next
      save(out.blob, out.name);
      say(`Saved ${out.name} (${fmtSize(out.blob.size)}).`);
    } finally {
      exportBtn.disabled = !exportList.length;
    }
  }));
  $("#original").addEventListener("click", () => { if (current) save(current.file, current.name); });

  // ---------- drop, choose, paste ----------
  const drop = $("#drop");
  const hasFiles = (e) => e.dataTransfer?.types?.includes("Files");
  let depth = 0;
  document.addEventListener("dragenter", (e) => { if (hasFiles(e)) { depth++; drop.classList.add("over"); } });
  document.addEventListener("dragleave", (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; drop.classList.remove("over"); } });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    drop.classList.remove("over");
    if (e.dataTransfer.files.length) run(() => addFiles([...e.dataTransfer.files]));
  });
  document.addEventListener("paste", (e) => {
    if (e.clipboardData?.files.length) { e.preventDefault(); run(() => addFiles([...e.clipboardData.files])); }
  });
  $("#picker").addEventListener("change", (e) => {
    const list = [...e.target.files];
    e.target.value = "";
    run(() => addFiles(list));
  });

  // ---------- combine several files into one ----------
  // The order of `files` (the tray) is the order of the output; entry.inc says whether a file takes part.
  const cfmt = $("#cfmt"), cgo = $("#cgo"), cnote = $("#cnote");
  const included = () => files.filter((f) => f.inc);

  const latin1 = (s) => s.replace(/\r/g, "").replace(/\t/g, "    ").replace(/[^\x20-\x7E\xA0-\xFF\n]/g, "?");

  async function imageForPdf(f) {
    const url = (f.url ||= URL.createObjectURL(f.file));
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error(`Could not decode ${f.name}.`));
      img.src = url;
    });
    const w = img.naturalWidth || 1024, h = img.naturalHeight || 1024;
    if (w * h > 1e8 || Math.max(w, h) > 16384) throw new Error(`${f.name} is too large for the browser to convert.`);
    const jpeg = ["jpg", "jpeg", "jpe", "jfif"].includes(f.ext);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d");
    if (jpeg) { x.fillStyle = "#ffffff"; x.fillRect(0, 0, w, h); }
    x.drawImage(img, 0, 0, w, h);
    const blob = await toBlob(c, jpeg ? "image/jpeg" : "image/png", 0.92);
    return { bytes: new Uint8Array(await blob.arrayBuffer()), jpeg, w, h };
  }

  async function pdfText(f) {
    const pdfjs = await lib("pdfjs");
    pdfjs.GlobalWorkerOptions.workerSrc = LIBS.pdfjs.worker;
    let doc;
    try { doc = await pdfjs.getDocument({ data: new Uint8Array(await f.file.arrayBuffer()) }).promise; }
    catch { throw new Error(`Could not read ${f.name}. It may be password protected or damaged.`); }
    const parts = [];
    for (let k = 1; k <= doc.numPages; k++) {
      const content = await (await doc.getPage(k)).getTextContent();
      parts.push(content.items.map((i) => i.str + (i.hasEOL ? "\n" : " ")).join("").replace(/[ \t]+\n/g, "\n").trim());
    }
    doc.destroy();
    return parts.join("\n\n");
  }

  async function combinePdf(list, progress) {
    const { PDFDocument, StandardFonts } = await lib("pdflib");
    const out = await PDFDocument.create();
    let font = null;
    for (const [i, f] of list.entries()) {
      progress(`Adding ${f.name} (${i + 1} of ${list.length})…`);
      if (f.kind === "pdf") {
        let src;
        try { src = await PDFDocument.load(await f.file.arrayBuffer()); }
        catch { throw new Error(`Could not merge ${f.name}. It may be password protected or damaged.`); }
        (await out.copyPages(src, src.getPageIndices())).forEach((p) => out.addPage(p));
      } else if (f.kind === "image") {
        const { bytes, jpeg, w, h } = await imageForPdf(f);
        const pic = jpeg ? await out.embedJpg(bytes) : await out.embedPng(bytes);
        const k = Math.min(0.75, 14000 / Math.max(w, h));   // one page per image, sized to the image
        out.addPage([w * k, h * k]).drawImage(pic, { x: 0, y: 0, width: w * k, height: h * k });
      } else {                                              // text: monospace pages, Latin characters only
        font ||= await out.embedFont(StandardFonts.Courier);
        const W = 595, H = 842, cols = 95, lh = 12, perPage = Math.floor((H - 80) / lh);
        const lines = [];
        for (const raw of latin1(await f.file.text()).split("\n")) {
          if (!raw) { lines.push(""); continue; }
          for (let c = 0; c < raw.length; c += cols) lines.push(raw.slice(c, c + cols));
        }
        for (let s = 0; s < Math.max(lines.length, 1); s += perPage) {
          const page = out.addPage([W, H]);
          lines.slice(s, s + perPage).forEach((l, j) => { if (l) page.drawText(l, { x: 40, y: H - 50 - j * lh, size: 9, font }); });
        }
      }
    }
    return { blob: new Blob([await out.save()], { type: "application/pdf" }), ext: "pdf" };
  }

  async function combineTxt(list, progress) {
    const label = $("#clabel").checked, parts = [];
    for (const [i, f] of list.entries()) {
      progress(`Reading ${f.name} (${i + 1} of ${list.length})…`);
      let t;
      if (f.kind === "docx") t = (await (await lib("mammoth")).extractRawText({ arrayBuffer: await f.file.arrayBuffer() })).value;
      else if (f.kind === "pdf") t = await pdfText(f);
      else t = (await f.file.text()).replace(/^\uFEFF/, "");
      parts.push((label ? `=== ${f.name} ===\n\n` : "") + t.trim());
    }
    return { blob: textBlob(parts.join("\n\n"), "text/plain"), ext: "txt" };
  }

  async function combineXlsx(list, progress) {
    const XLSX = await lib("xlsx"), out = XLSX.utils.book_new(), used = new Set();
    for (const [i, f] of list.entries()) {
      progress(`Adding ${f.name} (${i + 1} of ${list.length})…`);
      let wb;
      try {
        wb = f.ext === "csv" || f.ext === "tsv"
          ? XLSX.read((await f.file.text()).replace(/^\uFEFF/, ""), { type: "string", cellDates: true })
          : XLSX.read(await f.file.arrayBuffer(), { type: "array", cellDates: true });
      } catch { throw new Error(`Could not read ${f.name}.`); }
      for (const s of wb.SheetNames) {
        const stem = (wb.SheetNames.length > 1 ? `${baseOf(f.name)}-${s}` : baseOf(f.name)).replace(/[\[\]:*?\/\\]/g, "_");
        let name = stem.slice(0, 31), n = 2;                // Excel sheet names: 31 characters, unique
        while (used.has(name.toLowerCase())) name = stem.slice(0, 28) + "-" + n++;
        used.add(name.toLowerCase());
        XLSX.utils.book_append_sheet(out, wb.Sheets[s], name);
      }
    }
    return { blob: new Blob([XLSX.write(out, { bookType: "xlsx", type: "array" })], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), ext: "xlsx" };
  }

  const COMBINE = [
    { id: "pdf", label: "PDF (images, PDFs and text)", kinds: ["image", "pdf", "text"], run: combinePdf },
    { id: "txt", label: "Plain text (text, Word and PDF)", kinds: ["text", "docx", "pdf"], run: combineTxt },
    { id: "xlsx", label: "Excel workbook (one sheet per sheet)", kinds: ["sheet"], run: combineXlsx },
  ];

  function refreshCombine() {
    const inc = included(), keep = cfmt.value;
    const ok = inc.length < 2 ? [] : COMBINE.filter((c) => inc.every((f) => c.kinds.includes(f.kind)));
    cfmt.replaceChildren(...(ok.length ? ok : [{ id: "", label: "No common format" }]).map((c) => new Option(c.label, c.id)));
    if (ok.some((c) => c.id === keep)) cfmt.value = keep;
    cfmt.disabled = cgo.disabled = !ok.length;
    $("#clabel-wrap").hidden = cfmt.value !== "txt";
    cnote.textContent = inc.length < 2 ? "Tick at least two files."
      : ok.length ? ""
      : "These files can't be joined into one format. Images, PDFs and text files can become a PDF; text, Word and PDF files can become plain text; spreadsheets can become one workbook.";
  }

  function renderCombine() {
    $("#combine").hidden = files.length < 2;
    if (files.length < 2) return;
    let pos = 0;
    $("#corder").replaceChildren(...files.map((f, i) => {
      const li = el("li", f.inc ? "" : "off");
      li.dataset.id = f.id;
      const box = el("input"), name = el("span", "cname", f.name);
      box.type = "checkbox"; box.checked = f.inc; box.dataset.act = "inc";
      box.setAttribute("aria-label", "Include " + f.name);
      const up = el("button", "btn small", "▲"), down = el("button", "btn small", "▼");
      up.type = down.type = "button";
      up.dataset.act = "up"; down.dataset.act = "down";
      up.title = up.ariaLabel = "Move " + f.name + " up";
      down.title = down.ariaLabel = "Move " + f.name + " down";
      up.disabled = i === 0; down.disabled = i === files.length - 1;
      li.append(el("span", "cpos", f.inc ? ++pos + "." : "–"), box, name, el("span", "ckind", kinds[f.kind].label), up, down);
      return li;
    }));
    refreshCombine();
  }

  $("#corder").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-act]");
    if (!b) return;
    const id = +b.closest("li").dataset.id, i = files.findIndex((f) => f.id === id), j = b.dataset.act === "up" ? i - 1 : i + 1;
    if (!files[j]) return;
    [files[i], files[j]] = [files[j], files[i]];
    renderTray();
    $("#corder").querySelector(`li[data-id="${id}"] [data-act="${b.dataset.act}"]:not(:disabled)`)?.focus();
  });
  $("#corder").addEventListener("change", (ev) => {
    if (ev.target.dataset.act !== "inc") return;
    const f = files.find((x) => x.id === +ev.target.closest("li").dataset.id);
    if (f) { f.inc = ev.target.checked; renderCombine(); }
  });
  cfmt.addEventListener("change", refreshCombine);

  cgo.addEventListener("click", () => run(async () => {
    const choice = COMBINE.find((c) => c.id === cfmt.value), list = included();
    if (!choice || list.length < 2) return;
    cgo.disabled = true;
    say("Combining…");
    try {
      const { blob, ext } = await choice.run(list, say);
      const name = `${baseOf(list[0].name)}-combined.${ext}`;
      save(blob, name);
      say(`Saved ${name} (${fmtSize(blob.size)}) with ${list.length} files in the order shown.`);
    } finally {
      refreshCombine();
    }
  }));

  setExports([]);
})();
