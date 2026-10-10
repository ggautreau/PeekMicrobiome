#!/usr/bin/env python3
"""The analysis layer against implementations that are not this project's.

    node scripts/depth-bench/analysis_reference.mjs > js.json
    python3 scripts/depth-bench/analysis_reference.py js.json

§3 of the note validates the PROFILER: the WebAssembly port reproduces native
sylph's abundances. Everything the page does after that — the Bray-Curtis
matrix, the PCoA it is drawn as, the Hill numbers beside it and the Mann-Whitney
under the contrast table — is validated by this project's own unit tests and by
nothing else. A unit test written by the same hand that wrote the formula agrees
with the formula, correct or not; it catches a typo and it cannot catch a wrong
definition.

So each of the four is recomputed here from scipy and numpy and subtracted from
what web/figures.js and web/stats.js returned for the SAME input: the matrix of
the example shipped with the page, 468 genomes across 18 real gut metagenomes,
not a toy vector chosen to be easy.

WHAT WOULD MAKE THIS WRONG, in four ways worth naming:

  · Comparing against something that is not independent. scipy's braycurtis,
    entropy and mannwhitneyu are upstream code; the PCoA reference is written
    out below from the definition (double-centre, eigendecompose) because scipy
    has no classical MDS, so it is independent of figures.js but not of the
    person who wrote it. It is kept to the textbook and to numpy's eigh.

  · Comparing on different numbers. The matrix travels in the JSON from the node
    side rather than being rebuilt here, so a divergence cannot be a table that
    was assembled twice and differently.

  · The PCoA sign. An eigenvector's sign is arbitrary; so is a rotation inside a
    degenerate eigenspace. Both are handled explicitly below and the handling is
    printed, because "up to sign" quietly applied is how a real disagreement
    gets absorbed.

  · Ties, in the Mann-Whitney. scipy's method="exact" is documented as not valid
    when the data are tied, and an abundance matrix is mostly zeros, so most
    rows here ARE tied. Comparing everything to scipy's exact branch and
    reporting one maximum would be comparing the page against a number scipy
    itself disclaims. The tie-free rows are therefore reported separately, and
    the tied ones are checked against a brute-force enumeration of all C(18,9)
    splits — the definition of the test the page claims to compute.
"""
import itertools
import json
import sys
import warnings

import numpy as np
import scipy.spatial.distance as ssd
import scipy.stats as sst


def bray_curtis(js):
    """scipy's braycurtis over every pair, against figures.js's distanceMatrix."""
    values = np.asarray(js["values"], dtype=float)   # rows x samples
    cols = values.T                                  # samples x rows
    D_js = np.asarray(js["distance"], dtype=float)
    n = cols.shape[0]

    worst, worst_pair, pairs = 0.0, None, 0
    for i, j in itertools.combinations(range(n), 2):
        ref = ssd.braycurtis(cols[i], cols[j])
        d = abs(ref - D_js[i, j])
        pairs += 1
        if d > worst:
            worst, worst_pair = d, (i, j)
    return {"pairs": pairs, "max_abs_diff": worst, "at": worst_pair,
            "example_ref": float(ssd.braycurtis(cols[0], cols[1])),
            "example_js": float(D_js[0, 1])}


def alpha(js):
    """The three Hill numbers, from scipy.stats.entropy and the definitions."""
    values = np.asarray(js["values"], dtype=float)
    out = {}
    for key in ("richness", "shannon", "effective", "inverseSimpson"):
        out[key] = {"max_abs_diff": 0.0, "at": None}

    for c, got in enumerate(js["alpha"]):
        v = values[:, c]
        v = v[v > 0]
        p = v / v.sum()
        # scipy.stats.entropy normalises internally and uses natural log, which
        # is the unit figures.js reports Shannon in.
        ref = {
            "richness": float(v.size),
            "shannon": float(sst.entropy(p)),
            "effective": float(np.exp(sst.entropy(p))),
            "inverseSimpson": float(1.0 / np.sum(p * p)),
        }
        for key, r in ref.items():
            d = abs(r - float(got[key]))
            if d > out[key]["max_abs_diff"]:
                out[key] = {"max_abs_diff": d, "at": got["sample"]}
    return out


