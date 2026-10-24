"""Shared dice log of the Tabletop page. The server rolls the dice (so a roll cannot be made up in the browser) and keeps
the last rolls of each campaign in memory; every browser on the page asks for the new ones every couple of seconds.
The log is gone when the server restarts.

  POST /api/rolls   {expr, name} -> the roll   expr like "d100", "2d6+3" or "d10-1"; name = who rolled (a character's name)
  GET  /api/rolls?after=<id> -> {rolls: [newer than id, oldest first], last, reset}
                                reset is true when `after` is newer than anything here (the server restarted): the
                                rolls sent are then the whole log, and the page should drop what it showed.
A roll is {id, ts, name, expr, dice: [..], mod, total, role}."""
import random
import re
import threading
import time

from flask import jsonify, request

from .campaigns import current_id
from .core import Fail, bp
from .roles import current_role

KEEP = 100
EXPR = re.compile(r"^\s*(\d{0,3})d(\d{1,4})\s*([+-]\s*\d{1,6})?\s*$", re.I)
_dice = random.SystemRandom()
_lock = threading.Lock()
_logs = {}                       # campaign id -> {"last": id of the newest roll, "rolls": [...]}


def _log():
    return _logs.setdefault(current_id(), {"last": 0, "rolls": []})


@bp.get("/rolls")
def rolls_get():
    try:
        after = max(0, int(request.args.get("after", 0)))
    except ValueError:
        after = 0
    with _lock:
        log = _log()
        reset = after > log["last"]
        rolls = log["rolls"] if reset else [r for r in log["rolls"] if r["id"] > after]
        return jsonify(rolls=rolls, last=log["last"], reset=reset)


@bp.post("/rolls")
def rolls_add():
    d = request.get_json(silent=True) or {}
    m = EXPR.match(str(d.get("expr", "")))
    if not m:
        raise Fail("Use a roll like d100, 2d6+3 or d10-1.")
    n, sides = int(m.group(1) or 1), int(m.group(2))
    if not 1 <= n <= 100 or sides < 2:
        raise Fail("Roll 1 to 100 dice with at least 2 sides.")
    mod = int(m.group(3).replace(" ", "")) if m.group(3) else 0
    dice = [_dice.randint(1, sides) for _ in range(n)]
    name = " ".join(re.sub(r"[\x00-\x1f\x7f]", "", str(d.get("name") or "")).split())[:40]
    with _lock:
        log = _log()
        log["last"] += 1
        roll = {"id": log["last"], "ts": int(time.time() * 1000), "name": name or "Someone",
                "expr": f"{n}d{sides}{mod:+d}" if mod else f"{n}d{sides}", "dice": dice, "mod": mod,
                "total": sum(dice) + mod, "role": current_role()}
        log["rolls"].append(roll)
        del log["rolls"][:-KEEP]
    return jsonify(roll)
