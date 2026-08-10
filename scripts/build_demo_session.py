#!/usr/bin/env python3
"""Build the bundled demo session from a real exported abundance matrix.

WHY THIS SCRIPT EXISTS
----------------------
The demo the page ships is a saved session — the same JSON the "Save session"
button writes. A 200 kB blob committed with no provenance rots: nobody can say a
year later which runs it came from, which database, or whether the numbers were
ever real. This script is that provenance, executable: give it the matrix the app
exported and it rebuilds the demo byte for byte.

WHAT THE DEMO IS
----------------
Fifteen runs of PRJEB83730 — a public ENA study, human gut metagenomes on Ion
Torrent — profiled by PeekMicrobiome itself against the published Human gut
(UHGG) catalogue. Nothing here is simulated: every number is a taxonomic
abundance sylph computed, and anyone can re-profile the same accessions from the
ENA panel of the page and land on the same table.

One run per ENA sample, so the demo is fifteen samples rather than eighty-four
runs of the same fifteen: the matrix stays readable, the ordination stays
labelled (the plot drops point labels past twenty), and row clustering stays
under its ceiling. The eight subjects each contribute a standard library and, for
seven of them, a deeper one — which is the point of the groups file: the two
libraries of one subject land on top of each other in the ordination, at six
times the sequencing depth. That is what a reproducible profile looks like, and
it is worth more in a demo than any synthetic separation.

USAGE
-----
    python3 scripts/build_demo_session.py path/to/abundance_matrix_human-gut.tsv

Writes web/demo/gut-demo.session.json and web/demo/gut-demo.groups.csv.
"""

import argparse
import collections
import json
import pathlib
import re
import sys
from typing import NoReturn

REPO = pathlib.Path(__file__).resolve().parent.parent
BIOMES = REPO / "web/db/biomes.json"
MANIFEST = REPO / "web/db/prjeb83730.manifest.json"
LINEAGE = REPO / "web/db/lineage/human-gut.json"
OUT_DIR = REPO / "web/demo"

BIOME_KEY = "human-gut"
STUDY = "PRJEB83730"

# The deepest run of each of the fifteen ENA samples of PRJEB83730, by base_count
# from the ENA portal API (filereport?accession=PRJEB83730&result=read_run).
# Written out rather than fetched: a build script that needs the network to
# reproduce a committed file is a build script that stops reproducing it.
DEMO_RUNS = [
    "ERR14098576",  # MQB_014       514 Mb
    "ERR14098636",  # MQB_014_l3   3074 Mb
    "ERR14098585",  # MQB_023       508 Mb
    "ERR14098638",  # MQB_023_l2   2966 Mb
    "ERR14098593",  # MQB_032       502 Mb
    "ERR14098641",  # MQB_032_l2   3069 Mb
    "ERR14098601",  # MQB_041       530 Mb
    "ERR14098609",  # MQB_059       466 Mb
    "ERR14098644",  # MQB_059_l2    3093 Mb
    "ERR14098617",  # MQB_068       459 Mb
    "ERR14098647",  # MQB_068_l2   3194 Mb
    "ERR14098625",  # MQB_086       495 Mb
    "ERR14098650",  # MQB_086_l2   2918 Mb
    "ERR14098633",  # MQB_095       463 Mb
    "ERR14098653",  # MQB_095_l2   2741 Mb
]

# sylph's own parameters, as recorded in the header of the matrix this is built
# from. Checked against it rather than assumed.
K, C = 31, 200


def die(msg) -> NoReturn:
    sys.exit(f"build_demo_session.py: {msg}")


def read_matrix(path):
    """The exported TSV: comment header, then species / genome / one column per sample."""
    header, rows = [], []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if line.startswith("#"):
                header.append(line)
            elif line:
                rows.append(line.split("\t"))
    if not rows:
        die(f"{path} holds no data rows")
    cols = rows[0]
    if cols[:2] != ["species", "genome"]:
        die(f"{path} does not start with the species/genome columns this script expects")
    return header, cols[2:], rows[1:]


