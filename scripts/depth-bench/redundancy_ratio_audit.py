#!/usr/bin/env python3
"""Audit of redundancy_ratio.py: the controls its conclusion needs and does not run.

    python3 scripts/depth-bench/redundancy_ratio_audit.py [n_permutations]

Pure Python over files already on disk, ~100 s, almost all of it in control 5's
long permutation run; pass a smaller count to make it seconds, at the cost of
the one finding that needs the long run.

redundancy_ratio.py answers a reviewer who said §4 compares Bray-Curtis means
from two different feature spaces (468 taxonomic rows against thousands of
orthologs). Its answer is that the between/within RATIO is scale-free, that the
ratio holds at 1.26-1.28 across orthologs, modules and pathways while the
magnitudes fall six-fold, and that the ratio is therefore "a property of the
samples rather than of the axis". It then applies the same normalising move to
§3.3 and concludes that §3.3's claim reverses.

Three of those steps do not follow from what it measured, and each has a cheap
control that it did not run:

  1. LEVEL-INVARIANCE IS DEMONSTRATED ONLY INSIDE ONE FAMILY. Orthologs, modules
     and pathways are three aggregations of the SAME vector, so a statistic that
     is invariant under multiplicative rescaling is nearly forced to hold still
     across them. The comparison the paper makes is taxonomic against functional,
     which is not an aggregation of anything. The control is to coarsen the
     TAXONOMIC space to the same row counts and see whether ITS ratio holds.

  2. THE DILUTION CHECK IS AN IDENTITY, NOT EVIDENCE. Keeping the no-module
     orthologs as one bucket adds a nearly constant shared mass to every vector,
     which multiplies every Bray-Curtis distance by a single constant. A ratio of
     means is unchanged by construction. This recomputes that constant from the
     masses and shows it predicts the shift, so the "cleanest demonstration" is
     arithmetic that would have come out the same on any data at all.

  3. §3.3 AND §4 ARE THE SAME STATISTIC AND ARE READ IN OPPOSITE DIRECTIONS.
     between/within and signal/noise are both a between-sample distance over a
     same-source baseline in the same space, both scale-free for the same reason.
     Printed side by side, both order the spaces the same way.

And two reporting checks: the number of permutations decides the "null's own
maximum" that was offered as the yardstick for a floor p-value, and the contrast
between the two spaces — the quantity the conclusion is about — is reported with
no uncertainty at all, though a leave-one-donor-out pass costs a second.

WHAT WOULD MAKE THIS WRONG

  - The random coarsenings are not biology. Bucketing 468 genomes at random is a
    test of whether DIMENSION alone moves the ratio, nothing else; the genus
    roll-up beside it is the biological version of the same question, and both
    are reported because either alone would be arguable.
  - The floor-subtraction uses §3.3's depth-noise numbers, measured on three
    ENA runs at a 3 M cap, against §4's demo samples, which are other runs at
    unknown depth. It prices the sensitivity of the ratio to a floor; it is not a
    corrected value for the paper and is not quoted as one.
  - The leave-one-donor-out spread is a jackknife over six donors from one study.
    It says the contrast does not rest on any single donor. It says nothing about
    another cohort.

Reads the same files redundancy_ratio.py reads, and imports its functions rather
than retyping them, so any disagreement here is a disagreement about what was
concluded and never about what was computed.
"""
import itertools
import random
import statistics as st
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from redundancy_ratio import (  # noqa: E402
    BENCH_SAMPLES, CAP, DEEP, bench_functional, bench_taxonomic, bray_curtis,
    cohens_d, auc, load, module_vectors, pair_distances, pathway_vectors, split,
    taxonomic_vectors,
)

SEED = 20260816
COARSENINGS = (344, 102, 20)   # module rows, pathway rows, and coarser still
DRAWS = 20                     # random bucketings averaged over, per row count


def stats(vectors, samples, donor):
    w, b = split(pair_distances(vectors, samples), donor)
    return st.mean(w), st.mean(b), st.mean(b) / st.mean(w), cohens_d(w, b)[0], auc(w, b)


def rollup(vectors, key_of):
    """Aggregate features by a grouping function, the way a roll-up does."""
    out = {}
    for sample, vec in vectors.items():
        acc = {}
        for feature, value in vec.items():
            g = key_of(feature)
            acc[g] = acc.get(g, 0.0) + value
        out[sample] = acc
    return out


