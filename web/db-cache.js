// Resumable, single-flight, locally-cached download of a .syldb reference
// database.
//
// WHY THIS FILE EXISTS
//
// The full UHGG gut database is 454,021,440 bytes served from Zenodo. Measured
// from a European desktop: 1.48 MB/s, i.e. ~5 minutes of continuous transfer.
// Two things were wrong with the old code and both of them are fatal at that
// size:
//
//   1. EVERY WORKER DOWNLOADED IT. multi.js did `rpcs.map(r => r.loadDbUrl(url))`
//      and the worker's loadDbUrl did its own `fetch(url)`. The comment claimed
//      "the browser HTTP cache turns the second fetch into a disk hit, so only
//      one request flies". That is false, twice over: the N fetches are issued
//      SIMULTANEOUSLY, so nothing is in the cache yet when the 2nd..Nth start;
//      and Zenodo sends no Cache-Control and no ETag, so the browser has no
//      basis to reuse anything anyway. With the default pool of 2 that is
//      866 MB; with the 4 the UI offers, 1.7 GB, and the four streams fight
//      each other for the same link. Verified on a local server: 2 workers =
//      2 GET lines in the access log for one "Load database" click.
//   2. ONE 5-MINUTE FETCH, NO RESUME. A single `await resp.arrayBuffer()` over
//      five minutes on a laptop wifi is a coin flip, and any failure meant
//      starting over from byte 0, forever.
//
// WHAT REPLACES IT
//
// One download per database, in slices, written straight into OPFS as they
// arrive, resumable from the last persisted offset (including after a page
// reload), retried with backoff, cancellable, and validated before reuse.
// Workers then read the bytes out of OPFS themselves — the 433 MB never crosses
// postMessage and there is never more than one copy of it in JS at a time.
//
// WHERE IT RUNS
//
// The writing half is worker-only, on purpose. OPFS offers two ways to write:
//
//   - createWritable(): available on the main thread, but it is copy-on-write
//     against a swap file and only commits at close(). Keeping the data across
//     a page reload therefore means closing after every slice, and with
//     keepExistingData:true each open re-copies everything already written —
//     O(n^2/slice), about 11 GB of disk churn for this database.
//   - createSyncAccessHandle(): writes in place, commits at flush(), and is
//     available ONLY inside a dedicated worker.
//
// So the download lives in db-cache-worker.js, which imports this module. The
// window talks to it through dbCacheClient(). The sylph workers import this
// module too, but only for readCachedBytes().
//
// EXPORTS
//   ensureDb(url, opts)         — worker side: download-or-reuse, returns metadata
//   readCachedBytes(url)        — worker side: the validated bytes, or throws
//   downloadToMemory(url, opts) — the no-OPFS fallback
//   listCache() / removeCached(url) / clearCache()
//   dbCacheClient()             — window side: proxy to db-cache-worker.js
//   fmtBytes / fmtRate / fmtEta — shared formatting so both pages agree

// ---- tuning ------------------------------------------------------------------

// Slice size. Small enough that a dropped connection costs little, large enough
// that 433 MB is ~54 requests and not thousands (Zenodo rate-limits at 133
// requests/minute, and each request has a fixed TLS + latency cost).
export const DEFAULT_CHUNK = 8 * 1024 * 1024;

// How much data may be written before the resume pointer is persisted again.
// This is the worst case that has to be re-downloaded after a hard kill of the
// tab: 4 MiB, ~3 s at the measured rate.
const META_INTERVAL = 4 * 1024 * 1024;

// Consecutive attempts that move NOTHING before the download is abandoned, and
// the waits between them (long enough to ride out a wifi handover or a
// transient 5xx). The words "consecutive" and "nothing" are both load-bearing:
//
//   - a failure that still delivered bytes is progress, not a strike. Counting
//     it as a strike is how a link that drops every slice partway — the exact
//     shape of the bug report — gets abandoned six slices in while it is
//     steadily advancing. Measured on a server that RSTs every single request:
//     Chrome hands the ReadableStream only what it had already drained, so an
//     attempt can bank as little as 15% of what the server wrote, and a naive
//     rule stalls at 4.2 MB of 6.2 MB;
//   - "consecutive" so a link that fails intermittently over five minutes is
//     never abandoned on a tally of failures accumulated across the whole run.
const MAX_ATTEMPTS = 6;
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];

// The wait after a failure that DID move bytes. There is nothing to back off
// from — the link is up, it just keeps being cut — so this is only enough to
// avoid a hot loop. It matters: on a link that drops most slices, the backoff
// ladder would otherwise dominate the download time.
//
// (Both waits are setTimeout, and Chrome throttles setTimeout to once a minute
// in a tab that has been hidden for a while. A download left in a background
// tab therefore retries slowly. Measured while testing, worth knowing, not
// worth defeating: the download itself keeps running, only the retries wait.)
const PROGRESS_RETRY_MS = 150;

// The backstop for the pathological middle ground: a server that hands over a
// handful of bytes and dies, forever. Zero-progress attempts are caught by
// MAX_ATTEMPTS; this catches epsilon-progress. Scaled to the work, so it is
// generous for a 433 MB download and still finite.
const attemptCeiling = (size, chunkSize) => 10 * Math.ceil(size / chunkSize) + 50;

const ROOT_DIR = "syldb-cache";

// Bump when the on-disk layout changes; entries written by an older layout are
// ignored (and reported by listCache so they can be deleted).
export const CACHE_LAYOUT = 1;

// ---- small helpers -----------------------------------------------------------

export function absUrl(url) {
  return new URL(url, self.location.href).href;
}

// FNV-1a, 32-bit. Not a checksum of the content — just a short, stable, filename-
// safe token for a URL, so two databases cannot collide in the cache directory.
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// A directory name per URL. Readable prefix so `listCache()` and the OPFS
// inspector in DevTools are legible; hash suffix so it is unique. Zenodo's URL
// ends in ".../gut.syldb/content", so the last path segment alone would be
// "content" for every Zenodo file — take the last two.
export function cacheKey(url) {
  const u = new URL(absUrl(url));
  const segs = u.pathname.split("/").filter(Boolean).slice(-2).join("_");
  const base = (segs || u.hostname).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48);
  return `${base}-${fnv1a(u.href)}`;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(abortError()); }, { once: true });
});

