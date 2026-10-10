#!/usr/bin/env python3
"""What a peek recovers, against depth, against two other references.

    python3 scripts/depth-bench/analyse.py

Reads the ladder's outputs and answers three questions:

  1. CONVERGENCE. How far is a profile at depth d from the same tool's profile
     at the deepest rung? If the page's 3-million-read cap costs little, this
     distance is already small at 3 M.
  2. DETECTION. How many species does each tool report at each depth, and how
     much of the sample's abundance do the ones it agrees on carry?
  3. AGREEMENT. Where the three references can be compared at all — GTDB species
     names, which UHGG (r202), GTDB r220 and Meteor2's MSPs (r220) all use —
     how well do they agree, and does depth change that?

Nothing here re-implements a profiler: every number comes from the tools' own
output files.
"""
import gzip, json, lzma, os, re, sys
from collections import defaultdict
import pandas as pd, numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BENCH = os.path.join(ROOT, "data", "bench")
OUT = os.path.join(BENCH, "out")
REFS = os.path.join(BENCH, "refs")

# ---- names -------------------------------------------------------------------
#
# Three references, three ways of saying "this species". UHGG ships GTDB r202
# names as "Genus epithet"; GTDB r220 ships a full lineage per accession; Meteor
# gives a species column already. The comparison is made on the SPECIES name,
# lowercased, with GTDB's suffixes kept — "Blautia_A faecis" is not "Blautia
# faecis", and collapsing them would manufacture agreement.

def uhgg_names():
    with open(os.path.join(ROOT, "web/db/lineage.json")) as f:
        return json.load(f)

def gtdb_names():
    out = {}
    for f in ("bac120_taxonomy_r220.tsv.gz", "ar53_taxonomy_r220.tsv.gz"):
        p = os.path.join(REFS, f)
        if not os.path.exists(p):
            continue
        with gzip.open(p, "rt") as fh:
            for line in fh:
                acc, lin = line.rstrip("\n").split("\t")
                sp = lin.split(";s__")[-1]
                # sylph names a genome by its file; GTDB's accession carries an
                # RS_/GB_ prefix the file does not.
                out[acc.split("_", 1)[1] if acc[:3] in ("RS_", "GB_") else acc] = sp
    return out

def norm(sp):
    """A species name, comparable across the three references."""
    if not sp:
        return None
    s = str(sp).strip()
    s = re.sub(r"^s__", "", s)
    s = re.sub(r"\s+", " ", s)
    return s.lower() or None


def genus_of(sp):
    """The genus, which survives what the species name does not.

    UHGG ships GTDB r202 names and the other two references are r220; between
    those releases species were renamed, split and merged, so a species-level
    disagreement can be nomenclature rather than biology. The genus is far more
    stable across the two releases, so the same comparison is made at both ranks
    and the gap between them is itself the measure of how much of the
    disagreement is only in the names.
    """
    if not sp:
        return None
    g = str(sp).split()[0]
    return g.lower() or None


def to_genus(prof):
    out = defaultdict(float)
    for k, v in prof.items():
        g = genus_of(k)
        if g:
            out[g] += v
    return dict(out)


def covered(a, b):
    """The share of a's abundance carried by rows b also has.

    Jaccard counts a rare row and an abundant one the same, and these profiles
    have a long tail of rows at a fraction of a percent — so presence overlap
    reads as disagreement even when the two tools agree about everything that
    matters. This asks the question the other way: of what a says the sample is,
    how much does b name too?
    """
    tot = sum(a.values())
    return sum(v for k, v in a.items() if k in b) / tot if tot else float("nan")

# ---- readers -----------------------------------------------------------------

def read_sylph(path, names, kind):
    """sylph profile TSV -> {species: taxonomic abundance}. Unnamed rows kept
    under their accession, so richness is not quietly reduced by a name lookup."""
    prof = defaultdict(float)
    df = pd.read_csv(path, sep="\t")
    for _, r in df.iterrows():
        gf = os.path.basename(str(r["Genome_file"]))
        if kind == "uhgg":
            key = names.get(gf) or names.get(gf.replace(".gz", "")) or gf
        else:
            acc = re.sub(r"_genomic\.fna(\.gz)?$", "", gf)
            acc = re.sub(r"\.(fna|fa|fasta)(\.gz)?$", "", acc)
            m = re.match(r"((?:GCF|GCA)_\d+\.\d+)", acc)
            key = names.get(m.group(1), acc) if m else names.get(acc, acc)
        prof[norm(key)] += float(r["Taxonomic_abundance"])
    return dict(prof)