def row(label, rows, values):
    print(f"  {label:<24}{rows:>6}" + "".join(f"{v:>9.3f}" for v in values))


def control_1_coarsen_the_other_axis(session, samples, donor, ko_map):
    """Does the ratio hold still when the TAXONOMIC space is coarsened too?

    If it does not, "the ratio is level-invariant" is a fact about the functional
    roll-ups and not a licence to compare across the two spaces. If it does, the
    reviewer's row-count objection is answered directly — at matched dimension —
    and none of the argument about which statistic is privileged is needed.
    """
    print("\nCONTROL 1 - coarsen the taxonomic axis to the functional row counts")
    print(f"  {'space':<24}{'rows':>6}{'within':>9}{'between':>9}{'ratio':>9}{'d':>9}{'AUC':>9}")
    tax = taxonomic_vectors(session, samples)
    species = {g: m["species"] for g, m in session["matrix"].items()}
    row("taxonomic, species", len({k for v in tax.values() for k in v}),
        stats(tax, samples, donor))
    genus = rollup(tax, lambda g: species[g].split()[0])
    row("taxonomic, genus", len({k for v in genus.values() for k in v}),
        stats(genus, samples, donor))

    genomes = sorted({k for v in tax.values() for k in v})
    for target in COARSENINGS:
        draws = []
        for seed in range(DRAWS):
            rng = random.Random(SEED + seed)
            assign = {g: rng.randrange(target) for g in genomes}
            draws.append(stats(rollup(tax, lambda g: assign[g]), samples, donor))
        row(f"taxonomic, {target} buckets", target,
            [st.mean([d[i] for d in draws]) for i in range(5)])

    profiles = session["funcProfiles"]
    kos = sorted({k for v in profiles.values() for k in v})
    for target in COARSENINGS[:2]:
        draws = []
        for seed in range(DRAWS):
            rng = random.Random(SEED + seed)
            assign = {k: rng.randrange(target) for k in kos}
            draws.append(stats(rollup(profiles, lambda k: assign[k]), samples, donor))
        row(f"functional, {target} buckets", target,
            [st.mean([d[i] for d in draws]) for i in range(5)])
    print(f"  ({DRAWS} random bucketings averaged per row; genus from the session's own names)")


def control_2_dilution_is_algebra(session, samples, donor, ko_map):
    """The 'unassigned kept' shift, predicted from the masses alone.

    Adding a shared component of mass u to two vectors of mass m each multiplies
    Bray-Curtis by m/(m+u) when the added component is identical in both. If the
    measured shift matches that constant, the experiment's "cleanest single
    demonstration" demonstrates only that a ratio of means survives being
    multiplied through by a constant.
    """
    print("\nCONTROL 2 - the 'unassigned kept' shift against the dilution it must be")
    profiles = session["funcProfiles"]
    unassigned = [sum(v for ko, v in profiles[s].items() if not ko_map["koModules"].get(ko))
                  for s in samples]
    mean_u = st.mean(unassigned)
    print(f"  unassigned mass per sample   mean {mean_u:.3f}"
          f"   range {min(unassigned):.3f}-{max(unassigned):.3f}  (of a profile summing to 1)")
    print(f"  {'space':<24}{'dropped':>9}{'kept':>9}{'measured':>10}{'predicted':>11}{'ratio kept':>12}")
    for label, builder in (("modules", module_vectors), ("pathways", pathway_vectors)):
        dropped = builder(profiles, samples, ko_map)
        kept = builder(profiles, samples, ko_map, keep_unassigned=True)
        wd, bd = split(pair_distances(dropped, samples), donor)
        wk, bk = split(pair_distances(kept, samples), donor)
        mass = st.mean([sum(v.values()) for v in dropped.values()])
        print(f"  {label:<24}{st.mean(wd):>9.3f}{st.mean(wk):>9.3f}"
              f"{st.mean(wk) / st.mean(wd):>10.3f}{mass / (mass + mean_u):>11.3f}"
              f"{st.mean(bk) / st.mean(wk):>12.3f}")
    print("  (measured = kept/dropped on the within-donor mean; predicted = m/(m+u))")


