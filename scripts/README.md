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

## `build_screening_db.sh` — the multi-biome screening database

```bash
./scripts/build_screening_db.sh                 # ~4 min, no downloads
C=4000 ./scripts/build_screening_db.sh          # half the size, same verdict
```

With one reference database there was no way to pick the wrong one. With
nineteen there is, and it is the main way to get a wrong answer: sylph reports
whatever looks closest and never says *this sample is not from here*. The
screening database exists to answer "which catalogue should I use?" before the
real run. It is **not** for profiling — it mixes biomes on purpose.

It is built entirely from the `.syldb` files `build_biome_dbs.sh` already
produced. Nothing is downloaded and no genome is re-sketched, because a
`.syldb` stores FracMinHash *hashes*, kept when `hash < u64::MAX / c`
(`seeding.rs`). Discarding the hashes at or above `u64::MAX / 2000` therefore
yields exactly the sketch that `-c 2000` would have produced — the argument,
and its caveat about `min_spacing`, is written out in full at the top of
`sylph-wasm/src/bin/syldb-reduce.rs`.

**The `min_spacing` caveat is not small, and the header used to say it was.**
Reduction filters both hash vectors, so their *union* is exactly a fresh sketch
at the new `c`; but only `genome_kmers` feeds the containment count, and that
vector comes out ~11% smaller than in a fresh build (measured against native
sketches of two control genomes: 2228 vs 2509 and 1555 vs 1755; on the shipped
database 13.3% of the union sits in the pseudotax list, against 1.6–1.8% in a
fresh `-c 2000` sketch). For containment, `screening-c2000-derep.syldb` behaves
like a fresh sketch at c ≈ 2250: slightly less sensitive at low coverage,
slightly more genomes under the 50-k-mer floor. It is not a correctness bug —
the ERR14098649 cross-validation was run on a reduced database and already
includes it — but budget for it when choosing between c=2000 and c=4000.

Three pieces:

- **`syldb-reduce`** (`sylph-wasm/src/bin/`, `cargo build --release --bin
  syldb-reduce`) — re-sub-samples one or more `.syldb` to a coarser `c`, merges
  them, and can drop sketches not on a keep-list. It filters
  `pseudotax_tracked_nonused_kmers` with the same threshold (the browser's
  `profile()` refuses a database without that field). What it refuses to do:
  - `--check` (and the audit run on every input and on the output) recomputes
    `u64::MAX/c` **independently of the tool's own `threshold()`** and walks
    *both* hash vectors, then **exits 1**. The previous version compared each
    hash to the very function it was validating and only printed
    `violations=0`, always exiting 0 — with `threshold()` doubled it happily
    wrote a file labelled c=2000 holding a c=1000 sketch and passed its own
    check. It also fails on a mixed `k`, `min_spacing` or `c`, on a missing
    pseudotax vector, and on duplicate genome names.
  - the reduction ratio is checked against `c_source/c_target`: keeping 20 000
    hashes where 2 000 were due is fatal, which is how a wrong threshold shows
    up before any hash is looked at (the sabotaged build announced 5.01x where
    10.10x was due).
  - merging refuses inputs that disagree on `k` or `min_spacing`, not just on
    `c` — a `.syldb` mixing k=21 and k=31 loads fine in the browser and only
    traps later, inside `get_stats()`.
  - `--min-kmers N` (default 50) now **drops** sketches left below the floor
    instead of counting them: under `profile`'s `--min-number-kmers`,
    `get_stats()` returns `None`, so such a genome can never be reported and
    would only take up space. `--keep-below-min` restores the old counting
    behaviour; `--min-kmers 0` disables the floor.
  `--list` prints per-file stats, in a line whose field names
  (`n=`, `c=`, `k=`, `min_genome_kmers=`, `below_floor=`) are the contract
  `write_screening_manifest.sh` parses.