def biome_entry():
    cat = json.loads(BIOMES.read_text(encoding="utf-8"))
    for group in cat.get("groups", []):
        for b in group.get("biomes", []):
            if b.get("key") == BIOME_KEY:
                return b
    die(f"no {BIOME_KEY!r} entry in {BIOMES}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("matrix", help="an abundance matrix exported by PeekMicrobiome")
    args = ap.parse_args()

    header, samples, rows = read_matrix(args.matrix)

    # The export names its own reference. Refuse anything else: a demo labelled
    # Human gut but computed against another catalogue would be a lie no
    # downstream check could catch.
    joined = "\n".join(header)
    if f"[{BIOME_KEY}]" not in joined:
        die(f"{args.matrix} was not profiled against the {BIOME_KEY} catalogue:\n" +
            "\n".join(header[:3]))
    m = re.search(r"genomes=(\d+), k=(\d+), c=(\d+)", joined)
    if not m:
        die("the matrix header carries no 'genomes=, k=, c=' line")
    genomes, k, c = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if (k, c) != (K, C):
        die(f"the matrix was profiled at k={k}, c={c}, not k={K}, c={C}")
    exported = re.search(r"^# exported: (\S+)", joined, re.M)
    exported = exported.group(1) if exported else None

    biome = biome_entry()
    if genomes != biome["species"]:
        die(f"the matrix says genomes={genomes}, the catalogue entry says "
            f"{biome['species']} — one of them is stale")

    # The export writes which catalogue EACH column was profiled against, and the
    # session repeats one reference for all fifteen. That is only true if the
    # export says so — a matrix assembled across two catalogues would otherwise
    # be shipped claiming one.
    per_sample = re.search(r"^# reference per sample: (.*)$", joined, re.M)
    if per_sample:
        labels = {kv.split("=", 1)[1].strip()
                  for kv in per_sample.group(1).split(";") if "=" in kv}
        if labels != {biome["label"]}:
            die(f"the export was not profiled against one catalogue: {sorted(labels)}")

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    # run accession -> the study's own sample name, from the manifest already in
    # the repo. No network, and it is the same mapping the ENA panel uses.
    #
    # The trailing _l2 / _l3 is a second library of the SAME subject, sequenced
    # about six times deeper. Stripping it is what makes the groups file worth
    # loading: the two libraries of one subject are then the same colour, and
    # whether they land together is a question the ordination answers on screen.
    subject = {}
    for fname, meta in manifest.items():
        run = fname.split(".")[0].split("_")[0]
        subject[run] = re.sub(r"_l\d+$", "", meta["sample"])

    missing = [r for r in DEMO_RUNS if r not in samples]
    if missing:
        die(f"{args.matrix} has no column for {', '.join(missing)}")
    unknown = [r for r in DEMO_RUNS if r not in subject]
    if unknown:
        die(f"{MANIFEST} does not name the sample of {', '.join(unknown)}")

    col = {s: i for i, s in enumerate(samples)}
    matrix, kept, dropped = {}, 0, 0
    totals = dict.fromkeys(DEMO_RUNS, 0.0)
    for r in rows:
        species, genome = r[0], r[1]
        values = {run: float(r[2 + col[run]]) for run in DEMO_RUNS}
        if not any(v > 0 for v in values.values()):
            # A genome detected only in the runs this demo leaves out is a row of
            # zeros here. Keeping it would inflate the table with taxa the demo
            # never shows.
            dropped += 1
            continue
        kept += 1
        entry = {"species": species}
        for run, v in values.items():
            entry[run] = round(v, 4)
            totals[run] += v
        matrix[genome] = entry

    for run, total in totals.items():
        if abs(total - 100) > 0.5:
            die(f"{run} sums to {total:.2f}%, not 100 — the columns are not "
                f"relative abundances of one sample")

    # No two rows may share a label. GTDB reuses species names across
    # representatives and the rank fallbacks add more, which is why the app
    # appends the accession to an ambiguous name — and why an export taken
    # before that fix would ship a demo that CroCoDeEL and phyloseq reject on
    # sight. The label is written by the app, not by this script, so the only
    # thing to do about it here is refuse the file.
    labels = collections.Counter(m["species"] for m in matrix.values())
    dupes = {name: n for name, n in labels.items() if n > 1}
    if dupes:
        worst = sorted(dupes.items(), key=lambda kv: -kv[1])[:3]
        die(f"{len(dupes)} labels are shared by {sum(dupes.values())} rows "
            f"(e.g. {worst}) — re-export the matrix from a build that "
            f"disambiguates them, or downstream tools will reject the demo")

    # Every genome must be one the bundled lineage map knows, or the rank picker
    # the demo turns on would aggregate part of the table and silently bucket the
    # rest as "unclassified".
    lineage = json.loads(LINEAGE.read_text(encoding="utf-8"))
    known = lineage.get("species", {})
    strangers = [g for g in matrix if g not in known and g.replace(".gz", "") not in known]
    if strangers:
        die(f"{len(strangers)} genomes are absent from {LINEAGE.name}, "
            f"e.g. {strangers[:3]}")

    # The shape makeDbRef() produces, so the demo renders through exactly the
    # same code as a session the user saved themselves.
    ref = {
        "key": biome["key"],
        "label": biome["label"],
        "catalogue": f"MGnify {biome['catalogue']} {biome['version']}".strip(),
        "version": biome["version"],
        "species": biome["species"],
        "file": biome["file"],
        "url": biome["url"],
        "doi": biome["doi"],
        "local": False,
        "genomes": genomes,
        "k": k,
        "c": c,
        "bytes": biome["bytes"],
        "source": biome.get("source", ""),
        "at": exported,
    }

    session = {
        "format": 1,
        "app": "PeekMicrobiome",
        "savedAt": exported,
        "ref": ref,
        "samples": list(DEMO_RUNS),
        "matrix": matrix,
        "refBySample": {run: ref for run in DEMO_RUNS},
        "rank": "s",
        # Ignored by fromSession(), which validates only what it reads. Here so
        # the file explains itself when it is opened on its own.
        "demo": {
            "study": STUDY,
            "studyUrl": f"https://www.ebi.ac.uk/ena/browser/view/{STUDY}",
            "note": (f"{len(DEMO_RUNS)} public runs of {STUDY} (human gut metagenome, Ion "
                     f"Torrent), one per ENA sample, profiled by PeekMicrobiome against "
                     f"{biome['label']} — {ref['catalogue']}, {genomes} genomes, k={k}, c={c}. "
                     f"Real measurements, not simulated: the same accessions profiled from "
                     f"the ENA panel of this page reproduce them."),
            "builtBy": "scripts/build_demo_session.py",
        },
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_json = OUT_DIR / "gut-demo.session.json"
    out_json.write_text(json.dumps(session, indent=1) + "\n", encoding="utf-8")

    # The groups file the "Load groups (CSV)" control reads, in the exact shape
    # it expects: sample name first, group second.
    out_csv = OUT_DIR / "gut-demo.groups.csv"
    lines = ["sample,subject"]
    for run in DEMO_RUNS:
        lines.append(f"{run},{subject[run]}")
    out_csv.write_text("\n".join(lines) + "\n", encoding="utf-8")

    subjects = sorted({subject[r] for r in DEMO_RUNS})
    print(f"{out_json.relative_to(REPO)}  {out_json.stat().st_size:,} B")
    print(f"{out_csv.relative_to(REPO)}  {out_csv.stat().st_size:,} B")
    print(f"  {len(DEMO_RUNS)} runs x {kept} rows ({dropped} all-zero rows dropped), "
          f"{len(subjects)} groups")
    print(f"  reference: {ref['label']} — {ref['catalogue']}, {genomes} genomes, k={k}, c={c}")
    print(f"  exported:  {exported}")


if __name__ == "__main__":
    main()
