#!/usr/bin/env python3
"""Dereplicate the screening database ACROSS catalogues, by GTDB species name.

    scripts/derep_screening.py data/screening/genome-biome.tsv \
        --keep-out data/screening/keep.txt \
        --map-out  data/screening/species-biome.tsv

WHY
---
MGnify dereplicates each catalogue independently, so a species living in both
human-gut and mouse-gut is represented twice, by two different assemblies. In a
single `sylph profile` run over the merged database those two copies compete:
pseudotax reassignment hands each k-mer to whichever copy scored the higher
ANI, and the loser disappears from the output entirely. Measured on a real
human gut sample this attributed *Coprococcus eutactus_A* and *Bacteroides
uniformis* to mouse-gut and *Agathobacter rectalis* to marine-sediment — the
biome label was pure coin-flip, and the human-gut copy vanished.

A screening database must not do that. So: keep exactly ONE genome per GTDB
species, and label it with the SET of catalogues that contain that species. A
detected species then evidences every catalogue it belongs to, and no k-mer is
ever split between two copies of the same organism.

Which copy survives: the one with the most k-mers at the screening `c` (the
largest / best-assembled representative), ties broken on accession so the
output is reproducible.

WHAT THIS DOES NOT FIX
----------------------
41% of the genomes carry no GTDB species name (empty `s__` — novel species,
overwhelmingly soil and marine). Two unnamed genomes from different catalogues
may still be the same organism; name-based dereplication cannot see it. They
are all kept, each labelled with its own single catalogue. So the residual
duplication is concentrated in exactly the biomes whose members are mostly
undescribed, and the screen's verdict for those biomes should be read as a
floor, not an exact figure.
"""
import collections
import csv
import sys

src = sys.argv[1]
keep_out = None
map_out = None
if "--keep-out" in sys.argv:
    keep_out = sys.argv[sys.argv.index("--keep-out") + 1]
if "--map-out" in sys.argv:
    map_out = sys.argv[sys.argv.index("--map-out") + 1]

rows = list(csv.DictReader(open(src), delimiter="\t"))
print(f"{len(rows)} genomes in {src}")

named = collections.defaultdict(list)   # species -> [row]
unnamed = []
for r in rows:
    sp = r["species"]
    if not sp or sp.startswith("MGYG"):
        unnamed.append(r)
    else:
        named[sp].append(r)

print(f"  {len(named)} distinct named species over {sum(len(v) for v in named.values())} genomes")
print(f"  {len(unnamed)} genomes with no GTDB species name (kept as-is)")

keep = []
out_rows = []
collapsed = 0
for sp, group in sorted(named.items()):
    biomes = sorted({r["biome"] for r in group})
    best = max(group, key=lambda r: (int(r["n_kmers"]), r["accession"]))
    collapsed += len(group) - 1
    keep.append(best["genome_file"])
    out_rows.append(
        (best["genome_file"], best["accession"], sp, ",".join(biomes), best["n_kmers"], best["lineage"])
    )
for r in unnamed:
    keep.append(r["genome_file"])
    out_rows.append((r["genome_file"], r["accession"], "", r["biome"], r["n_kmers"], r["lineage"]))

print(f"  collapsed {collapsed} redundant copies -> keeping {len(keep)} genomes")

multi = collections.Counter(len(r[3].split(",")) for r in out_rows)
print(f"  entries labelled with N catalogues: {dict(sorted(multi.items()))}")

if keep_out:
    with open(keep_out, "w") as fh:
        fh.write("\n".join(keep) + "\n")
    print(f"wrote {keep_out} ({len(keep)} lines)")

if map_out:
    with open(map_out, "w") as fh:
        fh.write("genome_file\taccession\tspecies\tbiomes\tn_kmers\tlineage\n")
        for r in out_rows:
            fh.write("\t".join(r) + "\n")
    print(f"wrote {map_out} ({len(out_rows)} rows)")
