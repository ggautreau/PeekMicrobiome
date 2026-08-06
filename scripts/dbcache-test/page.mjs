// End-to-end smoke test of the REAL pages, not just db-cache.js.
//
// run.mjs drives a purpose-built test page, which proves the cache module works
// but says nothing about whether index.html/multi.js are wired to it correctly —
// a typo in an element id, a missing import, a loadFn that is never called, and
// every module test still passes while the site is broken.
//
// So this one loads web/index.html itself in headless Chrome, clicks the real
// "Load database" button through the DevTools protocol, and reads the real
// status line. Then it reloads the page and clicks again, to see the second
// visit come out of the local cache.
//
//   node scripts/dbcache-test/page.mjs            # index.html, pool of 4
//   PAGE=profile.html node scripts/dbcache-test/page.mjs
//
// Node 22 has a global WebSocket, so CDP needs no dependencies.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const WEB = path.join(REPO, "web");
const PORT = Number(process.env.PORT ?? 8821);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9333);
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = process.env.SCRATCH ?? fs.mkdtempSync(path.join(os.tmpdir(), "dbpage-"));
const ROOT = path.join(SCRATCH, "root");
const PROFILE = path.join(SCRATCH, "chrome-profile");
const LOG = path.join(SCRATCH, "server.jsonl");
const PAGE = process.env.PAGE ?? "index.html";
const MINI = "/db/gut_mini.syldb";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `   [${detail}]` : ""}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
for (const n of fs.readdirSync(WEB)) fs.symlinkSync(path.join(WEB, n), path.join(ROOT, n));

const server = spawn("python3", [
  path.join(REPO, "scripts/flaky_server.py"),
  "--root", ROOT, "--port", String(PORT), "--log", LOG, "--target", MINI,
], { stdio: ["ignore", "ignore", "inherit"] });

const readLog = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n")
  .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
const dbBytes = () => readLog().filter(l => l.path === MINI).reduce((a, l) => a + (l.sent ?? 0), 0);
const dbRequests = () => readLog().filter(l => l.path === MINI).length;

// ---- the smallest CDP client that can click a button -------------------------

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new Cdp(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const w = c.waiting.get(msg.id);
      if (w) { c.waiting.delete(msg.id); w(msg); }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  // Returns the value of a JS expression evaluated in the page.
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description ?? "page exception");
    }
    return r.result?.result?.value;
  }
}

async function targetWs(pathMatch) {
  for (let i = 0; i < 200; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const t = list.find(x => x.type === "page" && x.url.includes(pathMatch));
      if (t?.webSocketDebuggerUrl) return t.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("no debuggable page appeared");
}

// Wait until #dbInfo matches, reporting what it said if it never does.
async function waitForInfo(cdp, re, timeoutMs = 180_000) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    last = await cdp.eval(`document.getElementById("dbInfo")?.textContent ?? ""`);
    if (re.test(last)) return last;
    const err = await cdp.eval(`document.getElementById("error")?.textContent ?? ""`);
    if (err) throw new Error(`page reported an error: ${err}`);
    await sleep(300);
  }
  throw new Error(`#dbInfo never matched ${re} — last: "${last}"`);
}

let chrome = null;
async function launch() {
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    fs.rmSync(path.join(PROFILE, f), { force: true });
  }
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-first-run", `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`,
    "--disable-background-networking", "--disable-sync", "--disable-default-apps",
    "--disable-component-update", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    `${BASE}/${PAGE}`,
  ], { stdio: ["ignore", "ignore", "ignore"], detached: true });
  const cdp = await Cdp.attach(await targetWs(PAGE));
  // The debug target exists as soon as the tab does — well before the document
  // is parsed, and on this machine Chrome takes ~30 s to get going. Evaluating
  // too early returns null for every element and looks exactly like a broken
  // page. Wait for the document AND for a marker element the page owns.
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    const ready = await cdp.eval(
      `document.readyState === "complete" && !!document.getElementById("dbSelect")`
    ).catch(() => false);
    if (ready === true) return cdp;
    await sleep(250);
  }
  throw new Error(`${PAGE} never finished loading`);
}

