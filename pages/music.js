// Page script for pages/music.html. A small hash-routed app (#/songs?album=...). Playback lives in shared/player.js,
// so music keeps playing while you move between these views. Lists load 100 rows at a time as you scroll, and
// artwork is only requested for rows that scroll into view (loading="lazy").
// Songs are uploaded from here into the server's data/music folder, and can be downloaded or deleted from the "⋯" menu.
(function () {
  const P = window.Player, $ = (s) => document.querySelector(s), view = $("#view"), status = $("#status");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (s) => { s = Math.round(s || 0); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const say = (m, err) => { status.textContent = m || ""; status.classList.toggle("error", !!err); };
  const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { say(e.message || String(e), true); } };
  async function api(path, method, body) {
    const r = await fetch("/api/music" + path, body === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) {
      let msg = "";
      try { msg = (await r.json()).error; } catch { /* not JSON */ }
      throw new Error(r.status === 401 ? "Session ended. Reload to sign in." : msg || "Server error " + r.status);
    }
    return r.status === 204 ? null : r.json();
  }
  const art = (id) => (id ? `<img loading="lazy" decoding="async" src="/api/music/art/${id}" alt="" onerror="this.style.visibility='hidden'">` : "");

  let cur = { list: [] }, stop = () => {}, tok = 0;

  // ---------- templates ----------
  const row = (t, i) => `<li class="row${P.cur()?.id === t.id ? " on" : ""}" data-i="${i}" data-id="${t.id}">
    <span class="cov">${art(t.id)}</span>
    <span class="rt"><b>${esc(t.title)}</b><small>${esc([t.artist, t.album].filter(Boolean).join(" · "))}</small></span>
    <span class="dur">${fmt(t.dur)}</span>
    ${cur.pl ? '<button class="ib" data-a="up" aria-label="Move up">▲</button><button class="ib" data-a="down" aria-label="Move down">▼</button><button class="ib" data-a="rm" aria-label="Remove from playlist">✕</button>' : ""}
    <button class="ib" data-a="like" aria-pressed="${!!t.liked}" aria-label="Like">♥</button>
    <button class="ib" data-a="dl" aria-pressed="${P.dl.has(t.id)}" aria-label="Download to this device" title="Keep on this device for offline listening">⬇</button>
    <button class="ib" data-a="more" aria-label="More">⋯</button></li>`;
  const rows = (items, start = 0) => items.map((t, k) => row(t, start + k)).join("");
  const KEY = { albums: "album", artists: "artist", genres: "genre" };
  const cards = (items, kind) => items.map((x) => {
    const q = kind === "albums" ? { album: x.album, artist: x.artist } : { [KEY[kind]]: x[KEY[kind]] };
    const sub = kind === "albums" ? x.artist : `${x.n} song${x.n === 1 ? "" : "s"}`;
    return `<a class="card" href="#/songs?${esc(new URLSearchParams(q))}"><span class="cov sq">${art(x.art)}</span><b>${esc(x[KEY[kind]] || "Unknown")}</b><small>${esc(sub)}</small></a>`;
  }).join("");
  const plCards = (items) => items.map((p) =>
    `<a class="card" href="#/songs?${esc(new URLSearchParams({ pl: p.id, name: p.name }))}"><span class="cov sq">${art(p.art)}</span><b>${esc(p.name)}</b><small>${p.n ?? ""} ${p.n === 1 ? "song" : p.n == null ? "" : "songs"}</small></a>`).join("");

  // Infinite scroll: fetch the next page whenever the sentinel below the list comes near the viewport.
  function paged(path, params, limit, into, render) {
    let n = 0, more = true, busy = false;
    const s = document.createElement("div");
    into.after(s);
    const obs = new IntersectionObserver(async () => {
      if (busy || !more) return;
      busy = true;
      try {
        const d = await api(path + "?" + new URLSearchParams({ ...params, offset: n, limit }));
        if (!n && !d.items.length) into.innerHTML = '<p class="hint">Nothing here yet. Press Upload to add songs.</p>';
        else into.insertAdjacentHTML("beforeend", render(d.items, n));
        n += d.items.length; more = d.more;
      } catch (e) { say(e.message + (navigator.onLine ? "" : " You are offline: open Downloads."), true); more = false; }
      busy = false;
      obs.unobserve(s);
      if (more) obs.observe(s);                            // re-check: the sentinel may still be on screen
    }, { rootMargin: "600px" });
    obs.observe(s);
    stop = () => { obs.disconnect(); s.remove(); };
  }

  // ---------- views ----------
  const VIEWS = {
    async home() {
      const [r, a] = await Promise.all([api("/tracks?recent=1&limit=8"), api("/browse/albums?limit=12")]);
      cur.list = r.items;
      view.innerHTML = `<h2>Recently played</h2>${r.items.length ? `<ul class="rows">${rows(r.items)}</ul>` : '<p class="hint">Nothing played yet.</p>'}
        <h2>Albums</h2><div class="grid">${cards(a.items, "albums")}</div>${a.more ? '<p><a href="#/albums">All albums</a></p>' : ""}`;
    },
    async songs(p) { return list("/tracks", p, p.name || p.album || p.artist || p.genre || "Songs", 100); },
    liked: () => list("/tracks", { liked: 1 }, "Liked songs", 100),
    history: () => list("/tracks", { hist: 1 }, "Listening history", 100),
    albums: () => grid("albums", "Albums"),
    artists: () => grid("artists", "Artists"),
    genres: () => grid("genres", "Genres"),
    player: () => playerView(),
    async playlists() {
      const d = await api("/playlists");
      view.innerHTML = `<div class="head"><h2>Playlists</h2><button class="btn primary small" data-a="newpl">New playlist</button></div>
        ${d.items.length ? `<div class="grid">${plCards(d.items)}</div>` : '<p class="hint">No playlists yet.</p>'}`;
    },
    downloads() {
      cur.list = P.dl.list();
      view.innerHTML = `<div class="head"><h2>Kept on this device</h2><button class="btn primary small" data-a="playall">Play</button></div>
        ${cur.list.length ? `<ul class="rows">${rows(cur.list)}</ul>` : '<p class="hint">Tap ⬇ on a song to keep it here for offline listening.</p>'}`;
    },
    async search(p) {
      const my = ++tok, text = p.q || "";
      if (document.activeElement !== $("#q")) $("#q").value = text;
      const d = await api("/search?q=" + encodeURIComponent(text));
      if (my !== tok) return;
      cur.list = d.tracks;
      const sec = (t, h) => (h ? `<h2>${t}</h2>${h}` : "");
      view.innerHTML = sec("Playlists", d.playlists.length ? `<div class="grid">${plCards(d.playlists)}</div>` : "")
        + sec("Artists", d.artists.length ? `<div class="grid">${cards(d.artists, "artists")}</div>` : "")
        + sec("Albums", d.albums.length ? `<div class="grid">${cards(d.albums, "albums")}</div>` : "")
        + sec("Songs", d.tracks.length ? `<ul class="rows">${rows(d.tracks)}</ul>` : "")
        + (d.tracks.length || d.albums.length || d.playlists.length ? "" : '<p class="hint">No matches.</p>');
    },
  };

  async function list(path, p, title, limit) {
    cur.pl = p.pl ? +p.pl : 0; cur.name = p.name || "";
    const tools = cur.pl ? '<button class="btn small" data-a="rename">Rename</button><button class="btn small" data-a="delete">Delete</button>' : "";
    view.innerHTML = `<div class="head"><h2>${esc(title)}</h2><button class="btn primary small" data-a="playall">Play</button>
      <button class="btn small" data-a="shuffle">Shuffle</button><button class="btn small" data-a="dlall">Keep all on this device</button>${tools}</div><ul class="rows"></ul>`;
    cur.ul = view.querySelector(".rows");
    paged(path, p, cur.pl ? 5000 : limit, cur.ul, (items, start) => { cur.list.push(...items); return rows(items, start); });
  }
  function grid(kind, title) {
    view.innerHTML = `<h2>${title}</h2><div class="grid"></div>`;
    paged("/browse/" + kind, {}, 60, view.querySelector(".grid"), (items) => cards(items, kind));
  }

  // ---------- the Player tab: a big player (the whole screen on a phone) ----------
  // Controls: shuffle (reorders the playlist), previous, play/pause, next, repeat (once = this song, twice = the playlist,
  // again = off), a seek bar and a volume slider, and the queue underneath. Everything is driven by shared/player.js.
  function playerView() {
    document.documentElement.classList.add("pl-full");           // hides the little floating player
    view.innerHTML = `<section class="pv" aria-label="Music player">
      <button class="btn small pv-back" type="button" data-pv="back">‹ Library</button>
      <div class="pv-art" aria-hidden="true"></div>
      <div class="pv-info"><b id="pv-title"></b><span id="pv-artist"></span></div>
      <div class="pv-seek"><span id="pv-cur">0:00</span><input type="range" id="pv-bar" min="0" max="1000" value="0" aria-label="Seek"><span id="pv-dur">0:00</span></div>
      <div class="pv-ctl">
        <button type="button" data-pv="shuf" aria-label="Shuffle the playlist" title="Shuffle the playlist">⇄</button>
        <button type="button" data-pv="prev" aria-label="Previous" title="Previous">⏮</button>
        <button type="button" class="pv-play" data-pv="pp" aria-label="Play or pause">▶</button>
        <button type="button" data-pv="next" aria-label="Next" title="Next">⏭</button>
        <button type="button" data-pv="rep" aria-label="Repeat" title="Repeat">↻</button>
      </div>
      <p class="pv-mode" id="pv-mode" aria-live="polite"></p>
      <label class="pv-vol"><span aria-hidden="true">🔈</span><input type="range" id="pv-vol" min="0" max="100" aria-label="Volume"><span aria-hidden="true">🔊</span></label>
      <div class="pv-q"><h2>Up next</h2><ol id="pv-list"></ol></div>
    </section>`;
    const q = (s) => view.querySelector(s), A = P.audio;
    let dragging = false, shownId = null;

    const paintTime = () => {
      const d = A.duration || P.cur()?.dur || 0;
      q("#pv-cur").textContent = fmt(dragging ? (q("#pv-bar").value / 1000) * d : A.currentTime);
      q("#pv-dur").textContent = fmt(d);
      if (!dragging && d) q("#pv-bar").value = (A.currentTime / d) * 1000;
    };
    function paint() {
      const t = P.cur(), S = P.state;
      q("#pv-title").textContent = t ? t.title : "Nothing playing";
      q("#pv-artist").textContent = t ? [t.artist, t.album].filter(Boolean).join(" · ") : "Pick a song in the library and it shows up here.";
      const id = t ? t.id : null;
      if (id !== shownId) { shownId = id; q(".pv-art").innerHTML = t ? art(t.id) : "♫"; }
      q(".pv-play").textContent = A.paused ? "▶" : "❚❚";
      q('[data-pv="shuf"]').setAttribute("aria-pressed", String(S.shuffle));
      const rep = q('[data-pv="rep"]');
      rep.textContent = S.repeat === 2 ? "↻1" : "↻";
      rep.setAttribute("aria-pressed", String(S.repeat > 0));
      q("#pv-mode").textContent = `Repeat: ${["off", "playlist", "this song"][S.repeat]} · Shuffle: ${S.shuffle ? "on" : "off"}`;
      if (document.activeElement !== q("#pv-vol")) q("#pv-vol").value = Math.round(P.volume() * 100);
      const list = P.queue(), from = Math.max(0, S.i);
      q("#pv-list").innerHTML = list.slice(from, from + 100).map((x, k) =>
        `<li><button type="button" class="${from + k === S.i ? "on" : ""}" data-pv="jump" data-j="${from + k}"><b>${esc(x.title)}</b><small>${esc(x.artist || "")}</small></button></li>`).join("")
        || '<li class="hint">The queue is empty.</li>';
      paintTime();
    }

    q(".pv").addEventListener("click", (e) => {
      const b = e.target.closest("[data-pv]");
      if (!b) return;
      const a = b.dataset.pv;
      if (a === "back") location.hash = "#/home";
      else if (a === "pp") P.toggle();
      else if (a === "prev") P.prev();
      else if (a === "next") P.next();
      else if (a === "shuf") P.toggleShuffle();
      else if (a === "rep") P.cycleRepeat();
      else if (a === "jump") P.jump(+b.dataset.j);
    });
    q("#pv-bar").addEventListener("input", () => { dragging = true; paintTime(); });
    q("#pv-bar").addEventListener("change", (e) => { dragging = false; P.seek(e.target.value / 1000); });
    q("#pv-vol").addEventListener("input", (e) => P.setVolume(e.target.value / 100));

    const off = P.on((e) => { if (e === "track" || e === "state" || e === "mode") paint(); });
    const events = ["timeupdate", "loadedmetadata", "durationchange"];
    events.forEach((n) => A.addEventListener(n, paintTime));
    stop = () => { off(); events.forEach((n) => A.removeEventListener(n, paintTime)); };
    paint();
  }

  async function route() {
    stop(); stop = () => {}; say("");
    document.documentElement.classList.remove("pl-full");
    const [name, qs] = location.hash.slice(2).split("?"), p = Object.fromEntries(new URLSearchParams(qs || ""));
    const key = VIEWS[name] ? name : "home";
    document.querySelectorAll("#mnav a").forEach((a) => a.setAttribute("aria-selected", String(a.getAttribute("href") === "#/" + key)));
    cur = { list: [] };
    try { await VIEWS[key](p); }
    catch (e) { say(e.message + (navigator.onLine ? "" : " You are offline: open Downloads."), true); }
  }
  addEventListener("hashchange", route);

  // ---------- actions ----------
  const savePl = () => api(`/playlists/${cur.pl}/tracks`, "PUT", { ids: cur.list.map((t) => t.id) });
  const syncRows = () => view.querySelectorAll(".row").forEach((li) => {
    const t = cur.list[+li.dataset.i];
    if (!t) return;
    li.querySelector('[data-a="dl"]').setAttribute("aria-pressed", String(P.dl.has(t.id)));
    li.querySelector('[data-a="like"]').setAttribute("aria-pressed", String(!!t.liked));
  });

  view.addEventListener("click", guard(async (e) => {
    const b = e.target.closest("[data-a]"), li = e.target.closest(".row");
    const i = li ? +li.dataset.i : -1, t = cur.list[i], a = b?.dataset.a;
    if (!a) { if (t) P.play(cur.list, i); return; }
    if (a === "playall" && cur.list.length) P.play(cur.list, 0);
    else if (a === "shuffle" && cur.list.length) { P.state.shuffle = true; P.play(cur.list, Math.floor(Math.random() * cur.list.length)); }
    else if (a === "dlall") {
      for (const x of cur.list) if (!P.dl.has(x.id)) { say(`Saving ${x.title}…`); await P.dl.add(x); }
      say("All songs are on this device.");
    } else if (a === "like" && t) {
      t.liked = !t.liked; syncRows();
      await api(`/like/${t.id}`, "PUT", { liked: !!t.liked });
    } else if (a === "dl" && t) {
      b.disabled = true;
      try { await (P.dl.has(t.id) ? P.dl.remove(t.id) : P.dl.add(t)); } finally { b.disabled = false; }
    } else if (a === "more" && t) await menu(t);
    else if ((a === "up" || a === "down") && t) {
      const j = a === "up" ? i - 1 : i + 1;
      if (!cur.list[j]) return;
      [cur.list[i], cur.list[j]] = [cur.list[j], cur.list[i]];
      cur.ul.innerHTML = rows(cur.list); await savePl();
    } else if (a === "rm" && t) { cur.list.splice(i, 1); cur.ul.innerHTML = rows(cur.list); await savePl(); }
    else if (a === "newpl") { const n = prompt("Playlist name"); if (n?.trim()) { await api("/playlists", "POST", { name: n }); route(); } }
    else if (a === "rename") { const n = prompt("Rename playlist", cur.name); if (n?.trim()) { await api("/playlists/" + cur.pl, "PATCH", { name: n }); location.hash = "#/songs?" + new URLSearchParams({ pl: cur.pl, name: n.trim() }); } }
    else if (a === "delete" && confirm("Delete this playlist? The songs stay in your library.")) { await api("/playlists/" + cur.pl, "DELETE"); location.hash = "#/playlists"; }
  }));

  async function menu(t) {
    const d = $("#pick"), pls = (await api("/playlists")).items;
    d.innerHTML = `<h3>${esc(t.title)}</h3><button class="btn" data-q>Add to queue</button><h4>Add to playlist</h4>
      ${pls.map((p) => `<button class="btn" data-p="${p.id}">${esc(p.name)}</button>`).join("")}
      <button class="btn primary" data-n>New playlist…</button>
      <h4>File</h4><button class="btn" data-file>Download the file</button><button class="btn" data-rm>Delete from the library</button>
      <button class="btn" data-c>Close</button>`;
    d.onclick = guard(async (e) => {
      const x = e.target.closest("button");
      if (!x) return;
      if (x.dataset.q !== undefined) P.enqueue(t);
      else if (x.dataset.p) await api(`/playlists/${x.dataset.p}/tracks`, "POST", { ids: [t.id] });
      else if (x.dataset.n !== undefined) { const n = prompt("Playlist name"); if (!n?.trim()) return; await api("/playlists", "POST", { name: n, ids: [t.id] }); }
      else if (x.dataset.file !== undefined) location.href = "/api/music/download/" + t.id;
      else if (x.dataset.rm !== undefined) {
        if (!confirm(`Delete “${t.title}” from the music folder? This cannot be undone.`)) return;
        if (P.dl.has(t.id)) await P.dl.remove(t.id);
        await api(`/track/${t.id}`, "DELETE");
        d.close();
        say(`Deleted “${t.title}”.`);
        route();
        return;
      }
      d.close();
    });
    d.showModal();
  }

  // ---------- upload ----------
  $("#upload").addEventListener("click", () => $("#up").click());
  $("#up").addEventListener("change", guard(async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    let done = 0;
    const failed = [];
    for (const [i, f] of files.entries()) {
      say(`Uploading ${f.name} (${i + 1} of ${files.length})…`);
      const fd = new FormData();
      fd.append("file", f, f.name);
      try {
        const r = await fetch("/api/music/upload", { method: "POST", body: fd, credentials: "same-origin" });
        if (r.status === 401) return location.reload();
        if (r.ok) done++;
        else failed.push(`${f.name}: ${(await r.json().catch(() => ({}))).error || "upload failed (" + r.status + ")"}`);
      } catch { failed.push(`${f.name}: the connection was lost`); }
    }
    say((done ? `Uploaded ${done} song${done === 1 ? "" : "s"}. ` : "") + failed.join(" "), failed.length > 0);
    if (done) route();
  }));

  // ---------- search, scan, player events ----------
  let timer;
  $("#q").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { const v = e.target.value.trim(); location.replace(v ? "#/search?q=" + encodeURIComponent(v) : "#/home"); }, 150);
  });
  async function watchScan() {
    let was = false;
    for (;;) {
      const s = await api("/status");
      if (s.error) return say(s.error, true);
      if (!s.running) break;
      was = true; say(`Scanning the library… ${s.seen} files`);
      await new Promise((r) => setTimeout(r, 1500));
    }
    say("");
    if (was) route();
  }
  $("#scan").addEventListener("click", guard(async () => { await api("/scan", "POST"); await watchScan(); }));
  P.on((e) => {
    if (e === "track") view.querySelectorAll(".row").forEach((li) => li.classList.toggle("on", P.cur()?.id === +li.dataset.id));
    else if (e === "dl") { if (location.hash.startsWith("#/downloads")) route(); else syncRows(); }
  });

  if (!navigator.onLine && !location.hash) location.hash = "#/downloads";
  route();
  if (navigator.onLine) guard(watchScan)();
})();
