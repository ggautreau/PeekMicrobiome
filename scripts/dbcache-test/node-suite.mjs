// The hostile half of the db-cache bench that headless Chrome cannot express.
//
//   node scripts/dbcache-test/node-suite.mjs        (also run by run.mjs)
//
// run.mjs drives the REAL modules in a REAL browser against a flaky server, and
// that is the only place OPFS, workers and sylph itself are exercised for real.
// It cannot, however, ask for the situations that produce a SILENTLY WRONG
// database rather than a visible failure:
//
//   - a cached entry whose resume pointer is longer than the file the server
//     offers (that state is only reachable by having been corrupted first);
//   - a local write that stores fewer bytes than it was given (OPFS will not do
//     that on demand, and it is the one corruption that keeps the length exact);
//   - running out of quota before the download starts;
//   - a browser storage estimate that says the disk is full.
//
// So this half keeps the real db-cache.js and the real flaky_server.py — real
// HTTP, real Range headers, real cuts — and replaces only OPFS, with an
// in-memory implementation that can be told to lie in the specific ways a real
// disk lies. Every scenario asserts on the bytes that end up on "disk", hashed
// and compared with the file the server holds: the question is never "did it
// error" but "is what it kept the right file".

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PORT = Number(process.env.NODE_SUITE_PORT ?? 8819);
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "dbnode-"));
const ROOT = path.join(SCRATCH, "root");
const LOG = path.join(SCRATCH, "server.jsonl");
const TARGET = "/t/synth.bin";
const ALT = path.join(ROOT, "t", "synth.alt.bin");

let failures = 0, passes = 0;
function check(name, ok, detail = "") {
  if (ok) passes++; else failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `   [${detail}]` : ""}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

// Deterministic pseudo-random bytes: a file rewritten with another seed has the
// same length and different content, which is the only interesting case.
function synth(len, seed) {
  const buf = Buffer.alloc(len);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < len; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

// ---- the fake disk -----------------------------------------------------------
//
// Faithful to the parts that matter: write() RETURNS A BYTE COUNT (which is the
// whole point — a real FileSystemSyncAccessHandle may store fewer bytes than it
// was given), truncate() really shortens, and a second createSyncAccessHandle()
// on an open file throws NoModificationAllowedError like the real one.

const FS = new Map();               // "/dir/file" -> Buffer
const OPEN = new Set();
let writeHook = null;               // (piece, at, seq) -> bytes to store, or throw
let dataFlushes = 0;                // flush() calls on the `data` file
let metaWrites = [];                // every meta.json write, with the flush count at the time
let writeSeq = 0;

class FakeSync {
  constructor(p) { this.p = p; }
  write(buf, { at } = { at: 0 }) {
    const piece = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    let n = piece.length;
    if (this.p.endsWith("/data") && writeHook) n = writeHook(piece, at, writeSeq++);
    const cur = FS.get(this.p) ?? Buffer.alloc(0);
    const end = at + n;
    const grown = end > cur.length ? Buffer.concat([cur, Buffer.alloc(end - cur.length)]) : cur;
    piece.copy(grown, at, 0, n);
    FS.set(this.p, grown);
    if (this.p.endsWith("/meta.json")) {
      try {
        metaWrites.push({ meta: JSON.parse(grown.subarray(0, end).toString("utf8")), dataFlushes });
      } catch { /* partial write of metadata, not interesting here */ }
    }
    return n;
  }
  truncate(n) {
    const cur = FS.get(this.p) ?? Buffer.alloc(0);
    FS.set(this.p, n <= cur.length ? Buffer.from(cur.subarray(0, n)) : Buffer.concat([cur, Buffer.alloc(n - cur.length)]));
  }
  flush() { if (this.p.endsWith("/data")) dataFlushes++; }
  getSize() { return (FS.get(this.p) ?? Buffer.alloc(0)).length; }
  close() { OPEN.delete(this.p); }
}

class FakeFileHandle {
  constructor(p) { this.kind = "file"; this.path = p; }
  async createSyncAccessHandle() {
    if (OPEN.has(this.path)) { const e = new Error("locked"); e.name = "NoModificationAllowedError"; throw e; }
    OPEN.add(this.path);
    return new FakeSync(this.path);
  }
  async getFile() {
    const b = FS.get(this.path);
    if (!b) { const e = new Error("no such file"); e.name = "NotFoundError"; throw e; }
    return {
      size: b.length,
      async text() { return b.toString("utf8"); },
      async arrayBuffer() { return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); },
    };
  }
}