function kill() {
  if (!chrome) return;
  try { process.kill(-chrome.pid, "SIGKILL"); } catch { /* gone */ }
  try { execFileSync("pkill", ["-9", "-f", `--user-data-dir=${PROFILE}`], { stdio: "ignore" }); }
  catch { /* nothing left */ }
  chrome = null;
}

try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/_reset`)).ok) break; } catch { /* wait */ }
    await sleep(100);
  }
  const miniSize = fs.statSync(path.join(WEB, "db/gut_mini.syldb")).size;
  console.log(`driving ${PAGE} against ${BASE}\n`);

  // ---- first visit -----------------------------------------------------------
  let cdp = await launch();
  // The page must come up clean: multi.js runs renderCacheInfo() at import, so a
  // broken element id or a bad import shows up here and nowhere else.
  // (`typeof null` is "object", so this asks for the node, not its typeof.)
  check("the page loaded and the cache UI is present",
    (await cdp.eval(`!!document.getElementById("dbCacheInfo")`)) === true);
  check("the Cancel-download button exists and starts hidden",
    (await cdp.eval(`document.getElementById("cancelDb")?.classList.contains("hide")`)) === true);

  // Pick the bundled 6 MB database and, on index.html, a pool of 4.
  await cdp.eval(`
    (() => {
      const s = document.getElementById("dbSelect");
      s.value = [...s.options].find(o => o.value.includes("gut_mini")).value;
      const p = document.getElementById("poolSize");
      if (p) p.value = "4";
      return s.value;
    })()`);
  await fetch(`${BASE}/_reset`);
  await cdp.eval(`document.getElementById("loadDb").click()`);
  const info1 = await waitForInfo(cdp, /Database ready/);
  console.log(`   ${info1}`);
  check("the database loaded through the page", /Database ready/.test(info1), "");
  check("it says the bytes were downloaded and cached",
    /downloaded and cached locally/.test(info1), info1.slice(0, 120));
  check("the genome count came back from sylph", /\b50 genomes\b/.test(info1));
  if (PAGE === "index.html") {
    check("all four workers were fed", /ready on 4 workers/.test(info1), info1.slice(0, 80));
  }
  check("ONE download for the whole pool",
    dbBytes() >= miniSize && dbBytes() < miniSize * 1.05,
    `${dbBytes()} bytes in ${dbRequests()} requests (4 copies would be ${miniSize * 4})`);

  const listed = await cdp.eval(`document.getElementById("dbCacheInfo").textContent`);
  check("the cache listing shows the entry and a Delete button",
    /Cached on this computer/.test(listed)
    && (await cdp.eval(`!!document.querySelector("#dbCacheInfo button[data-cache-key]")`)) === true,
    listed.slice(0, 120));

  kill();
  await sleep(1000);

  // ---- second visit: a genuinely new page load -------------------------------
  await fetch(`${BASE}/_reset`);
  cdp = await launch();
  await cdp.eval(`
    (() => {
      const s = document.getElementById("dbSelect");
      s.value = [...s.options].find(o => o.value.includes("gut_mini")).value;
      const p = document.getElementById("poolSize");
      if (p) p.value = "4";
    })()`);
  await cdp.eval(`document.getElementById("loadDb").click()`);
  const info2 = await waitForInfo(cdp, /Database ready/);
  console.log(`   ${info2}`);
  check("the second visit says it came from the local cache",
    /loaded from local cache/.test(info2), info2.slice(0, 120));
  check("and pulled no database bytes", dbBytes() <= 1,
    `${dbBytes()} bytes in ${dbRequests()} requests (revalidation probe only)`);

  // ---- the Delete button really deletes --------------------------------------
  await cdp.eval(`document.querySelector("#dbCacheInfo button[data-cache-key]").click()`);
  for (let i = 0; i < 40; i++) {
    const t = await cdp.eval(`document.getElementById("dbCacheInfo").textContent`);
    if (!/Cached on this computer/.test(t)) break;
    await sleep(250);
  }
  check("the Delete button empties the listing",
    !/Cached on this computer/.test(await cdp.eval(`document.getElementById("dbCacheInfo").textContent`)));
} catch (e) {
  console.error(e);
  failures++;
} finally {
  kill();
  server.kill("SIGKILL");
}

console.log(`\n${failures ? `${failures} failed` : "all page checks passed"}`);
process.exit(failures ? 1 : 0);
