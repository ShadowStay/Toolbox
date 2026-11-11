// Share button for every file in pages/cloud-storage.html (server side: processing/share.py).
// A share is a public link that works for 24 hours. The dialog shows it as a link, a QR code or a barcode (Code 128).
// The QR code and barcode libraries are loaded from cdnjs the first time they are needed.
(function () {
  const rows = document.getElementById("rows");
  if (!rows) return;
  const API = "/api/storage";
  const CDN = "https://cdnjs.cloudflare.com/ajax/libs/";
  const LIBS = {
    qr: { label: "QR code", global: "qrcode", src: CDN + "qrcode-generator/1.4.4/qrcode.min.js" },
    bar: { label: "barcode", global: "JsBarcode", src: CDN + "jsbarcode/3.11.6/JsBarcode.all.min.js" },
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
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  const css = document.createElement("style");
  css.textContent = `
    #sharer { width: min(34rem, 94vw); padding: 1.4rem; color: var(--moon, #f1e9ff); background: var(--dusk, #22123b); border: 1px solid var(--amethyst, #8a5bd8); border-radius: .7rem; box-shadow: 0 20px 60px #000a; }
    #sharer::backdrop { background: #000a; }
    #sharer h2 { margin: 0 0 .2rem; font-size: 1.15rem; overflow-wrap: anywhere; }
    #sharer .tabs { margin-top: 1rem; }
    #sharer .sh-panel { padding: 1rem 0 .2rem; }
    #sharer .sh-row { display: flex; gap: .5rem; }
    #sharer .sh-row input { flex: 1; min-width: 0; }
    #sharer .sh-code { display: grid; place-items: center; overflow-x: auto; padding: .6rem; background: #fff; border-radius: .5rem; }
    #sharer canvas { display: block; width: 100%; max-width: 18rem; height: auto; image-rendering: pixelated; }
    #sharer canvas.wide { max-width: none; min-width: 100%; }
    #sharer .sh-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: 1rem; }
    #sharer .sh-actions .grow { margin-left: auto; }`;
  document.head.append(css);

  let dlg, titleEl, urlEl, expEl, noteEl, qrCv, barCv, dlBtn, tabs, panels;
  let cur = null, tab = "link";

  function build() {
    dlg = el("dialog");
    dlg.id = "sharer";
    titleEl = el("h2");
    expEl = el("p", "hint");
    expEl.style.margin = "0";
    tabs = el("div", "tabs");
    tabs.setAttribute("role", "tablist");
    for (const [id, label] of [["link", "Link"], ["qr", "QR code"], ["bar", "Barcode"]]) {
      const b = el("button", "tab", label);
      b.type = "button"; b.dataset.tab = id; b.setAttribute("role", "tab");
      tabs.append(b);
    }
    const link = el("div", "sh-panel"), row = el("div", "sh-row");
    urlEl = el("input"); urlEl.type = "text"; urlEl.readOnly = true; urlEl.setAttribute("aria-label", "Share link");
    const copy = el("button", "btn primary", "Copy link");
    copy.type = "button"; copy.dataset.act = "copy";
    row.append(urlEl, copy);
    link.append(row, el("p", "hint", "Anyone with this link can download the file, without signing in."));
    const qr = el("div", "sh-panel"), qrBox = el("div", "sh-code");
    qrCv = el("canvas"); qrBox.append(qrCv);
    qr.append(qrBox, el("p", "hint", "Scan the code to open the download page."));
    const bar = el("div", "sh-panel"), barBox = el("div", "sh-code");
    barCv = el("canvas", "wide"); barBox.append(barCv);
    bar.append(barBox, el("p", "hint", "A Code 128 barcode of the link. Use a barcode scanner that opens links; it takes you to the download page."));
    panels = { link, qr, bar };
    noteEl = el("p", "status");
    noteEl.setAttribute("role", "status");
    const actions = el("div", "sh-actions");
    dlBtn = el("button", "btn", "Save image");
    dlBtn.type = "button"; dlBtn.dataset.act = "image";
    const stop = el("button", "btn", "Stop sharing"), close = el("button", "btn grow", "Close");
    stop.type = close.type = "button";
    stop.dataset.act = "stop"; close.dataset.act = "close";
    actions.append(dlBtn, stop, close);
    dlg.append(titleEl, expEl, tabs, link, qr, bar, noteEl, actions);
    document.body.append(dlg);
    dlg.addEventListener("click", (e) => {
      const t = e.target.closest("[data-tab]"), a = e.target.closest("[data-act]");
      if (t) return select(t.dataset.tab);
      if (!a) return;
      run(() => act(a.dataset.act));
    });
  }

  const say = (text, error) => { noteEl.textContent = text; noteEl.classList.toggle("error", !!error); };
  async function run(fn) { try { await fn(); } catch (err) { say(err.message || String(err), true); } }

  async function drawQr(url) {
    const q = (await lib("qr"))(0, "M");
    q.addData(url); q.make();
    const n = q.getModuleCount(), cell = 8, margin = 4, size = (n + margin * 2) * cell;
    qrCv.width = qrCv.height = size;
    const x = qrCv.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, size, size);
    x.fillStyle = "#000";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) x.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
  }
  async function drawBar(url) {
    (await lib("bar"))(barCv, url, { format: "CODE128", width: 2, height: 100, margin: 20, displayValue: false, background: "#ffffff", lineColor: "#000000" });
  }

  async function select(name) {
    tab = name;
    tabs.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    for (const [k, p] of Object.entries(panels)) p.hidden = k !== name;
    dlBtn.hidden = name === "link";
    say("");
    if (!cur) return;
    try {
      if (name === "qr") await drawQr(cur.url);
      else if (name === "bar") await drawBar(cur.url);
    } catch (err) { say(err.message || "Could not draw that.", true); }
  }

  async function act(what) {
    if (what === "close") return dlg.close();
    if (what === "copy") {
      try { await navigator.clipboard.writeText(urlEl.value); }
      catch { urlEl.select(); document.execCommand("copy"); }
      return say("Link copied.");
    }
    if (what === "image") {
      const cv = tab === "qr" ? qrCv : barCv;
      const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
      if (!blob) throw new Error("Could not save the image.");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${tab === "qr" ? "qr" : "barcode"}-${cur.name}.png`.replace(/[\\/:*?"<>|]/g, "_");
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      return;
    }
    if (what === "stop") {
      if (!confirm("Stop sharing this file? The link, QR code and barcode will stop working.")) return;
      await window.Options.json(API + "/share/stop", { id: cur.id });
      dlg.close();
      const s = document.getElementById("status");
      if (s) { s.textContent = `Stopped sharing “${cur.name}”.`; s.classList.remove("error"); }
    }
  }

  async function open(id, name) {
    if (!dlg) build();
    cur = null;
    titleEl.textContent = `Share “${name}”`;
    expEl.textContent = "";
    urlEl.value = "";
    say("Creating the link…");
    await select("link");
    say("Creating the link…");
    dlg.showModal();
    try {
      const d = await window.Options.json(API + "/share", { id });
      cur = { id, name, url: location.origin + d.path };
      urlEl.value = cur.url;
      expEl.textContent = "Works until " + new Date(d.expires * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) + " (24 hours after it was created).";
      say("");
      urlEl.select();
    } catch (err) { say(err.message || String(err), true); }
  }

  // ---------- a Share button on every file row ----------
  function decorate() {
    rows.querySelectorAll("tr").forEach((tr) => {
      if (tr.dataset.dir === "1" || tr.querySelector(".share-btn")) return;
      const ac = tr.querySelector("td.ac"), dl = ac && ac.querySelector("a");
      if (!dl) return;
      const b = el("button", "btn small share-btn", "Share");
      b.type = "button";
      b.title = "Share with a link, QR code or barcode";
      dl.after(b);
    });
  }
  new MutationObserver(decorate).observe(rows, { childList: true });
  decorate();
  rows.addEventListener("click", (e) => {
    const b = e.target.closest(".share-btn");
    if (!b) return;
    const tr = b.closest("tr"), a = tr.querySelector(".nm a");
    run(() => open(tr.dataset.id, a ? a.title : "file"));
  });
})();
