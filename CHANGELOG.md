# Changelog

Figures in this file are measured on the development machine (Chrome 151, Linux, 62 GB RAM),
not estimated. Where a number replaced an assumption, the assumption is named too — several of
them were wrong in ways that mattered.

## 2026-08-08 (4)

### Interface review: six bugs, four accessibility failures, half the wall of text

A five-lens review of the live page proposed 29 changes; 24 survived adversarial
verification, and every number below was measured before and after.

**Bugs.** The page scrolled 267 px sideways on a phone (one `<select>` with an
inline `min-width:20rem`, sized to its longest option). A failed wasm boot turned
*Load database* into a permanent silent hang, controls already disabled. **Zero
species — the exact signature of the wrong catalogue — was printed in the success
green and counted as "ok"**; it is now its own status, named, coloured, counted
apart and re-runnable. An orphan `_1` built a sample with no files at all and
blamed the FASTQ; it is profiled single-end now, with the note the paired branch
already showed. The ENA rows painted the accession over the file size below
640 px. The sticky matrix header never engaged, because its scroll box had no
height.

**Accessibility.** The FASTQ drop zone was unreachable without a mouse —
`display:none` on the input takes it out of the tab order — so the one path where
reads never leave the machine was the one a keyboard could not use, while the ENA
path was fully operable. Not one live region existed: a 433 MB download started,
progressed and finished in silence. `--ink-muted` measured **2.79:1** and white on
the accent teal **3.09:1**, both below AA, on every status line and every primary
button. Now 4.96:1 and 5.42:1.

**Density.** Three warning panels, 1,662 px tall on a phone, put the first control
**2,080 px** down — two and a half screens. The two download paragraphs moved to
the controls they describe (the ENA one literally said "the ENA mode *below*",
2,900 px below), and the red panel went: it was the third statement of the same
warning and the only one that could not name the selected biome, which
`#dbBiomeNote` does live, under the picker.

    mobile   Step 1 at 2080 px -> 1266 px     panels 1662 px -> 820 px
    desktop  Step 1 at  850 px ->  595 px     panels  538 px -> 280 px
    words in <main>  898 -> 876

876 words against 898: the text was moved, not deleted.

**Stale copy.** The yellow panel still described "fast in-browser checks of *gut*
metagenomic composition" and named UHGG as the citation for all nineteen
catalogues. The page's first sentence described a drop-files-only tool — no ENA,
no automatic biome detection.

One test contract changed deliberately rather than quietly: `wiring.mjs` demanded
that the Zenodo download be named IN THE BANNER. It is now named at the control,
and the bench checks both halves — the banner names both kinds of request, the
card carries the detail. Its check was also narrowed to the database card: a
fallback `<option>` elsewhere in the file contains a zenodo.org URL and "433 MB",
so the whole-file version passed with the paragraph deleted, which is how that
mutation escaped once.

## 2026-08-08 (3)

### The host compresses, so Content-Length is not the file size

    Screening failed: the server sent more than the 11736250 bytes it declared
    (11789879 and counting)

on a download that was perfect. GitHub Pages serves `db/screening.syldb` with
`Content-Encoding: gzip`: Content-Length is **11,736,250**, the compressed body,
while `fetch()` decompresses transparently and the reader delivers the real
**13,319,802**. The overrun guard was comparing a content size against a
transfer size.

No header can settle it. A Range probe against the same host answers
`Content-Range: bytes 0-0/11736250` — the compressed total as well — and the
browser cannot ask for an identity encoding, because `Accept-Encoding` is a
forbidden header name for `fetch()`. The size the CALLER knows is the only truth
available, and it was already there: `db/biomes.json` carries `bytes` for every
entry, and `biomes.js` already refuses a database whose size disagrees with it.
It is now used one step earlier, where a compressing host would otherwise kill
the download before anything could be checked. The screening database declares
its own size in `screening-markers.json`.

Where no expected size is known and the host compresses, the error now names the
cause instead of accusing the server of overrunning.

**Every bench in this repository serves files with `python3 -m http.server`,
which does not compress** — which is exactly why production found this and none
of them could. `scripts/dbcache-test/node-suite.mjs` now runs one scenario
against a gzipping server, and asserts both directions: the error names
compression when the size is unknown, and with the caller's size the file lands
on disk byte for byte.

`gut_mini.syldb` had the same latent fault — 6,236,165 declared for 6,516,832
real — and only escaped it by being loaded before this guard existed in the path.

## 2026-08-08 (2)

