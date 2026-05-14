# `.syldb` size estimate — UHGG gut database

## Headline

**~450 MB** for the UHGG v2.0.2 species-rep `.syldb` at `c=200 k=31`, with a
plausible range of **400–600 MB**. Runtime in-memory footprint roughly the
same. Comfortably under wasm32's 4 GB ceiling.

## How we get there

### 1. Empirical anchor (most trustworthy)

Sylph upstream README publishes a concrete reference:

> Pre-built **GTDB-R220** database (`c=200`), **113,104 bacterial/archaeal
> species reps**, total `.syldb` size **~13 GB**.

That gives a per-species figure of **~115 KB/genome** on the sylph encoding,
averaged over a representative cross-domain catalogue. The same README notes
RAM use is ~15 GB to profile against GTDB-R220, so deserialised in-memory
footprint is ~1.15× the on-disk `.syldb` size.

Scaling to UHGG v2.0.2 species reps (**4744 species**):

| Quantity                    | Value           |
|-----------------------------|-----------------|
| Genomes                     | 4744            |
| `.syldb` / genome (GTDB avg)| ~115 KB         |
| **Naive scaled `.syldb`**   | **~530 MB**     |
| In-memory (1.15×)           | **~610 MB**     |

### 2. Adjustment for UHGG vs GTDB

UHGG species reps include many gut MAGs that tend to be **smaller** and more
fragmented than the average GTDB rep:
- GTDB avg rep length ≈ 3.0 Mb (mixed bacteria + archaea; many high-quality isolates).
- UHGG v2.0.2 species reps ≈ 2.5 Mb (gut bacterial MAGs; some Bacteroidota
  reps push 6+ Mb, balanced by small Mollicutes/Patescibacteria around 1 Mb).

`.syldb` size scales roughly linearly with genome length (the FMH sketch
keeps ~1/`c` of canonical k-mers per genome). Apply 0.83×:

```
4744 species × 115 KB × 0.83 ≈ 450 MB
```

Allow ±25% for variance in genome-size distribution and metadata overhead →
**400–600 MB**.

### 3. Cross-check from the struct layout

`src/types.rs` defines, per genome:

```rust
pub struct GenomeSketch {
    pub genome_kmers: Vec<u64>,                                   //  8 + 8·N₁
    pub pseudotax_tracked_nonused_kmers: Option<Vec<u64>>,        //  1 (+ 8 + 8·N₂ if Some)
    pub file_name: String,                                        //  8 + |name|
    pub first_contig_name: String,                                //  8 + |contig|
    pub c: usize, pub k: usize, pub gn_size: usize, pub min_spacing: usize,  // 4·8 = 32
}
```

`bincode` default encoding: `Vec<T>` is `u64` length + payload; `String` is
`u64` length + UTF-8 bytes; `Option<T>` is 1-byte tag + inner.

For a typical 2.5 Mb gut species at c=200:
- Canonical k-mers in genome: ~2.5 M
- FMH-sampled (1/c): ~12,500 → `genome_kmers` = 8 + 12500 × 8 ≈ **100 KB**
- `pseudotax_tracked_nonused_kmers` (Some path; subset of similar order): ~**60 KB**
- file_name + contig + 4 usize: ≈ **150 B**
- **Per-genome total: ~160 KB**

Summed: 4744 × 160 KB ≈ **760 MB** — higher than the empirical figure, because
the structural bound is conservative (assumes pseudotax tracking is roughly
as large as the main sketch). The 450 MB empirical anchor is more reliable.

## Implications

- **Download budget**: ~450 MB is heavy for a first page visit but cacheable
  in IndexedDB after that. Two reasonable strategies:
  1. **Single download, cached** — `.syldb` fetched once, stored in OPFS or
     IndexedDB, reloaded instantly on return visits.
  2. **Range-loaded chunks** — split the bincode-`Vec<GenomeSketch>` into a
     prefix index + per-genome blocks, fetch only what's needed. Adds
     significant engineering; not warranted for v1.
- **Memory headroom**: with database (~600 MB live) + read sketches (5M reads
  at c=200 ≈ 30 MB) + working buffers + WASM module (~10 MB), peak usage
  should land around **1 GB**. Plenty of margin under 4 GB.
- **No threading constraint from size alone**: even at peak we don't need
  SharedArrayBuffer for memory reasons; only for `wasm-bindgen-rayon` later.

## Verification plan

Once the build pipeline (`scripts/build_gut_db.sh`) has actually run on a
host with native sylph, replace this estimate with the measured file size and
peak RSS from `sylph profile` on a small FASTQ. Until then, treat 450 MB as
the planning number.
