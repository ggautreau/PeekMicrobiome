// Web Worker that owns the WASM Profiler and now also does FASTQ decompression
// + trim, so the main thread never holds the uncompressed read buffer.
//
// Since the streaming rework the decompressed FASTQ is never materialised at
// all: chunks come out of fastq-trim.js and go straight into the incremental
// wasm sketcher (begin_sample / feed / finish_sample). If the loaded wasm
// build does not expose that API yet, we transparently fall back to the old
// readAndTrim + Profiler.profile path, which is byte-identical but capped at
// ~2 GiB of decompressed reads by the single-ArrayBuffer limit.
//
// Protocol (every message has `id` + `type`) — UNCHANGED by the rework:
//   in  { id, type: "init", maxReads, bits }         // bits (32|64) picks the wasm package
//   out { id, ok: true, wasm: { bits, capped, memory64, reason, pkg } }
//   in  { id, type: "loadDb", bytes: Uint8Array }    // bytes is transferred
//   out { id, ok: true, meta: { database_size, k, c, bytes } }
//   in  { id, type: "loadDbCached", url }            // reads the OPFS cache entry
//   out { id, ok: true, meta: { database_size, k, c, bytes } }
//   in  { id, type: "profileFile", file: File, maxReads }
//   in  { id, type: "profileFilesMulti", files: File[], maxReads }
//   in  { id, type: "profileFilesPe", r1Files: File[], r2Files: File[], maxReads }
//       progress: { id, progress: { ... } }   // emitted periodically
//   out { id, ok: true, tsv, elapsedMs, reads }
//   in  { id: 0, type: "cancel", target: <id-being-cancelled> }   // abort an in-flight op
//   error: { id, ok: false, error: string }
//
// ADDED for the ENA input mode — the same two operations, over URLs instead of
// File handles:
//   in  { id, type: "profileUrls",   urls: [{url, bytes, name}], maxReads }
//   in  { id, type: "profileUrlsPe", r1: [{url,…}], r2: [{url,…}], maxReads }
//
// They are handled by the SAME branches as their File counterparts (see below):
// the only difference is where the read source comes from, and nothing about
// sketching, capping, pairing or cancellation is duplicated. The source has to
// be built here rather than on the page because an object with methods does not
// survive postMessage.
//
// Their progress events keep the existing shape and add two fields, because
// eight minutes of downloading with no visible movement reads as a crash:
//   progress: { …, net: true, bps }                      // network throughput
//   progress: { phase: "net_retry", note, attempt, … }   // a cut and its resume

// The ?v= MUST stay in sync with WORKER_VERSION in sylph-worker-rpc.js: the
// worker URL is cache-busted there, and without a matching bust here a browser
// can pair a freshly fetched worker with a stale cached fastq-trim.js, which
// fails the named import and kills the worker module outright.
import {
  readAndTrim, readAndTrimMulti, streamTrim, streamTrimMulti, streamTrimPair,
} from "./fastq-trim.js?v=24";
import {
  WORKER_VERSION, detectMemory64, chooseWasmBits, WASM32_SAFE_READS,
} from "./sylph-worker-rpc.js?v=24";
// The database is never downloaded here: one download happens in
// db-cache-worker.js, then every worker in the pool reads the same OPFS file.
import { readCachedBytes } from "./db-cache.js?v=24";
// FASTQs, on the other hand, ARE fetched here in ENA mode — streamed, never
// stored. urlSource is the resumable read source; see web/ena.js.
import { urlSource, rateMeter, fastqUrl } from "./ena.js?v=24";

let profiler = null;

// ---- wasm package selection --------------------------------------------------
//
// The package used to be a static import of ./sylph-pkg/. It is now chosen at
// init time between the 32-bit and the 64-bit build, because they are not
// interchangeable in either direction:
//   - 32-bit is ~1.6x faster end-to-end but its linear memory stops at 4 GB,
//     which the sketch state hits at ~48.75 M single-end reads (measured);
//   - 64-bit lifts that to V8's 16 GB (~195.5 M reads, measured, 4.01x) and is
//     the only way to profile a real 20-50 M read gut metagenome — but Safari
//     does not implement memory64 in ANY version, so it can never be the default
//     and the fallback is not a convenience, it is a requirement.
// See chooseWasmBits() in sylph-worker-rpc.js for the policy and the numbers.
//
// Both directories deliberately use the same file names, so only the prefix
// changes. The ?v= busts the glue; the explicit module_or_path below busts the
// .wasm too, which used to be fetched at a bare, permanently cacheable path.
const PKG_PATH = {
  32: "./sylph-pkg/sylph_wasm.js",
  64: "./sylph-pkg64/sylph_wasm.js",
};
const WASM_PATH = {
  32: "./sylph-pkg/sylph_wasm_bg.wasm",
  64: "./sylph-pkg64/sylph_wasm_bg.wasm",
};

