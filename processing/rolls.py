"""Shared dice log of the Tabletop page. The server rolls the dice (so a roll cannot be made up in the browser) and keeps
the last rolls of each campaign in memory; every browser on the page asks for the new ones every couple of seconds.
The log is gone when the server restarts.

  POST /api/rolls   {expr, name, label?} -> the roll   expr like "d100", "2d6+3", "d10-1" or, as on the sheet, "1k10+2";
                                several terms are fine too: "d100+1d4-k5+2" (dice and whole numbers, each with + or -)
                                (k is the same as d); name = who rolled (a character's name); label = what was rolled (a weapon)
  GET  /api/rolls?after=<id> -> {rolls: [newer than id, oldest first], last, reset}
                                reset is true when `after` is newer than anything here (the server restarted): the
                                rolls sent are then the whole log, and the page should drop what it showed.
A roll is {id, ts, name, label, expr, dice: [..], mod, total, role, parts: [{sign, n, sides, dice}]}."""
import random
import re
import threading
import time

from flask import jsonify, request

from .campaigns import current_id
from .errors import Fail
from . import bp
from .roles import current_role

KEEP = 100
TERM = re.compile(r"\s*([+-])?\s*(?:(\d{0,3})\s*[dk]\s*(\d{1,4})|(\d{1,6}))\s*", re.I)   # one term: dice or a whole number
MAX_TERMS = 12
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


def parse_expr(expr):
    """"d100+1k4-k5+2" -> ([(sign, dice, sides), ...], flat). Raises Fail when it is not a sum of dice and whole numbers."""
    text, pos, dice, flat = str(expr), 0, [], 0
    while pos < len(text):
        m = TERM.match(text, pos)
        if not m or m.end() == pos or (pos and not m.group(1)) or len(dice) + 1 > MAX_TERMS:
            raise Fail("Use a roll like d100, 2d6+3, d10-1, 1k10+2 or d100+k4-2.")
        sign = -1 if m.group(1) == "-" else 1
        if m.group(3):
            dice.append((sign, int(m.group(2) or 1), int(m.group(3))))
        else:
            flat += sign * int(m.group(4))
        pos = m.end()
    if not dice:
        raise Fail("Use a roll like d100, 2d6+3, d10-1, 1k10+2 or d100+k4-2.")
    return dice, flat


def make_roll(expr, name="", label=""):
    """Roll an expression like "2d6+3" (or "1k10+2", or "d100+k4-2") for someone, put it in this campaign's log and return it."""
    terms, mod = parse_expr(expr)
    if sum(n for _, n, _ in terms) > 100 or any(n < 1 or sides < 2 for _, n, sides in terms):
        raise Fail("Roll 1 to 100 dice with at least 2 sides.")
    parts = [{"sign": sign, "n": n, "sides": sides, "dice": [_dice.randint(1, sides) for _ in range(n)]} for sign, n, sides in terms]
    dice = [v for part in parts for v in part["dice"]]
    total = sum(part["sign"] * sum(part["dice"]) for part in parts) + mod
    shown = "".join((("-" if sign < 0 else "+") if i else ("-" if sign < 0 else "")) + f"{n}d{sides}" for i, (sign, n, sides) in enumerate(terms))
    clean = lambda v: " ".join(re.sub(r"[\x00-\x1f\x7f]", "", str(v or "")).split())[:40]
    name, label = clean(name), clean(label)
    with _lock:
        log = _log()
        log["last"] += 1
        roll = {"id": log["last"], "ts": int(time.time() * 1000), "name": name or "Someone", "label": label,
                "expr": shown + (f"{mod:+d}" if mod else ""), "dice": dice, "mod": mod,
                "total": total, "role": current_role(), "parts": parts}
        log["rolls"].append(roll)
        del log["rolls"][:-KEEP]
    return roll


@bp.post("/rolls")
def rolls_add():
    d = request.get_json(silent=True) or {}
    return jsonify(make_roll(d.get("expr", ""), d.get("name"), d.get("label")))