def classical_mds(D):
    """Textbook PCoA: double-centre -0.5 D^2, eigendecompose, scale by sqrt(l).

    The reference figures.js is being checked against. It differs from the page
    in method and not in definition: numpy's eigh takes the whole spectrum at
    once where figures.js runs power iteration with deflation for two axes, so
    an error in the deflation would show up here as a coordinate that does not
    match.
    """
    n = D.shape[0]
    J = np.eye(n) - np.ones((n, n)) / n
    B = -0.5 * J @ (D ** 2) @ J
    vals, vecs = np.linalg.eigh(B)
    order = np.argsort(vals)[::-1]
    vals, vecs = vals[order], vecs[:, order]
    pos_total = vals[vals > 0].sum()
    coords = vecs[:, :2] * np.sqrt(np.maximum(vals[:2], 0))
    return vals, coords, vals[:2] / pos_total


def pcoa(js):
    D = np.asarray(js["distance"], dtype=float)
    vals, ref_xy, ref_expl = classical_mds(D)
    js_xy = np.array([[p["x"], p["y"]] for p in js["pcoa"]["points"]], dtype=float)
    js_expl = np.asarray(js["pcoa"]["explained"], dtype=float)

    # THE SIGN. An eigenvector v and -v are the same axis, so the reference axis
    # is flipped to whichever orientation agrees with the page before anything
    # is subtracted. The flip is chosen by the sign of the dot product, which is
    # the orientation that maximises agreement — and if the two configurations
    # really disagreed, no choice of sign would rescue the difference.
    signs = np.sign((ref_xy * js_xy).sum(axis=0))
    signs[signs == 0] = 1
    aligned = ref_xy * signs

    # THE ROTATION. Sign is the only freedom while the two leading eigenvalues
    # are distinct; if they were equal, any rotation of the plane would be an
    # equally valid answer and per-point differences would be meaningless. The
    # gap is printed so the reader can see which case this is, and an orthogonal
    # Procrustes fit is run anyway as the rotation-invariant statement.
    U, s, Vt = np.linalg.svd(aligned.T @ js_xy)
    R = U @ Vt
    procrustes = float(np.abs(aligned @ R - js_xy).max())

    return {
        "explained_js": js_expl.tolist(),
        "explained_ref": ref_expl.tolist(),
        "explained_max_abs_diff": float(np.abs(js_expl - ref_expl).max()),
        "signs_applied_to_reference": signs.tolist(),
        "coord_max_abs_diff": float(np.abs(aligned - js_xy).max()),
        "coord_max_abs_diff_after_procrustes": procrustes,
        "coord_scale": float(np.abs(js_xy).max()),
        "eigenvalues_first_four": vals[:4].tolist(),
        "eigen_gap_1_2": float(vals[0] - vals[1]),
        "negative_eigenvalue_total": float(vals[vals < 0].sum()),
    }


def exact_permutation_p(a, b, splits):
    """Two-sided exact p by enumerating every C(18,9) split, ties included.

    The definition of the test, computed the slow honest way: rank the pooled
    values with ties averaged, then ask what fraction of all equally likely
    labellings give a first-group rank sum at least as extreme. web/stats.js
    reaches the same number by dynamic programming over rank sums, so this is an
    independent route to it — and unlike scipy's exact branch it stays valid
    when the values are tied, which on an abundance matrix is the normal case.
    """
    pooled = np.concatenate([a, b])
    ranks = sst.rankdata(pooled)
    sums = ranks[splits].sum(axis=1)
    obs = ranks[:len(a)].sum()
    # The same convention as stats.js and as scipy's exact branch: twice the
    # smaller tail, capped at 1.
    le = np.count_nonzero(sums <= obs + 1e-9)
    ge = np.count_nonzero(sums >= obs - 1e-9)
    return min(1.0, 2.0 * min(le, ge) / sums.shape[0])


