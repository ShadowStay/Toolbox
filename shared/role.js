// "Who are you at the table, and which campaign are you playing?" Loaded by pages that depend on it (Tabletop, including its Dungeon Master HQ tab).
// Both answers are kept in cookies, so the next visit starts where you left off, and both can be changed at any time
// with the "Change" button of the bar this script draws (Role.mount):
//   * the role (player / dungeon master) in a signed cookie set by processing/roles.py, which is what actually limits
//     what a player can see. The dungeon master needs a password: the first person to choose the role picks it.
//   * the campaign in the cookie spells_campaign (processing/campaigns.py). Everything is stored per campaign.
// Here: the dialog, document.documentElement.dataset.role ("player" | "dm"), a "rolechange" event (fired when the role
// or the campaign changed; detail = {role, campaign: {id, name}}), and
//   window.Role = { ready, get(), campaign(), campaigns(), passwordInfo(), ask(), refresh(), mount(el), beforeChange(fn) }
//   <script src="/shared/role.js" data-ask="always">   ask every time the page opens
//   <script src="/shared/role.js" data-ask="unset">    ask only when no role has been chosen yet (Tabletop)
//   Role.beforeChange(fn)  fn() is awaited (to save unsaved work) before a campaign is switched.
(function () {
  const root = document.documentElement, api = window.Options;
  const mode = (document.currentScript && document.currentScript.dataset.ask) || "always";
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
    .role-pin .row, .role-foot { display: flex; gap: .5rem; justify-content: flex-end; margin-top: .4rem; }
    .role-err { min-height: 1.3rem; margin-top: .6rem !important; color: #ff9fb3 !important; }
    .role-bar { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1rem; margin-top: 1rem; color: #d9cbf2; }
    .role-bar strong { color: var(--moon, #f1e9ff); }
    @media (max-width: 480px) { .role-choices { grid-template-columns: 1fr; } }`;
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
      <p>Pick the campaign you are playing and your role. Both are remembered in this browser and you can change them any time.</p>
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
      <p class="role-err" role="alert"></p>
      <div class="role-foot"><button type="button" class="btn small" data-cancel>Cancel</button></div>`;
    document.body.append(dialog);
  }

  // Shows the dialog; resolves with the chosen role (or the old one when it was cancelled).
  async function ask(required) {
    if (!dialog) build();
    const q = (s) => dialog.querySelector(s);
    const pinForm = q(".role-pin"), choices = q(".role-choices"), camp = q(".role-camp"), cancel = q("[data-cancel]"), err = q(".role-err");
    const select = q("#role-camp");
    pinForm.hidden = true; choices.hidden = false; camp.hidden = false;
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
        dialog.close(); cleanup();
        await loadCampaigns().catch(() => {});
        if (role !== current || switching) setRole(role); else paintBars();
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
    refresh, mount,
    beforeChange: (fn) => flushers.push(fn),
  };
})();
