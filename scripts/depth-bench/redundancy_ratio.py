#!/usr/bin/env python3
"""The functional-redundancy claim of §4, expressed so that the two halves compare.

    python3 scripts/depth-bench/redundancy_ratio.py

§4 reports 0.326 within a donor against 0.734 between taxonomically, and 0.184
against 0.231 functionally, and reads the second pair as functional redundancy.
§3.3 sets 0.204 functional beside 0.791 taxonomic the same way. A reviewer
objected that those magnitudes come from different spaces — 468 taxonomic rows
against thousands of orthologs — and that the note itself supplies the reason
they cannot be compared, one sentence later, when it says the coarser roll-ups
compress the distances further. It never applies that reason to the comparison
it just made.

The objection is right about the magnitudes and wrong about the conclusion, and
the way to show both is to stop comparing bare distances. A Bray-Curtis mean is
a property of the feature space it was computed in; the SEPARATION between the
within-donor and between-donor distributions is a property of the biology, and
survives being measured in a compressed space. So this recomputes the claim
three ways that do not depend on the scale of the axis:

  ratio        mean between / mean within — unitless by construction
  Cohen's d    the same gap in units of the pooled standard deviation
  AUC          P(a between-donor pair is more distant than a within-donor pair),
               rank-based, so any monotone rescaling of the distances leaves it
               unchanged — which is exactly what a roll-up nearly is

and runs the three functional levels the interface offers, because if the ratio
is the level-invariant statistic then it should hold still while the magnitudes
fall through the floor. That is the test of the reviewer's point, not a rebuttal
of it.

WHAT WOULD MAKE THIS WRONG

  - The 18 within-donor and 135 between-donor distances are NOT 153 independent
    observations: they are pairs drawn from 18 samples, each sample appearing in
    17 of them. Cohen's d and the AUC are therefore reported as descriptions of
    the two distance distributions, never as tests, and the p-values come from
    permuting DONOR LABELS over samples — the PERMANOVA argument, in which the
    exchangeable unit is the sample — rather than from any table. todo.md flags
    the same trap for the "93-97% explained by donor" figure.
  - The roll-ups are not partitions. A KO in three modules is counted in all
    three (kegg.js explains why: splitting it would make a well-connected module
    look rare), so the module and pathway spaces double-count, and their row
    counts are not a smaller alphabet for the same signal. That is a reason the
    magnitudes shift, and it is the confound being measured, not a bug.
  - Orthologs reaching no module are dropped by both roll-ups, as in the
    interface, which renormalises what is left. Including them instead as a
    single bucket halves every module and pathway distance (measured below) —
    the strongest single demonstration that these magnitudes are conventions.
    The reproduction check confirms the paper's convention is the dropping one.
  - Bray-Curtis is unnormalised here, as in web/cluster.js. It is invariant to a
    common scaling of both vectors, so the taxonomic profile summing to 100 and
    the functional one to 1 does not affect any number printed.
  - Six donors, three samples each, one study. Nothing here says how these
    quantities behave in a cohort that is not this one.

Reads only web/demo/gut-demo.session.json (which carries both halves: `matrix`
taxonomically and `funcProfiles` as measured KOs), its groups CSV, and the KEGG
map the page ships. No database, no profiler, no network.
"""
import itertools
import json
import math
import os
import random
import statistics as st

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SESSION = os.path.join(ROOT, "web/demo/gut-demo.session.json")
GROUPS = os.path.join(ROOT, "web/demo/gut-demo.groups.csv")
KO_MAP = os.path.join(ROOT, "web/db/kegg/ko-map.json")

NO_PATHWAY = "_none"          # kegg.js's own bucket for modules on no KEGG map
PERMUTATIONS = 9999
SEED = 20260816

# What §4 and §3.3 currently print. Recomputing them is the licence to
# reinterpret them: if this script cannot reproduce the published pair it is
# measuring something else, and its ratios say nothing about the paper.
PUBLISHED = {
    "taxonomic (species)": (0.326, 0.734),
    "functional (orthologs)": (0.184, 0.231),
    "functional (modules)": (0.087, 0.111),
    "functional (pathways)": (0.031, 0.040),
}


def bray_curtis(a, b):
    """web/cluster.js brayCurtis, over sparse vectors: 0 identical, 1 disjoint."""
    sum_min = sum_all = 0.0
    for key in a.keys() | b.keys():
        x, y = a.get(key, 0.0), b.get(key, 0.0)
        sum_min += min(x, y)
        sum_all += x + y
    return 0.0 if sum_all == 0 else 1.0 - 2.0 * sum_min / sum_all


