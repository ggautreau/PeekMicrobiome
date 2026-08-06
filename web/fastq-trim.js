// Streaming FASTQ trim: opens a File, gunzips multi-member gzip if needed
// (via fflate, NOT DecompressionStream), and hands out the decompressed bytes
// up to the first 4·maxReads newlines.
//
// Two flavours share one implementation (`streamCore` below):
//
//   streamTrim / streamTrimMulti   push each decompressed chunk to `onChunk`
//                                  as it comes out and keep NOTHING. This is
//                                  the path that feeds the incremental wasm
//                                  sketcher, and the only one that scales past
//                                  ~7M reads (Chrome refuses a single
//                                  ArrayBuffer of 2 GiB).
//
//   streamTrimPair                 same, for the two mates of one paired-end
//                                  sample: runs both loops together, bounds
//                                  their drift, and makes them fail together.
//
//   readAndTrim / readAndTrimMulti collect those chunks and concatenate them
//                                  into one Uint8Array. Kept as the fallback /
//                                  equivalence reference for Profiler.profile.
//
// Cutting always happens on the 4·maxReads-th newline, i.e. exactly on a FASTQ
// record boundary — both flavours cut in the same place, byte for byte.
//
// Lives in its own module so the Web Worker can run it — main thread then
// only ships the File handle across postMessage, never the decompressed bytes.

import { Gunzip } from "./vendor/fflate.js";

export async function detectGzip(file) {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return head.length === 2 && head[0] === 0x1f && head[1] === 0x8b;
}

// Core reader shared by every entry point below.
//
//   filesList  array of File/Blob, read in order, as if concatenated
//   maxReads   cap; stop right after the (4·maxReads)-th newline
//   onChunk    (Uint8Array) => void — called synchronously, in order, with
//              every decompressed byte that is inside the cap. The view is
//              only valid for the duration of the call: copy it if you keep it.
//   onProgress (bytesIn, reads, totalBytes, fileIndex) => void, throttled 100ms
//   signal     AbortSignal
//   shouldStop optional () => boolean, polled after each input chunk; lets the
//              consumer (e.g. the wasm sketcher saying "I have enough reads")
//              stop the read early so we never gunzip the rest of the file.
//   waitTurn   optional async () => void, awaited before each input chunk;
//              back-pressure hook (see streamTrimPair).
//
// Returns { reads, bytesIn }.
async function streamCore(filesList, maxReads, onChunk, onProgress, signal, shouldStop, waitTurn) {
  const targetNewlines = maxReads * 4;
  const totalBytes = filesList.reduce((a, f) => a + f.size, 0);

  let newlines = 0;
  let bytesIn = 0;
  let lastReport = 0;
  let capped = false;

  // Scan for the cap while forwarding. Identical newline accounting to the
  // pre-streaming version: the cutoff is inclusive of the capping newline, so
  // the output always ends on a complete 4-line record.
  function consumeChunk(value) {
    if (capped || value.length === 0) return;
    let cutoff = -1;
    for (let i = 0; i < value.length; i++) {
      if (value[i] === 0x0A) {
        newlines++;
        if (newlines === targetNewlines) { cutoff = i + 1; break; }
      }
    }
    if (cutoff >= 0) {
      capped = true;
      onChunk(value.subarray(0, cutoff));
    } else {
      onChunk(value);
    }
  }

  for (let fi = 0; fi < filesList.length && !capped; fi++) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (shouldStop && shouldStop()) break;
    const f = filesList[fi];
    const isGz = await detectGzip(f);
    const reader = f.stream().getReader();
    const gz = isGz ? new Gunzip((chunk) => consumeChunk(chunk)) : null;
    const onAbort = signal ? () => reader.cancel().catch(() => {}) : null;
    if (onAbort) signal.addEventListener("abort", onAbort);
    try {
      while (!capped) {
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        if (waitTurn) {
          await waitTurn();
          if (signal?.aborted) throw new DOMException("aborted", "AbortError");
          if (shouldStop && shouldStop()) break;
        }
        const { value, done } = await reader.read();
        if (done) {
          // Closing the gzip stream is where a TRUNCATED .gz shows up: fflate
          // raises on the final push because the deflate stream never ended.
          // Swallowing that (as this line used to) turned an interrupted
          // download into a clean EOF and profiled the sample on whatever
          // fraction of the reads had arrived — reported as a success, with no
          // warning, which is the worst thing this file can do. Same rule as
          // the intermediate push below: the error only stops mattering once
          // we have all the reads we asked for, since then the rest of the
          // file was going to be ignored anyway.
          if (gz) {
            try { gz.push(new Uint8Array(0), true); }
            catch (e) { if (newlines < targetNewlines) throw e; }
          }
          break;
        }
        bytesIn += value.length;
        if (gz) {
          try { gz.push(value, false); }
          catch (e) {
            if (newlines >= targetNewlines) break;
            throw e;
          }
        } else {
          consumeChunk(value);
        }
        if (shouldStop && shouldStop()) { capped = true; break; }
        const now = performance.now();
        if (now - lastReport > 100) {
          if (onProgress) onProgress(bytesIn, Math.floor(newlines / 4), totalBytes, fi);
          lastReport = now;
        }
      }
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      try { await reader.cancel(); } catch { /* already cancelled or errored */ }
    }
  }

  return { reads: Math.floor(newlines / 4), bytesIn };
}

