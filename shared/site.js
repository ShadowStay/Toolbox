// Site script, loaded on every page. It does four things:
//   1. Options (animations, where to process files, layout) saved in cookies, applied to <html> as data-motion / data-process / data-device.
//   2. The Options dialog, opened from the sidebar.
//   3. The sidebar, built from /api/pages (a signed-out visitor just sees the brand and a Sign in link). On phones it is a top bar with a menu button.
//   4. window.Options.call/json/blob: helpers for pages that send work to the server.
// Cookies (read by app.py too, so the first paint is already right): spells_motion = on|off, spells_process = browser|server,
// spells_nav = open|closed (the sidebar: a narrow strip of icons unless opened; hovering it for 0.75 s pops it out for a moment),
// spells_layout = auto|mobile|desktop (auto: the server looks at the User-Agent; touch tablets that look like desktops are caught below).
(function () {
  const root = document.documentElement;
  const YEAR = 365 * 24 * 3600;
  const cookie = {
    get(name) {
      const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
      return m ? decodeURIComponent(m[1]) : "";
    },
    set(name, value) {
      document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${YEAR}; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
    },
  };
  const opts = {
    motion: cookie.get("spells_motion") === "on" ? "on" : "off",          // animations are off by default
    process: cookie.get("spells_process") === "server" ? "server" : "browser",
    nav: cookie.get("spells_nav") === "open" ? "open" : "closed",              // retracted by default
    layout: ["mobile", "desktop"].includes(cookie.get("spells_layout")) ? cookie.get("spells_layout") : "auto",
  };

  // ---------- phone layout ----------
  // app.py already links /shared/mobile.css and sets data-device for phones. An iPad asks for the desktop site and sends a
  // Mac User-Agent, so on a touch screen of tablet size or smaller the stylesheet is added here instead.
  function isMobile() { return root.dataset.device === "mobile"; }
  function loadMobileCss() {
    if (document.getElementById("mobile-css")) return;
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = "/shared/mobile.css"; l.id = "mobile-css";
    document.head.append(l);
  }
  if (!isMobile() && opts.layout === "auto" && window.matchMedia && matchMedia("(pointer: coarse)").matches
      && Math.min(screen.width, screen.height) <= 900) {
    root.dataset.device = "mobile";
    loadMobileCss();
  }

  const IN_BROWSER = "Everything runs in your browser; nothing is uploaded.";
  const NOTES = {
    browser: [IN_BROWSER, IN_BROWSER],
    server: [
      "Processing happens on the server: your text and images are sent there when you run an action, used for that task and not stored.",
      "Processing happens on the server: files are uploaded and kept there for up to 30 minutes while open, then deleted.",
    ],
  };
  function apply() {
    root.dataset.motion = opts.motion;
    root.dataset.process = opts.process;
    root.dataset.nav = isMobile() ? "open" : opts.nav;      // the phone's top bar has no retracted strip
    document.querySelectorAll(".where").forEach((el) => { el.textContent = NOTES[opts.process][el.hasAttribute("data-files") ? 1 : 0]; });
  }
  function set(patch) {
    Object.assign(opts, patch);
    cookie.set("spells_motion", opts.motion);
    cookie.set("spells_process", opts.process);
    cookie.set("spells_nav", opts.nav);
    cookie.set("spells_layout", opts.layout);
    apply();
    reflect();
    document.dispatchEvent(new CustomEvent("optionschange", { detail: { ...opts } }));
  }

  // ---------- talking to the server ----------
  // call(path)            -> GET
  // call(path, FormData)  -> POST multipart
  // call(path, object)    -> POST JSON
  // Resolves with the Response, or throws an Error whose message is fit to show in a status line.
  async function call(path, body) {
    const init = { credentials: "same-origin" };
    if (body !== undefined) {
      init.method = "POST";
      if (body instanceof FormData) init.body = body;
      else { init.headers = { "Content-Type": "application/json" }; init.body = JSON.stringify(body); }
    }
    let r;
    try { r = await fetch(path, init); }
    catch { throw new Error("Could not reach the server. Try again, or switch to browser processing in Options."); }
    if (r.ok) return r;
    if (r.status === 401) { location.reload(); throw new Error("Your session ended. Sign in again."); }
    let msg = "";
    try { msg = (await r.json()).error; } catch { /* not JSON */ }
    throw new Error(msg || (r.status === 413 ? "That is too large for the server." : `The server could not do that (${r.status}).`));
  }

  // ---------- options dialog (built the first time it is opened) ----------
  const WHERE = [
    ["browser", "In my browser", "Private. Nothing leaves your device."],
    ["server", "On the server", "Uses this site's server. Handles more formats and big files."],
  ];
  const LAYOUT = [
    ["auto", "Automatic", "Phone layout on phones."],
    ["mobile", "Phone", "Always the phone layout."],
    ["desktop", "Desktop", "Always the desktop layout."],
  ];
  let dialog = null;
  function build() {
    dialog = document.createElement("dialog");
    dialog.id = "options";
    dialog.setAttribute("aria-labelledby", "options-title");
    dialog.innerHTML = `
      <h2 id="options-title">Options</h2>
      <fieldset>
        <legend>Process text, images and files</legend>
        <div class="choices">${WHERE.map(([id, name, desc]) => `
          <label class="choice">
            <input type="radio" name="opt-process" value="${id}">
            <strong>${name}</strong><small>${desc}</small>
          </label>`).join("")}
        </div>
      </fieldset>
      <fieldset>
        <legend>Layout</legend>
        <div class="choices three" style="grid-template-columns:repeat(3,1fr)">${LAYOUT.map(([id, name, desc]) => `
          <label class="choice">
            <input type="radio" name="opt-layout" value="${id}">
            <strong>${name}</strong><small>${desc}</small>
          </label>`).join("")}
        </div>
      </fieldset>
      <fieldset>
        <legend>Motion</legend>
        <label class="switch-row">
          <span><strong>Animations</strong><small>Glows, shimmer and hover effects. Off by default.</small></span>
          <input type="checkbox" role="switch" id="opt-motion">
        </label>
      </fieldset>
      <div class="opt-actions"><button class="opt-done" type="button" data-close>Done</button></div>`;
    document.body.append(dialog);
    dialog.addEventListener("change", (e) => {
      if (e.target.name === "opt-process") set({ process: e.target.value });
      else if (e.target.name === "opt-layout") { set({ layout: e.target.value }); location.reload(); }   // the server picks the stylesheet
      else if (e.target.id === "opt-motion") set({ motion: e.target.checked ? "on" : "off" });
    });
    dialog.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) return dialog.close();
      if (e.target !== dialog) return;                     // a click on the backdrop lands on the dialog itself
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
    });
  }
  function reflect() {
    if (!dialog) return;
    dialog.querySelectorAll('input[name="opt-process"]').forEach((r) => { r.checked = r.value === opts.process; });
    dialog.querySelectorAll('input[name="opt-layout"]').forEach((r) => { r.checked = r.value === opts.layout; });
    dialog.querySelector("#opt-motion").checked = opts.motion === "on";
  }
  function open() {
    if (!dialog) build();
    reflect();
    closeMenu();
    dialog.showModal();
  }

  window.Options = {
    get: () => ({ ...opts }),
    set, open, call,
    server: () => opts.process === "server",
    mobile: isMobile,
    json: async (path, body) => {                        // an empty reply (204) is {} instead of a parse error
      const text = await (await call(path, body)).text();
      return text ? JSON.parse(text) : {};
    },
    blob: async (path, body) => (await call(path, body)).blob(),
  };
  apply();
  document.addEventListener("DOMContentLoaded", apply);    // notes may sit below the script tag

  // ---------- sidebar ----------
  const nav = document.getElementById("site-nav");
  if (!nav) return;
  const current = location.pathname.replace(/\/+$/, "") || "/";
  const CACHE = "spells-nav";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const store = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };

  // The phone's menu: the top bar shows the brand and a ☰ button; the list of tools drops down under it.
  const menuBtn = () => nav.querySelector(".nav-menu");
  function closeMenu() {
    delete root.dataset.menu;
    const b = menuBtn();
    if (b) { b.setAttribute("aria-expanded", "false"); b.textContent = "☰"; }
  }
  function toggleMenu() {
    const open = root.dataset.menu !== "open";
    if (!open) return closeMenu();
    root.dataset.menu = "open";
    const b = menuBtn();
    b.setAttribute("aria-expanded", "true"); b.textContent = "✕";
    nav.scrollTop = 0;
  }

  // groups: array of {label, pages}, or null when signed out.
  function render(groups) {
    root.dataset.auth = groups ? "yes" : "no";
    const items = (groups || []).map((g) =>
      (g.label ? `<li class="group">${esc(g.label)}</li>` : "") +
      g.pages.map((p) => `<li><a href="${p.path}" title="${esc(p.label)}"${p.path === current ? ' aria-current="page"' : ""}><span class="ico" aria-hidden="true">${esc(p.glyph || "✦")}</span><span class="lbl">${esc(p.label)}</span></a></li>`).join("")
    ).join("");
    nav.innerHTML = `
      <div class="nav-panel">
        <div class="nav-head">
          <a class="brand" href="/">
            <span class="sigil" aria-hidden="true">☾</span>
            <span class="brand-text">Iprix's Spells</span>
          </a>
          <button class="nav-toggle" type="button" data-act="retract" aria-label="Retract the sidebar" title="Retract the sidebar">«</button>
          <button class="nav-menu" type="button" data-act="menu" aria-label="Menu" aria-expanded="false"${isMobile() ? "" : " hidden"}>☰</button>
        </div>
        <button class="nav-expand" type="button" data-act="expand" aria-label="Open the sidebar" title="Open the sidebar">»</button>
        ${groups ? `<ul>${items}</ul>` : ""}
        <div class="nav-foot">
          <button class="leave" type="button" data-act="options" title="Options"><span class="ico" aria-hidden="true">⚙</span><span class="lbl">Options</span></button>
          ${groups ? '<button class="leave" type="button" data-act="logout" title="Seal the tower"><span class="ico" aria-hidden="true">🔒</span><span class="lbl">Seal the tower</span></button>'
                   : '<a class="leave" href="/login" title="Sign in"><span class="ico" aria-hidden="true">🔑</span><span class="lbl">Sign in</span></a>'}
        </div>
      </div>`;
    closeMenu();
  }

  // ---------- retracting and popping out ----------
  // Retracted ("closed"): a narrow strip of icons. Hovering it for 0.75 s (or tabbing into it) pops the full sidebar out over
  // the page until the pointer leaves; clicking the strip, or its » button, opens it for good (it then takes its place in the
  // layout) and the « button next to the title retracts it again. The choice is kept in a cookie. None of this applies to
  // the phone layout, where the sidebar is the top bar.
  const HOVER_MS = 750;
  let hoverTimer = 0, blocked = false;                    // blocked: just retracted under the pointer, do not pop out again until it leaves
  const panel = () => nav.querySelector(".nav-panel");
  const isClosed = () => !isMobile() && root.dataset.nav !== "open";
  const peek = (on) => { const p = panel(); if (p) p.classList.toggle("peek", on && !isMobile()); };
  function setNav(value) {
    if (isMobile()) return;
    opts.nav = value;
    cookie.set("spells_nav", value);
    root.dataset.nav = value;
    peek(false);
  }
  nav.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "touch" || !isClosed() || blocked) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => { if (isClosed()) peek(true); }, HOVER_MS);
  });
  nav.addEventListener("pointerleave", () => { clearTimeout(hoverTimer); blocked = false; peek(false); });
  nav.addEventListener("focusin", () => { if (isClosed()) peek(true); });
  nav.addEventListener("focusout", (e) => { if (!nav.contains(e.relatedTarget)) peek(false); });

  nav.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) {
      if (isClosed() && !e.target.closest("a")) setNav("open");        // a click on the strip itself (not on a link)
      return;
    }
    if (b.dataset.act === "menu") return toggleMenu();
    if (b.dataset.act === "expand") return setNav("open");
    if (b.dataset.act === "retract") { blocked = true; return setNav("closed"); }
    if (b.dataset.act === "options") return open();
    await fetch("/logout", { method: "POST" });
    store.set(CACHE, "");
    location.href = "/";
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && root.dataset.menu === "open") closeMenu(); });
  document.addEventListener("pointerdown", (e) => {                     // a tap on the page closes the phone menu
    if (root.dataset.menu === "open" && !nav.contains(e.target)) closeMenu();
  });

  // Draw from the cached list straight away so the sidebar never flashes empty, then refresh it.
  (async function () {
    let cached = null;
    try { cached = JSON.parse(store.get(CACHE)); } catch { /* no cache */ }
    if (Array.isArray(cached)) render(cached);
    try {
      const r = await fetch("/api/pages", { credentials: "same-origin" });
      if (r.status === 401) { store.set(CACHE, ""); return render(null); }
      const fresh = await r.json();
      if (JSON.stringify(fresh) !== JSON.stringify(cached)) render(fresh);
      store.set(CACHE, JSON.stringify(fresh));
    } catch {
      if (!Array.isArray(cached)) render(null);
    }
  })();
})();
