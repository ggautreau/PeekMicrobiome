# PeekMicrobiome

Upload-free, installation-free metagenomic profiling across biomes. A WebAssembly build of [sylph](https://github.com/bluenote-1577/sylph) that runs entirely in the browser: your FASTQ files are never uploaded, nothing is installed, and reads are sketched as they stream — the FASTQ is never held whole. Nineteen MGnify reference catalogues, one biome at a time.

**Live site:** <https://ggautreau.github.io/PeekMicrobiome/>

> [!IMPORTANT]
> **Unofficial port.** This is an adapted WebAssembly port of sylph for quick, in-browser checks of gut metagenomic composition. It is **not supported or endorsed by the sylph authors** and does not achieve the reliability of [sylph](https://github.com/bluenote-1577/sylph), [MetaPhlAn4](https://github.com/biobakery/MetaPhlAn), or [Meteor2](https://github.com/metagenopolis/meteor) run natively — use those for real analyses. If you use the results, please cite the upstream papers below.

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
| **Load database** (any published biome) | the catalogue you picked coming *down* from `zenodo.org`, once, then cached on your computer — 433 MB for the human-gut default, 18 MB to 2.8 GB for the others | Zenodo sees your IP address and which of these files you asked for |
| **Load database** (bundled 6 MB / local `.syldb`) | nothing beyond the site itself | nothing |
| **Paste an ENA accession** | the accession, then the public FASTQ files coming *down* from the EBI | the EBI sees your IP address and which accessions you asked for |

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
| `web/` | Static site: multi-sample sylph profiler with INRAE-themed UI. |
| `web/sylph-pkg/` | wasm32 package (committed so the deployed site is self-contained). |
| `web/sylph-pkg64/` | wasm64 package, same filenames — loaded when a run needs more than 4 GB. |
| `scripts/build_wasm.sh` | Builds either package: `./scripts/build_wasm.sh 32\|64\|both`. |
| `scripts/` | Native pipeline to build the gut `.syldb` from UHGG. |
| `sylph-wasm/` | Fork of upstream sylph with a wasm32 target and JS bindings. |
| `sylph-survey/` | Notes and porting plan for the sylph → WASM fork. |
| `docs/` | Design notes, size estimates, deployment notes. |
| `.github/workflows/pages.yml` | GitHub Pages deploy on push to `main`. |

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

## Database hosting

The 6 MB smoke-test database (`web/db/gut_mini.syldb`) is bundled with the site. The full 433 MB UHGG `gut.syldb` is too large for GitHub Pages and is fetched from **Zenodo** at runtime:

- DOI: [10.5281/zenodo.20180025](https://doi.org/10.5281/zenodo.20180025)
- File URL (CORS-enabled, used by the web app): `https://zenodo.org/api/records/20180025/files/gut.syldb/content`

> Note: the user-facing record URL `https://zenodo.org/records/20180025/files/gut.syldb` does **not** return CORS headers, so it can't be `fetch()`-ed by the browser app. Use the `/api/records/.../content` form instead. GitHub Release assets have the same CORS limitation — that's why we host on Zenodo rather than from a GitHub Release.

To publish a new version, upload a fresh `gut.syldb` to Zenodo and paste the URL into the matching entry of **`web/db/biomes.json`** (see below). A visitor who already has the old one cached picks the new one up automatically: the cache is validated against the server's size and `Last-Modified` on every load, and a mismatch re-downloads instead of serving the stale copy.

### One database per biome (`web/db/biomes.json`)

There is one reference database per **MGnify genome catalogue** — human-gut (UHGG), human-oral, soil, marine, cow-rumen, and so on. `web/db/biomes.json` is the catalogue of catalogues: for each one, a key, a readable label, the MGnify catalogue name and version, the species count as `sylph inspect` reported it, the size in bytes, and the URL. The picker on both pages is built from that file, grouped by family (human / animal / plant & soil / marine); nothing about the list is hard-coded in the HTML except a two-entry fallback for the case where the file cannot be read.

- **To publish a database:** upload `<key>.syldb` to Zenodo, then set `url` on that entry to the CORS-enabled form `https://zenodo.org/api/records/<record>/files/<file>/content` (and `doi`, optionally). That is the only field meant to be edited by hand.
- **An entry with an empty `url` is still listed**, greyed out, with the reason — a database that exists but is not published yet is information, and an entry that silently disappears is indistinguishable from a broken catalogue.
- **They are never merged, and only one is loaded at a time.** MGnify publishes no unified catalogue: each one is dereplicated independently and they overlap (10% of the named species are shared between human-oral and human-skin), so two loaded together would count the same species twice with its k-mers split arbitrarily. sylph's pseudotax reassignment separates close genomes *within* one database; it cannot arbitrate between two dereplicated apart.
- **Which biome produced a result is carried with the result**, because profiling against the wrong one fails silently — sylph reports the closest genomes the loaded database holds, so a saliva sample profiled against soil comes back as a full, plausible, wrong table. The biome is named on the database status line, above the matrix, in the exported TSV/CSV header (`#` comment lines) and in the exported file name; loading a different database resets samples already profiled rather than mixing two references in one matrix; and the genome count sylph reports is checked against the count the catalogue claims, which catches a mislabelled deposit.
- Each entry may declare a `lineage` map (genome file → species name). Only the human-gut catalogue has one today; the others show genome accessions instead of names, which is why the map is per entry and not fetched for every biome.

The download cache is keyed by URL, so several biomes coexist in it: the listing names each cached entry by its biome, and switching back to one already downloaded costs nothing.

### How it is downloaded (`web/db-cache.js`)

454,021,440 bytes at a measured 1.48 MB/s is about **five minutes**, so the download is built to survive that:

- **once per database, not once per worker.** The pool used to call `loadDbUrl` on every worker and each one ran its own `fetch()`; with the 4-thread setting that was 1.7 GB of simultaneous downloads fighting for the link. Now `db-cache-worker.js` downloads once and every sylph worker reads the same OPFS file — the bytes never cross `postMessage`.
- **in 8 MiB slices, with `Range`.** The size comes from the `Content-Length` of a HEAD, and `Range` support is *assumed* rather than probed: the first real slice settles it, and a `200` where a `206` was expected restarts the download from zero without ranges. That is deliberate — probing cost a request and, worse, a single transient `503` on that one request was read as "this host does not do ranges" and silently turned a resumable 433 MB download into an all-or-nothing one. `Accept-Ranges` is not consulted either: Zenodo answers ranges perfectly well and never sends it. A failed slice is retried with growing backoff; an interrupted one costs part of a slice, not the file.
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

This repository is MIT (see `LICENSE`, © 2026 Guillaume Gautreau), but it is not all original
work, and the MIT terms of the code it builds on have to travel with it — the licence requires the
copyright notice to be kept in "all copies or substantial portions of the Software".

| Path | Origin | Licence |
|---|---|---|
| `sylph-wasm/` | fork of [sylph](https://github.com/bluenote-1577/sylph) 0.9.0, with a wasm target added | MIT, © 2023 Jim Shaw — `sylph-wasm/LICENSE` |
| `web/vendor/fflate.js` | vendored [fflate](https://github.com/101arrowz/fflate) | MIT, © 2026 Arjun Barrett — `web/vendor/LICENSE.fflate` |
| everything else | this project | MIT, © 2026 Guillaume Gautreau — `LICENSE` |

`sylph-wasm/` is a **modified** copy of upstream sylph: a `wasm` feature, a wasm-bindgen surface
(`src/wasm.rs`), a streaming sketcher (`StreamSketcher` in `src/sketch.rs`), and byte-slice
variants of the sketching entry points. The algorithms and the `.syldb` format are unchanged — a
database built by upstream `sylph sketch` is read here as-is, and the TSV matches. Bugs you find
in this port are this repository's, not upstream's; report them here rather than to the sylph
authors.

The reference databases are built from the [UHGG catalog](https://www.nature.com/articles/s41587-020-0603-3),
whose own terms and citation requirements apply to the `.syldb` files and to `web/db/lineage.json`.

## Citations

If you use the results, please cite:

- **sylph** — Shaw, J. & Yu, Y. W. *Rapid species-level metagenome profiling and containment estimation with sylph.* Nature Biotechnology (2024). <https://www.nature.com/articles/s41587-024-02412-y> — upstream repo: <https://github.com/bluenote-1577/sylph>
- **UHGG catalog** — Almeida, A. *et al.* *A unified catalog of 204,938 reference genomes from the human gut microbiome.* Nature Biotechnology 39, 105–114 (2021). <https://www.nature.com/articles/s41587-020-0603-3>

This repository is an unofficial adaptation; the authors of sylph and the UHGG catalog are not responsible for it.