def mann_whitney(js):
    values = np.asarray(js["values"], dtype=float)
    ia, ib = js["groupA"], js["groupB"]
    n1, n2 = len(ia), len(ib)
    n = n1 + n2

    # Every split of 18 into 9 and 9, once, reused for all 468 rows: 48,620
    # rows of nine indices is under half a megabyte and turns the enumeration
    # into one gather per matrix row.
    splits = np.array(list(itertools.combinations(range(n), n1)), dtype=np.int8)

    worst_scipy = {"d": 0.0, "row": None}
    worst_scipy_untied = {"d": 0.0, "row": None}
    worst_perm = {"d": 0.0, "row": None}
    worst_u = 0.0
    tied_rows = 0

    for row, got in zip(values, js["mannWhitney"]):
        a, b = row[ia], row[ib]
        pooled = np.concatenate([a, b])
        has_ties = np.unique(pooled).size < n
        tied_rows += bool(has_ties)

        with warnings.catch_warnings():
            # scipy warns on every tied row that its exact branch does not
            # apply. That warning is the finding, not noise — it is counted
            # above and reported, and silenced here only so 400-odd copies of
            # it do not bury the numbers.
            warnings.simplefilter("ignore")
            res = sst.mannwhitneyu(a, b, method="exact", alternative="two-sided")

        d = abs(float(res.pvalue) - float(got["p"]))
        if d > worst_scipy["d"]:
            worst_scipy = {"d": d, "row": got["genome"], "scipy": float(res.pvalue),
                           "js": float(got["p"]), "ties": bool(has_ties)}
        if not has_ties and d > worst_scipy_untied["d"]:
            worst_scipy_untied = {"d": d, "row": got["genome"],
                                  "scipy": float(res.pvalue), "js": float(got["p"])}

        pref = exact_permutation_p(a, b, splits)
        dp = abs(pref - float(got["p"]))
        if dp > worst_perm["d"]:
            worst_perm = {"d": dp, "row": got["genome"], "perm": pref,
                          "js": float(got["p"]), "ties": bool(has_ties)}

        # U itself, which does not depend on how the tail is counted. scipy
        # reports U for the first group; stats.js reports min(U1, U2).
        u_ref = min(float(res.statistic), n1 * n2 - float(res.statistic))
        worst_u = max(worst_u, abs(u_ref - float(got["u"])))

    out = {"rows": len(values), "n1": n1, "n2": n2,
           "rows_with_ties": tied_rows,
           "splits_enumerated": int(splits.shape[0]),
           "max_abs_diff_p_vs_scipy_exact": worst_scipy,
           "max_abs_diff_p_vs_scipy_exact_untied_rows_only": worst_scipy_untied,
           "max_abs_diff_p_vs_brute_force_permutation": worst_perm,
           "max_abs_diff_u": worst_u}

    # The tie-breaker, on the one row where scipy's exact branch disagrees most.
    # Two implementations against one is not an argument; scipy asked for the
    # answer a THIRD way is. PermutationMethod(n_resamples=inf) makes scipy
    # enumerate every split itself, which is the branch of scipy that does
    # handle ties — so if the page were wrong, this is where it would show.
    if worst_scipy["row"] is not None:
        i = js["genomes"].index(worst_scipy["row"])
        row = values[i]
        res = sst.mannwhitneyu(row[ia], row[ib], alternative="two-sided",
                               method=sst.PermutationMethod(n_resamples=np.inf))
        out["worst_row_scipy_exhaustive_permutation_p"] = float(res.pvalue)
        out["worst_row_values"] = {"a": row[ia].tolist(), "b": row[ib].tolist()}
    return out


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "js.json"
    js = json.load(open(path))

    print(f"input: {len(js['values'])} rows x {len(js['samples'])} samples "
          f"(web/demo/gut-demo.session.json)")

    bc = bray_curtis(js)
    print("\n-- Bray-Curtis, figures.js distanceMatrix vs scipy.spatial.distance.braycurtis")
    print(f"   pairs compared            {bc['pairs']}")
    print(f"   max |difference|          {bc['max_abs_diff']:.3e}   (pair {bc['at']})")
    print(f"   e.g. pair (0,1)           scipy {bc['example_ref']!r} / js {bc['example_js']!r}")

    al = alpha(js)
    print("\n-- Hill numbers, figures.js alphaDiversity vs scipy.stats.entropy")
    for key, r in al.items():
        print(f"   {key:<16} max |difference| {r['max_abs_diff']:.3e}   (worst {r['at']})")

    pc = pcoa(js)
    print("\n-- PCoA, figures.js pcoa vs classical MDS from numpy.linalg.eigh")
    print(f"   explained js              {pc['explained_js']}")
    print(f"   explained reference       {pc['explained_ref']}")
    print(f"   max |difference|          {pc['explained_max_abs_diff']:.3e}")
    print(f"   eigenvalues 1..4          {pc['eigenvalues_first_four']}")
    print(f"   gap between axis 1 and 2  {pc['eigen_gap_1_2']:.4f}  "
          f"(distinct -> sign is the only freedom)")
    print(f"   negative eigenvalue total {pc['negative_eigenvalue_total']:.4f}")
    print(f"   signs applied to ref      {pc['signs_applied_to_reference']}")
    print(f"   max |coordinate diff|     {pc['coord_max_abs_diff']:.3e}   "
          f"(coordinates span +-{pc['coord_scale']:.3f})")
    print(f"   same, after Procrustes    {pc['coord_max_abs_diff_after_procrustes']:.3e}")

    mw = mann_whitney(js)
    print("\n-- Mann-Whitney, stats.js mannWhitney vs scipy.stats.mannwhitneyu(exact)")
    print(f"   rows compared             {mw['rows']}, split {mw['n1']} v {mw['n2']}")
    print(f"   rows with tied values     {mw['rows_with_ties']} of {mw['rows']}"
          f"   <- scipy's exact branch is not valid on these")
    w = mw["max_abs_diff_p_vs_scipy_exact"]
    print(f"   max |dp| vs scipy, all    {w['d']:.3e}"
          + (f"   (row {w['row']}, scipy {w['scipy']:.6g} / js {w['js']:.6g},"
             f" tied={w['ties']})" if w["row"] else ""))
    w = mw["max_abs_diff_p_vs_scipy_exact_untied_rows_only"]
    print(f"   max |dp| vs scipy, no ties {w['d']:.3e}"
          + (f"   (row {w['row']})" if w["row"] else "   (no such row)"))
    w = mw["max_abs_diff_p_vs_brute_force_permutation"]
    print(f"   max |dp| vs enumerating all {mw['splits_enumerated']} splits  {w['d']:.3e}"
          + (f"   (row {w['row']})" if w["row"] else ""))
    print(f"   max |dU|                  {mw['max_abs_diff_u']:.3e}")
    if "worst_row_scipy_exhaustive_permutation_p" in mw:
        w = mw["max_abs_diff_p_vs_scipy_exact"]
        print(f"   the worst row settled:    {w['row']} is "
              f"{mw['worst_row_values']['a'].count(0.0)}+"
              f"{mw['worst_row_values']['b'].count(0.0)} zeros of 18")
        print(f"     scipy method=exact      {w['scipy']:.6g}   (ties present: not valid here)")
        print(f"     scipy exhaustive perm   {mw['worst_row_scipy_exhaustive_permutation_p']:.6g}")
        print(f"     stats.js                {w['js']:.6g}")


if __name__ == "__main__":
    main()
