// Page script for pages/fortune-wheel.html. The whole wheel runs in the browser: the list is parsed from the text box, the
// winner is drawn with the browser's secure random numbers, and the wheel is then turned so that the pointer ends up on it.
// The list is kept in localStorage; the past results only until the page is closed.
(function () {
  const $ = (s) => document.querySelector(s);
  const cv = $("#wheel"), ctx = cv.getContext("2d"), input = $("#entries"), result = $("#result");
  const spinBtn = $("#spin"), hub = $("#hub"), removeBtn = $("#remove-winner");
  const TAU = Math.PI * 2, POINTER = -Math.PI / 2, MAX = 100, SIZE = cv.width;
  const PALETTE = ["#5b2f9e", "#8a5bd8", "#3a1f6b", "#6e53cc", "#4b2a85", "#9b6ee6", "#2f1a57"];     // an odd number, so neighbours differ
  const KEY = "wheel-entries";
  const EXAMPLE = ["Alice", "Bob", "Charlie", "Dana", "Eve", "Frank"];
  const store = {
    get: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
    set: (v) => { try { localStorage.setItem(KEY, v); } catch { /* storage unavailable */ } },
  };
  const reduced = () => !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);

  let list = [], rot = 0, spinning = false, winner = -1, history = [];

  // ---------- the list ----------
  const parse = () => input.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  function setLines(lines) {
    if (spinning) return;                                  // the list stays as it is while the wheel turns
    input.value = lines.join("\n");
    changed();
  }
  function changed() {
    store.set(input.value);
    const all = parse();
    list = all.slice(0, MAX);
    winner = -1;
    removeBtn.disabled = true;
    $("#count").textContent = all.length > MAX ? `${all.length} entries, only the first ${MAX} are used` : `${list.length} ${list.length === 1 ? "entry" : "entries"}`;
    spinBtn.disabled = hub.disabled = spinning || list.length < 2;
    if (!spinning) say(list.length < 2 ? "Add at least two entries, then spin." : "Ready. Spin the wheel!", true);
    draw();
  }
  function removeLine(index) {                              // the index-th entry (blank lines do not count)
    let k = -1;
    setLines(input.value.split(/\r?\n/).filter((l) => l.trim() === "" || ++k !== index).filter((l) => l.trim() !== ""));
  }
  function say(text, pending) {
    result.textContent = text;
    result.classList.toggle("pending", !!pending);
  }

  // ---------- drawing ----------
  function fit(text, maxWidth) {                            // the text, cut with an ellipsis when it is wider than maxWidth
    if (ctx.measureText(text).width <= maxWidth) return text;
    let s = [...text];
    while (s.length > 1 && ctx.measureText(s.join("") + "…").width > maxWidth) s.pop();
    return s.join("") + "…";
  }
  function draw() {
    const n = list.length, c = SIZE / 2, r = c - 10;
    ctx.clearRect(0, 0, SIZE, SIZE);
    if (n < 2) {
      ctx.beginPath(); ctx.arc(c, c, r, 0, TAU);
      ctx.fillStyle = "#22123b"; ctx.fill();
      ctx.lineWidth = 6; ctx.strokeStyle = "#8a5bd8"; ctx.stroke();
      return;
    }
    const seg = TAU / n, size = Math.max(12, Math.min(34, seg * r * 0.3));
    for (let i = 0; i < n; i++) {
      const a0 = rot + i * seg, a1 = a0 + seg;
      let color = PALETTE[i % PALETTE.length];
      if (i === n - 1 && n > 1 && color === PALETTE[0]) color = PALETTE[(i + 1) % PALETTE.length];   // the last must differ from the first
      ctx.beginPath(); ctx.moveTo(c, c); ctx.arc(c, c, r, a0, a1); ctx.closePath();
      ctx.fillStyle = color; ctx.fill();
      if (i === winner) { ctx.fillStyle = "#e9c77655"; ctx.fill(); }
      ctx.lineWidth = 2; ctx.strokeStyle = "#140b22"; ctx.stroke();

      ctx.save();
      ctx.translate(c, c); ctx.rotate(a0 + seg / 2);
      ctx.font = `600 ${size}px Inter, system-ui, sans-serif`;
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillStyle = i === winner ? "#fff" : "#f1e9ff";
      ctx.shadowColor = "#000b"; ctx.shadowBlur = 4;
      ctx.fillText(fit(list[i], r * 0.64), r - 26, 0);
      ctx.restore();
    }
    if (winner >= 0) {                                      // a gold rim around the winning slice
      const a0 = rot + winner * seg;
      ctx.beginPath(); ctx.arc(c, c, r - 3, a0, a0 + seg);
      ctx.lineWidth = 8; ctx.strokeStyle = "#e9c776"; ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(c, c, r, 0, TAU);
    ctx.lineWidth = 8; ctx.strokeStyle = "#e9c776"; ctx.stroke();
  }

  // ---------- spinning ----------
  function random() {                                       // 0 <= x < 1, from the browser's secure generator
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] / 4294967296;
  }
  // Which slice is under the pointer for a given rotation.
  const sliceAt = (angle, n) => Math.floor((((POINTER - angle) % TAU + TAU) % TAU) / (TAU / n)) % n;

  function spin() {
    if (spinning) return;
    if (winner >= 0 && $("#auto-remove").checked) removeLine(winner);
    if (list.length < 2) return say("Add at least two entries first.", true);
    const n = list.length, seg = TAU / n;
    const pick = Math.floor(random() * n);                  // the winner is drawn first; the wheel is then turned to land on it
    const inside = (random() - 0.5) * 0.8 * seg;            // not always dead centre of the slice
    const target = POINTER - (pick + 0.5) * seg - inside;   // rotation (mod 2π) that puts that spot under the pointer
    const end = target + Math.ceil((rot - target) / TAU) * TAU + (5 + Math.floor(random() * 3)) * TAU;

    winner = -1; removeBtn.disabled = true;
    spinning = true;
    spinBtn.disabled = hub.disabled = true;
    input.readOnly = true;
    say("Spinning…", true);
    if (reduced()) return finish(end);                      // no animation for people who asked for none

    const start = rot, total = end - start, ms = 4500 + random() * 1500, t0 = performance.now();
    (function frame(now) {
      const t = Math.min(1, (now - t0) / ms);
      rot = start + total * (1 - Math.pow(1 - t, 4));       // fast at first, slowing down to a stop
      draw();
      if (t < 1) requestAnimationFrame(frame); else finish(end);
    })(t0);
  }
  function finish(end) {
    rot = ((end % TAU) + TAU) % TAU;
    spinning = false;
    input.readOnly = false;
    winner = sliceAt(rot, list.length);                     // read from the final picture, so the text always matches the wheel
    spinBtn.disabled = hub.disabled = false;
    removeBtn.disabled = false;
    say(`🎉 ${list[winner]}`);
    history.unshift({ text: list[winner], at: new Date() });
    history = history.slice(0, 30);
    paintHistory();
    draw();
  }

  // ---------- past results ----------
  function paintHistory() {
    const two = (n) => String(n).padStart(2, "0");
    $("#history").replaceChildren(...history.map((h) => {
      const li = document.createElement("li"), time = document.createElement("small");
      time.textContent = `${two(h.at.getHours())}:${two(h.at.getMinutes())}:${two(h.at.getSeconds())}`;
      li.append(time, document.createTextNode(h.text));
      return li;
    }));
  }

  // ---------- buttons ----------
  spinBtn.addEventListener("click", spin);
  hub.addEventListener("click", spin);
  removeBtn.addEventListener("click", () => { if (winner >= 0) removeLine(winner); });
  input.addEventListener("input", changed);
  $("#shuffle").addEventListener("click", () => {
    const a = parse();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    setLines(a);
  });
  $("#sort").addEventListener("click", () => setLines(parse().sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))));
  $("#example").addEventListener("click", () => setLines(EXAMPLE));
  $("#clear").addEventListener("click", () => { setLines([]); input.focus(); });
  $("#clear-history").addEventListener("click", () => { history = []; paintHistory(); });

  const saved = store.get();
  input.value = saved === null ? EXAMPLE.join("\n") : saved;
  changed();
})();