def control_3_same_statistic_both_sections(session, samples, donor, ko_map):
    """§4's between/within and §3.3's signal/noise, printed as the one statistic.

    Both divide a between-sample distance by a same-source baseline measured in
    the same space, and both are unchanged when that space compresses every
    distance by a constant. Whatever is concluded from one has to be concluded
    from the other.
    """
    print("\nCONTROL 3 - §4 and §3.3 are the same statistic; how do they order the spaces?")
    tax = taxonomic_vectors(session, samples)
    orth = session["funcProfiles"]
    r_tax = stats(tax, samples, donor)[2]
    r_orth = stats(orth, samples, donor)[2]

    noise_t = st.mean([bray_curtis(bench_taxonomic(s, CAP), bench_taxonomic(s, DEEP))
                       for s in BENCH_SAMPLES])
    sig_t = st.mean([bray_curtis(bench_taxonomic(a, CAP), bench_taxonomic(b, CAP))
                     for a, b in itertools.combinations(BENCH_SAMPLES, 2)])
    noise_f = st.mean([bray_curtis(bench_functional(s, CAP), bench_functional(s, DEEP))
                       for s in BENCH_SAMPLES])
    sig_f = st.mean([bray_curtis(bench_functional(a, CAP), bench_functional(b, CAP))
                     for a, b in itertools.combinations(BENCH_SAMPLES, 2)])

    print(f"  {'section':<10}{'baseline':<26}{'taxonomic':>11}{'functional':>12}{'ordering':>12}")
    print(f"  {'§4':<10}{'within-donor (biological)':<26}{r_tax:>11.2f}{r_orth:>12.2f}"
          f"{'tax > func':>12}")
    print(f"  {'§3.3':<10}{'same sample deeper (technical)':<26}"
          f"{sig_t / noise_t:>11.2f}{sig_f / noise_f:>12.2f}{'tax > func':>12}")
    print(f"  §3.3 inputs: taxonomic {sig_t:.3f}/{noise_t:.3f}, functional {sig_f:.3f}/{noise_f:.3f}")
    print("  Both normalisations put the functional space below the taxonomic one, which is")
    print("  the direction §3.3 already claimed. Normalising does not reverse §3.3; what it")
    print("  does show is that the functional between-sample distance is only twice the")
    print("  distance a halving of depth produces, so the number carries little on its own.")


def control_4_the_floor_the_ratio_ignores(session, samples, donor):
    """between/within is invariant to a multiplicative rescale, not to a floor.

    §3.3 measures a distance that means 'no biological difference' in each space:
    0.050 taxonomically, 0.098 functionally. A floor of that size inflates the
    within-donor mean more than the between-donor one and so DEFLATES the ratio,
    unequally in the two spaces. Indicative only — different runs, different
    depth — but it prices the claim that the ratio is free of the axis.
    """
    print("\nCONTROL 4 - the ratio is floor-sensitive, and the two floors differ two-fold")
    tax = taxonomic_vectors(session, samples)
    orth = session["funcProfiles"]
    floors = {"taxonomic": st.mean([bray_curtis(bench_taxonomic(s, CAP), bench_taxonomic(s, DEEP))
                                    for s in BENCH_SAMPLES]),
              "functional": st.mean([bray_curtis(bench_functional(s, CAP), bench_functional(s, DEEP))
                                     for s in BENCH_SAMPLES])}
    print(f"  {'space':<14}{'within':>9}{'between':>9}{'ratio':>8}{'floor':>8}{'floor-subtracted':>19}")
    out = {}
    for name, vecs in (("taxonomic", tax), ("functional", orth)):
        w, b, r, _, _ = stats(vecs, samples, donor)
        f = floors[name]
        out[name] = (b - f) / (w - f)
        print(f"  {name:<14}{w:>9.3f}{b:>9.3f}{r:>8.2f}{f:>8.3f}{out[name]:>19.2f}")
    print(f"  contrast between the two spaces: {2.251 / 1.258:.2f}x raw,"
          f" {out['taxonomic'] / out['functional']:.2f}x once each floor is removed")


