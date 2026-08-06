# scripts/

## `build_gut_db.sh`

Build the gut sylph database from UHGG v2.0.2 species representatives.

```bash
# prereqs (on PATH): curl, awk, gzip, xargs, sylph >=0.6
JOBS=16 bash scripts/build_gut_db.sh
```

Outputs land under `data/uhgg/`:
- `gut.syldb` — the sketched database (k=31, c=200), the artifact the WASM build will load
- `gut.taxonomy.tsv` — genome → GTDB lineage mapping (for `sylph-tax`)
- `genomes/` — downloaded `.fna` species reps (~5 GB raw; can be deleted after sketching)

Tunables (env vars):
- `UHGG_VERSION` — default `v2.0.2`
- `K`, `C` — default `31`, `200` (sylph defaults; keep aligned with WASM build)
- `JOBS` — download/sketch parallelism, default `8`
- `OUT_ROOT` — output dir, default `data/uhgg`

**Sylph isn't installed on this dev machine.** Run on a host with native sylph
(`cargo install sylph` or `conda install -c bioconda sylph`) and at least 50 GB
of scratch disk.

## `gen_test_fastq.py`

Generate a synthetic gzipped FASTQ for testing the web downsampler:

```bash
python3 scripts/gen_test_fastq.py 10000 /tmp/test10k.fastq.gz
```

## `flaky_server.py` + `dbcache-test/`

Tests `web/db-cache.js` — the resumable, single-flight, OPFS-cached download of
the reference database — **without touching Zenodo**. The real database is
433 MB / ~5 minutes per attempt, which is unusable as a test loop, so the 6 MB
bundled `gut_mini.syldb` stands in and the failures are manufactured locally.

```bash
node scripts/dbcache-test/run.mjs          # ~12 min, 19 headless Chrome launches
VERBOSE=1 node scripts/dbcache-test/run.mjs

node scripts/dbcache-test/node-suite.mjs   # ~2 min, no browser  (run.mjs runs it too)
node scripts/dbcache-test/wiring.mjs       # instant             (run.mjs runs it too)
```

`flaky_server.py` is a static server with real `Range` support that can break on
purpose:

- `--cut-every N` — every Nth request for `--target`, send part of the body and
  then RST the socket (what a dropped connection looks like to `fetch()`);
- `--fail-every N` — every Nth request, answer 503;
- `--delay S` — throttle, to simulate a slow link;
- `--empty-every N` — every Nth request, a valid 206 with an empty body: the
  shape of a connection dropped right after the headers, and a "success" that
  carries nothing;
- `--no-head`, `--no-ranges`, `--ranges-until N` — hosts that block HEAD, never
  honour `Range`, or stop honouring it partway (a proxy or captive portal cutting
  in mid-download);
- `--shift-range N` — every Nth range request answered with a *different*
  interval, declared honestly in `Content-Range`;
- `--no-last-modified` — no validator at all: only the length distinguishes two
  versions of the file;
- `--alt PATH --alt-after N` — the file is republished mid-download (same length,
  different bytes, different `Last-Modified`);
- `--honour-if-range` — the RFC 7233 answer to a stale `If-Range`: 200 and the
  whole current file instead of a slice of a newer one.

It sends no `Cache-Control` and no `ETag`, exactly like Zenodo, and logs every
request as JSON (path, Range header, bytes actually sent) — that log is how
"one download for a pool of 4 workers" is *measured* rather than asserted.

`dbcache-test/run.mjs` builds a scratch directory of symlinks to `web/`, drops
the test page (`_dbtest.html` / `_dbtest.js`) beside the real modules so the
imports are the shipped files, and drives headless Chrome through the scenarios.
Two launches on the same `--user-data-dir` and the same port is how "resume
after a page reload" is asked, since OPFS is keyed by profile *and* origin.

`dbcache-test/node-suite.mjs` covers what a browser cannot be asked for: a cache
entry that starts life corrupted, a local write that stores fewer bytes than it
was given, a storage estimate that says the disk is full. It drives the same
`web/db-cache.js` against the same `flaky_server.py` over real HTTP, and replaces
only OPFS — with an implementation that can be told to lie in exactly those ways.
Every scenario hashes what ended up on "disk" against the file the server holds:
the question is never "did it error" but "is what it kept the right file".

