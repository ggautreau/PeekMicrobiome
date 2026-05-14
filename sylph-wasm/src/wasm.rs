// wasm-bindgen surface for in-browser sylph profiling.
//
// JS-facing entry points:
//   const profiler = new Profiler(syldbBytes);
//   const tsv = profiler.profile(fastqBytes, maxReads);
//
// The .syldb is the standard sylph bincode-serialised Vec<GenomeSketch>; it is
// produced by native `sylph sketch` and shipped as a static asset. `fastqBytes`
// is uncompressed FASTQ — the caller is expected to gunzip in JS (browsers do
// this natively via DecompressionStream).

use wasm_bindgen::prelude::*;

use crate::cmdline::ContainArgs;
use crate::contain::{
    derep_if_reassign_threshold, estimate_covered_bases, estimate_true_cov, get_kmer_identity,
    get_stats, winner_table,
};
use crate::sketch::{sketch_pair_sequences_from_bytes, sketch_sequences_from_bytes};
use crate::types::{AniResult, GenomeSketch};

/// Profile-mode defaults to match sylph CLI `profile`.
fn profile_args() -> ContainArgs {
    let mut a = ContainArgs::default();
    a.min_count_correct = 3.0;
    a.min_number_kmers = 50.0;
    a.minimum_ani = None; // sylph picks 95.0 for profile internally
    a.redundant_ani = 99.0;
    a.c = 200;
    a.k = 31;
    a.min_spacing_kmer = 30;
    a.pseudotax = true;
    a.threads = 1;
    a
}

#[wasm_bindgen]
pub struct Profiler {
    genome_sketches: Vec<GenomeSketch>,
}

#[wasm_bindgen]
impl Profiler {
    /// Load a sylph database. `syldb` is the raw bytes of a `.syldb` file
    /// (bincode-serialised `Vec<GenomeSketch>`).
    #[wasm_bindgen(constructor)]
    pub fn new(syldb: &[u8]) -> Result<Profiler, JsValue> {
        // Show Rust panics in the browser console.
        console_error_panic_hook::set_once();
        // Route Rust `log::*` to console.* (best effort).
        let _ = console_log::init_with_level(log::Level::Info);

        let cursor = std::io::Cursor::new(syldb);
        let genome_sketches: Vec<GenomeSketch> = bincode::deserialize_from(cursor)
            .map_err(|e| JsValue::from_str(&format!("syldb decode failed: {}", e)))?;
        if genome_sketches.is_empty() {
            return Err(JsValue::from_str("syldb contained no genome sketches"));
        }
        if genome_sketches[0].pseudotax_tracked_nonused_kmers.is_none() {
            return Err(JsValue::from_str(
                "syldb was sketched without pseudotax tracking; profile() needs --enable-pseudotax",
            ));
        }
        Ok(Profiler { genome_sketches })
    }

    /// Returns the number of genome sketches loaded — handy as a smoke test.
    #[wasm_bindgen(getter)]
    pub fn database_size(&self) -> usize {
        self.genome_sketches.len()
    }

    /// Returns the `c` (sub-sampling rate) of the loaded database.
    #[wasm_bindgen(getter)]
    pub fn c(&self) -> usize {
        self.genome_sketches[0].c
    }

    /// Returns the `k` of the loaded database.
    #[wasm_bindgen(getter)]
    pub fn k(&self) -> usize {
        self.genome_sketches[0].k
    }

    /// Profile a single FASTQ sample against the loaded database.
    ///
    /// `fastq` should be uncompressed FASTQ bytes. `max_reads` caps the number
    /// of records sketched (0 = no cap).
    ///
    /// Returns a sylph-compatible TSV string (with the same column order
    /// produced by `sylph profile`).
    pub fn profile(&self, fastq: &[u8], max_reads: u32) -> Result<String, JsValue> {
        let cap = if max_reads == 0 {
            None
        } else {
            Some(max_reads as usize)
        };
        let c = self.genome_sketches[0].c;
        let k = self.genome_sketches[0].k;
        let sequence_sketch = sketch_sequences_from_bytes(
            fastq.to_vec(),
            "browser_sample".to_string(),
            c,
            k,
            /* no_dedup= */ false,
            cap,
        )
        .ok_or_else(|| JsValue::from_str("could not sketch FASTQ — not a valid FASTQ stream"))?;
        self.profile_sketch(sequence_sketch)
    }

