// Page script for pages/printing.html. Each file is uploaded and converted to PDF at once (/api/print/prepare). The preview
// and the real print are made by the same layout code on the server (processing/printing.py), so the preview is what comes out.
(function () {
  const $ = (s) => document.querySelector(s);
  const api = window.Options;
  const status = $("#status"), sel = $("#printer"), queueEl = $("#queue");
  const MAX = 50 * 1024 * 1024;
  const say = (text, error) => { status.textContent = text; status.classList.toggle("error", !!error); };
  const fmtSize = (n) => (n < 1048576 ? (n / 1024).toFixed(0) + " KB" : (n / 1048576).toFixed(1) + " MB");
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const store = {
    get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };
  async function run(fn) { try { await fn(); } catch (err) { say(err.message || String(err), true); } }

  // queue item: {id, file, state: "prep" | "ready" | "run" | "done" | "failed", text, sid (server id), pages}
  let queue = [], seq = 0, busy = false, printers = [], current = null, sheet = 0, sheets = 1;
  const opt = { place: "c", rotate: 0 };

  // ---------- printers ----------
  function paintPrinter() {
    const p = printers.find((x) => x.name === sel.value);
    $("#printer-state").textContent = !p ? "" : `${p.info ? p.info + ". " : ""}Status: ${p.accepting ? p.state : "not accepting jobs"}${p.reasons.length ? " (" + p.reasons.join(", ") + ")" : ""}.`;
  }
  async function loadPrinters() {
    const d = await api.json("/api/print/printers");
    printers = d.printers;
    const keep = store.get("print-printer");
    sel.replaceChildren(...printers.map((p) => new Option(p.name + (p.default ? " (default)" : ""), p.name)));
    const last = printers.find((p) => p.name === keep) || printers.find((p) => p.default) || printers[0];
    if (last) sel.value = last.name;
    paintPrinter();
    if (!d.office) $("#printer-state").textContent += " Word, Excel and PowerPoint files need LibreOffice on the server.";
  }
  sel.addEventListener("change", () => { store.set("print-printer", sel.value); paintPrinter(); run(loadJobs); });
  $("#refresh").addEventListener("click", () => run(async () => { say(""); await loadPrinters(); await loadJobs(); }));

  // ---------- layout options ----------
  const options = () => ({
    paper: $("#paper").value, orient: $("#orient").value, scale: $("#scale").value, zoom: parseFloat($("#zoom").value) || 100,
    place: opt.place, rotate: opt.rotate, margin: $("#margin").value.trim(), nup: +$("#nup").value, pages: $("#pages").value.trim(),
  });
  function paintOptions() {
    $("#zoom-wrap").hidden = $("#scale").value !== "custom";
    $("#rot-label").textContent = opt.rotate + "°";
    document.querySelectorAll("#place button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.p === opt.place)));
  }
  let timer = 0;
  function changed(now) { paintOptions(); sheet = 0; clearTimeout(timer); timer = setTimeout(() => run(preview), now ? 0 : 300); }
  for (const id of ["paper", "orient", "scale", "nup"]) $("#" + id).addEventListener("change", () => changed(true));
  for (const id of ["zoom", "margin", "pages"]) $("#" + id).addEventListener("input", () => changed(false));
  $("#place").addEventListener("click", (e) => { const b = e.target.closest("button[data-p]"); if (b) { opt.place = b.dataset.p; changed(true); } });
  $("#rot-r").addEventListener("click", () => { opt.rotate = (opt.rotate + 90) % 360; changed(true); });
  $("#rot-l").addEventListener("click", () => { opt.rotate = (opt.rotate + 270) % 360; changed(true); });
  $("#reset").addEventListener("click", () => {
    $("#paper").value = "a4"; $("#orient").value = "auto"; $("#scale").value = "auto"; $("#zoom").value = "100";
    $("#margin").value = ""; $("#nup").value = "1"; $("#pages").value = ""; $("#copies").value = "1";
    opt.place = "c"; opt.rotate = 0; changed(true);
  });
  $("#prev").addEventListener("click", () => { if (sheet > 0) { sheet--; run(preview); } });
  $("#next").addEventListener("click", () => { if (sheet < sheets - 1) { sheet++; run(preview); } });

  // ---------- preview ----------
  let pv = 0;
  async function preview() {
    const img = $("#sheet-img"), wait = $("#sheet-wait");
    if (!current || current.state === "prep" || current.state === "failed" || !current.sid) {
      img.hidden = true; wait.hidden = false;
      wait.textContent = !current ? "Select a file." : current.state === "failed" ? current.text : "Preparing…";
      $("#sheet-label").textContent = $("#sheet-info").textContent = "";
      return;
    }
    const my = ++pv;
    img.classList.add("stale");
    let d;
    try { d = await api.json("/api/print/preview", { id: current.sid, options: options(), sheet }); }
    catch (err) {
      if (my !== pv) return;
      if (/no longer on the server/.test(err.message)) { await prepare(current); return preview(); }   // the server forgot it: send it again
      img.classList.remove("stale");
      $("#sheet-info").textContent = err.message;
      $("#sheet-info").classList.add("error");
      return;
    }
    if (my !== pv) return;
    sheets = d.sheets; sheet = d.sheet;
    img.src = d.image; img.hidden = false; img.classList.remove("stale"); wait.hidden = true;
    $("#sheet-info").classList.remove("error");
    $("#sheet-info").textContent = d.info;
    $("#sheet-label").textContent = `Sheet ${sheet + 1} of ${sheets}`;
    $("#prev").disabled = sheet === 0; $("#next").disabled = sheet >= sheets - 1;
  }

  // ---------- the list of files ----------
  function renderQueue() {
    $("#queue-box").hidden = $("#layout-box").hidden = !queue.length;
    queueEl.replaceChildren(...queue.map((q) => {
      const li = el("li", q.state + (q === current ? " on" : "")), name = el("span", "qname", q.file.name), st = el("span", "qstate", q.text || fmtSize(q.file.size));
      li.dataset.id = q.id; name.title = q.file.name;
      li.append(name, st);
      if (q.state !== "run") {
        const x = el("button", "btn small", "✕");
        x.type = "button"; x.title = x.ariaLabel = "Remove " + q.file.name; x.dataset.rm = q.id;
        li.append(x);
      }
      return li;
    }));
    $("#print").disabled = busy || !queue.some((q) => q.state === "ready");
  }
  queueEl.addEventListener("click", (e) => {
    const rm = e.target.closest("button[data-rm]");
    if (rm) {
      const gone = queue.find((q) => q.id === +rm.dataset.rm);
      queue = queue.filter((q) => q !== gone);
      if (gone === current) { current = queue[0] || null; sheet = 0; run(preview); }
      return renderQueue();
    }
    const li = e.target.closest("li[data-id]");
    const q = li && queue.find((x) => x.id === +li.dataset.id);
    if (q && q !== current) { current = q; sheet = 0; renderQueue(); run(preview); }
  });
  $("#clear").addEventListener("click", () => { if (!busy) { queue = []; current = null; renderQueue(); say(""); run(preview); } });

  async function prepare(q) {
    q.state = "prep"; q.text = "Converting…"; renderQueue();
    const fd = new FormData();
    fd.append("file", q.file, q.file.name);
    try {
      const r = await api.json("/api/print/prepare", fd);
      q.sid = r.id; q.pages = r.pages; q.state = "ready";
      q.text = `${r.kind === "image" ? "Picture" : r.pages + " page" + (r.pages === 1 ? "" : "s")}, ${fmtSize(q.file.size)}`;
    } catch (err) { q.state = "failed"; q.sid = null; q.text = err.message; }
    renderQueue();
  }
  async function add(list) {
    const skipped = [], fresh = [];
    for (const file of list) {
      if (file.size > MAX) { skipped.push(`${file.name} (over ${fmtSize(MAX)})`); continue; }
      const q = { id: ++seq, file, state: "prep", text: "", sid: null, pages: 0 };
      queue.push(q); fresh.push(q);
    }
    if (!current && fresh.length) current = fresh[0];
    renderQueue();
    say(skipped.length ? "Skipped: " + skipped.join(", ") : "", !!skipped.length);
    for (const q of fresh) { await prepare(q); if (q === current) await run(preview); }
  }

  // ---------- printing ----------
  $("#print").addEventListener("click", () => run(async () => {
    if (busy) return;
    if (!sel.value) throw new Error("There is no printer to print on.");
    const copies = parseInt($("#copies").value, 10);
    if (!(copies >= 1 && copies <= 99)) throw new Error("Copies must be between 1 and 99.");
    busy = true;
    say("Sending…");
    let ok = 0, failed = 0;
    try {
      for (const q of queue.filter((x) => x.state === "ready")) {
        q.state = "run"; q.text = "Sending…"; renderQueue();
        const body = () => ({ id: q.sid, printer: sel.value, copies, options: options() });
        try {
          let r;
          try { r = await api.json("/api/print/submit", body()); }
          catch (err) { if (!/no longer on the server/.test(err.message)) throw err; await prepare(q); q.state = "run"; r = await api.json("/api/print/submit", body()); }
          q.state = "done"; q.text = `Sent as job ${r.job ?? ""} (${r.sheets} sheet${r.sheets === 1 ? "" : "s"}).`; ok++;
        } catch (err) { q.state = "ready"; q.text = err.message; failed++; q.err = true; }
        renderQueue();
      }
    } finally { busy = false; renderQueue(); }
    say(failed ? `${ok} sent, ${failed} failed.` : `${ok} file${ok === 1 ? "" : "s"} sent to ${sel.value}.`, !!failed);
    await loadJobs();
  }));

  // ---------- jobs ----------
  async function loadJobs() {
    if (!sel.value) return;
    const d = await api.json("/api/print/jobs?printer=" + encodeURIComponent(sel.value));
    $("#jobs").replaceChildren(...d.jobs.map((j) => {
      const li = el("li"), name = el("span", "jname", `#${j.id} ${j.name}`);
      name.title = j.name;
      const when = j.created ? new Date(j.created * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      li.append(name, el("span", "jstate", [j.state, when].filter(Boolean).join(" · ")));
      if (["waiting", "held", "printing", "stopped"].includes(j.state)) {
        const x = el("button", "btn small", "Cancel");
        x.type = "button"; x.dataset.job = j.id;
        li.append(x);
      }
      return li;
    }));
  }
  $("#jobs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-job]");
    if (b) run(async () => { await api.json(`/api/print/jobs/${b.dataset.job}/cancel`, { printer: sel.value }); await loadJobs(); });
  });
  $("#jobs-refresh").addEventListener("click", () => run(loadJobs));
  setInterval(() => { if (!document.hidden) loadJobs().catch(() => {}); }, 5000);

  // ---------- adding files ----------
  $("#picker").addEventListener("change", (e) => { const l = [...e.target.files]; e.target.value = ""; run(() => add(l)); });
  const drop = $("#drop"), hasFiles = (e) => e.dataTransfer?.types?.includes("Files");
  let depth = 0;
  document.addEventListener("dragenter", (e) => { if (hasFiles(e)) { depth++; drop.classList.add("over"); } });
  document.addEventListener("dragleave", (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; drop.classList.remove("over"); } });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault(); depth = 0; drop.classList.remove("over");
    if (e.dataTransfer.files.length) run(() => add([...e.dataTransfer.files]));
  });
  document.addEventListener("paste", (e) => { if (e.clipboardData?.files.length) { e.preventDefault(); run(() => add([...e.clipboardData.files])); } });

  paintOptions();
  renderQueue();
  run(async () => { await loadPrinters(); await loadJobs(); });
})();
