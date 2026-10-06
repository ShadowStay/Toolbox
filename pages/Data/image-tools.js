// Page script for html/image-tools.html. A small layer editor: every image is a layer you can
// drag, resize, rotate and crop directly on the artboard. All processing happens in the browser.
(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const cv = $("#view"), ctx = cv.getContext("2d"), stage = $("#stage"), box = $("#box"), status = $("#status");
  const val = (id) => $("#" + id).value;
  const num = (id) => parseFloat(val(id));
  const checked = (id) => $("#" + id).checked;
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const DEG = Math.PI / 180;

  let art = { w: 0, h: 0, bg: "#ffffff", transp: false };
  let layers = [], sel = null, history = [], cropping = false, drag = null, seq = 0;

  const filterDefs = [
    ["brightness", "Brightness", 0, 300, 100, "%"],
    ["contrast", "Contrast", 0, 300, 100, "%"],
    ["saturate", "Saturation", 0, 300, 100, "%"],
    ["hue-rotate", "Hue", 0, 360, 0, "deg"],
    ["blur", "Blur", 0, 20, 0, "px"],
    ["grayscale", "Grayscale", 0, 100, 0, "%"],
    ["sepia", "Sepia", 0, 100, 0, "%"],
    ["invert", "Invert", 0, 100, 0, "%"],
  ];
  const newF = () => Object.fromEntries(filterDefs.map((d) => [d[0], d[4]]));
  const filterStr = (f) => filterDefs.filter((d) => f[d[0]] !== d[4]).map((d) => `${d[0]}(${f[d[0]]}${d[5]})`).join(" ");
  $("#filters").innerHTML = filterDefs.map(([k, label, min, max, def, unit]) =>
    `<label class="slider"><span>${label}</span><input type="range" data-f="${k}" min="${min}" max="${max}" value="${def}" data-unit="${unit}"><output>${def}${unit}</output></label>`
  ).join("");

  // ---------- state helpers ----------
  function canvasOf(w, h) {
    w = Math.round(w); h = Math.round(h);
    if (!(w > 0 && h > 0)) throw new Error("Width and height must be positive numbers.");
    if (w * h > 1e8 || Math.max(w, h) > 16384) throw new Error("That is bigger than the browser can handle (16,384 px per side at most).");
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  }
  const setArt = (w, h) => { const c = canvasOf(w, h); art.w = c.width; art.h = c.height; };
  const need = () => { if (!sel) throw new Error("Select a layer first: click an image."); };
  const copyLayer = (l) => ({ ...l, f: { ...l.f } });

  function snapshot() {
    history.push({ art: { ...art }, layers: layers.map(copyLayer), sel: layers.indexOf(sel) });
    if (history.length > 40) history.shift();
  }
  function restore(s) {
    art = { ...s.art };
    layers = s.layers.map(copyLayer);
    sel = layers[s.sel] || null;
    cropping = false;
    refresh();
  }

  // ---------- drawing ----------
  function paint(c) {
    const x = c.getContext("2d");
    x.clearRect(0, 0, c.width, c.height);
    if (!art.transp) { x.fillStyle = art.bg; x.fillRect(0, 0, c.width, c.height); }
    for (const l of layers) {
      x.save();
      x.translate(l.cx, l.cy);
      x.rotate(l.rot);
      x.scale(l.fx ? -1 : 1, l.fy ? -1 : 1);
      const f = filterStr(l.f);
      if (f && "filter" in x) x.filter = f;
      x.imageSmoothingQuality = "high";
      x.drawImage(l.bmp, l.sx, l.sy, l.sw, l.sh, -l.w / 2, -l.h / 2, l.w, l.h);
      x.restore();
    }
  }

  const HANDLES = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  const cursorFor = ([x, y]) => (x && y ? (x === y ? "nwse-resize" : "nesw-resize") : x ? "ew-resize" : "ns-resize");
  box.innerHTML = HANDLES.map((h) =>
    `<i data-h="${h}" style="left:${(h[0] + 1) * 50}%;top:${(h[1] + 1) * 50}%;cursor:${cursorFor(h)}"></i>`).join("") +
    `<i class="rot" data-h="rot"></i>`;

  function place() {
    box.hidden = !sel;
    if (!sel || !art.w) return;
    const s = cv.clientWidth / art.w;
    Object.assign(box.style, {
      left: (sel.cx - sel.w / 2) * s + "px", top: (sel.cy - sel.h / 2) * s + "px",
      width: sel.w * s + "px", height: sel.h * s + "px", transform: `rotate(${sel.rot}rad)`,
    });
    box.classList.toggle("cropping", cropping);
  }
  const redraw = () => { paint(cv); place(); };

  const put = (id, v) => { const el = $("#" + id); if (document.activeElement !== el) el.value = v; };
  function syncInputs() {
    put("ab-w", art.w); put("ab-h", art.h);
    $("#ab-bg").value = art.bg; $("#ab-transp").checked = art.transp;
    put("ly-w", sel ? Math.round(sel.w) : ""); put("ly-h", sel ? Math.round(sel.h) : "");
    put("ly-rot", sel ? Math.round((((sel.rot / DEG) % 360) + 360) % 360) : "");
    filterDefs.forEach(([k, , , , def, unit]) => {
      const el = $(`[data-f="${k}"]`), v = sel ? sel.f[k] : def;
      el.value = v; el.nextElementSibling.textContent = v + unit;
    });
    $("#crop-btn").setAttribute("aria-pressed", String(cropping));
  }

  function renderTray() {
    $("#tray").innerHTML = layers.map((l, i) => `
      <li class="${l === sel ? "on" : ""}">
        <img src="${l.url}" alt="" data-action="pick" data-arg="${i}" title="Select">
        <span class="name" title="${l.name.replace(/"/g, "&quot;")}">${l.name.replace(/</g, "&lt;")}</span>
        <span class="row">
          <button class="btn small" data-action="trayOp" data-arg="left:${i}" title="Send backward" aria-label="Send backward">◀</button>
          <button class="btn small" data-action="trayOp" data-arg="right:${i}" title="Bring forward" aria-label="Bring forward">▶</button>
          <button class="btn small" data-action="trayOp" data-arg="remove:${i}" title="Remove" aria-label="Remove">✕</button>
        </span>
      </li>`).join("");
  }

  function refresh() {
    const has = layers.length > 0;
    $("#empty").hidden = has;
    $("#stage-box").hidden = !has;
    renderTray();
    if (has) {
      if (cv.width !== art.w || cv.height !== art.h) { cv.width = art.w; cv.height = art.h; }
      redraw();
      $("#dims").textContent = `${art.w} × ${art.h} px`;
    }
    syncInputs();
    $("#undo").disabled = !history.length;
  }
  new ResizeObserver(place).observe(cv);

  // ---------- direct manipulation on the artboard ----------
  const pt = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * art.w, y: ((e.clientY - r.top) / r.height) * art.h };
  };
  function hitTest(p) {
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i], dx = p.x - l.cx, dy = p.y - l.cy, c = Math.cos(l.rot), s = Math.sin(l.rot);
      if (Math.abs(dx * c + dy * s) <= l.w / 2 && Math.abs(-dx * s + dy * c) <= l.h / 2) return l;
    }
    return null;
  }

  // Resize (or crop) the selected layer by dragging handle [hx, hy]; the opposite edge stays put.
  function resizeTo(p, free) {
    const o = drag.o, [hx, hy] = drag.h, l = sel;
    const c = Math.cos(o.rot), s = Math.sin(o.rot), dx = p.x - o.cx, dy = p.y - o.cy;
    const lx = dx * c + dy * s, ly = -dx * s + dy * c;
    let nw = hx ? Math.max(8, (lx + (hx * o.w) / 2) * hx) : o.w;
    let nh = hy ? Math.max(8, (ly + (hy * o.h) / 2) * hy) : o.h;
    if (hx && hy && !free && !cropping) { const k = Math.max(nw / o.w, nh / o.h); nw = o.w * k; nh = o.h * k; }
    if (cropping) {
      // Keep the image scale; only change which part of the source is visible.
      const axis = (n, size, s0, sl, max, e) => {
        const nsl = Math.min((sl * n) / size, e > 0 ? max - s0 : s0 + sl);
        return [(nsl * size) / sl, e > 0 ? s0 : s0 + sl - nsl, nsl];
      };
      if (hx) [nw, l.sx, l.sw] = axis(nw, o.w, o.sx, o.sw, o.bmp.width, o.fx ? -hx : hx);
      if (hy) [nh, l.sy, l.sh] = axis(nh, o.h, o.sy, o.sh, o.bmp.height, o.fy ? -hy : hy);
    }
    l.w = nw; l.h = nh;
    const ox = (hx * (nw - o.w)) / 2, oy = (hy * (nh - o.h)) / 2;
    l.cx = o.cx + ox * c - oy * s;
    l.cy = o.cy + ox * s + oy * c;
  }

  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const p = pt(e), h = e.target.dataset.h;
    let type = null;
    if (h) type = h === "rot" ? "rot" : "size";
    else {
      const hit = hitTest(p);
      if (hit !== sel) { sel = hit; cropping = false; refresh(); }
      if (hit) type = "move";
    }
    if (!type) return;
    snapshot();
    drag = { type, p0: p, o: { ...sel }, h: type === "size" ? h.split(",").map(Number) : null, moved: false };
    stage.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  stage.addEventListener("pointermove", (e) => {
    const p = pt(e);
    if (!drag) { cv.style.cursor = hitTest(p) ? "move" : "default"; return; }
    drag.moved = true;
    const o = drag.o;
    if (drag.type === "move") { sel.cx = o.cx + p.x - drag.p0.x; sel.cy = o.cy + p.y - drag.p0.y; }
    else if (drag.type === "rot") {
      let a = Math.atan2(p.y - sel.cy, p.x - sel.cx) + Math.PI / 2;
      if (e.shiftKey) a = Math.round(a / (15 * DEG)) * 15 * DEG;
      else { const q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2); if (Math.abs(a - q) < 3 * DEG) a = q; }
      sel.rot = a;
    } else resizeTo(p, e.shiftKey);
    redraw();
    syncInputs();
  });
  const endDrag = () => { if (drag && !drag.moved) history.pop(); drag = null; $("#undo").disabled = !history.length; };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  // ---------- export helpers ----------
  async function encode(src) {
    const fmt = val("ex-format");
    let c = src;
    if (fmt === "jpeg") {
      c = canvasOf(src.width, src.height);
      const x = c.getContext("2d");
      x.fillStyle = val("ex-bg");
      x.fillRect(0, 0, c.width, c.height);
      x.drawImage(src, 0, 0);
    }
    const blob = await new Promise((r) => c.toBlob(r, "image/" + fmt, num("ex-quality") / 100));
    if (!blob || blob.type !== "image/" + fmt) throw new Error(`This browser cannot save ${fmt.toUpperCase()} files. Pick another format.`);
    return blob;
  }
  function save(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }
  const fileName = (suffix = "") => {
    const fmt = val("ex-format");
    return (val("ex-name").trim() || "image") + suffix + "." + (fmt === "jpeg" ? "jpg" : fmt);
  };

  // ---------- adding images ----------
  async function addFiles(files) {
    const imgs = [...files].filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) throw new Error("No image files found.");
    snapshot();
    let ok = 0;
    for (const f of imgs) {
      let bmp;
      try { bmp = await createImageBitmap(f); } catch { continue; }
      if (!layers.length) {
        setArt(bmp.width, bmp.height);
        $("#ex-name").value = (f.name || "image").replace(/\.[^.]+$/, "");
      }
      const k = layers.length ? Math.min(1, (art.w * 0.9) / bmp.width, (art.h * 0.9) / bmp.height) : 1;
      const off = (layers.length % 5) * 24;
      sel = {
        id: ++seq, name: f.name || "pasted-image.png", url: URL.createObjectURL(f), bmp,
        cx: art.w / 2 + off, cy: art.h / 2 + off, w: bmp.width * k, h: bmp.height * k, rot: 0, fx: false, fy: false,
        sx: 0, sy: 0, sw: bmp.width, sh: bmp.height, f: newF(),
      };
      layers.push(sel);
      ok++;
    }
    if (!ok) { history.pop(); throw new Error("Those files could not be read as images."); }
    cropping = false;
    refresh();
    status.textContent = `Added ${plural(ok, "image")}. Drag it, or use the handles to resize and rotate.`;
  }

  // ---------- actions (called from buttons via data-action / data-arg) ----------
  const actions = {
    pick(i) { sel = layers[+i] || null; cropping = false; refresh(); },
    trayOp(arg) {
      const [op, i] = arg.split(":"), k = +i;
      snapshot();
      if (op === "remove") { const [l] = layers.splice(k, 1); if (sel === l) { sel = null; cropping = false; } }
      else {
        const j = op === "left" ? k - 1 : k + 1;
        if (!layers[j]) { history.pop(); return; }
        [layers[k], layers[j]] = [layers[j], layers[k]];
      }
      refresh();
    },
    remove() { need(); actions.trayOp("remove:" + layers.indexOf(sel)); },
    duplicate() {
      need(); snapshot();
      const c = { ...copyLayer(sel), id: ++seq, cx: sel.cx + 20, cy: sel.cy + 20 };
      layers.splice(layers.indexOf(sel) + 1, 0, c);
      sel = c;
      refresh();
    },
    flip(ax) { need(); snapshot(); if (ax === "h") sel.fx = !sel.fx; else sel.fy = !sel.fy; refresh(); },
    rotate(d) { need(); snapshot(); sel.rot += +d * DEG; refresh(); },
    fill() {
      need(); snapshot();
      const k = Math.min(art.w / sel.w, art.h / sel.h);
      Object.assign(sel, { w: sel.w * k, h: sel.h * k, cx: art.w / 2, cy: art.h / 2, rot: 0 });
      refresh();
    },
    crop() {
      need();
      cropping = !cropping;
      refresh();
      status.textContent = cropping ? "Crop mode: drag the handles to trim the image. Click Crop again when done." : "";
    },
    resetCrop() {
      need(); snapshot();
      const kx = sel.w / sel.sw, ky = sel.h / sel.sh;
      Object.assign(sel, { sx: 0, sy: 0, sw: sel.bmp.width, sh: sel.bmp.height, w: sel.bmp.width * kx, h: sel.bmp.height * ky });
      refresh();
    },
    resetFilters() { need(); snapshot(); sel.f = newF(); refresh(); },

    setArtboard() { snapshot(); setArt(num("ab-w"), num("ab-h")); refresh(); },
    fitArtboard() {
      if (!layers.length) throw new Error("Add an image first.");
      const pts = layers.flatMap((l) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
        const x = (a * l.w) / 2, y = (b * l.h) / 2, c = Math.cos(l.rot), s = Math.sin(l.rot);
        return [l.cx + x * c - y * s, l.cy + x * s + y * c];
      }));
      const x0 = Math.min(...pts.map((p) => p[0])), y0 = Math.min(...pts.map((p) => p[1]));
      const x1 = Math.max(...pts.map((p) => p[0])), y1 = Math.max(...pts.map((p) => p[1]));
      snapshot();
      setArt(Math.ceil(x1 - x0), Math.ceil(y1 - y0));
      layers.forEach((l) => { l.cx -= x0; l.cy -= y0; });
      refresh();
    },
    arrange() {
      const n = layers.length;
      if (n < 2) throw new Error("Add at least two images to arrange.");
      const mode = val("cb-mode"), gap = Math.max(0, num("cb-gap") || 0), fit = checked("cb-fit");
      const cols = mode === "h" ? n : mode === "v" ? 1 : Math.min(n, Math.max(1, Math.floor(num("cb-cols")) || 2));
      const rows = Math.ceil(n / cols);
      const maxW = Math.max(...layers.map((l) => l.w)), maxH = Math.max(...layers.map((l) => l.h));
      const size = layers.map((l) => {
        const k = !fit ? 1 : mode === "h" ? maxH / l.h : mode === "v" ? maxW / l.w : Math.min(maxW / l.w, maxH / l.h);
        return { w: l.w * k, h: l.h * k };
      });
      const colW = Array(cols).fill(0), rowH = Array(rows).fill(0);
      size.forEach((s, i) => { const c = i % cols, r = Math.floor(i / cols); colW[c] = Math.max(colW[c], s.w); rowH[r] = Math.max(rowH[r], s.h); });
      snapshot();
      setArt(sum(colW) + gap * (cols - 1), sum(rowH) + gap * (rows - 1));
      layers.forEach((l, i) => {
        const c = i % cols, r = Math.floor(i / cols);
        l.rot = 0; l.w = size[i].w; l.h = size[i].h;
        l.cx = sum(colW.slice(0, c)) + gap * c + colW[c] / 2;
        l.cy = sum(rowH.slice(0, r)) + gap * r + rowH[r] / 2;
      });
      refresh();
      status.textContent = `Arranged ${plural(n, "image")}. You can still drag them around.`;
    },

    async download() {
      if (!layers.length) throw new Error("Add an image first.");
      const blob = await encode(cv);
      save(blob, fileName());
      status.textContent = `Saved ${fileName()} (${(blob.size / 1024).toFixed(blob.size < 1e5 ? 1 : 0)} KB).`;
    },
    async split() {
      if (!layers.length) throw new Error("Add an image first.");
      const rows = Math.max(1, Math.floor(num("sp-rows")) || 1), cols = Math.max(1, Math.floor(num("sp-cols")) || 1);
      if (rows * cols < 2) throw new Error("Choose at least 2 pieces.");
      if (rows * cols > 100) throw new Error("That would make more than 100 pieces.");
      let n = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x0 = Math.round((c * cv.width) / cols), x1 = Math.round(((c + 1) * cv.width) / cols);
          const y0 = Math.round((r * cv.height) / rows), y1 = Math.round(((r + 1) * cv.height) / rows);
          const piece = canvasOf(x1 - x0, y1 - y0);
          piece.getContext("2d").drawImage(cv, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
          save(await encode(piece), fileName(`-${++n}`));
          await new Promise((res) => setTimeout(res, 200));
        }
      }
      status.textContent = `Downloaded ${plural(n, "piece")}.`;
    },
    undo() {
      if (!history.length) throw new Error("Nothing to undo.");
      restore(history.pop());
      status.textContent = "Undone.";
    },
  };

  async function run(fn) {
    status.classList.remove("error");
    try { await fn(); }
    catch (err) { status.textContent = err.message; status.classList.add("error"); }
  }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (btn) run(() => actions[btn.dataset.action](btn.dataset.arg));
  });

  // ---------- inputs ----------
  document.addEventListener("pointerdown", (e) => { if (e.target.dataset?.f && sel) snapshot(); });
  document.addEventListener("input", (e) => {
    const t = e.target;
    const out = t.closest(".slider")?.querySelector("output");
    if (out) out.textContent = t.value + (t.dataset.unit || "");
    if (t.id === "ex-format") $("#ex-quality").disabled = t.value === "png";
    if (t.dataset.f) {
      if (!sel) { run(() => need()); syncInputs(); return; }
      if (!("filter" in ctx)) { status.textContent = "This browser can't draw filters (Safari). Try Chrome, Edge or Firefox."; status.classList.add("error"); }
      sel.f[t.dataset.f] = +t.value;
      redraw();
    }
  });

  $$("#ly-w, #ly-h, #ly-rot").forEach((el) => el.addEventListener("focus", () => sel && snapshot()));
  const dim = (id, other, ratioOf) => $("#" + id).addEventListener("input", () => {
    const v = num(id);
    if (!sel || !(v > 0)) return;
    const ratio = ratioOf();
    sel[id === "ly-w" ? "w" : "h"] = v;
    if (checked("ly-lock")) sel[other] = id === "ly-w" ? v * ratio : v / ratio;
    redraw(); syncInputs();
  });
  dim("ly-w", "h", () => sel.h / sel.w);
  dim("ly-h", "w", () => sel.h / sel.w);
  $("#ly-rot").addEventListener("input", () => { if (sel) { sel.rot = (num("ly-rot") || 0) * DEG; redraw(); } });
  $("#ab-bg").addEventListener("input", () => { art.bg = val("ab-bg"); redraw(); });
  $("#ab-transp").addEventListener("change", () => { art.transp = checked("ab-transp"); redraw(); });

  $("#files").addEventListener("change", (e) => { run(() => addFiles(e.target.files)).then(() => (e.target.value = "")); });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) run(() => addFiles(e.dataTransfer.files));
  });
  document.addEventListener("paste", (e) => {
    if (e.clipboardData?.files.length) { e.preventDefault(); run(() => addFiles(e.clipboardData.files)); }
  });
  document.addEventListener("keydown", (e) => {
    if (!sel || e.target.closest("input, select, textarea")) return;
    const st = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] }[e.key];
    if (d) { e.preventDefault(); snapshot(); sel.cx += d[0]; sel.cy += d[1]; refresh(); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); run(() => actions.remove()); }
  });

  // ---------- tabs ----------
  $$("[data-tab]").forEach((t) => t.addEventListener("click", () => {
    $$("[data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === t)));
    $$("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== t.dataset.tab));
    status.textContent = ""; status.classList.remove("error");
  }));
})();
