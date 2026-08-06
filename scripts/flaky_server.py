#!/usr/bin/env python3
"""A deliberately unreliable static file server, for testing db-cache.js.

It serves web/ over HTTP with real Range support, and can be told to break in
the ways that actually happen on a five-minute download from Zenodo — or behind
a corporate proxy, a captive portal, or a multi-backend CDN:

  --cut-every N     every Nth request for the target file, send only part of
                    the body and then slam the socket shut (no FIN with the
                    right length: the client sees a truncated stream, which is
                    what a dropped wifi connection looks like to fetch()).
  --fail-every N    every Nth request for the target file, answer 503.
  --no-head         answer HEAD with 405 (hosts that only do GET).
  --no-ranges       ignore Range entirely: always 200 with the whole file, from
                    byte 0. A resume that keeps writing at its old offset
                    silently appends a second copy of the file.
  --ranges-until N  honour Range for the first N requests, then behave like
                    --no-ranges. This is the proxy/captive-portal case, and the
                    one that arms the bug: the client has already written a
                    prefix when the server stops honouring Range.
  --empty-every N   every Nth request, answer 206 with Content-Length: 0 and no
                    body. A perfectly valid, perfectly successful response
                    carrying nothing — exactly what a connection cut right after
                    the headers produces. A client that does not count it as a
                    failure spins on it for ever.
  --shift-range N   every Nth Range request is answered with a DIFFERENT
                    interval (always the first slice), honestly declared in
                    Content-Range. A CDN that clamps ranges, or a cache serving
                    another variant. Written at the offset that was asked for,
                    it produces a file of plausible length and wrong contents.
  --no-last-modified  send no Last-Modified (and no ETag): nothing but the
                    length is left to tell two versions of the file apart.
  --alt PATH / --alt-after N
                    after N requests for the target, serve PATH instead (same
                    length, different bytes, different Last-Modified): the file
                    was republished mid-download.

Both counters cover only the target path (--target, default the .syldb), so the
page, its modules and the wasm package always load cleanly and the only thing
under test is the database download.

Every request is logged as one JSON object per line to --log, including the
Range header and how many bytes were really written. That log is the evidence
for "one download with a pool of 4": count the bytes served for the target.

    python3 flaky_server.py --root web --port 8811 --log /tmp/x.jsonl \
        --target /db/gut_mini.syldb --cut-every 3

POST /_report  appends its body to --log as {"report": ...} — the browser side
of the test uses it to hand results back.
GET  /_reset   zeroes the fault counters and truncates the log.
"""

import argparse
import json
import mimetypes
import os
import posixpath
import re
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

STATE = {
    "root": ".",
    "target": None,
    "cut_every": 0,
    "cut_at": 0.4,       # fraction of the requested slice to deliver before cutting
    "fail_every": 0,
    "n_target": 0,       # requests seen for the target path
    "log": None,
    "lock": threading.Lock(),
    "delay": 0.0,
    "no_head": False,
    "no_ranges": False,
    "ranges_until": None,
    "empty_every": 0,
    "shift_range": 0,
    "no_last_modified": False,
    "alt": None,
    "alt_after": 0,
    "honour_if_range": False,
}


def logline(obj):
    obj["t"] = round(time.time(), 3)
    with STATE["lock"]:
        with open(STATE["log"], "a") as f:
            f.write(json.dumps(obj) + "\n")


RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")

