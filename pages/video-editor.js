// pages/video-editor.js
// Page script for pages/video-editor.html: a small multi-track video editor.
// Editing and preview always run in the browser (a <video>/<audio> element per clip, mixed with Web Audio and drawn on a
// canvas). Export runs in the browser too (MediaRecorder for MP4/WebM, offline mixing for MP3/WAV) or, when "On the
// server" is chosen in Options, through ffmpeg (processing/video.py), which adds MOV, MKV, AVI, GIF, M4A, OGG and FLAC.
(function () {
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pad2 = (n) => String(n).padStart(2, "0");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const baseOf = (n) => n.replace(/\.[^.]+$/, "") || "file";
  const extOf = (n) => (n.match(/\.([^.]+)$/) || [, ""])[1].toLowerCase();
  const fmtSize = (n) => (n < 1048576 ? (n / 1024).toFixed(0) + " KB" : (n / 1048576).toFixed(1) + " MB");
  const HEAD_W = 168;                 // width of the track headers in px (keep in sync with --head-w in the css)
  const MIN_DUR = 0.1;                // shortest clip, in seconds

  const status = $("#status");
  const say = (text, error) => { status.textContent = text; status.classList.toggle("error", !!error); };

  // ---------- state ----------
  const proj = { w: 1280, h: 720, fps: 30 };
  const media = new Map();            // id -> {id, name, file, kind, url, duration, w, h, thumb, img, peaks}
  let tracks = [];                    // top to bottom: {id, type, name, muted, hidden, locked, clips: [{id, mid, type, start, in, dur, vol}]}
  const trackCount = { video: 0, audio: 0 };
  let seq = 0, mseq = 0;
  const uid = () => ++seq;
  let selId = null, activeTrack = null;
  let playhead = 0, playing = false, base = 0, t0 = 0, raf = 0;
  let pps = 60, snapOn = true, exporting = false, cancelExport = false;
  const hist = { undo: [], redo: [] };
  const els = new Map();              // clip id -> {el, src, gain}

  const end = (c) => c.start + c.dur;
  const projectEnd = () => Math.max(0, ...tracks.flatMap((t) => t.clips.map(end)));
  function findClip(id) {
    for (const track of tracks) { const clip = track.clips.find((c) => c.id === id); if (clip) return { clip, track }; }
    return null;
  }
  const canHost = (track, clip) => (track.type === "audio" ? clip.type === "audio" : clip.type !== "audio");

  function isFree(track, start, dur, ignoreId) {
    return track.clips.every((c) => c.id === ignoreId || start + dur <= c.start + 1e-6 || start >= end(c) - 1e-6);
  }
  // Nearest start to `start` where the clip does not overlap another clip on the track.
  function fit(track, clip, start) {
    start = Math.max(0, start);
    if (isFree(track, start, clip.dur, clip.id)) return start;
    const cands = [];
    for (const c of track.clips) if (c.id !== clip.id) cands.push(end(c), c.start - clip.dur);
    return cands.filter((s) => s >= 0 && isFree(track, s, clip.dur, clip.id)).sort((a, b) => Math.abs(a - start) - Math.abs(b - start))[0];
  }

  function newTrack(type) {
    const n = ++trackCount[type];
    return { id: uid(), type, name: (type === "video" ? "Video " : "Audio ") + n, muted: false, hidden: false, locked: false, clips: [] };
  }
  function addTrack(type) {
    const t = newTrack(type);
    if (type === "video") tracks.unshift(t); else tracks.push(t);   // new video tracks go on top, new audio tracks below
    return t;
  }

  function tc(t) {
    const f = proj.fps, total = Math.round(Math.max(0, t) * f), s = Math.floor(total / f);
    return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}:${pad2(total % f)}`;
  }
  const clock = (t) => (t >= 3600 ? `${Math.floor(t / 3600)}:${pad2(Math.floor(t / 60) % 60)}:${pad2(Math.floor(t % 60))}` : `${Math.floor(t / 60)}:${pad2(Math.floor(t % 60))}`);

  // ---------- history ----------
  function pushHistory() { hist.undo.push(JSON.stringify(tracks)); if (hist.undo.length > 100) hist.undo.shift(); hist.redo.length = 0; }
  function edit(fn) { pushHistory(); fn(); afterChange(); }
  function undo() { if (!hist.undo.length) return; hist.redo.push(JSON.stringify(tracks)); tracks = JSON.parse(hist.undo.pop()); afterChange(); }
  function redo() { if (!hist.redo.length) return; hist.undo.push(JSON.stringify(tracks)); tracks = JSON.parse(hist.redo.pop()); afterChange(); }
  function afterChange() {
    if (selId && !findClip(selId)) selId = null;
    if (activeTrack && !tracks.some((t) => t.id === activeTrack)) activeTrack = null;
    renderTimeline();
    renderInspector();
    syncMedia();
    drawFrame();
    updateTransport();
  }

  // ---------- audio graph ----------
  let actx = null, master = null;
  function getCtx() {
    if (!actx) {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      master = actx.createGain();
      master.connect(actx.destination);
    }
    return actx;
  }

  // ---------- libraries, loaded on demand ----------
  const CDN = "https://cdnjs.cloudflare.com/ajax/libs/";
  const LIBS = { lame: { label: "MP3 encoder", global: "lamejs", src: CDN + "lamejs/1.2.1/lame.min.js" } };
  const pending = {};
  function lib(name) {
    const l = LIBS[name];
    if (window[l.global]) return Promise.resolve(window[l.global]);
    pending[name] ||= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = l.src;
      s.onload = () => resolve(window[l.global]);
      s.onerror = () => { delete pending[name]; s.remove(); reject(new Error(`Could not load the ${l.label}. Check your connection and try again.`)); };
      document.head.append(s);
    });
    return pending[name];
  }

  // ---------- importing media ----------
  const KINDS = {
    video: "mp4 webm mov m4v ogv mkv avi",
    audio: "mp3 wav ogg oga m4a aac flac opus",
    image: "png jpg jpeg jpe jfif gif webp bmp svg avif",
  };
  function kindOf(file) {
    for (const k of ["video", "audio", "image"]) if (file.type.startsWith(k + "/")) return k;
    const ext = extOf(file.name);
    return Object.keys(KINDS).find((k) => KINDS[k].split(" ").includes(ext)) || "";
  }

  function probe(file, kind) {
    const url = URL.createObjectURL(file);
    const m = { id: ++mseq, name: file.name || "file", file, kind, url, duration: 0, w: 0, h: 0, thumb: "", img: null, peaks: null };
    const fail = (rej) => { URL.revokeObjectURL(url); rej(new Error(`${m.name}: this browser can't read that file.`)); };
    if (kind === "image") {
      return new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => { m.img = img; m.w = img.naturalWidth; m.h = img.naturalHeight; m.thumb = url; res(m); };
        img.onerror = () => fail(rej);
        img.src = url;
      });
    }
    return new Promise((res, rej) => {
      const v = document.createElement(kind === "video" ? "video" : "audio");
      v.preload = "metadata"; v.muted = true;
      v.onerror = () => fail(rej);
      v.onloadedmetadata = () => {
        m.duration = v.duration;
        if (!isFinite(m.duration) || m.duration <= 0) return fail(rej);
        if (kind === "audio") { res(m); loadPeaks(m); return; }
        m.w = v.videoWidth; m.h = v.videoHeight;
        let done = false;
        const finish = () => { if (done) return; done = true; res(m); };
        v.onseeked = () => {
          try {
            const c = document.createElement("canvas");
            c.width = 160; c.height = 90;
            const x = c.getContext("2d");
            x.fillStyle = "#000"; x.fillRect(0, 0, 160, 90);
            const k = Math.min(160 / m.w, 90 / m.h);
            x.drawImage(v, (160 - m.w * k) / 2, (90 - m.h * k) / 2, m.w * k, m.h * k);
            m.thumb = c.toDataURL("image/jpeg", 0.6);
          } catch { /* no thumbnail */ }
          finish();
        };
        setTimeout(finish, 3000);
        v.currentTime = Math.min(1, m.duration / 2);
      };
      v.src = url;
    });
  }

  // Waveform peaks (50 per second), decoded in the browser. Skipped for very large files.
  async function loadPeaks(m) {
    if (m.peaks || m.noPeaks || m.busy) return;
    if (m.file.size > 200 * 1048576) { m.noPeaks = true; return; }
    m.busy = true;
    try {
      const buf = await getCtx().decodeAudioData(await m.file.arrayBuffer());
      const per = 50, n = Math.max(1, Math.ceil(buf.duration * per)), peaks = new Float32Array(n);
      const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
      const step = buf.sampleRate / per;
      for (let i = 0; i < n; i++) {
        const a = Math.floor(i * step), b = Math.min(buf.length, Math.floor((i + 1) * step));
        let mx = 0;
        for (const d of chans) for (let j = a; j < b; j += 4) { const v = Math.abs(d[j]); if (v > mx) mx = v; }
        peaks[i] = mx;
      }
      m.peaks = peaks;
      drawWaves();
    } catch { m.noPeaks = true; }
    m.busy = false;
  }

  async function importFiles(list) {
    const skipped = [];
    let n = 0;
    for (const file of list) {
      const kind = kindOf(file);
      if (!kind) { skipped.push(`${file.name} (not a video, audio or image file)`); continue; }
      try { const m = await probe(file, kind); media.set(m.id, m); n++; renderBin(); }
      catch (err) { skipped.push(err.message); }
    }
    say(n ? `Imported ${n} file${n === 1 ? "" : "s"}.${skipped.length ? " Skipped: " + skipped.join("; ") : ""}` : "Nothing imported. " + skipped.join("; "), !n);
  }

  function renderBin() {
    const list = $("#media-list");
    $("#bin-empty").hidden = media.size > 0;
    list.replaceChildren(...[...media.values()].map((m) => {
      const li = el("li", "item");
      li.draggable = true; li.dataset.id = m.id;
      const th = el("span", "thumb " + m.kind);
      if (m.kind === "audio") th.textContent = "♪";
      else if (m.thumb) th.style.backgroundImage = `url("${m.thumb}")`;
      const meta = [m.kind[0].toUpperCase() + m.kind.slice(1)];
      if (m.duration) meta.push(clock(m.duration));
      if (m.w) meta.push(`${m.w}×${m.h}`);
      meta.push(fmtSize(m.file.size));
      const info = el("span", "info");
      info.append(el("span", "iname", m.name), el("span", "imeta", meta.join(" · ")));
      info.title = m.name;
      const add = el("button", "btn small", "+"), rm = el("button", "btn small", "✕");
      add.type = rm.type = "button";
      add.dataset.act = "add"; rm.dataset.act = "remove";
      add.title = add.ariaLabel = "Add to the timeline at the playhead";
      rm.title = rm.ariaLabel = "Remove from the project";
      li.append(th, info, add, rm);
      return li;
    }));
  }

  $("#media-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const m = media.get(+b.closest(".item").dataset.id);
    if (!m) return;
    if (b.dataset.act === "add") edit(() => { selId = addClip(m).id; });
    else removeMedia(m);
  });
  $("#media-list").addEventListener("dblclick", (e) => {
    const li = e.target.closest(".item");
    const m = li && !e.target.closest("button") && media.get(+li.dataset.id);
    if (m) edit(() => { selId = addClip(m).id; });
  });
  $("#media-list").addEventListener("dragstart", (e) => {
    const li = e.target.closest(".item");
    if (!li) return;
    e.dataTransfer.setData("text/x-media", li.dataset.id);
    e.dataTransfer.effectAllowed = "copy";
  });

  function removeMedia(m) {
    const used = tracks.some((t) => t.clips.some((c) => c.mid === m.id));
    if (used && !confirm(`“${m.name}” is used on the timeline. Remove it and its clips? This also clears the undo history.`)) return;
    tracks.forEach((t) => { t.clips = t.clips.filter((c) => c.mid !== m.id); });
    hist.undo.length = hist.redo.length = 0;
    media.delete(m.id);
    URL.revokeObjectURL(m.url);
    renderBin();
    afterChange();
  }

  $("#picker").addEventListener("change", (e) => { const l = [...e.target.files]; e.target.value = ""; importFiles(l); });
  const hasFiles = (e) => e.dataTransfer?.types?.includes("Files");
  document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener("drop", (e) => { if (hasFiles(e)) { e.preventDefault(); importFiles([...e.dataTransfer.files]); } });

  // ---------- adding clips ----------
  function addClip(m, opts = {}) {
    const type = m.kind;                                         // video | audio | image
    const want = type === "audio" ? "audio" : "video";
    const ok = (t) => t.type === want && !t.locked;
    let track = tracks.find((t) => t.id === opts.trackId && ok(t)) || tracks.find((t) => t.id === activeTrack && ok(t)) || tracks.find(ok);
    if (!track) track = addTrack(want);
    const clip = { id: uid(), mid: m.id, type, start: 0, in: 0, dur: type === "image" ? 5 : m.duration, vol: 1 };
    clip.start = fit(track, clip, opts.start ?? playhead);
    track.clips.push(clip);
    return clip;
  }

  // ---------- playback engine ----------
  function makeEl(c, m) {
    const e = document.createElement(m.kind === "audio" ? "audio" : "video");
    e.preload = "auto"; e.playsInline = true; e.src = m.url;
    e.addEventListener("seeked", requestDraw);
    e.addEventListener("loadeddata", requestDraw);
    const ctx = getCtx(), src = ctx.createMediaElementSource(e), gain = ctx.createGain();
    src.connect(gain); gain.connect(master);
    const rec = { el: e, src, gain };
    els.set(c.id, rec);
    return rec;
  }

  // Make every clip's media element match the playhead: play the active ones, pre-seek the ones about to start.
  function syncMedia() {
    const t = playhead, ids = new Set();
    for (const tr of tracks) {
      for (const c of tr.clips) {
        ids.add(c.id);
        const m = media.get(c.mid);
        if (!m || c.type === "image") continue;
        const active = t >= c.start && t < end(c);
        const near = !active && c.start > t && c.start - t < 1.5;
        let rec = els.get(c.id);
        if (!rec) { if (!(active || near)) continue; rec = makeEl(c, m); }
        rec.gain.gain.value = tr.muted ? 0 : c.vol;
        const e = rec.el, target = c.in + Math.max(0, t - c.start);
        if (active) {
          if (playing) {
            if (e.paused) { if (Math.abs(e.currentTime - target) > 0.05) e.currentTime = target; e.play().catch(() => {}); }
            else if (Math.abs(e.currentTime - target) > 0.3) e.currentTime = target;
          } else {
            if (!e.paused) e.pause();
            if (Math.abs(e.currentTime - target) > 0.02) e.currentTime = target;
          }
        } else {
          if (!e.paused) e.pause();
          if (near && Math.abs(e.currentTime - c.in) > 0.05) e.currentTime = c.in;
        }
      }
    }
    for (const [id, rec] of els) {
      if (ids.has(id)) continue;
      rec.el.pause(); rec.el.removeAttribute("src"); rec.el.load();
      rec.src.disconnect(); rec.gain.disconnect();
      els.delete(id);
    }
  }
  function applyGains() {
    for (const tr of tracks) for (const c of tr.clips) { const r = els.get(c.id); if (r) r.gain.gain.value = tr.muted ? 0 : c.vol; }
  }

  const cv = $("#screen"), c2 = cv.getContext("2d");
  function drawFrame() {
    c2.fillStyle = "#000";
    c2.fillRect(0, 0, cv.width, cv.height);
    for (let i = tracks.length - 1; i >= 0; i--) {                    // bottom video track first, top one last
      const tr = tracks[i];
      if (tr.type !== "video" || tr.hidden) continue;
      for (const c of tr.clips) {
        if (playhead < c.start || playhead >= end(c)) continue;
        const m = media.get(c.mid);
        if (!m) continue;
        let src, sw, sh;
        if (c.type === "image") { src = m.img; sw = m.w; sh = m.h; }
        else {
          src = els.get(c.id)?.el;
          if (!src || src.readyState < 2) continue;
          sw = src.videoWidth; sh = src.videoHeight;
        }
        if (!src || !sw || !sh) continue;
        const k = Math.min(cv.width / sw, cv.height / sh);
        c2.drawImage(src, (cv.width - sw * k) / 2, (cv.height - sh * k) / 2, sw * k, sh * k);
      }
    }
  }
  let drawQueued = false;
  function requestDraw() { if (drawQueued) return; drawQueued = true; requestAnimationFrame(() => { drawQueued = false; drawFrame(); }); }

  function tick() {
    if (!playing) return;
    const endT = projectEnd();
    playhead = base + (performance.now() - t0) / 1000;
    if (playhead >= endT) { playhead = endT; syncMedia(); drawFrame(); positionPlayhead(); pause(); return; }
    syncMedia();
    drawFrame();
    positionPlayhead();
    const lx = playhead * pps, vw = tlScroll.clientWidth - HEAD_W;
    if (lx > tlScroll.scrollLeft + vw - 20 || lx < tlScroll.scrollLeft) tlScroll.scrollLeft = Math.max(0, lx - 40);
    updateTransport();
    raf = requestAnimationFrame(tick);
  }
  function play() {
    if (playing) return;
    const endT = projectEnd();
    if (!endT) return say("Add a clip to the timeline first.", true);
    if (playhead >= endT - 0.02) playhead = 0;
    getCtx().resume?.();
    playing = true; base = playhead; t0 = performance.now();
    raf = requestAnimationFrame(tick);
    updateTransport();
  }
  function pause() {
    if (!playing) { updateTransport(); return; }
    playing = false;
    cancelAnimationFrame(raf);
    els.forEach((r) => r.el.pause());
    updateTransport();
    drawFrame();
  }
  function seek(t) {
    playhead = Math.max(0, t);
    if (playing) { base = playhead; t0 = performance.now(); }
    syncMedia(); drawFrame(); positionPlayhead(); updateTransport();
  }

  function updateTransport() {
    $("#tc").textContent = tc(playhead);
    $("#tc-total").textContent = "/ " + tc(projectEnd());
    $("#t-play").textContent = playing ? "❚❚" : "▶";
    const none = !projectEnd();
    $("#t-play").disabled = none;
    $("#export").disabled = none;
    $("#undo").disabled = !hist.undo.length;
    $("#redo").disabled = !hist.redo.length;
    const sel = !!selId;
    $("#b-dup").disabled = $("#b-delete").disabled = $("#b-ripple").disabled = !sel;
    $("#b-split").disabled = none;
    $("#z-label").textContent = Math.round(pps) + " px/s";
  }
  $("#t-play").addEventListener("click", () => (playing ? pause() : play()));
  $("#t-start").addEventListener("click", () => seek(0));
  $("#t-end").addEventListener("click", () => seek(projectEnd()));
  $("#t-back").addEventListener("click", () => seek(playhead - 1 / proj.fps));
  $("#t-fwd").addEventListener("click", () => seek(playhead + 1 / proj.fps));
  $("#undo").addEventListener("click", undo);
  $("#redo").addEventListener("click", redo);

  $("#res").addEventListener("change", (e) => {
    const [w, h] = e.target.value.split("x").map(Number);
    proj.w = w; proj.h = h; cv.width = w; cv.height = h;
    drawFrame();
  });
  $("#fps").addEventListener("change", (e) => { proj.fps = +e.target.value; updateTransport(); });

  // ---------- timeline rendering ----------
  const tlScroll = $("#tl-scroll"), content = $("#tl-content"), rulerLane = $("#ruler"), trackList = $("#track-list"), playheadEl = $("#playhead");
  const positionPlayhead = () => { playheadEl.style.left = HEAD_W + playhead * pps + "px"; };
  const timeAt = (x) => Math.max(0, (x - rulerLane.getBoundingClientRect().left) / pps);

  function renderRuler(w) {
    rulerLane.style.width = w + "px";
    const steps = [[0.1, 5], [0.2, 4], [0.5, 5], [1, 5], [2, 4], [5, 5], [10, 5], [15, 5], [30, 6], [60, 6], [120, 4], [300, 5], [600, 5], [1800, 6], [3600, 6]];
    const [step, div] = steps.find(([s]) => s * pps >= 90) || steps[steps.length - 1];
    rulerLane.style.setProperty("--minor", (step / div) * pps + "px");
    const frag = document.createDocumentFragment();
    for (let i = 0; i * step * pps < w; i++) {
      const t = i * step, tick = el("span", "tick", step < 1 ? t.toFixed(1) + "s" : clock(t));
      tick.style.left = t * pps + "px";
      frag.append(tick);
    }
    rulerLane.replaceChildren(frag);
  }

  function trackRow(tr, w) {
    const row = el("div", `trow ${tr.type}${tr.id === activeTrack ? " active" : ""}${tr.muted ? " muted" : ""}${tr.hidden ? " hidden" : ""}${tr.locked ? " locked" : ""}`);
    row.dataset.tid = tr.id;
    const head = el("div", "thead"), name = el("span", "tname", tr.name), btns = el("span", "tbtns");
    name.title = "Double-click to rename";
    const b = (act, label, title, on) => {
      const x = el("button", "tbtn" + (on ? " on" : ""), label);
      x.type = "button"; x.dataset.act = act; x.title = x.ariaLabel = title;
      if (on !== undefined) x.setAttribute("aria-pressed", String(!!on));
      return x;
    };
    btns.append(b("mute", "M", "Mute track", tr.muted));
    if (tr.type === "video") btns.append(b("hide", "H", "Hide track in the preview", tr.hidden));
    btns.append(b("lock", "L", "Lock track", tr.locked), b("del", "✕", "Delete track"));
    head.append(name, btns);
    const lane = el("div", "lane");
    lane.style.width = w + "px";
    tr.clips.forEach((c) => lane.append(clipEl(c)));
    row.append(head, lane);
    return row;
  }

  function layoutClip(d, c) { d.style.left = c.start * pps + "px"; d.style.width = Math.max(2, c.dur * pps) + "px"; }
  function clipEl(c) {
    const m = media.get(c.mid);
    const d = el("div", `clip ${c.type}${c.id === selId ? " sel" : ""}`);
    d.dataset.id = c.id;
    layoutClip(d, c);
    if (c.type !== "audio" && m?.thumb) d.style.backgroundImage = `url("${m.thumb}")`;
    if (c.type === "audio") d.append(el("canvas", "wave"));
    d.append(el("span", "clabel", m ? m.name : "(missing file)"), el("i", "h l"), el("i", "h r"));
    d.title = m ? m.name : "";
    return d;
  }

  function drawWave(d, c) {
    const cvs = d.querySelector("canvas.wave");
    if (!cvs) return;
    const m = media.get(c.mid);
    if (m && !m.peaks && !m.noPeaks) loadPeaks(m);
    cvs.width = clamp(Math.round(c.dur * pps), 1, 8000);
    cvs.height = 40;
    if (!m || !m.peaks) return;
    const x = cvs.getContext("2d"), per = 50, H = cvs.height;
    x.fillStyle = "rgba(255,255,255,.75)";
    for (let i = 0; i < cvs.width; i++) {
      const a = Math.floor((c.in + (i / cvs.width) * c.dur) * per), b = Math.max(a + 1, Math.ceil((c.in + ((i + 1) / cvs.width) * c.dur) * per));
      let mx = 0;
      for (let j = a; j < b && j < m.peaks.length; j++) if (m.peaks[j] > mx) mx = m.peaks[j];
      const h = Math.max(1, mx * H * 0.95);
      x.fillRect(i, (H - h) / 2, 1, h);
    }
  }
  function drawWaves() {
    trackList.querySelectorAll(".clip.audio").forEach((d) => { const f = findClip(+d.dataset.id); if (f) drawWave(d, f.clip); });
  }

  function renderTimeline() {
    const w = Math.max(tlScroll.clientWidth - HEAD_W, (projectEnd() + 30) * pps);
    content.style.width = HEAD_W + w + "px";
    renderRuler(w);
    trackList.replaceChildren(...tracks.map((t) => trackRow(t, w)));
    positionPlayhead();
    drawWaves();
    updateTransport();
  }

  function selectClip(id) {
    selId = id;
    trackList.querySelectorAll(".clip").forEach((d) => d.classList.toggle("sel", +d.dataset.id === id));
    renderInspector();
    updateTransport();
  }

  // ---------- timeline interaction ----------
  rulerLane.addEventListener("pointerdown", (e) => {
    if (exporting) return;
    rulerLane.setPointerCapture(e.pointerId);
    const move = (ev) => seek(timeAt(ev.clientX));
    const up = () => { rulerLane.removeEventListener("pointermove", move); rulerLane.removeEventListener("pointerup", up); rulerLane.removeEventListener("pointercancel", up); };
    rulerLane.addEventListener("pointermove", move);
    rulerLane.addEventListener("pointerup", up);
    rulerLane.addEventListener("pointercancel", up);
    move(e);
  });

  const rowAt = (y) => [...trackList.children].find((r) => { const b = r.getBoundingClientRect(); return y >= b.top && y < b.bottom; });
  const clearTargets = () => trackList.querySelectorAll(".trow.target, .trow.bad").forEach((r) => r.classList.remove("target", "bad"));

  trackList.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || exporting) return;
    const d = e.target.closest(".clip");
    if (d) return startDrag(e, d, e.target.closest(".h") ? (e.target.classList.contains("l") ? "l" : "r") : "move");
    if (e.target.closest(".lane")) selectClip(null);
  });

  function startDrag(e, d, mode) {
    const id = +d.dataset.id, f = findClip(id);
    if (!f) return;
    selectClip(id);
    if (f.track.locked) return;
    e.preventDefault();
    const { clip, track } = f, m = media.get(clip.mid);
    const before = JSON.stringify(tracks);
    const o = { start: clip.start, in: clip.in, dur: clip.dur };
    const x0 = e.clientX, y0 = e.clientY;
    const maxDur = clip.type === "image" ? Infinity : m ? m.duration : clip.in + clip.dur;
    const others = track.clips.filter((c) => c.id !== clip.id);
    const prevEnd = Math.max(0, ...others.filter((c) => end(c) <= o.start + 1e-6).map(end));
    const nextStart = Math.min(Infinity, ...others.filter((c) => c.start >= o.start + o.dur - 1e-6).map((c) => c.start));
    const points = [0, playhead, ...tracks.flatMap((t) => t.clips).filter((c) => c.id !== clip.id).flatMap((c) => [c.start, end(c)])];
    const snapDelta = (edges) => {
      if (!snapOn) return 0;
      let best = 0, bd = 8 / pps;
      for (const ed of edges) for (const p of points) { const dd = p - ed; if (Math.abs(dd) < bd) { bd = Math.abs(dd); best = dd; } }
      return best;
    };
    let moved = false, dest = track;
    d.setPointerCapture(e.pointerId);
    d.classList.add("drag");

    const onMove = (ev) => {
      moved = true;
      const dt = (ev.clientX - x0) / pps;
      if (mode === "move") {
        let s = Math.max(0, o.start + dt);
        s = Math.max(0, s + snapDelta([s, s + o.dur]));
        clip.start = s;
        layoutClip(d, clip);
        d.style.transform = `translateY(${ev.clientY - y0}px)`;
        clearTargets();
        const row = rowAt(ev.clientY);
        if (row) {
          const t2 = tracks.find((t) => t.id === +row.dataset.tid), ok = t2 && canHost(t2, clip) && !t2.locked;
          row.classList.add(ok ? "target" : "bad");
          dest = ok ? t2 : track;
        }
      } else if (mode === "l") {
        let s = o.start + dt;
        s += snapDelta([s]);
        const lo = Math.max(prevEnd, clip.type === "image" ? 0 : o.start - o.in);
        s = clamp(s, lo, o.start + o.dur - MIN_DUR);
        clip.start = s;
        clip.dur = o.dur - (s - o.start);
        clip.in = clip.type === "image" ? 0 : o.in + (s - o.start);
        layoutClip(d, clip); drawWave(d, clip);
      } else {
        let e2 = o.start + o.dur + dt;
        e2 += snapDelta([e2]);
        const hi = Math.min(nextStart, o.start + (maxDur - o.in));
        e2 = clamp(e2, o.start + MIN_DUR, hi);
        clip.dur = e2 - o.start;
        layoutClip(d, clip); drawWave(d, clip);
      }
    };
    const onUp = () => {
      d.removeEventListener("pointermove", onMove);
      d.removeEventListener("pointerup", onUp);
      d.removeEventListener("pointercancel", onUp);
      d.classList.remove("drag");
      d.style.transform = "";
      clearTargets();
      if (!moved) return;
      if (mode === "move") {
        if (dest !== track) { track.clips = track.clips.filter((c) => c !== clip); dest.clips.push(clip); }
        clip.start = fit(dest, clip, clip.start);
      }
      if (JSON.stringify(tracks) !== before) { hist.undo.push(before); hist.redo.length = 0; }
      afterChange();
    };
    d.addEventListener("pointermove", onMove);
    d.addEventListener("pointerup", onUp);
    d.addEventListener("pointercancel", onUp);
  }

  // Dragging from the media bin onto a track.
  trackList.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("text/x-media")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    clearTargets();
    rowAt(e.clientY)?.classList.add("target");
  });
  trackList.addEventListener("dragleave", (e) => { if (!trackList.contains(e.relatedTarget)) clearTargets(); });
  trackList.addEventListener("drop", (e) => {
    const m = media.get(+e.dataTransfer.getData("text/x-media"));
    if (!m) return;
    e.preventDefault();
    clearTargets();
    const row = rowAt(e.clientY), start = timeAt(e.clientX);
    edit(() => { selId = addClip(m, { trackId: row ? +row.dataset.tid : undefined, start }).id; });
  });

  // Track headers.
  trackList.addEventListener("click", (e) => {
    const row = e.target.closest(".trow"), tr = row && tracks.find((t) => t.id === +row.dataset.tid);
    if (!tr) return;
    const b = e.target.closest(".tbtn");
    if (b) {
      const act = b.dataset.act;
      if (act === "del") {
        if (tr.clips.length && !confirm(`Delete “${tr.name}” and its ${tr.clips.length} clip(s)?`)) return;
        edit(() => { tracks = tracks.filter((t) => t !== tr); });
      } else edit(() => { tr[{ mute: "muted", hide: "hidden", lock: "locked" }[act]] ^= true; });
    } else if (e.target.closest(".thead")) {
      activeTrack = tr.id;
      trackList.querySelectorAll(".trow").forEach((r) => r.classList.toggle("active", +r.dataset.tid === tr.id));
    }
  });
  trackList.addEventListener("dblclick", (e) => {
    const n = e.target.closest(".tname");
    if (!n) return;
    const tr = tracks.find((t) => t.id === +n.closest(".trow").dataset.tid), name = tr && prompt("Track name:", tr.name);
    if (name && name.trim()) edit(() => { tr.name = name.trim().slice(0, 24); });
  });

  // ---------- editing actions ----------
  function doSplit() {
    const here = (c) => playhead > c.start + 0.05 && playhead < end(c) - 0.05;
    const f = selId && findClip(selId);
    const targets = (f ? [f] : tracks.flatMap((track) => track.clips.map((clip) => ({ clip, track })))).filter(({ clip, track }) => !track.locked && here(clip));
    if (!targets.length) return say("Move the playhead over a clip to split it.", true);
    edit(() => {
      for (const { clip, track } of targets) {
        const b = { ...clip, id: uid(), start: playhead, in: clip.type === "image" ? 0 : clip.in + (playhead - clip.start), dur: end(clip) - playhead };
        clip.dur = playhead - clip.start;
        track.clips.push(b);
      }
    });
    say("Split.");
  }
  function doDelete(ripple) {
    const f = selId && findClip(selId);
    if (!f || f.track.locked) return;
    edit(() => {
      const { clip, track } = f;
      track.clips = track.clips.filter((c) => c !== clip);
      if (ripple) track.clips.forEach((c) => { if (c.start >= clip.start - 1e-6) c.start -= clip.dur; });
      selId = null;
    });
  }
  function doDuplicate() {
    const f = selId && findClip(selId);
    if (!f || f.track.locked) return;
    edit(() => {
      const copy = { ...f.clip, id: uid() };
      copy.start = fit(f.track, copy, end(f.clip));
      f.track.clips.push(copy);
      selId = copy.id;
    });
  }
  function doDetach() {
    const f = selId && findClip(selId);
    if (!f || f.clip.type !== "video") return;
    edit(() => {
      const { clip } = f, a = { id: uid(), mid: clip.mid, type: "audio", start: clip.start, in: clip.in, dur: clip.dur, vol: clip.vol || 1 };
      let tr = tracks.find((t) => t.type === "audio" && !t.locked && isFree(t, a.start, a.dur));
      if (!tr) tr = addTrack("audio");
      tr.clips.push(a);
      clip.vol = 0;
      selId = a.id;
    });
    say("The sound now sits on its own audio track.");
  }
  $("#b-split").addEventListener("click", doSplit);
  $("#b-dup").addEventListener("click", doDuplicate);
  $("#b-delete").addEventListener("click", () => doDelete(false));
  $("#b-ripple").addEventListener("click", () => doDelete(true));
  $("#b-addv").addEventListener("click", () => edit(() => addTrack("video")));
  $("#b-adda").addEventListener("click", () => edit(() => addTrack("audio")));
  $("#snap").addEventListener("change", (e) => { snapOn = e.target.checked; });

  // ---------- zoom ----------
  function setZoom(v, anchorX) {
    const old = pps, lane = rulerLane.getBoundingClientRect();
    const x = anchorX ?? lane.left + playhead * old, t = (x - lane.left) / old;
    pps = clamp(v, 4, 600);
    renderTimeline();
    tlScroll.scrollLeft += t * pps - t * old;
  }
  $("#z-in").addEventListener("click", () => setZoom(pps * 1.25));
  $("#z-out").addEventListener("click", () => setZoom(pps / 1.25));
  $("#z-fit").addEventListener("click", () => { pps = clamp((tlScroll.clientWidth - HEAD_W - 40) / Math.max(projectEnd(), 5), 4, 600); renderTimeline(); tlScroll.scrollLeft = 0; });
  tlScroll.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setZoom(pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX);
  }, { passive: false });
  new ResizeObserver(() => { if (!exporting) renderTimeline(); }).observe(tlScroll);

  // Resizable timeline.
  $("#split").addEventListener("pointerdown", (e) => {
    const s = $("#split"), page = $("#editor"), y0 = e.clientY, h0 = $(".timeline").getBoundingClientRect().height;
    s.setPointerCapture(e.pointerId);
    const move = (ev) => page.style.setProperty("--tl-h", clamp(h0 - (ev.clientY - y0), 150, innerHeight * 0.7) + "px");
    const up = () => { s.removeEventListener("pointermove", move); s.removeEventListener("pointerup", up); s.removeEventListener("pointercancel", up); };
    s.addEventListener("pointermove", move);
    s.addEventListener("pointerup", up);
    s.addEventListener("pointercancel", up);
  });

  // ---------- inspector ----------
  function helpNode() {
    const box = el("div", "help");
    box.append(el("h3", "", "Select a clip to edit it"));
    const dl = el("dl");
    [["Space", "Play / pause"], ["S", "Split at the playhead"], ["Delete", "Delete the selected clip"], ["Shift+Delete", "Delete and close the gap"],
     ["Ctrl+D", "Duplicate"], ["Ctrl+Z / Y", "Undo / redo"], ["← →", "Step one frame (Shift: 1 s)"], ["Home / End", "Jump to start / end"],
     ["Ctrl+wheel", "Zoom the timeline"], ["Drag edges", "Trim a clip"]].forEach(([k, v]) => dl.append(el("dt", "", k), el("dd", "", v)));
    box.append(dl);
    return box;
  }

  function renderInspector() {
    const box = $("#insp"), f = selId ? findClip(selId) : null;
    if (!f) return box.replaceChildren(helpNode());
    const { clip, track } = f, m = media.get(clip.mid), wrap = el("div");
    wrap.append(el("p", "insp-name", m ? m.name : "(missing file)"), el("p", "hint insp-sub", `${track.name} · ${clip.type}`));
    const grid = el("div", "insp-grid");
    for (const [label, key, min] of [["Start on timeline (s)", "start", 0], ["Start in source (s)", "in", 0], ["Length (s)", "dur", MIN_DUR]]) {
      const w = el("label", "field", label), i = el("input");
      i.type = "number"; i.step = "0.01"; i.min = min; i.value = +clip[key].toFixed(3); i.dataset.k = key;
      if (key === "in" && clip.type === "image") i.disabled = true;
      w.append(i); grid.append(w);
    }
    if (clip.type !== "image") {
      const w = el("label", "field", "Volume"), row = el("div", "vol-row"), r = el("input"), out = el("output", "", Math.round(clip.vol * 100) + "%");
      r.type = "range"; r.min = 0; r.max = 200; r.value = Math.round(clip.vol * 100); r.dataset.vol = "1";
      row.append(r, out); w.append(row); grid.append(w);
    }
    const acts = el("div", "insp-actions");
    const btn = (act, label) => { const b = el("button", "btn small", label); b.type = "button"; b.dataset.act = act; return b; };
    acts.append(btn("split", "Split at playhead"), btn("dup", "Duplicate"));
    if (clip.type === "video" && m?.kind === "video") acts.append(btn("detach", "Detach audio"));
    acts.append(btn("del", "Delete"), btn("ripple", "Ripple delete"));
    wrap.append(grid, acts);
    box.replaceChildren(wrap);
  }

  function setProp(clip, track, key, v) {
    const m = media.get(clip.mid);
    let { start, in: inn, dur } = clip;
    if (!isFinite(v)) return renderInspector();
    if (key === "start") start = Math.max(0, v);
    if (key === "in") inn = Math.max(0, v);
    if (key === "dur") dur = Math.max(MIN_DUR, v);
    if (clip.type === "image") inn = 0;
    else if (m) { inn = Math.min(inn, m.duration - MIN_DUR); dur = Math.min(dur, m.duration - inn); }
    if (!isFree(track, start, dur, clip.id)) { say("That would overlap another clip on the same track.", true); return renderInspector(); }
    edit(() => { clip.start = start; clip.in = inn; clip.dur = dur; });
  }
  let volSnap = false;
  $("#insp").addEventListener("change", (e) => {
    if (e.target.dataset.vol) { volSnap = false; return; }
    const k = e.target.dataset.k, f = selId && findClip(selId);
    if (k && f && !f.track.locked) setProp(f.clip, f.track, k, parseFloat(e.target.value));
  });
  $("#insp").addEventListener("input", (e) => {
    if (!e.target.dataset.vol) return;
    const f = selId && findClip(selId);
    if (!f) return;
    if (!volSnap) { pushHistory(); volSnap = true; }
    f.clip.vol = e.target.value / 100;
    e.target.nextElementSibling.textContent = e.target.value + "%";
    applyGains();
    updateTransport();
  });
  $("#insp").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    ({ split: doSplit, dup: doDuplicate, detach: doDetach, del: () => doDelete(false), ripple: () => doDelete(true) })[b.dataset.act]();
  });

  // ---------- keyboard ----------
  document.addEventListener("keydown", (e) => {
    if (exporting || $("#exp").open || e.target.closest("input, select, textarea")) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (e.target.closest("button") && (k === " " || k === "enter")) return;
    if (mod && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && k === "y") { e.preventDefault(); redo(); }
    else if (mod && k === "d") { e.preventDefault(); doDuplicate(); }
    else if (mod || e.altKey) return;
    else if (k === " ") { e.preventDefault(); playing ? pause() : play(); }
    else if (k === "s") doSplit();
    else if (k === "delete" || k === "backspace") { e.preventDefault(); doDelete(e.shiftKey); }
    else if (k === "arrowleft" || k === "arrowright") { e.preventDefault(); seek(playhead + (k === "arrowleft" ? -1 : 1) * (e.shiftKey ? 1 : 1 / proj.fps)); }
    else if (k === "home") seek(0);
    else if (k === "end") seek(projectEnd());
    else if (k === "+" || k === "=") setZoom(pps * 1.25);
    else if (k === "-") setZoom(pps / 1.25);
  });
  window.addEventListener("beforeunload", (e) => { if (tracks.some((t) => t.clips.length)) { e.preventDefault(); e.returnValue = ""; } });

  // ---------- export ----------
  const FORMATS = [
    { id: "mp4", label: "MP4 (H.264 + AAC)", video: true },
    { id: "webm", label: "WebM (VP9 + Opus)", video: true },
    { id: "mov", label: "MOV (QuickTime)", video: true, server: true },
    { id: "mkv", label: "MKV (Matroska)", video: true, server: true },
    { id: "avi", label: "AVI", video: true, server: true },
    { id: "gif", label: "Animated GIF (no sound)", video: true, server: true },
    { id: "mp3", label: "MP3" },
    { id: "wav", label: "WAV (lossless)" },
    { id: "m4a", label: "M4A / AAC", server: true },
    { id: "ogg", label: "OGG Vorbis", server: true },
    { id: "flac", label: "FLAC (lossless)", server: true },
  ];
  const useServer = () => window.Options.server();

  function recMime(id) {
    if (typeof MediaRecorder === "undefined") return "";
    const list = id === "mp4"
      ? ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4"]
      : ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    return list.find((t) => MediaRecorder.isTypeSupported(t)) || "";
  }

  function fillFormats() {
    const sel = $("#ex-fmt"), keep = sel.value, server = useServer();
    sel.replaceChildren();
    for (const [label, isVideo] of [["Video", true], ["Audio only", false]]) {
      const g = document.createElement("optgroup");
      g.label = label;
      for (const f of FORMATS.filter((x) => !!x.video === isVideo)) {
        const ok = server || (!f.server && (!f.video || recMime(f.id)));
        const o = new Option(f.label + (ok ? "" : f.server ? " (needs server processing)" : " (not supported by this browser)"), f.id);
        o.disabled = !ok;
        g.append(o);
      }
      sel.append(g);
    }
    const opts = [...sel.options];
    const pick = opts.find((o) => !o.disabled && o.value === keep) || opts.find((o) => !o.disabled);
    if (pick) sel.value = pick.value;
    $("#ex-note").textContent = server
      ? "The server renders the project with ffmpeg and every format is available. Your files are uploaded for this render and deleted afterwards."
      : "Video is recorded in real time while the timeline plays (a 2-minute project takes about 2 minutes), so keep this tab open and visible. Audio formats are mixed instantly.";
    $("#ex-switch").hidden = server;
  }

  const xs = (text, error) => { const s = $("#ex-status"); s.textContent = text; s.classList.toggle("error", !!error); };
  const xp = (frac) => { const b = $("#ex-bar"); b.hidden = false; if (frac == null) b.removeAttribute("value"); else b.value = Math.round(clamp(frac, 0, 1) * 100); };
  function busy(on) {
    exporting = on;
    ["#ex-go", "#ex-fmt", "#ex-q", "#ex-name", "#ex-switch"].forEach((s) => { $(s).disabled = on; });
    $("#ex-cancel").textContent = on ? (useServer() ? "Working…" : "Cancel export") : "Close";
    $("#ex-cancel").disabled = on && useServer();
  }

  $("#export").addEventListener("click", () => {
    pause();
    fillFormats();
    xs(""); $("#ex-bar").hidden = true;
    $("#exp").showModal();
  });
  $("#ex-switch").addEventListener("click", () => window.Options.set({ process: "server" }));
  $("#ex-cancel").addEventListener("click", () => { if (exporting) { cancelExport = true; pause(); } else $("#exp").close(); });
  $("#exp").addEventListener("cancel", (e) => { if (exporting) e.preventDefault(); });
  document.addEventListener("optionschange", () => { if ($("#exp").open && !exporting) fillFormats(); });

  function save(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  $("#ex-go").addEventListener("click", async () => {
    const f = FORMATS.find((x) => x.id === $("#ex-fmt").value), q = $("#ex-q").value;
    const name = ($("#ex-name").value.trim() || "video").replace(/[\\/:*?"<>|]/g, "_");
    if (!f || !projectEnd()) return;
    cancelExport = false;
    busy(true);
    try {
      const blob = useServer() ? await exportServer(f, q) : f.video ? await exportRecorder(f, q) : await exportAudio(f, q);
      if (blob) { save(blob, `${name}.${f.id}`); xp(1); xs(`Saved ${name}.${f.id} (${fmtSize(blob.size)}).`); }
      else xs("Export cancelled.");
    } catch (err) {
      xs(err.message || String(err), true);
    } finally {
      busy(false);
      seek(0);
    }
  });

  // Server: upload the used files plus the timeline layout; ffmpeg renders it (processing/video.py).
  async function exportServer(f, q) {
    const used = [...new Set(tracks.flatMap((t) => t.clips.map((c) => c.mid)))].filter((id) => media.has(id));
    const index = new Map(used.map((id, i) => [id, i]));
    const fd = new FormData();
    used.forEach((id, i) => fd.append("file" + i, media.get(id).file, media.get(id).name));
    fd.append("state", JSON.stringify({
      width: proj.w, height: proj.h, fps: proj.fps, format: f.id, quality: q,
      tracks: tracks.map((t) => ({
        type: t.type, muted: t.muted, hidden: t.hidden,
        clips: t.clips.filter((c) => index.has(c.mid)).map((c) => ({ file: index.get(c.mid), type: c.type, start: c.start, in: c.in, dur: c.dur, vol: c.vol })),
      })),
    }));
    xp(null);
    xs("Uploading and rendering on the server. Long projects can take a while…");
    return window.Options.blob("/api/video/render", fd);
  }

  // Browser, video: play the timeline into a MediaRecorder (canvas + mixed audio).
  async function exportRecorder(f, q) {
    const mime = recMime(f.id);
    if (!mime) throw new Error("This browser can't record that format. Pick another one.");
    const ctx = getCtx();
    await ctx.resume();
    const dest = ctx.createMediaStreamDestination();
    master.disconnect();
    master.connect(dest);                                   // silent while exporting
    const stream = new MediaStream([...cv.captureStream(proj.fps).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    try {
      const bpp = { high: 0.15, medium: 0.09, low: 0.05 }[q] || 0.09;
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.round(proj.w * proj.h * proj.fps * bpp), audioBitsPerSecond: 192000 });
      const chunks = [], stopped = new Promise((r) => { rec.onstop = r; });
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      seek(0);
      xs("Getting ready…"); xp(0);
      await sleep(500);
      rec.start(500);
      play();
      const endT = projectEnd();
      while (playing && !cancelExport) { xp(playhead / endT); xs(`Recording ${tc(playhead)} of ${tc(endT)}. Keep this tab visible.`); await sleep(150); }
      await sleep(300);
      if (rec.state !== "inactive") rec.stop();
      await stopped;
      return cancelExport ? null : new Blob(chunks, { type: mime.split(";")[0] });
    } finally {
      pause();
      stream.getTracks().forEach((t) => t.stop());
      master.disconnect();
      master.connect(ctx.destination);
    }
  }

  // Browser, audio: mix every clip offline, then write WAV or encode MP3.
  async function exportAudio(f, q) {
    const sr = 44100, dur = projectEnd();
    xp(null); xs("Mixing audio…");
    const off = new OfflineAudioContext(2, Math.ceil(dur * sr), sr), cache = new Map();
    let any = false;
    for (const tr of tracks) {
      if (tr.muted) continue;
      for (const c of tr.clips) {
        const m = media.get(c.mid);
        if (!m || c.type === "image" || c.vol <= 0) continue;
        let buf = cache.get(m.id);
        if (buf === undefined) {
          try { buf = await off.decodeAudioData(await m.file.arrayBuffer()); } catch { buf = null; }
          cache.set(m.id, buf);
        }
        if (!buf) continue;
        const s = off.createBufferSource(), g = off.createGain();
        s.buffer = buf; g.gain.value = c.vol;
        s.connect(g).connect(off.destination);
        s.start(c.start, Math.min(c.in, buf.duration), c.dur);
        any = true;
      }
    }
    if (!any) throw new Error("There is no audio to export. Add an audio clip or a video with sound.");
    const out = await off.startRendering();
    return f.id === "wav" ? wavBlob(out) : mp3Blob(out, { high: 256, medium: 192, low: 128 }[q] || 192);
  }

  function wavBlob(buf) {
    const ch = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate, bytes = n * ch * 2;
    const ab = new ArrayBuffer(44 + bytes), v = new DataView(ab);
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, "RIFF"); v.setUint32(4, 36 + bytes, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, bytes, true);
    const data = Array.from({ length: ch }, (_, i) => buf.getChannelData(i));
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const x = clamp(data[c][i], -1, 1); v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true); o += 2; }
    return new Blob([ab], { type: "audio/wav" });
  }

  async function mp3Blob(buf, kbps) {
    const lj = await lib("lame");
    const enc = new lj.Mp3Encoder(2, buf.sampleRate, kbps);
    const toInt = (f32) => { const o = new Int16Array(f32.length); for (let i = 0; i < f32.length; i++) { const x = clamp(f32[i], -1, 1); o[i] = x < 0 ? x * 0x8000 : x * 0x7fff; } return o; };
    const L = toInt(buf.getChannelData(0)), R = toInt(buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0));
    const parts = [], block = 1152 * 10;
    const keep = (d) => { if (d.length) parts.push(new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))); };
    for (let i = 0, k = 0; i < L.length; i += block, k++) {
      keep(enc.encodeBuffer(L.subarray(i, i + block), R.subarray(i, i + block)));
      if (k % 20 === 0) { xp(i / L.length); xs("Encoding MP3…"); await sleep(0); }
    }
    keep(enc.flush());
    return new Blob(parts, { type: "audio/mpeg" });
  }

  // ---------- start ----------
  addTrack("video"); addTrack("audio"); addTrack("audio");
  renderBin();
  renderTimeline();
  renderInspector();
  drawFrame();
  updateTransport();
})();