let Profiler = null;      // filled in by loadPkg()
let wasmInfo = null;      // { bits, capped, memory64, reason, pkg } once loaded
let initPromise = null;

async function loadPkg(bits) {
  const mod = await import(`${PKG_PATH[bits]}?v=${WORKER_VERSION}`);
  // wasm-bindgen would otherwise derive the .wasm URL from its own import.meta,
  // dropping the query and letting a stale binary pair with fresh glue.
  await mod.default({
    module_or_path: new URL(`${WASM_PATH[bits]}?v=${WORKER_VERSION}`, import.meta.url),
  });
  Profiler = mod.Profiler;
  return mod;
}

// Idempotent, and shared: every handler funnels through it, so the package is
// chosen exactly once per worker. The arguments only matter on the first call —
// afterwards the module graph is fixed for the life of the worker and the page
// has to spawn a new one (which it does; see ensureWasmBuildFor there).
//
// `requestedBits` is the page's decision. The page owns the reads control and
// has already run chooseWasmBits() against its own probe, so this realm's probe
// is a VETO on that decision, not a second opinion: two independent decisions in
// two realms can only ever disagree, and a disagreement would have the page tear
// its pool down on every single run chasing a state the worker keeps refusing.
// With no requestedBits (an old caller, or a loadDb before any init) the policy
// runs here instead, on maxReads.
function ensureInited(maxReads, requestedBits) {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const memory64 = detectMemory64();
    let choice = requestedBits === 32 || requestedBits === 64
      ? {
        bits: requestedBits, capped: false, memory64: memory64.ok,
        reason: `${requestedBits}-bit requested by the page`,
      }
      : chooseWasmBits({ maxReads, memory64 });
    if (choice.bits === 64 && !memory64.ok) {
      choice = {
        bits: 32, capped: true, memory64: false,
        reason: `the 64-bit build was requested but this realm has no memory64 (${memory64.reason})`,
      };
    }
    try {
      await loadPkg(choice.bits);
      wasmInfo = { ...choice, pkg: PKG_PATH[choice.bits] };
    } catch (err) {
      // Loud, always: a missing or broken sylph-pkg64/ on the server would
      // otherwise show up much later as an unexplained out-of-memory abort in
      // the middle of a long run.
      if (choice.bits !== 64) throw err;
      console.error(`[worker] the 64-bit wasm package failed to load (${err?.message ?? err}) — ` +
        `falling back to the 32-bit build; this run will abort past ~${WASM32_SAFE_READS.toLocaleString("en-US")} reads`);
      await loadPkg(32);
      wasmInfo = {
        bits: 32, capped: true, memory64: true, pkg: PKG_PATH[32],
        reason: `64-bit package failed to load (${err?.message ?? err}); fell back to 32-bit`,
      };
    }
    // One line per worker, always emitted: which package, and why that one.
    const say = wasmInfo.capped ? console.warn : console.log;
    say(`[worker] wasm ${wasmInfo.bits}-bit (${wasmInfo.pkg}): ${wasmInfo.reason}`);
    return wasmInfo;
  })();
  // A rejected init must not be cached, or every later message reports the same
  // stale failure with no way to retry.
  initPromise.catch(() => { initPromise = null; });
  return initPromise;
}

// id -> AbortController, so "cancel" messages can interrupt the trim loops.
const aborters = new Map();

// ---- ENA (URL) inputs --------------------------------------------------------

