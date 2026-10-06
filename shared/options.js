// Site options (theme + animations). Loaded in <head> on every page, so the saved choice is applied before the
// page paints. Also owns the Options dialog (opened from the sidebar). Saved in localStorage as "spells-options".
(function () {
  const root = document.documentElement;
  const KEY = "spells-options";
  const THEMES = [
    ["spell", "Spell tower", "Dark, candlelit violet."],
    ["book", "Open book", "Parchment, ink and turning pages."],
  ];
  const FONTS = "https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=IM+Fell+English+SC&family=IM+Fell+English:ital@0;1&display=swap";

  const defaults = { theme: "spell", motion: matchMedia("(prefers-reduced-motion: reduce)").matches ? "off" : "on" };
  const opts = { ...defaults };
  try { Object.assign(opts, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch { /* keep defaults */ }
  if (!THEMES.some(([id]) => id === opts.theme)) opts.theme = defaults.theme;
  if (opts.motion !== "off") opts.motion = "on";

  function apply() {
    root.dataset.theme = opts.theme;
    root.dataset.motion = opts.motion;
    // The page-turn stylesheet only counts while the book theme is on with animations enabled.
    const turn = document.getElementById("turn-css");
    if (turn) turn.disabled = !(opts.theme === "book" && opts.motion === "on");
    if (opts.theme === "book" && !document.getElementById("book-fonts")) {
      const l = document.createElement("link");
      l.id = "book-fonts"; l.rel = "stylesheet"; l.href = FONTS;
      document.head.append(l);
    }
  }

  function set(patch) {
    Object.assign(opts, patch);
    try { localStorage.setItem(KEY, JSON.stringify(opts)); } catch { /* storage unavailable */ }
    apply();
    reflect();
    document.dispatchEvent(new CustomEvent("optionschange", { detail: { ...opts } }));
  }

  // ---------- dialog (built the first time it is opened) ----------
  let dialog = null;
  function build() {
    dialog = document.createElement("dialog");
    dialog.id = "options";
    dialog.setAttribute("aria-labelledby", "options-title");
    dialog.innerHTML = `
      <h2 id="options-title">Options</h2>
      <fieldset>
        <legend>Theme</legend>
        <div class="theme-choices">${THEMES.map(([id, name, desc]) => `
          <label class="theme-choice">
            <input type="radio" name="opt-theme" value="${id}">
            <span class="swatch swatch-${id}" aria-hidden="true"></span>
            <strong>${name}</strong><small>${desc}</small>
          </label>`).join("")}
        </div>
      </fieldset>
      <fieldset>
        <legend>Motion</legend>
        <label class="switch-row">
          <span><strong>Animations</strong><small>Floating motes, glows, hover effects and page turns.</small></span>
          <input type="checkbox" role="switch" id="opt-motion">
        </label>
      </fieldset>
      <div class="opt-actions"><button class="opt-done" type="button" data-close>Done</button></div>`;
    document.body.append(dialog);
    dialog.addEventListener("change", (e) => {
      if (e.target.name === "opt-theme") set({ theme: e.target.value });
      else if (e.target.id === "opt-motion") set({ motion: e.target.checked ? "on" : "off" });
    });
    dialog.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) return dialog.close();
      if (e.target !== dialog) return;                     // a click on the backdrop lands on the dialog itself
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
    });
  }
  function reflect() {
    if (!dialog) return;
    dialog.querySelectorAll('input[name="opt-theme"]').forEach((r) => { r.checked = r.value === opts.theme; });
    dialog.querySelector("#opt-motion").checked = opts.motion === "on";
  }
  function open() {
    if (!dialog) build();
    reflect();
    dialog.showModal();
  }

  window.Options = { get: () => ({ ...opts }), set, open };
  apply();
})();
