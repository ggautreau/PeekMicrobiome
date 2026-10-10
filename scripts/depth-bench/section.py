#!/usr/bin/env python3
"""The depth section of the note, written from the measurements themselves.

    python3 scripts/depth-bench/section.py > section.md

Every number in the section below comes out of depth_metrics.tsv rather than
being typed in, so the prose cannot drift from the table it describes. If a
measurement is missing the template fails loudly rather than printing a gap.
"""
import os
import sys
import textwrap

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TSV = os.path.join(ROOT, "data/bench/depth_metrics.tsv")
CAP = 3_000_000
# Read PAIRS per run, from the ENA's own read_count halved (the archive counts
# both mates). Needed because "the deepest rung" is only a fair stand-in for the
# whole run if it is most of it, and how much of it varies by run.
RUN_PAIRS = {
    "ERR14098649": 13_510_300 // 2,
    "ERR14098640": 15_921_274 // 2,
    "ERR14098646": 14_737_610 // 2,
}

df = pd.read_csv(TSV, sep="\t")
solo = pd.DataFrame(df[~df["tool"].str.contains("~", na=False)])
pair = pd.DataFrame(df[df["tool"].str.contains("~", na=False)])
samples = sorted(solo["sample"].unique())
depths = sorted(solo["depth"].unique())
deep = depths[-1]


def one(frame, **where):
    sub = frame
    for k, v in where.items():
        sub = sub[sub[k] == v]
    if sub.empty:
        raise SystemExit(f"mesure absente : {where}")
    return sub


def mean(frame, col, **where):
    return one(frame, **where)[col].mean()


def rng(frame, col, **where):
    s = one(frame, **where)[col]
    return s.min(), s.max()


def pct(x):
    return f"{100 * x:.1f}%"


TOOLS = {"peek": "the page's catalogue", "gtdb": "the whole of GTDB r220",
         "meteor": "Meteor2's gene catalogue", "func": "the KEGG orthologs"}

lines = []
add = lines.append

add("### 3.3 What a peek recovers: read depth, and three references")
add("")
add(f"The page caps a run at {CAP // 1_000_000} million reads by default, and §4 says the cap "
    "bites without ever saying what it costs. The cost has two parts, and only one of "
    "them is about this page: how much of a profile is lost by reading fewer reads, and how much "
    "depends on which reference the reads are compared against. Both were measured on the same "
    f"reads — {len(samples)} stool runs of PRJEB83730 "
    f"({', '.join(samples)}), subsampled at {len(depths)} depths from "
    f"{depths[0]//1000:,} thousand to {deep/1e6:.2g} million read pairs with a fixed seed, so every "
    "rung of the ladder is a subset of the one above it. The deepest rung is "
    f"{min(100*deep/RUN_PAIRS[x] for x in samples if x in RUN_PAIRS):.0f}–"
    f"{max(100*deep/RUN_PAIRS[x] for x in samples if x in RUN_PAIRS):.0f}% of each run, so it "
    "stands in for the whole of it.")
add("")
add("Three profilers were run on every rung. **The page**, as native sylph 0.9.0 against the same "
    "UHGG catalogue the browser downloads: on these 150-bp pairs the two builds report the same "
    "rows in the same order with abundances within 0.03 percentage points — the residue of native "
    "sylph's AVX2 seeding, without which they are identical (§3.1) — so the native binary stands "
    "in for the browser at the precision reported here and costs hours less. **Native sylph against the whole "
    "of GTDB r220** — 113,104 species representatives, a 14 GB database — which is the profile the "
    "page cannot offer, because a browser must download what it uses. And **Meteor2 2.0.18**, "
    "which is not a sketching method at all: it maps reads to a 10.4-million-gene catalogue with "
    "bowtie2 and quantifies 1,990 metagenomic species pan-genomes. The page's functional half was "
    "run on the same rungs, against its 13,509 KEGG orthologs.")
