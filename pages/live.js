// Page script for pages/live.html: one shared room. Text chat is always on; people can also join the
// voice channel. Chat, presence and connection setup go through the server (chat.py); voice and screen
// shares flow directly between browsers (WebRTC, one connection per pair of people in voice).
// The drawing board (live-board.js, board.py) uses the same connection: this script hands it the events it needs
// (live:welcome, live:leave, live:disconnect, live:chat, live:bop, live:blive) and window.Live.
(function () {
  const $ = (s) => document.querySelector(s);
  const ICE = [{ urls: "stun:stun.l.google.com:19302" }];
  const media = navigator.mediaDevices;
  const canSink = "setSinkId" in HTMLMediaElement.prototype;
  const status = $("#status"), logEl = $("#log"), stageEl = $("#stage");
  const users = new Map(), peers = new Map(), shots = new Map(), meters = new Map();
  const store = {
    get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };
  let es = null, me = "", key = "", myName = store.get("chat-name"), retry = null, ac = null, outbox = Promise.resolve();
  let inVoice = false, mic = null, micTrack = null, screen = null, muted = false, deafened = false;
  let inputId = store.get("chat-input"), outputId = store.get("chat-output"), volume = 1;

  // What the board needs to know about the room.
  window.Live = { me: () => me, key: () => key, name: () => myName, user: (id) => users.get(id) };
  const fire = (name, detail) => document.dispatchEvent(new CustomEvent("live:" + name, { detail }));

  if (!window.isSecureContext) $("#secure-warn").hidden = false;
  const say = (text, error) => { status.textContent = text; status.classList.toggle("error", !!error); };
  const run = (fn) => async (...a) => {
    try { await fn(...a); } catch (err) { say(err.message || String(err), true); }
  };
  const initials = (name) => (name.replace(/\W/g, "").slice(0, 2) || "?").toUpperCase();

  // Messages to the server, kept in order so an offer never overtakes its ICE candidates.
  function send(type, data, to) {
    const body = JSON.stringify({ from: me, key, to, type, data });
    const p = outbox
      .then(() => fetch("/api/chat/send", { method: "POST", headers: { "Content-Type": "application/json" }, body }))
      .catch(() => null);
    outbox = p;
    return p;
  }

  // ---------- chat ----------
  function addLine(li) { logEl.append(li); logEl.scrollTop = logEl.scrollHeight; }
  function note(text) {
    const li = document.createElement("li");
    li.className = "sys"; li.textContent = text; addLine(li);
  }
  function chatLine(m) {
    const li = document.createElement("li");
    if (m.from === me) li.className = "mine";
    const b = document.createElement("b"), t = document.createElement("time");
    b.textContent = m.name;
    t.textContent = new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    li.append(b, t, document.createElement("br"), document.createTextNode(m.text));
    addLine(li);
  }
  $("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("#msg").value.trim();
    if (text && me) { send("chat", text); $("#msg").value = ""; }
  });

  // ---------- members and controls ----------
  function member(u, inVoiceList) {
    const li = document.createElement("li");
    li.className = "member"; li.dataset.uid = u.id;
    const av = document.createElement("span"), nm = document.createElement("span");
    av.className = "avatar"; av.textContent = initials(u.name);
    nm.className = "mname"; nm.textContent = u.name + (u.id === me ? " (you)" : "");
    li.append(av, nm);
    if (inVoiceList) {
      const add = (text, cls) => { const s = document.createElement("span"); s.className = "badge " + (cls || ""); s.textContent = text; li.append(s); };
      if (u.sharing) add("LIVE", "live");
      if (u.deafened) add("🔕"); else if (u.muted) add("🔇");
    }
    return li;
  }
  function render() {
    const all = [...users.values()];
    $("#voice-list").replaceChildren(...all.filter((u) => u.voice).map((u) => member(u, true)));
    $("#online-list").replaceChildren(...all.map((u) => member(u, false)));
    $("#online-title").textContent = `Online — ${all.length}`;
    const vb = $("#voice-btn");
    vb.textContent = inVoice ? "Leave voice" : "Join voice";
    vb.classList.toggle("danger", inVoice); vb.classList.toggle("primary", !inVoice);
    $("#share").hidden = !inVoice;
    $("#share").textContent = screen ? "Stop sharing" : "Share screen";
    $("#mic").textContent = muted || deafened ? "🔇" : "🎤";
    $("#mic").classList.toggle("off", muted || deafened);
    $("#deaf").textContent = deafened ? "🔕" : "🎧";
    $("#deaf").classList.toggle("off", deafened);
    $("#me-name").textContent = myName;
    $("#me-avatar").textContent = initials(myName);
    $("#me-state").textContent = inVoice ? (deafened ? "Deafened" : muted ? "Muted" : "In voice") : "Not in voice";
  }
  // Apply a local change (voice / mute / deafen / sharing) and tell everyone else.
  function setSelf() {
    const state = { voice: inVoice, muted, deafened, sharing: screen ? screen.id : null };
    const u = users.get(me);
    if (u) Object.assign(u, state);
    render();
    return send("state", state);
  }

  // Speaking indicator: a green ring around the avatar while someone's audio level is above a threshold.
  function meter(stream, key) {
    ac ||= new (window.AudioContext || window.webkitAudioContext)();
    ac.resume?.();
    const an = ac.createAnalyser();
    an.fftSize = 256;
    ac.createMediaStreamSource(stream).connect(an);
    meters.set(key, { an, buf: new Uint8Array(an.fftSize) });
  }
  setInterval(() => {
    for (const [id, m] of meters) {
      m.an.getByteTimeDomainData(m.buf);
      const loud = Math.max(...m.buf.map((v) => Math.abs(v - 128))) > 10;
      $(`#voice-list [data-uid="${id}"]`)?.classList.toggle("speaking", loud);
    }
  }, 120);

  // ---------- screen shares (the stage above the chat) ----------
  function showShot(key, label, stream, local) {
    let s = shots.get(key);
    if (!s) {
      const el = document.createElement("div");
      el.className = "shot";
      el.innerHTML = `<video autoplay playsinline></video><span class="label"></span>`;
      el.addEventListener("dblclick", () => el.requestFullscreen?.());
      s = { el, video: el.querySelector("video"), label: el.querySelector(".label"), local };
      shots.set(key, s);
      stageEl.append(el);
    }
    s.label.textContent = label;
    s.video.srcObject = stream;
    s.video.muted = local || deafened;
    s.video.volume = volume;
    if (outputId && canSink) s.video.setSinkId(outputId).catch(() => {});
    stageEl.hidden = false;
  }
  function dropShot(key) {
    shots.get(key)?.el.remove();
    shots.delete(key);
    stageEl.hidden = !shots.size;
  }

  // ---------- peer connections ("perfect negotiation": either side may offer at any time) ----------
  function addPeer(id) {
    if (peers.has(id)) return;
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const p = { id, pc, polite: me < id, making: false, ignore: false, queue: Promise.resolve(), senders: [], micSender: null, audio: null };
    peers.set(id, p);

    pc.onnegotiationneeded = async () => {
      try {
        p.making = true;
        await pc.setLocalDescription();
        send("signal", { description: pc.localDescription }, id);
      } catch (e) { console.error(e); } finally { p.making = false; }
    };
    pc.onicecandidate = ({ candidate }) => { if (candidate) send("signal", { candidate }, id); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") note(`Could not connect voice to ${users.get(id)?.name || "someone"}. A firewall may be blocking direct connections.`);
    };
    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] || new MediaStream([track]);
      const u = users.get(id);
      if (track.kind === "video" || stream.id === u?.sharing) {
        showShot("screen:" + id, `${u?.name || "Someone"}'s screen`, stream, false);
        return;
      }
      p.audio ||= new Audio();
      Object.assign(p.audio, { autoplay: true, srcObject: stream, volume, muted: deafened });
      if (outputId && canSink) p.audio.setSinkId(outputId).catch(() => {});
      meter(stream, id);
    };

    if (micTrack) p.micSender = pc.addTrack(micTrack, mic);
    else pc.addTransceiver("audio", { direction: "recvonly" });         // listen-only still hears everyone
    if (screen) screen.getTracks().forEach((t) => p.senders.push(pc.addTrack(t, screen)));
  }
  function removePeer(id) {
    const p = peers.get(id);
    if (!p) return;
    p.pc.close();
    if (p.audio) p.audio.srcObject = null;
    peers.delete(id);
    meters.delete(id);
    dropShot("screen:" + id);
  }
  // While I am in voice, I hold a connection to every other person who is in voice, and to nobody else.
  function syncPeers() {
    const want = new Set(inVoice ? [...users.values()].filter((u) => u.voice && u.id !== me).map((u) => u.id) : []);
    want.forEach(addPeer);
    [...peers.keys()].filter((id) => !want.has(id)).forEach(removePeer);
  }
  async function handleSignal(p, { description, candidate }) {
    const pc = p.pc;
    try {
      if (description) {
        const collision = description.type === "offer" && (p.making || pc.signalingState !== "stable");
        p.ignore = !p.polite && collision;
        if (p.ignore) return;
        await pc.setRemoteDescription(description);
        if (description.type === "offer") {
          await pc.setLocalDescription();
          send("signal", { description: pc.localDescription }, p.id);
        }
      } else if (candidate) {
        try { await pc.addIceCandidate(candidate); } catch (e) { if (!p.ignore) throw e; }
      }
    } catch (e) { console.error(e); }
  }

  // ---------- microphone, devices, volume ----------
  async function getMic() {
    if (!media?.getUserMedia) throw new Error("no media");
    const stream = await media.getUserMedia({
      audio: { deviceId: inputId ? { exact: inputId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    refreshDevices();
    return stream;
  }
  const applyMic = () => { if (micTrack) micTrack.enabled = !muted && !deafened; };
  function applyOutput() {
    const targets = [...peers.values()].map((p) => p.audio).filter(Boolean).concat([...shots.values()].map((s) => s.video));
    targets.forEach((el) => {
      el.volume = volume;
      if (outputId && canSink) el.setSinkId(outputId).catch(() => {});
    });
  }
  function applyDeaf() {
    peers.forEach((p) => { if (p.audio) p.audio.muted = deafened; });
    shots.forEach((s) => { if (!s.local) s.video.muted = deafened; });
  }
  async function refreshDevices() {
    if (!media?.enumerateDevices) return;
    const list = (await media.enumerateDevices()).filter((d) => d.deviceId !== "default" && d.deviceId !== "communications");
    const fill = (sel, kind, current, label) => {
      const items = list.filter((d) => d.kind === kind);
      sel.replaceChildren(new Option("System default", ""), ...items.map((d, i) => new Option(d.label || `${label} ${i + 1}`, d.deviceId)));
      sel.value = current;
    };
    fill($("#in-dev"), "audioinput", inputId, "Microphone");
    fill($("#out-dev"), "audiooutput", outputId, "Speaker");
  }
  media?.addEventListener?.("devicechange", refreshDevices);

  // ---------- voice channel ----------
  async function joinVoice() {
    if (!me) throw new Error("Not connected yet.");
    let micNote = "";
    try {
      mic = await getMic();
      micTrack = mic.getAudioTracks()[0];
      meter(mic, me);
    } catch {
      mic = micTrack = null;
      micNote = "No microphone available (permission denied, or this page isn't on https or localhost). You can listen but not talk.";
    }
    inVoice = true;
    applyMic();
    const res = await setSelf();
    if (res && res.status === 409) { await leaveVoice(); throw new Error("The voice channel is full (8 people)."); }
    syncPeers();
    if (micNote) note(micNote);
  }
  async function leaveVoice() {
    stopShare();
    inVoice = false;
    [...peers.keys()].forEach(removePeer);
    mic?.getTracks().forEach((t) => t.stop());
    mic = micTrack = null;
    meters.delete(me);
    return setSelf();
  }
  $("#voice-btn").addEventListener("click", run(() => (inVoice ? leaveVoice() : joinVoice())));

  $("#mic").addEventListener("click", () => { muted = !muted; applyMic(); setSelf(); });
  $("#deaf").addEventListener("click", () => { deafened = !deafened; applyMic(); applyDeaf(); setSelf(); });

  const share = run(async () => {
    if (screen) return stopShare();
    if (!media?.getDisplayMedia) throw new Error("Screen sharing needs https:// or localhost and a desktop browser.");
    try {
      screen = await media.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    } catch (err) {
      if (err.name === "NotAllowedError") return say("Screen sharing was cancelled.");
      throw err;
    }
    setSelf();                                                          // announces the stream before its tracks arrive
    peers.forEach((p) => screen.getTracks().forEach((t) => p.senders.push(p.pc.addTrack(t, screen))));
    showShot("screen:me", "Your screen", screen, true);
    screen.getVideoTracks()[0].onended = stopShare;                     // the browser's own "Stop sharing" button
    say("");
  });
  function stopShare() {
    if (!screen) return;
    screen.getTracks().forEach((t) => t.stop());
    peers.forEach((p) => {
      p.senders.forEach((s) => { try { p.pc.removeTrack(s); } catch { /* connection closed */ } });
      p.senders = [];
    });
    screen = null;
    dropShot("screen:me");
    setSelf();
  }
  $("#share").addEventListener("click", share);

  // ---------- settings dialog ----------
  $("#gear").addEventListener("click", () => {
    $("#out-wrap").hidden = !canSink;
    $("#out-note").hidden = canSink;
    refreshDevices();
    $("#settings").showModal();
  });
  $("#in-dev").addEventListener("change", run(async (e) => {
    inputId = e.target.value;
    store.set("chat-input", inputId);
    if (!inVoice) return;
    if (!micTrack) { await leaveVoice(); return joinVoice(); }          // was listen-only: rejoin with the new mic
    const next = await getMic(), track = next.getAudioTracks()[0];
    track.enabled = !muted && !deafened;
    await Promise.all([...peers.values()].map((p) => p.micSender?.replaceTrack(track)));
    mic.getTracks().forEach((t) => t.stop());
    mic = next; micTrack = track;
    meter(mic, me);
  }));
  $("#out-dev").addEventListener("change", (e) => { outputId = e.target.value; store.set("chat-output", outputId); applyOutput(); });
  $("#vol").addEventListener("input", (e) => { volume = e.target.value / 100; applyOutput(); });
  $("#rename").addEventListener("click", () => {
    $("#settings").close();
    disconnect();
    clearTimeout(retry);
    resetLocal();
    fire("disconnect");
    $("#app").hidden = true;
    $("#login").hidden = false;
    $("#name").value = myName;
    $("#name").focus();
  });

  // ---------- connection ----------
  function resetLocal() {
    stopShare();
    inVoice = false;
    [...peers.keys()].forEach(removePeer);
    mic?.getTracks().forEach((t) => t.stop());
    mic = micTrack = null;
    meters.clear();
    users.clear();
    me = key = "";
  }
  function disconnect() {
    if (es) { es.close(); es = null; }
    if (me) navigator.sendBeacon("/api/chat/leave", new Blob([JSON.stringify({ from: me, key })], { type: "application/json" }));
  }
  function connect() {
    clearTimeout(retry);
    es = new EventSource(`/api/chat/events?name=${encodeURIComponent(myName)}`);
    const on = (type, fn) => es.addEventListener(type, (ev) => fn(JSON.parse(ev.data)));

    on("welcome", (d) => {
      me = d.id; key = d.key;
      users.clear();
      d.users.forEach((u) => users.set(u.id, u));
      logEl.replaceChildren();
      d.history.forEach(chatLine);
      $("#login").hidden = true;
      $("#app").hidden = false;
      say("");
      render();
      fire("welcome", { id: me });
    });
    on("join", (u) => { users.set(u.id, u); render(); });
    on("leave", ({ id }) => { users.delete(id); removePeer(id); render(); fire("leave", { id }); });
    on("state", ({ id, ...s }) => {
      const u = users.get(id);
      if (!u) return;
      Object.assign(u, s);
      if (!s.sharing) dropShot("screen:" + id);
      syncPeers();
      render();
    });
    on("chat", (m) => { chatLine(m); if (m.from !== me) fire("chat", m); });
    on("signal", ({ from, data }) => {
      const p = peers.get(from);
      if (p) p.queue = p.queue.then(() => handleSignal(p, data));        // one message at a time per person
    });
    on("bop", (d) => fire("bop", d));                                    // board: a change to the drawing
    on("blive", (d) => fire("blive", d));                                // board: cursors and drawing in progress
    es.onerror = () => {
      if (es) { es.close(); es = null; }
      resetLocal();
      render();
      fire("disconnect");
      say("Disconnected. Reconnecting…", true);
      retry = setTimeout(connect, 3000);
    };
  }

  $("#login").addEventListener("submit", (e) => {
    e.preventDefault();
    myName = $("#name").value.trim().slice(0, 24) || "Guest";
    store.set("chat-name", myName);
    say("Connecting…");
    connect();
  });
  $("#chat-form input").addEventListener("keydown", (e) => e.stopPropagation());
  window.addEventListener("pagehide", disconnect);
  window.addEventListener("pageshow", (e) => {           // restored from the back/forward cache: pagehide closed the connection
    if (!e.persisted || es || $("#app").hidden) return;
    resetLocal();
    render();
    fire("disconnect");
    say("Reconnecting…");
    connect();
  });

  // Start: reconnect straight away if we already know the name, otherwise ask for one.
  if (myName) { say("Connecting…"); connect(); }
  else $("#name").focus();
})();
