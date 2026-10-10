#!/usr/bin/env python3
"""The depth ladder, drawn.

    python3 scripts/depth-bench/figure.py [out.svg]

Three panels, because there are three claims and they are not the same claim:

  (A) how far each tool's profile at depth d is from its own profile at the
      deepest rung — SOLID — against how far apart two different samples are —
      DASHED. The gap between the two lines is what the read cap costs measured
      in the units of the thing it might damage. Putting them in one panel is
      the point: a distance to oneself means nothing on its own.
  (B) how many rows each tool reports, which is where the tools differ most;
  (C) how much of the deep profile's ABUNDANCE the shallow one still accounts
      for — the number a count cannot give, since losing half the species can
      cost three percent of the sample.

The page's default cap is drawn as a rule in all three.
"""
import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TSV = os.path.join(ROOT, "data/bench/depth_metrics.tsv")
BTW = os.path.join(ROOT, "data/bench/between_samples.tsv")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "data/bench/depth.svg")
CAP = 3_000_000

LABEL = {
    "peek": "PeekMicrobiome — sylph, UHGG (4,744 genomes)",
    "gtdb": "native sylph — the whole of GTDB r220",
    "meteor": "Meteor2 — 10.4 M-gene catalogue",
    "func": "PeekMicrobiome — KEGG orthologs",
}
COLOUR = {"peek": "#00a3a6", "gtdb": "#275662", "meteor": "#e8623b", "func": "#8b6fb0"}

df = pd.DataFrame(pd.read_csv(TSV, sep="\t"))
df = pd.DataFrame(df[~df["tool"].str.contains("~", na=False)])
btw = pd.DataFrame(pd.read_csv(BTW, sep="\t")) if os.path.exists(BTW) else pd.DataFrame()

fig, ax = plt.subplots(1, 3, figsize=(13.5, 4.3))

for tool in ("peek", "gtdb", "meteor", "func"):
    sub = pd.DataFrame(df[df["tool"] == tool])
    if sub.empty:
        continue
    g = sub.groupby("depth")
    for panel, col in ((0, "bray_to_deepest"), (1, "detected"), (2, "deep_abund_found")):
        m = g[col].mean()
        lo, hi = g[col].min(), g[col].max()
        ax[panel].plot(m.index, m.values, "o-", color=COLOUR[tool], label=LABEL[tool],
                       markersize=4, linewidth=1.6)
        ax[panel].fill_between(m.index, lo.values, hi.values, color=COLOUR[tool],
                               alpha=0.13, linewidth=0)
    if not btw.empty:
        b = pd.DataFrame(btw[btw["tool"] == tool])
        if not b.empty:
            bm = b.groupby("depth")["bray"].mean()
            ax[0].plot(bm.index, bm.values, "--", color=COLOUR[tool], linewidth=1.2,
                       alpha=0.85)

for a in ax:
    a.set_xscale("log")
    a.axvline(CAP, color="#9aa0a1", linestyle=":", linewidth=1.2)
    a.set_xlabel("read pairs profiled")
    a.spines[["top", "right"]].set_visible(False)
    a.annotate("default cap", xy=(CAP, 1), xycoords=("data", "axes fraction"),
               xytext=(-4, -4), textcoords="offset points", rotation=90,
               ha="right", va="top", fontsize=7.5, color="#6b7172")

ax[0].set_ylabel("Bray–Curtis distance")
ax[0].set_title("solid: to its own deepest profile\ndashed: between two samples",
                fontsize=8.5, color="#4a4a4a")
ax[1].set_ylabel("rows reported")
ax[1].set_yscale("log")
ax[2].set_ylabel("share of the deep profile's abundance recovered")
ax[2].set_ylim(0.5, 1.02)
ax[0].legend(fontsize=7.2, frameon=False, loc="center left")
fig.tight_layout(pad=1.4)
fig.savefig(OUT)
print(f"écrit : {OUT}")
