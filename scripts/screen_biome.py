#!/usr/bin/env python3
"""Turn a `sylph profile` run against the screening database into a verdict:
which MGnify catalogue should this sample actually be profiled against?

    scripts/screen_biome.py <profile.tsv> [--map data/screening/species-biome.tsv]

HOW THE VERDICT IS COMPUTED, AND WHY NOT THE OBVIOUS WAY
--------------------------------------------------------
The obvious way is to sum each detected genome's abundance under the label of
the catalogue it came from. That is wrong, and measurably so. The screening
database (after `derep_screening.py`) holds one genome per GTDB species, but
that species may belong to several catalogues at once — 2114 of 30612 named
species do. Charging its whole abundance to one catalogue would be arbitrary.

So each detected species contributes its abundance to EVERY catalogue that
contains it. The columns are therefore not a partition and do not sum to 100%:
they are "how much of this sample would a run against catalogue X have been
able to explain". That is exactly the question a user picking a database is
asking, and it is the only reading that survives the fact that MGnify's
catalogues overlap.

`excl%` is the complement: abundance from species found ONLY in that catalogue.
A biome with high excl% is genuinely indicated. A biome with high taxo% but
excl% near zero is only riding on cosmopolitan species and is not the answer.
"""
import collections
import sys

prof = sys.argv[1]
mapping = "data/screening/species-biome.tsv"
if "--map" in sys.argv:
    mapping = sys.argv[sys.argv.index("--map") + 1]

info = {}
with open(mapping) as fh:
    hdr = fh.readline().rstrip("\n").split("\t")
    gi = hdr.index("genome_file")
    si = hdr.index("species")
    bi = hdr.index("biomes")
    for line in fh:
        f = line.rstrip("\n").split("\t")
        if len(f) > max(gi, si, bi):
            info[f[gi]] = (f[si], f[bi].split(","))

agg = collections.defaultdict(
    lambda: {"taxo": 0.0, "excl": 0.0, "n": 0, "n_hi": 0, "best": 0.0, "top": ""}
)
unmapped = 0
detected = []
with open(prof) as fh:
    h = fh.readline().rstrip("\n").split("\t")
    gi2, ai, ni = h.index("Genome_file"), h.index("Taxonomic_abundance"), h.index("Adjusted_ANI")
    for line in fh:
        f = line.rstrip("\n").split("\t")
        if len(f) < 4:
            continue
        m = info.get(f[gi2])
        if m is None:
            unmapped += 1
            continue
        sp, biomes = m
        t, a = float(f[ai]), float(f[ni])
        detected.append((t, sp or f[gi2].rsplit("/", 1)[-1], biomes, a))
        for b in biomes:
            e = agg[b]
            e["taxo"] += t
            e["n"] += 1
            if len(biomes) == 1:
                e["excl"] += t
            if a >= 97.0:
                e["n_hi"] += 1
            if t > e["best"]:
                e["best"] = t
                e["top"] = sp or f[gi2].rsplit("/", 1)[-1]

if unmapped:
    print(f"WARNING: {unmapped} reported genomes are absent from {mapping}", file=sys.stderr)

total = sum(t for t, _, _, _ in detected)
print(f"{len(detected)} species detected, {total:.2f}% total taxonomic abundance\n")
print(f"{'catalogue':<20} {'taxo%':>8} {'excl%':>8} {'n':>5} {'n_hi':>5} {'best%':>7}  top species")
for b in sorted(agg, key=lambda b: -agg[b]["taxo"]):
    e = agg[b]
    print(
        f"{b:<20} {e['taxo']:>8.2f} {e['excl']:>8.2f} {e['n']:>5} {e['n_hi']:>5} "
        f"{e['best']:>7.3f}  {e['top']}"
    )

order = sorted(agg, key=lambda b: -agg[b]["excl"])
if order:
    b0 = order[0]
    print(
        f"\nverdict: {b0} — explains {agg[b0]['taxo']:.1f}% of the sample, "
        f"{agg[b0]['excl']:.1f}% of it from species found in no other catalogue."
    )
    if len(order) > 1:
        b1 = order[1]
        print(
            f"         runner-up {b1}: {agg[b1]['taxo']:.1f}% / {agg[b1]['excl']:.1f}% exclusive."
        )
    if agg[b0]["excl"] < 5.0:
        print(
            "         CAUTION: no catalogue is exclusively indicated. This sample may come from "
            "a biome MGnify does not cover; treat any single-catalogue profile as provisional."
        )