### Two modes for choosing a catalogue, and the biome can be found for you

Picking the wrong catalogue is the main way to be misled by this tool, and until
now the only answer was "you tell us". Step 1 now asks how you want to choose:

- **myself** (default) — the picker, as before. Automatic is not the default: it
  costs a 13 MB download and a screening pass, and most users know their biome.
- **automatically, from a sample** — screens the first sample against the 13 MB
  marker database, then loads the catalogue it points to. One click from an
  unlabelled FASTQ to a loaded reference.

The screen runs in a worker of its OWN, created for it and terminated after. The
obvious implementation — load the markers into one of the pool workers — would
silently replace the reference database that worker holds, and the next sample it
drained would be profiled against 4,169 screening markers while the matrix went
on naming the catalogue the user chose.

A verdict is ranked by EXCLUSIVE support, never by how much a catalogue explains:
shared species raise every catalogue they belong to, so the plain figure crowns
whichever is largest and most cosmopolitan. Measured on a gut sample, human-gut
96.1% explained / 42.1% exclusive against mouse-gut 46.7% / **0.0%** — mouse-gut
is riding, not indicated. When nothing is exclusive the verdict is refused rather
than guessed, and the panel offers the manual picker instead.

### The matrix names the catalogue of every column

The reference was one line above the table — which a screenshot, or a copied
range, leaves behind. Each sample now records the reference it was profiled
against as it is profiled, and the matrix header carries it per column. Both
exports gain a `# reference per sample:` line, and a warning line if the columns
ever disagree.

With one database loaded they all repeat, and that repetition is the point: the
reference becomes a property of the column instead of a caption. It is also the
only thing that could reveal a mixed matrix if the invariant that prevents one
were ever lost — and automatic mode loads a database mid-session, which is
exactly the kind of change that loses invariants.

## 2026-08-08

### Every catalogue names its species, and links them

Profiling against anything but human-gut returned a column of accessions —
`(MGYG000304057.fna.gz)` — because only human-gut had a genome-to-species map.
MGYG000304057 is *Lactobacillus iners*, and a vaginal result was unreadable for
want of a lookup table. All nineteen catalogues have one now, generated by
`scripts/build_lineages.py` from MGnify's `genomes-all_metadata.tsv`: **56,782
genomes, exactly the count of the Zenodo deposit**, 59% with a full GTDB species
name and the rest falling back to the lowest rank that exists rather than to an
accession. Each genome links to its MGnify page.

The generator refuses to write a map whose entry count disagrees with the
database: partial coverage would show names on some rows and accessions on
others, which reads as missing data rather than as a broken build. It fired
three times, every time on this code — `d__` missing from the fallback ranks,
and three marine genomes with no classification at all (now `unclassified`,
which says the silence comes from the taxonomy and not from the application).

Human-gut gained from it too: 1,187 of its 4,744 rows had a **blank** name.
None of the 4,744 existing names changed.

### read_count means pairs on some runs and reads on others

`INCOMPLETE — 14,091 reads were profiled but the ENA lists only 7,046 (100.0%
more) — the file served does not match the catalogue`, on a download that was
perfect. The ENA does not use one convention for `read_count` on paired runs and
does not say which it used:

    ERR14098649  read_count 13,510,300  base_count/read_count = 149.8  -> READS
    ERR4421639   read_count     14,091  base_count/read_count = 302.0  -> SPOTS

All 91 runs of PRJEB34536 are the second kind, so the whole project reported as
corrupt. Both readings are accepted for paired runs now, and only a count
matching neither is flagged. The check keeps its teeth — truncated to 10%, four
times too many, half of expected, and a doubled single-end run are all still
caught — at the cost of one blind spot, asserted as a test rather than described
in a comment: a spots-convention run cut to exactly half now passes.

