// Shared by every page. Builds the left-hand navigation from /api/pages
// (uncategorized pages first, then one heading per category; the home page is not listed).
// In the book theme the same markup is shown as a table of contents with page numbers.
(async function () {
  const nav = document.getElementById("site-nav");
  if (!nav) return;
  const root = document.documentElement;
  const main = document.querySelector("main.page");
  const current = location.pathname.replace(/\/+$/, "") || "/";
  const CACHE = "spells-nav";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const store = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* storage unavailable */ } },
    del: (k) => { try { sessionStorage.removeItem(k); } catch { /* storage unavailable */ } },
  };
  const turning = () => { const o = window.Options?.get(); return !!o && o.theme === "book" && o.motion === "on"; };
  const nativeTurn = "CSSViewTransitionRule" in window;   // browser can animate navigations itself (see turn.css)

  // Arriving from a fallback page turn.
  if (store.get("spells-turn")) {
    store.del("spells-turn");
    if (!nativeTurn && turning()) {
      root.classList.add("arriving");
      setTimeout(() => root.classList.remove("arriving"), 700);
    }
  }

  const syncLabels = () => {
    const out = nav.querySelector('[data-act="logout"]');
    if (out) out.textContent = root.dataset.theme === "book" ? "Close the book" : "Seal the tower";
  };

  function render(groups) {
    let n = 0, title = "Frontispiece", folio = current === "/" ? "i" : "";
    const link = (p) => {
      n++;
      const here = p.path === current;
      if (here) { title = p.label; folio = String(n); }
      return `<li><a href="${p.path}"${here ? ' aria-current="page"' : ""}><span class="t">${esc(p.label)}</span><span class="dots"></span><span class="pg">${n}</span></a></li>`;
    };
    const items = groups
      .map((g) => (g.label ? `<li class="group">${esc(g.label)}</li>` : "") + g.pages.map(link).join(""))
      .join("");
    nav.innerHTML = `
      <a class="brand" href="/">
        <span class="sigil" aria-hidden="true">☾</span>
        <span class="brand-text">Iprix's Spells</span>
      </a>
      <ul>${items}</ul>
      <div class="nav-foot">
        <button class="leave" type="button" data-act="options">Options</button>
        <button class="leave" type="button" data-act="logout"></button>
      </div>`;
    if (main) { main.dataset.title = title; if (folio) main.dataset.pg = folio; }
    syncLabels();
  }

  nav.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    if (b.dataset.act === "options") return window.Options?.open();
    await fetch("/logout", { method: "POST" });
    location.href = "/";
  });
  document.addEventListener("optionschange", syncLabels);

  // Fallback page turn for browsers that cannot animate navigations themselves.
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.target || a.origin !== location.origin || a.pathname === location.pathname || nativeTurn || !turning()) return;
    e.preventDefault();
    root.classList.add("leaving");
    store.set("spells-turn", "1");
    setTimeout(() => { location.href = a.href; }, 480);
  });

  // Draw from the cached list straight away so the sidebar never flashes empty, then refresh it.
  let cached = null;
  try { cached = JSON.parse(store.get(CACHE)); } catch { /* no cache */ }
  if (Array.isArray(cached)) render(cached);
  try {
    const fresh = await (await fetch("/api/pages")).json();
    if (JSON.stringify(fresh) !== JSON.stringify(cached)) render(fresh);
    store.set(CACHE, JSON.stringify(fresh));
  } catch {
    if (!Array.isArray(cached)) render([]);   // brand link only
  }
})();
