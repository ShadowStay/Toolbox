"""Server statistics for the home page.
  GET /api/system -> {host, os, python, uptime, cpu: {percent, cores: [..], count, freq, load}, memory, swap, disks: [..],
                      temps: [{name, c}], temp_main, net: {rx, tx, rx_total, tx_total}, process: {rss}}
Needs psutil. The password gate already covers /api/, so only signed-in people can read it (the home page itself is public,
which is why the panel on it is hidden for visitors who are not signed in). Everything that needs two samples (CPU load,
network speed) is measured at most once per second and shared by every request, so many open tabs cost nothing extra."""
import os
import platform
import socket
import threading
import time
from pathlib import Path

import psutil
from flask import jsonify

from . import BASE, bp

_lock = threading.Lock()
_state = {"at": 0.0, "cores": [], "cpu": 0.0, "net": None, "rx": 0.0, "tx": 0.0}
psutil.cpu_percent(percpu=True)             # the first reading is meaningless; this primes the counters
_main_hint = ("cpu", "core", "package", "tctl", "k10temp", "soc", "thermal")


def _sample():
    now = time.monotonic()
    with _lock:
        dt = now - _state["at"]
        if _state["at"] and dt < 1:
            return
        cores = psutil.cpu_percent(interval=None, percpu=True)
        net = psutil.net_io_counters()
        if net and _state["net"] and dt > 0:
            _state["tx"] = max(0.0, (net.bytes_sent - _state["net"][0]) / dt)
            _state["rx"] = max(0.0, (net.bytes_recv - _state["net"][1]) / dt)
        _state.update(at=now, cores=cores, cpu=sum(cores) / len(cores) if cores else 0.0,
                      net=(net.bytes_sent, net.bytes_recv) if net else None)


def _temps():
    out = []
    try:
        found = psutil.sensors_temperatures()
    except (AttributeError, OSError):
        found = {}
    for chip, entries in found.items():
        for e in entries:
            if e.current is not None and -50 < e.current < 150:
                out.append({"name": f"{chip} {e.label}".strip(), "c": round(e.current, 1)})
    if not out:                              # some boards (and containers) only expose the thermal zones
        for zone in sorted(Path("/sys/class/thermal").glob("thermal_zone*")):
            try:
                c = int((zone / "temp").read_text()) / 1000
                name = (zone / "type").read_text().strip() if (zone / "type").exists() else zone.name
            except (OSError, ValueError):
                continue
            if -50 < c < 150:
                out.append({"name": name, "c": round(c, 1)})
    return out[:8]


def _mount_of(path):
    best = ""
    for part in psutil.disk_partitions(all=False):
        mp = part.mountpoint
        if str(path).startswith(mp) and len(mp) > len(best):
            best = mp
    return best or str(path)


def _disks():
    out, seen = [], set()
    for path in (Path(BASE.anchor or "/"), BASE):         # the system disk, and the disk the project (and data/) lives on
        try:
            dev = os.stat(path).st_dev
            u = psutil.disk_usage(str(path))
        except OSError:
            continue
        if dev in seen:
            continue
        seen.add(dev)
        out.append({"name": _mount_of(path), "total": u.total, "used": u.used, "free": u.free, "percent": u.percent})
    return out


@bp.get("/system")
def system_stats():
    _sample()
    vm, sw = psutil.virtual_memory(), psutil.swap_memory()
    freq = psutil.cpu_freq()
    try:
        load = [round(x, 2) for x in os.getloadavg()]
    except (AttributeError, OSError):
        load = None
    temps = _temps()
    main = next((t for t in temps if any(h in t["name"].lower() for h in _main_hint)), None) or max(temps, key=lambda t: t["c"], default=None)
    net = psutil.net_io_counters()
    resp = jsonify(
        host=socket.gethostname(), os=f"{platform.system()} {platform.release()}", python=platform.python_version(),
        uptime=int(time.time() - psutil.boot_time()),
        cpu={"percent": round(_state["cpu"], 1), "cores": [round(c, 1) for c in _state["cores"]], "count": psutil.cpu_count(logical=True),
             "physical": psutil.cpu_count(logical=False), "freq": round(freq.current) if freq and freq.current else None, "load": load},
        memory={"total": vm.total, "used": vm.total - vm.available, "percent": round((vm.total - vm.available) / vm.total * 100, 1)},
        swap={"total": sw.total, "used": sw.used, "percent": sw.percent},
        disks=_disks(), temps=temps, temp_main=main,
        net={"rx": round(_state["rx"]), "tx": round(_state["tx"]), "rx_total": net.bytes_recv if net else 0, "tx_total": net.bytes_sent if net else 0},
        process={"rss": psutil.Process().memory_info().rss},
    )
    resp.headers["Cache-Control"] = "no-store"
    return resp
