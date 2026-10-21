// Page script for pages/dungeon-master-hq.html. An enemy is the flat {key: text} map of the inputs that carry a
// data-k key (stored by processing/enemies.py), the same way the character sheet works. Changes save by themselves.
(function () {
  const $ = (s) => document.querySelector(s);
  const api = window.Options;
  const sheet = $("#sheet"), status = $("#status"), picker = $("#enemies");
  const say = (text, error) => { status.textContent = text; status.classList.toggle("error", !!error); };
  const store = {
    get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };
  async function run(fn) { try { await fn(); } catch (err) { say(err.message || String(err), true); } }
  const fld = (k) => sheet.querySelector(`[data-k="${k}"]`);

  // The attack table: a few rows of name, attacks per round, TÉ and damage.
  $("#attacks").innerHTML = Array.from({ length: 6 }, (_, i) =>
    "<tr>" + [["n", "Támadás"], ["t", "Tám/kör"], ["te", "TÉ"], ["s", "Sebzés"]].map(([c, label]) =>
      `<td><input type="text" data-k="a.${i}.${c}" aria-label="${label}, row ${i + 1}" autocomplete="off" spellcheck="false"></td>`).join("") + "</tr>").join("");

  // ---------- portrait ----------
  let portrait = "";
  const showPortrait = () => {
    $("#portrait-img").hidden = !portrait;
    $("#portrait-hint").hidden = !!portrait;
    $("#portrait-clear").hidden = !portrait;
    if (portrait) $("#portrait-img").src = portrait;
  };
  $("#portrait").addEventListener("click", () => $("#portrait-file").click());
  $("#portrait").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#portrait-file").click(); } });
  $("#portrait-clear").addEventListener("click", () => { portrait = ""; showPortrait(); mark(); });
  $("#portrait-file").addEventListener("change", (e) => run(async () => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    let bmp;
    try { bmp = await createImageBitmap(file); } catch { throw new Error("That file could not be read as an image."); }
    const S = 240, c = document.createElement("canvas"), k = Math.max(S / bmp.width, S / bmp.height);
    c.width = c.height = S;
    c.getContext("2d").drawImage(bmp, (S - bmp.width * k) / 2, (S - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
    portrait = c.toDataURL("image/jpeg", 0.85);
    showPortrait();
    mark();
  }));

  // ---------- storing enemies ----------
  let cur = "", list = [], dirty = false, timer = 0;
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

  // ---------- damage and healing ----------
  const num = (k) => { const v = parseFloat(String(fld(k).value).replace(",", ".")); return isNaN(v) ? null : v; };
  const put = (k, v) => { fld(k).value = String(v); };
  function hp(kind) {
    if (kind === "full") {
      for (const [c, m] of [["hp.curep", "hp.maxep"], ["hp.curfp", "hp.maxfp"]]) if (num(m) != null) put(c, num(m));
      mark();
      return say("Back to full HP.");
    }
    const amount = parseFloat(String($("#amount").value).replace(",", "."));
    if (!(amount > 0)) throw new Error("Type how much damage or healing, as a number above 0.");
    const max = num("hp.maxep");
    let now = num("hp.curep");
    if (now == null) now = max == null ? 0 : max;        // no current value yet: start from full
    now = kind === "hit" ? now - amount : now + amount;  // Ép may drop below 0; healing stops at Max. Ép
    if (kind === "heal" && max != null) now = Math.min(now, max);
    put("hp.curep", now);
    mark();
    say(kind === "hit" ? `Took ${amount} damage: ${now} Ép left.` : `Healed ${amount}: ${now} Ép.`);
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
      await api.json("/api/map/tokens", { kind: "enemy", ref: cur });
      say("Added to the map. Open the Map tab on the Tabletop page to move it.");
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
      const blob = new Blob([JSON.stringify({ format: "spells-enemy", version: 1, data: d }, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = ((d.name || "enemy").replace(/[\\/:*?"<>|]/g, "_")) + ".json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    },
  };
  document.querySelector(".charbar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (b) run(ACTIONS[b.dataset.act]);
  });
  $("#import").addEventListener("change", (e) => run(async () => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    let doc;
    try { doc = JSON.parse(await file.text()); } catch { throw new Error("That file is not valid JSON."); }
    await create(doc && typeof doc.data === "object" ? doc.data : doc);
    say("Imported.");
  }));
  $("#import-label").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#import").click(); } });

  // ---------- start ----------
  // Only the dungeon master gets in (the server refuses players too). shared/role.js asks who you are if that is not known yet.
  let booted = false;
  async function boot() {
    if (booted) return;
    booted = true;
    await refreshList();
    const last = store.get("dm-last");
    if (list.length) await open(list.some((c) => c.id === last) ? last : list[0].id);
    else await create({ name: "New enemy" });
  }
  function gate() {
    const dm = window.Role.get() === "dm";
    $("#locked").hidden = dm;
    $("#dm-content").hidden = !dm;
    if (dm) run(boot);
  }
  $("#switch-role").addEventListener("click", () => run(async () => { await window.Role.ask(); }));
  document.addEventListener("rolechange", gate);
  window.Role.ready.then(gate);
})();
