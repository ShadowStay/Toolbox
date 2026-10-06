// Home page script: floating motes, rotating whispers, and the spellbook built from /api/pages.
(function () {
  const $ = (s) => document.querySelector(s);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- drifting motes and the odd shooting star ----------
  const cv = $("#motes"), ctx = cv.getContext("2d");
  let W = 0, H = 0, motes = [], star = null;
  const rand = (a, b) => a + Math.random() * (b - a);
  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    motes = Array.from({ length: Math.round(Math.min(90, (W * H) / 18000)) }, () => ({
      x: rand(0, W), y: rand(0, H), r: rand(.6, 2), vy: rand(.08, .3), vx: rand(-.08, .08),
      p: rand(0, 6.28), gold: Math.random() < .2,
    }));
  }
  function frame(t) {
    ctx.clearRect(0, 0, W, H);
    for (const m of motes) {
      m.y -= m.vy; m.x += m.vx + Math.sin(t / 2000 + m.p) * .1;
      if (m.y < -5) { m.y = H + 5; m.x = rand(0, W); }
      ctx.globalAlpha = .25 + .5 * Math.abs(Math.sin(t / 1200 + m.p));
      ctx.fillStyle = m.gold ? "#e9c776" : "#c9a2ff";
      ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, 6.28); ctx.fill();
    }
    ctx.shadowBlur = 0;
    if (!star && Math.random() < .002) star = { x: rand(W * .3, W), y: rand(0, H * .4), l: 0 };
    if (star) {
      star.x -= 9; star.y += 4; star.l += 1;
      const g = ctx.createLinearGradient(star.x, star.y, star.x + 90, star.y - 40);
      g.addColorStop(0, "#fff"); g.addColorStop(1, "transparent");
      ctx.globalAlpha = Math.max(0, 1 - star.l / 50);
      ctx.strokeStyle = g; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(star.x, star.y); ctx.lineTo(star.x + 90, star.y - 40); ctx.stroke();
      if (star.l > 50) star = null;
    }
    requestAnimationFrame(frame);
  }
  resize();
  addEventListener("resize", resize);
  if (!reduce) requestAnimationFrame(frame);

  // ---------- rotating whispers ----------
  const whispers = [
    "Everything runs in your browser.",
    "No scrolls leave this tower.",
    "Small spells, sharp edges.",
    "Conjured by hand, one tool at a time.",
  ];
  const el = $("#whisper");
  if (!reduce) {
    let i = 0;
    setInterval(() => {
      el.classList.add("out");
      setTimeout(() => { el.textContent = whispers[++i % whispers.length]; el.classList.remove("out"); }, 500);
    }, 4500);
  }

  // ---------- spellbook ----------
  const info = {
    "text-tools": ["✎", "Find, replace, clean, convert and compare text."],
    "image-tools": ["❖", "Layer, crop, filter and convert images."],
    chat: ["☄", "A shared room with voice and screen sharing."],
  };
  const fallback = ["✦", "A spell worth casting."];

  function card(p, i) {
    const [glyph, desc] = info[p.name] || fallback;
    const a = document.createElement("a");
    a.className = "spell"; a.href = p.path; a.style.setProperty("--i", i);
    for (const [cls, text] of [["glyph", glyph], ["s-name", p.label], ["s-desc", desc], ["s-path", p.path]]) {
      const s = document.createElement("span");
      s.className = cls; s.textContent = text;
      a.append(s);
    }
    a.addEventListener("pointermove", (e) => {
      const r = a.getBoundingClientRect();
      a.style.setProperty("--mx", e.clientX - r.left + "px");
      a.style.setProperty("--my", e.clientY - r.top + "px");
    });
    const li = document.createElement("li");
    li.append(a);
    return li;
  }

  (async function () {
    const shelves = $("#shelves");
    let groups = [];
    try { groups = await (await fetch("/api/pages")).json(); } catch { /* handled below */ }
    if (!groups.length) { shelves.innerHTML = '<p class="empty">The shelves are empty.</p>'; return; }
    let n = 0;
    shelves.replaceChildren(...groups.map((g) => {
      const shelf = document.createElement("div");
      shelf.className = "shelf";
      if (g.label) { const h = document.createElement("h3"); h.textContent = g.label; shelf.append(h); }
      const ul = document.createElement("ul");
      ul.append(...g.pages.map((p) => card(p, n++)));
      shelf.append(ul);
      return shelf;
    }));
  })();
})();
