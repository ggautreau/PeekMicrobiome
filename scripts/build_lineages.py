#!/usr/bin/env python3
"""Build one genome -> species-name map per MGnify catalogue.

    python3 scripts/build_lineages.py            # all catalogues in web/db/biomes.json
    python3 scripts/build_lineages.py human-vaginal soil

Without these, a profile against any catalogue but human-gut comes back as a
column of accessions:

    (MGYG000304057.fna.gz)   MGYG000304057.fna.gz   100.00

which names nothing a biologist can act on. MGYG000304057 is Lactobacillus
iners, and the vaginal result was unreadable purely for want of a lookup table.

The names come from MGnify's own `genomes-all_metadata.tsv`, one per catalogue,
which carries the GTDB `Lineage` of every genome. Only the SPECIES
REPRESENTATIVES are kept: that is exactly what `sylph sketch` was given, so the
map covers the database and nothing else. The count is checked against
data/biome-dbs/manifest.tsv — if they disagree, the map does not match the
database it is for, and that is an error rather than a warning.

Keys are stored WITHOUT the .gz: the eighteen biome databases were built from
gzipped genomes and hold `MGYG….fna.gz`, while the older human-gut one holds
`MGYG….fna`. Normalising here means one convention in the JSON and one lookup
in the browser, rather than two of each.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BIOMES = ROOT / "web" / "db" / "biomes.json"
OUT_DIR = ROOT / "web" / "db" / "lineage"
MANIFEST = ROOT / "data" / "biome-dbs" / "manifest.tsv"
FTP = "https://ftp.ebi.ac.uk/pub/databases/metagenomics/mgnify_genomes"

# GTDB ranks, lowest first. A genome with no species name still has a genus, and
# "Prevotella sp." is worth incomparably more to a reader than an accession.
#
# d__ is in the list because some genomes really do stop there: tomato-rhizosphere
# has two whose lineage is "d__Bacteria;p__;c__;o__;f__;g__;s__", and marine and
# marine-sediment have more. Leaving the domain out dropped them from the map,
# which the count check then caught as a map that did not cover its database.
# Ranks kept for aggregation, coarsest last. Species is not here: it is already
# the map's value, and duplicating it would double the file for nothing.
RANK_KEYS = ["d", "p", "c", "o", "f", "g"]

RANKS = [("s__", ""), ("g__", " sp."), ("f__", " (family)"),
         ("o__", " (order)"), ("c__", " (class)"), ("p__", " (phylum)"),
         ("d__", " (domain only)")]


def species_name(lineage: str) -> tuple[str, bool]:
    """(display name, is_named_species) from a GTDB lineage string."""
    parts = {p[:3]: p[3:].strip() for p in lineage.split(";") if len(p) > 3}
    for prefix, suffix in RANKS:
        val = parts.get(prefix, "")
        if val:
            return val + suffix, prefix == "s__"
    # Genuinely unclassified: marine has three whose lineage is ";"-separated
    # emptiness, "d__;p__;c__;o__;f__;g__;s__", not even a domain. They still
    # need an entry — a genome missing from the map is indistinguishable from a
    # broken map, whereas "unclassified" says the silence comes from the
    # taxonomy and not from this application.
    return "unclassified", False


def fetch(url: str) -> str:
    with urllib.request.urlopen(url, timeout=300) as r:
        return r.read().decode("utf-8", "replace")


def expected_counts() -> dict[str, int]:
    """key -> species count sylph inspect reported, from the build manifest."""
    if not MANIFEST.exists():
        return {}
    out = {}
    with MANIFEST.open() as fh:
        for row in csv.reader(fh, delimiter="\t"):
            if len(row) >= 3:
                out[row[0]] = int(row[2])
    return out


def build_one(entry: dict, expect: dict[str, int]) -> dict | None:
    key, cat, ver = entry["key"], entry["catalogue"], entry["version"]
    url = f"{FTP}/{cat}/{ver}/genomes-all_metadata.tsv"
    try:
        tsv = fetch(url)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
        print(f"  !! {key}: {url} -> {e}")
        return None

    rows = list(csv.DictReader(tsv.splitlines(), delimiter="\t"))
    if not rows or "Lineage" not in rows[0]:
        print(f"  !! {key}: no Lineage column — the file format changed")
        return None

    mapping, named = {}, 0
    # Higher ranks, interned. A catalogue of 4,744 genomes has 3,444 species but
    # only 1,031 genera, 214 families and 24 phyla, so storing the strings once
    # and referring to them by index is most of the difference between 638 KB of
    # repeated lineages and something worth shipping.
    ranks = {k: [] for k in RANK_KEYS}
    rank_idx = {k: {} for k in RANK_KEYS}
    taxa = {}

    def intern(rank, value):
        if not value:
            return -1        # unclassified at this rank; -1 rather than a fake name
        seen = rank_idx[rank]
        if value not in seen:
            seen[value] = len(ranks[rank])
            ranks[rank].append(value)
        return seen[value]

    for r in rows:
        genome = (r.get("Genome") or "").strip()
        # The database holds one sketch per species representative. Keeping the
        # members too would triple the file for names nothing will ever look up.
        if not genome or genome != (r.get("Species_rep") or "").strip():
            continue
        lineage = r.get("Lineage") or ""
        name, is_species = species_name(lineage)
        gk = f"{genome}.fna"
        mapping[gk] = name
        parts = {p[:3]: p[3:].strip() for p in lineage.split(";") if len(p) > 3}
        taxa[gk] = [intern(k, parts.get(f"{k}__", "")) for k in RANK_KEYS]
        named += is_species

    want = expect.get(key)
    if want is not None and len(mapping) != want:
        # Not a warning: a map that does not cover the database would show names
        # for some rows and accessions for others, and look like missing data
        # rather than like a broken build.
        print(f"  !! {key}: {len(mapping)} representatives mapped but the database "
              f"holds {want} — refusing to write a map that does not match it")
        return None

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"{key}.json"
    # schema 2: species names as before, plus the higher ranks by index. Readers
    # that only want a name can still take `species[genome]` and ignore the rest.
    out.write_text(json.dumps({
        "schema": 2,
        "ranks": ranks,
        "rankKeys": RANK_KEYS,
        "species": mapping,
        "taxa": taxa,
    }, ensure_ascii=False, sort_keys=False, separators=(",", ":")) + "\n")
    pct = 100 * named / len(mapping) if mapping else 0
    print(f"  ok {key:<20} {len(mapping):>6} genomes  {named:>6} with a species name "
          f"({pct:.0f}%)  {out.stat().st_size / 1024:.0f} KB")
    return {"key": key, "n": len(mapping), "named": named}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("keys", nargs="*", help="biome keys; default: all with a catalogue")
    args = ap.parse_args()

    cat = json.loads(BIOMES.read_text())
    entries = [b for g in cat["groups"] for b in g["biomes"]
               if b.get("catalogue") and b.get("version") and not b.get("bundled")]
    if args.keys:
        entries = [b for b in entries if b["key"] in set(args.keys)]
        missing = set(args.keys) - {b["key"] for b in entries}
        if missing:
            raise SystemExit(f"unknown biome key(s): {', '.join(sorted(missing))}")

    expect = expected_counts()
    print(f"{len(entries)} catalogue(s), names from MGnify genomes-all_metadata.tsv")
    done = [build_one(b, expect) for b in entries]
    ok = [d for d in done if d]
    total = sum(d["n"] for d in ok)
    named = sum(d["named"] for d in ok)
    print(f"\n{len(ok)}/{len(entries)} written — {total:,} genomes, {named:,} "
          f"({100 * named / total if total else 0:.0f}%) with a GTDB species name")
    if len(ok) != len(entries):
        print("Some catalogues failed; nothing was written for those.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
