"""What the two contrast designs produce WHEN THE LABELS MEAN NOTHING.

    node  scripts/depth-bench/pseudoreplication_dump.mjs /tmp/page.json
    python3 scripts/depth-bench/pseudoreplication_null.py /tmp/page.json

pseudoreplication.mjs measured the two floors (2/48,620 at nine samples a side,
2/20 at three donors a side) and then counted rows under each design: 25 rows at
raw p <= 0.05 and 4 at q <= 0.1 with samples as observations, 0 and 0 with
donors as observations. Those counts were read as the evidence pseudoreplication
manufactures, and neither was checked against chance:

  * at three donors a side no p below 0.1 exists, so "0 rows at p <= 0.05" is
    forced by the floor the same script printed, whatever the data say;
  * at nine a side the expected count under the test's own null is not 5 % of
    the family — most rows are too tied to reach 0.05 at all — so what 25 has to
    be read against is a number that has to be computed rather than assumed.

So this file recomputes both designs INDEPENDENTLY of web/stats.js (an exact
integer DP over the permutation null, checked against brute-force enumeration)
and adds the numbers the counts have to be read against: the expected count
under each design's own null, obtained per row from that row's own exact null
distribution.

It then asks the question the single sex contrast cannot answer on its own. Six
donors split three-and-three twenty ways; the page would run its nine-against-
nine test on any of them. Sections (d) and (e) run all twenty, so "on this data
it happens not to matter" can be checked against the nineteen labelings where it
might have.

WHAT WOULD MAKE THIS WRONG

  * the null. Rows of a compositional table are not independent, so the expected
    counts below are exact per row and only approximate as a total; they are a
    calibration, not a test. That cuts one way only: correlation makes the
    observed count MORE variable around the expectation, never systematically
    smaller, so "fewer floor hits than chance" is not manufactured by it.
  * the p-values. If this file's DP disagreed with web/stats.js, the comparison
    would be between two different tests rather than two designs, so every p of
    both designs is compared cell by cell and the maximum difference printed.
  * the donor map and the missing-cell rule are pseudoreplication.mjs's, read
    from the same session file, so a fault there is a fault in both.
"""
import json
import subprocess
import sys
import tempfile
from itertools import combinations
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


