// Server statistics panel of the home page (pages/index.html, server side: processing/system.py).
// The panel is only shown to signed-in visitors; the data comes from /api/system, which the password gate protects anyway.
// It refreshes every 3 seconds while the tab is visible.
(function () {
  const root = document.documentElement;
  const box = document.getElementById("server-stats"), meta = document.getElementById("server-meta"), panel = document.getElementById("server-panel");
  if (!box || !panel || root.dataset.auth !== "yes") return;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const bytes = (n) => {
    const u = ["B", "KB", "MB", "GB", "TB", "PB"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(n < 10 ? 2 : 1) : Math.round(n)) + " " + u[i];
  };
  const dur = (s) => {
    const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
    return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m`;
  };
  const level = (p, warn = 75, hot = 90) => (p >= hot ? "hot" : p >= warn ? "warn" : "");

  // title, big number, optional meter (0-100), detail lines, optional extra element
  function card(title, big, pct, lines, extra) {
    const c = el("article", "stat");
    c.append(el("h3", "", title), el("p", "big", big));
    if (pct != null) {
      const bar = el("div", "meter " + level(pct)), fill = el("span");
      fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
      bar.setAttribute("role", "img");
      bar.setAttribute("aria-label", `${title}: ${Math.round(pct)}%`);
      bar.append(fill);
      c.append(bar);
    }
    for (const l of lines) c.append(el("p", "sub", l));
    if (extra) c.append(extra);
    return c;
  }

  function render(d) {
    const cards = [];
    const cores = el("div", "cores");
    cores.setAttribute("aria-hidden", "true");
    for (const p of d.cpu.cores) {
      const c = el("span", "core " + level(p)), f = el("i");
      f.style.height = Math.max(4, p) + "%";
      c.title = Math.round(p) + "%";
      c.append(f);
      cores.append(c);
    }
    const cpuLines = [`${d.cpu.count} threads${d.cpu.physical ? ` (${d.cpu.physical} cores)` : ""}${d.cpu.freq ? ` · ${(d.cpu.freq / 1000).toFixed(2)} GHz` : ""}`];
    if (d.cpu.load) cpuLines.push(`Load average ${d.cpu.load.join(" · ")}`);
    cards.push(card("CPU", Math.round(d.cpu.percent) + "%", d.cpu.percent, cpuLines, cores));

    const memLines = [`${bytes(d.memory.used)} of ${bytes(d.memory.total)}`];
    if (d.swap.total) memLines.push(`Swap ${bytes(d.swap.used)} of ${bytes(d.swap.total)} (${Math.round(d.swap.percent)}%)`);
    cards.push(card("Memory", Math.round(d.memory.percent) + "%", d.memory.percent, memLines));

    for (const k of d.disks) cards.push(card("Disk " + k.name, Math.round(k.percent) + "%", k.percent, [`${bytes(k.used)} used of ${bytes(k.total)}`, `${bytes(k.free)} free`]));

    if (d.temp_main) {
      const others = d.temps.filter((t) => t !== d.temp_main && t.name !== d.temp_main.name).map((t) => `${t.name}: ${t.c} °C`);
      cards.push(card("Temperature", d.temp_main.c.toFixed(1) + " °C", Math.min(100, d.temp_main.c), [d.temp_main.name, ...others].slice(0, 5)));
      cards[cards.length - 1].querySelector(".meter").className = "meter " + level(d.temp_main.c, 70, 85);
    } else cards.push(card("Temperature", "n/a", null, ["No temperature sensor can be read on this machine."]));

    cards.push(card("Network", "↓ " + bytes(d.net.rx) + "/s", null, [`↑ ${bytes(d.net.tx)}/s`, `Total ↓ ${bytes(d.net.rx_total)} · ↑ ${bytes(d.net.tx_total)}`]));
    cards.push(card("System", dur(d.uptime), null, [`Up since boot · ${d.host}`, d.os, `Python ${d.python} · app uses ${bytes(d.process.rss)}`]));

    box.replaceChildren(...cards);
    meta.textContent = "Updated " + new Date().toLocaleTimeString();
  }

  let timer = 0, stopped = false;
  async function tick() {
    if (stopped || document.hidden) return;
    try {
      const r = await fetch("/api/system", { credentials: "same-origin", cache: "no-store" });
      if (r.status === 401) { stopped = true; clearInterval(timer); panel.hidden = true; return; }
      if (!r.ok) throw new Error();
      render(await r.json());
    } catch { meta.textContent = "The server statistics could not be loaded."; }
  }
  timer = setInterval(tick, 3000);
  document.addEventListener("visibilitychange", tick);
  tick();
})();
