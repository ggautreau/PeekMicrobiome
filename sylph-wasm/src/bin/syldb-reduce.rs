//! `syldb-reduce` — rebuild a `.syldb` at a coarser FracMinHash rate `c`
//! without re-reading a single genome, and optionally merge several catalogues
//! into one screening database.
//!
//! WHY THIS IS EXACT
//! -----------------
//! `GenomeSketch.genome_kmers` does not store k-mers. It stores their *hashes*.
//! `seeding::fmh_seeds_positions` computes `hash = mm_hash64(canonical_kmer)`
//! and pushes `hash` itself — not the k-mer — whenever
//!
//!     hash < u64::MAX / c                                (seeding.rs:171,205)
//!
//! The retention rule is therefore a pure predicate on a value that survives
//! into the serialised sketch. Keeping only the hashes below `u64::MAX / c_new`
//! for some `c_new > c_old` yields precisely the hash multiset that sketching
//! the same genome at `c_new` would have produced. No genome, no k-mer, no
//! re-hashing needed. `contain.rs` only ever tests membership of these hashes
//! against the read sketch's `kmer_counts` (same hashes, same rule), so the
//! reduced database is consumed by exactly the same code path.
//!
//! THE CAVEAT — `min_spacing` — AND IT IS NOT SMALL
//! ------------------------------------------------
//! Sketching also drops a marker that sits within `min_spacing` bp of the
//! previously kept marker (sketch.rs:540,623); such markers are not lost, they
//! are moved to `pseudotax_tracked_nonused_kmers`. That partition was decided
//! at the *original* `c`, and re-sketching at `c_new` decides it differently:
//! at c=2000 markers are ~10x further apart, so almost nothing is
//! spacing-suppressed there, while plenty was at c=200.
//!
//! This is a re-partition, never a loss: this tool filters *both* vectors with
//! the same threshold, so `genome_kmers ∪ pseudotax_tracked_nonused_kmers` is
//! bit-identical to what a fresh `sylph sketch -c c_new` would yield. But the
//! two vectors are NOT interchangeable downstream: both feed `winner_table()`
//! (contain.rs:432-446), only `genome_kmers` feeds `contain_count`
//! (contain.rs:643-668) — i.e. the numerator/denominator of `naive_ani` and the
//! 50-k-mer floor of `get_stats`. So the size of `genome_kmers` is the quantity
//! that matters, and it is measurably smaller than in a fresh sketch:
//!
//!   * two control genomes sketched natively at c=200 and c=2000, then compared
//!     with the reduction of the c=200 sketch:
//!       g1 (5.0 Mb, 1 contig)  genome_kmers 2228 reduced vs 2509 fresh  -11.2%
//!       g2 (3.5 Mb, 2 contigs) genome_kmers 1555 reduced vs 1755 fresh  -11.4%
//!     the union was identical in both cases (0 hashes of difference);
//!   * on the shipped database, `syldb-reduce --list
//!     data/screening/screening-c2000-derep.syldb` reports 69.27 M genome_kmers
//!     against 10.61 M nonused, i.e. 13.3% of the union parked in the pseudotax
//!     list, where a fresh c=2000 sketch puts 1.6-1.8% there.
//!   * and the reason is visible in one line: `--check gut.syldb` (the c=200
//!     source) reports 49.21 M genome_kmers against 7.48 M nonused — 13.2%.
//!     The reduced database inherits the c=200 partition almost exactly,
//!     because that is precisely what it does: it filters, it does not
//!     re-decide spacing.
//!
//! CONSEQUENCE, stated plainly: for containment a database reduced from c=200
//! to c=2000 behaves like a fresh sketch at c ≈ 2250, not 2000 — roughly 11%
//! fewer countable markers per genome. Slightly less sensitivity at low
//! coverage, slightly more genomes under the 50-k-mer floor. It is not a
//! correctness bug (the cross-validation on ERR14098649 was run against a
//! reduced database and already includes this effect), but anyone choosing
//! between c=2000 and c=4000 on paper must budget for it.
//!
//! To re-measure in ten lines: `sylph sketch -c 200 g.fna -o a`, `sylph sketch
//! -c 2000 g.fna -o b`, `syldb-reduce --c 2000 --out r a.syldb`, then compare
//! `--list r` with `--list b.syldb`.
//!
//! WHAT THIS TOOL CANNOT FIX — UNNAMED GENOMES
//! -------------------------------------------
//! Merging 19 catalogues merges 19 independently-dereplicated sets, so the same
//! organism appears several times. `scripts/derep_screening.py` collapses those
//! copies BY GTDB SPECIES NAME — and 23 312 of the 56 782 genomes (41.1%) have
//! no species name at all (empty `s__`: novel species, overwhelmingly soil
//! 10 348, marine 5 796 and marine-sediment 2 050). Two unnamed genomes from
//! two catalogues can be the same organism and there is nothing here to notice
//! it: they are both kept and both counted. The screening verdict for the
//! biomes whose members are mostly undescribed is therefore a floor, not an
//! exact figure, and their genome counts are inflated by an unknown amount.
//! This tool does not solve it and does not pretend to; a real fix needs
//! sketch-level ANI clustering, not names.
//!
//! USAGE
//!   syldb-reduce --c 2000 --out screening.syldb \
//!                --biome-tsv genome-biome.tsv \
//!                gut=/path/gut.syldb marine=/path/marine.syldb ...
//!   syldb-reduce --list db.syldb          # per-sketch stats, writes nothing
//!   syldb-reduce --check db.syldb         # audit; exit 1 if anything is wrong
//!   syldb-reduce --c 2000 --dry-run in.syldb

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, BufWriter, Write};
use sylph::types::{GenomeSketch, Kmer};

