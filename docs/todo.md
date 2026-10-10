# To do

Things that are decided but not built, or measured but not written up. Each entry says what the
work is, what is already known, and what would make it wrong — so that picking one up does not
start with rediscovering why.

---

## 1. Functional profiles: function rather than taxon

**What.** A second view of the same result: instead of "which species", "which functions". The
abundance matrix the page already computes stays the input; what is added is a per-catalogue map
from genome to functional repertoire, and a matrix product.

**The design that works.** Weight each reference genome's functional repertoire by the abundance
sylph estimated for it, and sum over genomes. That is one dot product per sample, done in the
browser on data already in memory, and it needs **no change to sylph and no new `.syldb`**. It is
the same shape as `web/db/lineage/<biome>.json`, which already maps genome file → species name;
this maps genome file → functions.

**Feasibility, measured rather than assumed** (2026-08-13). MGnify publishes per-species KEGG module
completeness for each catalogue —
`ftp.ebi.ac.uk/pub/databases/metagenomics/mgnify_genomes/human-gut/v2.0.2/pangenome_functions/kegg_completeness.tar.gz`,
4.1 MB, one TSV per species representative, keyed by the same `MGYG…` identifiers the lineage map
uses. Folded into one JSON for the human-gut catalogue it gives:

| | |
|---|---|
| genomes covered | 4,744 — the whole catalogue |
| distinct KEGG modules | 396 |
| modules per genome | median 112, max 242 |
| size | 6.5 MB raw, **1.2 MB gzipped** |

For comparison the lineage map is 0.4 MB and the database itself is 433 MB. It ships. The heavier
`functional_profiles.tar.gz` (300 MB, per-protein annotations) would be a Zenodo asset rather than a
bundled file, and is only worth it if module-level turns out to be too coarse.

**What must be said in the interface, not buried.** This is *functional potential inferred from
reference genomes*, not measured gene content. It inherits every blind spot of the catalogue; it
ignores strain-level gene content variation, which is exactly what collapsing to a species
representative destroys; and it says nothing about expression. Tools that map reads to gene families
directly make a stronger claim and should be named as the thing to use when the answer matters —
the same posture the biome warning already takes. A functional bar chart with no such line reads as
a measurement.

**Is sylph suited to detecting functions? No — and sylph says so itself.** Measured against the
shipped gut database (`sylph inspect`, 4,744 genomes): the sketch keeps **4.31 k-mers per kb** at
`c=200`, giving a median of 9,280 sketch k-mers per genome (minimum 1,924, median genome 2.15 Mb).
Now sylph's own `profile` has a default `-M, --min-number-kmers 50`, which *"exclude[s] genomes with
less than this number of sampled k-mers"*. At 4.31 k-mers/kb that threshold sits at about **12 kb of
reference**:

| reference | sketch k-mers | vs sylph's own floor of 50 |
|---|---|---|
| a 1 kb gene | 4 | 11× below |
| a 3 kb gene | 13 | 4× below |
| a 10 kb operon | 43 | still below |
| a 50 kb genomic island | 215 | above |

So a `.syldb` built over genes would be discarded by sylph's default settings before anything was
reported. That is not a tuning accident: containment ANI and the zero-inflated Poisson coverage
correction are statistical procedures over the retained k-mer set, and on four k-mers they estimate
nothing. Lowering `c` to compensate reverses the one property this project depends on — reaching 50
k-mers for a 1 kb gene needs `c ≈ 17`, roughly a twelvefold larger database, and 433 MB becomes
multiple gigabytes before the pangenome is even bigger than the genome set.

**"One reference per KO, k-merising every gene that carries it" — the size objection lifts, and a
harder one replaces it.** Aggregating a KO's genes across 4,744 genomes gives megabases, comfortably
past the 50-k-mer floor, so that idea does clear the obstacle above. What it cannot clear is the
identity regime that 31-mers impose. Two homologous sequences at nucleotide identity *p* share about
*p*³¹ of their 31-mers:

