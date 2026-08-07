// Tiny promise-RPC wrapper around the WASM worker, plus the policy that decides
// WHICH wasm package the worker loads (32-bit or 64-bit).
//
// Use:
//   const rpc = sylphWorkerRpc();
//   const wasm = await rpc.init(maxReads);   // -> { bits, capped, reason, memory64 }
//   const meta = await rpc.loadDb(uint8);                           // transfers ownership
//   const meta = await rpc.loadDbCached(url);   // reads the OPFS entry db-cache.js filled
//   const { tsv } = await rpc.profileFile(file, 1_000_000, onProgress, signal);
//   const { tsv } = await rpc.profileFilesMulti(files, ..., onProgress, signal);
//   const { tsv } = await rpc.profileFilesPe(r1Files, r2Files, ..., onProgress, signal);
//
// `onProgress` is called for each progress event the worker emits.
// `signal` is an optional AbortSignal — aborting it sends a "cancel" message
// to the worker, which propagates into the streaming readAndTrim.
//
// The capability probe and the reads budget live here, not in the worker, for
// one reason: the worker cannot be imported by anything (it calls
// self.addEventListener at load time), so nothing could test them. This module
// has no top-level side effect and is imported by the worker, by both pages,
// and by web/fastq-trim.parity.test.mjs.

// Bump this version when you change the worker or any module it imports, to
// force the browser to refetch instead of reusing its module-worker cache.
// The worker imports fastq-trim.js as "./fastq-trim.js?v=<this>" and this file
// as "./sylph-worker-rpc.js?v=<this>", so all three are always invalidated
// together — bumping only one of them can pair a new worker with a stale
// dependency, whose missing named export kills the worker module at
// instantiation (no fallback: the fallback is inside it).
// Since v9 the version also busts the wasm package (glue + .wasm), which used
// to be fetched at a bare, permanently cacheable path.
// Since v10 it also busts db-cache.js (imported by the worker for
// readCachedBytes) and db-cache-worker.js, and the worker protocol changed:
// "loadDbUrl" is gone, replaced by "loadDbCached". A page paired with a v9
// worker would ask for a message type that no longer exists, so this bump is
// what keeps a cached visitor working.
// Since v12 the worker also imports ena.js (the resumable URL read source for
// the ENA input mode) and answers two new message types, "profileUrls" and
// "profileUrlsPe". A page paired with a v11 worker would ask for message types
// that worker has never heard of and get nothing back but a rejected promise,
// so this bump is again what keeps a cached visitor working.
// The check is enforced by web/fastq-trim.parity.test.mjs.
export const WORKER_VERSION = "14";

// ---- memory64 capability probe ----------------------------------------------

// (module (memory i64 1)) — 13 bytes. Validating it asks the engine exactly one
// question: can you decode a memory whose index type is i64? Nothing is
// instantiated and nothing is allocated.
const MEMORY64_PROBE_MODULE = Uint8Array.of(
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // "\0asm", version 1
  0x05, 0x03, 0x01, 0x04, 0x01,                   // memory section: 1 memory, flags=0x04 (MEMORY64), min=1
);

// The same module with flags=0x00, i.e. an ordinary 32-bit memory. Every engine
// that runs wasm at all validates this one. It is the control that makes a
// `false` above mean "no memory64" rather than "validate() is broken here".
const MEMORY32_PROBE_MODULE = Uint8Array.of(
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x05, 0x03, 0x01, 0x00, 0x01,
);