class FakeDir {
  constructor(p) { this.kind = "directory"; this.path = p; }
  async getDirectoryHandle(name, { create } = {}) {
    const p = `${this.path}/${name}`;
    if (!create && ![...FS.keys()].some(k => k.startsWith(p + "/"))) {
      const e = new Error("no such directory"); e.name = "NotFoundError"; throw e;
    }
    return new FakeDir(p);
  }
  async getFileHandle(name, { create } = {}) {
    const p = `${this.path}/${name}`;
    if (!FS.has(p)) {
      if (!create) { const e = new Error("no such file"); e.name = "NotFoundError"; throw e; }
      FS.set(p, Buffer.alloc(0));
    }
    return new FakeFileHandle(p);
  }
  async removeEntry(name) {
    const p = `${this.path}/${name}`;
    for (const k of [...FS.keys()]) if (k === p || k.startsWith(p + "/")) FS.delete(k);
  }
  async *entries() {
    const seen = new Set();
    for (const k of FS.keys()) {
      if (!k.startsWith(this.path + "/")) continue;
      const rest = k.slice(this.path.length + 1);
      const first = rest.split("/")[0];
      if (seen.has(first)) continue;
      seen.add(first);
      yield [first, rest.includes("/") ? new FakeDir(`${this.path}/${first}`) : new FakeFileHandle(k)];
    }
  }
}

let estimate = async () => ({ quota: 8 * 1024 ** 3, usage: 0 });

globalThis.WorkerGlobalScope = class WorkerGlobalScope {};
globalThis.DedicatedWorkerGlobalScope = class DedicatedWorkerGlobalScope extends WorkerGlobalScope {};
const fakeSelf = new globalThis.DedicatedWorkerGlobalScope();
fakeSelf.location = { href: `${BASE}/_node/` };   // same origin as the server: If-Range is allowed
globalThis.self = fakeSelf;
globalThis.FileSystemFileHandle = FakeFileHandle;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    onLine: true,
    storage: {
      getDirectory: async () => new FakeDir(""),
      estimate: (...a) => estimate(...a),
    },
    // No navigator.locks: this half deliberately exercises the fallback for
    // contexts that do not have Web Locks. The two-tab queue is tested in the
    // browser, where the API actually exists (run.mjs, "two tabs").
  },
});

function resetDisk() {
  FS.clear(); OPEN.clear();
  writeHook = null; dataFlushes = 0; metaWrites = []; writeSeq = 0;
  estimate = async () => ({ quota: 8 * 1024 ** 3, usage: 0 });
}

// Fresh disk AND a fresh server log/fault counter, so every scenario's request
// count is its own.
async function reset() {
  resetDisk();
  try { await fetch(`${BASE}/_reset`); } catch { /* the server may be down on purpose */ }
}

const {
  ensureDb, readCachedBytes, listCache, cacheKey, validateEntry, assertSameDatabase, cacheSummary,
} = await import(path.join(REPO, "web/db-cache.js"));

const dataPath = (url) => `/syldb-cache/${cacheKey(url)}/data`;
const metaPath = (url) => `/syldb-cache/${cacheKey(url)}/meta.json`;
const onDisk = (url) => FS.get(dataPath(url)) ?? Buffer.alloc(0);

// Plant a cache entry directly, the way a previous (possibly buggy) run would
// have left one.
function seedEntry(url, { data, meta }) {
  FS.set(dataPath(url), data);
  FS.set(metaPath(url), Buffer.from(JSON.stringify({ layout: 1, url, ...meta })));
}

// ---- the server --------------------------------------------------------------

