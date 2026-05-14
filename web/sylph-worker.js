// Web Worker that owns the WASM Profiler and now also does FASTQ decompression
// + trim, so the main thread never holds the uncompressed read buffer.
//
// Protocol (every message has `id` + `type`):
//   in  { id, type: "init" }
//   out { id, ok: true }
//   in  { id, type: "loadDb", bytes: Uint8Array }    // bytes is transferred
//   out { id, ok: true, meta: { database_size, k, c, bytes } }
//   in  { id, type: "profileFile", file: File, maxReads }
//   in  { id, type: "profileFilesMulti", files: File[], maxReads }
//   in  { id, type: "profileFilesPe", r1Files: File[], r2Files: File[], maxReads }
//       progress: { id, progress: { ... } }   // emitted periodically
//   out { id, ok: true, tsv, elapsedMs, reads }
//   in  { id: 0, type: "cancel", target: <id-being-cancelled> }   // abort an in-flight op
//   error: { id, ok: false, error: string }

import init, { Profiler } from "./sylph-pkg/sylph_wasm.js";
import { readAndTrim, readAndTrimMulti } from "./fastq-trim.js";

let profiler = null;
let inited = false;

// id -> AbortController, so "cancel" messages can interrupt readAndTrim*.
const aborters = new Map();

function ensureInited() {
  if (inited) return Promise.resolve();
  return init().then(() => { inited = true; });
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
  try {
    if (type === "init") {
      await ensureInited();
      self.postMessage({ id, ok: true });
    } else if (type === "loadDb") {
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
    } else if (type === "loadDbUrl") {
      // Each worker in a pool fetches the DB independently — the browser
      // HTTP cache turns the second fetch into a memory/disk hit, so only
      // one network request actually flies.
      await ensureInited();
      if (profiler) { profiler.free(); profiler = null; }
      const { url } = e.data;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
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
      const trimT0 = performance.now();
      const trimmed = await readAndTrim(file, maxReads,
        (bytesIn, reads, total) => self.postMessage({ id, progress: { bytesIn, reads, total } }),
        ac.signal,
      );
      const trimMs = performance.now() - trimT0;
      console.log(`[worker profileFile] trim done: reads=${trimmed.reads} (target ${maxReads}) ` +
        `bytes=${trimmed.bytes.length} compressedRead=${trimmed.compressedBytesRead ?? '?'} ` +
        `fileSize=${file.size} in ${trimMs.toFixed(0)} ms`);
      self.postMessage({ id, progress: { phase: "profile_start", reads: trimmed.reads } });
      const t0 = performance.now();
      const tsv = profiler.profile(trimmed.bytes, maxReads);
      const elapsedMs = performance.now() - t0;
      console.log(`[worker profileFile] profile done in ${elapsedMs.toFixed(0)} ms; ` +
        `tsv has ${(tsv.match(/\n/g) || []).length} lines`);
      self.postMessage({ id, ok: true, tsv, elapsedMs, reads: trimmed.reads });
    } else if (type === "profileFilesMulti") {
      if (!profiler) throw new Error("database not loaded");
      const { files, maxReads } = e.data;
      const trimT0 = performance.now();
      const trimmed = await readAndTrimMulti(files, maxReads,
        (bytesIn, reads, total, fi) => self.postMessage({ id, progress: { bytesIn, reads, total, fi } }),
        ac.signal,
      );
      const trimMs = performance.now() - trimT0;
      console.log(`[worker profileFilesMulti] trim done: reads=${trimmed.reads} (target ${maxReads}) ` +
        `bytes=${trimmed.bytes.length} totalFileSize=${files.reduce((a, f) => a + f.size, 0)} ` +
        `in ${trimMs.toFixed(0)} ms`);
      self.postMessage({ id, progress: { phase: "profile_start", reads: trimmed.reads } });
      const t0 = performance.now();
      const tsv = profiler.profile(trimmed.bytes, maxReads);
      const elapsedMs = performance.now() - t0;
      console.log(`[worker profileFilesMulti] profile done in ${elapsedMs.toFixed(0)} ms; ` +
        `tsv has ${(tsv.match(/\n/g) || []).length} lines`);
      self.postMessage({ id, ok: true, tsv, elapsedMs, reads: trimmed.reads });
    } else if (type === "profileFilesPe") {
      if (!profiler) throw new Error("database not loaded");
      const { r1Files, r2Files, maxReads } = e.data;
      const trimT0 = performance.now();
      const [t1, t2] = await Promise.all([
        readAndTrimMulti(r1Files, maxReads,
          (b, r, t, fi) => self.postMessage({ id, progress: { mate: 1, bytesIn: b, reads: r, total: t, fi } }),
          ac.signal),
        readAndTrimMulti(r2Files, maxReads,
          (b, r, t, fi) => self.postMessage({ id, progress: { mate: 2, bytesIn: b, reads: r, total: t, fi } }),
          ac.signal),
      ]);
      const trimMs = performance.now() - trimT0;
      console.log(`[worker profileFilesPe] trim done: r1=${t1.reads}/${t1.bytes.length}B ` +
        `r2=${t2.reads}/${t2.bytes.length}B target ${maxReads} in ${trimMs.toFixed(0)} ms`);
      self.postMessage({ id, progress: { phase: "profile_start", reads: Math.min(t1.reads, t2.reads) } });
      const t0 = performance.now();
      const tsv = profiler.profile_pe(t1.bytes, t2.bytes, maxReads);
      const elapsedMs = performance.now() - t0;
      console.log(`[worker profileFilesPe] profile done in ${elapsedMs.toFixed(0)} ms; ` +
        `tsv has ${(tsv.match(/\n/g) || []).length} lines`);
      self.postMessage({ id, ok: true, tsv, elapsedMs, reads: Math.min(t1.reads, t2.reads) });
    } else {
      throw new Error(`unknown message type: ${type}`);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message ?? String(err) });
  } finally {
    aborters.delete(id);
  }
});