// Does this engine really support memory64? Returns { ok, reason }.
//
// `wasm` is injectable so the test can drive the probe against engines this
// machine does not have (a 32-bit-only one, and one that honours the OLD spec
// draft's property name). Everything else passes globalThis.WebAssembly.
export function detectMemory64(wasm = globalThis.WebAssembly) {
  if (!wasm || typeof wasm.Memory !== "function" || typeof wasm.validate !== "function") {
    return { ok: false, reason: "no WebAssembly.Memory / WebAssembly.validate in this realm" };
  }

  // Static half: can the engine decode an i64-indexed memory at all?
  let validates = false;
  try { validates = wasm.validate(MEMORY64_PROBE_MODULE) === true; } catch { validates = false; }
  if (!validates) {
    let control = false;
    try { control = wasm.validate(MEMORY32_PROBE_MODULE) === true; } catch { control = false; }
    return {
      ok: false,
      reason: control
        ? "WebAssembly.validate rejects a memory64 module"
        : "WebAssembly.validate rejects even a memory32 module — the probe is not usable here",
    };
  }

  // Dynamic half: the JS API has to agree with the decoder.
  //
  // The property is `address`. NOT `index`. An unknown key on this descriptor is
  // silently ignored, so `{ index: "i64" }` hands back a perfectly ordinary
  // 32-bit memory, capped at 4 GB, with no error anywhere — a probe written that
  // way answers "yes, memory64" on every browser on earth, including the ones
  // that have never heard of it. (`index` was the property name in an early
  // draft, which is exactly why it is such an easy thing to write.)
  //
  // `initial` / `maximum` must be BigInt for the same reason: that is what makes
  // the NEGATIVE answer trustworthy. A 32-bit engine, having ignored `address`,
  // then tries to convert 1n to a Number and throws.
  try {
    new wasm.Memory({ initial: 1n, maximum: 4n, address: "i64" });
  } catch (e) {
    return { ok: false, reason: `WebAssembly.Memory rejected address:"i64" (${e?.message ?? e})` };
  }

  return { ok: true, reason: "accepted by both WebAssembly.validate and WebAssembly.Memory" };
}

// ---- reads budget ------------------------------------------------------------
//
// Measured on this machine, worst case on purpose: 150 bp reads, all distinct,
// matching nothing in the database, so every k-mer is kept and the sketch state
// grows as fast as it ever can. Streaming means the FASTQ itself is never
// materialised, so what is being measured is purely the sketch state.
//
//   wasm32: 48 750 000 reads OK, dies at 49 000 000 (2.385 GiB reserved)
//   wasm64: 195 500 000 reads OK, dies at 195 750 000 (8.762 GiB reserved)
//
// Both die on a *doubling*: wasm32 trying to go from 2.385 GiB to ~4.5 GiB (over
// the 4 GB wasm32 limit), wasm64 from 8.762 GiB to ~17 GiB (over V8's 16 GB
// memory64 limit). The failure is an unrecoverable Rust allocator abort, seen
// from JS as `RuntimeError: unreachable`, after which the module is poisoned and
// only a reload fixes it. There is no graceful degradation to lean on.
export const WASM32_CEILING_READS = 48_750_000;
export const WASM64_CEILING_READS = 195_500_000;

// Half of the measured ceilings. Two documented reasons, plus the cliff above:
//   - the ceiling runs are single-end. Paired-end stores one entry per PAIR plus
//     two inter-mate markers, so the per-read state is roughly double and the PE
//     ceiling is materially lower (not measured: each ceiling run costs 2-9 min);
//   - the ceiling runs used reads that match nothing, so finish_sample() was
//     trivial (18 ms, 0 rows) and the transient peak of the inference phase on
//     data that actually matches never appeared in the number.
export const WASM32_SAFE_READS = 24_000_000;
export const WASM64_SAFE_READS = 96_000_000;

// Exported so both pages format read counts the same way these notes do —
// mixing `toLocaleString()` (which follows the browser's locale) with the
// en-US grouping used here put "24 000 000" and "24,000,000" side by side in
// the same sentence.
export const fmtReads = (n) => (Number.isFinite(n) ? Math.floor(n).toLocaleString("en-US") : "?");

// THE POLICY. wasm64 is 1.58x-1.68x slower end-to-end than wasm32 on the same
// profile() (measured; the cost is in the inference phase, not the sketching,
// which is within 1.7%). So 32-bit is the default and 64-bit is chosen only when
// 32-bit provably will not hold the run.
//
// Returns { bits, capped, memory64, reason }. `capped` means the user asked for
// more reads than this browser can deliver — the run is going to be attempted at
// 32 bits and may abort. Say so in the UI; do not swallow it.
export function chooseWasmBits({ maxReads, memory64 } = {}) {
  const has64 = memory64 === true || memory64?.ok === true;
  const why64 = memory64?.reason ?? (has64 ? "memory64 available" : "memory64 unavailable");
  const needs64 = Number.isFinite(maxReads) && maxReads > WASM32_SAFE_READS;

  if (!needs64) {
    return {
      bits: 32, capped: false, memory64: has64,
      reason: `${fmtReads(maxReads)} reads is inside the 32-bit budget ` +
        `(safe up to ${fmtReads(WASM32_SAFE_READS)}); the 32-bit build is ~1.6x faster`,
    };
  }
  if (!has64) {
    return {
      bits: 32, capped: true, memory64: false,
      reason: `${fmtReads(maxReads)} reads needs more than the 32-bit budget ` +
        `(safe up to ${fmtReads(WASM32_SAFE_READS)}) but this browser has no memory64 ` +
        `(${why64}), so there is nothing else to load`,
    };
  }
  return {
    bits: 64, capped: false, memory64: true,
    reason: `${fmtReads(maxReads)} reads exceeds the 32-bit budget ` +
      `(safe up to ${fmtReads(WASM32_SAFE_READS)}); switching to the 64-bit build ` +
      `(safe up to ${fmtReads(WASM64_SAFE_READS)}) at ~1.6x the run time`,
  };
}

