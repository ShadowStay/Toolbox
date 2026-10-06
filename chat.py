"""One shared room. Everyone who opens the page is online and in the text chat; people can also join the
voice channel. The server relays chat, keeps presence (who is in voice, muted, deafened, sharing) and passes
WebRTC setup messages. Audio and screens flow directly between browsers. State lives in memory."""
import json
import queue
import re
import secrets
import threading
import time

from flask import Blueprint, Response, abort, request, stream_with_context

bp = Blueprint("chat", __name__)

MAX_USERS = 100
MAX_VOICE = 8          # peer-to-peer mesh: everyone in voice connects to everyone else in voice
HISTORY = 200
LOCK = threading.Lock()
USERS = {}             # id -> {name, q, voice, muted, deafened, sharing}
LOG = []               # chat history


def sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def clean(value, limit):
    return re.sub(r"[\x00-\x1f\x7f]", "", str(value or "")).strip()[:limit]


def public(uid, u):
    return {"id": uid, **{k: u[k] for k in ("name", "voice", "muted", "deafened", "sharing")}}


def deliver(event, data, to=None, exclude=None):
    with LOCK:
        targets = [u["q"] for uid, u in USERS.items() if (uid == to if to else uid != exclude)]
    for q in targets:
        q.put(sse(event, data))


@bp.get("/api/chat/events")
def events():
    name = clean(request.args.get("name"), 24) or "Guest"
    uid, q = secrets.token_hex(4), queue.Queue()
    with LOCK:
        if len(USERS) >= MAX_USERS:
            abort(429)
        USERS[uid] = {"name": name, "q": q, "voice": False, "muted": False, "deafened": False, "sharing": None}
        users = [public(i, u) for i, u in USERS.items()]
        history = list(LOG)
    q.put(sse("welcome", {"id": uid, "users": users, "history": history}))
    deliver("join", public(uid, USERS[uid]), exclude=uid)

    def stream():
        try:
            while True:
                try:
                    msg = q.get(timeout=10)
                except queue.Empty:
                    yield ": ping\n\n"      # keeps the connection open and detects dead clients
                    continue
                if msg is None:             # explicit leave
                    return
                yield msg
        finally:
            with LOCK:
                removed = USERS.pop(uid, None)
            if removed:
                deliver("leave", {"id": uid})

    return Response(stream_with_context(stream()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@bp.post("/api/chat/send")
def send():
    body = request.get_json(silent=True) or {}
    sender, kind, to, data = body.get("from"), body.get("type"), body.get("to"), body.get("data")
    if kind not in ("chat", "signal", "state"):
        abort(400)
    with LOCK:
        user = USERS.get(sender)
    if not user:
        abort(404)

    if kind == "chat":
        text = clean(data, 1000)
        if not text:
            abort(400)
        msg = {"from": sender, "name": user["name"], "text": text, "ts": int(time.time() * 1000)}
        with LOCK:
            LOG.append(msg)
            del LOG[:-HISTORY]
        deliver("chat", msg)

    elif kind == "state":
        s = data if isinstance(data, dict) else {}
        voice = bool(s.get("voice"))
        new = {"voice": voice, "muted": bool(s.get("muted")), "deafened": bool(s.get("deafened")),
               "sharing": (clean(s.get("sharing"), 64) or None) if voice else None}
        with LOCK:
            if voice and not user["voice"] and sum(u["voice"] for u in USERS.values()) >= MAX_VOICE:
                abort(409)                  # voice channel is full
            user.update(new)
        deliver("state", {"id": sender, **new}, exclude=sender)

    else:                                    # signal: WebRTC offer / answer / ICE candidate for one person
        if not to or len(json.dumps(data)) > 60000:
            abort(400)
        deliver("signal", {"from": sender, "data": data}, to=to)
    return "", 204


@bp.post("/api/chat/leave")
def leave():
    sender = (request.get_json(silent=True) or {}).get("from")
    with LOCK:
        user = USERS.get(sender)
    if user:
        user["q"].put(None)
    return "", 204
