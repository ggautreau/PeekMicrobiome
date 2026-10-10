#!/usr/bin/env python3
"""The functional port against fmh-funprofiler itself.

    python3 scripts/depth-bench/equivalence.py [reads.fastq.gz ...]

§3 of the note shows the TAXONOMIC port reproducing native sylph exactly. The
functional half had no such check: a second sketcher, in a second alphabet,
against a second reference, validated by nothing but its own unit tests.

The reference pipeline is three commands, and this runs them:

    sourmash sketch translate -p scaled=1000,k=11,abund <reads> -o mg.sig
    sourmash prefetch mg.sig KOs_scaled_1000.sig.zip -k 11 --scaled 1000 \\
        --protein --threshold-bp 1000 -o prefetch.csv
    abundance = f_match_query / sum(f_match_query)

against the page's own code path, driven by func_profile.mjs — which imports
web/func-sketch.js rather than reimplementing it, so what is compared is the
module the worker feeds.

Needs `sourmash` (any 4.x) and the upstream KO archive, both fetched by
scripts/funprofiler/fixtures.sh.
"""
import json
import os
import statistics
import subprocess
import sys
import tempfile

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
KO_ZIP = os.path.join(ROOT, "scripts/funprofiler/KOs_scaled_1000.sig.zip")
SOURMASH = os.environ.get("SOURMASH", "sourmash")


def upstream(fastq, workdir):
    """fmh-funprofiler's own pipeline, as its funcprofiler.py runs it."""
    sig = os.path.join(workdir, "mg.sig")
    pre = os.path.join(workdir, "prefetch.csv")
    subprocess.run([SOURMASH, "sketch", "translate", "-p",
                    "scaled=1000,k=11,abund", fastq, "-o", sig],
                   check=True, capture_output=True)
    subprocess.run([SOURMASH, "prefetch", sig, KO_ZIP, "-o", pre, "-k", "11",
                    "--scaled", "1000", "--protein", "--threshold-bp", "1000"],
                   check=True, capture_output=True)
    if not os.path.exists(pre) or os.path.getsize(pre) == 0:
        return {}
    df = pd.read_csv(pre)[["match_name", "f_match_query"]].copy()
    # "ko:K00009 <description>" upstream, "K00009" in the page's reference: the
    # same identifier written two ways, and stripping the prefix is the whole of
    # the reconciliation.
    df["ko"] = df.match_name.str.split().str[0].str.replace("^ko:", "", regex=True)
    total = df.f_match_query.sum()
    return dict(zip(df.ko, df.f_match_query / total))


def page(fastq, workdir):
    out = os.path.join(workdir, "page.json")
    subprocess.run(["node", os.path.join(ROOT, "scripts/depth-bench/func_profile.mjs"),
                    fastq, "", out], check=True, capture_output=True)
    with open(out) as fh:
        return json.load(fh)["profile"]


def main():
    fastqs = sys.argv[1:] or [os.path.join(ROOT, "data/bench/equiv/reads.fastq.gz")]
    if not os.path.exists(KO_ZIP):
        print(f"absent : {KO_ZIP} — lancer scripts/funprofiler/fixtures.sh")
        return 2
    fail = 0
    for fq in fastqs:
        if not os.path.exists(fq):
            print(f"absent : {fq}")
            fail += 1
            continue
        with tempfile.TemporaryDirectory() as work:
            # sourmash reads plain FASTQ here; the page reads what the browser
            # hands it, which is gzip.
            plain = fq
            if fq.endswith(".gz"):
                plain = os.path.join(work, "reads.fastq")
                with open(plain, "wb") as out:
                    subprocess.run(["gzip", "-dc", fq], stdout=out, check=True)
            up = upstream(plain, work)
            pg = page(fq, work)
        A, B = set(pg), set(up)
        shared = A & B
        worst = max((abs(pg[k] - up[k]), k) for k in shared) if shared else (float("nan"), "")
        med = statistics.median(abs(pg[k] - up[k]) for k in shared) if shared else float("nan")
        same_order = (sorted(pg, key=lambda k: -pg[k])[:10]
                      == sorted(up, key=lambda k: -up[k])[:10])
        ok = (A == B) and worst[0] < 1e-12 and same_order
        fail += 0 if ok else 1
        print(f"{'ok  ' if ok else 'FAIL'} {os.path.basename(fq)}: "
              f"page {len(A)} / amont {len(B)} orthologues, "
              f"propres à l'un {len(A ^ B)}, "
              f"plus grand écart {worst[0]:.2e}, médian {med:.2e}, "
              f"dix premiers dans le même ordre : {same_order}")
    print(f"\n{len(fastqs) - fail} réussites, {fail} échecs (équivalence fonctionnelle)")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
