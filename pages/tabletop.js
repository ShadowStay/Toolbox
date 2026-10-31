// Page script of pages/tabletop.html: everything the Tabletop page runs, in the order the parts need each other.

// ====================================================================================================
// 1. Role and campaign (player / dungeon master dialog, campaign bar)
// ====================================================================================================

// "Who are you at the table, and which campaign are you playing?"
// Both answers are kept in cookies, so the next visit starts where you left off, and both can be changed at any time
// with the "Change" button of the bar this script draws (Role.mount):
//   * the role (player / dungeon master) in a signed cookie set by processing/roles.py, which is what actually limits
//     what a player can see. The dungeon master needs a password: the first person to choose the role picks it.
//   * the campaign in the cookie spells_campaign (processing/campaigns.py). Everything is stored per campaign.
// Here: the dialog, document.documentElement.dataset.role ("player" | "dm"), a "rolechange" event (fired when the role
// or the campaign changed; detail = {role, campaign: {id, name}}), and
//   window.Role = { ready, get(), campaign(), campaigns(), passwordInfo(), ask(), pickCharacter(), refresh(), mount(el), beforeChange(fn) }
// Choosing "Player" opens a second step in the same dialog: which character do you play? The answer is announced with the
// document event "characterpick" (detail {id} for an existing character, {fresh: true} for a new one); the page does the
// rest. Role.pickCharacter() shows only that step (for a player who has not chosen yet in this session).
// The dialog is shown on load only when no role has been chosen yet.
//   Role.beforeChange(fn)  fn() is awaited (to save unsaved work) before a campaign is switched.
(function () {
  const root = document.documentElement, api = window.Options;
  const mode = "unset";                                   // ask only when no role has been chosen yet
  let current = null, dialog = null;
  let pw = { set: false, source: null };           // is there a dungeon master password, and where does it come from
  let campaigns = [], campaignId = "";
  const bars = new Set(), flushers = [];

  const style = document.createElement("style");
  style.textContent = `
    #role-dialog { width: min(32rem, 92vw); padding: 1.5rem; color: var(--moon, #f1e9ff); background: var(--dusk, #22123b); border: 1px solid var(--amethyst, #8a5bd8); border-radius: .8rem; box-shadow: 0 20px 60px #000a; }
    #role-dialog::backdrop { background: #000c; backdrop-filter: blur(3px); }
    #role-dialog h2 { margin: 0 0 .25rem; font-size: 1.3rem; }
    #role-dialog p { margin: 0; color: #d9cbf2; font-size: .95rem; }
    .role-camp { margin-top: 1rem; }
    .role-choices { display: grid; grid-template-columns: 1fr 1fr; gap: .8rem; margin-top: 1rem; }
    .role-choice { display: grid; gap: .3rem; padding: 1rem; text-align: left; font: inherit; color: inherit; cursor: pointer; background: #8a5bd822; border: 2px solid #8a5bd877; border-radius: .7rem; }
    .role-choice:hover, .role-choice:focus-visible { border-color: var(--candle, #e9c776); outline: none; }
    .role-choice.last { border-color: var(--orchid, #c9a2ff); }
    .role-choice strong { font-size: 1.1rem; }
    .role-choice small { opacity: .8; line-height: 1.35; }
    .role-pin { display: grid; gap: .5rem; margin-top: 1rem; }
    .role-pin input { font: inherit; padding: .6rem .7rem; color: inherit; background: #140b22; border: 1px solid #8a5bd877; border-radius: .4rem; }
    .role-pin .row, .role-foot, .role-charfoot { display: flex; gap: .5rem; justify-content: flex-end; margin-top: .4rem; }
    .role-err { min-height: 1.3rem; margin-top: .6rem !important; color: #ff9fb3 !important; }
    .role-bar { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1rem; margin-top: 1rem; color: #d9cbf2; }
    .role-bar strong { color: var(--moon, #f1e9ff); }
    .role-chars { margin-top: 1rem; }
    .role-charlist { display: flex; flex-wrap: wrap; gap: .6rem; max-height: 40vh; margin-top: .8rem; overflow: auto; }
    .role-char { display: flex; align-items: center; gap: .7rem; min-width: 0; width: calc(50% - .3rem); padding: .7rem .8rem; font: inherit; color: inherit; text-align: left; cursor: pointer; background: #8a5bd822; border: 2px solid #8a5bd877; border-radius: .7rem; }
    .role-char:hover, .role-char:focus-visible { border-color: var(--candle, #e9c776); outline: none; }
    .role-char.last { border-color: var(--orchid, #c9a2ff); }
    .role-char .ico { flex: none; display: grid; place-items: center; width: 2.4rem; height: 2.4rem; font-size: .8rem; font-weight: 600; background: var(--violet, #4b2a85); border-radius: 50%; }
    .role-char .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .role-empty { margin-top: .8rem !important; }
    @media (max-width: 480px) { .role-choices { grid-template-columns: 1fr; } .role-char { width: 100%; } }`;
  document.head.append(style);

  const campaignName = () => (campaigns.find((c) => c.id === campaignId) || {}).name || "";
  const detail = () => ({ role: current, campaign: { id: campaignId, name: campaignName() } });

  // ---------- the bar: "Playing as … in …  [Change]" ----------
  function paintBar(el) {
    const mk = (tag, text, cls) => Object.assign(document.createElement(tag), { textContent: text, className: cls || "" });
    const who = mk("strong", current === "dm" ? "Dungeon master" : current === "player" ? "Player" : "nobody yet");
    const where = mk("strong", campaignName() || "…");
    const text = document.createElement("span");
    text.append("Playing as ", who, " in ", where);
    const btn = mk("button", "Change", "btn small");
    btn.type = "button";
    btn.addEventListener("click", () => ask(false));
    el.replaceChildren(text, btn);
  }
  const paintBars = () => bars.forEach(paintBar);
  function mount(el) {
    el.classList.add("role-bar");
    bars.add(el);
    paintBar(el);
  }

  function setRole(role) {
    current = role;
    root.dataset.role = role || "";
    paintBars();
    document.dispatchEvent(new CustomEvent("rolechange", { detail: detail() }));
  }

  async function loadCampaigns() {
    const d = await api.json("/api/campaigns");
    campaigns = d.campaigns;
    campaignId = d.current;
    paintBars();
  }
  // Re-read the campaigns (after one was created, renamed or deleted). Tells the page when the current one changed.
  async function refresh() {
    const before = campaignId, was = campaignName();
    await loadCampaigns();
    if (before !== campaignId) document.dispatchEvent(new CustomEvent("rolechange", { detail: detail() }));
    else if (was !== campaignName()) paintBars();
  }
  async function flush() { for (const fn of flushers) await fn(); }

  function build() {
    dialog = document.createElement("dialog");
    dialog.id = "role-dialog";
    dialog.setAttribute("aria-labelledby", "role-title");
    dialog.innerHTML = `
      <h2 id="role-title">Who are you at the table?</h2>
      <label class="field role-camp">Campaign <select id="role-camp"></select></label>
      <div class="role-choices">
        <button type="button" class="role-choice" data-role="player"><strong>Player</strong><small>Play your character. Fog of war applies.</small></button>
        <button type="button" class="role-choice" data-role="dm"><strong>Dungeon master</strong><small>Enemies, walls, doors, fog and saved maps. Needs the dungeon master password.</small></button>
      </div>
      <form class="role-pin" hidden>
        <label for="role-pin-in" id="role-pin-label">Dungeon master password</label>
        <input id="role-pin-in" type="password" autocomplete="off">
        <input id="role-pin-in2" type="password" autocomplete="off" placeholder="Repeat the password" aria-label="Repeat the password" hidden>
        <div class="row"><button type="button" class="btn small" data-back>Back</button><button type="submit" class="btn primary small" id="role-pin-go">Continue</button></div>
      </form>
      <div class="role-chars" hidden>
        <div class="role-charlist"></div>
        <p class="role-empty" hidden>There is no character in this campaign yet.</p>
        <div class="role-charfoot"><button type="button" class="btn small" data-skipchar>Choose later</button><button type="button" class="btn primary small" data-newchar>New character</button></div>
      </div>
      <p class="role-err" role="alert"></p>
      <div class="role-foot"><button type="button" class="btn small" data-cancel>Cancel</button></div>`;
    document.body.append(dialog);
  }

  // Step 2 for players, inside the open dialog: the characters that can be opened (not locked, or unlocked here), as cards.
  // Resolves {id}, {fresh: true} or null (Choose later). Escape does not close it; the foot buttons are hidden meanwhile.
  async function characterStep() {
    const q = (s) => dialog.querySelector(s);
    const box = q(".role-chars"), list = q(".role-charlist"), err = q(".role-err");
    let chars = [];
    try { chars = (await api.json("/api/characters")).characters.filter((c) => c.open); } catch (e) { err.textContent = e.message; }
    const last = (() => { try { return sessionStorage.getItem("tabletop-as") || ""; } catch { return ""; } })();
    list.replaceChildren(...chars.map((c) => {
      const b = document.createElement("button"), ico = document.createElement("span"), nm = document.createElement("span");
      b.type = "button"; b.className = "role-char" + (c.id === last ? " last" : ""); b.dataset.id = c.id;
      ico.className = "ico"; ico.textContent = (c.name.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2) || "?").toUpperCase();
      nm.className = "nm"; nm.textContent = c.name;
      b.append(ico, nm);
      return b;
    }));
    q(".role-empty").hidden = chars.length > 0;
    q("#role-title").textContent = "Who are you playing?";
    for (const s of [".role-camp", ".role-choices", ".role-pin", ".role-foot"]) q(s).hidden = true;
    box.hidden = false;
    return new Promise((resolve) => {
      const onClick = (e) => {
        const card = e.target.closest(".role-char");
        const result = card ? { id: card.dataset.id } : e.target.closest("[data-newchar]") ? { fresh: true } : e.target.closest("[data-skipchar]") ? null : undefined;
        if (result === undefined) return;
        box.removeEventListener("click", onClick);
        dialog.removeEventListener("cancel", onCancel);
        box.hidden = true;
        q("#role-title").textContent = "Who are you at the table?";
        q(".role-foot").hidden = false;
        resolve(result);
      };
      const onCancel = (e) => e.preventDefault();
      box.addEventListener("click", onClick);
      dialog.addEventListener("cancel", onCancel);
      q(".role-char, [data-newchar]").focus();
    });
  }
  const announce = (pick) => { if (pick) document.dispatchEvent(new CustomEvent("characterpick", { detail: pick })); };
  // Only the character step, for a player who has not chosen a character in this session.
  async function pickCharacter() {
    if (!dialog) build();
    dialog.querySelector(".role-err").textContent = "";
    dialog.showModal();
    const pick = await characterStep();
    dialog.close();
    announce(pick);
    return pick;
  }

  // Shows the dialog; resolves with the chosen role (or the old one when it was cancelled).
  async function ask(required) {
    if (!dialog) build();
    const q = (s) => dialog.querySelector(s);
    const pinForm = q(".role-pin"), choices = q(".role-choices"), camp = q(".role-camp"), cancel = q("[data-cancel]"), err = q(".role-err");
    const select = q("#role-camp");
    pinForm.hidden = true; choices.hidden = false; camp.hidden = false;
    dialog.querySelector(".role-chars").hidden = true;
    q(".role-foot").hidden = false;
    err.textContent = "";
    cancel.hidden = !!required;
    try { await loadCampaigns(); } catch (e) { err.textContent = e.message; }
    select.replaceChildren(...campaigns.map((c) => new Option(c.name, c.id)));
    select.value = campaignId;
    dialog.querySelectorAll(".role-choice").forEach((b) => b.classList.toggle("last", b.dataset.role === current));

    return new Promise((resolve) => {
      // Saves unsaved work, then sets the role and (if it changed) the campaign. False = something went wrong, shown in the dialog.
      async function finish(role, extra) {
        err.textContent = "";
        const wanted = select.value, switching = wanted && wanted !== campaignId;
        try {
          await flush();
          await api.json("/api/role", { role, ...extra });
          if (switching) await api.json("/api/campaign", { id: wanted });
        } catch (e) { err.textContent = e.message; return false; }
        if (extra && extra.create) pw = { set: true, source: "file" };
        return { switching };
      }
      const done = async (role, switching) => {
        const pick = role === "player" ? await characterStep() : null;     // a player says who they play, in the same dialog
        dialog.close(); cleanup();
        await loadCampaigns().catch(() => {});
        if (role !== current || switching) setRole(role); else paintBars();
        announce(pick);
        resolve(current);
      };
      const showPin = () => {
        const create = !pw.set;
        choices.hidden = true; camp.hidden = true; pinForm.hidden = false;
        q("#role-pin-label").textContent = create ? "Choose a dungeon master password (at least 4 characters)" : "Dungeon master password";
        q("#role-pin-in2").hidden = !create;
        q("#role-pin-go").textContent = create ? "Set password and continue" : "Continue";
        q("#role-pin-in").value = ""; q("#role-pin-in2").value = "";
        q("#role-pin-in").focus();
      };
      const onClick = async (e) => {
        const b = e.target.closest(".role-choice");
        if (b) {
          if (b.dataset.role === "dm" && current !== "dm" && (!pw.set || pw.source)) showPin();
          else { const r = await finish(b.dataset.role); if (r) done(b.dataset.role, r.switching); }
        } else if (e.target.closest("[data-back]")) { pinForm.hidden = true; choices.hidden = false; camp.hidden = false; err.textContent = ""; }
        else if (e.target.closest("[data-cancel]")) { dialog.close(); cleanup(); resolve(current); }
      };
      const onSubmit = async (e) => {
        e.preventDefault();
        const pin = q("#role-pin-in").value, create = !pw.set;
        if (create && pin !== q("#role-pin-in2").value) { err.textContent = "The two passwords are not the same."; return; }
        const r = await finish("dm", create ? { pin, create: true } : { pin });
        if (r) done("dm", r.switching);
      };
      const onCancel = (e) => { if (required) e.preventDefault(); };       // Escape does not skip the question
      function cleanup() { dialog.removeEventListener("click", onClick); pinForm.removeEventListener("submit", onSubmit); dialog.removeEventListener("cancel", onCancel); }
      dialog.addEventListener("click", onClick);
      pinForm.addEventListener("submit", onSubmit);
      dialog.addEventListener("cancel", onCancel);
      dialog.showModal();
    });
  }

  const ready = (async () => {
    try {
      const d = await api.json("/api/role");
      current = d.role;
      pw = { set: !!d.dm_protected, source: d.dm_source || null };
      root.dataset.role = current || "";
    } catch { /* the page shows its own errors */ }
    try { await loadCampaigns(); } catch { /* the dialog shows the error when it opens */ }
    if (mode === "always" || !current) await ask(true);
    return current;
  })();

  window.Role = {
    ready,
    get: () => current,
    campaign: () => ({ id: campaignId, name: campaignName() }),
    campaigns: () => campaigns.slice(),
    passwordInfo: () => ({ ...pw }),
    ask: () => ask(false),
    pickCharacter,
    refresh, mount,
    beforeChange: (fn) => flushers.push(fn),
  };
})();

// ====================================================================================================
// 2. Portrait and JSON helpers shared by the character sheet and the enemy sheet
// ====================================================================================================