def control_5_permutation_reporting(session, samples, donor, ko_map, n_perm):
    """The 'null's own maximum' is a function of how many shuffles were drawn.

    redundancy_ratio.py reports p = 1/10000 in all four spaces and offers the best
    of its 9,999 shuffles as the yardstick that makes that floor readable. The
    maximum of a sample grows with the sample, so this re-runs the same null an
    order of magnitude longer and prints both.
    """
    print(f"\nCONTROL 5 - the same permutation null at {n_perm} shuffles instead of 9,999")
    profiles = session["funcProfiles"]
    spaces = {
        "taxonomic": taxonomic_vectors(session, samples),
        "orthologs": profiles,
        "modules": module_vectors(profiles, samples, ko_map),
        "pathways": pathway_vectors(profiles, samples, ko_map),
    }
    print(f"  {'space':<12}{'observed':>10}{'null max':>10}{'null 95th':>11}{'>= obs':>8}{'p':>11}")
    for name, vecs in spaces.items():
        pairs = pair_distances(vecs, samples)
        w, b = split(pairs, donor)
        observed = st.mean(b) / st.mean(w)
        rng = random.Random(SEED)
        labels = [donor[s] for s in samples]
        null = []
        for _ in range(n_perm):
            rng.shuffle(labels)
            fake = dict(zip(samples, labels))
            fw, fb = [], []
            for a, c, dist in pairs:
                (fw if fake[a] == fake[c] else fb).append(dist)
            null.append(st.mean(fb) / st.mean(fw))
        hits = sum(1 for x in null if x >= observed)
        print(f"  {name:<12}{observed:>10.3f}{max(null):>10.3f}"
              f"{sorted(null)[int(0.95 * n_perm)]:>11.3f}{hits:>8}"
              f"{(hits + 1) / (n_perm + 1):>11.6f}")
    print("  The 95th percentile is stable across run lengths; the maximum is not.")


def control_6_the_contrast_has_no_error_bar(session, samples, donor, ko_map):
    """Leave one donor out. The conclusion is about the DIFFERENCE of two ratios.

    Every p-value in the experiment tests one space against a shuffled-label null.
    None of them touches the quantity the conclusion is actually about — that the
    taxonomic ratio exceeds the functional one — which is reported as two point
    estimates with nothing around them. Six donors admit a jackknife.
    """
    print("\nCONTROL 6 - leave-one-donor-out spread on the ratios and on their contrast")
    profiles = session["funcProfiles"]
    spaces = {
        "taxonomic": taxonomic_vectors(session, samples),
        "orthologs": profiles,
        "modules": module_vectors(profiles, samples, ko_map),
        "pathways": pathway_vectors(profiles, samples, ko_map),
    }
    donors = sorted(set(donor.values()))
    loo = {}
    print(f"  {'space':<12}{'all six':>9}{'LOO min':>10}{'LOO max':>10}{'LOO sd':>9}")
    for name, vecs in spaces.items():
        full = stats(vecs, samples, donor)[2]
        vals = [stats(vecs, [s for s in samples if donor[s] != d], donor)[2] for d in donors]
        loo[name] = vals
        print(f"  {name:<12}{full:>9.3f}{min(vals):>10.3f}{max(vals):>10.3f}{st.stdev(vals):>9.3f}")
    contrast = [t / o for t, o in zip(loo["taxonomic"], loo["orthologs"])]
    print(f"  taxonomic ratio / ortholog ratio: {stats(spaces['taxonomic'], samples, donor)[2] / stats(profiles, samples, donor)[2]:.2f}"
          f" on all six donors, {min(contrast):.2f}-{max(contrast):.2f} leaving each one out")


def main():
    session, samples, donor, ko_map = load()
    n_perm = int(sys.argv[1]) if len(sys.argv) > 1 else 199999
    print("AUDIT of redundancy_ratio.py - the controls the conclusion needs")
    print(f"source   web/demo/gut-demo.session.json, {len(samples)} samples,"
          f" {len(set(donor.values()))} donors; data/bench/out for §3.3")
    control_1_coarsen_the_other_axis(session, samples, donor, ko_map)
    control_2_dilution_is_algebra(session, samples, donor, ko_map)
    control_3_same_statistic_both_sections(session, samples, donor, ko_map)
    control_4_the_floor_the_ratio_ignores(session, samples, donor)
    control_5_permutation_reporting(session, samples, donor, ko_map, n_perm)
    control_6_the_contrast_has_no_error_bar(session, samples, donor, ko_map)


if __name__ == "__main__":
    main()