# instantiateStreaming refuses anything that is not application/wasm, and the
# platform mimetypes table does not always know about it.
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "flaky/1.0"

    def log_message(self, *a):
        pass  # everything worth keeping goes to the JSON log

    # ---- helpers ----
    def _path(self):
        p = urlparse(self.path).path
        p = posixpath.normpath(unquote(p))
        while p.startswith("/"):
            p = p[1:]
        full = os.path.join(STATE["root"], p)
        return urlparse(self.path).path, full

    def _send_headers(self, code, headers, body_len):
        self.send_response(code)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(body_len))
        self.end_headers()

    # ---- verbs ----
    def do_POST(self):
        if urlparse(self.path).path == "/_report":
            n = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(n).decode("utf8", "replace")
            try:
                payload = json.loads(body)
            except Exception:
                payload = body
            logline({"report": payload})
            self._send_headers(200, {"Content-Type": "text/plain",
                                     "Access-Control-Allow-Origin": "*"}, 2)
            self.wfile.write(b"ok")
            return
        self._send_headers(404, {}, 0)

    def do_HEAD(self):
        self._serve(head_only=True)

    def do_GET(self):
        if urlparse(self.path).path == "/_reset":
            STATE["n_target"] = 0
            open(STATE["log"], "w").close()
            self._send_headers(200, {"Content-Type": "text/plain"}, 2)
            self.wfile.write(b"ok")
            return
        self._serve(head_only=False)

    def _serve(self, head_only):
        urlpath, full = self._path()
        is_target = STATE["target"] is not None and urlpath == STATE["target"]
        rng = self.headers.get("Range")

        if not os.path.isfile(full):
            logline({"path": urlpath, "status": 404, "range": rng})
            self._send_headers(404, {}, 0)
            return

        if is_target and head_only and STATE["no_head"]:
            logline({"path": urlpath, "status": 405, "range": rng, "head": True,
                     "fault": "no-head"})
            self._send_headers(405, {"Access-Control-Allow-Origin": "*"}, 0)
            return

        n = 0
        fault = None
        if is_target:
            with STATE["lock"]:
                STATE["n_target"] += 1
                n = STATE["n_target"]
            if STATE["fail_every"] and n % STATE["fail_every"] == 0:
                fault = "503"
            elif STATE["empty_every"] and not head_only and n % STATE["empty_every"] == 0:
                fault = "empty"
            elif STATE["shift_range"] and rng and n % STATE["shift_range"] == 0:
                fault = "shift"
            elif STATE["cut_every"] and n % STATE["cut_every"] == 0:
                fault = "cut"

        # Republished mid-download: same length, other bytes, other Last-Modified.
        if is_target and STATE["alt"] and STATE["alt_after"] and n > STATE["alt_after"]:
            full = STATE["alt"]
            fault = fault or "alt"

        size = os.path.getsize(full)
        mtime = os.path.getmtime(full)
        last_mod = time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime(mtime))
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"

        # A host that does not do ranges at all, or one that stops honouring them
        # partway (a proxy kicking in, a captive portal). Either way the answer is
        # 200 and the WHOLE file from byte 0, which is the answer a resuming
        # client must not write at its old offset.
        # The conforming answer to a stale If-Range: forget the Range and send the
        # whole current file, so the client can never splice two versions.
        if_range = self.headers.get("If-Range")
        stale_if_range = bool(
            is_target and STATE["honour_if_range"] and if_range and if_range != last_mod)

        ignore_range = is_target and (
            stale_if_range
            or STATE["no_ranges"]
            or (STATE["ranges_until"] is not None and n > STATE["ranges_until"]))
        eff_rng = None if ignore_range else rng

        if fault == "503":
            logline({"path": urlpath, "status": 503, "range": rng, "fault": "503",
                     "n": STATE["n_target"], "sent": 0})
            self._send_headers(503, {"Access-Control-Allow-Origin": "*"}, 0)
            return

        start, end = 0, size - 1
        status = 200
        if eff_rng:
            m = RANGE_RE.match(eff_rng.strip())
            if m:
                s, e = m.group(1), m.group(2)
                if s == "":                     # suffix range
                    start = max(0, size - int(e))
                    end = size - 1
                else:
                    start = int(s)
                    end = int(e) if e else size - 1
                end = min(end, size - 1)
                if start > end or start >= size:
                    self._send_headers(416, {"Content-Range": f"bytes */{size}"}, 0)
                    logline({"path": urlpath, "status": 416, "range": rng})
                    return
                status = 206

        # A 206 answering an interval nobody asked for, declared honestly in
        # Content-Range. Same-origin the client can read that header and refuse
        # the slice; cross-origin (Zenodo) it cannot, which is why the client also
        # refuses to write past the declared size.
        # Honest to the letter and useless in practice: the right offset, a
        # truthful Content-Range, and `drip` bytes of progress per request. No
        # error is ever raised, so a retry budget that only counts FAILURES
        # never fires — 433 MB one byte at a time is 454 million requests, with
        # a progress bar that keeps insisting it is moving.
        drip = STATE.get("drip") or 0
        if drip and status == 206:
            end = min(end, start + drip - 1)

        if fault == "shift" and status == 206:
            asked = end - start + 1
            start = 0
            end = min(STATE.get("shift_len") or asked, size) - 1

        length = end - start + 1
        headers = {
            "Content-Type": ctype,
            "Last-Modified": last_mod,
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "Content-Range, Content-Length, Last-Modified, ETag",
            # No Cache-Control and no ETag on purpose: that is exactly what
            # Zenodo does, and the whole point of the cache is not to depend on
            # the browser's HTTP cache.
        }
        if STATE["no_last_modified"] and is_target:
            # Nothing but the length is left to tell two versions apart.
            headers.pop("Last-Modified", None)
        if status == 206:
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"

        # A clean, valid, successful response carrying NO bytes: Content-Length 0
        # and an immediate end of body. This is what a connection dropped right
        # after the response headers looks like to fetch(), and it is a success as
        # far as the status code is concerned.
        if fault == "empty":
            self._send_headers(status, headers, 0)
            logline({"path": urlpath, "status": status, "range": rng, "fault": "empty",
                     "n": n, "asked": length, "sent": 0})
            return

        if head_only:
            self._send_headers(status, headers, length)
            logline({"path": urlpath, "status": status, "range": rng, "head": True,
                     "n": n if is_target else None})
            return

        # A cut is a lie about Content-Length followed by a hard socket close:
        # the client is told `length` bytes are coming, gets a fraction, and the
        # connection dies. fetch() surfaces that as a stream error, which is the
        # case the retry/resume logic exists for.
        to_send = length
        if fault == "cut":
            to_send = max(1, int(length * STATE["cut_at"]))

        self._send_headers(status, headers, length)
        sent = 0
        try:
            with open(full, "rb") as f:
                f.seek(start)
                remaining = to_send
                while remaining > 0:
                    buf = f.read(min(65536, remaining))
                    if not buf:
                        break
                    self.wfile.write(buf)
                    sent += len(buf)
                    remaining -= len(buf)
                    if STATE["delay"]:
                        time.sleep(STATE["delay"])
            if fault == "cut":
                self.wfile.flush()
                # RST rather than a clean FIN, so the peer cannot mistake the
                # truncation for a complete body.
                try:
                    self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER,
                                               b"\x01\x00\x00\x00\x00\x00\x00\x00")
                except OSError:
                    pass
                self.close_connection = True
                self.connection.close()
        except (BrokenPipeError, ConnectionResetError):
            pass

        logline({"path": urlpath, "status": status, "range": rng,
                 "n": n if is_target else None, "start": start,
                 "if_range": if_range,
                 "asked": length, "sent": sent, "fault": fault})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--port", type=int, default=8811)
    ap.add_argument("--log", required=True)
    ap.add_argument("--target", default=None, help="URL path the faults apply to")
    ap.add_argument("--cut-every", type=int, default=0)
    ap.add_argument("--cut-at", type=float, default=0.4)
    ap.add_argument("--fail-every", type=int, default=0)
    ap.add_argument("--delay", type=float, default=0.0, help="seconds per 64 KB, to slow the link")
    ap.add_argument("--no-head", action="store_true", help="answer HEAD with 405")
    ap.add_argument("--no-ranges", action="store_true", help="never honour Range")
    ap.add_argument("--ranges-until", type=int, default=None,
                    help="honour Range for the first N target requests, then stop")
    ap.add_argument("--empty-every", type=int, default=0,
                    help="every Nth target request: 206 with an empty body")
    ap.add_argument("--shift-range", type=int, default=0,
                    help="every Nth Range request: answer a different interval")
    ap.add_argument("--shift-len", type=int, default=0,
                    help="length of the interval used by --shift-range (default: as asked)")
    ap.add_argument("--drip", type=int, default=0,
                    help="serve at most N bytes per range request, honestly declared")
    ap.add_argument("--no-last-modified", action="store_true",
                    help="send no Last-Modified for the target")
    ap.add_argument("--alt", default=None, help="file to serve after --alt-after requests")
    ap.add_argument("--alt-after", type=int, default=0)
    ap.add_argument("--honour-if-range", action="store_true",
                    help="answer a stale If-Range with 200 and the whole file (RFC 7233)")
    args = ap.parse_args()

    STATE.update(root=os.path.abspath(args.root), target=args.target,
                 cut_every=args.cut_every, cut_at=args.cut_at,
                 fail_every=args.fail_every, log=os.path.abspath(args.log),
                 delay=args.delay, no_head=args.no_head, no_ranges=args.no_ranges,
                 ranges_until=args.ranges_until, empty_every=args.empty_every,
                 shift_range=args.shift_range, shift_len=args.shift_len,
                 drip=args.drip,
                 no_last_modified=args.no_last_modified,
                 alt=os.path.abspath(args.alt) if args.alt else None,
                 alt_after=args.alt_after, honour_if_range=args.honour_if_range)
    open(STATE["log"], "w").close()

    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    srv.daemon_threads = True
    print(f"serving {STATE['root']} on http://127.0.0.1:{args.port} "
          f"(target={args.target} cut_every={args.cut_every} fail_every={args.fail_every})",
          flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