/// The FracMinHash retention threshold for a given `c`, byte-for-byte the
/// expression used in `seeding.rs`. This is the value the tool *applies*.
#[inline]
fn threshold(c: usize) -> u64 {
    u64::MAX / (c as u64)
}

/// The threshold the *auditor* uses. Deliberately written out a second time,
/// with the constant spelled in full and with no call to `threshold()`.
///
/// This duplication is the point. The previous version of `--check` compared
/// every hash against `threshold(sk.c)` — the very function it was supposed to
/// be validating — so a wrong `threshold()` validated itself: with the constant
/// doubled, the tool wrote a database labelled c=2000 that still held a c=1000
/// sketch, and its own `--check` answered `violations=0, exit 0`. A check that
/// shares the arithmetic of the thing it checks proves nothing. Both functions
/// are pinned against literal values in `tests::pinned_thresholds`.
#[inline]
fn audit_threshold(c: usize) -> u64 {
    18_446_744_073_709_551_615u64 / (c as u64)
}

struct Input {
    label: String,
    path: String,
}

/// Everything `--list` prints and `--check` decides on, computed in one pass
/// and never using `threshold()`.
#[derive(Debug, Default, PartialEq)]
struct Audit {
    n: usize,
    genome_kmers: u64,
    nonused: u64,
    max_hash: u64,
    min_genome_kmers: usize,
    below_floor: usize,
    violations_genome: u64,
    violations_nonused: u64,
    first_violation: Option<String>,
    missing_pseudotax: usize,
    duplicate_names: usize,
    cs: BTreeSet<usize>,
    ks: BTreeSet<usize>,
    min_spacings: BTreeSet<usize>,
}

fn audit(sketches: &[GenomeSketch], floor: usize) -> Audit {
    let mut a = Audit {
        min_genome_kmers: usize::MAX,
        ..Default::default()
    };
    let mut names: HashSet<&str> = HashSet::with_capacity(sketches.len());
    a.n = sketches.len();
    for sk in sketches {
        a.cs.insert(sk.c);
        a.ks.insert(sk.k);
        a.min_spacings.insert(sk.min_spacing);
        a.genome_kmers += sk.genome_kmers.len() as u64;
        a.min_genome_kmers = a.min_genome_kmers.min(sk.genome_kmers.len());
        if sk.genome_kmers.len() < floor {
            a.below_floor += 1;
        }
        if !names.insert(sk.file_name.as_str()) {
            a.duplicate_names += 1;
        }
        let thr = audit_threshold(sk.c);
        for h in sk.genome_kmers.iter() {
            if *h > a.max_hash {
                a.max_hash = *h;
            }
            if *h >= thr {
                a.violations_genome += 1;
                if a.first_violation.is_none() {
                    a.first_violation = Some(format!(
                        "{} stores genome_kmers hash {} >= u64::MAX/{} = {}",
                        sk.file_name, h, sk.c, thr
                    ));
                }
            }
        }
        match &sk.pseudotax_tracked_nonused_kmers {
            None => a.missing_pseudotax += 1,
            Some(nu) => {
                a.nonused += nu.len() as u64;
                for h in nu.iter() {
                    if *h >= thr {
                        a.violations_nonused += 1;
                        if a.first_violation.is_none() {
                            a.first_violation = Some(format!(
                                "{} stores pseudotax hash {} >= u64::MAX/{} = {}",
                                sk.file_name, h, sk.c, thr
                            ));
                        }
                    }
                }
            }
        }
    }
    if a.min_genome_kmers == usize::MAX {
        a.min_genome_kmers = 0;
    }
    a
}

/// Everything that makes a database unfit to ship. Non-empty => exit 1.
///
/// `names_fatal` says whether duplicate `file_name` values count as a failure.
/// They always do for a database being audited on its own (`--check`) and for
/// any run that writes a biome table, where one genome would get two rows and
/// every downstream join would double-count it. `sylph sketch -i` legitimately
/// produces one `file_name` per record, so a reduce that writes no table only
/// warns.
fn audit_problems(a: &Audit, names_fatal: bool) -> Vec<String> {
    let mut p = vec![];
    if a.n == 0 {
        p.push("database is empty".to_string());
    }
    let v = a.violations_genome + a.violations_nonused;
    if v > 0 {
        p.push(format!(
            "{} hashes (>= threshold): {} in genome_kmers, {} in pseudotax. First: {}",
            v,
            a.violations_genome,
            a.violations_nonused,
            a.first_violation.as_deref().unwrap_or("?")
        ));
    }
    if a.ks.len() > 1 {
        p.push(format!(
            "mixed k = {:?}. The browser reports genome_sketches[0].k and get_stats() \
             exits(1) on the first mismatched sketch.",
            a.ks
        ));
    }
    if a.min_spacings.len() > 1 {
        p.push(format!("mixed min_spacing = {:?}", a.min_spacings));
    }
    if a.cs.len() > 1 {
        p.push(format!(
            "mixed c = {:?}. Every sketch in one .syldb must share c.",
            a.cs
        ));
    }
    if a.missing_pseudotax > 0 {
        p.push(format!(
            "{} sketches have no pseudotax_tracked_nonused_kmers; the browser's profile() \
             path requires it",
            a.missing_pseudotax
        ));
    }
    if a.duplicate_names > 0 && names_fatal {
        p.push(format!(
            "{} duplicate file_name values; the biome table cannot disambiguate them",
            a.duplicate_names
        ));
    }
    p
}