// Small helpers shared by the character sheet (pages/tabletop.js) and the enemy sheet (the Dungeon Master HQ part of pages/tabletop.js).
//   SheetUtils.portrait(file)       -> Promise<data URL>  a square 240 px JPEG cut from the middle of an image file
//   SheetUtils.download(name, doc)  save an object as a .json file
//   SheetUtils.readDoc(file)        -> Promise<object>    read a .json file; an export's {data} wrapper is removed
window.SheetUtils = {
  async portrait(file) {
    let bmp;
    try { bmp = await createImageBitmap(file); } catch { throw new Error("That file could not be read as an image."); }
    const S = 240, c = document.createElement("canvas"), k = Math.max(S / bmp.width, S / bmp.height);
    c.width = c.height = S;
    c.getContext("2d").drawImage(bmp, (S - bmp.width * k) / 2, (S - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
    return c.toDataURL("image/jpeg", 0.85);
  },
  download(name, doc) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }));
    a.download = String(name || "export").replace(/[\\/:*?"<>|]/g, "_") + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  },
  async readDoc(file) {
    let doc;
    try { doc = JSON.parse(await file.text()); } catch { throw new Error("That file is not valid JSON."); }
    return doc && typeof doc.data === "object" ? doc.data : doc;
  },
};

// ====================================================================================================
// 3. Dice: roller, shared log, weapon presets, custom rolls
// ====================================================================================================

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
    for (const p of panels) p.as.textContent = current() ? `Rolling as ${current().name}` : isDM() ? "Rolling as Dungeon Master" : "Rolling as: no character";
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
      crEdit: q("[data-cr-edit]"), crButtons: q("[data-cr-buttons]"), crEditor: q("[data-cr-editor]"), crList: q("[data-cr-list]"), crAdd: q("[data-cr-add]"), say: (t, error) => { sayEl.textContent = t; sayEl.classList.toggle("error", !!error); } };
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

// ====================================================================================================
// 4. Views, map, sidebar drawer, measuring tool
// ====================================================================================================