def read_meteor(path, msp2sp):
    """Meteor's MSP table -> {species: share of the summed MSP signal}."""
    with lzma.open(path, "rt") as fh:
        df = pd.read_csv(fh, sep="\t")
    col = df.columns[1]
    df = df[df[col] > 0]
    tot = df[col].sum()
    if tot <= 0:
        return {}
    prof = defaultdict(float)
    for _, r in df.iterrows():
        sp = msp2sp.get(r["msp_name"])
        prof[norm(sp) if sp else r["msp_name"]] += 100.0 * r[col] / tot
    return dict(prof)

# ---- distances ---------------------------------------------------------------

def bray(a, b):
    keys = set(a) | set(b)
    if not keys:
        return np.nan
    num = sum(abs(a.get(k, 0.0) - b.get(k, 0.0)) for k in keys)
    den = sum(a.get(k, 0.0) + b.get(k, 0.0) for k in keys)
    return num / den if den else np.nan

def jaccard(a, b):
    A, B = {k for k, v in a.items() if v > 0}, {k for k, v in b.items() if v > 0}
    return len(A & B) / len(A | B) if (A or B) else np.nan

def spearman(a, b):
    keys = sorted(set(a) & set(b))
    if len(keys) < 3:
        return np.nan
    from scipy.stats import spearmanr
    return spearmanr([a[k] for k in keys], [b[k] for k in keys]).statistic

# ---- functions ---------------------------------------------------------------

def read_func(path):
    with open(path) as fh:
        d = json.load(fh)
    return d["profile"], d