| nucleotide identity | 31-mers in common |
|---|---|
| 99% | 73% |
| 95% | 20% |
| 90% | 3.8% |
| 85% | 0.65% |
| 80% | 0.10% |
| 75% | 0.01% |

sylph is built for the top of that table and says so: `-m, --minimum-ani` defaults to **95 for
profile**, and its own help adds *"Smaller than 95 for profile will give inaccurate results."*

Functional equivalence lives far below it. MGnify's own protein catalogue publishes `uhgp-50`
alongside `uhgp-90/95/100` — the 50% amino-acid identity level exists precisely because that is
where proteins are still the same function. The corresponding nucleotide identity puts 31-mer
sharing at effectively zero.

So a per-KO set is a bag of mutually invisible sequences. A read from species A matches A's own copy
and nothing else in the bag; containment of the whole set therefore measures *which catalogue copies
are present*, weighted by their abundance — which is genome abundance × annotation, the matrix
product above, re-derived with worse statistics and no attribution. The function itself is never what
is being detected.

That gap is not an implementation detail, it is why the two families of tool differ: functional
annotation transfers by **protein** homology, so functional profilers use translated search
(DIAMOND, HUMAnN), while taxonomic profilers use nucleotide k-mers. sylph is firmly in the second
family, and no database layout moves it into the first.

**But the sketch idea does work — one alphabet up.** `fmh-funprofiler` is FracMinHash applied to
**amino-acid** k-mers: Hera *et al.*, "Metagenomic functional profiling: to sketch or not to
sketch?", *Bioinformatics* **40**, ii165–ii173 (2024), doi:10.1093/bioinformatics/btae397. It
sketches 25,347 KEGG orthologs at k=7/11/15 amino acids, scaled=1000, and reports **39–99× faster
than DIAMOND with 40–55× less memory**, completeness around 60% overall and up to 85% on the top 95%
most abundant KOs, with few false positives. Same family as sylph — Koslicki co-authored the
FracMinHash groundwork — just on the alphabet where homology survives.

Its prebuilt sketches are on Zenodo (record 10045253) and are **browser-sized**: 98 MB for
`scaled=1000` across all three k, 113–139 MB for the SBT-indexed variants — against the 433 MB
human-gut catalogue this page already downloads.

**And the WebAssembly path is largely already there.** `src/core/Cargo.toml` in sourmash carries a
dedicated WASM section — `wasm-bindgen`, `wasm-bindgen-test`, wasm-specific `chrono` — so the Rust
core officially targets `wasm32-unknown-unknown`. Mibianto [12] has already shipped sourmash
sketching in a browser, which retires the hardest unknown. One caveat is visible in the same file:
`rocksdb` is excluded on wasm, so the accelerated index backend is not available there. At 25,347 KO
signatures averaging ~4 KB that does not bite — a linear intersection of the sample sketch against
every reference is a few tens of millions of hash lookups, which is nothing. The unproven step is
therefore *search in the browser*, not sketching: Mibianto does its `gather` server-side, so nobody
has demonstrated the half we would need.

### Recommendation

**Aim at the protein-sketch route; treat the core-genome inference as a stepping stone, and do not
call it functional profiling.**

The reason is not cost — inference is an afternoon and this is weeks — it is that **the inference
cannot produce a finding that is not already in the taxonomic table**. The functional profile is a
deterministic function of the species profile: two samples with identical species necessarily have
identical functions, so "same taxa, different functions" is literally unrepresentable, and that is
the question a functional view is asked. It is a recolouring of the abundance matrix. Worth
shipping — the redundancy result above is real and interesting — but as *"what the taxa you found
are known to carry"*, never as a measurement of function. The core/pangenome gap measured above
(0.150, larger than the distance between two people) is the same problem seen from another angle.

The protein sketches measure from the reads instead, independently of the catalogue's taxonomy, and
can see functions carried by organisms the catalogue does not name — 25% of the gut representatives
have no GTDB species name at all, and reads matching no catalogue genome are simply absent from the
taxonomic table today.

### Settled, 2026-08-13: it runs in the browser, in both architectures

