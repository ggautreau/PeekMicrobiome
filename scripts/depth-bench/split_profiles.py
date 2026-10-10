#!/usr/bin/env python3
"""One sylph table, split back into one file per rung.

    python3 split_profiles.py <db-name> <bench-dir>

sylph profiles every sketch handed to it in a single database load and writes
one table with a Sample_file column. The rung's tag is that column, so the split
is by name rather than by the order the rows came back in.
"""
import os
import sys

import pandas as pd

db, bench = sys.argv[1], sys.argv[2]
df = pd.read_csv(os.path.join(bench, f"all.{db}.tsv"), sep="\t")
n = 0
for tag, sub in df.groupby("Sample_file"):
    sample = str(tag).split("_d")[0]
    d = os.path.join(bench, "out", sample, "sylph")
    os.makedirs(d, exist_ok=True)
    sub.to_csv(os.path.join(d, f"{tag}.{db}.tsv"), sep="\t", index=False)
    n += 1
print(f"{n} tables écrites pour {db}")