def load():
    session = json.load(open(SESSION))
    samples = session["samples"]
    donor = {}
    for line in open(GROUPS).read().splitlines()[1:]:
        if line.strip():
            sample, group = line.split(",")
            donor[sample] = group
    return session, samples, donor, json.load(open(KO_MAP))


def taxonomic_vectors(session, samples):
    """Species rows of the session matrix, dropping the `species` name field."""
    return {
        s: {row: cols[s] for row, cols in session["matrix"].items() if cols.get(s, 0) > 0}
        for s in samples
    }


def module_vectors(profiles, samples, ko_map, keep_unassigned=False):
    """kegg.js moduleTable: a KO's abundance goes WHOLE into each of its modules."""
    out = {}
    for s in samples:
        vec, unassigned = {}, 0.0
        for ko, value in profiles[s].items():
            mods = ko_map["koModules"].get(ko)
            if not mods:
                unassigned += value
                continue
            for m in mods:
                vec[m] = vec.get(m, 0.0) + value
        if keep_unassigned:
            vec["_unassigned"] = unassigned
        out[s] = vec
    return out


def pathway_vectors(profiles, samples, ko_map, keep_unassigned=False):
    """kegg.js pathwayRollup: each ortholog counts ONCE per map it reaches."""
    modules = ko_map["modules"]
    out = {}
    for s in samples:
        vec, unassigned = {}, 0.0
        for ko, value in profiles[s].items():
            mods = ko_map["koModules"].get(ko)
            if not mods:
                unassigned += value
                continue
            paths = set()
            for m in mods:
                paths.update(modules.get(m, {}).get("p") or [])
            # Only when no map shows the ortholog at all, never merely because
            # one of its modules is off-map.
            for p in (paths or {NO_PATHWAY}):
                vec[p] = vec.get(p, 0.0) + value
        if keep_unassigned:
            vec["_unassigned"] = unassigned
        out[s] = vec
    return out


def pair_distances(vectors, samples):
    """Every unordered pair once, as (sample_a, sample_b, distance)."""
    return [(a, b, bray_curtis(vectors[a], vectors[b]))
            for a, b in itertools.combinations(samples, 2)]


def split(pairs, donor):
    within = [d for a, b, d in pairs if donor[a] == donor[b]]
    between = [d for a, b, d in pairs if donor[a] != donor[b]]
    return within, between


def cohens_d(within, between):
    """Gap in pooled-SD units. Unitless, so it crosses feature spaces."""
    n1, n2 = len(within), len(between)
    v1, v2 = st.variance(within), st.variance(between)
    pooled = math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2))
    return (st.mean(between) - st.mean(within)) / pooled, pooled


def auc(within, between):
    """P(between > within), ties at a half — the Mann-Whitney common-language
    effect size. Rank-based, so it is blind to any monotone rescaling of the
    distances, which is nearly what a roll-up does to them."""
    wins = 0.0
    for w in within:
        for b in between:
            wins += 1.0 if b > w else 0.5 if b == w else 0.0
    return wins / (len(within) * len(between))


def permutation_null(pairs, donor, samples, rng):
    """Shuffle donor labels over samples; the sample is the exchangeable unit.

    One pass builds the null for BOTH statistics, and the nulls are returned
    rather than reduced to a p-value on the spot: a p at the 1/(n+1) floor says
    only "off the end of the null", and what the reader needs beside it is where
    that end was. A ratio of 1.27 is unimpressive until the best of ten thousand
    random groupings of the same samples reaches 1.06.
    """
    labels = [donor[s] for s in samples]
    ratios, ds = [], []
    for _ in range(PERMUTATIONS):
        rng.shuffle(labels)
        fake = dict(zip(samples, labels))
        w, bt = [], []
        for a, b, dist in pairs:
            (w if fake[a] == fake[b] else bt).append(dist)
        ratios.append(st.mean(bt) / st.mean(w))
        ds.append(cohens_d(w, bt)[0])
    return ratios, ds


def p_value(null, observed):
    """(r+1)/(n+1), one-sided. Cannot report 0, which would be a lie."""
    return (sum(1 for x in null if x >= observed) + 1) / (len(null) + 1)