The experiment above was run. **fmh-funprofiler's pipeline now executes entirely in WebAssembly**,
wasm32 and wasm64, and reproduces sourmash exactly. Build with
`./scripts/build_funprofiler_wasm.sh both`; check with `python3 scripts/funprofiler/run.py` after
`scripts/funprofiler/fixtures.sh`.

**What had to be built.** sourmash's WASM surface exposed only sketching — `KmerMinHash`,
`Signature`, `ComputeParameters` — with no way to load a reference or compare against one, which is
why the assignment half has always run server-side. `scripts/funprofiler/funcprofiler.rs` adds a
`FuncProfiler` that loads reference signatures from `.sig` JSON and runs the prefetch pass. The pass
is one intersection per reference, which is what made it fit: no greedy cover, and no RocksDB, which
the crate excludes from wasm anyway.

Sketching needed nothing new. `SeqToHashes` switches to `translated_frames` on its own once the hash
function is protein, so `add_sequence_js` on a protein `KmerMinHash` already *is* `sourmash sketch
translate`, six frames included.

**Correctness, against sourmash 4.9.4 rather than against ourselves.** On fmh-funprofiler's own demo
FASTQ (10,000 reads) and 4,000 KO signatures at k=11:

| | |
|---|---|
| sample sketch | 2,318 hashes, **identical hash for hash** to `sourmash sketch translate` |
| profile | 147 KOs; **0 missing, 0 extra**, largest abundance difference **0** vs `sourmash prefetch` normalised as `funcprofiler.py` normalises it |
| wasm32 vs wasm64 | byte-identical profiles (same digest over every row), Chrome 151 |

**Cost, measured in Chrome:** wasm32 sketches in 0.43 s, loads 4,000 references in 0.64 s and
profiles in 0.048 s; wasm64 takes 0.62 / 0.87 / 0.059 s — about 1.4× the 32-bit build, the same
direction and roughly the same size as the penalty measured for sylph.

**Four traps, each of which cost real time.**
- `niffler`'s `zstd` feature is a C library; `cc-rs` wants clang for wasm32 and a machine with only
  gcc fails. Nothing here reads zstd — drop the feature.
- Every wasm guard in sourmash keys on `target_arch = "wasm32"`. On wasm64 the arch is `"wasm64"`,
  so `js-sys`, `web-sys`, `wasm-bindgen` and `getrandom`'s `js` feature silently vanish — and
  `rocksdb`, guarded by *not* wasm32, silently returns. `target_family = "wasm"` fixes both
  directions. This is the same trap the README already documents for sylph.
- wasm-bindgen before 0.2.126 cannot describe a 64-bit module: `non-i32 constant`.
- **Do not test wasm64 in node.** Node 22 rejects a 64-bit table with "invalid table elements limits
  flags" — and rejects the sylph wasm64 package that works in production for the same reason. The
  browser is the only honest harness.

**At full scale, in the browser** (`python3 scripts/funprofiler/run_full.py`): every k=11 signature
the archive holds — 13,506 references, 2.2 M hashes — loaded and scanned in a tab.

| | wasm32 | wasm64 |
|---|---|---|
| fetch 20 MB gz → 48 MB text, decompressed by `DecompressionStream` | 0.46 s | 0.45 s |
| sketch 10,000 reads | 0.55 s | 0.69 s |
| load 13,506 references | 1.59 s | 2.12 s |
| profile | **0.136 s** | 0.207 s |
| WebAssembly memory | **39 MB** | 41 MB |
| result | 211 KOs, identical digest across both, and **identical to `sourmash prefetch` over the whole archive: 0 missing, 0 extra, largest difference 0** |

Two numbers reframe the feasibility question. The reference is **20 MB gzipped**, not the 98 MB the
Zenodo record suggests — that file carries four k values and only one is needed; 20 MB is smaller
than the smallest biome database this page already ships. And it costs **39 MB of WebAssembly
memory**, against 433 MB for the human-gut catalogue. Functional profiling is the cheap half.

