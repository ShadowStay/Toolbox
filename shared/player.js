// Persistent music player, loaded on every page for signed-in users (see app.py). One <audio> element plays the queue,
// the Media Session API gives lock-screen / notification controls (background playback), and a small floating player sits
// bottom-right. Position, queue and settings are saved in localStorage so another page picks up where this one stopped;
// the current track and position are also synced to the server so other devices can resume.
(function () {
  if (window.Player) return;
  const ls = (k, v) => {
    try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ }
    return null;
  };
  const S = Object.assign({ q: [], i: -1, t: 0, playing: false, closed: false, shuffle: false, repeat: 0, ts: 0 }, ls("mp-state"));
  const audio = new Audio();
  audio.preload = "auto";
  const subs = [], emit = (e) => subs.forEach((f) => f(e));
  const cur = () => S.q[S.i];
  const slim = (t) => ({ id: t.id, title: t.title, artist: t.artist, album: t.album, dur: t.dur });
  const json = { "Content-Type": "application/json" };
  let counted = false, lastSave = 0, lastSync = 0, lastPos = 0, dragging = false;

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

  // ---------- persistence ----------
  function save() {
    const a = Math.max(0, S.i - 50);                       // keep a window of the queue, not thousands of tracks
    ls("mp-state", { ...S, q: S.q.slice(a, a + 300).map(slim), i: S.i - a, t: audio.currentTime || 0, playing: !audio.paused, ts: Date.now() });
  }
  const payload = () => JSON.stringify({ cur: slim(cur()), t: audio.currentTime || 0, ts: Date.now() });
  const sync = () => { if (cur()) fetch("/api/music/state", { method: "PUT", headers: json, body: payload() }).catch(() => {}); };

  // ---------- playback ----------
  function load(i, play, at) {
    const t = S.q[i];
    if (!t) return;
    S.i = i; counted = false;
    audio.src = "/api/music/file/" + t.id;                 // the service worker answers from the download cache if present
    if (at) audio.addEventListener("loadedmetadata", () => { audio.currentTime = at; }, { once: true });
    meta(t); ui(); save(); emit("track");
    if (play) audio.play().catch(() => ui());
  }
  function next(auto) {
    if (!S.q.length) return;
    if (auto && S.repeat === 2) { audio.currentTime = 0; audio.play(); return; }
    let n = S.shuffle && S.q.length > 1 ? S.i + 1 + Math.floor(Math.random() * (S.q.length - 1)) : S.i + 1;
    n %= S.q.length;
    if (auto && !S.shuffle && S.i + 1 >= S.q.length && S.repeat === 0) { audio.pause(); return; }
    load(n, true);
  }
  function prev() {
    if (audio.currentTime > 3 || S.i <= 0) audio.currentTime = 0; else load(S.i - 1, true);
  }
  const toggle = () => { if (!cur()) return; if (audio.paused) { S.closed = false; audio.play().catch(() => {}); } else audio.pause(); };

  audio.addEventListener("play", () => { S.closed = false; save(); ui(); emit("state"); if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing"; });
  audio.addEventListener("pause", () => { save(); sync(); ui(); emit("state"); if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused"; });
  audio.addEventListener("ended", () => next(true));
  audio.addEventListener("error", () => { if (cur()) sub.textContent = "Can't play this (offline and not downloaded?)"; ui(); });
  audio.addEventListener("timeupdate", () => {
    const n = Date.now(), d = audio.duration || cur()?.dur || 0;
    if (!dragging && d) bar.value = (audio.currentTime / d) * 1000;
    if (!counted && cur() && audio.currentTime > Math.min(10, (d || 30) / 2)) {
      counted = true;
      fetch("/api/music/history", { method: "POST", headers: json, body: JSON.stringify({ id: cur().id }) }).catch(() => {});
    }
    if (n - lastSave > 2000) { lastSave = n; save(); }
    if (n - lastSync > 20000) { lastSync = n; sync(); }
    if (n - lastPos > 1000 && isFinite(audio.duration) && "mediaSession" in navigator) {
      lastPos = n;
      try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: 1 }); } catch { /* ignore */ }
    }
  });

  // ---------- lock screen / notification controls ----------
  function meta(t) {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album,
      artwork: [{ src: location.origin + "/api/music/art/" + t.id, sizes: "320x320", type: "image/jpeg" }],
    });
  }
  if ("mediaSession" in navigator) {
    const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* unsupported action */ } };
    h("play", toggle); h("pause", toggle); h("previoustrack", prev); h("nexttrack", () => next(false));
    h("seekto", (d) => { audio.currentTime = d.seekTime; });
    h("seekbackward", (d) => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); });
    h("seekforward", (d) => { audio.currentTime += d.seekOffset || 10; });
  }

  // ---------- downloads (offline copies in the Cache API; the service worker plays them) ----------
  let ids = new Set((ls("mp-dl") || []).map((t) => t.id));
  const dl = {
    list: () => ls("mp-dl") || [],
    has: (id) => ids.has(id),
    async add(t) {
      if (!window.caches) throw new Error("Offline storage needs https (or localhost).");
      const c = await caches.open("music-dl"), r = await fetch("/api/music/file/" + t.id);
      if (!r.ok) throw new Error("Download failed (" + r.status + ").");
      await c.put("/api/music/file/" + t.id, r);
      try { const a = await fetch("/api/music/art/" + t.id); if (a.ok) await c.put("/api/music/art/" + t.id, a); } catch { /* no artwork */ }
      ls("mp-dl", [...dl.list().filter((x) => x.id !== t.id), slim(t)]);
      ids.add(t.id);
      navigator.storage?.persist?.();
      emit("dl");
    },
    async remove(id) {
      const c = await caches.open("music-dl");
      await c.delete("/api/music/file/" + id); await c.delete("/api/music/art/" + id);
      ls("mp-dl", dl.list().filter((x) => x.id !== id));
      ids.delete(id);
      emit("dl");
    },
  };

  // ---------- floating player ----------
  const style = document.createElement("style");
  style.textContent = `
#mp{position:fixed;right:1rem;bottom:1rem;z-index:50;width:20rem;display:grid;grid-template-columns:3rem 1fr;gap:.4rem .7rem;align-items:center;padding:.6rem;color:var(--moon,#f1e9ff);background:var(--dusk,#22123b);border:1px solid var(--amethyst,#8a5bd8);border-radius:.8rem;box-shadow:0 12px 40px #000a;font:.9rem system-ui,sans-serif}
#mp[hidden]{display:none}
#mp img{width:3rem;height:3rem;border-radius:.4rem;object-fit:cover;background:var(--violet,#4b2a85);cursor:pointer}
#mp .mp-t{min-width:0;display:grid;cursor:pointer}
#mp .mp-t b,#mp .mp-t span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#mp .mp-t span{font-size:.78rem;opacity:.75}
#mp .mp-c{grid-column:1/3;display:flex;justify-content:space-between;align-items:center}
#mp button{min-width:2.2rem;height:2.2rem;font:inherit;color:inherit;background:none;border:1px solid transparent;border-radius:.4rem;cursor:pointer}
#mp button:hover{background:#8a5bd833}
#mp button[aria-pressed="true"]{color:var(--candle,#e9c776)}
#mp .big{background:var(--amethyst,#8a5bd8);border-radius:50%}
#mp input{grid-column:1/3;width:100%;accent-color:var(--amethyst,#8a5bd8)}
@media(max-width:760px){#mp{left:0;right:0;bottom:0;width:auto;border-radius:.8rem .8rem 0 0;padding-bottom:calc(.6rem + env(safe-area-inset-bottom,0px))}}`;
  document.head.append(style);
  const root = document.createElement("div");
  root.id = "mp"; root.hidden = true;
  root.innerHTML = `<img alt="" onerror="this.style.visibility='hidden'" data-a="open"><div class="mp-t" data-a="open"><b></b><span></span></div>
<div class="mp-c"><button data-a="shuf" title="Shuffle" aria-label="Shuffle">⇄</button><button data-a="prev" aria-label="Previous">⏮</button>
<button class="big" data-a="pp" aria-label="Play or pause">▶</button><button data-a="next" aria-label="Next">⏭</button>
<button data-a="rep" title="Repeat" aria-label="Repeat">↻</button><button data-a="x" title="Close" aria-label="Close">✕</button></div>
<input type="range" min="0" max="1000" value="0" aria-label="Seek">`;
  document.body.append(root);
  const img = root.querySelector("img"), title = root.querySelector("b"), sub = root.querySelector(".mp-t span"),
    pp = root.querySelector(".big"), bar = root.querySelector("input"),
    shuf = root.querySelector('[data-a="shuf"]'), rep = root.querySelector('[data-a="rep"]');

  function ui() {
    const t = cur();
    root.hidden = !t || S.closed;
    if (!t) return;
    if (root._id !== t.id) {
      root._id = t.id; img.style.visibility = "visible"; img.src = "/api/music/art/" + t.id;
      title.textContent = t.title; sub.textContent = t.artist;
    }
    pp.textContent = audio.paused ? "▶" : "❚❚";
    shuf.setAttribute("aria-pressed", String(S.shuffle));
    rep.textContent = S.repeat === 2 ? "↻1" : "↻";
    rep.setAttribute("aria-pressed", String(S.repeat > 0));
  }
  root.addEventListener("click", (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "pp") toggle();
    else if (a === "next") next(false);
    else if (a === "prev") prev();
    else if (a === "shuf") { S.shuffle = !S.shuffle; save(); ui(); }
    else if (a === "rep") { S.repeat = (S.repeat + 1) % 3; save(); ui(); }
    else if (a === "x") { audio.pause(); S.closed = true; save(); ui(); }
    else if (a === "open" && location.pathname !== "/music") location.href = "/music";
  });
  bar.addEventListener("input", () => { dragging = true; });
  bar.addEventListener("change", () => { dragging = false; const d = audio.duration || cur()?.dur; if (d) audio.currentTime = (bar.value / 1000) * d; });
  addEventListener("pagehide", () => {
    if (!cur()) return;
    save();
    navigator.sendBeacon("/api/music/state", new Blob([payload()], { type: "application/json" }));
  });

  window.Player = {
    audio, state: S, cur, dl, toggle, prev, next: () => next(false), on: (f) => subs.push(f),
    play(list, i) { S.q = list.slice(); S.closed = false; load(i, true); },
    enqueue(t) { S.q.push(t); S.closed = false; if (S.i < 0 || (audio.paused && !audio.src)) load(S.q.length - 1, true); else { save(); ui(); } },
  };

  // ---------- restore on page load ----------
  if (cur()) {
    const was = S.playing && !S.closed && Date.now() - S.ts < 20000;   // we were mid-song when the page changed
    load(S.i, was, S.t);
  }
  fetch("/api/music/state").then((r) => (r.ok ? r.json() : null)).then((d) => {   // another device played more recently
    if (d && d.cur && d.ts > S.ts + 2000 && audio.paused) { S.q = [d.cur]; S.closed = false; load(0, false, d.t); }
  }).catch(() => {});
})();
