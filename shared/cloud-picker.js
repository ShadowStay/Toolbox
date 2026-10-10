// "Open from cloud storage" for any page that has a file input.
// Add to a page, after site.js:  <script src="/shared/cloud-picker.js" data-target="#picker"></script>
//   data-target   CSS selector of the page's <input type="file"> (default #picker)
//   data-max-mb   files larger than this are shown but can't be ticked (default 300)
// It adds a button after the input's drop zone. Picked files are downloaded into the browser and handed to the page
// exactly as if they had been chosen from the computer, so the page needs no changes.
(function () {
  const script = document.currentScript;
  const target = document.querySelector((script && script.dataset.target) || "#picker");
  if (!target) return;
  const MAX = (Number(script && script.dataset.maxMb) || 300) * 1024 * 1024;
  const API = "/api/storage";

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

  // ---------- styles (kept here so the page's own stylesheet stays untouched) ----------
  const css = document.createElement("style");
  css.textContent = `
    .cloud-open { margin: 0 0 .75rem; }
    #cloud-picker { width: min(34rem, 94vw); max-height: 85vh; padding: 1.25rem; color: var(--moon, #f1e9ff); background: var(--dusk, #22123b); border: 1px solid var(--amethyst, #8a5bd8); border-radius: .7rem; }
    #cloud-picker::backdrop { background: #000a; }
    #cloud-picker h2 { margin: 0 0 .75rem; font-size: 1.1rem; }
    #cloud-picker .cp-path { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem; margin-bottom: .6rem; font-size: .9rem; }
    #cloud-picker .cp-path button { padding: 0; font: inherit; color: var(--orchid, #c9a2ff); background: none; border: 0; text-decoration: underline; cursor: pointer; }
    #cloud-picker .cp-list { list-style: none; margin: 0; padding: 0; max-height: 45vh; overflow: auto; background: #140b22; border: 1px solid #8a5bd855; border-radius: .5rem; }
    #cloud-picker .cp-list li { display: flex; align-items: center; gap: .6rem; padding: .4rem .7rem; border-bottom: 1px solid #8a5bd822; }
    #cloud-picker .cp-list li:last-child { border-bottom: 0; }
    #cloud-picker .cp-list label, #cloud-picker .cp-list button.dir { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #cloud-picker .cp-list button.dir { padding: 0; font: inherit; color: inherit; text-align: left; background: none; border: 0; cursor: pointer; }
    #cloud-picker .cp-list label { display: flex; align-items: center; gap: .5rem; cursor: pointer; }
    #cloud-picker .cp-list li.off { opacity: .5; }
    #cloud-picker .cp-list input { accent-color: var(--amethyst, #8a5bd8); }
    #cloud-picker .cp-size { flex: none; font-size: .8rem; color: #d9cbf2; font-variant-numeric: tabular-nums; }
    #cloud-picker .cp-empty { padding: 1rem; color: #d9cbf2; }
    #cloud-picker .cp-note { min-height: 1.4rem; margin: .6rem 0 0; font-size: .9rem; color: var(--orchid, #c9a2ff); }
    #cloud-picker .cp-note.error { color: #ff9fb3; }
    #cloud-picker .cp-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .75rem; }`;
  document.head.append(css);

  // ---------- button ----------
  const row = el("div", "actions cloud-open");
  const openBtn = el("button", "btn", "Open from cloud storage");
  openBtn.type = "button";
  row.append(openBtn);
  (target.closest("label") || target).insertAdjacentElement("afterend", row);

  // ---------- dialog (built on first use) ----------
  let dialog, pathEl, listEl, noteEl, goBtn;
  let dir = "";
  const picked = new Map();                               // id -> item, kept while you move between folders

  const say = (text, error) => { noteEl.textContent = text; noteEl.classList.toggle("error", !!error); };

  function build() {
    dialog = el("dialog");
    dialog.id = "cloud-picker";
    pathEl = el("nav", "cp-path");
    listEl = el("ul", "cp-list");
    noteEl = el("p", "cp-note");
    noteEl.setAttribute("role", "status");
    goBtn = el("button", "btn primary", "Open");
    goBtn.type = "button";
    const cancel = el("button", "btn", "Cancel");
    cancel.type = "button";
    const actions = el("div", "cp-actions");
    actions.append(goBtn, cancel);
    dialog.append(el("h2", "", "Open from cloud storage"), pathEl, listEl, noteEl, actions);
    document.body.append(dialog);
    cancel.addEventListener("click", () => dialog.close());
    goBtn.addEventListener("click", importPicked);
  }

  function updateGo() {
    goBtn.textContent = picked.size ? `Open ${picked.size} file${picked.size === 1 ? "" : "s"}` : "Open";
    goBtn.disabled = !picked.size;
  }

  async function list(id) {
    say("Loading…");
    let d;
    try {
      const r = await fetch(`${API}/list?parent=${encodeURIComponent(id)}`, { credentials: "same-origin" });
      if (r.status === 401) return location.reload();
      d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not read the folder.");
    } catch (err) {
      if (id) return list("");                            // the folder is gone: start from the top
      return say(err.message || "Could not reach the server.", true);
    }
    dir = id;
    say("");

    pathEl.replaceChildren();
    const crumb = (label, to, last) => {
      if (pathEl.childNodes.length) pathEl.append(el("span", "", "/"));
      if (last) return pathEl.append(el("strong", "", label));
      const b = el("button", "", label);
      b.type = "button";
      b.addEventListener("click", () => list(to));
      pathEl.append(b);
    };
    crumb("Cloud storage", "", !d.path.length);
    d.path.forEach((p, i) => crumb(p.name, p.id, i === d.path.length - 1));

    if (!d.items.length) {
      listEl.replaceChildren(el("li", "cp-empty", "This folder is empty."));
      return;
    }
    listEl.replaceChildren(...d.items.map((it) => {
      const li = el("li");
      if (it.is_dir) {
        const b = el("button", "dir", "📁 " + it.name);
        b.type = "button";
        b.addEventListener("click", () => list(it.id));
        li.append(b);
        return li;
      }
      const tooBig = it.size > MAX;
      const label = el("label"), box = el("input");
      box.type = "checkbox";
      box.checked = picked.has(it.id);
      box.disabled = tooBig;
      box.addEventListener("change", () => {
        if (box.checked) picked.set(it.id, it); else picked.delete(it.id);
        updateGo();
      });
      label.append(box, el("span", "", it.name));
      label.title = it.name;
      li.append(label, el("span", "cp-size", tooBig ? `${fmtSize(it.size)} (too big for this page)` : fmtSize(it.size)));
      if (tooBig) li.className = "off";
      return li;
    }));
  }

  async function importPicked() {
    const items = [...picked.values()];
    if (!items.length) return;
    goBtn.disabled = true;
    const files = [];
    try {
      for (const [i, it] of items.entries()) {
        say(`Downloading ${it.name} (${i + 1} of ${items.length})…`);
        const r = await fetch(`${API}/download/${it.id}`, { credentials: "same-origin" });
        if (r.status === 401) return location.reload();
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Could not download ${it.name}.`);
        files.push(new File([await r.blob()], it.name, { type: it.mime || "" }));
      }
    } catch (err) {
      say(err.message || String(err), true);
      goBtn.disabled = false;
      return;
    }
    // Hand the files to the page exactly as if they had been chosen from the computer.
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    target.files = dt.files;
    target.dispatchEvent(new Event("change", { bubbles: true }));
    picked.clear();
    dialog.close();
  }

  openBtn.addEventListener("click", () => {
    if (!dialog) build();
    updateGo();
    dialog.showModal();
    list(dir);
  });
})();