**Not a defect in the published archive, as this paragraph first claimed.** The manifest's 14,606
signatures per k are all in the archive; reading only members ending in `.sig.gz` missed sourmash's
collision suffixes (`.sig.gz_0`, …) and with them 1,100 signatures at k=11 — 1,096 empty and 4 exact
copies of kept orthologs. The reference now ships the 13,509 non-empty ones; the measurements in this
section were taken on the earlier 13,506, which differs only in those four twins and one empty
sketch. `web/db/kegg/README.md` has the details.

### The Function tab: built, tested, and waiting on one wire

`web/kegg.js` turns a KO profile into the same `{ samples, rows }` table the taxonomic figures
already take — which is why functions need no new plotting code for composition and diversity — and
rolls orthologs up into KEGG modules and pathways. `pathwaySvg` in `web/figures.js` draws the map.
`web/kegg.test.mjs` covers it: **23 checks, 0 failed**, in CI.

**Three granularities, one measurement.** Pathways (the level a reader reasons in), modules, and the
orthologs actually measured. The tab carries a level selector and downloads the function matrix as
TSV at whichever level is on screen.

**One matrix renderer, both halves.** `paintMatrix()` in `web/multi.js` draws the taxonomic and the
functional table, so they are the same table asked two questions rather than two tables that happen
to agree. They agreed for about a day: the functional one had one header row instead of two, no heat
colour, no identifier column and three decimals instead of two, and none of it was visible until the
two were seen side by side. What differs is passed in — what a row is, what identifies it, where
that identifier is looked up, and what the columns were measured against.

**Every row carries three strings, and the distinction is load-bearing.** `id` (K01952 / M00001 /
map00010) is what joins to any other KEGG table and what a reader copies into a paper; `name` is the
human name alone, which is what a table column reads; `label` is `id — name`, which is what a figure
legend needs because it has room for one string and either half alone is useless. The identifier
column links to `https://www.kegg.jp/entry/<id>` — KEGG's own documented WebLinks form, the only
operation the GenomeNet mirror also implements, and one click from the drawn map at a fortieth of its
weight. Linking raises no licensing question distinct from displaying the names: KEGG's terms address
*use*, an `<a href>` copies nothing onto our server, and hot-linking KEGG's map IMAGES — which would
be reproduction — is exactly what linking to `/entry/` avoids. Note `/entry/` soft-404s: a retired
identifier returns HTTP 200 with "No such data was found.", so status cannot validate an id.

**The number the interface must never hide.** Only **17%** of the orthologs this reference can report
belong to any KEGG module — on the demo FASTQ's own profile, 29% of the *measured* signal reaches
one. So `moduleTable` returns `unassigned` rather than dropping it, the pathway figure always draws
an "in no KEGG module" bar, and the figure prints its own coverage. A module chart speaking for a
quarter of the signal while looking complete would be the same lie the composition figure's grey
"other" exists to prevent. Two tests fail if that bar or that sentence disappears.

**Why measured and not inferred, restated where the code lives.** The cheap route — genome abundance
× annotation — makes the functional profile a deterministic function of the species profile, so
"same organisms, different capability" is unrepresentable. That is the question a functional view is
asked, so the reads are sketched a second time instead.

### The example now carries both halves, measured 2026-08-14

The eighteen PRJNA728374 runs of the shipped demo have been profiled functionally — **the same
accessions, the same 3,000,000-read cap, the same streaming code**, by
`scripts/funcprofile_ena_runs.mjs`, which is `profile_ena_runs.mjs` with a sourmash protein sketch
in place of the sylph profiler. About 190 MiB downloaded and ~4 minutes per run; three processes in
parallel did the eighteen in 25 minutes. The merged table is tracked as `func_matrix_human-gut.tsv`
(4,307 orthologs × 18 samples), and `build_demo_session.py --only-func` folds it into the session
without touching a taxonomic number.

| | |
|---|---|
| hashes per sample | 189,000 – 318,000 |
| orthologs per sample | 2,121 – 2,951 |
| named by the bundled KEGG map | 99.8% |
| share of the measured signal reaching a module | **23%** |
| modules / pathways in the community | 344 / 102 |
| session size | 255 kB → 1.27 MB (187 kB gzipped, which is what the page fetches) |