/// One machine-parsable line per file. `scripts/build_screening_db.sh` parses
/// `n=`, `c=`, `k=`, `min_genome_kmers=` and `below_floor=` out of it to write
/// data/screening/manifest.tsv, so the field names are a contract.
fn stats_line(label: &str, a: &Audit, floor: usize, check: bool) -> String {
    let c = a.cs.iter().next().copied().unwrap_or(0);
    format!(
        "{}\tn={}\tc={}\tk={}\tmin_spacing={}\tgenome_kmers={}\tnonused={}\tmax_hash={}\t\
         threshold={}\tmax/thr={:.6}\tmin_genome_kmers={}\tfloor={}\tbelow_floor={}{}",
        label,
        a.n,
        c,
        a.ks.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","),
        a.min_spacings.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","),
        a.genome_kmers,
        a.nonused,
        a.max_hash,
        audit_threshold(c.max(1)),
        a.max_hash as f64 / audit_threshold(c.max(1)) as f64,
        a.min_genome_kmers,
        floor,
        a.below_floor,
        if check {
            format!(
                "\tviolations={}",
                a.violations_genome + a.violations_nonused
            )
        } else {
            String::new()
        }
    )
}

/// How far the observed survivor count may sit from `expected` before we call
/// the reduction wrong. Loose enough for binomial noise on small sketches
/// (relative sd ~ 1/sqrt(expected)), tight enough that the 2x error a doubled
/// threshold produces (5.01x reduction where 10.10x was due) can never hide.
fn ratio_tolerance(expected: f64) -> f64 {
    0.20 + 6.0 / expected.sqrt()
}

/// The independent sanity check on the reduction itself: filtering at
/// `u64::MAX/c_dst` a set of hashes uniform below `u64::MAX/c_src` must keep
/// about `c_src/c_dst` of them. This is the signal that caught the sabotaged
/// `threshold()` immediately, long before any hash-level audit.
fn ratio_verdict(label: &str, observed: u64, expected: f64) -> Result<(), String> {
    if expected < 100.0 {
        // Too few hashes for the law of large numbers to say anything.
        return Ok(());
    }
    let dev = (observed as f64 - expected).abs() / expected;
    let tol = ratio_tolerance(expected);
    if dev > tol {
        return Err(format!(
            "{}: reduction kept {} hashes where {:.0} were due ({:+.1}%, tolerance {:.1}%). \
             Either the input's declared c does not describe its hashes, or the retention \
             threshold is wrong. Refusing to write.",
            label,
            observed,
            expected,
            100.0 * (observed as f64 - expected) / expected,
            100.0 * tol
        ));
    }
    Ok(())
}

fn usage_text() -> String {
    "syldb-reduce — re-sub-sample .syldb files to a larger c, and merge them.

USAGE:
  syldb-reduce --c <C> --out <FILE> [--biome-tsv <FILE>] [--min-kmers <N>] [LABEL=]<db.syldb>...
  syldb-reduce --c <C> --dry-run [LABEL=]<db.syldb>...
  syldb-reduce --list <db.syldb>...
  syldb-reduce --check <db.syldb>...

OPTIONS:
  --c <C>            target sub-sampling rate; must be >= every input's c
  --out <FILE>       write the merged, reduced Vec<GenomeSketch> here
  --biome-tsv <FILE> write genome_file<TAB>biome<TAB>first_contig<TAB>n_kmers.
                     Duplicate genome file names are fatal when this is asked
                     for: the table would carry two rows for one genome.
  --keep <FILE>      newline-delimited list of `file_name` values; every sketch
                     not listed is dropped. Used to dereplicate catalogues
                     against each other by GTDB species name.
  --min-kmers <N>    DROP sketches left with fewer than N genome_kmers after
                     reduction. Default 50, matching profile's
                     --min-number-kmers: below it get_stats() returns None, so
                     such a genome can never be detected — it would only take
                     up space. Use --min-kmers 0 to disable, or
                     --keep-below-min to count them without dropping.
  --keep-below-min   report sketches below --min-kmers instead of dropping them
                     (the pre-2026-08 behaviour; they stay undetectable)
  --dry-run          reduce and report, write nothing
  --list             print per-file stats of the inputs as-is
  --check            audit the inputs: FracMinHash invariant on both hash
                     vectors, homogeneity of c/k/min_spacing, presence of the
                     pseudotax vector, duplicate genome names. Exits 1 if any
                     of it fails. The check computes its own threshold and
                     never calls the tool's own threshold(), on purpose.

NOTE ON MERGED CATALOGUES: dereplication across catalogues is done by GTDB
species name (scripts/derep_screening.py), and 41.1% of MGnify genomes have no
species name. Unnamed duplicates of the same organism survive in several
copies. See the header of this file."
        .to_string()
}

