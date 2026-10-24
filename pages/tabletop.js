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
      ${card("Életerő", pair(f("hp.maxep", "Max. Ép"), f("hp.maxfp", "Max. Fp")) + pair(f("hp.curep", "Akt. Ép"), f("hp.curfp", "Akt. Fp")) + pair(f("hp.fpl", "Fp/Szint"), blank) + '<input type="hidden" data-k="hp.epbase"><input type="hidden" data-k="hp.fpbase">', "a-hp")}
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
    if (!per) throw new Error("Fill in HM/Szint first, for example by applying a class.");
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
    say(list.length ? "Choose a character above. Characters with a lock need their password." : "");
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
    window.Dice.suggest(id);
    renderList();
    say("");
    return true;
  }
  async function create(data) {
    await save();
    const { id } = await api.json("/api/characters", { data });
    cur = "";
    await refreshList();
    await open(id);
  }

  sheet.addEventListener("input", () => { refreshWeapons(); refreshRace(); mark(); });
  picker.addEventListener("change", () => run(() => open(picker.value)));
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
      if (list.length) await open(list[0].id); else await create({ name: "New character" });
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
  // The roller and the log are shared with the Map tab and with everybody else (pages/tabletop-dice.js).
  window.Dice.mount($("#dice-sheet"));

  // ---------- start ----------
  // Loads the characters of the current campaign and opens one you can open (the last one, if possible). A player who has
  // no remembered character in this browser and several to choose from gets the selection dialog; when every character is
  // locked, the first one asks for its password; when there are none, a new one is created.
  // skip: a character id not to open (the one that was just locked).
  async function loadCharacters(skip) {
    cur = ""; dirty = false;
    await refreshList();
    const last = store.get("tabletop-last"), free = (c) => (!c.locked || c.open) && c.id !== skip;
    const choices = list.filter(free);
    if (!skip && !isDM() && choices.length > 1 && !choices.some((c) => c.id === last)) {
      clearSheet();
      if (await chooseCharacter(choices)) return;
    }
    const pick = choices.find((c) => c.id === last) || choices[0];
    if (pick) await open(pick.id);
    else if (list.length) { clearSheet(); await open(list.find((c) => c.id !== skip || list.length === 1).id) || clearSheet(); }
    else await create({ name: "New character" });
  }

  // ---------- character selection dialog ----------
  // Cards for the characters you can open, and a button for a new one. True once a character is open; false when the
  // dialog was dismissed (Escape), so the caller opens a default one.
  function chooseCharacter(choices) {
    const dlg = $("#char-selection"), box = $("#selection-list");
    box.replaceChildren(...choices.map((c) => {
      const card = document.createElement("button");
      card.type = "button"; card.className = "char-option"; card.dataset.id = c.id;
      const icon = document.createElement("span"), name = document.createElement("span");
      icon.className = "char-icon"; icon.textContent = (c.name.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2) || "?").toUpperCase();
      name.className = "char-name"; name.textContent = (c.locked ? "🔓 " : "") + c.name;
      card.append(icon, name);
      return card;
    }));
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        dlg.removeEventListener("click", onClick);
        dlg.removeEventListener("close", onClose);
        if (dlg.open) dlg.close();
        resolve(ok);
      };
      const onClose = () => finish(false);
      const onClick = (e) => {
        const card = e.target.closest(".char-option"), fresh = e.target.closest('[data-act="new-selection"]');
        if (!card && !fresh) return;
        run(async () => {
          if (fresh) await create({ name: "New character" });
          else if (!(await open(card.dataset.id))) return;
          finish(true);
        });
      };
      dlg.addEventListener("click", onClick);
      dlg.addEventListener("close", onClose);
      dlg.showModal();
    });
  }

  // The bar with the role and the campaign (shared/role.js). Unsaved work is saved before another campaign opens, and
  // the lists are loaded again whenever the role or the campaign changes.
  window.Role.mount($("#rolebar"));
  window.Role.beforeChange(() => save());
  let live = false;
  document.addEventListener("rolechange", () => { if (live) run(() => loadCharacters()); });

  run(async () => {
    await loadClasses().catch((err) => say(err.message, true));
    await loadRaces().catch((err) => say(err.message, true));
    await loadWeapons().catch((err) => say(err.message, true));
    await window.Role.ready;
    live = true;
    await loadCharacters();
  });
})();
