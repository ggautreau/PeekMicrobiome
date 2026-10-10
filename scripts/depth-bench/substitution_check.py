#!/usr/bin/env python3
"""How far apart the two builds are, on this experiment's own reads.

    python3 scripts/depth-bench/substitution_check.py <native.tsv> <wasm.tsv>

§3.3 profiles its "page" arm with native sylph, and that substitution is only
legitimate if the two builds agree at the precision the section reports. §3.1
established equality on a different run at a different depth; this asks the same
question of the reads actually used, and prints the four numbers §3.1 quotes.
"""
import os
import sys

import pandas as pd

nat, was = sys.argv[1], sys.argv[2]
for f in (nat, was):
    if not os.path.exists(f):
        sys.exit(f"absent : {f}")
n = pd.read_csv(nat, sep="\t")
w = pd.read_csv(was, sep="\t")
key = "Genome_file"
shared = set(n[key]) & set(w[key])
only = len(set(n[key]) ^ set(w[key]))
order_n = list(n.sort_values("Taxonomic_abundance", ascending=False)[key])
order_w = list(w.sort_values("Taxonomic_abundance", ascending=False)[key])

print(f"lignes : natif {len(n)}, wasm {len(w)}, propres à un seul côté {only}")
print(f"même ordre : {order_n == order_w}")
for col in ("Taxonomic_abundance", "Sequence_abundance", "Adjusted_ANI"):
    N = dict(zip(n[key], n[col]))
    W = dict(zip(w[key], w[col]))
    worst = max((abs(N[k] - W[k]) for k in shared), default=float("nan"))
    print(f"plus grand écart, {col} : {worst:.4f}")
sys.exit(0 if only == 0 and order_n == order_w else 1)