// Tabletop views and map (the tabs of pages/tabletop.html: Character sheet, Map and, for the dungeon master, Dungeon Master HQ; server side: processing/battlemap.py and roles.py).
// One map shared by everybody. The server keeps the tokens, walls, doors and the fog of war, and only sends each
// person what their role may see; this page draws it and polls every 2 seconds. Role (player / dungeon master) is
// asked by the role part of this file (which also picks the campaign: every campaign has its own map); the DM-only controls carry
// the class "dm-only" and the server refuses players anyway.
(function () {
  const $ = (s) => document.querySelector(s);
  const api = window.Options;
  const CW = 16, CH = 10;                                   // the board is 16 x 10 squares
  const board = $("#map"), geoG = $("#g-geo"), pv = $("#pv"), fogImg = $("#fog"), cover = $("#mapcover");
  const status = $("#map-status"), addSel = $("#map-add");
  const say = (text, error) => { status.textContent = text; status.classList.toggle("error", !!error); };
  async function run(fn) { try { await fn(); } catch (err) { say(err.message || String(err), true); } }
  const store = {
    get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const initials = (name) => (name.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2) || "?").toUpperCase();
  const isDM = () => window.Role.get() === "dm";
  const num1 = (v) => +v.toFixed(1);

  let data = { tokens: [], walls: [], doors: [], hidden: false, vision: 7, fog: null };
  let tool = "move", chain = null, gesture = null;
  let sel = { type: "", id: "" };

  // ---------- switching between the sheet, the map and the dungeon master's HQ ----------
  // the Dungeon Master HQ section listens for the "tabletopview" event to load the enemies when its tab opens.
  const VIEWS = ["sheet", "map", "dm"];
  let timer = 0;
  function showView(name) {
    if (!VIEWS.includes(name) || (name === "dm" && !isDM())) name = "sheet";       // players never get the HQ
    document.querySelectorAll("[data-view]").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.view === name)));
    VIEWS.forEach((v) => { $("#view-" + v).hidden = v !== name; });
    store.set("tabletop-view", name);
    clearInterval(timer);
    if (name === "map") {
      applyRole();
      run(async () => { await loadChoices(); await refresh(); });
      timer = setInterval(() => { if (!document.hidden) run(refresh); }, 2000);
    }
    document.dispatchEvent(new CustomEvent("tabletopview", { detail: { view: name } }));
  }
  document.querySelectorAll("[data-view]").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));
  document.addEventListener("click", (e) => {                 // links inside the page, like "Dungeon Master HQ" in the empty-map note
    const a = e.target.closest("[data-goto]");
    if (a) { e.preventDefault(); showView(a.dataset.goto); }
  });

  // ---------- role ----------
  function applyRole() {
    const dm = isDM();
    if (!dm) setTool("move");
  }
  document.addEventListener("rolechange", () => {
    if (!isDM() && !$("#view-dm").hidden) showView("sheet");     // no longer the dungeon master: leave the HQ
    if ($("#view-map").hidden) return;
    applyRole();
    select("", "");
    run(async () => { await loadChoices(); await refresh(); });
  });

  // ---------- dice and "playing as" (this file) ----------
  window.Dice.mount($("#dice-map"));
  document.addEventListener("tabletopas", () => { if (!$("#view-map").hidden) run(refresh); });   // the marked token follows the choice

  // ---------- who can be added: players see characters only; the dungeon master also sees enemies ----------
  async function loadChoices() {
    const dm = isDM();
    const [c, e] = await Promise.all([api.json("/api/characters"), dm ? api.json("/api/enemies") : { enemies: [] }]);
    const group = (label, kind, list) => {
      const g = document.createElement("optgroup");
      g.label = label;
      g.append(...list.map((x) => new Option(x.name, kind + ":" + x.id)));
      return list.length ? [g] : [];
    };
    const keep = addSel.value;
    addSel.replaceChildren(...group("Characters", "character", c.characters), ...group("Enemies", "enemy", e.enemies));
    if (keep) addSel.value = keep;
    $("#map-add-go").disabled = !addSel.options.length;
  }
  $("#map-add-go").addEventListener("click", () => run(async () => {
    const [kind, ref] = addSel.value.split(":");
    if (!ref) throw new Error("There is nobody to add yet. Create a character first.");
    await api.json("/api/map/tokens", { kind, ref });
    await refresh();
    say("Added to the map.");
  }));

  // ---------- tokens ----------
  const els = new Map();                       // token id -> element
  const busy = new Set();                      // tokens being dragged or still being saved: the poll must not move them
  const PATH = (t) => `/api/map/tokens/${t.id}/portrait?v=${t.v}`;

  function build(t) {
    const el = document.createElement("div");
    el.className = "token " + t.kind;
    el.dataset.id = t.id;
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.innerHTML = '<div class="disc"><div class="layer base"></div><div class="layer grey gl"></div><div class="layer grey gr"></div>' +
      '<div class="tint ep"></div><div class="tint fp"></div><span class="mid"></span></div>' +
      '<div class="vit"><span class="ep"></span><span class="fp"></span></div><div class="tname"></div><div class="fxb" hidden></div>';
    return el;
  }
  // The portrait (or the initials when there is none) goes into the three layers.
  function fillLayer(layer, t) {
    const key = t.portrait ? t.v : "initials:" + t.name;
    if (layer.dataset.key === key) return;
    layer.dataset.key = key;
    const initial = () => { const s = document.createElement("span"); s.className = "init"; s.textContent = initials(t.name); layer.replaceChildren(s); };
    if (!t.portrait) return initial();
    const img = new Image();
    img.alt = ""; img.draggable = false;
    img.src = PATH(t);
    img.onerror = () => { layer.dataset.key = ""; initial(); };
    layer.replaceChildren(img);
  }
  const share = (cur, max) => (max > 0 && cur != null ? clamp((cur / max) * 100, 0, 100) : null);   // percent left, or null = unknown

  function paint(el, t) {
    if (t.kind === "enemy" && !isDM()) t = { ...t, hp: null, max: null, fp: null, fpmax: null };   // only the dungeon master sees enemy health
    const ep = share(t.hp, t.max), fp = share(t.fp, t.fpmax);
    ["base", "gl", "gr"].forEach((c) => fillLayer(el.querySelector(c === "base" ? ".layer.base" : ".layer." + c), t));
    // Grey from the top down over the missing part; the tint covers what is left. Left half = Ép, right half = Fp.
    const part = (grey, tint, pct, side) => {
      const left = side === "l", rest = pct == null ? 100 : pct;
      grey.style.clipPath = left ? `inset(0 50% ${rest}% 0)` : `inset(0 0 ${rest}% 50%)`;
      grey.hidden = rest >= 100;
      tint.style.clipPath = left ? `inset(${100 - rest}% 50% 0 0)` : `inset(${100 - rest}% 0 0 50%)`;
      tint.hidden = pct == null;
    };
    part(el.querySelector(".gl"), el.querySelector(".tint.ep"), ep, "l");
    part(el.querySelector(".gr"), el.querySelector(".tint.fp"), fp, "r");
    const vE = el.querySelector(".vit .ep"), vF = el.querySelector(".vit .fp");
    vE.hidden = ep == null; vF.hidden = fp == null;
    if (ep != null) vE.textContent = `${num1(t.hp)}/${num1(t.max)}`;
    if (fp != null) vF.textContent = `${num1(t.fp)}/${num1(t.fpmax)}`;
    el.classList.toggle("down", ep != null && t.hp <= 0);
    el.querySelector(".tname").textContent = t.name;
    const bits = [t.name];
    if (ep != null) bits.push(`Ép ${num1(t.hp)}/${num1(t.max)}`);
    if (fp != null) bits.push(`Fp ${num1(t.fp)}/${num1(t.fpmax)}`);
    const fx = (t.effects || []).filter((e) => e.t == null || e.t > 0);        // the effects that are still on (ended ones are not shown)
    if (fx.length) bits.push("Effects: " + fx.map(effectText).join(", "));
    el.title = bits.join(" · ");
    el.setAttribute("aria-label", el.title);
    const badge = el.querySelector(".fxb");
    badge.hidden = !fx.length;
    badge.textContent = "✦" + fx.length;
    el.classList.toggle("fixed", !canMove(t));
    el.classList.toggle("mine", t.kind === "character" && !!window.Dice.as() && t.ref === window.Dice.as().id);   // the character you play
    if (!busy.has(t.id)) { el.style.left = t.x * 100 + "%"; el.style.top = t.y * 100 + "%"; }
    el.classList.toggle("sel", sel.type === "token" && sel.id === t.id);
  }
  const canMove = (t) => isDM() || t.kind === "character";
  const effectText = (e) => (e.t == null ? e.n : e.t > 0 ? `${e.n} (${e.t})` : `${e.n} (ended)`);

  // ---------- hit points (the sidebar and the token window) ----------
  // The party (everybody sees it) and, for the dungeon master, the enemies. Each token has its own Ép / Fp boxes, which
  // you edit like any number: type, then leave the box. Only the current values are shown; click the title (Ép or Fp) to
  // see the maximum next to it, click it again to hide it. Every enemy token has its own HP, so three goblins are three
  // rows. Players never receive an enemy's HP, so they only get the party. A character whose sheet is locked can only be
  // edited here once it was opened with its password on the sheet tab (the boxes are greyed out until then).
  const showNum = (v) => (v == null ? "" : String(num1(v)));
  const showMax = new Set();                                 // "tokenId:hp" / "tokenId:fp": the maximum was opened by clicking the title
  const maxOf = { hp: "max", fp: "fpmax" };
  const box = (t, f, label) => `<input type="text" inputmode="decimal" autocomplete="off" data-f="${f}" value="${esc(showNum(t[f]))}" aria-label="${esc(t.name)}: ${label}"${t.editable ? "" : " disabled"}${(f === "max" || f === "fpmax") && !isDM() ? ' readonly title="Only the dungeon master can change the maximum"' : ""}>`;
  // One line: the title (a button), the current value and, once the title was clicked, "/ maximum".
  function statLine(t, f, title) {
    const open = showMax.has(t.id + ":" + f);
    return `<div class="sg${open ? " open" : ""}"><button type="button" class="stat-title" data-toggle-max="${f}" aria-expanded="${open}" title="${open ? "Hide" : "Show"} the maximum ${title}">${title}</button>` +
      `${box(t, f, title + " now")}${open ? `<i>/</i>${box(t, maxOf[f], "Max. " + title)}` : ""}</div>`;
  }
  const toggleMax = (id, f) => { const k = id + ":" + f; if (!showMax.delete(k)) showMax.add(k); sideSig = ""; };
  let sideSig = "";
  function sideRow(t) {
    const li = document.createElement("li");
    li.className = "srow " + t.kind + (sel.type === "token" && sel.id === t.id ? " sel" : "");
    li.dataset.id = t.id;
    li.innerHTML =
      `<button type="button" class="sel-btn" data-select title="Show on the map">${esc(t.name)}</button>` +
      `<div class="sgs">${statLine(t, "hp", "Ép")}${statLine(t, "fp", "Fp")}</div>` +
      (t.editable ? '<button type="button" class="btn small" data-full title="Set Ép and Fp to their maximum">Full</button>' : "");
    if (!t.editable) li.title = "This character is locked. Open it with its password on the Character sheet tab first.";
    return li;
  }
  function renderSide() {
    const side = $("#drawer"), dm = isDM();
    const rows = data.tokens.filter((t) => t.kind === "character" || dm);
    const sig = JSON.stringify([dm, [...showMax], rows.map((t) => [t.id, t.kind, t.name, t.hp, t.max, t.fp, t.fpmax, t.editable])]);
    if (sig === sideSig) return;
    if (side.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;   // do not pull the box out from under a typing hand
    sideSig = sig;
    $("#side-party").replaceChildren(...rows.filter((t) => t.kind === "character").map(sideRow));
    $("#side-enemies").replaceChildren(...rows.filter((t) => t.kind === "enemy").map(sideRow));
  }
  // Change one of the numbers of a token (the sidebar and the token window both use this).
  async function setStat(id, field, value) {
    try { await api.json(`/api/map/tokens/${id}/stats`, { [field]: value }); }
    finally { sideSig = ""; await refresh(); }                   // on an error the box goes back to the stored number
  }
  $("#drawer").addEventListener("change", (e) => {
    const input = e.target.closest("input[data-f]"), li = input && input.closest(".srow");
    if (li) run(() => setStat(li.dataset.id, input.dataset.f, input.value));
  });
  $("#drawer").addEventListener("click", (e) => {
    const li = e.target.closest(".srow");
    if (!li) return;
    const t = data.tokens.find((x) => x.id === li.dataset.id);
    if (!t) return;
    const title = e.target.closest("[data-toggle-max]");
    if (title) { toggleMax(t.id, title.dataset.toggleMax); return renderSide(); }
    if (e.target.closest("[data-select]")) return select("token", t.id);
    if (e.target.closest("[data-full]")) run(async () => {
      const body = {};
      if (t.max != null) body.hp = t.max;
      if (t.fpmax != null) body.fp = t.fpmax;
      if (!Object.keys(body).length) throw new Error(`${t.name} has no maximum Ép or Fp yet.`);
      await api.json(`/api/map/tokens/${t.id}/stats`, body);
      sideSig = "";
      await refresh();
    });
  });
  $("#drawer").addEventListener("dblclick", (e) => {
    const li = e.target.closest(".srow");
    if (li && e.target.closest("[data-select]")) window.TableMap.openToken(li.dataset.id);
  });

  // ---------- the sidebar that pops out over the board ----------
  // Closed, only its tab shows at the right edge of the board. Two tabs inside: Ép & Fp, and Initiative (this file).
  function showDTab(name) {
    document.querySelectorAll("[data-dtab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.dtab === name)));
    document.querySelectorAll("[data-dpanel]").forEach((p) => { p.hidden = p.dataset.dpanel !== name; });
    store.set("tabletop-dtab", name);
  }
  function openDrawer(tab) {
    $("#drawer").classList.add("open");
    $("#drawer-tab").setAttribute("aria-expanded", "true");
    $("#drawer-body").inert = false;
    showDTab(tab || store.get("tabletop-dtab") || "hp");
  }
  function closeDrawer() {
    $("#drawer").classList.remove("open");
    $("#drawer-tab").setAttribute("aria-expanded", "false");
    $("#drawer-body").inert = true;
  }
  const drawerOpen = () => $("#drawer").classList.contains("open");
  $("#drawer-tab").addEventListener("click", () => (drawerOpen() ? closeDrawer() : openDrawer()));
  $("#drawer-close").addEventListener("click", () => { closeDrawer(); $("#drawer-tab").focus(); });
  document.querySelectorAll("[data-dtab]").forEach((b) => b.addEventListener("click", () => showDTab(b.dataset.dtab)));
  $("#combat-open").addEventListener("click", () => openDrawer("init"));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && drawerOpen() && $("#drawer").contains(document.activeElement)) { closeDrawer(); $("#drawer-tab").focus(); } });

  // What the token window and the initiative tab (the next sections) use of this section.
  window.TableMap = {
    data: () => data, refresh: () => refresh(), say, isDM, api, esc, run, statLine, toggleMax, setStat, effectText, showMax,
    openDrawer, closeDrawer, showDTab, drawerOpen,
    openToken() {},                                                              // set by this file
    setTab(text, sub) {                                                          // the label of the sidebar's tab at the edge of the board
      $("#drawer-tab-text").textContent = text;
      $("#drawer-tab-sub").textContent = sub || "";
      $("#drawer-tab-sub").hidden = !sub;
    },
  };

  // ---------- walls and doors ----------
  let geoSig = "";
  function drawGeo() {
    const sig = JSON.stringify([data.walls, data.doors, sel, isDM()]);
    if (sig === geoSig) return;
    geoSig = sig;
    const line = (cls, o, extra = "") => `<line class="${cls}" x1="${o.x1}" y1="${o.y1}" x2="${o.x2}" y2="${o.y2}" ${extra}/>`;
    const hit = (type, o) => line("hit", o, `data-t="${type}" data-id="${o.id}"`);
    const isSel = (type, id) => sel.type === type && sel.id === id;
    geoG.innerHTML =
      data.walls.map((w) => line("wall" + (isSel("wall", w.id) ? " sel" : ""), w) + (isDM() ? hit("wall", w) : "")).join("") +
      data.doors.map((d) => {
        const lock = d.locked ? `<text class="lock" x="${(d.x1 + d.x2) / 2}" y="${(d.y1 + d.y2) / 2 - .35}">🔒</text>` : "";
        return line(`door ${d.open ? "open" : "closed"}${d.locked ? " locked" : ""}${isSel("door", d.id) ? " sel" : ""}`, d) + hit("door", d) + lock;
      }).join("");
  }

  // ---------- refreshing from the server ----------
  async function refresh() {
    data = await api.json("/api/map");
    const dm = isDM();
    $("#hidden-badge").hidden = !(dm && data.hidden);
    $("#map-hide").textContent = data.hidden ? "Show map to players" : "Hide map from players";
    if (document.activeElement !== $("#map-vision")) $("#map-vision").value = data.vision;
    cover.hidden = !(data.hidden && !dm);

    const ids = new Set(data.tokens.map((t) => t.id));
    for (const [id, el] of els) if (!ids.has(id)) { el.remove(); els.delete(id); busy.delete(id); if (sel.id === id) select("", ""); }
    for (const t of data.tokens) {
      let el = els.get(t.id);
      if (!el) { el = build(t); els.set(t.id, el); board.append(el); }
      paint(el, t);
    }
    if (sel.type === "wall" && !data.walls.some((w) => w.id === sel.id)) select("", "");
    if (sel.type === "door" && !data.doors.some((d) => d.id === sel.id)) select("", "");
    drawGeo();
    renderSide();

    if (data.fog) {
      if (fogImg.dataset.h !== data.fog) { fogImg.dataset.h = data.fog; fogImg.src = "/api/map/fog.png?h=" + data.fog; }
      fogImg.hidden = dm && !$("#fog-preview").checked;
      fogImg.classList.toggle("preview", dm);
    } else fogImg.hidden = true;
    $("#map-empty").hidden = data.tokens.length > 0 || (data.hidden && !dm);
    updateButtons();
    document.dispatchEvent(new CustomEvent("mapdata", { detail: data }));       // the token window and the initiative tab draw from it
  }

  // ---------- selection ----------
  function select(type, id) {
    sel = { type, id };
    els.forEach((el, k) => el.classList.toggle("sel", type === "token" && k === id));
    document.querySelectorAll(".srow").forEach((li) => li.classList.toggle("sel", type === "token" && li.dataset.id === id));
    geoSig = "";
    drawGeo();
    updateButtons();
  }
  function updateButtons() {
    const door = sel.type === "door" ? data.doors.find((d) => d.id === sel.id) : null;
    const tok = sel.type === "token" ? data.tokens.find((t) => t.id === sel.id) : null;
    $("#map-remove").disabled = !sel.type || (!isDM() && !(tok && tok.kind === "character"));
    $("#door-toggle").disabled = !door;
    $("#door-lock").disabled = !door;
    $("#door-lock").textContent = door && door.locked ? "Unlock door" : "Lock door";
  }

  // ---------- dragging tokens ----------
  let drag = null;
  board.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || tool === "measure") return;           // the measuring tool uses clicks on tokens itself
    const el = e.target.closest(".token");
    if (!el) { if (!e.target.closest(".hit")) select("", ""); return; }
    const id = el.dataset.id, r = board.getBoundingClientRect(), t = data.tokens.find((x) => x.id === id);
    if (!t) return;
    select("token", id);
    if (!canMove(t)) return;
    busy.add(id);
    // Remember where inside the token the pointer grabbed it, so it does not jump to centre on the pointer.
    drag = { id, el, r, dx: e.clientX - (r.left + t.x * r.width), dy: e.clientY - (r.top + t.y * r.height), x: t.x, y: t.y, moved: false };
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  board.addEventListener("pointermove", (e) => {
    if (!drag) return;
    drag.moved = true;
    drag.el.classList.add("drag");
    drag.x = clamp((e.clientX - drag.dx - drag.r.left) / drag.r.width, 0, 1);
    drag.y = clamp((e.clientY - drag.dy - drag.r.top) / drag.r.height, 0, 1);
    drag.el.style.left = drag.x * 100 + "%";
    drag.el.style.top = drag.y * 100 + "%";
  });
  async function drop() {
    if (!drag) return;
    const { id, el, x, y, moved } = drag;
    drag = null;
    el.classList.remove("drag");
    if (!moved) { busy.delete(id); return; }
    const t = data.tokens.find((q) => q.id === id);
    if (t) { t.x = x; t.y = y; }
    try { await api.json("/api/map/tokens/" + id, { x, y }); await refresh(); }
    catch (err) { say(err.message || String(err), true); }
    busy.delete(id);
  }
  board.addEventListener("pointerup", drop);
  board.addEventListener("pointercancel", drop);

  // ---------- drawing walls and doors (dungeon master) ----------
  const drawing = () => tool === "wall" || tool === "door";      // the tools only the dungeon master can use
  function setTool(next) {
    tool = next;
    endChain();
    clearMeasure();
    $("#measure-opts").hidden = tool !== "measure";
    if (tool === "measure") say("Measure: snaps to tile centres and tokens. Esc clears the line.");
    else if (next === "move") say("");
    board.classList.toggle("drawing", tool !== "move");
    document.querySelectorAll("[data-tool]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tool === tool)));
  }
  document.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool === "measure" && tool === "measure" ? "move" : b.dataset.tool)));

  const snap = (v) => Math.round(v * 2) / 2;
  const cellAt = (e) => {
    const r = board.getBoundingClientRect();
    return { x: clamp(snap(((e.clientX - r.left) / r.width) * CW), 0, CW), y: clamp(snap(((e.clientY - r.top) / r.height) * CH), 0, CH) };
  };
  function showPreview(to) {
    pv.hidden = !chain;
    if (!chain) return;
    pv.setAttribute("x1", chain.x); pv.setAttribute("y1", chain.y);
    pv.setAttribute("x2", to ? to.x : chain.x); pv.setAttribute("y2", to ? to.y : chain.y);
  }
  function endChain() { chain = null; gesture = null; showPreview(); $("#chain-end").hidden = true; }
  $("#chain-end").addEventListener("click", endChain);

  async function commit(a, b) {
    if (Math.hypot(b.x - a.x, b.y - a.y) < 0.4) return;
    const kind = tool === "door" ? "doors" : "walls";
    await api.json("/api/map/" + kind, { x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    await refresh();
  }
  const afterCommit = (p) => { if (tool === "wall") { chain = { x: p.x, y: p.y }; $("#chain-end").hidden = false; showPreview(p); } else endChain(); };

  board.addEventListener("pointerdown", (e) => {
    if (!drawing() || !isDM() || e.button !== 0) return;
    const p = cellAt(e);
    if (!chain) { chain = p; gesture = { x: p.x, y: p.y }; $("#chain-end").hidden = tool !== "wall"; showPreview(p); return; }
    const from = chain;
    afterCommit(p);
    run(() => commit(from, p));
  });
  board.addEventListener("pointermove", (e) => { if (chain && tool !== "move") showPreview(cellAt(e)); });
  board.addEventListener("pointerup", (e) => {              // dragging from one point to another works too
    if (!gesture || !drawing()) return;
    const p = cellAt(e), from = gesture;
    gesture = null;
    if (Math.hypot(p.x - from.x, p.y - from.y) >= 0.4) { afterCommit(p); run(() => commit(from, p)); }
  });
  board.addEventListener("dblclick", (e) => {
    if (drawing()) return endChain();
    const el = e.target.closest(".token");
    if (el && tool === "move") window.TableMap.openToken(el.dataset.id);      // double-click a token: its Ép, Fp and effects
  });
  board.addEventListener("contextmenu", (e) => { if (tool !== "move") { e.preventDefault(); endChain(); clearMeasure(); } });

  // ---------- measuring distances (everybody) ----------
  // Click or drag from one spot to another. Each end snaps to the centre of a tile, or to the centre of a token when the
  // pointer is on one. The distance is the straight line between the two, in tiles (and in metres, or another unit, when
  // "1 tile =" is filled in). A click starts the line and the next click ends it; a drag works too. Nothing is sent to
  // the server: everybody measures for themselves.
  let ms = null;                                              // {a, b, fixed, drag}: the points are {x, y, name?} in tile units
  const spot = (e) => {
    const r = board.getBoundingClientRect();
    const x = clamp(((e.clientX - r.left) / r.width) * CW, 0, CW), y = clamp(((e.clientY - r.top) / r.height) * CH, 0, CH);
    const reach = Math.max(0.5, (+$("#map-size").value / 2) / (r.width / CW));         // a token's radius, in tiles
    let best = null, near = reach;
    for (const t of data.tokens) {
      const d = Math.hypot(t.x * CW - x, t.y * CH - y);
      if (d <= near) { best = t; near = d; }
    }
    return best ? { x: best.x * CW, y: best.y * CH, name: best.name }
                : { x: clamp(Math.floor(x) + 0.5, 0.5, CW - 0.5), y: clamp(Math.floor(y) + 0.5, 0.5, CH - 0.5) };
  };
  function clearMeasure() {
    ms = null;
    for (const id of ["m-line", "m-a", "m-b", "m-label"]) { const el = document.getElementById(id); if (el) el.hidden = true; }
  }
  function drawMeasure() {
    if (!ms) return clearMeasure();
    const { a, b } = ms, tiles = Math.hypot(b.x - a.x, b.y - a.y), line = $("#m-line");
    line.setAttribute("x1", a.x); line.setAttribute("y1", a.y); line.setAttribute("x2", b.x); line.setAttribute("y2", b.y);
    for (const [id, p] of [["m-a", a], ["m-b", b]]) {
      const dot = $("#" + id);
      dot.style.left = (p.x / CW) * 100 + "%"; dot.style.top = (p.y / CH) * 100 + "%"; dot.hidden = false;
    }
    const scale = parseFloat($("#measure-scale").value.replace(",", ".")), unit = $("#measure-unit").value.trim();
    let text = `${num1(tiles)} ${num1(tiles) === 1 ? "tile" : "tiles"}`;
    if (scale > 0) text += ` · ${+(tiles * scale).toFixed(1)} ${unit}`;
    if (a.name && b.name) text = `${a.name} → ${b.name}: ${text}`;
    const label = $("#m-label");
    label.textContent = text;
    label.style.left = ((a.x + b.x) / 2 / CW) * 100 + "%"; label.style.top = ((a.y + b.y) / 2 / CH) * 100 + "%";
    line.hidden = label.hidden = false;
  }
  board.addEventListener("pointerdown", (e) => {
    if (tool !== "measure" || e.button !== 0) return;
    const p = spot(e);
    if (!ms || ms.fixed) ms = { a: p, b: p, fixed: false, drag: true };
    else { ms.b = p; ms.fixed = true; }                       // the second click ends the line
    board.setPointerCapture(e.pointerId);
    drawMeasure();
    e.preventDefault();
  });
  board.addEventListener("pointermove", (e) => {
    if (tool !== "measure" || !ms || ms.fixed) return;
    ms.b = spot(e);
    drawMeasure();
  });
  board.addEventListener("pointerup", () => {
    if (tool !== "measure" || !ms || ms.fixed || !ms.drag) return;
    ms.drag = false;
    if (Math.hypot(ms.b.x - ms.a.x, ms.b.y - ms.a.y) > 0.25) ms.fixed = true;      // dragged: done. Only clicked: the next click is the end
  });
  ["measure-scale", "measure-unit"].forEach((id) => {
    const k = "tabletop-" + id, box = $("#" + id);
    if (store.get(k)) box.value = store.get(k);
    box.addEventListener("input", () => { store.set(k, box.value); drawMeasure(); });
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && tool === "measure") clearMeasure(); });

  // ---------- doors ----------
  async function toggleDoor(id) {
    await api.json(`/api/map/doors/${id}/toggle`, {});
    await refresh();
  }
  geoG.addEventListener("click", (e) => {
    const h = e.target.closest(".hit");
    if (!h || tool !== "move") return;
    const type = h.dataset.t, id = h.dataset.id;
    if (!isDM()) { if (type === "door") run(() => toggleDoor(id)); return; }       // players: one click opens a door
    select(type, id);
  });
  geoG.addEventListener("dblclick", (e) => {                                      // the dungeon master: double-click
    const h = e.target.closest('.hit[data-t="door"]');
    if (h && isDM() && tool === "move") run(() => toggleDoor(h.dataset.id));
  });
  $("#door-toggle").addEventListener("click", () => run(() => toggleDoor(sel.id)));
  $("#door-lock").addEventListener("click", () => run(async () => {
    const door = data.doors.find((d) => d.id === sel.id);
    if (!door) return;
    await api.json(`/api/map/doors/${door.id}/lock`, { locked: !door.locked });
    await refresh();
  }));

  // ---------- removing ----------
  $("#map-remove").addEventListener("click", () => run(async () => {
    if (!sel.type) return;
    const path = { token: "tokens", wall: "walls", door: "doors" }[sel.type];
    const tok = sel.type === "token" ? data.tokens.find((t) => t.id === sel.id) : null;
    await api.json(`/api/map/${path}/${sel.id}/delete`, {});
    select("", "");
    await refresh();
    say(tok ? `Took ${tok.name} off the map. The sheet is untouched.` : "Removed.");
  }));

  // Arrow keys nudge the selected token (Shift = bigger steps); Delete removes; Escape stops drawing.
  const typing = (e) => e.target.closest("input, select, textarea");
  document.addEventListener("keydown", (e) => {
    if ($("#view-map").hidden || typing(e) || $("#saves").open) return;
    if (e.key === "Escape") return endChain();
    if (!sel.type) return;
    if (e.key === "Delete") { e.preventDefault(); return $("#map-remove").click(); }
    const t = sel.type === "token" ? data.tokens.find((x) => x.id === sel.id) : null, el = t && els.get(t.id);
    if (!t || !el || !canMove(t)) return;
    const st = e.shiftKey ? 0.05 : 0.01;
    const d = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] }[e.key];
    if (!d) return;
    e.preventDefault();
    t.x = clamp(t.x + d[0], 0, 1); t.y = clamp(t.y + d[1], 0, 1);
    el.style.left = t.x * 100 + "%"; el.style.top = t.y * 100 + "%";
    busy.add(t.id);
    api.json("/api/map/tokens/" + t.id, { x: t.x, y: t.y }).catch((err) => say(err.message, true)).finally(() => busy.delete(t.id));
  });

  // ---------- map settings (dungeon master) ----------
  const vision = $("#map-vision");
  vision.addEventListener("change", () => run(async () => {
    await api.json("/api/map/settings", { vision: +vision.value });
    await refresh();
  }));
  $("#map-hide").addEventListener("click", () => run(async () => {
    await api.json("/api/map/settings", { hidden: !data.hidden });
    await refresh();
    say(data.hidden ? "The map is hidden from players. Arrange it in peace." : "Players can see the map again.");
  }));
  $("#fog-preview").addEventListener("change", () => { store.set("tabletop-fog", $("#fog-preview").checked ? "on" : "off"); fogImg.hidden = isDM() && !$("#fog-preview").checked || !data.fog; });
  if (store.get("tabletop-fog") === "off") $("#fog-preview").checked = false;
  $("#fog-reset").addEventListener("click", () => run(async () => {
    if (!confirm("Forget everything the players have explored? They will only see what their characters see right now.")) return;
    await api.json("/api/map/fog/reset", {});
    await refresh();
    say("The explored area was reset.");
  }));

  // ---------- save and load maps (dungeon master) ----------
  const dlg = $("#saves"), saveStatus = $("#save-status");
  const sayS = (text, error) => { saveStatus.textContent = text; saveStatus.classList.toggle("error", !!error); };
  let saves = [];
  async function loadSaves() {
    saves = (await api.json("/api/map/saves")).saves;
    $("#save-list").replaceChildren(...saves.map((s) => {
      const li = document.createElement("li");
      const info = document.createElement("span"), name = document.createElement("strong"), meta = document.createElement("small");
      info.className = "sn";
      name.textContent = s.name;
      meta.textContent = `${new Date(s.saved * 1000).toLocaleString()} · ${s.tokens} token${s.tokens === 1 ? "" : "s"}, ${s.walls} wall${s.walls === 1 ? "" : "s"}, ${s.doors} door${s.doors === 1 ? "" : "s"}`;
      info.append(name, meta);
      const load = document.createElement("button"), del = document.createElement("button");
      load.className = del.className = "btn small";
      load.type = del.type = "button";
      load.textContent = "Load"; del.textContent = "Delete";
      load.dataset.act = "load"; del.dataset.act = "delete";
      li.dataset.id = s.id;
      li.append(info, load, del);
      return li;
    }));
  }
  $("#saves-open").addEventListener("click", () => run(async () => { sayS(""); await loadSaves(); dlg.showModal(); $("#save-name").focus(); }));
  $("#saves-close").addEventListener("click", () => dlg.close());
  $("#save-go").addEventListener("click", async () => {
    try {
      const name = $("#save-name").value.trim();
      if (!name) throw new Error("Give the save a name.");
      if (saves.some((s) => s.name.toLowerCase() === name.toLowerCase()) && !confirm(`Replace the saved map “${name}”?`)) return;
      const r = await api.json("/api/map/saves", { name });
      await loadSaves();
      sayS(r.replaced ? `Replaced “${r.name}”.` : `Saved “${r.name}”.`);
    } catch (err) { sayS(err.message || String(err), true); }
  });
  $("#save-list").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    const s = b && saves.find((x) => x.id === b.closest("li").dataset.id);
    if (!s) return;
    try {
      if (b.dataset.act === "delete") {
        if (!confirm(`Delete the saved map “${s.name}”? This cannot be undone.`)) return;
        await api.json(`/api/map/saves/${s.id}/delete`, {});
        await loadSaves();
        sayS(`Deleted “${s.name}”.`);
      } else {
        if (!confirm(`Load “${s.name}”? The current map (tokens, walls, doors and explored area) is replaced. Save it first if you want to keep it.`)) return;
        await api.json(`/api/map/saves/${s.id}/load`, {});
        dlg.close();
        select("", "");
        await refresh();
        say(`Loaded “${s.name}”. Hidden from players.`);
      }
    } catch (err) { sayS(err.message || String(err), true); }
  });
  dlg.addEventListener("click", (e) => {                         // a click on the backdrop closes it
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
  });

  // ---------- token size (a personal setting, kept in this browser) ----------
  const size = $("#map-size");
  const applySize = () => board.style.setProperty("--tok", size.value + "px");
  if (store.get("tabletop-token")) size.value = store.get("tabletop-token");
  applySize();
  size.addEventListener("input", () => { applySize(); store.set("tabletop-token", size.value); });

  // The role is asked first (the role part of this file); then open on the map again if that is where the person was.
  window.Role.ready.then(() => {
  applyRole();
  const want = location.hash === "#dm" ? "dm" : store.get("tabletop-view");        // #dm: the old Dungeon Master HQ address
  if (want === "map" || want === "dm") showView(want);
});
})();

