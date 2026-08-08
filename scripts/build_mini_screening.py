#!/usr/bin/env python3
"""Build a MINI screening database: which biome is this sample from?

    python3 scripts/build_mini_screening.py            # ~8 MB, c=8000
    python3 scripts/build_mini_screening.py --c 16000 --per-biome 120

The full screening database is 619 MB at c=2000 and 161 MB at c=8000 — fine on
a workstation, absurd as the thing you download BEFORE deciding which 2.9 GB
catalogue to fetch. Screening only has to answer "which biome", and that does
not need all 53,924 species.

TWO IDEAS MAKE IT SMALL
-----------------------
1. Only EXCLUSIVE species. A species found in both human-gut and human-skin
   says nothing about which of the two a sample came from. Measured across the
   nineteen catalogues: 30,612 distinct named species, 28,498 of them in
   exactly one catalogue. Those are the only ones that can carry a verdict.

2. Only the most FINDABLE of them. A marker helps only if the sample is likely
   to contain it and the sketch is large enough to be detected. Species are
   ranked by how many genomes MGnify assembled for them in that biome — a
   direct measure of how often it was actually seen there — and ties broken by
   sketch size.

WHAT THIS CANNOT DO, and it matters
-----------------------------------
Exclusivity is decided on GTDB species NAMES, and 41% of the merged genomes
have none (novel species, overwhelmingly soil, marine and marine-sediment).
Two unnamed genomes in two catalogues may be one organism and nothing here can
tell, so unnamed genomes are never used as markers. The consequence is not
symmetric: biomes whose diversity is mostly novel are represented by the
fraction of themselves that GTDB has named.

Small catalogues get few markers because they HAVE few exclusive species —
zebrafish-fecal has 12, marine-eukaryotes 8. A verdict for those is weak
evidence and the manifest says so per biome rather than averaging it away.

A screening result is a hint about which catalogue to load. It is not a
profile, and it is not a diagnosis.
"""
from __future__ import annotations

import argparse
import collections
import csv
import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCREEN = ROOT / "data" / "screening"
GENOME_BIOME = SCREEN / "genome-biome.tsv"
SOURCE_DB = SCREEN / "screening-c2000.syldb"      # not dereplicated: all 56,782
BIOMES = ROOT / "web" / "db" / "biomes.json"
CACHE = SCREEN / "mgnify-meta"
REDUCE = ROOT / "sylph-wasm" / "target" / "release" / "syldb-reduce"
FTP = "https://ftp.ebi.ac.uk/pub/databases/metagenomics/mgnify_genomes"

# A name that is a real species, not a fallback to a higher rank. Only these can
# support "found in exactly one catalogue" — see the module docstring.
FALLBACK_SUFFIXES = (" sp.", "(family)", "(order)", "(class)", "(phylum)", "(domain only)")


def is_named_species(v: str) -> bool:
    return bool(v) and v != "unclassified" and not v.endswith(FALLBACK_SUFFIXES)


def species_of(lineage: str) -> str:
    for p in lineage.split(";"):
        if p.startswith("s__"):
            return p[3:].strip()
    return ""


