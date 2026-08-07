// One real run against the real Zenodo-hosted database.
//
// Everything else in this directory runs against a local server, because 433 MB
// at the measured 1.48 MB/s is five minutes per attempt. But one thing cannot be
// checked locally at all: CROSS-ORIGIN header visibility. A same-origin server
// hands the page every response header; Zenodo hands it seven safelisted ones
// plus whatever Access-Control-Expose-Headers names — and Content-Range is on
// neither list. Code that reads the total size out of Content-Range passes every
// local test and then reports a 1-byte database in production.
//
// So this downloads a bounded prefix (default 30 MB), cancels, and then proves
// a second page load resumes from there. It reports the throughput actually
// measured. It does NOT pull the whole file.
//
//   node scripts/dbcache-test/zenodo.mjs           # ~30 MB, two page loads
//   MB=60 node scripts/dbcache-test/zenodo.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const WEB = path.join(REPO, "web");
const PORT = Number(process.env.PORT ?? 8819);
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = process.env.SCRATCH ?? fs.mkdtempSync(path.join(os.tmpdir(), "zenodo-"));
const ROOT = path.join(SCRATCH, "root");
const PROFILE = path.join(SCRATCH, "chrome-profile");
const LOG = path.join(SCRATCH, "server.jsonl");
const ZENODO = "https://zenodo.org/api/records/21842023/files/human-gut.syldb/content";
const STOP_AT = Number(process.env.MB ?? 30) * 1_000_000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `   [${detail}]` : ""}`);
};

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
for (const n of fs.readdirSync(WEB)) fs.symlinkSync(path.join(WEB, n), path.join(ROOT, n));
for (const n of ["_dbtest.html", "_dbtest.js"]) fs.symlinkSync(path.join(HERE, n), path.join(ROOT, n));

const server = spawn("python3", [
  path.join(REPO, "scripts/flaky_server.py"),
  "--root", ROOT, "--port", String(PORT), "--log", LOG,
], { stdio: ["ignore", "pipe", "pipe"] });

async function waitServer() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/_reset`)).ok) return; } catch { /* not up */ }
    await sleep(100);
  }
  throw new Error("server did not start");
}

function readLog() {
  if (!fs.existsSync(LOG)) return [];
  return fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

async function run(query, timeoutMs = 300_000) {
  await fetch(`${BASE}/_reset`);
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    fs.rmSync(path.join(PROFILE, f), { force: true });
  }
  console.log(`   … ${query}`);
  const chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-first-run", "--enable-logging=stderr", `--user-data-dir=${PROFILE}`,
    "--disable-background-networking", "--disable-sync", "--disable-default-apps",
    "--disable-component-update", "--no-default-browser-check",
    `${BASE}/_dbtest.html?${query}`,
  ], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  let exited = false;
  chrome.on("exit", () => { exited = true; });
  const t0 = Date.now();
  let report = null;
  while (Date.now() - t0 < timeoutMs) {
    const l = readLog().find(x => x.report);
    if (l) { report = l.report; break; }
    await sleep(250);
  }
  for (let i = 0; i < 40 && !exited; i++) await sleep(100);
  if (!exited) { try { process.kill(-chrome.pid, "SIGKILL"); } catch { /* gone */ } }
  await sleep(500);
  if (!report) throw new Error(`no report for ${query}`);
  return report;
}

const fmt = (n) => `${(n / 1e6).toFixed(1)} MB`;

try {
  await waitServer();
  console.log(`Zenodo: ${ZENODO}`);
  console.log(`stopping each pass at ${fmt(STOP_AT)} — the full file is NOT downloaded\n`);

  const u = encodeURIComponent(ZENODO);

  // Pass 1. The critical assertion is `total`: if Content-Range were the only
  // source of the size, this would come back as 1 and everything downstream
  // would be nonsense.
  const t0 = Date.now();
  const a = await run(`t=abort&url=${u}&at=${STOP_AT}&chunk=${8 * 1024 * 1024}`);
  const wall = (Date.now() - t0) / 1000;
  check("the real size is readable cross-origin", a.entry?.size === 454_021_440,
    `${a.entry?.size} bytes`);
  check("Zenodo serves ranges (the download progressed)", (a.received ?? 0) >= STOP_AT,
    `${fmt(a.received)} received`);
  check("cancelling keeps the partial entry", (a.entry?.bytes ?? 0) >= STOP_AT && a.entry?.complete === false,
    `${fmt(a.entry?.bytes)} on disk, complete=${a.entry?.complete}`);
  check("Last-Modified is readable cross-origin and stored", !!a.entry?.lastModified,
    a.entry?.lastModified ?? "(none)");
  console.log(`   throughput: ${fmt(a.received)} in ~${wall.toFixed(0)} s wall ` +
    `(includes ~30 s of headless Chrome startup)`);

  // Pass 2. A second page load, same profile: it must continue, not restart.
  const b = await run(`t=abort&url=${u}&at=${a.received + 8_000_000}&chunk=${8 * 1024 * 1024}`);
  check("a fresh page load resumes against the real server",
    (b.entry?.received ?? 0) > (a.entry?.received ?? 0),
    `${fmt(a.entry?.received)} → ${fmt(b.entry?.received)}`);

  console.log(`\nTotal pulled from Zenodo this run: about ${fmt(b.entry?.bytes ?? 0)} ` +
    `of ${fmt(454_021_440)} — the rest was never requested.`);
} finally {
  server.kill("SIGKILL");
}
process.exit(failures ? 1 : 0);
