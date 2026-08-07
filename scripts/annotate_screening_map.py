#!/usr/bin/env python3
"""Add GTDB lineage to the genome->biome table `syldb-reduce --biome-tsv` emits.

    scripts/annotate_screening_map.py \
        data/screening/genome-biome.tsv \
        -o data/screening/genome-biome.tsv

Sources, in this order:
  * data/biome-work/<biome>/metadata.tsv   — MGnify's genomes-all_metadata.tsv,
    columns Genome / Lineage. Covers the 18 non-gut catalogues.
  * web/db/lineage.json                    — the human-gut species names the
    web app already ships, keyed on `MGYG…….fna`.

Output columns: genome_file, biome, accession, n_kmers, species, lineage.
A genome with no lineage found keeps its accession as `species` and an empty
lineage — the file is a lookup table, not a claim, so a miss must be visible
rather than guessed.
"""
import json
import os
import sys

src = sys.argv[1]
out = src
if "-o" in sys.argv:
    out = sys.argv[sys.argv.index("-o") + 1]
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# accession -> (species, full lineage)
lin = {}
work = os.path.join(root, "data", "biome-work")
if os.path.isdir(work):
    for b in sorted(os.listdir(work)):
        meta = os.path.join(work, b, "metadata.tsv")
        if not os.path.exists(meta):
            continue
        with open(meta) as fh:
            hdr = fh.readline().rstrip("\n").split("\t")
            try:
                gi, li = hdr.index("Genome"), hdr.index("Lineage")
            except ValueError:
                continue
            for line in fh:
                f = line.rstrip("\n").split("\t")
                if len(f) <= max(gi, li):
                    continue
                lineage = f[li]
                sp = lineage.rsplit("s__", 1)[-1] if "s__" in lineage else ""
                lin[f[gi]] = (sp, lineage)

# The human-gut catalogue has no metadata.tsv under data/biome-work (it was
# built by the older build_gut_db.sh). If a UHGG genomes-all_metadata.tsv is
# pointed at with --uhgg-metadata, use it — it fills the 1187 species that
# web/db/lineage.json leaves as empty strings.
if "--uhgg-metadata" in sys.argv:
    p = sys.argv[sys.argv.index("--uhgg-metadata") + 1]
    with open(p) as fh:
        hdr = fh.readline().rstrip("\n").split("\t")
        gi_, li_ = hdr.index("Genome"), hdr.index("Lineage")
        for line in fh:
            f = line.rstrip("\n").split("\t")
            if len(f) <= max(gi_, li_):
                continue
            lineage = f[li_]
            sp = lineage.rsplit("s__", 1)[-1] if "s__" in lineage else ""
            lin.setdefault(f[gi_], (sp, lineage))

gut = {}
gj = os.path.join(root, "web", "db", "lineage.json")
if os.path.exists(gj):
    with open(gj) as fh:
        gut = json.load(fh)

n, hit = 0, 0
rows = []
with open(src) as fh:
    hdr = fh.readline().rstrip("\n").split("\t")
    gi = hdr.index("genome_file")
    bi = hdr.index("biome")
    ki = hdr.index("n_kmers")
    for line in fh:
        f = line.rstrip("\n").split("\t")
        if len(f) <= max(gi, bi, ki):
            continue
        g = f[gi]
        base = g.rsplit("/", 1)[-1]
        acc = base.replace(".fna.gz", "").replace(".fna", "")
        sp, full = lin.get(acc, ("", ""))
        if not sp:
            v = gut.get(base) or gut.get(base + ".gz") or gut.get(acc + ".fna")
            if isinstance(v, str):
                sp = v
        n += 1
        if sp:
            hit += 1
        rows.append((g, f[bi], acc, f[ki], sp or acc, full))

with open(out, "w") as fh:
    fh.write("genome_file\tbiome\taccession\tn_kmers\tspecies\tlineage\n")
    for r in rows:
        fh.write("\t".join(r) + "\n")

withlin = sum(1 for r in rows if r[5])
print(
    f"{out}: {n} rows, {hit} with a species name ({100*hit/max(n,1):.1f}%), "
    f"{withlin} with a full GTDB lineage ({100*withlin/max(n,1):.1f}%). "
    "Rows without a species name are GTDB placeholders (empty s__), not lookup failures."
)
