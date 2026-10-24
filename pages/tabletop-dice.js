// Dice and "Playing as" for pages/tabletop.html. One roller is drawn into the Character sheet and one into the Map
// sidebar (Dice.mount); both share one log. Rolls are made by the server (processing/rolls.py) and every browser on the
// page polls for new ones, so everybody sees everybody's rolls. The log is kept per campaign and lasts until the server
// restarts.
// "Playing as" is the character you play in this browser session (sessionStorage: it is forgotten when the tab closes).
// Rolls carry its name, and the map marks its token. Document event "tabletopas" fires when it changes.
//   window.Dice = { mount(el), as() -> {id, name} | null, setAs(id), suggest(id) }
(function () {
  const api = window.Options, Role = window.Role;
  const KEY = "tabletop-as", POLL_MS = 2000;
  const session = {
    get: () => { try { return sessionStorage.getItem(KEY) || ""; } catch { return ""; } },
    set: (v) => { try { sessionStorage.setItem(KEY, v); } catch { /* storage unavailable */ } },
  };
  let asId = session.get(), choices = [], rolls = [], last = 0;
  const mine = new Set();                                   // ids of the rolls made in this browser
  const panels = [];                                        // {root, select, log, say}
  const isDM = () => Role.get() === "dm";
  const current = () => choices.find((c) => c.id === asId) || null;
  const rollerName = () => (current() ? current().name : isDM() ? "Dungeon Master" : "Player");

  // ---------- playing as ----------
  function fillSelects() {
    for (const p of panels) {
      p.select.replaceChildren(new Option(isDM() ? "Dungeon Master (no character)" : "No character chosen", ""), ...choices.map((c) => new Option(c.name, c.id)));
      p.select.value = current() ? asId : "";
    }
  }
  async function loadChoices() {
    try { choices = (await api.json("/api/characters")).characters.filter((c) => c.open); } catch { choices = []; }
    if (asId && !current()) { asId = ""; session.set(""); changed(); }       // that character is gone or locked now
    fillSelects();
  }
  function changed() { document.dispatchEvent(new CustomEvent("tabletopas", { detail: { id: asId } })); }
  function setAs(id) {
    asId = choices.some((c) => c.id === id) ? id : "";
    session.set(asId);
    fillSelects();
    changed();
  }

  // ---------- the log ----------
  const two = (n) => String(n).padStart(2, "0");
  function line(r) {
    const li = document.createElement("li"), big = document.createElement("strong"), who = document.createElement("small"), what = document.createElement("small");
    const d = new Date(r.ts), mod = r.mod ? (r.mod > 0 ? " + " : " − ") + Math.abs(r.mod) : "";
    if (mine.has(r.id)) li.className = "mine";
    big.textContent = r.total;
    who.className = "who"; who.textContent = `${r.name} · ${two(d.getHours())}:${two(d.getMinutes())}`;
    what.textContent = `${r.expr}: [${r.dice.join(", ")}]${mod}`;
    li.append(big, who, what);
    return li;
  }
  function paintLogs() {
    for (const p of panels) p.log.replaceChildren(...rolls.slice().reverse().map(line));     // newest first
  }
  function take(list, reset) {
    if (reset) rolls = [];
    const seen = new Set(rolls.map((r) => r.id));
    let added = false;
    for (const r of list) if (!seen.has(r.id)) { rolls.push(r); added = true; }
    rolls.sort((a, b) => a.id - b.id);
    rolls = rolls.slice(-50);
    last = rolls.length ? rolls[rolls.length - 1].id : last;
    if (added || reset) paintLogs();
  }
  async function poll() {
    if (document.hidden || !panels.length) return;
    try {
      const d = await api.json("/api/rolls?after=" + last);
      if (d.reset) { last = 0; mine.clear(); }
      take(d.rolls, d.reset);
    } catch { /* offline for a moment: the next poll catches up */ }
  }

  async function roll(p, expr) {
    p.say("");
    try {
      const r = await api.json("/api/rolls", { expr, name: rollerName() });
      mine.add(r.id);
      take([r], false);
    } catch (err) { p.say(err.message || String(err), true); }
  }

  // ---------- the roller (drawn into the sheet and the map) ----------
  function mount(root) {
    root.innerHTML = `
      <h2>Dice</h2>
      <label class="field">Playing as <select data-as></select></label>
      <label class="field">Modifier <input type="text" data-mod value="0" inputmode="numeric" autocomplete="off"></label>
      <div class="actions">
        <button class="btn" type="button" data-die="d6">d6</button>
        <button class="btn" type="button" data-die="d10">d10</button>
        <button class="btn primary" type="button" data-die="d100">d100</button>
      </div>
      <form class="custom">
        <input type="text" data-expr placeholder="2d6+3" aria-label="Dice expression" autocomplete="off" spellcheck="false">
        <button class="btn" type="submit">Roll</button>
      </form>
      <p class="status nomargin" data-say role="status"></p>
      <ol class="rolls" aria-live="polite" aria-label="Rolls of everybody at the table"></ol>`;
    const q = (s) => root.querySelector(s);
    const sayEl = q("[data-say]");
    const p = { root, select: q("[data-as]"), log: q(".rolls"), say: (t, error) => { sayEl.textContent = t; sayEl.classList.toggle("error", !!error); } };
    panels.push(p);
    const mod = () => { const v = parseInt(q("[data-mod]").value, 10) || 0; return v ? (v > 0 ? "+" : "") + v : ""; };
    root.addEventListener("click", (e) => { const b = e.target.closest("[data-die]"); if (b) roll(p, b.dataset.die + mod()); });
    q(".custom").addEventListener("submit", (e) => { e.preventDefault(); roll(p, q("[data-expr]").value); });
    p.select.addEventListener("change", () => setAs(p.select.value));
    p.select.addEventListener("focus", loadChoices);       // the list of characters may have changed meanwhile
    fillSelects();
    paintLogs();
  }

  // ---------- keeping up ----------
  document.addEventListener("tabletopview", loadChoices);
  document.addEventListener("visibilitychange", poll);
  document.addEventListener("rolechange", () => { rolls = []; last = 0; paintLogs(); loadChoices(); poll(); });   // another campaign has its own rolls
  setInterval(poll, POLL_MS);
  Role.ready.then(() => { loadChoices(); poll(); });

  window.Dice = {
    mount,
    as: () => current(),
    setAs,
    // The sheet you just opened becomes the character you play, unless you already chose one (players only).
    suggest: async (id) => { if (asId || isDM()) return; await loadChoices(); if (!asId) setAs(id); },
  };
})();
