// Page script for pages/printing.html. Files are staged in a list, then sent one by one to /api/print/submit
// (processing/printing.py), which converts them to PDF and hands them to CUPS. Jobs come from /api/print/jobs.
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

  let queue = [], seq = 0, busy = false, printers = [];

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

  // ---------- the list of files ----------
  function renderQueue() {
    $("#queue-box").hidden = !queue.length;
    queueEl.replaceChildren(...queue.map((q) => {
      const li = el("li", q.state), name = el("span", "qname", q.file.name), st = el("span", "qstate", q.text || fmtSize(q.file.size));
      name.title = q.file.name;
      li.append(name, st);
      if (q.state !== "run") {
        const x = el("button", "btn small", "✕");
        x.type = "button"; x.title = x.ariaLabel = "Remove " + q.file.name; x.dataset.id = q.id;
        li.append(x);
      }
      return li;
    }));
    $("#print").disabled = busy || !queue.some((q) => q.state !== "done");
  }
  queueEl.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-id]");
    if (b) { queue = queue.filter((q) => q.id !== +b.dataset.id); renderQueue(); }
  });
  $("#clear").addEventListener("click", () => { if (!busy) { queue = []; renderQueue(); say(""); } });

  function add(list) {
    const skipped = [];
    for (const file of list) {
      if (file.size > MAX) { skipped.push(`${file.name} (over ${fmtSize(MAX)})`); continue; }
      queue.push({ id: ++seq, file, state: "wait", text: "" });
    }
    renderQueue();
    say(skipped.length ? "Skipped: " + skipped.join(", ") : "", !!skipped.length);
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
      for (const q of queue.filter((x) => x.state !== "done")) {
        q.state = "run"; q.text = "Converting and sending…"; renderQueue();
        const fd = new FormData();
        fd.append("file", q.file, q.file.name);
        fd.append("printer", sel.value);
        fd.append("copies", String(copies));
        fd.append("pages", $("#pages").value.trim());
        fd.append("fit", $("#fit").checked ? "1" : "0");
        try {
          const r = await api.json("/api/print/submit", fd);
          q.state = "done"; q.text = `Sent as job ${r.job ?? ""} (${r.pages} page${r.pages === 1 ? "" : "s"}).`; ok++;
        } catch (err) { q.state = "failed"; q.text = err.message; failed++; }
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
  $("#picker").addEventListener("change", (e) => { const l = [...e.target.files]; e.target.value = ""; add(l); });
  const drop = $("#drop"), hasFiles = (e) => e.dataTransfer?.types?.includes("Files");
  let depth = 0;
  document.addEventListener("dragenter", (e) => { if (hasFiles(e)) { depth++; drop.classList.add("over"); } });
  document.addEventListener("dragleave", (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; drop.classList.remove("over"); } });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault(); depth = 0; drop.classList.remove("over");
    if (e.dataTransfer.files.length) add([...e.dataTransfer.files]);
  });
  document.addEventListener("paste", (e) => { if (e.clipboardData?.files.length) { e.preventDefault(); add([...e.clipboardData.files]); } });

  renderQueue();
  run(async () => { await loadPrinters(); await loadJobs(); });
})();
