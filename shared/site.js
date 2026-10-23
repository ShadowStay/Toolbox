// Site script, loaded on every page. It does four things:
//   1. Options (animations, where to process files) saved in cookies, applied to <html> as data-motion / data-process.
//   2. The Options dialog, opened from the sidebar.
//   3. The sidebar, built from /api/pages (a signed-out visitor just sees the brand and a Sign in link).
//   4. window.Options.call/json/blob: helpers for pages that send work to the server.
// Cookies (read by app.py too, so the first paint is already right): spells_motion = on|off, spells_process = browser|server.
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
  };

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
    document.querySelectorAll(".where").forEach((el) => { el.textContent = NOTES[opts.process][el.hasAttribute("data-files") ? 1 : 0]; });
  }
  function set(patch) {
    Object.assign(opts, patch);
    cookie.set("spells_motion", opts.motion);
    cookie.set("spells_process", opts.process);
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
        <legend>Motion</legend>
        <label class="switch-row">
          <span><strong>Animations</strong><small>Floating motes, glows and hover effects. Off by default.</small></span>
          <input type="checkbox" role="switch" id="opt-motion">
        </label>
      </fieldset>
      <div class="opt-actions"><button class="opt-done" type="button" data-close>Done</button></div>`;
    document.body.append(dialog);
    dialog.addEventListener("change", (e) => {
      if (e.target.name === "opt-process") set({ process: e.target.value });
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
    dialog.querySelector("#opt-motion").checked = opts.motion === "on";
  }
  function open() {
    if (!dialog) build();
    reflect();
    dialog.showModal();
  }

  window.Options = {
    get: () => ({ ...opts }),
    set, open, call,
    server: () => opts.process === "server",
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

  // groups: array of {label, pages}, or null when signed out.
  function render(groups) {
    root.dataset.auth = groups ? "yes" : "no";
    const items = (groups || []).map((g) =>
      (g.label ? `<li class="group">${esc(g.label)}</li>` : "") +
      g.pages.map((p) => `<li><a href="${p.path}"${p.path === current ? ' aria-current="page"' : ""}>${esc(p.label)}</a></li>`).join("")
    ).join("");
    nav.innerHTML = `
      <a class="brand" href="/">
        <span class="sigil" aria-hidden="true">☾</span>
        <span class="brand-text">Iprix's Spells</span>
      </a>
      ${groups ? `<ul>${items}</ul>` : ""}
      <div class="nav-foot">
        <button class="leave" type="button" data-act="options">Options</button>
        ${groups ? '<button class="leave" type="button" data-act="logout">Seal the tower</button>' : '<a class="leave" href="/login">Sign in</a>'}
      </div>`;
  }

  nav.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    if (b.dataset.act === "options") return open();
    await fetch("/logout", { method: "POST" });
    store.set(CACHE, "");
    location.href = "/";
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
