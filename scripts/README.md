# scripts/

## `build_gut_db.sh`

Build the gut sylph database from UHGG v2.0.2 species representatives.

```bash
# prereqs (on PATH): curl, awk, gzip, xargs, sylph >=0.6
JOBS=16 bash scripts/build_gut_db.sh
```

Outputs land under `data/uhgg/`:
- `gut.syldb` — the sketched database (k=31, c=200), the artifact the WASM build will load
- `gut.taxonomy.tsv` — genome → GTDB lineage mapping (for `sylph-tax`)
- `genomes/` — downloaded `.fna` species reps (~5 GB raw; can be deleted after sketching)

Tunables (env vars):
- `UHGG_VERSION` — default `v2.0.2`
- `K`, `C` — default `31`, `200` (sylph defaults; keep aligned with WASM build)
- `JOBS` — download/sketch parallelism, default `8`
- `OUT_ROOT` — output dir, default `data/uhgg`

**Sylph isn't installed on this dev machine.** Run on a host with native sylph
(`cargo install sylph` or `conda install -c bioconda sylph`) and at least 50 GB
of scratch disk.

## `gen_test_fastq.py`

Generate a synthetic gzipped FASTQ for testing the web downsampler:

```bash
python3 scripts/gen_test_fastq.py 10000 /tmp/test10k.fastq.gz
```

## `test_downsample.mjs`

Node port of `web/app.js` downsample loop, for sanity-checking the cut logic
without a browser:

```bash
node scripts/test_downsample.mjs /tmp/test10k.fastq.gz /tmp/out.fastq 1000
```
