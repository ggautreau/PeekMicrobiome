# PeekMicrobiome

Upload-free, installation-free metagenomic profiling across biomes. A WebAssembly build of [sylph](https://github.com/bluenote-1577/sylph) that runs entirely in the browser: your FASTQ files are never uploaded, nothing is installed, and reads are sketched as they stream — the FASTQ is never held whole. Nineteen MGnify reference catalogues, one biome at a time.

**Live site:** <https://ggautreau.github.io/PeekMicrobiome/>

> [!IMPORTANT]
> **Unofficial port.** This is an adapted WebAssembly port of sylph for quick, in-browser checks of metagenomic composition — a *preview*, which is what the name says. It is **not supported or endorsed by the sylph authors** and does not achieve the reliability of [sylph](https://github.com/bluenote-1577/sylph), [MetaPhlAn4](https://github.com/biobakery/MetaPhlAn), or [Meteor2](https://github.com/metagenopolis/meteor) run natively — use those for real analyses. If you use the results, please cite the upstream papers below.

## Goals

- **Zero install** — single static site, no server-side compute.
- **Privacy** — a FASTQ you drop in never leaves your machine, in any mode. The page does download things (a reference database, and public FASTQs if you ask for them); see *What crosses the network* below for all of them, and in which direction.
- **Whole samples, not subsamples** — reads are sketched in a streaming pass, so nothing that grows with the input is ever materialised.

## What crosses the network

Every request this page makes, and nothing else. All of them are downloads *towards* you: no
file of yours, no read, no file name and no result is ever uploaded, in any mode.

| Step | What crosses the network | What the other side learns |
|---|---|---|
| **Drop a FASTQ** | nothing | nothing |
| **Load database** (any published biome) | the catalogue you picked coming *down* from `zenodo.org`, once, then cached on your computer — 454 MB for the human-gut default, 13 MB to 3.0 GB for the others | Zenodo sees your IP address and which of these files you asked for |
| **Load database** (bundled 6 MB / local `.syldb`) | nothing beyond the site itself | nothing |
| **Paste an ENA accession** | the accession, then the public FASTQ files coming *down* from the EBI | the EBI sees your IP address and which accessions you asked for |
| **Open the Gut Metabolic Modules level**, after answering its licence question | 8 KB of definitions coming *down* from `raw.githubusercontent.com` — the Raes lab's own repository, never this one | GitHub sees your IP address and that you asked for that file |

Loading a database is **required before anything can be profiled**, including a purely local
FASTQ, so the Zenodo row applies to everyone who does not pick the bundled or a local database —
which is why it sits in the page banner next to the other two, at the same level, rather than
being left as a footnote about caching.

## Two input modes

The second input mode exists because the interesting samples are usually already public: a run,
sample, experiment or project accession is resolved against the EBI's
[portal API](https://www.ebi.ac.uk/ena/portal/api/filereport), the runs it covers are listed with
their layout, read count and size, and the ones you tick are **streamed straight from the EBI's
servers into the profiler** — decompressed, sketched and discarded chunk by chunk, never
permanently saved to disk. FASTQ URLs are only followed on hosts under `ebi.ac.uk` (in practice
`ftp.sra.ebi.ac.uk`, but the EBI is free to name another of its mirrors and the allow-list says
`ebi.ac.uk`, not one host). Both modes feed the same sample list, the same worker pool and the
same abundance matrix.

### Downloading a run (`web/ena.js`)

At the ~4-5 MiB/s this link measures against the EBI, a 1.8 GB paired run is **eight minutes** of
downloading against about one minute of profiling. A connection cut at 90 % that starts over is
not a slow path, it is a broken feature — so `urlSource()` gives the streaming trimmer a
`ReadableStream` that resumes:

- it satisfies the same three-method contract `streamCore` already asked of a `File`
  (`.size`, `.slice(0,2).arrayBuffer()`, `.stream()`), so multi-member gunzip, the cut on a record
  boundary, the incremental sketcher, the R1/R2 drift budget and cancellation are all reused
  untouched;
- a cut re-opens with `Range: bytes=<already read>-`, with growing backoff;
- **every** request counts against a ceiling, not just the failed ones — a server answering a
  handful of bytes per request is "making progress" for ever otherwise (the exact hole that was
  found in `db-cache.js`);
- a `200` where a `206` was expected is never pasted onto the bytes already delivered: the read
  restarts from zero and skips the prefix, a bounded number of times, then fails. Concatenating
  would produce a valid prefix followed by the whole file again — a wrong sketch with no symptom;
- a `Last-Modified` or size that changes mid-read is a hard failure, because the reads already
  fed to the sketcher came from the other version;
- a body that ends cleanly but *short* is treated as a cut, not as the end of the file — "short"
  meaning short of **either** witness, the server's `Content-Length`/`Content-Range` *or* the
  `fastq_bytes` the portal API published. Those two are also compared with each other, and a
  disagreement is fatal: an object truncated upstream and served with an honest `Content-Length`
  for the truncated object satisfies every check the server can be asked to make of itself, and
  `fastq_bytes` is the only number that comes from somewhere else;
- and after all of that, the number of reads that actually came out of the decompressor is
  compared with the run's `read_count` (unless the *Max reads per sample* cap stopped the read first).
  A sample that profiled fewer reads than the ENA lists is reported as **incomplete**, with the
  shortfall, instead of as a result. It is the only check that can see a truncation both size
  witnesses agreed on.

The worker builds the source itself (an object with methods does not survive `postMessage`) and
handles the URL variants in the *same* branches as the `File` ones, so there is one copy of the
sketching loop.

Test it against a deliberately hostile server, and against the real page, without touching the EBI:

```bash
node scripts/ena-test/node-suite.mjs   # ~15 s: resolution + resume, byte-for-byte assertions
node scripts/ena-test/wiring.mjs       # instant: what the pages and this file claim
node scripts/ena-test/tsv-parity.mjs   # ~40 s: same data, both paths, same TSV (see below)
node scripts/ena-test/mutations.mjs    # ~4 min: each guard removed in turn, bench must notice
node scripts/ena-test/page.mjs         # ~2 min: headless Chrome, real page, download cut mid-run
node scripts/ena-test/live.mjs         # one 102 MiB run against the real ENA
```

The criterion this whole mode is judged on is not "did it error": it is **the same data profiled
through the local-file path and through the ENA path must produce the same TSV**.
`tsv-parity.mjs` is the test that holds it. It profiles one real fixture twice — once from a
`File`, once through `urlSource()` against a server that cuts every second request — and compares
the TSVs byte for byte, for a capped single-end read, a capped paired-end read (where the two
streams interact through the drift budget and the cross-stop) and a whole file with no cap. The
fixture is the first few tens of thousands of reads of `ERR14098592`, fetched once with a `Range`
request into `scripts/ena-test/fx/` (git-ignored) and reused afterwards:

```bash
node scripts/ena-test/fixtures.mjs     # ~8 MiB from the EBI, once
```

## What you get back

Two halves, in two tabs: **which organisms**, and **which functions**. They are two questions, not
two views of one table, so they get one tab each and neither is a sub-panel of the other.

One row per taxon, one column per sample, cells in taxonomic (relative) abundance. Downloadable
as TSV or CSV, and as the formats other tools read — sylph's own TSV, MetaPhlAn, BIOM 1.0 — plus
a session file that puts the whole result back on screen later.

Five figures are drawn from whatever is on screen, as inline SVG: no plotting library, no DOM and
no fetch anywhere in `web/figures.js`, which is what makes every one of them testable in plain
node and downloadable as a file you can paste into a manuscript.

- **Composition** — stacked bars, the top N taxa plus a grey *other* that is never dropped: a bar
  stopping at 60 % with no explanation reads as missing data rather than as a legend cut. How many
  taxa are named is a slider, up to 30 — held under the 36 colours the palette can tell apart, by
  a test that fails if either number moves without the other.
- **Diversity** — Shannon as *effective taxa* (e^H) beside observed richness. The order matters:
  on paired libraries 6× apart in sequencing depth, observed richness moved 110 → 274 while
  effective taxa moved 63 → 69. One of those two numbers is mostly a depth readout.
- **PCoA** — classical MDS on Bray-Curtis. The axes say what fraction of the positive eigenvalue
  total they carry, which on the shipped example is 25.8 % and 22.9 %: the plane shows 49 % of
  what separates those eighteen samples, and the rest is why the neighbour list can disagree with
  what the eye reads. Zoom and pan, and colouring either by a metadata field or by k-means
  clusters — with the silhouette written inside the figure, because k-means always returns
  clusters and on samples with no structure at all that score still averages about 0.3.
- **Enterotype** — human gut only, and it refuses on any other catalogue by name. A three-way
  split between Bacteroides, Prevotella and Ruminococcus drawn as a triangle: the position IS the
  split, and a sample in the middle is drawn in the middle. The pole names are GTDB's, not 2011's
  — `Phocaeicola` carries 56 % of the Bacteroides pole on the example, and bare `Ruminococcus` is
  empty in every sample.

- **Contrast** — which rows differ between two groups of samples, ranked by the **difference in mean
  abundance** and tested by a two-sided **Mann-Whitney**, exact by permutation, with
  **Benjamini-Hochberg** across every row of the table rather than across the ten on screen. Rows
  stay ordered by effect, not by p: at nine samples a group a p-value ordering is mostly an ordering
  of how many zeros a row has. Every sample is drawn as its own dot — the spread and the overlap a
  q summarises away — and clicking one opens that sample, as on the ordination.

  **The figure states what the test cannot do.** At three samples a group there are only
  C(6,3) = 20 ways to split them, so the smallest two-sided p the test can return is 0.1: *nothing*
  can reach 0.05, however cleanly the groups separate, and a column of q near 1 is arithmetic rather
  than a finding. The caption says so, with the number, whenever the groups are that small. At nine
  a side the floor is 2/48,620 and significance is attainable — though on the shipped example,
  split by sex, the smallest q over 468 species is 0.058 and nothing survives the correction.

  Which two groups is a picker, because "the two largest" is a coin toss when six groups have three
  samples each.

### Making the groups

The ordination colours by groups and the contrast plot is about them, so there are three ways to
have some, and all three end in the same map:

- **A field of the archive's own metadata.** A run that came from the ENA already carries what it
  needs — the bundled example splits nine and nine on `host_sex` without anybody typing anything.
  Only fields that actually split the run are offered: one value for every sample groups nothing,
  and a distinct value per sample groups nothing either.
- **The editor**, sample by sample, for everything else — a local FASTQ carries no metadata at all.
  Type any name beside a sample; repeat it for the ones that belong together. It says as you go
  whether what you have made can be contrasted, because one group of six cannot.
- **A two-column CSV**, as before.

If a run has no groups, the **Contrast** figure says so and offers both: one button for the best
metadata field it found, one that opens the editor. It used to draw "most variable rows" instead —
a real answer to a different question, under a tab labelled Contrast, with nothing saying a group
was missing. That view is still there, by name, under the buttons.

It is a dialog, not a mode over the plot, and that is deliberate: **clicking a point opens what that
sample is made of**, and a "click samples to group them" mode would take that gesture away for as
long as it was on. Groups made by hand are saved with the session; groups derived from a metadata
field are not, because the field is saved beside them and deriving it again costs nothing.

In that panel the pie draws **every** taxon, not only the named ones: the rare tail keeps its grey
and its single "other taxa (110)" legend row, but each of those hundred and ten is its own wedge
with its own share, and hovering one names it. They were a single grey slice before — a hundred and
ten measurements with nothing to ask of them.

**The matrix can be searched and sorted.** Type a name or an identifier to filter it — 468 species
is not a list anyone scrolls — and click a sample's column to rank by that sample; a third click
gives the table its own order back. Both halves have both.

Clicking a point, a bar or a row opens that sample beside the figure: what it is made of, how
diverse it is, which samples it is really nearest — over every row of the matrix, not the
two-dimensional shadow of them the ordination draws — and what the archive says it is, when it
came from one.

Every figure carries the catalogue in its caption, for the same reason the matrix does: these are
abundances relative to one catalogue and to nothing else.

### The functional half

Tick **also profile functions** before a run and the same reads are read a second way, in the same
pass: translated in six frames and sketched as **amino-acid** k-mers (k=11, scaled 1000), then
matched against 13,509 KEGG ortholog sketches. This is
[fmh-funprofiler](https://doi.org/10.1093/bioinformatics/btae397) (Hera *et al.*, *Bioinformatics*
**40**, ii165, 2024) in the browser, beside sylph, in the same worker.

It is **measured, not inferred**: nothing here predicts function from the species that were found.
And it is off by default, because it is not cheap — a 20 MB reference download once, 38 MB of
WebAssembly memory in every worker, and **about four to five times as long per sample** (measured:
2.4 s against 11 s on 200,000 reads in Chrome, same file and same database). On runs streamed from
the ENA the download usually still dominates. A cost that size has to be a choice.

What it does not do is stated on the tab, in the same voice as the biome warning: the method finds
about **60 % of a sample's orthologs overall and about 85 % of the abundant ones**, so a function
missing from the table is not necessarily missing from the sample.

The orthologs roll up into KEGG modules and pathways, and each row links to KEGG — a pathway cell
opens that map on kegg.jp **coloured by that sample's own ortholog abundances**. Two things the
interface says out loud because they are easy to read wrongly: the roll-ups **overlap** (an ortholog
in three modules is evidence for all three, so the columns do not add to 100 %), and diversity is
therefore computed over the orthologs whatever level is on screen — an entropy over categories that
share members is not a diversity index.

**A cell can be opened.** At the module and gut-metabolic-module levels, clicking a number says what
it was measured from: for a KEGG module, the orthologs detected in it and their abundance in *that*
sample, each linking to KEGG; for a gut metabolic module, its steps — which were found and which were
missing, which is why a cell can be empty while its orthologs are present, since the module is a path
and one broken step breaks it. An ortholog row has nothing inside it that its own identifier does not
already link to, and a pathway cell opens KEGG's coloured map instead.

KEGG is not a public database. Academic use is free; any non-academic use needs a commercial
licence. The tab asks once, before it shows a single KEGG identifier, and the answer stays in the
browser. The [Gut Metabolic Modules](https://github.com/raeslab/GMMs) level asks its own question
for the same reason and ships **no definitions at all** — VIB licenses them for academic use inside
one institution, so the reader opens their own copy, which is read in the tab and stored nowhere.

## Read ceiling

The FASTQ used to be trimmed, decompressed, concatenated into one `Uint8Array` and handed to
wasm in a single call. That capped a sample at 3 M reads. It no longer is: `Profiler` takes
`begin_sample` / `feed(chunk)` / `finish_sample`, and the trimmer pushes chunks straight through.
Measured on 542 MB of FASTQ: peak wasm memory went from **+572 MB to +45 MB**, same TSV byte for
byte.

What limits a run now is the sketch state itself, which grows with the *diversity* of the sample
rather than its size. Measured ceilings on reads that are all distinct (the worst case there is):

| build | ceiling measured | shipped as safe | why |
|---|---|---|---|
| wasm32 (`web/sylph-pkg/`) | 48.75 M reads | 24 M | 4 GB address space |
| wasm64 (`web/sylph-pkg64/`) | 195.5 M reads | 96 M | V8 caps memory64 at 16 GB |

The site probes for memory64 and loads the 32-bit package unless the requested read count needs
more. 32-bit stays the default because it is faster — but the cost is **not** in sketching
(1.017×, i.e. 1.7%); it sits in the inference pass, so it is close to a fixed per-sample cost
rather than a per-read one. End-to-end that came out at 1.58–1.71× on a 198 k-read sample.

Safari supports memory64 in no version, Technology Preview included, so on Safari the 24 M line
is the real one and the UI says so rather than failing unexplained.

## Layout

| Path | What it holds |
|---|---|
| `web/` | Static site: multi-sample profiler with INRAE-themed UI. |
| `web/db/biomes.json` | The catalogue of catalogues — one entry per biome, read at load time. |
| `web/demo/` | The worked example the page loads with one click: a saved session of eighteen public PRJNA728374 runs — six people, three stool samples each over eight weeks — built by `scripts/build_demo_session.py`. |
| `web/biomes.js` | Builds the picker, freezes which database a result came from. |
| `web/db-cache.js` | One resumable, cached download per database (OPFS). |
| `web/ena.js` | Resolves an ENA accession and streams its FASTQs, and asks the portal for what the run says about itself in the same request. |
| `web/meta.js` | Decides which of that is printable: INSDC sentinels, archive-generated titles and 0.0/0.0 coordinates never reach the screen. |
| `web/figures.js` | Every figure, as pure functions — a table in, an SVG string out. No DOM, no fetch, no library. |
| `web/func-sketch.js` | The second reading of the same reads: amino-acid k-mers against KEGG orthologs, fed from every one of the worker's four feed paths — one parser per byte stream, one sketch per sample. |
| `web/kegg.js` | Orthologs into modules and pathways, the KEGG links and the colour ramp, and the licence question both pages ask. Pure functions, same contract as `figures.js`. |
| `web/gmm.js` | Gut Metabolic Modules, parsed from the reader's own copy of VIB's definitions. Ships none. |
| `web/table-view.js` | Searching and sorting a matrix of hundreds of rows: what a search matches, how ties break, and the third click that restores the original order. Pure functions. |
| `web/groups.js` | Where a sample grouping comes from — a metadata field, the editor, or a CSV — and which fields are worth offering. Pure functions. |
| `web/stats.js` | The contrast's test: exact Mann-Whitney by permutation, Benjamini-Hochberg, and the smallest p attainable at a given pair of group sizes. Pure functions. |
| `web/db/kegg/` | 13,509 KEGG ortholog sketches (20 MB, Zenodo 10045253, CC BY 4.0) and the KO→module→pathway map. |
| `web/funprofiler-pkg/` | sourmash compiled to wasm32, for the protein sketch. The build script also writes a wasm64 package to `web/funprofiler-pkg64/`, used only to measure it against this one: the page does not load it and it is not committed. |
| `web/sylph-pkg/` | wasm32 package (committed so the deployed site is self-contained). |
| `web/sylph-pkg64/` | wasm64 package, same filenames — loaded when a run needs more than 4 GB. |
| `scripts/build_wasm.sh` | Builds either package: `./scripts/build_wasm.sh 32\|64\|both`. |
| `scripts/build_biome_dbs.sh` | Builds one `.syldb` per MGnify catalogue (see *Reference databases*). |
| `scripts/build_gut_db.sh` | The original human-gut-only pipeline, kept as it was. |
| `scripts/dbcache-test/`, `scripts/ena-test/` | Browser and Node test benches, plus `flaky_server.py`. 1,636 parity assertions, 173 against a hostile HTTP server, 172 source-level claims, a real-browser run of both pages, and 48 mutations that check the benches still bite. |
| `scripts/funcprofile_ena_runs.mjs` | The functional half of the example, measured offline with the same code the page runs. |
| `scripts/session_to_matrix.mjs` | The example's matrix back out of the session, in the export format, so the demo can be rebuilt from what is tracked. |
| `scripts/profile_ena_runs.mjs` | Builds the example's measurements with the code the page runs, at the cap the page defaults to. |
| `sylph-wasm/` | Fork of upstream sylph with a wasm32 target and JS bindings. |
| `sylph-survey/` | Notes and porting plan for the sylph → WASM fork. |
| `docs/` | Design notes, size estimates, deployment notes. |
| `.github/workflows/pages.yml` | Runs the benches on every push and pull request, and deploys `web/` to Pages only if they pass. |

## Building the wasm packages

```sh
./scripts/build_wasm.sh both
```

The 32-bit build is plain stable Rust through `wasm-pack`. The 64-bit one needs more, because
`wasm64-unknown-unknown` is a Tier 3 target with no prebuilt `std`:

- `rustup toolchain install nightly` and `rustup component add rust-src --toolchain nightly`
- the `wasm-bindgen` **CLI at exactly the version the crate resolves to** (`cargo install
  wasm-bindgen-cli --version <that one>`) — the script checks this and refuses otherwise
- optionally `WASM_OPT=/path/to/wasm-opt`, **binaryen ≥ 129**. The wasm-opt bundled with
  wasm-pack 0.13.1 is binaryen 117 and dies with `Tables may not be 64-bit`; the script checks
  the version and skips the size pass rather than destroying the artifact.

`wasm-pack` cannot produce the 64-bit package at all: it hard-codes `--target
wasm32-unknown-unknown` and never passes `-Z build-std`.

Two traps that cost real time, recorded here so they are not rediscovered:

- Keying dependencies on `cfg(target_arch = "wasm32")` **silently** drops them on wasm64, where
  `target_arch` is `"wasm64"`. The cdylib then links cleanly while exporting nothing at all. Use
  `cfg(target_family = "wasm")`.
- `console_error_panic_hook` 0.1.7 has the same arch test inside it, so on wasm64 it falls back
  to `io::stderr()` — a black hole in a browser, and Rust panics become invisible. This crate
  installs its own hook instead.

## Reference databases

There are **nineteen**, one per MGnify genome catalogue, built by `scripts/build_biome_dbs.sh`
and listed with their species counts and sizes in `data/biome-dbs/manifest.tsv`:

| | species | `.syldb` | | species | `.syldb` |
|---|---|---|---|---|---|
| soil | 19 472 | 2.8 GB | chicken-gut | 1 322 | 115 MB |
| marine | 13 223 | 1.2 GB | pig-gut | 1 376 | 108 MB |
| marine-sediment | 6 158 | 674 MB | tomato-rhizosphere | 579 | 91 MB |
| **human-gut** (UHGG) | 4 744 | 454 MB | human-skin | 579 | 59 MB |
| mouse-gut | 2 847 | 274 MB | maize-rhizosphere | 336 | 53 MB |
| cow-rumen | 2 729 | 237 MB | human-oral | 452 | 32 MB |
| sheep-rumen | 2 172 | 180 MB | human-vaginal | 280 | 18 MB |

plus honeybee-gut, non-model-fish-gut, barley-rhizosphere, zebrafish-fecal and
marine-eukaryotes, all under 18 MB. A `.syldb` tracks the *size* of the genomes, not their
number: `soil` costs 145 KB per genome against 91 KB for the gut, and sixteen marine eukaryotes
weigh 13 MB.

**They are not interchangeable, and they must not be merged.** MGnify dereplicates each catalogue
independently and they overlap — 10 % of the named species are shared between `human-oral` and
`human-skin`. Loading two at once would list the same species twice, splitting its k-mers
arbitrarily: sylph's pseudotax reassignment settles close genomes *within* one database, it does
not arbitrate between two separately dereplicated catalogues. Hence one biome at a time, and the
biome carried into every exported file.

### Hosting

The 6.5 MB smoke-test database (`web/db/gut_mini.syldb`) is bundled with the site. The other nineteen are 6.24 GiB in total, far past what GitHub Pages will serve, and are fetched from **Zenodo** at runtime — all nineteen in a single record:

- **Concept DOI** (all versions — cite this one): [10.5281/zenodo.21842022](https://doi.org/10.5281/zenodo.21842022)
- **This version:** [10.5281/zenodo.21842023](https://doi.org/10.5281/zenodo.21842023) — <https://zenodo.org/records/21842023>, 19 files, 6.24 GiB, **CC0**, published 2026-08-07
- File URL (CORS-enabled, used by the web app): `https://zenodo.org/api/records/21842023/files/<key>.syldb/content`, where `<key>` is the biome key in `web/db/biomes.json` — e.g. `.../files/human-gut.syldb/content`

The databases are released under CC0 because a `.syldb` is a FracMinHash of genomes that are not ours: a mechanical transform with no creative step to own. Cite MGnify, the catalogue paper for the biome you used, and sylph — see [Citations](#citations).

> Note: the user-facing record URL `https://zenodo.org/records/21842023/files/human-gut.syldb` does **not** return CORS headers, so it can't be `fetch()`-ed by the browser app. Use the `/api/records/.../content` form instead. GitHub Release assets have the same CORS limitation — that's why we host on Zenodo rather than from a GitHub Release.
>
> Nor is `Content-Range` exposed: Zenodo's `Access-Control-Expose-Headers` lists only `Content-Type, ETag, Link` and the rate-limit headers. A resumable download must therefore take the total size from a full request's `Content-Length`, never from the `Content-Range` of a ranged one — the browser cannot read that header, and code that tries records the database as 1 byte.

To publish a new version, upload a fresh `<key>.syldb` — the human-gut one is `human-gut.syldb`, not `gut.syldb`, which is only the local build-artifact name — as a **new version of record 21842023** rather than a new record, and paste the URL into the matching entry of **`web/db/biomes.json`** (see below). A visitor who already has the old one cached picks the new one up automatically: the cache is validated against the server's size and `Last-Modified` on every load, and a mismatch re-downloads instead of serving the stale copy.

### One database per biome (`web/db/biomes.json`)

There is one reference database per **MGnify genome catalogue** — human-gut (UHGG), human-oral, soil, marine, cow-rumen, and so on. `web/db/biomes.json` is the catalogue of catalogues: for each one, a key, a readable label, the MGnify catalogue name and version, the species count as `sylph inspect` reported it, the size in bytes, and the URL. The picker on both pages is built from that file, grouped by family (human / animal / plant & soil / marine); nothing about the list is hard-coded in the HTML except a two-entry fallback for the case where the file cannot be read.

- **All nineteen are published** (Zenodo 21842023, CC0) and selectable. `scripts/zenodo_upload.py` does the deposit; it verifies every file's md5 against the local copy and stops at the draft, because publishing mints a permanent DOI.
- **`bytes` must match the file on Zenodo exactly.** `biomes.js` compares the downloaded database against it and refuses a mismatch, so a wrong number here does not mis-report a size — it makes the database unloadable.
- **An entry with an empty `url` is still listed**, greyed out, with the reason — an entry that silently disappears is indistinguishable from a broken catalogue.
- **They are never merged, and only one is loaded at a time.** MGnify publishes no unified catalogue: each one is dereplicated independently and they overlap (10% of the named species are shared between human-oral and human-skin), so two loaded together would count the same species twice with its k-mers split arbitrarily. sylph's pseudotax reassignment separates close genomes *within* one database; it cannot arbitrate between two dereplicated apart.
- **Which biome produced a result is carried with the result**, because profiling against the wrong one fails silently — sylph reports the closest genomes the loaded database holds, so a saliva sample profiled against soil comes back as a full, plausible, wrong table. The biome is named on the database status line, above the matrix, in the exported TSV/CSV header (`#` comment lines) and in the exported file name; loading a different database resets samples already profiled rather than mixing two references in one matrix; and the genome count sylph reports is checked against the count the catalogue claims, which catches a mislabelled deposit.
- Each entry may declare a `lineage` map (genome file → species name). Only the human-gut catalogue has one today; the others show genome accessions instead of names, which is why the map is per entry and not fetched for every biome.

The download cache is keyed by URL, so several biomes coexist in it: the listing names each cached entry by its biome, and switching back to one already downloaded costs nothing.

### How it is downloaded (`web/db-cache.js`)

454,021,440 bytes at a measured 1.48 MB/s is about **five minutes**, so the download is built to survive that:

- **once per database, not once per worker.** The pool used to call `loadDbUrl` on every worker and each one ran its own `fetch()`; with the 4-thread setting that was 1.7 GB of simultaneous downloads fighting for the link. Now `db-cache-worker.js` downloads once and every sylph worker reads the same OPFS file — the bytes never cross `postMessage`.
- **in 8 MiB slices, with `Range`.** The size comes from the `Content-Length` of a HEAD, and `Range` support is *assumed* rather than probed: the first real slice settles it, and a `200` where a `206` was expected restarts the download from zero without ranges. That is deliberate — probing cost a request and, worse, a single transient `503` on that one request was read as "this host does not do ranges" and silently turned a resumable 454 MB download into an all-or-nothing one. `Accept-Ranges` is not consulted either: Zenodo answers ranges perfectly well and never sends it. A failed slice is retried with growing backoff; an interrupted one costs part of a slice, not the file.
- **written straight into OPFS as it arrives**, never accumulated in JS, and the resume pointer is persisted every 4 MiB — so closing the tab mid-download and coming back resumes rather than restarts.
- **validated before use.** Size must match exactly and `Last-Modified` (or `ETag`) must agree, or the entry is discarded and re-fetched. When the host offers neither validator, the length is all there is to compare: that is shown as "checked on its length only", and such an entry is never *resumed* onto, because a tail from another version would splice invisibly onto the prefix. A truncated `.syldb` would otherwise decode into fewer genomes and produce quietly wrong abundances. A returning visitor pays exactly one `HEAD` for this; if the server is unreachable the entry is still used, and the UI says it was not revalidated.
- **careful about CORS.** The size comes from `Content-Length` on a `HEAD`, not from `Content-Range` on a `206`: `Content-Range` is not a CORS-safelisted response header and Zenodo does not expose it, so reading the total from there yields `null` in the browser and a database recorded as 1 byte long — while passing every same-origin test.
- **one writer at a time, across tabs.** The write path runs under a Web Lock keyed on the database, and the state is re-read once the lock is held: the second tab queues instead of failing after 16 s, and instead of acting on a decision it took before the wait — which is how it used to truncate the entry the first tab had just finished.
- **suspicious of the server, slice by slice.** Nothing is written past the declared size; a short local write is a failure, not a success; a `206` answering a different interval is refused wherever `Content-Range` is readable (same-origin); a `Last-Modified` that changes mid-download throws the partial copy away rather than splicing two releases together; and same-origin requests carry `If-Range`, which a conforming server answers with a clean `200` instead of a slice from a newer file. Cross-origin, `If-Range` is deliberately *not* sent: unlike `Range` it is not CORS-safelisted, so it would preflight every slice and Zenodo would refuse.
- **cancellable, with rate and ETA** on the database status line, and a listing of what is cached with a Delete button.

Zenodo sends no `Cache-Control` and no `ETag`, so none of this can lean on the browser's HTTP cache.

Test it against a deliberately hostile server (cuts connections mid-slice, fails every other request) without touching Zenodo:

```bash
node scripts/dbcache-test/run.mjs      # headless Chrome + scripts/flaky_server.py
```

## Licensing

**GPL-3.0-or-later** (see `LICENSE` and `COPYRIGHT`, © 2026 Guillaume Gautreau, MaIAGE — INRAE).
Use it, study it, change it, share it — and share your changes under the same terms.

It is not all original work, however, and the licence of the code it builds on travels with that
code. MIT-licensed code may be combined into a GPL work — that direction is allowed, and it is
what happens here — but the GPL does **not** relicense it: those files stay available from their
authors under MIT.

| Path | Origin | Licence |
|---|---|---|
| `sylph-wasm/` | fork of [sylph](https://github.com/bluenote-1577/sylph) 0.9.0, with a wasm target added | MIT, © 2023 Jim Shaw — `sylph-wasm/LICENSE` |
| `web/vendor/fflate.js` | vendored [fflate](https://github.com/101arrowz/fflate) | MIT, © 2026 Arjun Barrett — `web/vendor/LICENSE.fflate` |
| `web/funprofiler-pkg/` | [sourmash](https://github.com/sourmash-bio/sourmash) compiled to WebAssembly, for the protein sketch (built by `scripts/build_funprofiler_wasm.sh` from a pinned commit, with one added `FuncProfiler` type) | BSD-3-Clause, © 2016 The Regents of the University of California — `web/funprofiler-pkg/LICENSE.sourmash` |
| everything else | this project | **GPL-3.0-or-later**, © 2026 Guillaume Gautreau — `LICENSE` |

`sylph-wasm/` is a **modified** copy of upstream sylph: a `wasm` feature, a wasm-bindgen surface
(`src/wasm.rs`), a streaming sketcher (`StreamSketcher` in `src/sketch.rs`), and byte-slice
variants of the sketching entry points. The algorithms and the `.syldb` format are unchanged — a
database built by upstream `sylph sketch` is read here as-is, and the TSV matches. Bugs you find
in this port are this repository's, not upstream's; report them here rather than to the sylph
authors.

The reference databases are **data, not code**: this licence does not cover them. The nineteen
`.syldb` files are deposited separately under **CC0**
([10.5281/zenodo.21842022](https://doi.org/10.5281/zenodo.21842022)) — a FracMinHash of genomes
that are not ours is a mechanical transform, and asserting a licence over it would claim rights we
do not hold. They are derived from the
[MGnify genome catalogues](https://www.ebi.ac.uk/metagenomics/browse/genomes) and, for the human
gut, the [UHGG catalog](https://www.nature.com/articles/s41587-020-0603-3); EMBL-EBI places no
restriction on redistribution and asks for attribution as good scientific practice, which is what
the citations below are for. `web/db/lineage.json` is derived from the same catalogues.

**The functional half brings three more licences, and none of them is ours.**

- `web/db/kegg/ko-sketches-k11.ndjson.gz` — 13,509 KEGG ortholog sketches, redistributed
  **unmodified** (the k = 11 subset, empty sketches left out) from [fmh-funprofiler](https://doi.org/10.1093/bioinformatics/btae397)'s deposit
  ([Zenodo 10045253](https://doi.org/10.5281/zenodo.10045253)) under **CC BY 4.0**, © KoslickiLab.
  See `web/db/kegg/README.md` for the provenance, and for why it holds 13,509 of the archive's
  14,606 signatures.
- **KEGG itself is not a public database.** Every identifier, name and roll-up shown in the Function
  tab is KEGG's: academic use is free, any non-academic use requires a commercial licence from
  Pathway Solutions ([KEGG's terms](https://www.kegg.jp/kegg/legal.html)). The tab asks which the
  reader is before showing a single KEGG identifier, and the answer stays in the browser.
- **Gut Metabolic Modules are not shipped at all.** They are distributed by VIB under an Academic
  Non-commercial Software Licence whose clause 9 forbids passing them outside the licensee's
  institution, so this repository contains none of them and never will. The page asks the licence
  question first and then fetches them **from the Raes lab's own repository** — the bytes go from
  their GitHub to your browser, nothing of theirs is redistributed here, and nothing is written to
  disk. If that fetch cannot happen (offline, a proxy, the file renamed upstream) the old path is
  still there: download the file and open it with the picker. `web/gmm.test.mjs` tests the parser on
  hand-built definitions and skips the checks that need the real catalogue unless `GMM_DEFS` points
  at your own copy.

## Citations

If you use the results, please cite:

- **sylph** — Shaw, J. & Yu, Y. W. *Rapid species-level metagenome profiling and containment estimation with sylph.* Nature Biotechnology (2024). <https://www.nature.com/articles/s41587-024-02412-y> — upstream repo: <https://github.com/bluenote-1577/sylph>
- **MGnify** — Richardson, L. *et al.* *MGnify: the microbiome sequence data analysis resource in 2023.* Nucleic Acids Research 51, D753–D759 (2023). <https://doi.org/10.1093/nar/gkac1080>
- **the catalogue paper for the biome you profiled against** — each MGnify catalogue has its own; for the human gut that is the **UHGG catalog** — Almeida, A. *et al.* *A unified catalog of 204,938 reference genomes from the human gut microbiome.* Nature Biotechnology 39, 105–114 (2021). <https://www.nature.com/articles/s41587-020-0603-3>
- **the databases themselves**, if you want the exact sketches to be reproducible — *sylph databases for the MGnify genome catalogues (19 biomes)*, Zenodo, CC0. <https://doi.org/10.5281/zenodo.21842022>

This repository is an unofficial adaptation; the authors of sylph, of MGnify and of the catalogues are not responsible for it.
