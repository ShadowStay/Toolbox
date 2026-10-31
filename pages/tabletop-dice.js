// Dice and "Playing as" for pages/tabletop.html. One roller is drawn into the Character sheet and one into the Map
// sidebar (Dice.mount); both share one log. Rolls are made by the server (processing/rolls.py) and every browser on the
// page polls for new ones, so everybody sees everybody's rolls. The log is kept per campaign and lasts until the server
// restarts.
// The dice character is the character you play in this browser session (sessionStorage: it is forgotten when the tab closes).
// Rolls carry its name, and the map marks its token. Document event "tabletopas" fires when it changes.
// That character's sheet feeds the buttons:
//   * k100 + fegyver nélküli TÉ (the TÉ "Fegyver nélkül" box, plus the Modifier box of the panel);
//   * "TÉ with a weapon": k100 + Fegyver nélkül + the weapon's TÉ + the TÉ Módosítók, one button per weapon of the Fegyverek table;
//   * "Sebzés": one button per weapon (and the shield) whose Sebzés is a dice roll like "1k10+2" (number of dice, k, sides,
//     + or − the bonus). Weapon buttons are named after the first five letters of the weapon and a dot.
// "My rolls": rolls you name yourself ("Sneak attack", k100 + 3). Each shows its name with the actual roll under it in smaller
// text. Edit opens a list where you rename them, change the roll, delete them, add new ones and arrange them (▲ ▼, or drag the
// ⠿ handle). They are kept in this browser, separately for each character (and one set for when there is no character).
//   window.Dice = { mount(el), as() -> {id, name} | null, choose(id), hasChoice() -> Promise<bool>, sync() }
//   choose(id): play as that character; sync(): read the characters and their weapons again (after the sheet was saved).
(function () {
  const api = window.Options, Role = window.Role;
  const KEY = "tabletop-as", POLL_MS = 2000;
  const session = {
    get: () => { try { return sessionStorage.getItem(KEY) || ""; } catch { return ""; } },
    set: (v) => { try { sessionStorage.setItem(KEY, v); } catch { /* storage unavailable */ } },
  };
  let asId = session.get(), choices = [], weapons = [], unarmed = null, rolls = [], last = 0;
  const mine = new Set();                                   // ids of the rolls made in this browser
  const panels = [];                                        // {root, select, log, say}
  const isDM = () => Role.get() === "dm";
  const current = () => choices.find((c) => c.id === asId) || null;
  const rollerName = () => (current() ? current().name : isDM() ? "Dungeon Master" : "Player");

  // ---------- playing as ----------
  // There is no selector in the dice panel: the character is the one chosen with the character picker of the sheet, or in
  // the player/dungeon master dialog. The panel only says who is rolling.
  function paintAs() {
    reloadCustom();
    for (const p of panels) p.as.textContent = current() ? `Rolling as ${current().name}` : isDM() ? "Rolling as Dungeon Master" : "Rolling as Player: choose a character at the top of the sheet";
  }
  async function loadChoices() {
    try { choices = (await api.json("/api/characters")).characters.filter((c) => c.open); } catch { choices = []; }
    if (asId && !current()) { asId = ""; session.set(""); changed(); }       // that character is gone or locked now
    paintAs();
    await loadWeapons();
  }
  function changed() { document.dispatchEvent(new CustomEvent("tabletopas", { detail: { id: asId } })); }
  function setAs(id) {
    asId = choices.some((c) => c.id === id) ? id : "";
    session.set(asId);
    paintAs();
    changed();
    loadWeapons();
  }

  // ---------- weapons ----------
  // "1k10+2" -> "1d10+2". Anything that is not a dice roll (empty, "-", text) gives null: no preset for that weapon.
  const DAMAGE = /^\s*(\d{0,3})\s*[kd]\s*(\d{1,4})\s*(?:([+-])\s*(\d{1,6}))?\s*$/i;
  function damageExpr(text) {
    const m = DAMAGE.exec(String(text || ""));
    return m ? `${m[1] || 1}d${m[2]}${m[3] ? m[3] + m[4] : ""}` : null;
  }
  const short = (name) => [...name.trim()].slice(0, 5).join("") + ".";
  const num = (v) => { const n = parseFloat(String(v ?? "").replace(",", ".")); return isNaN(n) ? 0 : n; };
  const plus = (n) => (n < 0 ? "−" : "+") + " " + Math.abs(n);
  async function loadWeapons() {
    weapons = []; unarmed = null;
    if (asId) {
      try {
        const data = (await api.json("/api/characters/" + asId)).data || {};
        unarmed = Math.round(num(data["te.wpn"]));                                  // TÉ, Fegyver nélkül
        const mod = num(data["te.mod"]);                                            // TÉ, Módosítók: added with every weapon
        const rows = Array.from({ length: 10 }, (_, i) => ({ name: data[`w.${i}.n`], dmg: data[`w.${i}.s`], te: data[`w.${i}.te`] }))
          .concat([{ name: data["shield.name"], dmg: data["shield.dmg"], te: "" }]);
        weapons = rows.map((r, i) => {
          const name = String(r.name || "").trim(), isShield = i === 10;
          return { name, dmg: String(r.dmg || "").trim(), expr: damageExpr(r.dmg),
                   te: !isShield && String(r.te || "").trim() !== "" ? Math.round(unarmed + num(r.te) + mod) : null };
        }).filter((w) => w.name && (w.expr || w.te != null));
      } catch { /* locked, or gone: no presets */ }
    }
    paintWeapons();
  }
  const k100 = (n) => (n == null ? "k100" : `k100 ${plus(n)}`);
  const d100 = (n) => "1d100" + (n ? (n > 0 ? "+" : "-") + Math.abs(n) : "");
  function paintWeapons() {
    for (const p of panels) {
      const button = (text, expr, label, title) => {
        const b = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: text, title: title || "" });
        b.dataset.expr = expr; b.dataset.label = label;
        return b;
      };
      const group = (heading, buttons) => {
        const box = document.createElement("div"), hd = document.createElement("small"), row = document.createElement("div");
        hd.className = "hd"; hd.textContent = heading; row.className = "actions";
        row.append(...buttons); box.append(hd, row);
        return box;
      };
      const te = weapons.filter((w) => w.te != null), dmg = weapons.filter((w) => w.expr);
      p.weapons.hidden = !te.length && !dmg.length;
      p.weapons.replaceChildren(
        ...(te.length ? [group("TÉ with a weapon", te.map((w) => button(`${short(w.name)} ${k100(w.te)}`, d100(w.te), w.name + " TÉ", `${w.name}: fegyver nélkül + weapon TÉ + módosítók = ${w.te}`)))] : []),
        ...(dmg.length ? [group("Sebzés", dmg.map((w) => button(`${short(w.name)} ${w.expr.replace("d", "k")}`, w.expr, w.name, `${w.name}: ${w.dmg}`)))] : []));
      paintQuick(p);
    }
  }
  // The k100 button shows k100 + fegyver nélküli TÉ (+ the Modifier box); without a character it is a plain k100.
  function paintQuick(p) {
    const b = p.root.querySelector("[data-die=d100]");
    b.textContent = k100(unarmed == null ? (p.mod() || null) : unarmed + p.mod());
    b.title = unarmed == null ? "" : "k100 + fegyver nélküli TÉ" + (p.mod() ? " + the modifier" : "");
  }

  // ---------- the log ----------
  const two = (n) => String(n).padStart(2, "0");
  function line(r) {
    const li = document.createElement("li"), big = document.createElement("strong"), who = document.createElement("small"), what = document.createElement("small");
    const d = new Date(r.ts), mod = r.mod ? (r.mod > 0 ? " + " : " − ") + Math.abs(r.mod) : "";
    if (mine.has(r.id)) li.className = "mine";
    big.textContent = r.total;
    who.className = "who"; who.textContent = `${r.name}${r.label ? " · " + r.label : ""} · ${two(d.getHours())}:${two(d.getMinutes())}`;
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

  async function roll(p, expr, label) {
    p.say("");
    try {
      const r = await api.json("/api/rolls", { expr, name: rollerName(), label });
      mine.add(r.id);
      take([r], false);
    } catch (err) { p.say(err.message || String(err), true); }
  }

  // ---------- my rolls ----------
  const MAX_CUSTOM = 24, crKey = () => "tabletop-rolls:" + (asId || "_");
  let custom = [], customKey = null;                        // [{n: name, r: roll as typed}]
  function parseRoll(text) {                                // "k100 + 3", "1k10+2", "2d6-1" -> {expr: "1d100+3", shown: "k100 + 3"} | null
    const m = DAMAGE.exec(String(text || ""));
    if (!m) return null;
    const n = +(m[1] || 1), sides = +m[2], mod = m[3] ? (m[3] === "-" ? -1 : 1) * +m[4] : 0;
    if (n < 1 || n > 100 || sides < 2) return null;
    return { expr: `${n}d${sides}${mod ? (mod > 0 ? "+" : "-") + Math.abs(mod) : ""}`, shown: `${n === 1 ? "" : n}k${sides}${mod ? ` ${plus(mod)}` : ""}` };
  }
  function reloadCustom() {
    if (customKey === crKey()) return;
    customKey = crKey();
    try {
      const a = JSON.parse(localStorage.getItem(customKey) || "[]");
      custom = (Array.isArray(a) ? a : []).filter((c) => c && typeof c.n === "string" && typeof c.r === "string").slice(0, MAX_CUSTOM);
    } catch { custom = []; }
    paintCustom(true);
  }
  function saveCustom() { try { localStorage.setItem(customKey, JSON.stringify(custom)); } catch { /* storage unavailable */ } }
  function paintCustomButtons() {
    for (const p of panels) {
      const buttons = custom.map((c) => ({ c, roll: parseRoll(c.r) })).filter((x) => x.roll).map(({ c, roll }) => {
        const b = document.createElement("button"), name = document.createElement("span"), what = document.createElement("small");
        b.type = "button"; b.className = "btn cr-btn"; b.dataset.expr = roll.expr; b.dataset.label = c.n.trim() || roll.shown;
        name.className = "nm"; name.textContent = c.n.trim() || roll.shown;
        what.className = "rl"; what.textContent = roll.shown;                  // the actual roll, under the name
        b.append(name, what);
        return b;
      });
      p.crButtons.replaceChildren(...buttons);
      p.crHint.hidden = buttons.length > 0 || p.editing;
    }
  }
  function paintEditor(p) {
    p.crEditor.hidden = !p.editing;
    p.crEdit.textContent = p.editing ? "Done" : "Edit";
    if (!p.editing) return;
    p.crList.replaceChildren(...custom.map((c, i) => {
      const row = document.createElement("div");
      row.className = "cr-row"; row.dataset.i = i;
      row.innerHTML = `<span class="grip" title="Drag to arrange" aria-hidden="true">⠿</span>
        <input type="text" data-f="n" maxlength="30" placeholder="Name" aria-label="Name of the roll" autocomplete="off" spellcheck="false">
        <input type="text" data-f="r" placeholder="k100 + 3" aria-label="The roll, like k100 + 3 or 2k6" autocomplete="off" spellcheck="false">
        <span class="cr-moves"><button type="button" class="btn small" data-move="-1" aria-label="Move up" title="Move up">▲</button><button type="button" class="btn small" data-move="1" aria-label="Move down" title="Move down">▼</button><button type="button" class="btn small" data-del aria-label="Delete this roll" title="Delete">✕</button></span>`;
      const [nameBox, rollBox] = row.querySelectorAll("input");
      nameBox.value = c.n; rollBox.value = c.r;
      rollBox.classList.toggle("bad", !parseRoll(c.r));
      rollBox.title = parseRoll(c.r) ? "" : "Use a roll like k100 + 3, 2k6 or 1k10 - 1";
      row.querySelector("[data-move='-1']").disabled = i === 0;
      row.querySelector("[data-move='1']").disabled = i === custom.length - 1;
      return row;
    }));
    p.crAdd.disabled = custom.length >= MAX_CUSTOM;
  }
  function paintCustom() {
    paintCustomButtons();
    panels.forEach(paintEditor);
  }
  function moveCustom(from, to) {
    if (from === to || !custom[from] || to < 0 || to >= custom.length) return;
    custom.splice(to, 0, custom.splice(from, 1)[0]);
    saveCustom(); paintCustom();
  }
  function wireCustom(p) {
    p.crEdit.addEventListener("click", () => { p.editing = !p.editing; paintCustomButtons(); paintEditor(p); });
    p.crAdd.addEventListener("click", () => {
      if (custom.length >= MAX_CUSTOM) return;
      custom.push({ n: "", r: "k100" });
      saveCustom(); paintCustom();
      p.crList.querySelector(".cr-row:last-child input").focus();
    });
    p.crEditor.addEventListener("input", (e) => {                              // typing: save and update the buttons, but keep the boxes as they are
      const box = e.target.closest("input[data-f]"), row = box && box.closest(".cr-row");
      if (!row) return;
      custom[+row.dataset.i][box.dataset.f] = box.value;
      if (box.dataset.f === "r") { box.classList.toggle("bad", !parseRoll(box.value)); box.title = parseRoll(box.value) ? "" : "Use a roll like k100 + 3, 2k6 or 1k10 - 1"; }
      saveCustom(); paintCustomButtons();
    });
    p.crEditor.addEventListener("click", (e) => {
      const row = e.target.closest(".cr-row"), i = row ? +row.dataset.i : -1;
      if (e.target.closest("[data-del]")) { custom.splice(i, 1); saveCustom(); paintCustom(); }
      else if (e.target.closest("[data-move]")) moveCustom(i, i + +e.target.closest("[data-move]").dataset.move);
    });
    // Dragging: only the ⠿ handle starts a drag, so the text boxes keep working normally.
    let from = -1;
    p.crEditor.addEventListener("pointerdown", (e) => { const g = e.target.closest(".grip"); if (g) g.closest(".cr-row").draggable = true; });
    p.crEditor.addEventListener("dragstart", (e) => { from = +e.target.closest(".cr-row").dataset.i; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(from)); });
    p.crEditor.addEventListener("dragover", (e) => { if (from >= 0) e.preventDefault(); });
    p.crEditor.addEventListener("drop", (e) => {
      const row = e.target.closest(".cr-row");
      if (from < 0 || !row) return;
      e.preventDefault();
      moveCustom(from, +row.dataset.i);
      from = -1;
    });
    p.crEditor.addEventListener("dragend", () => { from = -1; p.crList.querySelectorAll(".cr-row").forEach((r) => { r.draggable = false; }); });
  }

  // ---------- the roller (drawn into the sheet and the map) ----------
  function mount(root) {
    root.innerHTML = `
      <h2>Dice</h2>
      <p class="hint nomargin" data-as></p>
      <label class="field">Modifier <input type="text" data-mod value="0" inputmode="numeric" autocomplete="off"></label>
      <div class="actions">
        <button class="btn" type="button" data-die="d6">k6</button>
        <button class="btn" type="button" data-die="d10">k10</button>
        <button class="btn primary" type="button" data-die="d100">k100</button>
      </div>
      <div class="weapons" data-weapons aria-label="Weapon rolls" hidden></div>
      <div class="myrolls" aria-label="My rolls">
        <div class="cr-head"><small class="hd">My rolls</small><button type="button" class="btn small" data-cr-edit>Edit</button></div>
        <div class="actions cr-buttons" data-cr-buttons></div>
        <p class="hint nomargin" data-cr-hint>Press Edit to make your own rolls.</p>
        <div class="cr-editor" data-cr-editor hidden>
          <div class="cr-list" data-cr-list></div>
          <button type="button" class="btn small" data-cr-add>+ Add a roll</button>
        </div>
      </div>
      <form class="custom">
        <input type="text" data-custom placeholder="2d6+3" aria-label="Dice expression" autocomplete="off" spellcheck="false">
        <button class="btn" type="submit">Roll</button>
      </form>
      <p class="status nomargin" data-say role="status"></p>
      <ol class="rolls" aria-live="polite" aria-label="Rolls of everybody at the table"></ol>`;
    const q = (s) => root.querySelector(s);
    const sayEl = q("[data-say]");
    const p = { root, as: q("[data-as]"), log: q(".rolls"), weapons: q("[data-weapons]"), editing: false,
      crEdit: q("[data-cr-edit]"), crButtons: q("[data-cr-buttons]"), crHint: q("[data-cr-hint]"), crEditor: q("[data-cr-editor]"), crList: q("[data-cr-list]"), crAdd: q("[data-cr-add]"), say: (t, error) => { sayEl.textContent = t; sayEl.classList.toggle("error", !!error); } };
    panels.push(p);
    p.mod = () => parseInt(q("[data-mod]").value, 10) || 0;
    q("[data-mod]").addEventListener("input", () => paintQuick(p));
    root.addEventListener("click", (e) => {
      const b = e.target.closest("[data-die]"), w = e.target.closest("[data-expr]");
      if (b) {                                                        // quick dice: plus the Modifier box (the k100 also plus the TÉ shown on it)
        const add = p.mod() + (b.dataset.die === "d100" && unarmed != null ? unarmed : 0);
        roll(p, b.dataset.die + (add ? (add > 0 ? "+" : "") + add : ""), b.dataset.die === "d100" && unarmed != null ? "TÉ" : "");
      } else if (w) roll(p, w.dataset.expr, w.dataset.label);       // weapon rolls are complete as they stand: the Modifier box is not added
    });
    q(".custom").addEventListener("submit", (e) => { e.preventDefault(); roll(p, q("[data-custom]").value); });
    wireCustom(p);
    paintAs();
    paintCustom();
    paintWeapons();
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
    choose: async (id) => { await loadChoices(); setAs(id); },      // the list may not know a character created a moment ago
    hasChoice: async () => { await loadChoices(); return !!current(); },
    sync: loadChoices,
  };
})();
