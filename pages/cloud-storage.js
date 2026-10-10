// Page script for pages/cloud-storage.html. Browsing, folders and downloads are plain requests to /api/storage
// (storage.py). Files up to 32 MB go up in one request; bigger ones are sent in 16 MB pieces that can resume.
(function () {
  const $ = (s) => document.querySelector(s);
  const API = "/api/storage";
  const CHUNK = 16 * 1024 * 1024, DIRECT = 32 * 1024 * 1024, PARALLEL = 3;
  const status = $("#status"), rows = $("#rows");

  // ---------- helpers ----------
  const say = (text, error) => { status.textContent = text; status.classList.toggle("error", !!error); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const fmtSize = (n) => {
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(n < 10 ? 2 : 1) : n) + " " + u[i];
  };
  const fmtDate = (t) => new Date(t * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const post = (path, body) => window.Options.json(API + path, body);
  async function run(fn) {
    status.classList.remove("error");
    try { await fn(); } catch (err) { if (!err.cancelled) say(err.message || String(err), true); }
  }

  // ---------- the folder on screen ----------
  let dir = "", data = null;
  const selected = new Set();

  async function load(id = dir, keepSelection) {
    const d = await window.Options.json(`${API}/list?parent=${encodeURIComponent(id)}`);
    dir = id; data = d;
    if (!keepSelection) selected.clear();
    for (const s of [...selected]) if (!d.items.some((i) => i.id === s)) selected.delete(s);
    render();
  }
  const hashId = () => { const h = location.hash.slice(1); return /^[0-9a-f]{0,32}$/.test(h) ? h : ""; };
  const openHash = () => run(async () => {
    try { await load(hashId()); }
    catch (err) {
      if (!hashId()) throw err;                       // that folder is gone: go to the top
      history.replaceState(null, "", location.pathname);
      await load("");
    }
  });
  addEventListener("hashchange", openHash);

  function render() {
    const { used, held, limit, items, path } = data;
    const pct = Math.min(100, ((used + held) / limit) * 100);
    $("#bar").style.width = pct + "%";
    $("#bar").parentElement.classList.toggle("full", pct > 90);
    $("#usage").textContent = `${fmtSize(used)} used of ${fmtSize(limit)}` +
      (held ? ` (${fmtSize(held)} reserved for uploads in progress)` : "") +
      `. ${fmtSize(Math.max(0, limit - used - held))} free.`;

    const nav = $("#crumbs");
    nav.replaceChildren();
    const crumb = (label, id, last) => {
      if (nav.childNodes.length) nav.append(el("span", "sep", "/"));
      if (last) return nav.append(el("strong", "", label));
      const a = el("a", "", label);
      a.href = "#" + id;
      nav.append(a);
    };
    crumb("Cloud storage", "", !path.length);
    path.forEach((p, i) => crumb(p.name, p.id, i === path.length - 1));

    $("#empty").hidden = items.length > 0;
    $("#listing").hidden = !items.length;
    rows.replaceChildren(...items.map(row));
    updateSelection();
  }

  function row(it) {
    const tr = el("tr");
    tr.dataset.id = it.id;
    const c0 = el("td", "chk"), box = el("input");
    box.type = "checkbox"; box.checked = selected.has(it.id); box.dataset.act = "sel";
    box.setAttribute("aria-label", "Select " + it.name);
    c0.append(box);

    const c1 = el("td", "nm"), a = el("a", "", (it.is_dir ? "📁 " : "📄 ") + it.name);
    a.title = it.name;
    if (it.is_dir) a.href = "#" + it.id;
    else { a.href = `${API}/download/${it.id}?inline=1`; a.target = "_blank"; a.rel = "noopener"; }
    c1.append(a);

    const c4 = el("td", "ac");
    const dl = el("a", "btn small", "Download");
    dl.href = `${API}/download/${it.id}`;
    if (it.is_dir) dl.title = "Download the folder as a .zip";
    const rn = el("button", "btn small", "Rename"), rm = el("button", "btn small", "Delete");
    rn.type = rm.type = "button";
    rn.dataset.act = "rename"; rm.dataset.act = "delete";
    c4.append(dl, rn, rm);

    tr.append(c0, c1, el("td", "sz", it.is_dir ? "–" : fmtSize(it.size)), el("td", "dt", fmtDate(it.created)), c4);
    return tr;
  }

  function updateSelection() {
    const n = selected.size;
    $("#selbar").hidden = !n;
    $("#selcount").textContent = `${n} selected`;
    const all = $("#all");
    all.checked = !!data && data.items.length > 0 && n === data.items.length;
    all.indeterminate = n > 0 && !all.checked;
  }

  rows.addEventListener("change", (e) => {
    if (e.target.dataset.act !== "sel") return;
    const id = e.target.closest("tr").dataset.id;
    if (e.target.checked) selected.add(id); else selected.delete(id);
    updateSelection();
  });
  $("#all").addEventListener("change", (e) => {
    selected.clear();
    if (e.target.checked) data.items.forEach((i) => selected.add(i.id));
    rows.querySelectorAll('input[data-act="sel"]').forEach((b) => { b.checked = e.target.checked; });
    updateSelection();
  });
  $("#sel-clear").addEventListener("click", () => {
    selected.clear();
    rows.querySelectorAll('input[data-act="sel"]').forEach((b) => { b.checked = false; });
    updateSelection();
  });

  // ---------- rename, delete, new folder, move ----------
  async function rename(it) {
    const name = prompt("New name", it.name);
    if (name === null || !name.trim() || name === it.name) return;
    await post("/rename", { id: it.id, name });
    await load(dir, true);
    say("Renamed.");
  }
  async function remove(ids, label) {
    const what = ids.length === 1 ? `“${label}”` : `${ids.length} items`;
    if (!confirm(`Delete ${what}? Folders are deleted with everything inside. This cannot be undone.`)) return;
    await post("/delete", { ids });
    await load(dir);
    say("Deleted.");
  }
  rows.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const it = data.items.find((i) => i.id === b.closest("tr").dataset.id);
    if (it) run(() => (b.dataset.act === "rename" ? rename(it) : remove([it.id], it.name)));
  });
  $("#sel-delete").addEventListener("click", () => run(() => remove([...selected])));
  $("#new-folder").addEventListener("click", () => run(async () => {
    const name = prompt("Folder name");
    if (!name || !name.trim()) return;
    await post("/folder", { parent: dir, name });
    await load(dir, true);
    say("Folder created.");
  }));

  const mover = $("#mover"), moveTo = $("#move-to");
  $("#sel-move").addEventListener("click", () => run(async () => {
    const { folders } = await window.Options.json(API + "/folders");
    const by = new Map(folders.map((f) => [f.id, f]));
    const label = (id) => { const p = []; for (let f = by.get(id); f; f = by.get(f.parent)) p.unshift(f.name); return "/" + p.join("/"); };
    const blocked = (id) => { for (let f = by.get(id); f; f = by.get(f.parent)) if (selected.has(f.id)) return true; return false; };
    const choices = folders.filter((f) => f.id !== dir && !blocked(f.id)).map((f) => [f.id, label(f.id)]).sort((a, b) => a[1].localeCompare(b[1]));
    if (dir) choices.unshift(["", "/ (top level)"]);
    if (!choices.length) return say("There is no other folder to move these into.", true);
    moveTo.replaceChildren(...choices.map(([id, text]) => new Option(text, id)));
    mover.showModal();
  }));
  $("#move-cancel").addEventListener("click", () => mover.close());
  $("#move-go").addEventListener("click", () => run(async () => {
    await post("/move", { ids: [...selected], parent: moveTo.value });
    mover.close();
    await load(dir);
    say("Moved.");
  }));

  // ---------- uploading ----------
  const jobs = [];
  let active = 0, dirCache = new Map(), refreshTimer = 0;

  function xhrPut(url, body, job, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("PUT", url);
      x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
      x.onload = () => {
        let d = {};
        try { d = JSON.parse(x.responseText); } catch { /* not JSON */ }
        if (x.status >= 200 && x.status < 300) return resolve(d);
        if (x.status === 401) location.reload();
        reject(Object.assign(new Error(d.error || `The server could not accept that (${x.status}).`), { status: x.status, data: d }));
      };
      x.onerror = () => reject(Object.assign(new Error("The connection was lost."), { network: true }));
      x.onabort = () => reject(Object.assign(new Error("Cancelled."), { cancelled: true }));
      job.xhr = x;
      x.send(body);
    });
  }

  function ensureDir(parent, segs) {
    if (!segs.length) return Promise.resolve(parent);
    const key = parent + "/" + segs.join("/");
    if (!dirCache.has(key)) {
      dirCache.set(key, ensureDir(parent, segs.slice(0, -1)).then(async (pid) =>
        (await post("/folder", { parent: pid, name: segs[segs.length - 1], exist_ok: true })).id));
    }
    return dirCache.get(key);
  }

  function progress(j, sent) {
    j.bar.value = j.file.size ? (sent / j.file.size) * 100 : 100;
    j.state_.textContent = `${fmtSize(sent)} of ${fmtSize(j.file.size)}`;
  }
  function finish(j, state, text) {
    j.state = state;
    j.li.className = state;
    j.state_.textContent = text;
    j.cancelBtn.hidden = true;
    if (state === "done") setTimeout(() => { if (j.li.isConnected) j.li.remove(); dropJob(j); }, 5000);
  }
  function dropJob(j) {
    const i = jobs.indexOf(j);
    if (i >= 0) jobs.splice(i, 1);
    if (!jobs.length) $("#uploads-box").hidden = true;
  }

  async function sendDirect(j, parent) {
    const url = `${API}/file?parent=${encodeURIComponent(parent)}&name=${encodeURIComponent(j.name)}`;
    for (let attempt = 1; ; attempt++) {
      try { return await xhrPut(url, j.file, j, (n) => progress(j, n)); }
      catch (err) {
        if (!err.network || j.cancelled || attempt >= 3) throw err;
        await sleep(1000 * attempt);
      }
    }
  }
  async function sendChunked(j, parent) {
    const size = j.file.size;
    const { id } = await post("/upload", { parent, name: j.name, size });
    try {
      let offset = 0, fails = 0;
      while (offset < size) {
        const end = Math.min(size, offset + CHUNK), start = offset;
        try {
          await xhrPut(`${API}/upload/${id}?offset=${start}`, j.file.slice(start, end), j, (n) => progress(j, start + n));
          offset = end; fails = 0;
        } catch (err) {
          if (err.cancelled || j.cancelled || ++fails > 5) throw err;
          await sleep(1000 * fails);
          try { offset = (await window.Options.json(`${API}/upload/${id}`)).received; } catch { /* retry from the same spot */ }
        }
      }
      await post(`/upload/${id}/finish`, {});
    } catch (err) {
      fetch(`${API}/upload/${id}`, { method: "DELETE", credentials: "same-origin" }).catch(() => {});
      throw err;
    }
  }

  async function uploadJob(j) {
    try {
      const parent = await ensureDir(j.parent, j.segs);
      if (j.cancelled) throw Object.assign(new Error("Cancelled."), { cancelled: true });
      if (j.file.size <= DIRECT) await sendDirect(j, parent); else await sendChunked(j, parent);
      finish(j, "done", "Done");
    } catch (err) {
      if (err.cancelled) finish(j, "cancelled", "Cancelled"); else finish(j, "failed", err.message);
    }
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => run(() => load(dir, true)), 600);
  }
  function pump() {
    while (active < PARALLEL) {
      const j = jobs.find((x) => x.state === "wait");
      if (!j) return;
      j.state = "run"; active++;
      uploadJob(j).finally(() => { active--; pump(); });
    }
  }

  function enqueue(list) {
    if (!list.length) return;
    dirCache = new Map();
    const parent = dir;
    for (const { file, path } of list) {
      const segs = path.split("/").filter(Boolean), name = segs.pop() || file.name;
      const j = { file, name, segs, parent, state: "wait" };
      j.li = el("li");
      j.bar = el("progress"); j.bar.max = 100; j.bar.value = 0;
      j.state_ = el("span", "ustate", "Waiting");
      j.cancelBtn = el("button", "btn small", "Cancel");
      j.cancelBtn.type = "button";
      j.cancelBtn.addEventListener("click", () => {
        if (j.state === "wait") finish(j, "cancelled", "Cancelled");
        else { j.cancelled = true; j.xhr?.abort(); }
      });
      const full = [...segs, name].join("/");
      const label = el("span", "uname", full);
      label.title = `${full} (${fmtSize(file.size)})`;
      j.li.append(label, j.cancelBtn, j.bar, j.state_);
      $("#uploads").append(j.li);
      jobs.push(j);
    }
    $("#uploads-box").hidden = false;
    pump();
  }
  $("#clear-done").addEventListener("click", () => {
    for (const j of [...jobs]) if (["done", "failed", "cancelled"].includes(j.state)) { j.li.remove(); dropJob(j); }
  });
  addEventListener("beforeunload", (e) => { if (jobs.some((j) => j.state === "wait" || j.state === "run")) e.preventDefault(); });

  // ---------- choosing and dropping ----------
  $("#upload-files").addEventListener("click", () => $("#picker").click());
  $("#upload-dir").addEventListener("click", () => $("#dirpicker").click());
  $("#picker").addEventListener("change", (e) => {
    const list = [...e.target.files].map((file) => ({ file, path: file.name }));
    e.target.value = "";
    enqueue(list);
  });
  $("#dirpicker").addEventListener("change", (e) => {
    const list = [...e.target.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
    e.target.value = "";
    enqueue(list);
  });

  async function walk(entry, prefix, out) {
    if (entry.isFile) {
      out.push({ file: await new Promise((res, rej) => entry.file(res, rej)), path: prefix + entry.name });
      return;
    }
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const child of batch) await walk(child, prefix + entry.name + "/", out);
    } while (batch.length);
  }

  const drop = $("#drop");
  const hasFiles = (e) => e.dataTransfer?.types?.includes("Files");
  let depth = 0;
  document.addEventListener("dragenter", (e) => { if (hasFiles(e)) { depth++; drop.classList.add("over"); } });
  document.addEventListener("dragleave", (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; drop.classList.remove("over"); } });
  document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    drop.classList.remove("over");
    // Read the entries now: the browser empties the drop data once this handler returns.
    const entries = [...(e.dataTransfer.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    const plain = [...e.dataTransfer.files].map((file) => ({ file, path: file.name }));
    if (!entries.length) return enqueue(plain);
    run(async () => {
      const out = [];
      for (const entry of entries) await walk(entry, "", out);
      enqueue(out);
    });
  });

  openHash();
})();