// How many reads this browser can be asked for, and where the slider should
// stop. Shared by both pages so they cannot drift apart.
export function readsBudget(memory64) {
  const has64 = memory64 === true || memory64?.ok === true;
  return {
    memory64: has64,
    safeMax: has64 ? WASM64_SAFE_READS : WASM32_SAFE_READS,
    // Slider stops a little past the 64-bit target range (a real gut metagenome
    // is 20-50 M reads) rather than at the safe max, which is far past anything
    // a browser tab should be asked to do in one sitting.
    sliderMax: has64 ? 60_000_000 : WASM32_SAFE_READS,
    ceiling: has64 ? WASM64_CEILING_READS : WASM32_CEILING_READS,
  };
}

// The one sentence the UI shows under the reads control. Kept here so the two
// pages say exactly the same thing.
// What this control is FOR, first; what it is limited BY, second.
//
// It used to be a memory guard: 3 M reads was the most the old one-buffer path
// could hold, so the note was a warning and the slider turned red early. Since
// the streaming sketcher the ceiling is 24 M reads (32-bit) or 96 M (64-bit) —
// past what most gut metagenomes contain. So the real question a user faces is
// no longer "will this fit" but "how much of my sample do I want to spend time
// on": fewer reads finish sooner, more reads find rarer species. The ceiling is
// still stated, because on a browser without memory64 it is what stops them.
export function readsBudgetNote(memory64) {
  const b = readsBudget(memory64);
  const tradeoff =
    `Fewer reads finish sooner; more reads detect species at lower abundance. `;
  if (!b.memory64) {
    return tradeoff +
      `This browser holds up to ${fmtReads(b.safeMax)} reads — it has no WebAssembly ` +
      `memory64, so 32-bit WebAssembly's 4 GB is the limit, not sylph. Chrome 133+ and ` +
      `Firefox 134+ raise it to ${fmtReads(WASM64_SAFE_READS)}; Safari supports it in no version.`;
  }
  return tradeoff +
    `This browser holds up to ${fmtReads(b.safeMax)} reads. Past ${fmtReads(WASM32_SAFE_READS)} ` +
    `the 64-bit build loads by itself — same results, about 1.6x the run time.`;
}

// One clause describing the build that is actually loaded, for the database
// line. Deliberately reports the CURRENT build's own ceiling and not the
// browser's: "32-bit WebAssembly, up to 96,000,000 reads" reads as a promise the
// loaded module cannot keep.
export function loadedBuildNote(bits, memory64, unit = "reads") {
  const has64 = memory64 === true || memory64?.ok === true;
  if (bits === 64) {
    return `64-bit WebAssembly, up to ${fmtReads(WASM64_SAFE_READS)} ${unit}`;
  }
  if (has64) {
    return `32-bit WebAssembly (the faster build); past ${fmtReads(WASM32_SAFE_READS)} ${unit} ` +
      `it switches to 64-bit by itself`;
  }
  return `32-bit WebAssembly, capped at ${fmtReads(WASM32_SAFE_READS)} ${unit} ` +
    `because this browser has no memory64`;
}

// The warning shown when the requested value is past the safe max.
export function readsOverBudgetNote(maxReads, memory64) {
  const b = readsBudget(memory64);
  if (!b.memory64) {
    return `${fmtReads(maxReads)} reads is past the ${fmtReads(b.safeMax)} this browser can hold: ` +
      `32-bit WebAssembly stops at 4 GB and the sketch state grows with every read, so the run ` +
      `will abort mid-sample with an out-of-memory error. Lower the value, use Chrome 133+ or ` +
      `Firefox 134+ (which support memory64), or run sylph on a server.`;
  }
  return `${fmtReads(maxReads)} reads is past the ${fmtReads(b.safeMax)} measured as safe even for ` +
    `the 64-bit build (V8 stops at 16 GB). The run may abort mid-sample. Lower the value, or run ` +
    `sylph on a server.`;
}

