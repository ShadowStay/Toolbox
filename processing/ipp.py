"""A very small IPP (Internet Printing Protocol) client, just enough to talk to CUPS over HTTP without cups-client, pycups
or any other package. CUPS listens on port 631 (here: the "cups" docker container publishes it on the host).
  request(op, operation_attrs, job_attrs, data) builds a request   send(url, payload) posts it and returns (status, groups)
A group is (tag, {attribute name: [values]}); tag 0x04 = printer attributes, 0x06 = job attributes."""
import base64
import struct
import urllib.error
import urllib.request

PRINT_JOB, CANCEL_JOB, GET_JOBS, CUPS_GET_PRINTERS = 0x0002, 0x0008, 0x000A, 0x4002


class IppError(Exception):
    """Something the person can be told: CUPS is unreachable, refused the job, ..."""


def _attr(tag, name, value):
    n = name.encode()
    return struct.pack(">BH", tag, len(n)) + n + struct.pack(">H", len(value)) + value


def _many(tag, name, values):
    return b"".join(_attr(tag, name if i == 0 else "", v.encode("utf-8")) for i, v in enumerate(values))


def charset(): return _many(0x47, "attributes-charset", ["utf-8"])
def language(): return _many(0x48, "attributes-natural-language", ["en"])
def uri(name, v): return _many(0x45, name, [v])
def name_(name, v): return _many(0x42, name, [v[:255]])
def mime(name, v): return _many(0x49, name, [v])
def keyword(name, *values): return _many(0x44, name, values)
def integer(name, v): return _attr(0x21, name, struct.pack(">i", v))
def ranges(name, pairs):
    return b"".join(_attr(0x33, name if i == 0 else "", struct.pack(">ii", lo, hi)) for i, (lo, hi) in enumerate(pairs))


def request(op, operation, job=b"", data=b"", rid=1):
    out = struct.pack(">HHI", 0x0101, op, rid) + b"\x01" + charset() + language() + operation
    if job:
        out += b"\x02" + job
    return out + b"\x03" + data


def _value(tag, raw):
    if tag in (0x21, 0x23):
        return int.from_bytes(raw, "big", signed=True)
    if tag == 0x22:
        return bool(raw and raw[0])
    if tag == 0x33 and len(raw) == 8:
        return struct.unpack(">ii", raw)
    if 0x40 <= tag <= 0x4F:
        return raw.decode("utf-8", "replace")
    return raw


def parse(buf):
    """-> (status code, [(group tag, {name: [values]})])"""
    if len(buf) < 9:
        raise IppError("CUPS sent an answer that could not be read.")
    status, pos, groups, cur, last = struct.unpack(">H", buf[2:4])[0], 8, [], None, None
    try:
        while pos < len(buf):
            tag = buf[pos]
            pos += 1
            if tag == 0x03:
                break
            if tag < 0x10:                                   # a delimiter: a new group of attributes starts
                cur = {}
                groups.append((tag, cur))
                continue
            (nl,) = struct.unpack(">H", buf[pos:pos + 2]); pos += 2
            if nl:
                last = buf[pos:pos + nl].decode(); pos += nl
            (vl,) = struct.unpack(">H", buf[pos:pos + 2]); pos += 2
            raw = buf[pos:pos + vl]; pos += vl
            if cur is not None and last:
                cur.setdefault(last, []).append(_value(tag, raw))
    except (struct.error, UnicodeDecodeError):
        raise IppError("CUPS sent an answer that could not be read.")
    return status, groups


def send(url, payload, user="", password="", timeout=60):
    headers = {"Content-Type": "application/ipp"}
    if user:
        headers["Authorization"] = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status, groups = parse(r.read())
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise IppError("CUPS asked for a login. Set CUPS_USER and CUPS_PASSWORD for the app.")
        raise IppError(f"CUPS answered with HTTP {e.code}.")
    except (urllib.error.URLError, OSError):
        raise IppError("Could not reach CUPS. Is the cups container running, and is CUPS_URL right?")
    if status >= 0x0400:
        msg = next((g[1].get("status-message", [""])[0] for g in groups if g[0] == 0x01 and "status-message" in g[1]), "")
        raise IppError(f"The print system refused that ({msg or hex(status)}).")
    return status, groups