def describe(name, vectors, samples, donor, rng, published=None):
    pairs = pair_distances(vectors, samples)
    within, between = split(pairs, donor)
    mean_w, mean_b = st.mean(within), st.mean(between)
    ratio = mean_b / mean_w
    d, pooled = cohens_d(within, between)
    a = auc(within, between)
    rows = len({k for v in vectors.values() for k in v})
    per_sample = st.mean([len(v) for v in vectors.values()])

    print(f"\n{name}")
    print(f"  rows in the space          {rows}  (mean {per_sample:.0f} present per sample)")
    print(f"  mean within-donor          {mean_w:.3f}   ({len(within)} pairs)")
    print(f"  mean between-donor         {mean_b:.3f}   ({len(between)} pairs)")
    if published:
        pw, pb = published
        ok = abs(mean_w - pw) < 5e-4 and abs(mean_b - pb) < 5e-4
        print(f"  paper prints               {pw:.3f} / {pb:.3f}"
              f"   {'reproduced' if ok else 'DOES NOT MATCH'}")
    print(f"  ratio between/within       {ratio:.3f}")
    print(f"  pooled SD                  {pooled:.3f}")
    print(f"  Cohen's d                  {d:.2f}")
    print(f"  AUC P(between > within)    {a:.3f}")
    print(f"  largest within             {max(within):.3f}")
    print(f"  smallest between           {min(between):.3f}"
          f"   -> {'a threshold separates them' if min(between) > max(within) else 'the distributions overlap'}")

    null_ratio, null_d = permutation_null(pairs, donor, samples, rng)
    p_ratio, p_d = p_value(null_ratio, ratio), p_value(null_d, d)
    print(f"  permutation p (ratio)      {p_ratio:.4f}   ({PERMUTATIONS} shuffles of the donor labels)")
    print(f"  permutation p (Cohen's d)  {p_d:.4f}")
    print(f"  null ratio, best of {PERMUTATIONS}   {max(null_ratio):.3f}"
          f"   (95th pct {sorted(null_ratio)[int(0.95 * PERMUTATIONS)]:.3f},"
          f" observed {ratio:.3f})")
    return dict(name=name, rows=rows, mean_w=mean_w, mean_b=mean_b, ratio=ratio,
                d=d, auc=a, p=p_ratio)


BENCH = os.path.join(ROOT, "data/bench/out")
BENCH_SAMPLES = ["ERR14098640", "ERR14098646", "ERR14098649"]
CAP, DEEP = 3000000, 6500000


def bench_taxonomic(sample, depth):
    """UHGG taxonomic abundance per genome, from the sylph TSV of that rung."""
    profile = {}
    path = os.path.join(BENCH, sample, "sylph", f"{sample}_d{depth}.uhgg.tsv")
    with open(path) as fh:
        next(fh)
        for line in fh:
            cols = line.rstrip("\n").split("\t")
            genome = os.path.basename(cols[1])
            profile[genome] = profile.get(genome, 0.0) + float(cols[2])
    return profile


def bench_functional(sample, depth):
    path = os.path.join(BENCH, sample, "func", f"{sample}_d{depth}.json")
    return json.load(open(path))["profile"]


def section_3_3():
    """§3.3's version of the claim, given each space its own yardstick.

    §3.3 compares 0.204 functional against 0.791 taxonomic across three
    unrelated runs. No ratio can be built from that pair the way §4's can: there
    is no within-group baseline, because there are no groups — three samples,
    one each. But §3.3 does carry a natural reference distance IN EACH SPACE,
    and it is already in the paper for the taxonomic half: how far a capped
    profile sits from the same sample profiled at twice the depth. That is the
    distance that means "no biological difference at all", measured in the units
    of whichever space it was measured in, and dividing by it is the same
    correction as §4's ratio.
    """
    print("\n\n" + "=" * 78)
    print("§3.3 - the same claim on three unrelated runs, normalised per space")
    print(f"source   {os.path.relpath(BENCH, ROOT)}, {len(BENCH_SAMPLES)} runs")
    print(f"         signal = mean distance between two different samples at the {CAP // 1000000} M cap")
    print(f"         noise  = mean distance from a sample to ITSELF at {DEEP / 1e6:.1f} M pairs")
    print(f"\n{'space':<22}{'noise':>8}{'signal':>9}{'signal/noise':>14}")
    rows = []
    for name, reader in (("taxonomic (UHGG)", bench_taxonomic),
                         ("functional (KO)", bench_functional)):
        noise = [bray_curtis(reader(s, CAP), reader(s, DEEP)) for s in BENCH_SAMPLES]
        signal = [bray_curtis(reader(a, CAP), reader(b, CAP))
                  for a, b in itertools.combinations(BENCH_SAMPLES, 2)]
        mean_n, mean_s = st.mean(noise), st.mean(signal)
        print(f"{name:<22}{mean_n:>8.3f}{mean_s:>9.3f}{mean_s / mean_n:>14.1f}x")
        rows.append((name, mean_n, mean_s, mean_s / mean_n))
    print(f"\n  taxonomic per-sample noise   "
          f"{[round(bray_curtis(bench_taxonomic(s, CAP), bench_taxonomic(s, DEEP)), 3) for s in BENCH_SAMPLES]}")
    print(f"  functional per-sample noise  "
          f"{[round(bray_curtis(bench_functional(s, CAP), bench_functional(s, DEEP)), 3) for s in BENCH_SAMPLES]}")
    print("\n  The paper reads 0.204 < 0.791 as the redundancy result arrived at from")
    print("  three unrelated samples. Against each space's OWN depth noise the")
    print("  direction reverses: the functional signal is the weaker of the two")
    print("  relative to what the measurement can resolve.")
    return rows


