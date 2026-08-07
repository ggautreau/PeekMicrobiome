#!/usr/bin/env python3
"""Compare two `sylph profile` TSVs that differ only in the database's `c`.

Answers the only question that matters when a database is re-sub-sampled: do
the dominant species survive, in the same order, at the same abundance?

    scripts/compare_profiles.py reference.tsv reduced.tsv [--lineage web/db/lineage.json]

Prints, in order:
  * how many genomes each run reported, and the overlap;
  * the top-N table side by side with the rank each genome got in both runs;
  * Spearman rank correlation and Pearson correlation of log10 abundance over
    the shared genomes;
  * every genome present in the reference and missing from the reduced run,
    with the abundance it had — i.e. exactly what sensitivity was paid.
"""
import json
import sys
from math import log10

REF, RED = sys.argv[1], sys.argv[2]
LIN = None
if "--lineage" in sys.argv:
    LIN = sys.argv[sys.argv.index("--lineage") + 1]

lineage = {}
if LIN:
    try:
        with open(LIN) as fh:
            lineage = json.load(fh)
    except Exception as e:  # noqa: BLE001
        print(f"(lineage not loaded: {e})", file=sys.stderr)


def name_of(g):
    base = g.rsplit("/", 1)[-1]
    v = lineage.get(g, lineage.get(base, lineage.get(base.replace(".gz", ""))))
    if isinstance(v, str):
        return v
    if isinstance(v, dict):
        for key in ("species", "Species", "name"):
            if key in v:
                return v[key]
    return g.rsplit("/", 1)[-1]


def load(path):
    rows = {}
    with open(path) as fh:
        header = fh.readline().rstrip("\n").split("\t")
        gi = header.index("Genome_file")
        ai = header.index("Taxonomic_abundance")
        si = header.index("Sequence_abundance")
        ni = header.index("Adjusted_ANI")
        ci = header.index("Eff_cov") if "Eff_cov" in header else header.index("True_cov")
        for line in fh:
            f = line.rstrip("\n").split("\t")
            if len(f) < 3:
                continue
            rows[f[gi]] = dict(
                tax=float(f[ai]), seq=float(f[si]), ani=float(f[ni]), cov=float(f[ci])
            )
    order = sorted(rows, key=lambda g: -rows[g]["tax"])
    for r, g in enumerate(order, 1):
        rows[g]["rank"] = r
    return rows


ref, red = load(REF), load(RED)
shared = [g for g in ref if g in red]
lost = [g for g in ref if g not in red]
gained = [g for g in red if g not in ref]

print(f"reference : {REF}   {len(ref)} genomes")
print(f"reduced   : {RED}   {len(red)} genomes")
print(f"shared {len(shared)}   lost {len(lost)}   gained {len(gained)}")
print(
    f"reference abundance retained by the shared set: "
    f"{sum(ref[g]['tax'] for g in shared):.2f}% of {sum(ref[g]['tax'] for g in ref):.2f}%"
)

N = 25
print(f"\n--- top {N} of the reference, with the reduced run beside it ---")
print(f"{'rk':>3} {'rk_red':>6} {'tax_ref':>8} {'tax_red':>8} {'ani_ref':>7} {'ani_red':>7}  species")
top = sorted(ref, key=lambda g: -ref[g]["tax"])[:N]
for g in top:
    r = red.get(g)
    rk_red = str(r["rank"]) if r else "--"
    tax_red = "%.3f" % r["tax"] if r else "LOST"
    ani_red = "%.2f" % r["ani"] if r else "--"
    print(
        f"{ref[g]['rank']:>3} {rk_red:>6} {ref[g]['tax']:>8.3f} {tax_red:>8} "
        f"{ref[g]['ani']:>7.2f} {ani_red:>7}  {name_of(g)}"
    )

# rank agreement over the reference's top N
present = [g for g in top if g in red]
print(f"\ntop-{N} of reference: {len(present)}/{N} present in the reduced run")
if len(present) > 1:
    rr = [ref[g]["rank"] for g in present]
    rd = [red[g]["rank"] for g in present]
    inv = sum(
        1
        for i in range(len(present))
        for j in range(i + 1, len(present))
        if (rr[i] - rr[j]) * (rd[i] - rd[j]) < 0
    )
    pairs = len(present) * (len(present) - 1) // 2
    print(f"  pairwise order preserved on {pairs - inv}/{pairs} pairs (Kendall tau = {1 - 2*inv/pairs:.4f})")


def spearman(xs, ys):
    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        for pos, i in enumerate(order):
            r[i] = pos + 1
        return r

    rx, ry = ranks(xs), ranks(ys)
    n = len(xs)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((rx[i] - mx) * (ry[i] - my) for i in range(n))
    dx = sum((rx[i] - mx) ** 2 for i in range(n)) ** 0.5
    dy = sum((ry[i] - my) ** 2 for i in range(n)) ** 0.5
    return num / (dx * dy) if dx and dy else float("nan")


def pearson(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    num = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    dx = sum((x - mx) ** 2 for x in xs) ** 0.5
    dy = sum((y - my) ** 2 for y in ys) ** 0.5
    return num / (dx * dy) if dx and dy else float("nan")


if len(shared) > 2:
    a = [ref[g]["tax"] for g in shared]
    b = [red[g]["tax"] for g in shared]
    print(f"\nover the {len(shared)} shared genomes:")
    print(f"  Spearman rank corr (taxonomic abundance) = {spearman(a, b):.4f}")
    print(f"  Pearson corr of log10 abundance          = {pearson([log10(x) for x in a], [log10(y) for y in b]):.4f}")
    aa = [ref[g]["ani"] for g in shared]
    bb = [red[g]["ani"] for g in shared]
    d = [bb[i] - aa[i] for i in range(len(shared))]
    d.sort()
    print(f"  ANI difference (reduced - reference): median {d[len(d)//2]:+.2f}, "
          f"min {d[0]:+.2f}, max {d[-1]:+.2f}")
    ratio = sorted(b[i] / a[i] for i in range(len(shared)))
    print(f"  abundance ratio reduced/reference: median {ratio[len(ratio)//2]:.3f}, "
          f"5th pct {ratio[len(ratio)//20]:.3f}, 95th pct {ratio[min(len(ratio)-1, 19*len(ratio)//20)]:.3f}")

if lost:
    print(f"\n--- {len(lost)} genomes LOST by the reduction (reference abundance) ---")
    for g in sorted(lost, key=lambda g: -ref[g]["tax"]):
        print(f"  rk {ref[g]['rank']:>3}  tax {ref[g]['tax']:.4f}%  cov {ref[g]['cov']:.3f}  ani {ref[g]['ani']:.2f}  {name_of(g)}")
    lo = [ref[g]["tax"] for g in lost]
    print(f"  lost abundance total {sum(lo):.3f}%, max single {max(lo):.4f}%")
    cv = sorted(ref[g]["cov"] for g in lost)
    print(f"  their coverage: median {cv[len(cv)//2]:.3f}, max {cv[-1]:.3f}")

if gained:
    print(f"\n--- {len(gained)} genomes gained by the reduction ---")
    for g in sorted(gained, key=lambda g: -red[g]["tax"])[:20]:
        print(f"  tax {red[g]['tax']:.4f}%  cov {red[g]['cov']:.3f}  ani {red[g]['ani']:.2f}  {name_of(g)}")