// ---- streaming API (no full materialisation) -------------------------------

// Single file. onProgress is called as (bytesIn, reads, totalBytes) — the file
// index is dropped, matching the old readAndTrim callback shape.
export async function streamTrim(file, maxReads, onChunk, onProgress, signal, shouldStop) {
  const { reads, bytesIn } = await streamCore(
    [file], maxReads, onChunk,
    onProgress ? (b, r, t) => onProgress(b, r, t) : null,
    signal, shouldStop,
  );
  return { reads, compressedBytesRead: bytesIn };
}

// Several files treated as one concatenated stream (one sample split over
// several runs). onProgress gets the extra fileIndex argument.
export async function streamTrimMulti(filesList, maxReads, onChunk, onProgress, signal, shouldStop, waitTurn) {
  return streamCore(filesList, maxReads, onChunk, onProgress, signal, shouldStop, waitTurn);
}

// How many decoded reads the leading mate may get ahead of the other before it
// is made to wait. The paired-end sketcher buffers exactly that imbalance, at
// roughly 184 bytes per queued read (24 B of VecDeque slot + ~160 B of
// allocator chunk for a 150 bp sequence), so 100 000 reads caps the sketcher's
// pairing queue at ~18 MiB per sample — i.e. ~74 MiB with the 4-worker pool,
// instead of "one whole mate", which is 1.5 GiB at 8M reads and 3.7 GiB at 20M.
export const PAIR_LAG_MAX = 100000;