let server = null;
async function startServer(extra = []) {
  await stopServer();
  server = spawn("python3", [
    path.join(REPO, "scripts/flaky_server.py"),
    "--root", ROOT, "--port", String(PORT), "--log", LOG, "--target", TARGET, ...extra,
  ], { stdio: ["ignore", "ignore", process.env.VERBOSE ? "inherit" : "ignore"] });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/_reset`)).ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error("test server did not start");
}
async function stopServer() {
  if (!server) return;
  server.kill("SIGKILL");
  server = null;
  await sleep(150);
}
function hits() {
  if (!fs.existsSync(LOG)) return [];
  return fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(l => l && l.path === TARGET);
}
const gets = () => hits().filter(l => !l.head);
const served = () => gets().reduce((a, l) => a + (l.sent ?? 0), 0);

// Run ensureDb with a hard deadline: an infinite retry loop must FAIL the bench,
// not hang it.
async function ensureWithin(url, opts, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const t0 = Date.now();
  try {
    const res = await ensureDb(url, { ...opts, signal: ac.signal, chunkSize: opts.chunkSize });
    return { res, ms: Date.now() - t0 };
  } catch (e) {
    return { err: e, timedOut: Date.now() - t0 >= ms - 50, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

// ---- scenarios ---------------------------------------------------------------

const SIZE = 1_000_000;
const CHUNK = 200_000;
const bodyA = synth(SIZE, 1);
const bodyB = synth(SIZE, 2);
const url = `${BASE}${TARGET}`;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, "t"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "t", "synth.bin"), bodyA);
fs.writeFileSync(ALT, bodyB);
// Same length, different bytes, and — crucially — a different Last-Modified.
// Written in the same second as the original it would be indistinguishable, and
// the scenario would silently test nothing.
fs.utimesSync(ALT, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));

try {
  // ---- A. a resume pointer that is LONGER than the file on the server --------
  // The state left behind by any bug that wrote past the end. Clamping it to the
  // announced size (which is what the code used to do) reads it as "everything is
  // already here": no request is made, the length check compares a length with a
  // length and passes, and a file that is NOT the database is published as
  // complete. Nothing downstream can tell.
  console.log("\n== A. resume pointer past the announced size ==");
  await startServer();
  {
    resetDisk();
    const head = await fetch(url, { method: "HEAD" });
    seedEntry(url, {
      data: Buffer.concat([bodyA.subarray(0, SIZE), Buffer.alloc(300_000, 0xAA)]),
      meta: {
        size: SIZE, lastModified: head.headers.get("last-modified"),
        received: SIZE + 300_000, complete: false, updated: Date.now(),
      },
    });
    const { res, err } = await ensureWithin(url, { chunkSize: CHUNK }, 60_000);
    check("the incoherent entry is not served as complete", !err && res?.bytesFetched === SIZE,
      err ? `threw: ${err.message}` : `bytesFetched=${res.bytesFetched}, ${gets().length} GETs`);
    check("it really re-downloaded (the whole file, not zero bytes)", served() >= SIZE,
      `${served()} bytes served in ${gets().length} GETs`);
    const bytes = await readCachedBytes(url).catch(() => Buffer.alloc(0));
    check("and what it kept is byte-identical to the server's file",
      sha(Buffer.from(bytes)) === sha(bodyA), `${bytes.length} bytes`);
  }

  // ---- B. the server stops honouring Range in the middle --------------------
  // A proxy or captive portal cutting in. The client has a prefix on disk, asks
  // for a range, and is answered with the WHOLE file from byte 0. Writing that at
  // the old offset appends a second copy of the file into the middle of the first.
  console.log("\n== B. Range honoured, then not, then the link cuts ==");
  await startServer(["--ranges-until", "2", "--cut-every", "4", "--cut-at", "0.4"]);
  {
    resetDisk();
    const { res, err } = await ensureWithin(url, { chunkSize: CHUNK }, 90_000);
    check("the download still finishes", !err && res?.source === "network",
      err ? `threw: ${err.message}` : `${gets().length} GETs`);
    check("nothing was ever written past the announced size", onDisk(url).length === SIZE,
      `${onDisk(url).length} bytes on disk for a ${SIZE} byte file`);
    const bytes = await readCachedBytes(url).catch(() => Buffer.alloc(0));
    check("and the file is byte-identical", sha(Buffer.from(bytes)) === sha(bodyA),
      `${bytes.length} bytes`);
  }

  // ---- B2. a host that never does ranges, cutting every other request -------
  console.log("\n== B2. no HEAD, no ranges, every 3rd response cut ==");
  await startServer(["--no-head", "--no-ranges", "--cut-every", "3", "--cut-at", "0.4"]);
  {
    resetDisk();
    const { res, err } = await ensureWithin(url, { chunkSize: CHUNK }, 90_000);
    check("it completes without ranges", !err && res?.source === "network",
      err ? `threw: ${err.message}` : `${gets().length} GETs`);
    check("each retry restarts at zero instead of appending", onDisk(url).length === SIZE,
      `${onDisk(url).length} bytes on disk`);
    const bytes = await readCachedBytes(url).catch(() => Buffer.alloc(0));
    check("and the file is byte-identical", sha(Buffer.from(bytes)) === sha(bodyA));
  }

  // ---- C. 206 with an empty body --------------------------------------------
  // A valid, successful, zero-byte response: what a connection dropped right
  // after the headers looks like. Not counted as a failure it is an unbounded hot
  // loop — measured at 2,200 requests a second — with a frozen status line and no
  // error ever raised.
  console.log("\n== C. 206 with an empty body ==");
  await startServer(["--empty-every", "1"]);
  {
    resetDisk();
    const { err, timedOut, ms } = await ensureWithin(url, { chunkSize: CHUNK }, 45_000);
    check("it gives up instead of spinning for ever", !!err && !timedOut,
      timedOut ? `still running after ${ms} ms and ${gets().length} requests` : `${err?.message?.slice(0, 90)}`);
    check("and it did not flood the server while doing it", gets().length <= 10,
      `${gets().length} GETs in ${ms} ms`);
  }
  console.log("\n== C2. every other response empty, the rest fine ==");
  await startServer(["--empty-every", "2"]);
  {
    resetDisk();
    const { res, err } = await ensureWithin(url, { chunkSize: CHUNK }, 90_000);
    check("an intermittent empty response is just a retry", !err && res?.source === "network",
      err ? `threw: ${err.message}` : `${gets().length} GETs`);
    const bytes = await readCachedBytes(url).catch(() => Buffer.alloc(0));
    check("and the file is byte-identical", sha(Buffer.from(bytes)) === sha(bodyA));
  }

  // ---- C3. epsilon progress: honest, and endless ----------------------------
  // The hole a failure-only retry budget leaves open. Every response here is a
  // valid 206 at the right offset with a truthful Content-Range — it just
  // carries one byte. Nothing ever fails, so a counter that only counts
  // failures never reaches its ceiling and nothing ever waits.
  console.log("\n== C3. a server that answers honestly, one byte at a time ==");
  await startServer(["--drip", "1"]);
  {
    resetDisk();
    const { err, timedOut, ms } = await ensureWithin(url, { chunkSize: CHUNK }, 45_000);
    check("it gives up rather than crawling for ever", !!err && !timedOut,
      timedOut ? `still running after ${ms} ms and ${gets().length} requests`
               : `${err?.message?.slice(0, 100)}`);
    // Hard number rather than the formula under test: a test that recomputes
    // the ceiling from the same expression would follow it wherever it went.
    check("the ceiling counts every request, not just the failed ones",
      gets().length < 1000,
      `${gets().length} GETs for a ${bodyA.length} byte file`);
  }

  // ---- D. a 206 answering a DIFFERENT interval ------------------------------
  // The failure with no symptoms: every response is a valid 206, the total length
  // comes out exactly right, and the file is a shuffled mess. Same-origin,
  // Content-Range is readable and says so — so it is checked.
  console.log("\n== D. 206 answering an interval nobody asked for ==");
  await startServer(["--shift-range", "1"]);
  {
    resetDisk();
    const { res, err } = await ensureWithin(url, { chunkSize: CHUNK }, 60_000);
    check("the slice is refused rather than written at the wrong offset",
      !!err && /different range/.test(err.message ?? ""),
      err ? err.message.slice(0, 110) : `completed: ${JSON.stringify(res)}`);
    check("no wrong-offset byte reached the file", onDisk(url).length <= CHUNK,
      `${onDisk(url).length} bytes on disk`);
    let served2 = null;
    try { served2 = await readCachedBytes(url); } catch { /* expected */ }
    check("and nothing is served from the mangled entry", served2 === null,
      served2 ? `${served2.length} bytes with sha ${sha(Buffer.from(served2)).slice(0, 16)}` : "refused");
  }

  // ---- E. the file is republished mid-download ------------------------------
  // Same length, different bytes. Every slice is individually valid; the assembled
  // file is two databases spliced together, of exactly the right length.
  console.log("\n== E. the file changes on the server mid-download ==");
  await startServer(["--alt", ALT, "--alt-after", "3"]);
  {
    resetDisk();
    const { res, err } = await ensureWithin(url, { chunkSize: CHUNK }, 60_000);
    check("the change is caught by the per-slice Last-Modified",
      !!err && /changed on the server/.test(err.message ?? ""),
      err ? err.message.slice(0, 110) : `completed: ${JSON.stringify(res)}`);
    check("the spliced prefix is discarded, not left to be resumed onto",
      onDisk(url).length === 0, `${onDisk(url).length} bytes left`);
  }

  // ---- E2. a server that honours If-Range -----------------------------------
  // The conforming answer to "this may have changed": 200 and the whole file,
  // which the client already knows how to handle (NO_RANGE -> restart). Proves the
  // header is really sent, and that it turns a corruption into a clean restart.
  console.log("\n== E2. same, against a server that honours If-Range ==");
  await startServer(["--alt", ALT, "--alt-after", "3", "--honour-if-range"]);
  {
    resetDisk();
    const { res, err } = await ensureWithin(url, { chunkSize: CHUNK }, 90_000);
    check("If-Range turns the republication into a clean restart",
      !err && res?.source === "network", err ? `threw: ${err.message}` : "ok");
    const bytes = await readCachedBytes(url).catch(() => Buffer.alloc(0));
    check("and what is cached is the NEW file, whole",
      sha(Buffer.from(bytes)) === sha(bodyB), `${bytes.length} bytes`);
  }

  // ---- F. a short local write ------------------------------------------------
  // The only corruption that keeps the length exact: write() stores fewer bytes
  // than it was given, the counter advances by the full amount, every later write
  // lands too far along, and the file ends at exactly the right size with a hole
  // in the middle.
  console.log("\n== F. local storage accepts only half of one write ==");
  await startServer();
  {
    resetDisk();
    let done = false;
    writeHook = (piece, at, seq) => {
      if (!done && seq === 3 && piece.length > 2) { done = true; return Math.floor(piece.length / 2); }
      return piece.length;
    };
    const { res, err } = await ensureWithin(url, { chunkSize: CHUNK }, 60_000);
    check("a short write is a failure, not a success", !err && res?.source === "network",
      err ? `threw: ${err.message}` : "completed");
    check("the short write really happened", done === true);
    const bytes = await readCachedBytes(url).catch(() => Buffer.alloc(0));
    check("and the file has no hole (byte-identical)", sha(Buffer.from(bytes)) === sha(bodyA),
      `${bytes.length} bytes, sha ${sha(Buffer.from(bytes)).slice(0, 16)}`);
  }

  // ---- G. out of quota -------------------------------------------------------
  console.log("\n== G. not enough storage, known in advance ==");
  {
    await reset();
    estimate = async () => ({ quota: 1_000_000, usage: 900_000 });
    const { err } = await ensureWithin(url, { chunkSize: CHUNK }, 60_000);
    check("it refuses before downloading anything",
      !!err && /not enough local storage/.test(err.message ?? ""), err?.message?.slice(0, 120));
    check("and not one database byte was fetched", gets().length === 0,
      `${gets().length} GETs, ${served()} bytes`);
  }

  // ---- H. the pointer is published only after the bytes are committed -------
  console.log("\n== H. quota error mid-write: flush before publishing the pointer ==");
  {
    await reset();
    writeHook = (piece, at, seq) => {
      if (seq >= 2) { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; }
      return piece.length;
    };
    const { err } = await ensureWithin(url, { chunkSize: CHUNK }, 60_000);
    check("the quota failure is reported, not retried",
      !!err && /QuotaExceededError/.test(err.message ?? ""), err?.message?.slice(0, 110));
    const last = metaWrites[metaWrites.length - 1];
    check("the resume pointer was published only after a flush",
      !!last && last.dataFlushes >= 1 && last.meta.complete === false,
      `flushes at the last meta write: ${last?.dataFlushes}, received=${last?.meta?.received}`);
  }

  // ---- I. a server with no validator at all ---------------------------------
  // Nothing but the length to tell two versions apart. The entry may still be
  // USED (refusing to cache anything on such a host would be absurd) but it must
  // say so, and it must never resume: a tail from version B on a prefix from
  // version A is the right length and the wrong file.
  console.log("\n== I. a server that sends no Last-Modified and no ETag ==");
  await startServer(["--no-last-modified"]);
  {
    resetDisk();
    const { res, err } = await ensureWithin(url, { chunkSize: CHUNK }, 60_000);
    check("it downloads and says what it could compare",
      !err && res?.validators === "size-only", err ? err.message : `validators=${res?.validators}`);
    const listed = (await listCache()).find(e => e.key === cacheKey(url));
    check("the cache listing carries it too", listed?.validators === "size-only",
      JSON.stringify(listed));
  }
  {
    // A half-finished entry on the same host: resuming would splice.
    await reset();
    seedEntry(url, {
      data: Buffer.from(bodyA.subarray(0, 400_000)),
      meta: { size: SIZE, received: 400_000, complete: false, updated: Date.now(), validators: "size-only" },
    });
    const { res, err } = await ensureWithin(url, { chunkSize: CHUNK }, 60_000);
    check("a partial entry is NOT resumed when only the length could be compared",
      !err && res?.bytesFetched === SIZE,
      err ? err.message : `bytesFetched=${res?.bytesFetched} (a resume would be ${SIZE - 400_000})`);
    check("the whole file really came back over the wire", served() >= SIZE,
      `${served()} bytes in ${gets().length} GETs`);
    const bytes = await readCachedBytes(url).catch(() => Buffer.alloc(0));
    check("and it is byte-identical", sha(Buffer.from(bytes)) === sha(bodyA));
  }

  // ---- J. offline, with nothing cached ---------------------------------------
  console.log("\n== J. server unreachable and nothing in the cache ==");
  await stopServer();
  {
    resetDisk();
    const { err } = await ensureWithin(url, { chunkSize: CHUNK }, 30_000);
    check("the error says what happened and what to do",
      !!err && /could not be reached|offline/.test(err.message ?? "") && /Local file/.test(err.message ?? ""),
      err?.message?.slice(0, 150));
  }

  // ---- K. N workers must hold the SAME database ------------------------------
  console.log("\n== K. the pool is checked for one database, not four ==");
  {
    const same = [{ database_size: 50, k: 31, c: 200, bytes: 10 }, { database_size: 50, k: 31, c: 200, bytes: 10 }];
    const mixed = [{ database_size: 50, k: 31, c: 200, bytes: 10 }, { database_size: 4992, k: 31, c: 200, bytes: 10 }];
    let ok1 = true, ok2 = false, msg = "";
    try { assertSameDatabase(same); } catch { ok1 = false; }
    try { assertSameDatabase(mixed); } catch (e) { ok2 = true; msg = e.message; }
    check("identical metadata passes", ok1);
    check("two different databases in one pool are refused", ok2, msg.slice(0, 110));
  }

  // ---- L2. the cache line says what is FREE, and asks about persistence ------
  {
    const line = cacheSummary({
      estimate: { quota: 10_000_000_000, usage: 8_000_000_000 },
      persisted: true,
      entries: [{ bytes: 433_000_000 }, { bytes: 6_500_000 }],
    });
    check("free space is quota minus usage, not the quota",
      /1\.86 GB still free of 9\.31 GB/.test(line) && !/10\.0/.test(line), line);
    check("what the cache itself occupies is shown", /419.1 MB used by these databases/.test(line), line);
    check("persistence is whatever it is told, both ways",
      /kept until you delete it/.test(line)
      && /may evict it/.test(cacheSummary({ persisted: false, entries: [] })),
      cacheSummary({ persisted: false, entries: [] }));
  }

  // ---- L. validateEntry names the validator it used --------------------------
  {
    const meta = { layout: 1, complete: true, size: 10, lastModified: "x" };
    const withLm = validateEntry(meta, 10, { size: 10, lastModified: "x" });
    const sizeOnly = validateEntry({ layout: 1, complete: true, size: 10 }, 10, { size: 10 });
    check("a Last-Modified match is reported as such", withLm.ok && withLm.validators === "lastModified",
      JSON.stringify(withLm));
    check("a size-only match says so out loud",
      sizeOnly.ok && sizeOnly.validators === "size-only" && /size alone/.test(sizeOnly.why),
      JSON.stringify(sizeOnly));
  }
} finally {
  await stopServer();
}

console.log(`\n${passes} passed, ${failures} failed (node suite)`);
process.exit(failures ? 1 : 0);
