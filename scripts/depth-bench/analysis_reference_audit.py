#!/usr/bin/env python3
"""The checks analysis_reference.py left out, and the ones it made too weakly.

    node scripts/depth-bench/analysis_reference.mjs > js.json
    python3 scripts/depth-bench/analysis_reference_audit.py js.json

analysis_reference.py validates four functions — distanceMatrix, alphaDiversity,
pcoa, mannWhitney — and its arithmetic reproduces exactly. Three things it
claims are nevertheless not things it measured, and this file measures them.

  · THE NUMBER THE PAGE PRINTS IS NOT p. figures.js draws the contrast figure
    with `q` from benjaminiHochberg() and captions it with minAttainableP()
    (figures.js:613, :838, :690). Neither was compared to anything outside the
    project, so "the figures the page draws are the standard quantities" was
    unsupported for the one column the reader actually reads. statsmodels ships
    fdr_bh; it is used here.

  · THE TIE ARGUMENT RESTED ON ONE ROW, AND THE LEAST INFORMATIVE ONE. scipy's
    exhaustive PermutationMethod is the only outside implementation that stays
    valid under ties, and analysis_reference.py ran it on exactly one row — the
    row where scipy's exact branch disagreed most, which is a row of seventeen
    zeros and one value. 130 of the 468 rows already return p = 1 and 114 hold a
    single nonzero, so that row's answer is forced and no implementation could
    get it wrong. Run here on the tied rows that carry signal instead.

  · THE DENOMINATOR OF "explained" WAS NEVER COMPARED. figures.js takes the two
    axes by power iteration but the positive-eigenvalue total by a separate
    Jacobi routine, eigenvaluesSym(). Only their RATIO was checked, so an error
    shared by numerator and denominator would have cancelled. The spectrum is
    compared to numpy's eigh directly.

WHAT WOULD MAKE THIS WRONG: reading a js.json produced by a different session or
a stale figures.js — the row count and sample count are asserted below against
the shipped example. And statsmodels' fdr_bh drops nothing, while
benjaminiHochberg() excludes non-finite p from its denominator; that divergence
is untested here because this matrix has no non-finite p, and it is stated
rather than measured.
"""
import json
import sys
import time
from math import comb

import numpy as np
import scipy.stats as sst
from statsmodels.stats.multitest import multipletests

# How many tied rows to put through scipy's exhaustive permutation. Each row is
# 48,620 relabellings, so this is the whole runtime of the script; the most
# extreme half of them is where an error in tie handling would show, and the
# stratified half is there so the answer is not read off the tail alone.
TIED_ROWS_TO_CHECK = 58


def bh_and_floor(js, qjs, floor_js):
    """benjaminiHochberg and minAttainableP against upstream references."""
    ps = np.array([m["p"] for m in js["mannWhitney"]], dtype=float)
    _, q_ref, _, _ = multipletests(ps, method="fdr_bh")
    n1, n2 = len(js["groupA"]), len(js["groupB"])
    return {
        "rows": ps.size,
        "q_max_abs_diff": float(np.abs(np.asarray(qjs) - q_ref).max()),
        "q_min_js": float(np.min(qjs)),
        "q_min_ref": float(q_ref.min()),
        # What the contrast figure would actually show. The raw-p count is the
        # number analysis_reference.py quoted as spread; it is not the number
        # the reader sees.
        "rows_p_below_05": int((ps < 0.05).sum()),
        "rows_q_below_05_js": int((np.asarray(qjs) < 0.05).sum()),
        "rows_q_below_05_ref": int((q_ref < 0.05).sum()),
        "floor_js": float(floor_js),
        "floor_ref": 2.0 / comb(n1 + n2, n1),
    }