// Read both mates of one paired-end sample concurrently, with two guarantees
// the plain `Promise.all` of two streamTrimMulti calls did not give:
//
//  1. Bounded drift. The mates decompress at different rates (R2's quality
//     lines compress worse, so the same read count is a bigger file), and the
//     wasm sketcher holds every decoded read of the leading mate until its
//     partner shows up. `queued1`/`queued2` report that backlog and the
//     leading loop is parked until it drains below `lagMax`.
//
//  2. Fail together, finish together. If one mate throws (truncated gzip, read
//     error), the other is aborted at once and BOTH loops are awaited before
//     this function returns. Otherwise the survivor kept running in the
//     background and its `feed_r2` calls landed in the *next* sample of the
//     same worker, silently mis-pairing it and reporting wrong abundances as a
//     success.
//
// hooks: { onChunk1, onChunk2, onProgress1, onProgress2, queued1, queued2,
//          pending1, pending2, shouldStop, signal, lagMax, tick }
//
// queued* and pending* are two different questions and the difference is not
// cosmetic. queued* = records decoded and waiting (the memory the sketcher is
// holding): that is what the drift budget throttles on. pending* = records this
// mate can still deliver, decoded ones PLUS the one its carry may still be
// holding: that is what the cross-stop rule below has to read, because the last
// record of a file with no trailing newline is only decoded at finish().
// Returns [r1Result, r2Result] as streamTrimMulti would.
export async function streamTrimPair(r1Files, r2Files, maxReads, hooks = {}) {
  const {
    onChunk1, onChunk2, onProgress1, onProgress2,
    queued1, queued2, pending1, pending2, shouldStop, signal,
    lagMax = PAIR_LAG_MAX,
    tick = () => new Promise((r) => setTimeout(r, 0)),
  } = hooks;

  // Internal controller: aborts both loops when either one fails, and follows
  // the caller's signal for user-initiated cancellation.
  const inner = new AbortController();
  const onOuterAbort = () => inner.abort();
  if (signal) {
    if (signal.aborted) inner.abort();
    else signal.addEventListener("abort", onOuterAbort);
  }

  const done = [false, false];
  let firstError = null;
  // Both backlog getters or none: without them we cannot tell "the other mate
  // is over and nothing is queued" from "we cannot see the queue", and guessing
  // zero would cut a mate short while records of the other were still waiting.
  const hasBacklog = typeof queued1 === "function" && typeof queued2 === "function";
  const backlog = hasBacklog ? [queued1, queued2] : [() => 0, () => 0];
  // Same all-or-nothing rule for the cross-stop. A build that cannot report the
  // carry gets NO cross-stop at all rather than a queue-only approximation:
  // reading the rest of a mate wastes time, dropping its last pair changes the
  // TSV.
  const hasPending = typeof pending1 === "function" && typeof pending2 === "function";
  const pending = hasPending ? [pending1, pending2] : null;
  const stop = () => (shouldStop ? shouldStop() === true : false);

  // Bytes this side has actually handed to the sketcher. The cross-stop below
  // must never fire on a mate that has delivered nothing yet: the sketcher
  // validates each side on its first block, so cutting a still-untouched mate
  // leaves it at bytes_fed == 0 and finish() sinks the whole sample. A
  // differential fuzz of the shipped stop policy found exactly this: the
  // verdict flipped between a profile and an error depending on which mate
  // happened to be scheduled first.
  const fed = [0, 0];

  function mate(idx, files, onChunk, onProgress) {
    const other = 1 - idx;
    const count = (chunk) => { fed[idx] += chunk.length; onChunk(chunk); };
    return streamCore(
      files, maxReads, count, onProgress, inner.signal,
      // Stop when the sketcher is finished, or when the other mate is over and
      // has nothing left to deliver — decoded or still in its carry: only then
      // can no further read on this side ever be paired, and reading on would
      // just burn CPU and memory.
      () => stop() || (hasPending && done[other] && pending[other]() === 0 && fed[idx] > 0),
      // Back-pressure: park while this side is too far ahead. Safe from
      // deadlock — the sketcher drains one of the two queues on every feed, so
      // only the leading side can be over the budget, and a finished or
      // aborted partner releases the wait immediately.
      async () => {
        while (
          backlog[idx]() > lagMax
          && !done[other]
          && !inner.signal.aborted
          && !stop()
        ) {
          await tick();
        }
      },
    ).then(
      (res) => { done[idx] = true; return res; },
      (err) => {
        done[idx] = true;
        if (!firstError) firstError = err;
        inner.abort();
        throw err;
      },
    );
  }

  const settled = await Promise.allSettled([
    mate(0, r1Files, onChunk1, onProgress1),
    mate(1, r2Files, onChunk2, onProgress2),
  ]);
  if (signal) signal.removeEventListener("abort", onOuterAbort);
  if (firstError) throw firstError;
  return [settled[0].value, settled[1].value];
}

// ---- materialising API (fallback / equivalence reference) ------------------

// Collect chunks and join them. Each chunk is released as soon as it is copied:
// holding `parts` alive through the whole concat made the JS peak 2x the
// decompressed FASTQ. The `new Uint8Array(totalOut)` is still a hard wall at
// ~2 GiB (Chrome refuses a single larger ArrayBuffer) — that is what caps this
// path at roughly 6-7M reads, and only the streaming API above removes it.
function collector() {
  const parts = [];
  let totalOut = 0;
  return {
    onChunk(chunk) { parts.push(chunk.slice()); totalOut += chunk.length; },
    join() {
      const bytes = new Uint8Array(totalOut);
      let off = 0;
      for (let i = 0; i < parts.length; i++) {
        bytes.set(parts[i], off);
        off += parts[i].length;
        parts[i] = null;
      }
      return bytes;
    },
  };
}

export async function readAndTrim(file, maxReads, onProgress, signal) {
  const c = collector();
  const { reads, compressedBytesRead } = await streamTrim(
    file, maxReads, c.onChunk, onProgress, signal,
  );
  return { bytes: c.join(), reads, compressedBytesRead };
}

export async function readAndTrimMulti(filesList, maxReads, onProgress, signal) {
  const c = collector();
  const { reads, bytesIn } = await streamTrimMulti(
    filesList, maxReads, c.onChunk, onProgress, signal,
  );
  return { bytes: c.join(), reads, bytesIn };
}
