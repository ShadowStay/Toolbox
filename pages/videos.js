// Page script for pages/videos.html: library, full-window player and precaching. Server side: processing/videos.py
// (list, Range streaming, posters). Precaching: the first PRE.head bytes of a video (plus its "moov" index when that is at the
// end of the file) are fetched with Range requests into the Cache API ("video-pre"); shared/sw.js answers the player's range
// requests from there. Resume positions and settings live in localStorage.
(function () {
  const $ = (s) => document.querySelector(s);
  const root = document.documentElement;
  const API = "/api/videos", MB = 1048576;
  const url = (id) => `${API}/file/${id}`;
  const NATIVE = new Set(["mp4", "m4v", "mov", "webm"]);          // formats a browser usually plays as they are; the rest is converted
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const store = {
    get: (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const fmtSize = (n) => (n < MB ? Math.round(n / 1024) + " KB" : n < 1024 * MB ? (n / MB).toFixed(0) + " MB" : (n / 1024 / MB).toFixed(1) + " GB");
  const fmtTime = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`;
  };
  const status = $("#status");
  const say = (t, err) => { status.textContent = t || ""; status.classList.toggle("error", !!err); };

  // ---------- settings and TV mode ----------
  const settings = Object.assign({ pre: true, auto: true, tv: null }, store.get("vid-settings", {}));
  const saveSettings = () => store.set("vid-settings", settings);
  const autoTv = /SMART-?TV|Tizen|Web0S|WebOS|NetCast|AFT[A-Z]|Android TV|GoogleTV|BRAVIA|CrKey|HbbTV|VIDAA|Roku|Hisense|PHILIPSTV|Viera/i.test(navigator.userAgent) || /[?&]tv=1/.test(location.search);
  const isTv = () => (settings.tv === null ? autoTv : settings.tv);
  function paintSettings() {
    root.classList.toggle("tv", isTv());
    $("#opt-pre").setAttribute("aria-pressed", String(settings.pre));
    $("#opt-pre").textContent = "Precache: " + (settings.pre ? "on" : "off");
    $("#opt-auto").setAttribute("aria-pressed", String(settings.auto));
    $("#opt-auto").textContent = "Autoplay next: " + (settings.auto ? "on" : "off");
    $("#opt-tv").setAttribute("aria-pressed", String(isTv()));
    $("#opt-tv").textContent = "TV mode: " + (settings.tv === null ? `auto (${autoTv ? "on" : "off"})` : settings.tv ? "on" : "off");
  }
  $("#opt-pre").addEventListener("click", () => { settings.pre = !settings.pre; saveSettings(); paintSettings(); });
  $("#opt-auto").addEventListener("click", () => { settings.auto = !settings.auto; saveSettings(); paintSettings(); });
  $("#opt-tv").addEventListener("click", () => { settings.tv = settings.tv === null ? true : settings.tv ? false : null; saveSettings(); paintSettings(); });
  paintSettings();

  // ---------- library ----------
  let items = [], byId = new Map(), view = [], loaded = false, shown = 0;
  const CHUNK = 60;
  let progress = store.get("vid-progress", {});                   // id -> {t, d, ts, done}
  const grid = $("#grid"), more = $("#more");

  function card(it) {
    const a = el("a", "vcard");
    a.href = "#v=" + it.id; a.dataset.id = it.id;
    const th = el("span", "thumb");
    th.append(el("span", "ph", "▶"));
    const img = new Image();
    img.loading = "lazy"; img.decoding = "async"; img.alt = ""; img.src = `${API}/thumb/${it.id}`;
    img.onerror = () => img.remove();
    th.append(img);
    const p = progress[it.id];
    if (p && p.done) th.append(el("span", "badge", "✓"));
    else if (p && p.d && p.t > 10) { const bar = el("span", "prog"), fill = el("i"); fill.style.width = clamp(p.t / p.d * 100, 0, 100) + "%"; bar.append(fill); th.append(bar); }
    if (!NATIVE.has(it.ext)) th.append(el("span", "badge ext", it.ext.toUpperCase()));
    a.append(th, el("span", "t", it.title), el("span", "s", [it.folder, fmtSize(it.size)].filter(Boolean).join(" · ")));
    return a;
  }
  function renderCont() {
    const list = Object.entries(progress).filter(([id, p]) => byId.has(id) && !p.done && p.t > 10 && p.d)
      .sort((a, b) => b[1].ts - a[1].ts).slice(0, 12).map(([id]) => byId.get(id));
    $("#cont").hidden = !list.length;
    $("#cont-row").replaceChildren(...list.map(card));
  }
  function applyFilter() {
    const toks = $("#q").value.toLowerCase().split(/\s+/).filter(Boolean), f = $("#folder").value, s = $("#sort").value;
    view = items.filter((it) => (!f || it.folder === f || it.folder.startsWith(f + " / ")) && toks.every((t) => (it.title + " " + it.folder).toLowerCase().includes(t)));
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    view.sort(s === "new" ? (a, b) => b.created - a.created : s === "size" ? (a, b) => b.size - a.size : (a, b) => collator.compare(a.folder + "/" + a.title, b.folder + "/" + b.title));
    shown = 0;
    grid.replaceChildren();
    $("#empty").hidden = items.length > 0;
    $("#all-title").hidden = !items.length;
    $("#all-title").textContent = view.length === items.length ? `All videos (${items.length})` : `${view.length} of ${items.length} videos`;
    showMore();
  }
  function showMore() {
    if (shown >= view.length) return;
    grid.append(...view.slice(shown, shown + CHUNK).map(card));
    shown += CHUNK;
  }
  new IntersectionObserver((e) => { if (e[0].isIntersecting) showMore(); }, { rootMargin: "900px" }).observe(more);
  function fillFolders() {
    const keep = $("#folder").value, names = [...new Set(items.map((i) => i.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    $("#folder").replaceChildren(new Option("All folders", ""), ...names.map((n) => new Option(n, n)));
    $("#folder").value = names.includes(keep) ? keep : "";
  }
  async function load() {
    say("Loading…");
    const r = await fetch(`${API}/list`, { credentials: "same-origin" });
    if (r.status === 401) return location.reload();
    if (!r.ok) throw new Error("The video list could not be loaded.");
    items = (await r.json()).items;
    byId = new Map(items.map((i) => [i.id, i]));
    loaded = true;
    fillFolders(); applyFilter(); renderCont();
    if (items.some((i) => !NATIVE.has(i.ext))) loadHls().catch(() => {});   // the converter's player library, ready before it is needed
    say("");
  }
  const run = (fn) => fn().catch((e) => say(e.message || String(e), true));
  let qT = 0;
  $("#q").addEventListener("input", () => { clearTimeout(qT); qT = setTimeout(applyFilter, 150); });
  $("#folder").addEventListener("change", applyFilter);
  $("#sort").addEventListener("change", applyFilter);
  $("#refresh").addEventListener("click", () => run(load));

  // ---------- precaching ----------
  const PRE = { cache: "video-pre", head: 8 * MB, tailMax: 16 * MB, keep: 8 };
  const busy = new Set();
  const conn = navigator.connection;
  const segUrl = (id, s) => `${url(id)}?seg=${s}`;
  const preAllowed = () => settings.pre && "caches" in window && !(conn && conn.saveData);

  async function fetchRange(id, a, b) {
    const ac = new AbortController();
    const r = await fetch(url(id), { headers: { Range: `bytes=${a}-${b}` }, credentials: "same-origin", signal: ac.signal });
    const m = /\/(\d+)$/.exec(r.headers.get("Content-Range") || "");
    if (r.status !== 206 || !m) { ac.abort(); throw new Error("range"); }
    return { buf: await r.arrayBuffer(), total: +m[1], type: r.headers.get("Content-Type") || "video/mp4" };
  }
  // How many bytes at the end of the file hold the "moov" index, when it is not at the start (0 = nothing to fetch).
  function tailBytes(buf, total) {
    const v = new DataView(buf), n = buf.byteLength;
    let o = 0;
    while (o + 8 <= n) {
      let size = v.getUint32(o);
      const type = String.fromCharCode(v.getUint8(o + 4), v.getUint8(o + 5), v.getUint8(o + 6), v.getUint8(o + 7));
      if (size === 1) { if (o + 16 > n) return 0; size = v.getUint32(o + 8) * 4294967296 + v.getUint32(o + 12); }
      else if (size === 0) size = total - o;
      if (size < 8) return 0;
      if (type === "moov") return 0;                               // the index is at the start: the head is enough
      if (type === "mdat") { const t = total - (o + size); return t > 0 && t <= PRE.tailMax && total - t >= n ? t : 0; }
      o += size;
    }
    return 0;
  }
  const order = () => store.get("vid-pre-order", []);
  function touch(id) { store.set("vid-pre-order", order().filter((x) => x !== id).concat(id)); }
  async function put(c, id, seg, start, part) {
    await c.put(segUrl(id, seg), new Response(part.buf, { headers: {
      "Content-Type": part.type, "X-Start": String(start), "X-Total": String(part.total), "X-Size": String(part.buf.byteLength) } }));
  }
  async function evict(c) {
    const o = order();
    while (o.length > PRE.keep) { const id = o.shift(); await c.delete(segUrl(id, "head")); await c.delete(segUrl(id, "tail")); }
    store.set("vid-pre-order", o);
  }
  async function precache(id) {
    if (!preAllowed() || busy.has(id) || !byId.has(id) || !NATIVE.has(byId.get(id).ext) || (current && current.id === id)) return;
    busy.add(id);
    try {
      const c = await caches.open(PRE.cache);
      if (await c.match(segUrl(id, "head"))) return touch(id);
      const head = await fetchRange(id, 0, PRE.head - 1);
      await put(c, id, "head", 0, head);
      const tail = tailBytes(head.buf, head.total);
      if (tail) await put(c, id, "tail", head.total - tail, await fetchRange(id, head.total - tail, head.total - 1));
      touch(id);
      await evict(c);
      preInfo();
    } catch { /* offline, or the file went away: nothing to do */ } finally { busy.delete(id); }
  }
  async function preInfo() {
    const info = $("#pre-info"), clear = $("#pre-clear");
    if (!("caches" in window)) { info.textContent = "Precaching needs HTTPS (or localhost)."; clear.hidden = true; return; }
    try {
      const c = await caches.open(PRE.cache);
      let size = 0, n = 0;
      for (const req of await c.keys()) { const r = await c.match(req); size += +(r && r.headers.get("X-Size")) || 0; if (req.url.endsWith("seg=head")) n++; }
      info.textContent = n ? `Precached: ${n} video${n === 1 ? "" : "s"} (${fmtSize(size)})` : "";
      clear.hidden = !n;
    } catch { info.textContent = ""; }
  }
  $("#pre-clear").addEventListener("click", async () => { try { await caches.delete(PRE.cache); } catch { /* ignore */ } store.set("vid-pre-order", []); preInfo(); });
  // Hover (mouse) or focus (remote) on a card for a moment: the click is probably coming.
  let preT = 0;
  const intent = (e) => {
    const a = e.target.closest && e.target.closest(".vcard");
    if (!a) return;
    clearTimeout(preT);
    preT = setTimeout(() => precache(a.dataset.id), isTv() ? 900 : 500);
  };
  const library = $("#library");
  library.addEventListener("pointerover", (e) => { if (e.pointerType === "mouse") intent(e); });
  library.addEventListener("focusin", (e) => { if (isTv()) intent(e); });
  library.addEventListener("pointerleave", () => clearTimeout(preT));

  // ---------- converted videos (cache on the server) ----------
  async function convInfo() {
    try {
      const d = await (await fetch(`${API}/cache`, { credentials: "same-origin" })).json();
      $("#conv-info").textContent = !d.ffmpeg ? "ffmpeg is not installed on the server: only mp4 and webm files the browser can decode will play."
        : d.size ? `Converted videos cached: ${fmtSize(d.size)} of ${fmtSize(d.limit)}` : "";
      $("#conv-clear").hidden = !d.size && !d.running;
    } catch { /* offline */ }
  }
  $("#conv-clear").addEventListener("click", async () => {
    if (!confirm("Delete all converted copies? They are made again when needed.")) return;
    await fetch(`${API}/cache/clear`, { method: "POST", credentials: "same-origin" }).catch(() => {});
    convInfo();
  });
  // Starts converting a video that needs it, if the server has nothing else to do (called for the next video of the list).
  function warm(id) {
    if (!settings.pre || (conn && conn.saveData)) return;
    fetch(`${API}/info/${id}?caps=${CAPS}&warm=1`, { credentials: "same-origin" }).catch(() => {});
  }

  // ---------- player ----------
  const player = $("#player"), v = $("#vid"), seek = $("#p-seek");
  let current = null, pushed = false, controls = true, idleT = 0, upT = 0, upN = 0, upActive = false, dragging = false, dragT = 0;
  let preDone = false, saveAt = 0, spinT = 0, msgT = 0, wl = null;
  let seq = 0, hls = null, hlsFix = 0, hlsLib = null, info = null, job = null, mode = "direct", pollT = 0, triedForce = false;
  let tracks = [], subIdx = -1;
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const neighbours = () => { const i = current ? view.findIndex((x) => x.id === current.id) : -1; return { prev: i > 0 ? view[i - 1] : null, next: i >= 0 && i < view.length - 1 ? view[i + 1] : null }; };

  // What this browser can decode beyond the basics (HEVC, VP9, AV1, AC3, E-AC3): the server then converts less.
  const CAPS = (() => {
    const t = { hevc: 'video/mp4; codecs="hvc1.1.6.L93.B0"', vp9: 'video/webm; codecs="vp9"', av1: 'video/mp4; codecs="av01.0.05M.08"', ac3: 'audio/mp4; codecs="ac-3"', eac3: 'audio/mp4; codecs="ec-3"' };
    const probe = document.createElement("video");
    return Object.keys(t).filter((k) => probe.canPlayType(t[k]) === "probably").join(",");
  })();
  // The length of the video: while a conversion is running the stream grows, so the length the server measured is used.
  const dur = () => { const d = job && info && info.duration ? info.duration : v.duration; return isFinite(d) && d > 0 ? d : (info && info.duration) || 0; };
  const convLimit = () => (job && job.state === "running" ? Math.max(0, job.seconds - 4) : Infinity);

  function flash(text) {
    const m = $("#p-msg");
    m.textContent = text; m.classList.add("show");
    clearTimeout(msgT); msgT = setTimeout(() => m.classList.remove("show"), 900);
  }
  function showControls() {
    controls = true;
    player.classList.remove("idle");
    clearTimeout(idleT);
    if (!v.paused && !upActive) idleT = setTimeout(hideControls, isTv() ? 5000 : 3500);
  }
  function hideControls() {
    if (v.paused || upActive || dragging) return;
    controls = false;
    player.classList.add("idle");
    if (document.activeElement !== player && player.contains(document.activeElement)) player.focus();
  }
  function setBusy(text) {
    $("#p-busy").hidden = !text;
    $("#p-busy").textContent = text || "";
    clearTimeout(spinT);
    $("#p-spin").hidden = !text;
  }
  function showError(text) {
    setBusy("");
    $("#p-err-text").textContent = text;
    $("#p-err-link").href = current ? `/api/storage/download/${current.id}` : "#";
    $("#p-err").hidden = false;
    showControls();
  }

  function paint() {
    const d = dur(), t = dragging ? dragT : v.currentTime || 0, pct = d ? clamp(t / d * 100, 0, 100) : 0;
    $("#p-played").style.width = pct + "%";
    $("#p-knob").style.left = pct + "%";
    let ahead = 0;
    for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= t + 0.5 && v.buffered.end(i) >= t) ahead = v.buffered.end(i);
    $("#p-buf").style.width = d ? clamp(ahead / d * 100, 0, 100) + "%" : "0";
    $("#p-time").textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
    seek.setAttribute("aria-valuenow", Math.round(t));
    seek.setAttribute("aria-valuemax", Math.round(d));
    const play = $("#p-play");
    play.textContent = v.paused ? "▶" : "❚❚";
    play.setAttribute("aria-label", v.paused ? "Play" : "Pause");
  }
  function paintNav() {
    const n = neighbours();
    $("#p-prev").disabled = !n.prev; $("#p-next").disabled = !n.next;
  }

  function saveProgress(done) {
    const d = dur();
    if (!current || !d) return;
    const t = v.currentTime, fin = done || t / d > 0.95;
    progress[current.id] = { t: fin ? 0 : t, d, ts: Date.now(), done: fin };
    const keys = Object.keys(progress);
    if (keys.length > 300) keys.sort((a, b) => progress[a].ts - progress[b].ts).slice(0, keys.length - 300).forEach((k) => delete progress[k]);
    store.set("vid-progress", progress);
  }

  // ----- subtitles -----
  function setSubs(list) {
    list = list || [];
    v.querySelectorAll("track").forEach((t) => t.remove());
    tracks = list.map((s) => {
      const t = document.createElement("track");
      t.kind = "subtitles"; t.label = s.label; t.srclang = s.lang || "und"; t.src = s.src;
      v.append(t);
      t.track.mode = "disabled";
      return t;
    });
    $("#p-cc").hidden = !tracks.length;
    const pref = store.get("vid-sub", "off");
    applySub(pref === "off" ? -1 : list.findIndex((s) => (s.lang || s.label) === pref), true);
  }
  function applySub(i, quiet) {
    subIdx = i;
    tracks.forEach((t, j) => { t.track.mode = j === i ? "showing" : "disabled"; });
    const b = $("#p-cc");
    b.textContent = i < 0 ? "CC" : "CC·" + (tracks[i].srclang !== "und" ? tracks[i].srclang.slice(0, 3) : i + 1);
    b.setAttribute("aria-pressed", String(i >= 0));
    if (quiet) return;
    store.set("vid-sub", i < 0 ? "off" : tracks[i].srclang !== "und" ? tracks[i].srclang : tracks[i].label);
    flash(i < 0 ? "Subtitles off" : "Subtitles: " + tracks[i].label);
  }
  const cycleSub = () => { if (tracks.length) applySub(subIdx + 1 >= tracks.length ? -1 : subIdx + 1); };
  $("#p-cc").addEventListener("click", cycleSub);

  // ----- getting the video to play -----
  async function getInfo(id, extra) {
    const r = await fetch(`${API}/info/${id}?caps=${CAPS}${extra || ""}`, { credentials: "same-origin" });
    if (r.status === 401) { location.reload(); throw new Error("Signed out."); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "The video could not be prepared.");
    return d;
  }
  async function pollStatus() {
    if (!job) return;
    try {
      const r = await fetch(`${API}/status/${job.key}`, { credentials: "same-origin", cache: "no-store" });
      if (r.ok && job) Object.assign(job, await r.json());
    } catch { /* the next poll will do */ }
  }
  function paintConv() {
    const c = $("#p-conv");
    if (job && job.state === "running" && info && info.duration) { c.hidden = false; c.textContent = `Converting ${Math.min(99, Math.round(job.seconds / info.duration * 100))}%`; }
    else c.hidden = true;
  }
  function watchJob() {                                              // while a conversion runs, keep the progress (and the seek limit) fresh
    clearTimeout(pollT);
    paintConv();
    if (!job || job.state !== "running") { convInfo(); return; }
    pollT = setTimeout(async () => {
      await pollStatus();
      if (job && job.state === "error") showError(job.error || "The conversion failed.");
      watchJob();
    }, 2000);
  }
  function loadHls() {
    if (window.Hls) return Promise.resolve(window.Hls);
    hlsLib ||= new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.min.js";
      s.onload = () => res(window.Hls);
      s.onerror = () => { hlsLib = null; s.remove(); rej(new Error("The player library for converted videos could not be loaded (it comes from cdnjs).")); };
      document.head.append(s);
    });
    return hlsLib;
  }
  function teardown() {
    clearTimeout(pollT);
    if (hls) { hls.destroy(); hls = null; }
    job = null; info = null; mode = "direct"; hlsFix = 0;
    $("#p-conv").hidden = true;
    setBusy("");
    v.onloadedmetadata = null;
  }
  function playDirect(it, from) {
    mode = "direct";
    v.onloadedmetadata = () => { if (from) v.currentTime = from; };
    v.src = url(it.id);
    v.play().catch(() => showControls());
  }
  // Converted playback: wait until the first segments exist, then play them with hls.js (or natively where the browser can).
  async function startHls(inf, from, my) {
    info = inf; mode = "hls"; hlsFix = 0;
    job = { key: inf.key, state: inf.state, seconds: inf.seconds || 0, duration: inf.duration };
    setSubs(inf.subs);
    if (v.getAttribute("src")) { v.pause(); v.removeAttribute("src"); v.load(); }
    const need = Math.min(14, (inf.duration || 60) * 0.5);
    for (;;) {
      if (my !== seq) return;
      if (job.state === "error") throw new Error(job.error || "The conversion failed.");
      if (job.state === "done" || (job.state === "running" && job.seconds >= need)) break;
      if (job.state === "busy" || job.state === "none") {
        setBusy("The server is busy with other conversions. Waiting for a free place…");
        const again = await getInfo(current.id, job.state === "none" ? "&retry=1" : "").catch(() => null);
        if (my !== seq) return;
        if (again && again.key) Object.assign(job, { key: again.key, state: again.state, seconds: again.seconds || 0 });
      } else setBusy(`Converting for playback… ${Math.round(job.seconds / (inf.duration || 1) * 100)}%`);
      await sleep(1000);
      if (my !== seq) return;
      await pollStatus();
    }
    setBusy("");
    const start = job.state === "done" ? from : Math.min(from, Math.max(0, job.seconds - 12));
    const native = v.canPlayType("application/vnd.apple.mpegurl");
    const safari = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);
    let Hls = null;
    if (!(safari && native)) { try { Hls = await loadHls(); } catch (e) { if (!native) throw e; } if (my !== seq) return; }
    if (Hls && Hls.isSupported()) {
      mode = "hls-js";
      hls = new Hls({ startPosition: start, maxBufferLength: 60, backBufferLength: 60 });
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR && ++hlsFix < 4) hls.recoverMediaError();
        else if (d.type === Hls.ErrorTypes.NETWORK_ERROR && ++hlsFix < 4) hls.startLoad();
        else showError("The converted video could not be played.");
      });
      hls.loadSource(inf.src);
      hls.attachMedia(v);
    } else if (native) {
      mode = "hls-native";
      v.onloadedmetadata = () => { if (start) v.currentTime = start; };
      v.src = inf.src;
    } else throw new Error("This browser can't play converted videos.");
    v.play().catch(() => showControls());
    watchJob();
  }

  async function openVideo(id) {
    const it = byId.get(id);
    if (!it) { say("That video no longer exists.", true); history.replaceState(null, "", location.pathname); return; }
    if (current) saveProgress();
    cancelUp(); teardown();
    const my = ++seq;
    current = it; preDone = false; triedForce = false;
    player.hidden = false;
    document.body.classList.add("playing");
    $("#p-title").textContent = it.title;
    $("#p-err").hidden = true;
    setSubs([]);
    const p = progress[id], from = p && !p.done && p.t > 10 ? Math.max(0, p.t - 3) : 0;
    v.playbackRate = 1; $("#p-speed").textContent = "1×";
    v.volume = store.get("vid-vol", 1); v.muted = store.get("vid-muted", false);
    paintNav(); paint(); showControls();
    session(it);
    player.focus();
    try {
      if (NATIVE.has(it.ext)) {                                      // starts at once; the server confirms (and adds subtitles) meanwhile
        playDirect(it, from);
        getInfo(id).then((inf) => {
          if (my !== seq) return;
          if (inf.mode === "hls") return startHls(inf, Math.max(from, v.currentTime || 0), my);
          info = inf; setSubs(inf.subs); paint();
        }).catch((e) => { if (my === seq && mode !== "direct") showError(e.message); });
      } else {
        setBusy("Checking the file…");
        const inf = await getInfo(id);
        if (my !== seq) return;
        if (inf.mode === "direct") { setBusy(""); info = inf; setSubs(inf.subs); playDirect(it, from); }
        else await startHls(inf, from, my);
      }
    } catch (e) { if (my === seq) showError(e.message || String(e)); }
  }
  function hidePlayer() {
    saveProgress();
    seq++;
    cancelUp(); clearTimeout(idleT); unlock(); teardown();
    const id = current && current.id;
    v.pause(); v.removeAttribute("src"); v.load();
    setSubs([]);
    if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    player.hidden = true; player.classList.add("idle");
    document.body.classList.remove("playing");
    current = null; pushed = false;
    renderCont();
    const back = id && document.querySelector(`#grid .vcard[data-id="${id}"], #cont-row .vcard[data-id="${id}"]`);
    if (back) back.focus({ preventScroll: false });
  }
  function closeRequest() {
    if (pushed) history.back();
    else { history.replaceState(null, "", location.pathname); hidePlayer(); }
  }
  function go(it) {                                                // another video, without adding history entries
    if (!it) return;
    history.replaceState(null, "", "#v=" + it.id);
    openVideo(it.id);
  }
  function route() {
    const m = /^#v=([0-9a-f]{32})$/.exec(location.hash);
    if (m) { if (loaded && (!current || current.id !== m[1])) openVideo(m[1]); }
    else if (!player.hidden) hidePlayer();
  }
  addEventListener("hashchange", route);
  library.addEventListener("click", (e) => { if (e.target.closest(".vcard")) pushed = true; });

  // Moves the playhead; while a conversion is running it cannot go past what has been converted.
  function seekTo(t) {
    t = clamp(t, 0, dur() || t);
    const lim = convLimit();
    if (t > lim) { t = lim; flash("Still converting…"); v.currentTime = t; return false; }
    v.currentTime = t;
    return true;
  }
  const seekBy = (d) => {
    if (!dur()) return;
    if (seekTo(v.currentTime + d)) flash((d > 0 ? "+" : "−") + Math.abs(d) + " s");
    paint();
  };
  const toggle = () => { if (v.paused) v.play().catch(() => {}); else v.pause(); };
  function toggleFs() {
    const d = document;
    if (d.fullscreenElement || d.webkitFullscreenElement) { (d.exitFullscreen || d.webkitExitFullscreen).call(d); try { screen.orientation.unlock(); } catch { /* ignore */ } }
    else if (player.requestFullscreen) player.requestFullscreen().then(() => { try { screen.orientation.lock("landscape").catch(() => {}); } catch { /* ignore */ } }).catch(() => {});
    else if (player.webkitRequestFullscreen) player.webkitRequestFullscreen();
    else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
  }
  const setVol = (x) => { v.muted = false; v.volume = clamp(x, 0, 1); flash("Volume " + Math.round(v.volume * 100) + "%"); };

  // controls
  $("#p-close").addEventListener("click", closeRequest);
  $("#p-play").addEventListener("click", toggle);
  $("#p-back").addEventListener("click", () => seekBy(-10));
  $("#p-fwd").addEventListener("click", () => seekBy(10));
  $("#p-prev").addEventListener("click", () => go(neighbours().prev));
  $("#p-next").addEventListener("click", () => go(neighbours().next));
  $("#p-fs").addEventListener("click", toggleFs);
  $("#p-vol").addEventListener("click", () => { v.muted = !v.muted; });
  $("#p-volr").addEventListener("input", (e) => { v.muted = false; v.volume = e.target.value / 100; });
  $("#p-speed").addEventListener("click", () => {
    v.playbackRate = SPEEDS[(SPEEDS.indexOf(v.playbackRate) + 1) % SPEEDS.length] || 1;
    $("#p-speed").textContent = v.playbackRate + "×";
    flash("Speed " + v.playbackRate + "×");
  });
  $("#p-up-play").addEventListener("click", () => { const n = neighbours().next; cancelUp(); go(n); });
  $("#p-up-cancel").addEventListener("click", () => { cancelUp(); showControls(); $("#p-play").focus(); });

  // seek bar: drag with mouse, finger or pen
  const timeAt = (e) => { const r = seek.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1) * dur(); };
  seek.addEventListener("pointerdown", (e) => { dragging = true; seek.classList.add("drag"); seek.setPointerCapture(e.pointerId); dragT = timeAt(e); paint(); e.preventDefault(); });
  seek.addEventListener("pointermove", (e) => { if (dragging) { dragT = timeAt(e); paint(); } });
  const endDrag = () => { if (!dragging) return; dragging = false; seek.classList.remove("drag"); if (dur()) seekTo(dragT); showControls(); };
  seek.addEventListener("pointerup", endDrag);
  seek.addEventListener("pointercancel", endDrag);

  // tapping the picture: mouse = play / pause (double-click = full screen); touch = show / hide controls, double-tap the sides = skip
  const hit = $("#p-hit");
  let ptype = "mouse", lastTap = 0;
  hit.addEventListener("pointerdown", (e) => { ptype = e.pointerType || "mouse"; });
  hit.addEventListener("click", (e) => {
    if (ptype === "mouse") { toggle(); showControls(); return; }
    const now = performance.now(), x = e.clientX / innerWidth;
    if (now - lastTap < 320) {
      lastTap = 0;
      if (x < 0.35) seekBy(-10); else if (x > 0.65) seekBy(10); else toggle();
      showControls();
      return;
    }
    lastTap = now;
    if (player.classList.contains("idle")) showControls();
    else if (v.paused) toggle();
    else hideControls();
  });
  hit.addEventListener("dblclick", () => { if (ptype === "mouse") toggleFs(); });
  player.addEventListener("pointermove", () => { if (!player.hidden) showControls(); });

  // video events
  const spin = (on) => { clearTimeout(spinT); if (on) spinT = setTimeout(() => { $("#p-spin").hidden = false; }, 400); else if ($("#p-busy").hidden) $("#p-spin").hidden = true; };
  ["timeupdate", "progress", "durationchange", "seeking", "seeked", "ratechange"].forEach((n) => v.addEventListener(n, () => { if (!dragging) paint(); }));
  v.addEventListener("timeupdate", () => { if (Date.now() - saveAt > 5000) { saveAt = Date.now(); saveProgress(); } });
  v.addEventListener("play", () => { paint(); showControls(); lock(); if (window.Player && window.Player.audio) window.Player.audio.pause(); if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing"; });
  v.addEventListener("pause", () => { paint(); showControls(); unlock(); saveProgress(); if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused"; });
  v.addEventListener("waiting", () => spin(true));
  ["playing", "canplay", "seeked"].forEach((n) => v.addEventListener(n, () => spin(false)));
  v.addEventListener("volumechange", () => {
    const off = v.muted || v.volume === 0;
    $("#p-vol").textContent = off ? "🔇" : "🔊";
    $("#p-vol").setAttribute("aria-label", off ? "Unmute" : "Mute");
    $("#p-volr").value = off ? 0 : Math.round(v.volume * 100);
    store.set("vid-vol", v.volume); store.set("vid-muted", v.muted);
  });
  v.addEventListener("canplaythrough", () => {                      // the current video is safe: now spare some bandwidth for the next one
    if (preDone) return;
    preDone = true;
    if (mode !== "direct" && !(job && job.state === "done")) return;   // a conversion is running: the server has its hands full
    setTimeout(() => { const n = neighbours().next; if (n && current) { if (NATIVE.has(n.ext)) precache(n.id); else warm(n.id); } }, 3000);
  });
  v.addEventListener("ended", () => {
    if (job && job.state === "running" && v.currentTime < dur() - 5) return;   // reached the end of what is converted so far
    saveProgress(true);
    const n = neighbours().next;
    if (settings.auto && n) showUp(n); else showControls();
  });
  v.addEventListener("error", () => {
    if (!current || mode === "hls-js") return;                        // hls.js reports its own errors
    spin(false);
    if (mode === "direct" && !triedForce && !job) {                    // the browser can't decode the original: let the server convert it
      triedForce = true;
      const my = seq, it = current, at = v.currentTime || 0;
      setBusy("This browser can't play the original. Converting it…");
      getInfo(it.id, "&force=1").then((inf) => (my === seq ? startHls(inf, at, my) : null)).catch((e) => { if (my === seq) showError(e.message); });
      return;
    }
    showError(v.error && v.error.code === 4 ? "This browser can't play this file." : "The video could not be loaded.");
  });

  // up next
  function paintUp() { $("#p-up-n").textContent = upN; }
  function showUp(n) {
    upActive = true;
    $("#p-up").hidden = false; $("#p-up-title").textContent = n.title;
    player.classList.remove("idle"); clearTimeout(idleT);
    upN = 5; paintUp();
    upT = setInterval(() => { if (--upN <= 0) { cancelUp(); go(n); } else paintUp(); }, 1000);
    $("#p-up-play").focus();
  }
  function cancelUp() { clearInterval(upT); upActive = false; $("#p-up").hidden = true; }

  // keep the screen on while playing
  async function lock() { try { if ("wakeLock" in navigator && !wl) { wl = await navigator.wakeLock.request("screen"); wl.addEventListener("release", () => { wl = null; }); } } catch { /* not allowed */ } }
  function unlock() { if (wl) wl.release().catch(() => {}); wl = null; }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !player.hidden && !v.paused) lock(); });
  addEventListener("pagehide", () => saveProgress());

  // lock screen / notification controls
  function session(it) {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: it.title, artist: it.folder || "Videos", artwork: [{ src: location.origin + `${API}/thumb/${it.id}`, sizes: "480x270", type: "image/jpeg" }] });
  }
  if ("mediaSession" in navigator) {
    const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* unsupported */ } };
    h("play", () => v.play().catch(() => {})); h("pause", () => v.pause());
    h("seekbackward", (d) => seekBy(-(d.seekOffset || 10))); h("seekforward", (d) => seekBy(d.seekOffset || 10));
    h("previoustrack", () => go(neighbours().prev)); h("nexttrack", () => go(neighbours().next));
    h("seekto", (d) => seekTo(d.seekTime));
  }

  // ---------- keyboard, TV remote ----------
  // Moves the focus to the nearest control in a direction, judged from where the focused one is on screen.
  function spatial(dir, scope) {
    const cur = document.activeElement;
    if (!cur || cur === document.body || !scope.contains(cur)) return false;
    const a = cur.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = null, bs = Infinity;
    const list = scope.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), [tabindex="0"]');
    for (const e of list) {
      if (e === cur) continue;
      const b = e.getBoundingClientRect();
      if (!b.width || !b.height || getComputedStyle(e).visibility === "hidden") continue;
      const dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay;
      const horiz = dir === "left" || dir === "right";
      if (!(dir === "right" ? dx > 8 : dir === "left" ? dx < -8 : dir === "down" ? dy > 8 : dy < -8)) continue;
      const overlap = horiz ? !(b.bottom <= a.top || b.top >= a.bottom) : !(b.right <= a.left || b.left >= a.right);
      const score = (horiz ? Math.abs(dx) : Math.abs(dy)) + (overlap ? 0 : (horiz ? Math.abs(dy) : Math.abs(dx)) * 2.5);
      if (score < bs) { bs = score; best = e; }
    }
    if (!best) return false;
    best.focus({ preventScroll: true });
    best.scrollIntoView({ block: "center", inline: "nearest" });
    return true;
  }
  const isBack = (e) => e.key === "Escape" || e.key === "GoBack" || e.key === "BrowserBack" || e.key === "XF86Back" || [10009, 461, 4].includes(e.keyCode);
  const MEDIA = { MediaPlayPause: "toggle", MediaPlay: "play", MediaPause: "pause", MediaTrackNext: "next", MediaTrackPrevious: "prev", MediaFastForward: "ff", MediaRewind: "rw", MediaStop: "close" };
  const MEDIA_CODE = { 179: "toggle", 415: "play", 19: "pause", 10252: "toggle", 176: "next", 177: "prev", 417: "ff", 412: "rw", 413: "close" };

  function playerKeys(e) {
    const t = e.target, k = e.key;
    if (isBack(e)) { e.preventDefault(); if (upActive) { cancelUp(); showControls(); } else closeRequest(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const media = MEDIA[k] || MEDIA_CODE[e.keyCode];
    const wasIdle = player.classList.contains("idle");
    showControls();
    if (media) {
      e.preventDefault();
      ({ toggle, play: () => v.play().catch(() => {}), pause: () => v.pause(), next: () => go(neighbours().next), prev: () => go(neighbours().prev),
         ff: () => seekBy(30), rw: () => seekBy(-30), close: closeRequest })[media]();
      return;
    }
    const onControl = t !== player && t !== document.body && t !== v && !!t.closest && !!t.closest("#p-bar, #p-top, #p-up");
    if (k.startsWith("Arrow")) {
      const dir = k.slice(5).toLowerCase(), horiz = dir === "left" || dir === "right", step = e.shiftKey ? 30 : 10;
      if (onControl && !wasIdle) {
        if (t === seek && horiz) { e.preventDefault(); seekBy(dir === "left" ? -step : step); return; }
        if (t.type === "range" && horiz) return;                    // the volume slider moves itself
        if (spatial(dir, player)) e.preventDefault();
        return;
      }
      e.preventDefault();
      if (horiz) seekBy(dir === "left" ? -step : step);
      else if (isTv()) $("#p-play").focus();                      // up / down on a remote opens the controls
      else setVol(v.volume + (dir === "up" ? 0.05 : -0.05));
      return;
    }
    if (k === "Enter" || k === " ") {
      if (t.tagName === "BUTTON" || t.tagName === "INPUT") return; // the focused button does its own thing
      e.preventDefault(); toggle(); return;
    }
    if (t.tagName === "INPUT" && t.type === "range") return;
    const key = k.toLowerCase();
    if (key === "k") toggle();
    else if (key === "j") seekBy(-10);
    else if (key === "l") seekBy(10);
    else if (key === "f") toggleFs();
    else if (key === "m") v.muted = !v.muted;
    else if (key === "n") go(neighbours().next);
    else if (key === "p") go(neighbours().prev);
    else if (key === "c") cycleSub();
    else if (/^[0-9]$/.test(k) && dur()) seekTo(dur() * (+k / 10));
    else return;
    e.preventDefault();
  }

  function libraryKeys(e) {
    const t = e.target;
    if (!e.key.startsWith("Arrow") || e.ctrlKey || e.metaKey || e.altKey) return;
    const dir = e.key.slice(5).toLowerCase(), onCard = !!(t.closest && t.closest(".vcard"));
    if (!isTv() && !onCard) return;                                 // on a PC the arrows scroll the page, unless a poster has the focus
    if (t.tagName === "INPUT" && t.type === "text" && (dir === "left" || dir === "right")) return;
    if (t.tagName === "SELECT" && !isTv()) return;
    e.preventDefault();
    if (t === document.body || t === document.documentElement) { const first = document.querySelector(".vcard") || $("#q"); if (first) first.focus(); return; }
    spatial(dir, document.body);
  }
  document.addEventListener("keydown", (e) => { if (!player.hidden) playerKeys(e); else libraryKeys(e); });

  // ---------- start ----------
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  run(async () => {
    await load();
    preInfo(); convInfo();
    route();
    if (isTv() && player.hidden) { const first = document.querySelector(".vcard"); if (first) first.focus(); }
  });
})();