def main():
    session, samples, donor, ko_map = load()
    rng = random.Random(SEED)
    profiles = session["funcProfiles"]

    print("EXPERIMENT 3 - the redundancy claim as ratios and effect sizes")
    print(f"source   {os.path.relpath(SESSION, ROOT)}")
    print(f"         {len(samples)} samples, {len(set(donor.values()))} donors,"
          f" {session['ref']['label']} / {session['ref']['catalogue']}")
    print(f"         functional half present in the session: "
          f"funcProfiles for {len(profiles)} samples, measured KOs")
    print(f"metric   Bray-Curtis, web/cluster.js, unnormalised")

    results = [
        describe("taxonomic (species)", taxonomic_vectors(session, samples),
                 samples, donor, rng, PUBLISHED["taxonomic (species)"]),
        describe("functional (orthologs)", profiles,
                 samples, donor, rng, PUBLISHED["functional (orthologs)"]),
        describe("functional (modules)", module_vectors(profiles, samples, ko_map),
                 samples, donor, rng, PUBLISHED["functional (modules)"]),
        describe("functional (pathways)", pathway_vectors(profiles, samples, ko_map),
                 samples, donor, rng, PUBLISHED["functional (pathways)"]),
    ]

    print("\n\nSUMMARY - what changes with the feature space and what does not")
    print(f"{'space':<24}{'rows':>7}{'within':>9}{'between':>9}"
          f"{'ratio':>8}{'d':>7}{'AUC':>7}{'p':>9}")
    for r in results:
        print(f"{r['name']:<24}{r['rows']:>7}{r['mean_w']:>9.3f}{r['mean_b']:>9.3f}"
              f"{r['ratio']:>8.2f}{r['d']:>7.2f}{r['auc']:>7.3f}{r['p']:>9.4f}")

    tax, orth = results[0], results[1]
    func = results[1:]
    print(f"\nmagnitude, taxonomic / ortholog:   "
          f"{tax['mean_b'] / orth['mean_b']:.2f}x on the between-donor mean")
    print(f"magnitude across functional levels: "
          f"{max(f['mean_b'] for f in func) / min(f['mean_b'] for f in func):.2f}x"
          f"  (orthologs {orth['mean_b']:.3f} -> pathways {func[-1]['mean_b']:.3f})")
    print(f"ratio across functional levels:     "
          f"{min(f['ratio'] for f in func):.2f} to {max(f['ratio'] for f in func):.2f}"
          f"  against {tax['ratio']:.2f} taxonomically")
    print(f"Cohen's d across functional levels: "
          f"{min(f['d'] for f in func):.2f} to {max(f['d'] for f in func):.2f}"
          f"  against {tax['d']:.2f} taxonomically")

    # The dropped-orthologs convention, priced. If changing a bookkeeping choice
    # moves the magnitudes as far as the roll-up itself does, the magnitudes were
    # never the comparable quantity.
    print("\n\nHOW MUCH OF THE MAGNITUDE IS CONVENTION")
    print("Orthologs in no module are dropped by both roll-ups (as in the interface).")
    print("Keeping them as one bucket instead, same data, same metric:")
    print(f"{'space':<26}{'within':>9}{'between':>9}{'ratio':>8}{'d':>7}{'AUC':>7}")
    for label, builder in (("modules", module_vectors), ("pathways", pathway_vectors)):
        for keep in (False, True):
            vec = builder(profiles, samples, ko_map, keep_unassigned=keep)
            w, b = split(pair_distances(vec, samples), donor)
            name = f"{label}, {'unassigned kept' if keep else 'dropped (paper)'}"
            print(f"{name:<26}{st.mean(w):>9.3f}{st.mean(b):>9.3f}"
                  f"{st.mean(b) / st.mean(w):>8.2f}{cohens_d(w, b)[0]:>7.2f}"
                  f"{auc(w, b):>7.3f}")

    section_3_3()


if __name__ == "__main__":
    main()
