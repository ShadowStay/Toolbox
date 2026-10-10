// Shared drawing board for pages/live.html (server side: board.py). live.js hands this script the room's events.
//
// The board is a list of objects in drawing order: strokes, and images made from strokes. Every change is a small
// operation (add / del / set / batch). It is applied here at once and sent to the server, which numbers it and sends it
// to everybody, so all browsers end up with the same board. Cursors, the stroke somebody is drawing and an object being
// dragged are sent as throwaway "live" messages. Undo and redo send the opposite operation, so they only ever touch
// your own actions.
(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const W = 1600, H = 900, API = "/api/board", PAPER = "#fffdf8";
  const FIELDS = { stroke: ["dx", "dy"], image: ["cx", "cy", "w", "h", "rot"] };
  const cv = $("#board"), ctx = cv.getContext("2d"), noteEl = $("#board-note");
  cv.width = W; cv.height = H;

  const r1 = (n) => Math.round(n * 10) / 10;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const me = () => window.Live.me();
  const say = (text, error) => { noteEl.textContent = text; noteEl.classList.toggle("error", !!error); };
  const scaleK = () => (cv.clientWidth || W) / W;                  // screen pixels per board unit
  const colorOf = (id) => { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360; return `hsl(${h} 70% 42%)`; };

  // ---------- state ----------
  let objs = new Map();                 // id -> object; Map order = drawing order, same as the server's
  let selection = new Set();
  let tool = "pen", act = null;         // act = the gesture in progress
  let ready = false, lastSeq = 0, backlog = [];
  const live = new Map();               // user id -> stroke somebody else is drawing right now
  const cursors = new Map();            // user id -> {x, y}
  const imgs = new Map();               // image src -> {img, ok}
  const undoStack = [], redoStack = [];
  let raf = 0;
  const dirty = () => { if (!raf) raf = requestAnimationFrame(draw); };

  // ---------- talking to the server ----------
  let chainOps = Promise.resolve(), chainLive = Promise.resolve(), liveBusy = 0;
  const post = (path, body) => fetch(API + path, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: me(), ...body }),
  });
  function sendOp(op) {                  // one at a time and in order, so an undo never overtakes the action it undoes
    chainOps = chainOps.then(async () => {
      try {
        const r = await post("/op", { op });
        if (r.status === 401) return location.reload();
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          say(d.error || "The board could not accept that change.", true);
          await resync();
        }
      } catch { say("Connection lost. The board will reload when you are reconnected.", true); }
    });
  }
  function sendLive(msg, droppable) {
    if (!ready || !me()) return;
    if (droppable && liveBusy > 2) return;
    liveBusy++;
    chainLive = chainLive.then(() => post("/live", msg)).catch(() => {}).then(() => { liveBusy--; });
  }
  async function resync() {
    ready = false;
    try {
      const r = await fetch(API + "/state", { credentials: "same-origin" });
      if (!r.ok) throw new Error();
      const d = await r.json();
      objs = new Map(d.objs.map((o) => [o.id, o]));
      lastSeq = d.seq;
      selection = new Set([...selection].filter((id) => objs.has(id)));
      live.clear();
      ready = true;
      for (const m of backlog.splice(0)) onOp(m);                      // changes that arrived while loading
    } catch { say("The board could not be loaded. Reload the page to try again.", true); }
    dirty();
  }

  // ---------- applying operations (the same rules as board.py) ----------
  function apply(op) {
    switch (op.t) {
      case "add": for (const o of op.objs) objs.set(o.id, o); break;   // an existing id keeps its place
      case "del": for (const id of op.ids) { objs.delete(id); selection.delete(id); } break;
      case "set":
        for (const { id, patch } of op.items) { const o = objs.get(id); if (o) objs.set(id, { ...o, ...patch }); }
        break;
      case "batch": op.ops.forEach(apply); break;
    }
    dirty();
  }
  function onOp(m) {
    if (m.seq <= lastSeq) return;
    lastSeq = m.seq;
    apply(m.op);
    live.delete(m.from);                // whatever they were drawing is now a real stroke (or was dropped)
  }

  // My own change: apply it here, send it, and remember how to take it back.
  function commit(op, inv) {
    apply(op);
    sendOp(op);
    undoStack.push({ op, inv });
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
    ui();
  }
  function undo() {
    const e = undoStack.pop();
    if (!e) return;
    apply(e.inv); sendOp(e.inv); redoStack.push(e); ui();
  }
  function redo() {
    const e = redoStack.pop();
    if (!e) return;
    apply(e.op); sendOp(e.op); undoStack.push(e); ui();
  }

  // ---------- drawing ----------
  function image(src) {
    let e = imgs.get(src);
    if (!e) {
      e = { img: new Image(), ok: false };
      e.img.onload = () => { e.ok = true; dirty(); };
      e.img.src = src;
      imgs.set(src, e);
    }
    return e;
  }
  function paintStroke(c, s) {
    const p = s.points;
    if (!p.length) return;
    c.save();
    c.translate(s.dx || 0, s.dy || 0);
    c.strokeStyle = c.fillStyle = s.color;
    c.lineWidth = s.size;
    c.lineCap = c.lineJoin = "round";
    if (p.length === 1) {
      c.beginPath(); c.arc(p[0][0], p[0][1], s.size / 2, 0, Math.PI * 2); c.fill();
    } else {
      c.beginPath();
      c.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length - 1; i++) c.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
      c.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
      c.stroke();
    }
    c.restore();
  }
  function paintImage(c, o) {
    const e = image(o.src);
    c.save();
    c.translate(o.cx, o.cy);
    c.rotate(o.rot || 0);
    if (e.ok) c.drawImage(e.img, -o.w / 2, -o.h / 2, o.w, o.h);
    else { c.strokeStyle = "#999"; c.setLineDash([8, 6]); c.strokeRect(-o.w / 2, -o.h / 2, o.w, o.h); }
    c.restore();
  }
  const paintObj = (c, o) => (o.kind === "image" ? paintImage(c, o) : paintStroke(c, o));

  function paintCursor(c, x, y, name, color, k) {
    c.save();
    c.translate(x, y);
    c.scale(1 / k, 1 / k);              // the same size on screen however the board is scaled
    c.fillStyle = color; c.strokeStyle = "#fff"; c.lineWidth = 1.5;
    c.beginPath();
    [[0, 0], [0, 17], [4.5, 13], [8, 20], [10.5, 19], [7, 12], [12, 12]].forEach(([px, py], i) => (i ? c.lineTo(px, py) : c.moveTo(px, py)));
    c.closePath(); c.fill(); c.stroke();
    c.font = "12px Inter, system-ui, sans-serif";
    const w = c.measureText(name).width + 10;
    c.fillStyle = color;
    c.beginPath(); c.roundRect(12, 18, w, 18, 4); c.fill();
    c.fillStyle = "#fff"; c.textBaseline = "middle"; c.fillText(name, 17, 27.5);
    c.restore();
  }

  // Bounding box [x0, y0, x1, y1] in board units, cached because objects are replaced rather than edited.
  const boxes = new WeakMap();
  function bounds(o) {
    let b = boxes.get(o);
    if (b) return b;
    if (o.kind === "image") {
      const c = Math.abs(Math.cos(o.rot || 0)), s = Math.abs(Math.sin(o.rot || 0));
      const w = o.w * c + o.h * s, h = o.w * s + o.h * c;
      b = [o.cx - w / 2, o.cy - h / 2, o.cx + w / 2, o.cy + h / 2];
    } else {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of o.points) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const pad = o.size / 2;
      b = [x0 + (o.dx || 0) - pad, y0 + (o.dy || 0) - pad, x1 + (o.dx || 0) + pad, y1 + (o.dy || 0) + pad];
    }
    boxes.set(o, b);
    return b;
  }
  function segDist2(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? clamp(((px - ax) * dx + (py - ay) * dy) / len, 0, 1) : 0;
    const x = ax + t * dx - px, y = ay + t * dy - py;
    return x * x + y * y;
  }
  function hits(o, x, y, tol) {
    const b = bounds(o);
    if (x < b[0] - tol || x > b[2] + tol || y < b[1] - tol || y > b[3] + tol) return false;
    if (o.kind === "image") {
      const a = -(o.rot || 0), dx = x - o.cx, dy = y - o.cy;
      const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
      return Math.abs(lx) <= o.w / 2 && Math.abs(ly) <= o.h / 2;
    }
    const px = x - (o.dx || 0), py = y - (o.dy || 0), r = o.size / 2 + tol, p = o.points;
    if (p.length === 1) return (px - p[0][0]) ** 2 + (py - p[0][1]) ** 2 <= r * r;
    for (let i = 1; i < p.length; i++) if (segDist2(px, py, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) <= r * r) return true;
    return false;
  }
  function pick(x, y, tol) {            // the top-most object under a point
    const all = [...objs.values()];
    for (let i = all.length - 1; i >= 0; i--) if (hits(all[i], x, y, tol)) return all[i];
    return null;
  }

  function singleImage() {
    if (tool !== "select" || selection.size !== 1) return null;
    const o = objs.get([...selection][0]);
    return o && o.kind === "image" ? o : null;
  }
  function handles(o, k) {              // resize handle (bottom-right corner) and rotate handle (above the top edge)
    const c = Math.cos(o.rot || 0), s = Math.sin(o.rot || 0);
    const at = (lx, ly) => [o.cx + lx * c - ly * s, o.cy + lx * s + ly * c];
    return { scale: at(o.w / 2, o.h / 2), top: at(0, -o.h / 2), rot: at(0, -o.h / 2 - 34 / k) };
  }

  function overlay(k) {
    ctx.save();
    ctx.lineWidth = 1.5 / k;
    ctx.strokeStyle = "#8a5bd8";
    ctx.setLineDash([6 / k, 5 / k]);
    for (const id of selection) {
      const o = objs.get(id);
      if (!o) continue;
      if (o.kind === "image") {
        ctx.save(); ctx.translate(o.cx, o.cy); ctx.rotate(o.rot || 0);
        ctx.strokeRect(-o.w / 2, -o.h / 2, o.w, o.h);
        ctx.restore();
      } else {
        const b = bounds(o);
        ctx.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
      }
    }
    ctx.setLineDash([]);
    const one = singleImage();
    if (one) {
      const h = handles(one, k);
      ctx.beginPath(); ctx.moveTo(h.top[0], h.top[1]); ctx.lineTo(h.rot[0], h.rot[1]); ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(h.rot[0], h.rot[1], 7 / k, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillRect(h.scale[0] - 6 / k, h.scale[1] - 6 / k, 12 / k, 12 / k);
      ctx.strokeRect(h.scale[0] - 6 / k, h.scale[1] - 6 / k, 12 / k, 12 / k);
    }
    if (act && act.type === "band") {
      ctx.fillStyle = "#8a5bd822";
      ctx.fillRect(act.x0, act.y0, act.x1 - act.x0, act.y1 - act.y0);
      ctx.strokeRect(act.x0, act.y0, act.x1 - act.x0, act.y1 - act.y0);
    }
    ctx.restore();
  }

  function draw() {
    raf = 0;
    const k = scaleK();
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, W, H);
    const fading = act && act.type === "erase" ? act.ids : null;
    for (const o of objs.values()) {
      if (fading && fading.has(o.id)) { ctx.globalAlpha = 0.2; paintObj(ctx, o); ctx.globalAlpha = 1; }
      else paintObj(ctx, o);
    }
    for (const s of live.values()) paintStroke(ctx, s);
    if (act && act.type === "pen") paintStroke(ctx, { color: act.color, size: act.size, points: act.points });
    overlay(k);
    for (const [id, c] of cursors) paintCursor(ctx, c.x, c.y, (window.Live.user(id) || {}).name || "Someone", colorOf(id), k);
    ui();
  }
  new ResizeObserver(dirty).observe(cv);

  // ---------- gestures ----------
  const pt = (e) => {
    const r = cv.getBoundingClientRect();
    return [((e.clientX - r.left) * W) / r.width, ((e.clientY - r.top) * H) / r.height];
  };
  const pickFields = (o) => Object.fromEntries(FIELDS[o.kind].map((f) => [f, o[f] || 0]));

  let flushT = 0, setT = 0, setIds = [], lastCursor = 0;
  function queueStroke() {               // sends the points drawn so far, at most every 50 ms
    if (flushT) return;
    flushT = setTimeout(() => {
      flushT = 0;
      if (!act || act.type !== "pen") return;
      const pts = act.points.slice(act.sent, act.sent + 400);
      if (!pts.length) return;
      sendLive({ kind: "stroke", id: act.id, color: act.color, size: act.size, pts });
      act.sent += pts.length;
      if (act.sent < act.points.length) queueStroke();
    }, 50);
  }
  function queueSet(ids) {               // shows others the objects being dragged
    setIds = [...ids];
    if (setT) return;
    setT = setTimeout(() => {
      setT = 0;
      const items = setIds.map((id) => objs.get(id)).filter(Boolean).map((o) => ({ id: o.id, patch: pickFields(o) }));
      if (items.length) sendLive({ kind: "set", items });
    }, 50);
  }
  function sendCursor(x, y) {
    const now = performance.now();
    if (now - lastCursor < 50) return;
    lastCursor = now;
    sendLive({ kind: "cursor", x: r1(x), y: r1(y) }, true);
  }

  function selectDown(e, x, y) {
    const k = scaleK(), one = singleImage();
    if (one) {
      const h = handles(one, k), near = (p) => Math.hypot(x - p[0], y - p[1]) <= 12 / k;
      if (near(h.scale)) { act = { type: "scale", o: one, d0: Math.hypot(one.w / 2, one.h / 2) }; return; }
      if (near(h.rot)) { act = { type: "rotate", o: one }; return; }
    }
    const target = pick(x, y, 8 / k);
    if (target) {
      if (!selection.has(target.id)) { if (!e.shiftKey) selection.clear(); selection.add(target.id); }
      else if (e.shiftKey) { selection.delete(target.id); return; }
      act = { type: "move", from: [x, y], orig: new Map([...selection].map((id) => [id, objs.get(id)])), moved: false };
    } else {
      act = { type: "band", x0: x, y0: y, x1: x, y1: y, base: e.shiftKey ? new Set(selection) : new Set() };
      if (!e.shiftKey) selection.clear();
    }
  }

  function eraseAt(x, y) {
    const o = pick(x, y, 6 / scaleK());
    if (o && o.kind === "stroke") act.ids.add(o.id);
  }

  cv.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !ready) return;
    cv.setPointerCapture(e.pointerId);
    const [x, y] = pt(e);
    if (tool === "pen") {
      act = { type: "pen", id: rid(), color: $("#b-color").value, size: +$("#b-size").value, points: [[r1(x), r1(y)]], sent: 0 };
      queueStroke();
    } else if (tool === "eraser") {
      act = { type: "erase", ids: new Set() };
      eraseAt(x, y);
    } else selectDown(e, x, y);
    e.preventDefault();
    dirty(); ui();
  });

  cv.addEventListener("pointermove", (e) => {
    if (!ready) return;
    const [x, y] = pt(e);
    sendCursor(x, y);
    const a = act;
    if (!a) return;
    if (a.type === "pen") {
      for (const ev of e.getCoalescedEvents ? e.getCoalescedEvents() : [e]) {
        const [px, py] = pt(ev), last = a.points[a.points.length - 1];
        if (Math.hypot(px - last[0], py - last[1]) >= 1.5 && a.points.length < 19000) a.points.push([r1(px), r1(py)]);
      }
      queueStroke();
    } else if (a.type === "erase") {
      eraseAt(x, y);
    } else if (a.type === "move") {
      const dx = x - a.from[0], dy = y - a.from[1];
      if (!a.moved && Math.hypot(dx, dy) < 2) return;
      a.moved = true;
      for (const [id, o] of a.orig) {
        if (!o) continue;
        objs.set(id, o.kind === "image"
          ? { ...o, cx: r1(o.cx + dx), cy: r1(o.cy + dy) }
          : { ...o, dx: r1((o.dx || 0) + dx), dy: r1((o.dy || 0) + dy) });
      }
      queueSet(a.orig.keys());
    } else if (a.type === "scale") {
      const k = clamp(Math.hypot(x - a.o.cx, y - a.o.cy) / a.d0, 8 / Math.min(a.o.w, a.o.h), 20000 / Math.max(a.o.w, a.o.h));
      objs.set(a.o.id, { ...a.o, w: r1(a.o.w * k), h: r1(a.o.h * k) });
      a.moved = true;
      queueSet([a.o.id]);
    } else if (a.type === "rotate") {
      let ang = Math.atan2(y - a.o.cy, x - a.o.cx) + Math.PI / 2;
      if (e.shiftKey) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
      objs.set(a.o.id, { ...a.o, rot: Math.round(ang * 1000) / 1000 });
      a.moved = true;
      queueSet([a.o.id]);
    } else if (a.type === "band") {
      a.x1 = x; a.y1 = y;
      const x0 = Math.min(a.x0, x), x1 = Math.max(a.x0, x), y0 = Math.min(a.y0, y), y1 = Math.max(a.y0, y);
      selection = new Set(a.base);
      for (const o of objs.values()) {
        const b = bounds(o);
        if (b[0] <= x1 && b[2] >= x0 && b[1] <= y1 && b[3] >= y0) selection.add(o.id);
      }
    }
    dirty();
  });

  // After a drag: one "set" operation for everything that moved, with the old values as its undo.
  function commitChange(a) {
    const before = a.type === "move" ? a.orig : new Map([[a.o.id, a.o]]);
    const to = [], from = [];
    for (const [id, was] of before) {
      const now = objs.get(id);
      if (!was || !now) continue;
      const patchTo = {}, patchFrom = {};
      for (const f of FIELDS[now.kind]) {
        if ((now[f] || 0) !== (was[f] || 0)) { patchTo[f] = now[f] || 0; patchFrom[f] = was[f] || 0; }
      }
      if (Object.keys(patchTo).length) { to.push({ id, patch: patchTo }); from.push({ id, patch: patchFrom }); }
    }
    if (to.length) commit({ t: "set", items: to }, { t: "set", items: from });
  }

  function end() {
    if (!act) return;
    const a = act;
    act = null;
    if (a.type === "pen") {
      const o = { id: a.id, kind: "stroke", color: a.color, size: a.size, points: a.points, dx: 0, dy: 0 };
      commit({ t: "add", objs: [o] }, { t: "del", ids: [o.id] });
    } else if (a.type === "erase") {
      const gone = [...a.ids].map((id) => objs.get(id)).filter(Boolean);
      if (gone.length) commit({ t: "del", ids: gone.map((o) => o.id) }, { t: "add", objs: gone });
    } else if (a.type !== "band" && a.moved) {
      commitChange(a);
    }
    dirty(); ui();
  }
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  cv.addEventListener("pointerleave", () => { if (!act) sendLive({ kind: "cursor" }, true); });

  // ---------- turning a drawing into an image ----------
  async function makeImage() {
    const strokes = selection.size
      ? [...selection].map((id) => objs.get(id)).filter((o) => o && o.kind === "stroke")
      : [...objs.values()].filter((o) => o.kind === "stroke");
    if (!strokes.length) return say("Draw something first, or select strokes with the Select tool.", true);
    say("Making the image…");
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const o of strokes) {
      const b = bounds(o);
      x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
    }
    x0 = Math.floor(x0 - 4); y0 = Math.floor(y0 - 4); x1 = Math.ceil(x1 + 4); y1 = Math.ceil(y1 + 4);
    const w = x1 - x0, h = y1 - y0, s = Math.min(2, 4096 / Math.max(w, h));     // drawn at up to 2x so it stays sharp
    const off = document.createElement("canvas");
    off.width = Math.max(1, Math.ceil(w * s)); off.height = Math.max(1, Math.ceil(h * s));
    const c = off.getContext("2d");                                              // transparent background
    c.scale(s, s); c.translate(-x0, -y0);
    strokes.forEach((o) => paintStroke(c, o));
    const blob = await new Promise((res) => off.toBlob(res, "image/png"));
    if (!blob) return say("This browser could not make the image.", true);
    const r = await fetch(`${API}/image?from=${encodeURIComponent(me())}`, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "image/png" }, body: blob,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return say(d.error || "The server could not store the image.", true);
    const e = image(d.src);                                                      // have it ready before it replaces the strokes
    await e.img.decode().then(() => { e.ok = true; }).catch(() => {});
    const img = { id: rid(), kind: "image", src: d.src, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w, h, rot: 0 };
    commit(
      { t: "batch", ops: [{ t: "del", ids: strokes.map((o) => o.id) }, { t: "add", objs: [img] }] },
      { t: "batch", ops: [{ t: "del", ids: [img.id] }, { t: "add", objs: strokes }] },
    );
    setTool("select");
    selection = new Set([img.id]);
    say("Made an image. Drag it to move it; use the handles to resize or rotate.");
    dirty();
  }

  function deleteSelected() {
    const gone = [...selection].map((id) => objs.get(id)).filter(Boolean);
    if (gone.length) commit({ t: "del", ids: gone.map((o) => o.id) }, { t: "add", objs: gone });
  }
  function clearBoard() {
    const all = [...objs.values()];
    if (!all.length) return say("The board is already empty.");
    if (!confirm("Clear the whole board for everyone? You can still undo it.")) return;
    commit({ t: "del", ids: all.map((o) => o.id) }, { t: "add", objs: all });
  }

  // ---------- toolbar, keys, tabs ----------
  function setTool(t) {
    tool = t;
    if (t !== "select") selection.clear();
    cv.style.cursor = t === "select" ? "default" : "crosshair";
    dirty(); ui();
  }
  function ui() {
    $("#b-undo").disabled = !undoStack.length;
    $("#b-redo").disabled = !redoStack.length;
    $("#b-delete").disabled = !selection.size;
    $("#b-image").title = selection.size ? "Turn the selected strokes into an image" : "Turn every stroke on the board into one image";
    $$("[data-tool]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tool === tool)));
  }
  $$("[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
  $("#b-undo").addEventListener("click", undo);
  $("#b-redo").addEventListener("click", redo);
  $("#b-image").addEventListener("click", () => makeImage().catch((err) => say(err.message || String(err), true)));
  $("#b-delete").addEventListener("click", deleteSelected);
  $("#b-clear").addEventListener("click", clearBoard);
  cv.style.cursor = "crosshair";

  document.addEventListener("keydown", (e) => {
    if ($("#view-board").hidden || e.target.closest("input[type='text'], textarea, select")) return;
    const key = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod && key === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if (mod && key === "y") { e.preventDefault(); redo(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && selection.size) { e.preventDefault(); deleteSelected(); }
  });

  let unread = 0;
  function showView(v) {
    $$("[data-view]").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.view === v)));
    $("#view-chat").hidden = v !== "chat";
    $("#view-board").hidden = v !== "board";
    if (v === "chat") {
      unread = 0;
      $("#unread").hidden = true;
      $("#log").scrollTop = $("#log").scrollHeight;
    } else dirty();
  }
  $$("[data-view]").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));
  document.addEventListener("live:chat", () => {
    if (!$("#view-board").hidden) { $("#unread").textContent = ++unread; $("#unread").hidden = false; }
  });

  // ---------- events from the room ----------
  document.addEventListener("live:welcome", () => {
    undoStack.length = 0; redoStack.length = 0;
    cursors.clear(); live.clear();
    resync();
  });
  document.addEventListener("live:disconnect", () => { ready = false; cursors.clear(); live.clear(); dirty(); });
  document.addEventListener("live:leave", (ev) => { cursors.delete(ev.detail.id); live.delete(ev.detail.id); dirty(); });
  document.addEventListener("live:bop", (ev) => { if (ready) onOp(ev.detail); else backlog.push(ev.detail); });
  document.addEventListener("live:blive", (ev) => {
    const m = ev.detail;
    if (m.kind === "cursor") {
      if (m.x == null) cursors.delete(m.from); else cursors.set(m.from, { x: m.x, y: m.y });
    } else if (m.kind === "stroke") {
      let s = live.get(m.from);
      if (!s || s.id !== m.id) { s = { id: m.id, color: m.color, size: m.size, points: [], dx: 0, dy: 0 }; live.set(m.from, s); }
      s.points.push(...m.pts);
      s.seen = performance.now();
    } else if (m.kind === "set") {
      for (const { id, patch } of m.items) { const o = objs.get(id); if (o) objs.set(id, { ...o, ...patch }); }
    }
    dirty();
  });
  setInterval(() => {                    // a stroke whose author vanished mid-way doesn't linger
    let gone = false;
    for (const [u, s] of live) if (performance.now() - (s.seen || 0) > 8000) { live.delete(u); gone = true; }
    if (gone) dirty();
  }, 3000);

  ui();
})();