def ties_against_scipy_permutation(js):
    """stats.js against the one upstream branch that is valid under ties."""
    V = np.asarray(js["values"], dtype=float)
    ia, ib = js["groupA"], js["groupB"]
    n = len(ia) + len(ib)
    mw = js["mannWhitney"]
    ps = np.array([m["p"] for m in mw], dtype=float)

    tied = [i for i in range(V.shape[0])
            if np.unique(np.concatenate([V[i][ia], V[i][ib]])).size < n]
    # The most extreme tied rows first — a tie-handling error changes the tail,
    # not the middle — then an even sweep across the rest.
    by_p = [i for i in np.argsort(ps) if i in set(tied)]
    half = TIED_ROWS_TO_CHECK // 2
    stride = max(1, len(tied) // half)
    sel = sorted(set(by_p[:half]) | set(tied[::stride][:half]))

    worst, worst_row = 0.0, None
    for i in sel:
        p = sst.mannwhitneyu(V[i][ia], V[i][ib], alternative="two-sided",
                             method=sst.PermutationMethod(n_resamples=np.inf)).pvalue
        d = abs(float(p) - float(mw[i]["p"]))
        if d > worst:
            worst, worst_row = d, mw[i]["genome"]

    # How much of the 468 is doing no work: a row with one nonzero value cannot
    # produce anything but p = 1, whoever computes it.
    single = int(sum(1 for i in range(V.shape[0]) if (V[i] > 0).sum() <= 1))
    return {"tied_rows": len(tied), "checked": len(sel),
            "max_abs_diff": worst, "at": worst_row,
            "rows_p_equal_1": int((ps == 1.0).sum()),
            "rows_single_nonzero": single,
            "distinct_p": len(set(ps.tolist()))}


def spectrum(js, ev_js):
    """figures.js eigenvaluesSym against numpy.linalg.eigh on the same B."""
    D = np.asarray(js["distance"], dtype=float)
    nn = D.shape[0]
    J = np.eye(nn) - np.ones((nn, nn)) / nn
    B = -0.5 * J @ (D ** 2) @ J
    ref = np.sort(np.linalg.eigh(B)[0])[::-1]
    ev = np.asarray(ev_js, dtype=float)
    return {
        "max_abs_diff": float(np.abs(ev - ref).max()),
        "pos_total_js": float(ev[ev > 0].sum()),
        "pos_total_ref": float(ref[ref > 0].sum()),
    }


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "js.json"
    js = json.load(open(path))
    aux = json.load(open(sys.argv[2] if len(sys.argv) > 2 else "aux.json"))
    if len(js["values"]) != 468 or len(js["samples"]) != 18:
        raise SystemExit(f"expected the shipped example's 468 x 18, got "
                         f"{len(js['values'])} x {len(js['samples'])}")

    t0 = time.time()
    print(f"input: {len(js['values'])} rows x {len(js['samples'])} samples")

    b = bh_and_floor(js, aux["q"], aux["floor"])
    print("\n-- Benjamini-Hochberg, stats.js vs statsmodels fdr_bh  (NOT CHECKED BEFORE)")
    print(f"   rows                      {b['rows']}")
    print(f"   max |difference| in q     {b['q_max_abs_diff']:.3e}")
    print(f"   smallest q                js {b['q_min_js']:.6g} / statsmodels {b['q_min_ref']:.6g}")
    print(f"   rows below 0.05           raw p {b['rows_p_below_05']}, "
          f"q {b['rows_q_below_05_js']} (statsmodels {b['rows_q_below_05_ref']})"
          f"  <- q is the column the figure prints")
    print(f"   minAttainableP(9,9)       js {b['floor_js']!r}")
    print(f"                             2/C(18,9) {b['floor_ref']!r}")
    print(f"   difference                {abs(b['floor_js'] - b['floor_ref']):.3e}")

    s = spectrum(js, aux["eigenvalues"])
    print("\n-- figures.js eigenvaluesSym vs numpy.linalg.eigh  (NOT CHECKED BEFORE)")
    print(f"   max |difference| over all {len(aux['eigenvalues'])} eigenvalues  {s['max_abs_diff']:.3e}")
    print(f"   positive total            js {s['pos_total_js']:.12f} / "
          f"numpy {s['pos_total_ref']:.12f}")

    m = ties_against_scipy_permutation(js)
    print("\n-- ties: stats.js vs scipy PermutationMethod(n_resamples=inf), MORE THAN ONE ROW")
    print(f"   tied rows in the matrix   {m['tied_rows']}")
    print(f"   tied rows checked here    {m['checked']}   (was 1 in analysis_reference.py)")
    print(f"   max |difference| in p     {m['max_abs_diff']:.3e}"
          + (f"   (worst {m['at']})" if m["at"] else "   (no row differed)"))
    print("\n   how much of the 468 can carry a disagreement at all:")
    print(f"   rows whose p is exactly 1 {m['rows_p_equal_1']}")
    print(f"   rows with one nonzero     {m['rows_single_nonzero']}   <- p = 1 is forced")
    print(f"   distinct p over 468 rows  {m['distinct_p']}")

    print(f"\nruntime {time.time() - t0:.1f} s")


if __name__ == "__main__":
    main()