fn usage() -> ! {
    eprintln!("{}", usage_text());
    std::process::exit(2)
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(run(&argv));
}

fn run(argv: &[String]) -> i32 {
    if argv.is_empty() {
        usage();
    }

    let mut target_c: Option<usize> = None;
    let mut out: Option<String> = None;
    let mut biome_tsv: Option<String> = None;
    let mut min_kmers: usize = 50;
    let mut keep_below_min = false;
    let mut dry_run = false;
    let mut list_only = false;
    let mut check_only = false;
    let mut keep: Option<HashSet<String>> = None;
    let mut inputs: Vec<Input> = vec![];

    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        match a.as_str() {
            "--c" | "-c" => {
                i += 1;
                target_c = Some(
                    argv.get(i)
                        .unwrap_or_else(|| usage())
                        .parse()
                        .expect("--c must be an integer"),
                );
            }
            "--out" | "-o" => {
                i += 1;
                out = Some(argv.get(i).unwrap_or_else(|| usage()).clone());
            }
            "--biome-tsv" => {
                i += 1;
                biome_tsv = Some(argv.get(i).unwrap_or_else(|| usage()).clone());
            }
            "--keep" => {
                i += 1;
                let p = argv.get(i).unwrap_or_else(|| usage());
                let txt = std::fs::read_to_string(p)
                    .unwrap_or_else(|e| panic!("cannot read --keep list {}: {}", p, e));
                let set: HashSet<String> = txt
                    .lines()
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty())
                    .collect();
                eprintln!("--keep: {} file names allowed", set.len());
                keep = Some(set);
            }
            "--min-kmers" => {
                i += 1;
                min_kmers = argv
                    .get(i)
                    .unwrap_or_else(|| usage())
                    .parse()
                    .expect("--min-kmers must be an integer");
            }
            "--keep-below-min" => keep_below_min = true,
            "--dry-run" => dry_run = true,
            "--list" => list_only = true,
            "--check" => check_only = true,
            "-h" | "--help" => usage(),
            _ => {
                if a.starts_with('-') {
                    eprintln!("unknown flag {}", a);
                    usage();
                }
                // LABEL=path, or bare path (label = file stem)
                let (label, path) = match a.split_once('=') {
                    Some((l, p)) => (l.to_string(), p.to_string()),
                    None => {
                        let stem = std::path::Path::new(a)
                            .file_stem()
                            .map(|s| s.to_string_lossy().to_string())
                            .unwrap_or_else(|| a.clone());
                        (stem, a.clone())
                    }
                };
                inputs.push(Input { label, path });
            }
        }
        i += 1;
    }

    if inputs.is_empty() {
        usage();
    }

    if list_only || check_only {
        let mut bad = 0;
        for inp in &inputs {
            let sketches = load(&inp.path);
            let a = audit(&sketches, min_kmers);
            println!("{}", stats_line(&inp.label, &a, min_kmers, check_only));
            if check_only {
                let problems = audit_problems(&a, true);
                if problems.is_empty() {
                    println!("  OK — {} sketches, every hash below u64::MAX/c, homogeneous", a.n);
                } else {
                    bad += 1;
                    for p in &problems {
                        eprintln!("  FAIL {}: {}", inp.path, p);
                    }
                }
            }
        }
        if bad > 0 {
            eprintln!(
                "\n{} of {} databases failed the audit. This is a hard failure: such a file \
                 must not be shipped.",
                bad,
                inputs.len()
            );
            return 1;
        }
        return 0;
    }

    let target_c = target_c.unwrap_or_else(|| {
        eprintln!("--c is required (or use --list)");
        usage()
    });
    if out.is_none() && !dry_run {
        eprintln!("--out is required unless --dry-run");
        usage();
    }
    let thr = threshold(target_c);
    eprintln!(
        "target c = {}  ->  keep hash < {} (= u64::MAX/{}, {:.4}% of hash space)",
        target_c,
        thr,
        target_c,
        100.0 * (thr as f64) / (u64::MAX as f64)
    );

    let mut merged: Vec<GenomeSketch> = vec![];
    // genome file_name -> (biome, first_contig, n_kmers)
    let mut biome_rows: Vec<(String, String, String, usize)> = vec![];
    let mut seen_files: HashMap<String, String> = HashMap::new();
    let mut total_in_kmers: u64 = 0;
    let mut total_out_kmers: u64 = 0;
    let mut n_below_min = 0usize;
    let mut n_dropped_floor = 0usize;
    let mut dropped_names: Vec<String> = vec![];
    let mut fatal: Vec<String> = vec![];
    // (k, min_spacing) of the first sketch seen, and where it came from.
    let mut shape: Option<(usize, usize, String)> = None;

    for inp in &inputs {
        let mut sketches = load(&inp.path);
        let n = sketches.len();
        if let Some(k) = &keep {
            sketches.retain(|sk| k.contains(&sk.file_name));
        }
        let dropped = n - sketches.len();

        // The invariant the whole tool rests on, audited with its own threshold
        // and over BOTH hash vectors, before anything is modified.
        let pre = audit(&sketches, min_kmers);
        let problems = audit_problems(&pre, biome_tsv.is_some());
        if !problems.is_empty() {
            panic!(
                "{}: refusing to reduce a database that fails its own audit:\n  - {}\n\
                 Run `syldb-reduce --check {}` for the details.",
                inp.path,
                problems.join("\n  - "),
                inp.path
            );
        }

        // Every input of a merge must agree on k and min_spacing, not just on c.
        // Merging 19 catalogues is the whole point of this tool, and a database
        // mixing k=21 with k=31 loads fine in the browser (Profiler::new only
        // looks at sketch[0]) and only blows up later, inside get_stats(), as a
        // process::exit(1) — i.e. a silent worker trap.
        let (k_here, ms_here) = (
            pre.ks.iter().next().copied().unwrap_or(0),
            pre.min_spacings.iter().next().copied().unwrap_or(0),
        );
        match &shape {
            None => shape = Some((k_here, ms_here, inp.label.clone())),
            Some((k0, ms0, from)) => {
                if *k0 != k_here || *ms0 != ms_here {
                    panic!(
                        "cannot merge: {} has k = {}, min_spacing = {} but {} has k = {}, \
                         min_spacing = {}. A .syldb must be homogeneous; sylph compares hashes \
                         of k-mers of one length only.",
                        inp.label, k_here, ms_here, from, k0, ms0
                    );
                }
            }
        }
        if let Some(c_max) = pre.cs.iter().next_back() {
            if *c_max > target_c {
                panic!(
                    "{}: a sketch has c = {} > target c = {}. A sketch can only be made \
                     COARSER, never finer. Refusing.",
                    inp.path, c_max, target_c
                );
            }
        }

        let mut in_k: u64 = 0;
        let mut out_k: u64 = 0;
        let mut in_nu: u64 = 0;
        let mut out_nu: u64 = 0;
        let mut expected_out: f64 = 0.0;
        let mut below = 0usize;
        let mut floor_dropped = 0usize;

        for mut sk in sketches {
            in_k += sk.genome_kmers.len() as u64;
            expected_out += sk.genome_kmers.len() as f64 * (sk.c as f64 / target_c as f64);
            sk.genome_kmers.retain(|h| *h < thr);
            out_k += sk.genome_kmers.len() as u64;

            let nu = sk
                .pseudotax_tracked_nonused_kmers
                .as_mut()
                .expect("audited above");
            in_nu += nu.len() as u64;
            nu.retain(|h: &Kmer| *h < thr);
            out_nu += nu.len() as u64;

            sk.c = target_c;

            if min_kmers > 0 && sk.genome_kmers.len() < min_kmers {
                below += 1;
                if !keep_below_min {
                    // Not a filter for tidiness: below --min-number-kmers,
                    // contain.rs::get_stats returns None, so this genome is
                    // undetectable by profile(). Keeping it would ship dead
                    // weight that no run can ever report.
                    floor_dropped += 1;
                    if dropped_names.len() < 200 {
                        dropped_names.push(format!(
                            "{}\t{}\t{}",
                            sk.file_name,
                            inp.label,
                            sk.genome_kmers.len()
                        ));
                    }
                    continue;
                }
            }

            if let Some(prev) = seen_files.insert(sk.file_name.clone(), inp.label.clone()) {
                let msg = format!(
                    "genome file name {} appears in both {} and {}",
                    sk.file_name, prev, inp.label
                );
                if biome_tsv.is_some() {
                    panic!(
                        "{} — and --biome-tsv was asked for, so the table would carry two rows \
                         for one genome and every downstream join would double-count it. \
                         Refusing.",
                        msg
                    );
                }
                eprintln!("  WARN: {}; the merged database holds it twice.", msg);
            }
            biome_rows.push((
                sk.file_name.clone(),
                inp.label.clone(),
                sk.first_contig_name.clone(),
                sk.genome_kmers.len(),
            ));
            merged.push(sk);
        }

        if let Err(e) = ratio_verdict(&inp.label, out_k, expected_out) {
            fatal.push(e);
        }

        n_below_min += below;
        n_dropped_floor += floor_dropped;
        total_in_kmers += in_k;
        total_out_kmers += out_k;
        eprintln!(
            "{:<20} {:>6} sketches (-{} not in keep-list, -{} under the {}-kmer floor)  \
             kmers {:>12} -> {:>11} ({:.2}x, {:.2}x due)  nonused {:>12} -> {:>11}",
            inp.label,
            n - dropped - floor_dropped,
            dropped,
            floor_dropped,
            min_kmers,
            in_k,
            out_k,
            if out_k > 0 { in_k as f64 / out_k as f64 } else { f64::NAN },
            if expected_out > 0.0 { in_k as f64 / expected_out } else { f64::NAN },
            in_nu,
            out_nu,
        );
    }

    eprintln!(
        "\nTOTAL {} sketches, genome_kmers {} -> {} ({:.2}x). {} sketches ended below {} kmers, \
         {} of them dropped ({}).",
        merged.len(),
        total_in_kmers,
        total_out_kmers,
        if total_out_kmers > 0 {
            total_in_kmers as f64 / total_out_kmers as f64
        } else {
            f64::NAN
        },
        n_below_min,
        min_kmers,
        n_dropped_floor,
        if keep_below_min {
            "--keep-below-min: kept, and undetectable by profile()"
        } else {
            "below profile()'s --min-number-kmers, get_stats() would return None"
        }
    );
    for d in dropped_names.iter().take(20) {
        eprintln!("  dropped: {}", d);
    }
    if dropped_names.len() > 20 {
        eprintln!("  ... and {} more", dropped_names.len() - 20);
    }

    if !fatal.is_empty() {
        for f in &fatal {
            eprintln!("FATAL {}", f);
        }
        return 1;
    }

    // Audit the result, not just the inputs: this is the file that ships.
    let post = audit(&merged, min_kmers);
    let problems = audit_problems(&post, biome_tsv.is_some());
    if !problems.is_empty() {
        for p in &problems {
            eprintln!("FATAL output database fails the audit: {}", p);
        }
        return 1;
    }
    eprintln!("{}", stats_line("RESULT", &post, min_kmers, true));

    if dry_run {
        eprintln!("--dry-run: nothing written.");
        return 0;
    }

    let out = out.unwrap();
    let f = File::create(&out).unwrap_or_else(|e| panic!("cannot create {}: {}", out, e));
    let w = BufWriter::with_capacity(16 << 20, f);
    bincode::serialize_into(w, &merged).expect("bincode serialise failed");
    let sz = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
    eprintln!("wrote {} ({} bytes, {:.1} MB)", out, sz, sz as f64 / 1e6);

    if let Some(tsv) = biome_tsv {
        let f = File::create(&tsv).unwrap_or_else(|e| panic!("cannot create {}: {}", tsv, e));
        let mut w = BufWriter::new(f);
        writeln!(w, "genome_file\tbiome\tfirst_contig\tn_kmers").unwrap();
        for (g, b, c, n) in &biome_rows {
            writeln!(w, "{}\t{}\t{}\t{}", g, b, c, n).unwrap();
        }
        eprintln!("wrote {} ({} rows)", tsv, biome_rows.len());
    }
    0
}

