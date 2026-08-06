# Changelog

Figures in this file are measured on the development machine (Chrome 151, Linux, 62 GB RAM),
not estimated. Where a number replaced an assumption, the assumption is named too — several of
them were wrong in ways that mattered.

## 2026-08-06

### The read ceiling: 3 M → 24 M (32-bit) / 96 M (64-bit)

The cap on reads per sample was documented as the 4 GB limit of wasm32. It was not, twice over:

- **Half the peak was a free copy.** `Profiler::profile` called `fastq.to_vec()` on a slice that
  already lived in linear memory. Removing it took the peak from **2.08× to 1.08×** the FASTQ.
- **The real wall was in JavaScript.** Chrome refuses a single `ArrayBuffer` of 2 GiB, so the
  old "trim everything into one buffer, then hand it to wasm" path stopped near 7 M reads
  whatever the pointer width. 6.57 M reads were profiled under **wasm32** to confirm it.

#### Streaming sketcher

`Profiler` gained `begin_sample` / `feed(chunk)` / `finish_sample`, so the FASTQ is never
materialised. Blocks are cut on record boundaries and each complete block is handed to
`needletail` — reusing the upstream parser is what makes the results identical rather than
merely similar.

- Peak wasm memory on a 542 MB FASTQ: **+572 MB → +45.4 MB**, byte-identical TSV.
- Equivalence checked in the browser across 7 chunk schedules, including **one byte per call**
  (56,837,152 `feed` calls) and a size landing exactly on a record boundary: one sha256 for all.
- An independent differential fuzz ran **4.09 million comparisons** with zero divergence.

#### Dual wasm32 / wasm64 build

`scripts/build_wasm.sh 32|64|both`. The site probes for memory64 and keeps the 32-bit package
unless the requested read count needs more.

| build | ceiling measured (all-distinct reads) | shipped as safe |
|---|---|---|
| wasm32 | 48.75 M reads | 24 M |
| wasm64 | 195.5 M reads | 96 M |

The 64-bit cost is **not** in sketching (1.017×, i.e. 1.7 %) but in the inference pass — closer
to a fixed per-sample cost than a per-read one; 1.58–1.71× end to end on a 198 k-read sample.
Safari supports memory64 in no version, so the 32-bit fallback is mandatory, not a convenience.

### Added

- **Profile public data straight from the ENA.** Paste a run, sample, experiment or project
  accession; the runs are listed with layout, read count and size, and the ones you tick are
  streamed from the EBI into the profiler — decompressed, sketched and discarded chunk by chunk,
  never permanently saved to disk. Both the portal API and the FASTQ hosts send
  `access-control-allow-origin: *` and honour `Range`. Live check: ERR14098592, 101.9 MiB at
  5.4 MB/s, 845,387 reads.
- **A resumable, cached database download** (`web/db-cache.js`). One download per database
  regardless of pool size, in `Range` slices written into OPFS as they arrive, resumed after a
  cut *and* after a page reload, validated on size and `Last-Modified` before use, with rate,
  ETA, cancel, and a list of what is cached with a Delete button.
- **Partial results while a run is going.** The matrix was already built sample by sample but
  only rendered at the end; it now appears as it fills, and the summary says how much of it is
  there (`still running, 3 of 85 done`) so a partial matrix cannot be exported as a whole one.
- **A pair-counting unit.** For paired samples, a checkbox switches the cap and every read count
  between pairs (sylph's unit) and sequenced reads (the ENA's). The two differ by exactly 2×.
- **Numbered steps.** The three cards fill in as each step is satisfied, and "Profile all" says
  why it is disabled instead of simply being grey.
- `web/sample-naming.js`, `web/ena.js`, `web/db-cache.js`, `web/db-cache-worker.js`,
  `web/fastq-trim.parity.test.mjs`, `scripts/ena-test/`, `scripts/dbcache-test/`,
  `scripts/flaky_server.py`, `scripts/build_wasm.sh`.

### Changed