// Descriptors from the page -> read sources for streamCore. The contract
// streamCore needs is .size / .slice().arrayBuffer() / .stream(), and urlSource
// provides exactly those over HTTP with resume; see web/ena.js.
//
// `signal` is this operation's AbortController, so cancelling a sample also
// aborts the download in flight instead of leaving it pulling bytes for a
// sample nobody is waiting for any more.
// The host allow-list is checked HERE too, not only where the accession was
// resolved. This function is the boundary that actually fetches: whatever
// arrives over postMessage is data, and the page's promise ("only the EBI is
// contacted") has to be enforced where the connection is opened, not two files
// away in the one caller that exists today. urlSource() applies the same list
// itself; this repeats it so the refusal names the descriptor rather than
// arriving as a stream error halfway through a sample.
function urlSources(descs, signal, id, mate) {
  for (const d of descs ?? []) {
    const checked = fastqUrl(d?.url);
    if (!checked || checked.blocked) {
      throw new Error(
        `refusing to download ${checked?.blocked ?? String(d?.url)}: this page only fetches ` +
        `FASTQ files from the EBI's servers (*.ebi.ac.uk)`);
    }
  }
  return (descs ?? []).map((d) => urlSource(d.url, {
    size: d.bytes, name: d.name, signal,
    // A retry is the one thing a user MUST see: without it a resumed download
    // looks like a stall, and a stall looks like a hang.
    onRetry: (r) => self.postMessage({
      id,
      progress: {
        phase: "net_retry", mate, note: r.note, attempt: r.attempt, waitMs: r.waitMs,
        received: r.received, total: r.total, requests: r.requests, restart: !!r.restart,
      },
    }),
  }));
}

// Network throughput, over a trailing window, attached to the progress events
// that already exist. Returns undefined for local files: a "0 B/s" next to a
// file being read off an SSD would be noise, and a missing field is ignored by
// both pages.
function bpsTracker(net) {
  if (!net) return () => undefined;
  const meter = rateMeter();
  return (bytesIn) => meter.push(bytesIn);
}


// Feature detection against the wasm bindings actually loaded. Lets this file
// work with both a streaming-capable build and an older one.
function hasStreamingApi(p) {
  return !!p
    && typeof p.begin_sample === "function"
    && typeof p.feed === "function"
    && typeof p.finish_sample === "function";
}

function hasStreamingPeApi(p) {
  return !!p
    && typeof p.begin_sample_pe === "function"
    && typeof p.feed_r1 === "function"
    && typeof p.feed_r2 === "function"
    && typeof p.finish_sample === "function";
}

// One warning per worker when the loaded wasm has no incremental sketcher: the
// fallback silently reintroduces the single-buffer wall (~7M reads) this whole
// path exists to remove, and used to do so without leaving a trace.
let warnedNoStreaming = false;
function warnFallback(where) {
  if (warnedNoStreaming) return;
  warnedNoStreaming = true;
  console.warn(`[worker] streaming sketcher unavailable in the loaded wasm (${where}) — ` +
    "falling back to profile(); reads are capped at ~7M by the 2 GiB ArrayBuffer limit. " +
    "Rebuild sylph-pkg to restore the streaming path.");
}

// `sample_done` / `sample_halted` / `sample_invalid` are getters on the
// Profiler; poll them so we stop pulling (and gunzipping) input the moment
// nothing more can change the result — read cap reached, stream rejected, or
// needletail gave up on a malformed record. The last two are absent from older
// builds, where `undefined === true` is false and only the cap applies.
function sampleStop() {
  if (!profiler) return false;
  return profiler.sample_done === true
    || profiler.sample_halted === true
    || profiler.sample_invalid === true;
}

function sampleReads(fallback) {
  const n = profiler ? profiler.sample_reads : undefined;
  return typeof n === "number" ? n : fallback;
}

// The pairing-queue getters ship with the streaming PE API, but a build from
// before they existed would report `undefined`; then we hand streamTrimPair no
// getters at all rather than a fake zero (see hasBacklog there).
function hasPairQueues(p) {
  return typeof p?.pair_queued_r1 === "number" && typeof p?.pair_queued_r2 === "number";
}

// pair_pending_* is newer still (it counts the carry as well as the queue).
// Without it streamTrimPair keeps reading each mate to its own EOF instead of
// guessing from pair_queued_*, which would drop the last pair of a file with no
// trailing newline.
function hasPairPending(p) {
  return typeof p?.pair_pending_r1 === "number" && typeof p?.pair_pending_r2 === "number";
}

// Drop any sample left in progress. Without this a cancelled or failed sample
// keeps its k-mer map and dedup table pinned in linear memory until the next
// begin_sample* — and wasm never gives that memory back to the OS.
// Tolerates an older pkg that does not export cancel_sample.
function cancelSample() {
  if (profiler && typeof profiler.cancel_sample === "function") {
    try { profiler.cancel_sample(); } catch { /* nothing in flight */ }
  }
}