**And it reproduces the redundancy result on a measurement rather than an inference.** Clustering
the ordination without being told who is who: taxonomy recovers all six people (k=5, silhouette
0.84, nobody split across clusters); function does not (k=3, silhouette 0.66 at ortholog level,
0.49 at module level, one and two people split respectively). Different people, different species,
similar functions — which the abundance × annotation route could not have shown, since it makes
function a deterministic image of taxonomy.

**What is still NOT wired: measuring functions in the page.** Nothing sets `funcProfiles` during a
run. Sessions carry it (`toSession`/`fromSession`, optional key, format number unmoved — old
sessions still open) and the example ships it, so the whole display path is exercised on real data;
but the worker still sketches only with sylph. The remaining work is one pass: feed each read chunk
to a sourmash protein `KmerMinHash` alongside `profiler.feed()`, run `FuncProfiler.profile()` at
`finish_sample`, and return the CSV beside the TSV. Until then the tab refuses with the reason on
anything but the example, as the enterotype tab does. The 20 MB reference also still needs to go
through the OPFS cache.

**The tab asks before it shows anything of KEGG's.** KEGG's terms state that it "is not a public
database" and that non-academic use requires a commercial licence from Pathway Solutions, so the
Function tab puts that sentence, a link to the terms, and two doors — *academic user* / *holds a
KEGG licence* — in front of the first figure. The answer is kept in `localStorage`, goes nowhere
(this page has no server to send it to), and is changeable under Settings. It is an acknowledgement,
not a check: nothing here can verify who anyone is, and pretending otherwise would be theatre. What
it can do is make sure nobody reads KEGG data here without having been told the terms. Nine wiring
checks hold it, including that the gate is decided *before* the tab looks for data — a reader who
has not answered must not be told "no functional profile", which is a different sentence that skips
the terms.

*(One of those checks was written wrong and a mutation found it: `indexOf(...) < indexOf(...)`
returns true when the first string is **deleted**, because -1 is less than any real index. An
ordering test must prove both positions exist before comparing them.)*

**The "service provider" clause does not apply here, and an earlier draft of this note said it did.**
KEGG asks those "who utilize KEGG for providing services" to obtain an academic service provider
licence. That clause targets *server-side* KEGG use — a machine that takes a user's data, queries
KEGG and returns an annotated result. This page has no server and performs no service: it hands over
a static file, and the reader's own browser does the work. No service is rendered, so the clause is
not engaged.

**Which is precisely why the gate is the right instrument.** With no server, the page is a delivery
mechanism and *the reader* is the user of KEGG — so the terms belong in front of the reader, which
is where they now are. A server-side tool could plausibly hold one licence covering its users; a
static page cannot, and cannot check anything either, so telling and asking is all there is.

**What remains open is a different clause: redistribution.** `ko-map.json` is a file of KEGG's
curated content — identifiers, names, and the KO→module→pathway membership. That is not sequence,
but it is curation, and KEGG's FTP subscription exists because bulk KEGG data is not freely
redistributable. Two precedents make it arguable rather than reckless: EMBL-EBI redistributes KEGG
module identifiers *with their names* in MGnify's own `pangenome_functions/kegg_completeness`
files, and Penn State publishes KEGG-derived sketches on Zenodo under CC BY 4.0. Still a question
for the maintainer before the file ships publicly — but a narrower one than this note first claimed.

