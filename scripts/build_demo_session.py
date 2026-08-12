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
Eighteen runs of PRJNA728374 — a public dietary-intervention study, human gut
metagenomes on Illumina HiSeq 4000 — profiled by PeekMicrobiome itself against
the published Human gut (UHGG) catalogue. Nothing is simulated: every number is a
taxonomic abundance sylph computed, and anyone can re-profile the same
accessions from the ENA panel of the page and land on the same table. The read
cap is the page's own default, so "the same accessions" really is the same work.

Six volunteers in Singapore gave a stool sample three times over eight weeks —
day 0, day 14, day 56 — while eating one of three cooking oils in a double-blind
trial. Six people, three visits each, and the person is readable from the sample
alias the ENA already returns: `A.M065_1` is arm A, subject M065, visit 1.

WHY THIS STUDY AND NOT THE LAST ONE. The demo used to be fifteen runs of
PRJEB83730, whose "repeat samples of one person" were nothing of the kind:
metaquantibiote is a CONTAMINATION experiment, and seven of those fifteen were a
donor's stool with 0.1% to 10% of another donor's added, re-sequenced six times
deeper. It said so only in the `comment` attribute of the sample XML, which no
portal field carries. The page had been deriving a noise threshold from those
pairs — measuring a spike-in and calling it sequencing noise.

Here the repeat is real. Six subjects x three visits shows what this page is
for: one person's three samples land beside each other in the ordination and a
different person's land elsewhere, so a visitor learns the one intuition worth
having — the individual is the signal, and eight weeks of a diet change is not.
Colour the same plot by the trial arm and A, B and C interleave. That negative
is worth more than any manufactured separation.

The arms are BLINDED. The record says A, B and C and never which oil each is;
this script and the page must not name them.

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
# What the ENA says these fifteen runs ARE — collected when, where, on what
# machine. Written out, like DEMO_RUNS below and for the same reason: a build
# script that needs the network to reproduce a committed file is a build script
# that stops reproducing it. Refreshed by hand from
#   filereport?accession=PRJNA728374&result=read_run&fields=<web/ena.js ENA_FIELDS>
META = REPO / "web/db/prjna728374.meta.json"
LINEAGE = REPO / "web/db/lineage/human-gut.json"
OUT_DIR = REPO / "web/demo"

BIOME_KEY = "human-gut"
STUDY = "PRJNA728374"

# The deepest run of each of the fifteen ENA samples of PRJEB83730, by base_count
# from the ENA portal API (filereport?accession=PRJEB83730&result=read_run).
# Written out rather than fetched: a build script that needs the network to
# reproduce a committed file is a build script that stops reproducing it.
DEMO_RUNS = [
    # subject, then visit. Day 0 / 14 / 56, from the sample alias A.M065_1 and
    # corroborated by collection_date, which really moves: M065 is 2018-12-05,
    # 2018-12-19, 2019-01-30.
    "SRR14473825",  # A.M065_1  M065 arm A day 0    1.00 Gbp
    "SRR14473824",  # A.M065_2  M065 arm A day 14   0.90 Gbp
    "SRR14473823",  # A.M065_3  M065 arm A day 56   1.06 Gbp
    "SRR14473855",  # A.M055_1  M055 arm A day 0    0.98 Gbp
    "SRR14473854",  # A.M055_2  M055 arm A day 14   1.32 Gbp
    "SRR14473853",  # A.M055_3  M055 arm A day 56   0.85 Gbp
    "SRR14473662",  # B.M092_1  M092 arm B day 0    1.19 Gbp
    "SRR14473661",  # B.M092_2  M092 arm B day 14   0.91 Gbp
    "SRR14473660",  # B.M092_3  M092 arm B day 56   1.17 Gbp
    "SRR14473875",  # B.M048_1  M048 arm B day 0    1.07 Gbp
    "SRR14473874",  # B.M048_2  M048 arm B day 14   1.01 Gbp
    "SRR14473873",  # B.M048_3  M048 arm B day 56   1.06 Gbp
    "SRR14473848",  # C.M058_1  M058 arm C day 0    1.12 Gbp
    "SRR14473847",  # C.M058_2  M058 arm C day 14   0.90 Gbp
    "SRR14473846",  # C.M058_3  M058 arm C day 56   0.93 Gbp
    "SRR14473842",  # C.M060_1  M060 arm C day 0    1.15 Gbp
    "SRR14473841",  # C.M060_2  M060 arm C day 14   0.59 Gbp
    "SRR14473840",  # C.M060_3  M060 arm C day 56   1.06 Gbp
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

    sample_meta = json.loads(META.read_text(encoding="utf-8"))
    missing_meta = [r for r in DEMO_RUNS if r not in sample_meta]
    if missing_meta:
        die(f"{META} says nothing about {', '.join(missing_meta)}")
    # The metadata must describe THESE runs and no others: a stale file naming a
    # run the demo dropped would ship a label for a column that is not there.
    stray = [r for r in sample_meta if r not in DEMO_RUNS]
    if stray:
        die(f"{META} describes {', '.join(stray)}, which the demo does not include")

    # run accession -> the subject, from the sample alias the ENA itself
    # returns: "A.M065_1" is arm A, subject M065, visit 1. Derived rather than
    # listed, so a run that ever moved to another subject could not be silently
    # mislabelled here — and taken from a PORTAL field, so the page shows the
    # same string for anyone who profiles these accessions themselves.
    subject, visit, arm = {}, {}, {}
    for run in DEMO_RUNS:
        alias = sample_meta.get(run, {}).get("sample_alias", "")
        m = re.fullmatch(r"([ABC])\.(M\d+)_([123])", alias)
        if not m:
            die(f"{run}: sample_alias {alias!r} is not the arm.subject_visit shape this study uses")
        arm[run], subject[run], visit[run] = m.group(1), m.group(2), int(m.group(3))


    subjects = sorted({subject[r] for r in DEMO_RUNS})
    # Three visits each, or this is not the time course the banner describes.
    per_subject = collections.Counter(subject.values())
    odd = {k: n for k, n in per_subject.items() if n != 3}
    if odd:
        die(f"these subjects do not have three visits: {odd}")
    if sorted(visit[r] for r in DEMO_RUNS) != sorted([1, 2, 3] * len(per_subject)):
        die("the visits are not one 1, one 2 and one 3 per subject")

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
        # The archive's own description of each sample, so the example shows what
        # a run profiled from the ENA panel shows. Read back by fromSession() as
        # an optional key: a session saved before this existed still opens.
        "sampleMeta": sample_meta,
        "rank": "s",
        # Ignored by fromSession(), which validates only what it reads. Here so
        # the file explains itself when it is opened on its own.
        "demo": {
            "study": STUDY,
            "studyUrl": f"https://www.ebi.ac.uk/ena/browser/view/{STUDY}",
            "note": (f"{len(DEMO_RUNS)} public runs of {STUDY}: {len(subjects)} volunteers in "
                     f"Singapore, each sampled three times over eight weeks (day 0, 14, 56) "
                     f"during a blinded dietary trial. Profiled by PeekMicrobiome against "
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


    print(f"{out_json.relative_to(REPO)}  {out_json.stat().st_size:,} B")
    print(f"{out_csv.relative_to(REPO)}  {out_csv.stat().st_size:,} B")
    print(f"  {len(DEMO_RUNS)} runs x {kept} rows ({dropped} all-zero rows dropped), "
          f"{len(subjects)} groups")
    print(f"  reference: {ref['label']} — {ref['catalogue']}, {genomes} genomes, k={k}, c={c}")
    print(f"  exported:  {exported}")


if __name__ == "__main__":
    main()