// ====================================================================================================
// 5. Token window (double-click): Ép, Fp, effects
// ====================================================================================================

// The window of a token on the map (double-click the token, or its name in the sidebar): Ép, Fp and the effects with the
// turns they have left. Every change is saved as soon as you leave the box; the map and the sidebar follow. Click Ép or Fp
// to see the maximum. Enemies show effects only to players (their health is the dungeon master's secret).
// Effects: a name and the turns left (empty = no limit). Combat counts the turns down (this file); one that ran out
// stays on the list, marked "ended", until it is deleted. What a player may change is decided by the server.
(function () {
  const M = window.TableMap, $ = (s) => document.querySelector(s);
  const dlg = $("#token-dialog"), body = $("#token-body"), status = $("#token-status");
  let id = "", sig = "";
  const token = () => M.data().tokens.find((t) => t.id === id);
  const say = (text, error) => { status.textContent = text; status.classList.toggle("error", !!error); };
  const run = async (fn) => { try { await fn(); } catch (err) { say(err.message || String(err), true); render(true); } };

  const effectRow = (e, editable) => {
    const ended = e.t != null && e.t <= 0;
    return `<li class="fx${ended ? " ended" : ""}" data-fx>` +
      `<input type="text" data-n maxlength="40" value="${M.esc(e.n)}" aria-label="Effect"${editable ? "" : " disabled"}>` +
      `<input type="number" data-t step="1" min="-999" max="999" value="${e.t == null ? "" : e.t}" placeholder="∞" aria-label="Turns left (empty: no limit)" title="Turns left (empty: no limit)"${editable ? "" : " disabled"}>` +
      (editable ? '<button type="button" class="btn small" data-del aria-label="Delete this effect" title="Delete">✕</button>' : "") +
      (ended ? '<small class="ended-tag">ended</small>' : "") + "</li>";
  };

  function render(force) {
    const t = token();
    if (!t) { if (dlg.open) dlg.close(); return; }
    const mine = (t.effects || []).length;
    const next = JSON.stringify([t, [...M.showMax], M.isDM()]);
    if (!force && next === sig) return;
    if (!force && dlg.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;   // never pull a box from under a typing hand
    sig = next;
    const stats = t.kind === "character" || M.isDM();                       // players never get an enemy's health
    $("#token-title").textContent = t.name;
    body.innerHTML =
      (stats ? `<div class="sgs tok-stats">${M.statLine(t, "hp", "Ép")}${M.statLine(t, "fp", "Fp")}</div>` : "") +
      `<h3 class="tok-sub">Effects</h3>` +
      `<ul class="fxlist" aria-label="Effects">${(t.effects || []).map((e) => effectRow(e, t.editable)).join("")}</ul>` +
      (mine ? "" : '<p class="hint nomargin">No effects.</p>') +
      (t.editable ? `<form class="fxadd" data-add><input type="text" data-n maxlength="40" placeholder="New effect" aria-label="New effect" autocomplete="off">` +
        `<input type="number" data-t step="1" min="-999" max="999" placeholder="turns" aria-label="Turns (empty: no limit)" title="Turns (empty: no limit)">` +
        `<button class="btn primary small" type="submit">Add</button></form>` : "");
  }

  // The effects as they are in the window now, sent to the server as a whole list.
  function readEffects() {
    return [...body.querySelectorAll(".fxlist [data-fx]")].map((li) => {
      const turns = li.querySelector("[data-t]").value.trim();
      return { n: li.querySelector("[data-n]").value.trim(), t: turns === "" ? null : parseInt(turns, 10) };
    }).filter((e) => e.n);
  }
  async function saveEffects(list) {
    say("");
    await M.api.json(`/api/map/tokens/${id}/effects`, { effects: list });
    await M.refresh();
    render(true);
  }

  body.addEventListener("change", (e) => {
    const stat = e.target.closest("input[data-f]"), row = e.target.closest("[data-fx]");
    if (stat) run(async () => { await M.setStat(id, stat.dataset.f, stat.value); render(true); });
    else if (row) run(() => saveEffects(readEffects()));
  });
  body.addEventListener("click", (e) => {
    const title = e.target.closest("[data-toggle-max]"), del = e.target.closest("[data-del]");
    if (title) { M.toggleMax(id, title.dataset.toggleMax); render(true); }
    else if (del) { del.closest("[data-fx]").remove(); run(() => saveEffects(readEffects())); }
  });
  body.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.target.closest("[data-add]"), name = form.querySelector("[data-n]").value.trim(), turns = form.querySelector("[data-t]").value.trim();
    if (!name) return say("Give the effect a name.", true);
    run(() => saveEffects([...readEffects(), { n: name, t: turns === "" ? null : parseInt(turns, 10) }]));
  });

  $("#token-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });          // a click on the backdrop
  dlg.addEventListener("close", () => { id = ""; sig = ""; say(""); });
  document.addEventListener("mapdata", () => { if (dlg.open) render(false); });

  M.openToken = (tid) => {
    id = tid; sig = "";
    if (!token()) return;
    say("");
    render(true);
    if (!dlg.open) dlg.showModal();
  };
})();

// ====================================================================================================
// 6. Combat mode: the Initiative tab
// ====================================================================================================

