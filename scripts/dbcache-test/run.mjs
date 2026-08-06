// Test harness for web/db-cache.js.
//
// The real database is 433 MB / 5 minutes, so it is never touched here. Instead
// a local server (scripts/flaky_server.py) serves the same shapes of failure
// that make a five-minute Zenodo download unreliable — a connection cut in the
// middle of a slice, and a request that just fails — and headless Chrome runs
// the actual application modules against it.
//
// What each phase proves is written next to it. Run:
//
//   node scripts/dbcache-test/run.mjs
//
// Everything lives in a scratch directory of symlinks to web/, so the test page
// sits next to the real modules (same origin, `./db-cache.js` is the real file)
// without ever being deployed with the site.

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const WEB = path.join(REPO, "web");
const PORT = Number(process.env.PORT ?? 8817);
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = process.env.SCRATCH ?? fs.mkdtempSync(path.join(os.tmpdir(), "dbcache-"));
const ROOT = path.join(SCRATCH, "root");
const PROFILE = path.join(SCRATCH, "chrome-profile");
const LOG = path.join(SCRATCH, "server.jsonl");
const MINI = "/db/gut_mini.syldb";
const SYNTH = "/t/synth.bin";

let failures = 0;
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `   [${detail}]` : ""}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha256File = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");

// ---- scratch root ------------------------------------------------------------

function buildRoot() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  for (const name of fs.readdirSync(WEB)) {
    fs.symlinkSync(path.join(WEB, name), path.join(ROOT, name));
  }
  // The test page, next to the modules it imports.
  for (const name of ["_dbtest.html", "_dbtest.js"]) {
    fs.symlinkSync(path.join(HERE, name), path.join(ROOT, name));
  }
  // A synthetic target we are free to rewrite mid-test (the real database is
  // a symlink into the repo and must not be touched).
  fs.mkdirSync(path.join(ROOT, "t"), { recursive: true });
  writeSynth(5_000_000, 1);
}

// Deterministic pseudo-random content, so a rewritten file with the SAME length
// really does have different bytes — which is what makes the Last-Modified
// check meaningful rather than incidentally passing on a length difference.
function writeSynth(len, seed) {
  const buf = Buffer.alloc(len);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < len; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
    buf[i] = x & 0xff;
  }
  fs.writeFileSync(path.join(ROOT, "t", "synth.bin"), buf);
  return createHash("sha256").update(buf).digest("hex");
}

// ---- server ------------------------------------------------------------------