def main():
    uh, gt = uhgg_names(), gtdb_names()
    msp = pd.read_feather(os.path.join(
        REFS, "hs_10_4_gut_taxo/database/hs_10_4_gut_1990MSPs_gtdb_r220.feather"))
    msp2sp = dict(zip(msp["msp_name"], msp["species"]))
    print(f"noms : UHGG {len(uh)}, GTDB r220 {len(gt)}, MSP {len(msp2sp)}")

    rows = []
    allprof = {}
    samples = sorted(d for d in os.listdir(OUT) if os.path.isdir(os.path.join(OUT, d)))
    # ONLY THE SAMPLES THAT FINISHED. A ladder still climbing has its shallow
    # rungs and not its deep ones, so including it would put a different set of
    # samples behind every depth — and the whole figure is a comparison ACROSS
    # depths. Set DEPTH_PARTIAL=1 to look at a run in progress.
    if not os.environ.get("DEPTH_PARTIAL"):
        full, ladders = [], {}
        for d in samples:
            fdir = os.path.join(OUT, d, "func")
            ladders[d] = len(os.listdir(fdir)) if os.path.isdir(fdir) else 0
        want = max(ladders.values(), default=0)
        full = [d for d in samples if ladders[d] == want]
        if len(full) != len(samples):
            print(f"échantillons incomplets écartés : "
                  f"{', '.join(f'{d} ({ladders[d]}/{want})' for d in samples if d not in full)}")
        samples = full
    for s in samples:
        base = os.path.join(OUT, s)
        depths = sorted({int(re.search(r"_d(\d+)", f).group(1))
                         for f in os.listdir(os.path.join(base, "func"))
                         if re.search(r"_d(\d+)", f)})
        if not depths:
            continue
        prof = {}
        for d in depths:
            tag = f"{s}_d{d}"
            got = {}
            p = os.path.join(base, "sylph", f"{tag}.uhgg.tsv")
            if os.path.exists(p):
                got["peek"] = read_sylph(p, uh, "uhgg")
            p = os.path.join(base, "sylph", f"{tag}.gtdb.tsv")
            if os.path.exists(p):
                got["gtdb"] = read_sylph(p, gt, "gtdb")
            p = os.path.join(base, "meteor", f"{tag}.msp.tsv.xz")
            if os.path.exists(p):
                got["meteor"] = read_meteor(p, msp2sp)
            p = os.path.join(base, "func", f"{tag}.json")
            if os.path.exists(p):
                got["func"], meta = read_func(p)
                got["_reads"] = meta["reads"]
            prof[d] = got
        allprof[s] = prof
        # EACH TOOL'S OWN deepest rung, not the deepest rung any tool reached: a
        # tool that has not finished its last rung would otherwise be compared
        # against an empty profile, and every one of its distances would come
        # back as 1.0 — which looks like a finding rather than like a job still
        # running.
        top = {t: max((d for d in depths if prof[d].get(t)), default=None)
               for t in ("peek", "gtdb", "meteor", "func")}
        for d in depths:
            for tool in ("peek", "gtdb", "meteor", "func"):
                a = prof[d].get(tool)
                if a is None or top[tool] is None:
                    continue
                ref = prof[top[tool]].get(tool, {})
                rows.append(dict(
                    sample=s, depth=d, tool=tool, rank="species", deepest=top[tool],
                    detected=sum(1 for v in a.values() if v > 0),
                    bray_to_deepest=bray(a, ref),
                    jaccard_to_deepest=jaccard(a, ref),
                    spearman_to_deepest=spearman(a, ref),
                    # THE NUMBER THAT MATTERS when a shallow run finds fewer rows:
                    # how much of the deep profile's abundance the shallow one
                    # still accounts for. Losing half the species can cost three
                    # percent of the sample, and a count alone cannot say which.
                    deep_abund_found=covered(ref, a),
                ))
        # between tools, at each depth, at two ranks
        for d in depths:
            for x, y in (("peek", "gtdb"), ("peek", "meteor"), ("gtdb", "meteor")):
                A, B = prof[d].get(x), prof[d].get(y)
                if not A or not B:
                    continue
                for rank, a, b in (("species", A, B),
                                   ("genus", to_genus(A), to_genus(B))):
                    rows.append(dict(sample=s, depth=d, tool=f"{x}~{y}", rank=rank,
                                     detected=len(set(a) & set(b)),
                                     bray_to_deepest=bray(a, b),
                                     jaccard_to_deepest=jaccard(a, b),
                                     spearman_to_deepest=spearman(a, b),
                                     abund_covered_xy=covered(a, b),
                                     abund_covered_yx=covered(b, a)))
    # ---- the number the cap actually turns on -------------------------------
    #
    # A distance to one's own deeper profile means nothing until it is put beside
    # the distance between two DIFFERENT samples. If reading a third of a run
    # moves a sample by 0.03 and two people are 0.6 apart, the cap costs nothing
    # any downstream analysis would notice; if the two were comparable, it would
    # cost everything. Same distance function, so the two tables are readable
    # against each other.
    between = []
    for d in sorted({r["depth"] for r in rows}):
        for tool in ("peek", "gtdb", "meteor", "func"):
            have = [(x, allprof[x][d][tool]) for x in sorted(allprof)
                    if d in allprof[x] and allprof[x][d].get(tool)]
            for i2 in range(len(have)):
                for j2 in range(i2 + 1, len(have)):
                    between.append(dict(depth=d, tool=tool, a=have[i2][0], b=have[j2][0],
                                        bray=bray(have[i2][1], have[j2][1])))
    # WRITTEN EVEN WHEN EMPTY. A run over one sample produces no pairs, and
    # leaving the previous run's file in place would let a figure drawn from it
    # show between-sample distances for samples that are no longer in the
    # experiment — which is exactly what happened once, with a sample that had
    # been discarded for a corrupt input.
    pd.DataFrame(between, columns=["depth", "tool", "a", "b", "bray"]).to_csv(
        os.path.join(BENCH, "between_samples.tsv"), sep="\t", index=False)

    df = pd.DataFrame(rows)
    out = os.path.join(BENCH, "depth_metrics.tsv")
    df.to_csv(out, sep="\t", index=False)
    print(f"{len(df)} lignes -> {out}")
    if len(df):
        piv = df[~df.tool.str.contains("~")].pivot_table(
            index="depth", columns="tool", values="bray_to_deepest", aggfunc="mean")
        print("\nBray-Curtis moyen jusqu'au profil le plus profond :")
        print(piv.round(4).to_string())
        piv2 = df[~df.tool.str.contains("~")].pivot_table(
            index="depth", columns="tool", values="detected", aggfunc="mean")
        print("\nlignes détectées (moyenne) :")
        print(piv2.round(1).to_string())
        if between:
            bt = pd.DataFrame(between)
            print("\ndistance ENTRE échantillons (moyenne) — à lire contre le tableau du haut :")
            print(bt.pivot_table(index="depth", columns="tool", values="bray",
                                 aggfunc="mean").round(4).to_string())

if __name__ == "__main__":
    main()