// The Initiative tab of the map's sidebar: combat mode. The dungeon master turns it on and picks who fights (players and
// monsters); then everybody taking part rolls k10 + KÉ. A character rolls with its KÉ without a weapon, but clicking
// Roll initiative also offers k10 + KÉ with each weapon (the server knows the numbers). The order is highest first and the
// dungeon master can move anybody. When the DM begins, "Next turn" passes the turn on and counts down the effects (see
// processing/battlemap.py for which ones); "Previous turn" takes it back and counts them up again. All of it lives on the
// server and is drawn from the "mapdata" event of this file, so everybody sees the same order.
(function () {
  const M = window.TableMap, $ = (s) => document.querySelector(s), esc = M.esc, api = M.api;
  const root = $("#init-panel");
  root.innerHTML = '<p class="status" id="init-status" role="status" aria-live="polite"></p><div id="init-content"></div>';
  const content = $("#init-content"), status = $("#init-status");
  let data = { tokens: [], combat: null }, combat = null, setup = null, menu = null, sig = "", hadCombat = null;

  const say = (text, error) => { status.textContent = text; status.classList.toggle("error", !!error); };
  const run = async (fn) => { try { await fn(); } catch (err) { say(err.message || String(err), true); } };
  const post = async (action, extra) => { await api.json("/api/map/combat", { action, ...extra }); await M.refresh(); };
  const token = (id) => data.tokens.find((t) => t.id === id);
  const canRoll = (e) => { const t = token(e.id); return !!t && (M.isDM() || (t.kind === "character" && t.editable)); };
  const plus = (n) => (n < 0 ? "−" : "+") + " " + Math.abs(n);

  // ---------- the label of the sidebar's tab at the edge of the board ----------
  function paintTab() {
    if (!combat) return M.setTab("Ép / Fp", "");
    if (combat.phase === "initiative") return M.setTab("⚔ Initiative", combat.pending ? `${combat.pending} to roll` : "ready");
    const cur = combat.order.find((e) => e.id === combat.current);
    M.setTab(`⚔ Round ${combat.round}`, cur ? cur.name : combat.unseen_turn ? "?" : "");
  }

  // ---------- drawing ----------
  function pickList(kind, title) {
    const list = data.tokens.filter((t) => t.kind === kind);
    return `<h4 class="init-sub">${title}</h4><ul class="pick">` + (list.length ? list.map((t) =>
      `<li><label class="check"><input type="checkbox" data-pick="${t.id}"${setup.ids.has(t.id) ? " checked" : ""}> ${esc(t.name)}</label></li>`).join("") : '<li class="hint">Nobody on the map.</li>') + "</ul>";
  }
  function setupHtml() {
    return `<h3 class="init-title">${setup.edit ? "Who is in the combat?" : "Combat mode: who is fighting?"}</h3>` +
      '<div class="actions"><button class="btn small" data-act="pick-players">All players</button><button class="btn small" data-act="pick-monsters">All monsters</button><button class="btn small" data-act="pick-none">None</button></div>' +
      pickList("character", "Players") + pickList("enemy", "Monsters") +
      `<div class="actions"><button class="btn primary" data-act="${setup.edit ? "save-fighters" : "start"}"${setup.ids.size ? "" : " disabled"}>${setup.edit ? "Save fighters" : `Start combat (${setup.ids.size})`}</button><button class="btn" data-act="cancel">Cancel</button></div>`;
  }
  function entryHtml(e, i, dm) {
    const cur = e.id === combat.current, pending = e.total == null;
    const detail = pending ? "" : e.roll == null ? esc(e.label) : `k10: ${e.roll} ${plus(e.bonus)} · ${esc(e.label)}`;
    let right = "";
    if (pending && canRoll(e)) right = `<button class="btn small primary" data-act="roll" data-id="${e.id}">Roll initiative</button>`;
    else if (pending) right = '<span class="hint">waiting…</span>';
    const rollMenu = menu && menu.id === e.id ? (menu.choices
      ? `<div class="rollmenu" role="group" aria-label="Roll initiative with">${menu.choices.map((c, k) =>
          `<button type="button" class="btn small${k === 0 ? " primary" : ""}" data-act="roll-with" data-id="${e.id}" data-choice="${c.choice}">${esc(c.label)} · k10 ${plus(c.bonus)}</button>`).join("")}<button type="button" class="btn small" data-act="roll-cancel">Cancel</button></div>`
      : '<div class="rollmenu hint">Looking up the rolls…</div>') : "";
    const dmBtns = dm ? `<span class="ord-tools"><button class="btn small" data-act="up" data-id="${e.id}" aria-label="Move ${esc(e.name)} up" title="Earlier in the order"${i === 0 ? " disabled" : ""}>▲</button>` +
      `<button class="btn small" data-act="down" data-id="${e.id}" aria-label="Move ${esc(e.name)} down" title="Later in the order"${i === combat.order.length - 1 ? " disabled" : ""}>▼</button>` +
      `<button class="btn small" data-act="set" data-id="${e.id}" aria-label="Set the initiative of ${esc(e.name)}" title="Set the number by hand">✎</button>` +
      (pending ? "" : `<button class="btn small" data-act="clear" data-id="${e.id}" aria-label="Clear the roll of ${esc(e.name)}" title="Clear the roll, so it can be rolled again">↺</button>`) + "</span>" : "";
    return `<li class="ord ${e.kind}${cur ? " cur" : ""}${pending ? " pending" : ""}" data-id="${e.id}"${cur ? ' aria-current="true"' : ""}>` +
      `<span class="ord-mark" aria-hidden="true">${cur ? "▶" : ""}</span><span class="ord-name">${esc(e.name)}</span><span class="ord-total">${pending ? "—" : e.total}</span>` +
      (detail ? `<small class="ord-det">${detail}</small>` : "") + (right ? `<span class="ord-act">${right}</span>` : "") + dmBtns + rollMenu + "</li>";
  }
  function combatHtml() {
    const dm = M.isDM(), c = combat, me = window.Dice.as();
    const mine = !!me && !!token(c.current) && token(c.current).kind === "character" && token(c.current).ref === me.id;        // the character you roll as
    const phase = c.phase === "initiative" ? `Rolling initiative${c.pending ? ` · ${c.pending} to go` : " · everybody has rolled"}` : `Round ${c.round}`;
    let controls = "";
    if (dm) {
      controls = '<div class="actions init-ctl">' + (c.phase === "initiative"
        ? '<button class="btn small" data-act="roll-monsters">Roll for all monsters</button>' + `<button class="btn primary small" data-act="begin">${c.pending ? "Begin anyway" : "Begin the combat"}</button>`
        : '<button class="btn small" data-act="prev" title="Take the turn back: effects count up again">◀ Previous turn</button><button class="btn primary small" data-act="next" title="Next turn: effects count down">Next turn ▶</button>') +
        '<button class="btn small" data-act="fighters">Fighters…</button><button class="btn small" data-act="end">End combat</button></div>' +
        `<label class="field tick">Effects count down <select data-tick><option value="own"${c.tick === "own" ? " selected" : ""}>on the turn of the one who has them</option><option value="all"${c.tick === "all" ? " selected" : ""}>every turn, for everybody</option></select></label>`;
    }
    return `<div class="chead"><strong>${phase}</strong></div>` + (mine ? '<p class="yourturn">It is your turn!</p>' : "") +
      (c.unseen_turn ? '<p class="hint">Something you cannot see is acting.</p>' : "") + controls +
      `<ol class="order" aria-label="Turn order">${c.order.map((e, i) => entryHtml(e, i, dm)).join("")}</ol>` +
      (c.order.length ? "" : '<p class="hint">Nobody you can see is in the combat.</p>');
  }
  function render(force) {
    paintTab();
    const dm = M.isDM();
    const next = JSON.stringify([dm, combat, setup && [...setup.ids, setup.edit], menu, data.tokens.map((t) => [t.id, t.name, t.kind, t.editable])]);
    if (!force && next === sig) return;
    if (!force && root.contains(document.activeElement) && /^(INPUT|SELECT)$/.test(document.activeElement.tagName)) return;
    sig = next;
    content.innerHTML = setup && dm ? setupHtml() : combat ? combatHtml()
      : dm ? '<p>No combat is going on. Turn combat mode on to pick who fights and roll for initiative.</p><button class="btn primary" data-act="setup">⚔ Turn combat mode on</button>'
      : '<p class="hint">No combat right now. The dungeon master starts it here.</p>';
  }

  // ---------- doing things ----------
  const picked = (kind) => data.tokens.filter((t) => t.kind === kind).map((t) => t.id);
  async function rollWith(id, choice) {
    const r = await api.json(`/api/map/tokens/${id}/initiative`, { choice });
    menu = null;
    say(`Rolled ${r.total}.`);
    await M.refresh();
  }
  const ACTS = {
    setup() { setup = { ids: new Set(picked("character")), edit: false }; render(true); },
    cancel() { setup = null; render(true); },
    "pick-players"() { picked("character").forEach((i) => setup.ids.add(i)); render(true); },
    "pick-monsters"() { picked("enemy").forEach((i) => setup.ids.add(i)); render(true); },
    "pick-none"() { setup.ids.clear(); render(true); },
    async start() { await api.json("/api/map/combat", { action: "start", ids: [...setup.ids] }); setup = null; await M.refresh(); render(true); M.openDrawer("init"); },
    fighters() { setup = { ids: new Set(combat.order.map((e) => e.id)), edit: true }; render(true); },
    async "save-fighters"() { await api.json("/api/map/combat", { action: "participants", ids: [...setup.ids] }); setup = null; await M.refresh(); render(true); },
    async begin() {
      if (combat.pending && !confirm(`${combat.pending} have not rolled initiative. Begin without them? They leave the combat.`)) return;
      await post("begin", { force: combat.pending > 0 });
    },
    next: () => post("next"),
    prev: () => post("prev"),
    async end() { if (confirm("End the combat?")) { await post("end"); menu = null; } },
    up: (b) => post("move", { id: b.dataset.id, to: combat.order.findIndex((e) => e.id === b.dataset.id) - 1 }),
    down: (b) => post("move", { id: b.dataset.id, to: combat.order.findIndex((e) => e.id === b.dataset.id) + 1 }),
    async set(b) {
      const e = combat.order.find((x) => x.id === b.dataset.id), v = prompt(`Initiative of ${e.name}:`, e.total == null ? "" : e.total);
      if (v !== null) await post("set_init", { id: e.id, total: v });
    },
    async clear(b) { await api.json(`/api/map/tokens/${b.dataset.id}/initiative/clear`, {}); await M.refresh(); },
    async roll(b) {                                              // the rolls to choose from: KÉ without a weapon first, then each weapon
      const id = b.dataset.id;
      menu = { id, choices: null }; render(true);
      const { choices } = await api.json(`/api/map/tokens/${id}/initiative`);
      if (choices.length === 1) return rollWith(id, choices[0].choice);       // nothing to choose (a monster has one KÉ)
      menu = { id, choices }; render(true);
    },
    "roll-with": (b) => rollWith(b.dataset.id, +b.dataset.choice),
    "roll-cancel"() { menu = null; render(true); },
    async "roll-monsters"() {
      for (const e of combat.order.filter((x) => x.total == null && token(x.id) && token(x.id).kind === "enemy")) await api.json(`/api/map/tokens/${e.id}/initiative`, { choice: -1 });
      await M.refresh();
    },
  };
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (b && ACTS[b.dataset.act]) { say(""); run(async () => { try { await ACTS[b.dataset.act](b); } catch (err) { menu = null; render(true); throw err; } }); }
  });
  root.addEventListener("change", (e) => {
    const pick = e.target.closest("[data-pick]"), tick = e.target.closest("[data-tick]");
    if (pick && setup) { pick.checked ? setup.ids.add(pick.dataset.pick) : setup.ids.delete(pick.dataset.pick); render(true); }
    else if (tick) run(() => post("tick", { mode: tick.value }));
  });

  document.addEventListener("mapdata", (e) => {
    data = e.detail; combat = data.combat;
    if (!combat) { menu = null; if (setup && setup.edit) setup = null; }
    if (hadCombat === false && combat && combat.phase === "initiative") M.openDrawer("init");        // a combat has just begun: show everybody the tab
    hadCombat = !!combat;
    render(false);
  });
})();

// ====================================================================================================
// 7. Dungeon Master HQ tab: enemies, campaigns, DM password
// ====================================================================================================

// The "Dungeon Master HQ" tab of pages/tabletop.html (only the dungeon master sees it; the server refuses players too).
// An enemy is the flat {key: text} map of the inputs inside #dm-sheet that carry a data-k key (stored by
// processing/enemies.py), the same way the character sheet works. Changes save by themselves. Enemies belong to the
// campaign chosen with the bar at the top of the page (the role part of this file); switching campaign loads that campaign's enemies.
(function () {
  const $ = (s) => document.querySelector(s);
  const api = window.Options, Role = window.Role, U = window.SheetUtils;
  const sheet = $("#dm-sheet"), status = $("#dm-status"), picker = $("#enemies");
  const say = (text, error) => { status.textContent = text; status.classList.toggle("error", !!error); };
  const store = {
    get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };
  async function run(fn) { try { await fn(); } catch (err) { say(err.message || String(err), true); } }
  const fld = (k) => sheet.querySelector(`[data-k="${k}"]`);
  const isDM = () => Role.get() === "dm";

  // The attack table: a few rows of name, attacks per round, TÉ, damage and a description of the attack.
  $("#dm-attacks").innerHTML = Array.from({ length: 6 }, (_, i) =>
    "<tr>" + [["n", "Támadás"], ["t", "Tám/kör"], ["te", "TÉ"], ["s", "Sebzés"], ["d", "Leírás"]].map(([c, label]) =>
      `<td><input type="text" data-k="a.${i}.${c}" aria-label="${label}, row ${i + 1}" autocomplete="off" spellcheck="false"></td>`).join("") + "</tr>").join("");

  // ---------- portrait ----------
  let portrait = "";
  const showPortrait = () => {
    $("#dm-portrait-img").hidden = !portrait;
    $("#dm-portrait-hint").hidden = !!portrait;
    $("#dm-portrait-clear").hidden = !portrait;
    if (portrait) $("#dm-portrait-img").src = portrait;
  };
  $("#dm-portrait").addEventListener("click", () => $("#dm-portrait-file").click());
  $("#dm-portrait").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#dm-portrait-file").click(); } });
  $("#dm-portrait-clear").addEventListener("click", () => { portrait = ""; showPortrait(); mark(); });
  $("#dm-portrait-file").addEventListener("change", (e) => run(async () => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    portrait = await U.portrait(file);
    showPortrait();
    mark();
  }));

  // ---------- storing enemies ----------
  let cur = "", list = [], dirty = false, timer = 0, bootedFor = "";
  const collect = () => {
    const d = {};
    sheet.querySelectorAll("[data-k]").forEach((el) => { if (el.value) d[el.dataset.k] = el.value; });
    if (portrait) d.portrait = portrait;
    return d;
  };
  const fill = (d) => {
    sheet.querySelectorAll("[data-k]").forEach((el) => { el.value = d[el.dataset.k] || ""; });
    portrait = d.portrait || "";
    showPortrait();
  };
  function renderList() {
    picker.replaceChildren(...list.map((c) => new Option(c.name, c.id)));
    picker.value = cur;
  }
  async function refreshList() { list = (await api.json("/api/enemies")).enemies; renderList(); }

  function mark() {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => run(save), 700);
  }
  async function save() {
    clearTimeout(timer);
    if (!cur || !dirty) return;
    dirty = false;
    const data = collect();
    say("Saving…");
    try { await api.json("/api/enemies/" + cur, { data }); }
    catch (err) { dirty = true; throw err; }
    const entry = list.find((c) => c.id === cur);
    if (entry) { entry.name = data.name || "Unnamed"; renderList(); }
    say("Saved.");
  }
  async function open(id) {
    await save();
    const d = await api.json("/api/enemies/" + id);
    cur = id;
    fill(d.data);
    store.set("dm-last", id);
    picker.value = id;
    say("");
  }
  async function create(data) {
    await save();
    const { id } = await api.json("/api/enemies", { data });
    cur = "";
    await refreshList();
    await open(id);
  }

  sheet.addEventListener("input", mark);
  picker.addEventListener("change", () => run(() => open(picker.value)));
  addEventListener("pagehide", () => {
    if (cur && dirty) fetch("/api/enemies/" + cur, { method: "POST", credentials: "same-origin", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: collect() }) }).catch(() => {});
  });

  // ---------- healing ----------
  // Full HP, Heal FP and Heal HP (with the amount from the box). Damage is just typing the new number into Akt. Ép / Akt. Fp.
  const parse = (v) => { const n = parseFloat(String(v).replace(",", ".")); return isNaN(n) ? null : n; };
  const num = (k) => parse(fld(k).value);
  const put = (k, v) => { fld(k).value = String(v); };
  const HEAL = { ep: ["hp.curep", "hp.maxep", "Ép"], fp: ["hp.curfp", "hp.maxfp", "Fp"] };
  function hp(kind) {
    if (kind === "full") {
      for (const [c, m] of [["hp.curep", "hp.maxep"], ["hp.curfp", "hp.maxfp"]]) if (num(m) != null) put(c, num(m));
      mark();
      return say("Back to full HP.");
    }
    const [curKey, maxKey, label] = HEAL[kind];
    const amount = parse($("#dm-amount").value);
    if (!(amount > 0)) throw new Error("Type how much to heal, as a number above 0.");
    const max = num(maxKey);
    let now = num(curKey);
    if (now == null) now = max == null ? 0 : max;        // no current value yet: start from full
    now += amount;
    if (max != null) now = Math.min(now, max);           // healing stops at the maximum
    put(curKey, now);
    mark();
    say(`Healed ${amount}: ${now} ${label}.`);
  }
  sheet.addEventListener("click", (e) => {
    const b = e.target.closest("[data-hp]");
    if (b) run(async () => hp(b.dataset.hp));
  });

  // ---------- the bar above the sheet ----------
  const ACTIONS = {
    new: () => create({ name: "New enemy" }),
    duplicate: async () => { const d = collect(); d.name = (d.name || "Unnamed") + " (copy)"; await create(d); },
    async map() {
      await save();
      const count = Math.max(1, Math.min(20, parseInt($("#dm-count").value, 10) || 1));
      await api.json("/api/map/tokens", { kind: "enemy", ref: cur, count });
      say(count === 1
        ? "Added to the map with its own HP. Open the Map tab to move it."
        : `Added ${count} to the map, each with its own HP (edit them in the sidebar of the map).`);
    },
    async delete() {
      const name = (list.find((c) => c.id === cur) || {}).name || "this enemy";
      if (!confirm(`Delete ${name}? This cannot be undone. It is also taken off the map.`)) return;
      await api.json(`/api/enemies/${cur}/delete`, {});
      dirty = false; cur = "";
      await refreshList();
      if (list.length) await open(list[0].id); else await create({ name: "New enemy" });
      say(`Deleted ${name}.`);
    },
    async export() {
      await save();
      const d = collect();
      U.download(d.name || "enemy", { format: "spells-enemy", version: 1, data: d });
    },
  };
  $("#dm-bar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (b) run(ACTIONS[b.dataset.act]);
  });
  $("#dm-import").addEventListener("change", (e) => run(async () => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    await create(await U.readDoc(file));
    say("Imported.");
  }));
  $("#dm-import-label").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#dm-import").click(); } });

  // ---------- campaigns and the dungeon master password ----------
  const CAMPAIGN = {
    async new() {
      const name = (prompt("Name of the new campaign:") || "").trim();
      if (!name) return;
      await save();
      const made = await api.json("/api/campaigns", { name });
      await api.json("/api/campaign", { id: made.id });
      await Role.refresh();                               // the campaign changed: the tabs load its data
      say(`Created “${made.name}” and switched to it.`);
    },
    async rename() {
      const now = Role.campaign();
      const name = (prompt("New name of this campaign:", now.name) || "").trim();
      if (!name || name === now.name) return;
      await api.json(`/api/campaigns/${now.id}/rename`, { name });
      await Role.refresh();
      say(`Renamed to “${name}”.`);
    },
    async delete() {
      const now = Role.campaign();
      if (!confirm(`Delete the campaign “${now.name}” with all its characters, enemies and maps? This cannot be undone.`)) return;
      await api.json(`/api/campaigns/${now.id}/delete`, {});
      dirty = false; cur = "";                            // its enemies are gone: nothing left to save
      await Role.refresh();                               // the cookie points nowhere now, so another campaign opens
      say(`Deleted “${now.name}”.`);
    },
  };
  $("#dm-settings").addEventListener("click", (e) => {
    const b = e.target.closest("[data-camp]");
    if (b) run(CAMPAIGN[b.dataset.camp]);
  });
  function showPasswordNote() {
    const env = Role.passwordInfo().source === "env";
    $("#dm-pw-note").textContent = env
      ? "The password is set by the DM_PASSWORD environment variable on the server. Change it there."
      : "Changing it signs everybody else out of the dungeon master role.";
    $("#dm-pw-change").querySelectorAll("input, button").forEach((el) => { el.disabled = env; });
  }
  $("#dm-pw-change").addEventListener("submit", (e) => {
    e.preventDefault();
    run(async () => {
      if ($("#dm-pw-new").value !== $("#dm-pw-new2").value) throw new Error("The two new passwords are not the same.");
      await api.json("/api/role/password", { current: $("#dm-pw-cur").value, new: $("#dm-pw-new").value });
      ["#dm-pw-cur", "#dm-pw-new", "#dm-pw-new2"].forEach((id) => { $(id).value = ""; });
      say("The dungeon master password was changed.");
    });
  });

  // ---------- start ----------
  // The tab is opened by this file (event "tabletopview"). The enemies of a campaign are loaded the first time the
  // tab is shown for it, and again whenever the campaign changes. When the role is no longer "dm", nothing is kept.
  async function boot() {
    const camp = Role.campaign().id;
    if (bootedFor === camp) return;
    bootedFor = camp;
    cur = ""; dirty = false;
    await refreshList();
    const last = store.get("dm-last");
    if (list.length) await open(list.some((c) => c.id === last) ? last : list[0].id);
    else await create({ name: "New enemy" });
  }
  function forget() {                                     // a player must not be able to read enemy sheets left in the page
    clearTimeout(timer);
    cur = ""; list = []; dirty = false; bootedFor = "";
    fill({});
    renderList();
    say("");
  }
  const visible = () => !$("#view-dm").hidden;
  document.addEventListener("tabletopview", () => { if (visible() && isDM()) { showPasswordNote(); run(boot); } });
  document.addEventListener("rolechange", () => {
    if (!isDM()) forget();
    else if (visible()) { showPasswordNote(); run(boot); }
  });
  Role.beforeChange(() => save());
})();