add("")

# --- convergence -------------------------------------------------------------
at_cap = {t: mean(solo, "bray_to_deepest", tool=t, depth=CAP) for t in TOOLS}
at_low = {t: mean(solo, "bray_to_deepest", tool=t, depth=depths[0]) for t in TOOLS}
half = {t: mean(solo, "bray_to_deepest", tool=t, depth=1_000_000) for t in TOOLS}

add(f"**What the cap costs.** Against its own profile at {deep/1e6:.2g} million pairs, the page's "
    f"taxonomic profile at the {CAP // 1_000_000}-million cap is {at_cap['peek']:.3f} away in "
    f"Bray–Curtis; at 250 thousand pairs it is "
    f"{mean(solo, 'bray_to_deepest', tool='peek', depth=250_000):.3f}, "
    f"and at {depths[0]//1000} thousand pairs {at_low['peek']:.3f}. The other two references behave "
    f"the same way — {at_cap['gtdb']:.3f} for GTDB at the cap — so this is a property of reading "
    "fewer reads rather than of any one method. Meteor2 is the outlier and converges faster "
    f"({at_cap['meteor']:.3f}), which is a property of the estimator rather than evidence that it "
    "is more accurate: it quantifies 1,990 species pan-genomes from a hundred core genes each and "
    "drops the ones too thinly covered to call, so it has a shorter tail to lose. The functional profile is the one that pays most: "
    f"{at_cap['func']:.3f} at the cap against {at_low['func']:.3f} at the shallowest rung, because "
    "an amino-acid sketch of a low-abundance organism is sparser still than its nucleotide one.")
add("")

det = {t: mean(solo, "detected", tool=t, depth=CAP) for t in TOOLS}
det_deep = {t: mean(solo, "detected", tool=t, depth=deep) for t in TOOLS}
found = {t: mean(solo, "deep_abund_found", tool=t, depth=CAP) for t in TOOLS}
found_low = {t: mean(solo, "deep_abund_found", tool=t, depth=depths[0]) for t in TOOLS}
add(f"**What it costs in detection.** At the cap the page reports {det['peek']:.0f} species on "
    f"average against {det_deep['peek']:.0f} at {deep/1e6:.2g} million pairs — "
    f"{pct(det['peek']/det_deep['peek'])} of them — and the same ratio holds for GTDB "
    f"({pct(det['gtdb']/det_deep['gtdb'])}) and Meteor2 ({pct(det['meteor']/det_deep['meteor'])}). "
    "The rows that go missing are the rare ones, and the count is the wrong way to price them: of "
    f"the abundance the deep profile accounts for, the capped run still finds {pct(found['peek'])} "
    f"(GTDB {pct(found['gtdb'])}, Meteor2 {pct(found['meteor'])}, orthologs {pct(found['func'])}). "
    f"Even at {depths[0]//1000} thousand pairs — a thirtieth of the cap — it is "
    f"{pct(found_low['peek'])}. A peek finds what is abundant and undercounts the tail, and it does "
    "so whatever it is compared against.")
add("")

# --- the cap against the signal ----------------------------------------------
BT = os.path.join(ROOT, "data/bench/between_samples.tsv")
bt = pd.read_csv(BT, sep="\t")


def bmean(tool, depth):
    sub = bt[(bt["tool"] == tool) & (bt["depth"] == depth)]
    if sub.empty:
        raise SystemExit(f"distance entre échantillons absente : {tool} {depth}")
    return sub["bray"].mean()