self.addEventListener("message", async (e) => {
  const { id, type } = e.data;

  if (type === "cancel") {
    const ac = aborters.get(e.data.target);
    if (ac) ac.abort();
    return;
  }

  const ac = new AbortController();
  aborters.set(id, ac);
  // Set as soon as a streamed sample is opened, so the `finally` below can
  // release it whatever happens (throw, cancel, early return).
  let sampleStarted = false;
  try {
    if (type === "init") {
      const wasm = await ensureInited(e.data.maxReads, e.data.bits);
      self.postMessage({ id, ok: true, wasm });
    } else if (type === "loadDb") {
      // No maxReads here on purpose: if "init" was never sent, the safe default
      // is the 32-bit package, not a guess. Both pages send "init" first.
      await ensureInited();
      if (profiler) { profiler.free(); profiler = null; }
      const { bytes } = e.data;
      profiler = new Profiler(bytes);
      self.postMessage({
        id, ok: true,
        meta: {
          database_size: profiler.database_size,
          k: profiler.k,
          c: profiler.c,
          bytes: bytes.length,
        },
      });
    } else if (type === "loadDbCached") {
      // Replaces the old "loadDbUrl", which fetched the URL here. That was the
      // bug: with a pool of N, N full downloads left simultaneously (the claim
      // that the HTTP cache collapsed them was wrong — see db-cache.js).
      //
      // Now the page has already made db-cache-worker.js download the database
      // exactly once into OPFS, and this only reads the local file. 433 MB never
      // crosses postMessage and is never held twice in JS.
      //
      // readCachedBytes re-checks the entry's size against its metadata and
      // throws rather than hand a short buffer to Profiler: a truncated .syldb
      // yields wrong abundances silently, which is the one failure mode worth
      // being noisy about.
      await ensureInited();
      if (profiler) { profiler.free(); profiler = null; }
      const bytes = await readCachedBytes(e.data.url);
      profiler = new Profiler(bytes);
      self.postMessage({
        id, ok: true,
        meta: {
          database_size: profiler.database_size,
          k: profiler.k,
          c: profiler.c,
          bytes: bytes.length,
        },
      });
    } else if (type === "loadDbFile") {
      await ensureInited();
      if (profiler) { profiler.free(); profiler = null; }
      const { file } = e.data;
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      profiler = new Profiler(bytes);
      self.postMessage({
        id, ok: true,
        meta: {
          database_size: profiler.database_size,
          k: profiler.k,
          c: profiler.c,
          bytes: bytes.length,
        },
      });
    } else if (type === "profileFile") {
      if (!profiler) throw new Error("database not loaded");
      const { file, maxReads } = e.data;
      const streaming = hasStreamingApi(profiler);
      const trimT0 = performance.now();
      let reads, fedBytes, compressedRead, tsv, elapsedMs;

      if (streaming) {
        profiler.begin_sample(maxReads);
        sampleStarted = true;
        fedBytes = 0;
        const res = await streamTrim(file, maxReads,
          (chunk) => { fedBytes += chunk.length; profiler.feed(chunk); },
          (bytesIn, r, total) => self.postMessage({ id, progress: { bytesIn, reads: r, total } }),
          ac.signal,
          sampleStop,
        );
        compressedRead = res.compressedBytesRead;
        reads = sampleReads(res.reads);
        const trimMs = performance.now() - trimT0;
        console.log(`[worker profileFile] stream done: reads=${reads} (target ${maxReads}) ` +
          `fedBytes=${fedBytes} compressedRead=${compressedRead} ` +
          `fileSize=${file.size} in ${trimMs.toFixed(0)} ms`);
        self.postMessage({ id, progress: { phase: "profile_start", reads } });
        const t0 = performance.now();
        tsv = profiler.finish_sample();
        elapsedMs = performance.now() - t0;
      } else {
        warnFallback("profileFile");
        const trimmed = await readAndTrim(file, maxReads,
          (bytesIn, r, total) => self.postMessage({ id, progress: { bytesIn, reads: r, total } }),
          ac.signal,
        );
        reads = trimmed.reads;
        const trimMs = performance.now() - trimT0;
        console.log(`[worker profileFile] trim done: reads=${trimmed.reads} (target ${maxReads}) ` +
          `bytes=${trimmed.bytes.length} compressedRead=${trimmed.compressedBytesRead ?? '?'} ` +
          `fileSize=${file.size} in ${trimMs.toFixed(0)} ms`);
        self.postMessage({ id, progress: { phase: "profile_start", reads } });
        const t0 = performance.now();
        tsv = profiler.profile(trimmed.bytes, maxReads);
        elapsedMs = performance.now() - t0;
      }

      console.log(`[worker profileFile] profile done in ${elapsedMs.toFixed(0)} ms; ` +
        `tsv has ${(tsv.match(/\n/g) || []).length} lines`);
      self.postMessage({ id, ok: true, tsv, elapsedMs, reads });
    } else if (type === "profileFilesMulti" || type === "profileUrls") {
      // ONE branch for local files and for ENA URLs. The only difference is the
      // first three lines: where the read sources come from, and whether the
      // progress events carry a network rate. Everything after that — the cap,
      // the incremental sketcher, the fallback, cancellation — is the code that
      // was already here, unchanged and not copied.
      if (!profiler) throw new Error("database not loaded");
      const { maxReads } = e.data;
      const net = type === "profileUrls";
      const files = net ? urlSources(e.data.urls, ac.signal, id) : e.data.files;
      const bps = bpsTracker(net);
      const streaming = hasStreamingApi(profiler);
      const totalFileSize = files.reduce((a, f) => a + f.size, 0);
      const trimT0 = performance.now();
      let reads, tsv, elapsedMs;

      if (streaming) {
        profiler.begin_sample(maxReads);
        sampleStarted = true;
        let fedBytes = 0;
        const res = await streamTrimMulti(files, maxReads,
          (chunk) => { fedBytes += chunk.length; profiler.feed(chunk); },
          (bytesIn, r, total, fi) =>
            self.postMessage({ id, progress: { bytesIn, reads: r, total, fi, net, bps: bps(bytesIn) } }),
          ac.signal,
          sampleStop,
        );
        reads = sampleReads(res.reads);
        const trimMs = performance.now() - trimT0;
        console.log(`[worker profileFilesMulti] stream done: reads=${reads} (target ${maxReads}) ` +
          `fedBytes=${fedBytes} totalFileSize=${totalFileSize} in ${trimMs.toFixed(0)} ms`);
        self.postMessage({ id, progress: { phase: "profile_start", reads } });
        const t0 = performance.now();
        tsv = profiler.finish_sample();
        elapsedMs = performance.now() - t0;
      } else {
        warnFallback("profileFilesMulti");
        const trimmed = await readAndTrimMulti(files, maxReads,
          (bytesIn, r, total, fi) =>
            self.postMessage({ id, progress: { bytesIn, reads: r, total, fi, net, bps: bps(bytesIn) } }),
          ac.signal,
        );
        reads = trimmed.reads;
        const trimMs = performance.now() - trimT0;
        console.log(`[worker profileFilesMulti] trim done: reads=${trimmed.reads} (target ${maxReads}) ` +
          `bytes=${trimmed.bytes.length} totalFileSize=${totalFileSize} ` +
          `in ${trimMs.toFixed(0)} ms`);
        self.postMessage({ id, progress: { phase: "profile_start", reads } });
        const t0 = performance.now();
        tsv = profiler.profile(trimmed.bytes, maxReads);
        elapsedMs = performance.now() - t0;
      }

      console.log(`[worker profileFilesMulti] profile done in ${elapsedMs.toFixed(0)} ms; ` +
        `tsv has ${(tsv.match(/\n/g) || []).length} lines`);
      self.postMessage({ id, ok: true, tsv, elapsedMs, reads });
    } else if (type === "profileFilesPe" || type === "profileUrlsPe") {
      // Same rule as the branch above: URLs only change where the two mates are
      // read from. The pairing, the drift budget and the fail-together rule are
      // untouched — and they have to be, because they are the part that is hard.
      if (!profiler) throw new Error("database not loaded");
      const { maxReads } = e.data;
      const net = type === "profileUrlsPe";
      const r1Files = net ? urlSources(e.data.r1, ac.signal, id, 1) : e.data.r1Files;
      const r2Files = net ? urlSources(e.data.r2, ac.signal, id, 2) : e.data.r2Files;
      const bps1 = bpsTracker(net);
      const bps2 = bpsTracker(net);
      const streaming = hasStreamingPeApi(profiler);
      const trimT0 = performance.now();
      let reads, tsv, elapsedMs;

      if (streaming) {
        // Both mates are fed into the same sample. The two loops interleave at
        // their await points only — feed_r1/feed_r2 are synchronous wasm calls,
        // so the Rust side sees a well-ordered stream from each side and pairs
        // them up itself. Only the drift between the two mates costs memory,
        // and streamTrimPair bounds it (and aborts both loops if either fails,
        // so a survivor can never leak its reads into the next sample).
        profiler.begin_sample_pe(maxReads);
        sampleStarted = true;
        const queues = hasPairQueues(profiler);
        const pendings = hasPairPending(profiler);
        let fed1 = 0, fed2 = 0;
        const [s1, s2] = await streamTrimPair(r1Files, r2Files, maxReads, {
          onChunk1: (chunk) => { fed1 += chunk.length; profiler.feed_r1(chunk); },
          onChunk2: (chunk) => { fed2 += chunk.length; profiler.feed_r2(chunk); },
          onProgress1: (b, r, t, fi) =>
            self.postMessage({ id, progress: { mate: 1, bytesIn: b, reads: r, total: t, fi, net, bps: bps1(b) } }),
          onProgress2: (b, r, t, fi) =>
            self.postMessage({ id, progress: { mate: 2, bytesIn: b, reads: r, total: t, fi, net, bps: bps2(b) } }),
          queued1: queues ? () => profiler.pair_queued_r1 : undefined,
          queued2: queues ? () => profiler.pair_queued_r2 : undefined,
          pending1: pendings ? () => profiler.pair_pending_r1 : undefined,
          pending2: pendings ? () => profiler.pair_pending_r2 : undefined,
          shouldStop: sampleStop,
          signal: ac.signal,
        });
        reads = sampleReads(Math.min(s1.reads, s2.reads));
        const trimMs = performance.now() - trimT0;
        console.log(`[worker profileFilesPe] stream done: r1=${s1.reads}/${fed1}B ` +
          `r2=${s2.reads}/${fed2}B pairs=${reads} target ${maxReads} in ${trimMs.toFixed(0)} ms`);
        self.postMessage({ id, progress: { phase: "profile_start", reads } });
        const t0 = performance.now();
        tsv = profiler.finish_sample();
        elapsedMs = performance.now() - t0;
      } else {
        warnFallback("profileFilesPe");
        const [t1, t2] = await Promise.all([
          readAndTrimMulti(r1Files, maxReads,
            (b, r, t, fi) => self.postMessage({ id, progress: { mate: 1, bytesIn: b, reads: r, total: t, fi, net, bps: bps1(b) } }),
            ac.signal),
          readAndTrimMulti(r2Files, maxReads,
            (b, r, t, fi) => self.postMessage({ id, progress: { mate: 2, bytesIn: b, reads: r, total: t, fi, net, bps: bps2(b) } }),
            ac.signal),
        ]);
        reads = Math.min(t1.reads, t2.reads);
        const trimMs = performance.now() - trimT0;
        console.log(`[worker profileFilesPe] trim done: r1=${t1.reads}/${t1.bytes.length}B ` +
          `r2=${t2.reads}/${t2.bytes.length}B target ${maxReads} in ${trimMs.toFixed(0)} ms`);
        self.postMessage({ id, progress: { phase: "profile_start", reads } });
        const t0 = performance.now();
        tsv = profiler.profile_pe(t1.bytes, t2.bytes, maxReads);
        elapsedMs = performance.now() - t0;
      }

      console.log(`[worker profileFilesPe] profile done in ${elapsedMs.toFixed(0)} ms; ` +
        `tsv has ${(tsv.match(/\n/g) || []).length} lines`);
      self.postMessage({ id, ok: true, tsv, elapsedMs, reads });
    } else {
      throw new Error(`unknown message type: ${type}`);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message ?? String(err) });
  } finally {
    // On the happy path finish_sample() already took the sketcher, so this is a
    // no-op; on a throw or a cancel it is what stops the abandoned sample from
    // pinning its k-mer maps for the lifetime of the tab.
    if (sampleStarted) cancelSample();
    aborters.delete(id);
  }
});