def doubled_ranks(values):
    """Ranks with ties averaged and doubled, as web/stats.js does it."""
    order = sorted(range(len(values)), key=lambda i: values[i])
    out = [0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        for k in range(i, j + 1):
            out[order[k]] = i + j + 2
        i = j + 1
    return out


def null_counts(ranks, n1):
    """counts[s] = how many of the C(n,n1) splits give first-group rank sum s.

    Integer DP, so the counts are exact rather than merely large: the page uses
    float64 for the same table and only its ratios, and a disagreement between
    the two would show up in the cell-by-cell comparison below.
    """
    total = sum(ranks)
    table = np.zeros((n1 + 1, total + 1), dtype=np.int64)
    table[0, 0] = 1
    for r in ranks:
        for k in range(min(n1, len(ranks)) - 1, -1, -1):
            table[k + 1, r:] += table[k, : total + 1 - r]
    return table[n1]


def p_of_sums(counts):
    """s -> two-sided p for every attainable first-group rank sum s.

    2 x min(P(S <= s), P(S >= s)) capped at 1 — the convention web/stats.js uses,
    reimplemented here rather than imported, which is the point of the file.
    """
    total = counts.sum()
    le = np.cumsum(counts)
    ge = total - le + counts
    with np.errstate(invalid="ignore"):
        p = np.minimum(1.0, 2.0 * np.minimum(le, ge) / total)
    return p, total


def row_stats(values, n1):
    """(p at the observed split, p for every split, split counts) for one row."""
    ranks = doubled_ranks(values)
    s1 = sum(ranks[:n1])
    counts = null_counts(ranks, n1)
    p_all, total = p_of_sums(counts)
    return p_all[s1], p_all, counts, total


def benjamini_hochberg(ps):
    ps = np.asarray(ps, dtype=float)
    n = len(ps)
    order = np.argsort(ps, kind="stable")
    q = np.empty(n)
    prev = 1.0
    for k in range(n - 1, -1, -1):
        i = order[k]
        prev = min(prev, ps[i] * n / (k + 1))
        q[i] = min(1.0, prev)
    return q


# ---- the table, exactly as pseudoreplication.mjs reads it ---------------------

if len(sys.argv) > 1:
    dump = Path(sys.argv[1])
else:
    # Run the dump ourselves, so the two halves cannot drift apart in a shell
    # history nobody kept.
    dump = Path(tempfile.gettempdir()) / "pseudoreplication_page.json"
    subprocess.run(["node", str(HERE / "pseudoreplication_dump.mjs"), str(dump)],
                   check=True, cwd=REPO)
page = json.loads(dump.read_text())
sample_vals = np.array(page["sampleVals"], dtype=float)   # rows x 18, page order
donor_vals = np.array(page["donorVals"], dtype=float)     # rows x 6, female first
species = page["species"]
samples = page["samples"]
n_rows = len(species)
fem_idx = [samples.index(s) for s in page["female"]]
mal_idx = [samples.index(s) for s in page["male"]]

# Columns reordered so the first n1 are the first group — the DP above assumes it.
sample_ord = sample_vals[:, fem_idx + mal_idx]

print(f"{n_rows} rows, {len(fem_idx)} v {len(mal_idx)} samples, "
      f"{len(page['fd'])} v {len(page['md'])} donors")

# ---- brute force, on the rows that decide the story --------------------------
#
# The DP is the fast path and the enumeration is the one nobody can argue with:
# C(18,9) = 48,620 splits is small enough to walk for a few rows, and if the two
# ever disagreed the whole file would be reporting the DP's opinion.
lead = int(np.argmin([row_stats(list(sample_ord[i]), 9)[0] for i in range(n_rows)]))
for i in (lead, 0, n_rows - 1):
    vals = list(sample_ord[i])
    ranks = doubled_ranks(vals)
    obs = sum(ranks[:9])
    sums = np.array([sum(c) for c in combinations(ranks, 9)])
    brute = min(1.0, 2 * min((sums <= obs).mean(), (sums >= obs).mean()))
    dp = row_stats(vals, 9)[0]
    assert abs(brute - dp) < 1e-12, (species[i], brute, dp)
print(f"brute force over all 48,620 splits agrees with the DP on the leading row "
      f"and two others")

# ---- both designs, recomputed -------------------------------------------------

pS, pD = np.empty(n_rows), np.empty(n_rows)
exp_p05_S = 0.0                   # expected rows at p <= 0.05, nine a side
exp_floor_D = 0.0                 # expected rows at their own floor, three a side
can_floor_D = 0                   # rows where perfect donor separation is possible
can_p05_S = 0                     # rows where p <= 0.05 is reachable at all
floor_rows = []

for i in range(n_rows):
    p, p_all, counts, total = row_stats(list(sample_ord[i]), 9)
    pS[i] = p
    reach = p_all[counts > 0]
    w = counts[counts > 0] / total
    exp_p05_S += float(w[reach <= 0.05].sum())
    can_p05_S += int(reach.min() <= 0.05)

    p, p_all, counts, total = row_stats(list(donor_vals[i]), 3)
    pD[i] = p
    reach = p_all[counts > 0]
    w = counts[counts > 0] / total
    # P(this row lands on 0.1) under label permutation. NOT P(it lands on its own
    # smallest attainable p): for a row too tied to separate at all that smallest
    # value is 1, it is hit with certainty, and summing those would answer a
    # different question — "how often is a row as extreme as it can be", which
    # every flat row satisfies trivially.
    exp_floor_D += float(w[reach <= 0.1 + 1e-12].sum())
    can_floor_D += int(reach.min() <= 0.1 + 1e-12)
    if p <= 0.1 + 1e-12:
        floor_rows.append(i)

qS, qD = benjamini_hochberg(pS), benjamini_hochberg(pD)
print(f"largest |p difference| against web/stats.js: "
      f"9v9 {np.abs(pS - np.array(page['pS'])).max():.3e}, "
      f"3v3 {np.abs(pD - np.array(page['pD'])).max():.3e}")
print(f"largest |q difference|: "
      f"9v9 {np.abs(qS - np.array(page['qS'])).max():.3e}, "
      f"3v3 {np.abs(qD - np.array(page['qD'])).max():.3e}")
print()

print(f"(a) nine samples a side")
print(f"  smallest p {pS.min():.4e}   smallest q {qS.min():.6f}")
print(f"  rows at raw p <= 0.05: {(pS <= 0.05).sum()}"
      f"   expected under this design's own null: {exp_p05_S:.1f}"
      f"   reachable at all: {can_p05_S}")
print(f"  rows at q <= 0.1: {(qS <= 0.1).sum()}   q <= 0.05: {(qS <= 0.05).sum()}")
print()
print(f"(b) three donors a side, profiles averaged")
print(f"  smallest p {pD.min():.4e}   smallest q {qD.min():.6f}")
print(f"  rows at the floor p = 0.1: {len(floor_rows)}"
      f"   expected under the donor null: {exp_floor_D:.1f}"
      f"   reachable at all: {can_floor_D}")
print(f"  a floor hit needs perfect separation: 2 of the 20 relabelings, so under the"
      f" null {can_floor_D} reachable rows give {0.1 * can_floor_D:.1f}")
print()

# ---- the third design: all eighteen columns, twenty honest relabelings --------
#
# Averaging is one way to stop counting a donor three times; the other is to keep
# every column and permute what was randomised — the donor's sex. Same statistic
# the page computes, null restricted to the twenty ways six donors split 3-3.
donors = page["donorOrder"]
# The donor of each column, from the alias rule pseudoreplication.mjs uses, in
# the same female-then-male column order the DP above assumes.
alias_donor = page["colDonor"]
col_donor = [alias_donor[samples.index(s)] for s in page["female"] + page["male"]]
splits = [set(c) for c in combinations(donors, 3)]
hits, can_hit, exp_hit = [], 0, 0.0
for i in range(n_rows):
    ranks = doubled_ranks(list(sample_ord[i]))
    sums = np.array([sum(r for r, d in zip(ranks, col_donor) if d in sp) for sp in splits])
    obs = sum(r for r, d in zip(ranks, col_donor) if d in set(page["fd"]))
    ps = np.minimum(1.0, 2 * np.minimum(
        np.array([(sums <= s).sum() for s in sums]),
        np.array([(sums >= s).sum() for s in sums])) / len(sums))
    p = min(1.0, 2 * min((sums <= obs).mean(), (sums >= obs).mean()))
    exp_hit += float((ps <= 0.1 + 1e-12).mean())
    can_hit += int(ps.min() <= 0.1 + 1e-12)
    if p <= 0.1 + 1e-12:
        hits.append(i)
print(f"(c) eighteen columns, donor labels permuted (20 relabelings)")
print(f"  rows at the floor p = 0.1: {len(hits)}"
      f"   expected under the same null: {exp_hit:.1f}"
      f"   reachable at all: {can_hit}")
print(f"  same rows as the averaged design: "
      f"{len(set(hits) & set(floor_rows))} of {len(floor_rows)}")
for i in sorted(set(hits) | set(floor_rows)):
    print(f"    {species[i][:44]:46} averaged {'yes' if i in floor_rows else 'no ':>3}"
          f"  permuted {'yes' if i in hits else 'no'}"
          f"  female {donor_vals[i][:3].mean():7.3f}  male {donor_vals[i][3:].mean():7.3f}")
print(f"  smallest BH q attainable with {len(hits)} rows on the floor: "
      f"{min(1.0, 0.1 * n_rows / max(len(hits), 1)):.3f}")
print()

# ---- (d) is 25 a lot? ---------------------------------------------------------
#
# The count pseudoreplication.mjs reads as manufactured signal — rows at raw
# p <= 0.05 with the samples treated as independent — computed for EVERY one of
# the twenty ways six donors could have been split three and three. The observed
# sex split is one of those twenty, so this says whether 25 is what any donor
# split of this table gives, or whether the sex split stands out among them.
counts_all = []
per_row_null = []
for i in range(n_rows):
    ranks = doubled_ranks(list(sample_ord[i]))
    counts = null_counts(ranks, 9)
    p_all, total = p_of_sums(counts)
    per_row_null.append((ranks, p_all))
for sp in splits:
    n_small = 0
    for ranks, p_all in per_row_null:
        s = sum(r for r, d in zip(ranks, col_donor) if d in sp)
        n_small += int(p_all[s] <= 0.05)
    counts_all.append(n_small)
obs_split = [j for j, sp in enumerate(splits) if sp == set(page["fd"])][0]
counts_all = np.array(counts_all)
print("(d) rows at raw p <= 0.05 (samples as observations) for all 20 donor splits")
print(f"  the sex split: {counts_all[obs_split]}"
      f"   others: min {counts_all.min()} median {np.median(counts_all):.0f} "
      f"max {counts_all.max()}")
print(f"  splits with at least as many as the sex split: "
      f"{int((counts_all >= counts_all[obs_split]).sum())} of 20")
print(f"  expected under the SAMPLE-level null (labels free): {exp_p05_S:.1f}")
# That expectation is a sum of per-row probabilities and the rows are not
# independent, so it is checked against relabelings that ignore the donors
# entirely: if the two disagreed, the per-row arithmetic would be the suspect.
rng = np.random.default_rng(1)
free = []
for _ in range(200):
    pick = rng.permutation(18)[:9]
    free.append(sum(int(p_all[sum(ranks[i] for i in pick)] <= 0.05)
                    for ranks, p_all in per_row_null))
free = np.array(free)
print(f"  200 free 9/9 relabelings: mean {free.mean():.1f}, median {np.median(free):.0f},"
      f" {int((free >= counts_all[obs_split]).sum())} of 200 reach the sex split's count")
print()

# ---- (e) is 0.058 a near miss? -----------------------------------------------
#
# The same twenty splits, but the statistic the paper quotes: the smallest BH q
# over the 468 rows when the eighteen columns are treated as eighteen
# observations. If a q of 0.058 is what an arbitrary split of six donors
# produces, then it is a property of the donor structure and not of sex.
minqs = []
for sp in splits:
    ps = np.array([p_all[sum(r for r, d in zip(ranks, col_donor) if d in sp)]
                   for ranks, p_all in per_row_null])
    minqs.append(benjamini_hochberg(ps).min())
minqs = np.array(minqs)
print("(e) smallest BH q over 468 rows, samples as observations, all 20 splits")
print(f"  the sex split: {minqs[obs_split]:.5f}"
      f"   others: min {minqs.min():.5f} median {np.median(minqs):.5f} "
      f"max {minqs.max():.5f}")
print(f"  splits whose smallest q is at or below the sex split's: "
      f"{int((minqs <= minqs[obs_split] + 1e-12).sum())} of 20")
print(f"  splits reaching q <= 0.05: {int((minqs <= 0.05).sum())} of 20")
print()

# ---- (f) what the figure says about all this ---------------------------------
#
# The floor is a property of the group sizes; the SENTENCE about the floor is a
# property of figures.js, which appends it only when the floor is above 0.05.
# Both subtitles are taken from the drawn SVG, so this is what a reader sees and
# not what the source suggests they see.
print("(f) the figure's own subtitle, from contrastSvg")
for line in page["subtitle9v9"]:
    print(f"  9 v 9 : {line}")
for line in page["subtitle3v3"]:
    print(f"  3 v 3 : {line}")
