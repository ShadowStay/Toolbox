// "Are you a player or the dungeon master?" Loaded by pages that depend on it (Tabletop, Dungeon Master HQ).
// The answer is kept by the server in a signed cookie (processing/roles.py), which is what actually limits what a
// player can see. Here: the dialog, document.documentElement.dataset.role ("player" | "dm"), a "rolechange" event,
// and window.Role = { ready, get(), ask() }.
//   <script src="/shared/role.js" data-ask="always">   ask every time the page opens (Tabletop)
//   <script src="/shared/role.js" data-ask="unset">    ask only when nothing has been chosen yet (Dungeon Master HQ)
(function () {
  const root = document.documentElement, api = window.Options;
  const mode = (document.currentScript && document.currentScript.dataset.ask) || "always";
  let current = null, pinNeeded = false, dialog = null;

  const style = document.createElement("style");
  style.textContent = `
    #role-dialog { width: min(32rem, 92vw); padding: 1.5rem; color: var(--moon, #f1e9ff); background: var(--dusk, #22123b); border: 1px solid var(--amethyst, #8a5bd8); border-radius: .8rem; box-shadow: 0 20px 60px #000a; }
    #role-dialog::backdrop { background: #000c; backdrop-filter: blur(3px); }
    #role-dialog h2 { margin: 0 0 .25rem; font-size: 1.3rem; }
    #role-dialog p { margin: 0; color: #d9cbf2; font-size: .95rem; }
    .role-choices { display: grid; grid-template-columns: 1fr 1fr; gap: .8rem; margin-top: 1.1rem; }
    .role-choice { display: grid; gap: .3rem; padding: 1rem; text-align: left; font: inherit; color: inherit; cursor: pointer; background: #8a5bd822; border: 2px solid #8a5bd877; border-radius: .7rem; }
    .role-choice:hover, .role-choice:focus-visible { border-color: var(--candle, #e9c776); outline: none; }
    .role-choice.last { border-color: var(--orchid, #c9a2ff); }
    .role-choice strong { font-size: 1.1rem; }
    .role-choice small { opacity: .8; line-height: 1.35; }
    .role-pin { display: grid; gap: .5rem; margin-top: 1rem; }
    .role-pin input { font: inherit; padding: .6rem .7rem; color: inherit; background: #140b22; border: 1px solid #8a5bd877; border-radius: .4rem; }
    .role-pin .row, .role-foot { display: flex; gap: .5rem; justify-content: flex-end; margin-top: .4rem; }
    .role-err { min-height: 1.3rem; margin-top: .6rem !important; color: #ff9fb3 !important; }
    @media (max-width: 480px) { .role-choices { grid-template-columns: 1fr; } }`;
  document.head.append(style);

  function setRole(role) {
    current = role;
    root.dataset.role = role || "";
    document.dispatchEvent(new CustomEvent("rolechange", { detail: { role } }));
  }

  function build() {
    dialog = document.createElement("dialog");
    dialog.id = "role-dialog";
    dialog.setAttribute("aria-labelledby", "role-title");
    dialog.innerHTML = `
      <h2 id="role-title">Who are you at the table?</h2>
      <p>Players see their characters and what they can see on the map. The dungeon master runs the enemies and the map.</p>
      <div class="role-choices">
        <button type="button" class="role-choice" data-role="player"><strong>Player</strong><small>Play your character. Fog of war applies.</small></button>
        <button type="button" class="role-choice" data-role="dm"><strong>Dungeon master</strong><small>Enemies, walls, doors, fog and saved maps.</small></button>
      </div>
      <form class="role-pin" hidden>
        <label for="role-pin-in">Dungeon master password</label>
        <input id="role-pin-in" type="password" autocomplete="off">
        <div class="row"><button type="button" class="btn small" data-back>Back</button><button type="submit" class="btn primary small">Continue</button></div>
      </form>
      <p class="role-err" role="alert"></p>
      <div class="role-foot"><button type="button" class="btn small" data-cancel>Cancel</button></div>`;
    document.body.append(dialog);
  }

  async function choose(role, pin) {
    const err = dialog.querySelector(".role-err");
    err.textContent = "";
    try {
      await api.json("/api/role", { role, pin });
      return true;
    } catch (e) {
      err.textContent = e.message;
      return false;
    }
  }

  // Shows the dialog; resolves with the chosen role (or the old one when it was cancelled).
  function ask(required) {
    if (!dialog) build();
    const pinForm = dialog.querySelector(".role-pin"), choices = dialog.querySelector(".role-choices");
    const cancel = dialog.querySelector("[data-cancel]");
    pinForm.hidden = true; choices.hidden = false;
    dialog.querySelector(".role-err").textContent = "";
    cancel.hidden = !!required;
    dialog.querySelectorAll(".role-choice").forEach((b) => b.classList.toggle("last", b.dataset.role === current));
    return new Promise((resolve) => {
      const done = (role) => { dialog.close(); cleanup(); if (role !== current) setRole(role); resolve(current); };
      const onClick = async (e) => {
        const b = e.target.closest(".role-choice");
        if (b) {
          if (b.dataset.role === "dm" && pinNeeded && current !== "dm") {
            choices.hidden = true; pinForm.hidden = false;
            dialog.querySelector("#role-pin-in").value = "";
            dialog.querySelector("#role-pin-in").focus();
          } else if (await choose(b.dataset.role)) done(b.dataset.role);
        } else if (e.target.closest("[data-back]")) { pinForm.hidden = true; choices.hidden = false; }
        else if (e.target.closest("[data-cancel]")) { dialog.close(); cleanup(); resolve(current); }
      };
      const onSubmit = async (e) => {
        e.preventDefault();
        if (await choose("dm", dialog.querySelector("#role-pin-in").value)) done("dm");
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
      current = d.role; pinNeeded = d.dm_protected;
      root.dataset.role = current || "";
    } catch { /* the page shows its own errors */ }
    if (mode === "always" || !current) await ask(true);
    return current;
  })();

  window.Role = { ready, get: () => current, ask: () => ask(false) };
})();