fn load(path: &str) -> Vec<GenomeSketch> {
    let f = File::open(path).unwrap_or_else(|e| panic!("cannot open {}: {}", path, e));
    let r = BufReader::with_capacity(16 << 20, f);
    bincode::deserialize_from(r).unwrap_or_else(|e| panic!("{} is not a valid .syldb: {}", path, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    // --- fixtures ----------------------------------------------------------

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("syldb-reduce-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn sketch(name: &str, c: usize, genome: Vec<u64>, nonused: Vec<u64>) -> GenomeSketch {
        GenomeSketch {
            genome_kmers: genome,
            pseudotax_tracked_nonused_kmers: Some(nonused),
            file_name: name.to_string(),
            first_contig_name: format!("{}_contig_1", name),
            c,
            k: 31,
            gn_size: 1_000_000,
            min_spacing: 30,
        }
    }

    /// Deterministic hashes uniform on [0, max), by splitmix64. Stands in for
    /// mm_hash64 output: all the tool cares about is that the values are
    /// uniform over the whole interval — a generator whose output tops out
    /// below `max` would make every reduction look lossless.
    fn uniform(n: usize, max: u64, seed: u64) -> Vec<u64> {
        let mut s = seed;
        (0..n)
            .map(|_| {
                s = s.wrapping_add(0x9E37_79B9_7F4A_7C15);
                let mut z = s;
                z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
                z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
                z ^= z >> 31;
                z % max
            })
            .collect()
    }

    #[test]
    fn the_fixture_generator_actually_spans_the_interval() {
        let max = audit_threshold(200);
        let v = uniform(20_000, max, 99);
        let hi = v.iter().copied().max().unwrap();
        assert!(hi > max - max / 500, "generator tops out at {} of {}", hi, max);
        let below = v.iter().filter(|h| **h < audit_threshold(2000)).count();
        assert!((1_700..2_300).contains(&below), "1/10 expected, got {}", below);
    }

    fn write_db(path: &Path, sk: &[GenomeSketch]) {
        let f = File::create(path).unwrap();
        bincode::serialize_into(BufWriter::new(f), &sk.to_vec()).unwrap();
    }

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    // --- 1. the threshold constants, pinned --------------------------------

    /// Guards BOTH thresholds against the mutation the review demonstrated
    /// (`threshold()` returning twice u64::MAX/c, which the old self-referential
    /// `--check` could not see). Literals, computed by hand, not by the code
    /// under test.
    #[test]
    fn pinned_thresholds() {
        for (c, want) in [
            (200usize, 92_233_720_368_547_758u64),
            (1000, 18_446_744_073_709_551),
            (2000, 9_223_372_036_854_775),
            (4000, 4_611_686_018_427_387),
            (8000, 2_305_843_009_213_693),
        ] {
            assert_eq!(threshold(c), want, "threshold({})", c);
            assert_eq!(audit_threshold(c), want, "audit_threshold({})", c);
        }
    }

    // --- 2. --check must FAIL, with a non-zero exit ------------------------

    #[test]
    fn check_exits_nonzero_on_violating_genome_kmers() {
        let d = tmpdir("chk-genome");
        let p = d.join("bad.syldb");
        // Declared c=2000, but holds hashes only legal at c=1000: exactly the
        // file a doubled threshold() would write.
        let mut g = uniform(500, audit_threshold(2000), 7);
        g.push(audit_threshold(2000) + 1);
        write_db(&p, &[sketch("g1.fna", 2000, g, vec![1, 2, 3])]);
        let code = run(&args(&["--check", p.to_str().unwrap()]));
        assert_eq!(code, 1, "--check must exit 1 when the invariant is violated");
    }

    #[test]
    fn check_exits_nonzero_on_violating_pseudotax_only() {
        // The old inline check looked at genome_kmers only.
        let d = tmpdir("chk-pseudo");
        let p = d.join("bad.syldb");
        let g = uniform(500, audit_threshold(2000), 11);
        let nu = vec![audit_threshold(2000), audit_threshold(2000) + 99];
        write_db(&p, &[sketch("g1.fna", 2000, g, nu)]);
        assert_eq!(run(&args(&["--check", p.to_str().unwrap()])), 1);
    }

    #[test]
    fn check_exits_zero_on_a_clean_database() {
        let d = tmpdir("chk-ok");
        let p = d.join("ok.syldb");
        write_db(
            &p,
            &[
                sketch("g1.fna", 2000, uniform(500, audit_threshold(2000), 3), uniform(20, audit_threshold(2000), 4)),
                sketch("g2.fna", 2000, uniform(300, audit_threshold(2000), 5), uniform(10, audit_threshold(2000), 6)),
            ],
        );
        assert_eq!(run(&args(&["--check", p.to_str().unwrap()])), 0);
    }

    #[test]
    fn check_exits_nonzero_on_mixed_k_and_on_duplicates() {
        let d = tmpdir("chk-mixed");
        let p = d.join("mixed.syldb");
        let mut a = sketch("g1.fna", 2000, uniform(200, audit_threshold(2000), 1), vec![]);
        let mut b = sketch("g1.fna", 2000, uniform(200, audit_threshold(2000), 2), vec![]);
        a.k = 31;
        b.k = 21;
        write_db(&p, &[a, b]);
        assert_eq!(run(&args(&["--check", p.to_str().unwrap()])), 1);
        let au = audit(&load(p.to_str().unwrap()), 50);
        let probs = audit_problems(&au, true).join(" | ");
        assert!(probs.contains("mixed k"), "{}", probs);
        assert!(probs.contains("duplicate file_name"), "{}", probs);
    }

    #[test]
    fn audit_never_delegates_to_the_function_it_audits() {
        // Structural: the auditor's threshold is its own. If someone rewrites
        // audit_threshold as a call to threshold(), this still passes — which
        // is why pinned_thresholds() exists as well. What this pins is that the
        // auditor flags a hash the *applied* threshold of a coarser c would
        // have let through.
        let sk = sketch("g.fna", 2000, vec![audit_threshold(2000)], vec![]);
        let a = audit(&[sk], 50);
        assert_eq!(a.violations_genome, 1);
        assert!(!audit_problems(&a, true).is_empty());
    }

    // --- 3. the reduction-ratio guard --------------------------------------

    #[test]
    fn ratio_guard_accepts_an_honest_reduction() {
        let d = tmpdir("ratio-ok");
        let p = d.join("in.syldb");
        let out = d.join("out.syldb");
        write_db(
            &p,
            &[sketch(
                "g1.fna",
                200,
                uniform(20_000, audit_threshold(200), 21),
                uniform(2_000, audit_threshold(200), 22),
            )],
        );
        let code = run(&args(&[
            "--c", "2000", "--out", out.to_str().unwrap(), "--min-kmers", "0",
            p.to_str().unwrap(),
        ]));
        assert_eq!(code, 0);
        let got = load(out.to_str().unwrap());
        assert_eq!(got[0].c, 2000);
        assert!(got[0].genome_kmers.iter().all(|h| *h < audit_threshold(2000)));
        // ~2000 expected out of 20000
        assert!((1500..2500).contains(&got[0].genome_kmers.len()), "{}", got[0].genome_kmers.len());
    }

    #[test]
    fn ratio_guard_refuses_a_database_whose_c_does_not_describe_its_hashes() {
        // Every hash already below u64::MAX/2000 but the sketch claims c=200:
        // reducing to c=2000 would keep 100% where 10% is due. That is the
        // shape a wrong threshold produces, and nothing else in the tool sees
        // it — every individual hash is perfectly legal for c=200.
        let d = tmpdir("ratio-bad");
        let p = d.join("in.syldb");
        let out = d.join("out.syldb");
        write_db(
            &p,
            &[sketch(
                "g1.fna",
                200,
                uniform(20_000, audit_threshold(2000), 31),
                vec![],
            )],
        );
        let code = run(&args(&[
            "--c", "2000", "--out", out.to_str().unwrap(), "--min-kmers", "0",
            p.to_str().unwrap(),
        ]));
        assert_eq!(code, 1, "the ratio guard must refuse this");
        assert!(!out.exists(), "nothing may be written when the guard fires");
    }

    #[test]
    fn ratio_verdict_arithmetic() {
        assert!(ratio_verdict("x", 2000, 2000.0).is_ok());
        assert!(ratio_verdict("x", 2090, 2000.0).is_ok()); // binomial noise
        assert!(ratio_verdict("x", 4000, 2000.0).is_err()); // the 2x mutant
        assert!(ratio_verdict("x", 1000, 2000.0).is_err()); // a too-strict threshold
        assert!(ratio_verdict("x", 90, 10.0).is_ok()); // too small to judge
    }

    // --- 4. --min-kmers really drops ---------------------------------------

    #[test]
    fn min_kmers_drops_the_undetectable_sketches() {
        let d = tmpdir("floor");
        let p = d.join("in.syldb");
        let out = d.join("out.syldb");
        let tsv = d.join("biome.tsv");
        write_db(
            &p,
            &[
                sketch("big.fna", 200, uniform(20_000, audit_threshold(200), 41), vec![]),
                // ~30 survivors: under the 50-kmer floor, invisible to profile()
                sketch("tiny.fna", 200, uniform(300, audit_threshold(200), 42), vec![]),
            ],
        );
        let code = run(&args(&[
            "--c", "2000", "--out", out.to_str().unwrap(),
            "--biome-tsv", tsv.to_str().unwrap(),
            p.to_str().unwrap(),
        ]));
        assert_eq!(code, 0);
        let got = load(out.to_str().unwrap());
        assert_eq!(got.len(), 1, "the sub-floor sketch must not be written");
        assert_eq!(got[0].file_name, "big.fna");
        let table = std::fs::read_to_string(&tsv).unwrap();
        assert!(!table.contains("tiny.fna"), "dropped genomes must leave the biome table too");
    }

    #[test]
    fn keep_below_min_preserves_the_old_behaviour() {
        let d = tmpdir("floor-keep");
        let p = d.join("in.syldb");
        let out = d.join("out.syldb");
        write_db(
            &p,
            &[
                sketch("big.fna", 200, uniform(20_000, audit_threshold(200), 41), vec![]),
                sketch("tiny.fna", 200, uniform(300, audit_threshold(200), 42), vec![]),
            ],
        );
        let code = run(&args(&[
            "--c", "2000", "--out", out.to_str().unwrap(), "--keep-below-min",
            p.to_str().unwrap(),
        ]));
        assert_eq!(code, 0);
        assert_eq!(load(out.to_str().unwrap()).len(), 2);
    }

    // --- 5. merge homogeneity and duplicate names --------------------------

    #[test]
    #[should_panic(expected = "cannot merge")]
    fn merging_two_different_k_panics() {
        let d = tmpdir("merge-k");
        let (p1, p2) = (d.join("a.syldb"), d.join("b.syldb"));
        let a = sketch("a.fna", 200, uniform(2000, audit_threshold(200), 51), vec![]);
        let mut b = sketch("b.fna", 200, uniform(2000, audit_threshold(200), 52), vec![]);
        b.k = 21;
        write_db(&p1, &[a]);
        write_db(&p2, &[b]);
        run(&args(&[
            "--c", "2000", "--dry-run", "--min-kmers", "0",
            p1.to_str().unwrap(), p2.to_str().unwrap(),
        ]));
    }

    #[test]
    #[should_panic(expected = "cannot merge")]
    fn merging_two_different_min_spacing_panics() {
        let d = tmpdir("merge-ms");
        let (p1, p2) = (d.join("a.syldb"), d.join("b.syldb"));
        let a = sketch("a.fna", 200, uniform(2000, audit_threshold(200), 53), vec![]);
        let mut b = sketch("b.fna", 200, uniform(2000, audit_threshold(200), 54), vec![]);
        b.min_spacing = 50;
        write_db(&p1, &[a]);
        write_db(&p2, &[b]);
        run(&args(&[
            "--c", "2000", "--dry-run", "--min-kmers", "0",
            p1.to_str().unwrap(), p2.to_str().unwrap(),
        ]));
    }

    #[test]
    #[should_panic(expected = "--biome-tsv was asked for")]
    fn duplicate_genome_name_with_biome_tsv_panics() {
        let d = tmpdir("dup");
        let (p1, p2) = (d.join("a.syldb"), d.join("b.syldb"));
        write_db(&p1, &[sketch("shared.fna", 200, uniform(2000, audit_threshold(200), 55), vec![])]);
        write_db(&p2, &[sketch("shared.fna", 200, uniform(2000, audit_threshold(200), 56), vec![])]);
        run(&args(&[
            "--c", "2000", "--out", d.join("o.syldb").to_str().unwrap(),
            "--biome-tsv", d.join("t.tsv").to_str().unwrap(),
            "--min-kmers", "0",
            &format!("one={}", p1.to_str().unwrap()),
            &format!("two={}", p2.to_str().unwrap()),
        ]));
    }

    // --- 6. what the docs must keep saying ---------------------------------

    #[test]
    fn help_states_the_unnamed_genome_limit() {
        let h = usage_text();
        assert!(
            h.contains("41.1%") && h.contains("species name"),
            "--help must carry the unnamed-genome limit and its figure:\n{}",
            h
        );
        assert!(h.contains("DROP sketches"), "--min-kmers must announce that it drops");
    }

    // --- 7. the machine-readable stats line the manifest is built from -----

    #[test]
    fn stats_line_carries_the_manifest_fields() {
        let sks = [
            sketch("a.fna", 2000, uniform(100, audit_threshold(2000), 61), vec![]),
            sketch("b.fna", 2000, uniform(3, audit_threshold(2000), 62), vec![]),
        ];
        let a = audit(&sks, 50);
        assert_eq!(a.below_floor, 1);
        assert_eq!(a.min_genome_kmers, 3);
        let line = stats_line("lbl", &a, 50, false);
        for field in ["n=2", "c=2000", "k=31", "min_genome_kmers=3", "floor=50", "below_floor=1"] {
            assert!(line.contains(field), "missing {} in {}", field, line);
        }
    }
}
