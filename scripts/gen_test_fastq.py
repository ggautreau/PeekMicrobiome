#!/usr/bin/env python3
"""Generate a tiny synthetic FASTQ (optionally gzipped) for testing the downsampler.

Usage:
    python scripts/gen_test_fastq.py 10000 out.fastq.gz
"""
from __future__ import annotations
import gzip
import random
import sys
from pathlib import Path


def gen(n_reads: int, out: Path, read_len: int = 100, seed: int = 1) -> None:
    rng = random.Random(seed)
    bases = "ACGT"
    opener = gzip.open if out.suffix == ".gz" else open
    with opener(out, "wt") as fh:
        for i in range(n_reads):
            seq = "".join(rng.choices(bases, k=read_len))
            qual = "I" * read_len  # Phred 40
            fh.write(f"@read{i}\n{seq}\n+\n{qual}\n")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    gen(int(sys.argv[1]), Path(sys.argv[2]))
    print(f"wrote {sys.argv[2]}", file=sys.stderr)
