#!/usr/bin/env python3
"""A community whose composition is known, to measure what a profile invents.

    python3 scripts/depth-bench/mock.py plan     # choose the genomes, write the truth
    python3 scripts/depth-bench/mock.py fetch    # download them
    python3 scripts/depth-bench/mock.py reads    # simulate the FASTQ
    python3 scripts/depth-bench/mock.py score profile.tsv   # against the truth

WHY THIS EXISTS. §3 of the note is titled "Validation" and contains only
self-agreement: the WebAssembly build reproduces native sylph, and the page's
4,744-genome catalogue orders a sample much as the whole of GTDB does. Both arms
of that second comparison are sylph 0.9.0 — same k, same estimator, differing
only in the reference — so it measures a catalogue's coverage under a shared
method, not accuracy. Nothing in the paper measures what the profile REPORTS THAT
IS NOT THERE.

THE DESIGN, and its one honest limitation. The community is built from two kinds
of genome:

  IN     species representatives of the human-gut catalogue the page profiles
         against. For these the truth is a species the reference can name, and
         what is measured is abundance accuracy and the detection limit.
  OUT    species representatives of a DIFFERENT MGnify catalogue, chosen so they
         are absent from the human-gut one. For these the correct answer is
         "nothing" — and whatever the profiler reports instead is what it
         invents when it meets an organism its reference does not hold.

Building the IN half from the catalogue itself is circular for the question "can
it find things", and that circularity is the point: it isolates the two questions
that are answerable — how well are abundances estimated, and what happens at the
tail — from the one that needs an independent gold standard.

Abundances span three orders of magnitude on purpose. A mock at even proportions
measures nothing about a peek: the whole question is where detection fails.
"""
import gzip
import json
import os
import random
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WORK = os.path.join(ROOT, "data", "bench", "mock")
TRUTH = os.path.join(WORK, "truth.json")
HUMAN_GUT = "https://ftp.ebi.ac.uk/pub/databases/metagenomics/mgnify_genomes/human-gut/v2.0.2"

# Ten species of the human-gut catalogue, spanning the genus diversity a stool
# sample actually has, plus five from other biomes that the human-gut catalogue
# cannot contain. The identifiers are read from the page's own lineage map, so
# the IN half is guaranteed to be in the database being profiled against.
N_IN, N_OUT = 12, 5
SEED = 20260816


def lineage():
    with open(os.path.join(ROOT, "web/db/lineage.json")) as fh:
        return json.load(fh)


def plan():
    os.makedirs(WORK, exist_ok=True)
    rng = random.Random(SEED)
    lin = lineage()
    inside = sorted(lin)
    rng.shuffle(inside)
    chosen_in = inside[:N_IN]

    # The OUT half: genomes from catalogues that are not human gut. Their URLs
    # are already on disk from the biome build, so nothing has to be guessed.
    out = []
    for biome in ("chicken-gut", "cow-rumen", "marine", "soil", "honeybee-gut"):
        p = os.path.join(ROOT, "data/biome-work", biome, "urls.txt")
        if not os.path.exists(p):
            continue
        with open(p) as fh:
            urls = [l.strip() for l in fh if l.strip()]
        if urls:
            out.append((biome, rng.choice(urls)))
        if len(out) == N_OUT:
            break

    # Log-normal abundances over three orders of magnitude: the regime where a
    # read cap decides what is seen. Renormalised to sum to 1 over the whole
    # community, IN and OUT together, because the OUT genomes really are in the
    # sample even though the reference cannot name them.
    n = len(chosen_in) + len(out)
    weights = [10 ** rng.uniform(-3, 0) for _ in range(n)]
    total = sum(weights)
    weights = [w / total for w in weights]

    truth = {"seed": SEED, "members": []}
    for i, g in enumerate(chosen_in):
        acc = g.replace(".fna", "")
        truth["members"].append({
            "kind": "in", "genome": acc, "species": lin[g],
            # MGnify shelves genomes under the accession minus its last two
            # characters: MGYG000307600 lives under MGYG0003076.
            "url": f"{HUMAN_GUT}/species_catalogue/{acc[:-2]}/{acc}/genome/{acc}.fna",
            "abundance": weights[i],
        })
    for j, (biome, url) in enumerate(out):
        truth["members"].append({
            "kind": "out", "genome": os.path.basename(url).replace(".fna", ""),
            "species": f"(absent from the human-gut catalogue — {biome})",
            "url": url, "abundance": weights[len(chosen_in) + j],
        })
    with open(TRUTH, "w") as fh:
        json.dump(truth, fh, indent=1)
    for m in truth["members"]:
        print(f"  {m['kind']:>3}  {m['abundance']*100:7.3f}%  {m['genome']}  {m['species'][:44]}")
    print(f"-> {TRUTH}")


def fetch():
    truth = json.load(open(TRUTH))
    d = os.path.join(WORK, "genomes")
    os.makedirs(d, exist_ok=True)
    for m in truth["members"]:
        dest = os.path.join(d, m["genome"] + ".fna")
        if os.path.exists(dest) and os.path.getsize(dest) > 1000:
            continue
        url = m["url"]
        # The biome build stored .fna URLs; some catalogues serve .fna.gz.
        for candidate in (url, url + ".gz"):
            r = subprocess.run(["curl", "-sfL", "-o", dest + ".tmp", candidate])
            if r.returncode == 0 and os.path.getsize(dest + ".tmp") > 1000:
                raw = open(dest + ".tmp", "rb").read()
                if raw[:2] == b"\x1f\x8b":
                    raw = gzip.decompress(raw)
                open(dest, "wb").write(raw)
                os.remove(dest + ".tmp")
                break
        else:
            print(f"  ÉCHEC {m['genome']}")
            continue
        print(f"  {m['genome']}: {os.path.getsize(dest)/1e6:.1f} Mo")


