// Streaming FASTQ trim: opens a File, gunzips multi-member gzip if needed
// (via fflate, NOT DecompressionStream), accumulates decompressed bytes up to
// the first 4·maxReads newlines, returns one Uint8Array.
//
// Lives in its own module so the Web Worker can run it — main thread then
// only ships the File handle across postMessage, never the decompressed bytes.

import { Gunzip } from "./vendor/fflate.js";

export async function detectGzip(file) {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return head.length === 2 && head[0] === 0x1f && head[1] === 0x8b;
}

export async function readAndTrim(file, maxReads, onProgress, signal) {
  const isGz = await detectGzip(file);
  const targetNewlines = maxReads * 4;
  const totalBytes = file.size;

  const parts = [];
  let totalOut = 0;
  let newlines = 0;
  let compressedBytesRead = 0;
  let lastReport = 0;
  let capped = false;

  function consumeChunk(value) {
    if (capped) return;
    let cutoff = -1;
    for (let i = 0; i < value.length; i++) {
      if (value[i] === 0x0A) {
        newlines++;
        if (newlines === targetNewlines) { cutoff = i + 1; break; }
      }
    }
    if (cutoff >= 0) {
      parts.push(value.slice(0, cutoff));
      totalOut += cutoff;
      capped = true;
    } else {
      parts.push(value.slice());
      totalOut += value.length;
    }
  }

  const reader = file.stream().getReader();
  const gz = isGz ? new Gunzip((chunk) => consumeChunk(chunk)) : null;
  const onAbort = signal ? () => reader.cancel().catch(() => {}) : null;
  if (onAbort) signal.addEventListener("abort", onAbort);
  try {
    while (!capped) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const { value, done } = await reader.read();
      if (done) {
        if (gz) { try { gz.push(new Uint8Array(0), true); } catch { /* eos */ } }
        break;
      }
      compressedBytesRead += value.length;
      if (gz) {
        try { gz.push(value, false); }
        catch (e) {
          if (newlines >= targetNewlines) break;
          throw e;
        }
      } else {
        consumeChunk(value);
      }
      const now = performance.now();
      if (now - lastReport > 100) {
        if (onProgress) onProgress(compressedBytesRead, Math.floor(newlines / 4), totalBytes);
        lastReport = now;
      }
    }
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    try { await reader.cancel(); } catch { /* already cancelled or errored */ }
  }

  const bytes = new Uint8Array(totalOut);
  let off = 0;
  for (const p of parts) { bytes.set(p, off); off += p.length; }
  return { bytes, reads: Math.floor(newlines / 4), compressedBytesRead };
}

export async function readAndTrimMulti(filesList, maxReads, onProgress, signal) {
  const targetNewlines = maxReads * 4;
  const parts = [];
  let totalOut = 0;
  let newlines = 0;
  let bytesIn = 0;
  let lastReport = 0;
  let capped = false;
  const totalBytes = filesList.reduce((a, f) => a + f.size, 0);

  function consumeChunk(value) {
    if (capped) return;
    let cutoff = -1;
    for (let i = 0; i < value.length; i++) {
      if (value[i] === 0x0A) {
        newlines++;
        if (newlines === targetNewlines) { cutoff = i + 1; break; }
      }
    }
    if (cutoff >= 0) {
      parts.push(value.slice(0, cutoff));
      totalOut += cutoff;
      capped = true;
    } else {
      parts.push(value.slice());
      totalOut += value.length;
    }
  }

  for (let fi = 0; fi < filesList.length && !capped; fi++) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const f = filesList[fi];
    const isGz = await detectGzip(f);
    const reader = f.stream().getReader();
    const gz = isGz ? new Gunzip((chunk) => consumeChunk(chunk)) : null;
    const onAbort = signal ? () => reader.cancel().catch(() => {}) : null;
    if (onAbort) signal.addEventListener("abort", onAbort);
    try {
      while (!capped) {
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        const { value, done } = await reader.read();
        if (done) {
          if (gz) { try { gz.push(new Uint8Array(0), true); } catch { /* eos */ } }
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

  const bytes = new Uint8Array(totalOut);
  let off = 0;
  for (const p of parts) { bytes.set(p, off); off += p.length; }
  return { bytes, reads: Math.floor(newlines / 4), bytesIn };
}
