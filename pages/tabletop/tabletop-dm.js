// The "Dungeon Master HQ" tab of pages/tabletop.html (only the dungeon master sees it; the server refuses players too).
// An enemy is the flat {key: text} map of the inputs inside #dm-sheet that carry a data-k key (stored by
// processing/enemies.py), the same way the character sheet works. Changes save by themselves. Enemies belong to the
// campaign chosen with the bar at the top of the page (shared/role.js); switching campaign loads that campaign's enemies.
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
  // The tab is opened by tabletop-map.js (event "tabletopview"). The enemies of a campaign are loaded the first time the
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
