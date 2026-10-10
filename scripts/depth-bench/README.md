# What a peek recovers

Two questions the paper could not answer before this directory existed.

**Does the functional half agree with the tool it ports?** §3 of the note showed
the taxonomic port reproducing native sylph, and said nothing at all about the
functional one — a second sketcher, in a second alphabet, against a second
reference, validated by nothing. It does: same orthologs, same order, agreeing
to 2 × 10⁻¹⁵. Asking the taxonomic question again on new reads also turned up
the answer §3.1 now carries — the two builds are very close rather than exactly
equal, and "exactly zero" was a property of one fixture.

**What does the 3-million-read cap cost?** The page caps a run by default, and
the note admitted the cap "bites" without measuring the bite. And a profile is
only as good as the reference it is relative to, so the same reads are also put
through two other references entirely: the whole of GTDB r220 through native
sylph, and a 10.4-million-gene catalogue through Meteor2, which works by mapping
reads to genes rather than by sketching k-mers.

## Running it

```
scripts/depth-bench/ladder.sh <sample> <R1.gz> <R2.gz> [threads]   # per sample
scripts/depth-bench/finish.sh [threads]                            # profiles, metrics, figure, §3.3
python3 scripts/depth-bench/equivalence.py reads.fastq.gz          # the functional port
node    scripts/depth-bench/substitution.mjs R1.gz R2.gz out.tsv   # the browser build, in node
```

`equivalence.py` needs `scripts/funprofiler/fixtures.sh` to have been run (it
fetches the upstream KO archive) and a FASTQ to run on; the one used for the
note was made with

```
seqtk sample -s7 ERR14098649_1.fastq.gz 200000 | gzip -1 > data/bench/equiv/reads.fastq.gz
```

— single-end on purpose, because that is the shape fmh-funprofiler's own pipeline
takes.

`ladder.sh` refuses an input before it spends anything on it — `gzip -t` on both
mates and a comparison of their record counts. That check exists because a
download of `ERR14098640_1.fastq.gz` once arrived at exactly the byte count the
archive publishes and was corrupt anyway, stopping at 4.9 of its 7.96 million
reads; seqtk sampled what it could read, nothing threw, and the profiles looked
entirely reasonable. It subsamples one rung at a time, profiles it three ways and deletes it
before the next: the ladder sums to 2.7× the run and the machine it was written
on had eight gigabytes free. It skips rungs that already have a `.done` marker,
so it can be killed and restarted.

`profile_all.sh` profiles every sketch against each database in ONE load rather
than one load per rung — the GTDB database is 14 GB off disk, and loading it
forty-eight times would cost more wall-clock than reading all the reads.

## Why native sylph stands in for the browser

The "page" arm of §3.3 is native sylph against the page's own catalogue, because
driving eight rungs × three samples through a browser would have cost a day. The
substitution is checked rather than assumed: `substitution.mjs` runs the page's
OWN WebAssembly profiler — the module the worker loads, fed the same way — on one
of the rungs, and `substitution_check.py` compares it with the native table.

On 100,000 pairs of ERR14098649 the two builds report the same 45 genomes, none
unique to either, in the same order, with abundances agreeing to 0.024 and ANI to
0.02. Not the exact zero §3.1 reports on ERR14098592 — which is why §3.1 now says
so — but three orders of magnitude finer than anything §3.3 claims.

## What is compared, and what cannot be

The three references name species differently — UHGG ships GTDB r202 names,
sylph's GTDB database is r220, and Meteor2's MSPs carry an r220 assignment — so
agreement is measured on the species name AND on the genus, which survives what
the species name does not: between those releases species were renamed, split
and merged, and the gap between the two ranks is the part of the disagreement
that is nomenclature rather than biology. Every row every tool reported could be
named — no row fell back to an accession on any side — so what is compared is
names, not the ability to produce them.

Presence overlap (Jaccard) is reported but not leant on. These profiles have a
long tail at a fraction of a percent, and counting a rare row and an abundant one
alike reads as disagreement even where the tools agree about everything that
matters. The number to read is the share of one tool's ABUNDANCE the other also
names.

Meteor2 runs here on the **fast (taxonomic) catalogue**, 0.9 GB, because the full
10.4-million-gene one does not fit. Its archive is 12.72 GB; the only member size
measured directly — by streaming the archive's own table without writing any of
it to disk — is the gene FASTA at 2.47 GB, and since that member is already
gzipped and therefore incompressible, the remaining ~10.2 GB of archive is the
bowtie2 index, which expands rather than shrinks. Sixteen to nineteen gigabytes
extracted is the honest range, against 6 GB free on this machine and about 18 GB
if every regenerable artefact in `data/` were deleted first. That is why there is no
Meteor2 column in the functional comparison: functional profiling needs the full
catalogue's gene annotations, and the fast catalogue carries only MSP core genes.

Not "carries no annotations" — the fast catalogue ships the whole KEGG table, and
`meteor profile` with it emits an MSP table and a gene table and no functional
one, which was checked rather than assumed. A KO profile could be *derived* from
its gene counts: of the 198,908 genes it indexes, 114,371 carry a KO, covering
4,111 of the 7,613 in the full catalogue and of the 13,506 the page matches
against. That derivation was deliberately not done. Those genes are chosen to
tell species apart, not to describe what a community does, so a rank correlation
against a functional profile would measure the marker set rather than the
function — a number that looks like a comparison and is not one.
The functional ladder therefore measures the page against itself at depth, and
against the reference implementation (`equivalence.py`), not against Meteor2.

