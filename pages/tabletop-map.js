// Tabletop views and map (the tabs of pages/tabletop.html: Character sheet, Map and, for the dungeon master, Dungeon Master HQ; server side: processing/battlemap.py and roles.py).
// One map shared by everybody. The server keeps the tokens, walls, doors and the fog of war, and only sends each
// person what their role may see; this page draws it and polls every 2 seconds. Role (player / dungeon master) is
// asked by shared/role.js (which also picks the campaign: every campaign has its own map); the DM-only controls carry
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
  // tabletop-dm.js listens for the "tabletopview" event to load the enemies when its tab opens.
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
    $("#map-help").textContent = dm
      ? "Drag tokens to move them. Use Draw walls and Place doors to build the map: click a point, then click the next point (double-click or Esc to stop). Click a door to select it, double-click to open or close it."
      : "Drag your character to move. Click a door you can see to open or close it. You only see what your characters can see.";
  }
  document.addEventListener("rolechange", () => {
    if (!isDM() && !$("#view-dm").hidden) showView("sheet");     // no longer the dungeon master: leave the HQ
    if ($("#view-map").hidden) return;
    applyRole();
    select("", "");
    run(async () => { await loadChoices(); await refresh(); });
  });

  // ---------- dice and "playing as" (pages/tabletop-dice.js) ----------
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
      '<div class="vit"><span class="ep"></span><span class="fp"></span></div><div class="tname"></div>';
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
    el.title = bits.join(" · ");
    el.setAttribute("aria-label", el.title);
    el.classList.toggle("fixed", !canMove(t));
    el.classList.toggle("mine", t.kind === "character" && !!window.Dice.as() && t.ref === window.Dice.as().id);   // the character you play
    if (!busy.has(t.id)) { el.style.left = t.x * 100 + "%"; el.style.top = t.y * 100 + "%"; }
    el.classList.toggle("sel", sel.type === "token" && sel.id === t.id);
  }
  const canMove = (t) => isDM() || t.kind === "character";

  // ---------- hit points sidebar ----------
  // The party (everybody sees it) and, for the dungeon master, the enemies. Each token has its own Ép / Fp boxes, which
  // you edit like any number: type, then leave the box. Every enemy token has its own HP, so three goblins are three
  // rows. Players never receive an enemy's HP, so they only get the party. A character whose sheet is locked can only be
  // edited here once it was opened with its password on the sheet tab (the boxes are greyed out until then).
  const showNum = (v) => (v == null ? "" : String(num1(v)));
  let sideSig = "";
  function sideRow(t) {
    const li = document.createElement("li");
    li.className = "srow " + t.kind + (sel.type === "token" && sel.id === t.id ? " sel" : "");
    li.dataset.id = t.id;
    const box = (f, v, label) => `<input type="text" inputmode="decimal" autocomplete="off" data-f="${f}" value="${esc(showNum(v))}" aria-label="${esc(t.name)}: ${label}"${t.editable ? "" : " disabled"}>`;
    li.innerHTML =
      `<button type="button" class="sel-btn" data-select title="Show on the map">${esc(t.name)}</button>` +
      `<div class="sgs"><div class="sg"><span>Ép</span>${box("hp", t.hp, "Ép now")}<i>/</i>${box("max", t.max, "Max. Ép")}</div>` +
      `<div class="sg"><span>Fp</span>${box("fp", t.fp, "Fp now")}<i>/</i>${box("fpmax", t.fpmax, "Max. Fp")}</div></div>` +
      (t.editable ? '<button type="button" class="btn small" data-full title="Set Ép and Fp to their maximum">Full</button>' : "");
    if (!t.editable) li.title = "This character is locked. Open it with its password on the Character sheet tab first.";
    return li;
  }
  function renderSide() {
    const side = document.querySelector(".mapside"), dm = isDM();
    const rows = data.tokens.filter((t) => t.kind === "character" || dm);
    const sig = JSON.stringify([dm, rows.map((t) => [t.id, t.kind, t.name, t.hp, t.max, t.fp, t.fpmax, t.editable])]);
    if (sig === sideSig) return;
    if (side.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;   // do not pull the box out from under a typing hand
    sideSig = sig;
    $("#side-party").replaceChildren(...rows.filter((t) => t.kind === "character").map(sideRow));
    $("#side-enemies").replaceChildren(...rows.filter((t) => t.kind === "enemy").map(sideRow));
  }
  document.querySelector(".mapside").addEventListener("change", (e) => {
    const input = e.target.closest("input[data-f]"), li = input && input.closest(".srow");
    if (!li) return;
    run(async () => {
      try { await api.json(`/api/map/tokens/${li.dataset.id}/stats`, { [input.dataset.f]: input.value }); }
      finally { sideSig = ""; await refresh(); }              // on an error the box goes back to the stored number
    });
  });
  document.querySelector(".mapside").addEventListener("click", (e) => {
    const li = e.target.closest(".srow");
    if (!li) return;
    const t = data.tokens.find((x) => x.id === li.dataset.id);
    if (!t) return;
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
    if (e.button !== 0) return;
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
  function setTool(next) {
    tool = next;
    endChain();
    board.classList.toggle("drawing", tool !== "move");
    document.querySelectorAll("[data-tool]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tool === tool)));
  }
  document.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));

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
    if (tool === "move" || !isDM() || e.button !== 0) return;
    const p = cellAt(e);
    if (!chain) { chain = p; gesture = { x: p.x, y: p.y }; $("#chain-end").hidden = tool !== "wall"; showPreview(p); return; }
    const from = chain;
    afterCommit(p);
    run(() => commit(from, p));
  });
  board.addEventListener("pointermove", (e) => { if (chain && tool !== "move") showPreview(cellAt(e)); });
  board.addEventListener("pointerup", (e) => {              // dragging from one point to another works too
    if (!gesture || tool === "move") return;
    const p = cellAt(e), from = gesture;
    gesture = null;
    if (Math.hypot(p.x - from.x, p.y - from.y) >= 0.4) { afterCommit(p); run(() => commit(from, p)); }
  });
  board.addEventListener("dblclick", () => { if (tool !== "move") endChain(); });
  board.addEventListener("contextmenu", (e) => { if (tool !== "move") { e.preventDefault(); endChain(); } });

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
        say(`Loaded “${s.name}”. It is hidden from players until you click “Show map to players”.`);
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

  // The role is asked first (shared/role.js); then open on the map again if that is where the person was.
  window.Role.ready.then(() => {
  applyRole();
  const want = location.hash === "#dm" ? "dm" : store.get("tabletop-view");        // #dm: the old Dungeon Master HQ address
  if (want === "map" || want === "dm") showView(want);
});
})();
