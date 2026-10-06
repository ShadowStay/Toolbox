// Shared by every page. Builds the left-hand navigation from /api/pages
// (uncategorized pages first, then one heading per category; the home page is not listed).
(async function () {
  const nav = document.getElementById("site-nav");
  if (!nav) return;

  let groups = [];
  try {
    groups = await (await fetch("/api/pages")).json();
  } catch { /* show the brand link only */ }

  const current = location.pathname.replace(/\/+$/, "") || "/";
  const link = (p) =>
    `<li><a href="${p.path}"${p.path === current ? ' aria-current="page"' : ""}>${p.label}</a></li>`;

  const items = groups
    .map((g) => (g.label ? `<li class="group">${g.label}</li>` : "") + g.pages.map(link).join(""))
    .join("");

  nav.innerHTML = `
    <a class="brand" href="/">
      <span class="sigil" aria-hidden="true">☾</span>
      <span class="brand-text">Iprix's Spells</span>
    </a>
<<<<<<< HEAD
    <ul>${items}</ul>
    <button class="leave" type="button">Seal the tower</button>`;
  nav.querySelector(".leave").addEventListener("click", async () => {
    await fetch("/logout", { method: "POST" });
    location.href = "/";
  });
=======
    <ul>${items}</ul>`;
>>>>>>> ea9fdacdd4a9457d7ca1392005deb1242c5c6ef3
})();