function abortError() {
  const e = new Error("download cancelled");
  e.name = "AbortError";
  return e;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtRate(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return "—";
  return `${fmtBytes(bps)}/s`;
}

export function fmtEta(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  if (sec < 90) return `${Math.ceil(sec)} s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return `${m} min ${String(s).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

// ---- capability probes -------------------------------------------------------

export function opfsSupported() {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
}

// createSyncAccessHandle is the only OPFS write primitive that commits without
// rewriting the whole file, and it exists only in dedicated workers.
export function canWriteCache() {
  return opfsSupported()
    && typeof FileSystemFileHandle !== "undefined"
    && typeof FileSystemFileHandle.prototype.createSyncAccessHandle === "function"
    && typeof WorkerGlobalScope !== "undefined"
    && typeof DedicatedWorkerGlobalScope !== "undefined"
    && self instanceof DedicatedWorkerGlobalScope;
}

// ---- OPFS entry plumbing -----------------------------------------------------

async function rootDir(create) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(ROOT_DIR, { create });
}

async function entryDir(url, create) {
  const dir = await rootDir(create);
  return dir.getDirectoryHandle(cacheKey(url), { create });
}

// Two files per entry: `data` (the database) and `meta.json` (what we know
// about it). Keeping the metadata beside the bytes rather than in localStorage
// means deleting the directory can never leave a lie behind.
async function dataHandle(url, create) {
  const dir = await entryDir(url, create);
  return dir.getFileHandle("data", { create });
}

async function metaHandle(url, create) {
  const dir = await entryDir(url, create);
  return dir.getFileHandle("meta.json", { create });
}

// Readable from anywhere (window or worker): getFile() needs no lock.
export async function readMeta(url) {
  try {
    const h = await metaHandle(url, false);
    const txt = await (await h.getFile()).text();
    const m = JSON.parse(txt);
    return m && m.layout === CACHE_LAYOUT ? m : null;
  } catch {
    return null;
  }
}

// Worker-only (sync access handle).
async function writeMeta(url, meta) {
  const h = await metaHandle(url, true);
  const sync = await h.createSyncAccessHandle();
  try {
    const bytes = new TextEncoder().encode(JSON.stringify({ ...meta, layout: CACHE_LAYOUT }));
    sync.truncate(0);
    sync.write(bytes, { at: 0 });
    sync.flush();
  } finally {
    sync.close();
  }
}

async function dataSize(url) {
  try {
    const h = await dataHandle(url, false);
    return (await h.getFile()).size;
  } catch {
    return 0;
  }
}

// Delete by directory name. This is the primitive, not removeCached(url),
// because the entry a user most wants to delete is the one whose metadata is
// unreadable — and that entry has no URL to delete it by. listCache() always
// reports a key, even when it can report nothing else.
export async function removeCachedKey(key) {
  try {
    const dir = await rootDir(false);
    await dir.removeEntry(key, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export async function removeCached(url) {
  return removeCachedKey(cacheKey(url));
}

export async function clearCache() {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(ROOT_DIR, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

// Everything currently held, with the truth (actual byte count on disk) next to
// the claim (what the metadata says). The UI shows both so a half-finished entry
// is visibly half-finished.
export async function listCache() {
  if (!opfsSupported()) return [];
  const out = [];
  try {
    const dir = await rootDir(false);
    for await (const [key, handle] of dir.entries()) {
      if (handle.kind !== "directory") continue;
      let meta = null, bytes = 0;
      try {
        const f = await (await handle.getFileHandle("meta.json")).getFile();
        meta = JSON.parse(await f.text());
      } catch { /* an entry with no readable metadata is still worth listing */ }
      try {
        bytes = (await (await handle.getFileHandle("data")).getFile()).size;
      } catch { /* ditto */ }
      out.push({
        key,
        url: meta?.url ?? null,
        size: meta?.size ?? null,
        lastModified: meta?.lastModified ?? null,
        received: meta?.received ?? null,
        validators: meta?.validators ?? null,
        complete: meta?.complete === true && bytes === meta?.size,
        bytes,
        stale: meta ? meta.layout !== CACHE_LAYOUT : true,
        updated: meta?.updated ?? null,
      });
    }
  } catch { /* no cache directory yet */ }
  out.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  return out;
}

// ---- server probe ------------------------------------------------------------

function parseContentRange(v) {
  // "bytes 1000000-1000099/454021440"
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(v || "").trim());
  if (!m) return null;
  return { start: +m[1], end: +m[2], total: +m[3] };
}

// What the server says about the file. Two questions, asked separately, because
// only one of them is needed on the common path.
//
// Question 1 — how big is it, and which version is it? A HEAD answers both.
// Content-Length and Last-Modified are CORS-safelisted response headers, so they
// are readable even cross-origin, which matters enormously here (see below).
//
// Question 2 — will it serve slices? Only worth asking when we are about to
// download. `accept-ranges` is NOT consulted: Zenodo answers a Range request
// with a perfectly good 206 and never sends that header, so the only
// trustworthy question is the one asked by requesting a range.
//
// THE CORS TRAP, recorded because it costs nothing to avoid and is invisible in
// local testing: the tempting single-request design is to send `Range:
// bytes=0-0` and read the total out of `Content-Range: bytes 0-0/454021440`.
// That works perfectly against a same-origin server and FAILS SILENTLY against
// Zenodo — Content-Range is not safelisted, and Zenodo's
// Access-Control-Expose-Headers lists Content-Type, ETag, Link and its rate
// limit headers, not Content-Range. `headers.get("content-range")` returns null
// in the browser, and the 206's own Content-Length is 1: the slice, not the
// file. The database would be recorded as one byte long.
async function probeSize(url, signal) {
  const head = await fetch(url, { method: "HEAD", signal, cache: "no-store" }).catch((e) => {
    if (e?.name === "AbortError") throw e;
    return null;   // some hosts do not answer HEAD; fall through to the range probe
  });
  if (head?.ok) {
    const size = Number(head.headers.get("content-length") || 0);
    if (Number.isFinite(size) && size > 0) {
      return {
        size,
        // TRANSFER size, not content size, whenever the response is encoded.
        // fetch() decompresses transparently, so the reader delivers MORE bytes
        // than Content-Length declares and the overrun guard fires on a perfectly
        // good download. Measured on GitHub Pages: db/screening.syldb is
        // 13,319,802 bytes and is served `Content-Encoding: gzip` with
        // Content-Length 11,736,250 — and a Range probe returns
        // `Content-Range: bytes 0-0/11736250`, the compressed total as well, so
        // NO header carries the real size. The browser cannot ask for identity
        // either: Accept-Encoding is a forbidden header name for fetch().
        // The caller's expected size is therefore the only truth available.
        encoded: !!head.headers.get("content-encoding"),
        lastModified: head.headers.get("last-modified"),
        etag: head.headers.get("etag"),
        ranges: null,      // not asked yet
      };
    }
  }
  return null;
}

// The 1-byte range request. Also yields the size wherever Content-Range is
// visible, so a server with no HEAD is still fully handled.
async function probeRanges(url, signal) {
  const resp = await fetch(url, { headers: { Range: "bytes=0-0" }, signal, cache: "no-store" });
  try { await resp.body?.cancel(); } catch { /* fine */ }
  if (!resp.ok && resp.status !== 206) {
    throw new Error(`HTTP ${resp.status} while probing the database`);
  }
  const ranges = resp.status === 206;
  const cr = parseContentRange(resp.headers.get("content-range"));
  return {
    size: cr?.total ?? (ranges ? 0 : Number(resp.headers.get("content-length") || 0)),
    encoded: !!resp.headers.get("content-encoding"),
    lastModified: resp.headers.get("last-modified"),
    etag: resp.headers.get("etag"),
    ranges,
  };
}

// One request in the normal case: a HEAD. Only if that yields no usable size —
// a host that blocks HEAD — does the range probe run as a fallback, since
// Content-Range gives the total wherever it is visible.
//
// Note what is NOT asked: whether the server honours Range. It used to be, and
// that was a mistake with teeth. Answering it costs a request, and worse, a
// single transient failure of that one request (a 503 from a server that fails
// intermittently — precisely the server this whole file exists for) was read as
// "this host does not do ranges", which silently turned a resumable 433 MB
// download into an all-or-nothing one. Measured in the test suite: with every
// second request failing, the download completed as ONE unresumable GET.
//
// Instead, ranges are assumed to work and the FIRST SLICE settles it for real:
// a 200 where a 206 was expected is handled in fetchRangeInto (accepted whole at
// offset 0, and a hard reset mid-download). Optimism costs nothing here and
// cannot be fooled by a flaky response.
export async function probe(url, signal) {
  const bySize = await probeSize(url, signal);
  if (bySize) return { ...bySize, ranges: true };

  const byRange = await probeRanges(url, signal);
  if (!Number.isFinite(byRange.size) || byRange.size <= 0) {
    throw new Error(
      "the server did not report the database size (no readable Content-Length). " +
      "For a cross-origin host this usually means HEAD is blocked and Content-Range is not exposed.");
  }
  return byRange;
}

// WHICH validator actually compared, when a cached entry is checked against what
// the server offers now. This is not a detail: "the sizes match" is a far weaker
// statement than "the ETag matches", and the difference decides whether a
// half-downloaded file may be resumed onto.
//
// A server that sends neither ETag nor Last-Modified (or an entry written when
// it did not) leaves nothing but the length to compare — and two different
// databases of the same length are entirely possible, since the file is
// republished at the same URL. That case is named, recorded in the metadata,
// shown in the UI, and above all it forbids RESUMING: splicing a tail from
// version B onto a prefix from version A produces a file of exactly the right
// length whose contents are nonsense, and nothing downstream can detect it.
export function validatorKind(meta, remote) {
  if (meta?.etag && remote?.etag) return "etag";
  if (meta?.lastModified && remote?.lastModified) return "lastModified";
  return "size-only";
}

// Is a cached entry usable for what the server is offering right now?
//
// Deliberately strict: a database that is the wrong size or a different build is
// not "close enough". sylph will happily decode a truncated .syldb into fewer
// genomes, or fail in a way that surfaces as a JS error nobody reads, and either
// way the user gets abundances that are quietly wrong. Re-downloading 433 MB is
// cheaper than a wrong answer.
export function validateEntry(meta, actualBytes, remote) {
  if (!meta) return { ok: false, why: "no cache entry" };
  if (meta.layout !== CACHE_LAYOUT) return { ok: false, why: "written by an older cache layout" };
  if (!meta.complete) return { ok: false, why: `incomplete (${meta.received ?? 0}/${meta.size ?? "?"} bytes)` };
  if (!Number.isFinite(meta.size) || meta.size <= 0) return { ok: false, why: "cached size is unknown" };
  if (actualBytes !== meta.size) {
    return { ok: false, why: `truncated on disk (${actualBytes} bytes, expected ${meta.size})` };
  }
  if (remote) {
    if (Number.isFinite(remote.size) && remote.size > 0 && remote.size !== meta.size) {
      return { ok: false, why: `the server now offers ${remote.size} bytes, the cache holds ${meta.size}` };
    }
    if (remote.etag && meta.etag && remote.etag !== meta.etag) {
      return { ok: false, why: "ETag changed on the server", validators: "etag" };
    }
    if (remote.lastModified && meta.lastModified && remote.lastModified !== meta.lastModified) {
      return {
        ok: false, validators: "lastModified",
        why: `Last-Modified changed (${meta.lastModified} → ${remote.lastModified})`,
      };
    }
  }
  const validators = validatorKind(meta, remote);
  return {
    ok: true,
    validators,
    // Said out loud rather than implied, because the UI repeats it: on a host
    // that offers no validator, "matches" means "is the same number of bytes".
    why: validators === "size-only"
      ? "matched on size alone — this server offers no ETag or Last-Modified to compare"
      : `size and ${validators === "etag" ? "ETag" : "Last-Modified"} match`,
  };
}

// The one line above the cache listing, shared by both pages so they cannot
// drift apart — and so it can be tested, which the two bugs it replaces could
// not be:
//
//   - it announced the TOTAL quota as "available", ignoring the `usage` the very
//     same estimate provides. A user with 8 GB already stored was told "of about
//     10.01 GB available" and started a second 433 MB download on the strength of
//     it. What is free is quota MINUS usage.
//   - it described persistence from a variable that is only ever set by the first
//     download of a session, so a returning visitor — whose storage IS persistent
//     — was always told "the browser may evict it".
export function cacheSummary({ estimate, persisted, entries } = {}) {
  const parts = [
    persisted
      ? "kept until you delete it"
      : "the browser may evict it if disk space runs short",
  ];
  const used = (entries ?? []).reduce((a, e) => a + (e.bytes ?? 0), 0);
  if (used > 0) parts.push(`${fmtBytes(used)} used by these databases`);
  const quota = estimate?.quota, usage = estimate?.usage;
  if (Number.isFinite(quota) && Number.isFinite(usage)) {
    parts.push(`${fmtBytes(Math.max(0, quota - usage))} still free of ${fmtBytes(quota)}`);
  } else if (Number.isFinite(quota)) {
    parts.push(`${fmtBytes(quota)} total quota`);
  }
  return parts.join(" · ");
}

// Do N workers hold the SAME database? The pool is loaded one worker at a time
// (a 433 MB OPFS read each), so the loads are seconds apart, and another tab is
// free to invalidate and rewrite the entry in between. Each read validates
// ITSELF against the metadata of the moment; nothing compares worker 1 with
// worker 4. Two references mixed into one abundance matrix, under one header,
// is exactly the silent-wrong-answer failure this module exists to prevent.
export function assertSameDatabase(metas) {
  const list = (metas ?? []).filter(Boolean);
  if (list.length < 2) return;
  const keys = ["database_size", "k", "c", "bytes"];
  const ref = list[0];
  for (let i = 1; i < list.length; i++) {
    for (const key of keys) {
      if (list[i]?.[key] !== ref?.[key]) {
        throw new Error(
          `the database changed while it was being handed to the workers: worker 1 has ` +
          `${key}=${ref?.[key]}, worker ${i + 1} has ${key}=${list[i]?.[key]}. ` +
          `Another tab probably replaced the cached copy — click Load database again.`);
      }
    }
  }
}

// A sync access handle is an EXCLUSIVE lock on the file. Two tabs of this site
// (or the profile page and the multi-sample page in two windows) asking for the
// same database at the same time is an ordinary thing to do, and the loser gets
// NoModificationAllowedError immediately. Wait for the other one instead of
// failing: it is downloading the very bytes we want, and when it lets go the
// entry is either complete (so we never enter this function again) or resumable.
async function openForWrite(fileHandle, signal, waits = [200, 500, 1000, 2000, 4000, 8000]) {
  let last = null;
  for (let i = 0; i <= waits.length; i++) {
    if (signal?.aborted) throw abortError();
    try {
      return await fileHandle.createSyncAccessHandle();
    } catch (e) {
      if (e?.name !== "NoModificationAllowedError" && e?.name !== "InvalidStateError") throw e;
      last = e;
      if (i === waits.length) break;
      await sleep(waits[i], signal);
    }
  }
  throw new Error(
    "another tab of this site is already downloading this database — " +
    `wait for it to finish, or close the other tab (${last?.message ?? last})`);
}

// The queue the file lock above cannot provide.
//
// A sync access handle fails IMMEDIATELY when someone else holds it, so the only
// thing openForWrite can do is poll and eventually give up — and, worse, the
// decision it acts on (how many bytes are already there, is the entry valid) was
// taken BEFORE the wait. The loser of that race would truncate away the complete
// entry the winner had just finished writing, and download 433 MB again.
//
// Web Locks are a real queue: request() waits until the holder lets go, and the
// callback runs with the lock held, so the state can be re-read at a moment when
// nobody else can be changing it. Available wherever OPFS is, dedicated workers
// included; when it is missing the caller still works, it just falls back to the
// polling handle above.
async function withWriteLock(u, signal, emit, fn) {
  if (typeof navigator?.locks?.request !== "function") return fn();
  const name = `syldb-cache:${cacheKey(u)}`;
  const NOT_GRANTED = Symbol("not-granted");
  // `entered` separates a failure of the LOCK from a failure of the work: the
  // API can exist and still be unusable (an insecure context, an exotic
  // embedding), and losing the download over that would be absurd — the sync
  // access handle below is still an exclusive lock, just a worse one.
  let entered = false;
  const run = async (lock) => {
    if (!lock) return NOT_GRANTED;
    entered = true;
    return fn();
  };
  try {
    // Asked without blocking first, purely so the wait can be explained rather
    // than looking like a freeze.
    const first = await navigator.locks.request(name, { ifAvailable: true }, run);
    if (first !== NOT_GRANTED) return first;
    emit("wait", {
      note: "another tab of this site is downloading this database — waiting for it to finish " +
        "(it will be reused, not downloaded twice)",
    });
    return await navigator.locks.request(name, signal ? { signal } : {}, run);
  } catch (e) {
    if (entered || e?.name === "AbortError") throw e;
    return fn();
  }
}

// Running out of disk is not a transient failure, and retrying it six times
// with backoff just makes the user wait 30 s for the same answer.
function isFatalWriteError(e) {
  return e?.name === "QuotaExceededError" || e?.name === "NotAllowedError";
}

// Is there room for what is about to be downloaded? Asked BEFORE the first byte,
// because the alternative — finding out at 380 MB of 433 — wastes four minutes
// and leaves the partial file consuming the very quota that ran out.
// navigator.storage.estimate() exists in workers; when it says nothing usable,
// nothing is claimed and the write-time QuotaExceededError remains the backstop.
async function storageShortfall(need) {
  let est = null;
  try { est = await navigator.storage.estimate(); } catch { return null; }
  const quota = est?.quota, usage = est?.usage;
  if (!Number.isFinite(quota) || !Number.isFinite(usage)) return null;
  const free = quota - usage;
  return free < need ? { need, free, quota, usage } : null;
}

// Same-origin? Decides whether a request header that is NOT CORS-safelisted may
// be sent (see If-Range in fetchRangeInto).
function sameOrigin(url) {
  try { return new URL(url).origin === new URL(self.location.href).origin; }
  catch { return false; }
}

// ---- rate / ETA --------------------------------------------------------------

// Progress is emitted from the stream loop, which runs once per network chunk —
// about 64 KB, so roughly 7,000 times for the full database. Each one is a
// postMessage to the page and a DOM write. Throttling to ~7 Hz keeps the
// readout live (the whole point) without making the download's own progress
// bar the reason the tab stutters. The final event is never dropped.
function throttle(fn, ms = 150) {
  let last = 0;
  return (force, ...args) => {
    const now = performance.now();
    if (!force && now - last < ms) return;
    last = now;
    fn(...args);
  };
}

// Throughput over a trailing window rather than since the start, so the number
// reacts to the link actually slowing down instead of averaging a stall away.
function rateMeter(windowMs = 5000) {
  const pts = [];
  return {
    push(received) {
      const now = performance.now();
      pts.push([now, received]);
      while (pts.length > 2 && now - pts[0][0] > windowMs) pts.shift();
      const [t0, b0] = pts[0];
      const dt = (now - t0) / 1000;
      return dt > 0.25 ? (received - b0) / dt : NaN;
    },
  };
}

// ---- the download ------------------------------------------------------------

// Fetch [start, end] inclusive and hand every piece to `sink` as it arrives.
// Returns how many bytes were actually written. Throws on a cut, having already
// written (and told the caller about) everything that did arrive — that is what
// makes an interruption cost one slice at most instead of the whole file.
// `expect` is what the probe learned: { size, lastModified, etag }. It is used
// to check that this slice belongs to the same file, at the same offset, as
// every other slice — see the three notes below.
async function fetchRangeInto(url, start, end, ranges, sink, signal, expect = null) {
  const headers = {};
  if (ranges) {
    headers.Range = `bytes=${start}-${end}`;
    // If-Range, but ONLY same-origin. A conforming server answers a stale
    // If-Range with 200 and the whole file instead of a 206 from a NEWER
    // version, which lands in the NO_RANGE path below and restarts cleanly —
    // that is the cheapest possible guarantee that 54 slices come from one file.
    //
    // Cross-origin it must not be sent: `Range` is a CORS-safelisted request
    // header, `If-Range` is NOT, so adding it turns every slice request into a
    // preflighted one. Zenodo does not answer OPTIONS with an
    // Access-Control-Allow-Headers that permits it, so the "safety" header would
    // fail the download outright. Cross-origin the per-slice Last-Modified check
    // below does the same job with a header that IS readable.
    const validator = expect?.etag || expect?.lastModified;
    if (validator && sameOrigin(url)) headers["If-Range"] = validator;
  }
  const resp = await fetch(url, { headers, signal, cache: "no-store" });
  if (resp.status === 200 && ranges && start > 0) {
    // The server changed its mind about Range mid-download (or a proxy did).
    // Refusing the body here is important: it is the whole file.
    try { await resp.body?.cancel(); } catch { /* fine */ }
    const e = new Error("server ignored Range mid-download");
    e.code = "NO_RANGE";
    throw e;
  }
  if (!resp.ok && resp.status !== 206) throw new Error(`HTTP ${resp.status}`);

  // Which slice is this, really? A 206 answering a DIFFERENT interval than the
  // one asked for — a CDN that clamps ranges, a caching proxy serving another
  // variant — would otherwise be written at `received`, i.e. at the wrong
  // offset, and a file of the right length with shuffled contents is undetectable
  // afterwards.
  //
  // Content-Range is not a CORS-safelisted RESPONSE header, and Zenodo does not
  // list it in Access-Control-Expose-Headers, so cross-origin this reads null and
  // the check cannot run — a documented residual risk, not an oversight. Where it
  // IS readable (the bundled gut_mini.syldb and any self-hosted copy: same
  // origin) it is free, so it is checked.
  if (resp.status === 206) {
    const cr = parseContentRange(resp.headers.get("content-range"));
    if (cr && (cr.start !== start
               || (Number.isFinite(expect?.size) && expect.size > 0 && cr.total !== expect.size))) {
      try { await resp.body?.cancel(); } catch { /* fine */ }
      throw new Error(
        `the server answered a different range than the one asked for ` +
        `(asked ${start}-${end}, got ${cr.start}-${cr.end}/${cr.total})`);
    }
  }
  // Is it still the same file? Last-Modified IS safelisted, so unlike
  // Content-Range this one works cross-origin, and it is the check that catches a
  // republication (or a multi-backend CDN) mid-download — the case where every
  // slice is individually valid, the total length is right, and the assembled
  // .syldb is two different databases spliced together.
  const lm = resp.headers.get("last-modified");
  if (expect && !expect.lastModified && lm) {
    // We hold no bytes of any version yet (a fresh start, or a restart that
    // threw everything away), so THIS response defines which version is being
    // assembled, and every later slice is checked against it. Adopting it here
    // rather than keeping the probe's value for ever is what lets the NO_RANGE
    // restart below pick up a file that was republished, instead of dying on the
    // difference it just recovered from.
    expect.lastModified = lm;
  } else if (expect?.lastModified && lm && lm !== expect.lastModified) {
    try { await resp.body?.cancel(); } catch { /* fine */ }
    const e = new Error(
      `the file changed on the server while it was downloading ` +
      `(Last-Modified ${expect.lastModified} → ${lm})`);
    e.code = "CHANGED";
    throw e;
  }
  if (!resp.body) throw new Error("response has no body stream");

  const reader = resp.body.getReader();
  let written = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value?.length) {
        sink(value);
        written += value.length;
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return written;
}

// The retry policy, in ONE place.
//
// Both callers below need the same rules, and the no-OPFS fallback used to be a
// second, weaker implementation of them: no NO_RANGE handling, no "zero bytes is
// a failure", and every failure counted as a strike whether or not it had
// delivered bytes — so a link that cuts every slice was abandoned after six cuts
// while it was steadily advancing, on the exact configuration the OPFS path
// survives. A policy this fiddly gets one implementation.
//
// `io` is the only difference between the two:
//   write(piece, at)    -> bytes actually stored. LESS than piece.length is a
//                          failure, not a success (see the short-write note).
//   rewind()            -> forget everything: the only offset at which the
//                          answer to a request with no Range header may be
//                          written is 0.
//   flush()             -> commit pending bytes.
//   checkpoint(n, done) -> publish the resume pointer (a no-op in memory).
//   fatalWrite(e, n)    -> an Error to throw instead of retrying, or null.
//
// Returns the byte count once the file is complete; throws otherwise, having
// already flushed and checkpointed whatever did arrive.
async function pumpDownload(u, remote, { chunkSize, signal, emit, io, expect, from = 0 }) {
  let received = from;
  let ranges = remote.ranges;
  let attempt = 0;          // CONSECUTIVE attempts that moved nothing
  // EVERY request, not just the failed ones. Counting only failures leaves a
  // hole a server can walk through: answer one byte per request and every round
  // is a "success", so `attempt` resets, the ceiling is never consulted, and
  // there is no wait between requests. 433 MB at one byte a time is 454 million
  // requests, with a status line that keeps saying it is making progress.
  // The ceiling is generous (10 requests per slice plus 50), so honest retries
  // are never the thing that trips it.
  let totalAttempts = 0;
  let noRangeResets = 0;
  let lastPersist = received;
  const meter = rateMeter();
  const emitDownload = throttle((extra) => emit("download", extra));

  // A request sent WITHOUT a Range header is answered with the whole file from
  // byte 0. Writing that body at `received` — which is what happens if the
  // pointer is not reset — splices a complete second copy into the middle of the
  // file: a valid prefix followed by the whole file again. Measured: a 1 MB file
  // resumed at 300 000 became 1 300 000 bytes on disk, and the next visit served
  // it as complete. The invariant is re-established before EVERY attempt rather
  // than at the two places that happen to set `ranges = false`, because it is
  // the attempt, not the reason for it, that has to be safe.
  const rewind = () => {
    received = 0;
    lastPersist = 0;
    io.rewind();
    // Nothing of any version is held any more, so the next response is free to
    // define which version this is (see fetchRangeInto).
    if (expect) { expect.lastModified = null; expect.etag = null; }
  };

  while (received < remote.size) {
    if (signal?.aborted) throw abortError();
    totalAttempts++;
    if (totalAttempts > attemptCeiling(remote.size, chunkSize)) {
      throw new Error(
        `giving up after ${totalAttempts} requests, still only ` +
        `${fmtBytes(received)} of ${fmtBytes(remote.size)} — the server is not ` +
        `delivering this file at a usable rate`,
      );
    }
    if (!ranges && received !== 0) rewind();
    const start = received;
    const end = ranges ? Math.min(remote.size, start + chunkSize) - 1 : remote.size - 1;
    const before = received;

    const sink = (piece) => {
      // Never write past the size the server declared. Keeping the invariant
      // LOCAL — here, at the write — rather than checking the total at the end
      // means a server that overruns cannot put a byte in the wrong place, and
      // it costs one comparison per network chunk.
      if (received + piece.length > remote.size) {
        const e = new Error(
          `the server sent more than the ${remote.size} bytes it declared ` +
          `(${received + piece.length} and counting)`);
        e.code = "OVERRUN";
        throw e;
      }
      const n = io.write(piece, received);
      // FileSystemSyncAccessHandle.write() returns a byte count precisely
      // because it can be SHORT (disk pressure). Ignoring it and advancing by
      // piece.length punches a HOLE: every later write lands at an offset that is
      // too high, the final length still comes out exact, and neither the length
      // check nor validateEntry nor readCachedBytes can see it — the one
      // corruption path that does not show up as a length mismatch. Advance by
      // what really landed and treat the shortfall as a failed attempt; with
      // ranges the retry simply resumes at the true offset.
      const stored = Number.isFinite(n) ? n : piece.length;
      received += stored;
      if (stored !== piece.length) {
        const e = new Error(
          `local storage accepted only ${stored} of ${piece.length} bytes ` +
          `at offset ${received - stored}`);
        e.code = "SHORT_WRITE";
        throw e;
      }
      const bps = meter.push(received);
      const left = remote.size - received;
      emitDownload(left === 0, {
        received, total: remote.size, bps,
        etaSec: Number.isFinite(bps) && bps > 0 ? left / bps : NaN,
        attempt,
      });
    };

    try {
      const got = await fetchRangeInto(u, start, end, ranges, sink, signal, expect);
      if (got > 0) attempt = 0;
      // A response carrying zero bytes is a failure wearing a success's clothes:
      // it is exactly what a connection cut right after the headers looks like.
      // Raised rather than counted here, so that the block below — which knows
      // about strikes, ceilings and waiting — is the only place that decides what
      // to do about a failure. Counted-but-never-checked on this path, it was an
      // unbounded, silent, waitless hot loop: measured at 2,200 requests per
      // second against a server answering 206 with an empty body, with the status
      // line frozen and no error ever raised.
      else throw new Error("the server answered with an empty body");
    } catch (e) {
      if (e?.name === "AbortError" || signal?.aborted) {
        io.flush();
        await io.checkpoint(received, false);
        throw abortError();
      }
      const fatal = io.fatalWrite?.(e, received);
      if (fatal) {
        // Out of disk (or storage denied). Keep what was written — the user may
        // free space and resume — but do not pretend a retry will help. Flushed
        // BEFORE the pointer is published, like every other exit: a pointer ahead
        // of the committed bytes is a hole waiting to be resumed onto.
        io.flush();
        await io.checkpoint(received, false);
        throw fatal;
      }
      if (e?.code === "OVERRUN" || e?.code === "CHANGED") {
        // The server is not serving the file that was probed. Nothing on disk can
        // be shown to belong to a single version any more, and a prefix of
        // unknown provenance is the one thing that must never be resumed onto: it
        // would produce a full-length file of mixed contents, which no check
        // downstream can detect.
        rewind();
        io.flush();
        await io.checkpoint(0, false);
        throw new Error(
          `${e.message} — the partial copy was discarded; ` +
          `click Load database again to start over.`);
      }
      if (e?.code === "NO_RANGE" && noRangeResets === 0) {
        // Start over from zero, without ranges. Costly, but correct, and it only
        // happens if the server contradicts its own probe.
        noRangeResets++;
        ranges = false;
        rewind();
        await io.checkpoint(0, false);
        emit("download", {
          received, total: remote.size,
          note: "server stopped honouring Range — restarting without resume",
        });
        continue;
      }
      // Any forward movement clears the strike count (see MAX_ATTEMPTS).
      attempt = received > before ? 0 : attempt + 1;
      // Not counted here: the top of the loop already counted this request.
      // Checked again all the same, so a failure gives the message that names
      // the dropped connection rather than the generic one.
      if (totalAttempts > attemptCeiling(remote.size, chunkSize)) {
        io.flush();
        await io.checkpoint(received, false);
        throw new Error(
          `giving up after ${totalAttempts} attempts, still only ` +
          `${fmtBytes(received)}/${fmtBytes(remote.size)}: the connection keeps dropping. ` +
          `The bytes already fetched are kept — clicking Load database again resumes here.`);
      }
      if (attempt >= MAX_ATTEMPTS) {
        io.flush();
        await io.checkpoint(received, false);
        throw new Error(
          `download failed after ${attempt} attempts at ${fmtBytes(received)}/${fmtBytes(remote.size)}: ` +
          `${e?.message ?? e}. The bytes already fetched are kept — clicking Load database again resumes here.`);
      }
      io.flush();
      await io.checkpoint(received, false);
      lastPersist = received;
      // A retry that follows real progress waits the minimum: the link is
      // working, it just keeps being cut, and there is nothing to back off from.
      // The ladder is for a link that is genuinely down.
      const wait = attempt === 0
        ? PROGRESS_RETRY_MS
        : BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
      emit("retry", {
        received, total: remote.size, attempt, waitMs: wait,
        note: attempt === 0
          ? `${e?.message ?? e} — resuming at ${fmtBytes(received)} in ${(wait / 1000).toFixed(1)} s`
          : `${e?.message ?? e} — retrying in ${(wait / 1000).toFixed(1)} s (attempt ${attempt}/${MAX_ATTEMPTS})`,
      });
      await sleep(wait, signal);
      continue;
    }

    if (received - lastPersist >= META_INTERVAL || received >= remote.size) {
      io.flush();
      await io.checkpoint(received, received >= remote.size);
      lastPersist = received;
    }
  }
  return received;
}

// A cached entry that is usable as it stands, or null. Cheap (two OPFS metadata
// reads), so it is asked before taking the write lock AND again once the lock is
// held — the second time is the one that matters: everything read before the
// wait may have been replaced by the very tab that was being waited for.
async function cacheHitFor(u, remote, emit) {
  const meta = await readMeta(u);
  const onDisk = await dataSize(u);
  const verdict = validateEntry(meta, onDisk, remote);
  if (!verdict.ok) return null;
  // With no reachable server this is an UNREVALIDATED hit: the entry is
  // internally consistent (complete, and the file is exactly the length it says)
  // but nobody confirmed the server still offers those bytes. Using it is right
  // — refusing to work offline because a HEAD failed would be absurd — but the
  // caller is told, so the UI can say so rather than imply freshness.
  emit("done", {
    received: meta.size, total: meta.size, source: "cache",
    revalidated: !!remote, validators: verdict.validators,
    note: remote ? verdict.why : `${verdict.why} (server unreachable, not revalidated)`,
  });
  return {
    source: "cache", size: meta.size, lastModified: meta.lastModified,
    validators: verdict.validators, revalidated: !!remote,
    key: cacheKey(u), url: u, bytesFetched: 0,
  };
}

// Offline with nothing usable in the cache is not a mysterious "Failed to
// fetch": it is a situation with two ways out, and both are worth naming.
function unreachableError(probeError) {
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  return new Error(
    `${offline ? "This computer appears to be offline" : "The server could not be reached"}, ` +
    `and there is no usable copy of this database on this computer yet ` +
    `(${probeError?.message ?? probeError}). Reconnect and click Load database again, ` +
    `or choose “Local file…” to use a .syldb already on your disk.`);
}

// Everything that WRITES the entry. Runs with the write lock held.
async function downloadEntry(u, remote, { emit, signal, chunkSize }) {
  const meta0 = await readMeta(u);
  const onDisk = await dataSize(u);
  const metaReceived = Number.isFinite(meta0?.received) ? meta0.received : 0;

  // An entry whose pointer or file runs PAST the size the server announces is
  // not a short prefix of the right file: it is evidence that bytes went
  // somewhere they do not belong, and the only safe reading of it is "corrupt".
  // Clamping it to remote.size instead — which is what used to happen — turned an
  // over-long pointer into "I already have everything": the loop never ran, the
  // final check compared a length to a length and passed, and the entry was
  // published COMPLETE without a single byte having been requested. Measured:
  // source=network, bytesFetched=0, zero GET requests, and a sha256 that differs
  // from the file on the server. An inconsistency invalidates; it never gets
  // shaved to fit.
  const coherent = metaReceived >= 0 && metaReceived <= remote.size && onDisk <= remote.size;
  // For a brand-new entry the question is what the SERVER offers, not what a
  // metadata file that does not exist yet holds.
  const validators = validatorKind(meta0 ?? remote, remote);

  // Can an interrupted download of the SAME bytes be continued? Only if every
  // validator we have still matches; otherwise the partial file is garbage that
  // happens to have the right prefix length.
  //
  // Note this also covers an entry that claimed to be complete but is short on
  // disk: what is there is a clean PREFIX of the right file, so only the tail is
  // refetched. Such an entry is still never *served* — validateEntry rejected it
  // before we got here, and readCachedBytes rejects it independently at the point
  // of use.
  //
  // What none of this can catch is corruption in the MIDDLE of a complete file of
  // the right length: nothing short of hashing the content would, and neither
  // Zenodo nor any static host offers a content hash in its response headers.
  const resumable = !!meta0
    && meta0.layout === CACHE_LAYOUT
    && meta0.size === remote.size
    && coherent
    // Length is not an identity. With no ETag and no Last-Modified to compare,
    // "same size" cannot distinguish version A from version B, and resuming would
    // splice B's tail onto A's prefix — right length, wrong contents, undetectable
    // for ever after. Re-downloading is the cheap option.
    && validators !== "size-only"
    && (!meta0.lastModified || !remote.lastModified || meta0.lastModified === remote.lastModified)
    && (!meta0.etag || !remote.etag || meta0.etag === remote.etag);

  // The persisted pointer, never the file length: bytes past `received` may have
  // been written but not committed, and trusting them would splice a hole into
  // the file if the last write was itself truncated.
  let received = resumable ? Math.min(metaReceived, onDisk) : 0;
  if (!remote.ranges) received = 0;   // no Range support: the only offer is "from zero"

  // Asked BEFORE the first byte. Finding out at 380 MB of 433 costs four minutes
  // and leaves the partial file holding down the very quota that ran out.
  const short = await storageShortfall(remote.size - received);
  if (short) {
    throw new Error(
      `not enough local storage for this database: it needs ${fmtBytes(short.need)} more, ` +
      `and only ${fmtBytes(short.free)} of the browser's ${fmtBytes(short.quota)} quota is free ` +
      `(${fmtBytes(short.usage)} already in use). Delete a cached database, or free some disk ` +
      `space, and click Load database again.`);
  }

  const startedAt = received;
  const fileHandle = await dataHandle(u, true);
  const sync = await openForWrite(fileHandle, signal);

  // The version being assembled, as opposed to the version the probe saw. They
  // differ after a restart that discarded everything (see pumpDownload's rewind),
  // and it is THIS one that has to be recorded, or the entry would be filed under
  // a Last-Modified its bytes do not come from.
  const expect = { size: remote.size, lastModified: remote.lastModified, etag: remote.etag };
  const persist = (n, complete) => writeMeta(u, {
    url: u, size: remote.size, lastModified: expect.lastModified, etag: expect.etag,
    validators, received: n, complete, updated: Date.now(), chunkSize,
  });
  const io = {
    write: (piece, at) => sync.write(piece, { at }),
    rewind: () => sync.truncate(0),
    // Guarded: a failing flush must not replace the real error (running out of
    // disk, typically) with its own. The pointer it protects is re-clamped to the
    // real file length on the way back in, so the worst case is refetching a
    // slice.
    flush: () => { try { sync.flush(); } catch { /* see above */ } },
    checkpoint: (n, complete) => persist(n, complete),
    fatalWrite: (e, n) => (isFatalWriteError(e)
      ? new Error(
        `cannot write the database to local storage at ${fmtBytes(n)}/${fmtBytes(remote.size)}: ` +
        `${e.name}. Free some disk space, or delete a cached database, and click Load database again.`)
      : null),
  };

  try {
    sync.truncate(received);   // drop anything past the trusted pointer
    await persist(received, false);
    emit("start", {
      received, total: remote.size, resumed: received > 0, ranges: remote.ranges,
      validators,
      note: (received > 0
        ? `resuming at ${fmtBytes(received)} of ${fmtBytes(remote.size)}`
        : `starting ${fmtBytes(remote.size)} download${remote.ranges ? "" : " (server does not do ranges — no resume)"}`)
        + (validators === "size-only"
          ? " — this server offers no ETag or Last-Modified, so the copy can only ever be checked on its length"
          : ""),
    });

    const finalReceived = await pumpDownload(u, remote, { chunkSize, signal, emit, io, expect, from: received });

    sync.flush();
    const finalSize = sync.getSize();
    if (finalSize !== remote.size || finalReceived !== remote.size) {
      // The counter and the file disagree: something is wrong with our own
      // bookkeeping, and a wrong-sized .syldb must never be handed to sylph.
      await persist(Math.min(finalReceived, finalSize), false);
      throw new Error(
        `wrote ${finalSize} bytes but the server declared ${remote.size} — cache entry left incomplete`);
    }
    await persist(remote.size, true);
    emit("done", {
      received: remote.size, total: remote.size, source: "network", validators,
      note: `downloaded ${fmtBytes(remote.size - startedAt)}${startedAt > 0 ? ` (resumed from ${fmtBytes(startedAt)})` : ""}`,
    });
    return {
      source: "network", size: remote.size, lastModified: expect.lastModified,
      validators, key: cacheKey(u), url: u, bytesFetched: remote.size - startedAt,
    };
  } finally {
    sync.close();
  }
}

// The public entry point on the worker side.
//
// Returns { source: "cache" | "network", size, lastModified, validators, key,
// url, bytesFetched }. `onProgress` receives
// { phase, received, total, bps, etaSec, attempt, note }.
export async function ensureDb(url, { onProgress, signal, chunkSize = DEFAULT_CHUNK,
  expectedSize = null } = {}) {
  const u = absUrl(url);
  if (!canWriteCache()) throw new Error("OPFS write access is unavailable in this context");

  const emit = (phase, extra) => { try { onProgress?.({ phase, ...extra }); } catch { /* UI must not break the download */ } };

  emit("probe", { note: "asking the server for size and validators" });
  let remote = null;
  let probeError = null;
  try {
    // One HEAD: is the cached copy still the right file? That is a size and a
    // Last-Modified, nothing more. A returning visitor pays exactly this.
    remote = await probe(u, signal);
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    probeError = e;   // offline? A complete cache entry is still usable.
  }

  // A usable entry needs no lock and no writing at all, so it is asked for
  // before queueing behind anyone.
  const hit = await cacheHitFor(u, remote, emit);
  if (hit) return hit;

  if (probeError && !remote) {
    // Nothing usable locally and the server is unreachable: that is the real
    // error, not the cache miss.
    throw unreachableError(probeError);
  }
  // The caller usually knows how big the database is — db/biomes.json carries
  // `bytes` for every entry, checked against the file at build time. Where it
  // does, that number wins over anything the headers say, because a compressing
  // host reports the size of the TRANSFER and fetch() then hands over the
  // decompressed body. Believing the header there aborts a good download with
  // "the server sent more than it declared".
  if (Number.isFinite(expectedSize) && expectedSize > 0 && remote) {
    if (remote.encoded || remote.size !== expectedSize) remote = { ...remote, size: expectedSize };
  }
  if (!Number.isFinite(remote.size) || remote.size <= 0) {
    throw new Error("the server did not report a size for the database (no content-length)");
  }
  if (remote.encoded && !(Number.isFinite(expectedSize) && expectedSize > 0)) {
    // Nothing to compare against and a size that describes the compressed body:
    // going ahead would fail mid-download with a message blaming the server.
    throw new Error(
      `this host compresses the database (Content-Encoding), so the size it reports ` +
      `(${remote.size}) is the compressed one while the browser receives it decompressed. ` +
      `Nothing here can tell how large the file really is — serve it without compression, ` +
      `or declare its size in db/biomes.json.`);
  }

  // Everything past here WRITES the entry, so: one writer at a time across every
  // tab of this site, and the decision is taken AGAIN once the lock is held. The
  // old code checked, then waited up to 15.7 s for the file handle, then acted on
  // its stale decision — truncating away the complete entry the other tab had
  // just finished writing and downloading all 433 MB a second time.
  return withWriteLock(u, signal, emit, async () => {
    const won = await cacheHitFor(u, remote, emit);
    if (won) return won;
    return downloadEntry(u, remote, { emit, signal, chunkSize });
  });
}

// Read a cached database out of OPFS. Called by every sylph worker; this is what
// replaces N independent fetches.
//
// Revalidates size against the metadata before returning: `ensureDb` already did
// that, but this function is the one whose result goes straight into
// `new Profiler(bytes)`, and a truncated database produces plausible-looking,
// wrong abundances with no error anywhere. Cheap check, unbounded payoff.
export async function readCachedBytes(url) {
  const u = absUrl(url);
  if (!opfsSupported()) throw new Error("OPFS is unavailable in this context");
  const meta = await readMeta(u);
  if (!meta) throw new Error(`no cache entry for ${u}`);
  if (!meta.complete) throw new Error(`cache entry for ${u} is incomplete (${meta.received}/${meta.size})`);
  const file = await (await dataHandle(u, false)).getFile();
  if (file.size !== meta.size) {
    throw new Error(`cache entry for ${u} is ${file.size} bytes, metadata says ${meta.size}`);
  }
  return new Uint8Array(await file.arrayBuffer());
}

// ---- fallback: one in-memory download ----------------------------------------
//
// Used when OPFS is missing or refuses to open (private windows on some
// browsers, exotic embeddings). It gives up persistence and resume-after-reload
// — but it keeps the property that actually caused the bug report: exactly ONE
// download, whatever the pool size. Retries, mid-flight resume, the NO_RANGE
// restart and the "only zero-progress attempts are strikes" rule are not
// reimplemented here: it runs the same pumpDownload as the OPFS path, with an
// `io` that writes into a buffer and has nowhere to checkpoint.
export async function downloadToMemory(url, { onProgress, signal, chunkSize = DEFAULT_CHUNK,
  expectedSize = null } = {}) {
  const u = absUrl(url);
  const emit = (phase, extra) => { try { onProgress?.({ phase, ...extra }); } catch { /* ignore */ } };
  emit("probe", { note: "asking the server for size (no local cache available)" });
  let remote = await probe(u, signal);
  // Same reason as in ensureDb(): on a compressing host the headers describe the
  // transfer, and the buffer allocated below would be short by the compression
  // ratio. Without OPFS there is no partial file to notice it either.
  if (Number.isFinite(expectedSize) && expectedSize > 0) {
    if (remote.encoded || remote.size !== expectedSize) remote = { ...remote, size: expectedSize };
  }
  if (!Number.isFinite(remote.size) || remote.size <= 0) {
    throw new Error("the server did not report a size for the database");
  }
  const buf = new Uint8Array(remote.size);
  emit("start", {
    received: 0, total: remote.size, ranges: remote.ranges,
    note: `starting ${fmtBytes(remote.size)} download (not cached: OPFS unavailable)`,
  });
  const io = {
    write: (piece, at) => { buf.set(piece, at); return piece.length; },
    rewind: () => { /* the buffer is overwritten from 0 */ },
    flush: () => {},
    checkpoint: () => {},     // nowhere to persist a resume pointer
    fatalWrite: () => null,
  };
  const expect = { size: remote.size, lastModified: remote.lastModified, etag: remote.etag };
  const received = await pumpDownload(u, remote, { chunkSize, signal, emit, io, expect, from: 0 });
  if (received !== remote.size) throw new Error(`got ${received} bytes, expected ${remote.size}`);
  emit("done", { received, total: remote.size, source: "network", note: "held in memory (not cached)" });
  return {
    source: "network", size: remote.size, lastModified: expect.lastModified,
    url: u, bytes: buf, bytesFetched: received,
  };
}

// ---- window side: a proxy to db-cache-worker.js -------------------------------

// One client per page. `ensure()` is single-flight per URL: two callers (or a
// double click on Load database) share one download rather than starting two.
export function dbCacheClient({ version = "" } = {}) {
  let worker = null;
  let nextId = 1;
  const pending = new Map();
  const inflight = new Map();   // url -> promise

  function ensureWorker() {
    if (worker) return worker;
    const url = new URL(`./db-cache-worker.js${version ? `?v=${version}` : ""}`, import.meta.url);
    worker = new Worker(url, { type: "module" });
    worker.addEventListener("message", (e) => {
      const { id } = e.data;
      const p = pending.get(id);
      if (!p) return;
      if (e.data.progress) { p.onProgress?.(e.data.progress); return; }
      pending.delete(id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(Object.assign(new Error(e.data.error), { name: e.data.errorName || "Error" }));
    });
    worker.addEventListener("error", (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message ?? "db-cache worker error"));
      pending.clear();
      worker = null;
    });
    return worker;
  }

  function call(type, payload, { onProgress, signal, transfer } = {}) {
    const w = ensureWorker();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => w.postMessage({ id: 0, type: "cancel", target: id });
      pending.set(id, {
        resolve: (v) => { signal?.removeEventListener("abort", onAbort); resolve(v); },
        reject: (e) => { signal?.removeEventListener("abort", onAbort); reject(e); },
        onProgress,
      });
      if (signal) {
        if (signal.aborted) { pending.delete(id); reject(abortError()); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      w.postMessage({ id, type, ...payload }, transfer ?? []);
    });
  }

  return {
    // Ask for a persistent quota once. A refusal is NOT an error: the data is
    // still cached, the browser is just allowed to evict it under pressure.
    async requestPersistence() {
      try {
        if (typeof navigator?.storage?.persisted !== "function") return { supported: false, persisted: false };
        if (await navigator.storage.persisted()) return { supported: true, persisted: true, alreadyGranted: true };
        const granted = typeof navigator.storage.persist === "function" ? await navigator.storage.persist() : false;
        return { supported: true, persisted: granted };
      } catch {
        return { supported: false, persisted: false };
      }
    },
    async estimate() {
      try { return await navigator.storage.estimate(); } catch { return null; }
    },
    // The CURRENT persistence state, asked without ever prompting: persisted()
    // only reports, persist() is the one that may put a permission prompt in
    // front of the user. This is what the cache listing must be drawn from — the
    // remembered result of a persist() call earlier in the session says nothing
    // on the next visit.
    async persisted() {
      try {
        return typeof navigator?.storage?.persisted === "function"
          ? await navigator.storage.persisted() : false;
      } catch { return false; }
    },
    // -> { source, size, lastModified, url, opfs, bytes? }
    // `expectedSize` is what the caller knows the database to be — db/biomes.json
    // carries it for every entry. It overrides the headers, which describe the
    // TRANSFER on any host that compresses. See ensureDb().
    ensure(url, { onProgress, signal, chunkSize, expectedSize } = {}) {
      const u = absUrl(url);
      const running = inflight.get(u);
      if (running) {
        // A second caller joins the download in progress instead of racing it.
        running.listeners.add(onProgress);
        return running.promise.finally(() => running.listeners.delete(onProgress));
      }
      const listeners = new Set([onProgress]);
      const promise = call("ensure", { url: u, chunkSize, expectedSize }, {
        onProgress: (p) => { for (const l of listeners) { try { l?.(p); } catch { /* ignore */ } } },
        signal,
      }).finally(() => inflight.delete(u));
      inflight.set(u, { promise, listeners });
      return promise;
    },
    list() { return call("list", {}); },
    // Accepts either — the UI deletes by key (always present, even for an entry
    // whose metadata cannot be read), callers with a URL can pass that.
    remove({ url, key } = {}) {
      return call("remove", { url: url ? absUrl(url) : null, key: key ?? null });
    },
    clear() { return call("clear", {}); },
    close() { worker?.terminate(); worker = null; pending.clear(); },
  };
}