// ====================================================================================================
// 8. Character sheet
// ====================================================================================================

// Page script for pages/tabletop.html. The sheet is built here from a few small helpers; every input carries a
// data-k key, and a character is the flat {key: text} map of those inputs (stored by processing/characters.py).
(function () {
  const $ = (s) => document.querySelector(s);
  const api = window.Options;
  const sheet = $("#sheet"), status = $("#status"), picker = $("#chars");
  const say = (text, error) => { status.textContent = text; status.classList.toggle("error", !!error); };
  const store = {
    get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };
  async function run(fn) { try { await fn(); } catch (err) { say(err.message || String(err), true); } }

  // ---------- sheet layout (labels follow the printed Hungarian sheet) ----------
  const f = (k, label) => `<label class="f"><span>${label}</span><input type="text" data-k="${k}" autocomplete="off" spellcheck="false"></label>`;
  const area = (k, label, rows) => `<label class="f"><span>${label}</span><textarea data-k="${k}" rows="${rows}" spellcheck="false"></textarea></label>`;
  const pair = (...fields) => `<div class="pair">${fields.join("")}</div>`;
  const card = (title, body, cls = "") => `<section class="card ${cls}">${title ? `<h3>${title}</h3>` : ""}${body}</section>`;
  const table = (prefix, n, cols, cls) => `<div class="tbl ${cls}"><table><thead><tr>${cols.map((c) => `<th>${c[1]}</th>`).join("")}</tr></thead><tbody>${
    Array.from({ length: n }, (_, i) => `<tr>${cols.map((c) => `<td><input type="text" data-k="${prefix}.${i}.${c[0]}" aria-label="${c[1]}, row ${i + 1}" autocomplete="off" spellcheck="false"></td>`).join("")}</tr>`).join("")
  }</tbody></table></div>`;

  const fi = (k, label, extra = "") => `<label class="f in"><span>${label}</span><input type="text" data-k="${k}" autocomplete="off" spellcheck="false" ${extra}></label>`;
  const fs = (k, label) => `<label class="f in"><span>${label}</span><select data-k="${k}"><option value=""></option></select></label>`;
  const trio = (...x) => `<div class="trio">${x.join("")}</div>`;
  const blank = "<span></span>";

  const ATTRS = [["str", "Erő"], ["spd", "Gyorsaság"], ["dex", "Ügyesség"], ["sta", "Állóképesség"], ["hea", "Egészség"], ["bea", "Szépség"], ["int", "Intelligencia"], ["wil", "Akaraterő"], ["ast", "Asztrál"]];
  const SIDE = [["str", "Sebzés járulék"], ["spd", "Páncélban"], ["dex", "Páncélban"]];     // boxes beside the first three stats
  const attrs = `<div class="attrs">${
    ATTRS.map(([k, l], i) => `<button type="button" class="an" data-calc="${k}" aria-expanded="false" title="Click to show the calculation" style="grid-row:${i + 1};grid-column:1"><span>${l}</span><small class="acalc" data-acalc="${k}" hidden></small></button><div class="acell" style="grid-row:${i + 1};grid-column:2"><input type="text" id="a-${k}" aria-label="${l}" data-k="attr.${k}" autocomplete="off" inputmode="numeric"><span class="tot" data-tot="${k}" hidden></span></div><span class="rm" data-rm="${k}" style="grid-row:${i + 1};grid-column:3" title="Faj módosító"></span>`).join("")
  }${
    SIDE.map(([k, l], i) => `<label class="side" style="grid-row:${i + 1};grid-column:4"><span>${l}</span><input type="text" data-k="attr.${k}.x" autocomplete="off"></label>`).join("")
  }</div>`;

  // The title is a button: clicking it shows the calculation and the −1 / +1 HM buttons (which also show whenever there is HM to spend).
  const chead = (id, title) => `<div class="chead"><h3 class="sname" role="button" tabindex="0" data-calc="${id}" aria-expanded="false" title="Click to show the calculation">${title}</h3><span class="hmb" data-hmb="${id}" hidden></span><span class="hmbtns" data-hmbtns="${id}" hidden><button class="btn small" type="button" data-hm-undo="${id}" title="Undo: give 1 HM back and lower Alap by 1">−1 HM</button><button class="btn small" type="button" data-hm="${id}" title="Spend 1 HM to raise Alap by 1">+1 HM</button></span></div>`;
  const combat = (id, title) => card("", chead(id, title) + `<div class="calc" data-calcbox="${id}" hidden></div>` + pair(f(id + ".arm", "Páncélban"), f(id + ".nak", "Páncél nélkül")) + pair(f(id + ".base", "Alap"), f(id + ".wpn", "Fegyver nélkül")) + f(id + ".mod", "Módosítók") + `<ul class="wlist" data-wl="${id}"></ul>`, "a-" + id);
  const pz = (id, title) => `<div><strong>${title}</strong>${f(id + ".st", "Statikus")}${f(id + ".dy", "Dinamikus")}${f(id + ".me", "ME")}</div>`;

  const page1 = `
    <div class="p1">
      <div class="a-left">
        ${card("", attrs)}
        ${card("Ψ képzettség", fi("psi.type", "Iskola típusa") + fi("psi.use", "Használat foka") + fi("psi.lvl", "Használat szintje") + pair(f("psi.cur", "Akt. Ψp"), f("psi.max", "Max. Ψp")) + f("psi.per", "Ψp / Szint"))}
        ${card("Ψ pajzsok", `<div class="pz">${pz("pz.a", "Asztrál")}${pz("pz.m", "Mentál")}</div>`)}
        ${card("Mana-pontok", pair(f("mana.per", "Mp/Szint"), f("mana.max", "Max. Mp")) + f("mana.cur", "Akt. Mp") + area("mana.other", "Egyéb módosítók", 4))}
      </div>
      ${card("Életerő", pair(f("hp.curep", "Akt. Ép"), f("hp.maxep", "Max. Ép")) + pair(f("hp.curfp", "Akt. Fp"), f("hp.maxfp", "Max. Fp")) + pair(f("hp.fpl", "Fp/Szint"), blank) + '<input type="hidden" data-k="hp.epbase"><input type="hidden" data-k="hp.fpbase">', "a-hp")}
      ${card("", `
        <label class="f nm"><span>A Karakter neve</span><input type="text" data-k="name" autocomplete="off" spellcheck="false"></label>
        ${fs("caste", "Kaszt")}${fs("race", "Faj")}
        ${[["align", "Jellem"], ["faith", "Vallás"], ["symbol", "Szimbólum"], ["home", "Szülőföld"], ["school", "Iskola"]].map(([k, l]) => fi(k, l)).join("")}
        <div class="portrait" id="portrait" tabindex="0" role="button" aria-label="Choose a portrait"><img id="portrait-img" alt="Portrait" hidden><span id="portrait-hint">Click to add a portrait</span></div>
        <input type="file" id="portrait-file" accept="image/*" hidden>
        <label class="f lvl"><span>Tapasztalati Szint</span><input type="text" data-k="level" autocomplete="off"></label>`, "ident a-ident")}
      ${combat("ke", "Kezdeményező Érték (KÉ)")}
      ${combat("te", "Támadó Érték (TÉ)")}
      ${combat("ve", "Védő Érték (VÉ)")}
      ${combat("ce", "Célző Érték (CÉ)")}
      ${card("", pair(f("hm", "HM/Szint"), f("tam", "Tám./kör")) + pair(f("hm.left", "Elkölthető HM"), `<div class="f"><span>Új szint</span><button class="btn" type="button" id="hm-add" title="Add HM/Szint to the pool">+ HM/Szint</button></div>`) + f("hm.owed", "Kötelező HM") + '<input type="hidden" data-k="hm.paid"><input type="hidden" data-k="hm.spent">', "a-hm")}
      <div class="a-armor armor">
        ${card("", f("armor.worn", "Viselt páncél"))}
        ${card("", trio(f("armor.mgt", "MGT"), f("armor.sfe", "Max. SFÉ"), f("armor.cur", "SFÉ")))}
        ${card("", trio(f("shield.name", "Pajzs"), f("shield.ve", "Pajzs VÉ"), f("shield.dmg", "Sebzés")))}
      </div>
      ${card("Fegyverek", table("w", 10, [["n", "Fegyver"], ["t", "Tám/kör"], ["ke", "KÉ"], ["te", "TÉ"], ["ve", "VÉ"], ["ce", "CÉ"], ["s", "Sebzés"]], "arms"), "a-arms")}
    </div>`;

  const SK = [["n", "Képzettség"], ["kp", "Kp"], ["f", "fok%"]];
  const EQ = [["n", "Felszerelés"], ["d", "darab"], ["e", "elhelyezés"]];
  const page2 = `
    ${card("", `<div class="two">${pair(f("skp", "Képzettség pontok"), f("skl", "Kp/Szint"))}${f("skmod", "Egyéb módosítók")}</div>`)}
    <div class="two full">${card("", table("sk1", 14, SK, "skills"))}${card("", table("sk2", 14, SK, "skills"))}</div>
    <div class="full">${card("Kincsek", `<div class="coins">${[["cu", "réz"], ["ag", "ezüst"], ["au", "arany"], ["mi", "mithrill"], ["gem", "drágakő"], ["oth", "egyéb"]].map(([k, l]) => f("coin." + k, l)).join("")}</div>`)}</div>
    <div class="two full">${card("", table("eq1", 12, EQ, "gear"))}${card("", table("eq2", 12, EQ, "gear"))}</div>
    <div class="two full">
      ${card("", area("mod2", "Egyéb módosítók", 7))}
      ${card("", area("desc", "A Karakter leírása", 7) + pair(f("xp", "Tapasztalati pontok"), f("xpnext", "Pontok a következő szinthez")))}
    </div>`;

  sheet.innerHTML = `<div data-p="1">${page1}</div><div data-p="2" hidden>${page2}</div>`;
  document.querySelectorAll("[data-page]").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll("[data-page]").forEach((x) => x.setAttribute("aria-selected", String(x === t)));
    sheet.querySelectorAll("[data-p]").forEach((p) => (p.hidden = p.dataset.p !== t.dataset.page));
  }));

  // ---------- calculated values ----------
  // Pressing "Apply class & calculate" fills "Fegyver nélkül" (KÉ/TÉ/VÉ/CÉ) and Max. Ép / Max. Fp as
  // base + every listed stat above 10 (never negative). Every box stays editable afterwards.
  const RULES = {                       // output: [base boxes added together, stats whose excess over 10 is added]
    "ke.wpn": ["ke.base", ["spd", "dex"]],
    "te.wpn": ["te.base", ["str", "spd", "dex"]],
    "ve.wpn": ["ve.base", ["spd", "dex"]],
    "ce.wpn": ["ce.base", ["dex"]],
    "hp.maxep": ["hp.epbase", ["hea"]],
    "hp.maxfp": ["hp.fpbase", ["sta", "wil"]],
    "pz.a.me": [["pz.a.st", "pz.a.dy"], ["ast"]],     // Asztrál ME = statikus + dinamikus + Asztrál over 10
    "pz.m.me": [["pz.m.st", "pz.m.dy"], ["wil"]],     // Mentál ME  = statikus + dinamikus + Akaraterő over 10
  };
  const fld = (k) => sheet.querySelector(`[data-k="${k}"]`);
  const toNum = (k) => parseFloat(String(fld(k).value).replace(",", ".")) || 0;
  // A stat as the calculations see it: the typed value plus the modifier of the chosen race.
  const eff = (s) => toNum("attr." + s) + raceMod(s);
  function calculate() {
    for (const [out, [bases, stats]] of Object.entries(RULES)) {
      const list = [].concat(bases), vals = list.map((k) => fld(k).value.trim()), o = fld(out);
      if (list.length === 1 && vals[0] === "-") { o.value = "-"; continue; }        // the class has no such value
      if (vals.every((v) => !v) && stats.every((s) => !fld("attr." + s).value.trim())) { o.value = ""; continue; }
      o.value = String(list.reduce((t, k) => t + toNum(k), 0) + stats.reduce((t, s) => t + Math.max(0, eff(s) - 10), 0));
    }
    refreshWeapons();
  }

  // Under each of KÉ/TÉ/VÉ/CÉ: every named weapon that has a value for it, as the total ("Fegyver nélkül + weapon + Módosítók").
  // Módosítók is a number typed in the stat's own box (it can be negative): it is added to every weapon of that stat.
  // Only the total is shown; click the title of the stat to see "Fegyver nélkül + weapon + Módosítók = total".
  const r2 = (n) => Math.round(n * 100) / 100;
  const signed = (n) => `${n < 0 ? "−" : "+"} ${Math.abs(n)}`;
  const STATS = ["ke", "te", "ve", "ce"], NAME = Object.fromEntries(ATTRS);
  function refreshWeapons() {
    const named = Array.from({ length: 10 }, (_, i) => [i, fld(`w.${i}.n`).value.trim()]).filter(([, n]) => n);
    for (const stat of STATS) {
      const base = parseFloat(fld(stat + ".wpn").value) || 0, mod = toNum(stat + ".mod");
      sheet.querySelector(`[data-wl="${stat}"]`).replaceChildren(...named.flatMap(([i, name]) => {
        const w = parseFloat(fld(`w.${i}.${stat}`).value);
        if (isNaN(w)) return [];
        const open = expanded.has(stat) || openWeapons.has(i);          // the whole stat is open, or this weapon was clicked
        const li = document.createElement("li"), a = document.createElement("button"), b = document.createElement("span");
        a.type = "button"; a.className = "wname"; a.dataset.w = i;
        a.textContent = name;
        a.title = "Click to show the calculation";
        a.setAttribute("aria-expanded", String(open));
        const total = r2(base + w + mod);
        b.title = `Fegyver nélkül ${base} ${signed(w)} (${name})${mod ? ` ${signed(mod)} (Módosítók)` : ""} = ${total}`;
        b.textContent = open ? `${base} ${signed(w)}${mod ? ` ${signed(mod)}` : ""} = ${total}` : String(total);
        li.append(a, b);
        return [li];
      }));
    }
    refreshCalc();
  }

  // ---------- opening a stat: calculation, HM label and HM buttons ----------
  // Settings of this page, kept in this browser. showHm: a "+3 HM" label next to KÉ/TÉ/VÉ/CÉ, like the race modifier next to the stats.
  const SETTINGS = "tabletop-settings";
  const settings = { showHm: true };
  try { Object.assign(settings, JSON.parse(store.get(SETTINGS) || "{}")); } catch { /* keep the defaults */ }
  const expanded = new Set();                               // the stats whose title was clicked
  const openWeapons = new Set();                            // the weapons (table rows) whose name was clicked

  // How many HM went into each of KÉ/TÉ/VÉ/CÉ: "hm.spent" counts them; an older sheet without it is worked out from
  // Alap minus the class's base value.
  function spentMap() {
    if (fld("hm.spent").value.trim()) return mapGet("hm.spent");
    const c = findClass(), o = {};
    for (const s of STATS) {
      const b = parseFloat(fld(s + ".base").value), cb = c && c[s + "_alap"];
      if (!isNaN(b) && typeof cb === "number" && b > cb) o[s] = b - cb;
    }
    return o;
  }
  // "Alap 12 (9 + 3 HM) + Gyorsaság 3 = 15": what "Fegyver nélkül" is made of, by the same rule calculate() uses.
  function calcLines(stat) {
    const [baseKey, stats] = RULES[stat + ".wpn"], text = fld(baseKey).value.trim();
    if (text === "-") return ["Alap is “-”: the class has no such value."];
    const base = toNum(baseKey), hm = spentMap()[stat] || 0;
    const parts = [`Alap ${base}${hm ? ` (${base - hm} + ${hm} HM)` : ""}`];
    let total = base, bonus = false;
    for (const st of stats) {
      const x = Math.max(0, eff(st) - 10);
      if (x > 0) { parts.push(`${NAME[st]} ${x}`); total += x; bonus = true; }
    }
    const lines = [`${parts.join(" + ")} = ${total}`];
    if (bonus) lines.push("A stat adds how far it is above 10 (race modifier included).");
    const mod = toNum(stat + ".mod");
    if (mod) lines.push(`Módosítók ${mod > 0 ? "+" : "−"}${Math.abs(mod)} is added to every weapon below.`);
    const typed = fld(stat + ".wpn").value.trim();
    if (typed && parseFloat(typed) !== total) lines.push(`The Fegyver nélkül box shows ${typed}: typed by hand, or not recalculated yet (press “Apply class & calculate”).`);
    return lines;
  }
  function refreshCalc() {
    const pool = parseInt(fld("hm.left").value, 10) || 0;
    sheet.querySelectorAll("[data-calc]").forEach((e) => e.setAttribute("aria-expanded", String(expanded.has(e.dataset.calc))));
    const spent = spentMap();
    for (const stat of STATS) {
      const box = sheet.querySelector(`[data-calcbox="${stat}"]`), open = expanded.has(stat);
      box.hidden = !open;
      if (open) box.replaceChildren(...calcLines(stat).map((t) => Object.assign(document.createElement("div"), { textContent: t })));
      const badge = sheet.querySelector(`[data-hmb="${stat}"]`), n = spent[stat] || 0;
      badge.hidden = !(settings.showHm && n > 0);
      badge.textContent = `+${n} HM`;
      badge.title = `${n} HM spent on ${HM_NAMES[stat]}`;
      sheet.querySelector(`[data-hmbtns="${stat}"]`).hidden = !(pool > 0 || open);     // spendable, or the title was clicked
    }
    for (const [k] of ATTRS) {                               // typed value + race modifier = what the calculations use
      const small = sheet.querySelector(`[data-acalc="${k}"]`), open = expanded.has(k), v = fld("attr." + k).value.trim(), m = raceMod(k);
      const tot = sheet.querySelector(`[data-tot="${k}"]`);       // the box shows the end result; click into it to edit the typed value
      tot.hidden = !(v && m);
      tot.textContent = toNum("attr." + k) + m;
      tot.title = `${v} ${m > 0 ? "+" : "−"} ${Math.abs(m)} (faj)`;
      const rm = sheet.querySelector(`[data-rm="${k}"]`);          // the race modifier itself shows only while the stat is open
      rm.textContent = open && m ? (m > 0 ? "+" : "−") + Math.abs(m) : "";
      small.hidden = !open;
      small.textContent = !v ? "–" : m ? `${v} ${m > 0 ? "+" : "−"} ${Math.abs(m)} (faj) = ${toNum("attr." + k) + m}` : `${v}, no race modifier`;
    }
  }
  const toggleStat = (el) => { const k = el.dataset.calc; expanded.has(k) ? expanded.delete(k) : expanded.add(k); refreshWeapons(); };
  sheet.addEventListener("click", (e) => {
    const wn = e.target.closest(".wname");
    if (wn) { const i = +wn.dataset.w; openWeapons.has(i) ? openWeapons.delete(i) : openWeapons.add(i); return refreshWeapons(); }
    const t = e.target.closest("[data-calc]");
    if (t) toggleStat(t);
  });
  sheet.addEventListener("keydown", (e) => {
    const t = e.target.closest("h3[data-calc]");
    if (t && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggleStat(t); }
  });

  // ---------- spending HM ----------
  // "+ HM/Szint" adds the level's HM to the pool and records what the class makes you spend on a given value
  // (hm_limitation in rules/classes.json) in "Kötelező HM", e.g. "KÉ 3". Those points must be spent on that value
  // before the rest of the pool can go anywhere else.
  const HM_NAMES = { ke: "KÉ", te: "TÉ", ve: "VÉ", ce: "CÉ" };
  const statKey = (s) => ({ ke: "ke", te: "te", ve: "ve", ce: "ce" })[String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()];
  function mapGet(key) {
    const o = {};
    for (const p of fld(key).value.split(",")) {
      const m = /^\s*(\S+)\s+(\d+)\s*$/.exec(p), k = m && statKey(m[1]);
      if (k) o[k] = (o[k] || 0) + +m[2];
    }
    return o;
  }
  const owedText = (o) => Object.entries(o).filter(([, n]) => n > 0).map(([k, n]) => `${HM_NAMES[k]} ${n}`).join(", ");
  const mapSet = (key, o) => { fld(key).value = owedText(o); };
  const owedGet = () => mapGet("hm.owed"), owedSet = (o) => mapSet("hm.owed", o);   // still required this level
  // "hm.paid" remembers how many of the required points went to each value, so a −1 HM can restore them

  function spendHm(stat) {
    const pool = parseInt(fld("hm.left").value, 10) || 0;
    if (pool < 1) throw new Error("No HM left to spend. Use “+ HM/Szint” when you gain a level.");
    const base = fld(stat + ".base");
    if (base.value.trim() === "-") throw new Error(`${HM_NAMES[stat]} Alap is “-”. Type a number there first to raise it.`);
    const owed = owedGet(), total = Object.values(owed).reduce((a, b) => a + b, 0);
    if (owed[stat] > 0) {
      owed[stat]--;
      const paid = mapGet("hm.paid");
      paid[stat] = (paid[stat] || 0) + 1;
      mapSet("hm.paid", paid);
    } else if (pool - 1 < total) throw new Error(`Your class requires ${owedText(owed)} HM first. Spend those before the rest.`);
    const spent = spentMap();                    // before Alap changes, so an older sheet is counted right
    spent[stat] = (spent[stat] || 0) + 1;
    mapSet("hm.spent", spent);
    bump(stat, 1);
    fld("hm.left").value = String(pool - 1);
    owedSet(owed);
    refreshWeapons();
    mark();
    const left = owedText(owed);
    say(`Spent 1 HM on ${HM_NAMES[stat]}. ${pool - 1} left${left ? `, still required: ${left}` : ""}.`);
  }
  // Raises or lowers Alap (and a numeric Fegyver nélkül, so manual edits survive) by d.
  function bump(stat, d) {
    fld(stat + ".base").value = String(toNum(stat + ".base") + d);
    const w = fld(stat + ".wpn");
    if (w.value.trim() && !isNaN(parseFloat(w.value))) w.value = String(parseFloat(w.value) + d);
  }
  function undoHm(stat) {
    const base = fld(stat + ".base");
    if (!base.value.trim() || base.value.trim() === "-") throw new Error(`${HM_NAMES[stat]} Alap has no number to lower.`);
    const c = findClass(), floor = c && c[stat + "_alap"] != null ? c[stat + "_alap"] : 0;
    if (toNum(stat + ".base") <= floor) throw new Error(`${HM_NAMES[stat]} Alap is already at ${c ? "the class base value" : "0"}.`);
    const spent = spentMap();
    if (spent[stat] > 0) { spent[stat]--; mapSet("hm.spent", spent); }
    bump(stat, -1);
    fld("hm.left").value = String((parseInt(fld("hm.left").value, 10) || 0) + 1);
    const paid = mapGet("hm.paid");
    if (paid[stat] > 0) {                       // that point had satisfied a class requirement: owe it again
      paid[stat]--;
      mapSet("hm.paid", paid);
      const owed = owedGet();
      owed[stat] = (owed[stat] || 0) + 1;
      owedSet(owed);
    }
    refreshWeapons();
    mark();
    say(`Took 1 HM back from ${HM_NAMES[stat]}. ${fld("hm.left").value} in the pool.`);
  }
  function addLevelHm() {
    const per = parseInt(fld("hm").value, 10);
    if (!per) throw new Error("Fill in HM/Szint first.");
    fld("hm.left").value = String((parseInt(fld("hm.left").value, 10) || 0) + per);
    const c = findClass(), owed = owedGet();
    let note = "";
    for (const l of (c ? c.hm_limitation : [])) {
      const k = statKey(l.stat);
      if (k) owed[k] = (owed[k] || 0) + l.amount;
      else note = ` The class limit of ${l.amount} has no stat in rules/classes.json, so it is not enforced.`;
    }
    owedSet(owed);
    refreshCalc();
    mark();
    const req = owedText(owed);
    say(`Added ${per} HM to the pool.${req ? ` Required: ${req}.` : ""}${note}`, !!note);
  }
  sheet.addEventListener("click", (e) => {
    const b = e.target.closest("[data-hm]"), u = e.target.closest("[data-hm-undo]");
    if (b) run(async () => spendHm(b.dataset.hm));
    else if (u) run(async () => undoHm(u.dataset.hmUndo));
  });
  $("#hm-add").addEventListener("click", () => run(async () => addLevelHm()));

  // ---------- portrait ----------
  let portrait = "";
  const showPortrait = () => {
    $("#portrait-img").hidden = !portrait;
    $("#portrait-hint").hidden = !!portrait;
    if (portrait) $("#portrait-img").src = portrait;
  };
  $("#portrait").addEventListener("click", () => $("#portrait-file").click());
  $("#portrait").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#portrait-file").click(); } });
  $("#portrait-file").addEventListener("change", (e) => run(async () => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    portrait = await window.SheetUtils.portrait(file);
    showPortrait();
    mark();
  }));

  // ---------- storing characters ----------
  let cur = "", list = [], dirty = false, timer = 0;
  const collect = () => {
    const d = {};
    sheet.querySelectorAll("[data-k]").forEach((el) => { if (el.value) d[el.dataset.k] = el.value; });
    if (portrait) d.portrait = portrait;
    return d;
  };
  const fill = (d) => {
    sheet.querySelectorAll("[data-k]").forEach((el) => {
      const v = d[el.dataset.k] || "";
      if (el.tagName === "SELECT" && v && ![...el.options].some((o) => o.value === v)) el.append(new Option(v, v));
      el.value = v;
    });
    portrait = d.portrait || "";
    showPortrait();
    refreshWeapons();
    refreshRace();
  };
  // A character with a password shows a lock: closed until its password was typed in this browser, open after that.
  function renderList() {
    picker.replaceChildren(...list.map((c) => new Option((c.locked ? (c.open ? "🔓 " : "🔒 ") : "") + c.name, c.id)));
    picker.value = cur;
    syncLockButtons();
  }
  async function refreshList() { list = (await api.json("/api/characters")).characters; renderList(); }

  // ---------- locking a character with a password ----------
  const entry = (id) => list.find((c) => c.id === id);
  const needsPassword = (c) => !!c && c.locked && !c.open;
  const isDM = () => window.Role.get() === "dm";
  // Players change their current Ép and Fp; the maximums are the dungeon master's to edit (the class calculation still fills them in).
  function lockMax() {
    for (const k of ["hp.maxep", "hp.maxfp"]) {
      const box = fld(k);
      box.readOnly = !isDM();
      box.title = box.readOnly ? "Only the dungeon master can change the maximum" : "";
    }
  }
  function syncLockButtons() {
    const c = entry(cur);
    document.querySelector('[data-act="password"]').hidden = !c;
    document.querySelector('[data-act="relock"]').hidden = !(c && c.locked && !isDM());       // the dungeon master can open everything anyway
  }
  // Nothing is open (a campaign without characters you can open, or you just locked yours): the sheet cannot be edited.
  function setActive(on) {
    sheet.inert = !on;
    document.querySelector(".sheetbar").inert = !on;
    sheet.style.opacity = on ? "" : ".45";
  }
  function clearSheet() {
    cur = ""; dirty = false;
    fill({});
    setActive(false);
    renderList();
    say(list.length ? "Locked characters need their password." : "");
  }

  // Asks for the password of c; true when it was right.
  function askPassword(c) {
    const dlg = $("#pw-dialog"), form = $("#pw-form"), input = $("#pw-input"), st = $("#pw-status");
    $("#pw-text").textContent = `“${c.name}” is protected. Type its password to open it. It stays open in this browser until you lock it again.`;
    input.value = ""; st.textContent = ""; st.classList.remove("error");
    return new Promise((resolve) => {
      const end = (ok) => {
        form.removeEventListener("submit", onSubmit);
        $("#pw-cancel").removeEventListener("click", onCancel);
        dlg.removeEventListener("close", onCancel);
        if (dlg.open) dlg.close();
        resolve(ok);
      };
      const onCancel = () => end(false);
      const onSubmit = async (e) => {
        e.preventDefault();
        try { await api.json(`/api/characters/${c.id}/unlock`, { password: input.value }); c.open = true; end(true); }
        catch (err) { st.textContent = err.message; st.classList.add("error"); input.select(); }
      };
      form.addEventListener("submit", onSubmit);
      $("#pw-cancel").addEventListener("click", onCancel);
      dlg.addEventListener("close", onCancel);                 // Escape
      dlg.showModal();
      input.focus();
    });
  }

  // Set, change or remove the password of the open character.
  function openLockDialog() {
    const c = entry(cur);
    if (!c) return;
    const dlg = $("#lock-dialog"), st = $("#lock-status");
    $("#lock-text").textContent = c.locked
      ? "This character has a password. Type a new one to change it, or remove it."
      : "Without a password everybody at the table can open and edit this character. With one, they need it first. The dungeon master can always open every character.";
    $("#lock-new").value = ""; $("#lock-new2").value = "";
    st.textContent = ""; st.classList.remove("error");
    $("#lock-remove").hidden = !c.locked;
    $("#lock-save").textContent = c.locked ? "Change password" : "Set password";
    dlg.showModal();
    $("#lock-new").focus();
  }
  $("#lock-cancel").addEventListener("click", () => $("#lock-dialog").close());
  $("#lock-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const st = $("#lock-status"), pw = $("#lock-new").value;
    st.classList.add("error");
    if (pw !== $("#lock-new2").value) { st.textContent = "The two passwords are not the same."; return; }
    run(async () => {
      try { await api.json(`/api/characters/${cur}/lock`, { password: pw }); }
      catch (err) { st.textContent = err.message; return; }
      $("#lock-dialog").close();
      await refreshList();
      say("Password set. This character stays open in this browser; others need the password.");
    });
  });
  $("#lock-remove").addEventListener("click", () => run(async () => {
    await api.json(`/api/characters/${cur}/lock/remove`, {});
    $("#lock-dialog").close();
    await refreshList();
    say("Password removed.");
  }));

  function mark() {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => run(save), 700);
  }
  async function save() {
    clearTimeout(timer);
    if (!cur || !dirty) return;
    dirty = false;
    const data = collect();
    say("Saving…");
    try {
      await api.json("/api/characters/" + cur, { data });
    } catch (err) { dirty = true; throw err; }
    const entry = list.find((c) => c.id === cur);
    if (entry) { entry.name = data.name || "Unnamed"; renderList(); }
    if (window.Dice.as() && window.Dice.as().id === cur) window.Dice.sync();      // its name and weapons feed the dice panel
    say("Saved.");
  }
  // Opens a character (asking for its password first when it has one). False when that was cancelled.
  async function open(id) {
    await save();
    const c = entry(id);
    if (needsPassword(c) && !(await askPassword(c))) { renderList(); return false; }      // the picker goes back to what was open
    const d = await api.json("/api/characters/" + id);
    cur = id;
    fill(d.data);
    setActive(true);
    store.set("tabletop-last", id);
    renderList();
    say("");
    return true;
  }
  // explicit: the person asked for this character (New, Duplicate, Import...): it becomes the character they roll as.
  async function create(data, explicit = true) {
    await save();
    const { id } = await api.json("/api/characters", { data });
    cur = "";
    await refreshList();
    await open(id);
    if (explicit) await window.Dice.choose(cur);
  }

  sheet.addEventListener("input", () => { refreshWeapons(); refreshRace(); mark(); });
  // Picking a character here is the global choice: the dice panels roll as it. (Opening the last one when the page loads is not a choice.)
  picker.addEventListener("change", () => run(async () => { if (await open(picker.value)) await window.Dice.choose(cur); }));
  addEventListener("pagehide", () => {
    if (cur && dirty) fetch("/api/characters/" + cur, { method: "POST", credentials: "same-origin", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: collect() }) }).catch(() => {});
  });

  const ACTIONS = {
    new: () => create({ name: "New character" }),
    duplicate: async () => { const d = collect(); d.name = (d.name || "Unnamed") + " (copy)"; await create(d); },
    async delete() {
      const name = (list.find((c) => c.id === cur) || {}).name || "this character";
      if (!confirm(`Delete ${name}? This cannot be undone.`)) return;
      await api.json(`/api/characters/${cur}/delete`, {});
      dirty = false; cur = "";
      await refreshList();
      if (list.length) await open(list[0].id); else await create({ name: "New character" }, false);
      say(`Deleted ${name}.`);
    },
    password: () => openLockDialog(),
    async relock() {                                     // close this character again in this browser
      await save();
      const id = cur, name = (entry(id) || {}).name || "The character";
      await api.json(`/api/characters/${id}/relock`, {});
      await loadCharacters(id);
      say(`${name} is locked again.`);
    },
    async export() {
      await save();
      const d = collect();
      window.SheetUtils.download(d.name || "character", { format: "spells-character", version: 1, data: d });
    },
  };
  $("#view-sheet .charbar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (b) run(ACTIONS[b.dataset.act]);
  });
  $("#import").addEventListener("change", (e) => run(async () => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    await create(await window.SheetUtils.readDoc(file));
    say("Imported.");
  }));
  $("#import-label").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#import").click(); } });

  // ---------- weapons (rules/weapons.json via /api/weapons) ----------
  // The weapon name boxes suggest the weapons of the rules; choosing one fills its row (and a shield fills the Pajzs boxes).
  //   ke -> KÉ,  te_ce -> TÉ,  ve_tav -> VÉ,  tam_kor -> Tám/kör,  dmg -> Sebzés.
  //   Ranged weapons (célzófegyverek) have no TÉ/VÉ: their first extra value goes to CÉ.
  let arms = [], shields = [];
  const norm = (t) => String(t).trim().toLowerCase();
  async function loadWeapons() {
    const all = await api.json("/api/weapons");
    shields = all["pajzsok"] || [];
    arms = Object.entries(all).filter(([cat]) => cat !== "pajzsok").flatMap(([cat, list]) => list.map((x) => ({ ...x, cat })));
    const fill = (id, list, withCat) => {
      let dl = document.getElementById(id);
      if (!dl) { dl = document.createElement("datalist"); dl.id = id; document.body.append(dl); }
      dl.replaceChildren(...list.map((x) => Object.assign(new Option(x.weapon_name), withCat ? { label: x.cat } : {})));
    };
    fill("weapon-list", arms, true);
    fill("shield-list", shields, false);
    for (let i = 0; i < 10; i++) fld(`w.${i}.n`).setAttribute("list", "weapon-list");
    fld("shield.name").setAttribute("list", "shield-list");
  }
  const put = (k, v) => { fld(k).value = v == null ? "" : String(v); };
  sheet.addEventListener("change", (e) => {                // change = a suggestion was chosen, or the box was left
    const el = e.target, key = el.dataset && el.dataset.k;
    if (!key) return;
    const row = /^w\.(\d+)\.n$/.exec(key), name = norm(el.value);
    if (row) {
      const x = arms.find((a) => norm(a.weapon_name) === name);
      if (!x) return;
      const ranged = x.cat === "célzófegyverek", i = row[1];
      put(`w.${i}.t`, x.tam_kor);
      put(`w.${i}.ke`, x.ke);
      put(`w.${i}.te`, ranged ? "" : x.te_ce);
      put(`w.${i}.ve`, ranged ? "" : x.ve_tav);
      put(`w.${i}.ce`, ranged ? (x.extra_values || [])[0] : "");
      put(`w.${i}.s`, x.dmg);
      el.value = x.weapon_name;
      say(`${x.weapon_name}: filled in from the weapon list${ranged && x.extra_values ? ` (range ${x.extra_values[1]})` : ""}.`);
    } else if (key === "shield.name") {
      const x = shields.find((a) => norm(a.weapon_name) === name);
      if (!x) return;
      put("shield.ve", x.ve_tav);
      put("shield.dmg", x.dmg);
      el.value = x.weapon_name;
      say(`Pajzs ${x.weapon_name}: filled in from the weapon list.`);
    } else return;
    refreshWeapons(); refreshRace(); mark();
  });

  // ---------- classes (rules/classes.json via /api/classes) ----------
  let classes = [], races = [];
  const RACE_KEY = { str: "ero", spd: "gyorsasag", dex: "ugyesseg", sta: "allokepesseg", hea: "egeszseg", bea: "szepseg", int: "intelligencia", wil: "akaratero", ast: "asztral" };
  const raceMod = (s) => {
    const r = races.find((x) => x.racename === fld("race").value);
    return r ? parseFloat(r.modifiers[RACE_KEY[s]]) || 0 : 0;
  };
  const refreshRace = () => refreshCalc();                   // the race modifier is only shown while a stat is open (refreshCalc)
  function fillSelect(key, names) {
    const sel = fld(key), keep = sel.value;
    sel.replaceChildren(new Option("", ""), ...names.map((n) => new Option(n, n)));
    if (keep && !names.includes(keep)) sel.append(new Option(keep, keep));       // a value from an older sheet
    sel.value = keep;
  }
  async function loadRaces() {
    races = (await api.json("/api/races")).races;
    fillSelect("race", races.map((r) => r.racename));
    refreshRace();
  }
  async function loadClasses() {
    classes = (await api.json("/api/classes")).classes;
    fillSelect("caste", classes.map((c) => c.classname));
    refreshCalc();
  }
  const findClass = () => {
    const typed = fld("caste").value.trim().toLowerCase();
    return classes.find((x) => x.classname.toLowerCase() === typed);
  };
  function applyClass() {
    const c = findClass();
    let msg = "Calculated the stats from your base values and stats.";
    if (c) {
      if (fld("ke.base").value && !confirm("Replace the base values and the calculated boxes with the class values?")) return;
      const n = (v) => (v == null ? "-" : String(v));
      const limit = c.hm_limitation.length ? `(${c.hm_limitation.map((l) => l.amount).join(",")})` : "";
      const set = {
        "ke.base": n(c.ke_alap), "te.base": n(c.te_alap), "ve.base": n(c.ve_alap), "ce.base": n(c.ce_alap),
        hm: c.hm + limit, skp: n(c.kp_alap), skl: n(c.kp_szint),
        "hp.epbase": n(c.ep_alap), "hp.fpbase": n(c.fp_alap), "hp.fpl": n(c.fp_szint), "hm.paid": "", "hm.spent": "",
      };
      for (const [k, v] of Object.entries(set)) fld(k).value = v;
      msg = `Applied ${c.classname} and calculated the stats.`;
    } else if (fld("caste").value.trim()) msg = `“${fld("caste").value.trim()}” is not in the class list, so only the stats were calculated.`;
    calculate();
    for (const [cur, max] of [["hp.curep", "hp.maxep"], ["hp.curfp", "hp.maxfp"]]) {
      if (!fld(cur).value) fld(cur).value = fld(max).value;
    }
    mark();
    say(msg);
  }
  $("#apply-class").addEventListener("click", () => run(async () => applyClass()));

  // ---------- page settings ----------
  const dlg = $("#tt-settings"), setHm = $("#set-hm");
  $("#tt-settings-open").addEventListener("click", () => { setHm.checked = settings.showHm; dlg.showModal(); });
  setHm.addEventListener("change", () => { settings.showHm = setHm.checked; store.set(SETTINGS, JSON.stringify(settings)); refreshCalc(); });
  $("#tt-settings-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => {                     // a click on the backdrop closes it
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
  });

  // ---------- dice ----------
  // The roller and the log are shared with the Map tab and with everybody else (this file).
  window.Dice.mount($("#dice-sheet"));

  // ---------- start ----------
  // Loads the characters of the current campaign and opens one you can open (the last one, if possible); when every
  // character is locked, the first one asks for its password; when there are none, a new one is created.
  // Choosing which character you play happens in the dialog that asks whether you are a player or the dungeon master
  // (the role part of this file): its answer arrives as the "characterpick" event below.
  // skip: a character id not to open (the one that was just locked).
  let loading = Promise.resolve();                            // the loading in progress, so a pick waits for it
  const loadCharacters = (skip) => (loading = loadCharactersNow(skip));
  async function loadCharactersNow(skip) {
    cur = ""; dirty = false;
    await refreshList();
    const last = store.get("tabletop-last"), free = (c) => (!c.locked || c.open) && c.id !== skip;
    const pick = list.find((c) => c.id === last && free(c)) || list.find(free);
    if (pick) await open(pick.id);
    else if (list.length) { clearSheet(); await open(list.find((c) => c.id !== skip || list.length === 1).id) || clearSheet(); }
    else await create({ name: "New character" }, false);
  }
  document.addEventListener("characterpick", (e) => run(async () => {
    await loading;
    if (e.detail.fresh) await create({ name: "New character" });          // (create also makes it your dice character)
    else if (!(await open(e.detail.id))) return;
    await window.Dice.choose(cur);                            // you play the character that is open now
  }));

  // The bar with the role and the campaign (the role part of this file). Unsaved work is saved before another campaign opens, and
  // the lists are loaded again whenever the role or the campaign changes.
  window.Role.mount($("#rolebar"));
  window.Role.beforeChange(() => save());
  let live = false;
  document.addEventListener("rolechange", () => { lockMax(); if (live) run(() => loadCharacters()); });

  run(async () => {
    await loadClasses().catch((err) => say(err.message, true));
    await loadRaces().catch((err) => say(err.message, true));
    await loadWeapons().catch((err) => say(err.message, true));
    await window.Role.ready;
    live = true;
    lockMax();
    await loadCharacters();
    // A player who has not said who they play in this session (a new tab) is asked now.
    if (window.Role.get() === "player" && !(await window.Dice.hasChoice())) window.Role.pickCharacter();
  });
})();