**`web/db/kegg/ko-map.json` is KEGG-derived** (0.88 MB, 0.21 MB gzipped, built by
`scripts/build_kegg_map.py` from KEGG's REST endpoints). It holds identifiers, names and membership
rather than sequence, and fmh-funprofiler's own KEGG-derived sketches are published CC BY 4.0 by
Penn State — but KEGG is copyrighted by Kanehisa Laboratories and this file goes into the
repository. A human has to answer that before it ships.

**Licensing is not an obstacle — checked.** The `fmh-funprofiler` code is MIT (© 2026 KoslickiLab,
Penn State), which combines into this GPL work in the same direction sylph already does. The
prebuilt sketches are Zenodo records 10045253 and 10981414 under **CC BY 4.0, open access**, so they
need not be redistributed at all: the page would fetch them from their Zenodo exactly as it fetches
ours from ours, with attribution. (Whether KEGG derivatives could be placed under CC BY is between
Penn State and Kanehisa Laboratories; relying on a depositor's declared licence is the same posture
we take in reverse with our own CC0 claim over FracMinHash sketches of MGnify genomes. Worth a
sentence in the citations, not a blocker.)

The one substantive risk left is accuracy: ~60% completeness overall, ~85% on the abundant tail. That
has to be stated wherever the feature appears, in the same voice as the biome warning.

**Which leaves two honest routes, and they claim different things.** Inference from genome abundance
× per-genome annotation — the route above — predicts functional *potential* and costs 1.2 MB. Measuring
gene content requires mapping reads to gene families, as HUMAnN or a gene-catalogue tool such as
Meteor2 does; that is a different tool with a different cost, not a different sylph database.

**Coverage across the nineteen catalogues, surveyed 2026-08-13.** `pangenome_functions/` exists for
**15 of 19**, and for **14 of those at exactly the version our `.syldb` was built from**, so the
genome identifiers align without translation:

| | catalogues |
|---|---|
| functions at our version | human-gut (v2.0.2), chicken-gut, cow-rumen, honeybee-gut, human-oral, human-vaginal, maize-rhizosphere, marine, mouse-gut, non-model-fish-gut, pig-gut, sheep-rumen, tomato-rhizosphere, zebrafish-fecal |
| version mismatch | barley-rhizosphere — our database is v2.0, functions only at v1.0; identifiers must be checked before use, not assumed |
| no annotations published | human-skin, marine-eukaryotes, marine-sediment, **soil** |

So this is a per-biome capability, not a global one, and it has to degrade the way the lineage map
already does: present where it exists, absent-and-explained where it does not — never silently
missing. Note that soil is among the four without, and it is the largest catalogue.

*(Watch the version listing: the FTP directory for human-gut lists `v1.0, v2.0.1, v2.0.2, v2.0` in
that order, so taking the last entry picks v2.0 and misses the annotations. Sort properly or check
every version — the first pass of this survey got human-gut wrong for exactly that reason.)*

**Tried on the shipped demo, 2026-08-13 — it works, and it says something.** The eighteen
PRJNA728374 samples, functional profile computed as abundance × core-module completeness summed over
genomes:

- **Coverage is total**: all 468 taxa in the demo matrix carry KEGG annotations. No abundance is
  dropped for want of an annotation — the worry that a functional view would quietly discard part of
  the sample does not arise here.
- **319 modules** are present in the community; 169 of them reach 0.1% of the profile.
- **Functional redundancy, recovered on our own data.** Bray–Curtis between samples is **0.057
  within a donor and 0.113 between donors**, against **0.326 and 0.734** taxonomically. Different
  people carry different species doing the same things — the textbook result, and a good reason for
  the feature to exist: it says something the taxonomic view cannot.
- **The personal signal weakens but survives**: nearest neighbour by function is the same donor for
  16 of 18 samples, against 18 of 18 by taxonomy.

**So: how to present it — answered.** Not as a whole-profile distance, which compresses everything
toward similarity (58 of 319 modules vary by less than 15% across all eighteen samples: a shared
core that drowns the signal). The useful view is **which modules differ**. Ranking by donor-explained
variance above the floor puts biotin and pantothenate biosynthesis, leucine degradation,
dTDP-L-rhamnose and the Wood–Ljungdahl pathway at the top — all at 93–97%.

**Two traps found while doing it, both worth keeping.**
- **Rank with an abundance floor or the ranking is noise.** The first attempt sorted by coefficient
  of variation with no floor and returned eight modules at 0.000% of the profile — anammox, cymene
  degradation, nocardicin biosynthesis — present in one sample at trace level. CV diverges as the
  mean approaches the detection floor. 0.1% of the profile was enough to make the list sensible.
- **93–97% "explained by donor" is descriptive, not a test.** Six donors, three samples each: that
  design makes a high between-group share easy to obtain. Anything published needs a permutation
  test, not this number.

**Core versus pangenome — measured, and the answer is uncomfortable.** The TSVs carry both: the
pangenome column says *some* genome in the species cluster has the module, the core column says
essentially all of them do. Core is the conservative reading, and everything above used it. The two
give a genome 111 versus 134 modules on average — core is 82% of pangenome — and 319 versus 352
modules across the community. So far, so mild. But the distance between the core and pangenome
profiles **of the same sample** averages **0.150**, while the distance between two *different
people* is 0.113 (core) or 0.069 (pangenome):

| | within a donor | between donors | core vs pangenome, same sample |
|---|---|---|---|
| core inference | 0.057 | 0.113 | **0.150** |
| pangenome inference | 0.036 | 0.069 | |

**The methodological choice moves the profile further than the biology does.** The structure
survives — both readings give between-donor distances about twice within-donor, so the ordination
and the redundancy result hold either way — but no absolute functional profile from this route
should be presented as a measurement. Whichever column is used must be named in the interface and
in every export, exactly as the catalogue already is, and the difference is a reason to prefer
"which modules differ between these groups" over "this sample's functional composition".

---

## 2. What does the 3-million-read cap actually cost?

Specified in full as note 6 of the Application Note draft (`docs/paper/`, not tracked here).

The short version: Table 1 of that draft proves the WebAssembly build reproduces sylph exactly *on
the same input*, and says nothing about what the **cap** costs. It is the first question a reviewer
will ask, and it is not hypothetical for our own example — all 378 runs of PRJNA728374 exceed the
cap (median 8.6 M reads, min 3.9 M, max 19.5 M), so every profile in the shipped demo was built
from about a third of its run.

Measure the cap alone first (same tool, same catalogue, depth series 0.5/1/3/10 M and uncapped, over
the eighteen demo runs; `scripts/profile_ena_runs.mjs --reads N` already takes the depth). The
number that matters is not how many species are lost but **what fraction of the full profile's
abundance the surviving species carry**. Comparing against Meteor2 or MetaPhlAn 4 at full depth
answers a different, less clean question — their references are not commensurable with MGnify genome
representatives — and belongs in supplementary unless it can be done fairly.

---

### Done, 2026-08-15: the harness is complete, the measurement is not

`scripts/profile_ena_runs.mjs --reads N` takes the depth, and
`scripts/compare_profiles.py ref.tsv reduced.tsv` already prints exactly the number this
item asks for — the overlap, the rank correlation, and every genome present at full depth and
missing from the capped run *with the abundance it had*, which is the sensitivity paid. So the
experiment is a loop over five depths and eighteen runs, and nothing needs writing.

**What it costs, which is why it has not been run here:** the eighteen demo runs are not on this
disk, `human-gut.syldb` (433 MB) is not either, and the uncapped arm reads every run to the end —
median 8.6 M reads, max 19.5 M. That is hours of transfer from the EBI, and it is the kind of
spending that should be a decision rather than a side effect of a session. The commands:

```bash
node scripts/profile_ena_runs.mjs --db human-gut.syldb --reads 500000  --out depth_0.5M.tsv --runs demo_runs.txt
# … 1000000, 3000000, 10000000, then --reads 0 for uncapped
python3 scripts/compare_profiles.py depth_uncapped.tsv depth_3M.tsv --lineage web/db/lineage/human-gut.json
```

---

## 3. Say which GTDB release the displayed names come from

**Measured 2026-08-13.** MGnify's own README states that UHGG v2.0.2 taxonomic annotations "were
generated with the Genome Taxonomy Database **r202**". The page displays those names, and nothing in
the interface, the exports or the README says so. Four GTDB releases have passed (r202 → r207 →
r214 → r220), and the drift is not cosmetic. Of the 4,744 human-gut species representatives:

| | count | share |
|---|---|---|
| no GTDB species name at all — novel species | 1,187 | 25% |
| named, and the name still exists in r220 | 2,632 | 55% |
| named, renamed in r220 but the genus survives | 294 | 6% |
| named, and neither species nor genus is in r220 | 631 | 13% |

So roughly a fifth of the names shown no longer match current GTDB — `Staphylococcus_A lentus` is
one, the genus itself having since gone. Cheap fix: record the release in
`web/db/lineage/<biome>.json` and print it wherever the catalogue is already named, next to the
version. The same applies to the enterotype poles, whose whole point is that they use GTDB
nomenclature rather than the 2011 names.

### Done, 2026-08-15, and narrower than the item assumed

Recorded per catalogue as `gtdb` in `web/db/biomes.json`, carried by `makeDbRef()`, and printed by
`refLine()` next to the catalogue ("names from GTDB r202") and by `refCommentLines()` in every
exported matrix. `scripts/build_demo_session.py` stamps it into the example.

**Only five of the nineteen catalogues state a release.** Read README by README on
`ftp.ebi.ac.uk`: human-gut r202, human-oral r202, cow-rumen r202, pig-gut r207, zebrafish-fecal
r207. The other fourteen say nothing about GTDB at all — so they carry no `gtdb` field, and the page
prints nothing rather than assuming r202 across the board, which would put a citation nobody checked
beside fourteen catalogues' names. The enterotype poles are not covered by this and still need their
own note.

**And the answer to "are the catalogue genomes in GTDB?": no, and it matters.** They are MGnify's
own — `GUT_GENOME######` accessions, with 3,835 of the 4,744 representatives (81%) being MAGs
MGnify assembled itself. They carry a GTDB *assignment*, they are not GTDB *reference genomes*, and
they cannot even be matched to GTDB by accession. The consequence for the "just use sylph's GTDB
database" option: the 1,187 representatives with no GTDB species name — 1,184 of them MAGs — are
exactly the uncultured, gut-specific fraction UHGG exists to capture, and profiling against GTDB
instead forfeits them. The per-biome catalogues are not merely smaller than GTDB; for this biome
they are not a subset of it.

---

## 4. Size the worker pool from the machine, not from a constant

`web/multi.js` fixes the pool at minimum 2, default 4, maximum 8, and reads neither
`navigator.hardwareConcurrency` nor `navigator.deviceMemory`. Measured on a 32-core host, 32 samples
took 86.3 s through one worker and 20.0 s through eight — a 4.32× speed-up that the default leaves
on the table. In the other direction, each worker holds its own copy of the database in its own
WebAssembly heap: peak resident memory rose from 1.89 GB at one worker to 14.55 GB at eight, a
near-constant **1.85 GB per worker** for the 454 MB human-gut catalogue. Eight workers on the 3.0 GB
soil catalogue would ask far more than a 16 GB laptop has, and nothing in the page stops it.

Size the default from `hardwareConcurrency`; bound it by `deviceMemory` against the size of the
catalogue actually loaded. (Measured with node worker threads standing in for Web Workers — same
one-database-per-worker shape. Re-measure in a browser before quoting the numbers as browser
numbers.)

### Done, 2026-08-15

`suggestedWorkers(catalogueBytes)` in `web/multi.js`: `hardwareConcurrency - 1`, clamped to [2, 8],
then bounded by `deviceMemory * 0.5` against `1.85 GB x (catalogue / 454 MB)` — the one measured
ratio, used as one measured point and not as a fitted model. Applied when the database is loaded,
which is the first moment the catalogue is known and the last moment the pool is free. `deviceMemory`
is a lower bound (the spec rounds to a power of two, Chrome caps at 8), so the bound is conservative
by construction; Settings shows the number the page chose **with its reason**, and the page stops
choosing the moment the reader moves it. Pinned by four checks in `scripts/ena-test/wiring.mjs`.

**Still not measured in a browser.** The 4.32x and the 1.85 GB are node worker threads, and this
change quotes them in a comment rather than on screen — the interface says only what the page did
and why.
