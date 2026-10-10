// The second reading of the same reads: amino-acid k-mers against KEGG orthologs.
//
// sylph answers "which organisms" from nucleotide 31-mers. That question and
// "which functions" are not the same question asked twice — functional
// equivalence lives near 50% amino-acid identity, where 31-mers share nothing —
// so the reads are sketched a SECOND time, in protein space, and matched against
// KEGG ortholog sketches. This is fmh-funprofiler (Hera et al., Bioinformatics
// 40, ii165, 2024) in the tab.
//
// WHAT THIS FILE IS. A sketcher that plugs into the worker's existing feed
// loops: `feed(chunk)` takes the same decompressed FASTQ bytes `profiler.feed()`
// takes, and `finish()` returns `{ K01952: 0.0184, … }`. One object per sample,
// one reference load per worker.
//
// WHY IT IS A SEPARATE FILE. The worker has four feed paths — single and paired,
// streaming and the materialising fallback, files and URLs — and threading a
// second sketcher through each of them by hand is four chances to feed one and
// forget another. This is one line in each `onChunk`, and everything that could
// be wrong lives here, where node can test it.

import { parseKoCsv } from "./kegg.js?v=79";

// sourmash writes a protein ksize as three times the amino-acid k, so k=11 is
// stored as 33. Not options: they must match the reference archive, and a
// mismatched k or scale does not fail, it returns an empty profile.
const K_STORED = 33, SCALED = 1000, SEED = 42;

// The reference, once per worker. 13,509 KEGG orthologs at k=11, ~39 MB of
// WebAssembly memory — against 433 MB for the human-gut catalogue beside it,
// which is why this fits at all.
let mod = null;
let refs = null;
let loading = null;

/**
 * Load the sourmash wasm and the ortholog sketches. Idempotent, and safe to
 * call from several samples at once: the second caller awaits the first.
 *
 * `bits` follows whatever the sylph side chose, so a worker never runs a 64-bit
 * profiler beside a 32-bit sketcher.
 */
export function loadFuncRefs({ pkg, refUrl, bytes, onProgress }) {
  if (refs) return Promise.resolve({ orthologs: refs.len() });
  if (loading) return loading;
  loading = (async () => {
    const glue = await import(`${pkg}/sourmash.js`);
    // Same shape as the sylph loader: fetch the bytes and hand them over, rather
    // than letting wasm-bindgen fetch a URL it computed itself.
    const wasm = await fetch(`${pkg}/sourmash_bg.wasm`);
    if (!wasm.ok) throw new Error(`${pkg}/sourmash_bg.wasm — HTTP ${wasm.status}`);
    await glue.default({ module_or_path: await wasm.arrayBuffer() });
    mod = glue;

    // THE BYTES COME FROM THE CALLER when it has them, and it does: the page
    // holds a pool of workers, each is its own realm, and each used to fetch the
    // 20 MB reference for itself — eight workers, eight concurrent downloads of
    // one file, under a line that promised "20 MB, once". Handed the compressed
    // bytes instead, the wire cost is one download whatever the pool size. The
    // 48 MB of text and the 38 MB of WebAssembly are still per worker, because
    // each worker sketches on its own; that part was always true and is stated.
    let source;
    if (bytes) {
      source = new Response(bytes).body;
    } else {
      const res = await fetch(refUrl);
      if (!res.ok) throw new Error(`${refUrl} — HTTP ${res.status}`);
      source = res.body;
    }
    // Decompressed by the platform. 20 MB over the wire, 48 MB of text: read as
    // a stream so neither is held twice.
    const text = await new Response(
      source.pipeThrough(new DecompressionStream("gzip"))).text();
    const prof = new mod.FuncProfiler();
    let n = 0;
    for (const line of text.split("\n")) {
      if (!line) continue;
      prof.add_references_json(line, K_STORED, SCALED);
      if ((++n & 1023) === 0) onProgress?.(n);
    }
    refs = prof;
    return { orthologs: prof.len() };
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

export function funcRefsLoaded() { return !!refs; }

/**
 * One sample's protein sketch.
 *
 * READS GO IN ONE AT A TIME, and that is not an oversight. Concatenating them
 * would put amino-acid k-mers across the junction of two unrelated reads, and
 * six-frame translation makes those chimeras plausible-looking rather than
 * obviously wrong. `add_sequence_js` on a protein KmerMinHash already IS
 * `sourmash sketch translate`, six frames included.
 */
export function newFuncSample() {
  if (!mod || !refs) return null;
  const sketch = new mod.KmerMinHash(0, K_STORED, true, false, false, SEED, SCALED, true);
  let seqs = 0;
  let dead = false;

  // ONE PARSER PER STREAM, one sketch for the sample. The paired path calls back
  // from two streams at once — onChunk1 and onChunk2 interleave in whatever order
  // the two downloads arrive — so a single line counter and a single carry would
  // put R2's bytes on the end of a half-read R1 line and lose the phase of the
  // 4-line record for the rest of the file. Both mates belong in the SAME sketch:
  // they are the two ends of the same fragments, and the sample is the library.
  const streams = new Map();
  const parserFor = (idx) => {
    let st = streams.get(idx);
    if (!st) { st = { dec: new TextDecoder(), carry: "", line: 0 }; streams.set(idx, st); }
    return st;
  };

  return {
    /**
     * The same bytes `profiler.feed()` takes: decompressed FASTQ at arbitrary
     * boundaries, so the record structure has to be tracked across chunks —
     * line 1 of every 4 is the sequence. `stream` names which of the concurrent
     * byte streams this chunk belongs to (0 for single-end, 1 and 2 for mates).
     */
    feed(chunk, stream = 0) {
      if (dead) return;
      const st = parserFor(stream);
      const text = st.carry + st.dec.decode(chunk, { stream: true });
      let start = 0;
      for (;;) {
        const nl = text.indexOf("\n", start);
        if (nl < 0) break;
        if (st.line % 4 === 1) {
          const seq = text.slice(start, nl).trimEnd();
          if (seq) { seqs++; sketch.add_sequence_js(seq); }
        }
        st.line++;
        start = nl + 1;
      }
      st.carry = text.slice(start);
    },
    /** A file with no trailing newline holds its last record in the carry. */
    finish() {
      if (dead) return null;
      for (const st of streams.values()) {
        if (st.carry && st.line % 4 === 1) {
          const seq = st.carry.trim();
          if (seq) { seqs++; sketch.add_sequence_js(seq); }
        }
      }
      const hashes = sketch.size_js();
      // min_overlap 1, as fmh-funprofiler uses: one shared hash is the detection
      // floor, and raising it here would silently drop the rare tail rather than
      // let the interface's own floor decide what to show.
      const csv = refs.profile(sketch, 1);
      sketch.free?.();
      dead = true;
      return { profile: parseKoCsv(csv), reads: seqs, hashes };
    },
    /** Cancelled samples must not leak a sketch into the next one. */
    drop() {
      if (dead) return;
      dead = true;
      try { sketch.free?.(); } catch { /* already gone */ }
    },
    get reads() { return seqs; },
  };
}