def reads(total_pairs=3_000_000, read_len=150):
    """Reads per genome in proportion to abundance x genome length.

    Relative ABUNDANCE here is what sylph calls sequence abundance — the share of
    the reads — so the number of reads is proportional to the weight directly.
    Taxonomic abundance, which the page reports by default, divides that by
    genome length; the scorer converts, rather than the simulator, so the truth
    file holds one definition and not two.
    """
    truth = json.load(open(TRUTH))
    d = os.path.join(WORK, "genomes")
    out1 = os.path.join(WORK, "mock_1.fastq")
    out2 = os.path.join(WORK, "mock_2.fastq")
    for p in (out1, out2):
        open(p, "w").close()
    for m in truth["members"]:
        n = int(round(total_pairs * m["abundance"]))
        if n <= 0:
            continue
        g = os.path.join(d, m["genome"] + ".fna")
        r1 = os.path.join(WORK, "t1.fq")
        r2 = os.path.join(WORK, "t2.fq")
        # wgsim's defaults carry a base error rate and a mutation rate; the
        # mutation rate is set to zero because a mock is a mixture of KNOWN
        # genomes, not of their diverged relatives — sequencing error stays.
        subprocess.run(["wgsim", "-N", str(n), "-1", str(read_len), "-2", str(read_len),
                        "-r", "0", "-R", "0", "-X", "0", "-S", str(SEED), g, r1, r2],
                       check=True, capture_output=True)
        for src, dst in ((r1, out1), (r2, out2)):
            with open(dst, "ab") as fh, open(src, "rb") as s:
                fh.write(s.read())
            os.remove(src)
        print(f"  {m['genome']}: {n} paires")
    for p in (out1, out2):
        subprocess.run(["gzip", "-1", "-f", p], check=True)
        print(f"  -> {p}.gz  {os.path.getsize(p + '.gz')/1e6:.0f} Mo")


def score(profile_tsv):
    """What the profiler said, against what was there."""
    import pandas as pd
    truth = json.load(open(TRUTH))
    df = pd.read_csv(profile_tsv, sep="\t")

    # The truth in TAXONOMIC abundance, which is what sylph's first column is:
    # share of reads divided by genome length, renormalised.
    lens = {}
    for m in truth["members"]:
        g = os.path.join(WORK, "genomes", m["genome"] + ".fna")
        lens[m["genome"]] = sum(len(l.strip()) for l in open(g) if not l.startswith(">"))
    tax = {m["genome"]: m["abundance"] / lens[m["genome"]] for m in truth["members"]}
    tot = sum(tax.values())
    tax = {k: 100 * v / tot for k, v in tax.items()}

    got = {}
    for _, r in df.iterrows():
        acc = os.path.basename(str(r["Genome_file"])).replace(".fna", "").replace(".gz", "")
        got[acc] = got.get(acc, 0) + float(r["Taxonomic_abundance"])

    ins = [m["genome"] for m in truth["members"] if m["kind"] == "in"]
    outs = [m["genome"] for m in truth["members"] if m["kind"] == "out"]
    found_in = [g for g in ins if got.get(g, 0) > 0]
    spurious = {g: v for g, v in got.items() if g not in ins}

    print(f"espèces présentes et dans le catalogue : {len(ins)}, retrouvées : {len(found_in)}")
    print(f"espèces présentes et ABSENTES du catalogue : {len(outs)} "
          f"(la bonne réponse est de n'en rapporter aucune)")
    print(f"lignes rapportées : {len(got)}, dont {len(spurious)} qui ne sont pas dans le mélange")
    inv = sum(spurious.values())
    print(f"abondance portée par ces lignes inventées : {inv:.2f} %")
    print(f"pureté (part de l'abondance rapportée qui est réelle) : {100 - inv:.2f} %")
    l1 = sum(abs(got.get(g, 0) - tax[g]) for g in ins) + inv
    print(f"erreur L1 sur les espèces du catalogue, plus l'inventé : {l1:.2f} points")
    print("\nespèce par espèce (catalogue) :")
    for g in sorted(ins, key=lambda x: -tax[x]):
        print(f"  {g}  vraie {tax[g]:7.3f} %  rapportée {got.get(g, 0):7.3f} %"
              f"{'   MANQUÉE' if got.get(g, 0) == 0 else ''}")
    miss = [tax[g] for g in ins if got.get(g, 0) == 0]
    if miss:
        print(f"\nplus forte abondance manquée : {max(miss):.3f} % ; "
              f"plus faible retrouvée : {min(tax[g] for g in found_in):.3f} %")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "plan"
    if cmd == "plan":
        plan()
    elif cmd == "fetch":
        fetch()
    elif cmd == "reads":
        reads(int(sys.argv[2]) if len(sys.argv) > 2 else 3_000_000)
    elif cmd == "score":
        score(sys.argv[2])
    else:
        sys.exit(__doc__)