export function sylphWorkerRpc() {
  const workerUrl = new URL(`./sylph-worker.js?v=${WORKER_VERSION}`, import.meta.url);
  const worker = new Worker(workerUrl, { type: "module" });
  const pending = new Map();
  let nextId = 1;

  worker.addEventListener("message", (e) => {
    const { id } = e.data;
    const resolver = pending.get(id);
    if (!resolver) return;
    if (e.data.progress) {
      resolver.onProgress?.(e.data.progress);
      return;
    }
    pending.delete(id);
    if (resolver.signal && resolver.onAbort) {
      resolver.signal.removeEventListener("abort", resolver.onAbort);
    }
    if (e.data.ok) resolver.resolve(e.data);
    else resolver.reject(new Error(e.data.error));
  });
  worker.addEventListener("error", (e) => {
    for (const { reject } of pending.values()) reject(new Error(e.message ?? "worker error"));
    pending.clear();
  });

  function call(type, payload, { transfer, onProgress, signal } = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, onProgress, signal };
      if (signal) {
        entry.onAbort = () => worker.postMessage({ id: 0, type: "cancel", target: id });
        signal.addEventListener("abort", entry.onAbort);
      }
      pending.set(id, entry);
      worker.postMessage({ id, type, ...payload }, transfer ?? []);
    });
  }

  return {
    worker,
    // `maxReads` is the number of reads this worker is going to be asked for and
    // `bits` is the caller's chooseWasmBits() verdict on it. Together they pick
    // the wasm package, and a package cannot be swapped afterwards: a module
    // worker has one module graph for its whole life. Changing the reads budget
    // later means terminate() + a fresh sylphWorkerRpc(), which is what both
    // pages do. Pass `bits` whenever you have run the policy yourself, so the
    // worker's own probe acts as a veto instead of deciding again; omit it and
    // the worker runs the policy on maxReads.
    // Resolves to { bits, capped, memory64, reason, pkg } — what actually
    // loaded, which is not always what was asked for.
    async init(maxReads, bits) {
      const { wasm } = await call("init", { maxReads, bits });
      return wasm;
    },
    async loadDb(bytes) {
      const { meta } = await call("loadDb", { bytes }, { transfer: [bytes.buffer] });
      return meta;
    },
    // Load a database the page has ALREADY downloaded into the OPFS cache (see
    // db-cache.js). Nothing is fetched here. This replaced loadDbUrl(), which
    // fetched inside every worker and therefore downloaded the database once
    // per worker in the pool.
    async loadDbCached(url) {
      const { meta } = await call("loadDbCached", { url });
      return meta;
    },
    async loadDbFile(file) {
      const { meta } = await call("loadDbFile", { file });
      return meta;
    },
    async profileFile(file, maxReads, onProgress, signal) {
      return call("profileFile", { file, maxReads }, { onProgress, signal });
    },
    async profileFilesMulti(files, maxReads, onProgress, signal) {
      return call("profileFilesMulti", { files, maxReads }, { onProgress, signal });
    },
    async profileFilesPe(r1Files, r2Files, maxReads, onProgress, signal) {
      return call("profileFilesPe", { r1Files, r2Files, maxReads }, { onProgress, signal });
    },
    // ENA mode. `urls` / `r1` / `r2` are plain {url, bytes, name} descriptors —
    // the read source itself is built inside the worker, because an object with
    // methods does not survive postMessage. Same progress callback, same signal,
    // same results; the progress events additionally carry `net: true`, a `bps`
    // rate, and `phase: "net_retry"` events when a download is cut and resumed.
    async profileUrls(urls, maxReads, onProgress, signal) {
      return call("profileUrls", { urls, maxReads }, { onProgress, signal });
    },
    async profileUrlsPe(r1, r2, maxReads, onProgress, signal) {
      return call("profileUrlsPe", { r1, r2, maxReads }, { onProgress, signal });
    },
    terminate() {
      worker.terminate();
      for (const { reject } of pending.values()) reject(new Error("worker terminated"));
      pending.clear();
    },
  };
}