def prevalence(cat: str, ver: str) -> dict[str, int]:
    """species representative -> how many genomes MGnify assembled for it.

    Cached: the marine table alone is 50,866 rows, and this script is meant to
    be re-run while tuning --per-biome.
    """
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / f"{cat}-{ver}.tsv"
    if not f.exists():
        url = f"{FTP}/{cat}/{ver}/genomes-all_metadata.tsv"
        try:
            with urllib.request.urlopen(url, timeout=300) as r:
                f.write_bytes(r.read())
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            print(f"  !! {cat}: {e}")
            return {}
    n = collections.Counter()
    for r in csv.DictReader(f.read_text().splitlines(), delimiter="\t"):
        rep = (r.get("Species_rep") or "").strip()
        if rep:
            n[rep] += 1
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--c", type=int, default=8000, help="target sub-sampling rate (default 8000)")
    ap.add_argument("--per-biome", type=int, default=200, help="max markers per biome (default 200)")
    ap.add_argument("--exclusive", type=int, default=100,
                    help="markers per biome that are exclusive to it (default 100)")
    ap.add_argument("--out", default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    out = Path(args.out) if args.out else SCREEN / f"mini-c{args.c}-n{args.per_biome}.syldb"
    for p in (GENOME_BIOME, SOURCE_DB, REDUCE):
        if not p.exists():
            raise SystemExit(f"missing: {p}")

    rows = list(csv.DictReader(GENOME_BIOME.read_text().splitlines(), delimiter="\t"))
    print(f"{len(rows):,} genomes in {GENOME_BIOME.name}")

    # Which named species live in exactly one catalogue.
    in_cats = collections.defaultdict(set)
    for r in rows:
        sp = species_of(r["lineage"])
        if is_named_species(sp):
            in_cats[sp].add(r["biome"])
    exclusive = {sp for sp, cats in in_cats.items() if len(cats) == 1}
    print(f"{len(in_cats):,} named species, {len(exclusive):,} exclusive to one catalogue")

    cat_of = {b["key"]: (b["catalogue"], b["version"])
              for g in json.loads(BIOMES.read_text())["groups"] for b in g["biomes"]
              if b.get("catalogue") and b.get("version")}

    # A sketch is dropped by syldb-reduce below 50 genome_kmers. n_kmers here was
    # measured at c=2000, and scales as 2000/c — so require it up front rather
    # than discover after the fact that a biome lost half its markers.
    need = 50 * args.c / 2000
    # MEASURED, and it is why exclusivity alone does not work: the species that
    # DOMINATE a biome are usually the shared ones. Lactobacillus iners is in
    # human-gut, human-skin and human-vaginal; L. crispatus in seven catalogues.
    # Requiring exclusivity throws away exactly what a vaginal sample is made of
    # and keeps only rarities — a 1 M-read vaginal run detected ZERO of the 61
    # exclusive markers it was given.
    #
    # A species in three catalogues still rules out the other sixteen, so the
    # markers are the most PREVALENT species of each biome whether shared or
    # not, plus a quota of exclusive ones. screen_biome.py credits each detected
    # species to every catalogue holding it, and uses the exclusive fraction to
    # separate a real hit from one riding on cosmopolitan species — so both
    # kinds are needed: the prevalent ones to detect anything at all, the
    # exclusive ones to tell the candidates apart.
    by_biome, excl_pool = collections.defaultdict(list), collections.defaultdict(list)
    for r in rows:
        sp = species_of(r["lineage"])
        if not is_named_species(sp) or int(r["n_kmers"]) < need:
            continue
        by_biome[r["biome"]].append((sp, r))
        if sp in exclusive:
            excl_pool[r["biome"]].append((sp, r))

    keep, report = [], []
    for biome in sorted(by_biome, key=lambda b: -len(by_biome[b])):
        prev = prevalence(*cat_of[biome]) if biome in cat_of else {}
        # Most-assembled first — how often MGnify actually saw it in this biome —
        # and the bigger sketch as a tie-break, since it is the more detectable.
        ranked = sorted(
            by_biome[biome],
            key=lambda t: (-prev.get(t[1]["accession"], 0), -int(t[1]["n_kmers"])),
        )
        chosen = ranked[: args.per_biome]
        # Top up with exclusives that prevalence alone would not have reached.
        picked = {r["genome_file"] for _, r in chosen}
        ex_ranked = sorted(excl_pool.get(biome, []),
                           key=lambda t: (-prev.get(t[1]["accession"], 0), -int(t[1]["n_kmers"])))
        extra = [t for t in ex_ranked if t[1]["genome_file"] not in picked][: args.exclusive]
        chosen = chosen + extra
        n_excl = sum(1 for sp, _ in chosen if sp in exclusive)
        keep.extend(r["genome_file"] for _, r in chosen)
        report.append((biome, len(by_biome[biome]), len(chosen), n_excl))

    print(f"\n{'biome':<22}{'named+detectable':>18}{'markers':>9}{'of them exclusive':>19}")
    for b, avail, n, n_excl in report:
        flag = "  <- thin" if n_excl < 20 else ""
        print(f"{b:<22}{avail:>18,}{n:>9,}{n_excl:>19,}{flag}")
    # Biomes share their prevalent species, so the same genome is often picked
    # for several: the file holds the union, not the sum.
    print(f"\n{len(keep):,} picks, {len(set(keep)):,} distinct genomes")
    keep = sorted(set(keep))

    if args.dry_run:
        return 0

    keep_file = SCREEN / f"mini-keep-c{args.c}-n{args.per_biome}.txt"
    keep_file.write_text("\n".join(keep) + "\n")

    # Its OWN species->biomes table, written from the same selection in the same
    # run. The shipped data/screening/species-biome.tsv covers the DEREPLICATED
    # database and this one is built from the full 56,782, so reusing it left
    # markers "absent from the map" — screen_biome.py then dropped them and a
    # vaginal sample scored 0 species on a marker it had correctly detected.
    # Two files that must agree are two files that will not; generate both here.
    #
    # `biomes` is every catalogue the species appears in, not the one this
    # particular genome came from: a genome labelled human-oral whose species
    # also lives in human-vaginal must be able to vote for both.
    by_species = collections.defaultdict(set)
    for r in rows:
        sp = species_of(r["lineage"])
        if sp:
            by_species[sp].add(r["biome"])
    picked = set(keep)
    map_file = SCREEN / f"mini-species-biome-c{args.c}-n{args.per_biome}.tsv"
    with map_file.open("w") as fh:
        fh.write("genome_file\taccession\tspecies\tbiomes\tn_kmers\tlineage\n")
        n = 0
        for r in rows:
            if r["genome_file"] not in picked:
                continue
            sp = species_of(r["lineage"])
            fh.write("\t".join([r["genome_file"], r["accession"], r["species"],
                                ",".join(sorted(by_species.get(sp, {r["biome"]}))),
                                r["n_kmers"], r["lineage"]]) + "\n")
            n += 1
    assert n == len(picked), f"map covers {n} of {len(picked)} markers"
    print(f"{map_file.name}: {n:,} markers mapped to their catalogues")
    cmd = [str(REDUCE), "--c", str(args.c), "--keep", str(keep_file),
           "--out", str(out), str(SOURCE_DB)]
    print("\n$ " + " ".join(cmd))
    r = subprocess.run(cmd)
    if r.returncode != 0:
        return r.returncode
    mb = out.stat().st_size / 2**20
    print(f"\n{out.name}: {mb:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