- **`derep_screening.py`** — dereplicates the catalogues *against each other* by
  GTDB species name, keeping one genome per species labelled with the set of
  catalogues that contain it. This is not an optimisation. MGnify dereplicates
  each catalogue independently, so 2114 species exist in two or more of them as
  two or more assemblies; merged into one database those copies compete, and
  pseudotax reassignment hands every k-mer to whichever copy scored higher.
  Measured, before this step: a human gut sample had *Coprococcus eutactus_A*
  and *Bacteroides uniformis* reported under mouse-gut and *Agathobacter
  rectalis* under marine-sediment, with the human-gut copies gone from the
  output entirely.
  **What it cannot do, and this is unfixed:** 23 312 of the 56 782 merged
  genomes (41.1%) carry no GTDB species name at all — novel species,
  overwhelmingly soil (10 348), marine (5 796) and marine-sediment (2 050).
  Dereplication by name cannot reach them, so two unnamed genomes from two
  catalogues may be the same organism and are both kept and both counted. The
  genome counts in `manifest.tsv` are therefore *not* species counts, those
  three biomes are over-represented by an unknown amount, and a screening score
  for them should be read as a floor. A real fix needs sketch-level ANI
  clustering across catalogues, not names; nothing here does that.
- **`screen_biome.py`** — turns a profile run against the screening database
  into a per-catalogue verdict. Each detected species is credited to *every*
  catalogue containing it, so the columns do not sum to 100%; they read as "how
  much of this sample could catalogue X have explained". `excl%` is the part
  coming from species found in that catalogue alone, and it is what the verdict
  ranks on — a biome with a large `taxo%` but `excl%` near zero is only riding
  on cosmopolitan species.

```bash
sylph profile data/screening/screening-c2000-derep.syldb sample.sylsp -o screen.tsv
python3 scripts/screen_biome.py screen.tsv
```

`data/screening/manifest.tsv` is **generated**, never typed:
`write_screening_manifest.sh` reads every column back off the files (bytes and
sha256 with coreutils, `c`/`k`/genomes/`min_genome_kmers`/`below_floor` from
`syldb-reduce --list`), and `check_screening_manifest.sh` regenerates it and
diffs. The hand-written version claimed "2 genomes under the 50-kmer floor" for
c=4000 and "121" for c=8000; the files held 4 and 140 — and c=4000 was the
variant it recommended.

```bash
scripts/check_screening_manifest.sh          # exit 1 + diff if it drifted
scripts/check_screening_manifest.sh --fix    # rewrite it from the files
MANIFEST_ONLY=1 scripts/build_screening_db.sh
```

## `compare_profiles.py`

Compares two `sylph profile` TSVs that differ only in the database's `c` — the
test that a re-sub-sampled database is still the same database. Reports the
shared/lost/gained genomes, the top-25 side by side with both ranks, Kendall
tau on that top-25, Spearman and log-abundance Pearson over the shared set, and
every genome the reduction dropped together with the abundance it had.

```bash
python3 scripts/compare_profiles.py full.tsv reduced.tsv --lineage web/db/lineage.json
```

## `annotate_screening_map.py`

Joins the genome→biome table `syldb-reduce --biome-tsv` emits with the GTDB
lineages in `data/biome-work/*/metadata.tsv` (and, with `--uhgg-metadata`, the
UHGG `genomes-all_metadata.tsv`, which fills the 1187 human-gut species that
`web/db/lineage.json` leaves empty). 41% of the 56 782 genomes have no species
name at all — those are GTDB placeholders (empty `s__`), overwhelmingly soil and
marine, not lookup failures.

## `build_demo_session.py` — the worked example the page ships

Rebuilds `web/demo/gut-demo.session.json` and `web/demo/gut-demo.groups.csv`
from an abundance matrix the app exported. The demo is what the "Explore example
results" button loads: fifteen public runs of **PRJEB83730** (human gut
metagenomes, Ion Torrent), one run per ENA sample, profiled by PeekMicrobiome
itself against the published Human gut (UHGG) catalogue and saved in the same
JSON the *Save session* button writes.

```bash
python3 scripts/build_demo_session.py abundance_matrix_human-gut.tsv
```

It refuses to write anything it cannot vouch for: a matrix profiled against
another catalogue, a `k`/`c` that is not 31/200, a genome count that disagrees
with `web/db/biomes.json`, a column that does not sum to 100 %, or a genome the
bundled lineage map cannot place — that last one because loading the example
borrows `web/db/lineage/human-gut.json` (399 kB, independent of the 433 MB
database) so the genus/family/phylum picker works, and an unplaceable genome
would be bucketed as "unclassified" without saying so.

The eight subjects each contribute a standard library and, for seven of them, a
second one sequenced about six times deeper; the groups file colours by subject,
so whether the two libraries of a subject land together in the ordination is a
question the demo answers on screen rather than a claim it makes.

`web/fastq-trim.parity.test.mjs` re-checks all of it against the catalogue on
every run — the file cannot drift into disagreeing with its own banner.
