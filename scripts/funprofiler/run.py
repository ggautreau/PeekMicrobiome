#!/usr/bin/env python3
"""Run the wasm test page in headless Chrome and collect what it reports.

--dump-dom fires before an async module finishes, and --virtual-time-budget
makes performance.now() meaningless, so neither can give a real timing. The page
posts its result back instead; this serves the files, waits for that request,
and prints it.
"""
import http.server, socketserver, subprocess, sys, threading, urllib.parse, os, time

PORT = 8753
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
# Served from the repository root so the page can reach both scripts/funprofiler/
# (itself, and its fixtures) and web/funprofiler-pkg*/ without escaping the root.
os.chdir(ROOT)
results = {}


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/done?"):
            results["value"] = urllib.parse.unquote(self.path[len("/done?"):])
            self.send_response(204)
            self.end_headers()
            return
        return super().do_GET()


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("", PORT), Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()

for pkg in ("funprofiler-pkg", "funprofiler-pkg64"):
    results.clear()
    profile = os.path.join(HERE, f".chrome-run-{pkg}")
    chrome = subprocess.Popen(
        ["google-chrome", "--headless=new", "--disable-gpu", "--no-sandbox",
         f"--user-data-dir={profile}",
         "--js-flags=--experimental-wasm-memory64",
         f"http://localhost:{PORT}/scripts/funprofiler/page.html?pkg={pkg}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + 240
    while "value" not in results and time.time() < deadline:
        time.sleep(0.25)
    chrome.terminate()
    try:
        chrome.wait(timeout=15)
    except subprocess.TimeoutExpired:
        chrome.kill()
    print(results.get("value", f"{pkg}: PAS DE RESULTAT (delai depasse)"))

httpd.shutdown()