let server = null;
async function startServer({ target = MINI, cutEvery = 0, failEvery = 0, cutAt = 0.4, delay = 0 } = {}) {
  await stopServer();
  const args = [
    path.join(REPO, "scripts/flaky_server.py"),
    "--root", ROOT, "--port", String(PORT), "--log", LOG,
    "--target", target, "--cut-every", String(cutEvery),
    "--fail-every", String(failEvery), "--cut-at", String(cutAt),
    "--delay", String(delay),
  ];
  server = spawn("python3", args, { stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", d => process.env.VERBOSE && process.stderr.write(`[srv] ${d}`));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/_reset`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error("test server did not start");
}

async function stopServer() {
  if (!server) return;
  server.kill("SIGKILL");
  server = null;
  await sleep(200);
}

function readLog() {
  if (!fs.existsSync(LOG)) return [];
  return fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// Traffic for one path since the last reset: how many requests, and how many
// bytes actually left the server. `bytes` is the number that matters — it is
// what "one download" means.
function traffic(logLines, urlPath) {
  const hits = logLines.filter(l => l.path === urlPath && !l.report);
  return {
    requests: hits.length,
    bytes: hits.reduce((a, l) => a + (l.sent ?? 0), 0),
    faults: hits.filter(l => l.fault).length,
    statuses: hits.map(l => l.status),
  };
}

// ---- chrome ------------------------------------------------------------------

// One Chrome launch = one page load. A SECOND launch with the same
// --user-data-dir and the same port is a second visit to the same origin, which
// is how "does it resume after a page reload?" is asked here.
async function runScenario(query, { timeoutMs = 180_000 } = {}) {
  await fetch(`${BASE}/_reset`);
  const url = `${BASE}/_dbtest.html?${query}`;
  process.stdout.write(`   … ${query}\n`);
  // Chrome's ProcessSingleton: a still-running instance on this profile makes
  // the next launch hand its URL over and exit, or — if the old instance is
  // wedged — sit for ~30 s before deciding it is dead. That was measured here as
  // a phantom "30 s to read a cached file". So: no survivors, then no lock
  // files, then launch.
  try { execFileSync("pkill", ["-9", "-f", `--user-data-dir=${PROFILE}`], { stdio: "ignore" }); }
  catch { /* pkill exits 1 when nothing matched, which is the normal case */ }
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    fs.rmSync(path.join(PROFILE, f), { force: true });
  }
  const chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-first-run", "--enable-logging=stderr", `--user-data-dir=${PROFILE}`,
    // Chrome spends ~25 s of every headless launch on background chatter it
    // cannot reach here anyway (GCM registration, component updates); this cuts
    // it out so the suite is minutes rather than tens of minutes.
    "--disable-background-networking", "--disable-sync", "--disable-default-apps",
    "--disable-component-update", "--no-default-browser-check", "--mute-audio",
    // A headless page counts as hidden, and Chrome's intensive throttling then
    // caps setTimeout at ONE CALL PER MINUTE. The retry backoff is built on
    // setTimeout, so without these a scenario with 60 retries takes an hour
    // instead of 30 s — measured: console timestamps jumped from 08:01 to 09:25
    // mid-download. Real users get this only in a tab left in the background;
    // the test must not.
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    url,
    // Its own process group, so the whole browser (zygote, renderers, GPU
    // process) can be taken down together. Killing only the parent leaves
    // children alive holding the profile.
  ], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  let stderr = "";
  chrome.stderr.on("data", d => { stderr += d; if (process.env.VERBOSE) process.stderr.write(`[chrome] ${d}`); });
  let exited = false;
  chrome.on("exit", () => { exited = true; });

  const t0 = Date.now();
  let report = null;
  while (Date.now() - t0 < timeoutMs) {
    const line = readLog().find(l => l.report);
    if (line) { report = line.report; break; }
    await sleep(250);
  }
  // Shut the browser down GRACEFULLY. This is not politeness: SIGKILL can cut
  // Chrome off before it has finished persisting OPFS, and the next scenario
  // then finds an empty cache and re-downloads — which looks exactly like a
  // cache bug and is not one. SIGTERM lets Chrome flush and exit; SIGKILL is
  // only the backstop.
  for (let i = 0; i < 20 && !exited; i++) await sleep(100);   // window.close() may work
  if (!exited) {
    try { process.kill(-chrome.pid, "SIGTERM"); } catch { /* already gone */ }
    for (let i = 0; i < 100 && !exited; i++) await sleep(100);
  }
  if (!exited) {
    try { process.kill(-chrome.pid, "SIGKILL"); } catch { /* already gone */ }
    for (let i = 0; i < 50 && !exited; i++) await sleep(100);
  }
  // window.close() is often refused for a top-level window the script did not
  // open, so the group kill above is the norm rather than the exception; make
  // sure nothing survived it holding the profile.
  try { execFileSync("pkill", ["-9", "-f", `--user-data-dir=${PROFILE}`], { stdio: "ignore" }); }
  catch { /* nothing left, good */ }
  await sleep(300);
  if (!report) throw new Error(`scenario "${query}" produced no report in ${timeoutMs} ms\n${stderr.slice(-3000)}`);
  if (report.err) console.log(`   scenario error: ${report.err}\n${report.stack ?? ""}`);
  return { report, log: readLog() };
}

// ---- the suite ---------------------------------------------------------------

const miniSize = fs.statSync(path.join(WEB, "db/gut_mini.syldb")).size;
const miniSha = sha256File(path.join(WEB, "db/gut_mini.syldb"));
const CHUNK = 1_048_576;   // 1 MiB slices -> 7 slices for the 6.5 MB mini db

async function main() {
  buildRoot();
  fs.rmSync(PROFILE, { recursive: true, force: true });
  console.log(`scratch: ${SCRATCH}`);
  console.log(`mini db: ${miniSize} bytes, sha256 ${miniSha}`);
  console.log("");

  // ---- 0. what a browser cannot be asked for --------------------------------
  // Chrome will not hand back a short write, will not let a cache entry start
  // life corrupted, and will not pretend the disk is full. node-suite.mjs drives
  // the SAME db-cache.js against the SAME flaky server with an OPFS that can be
  // told to lie, for the failures that end in wrong bytes rather than an error.
  console.log("== 0. adversarial scenarios that need a lying disk ==");
  {
    const r = spawnSync("node", [path.join(HERE, "node-suite.mjs")], {
      encoding: "utf8", timeout: 900_000,
      env: { ...process.env, NODE_SUITE_PORT: String(PORT + 2) },
    });
    const out = r.stdout ?? "";
    process.stdout.write(out.split("\n").map(l => (l ? `   ${l}` : l)).join("\n"));
    if (r.stderr) process.stderr.write(r.stderr.slice(-3000));
    // Fold its verdicts into this suite's totals rather than hiding them behind
    // one aggregate check.
    for (const line of out.split("\n")) {
      if (line.startsWith("ok  ")) results.push({ name: line.slice(4).trim(), ok: true });
      else if (line.startsWith("FAIL")) { results.push({ name: line.slice(4).trim(), ok: false }); failures++; }
    }
    check("the node-level suite ran to completion", r.status === 0 || r.status === 1,
      `exit ${r.status}${r.error ? ` (${r.error.message})` : ""}`);
  }

  // ---- 1. a clean download, and the bytes are the right bytes ---------------
  console.log("== 1. clean download ==");
  await startServer({});
  {
    const { report, log } = await runScenario(`t=ensure&chunk=${CHUNK}`);
    const t = traffic(log, MINI);
    check("downloads from the network", report.source === "network", report.source);
    check("reconstructed file is byte-identical (sha256)", report.sha === miniSha, `${report.sha?.slice(0, 16)}…`);
    check("length matches", report.len === miniSize, `${report.len}`);
    // ONE probe request — a HEAD — plus one request per slice. Whether the
    // server honours Range is not asked: it is discovered from the first slice,
    // so a flaky probe response cannot downgrade the download to unresumable.
    check("one probe request + ceil(size/chunk) slices",
      t.requests === 1 + Math.ceil(miniSize / CHUNK), `${t.requests} requests`);
    check("served ~exactly one copy",
      t.bytes >= miniSize && t.bytes <= miniSize + 64, `${t.bytes} bytes for a ${miniSize} byte file`);
  }

  // ---- 2. a second visit costs nothing --------------------------------------
  console.log("\n== 2. second visit (same profile, same origin) ==");
  {
    const { report, log } = await runScenario(`t=ensure&chunk=${CHUNK}`);
    const t = traffic(log, MINI);
    check("served from the local cache", report.source === "cache", report.source);
    check("still byte-identical", report.sha === miniSha);
    // ONE request: a HEAD. Confirming a cached entry needs a size and a
    // Last-Modified, nothing else — asking whether the server does ranges is
    // only relevant when about to download.
    check("a single HEAD revalidates the entry",
      t.requests === 1 && t.bytes === 0, `${t.requests} requests, ${t.bytes} bytes`);
    check("nothing at all is re-fetched", report.bytesFetched === 0, `${report.bytesFetched} bytes`);
    // Reported, NOT asserted. A wall-clock bound here measures the test rig, not
    // the cache: a headless page is "hidden", and Chrome's intensive throttling
    // adds a flat ~30 s to the first fetch a worker makes after the profile has
    // been reused, whatever that fetch is. Benchmarked in isolation on the same
    // warm profile, dbCacheClient.ensure() on a valid entry takes 12 ms cold and
    // 7 ms warm, against 3 ms for a bare HEAD and 3 ms for
    // navigator.storage.getDirectory() — i.e. the cache hit is the two requests
    // it has to make and nothing else.
    console.log(`     (elapsed ${report.ms} ms — marks ${JSON.stringify(report.marks)}, ` +
      `list ${report.listMs} ms; headless throttling inflates this, see the note in run.mjs)`);
  }

  // ---- 3. the connection is cut in the middle of slices ----------------------
  console.log("\n== 3. connection cut mid-slice (every 3rd request) ==");
  await runScenario("t=wipe");
  await startServer({ cutEvery: 3, cutAt: 0.4 });
  {
    const { report, log } = await runScenario(`t=ensure&chunk=${CHUNK}`);
    const t = traffic(log, MINI);
    check("the download still completes", report.ok === true && report.source === "network", report.source);
    check("and is byte-identical despite the cuts", report.sha === miniSha, `${report.sha?.slice(0, 16)}…`);
    check("cuts really happened", t.faults >= 2, `${t.faults} cut responses`);
    check("it retried", report.retries >= 2, `${report.retries} retries`);
    // The proof that a cut does not restart from zero: with N cuts each losing
    // at most 60% of one 1 MiB slice, the waste is bounded by a few slices — a
    // restart-from-zero policy would multiply the whole file instead.
    check("a cut costs part of a slice, not the whole file",
      t.bytes < miniSize + 4 * CHUNK, `${t.bytes} bytes served for a ${miniSize} byte file`);
  }

  // ---- 3b. EVERY slice is cut ------------------------------------------------
  // The pathological version of the same fault, and the one that separates
  // "retries" from "retries that understand progress": every single request is
  // truncated at 50%, so a policy that counts a partial transfer as a failed
  // attempt runs out of attempts and gives up — even though the download was
  // advancing half a slice at a time throughout.
  console.log("\n== 3b. every request cut at 50% ==");
  await runScenario("t=wipe");
  // A throttled link, deliberately. Over instant loopback the server writes half
  // a slice and RSTs before the page's reader has drained ANY of it — Chrome
  // discards its internal buffer on reset — so attempt after attempt banks zero
  // bytes and the download is (correctly) abandoned. That is a property of a
  // 0 ms RTT test rig, not of a real 1.5 MB/s link, where the stream is consumed
  // as it arrives and a cut costs only what was in flight. The delay models the
  // real thing; the fault stays maximal.
  await startServer({ cutEvery: 1, cutAt: 0.5, delay: 0.01 });
  {
    const { report, log } = await runScenario(`t=ensure&chunk=${CHUNK}`, { timeoutMs: 300_000 });
    const t = traffic(log, MINI);
    check("it grinds through anyway", report.ok === true && report.source === "network", report.source);
    check("and is byte-identical", report.sha === miniSha, `${report.sha?.slice(0, 16)}…`);
    check("every single slice was cut", t.faults >= 10, `${t.faults} cut responses of ${t.requests}`);
    // Deliberately loose, because of a measured browser behaviour worth writing
    // down: when the socket is RST, Chrome delivers to the ReadableStream only
    // what the page had already drained and discards the rest of its internal
    // buffer. Over loopback the server can write 512 KB and vanish before the
    // reader sees more than a fraction of it, so the server counts bytes the
    // client never had. That is an artefact of an instantaneous RST at LAN
    // speed, not of the download logic — on a real 1.5 MB/s link the stream is
    // drained as it arrives and a cut loses almost nothing. What is being
    // asserted is that the waste stays a small multiple and the download
    // terminates, versus never finishing at all.
    check("waste stays bounded and it terminates",
      t.bytes >= miniSize && t.bytes < miniSize * 6, `${t.bytes} bytes served for ${miniSize}`);
  }

  // ---- 4. every other request fails outright ---------------------------------
  console.log("\n== 4. every 2nd request answered 503 ==");
  await runScenario("t=wipe");
  await startServer({ failEvery: 2 });
  {
    const { report, log } = await runScenario(`t=ensure&chunk=${CHUNK}`);
    const t = traffic(log, MINI);
    check("the download still completes", report.ok === true && report.source === "network", report.source);
    check("and is byte-identical", report.sha === miniSha);
    check("half the responses were 503", t.statuses.filter(s => s === 503).length >= 4,
      `${t.statuses.filter(s => s === 503).length} of ${t.requests}`);
    check("no bytes were re-fetched for the failed attempts",
      t.bytes >= miniSize && t.bytes <= miniSize + 64, `${t.bytes} bytes`);
  }

  // ---- 5. cancel, then reload the page ---------------------------------------
  console.log("\n== 5. cancel mid-download, then a fresh page load ==");
  await runScenario("t=wipe");
  // Throttled to ~1.3 MB/s, near the 1.48 MB/s measured against Zenodo. Two
  // reasons: cancelling "part way" is only meaningful if there IS a part way
  // (over loopback the whole file lands in ~100 ms, faster than a single
  // progress tick), and a five-minute download is the situation being modelled.
  await startServer({ delay: 0.05 });
  let abortedAt = 0;
  {
    const { report } = await runScenario(`t=abort&at=2000000&chunk=${CHUNK}`);
    abortedAt = report.received ?? 0;
    check("cancelling raises AbortError", report.aborted === true, report.err);
    check("the partial download is kept", (report.entry?.bytes ?? 0) >= 2_000_000,
      `${report.entry?.bytes} bytes on disk, meta.received=${report.entry?.received}`);
    check("and is marked incomplete", report.entry?.complete === false, JSON.stringify(report.entry));
  }
  {
    // Second Chrome launch, same profile and same port: a new page, same origin,
    // same OPFS.
    const { report, log } = await runScenario(`t=ensure&chunk=${CHUNK}`);
    const t = traffic(log, MINI);
    check("the new page resumes instead of restarting", report.resumed === true,
      `resumed from ${report.resumedFrom} of ${miniSize}`);
    check("it resumes near where it stopped",
      report.resumedFrom > 0 && Math.abs(report.resumedFrom - abortedAt) <= 4 * 1024 * 1024,
      `stopped at ${abortedAt}, resumed at ${report.resumedFrom}`);
    check("only the remainder is fetched",
      t.bytes <= miniSize - report.resumedFrom + 64, `${t.bytes} bytes for the last ${miniSize - report.resumedFrom}`);
    check("the reassembled file is byte-identical", report.sha === miniSha, `${report.sha?.slice(0, 16)}…`);
  }

  // ---- 6. THE defect: one download for a pool of 4 ---------------------------
  console.log("\n== 6. pool of 4 sylph workers ==");
  await runScenario("t=wipe");
  {
    const { report, log } = await runScenario(`t=pool&n=4&chunk=${CHUNK}`, { timeoutMs: 180_000 });
    const t = traffic(log, MINI);
    check("all four workers loaded the database",
      Array.isArray(report.metas) && report.metas.length === 4
      && report.metas.every(m => m.bytes === miniSize && m.database_size === report.metas[0].database_size),
      JSON.stringify(report.metas?.[0]));
    check("ONE download, not four",
      t.bytes >= miniSize && t.bytes < miniSize * 1.05,
      `${t.bytes} bytes served (one copy = ${miniSize}, four copies = ${miniSize * 4})`);
    check("and the workers made no requests of their own",
      t.requests === 1 + Math.ceil(miniSize / CHUNK), `${t.requests} requests`);
  }

  // ---- 7. switching the wasm build must not re-download ----------------------
  console.log("\n== 7. wasm 32 -> 64 build switch ==");
  {
    const { report, log } = await runScenario(`t=bits&chunk=${CHUNK}`, { timeoutMs: 180_000 });
    const t = traffic(log, MINI);
    check("the cache was reused for both builds", report.source === "cache", report.source);
    check("32-bit worker loaded it", report.first?.meta?.bytes === miniSize, JSON.stringify(report.first?.bits));
    check("64-bit worker loaded the same bytes",
      report.second?.meta?.bytes === miniSize
      && report.second?.meta?.database_size === report.first?.meta?.database_size,
      `bits=${report.second?.bits} (${report.second?.reason ?? ""})`);
    check("no database bytes crossed the network",
      t.bytes === 0 && t.requests === 1, `${t.bytes} bytes, ${t.requests} requests (the HEAD probe)`);
  }

  // ---- 8. a truncated cache entry is refused, not served ----------------------
  console.log("\n== 8. truncated cache entry ==");
  {
    const { report } = await runScenario(`t=corrupt&chunk=${CHUNK}`, { timeoutMs: 180_000 });
    check("the entry really was truncated", report.after === Math.floor(report.before / 2),
      `${report.before} -> ${report.after}`);
    check("readCachedBytes refuses it", !!report.readErr, report.readErr);
    check("a sylph worker refuses it rather than profiling with it", !!report.workerErr, report.workerErr);
    // Repaired, not re-fetched whole: what survived truncation is a clean
    // PREFIX of the right file (the validators still match), so the missing
    // tail is all that has to come back. Re-pulling 433 MB to recover a
    // half-written 433 MB file would be its own kind of bug. What matters is
    // that the short entry was never served — the two checks above — and that
    // what ends up on disk is bit-for-bit correct.
    check("it is repaired over the network", report.source === "network" && report.bytesFetched > 0,
      `${report.source}, refetched ${report.bytesFetched} of ${miniSize} bytes`);
    check("only the missing tail is refetched",
      report.bytesFetched <= miniSize - report.after + CHUNK,
      `${report.bytesFetched} bytes for a ${miniSize - report.after} byte hole`);
    check("and the repaired copy is byte-identical", report.sha === miniSha);
  }

  // ---- 9. the file changed on the server -------------------------------------
  console.log("\n== 9. the server's copy changed ==");
  await startServer({ target: SYNTH });
  const shaA = writeSynth(5_000_000, 1);
  {
    const { report } = await runScenario(`t=ensure&url=/t/synth.bin&chunk=${CHUNK}`);
    check("synthetic file downloads", report.source === "network" && report.sha === shaA, report.sha?.slice(0, 16));
  }
  // Same LENGTH, different content, newer mtime: only Last-Modified can catch
  // this, and it has to, or the user profiles against the wrong database.
  await sleep(1100);   // the HTTP date has one-second resolution
  const shaB = writeSynth(5_000_000, 2);
  {
    const { report, log } = await runScenario(`t=ensure&url=/t/synth.bin&chunk=${CHUNK}`);
    const t = traffic(log, SYNTH);
    check("a same-size but newer file invalidates the entry", report.source === "network", report.source);
    check("and the new bytes are what is cached", report.sha === shaB && report.sha !== shaA, report.sha?.slice(0, 16));
    check("the whole file was re-fetched", t.bytes >= 5_000_000, `${t.bytes} bytes`);
  }
  // Different length.
  const shaC = writeSynth(3_000_000, 3);
  {
    const { report } = await runScenario(`t=ensure&url=/t/synth.bin&chunk=${CHUNK}`);
    check("a different-size file invalidates the entry", report.source === "network", report.source);
    check("and the cache holds the new file", report.sha === shaC && report.len === 3_000_000,
      `${report.len} bytes`);
  }

  // ---- 10. the user can see and delete what is cached -------------------------
  console.log("\n== 10. cache listing and deletion ==");
  {
    const { report } = await runScenario("t=list");
    check("both databases are listed", (report.entries ?? []).length === 2,
      (report.entries ?? []).map(e => `${e.key}:${e.bytes}`).join(" "));
    check("entries carry their URL and completeness",
      report.entries.every(e => e.url && e.complete === true), JSON.stringify(report.entries?.[0]));
  }
  {
    const { report } = await runScenario("t=delete&url=/t/synth.bin");
    check("deleting one entry leaves the other", report.before === 2 && report.after === 1,
      `${report.before} -> ${report.after}`);
  }

  // ---- 11. two tabs of this site at the same moment --------------------------
  // The ordinary case: index.html in one tab, profile.html in another, both
  // asked to load the same database. Before Web Locks the second one waited on
  // the file handle, acted on its stale decision, truncated the entry the first
  // had just finished and downloaded everything again — 866 MB for one 433 MB
  // database, and the finished tab's entry wiped.
  console.log("\n== 11. two tabs asking for the same database at once ==");
  await startServer({ delay: 0.005 });
  await runScenario("t=wipe");
  {
    const { report, log } = await runScenario(`t=twotabs&chunk=${CHUNK}`, { timeoutMs: 240_000 });
    const t = traffic(log, MINI);
    check("both tabs end up with the database",
      !report.a?.err && !report.b?.err, JSON.stringify([report.a, report.b]));
    check("ONE download, not two",
      t.bytes >= miniSize && t.bytes < miniSize * 1.05,
      `${t.bytes} bytes served (one copy = ${miniSize}, two = ${miniSize * 2})`);
    check("the second tab reuses the entry instead of rebuilding it",
      [report.a, report.b].filter(r => r?.source === "cache").length === 1
      && [report.a, report.b].filter(r => r?.source === "network").length === 1,
      `${report.a?.source}/${report.b?.source}`);
    check("and the file is byte-identical", report.sha === miniSha, `${report.sha?.slice(0, 16)}…`);
  }

  // ---- 12. the pages are wired to what was fixed -----------------------------
  console.log("\n== 12. page wiring ==");
  {
    const r = spawnSync("node", [path.join(HERE, "wiring.mjs")], { encoding: "utf8" });
    const out = r.stdout ?? "";
    process.stdout.write(out.split("\n").map(l => (l ? `   ${l}` : l)).join("\n"));
    for (const line of out.split("\n")) {
      if (line.startsWith("ok  ")) results.push({ name: line.slice(4).trim(), ok: true });
      else if (line.startsWith("FAIL")) { results.push({ name: line.slice(4).trim(), ok: false }); failures++; }
    }
    check("the wiring suite ran to completion", r.status === 0 || r.status === 1, `exit ${r.status}`);
  }

  await stopServer();
  console.log(`\n${results.filter(r => r.ok).length} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await stopServer();
  process.exit(2);
});