    /// Paired-end equivalent of `profile()`. `r1` and `r2` are the uncompressed
    /// FASTQ bytes for the two mates of one sample. Records are read in lockstep;
    /// dedup uses an inter-mate k-mer pair to drop PCR duplicates.
    pub fn profile_pe(&self, r1: &[u8], r2: &[u8], max_reads: u32) -> Result<String, JsValue> {
        let cap = if max_reads == 0 {
            None
        } else {
            Some(max_reads as usize)
        };
        let c = self.genome_sketches[0].c;
        let k = self.genome_sketches[0].k;
        let sequence_sketch = sketch_pair_sequences_from_bytes(
            r1.to_vec(),
            r2.to_vec(),
            "browser_sample".to_string(),
            c,
            k,
            /* no_dedup= */ false,
            cap,
        )
        .ok_or_else(|| JsValue::from_str("could not sketch FASTQ pair — not a valid FASTQ stream"))?;
        self.profile_sketch(sequence_sketch)
    }

    /// Shared back-half: run sylph's profile inference + reassignment on an
    /// already-sketched sample and emit a TSV identical to native `sylph profile`.
    fn profile_sketch(&self, sequence_sketch: crate::types::SequencesSketch) -> Result<String, JsValue> {
        let args = profile_args();

        // First pass: containment against every genome.
        let kmer_id_opt = get_kmer_identity(&sequence_sketch, args.estimate_unknown);

        let mut stats: Vec<AniResult> = self
            .genome_sketches
            .iter()
            .filter_map(|g| get_stats(&args, g, &sequence_sketch, None, false))
            .collect();

        estimate_true_cov(
            &mut stats,
            kmer_id_opt,
            args.estimate_unknown,
            sequence_sketch.mean_read_length,
            sequence_sketch.k,
        );

        // Pseudotax reassignment: peel back shared k-mers so abundances sum to ~100%.
        let winner = winner_table(&stats, false);
        let remaining: Vec<&GenomeSketch> = stats.iter().map(|x| x.genome_sketch).collect();
        let stats2: Vec<AniResult> = remaining
            .into_iter()
            .filter_map(|g| get_stats(&args, g, &sequence_sketch, Some(&winner), false))
            .collect();
        let mut stats = derep_if_reassign_threshold(&stats, stats2, args.redundant_ani, sequence_sketch.k);
        estimate_true_cov(
            &mut stats,
            kmer_id_opt,
            args.estimate_unknown,
            sequence_sketch.mean_read_length,
            sequence_sketch.k,
        );

        // Relative-abundance and sequence-abundance calculations (mirror contain.rs).
        let bases_explained = if args.estimate_unknown {
            estimate_covered_bases(&stats, &sequence_sketch, sequence_sketch.mean_read_length, sequence_sketch.k)
        } else {
            1.0
        };
        let total_cov: f64 = stats.iter().map(|x| x.final_est_cov).sum();
        let total_seq_cov: f64 = stats
            .iter()
            .map(|x| x.final_est_cov * x.genome_sketch.gn_size as f64)
            .sum();
        for r in stats.iter_mut() {
            r.rel_abund = Some(r.final_est_cov / total_cov * 100.0);
            let seq_abund = r.final_est_cov * r.genome_sketch.gn_size as f64 / total_seq_cov
                * 100.0
                * bases_explained;
            r.seq_abund = Some(seq_abund);
        }

        stats.sort_by(|a, b| {
            b.rel_abund
                .unwrap_or(0.0)
                .partial_cmp(&a.rel_abund.unwrap_or(0.0))
                .unwrap()
        });

        // Emit TSV with the same columns as `sylph profile` (pseudotax = true).
        let mut buf: Vec<u8> = Vec::new();
        crate::contain::print_header(true, &mut buf, args.estimate_unknown);
        for r in &stats {
            crate::contain::print_ani_result(r, true, &mut buf);
        }
        Ok(String::from_utf8_lossy(&buf).into_owned())
    }
}