## What each step costs the machine

`resources.sh` runs one step at a time under `/usr/bin/time -v`, nothing else on
the machine, and appends to `data/bench/res/measures.tsv`: wall clock, user and
system CPU, peak resident set, and the bytes the step wrote. Serial on purpose —
measuring two profilers at once measures contention, not cost.

Read it with the caveats, which an adversarial pass over the first draft of this
section turned up and which are not optional:

- **Meteor2's row is a compound step and a lower bound.** `meteor mapping` runs
  the alignment *and* the counting, so a peak taken over it cannot be attributed
  to bowtie2; bowtie2 runs with `--mm`, so its 346 MB index is file-backed shared
  memory, resident only as touched and warm from the previous rung; and `%M` is a
  maximum over concurrent children rather than their sum, while the aligner and
  the CRAM writer peak together by construction. `meteor fastq` is outside the
  measurement.
- **sylph's GTDB figure is per invocation, not per sample.** One sketch against
  GTDB r220 peaks at 13.3–13.6 GB, essentially all of it the database; twenty-four
  sketches in one load peak at 15.2 GB, about 2 GB above the database either way.
  Quoting "15 GB" as a per-sample cost would be wrong.
- **Meteor2's own log lines are not GNU time walls.** "Completed mapping creation
  in 54.58 seconds" covers bowtie2 and the CRAM write, 62–87% of the command, and
  the fraction rises with depth. The two must not share a column.
- **The ladder's "fait — 7,9G libre" is a `df` of the whole filesystem**, printed
  after the rung cleaned up. It is a guard against filling the disk, not a
  measurement of what the experiment used. For that, use `bytes_out`.
- **The functional rate to quote is the isolated one**, about 17,000 reads/s on
  one thread. The per-rung timings in `out/*/func/*.json` include sixteen rungs
  that ran while a second ladder was running, and are up to 23% slower for that
  reason alone. It is also not comparable to the 48,277 reads/s of Table 1: a
  different input, and that figure's denominator is not recorded here.

One number worth knowing before running the ladder again: `seqtk sample` holds
its reservoir in memory, so subsampling 3 million pairs peaks at 2.15 GB per
mate. The ladder's disk budget was the constraint everyone thinks about; memory
is the one that bites on a bigger top rung.

### The one row that really is the page

Of the six measured steps, exactly one runs the page's own code: `func_page`.
`func_profile.mjs` imports `web/func-sketch.js` (the module `sylph-worker.js`
feeds), loads `web/funprofiler-pkg` (the package `multi.js` passes to the worker)
and `web/db/kegg/ko-sketches-k11.ndjson.gz` (the reference the page downloads),
and feeds it over the same two-stream interface. The sylph rows are the native
binary and are not the page in any sense but the profile they produce.

Two things still separate `func_page` from a browser tab, and only one is small:

- **Decompression.** The page gunzips with fflate inside the worker; this script
  uses node's zlib, inside the measured clock. Measured separately, node's zlib
  turns 949 MB into 2.4 GB in 16.4 s, so the 3 M-pair rung's ~970 MB of input is
  about 17 s of the 360 s — under 5%, and fflate is generally the slower of the
  two, so a tab would be a little higher rather than lower.
- **The runtime.** node against a browser's WebAssembly engine, single-threaded
  in both cases. This one is not quantified and should not be guessed at; the
  note's own author-list expects a tab to be slower than node.

So: the shape (about 2 s fixed plus about 120 s per million read pairs) and the
sketching cost are the page's; the absolute seconds are the page's code under
node.

### On the timings in particular

Five statements about time were drafted from `measures.tsv` and put to
adversarial verification. **All five failed**, and the failures are worth keeping
because each is a different way of misreading a wall clock:

1. *"One sample costs 17.9 s by the page's route, 91.3 s by Meteor2's."* Three
   faults: the sylph rows are the NATIVE binary, whose substitution for the
   browser was validated on the profiles it produces and never on seconds; the
   GTDB figure is a one-time database load, not a per-sample cost; and Meteor2's
   total omits `meteor fastq`, a mandatory step of its own route.
2. *"The functional pass costs 20× the taxonomic pass."* Divides a sixteen-thread
   number by a one-thread number, and uses native sylph as the denominator when
   the question is about the page.
3. *"T(n) = L + n·p fits the batch."* Two parameters on two points, and the batch
   is not serial — sylph profiles in waves and re-spends part of the load per
   wave. Report the two measurements, not a fitted slope.
4. *"7.5 of 16 threads."* CPU-seconds over wall-seconds is mean concurrency, not
   parallel efficiency; it varies with depth; and the host has 32 logical CPUs,
   not 16.
5. *"About 17,000 reads/s."* Freezes an affine cost into a constant rate.

One correction the verifiers themselves got wrong, caught by re-deriving it: the
cost per read does not rise with depth, it **falls**, 67.7 µs at 100 k pairs to
60.0 µs at 3 M, as the fixed ~2 s amortises. Verification is a filter, not an
oracle — check its arithmetic too.

The wording that survived all of it: every duration here is a wall clock for a
single invocation of one step, measured one step at a time, with native sylph
standing in for the browser on output rather than on time. They must not be
summed across routes, nor divided by one another.