`dbcache-test/wiring.mjs` is source-level, deliberately: it checks that the pages
are wired to what the cache module offers (the real persistence state, free space
rather than total quota, a delete that failed, the queue-behind-another-tab
line), and that the README still describes the code that exists.

## `ena-test/`

Tests `web/ena.js` — the ENA accession resolver and the resumable HTTP read source
that feeds the streaming trimmer — **without touching the EBI**.

```bash
node scripts/ena-test/node-suite.mjs   # ~15 s, no browser
node scripts/ena-test/wiring.mjs       # instant, source-level: what the pages claim
node scripts/ena-test/tsv-parity.mjs   # ~10 s, both input paths must give the same TSV
node scripts/ena-test/mutations.mjs    # ~5 min, runs a bench once per mutation
node scripts/ena-test/page.mjs         # ~2 min, headless Chrome on the real index.html
node scripts/ena-test/live.mjs [ACC] [MAX_READS]   # the one test that uses the network
```

`node-suite.mjs` drives the shipped module: the resolver against injected fixtures
(the shapes ENA really returns — a PAIRED run with one file, three files for a pair,
`fastq_bytes` with a gap in it, an accession that does not exist and answers `[]` with
status 200), and the read source against `flaky_server.py` over real HTTP. Every
streaming scenario asks the same question — *are the bytes it delivered byte for byte
the file the server holds* — because a resume that drops or repeats a prefix produces a
sketch that is wrong with no symptom at all. It also runs the adapter through the real
`fastq-trim.js` and compares the trimmed FASTQ with the same file read locally.

`tsv-parity.mjs` is the only test that checks the CRITERION rather than a mechanism:
the same data profiled through the local-file path and through the ENA path must give
the same TSV. It profiles one real fixture twice — once from a `File`, once through
`urlSource()` against a server that cuts every second request — and compares the tables
byte for byte for a capped single-end read, a capped paired-end read (the drift budget
and the cross-stop, which nothing else covered) and a whole file. It also compares the
read counts and a hash of the bytes fed to the sketcher, so it cannot pass by comparing
two empty tables. The fixture is built once by `fixtures.mjs` from the first 8 MiB of
`ERR14098592` and lands in `scripts/ena-test/fx/` (git-ignored).

`wiring.mjs` is source-level, and says so: a banner sentence, a button that stays
greyed out, a field written and never displayed are behaviour neither the node bench
nor the browser suite reads. It holds the privacy notice (all three downloads named:
none, Zenodo, the EBI), the README's network table, and the parts of `multi.js` that
decide what the user is told.

`mutations.mjs` is the evidence that all of those are load-bearing: it removes each
guard in turn — the `Range` header on a resume, the no-splice rule, the request
ceiling, the `Last-Modified` comparison, the short-EOF check, the comparison of
`fastq_bytes` with what the server serves, the read-count check, the accession
validation, the host allow-list at both layers, the Zenodo paragraph in the banner —
reruns the bench that should notice, and asserts it does. A mutation that survives is
reported as a hole in the bench. Every file it edits is restored afterwards.

`page.mjs` drives the real `web/index.html` in headless Chrome through the whole
feature (look up → tick → add → load database → profile → matrix) while the download is
cut and resumed underneath it. The portal API call is redirected to a local fixture by a
`fetch` shim; the FASTQ host is redirected by Chrome's own `--host-resolver-rules`,
because those requests are made inside the worker — and mapping the host rather than
rewriting the URL keeps the allow-list in `ena.js` under test. The reads are a
subsample of the run already in `data/`, so the matrix that comes out is a real one.

`live.mjs` is the only script here that uses the network: one 102 MiB run
(`ERR14098592`, the smallest in PRJEB83730) resolved, streamed, gunzipped, sketched and
profiled to a TSV against the bundled 6 MB database, reporting the throughput it got.

## `test_downsample.mjs`

Node port of `web/app.js` downsample loop, for sanity-checking the cut logic
without a browser:

```bash
node scripts/test_downsample.mjs /tmp/test10k.fastq.gz /tmp/out.fastq 1000
```