(The two zero-species samples that surfaced this were `Water1` and `Water2`, the
project's only negative controls. Zero was right.)

### Per-sample progress, and words that mean what they say

- A progress ring on each running line, where **full means the sample is done** —
  which under a read cap is not the end of the file. Under a 3 M cap a 10 M-read
  file finishes at 30% of the bytes, so a byte-driven ring would vanish at a
  third and look like a crash; a read-driven one would freeze at 33% on a file
  smaller than the cap. It is the larger of the two ratios, and NaN rather than
  0 when there is nothing to measure, so an indeterminate spinner can say so.
- The ENA lookup shows a spinner and, past 1.5 s, the elapsed seconds. PRJEB34536
  answers in 0.2 s — which is exactly why it had no feedback, and why the slow
  case was the one left staring at a frozen line.
- **"trimming" is gone.** Nothing was ever trimmed: no quality filter, no adapter
  clipping, not a base removed — the stream stops after the Nth record. Nor is it
  downsampling, which implies a random draw. The step now reads
  `first 3,000,000 pairs`.
- The read cap names its unit. `Max reads per sample: 3,000,000` with the pair
  box unticked meant three million PAIRS — six million sequenced reads — so the
  label contradicted the unit it was in. The word follows the box now, and the
  conversion is spelled out instead of left as arithmetic.

## 2026-08-07 (2)

### Runs sylph cannot profile are named as such, before they are downloaded

Profiling PRJNA1270378 against the vaginal catalogue returned nothing. That was the correct
answer — 26 AMPLICON / PCR / Nanopore runs, 16S rather than shotgun — but the app had no way to
say so. sylph asks what fraction of a whole genome the reads cover; an amplicon covers well under
1% of one, so the containment stays below the detection threshold whatever catalogue is loaded.
An empty table, with no error and no warning, is indistinguishable from a bug, and the natural
conclusion is that the database is wrong.

`library_strategy`, `library_source` and `instrument_platform` ride along in the filereport
request `ena.js` already makes — the information was one word away in a URL. Runs whose library
type cannot answer the question are now listed with the reason, and left **unticked**: the
default should not spend 200 MB a run on a download whose result is known in advance. They stay
tickable, and "Select all" still takes them; that is an explicit instruction, this is a default.
On PRJNA1270378 it is 4.89 GiB not downloaded.

- Deliberately a fixed table (AMPLICON, RNA-Seq, WXS, Targeted-Capture, Bisulfite-Seq, Hi-C,
  ChIP-Seq, ATAC-seq, and METATRANSCRIPTOMIC via `library_source`) rather than "not WGS →
  complain". ENA has ~35 strategy values and shotgun metagenomes are declared under WGS, WGA and
  quite often OTHER; a warning that fires on good runs is one the user learns to click through on
  the bad ones. A run with no library metadata says nothing.
- Both directions are pinned by mutation: one that stops warning entirely, and one that warns on
  everything. The second matters as much as the first.
- **`web/fastq-trim.parity.test.mjs` had been crashing since the databases were published** — it
  asserted on entries with no URL, and there are none left. Caught here rather than there because
  that suite was not run before the previous commit was pushed. No user-facing effect: the suite
  broke, not the site. Repaired the same way as the other one, by building the pending entry in
  the fixture instead of borrowing it from production data. A `/gut\.syldb/` check that passed
  only because `human-gut.syldb` contains that substring was made explicit at the same time.

## 2026-08-07

### The nineteen databases are published

All nineteen `.syldb` files are deposited on Zenodo as a single record — 6.24 GiB, **CC0**,
concept DOI [10.5281/zenodo.21842022](https://doi.org/10.5281/zenodo.21842022), this version
[10.5281/zenodo.21842023](https://doi.org/10.5281/zenodo.21842023). Eighteen of them were built
but had nowhere to be fetched from; the picker listed them greyed out. They are now selectable,
and the app covers the biomes it claimed to.

One record rather than nineteen: one DOI to cite, one page to maintain. The human-gut database
moved into it from its own older record (20180025) and is now named `human-gut.syldb` rather than
`gut.syldb`, so every biome is fetched at `.../records/21842023/files/<key>.syldb/content`.
A visitor who had the old one cached re-downloads it once — the OPFS cache is keyed by URL.

- Each file's md5 was verified against the local copy at upload, and each of the nineteen URLs
  was checked to answer a real `Range` request with the exact byte count in `db/biomes.json`.
  That count is not decorative: `biomes.js` refuses a database whose size disagrees with it.
- **`db/biomes.json` was fetched at a bare, permanently cacheable path.** Publishing the
  databases would have changed nothing for anyone who had already visited: their browser would
  have kept the catalogue in which eighteen entries say "not published yet". It now carries a
  version parameter of its own, bumped with the file.
- Three hardcoded copies of the old URL survived in the fallback catalogue and in both pages'
  static `<option>` — the path taken only when `biomes.json` cannot be read, which is precisely
  when nobody is watching. Found by sweeping for the old record id rather than by testing.
- `scripts/ena-test/mutations.mjs` carried a mutation whose target text had already been
  rewritten, so it was skipping rather than testing. A mutation that cannot be applied is a hole
  in the suite that reports itself as a pass.

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