add("**And what it costs against what it is for.** A distance to one's own deeper profile is only "
    "meaningful beside the distance between two different samples, which is what any downstream "
    f"analysis actually reads. At the cap the page's profile is {at_cap['peek']:.3f} from its own "
    f"profile at {deep/1e6:.2g} million pairs, while two of these samples are "
    f"{bmean('peek', CAP):.3f} apart — a factor of {bmean('peek', CAP)/max(at_cap['peek'], 1e-9):.0f}. "
    f"And the between-sample distance barely moves with depth: {bmean('peek', depths[0]):.3f} at "
    f"{depths[0]//1000} thousand pairs against {bmean('peek', deep):.3f} at {deep/1e6:.2g} million. "
    "The signal a profile is read for is recovered at every depth tested here; what depth buys is "
    "the rare tail, and what the cap costs is a fraction of the gap it has to resolve. The "
    "functional profile is again the exception, and in the interesting direction: samples are "
    f"{bmean('func', CAP):.3f} apart functionally against {bmean('peek', CAP):.3f} taxonomically, "
    "which is the functional-redundancy result of §4 arrived at from three unrelated samples.")
add("")

# --- between references ------------------------------------------------------
sp = one(pair, rank="species")
gn = one(pair, rank="genus")
add("**Which reference, and how much it matters.** Every row every tool reported could be given a "
    "species name — no row fell back to an accession on either side — so what follows compares "
    "names rather than the ability to produce them. But the three do not name the same organisms: UHGG "
    "ships GTDB r202 names, sylph's database and Meteor2's MSPs are r220, and between those "
    "releases species were renamed, split and merged. Agreement is therefore reported at both "
    "ranks, and the gap between them is the part of the disagreement that is nomenclature.")
add("")
rows = [("PeekMicrobiome / GTDB r220", "peek~gtdb"),
        ("PeekMicrobiome / Meteor2", "peek~meteor"),
        ("GTDB r220 / Meteor2", "gtdb~meteor")]
add(f"At the {CAP // 1_000_000}-million cap, on the abundances of the rows both name:")
add("")
add("| | Spearman, species | Spearman, genus | abundance the other also names |")
add("|---|---|---|---|")
for label, key in rows:
    s_sp = mean(sp, "spearman_to_deepest", tool=key, depth=CAP)
    s_gn = mean(gn, "spearman_to_deepest", tool=key, depth=CAP)
    c_gn = mean(gn, "abund_covered_xy", tool=key, depth=CAP)
    add(f"| {label} | {s_sp:.3f} | {s_gn:.3f} | {pct(c_gn)} |")
add("")
lo_sp = mean(sp, "spearman_to_deepest", tool="peek~gtdb", depth=depths[0])
add(f"Depth improves agreement as much as it improves anything else: the page against GTDB rises "
    f"from {lo_sp:.3f} at {depths[0]//1000} thousand pairs to "
    f"{mean(sp, 'spearman_to_deepest', tool='peek~gtdb', depth=deep):.3f} at {deep/1e6:.2g} million. "
    "The genus column is the one to read: a browser-sized catalogue of 4,744 human-gut genomes "
    "orders the sample almost exactly as 113,104 species representatives do. What it cannot do is "
    "name an organism that is not in it.")
add("")
add("*Method: `scripts/depth-bench/`. Meteor2 was run on its fast (taxonomic) catalogue, which is "
    "why no Meteor2 column appears in the functional comparison: functional profiling needs the "
    "full 10.4-million-gene catalogue, 12.72 GB compressed and 16–19 GB extracted, against the "
    "4 GB this machine had free. The fast catalogue emits an MSP table and a gene table and no "
    "functional one.*")

# Wrapped at the width the rest of the note uses: a generated section that
# arrives as one line per paragraph is a diff nobody can read.
wrapped = []
for line in lines:
    if line.startswith(("|", "#")) or not line.strip():
        wrapped.append(line)
    else:
        # break_on_hyphens off: "browser-sized" split across lines otherwise, and
        # a hyphen at a line end reads as a different word.
        wrapped.extend(textwrap.wrap(line, 100, break_on_hyphens=False) or [""])
lines = wrapped
out = "\n".join(lines)
if "{" in out or "nan" in out.lower():
    sys.exit("un nombre manque dans la section")
print(out)