- **Threads takes effect immediately.** Resizing the pool used to wait for the next
  *Load database* because every new worker re-downloaded the database. It now reads the OPFS
  cache, so the change applies on the spot with nothing re-fetched.
- **"Max reads per sample"**, not "Reads per sample": the control is a cap. A sample with fewer
  reads is profiled whole, and the ENA read-count check only applies when the cap was not hit.
- The reads control now describes a **speed/sensitivity trade-off** rather than a memory guard,
  and estimates **time** rather than memory. Default 3,000,000 — this is a quick profiler.
- The privacy banner names its **three** network destinations (the site itself, zenodo.org for
  the database, the EBI in ENA mode) instead of implying there is one.
- `Cargo.lock` is tracked, and the unused direct `rand` dependency is gone.

### Fixed

- **The wasm32 build did not compile at all.** With no `Cargo.lock`, `rand = "0"` had drifted to
  rand 0.10 → getrandom 0.4, which refuses a wasm target without `wasm_js`. Nothing in `src/`
  ever used `rand`.
- **Paired files were not grouped** unless the mate marker touched the extension.
  `..._1.clean.fq.gz` and Illumina's `..._R1_001.fastq.gz` both failed. Matching is now on the
  whole name minus the marker, so `a_1.clean` still does not pair with `a_2.raw`.
- **One database download per worker.** The pool called `loadDbUrl` on every worker and each ran
  its own `fetch` — 4 threads meant 1.7 GB of simultaneous downloads competing for the link, on
  a server that sends neither `Cache-Control` nor `ETag`. Measured after: **6,516,832 bytes
  instead of 26,067,328**, and 32 cuts out of 33 requests still produce the exact file.
- **A non-deterministic TSV.** `parse_fastx_reader` was called per block and dispatches on the
  first byte, so a block starting with `>` was re-read by a FASTA reader: 135 divergences over
  30,000 inputs × 6 schedules, 0 after pinning the format.
- **Cross-sample contamination in paired mode.** A failing mate left the other loop feeding the
  *next* sample's `Profiler` — wrong abundances returned as a success.
- **A truncated `.gz` was swallowed** as a clean end of stream, so a partial profile was
  presented as complete.
- Three cache paths that served a corrupted database silently: a resume without `Range` writing
  the file over itself, an incoherent pointer *clamped* to the file size and therefore read as
  complete, and a short disk write leaving a hole at the right total length.
- **A retry budget that only counted failures**, so a server honestly delivering one byte per
  request looped forever: 2045 requests in 45 s before, bounded now.
- **`Content-Range` is not CORS-safelisted** and Zenodo does not expose it. Reading the total
  size from it passed every same-origin test and would have recorded the database as 1 byte.
- Cache-busting covered the worker's imports but not the pages' — a returning visitor got the
  new `multi.js` against a cached `sylph-worker-rpc.js` and a dead application
  (`r.loadDbCached is not a function`). The stylesheet had the same hole. One token now covers
  the whole graph.
- The ENA's `read_count` counts **both mates** of a paired run while the worker counts pairs
  (verified: 13,510,300 published, 6,755,150 records in R1). Comparing them directly would have
  flagged every paired run as 50 % short.
- Licensing: `sylph-wasm/` is a fork of sylph and carried **no licence file**, and
  `web/vendor/fflate.js` none either. Both are now present with their original copyright, the
  README states what comes from where, and the fork's README says it is a modified copy.

### Notes on testing

Three rounds of adversarial review found defects that the working tests could not, because those
tests only ever used valid input. An audit then removed correctives one at a time and found four
that **no test failed on** — so every fix since is required to show its test failing when the fix
is taken out. The benches currently catch 33 mutations out of 33.

Known gaps, deliberately not hidden: `cargo test --lib` does not compile `wasm.rs` (the module is
behind `cfg(target_arch)` and tests run on x86_64 — the browser harnesses cover it instead); an
`incomplete` sample still merges into the exported matrix without a marker in the TSV; corruption
in the middle of a full-length file remains undetectable, as no static host offers a content
hash; Firefox and Safari are untested.
