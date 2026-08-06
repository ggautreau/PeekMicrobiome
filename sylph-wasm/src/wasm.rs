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
use crate::sketch::{
    sketch_pair_sequences_from_bytes, sketch_sequences_from_bytes, PairStreamSketcher,
    StreamSketcher,
};
use crate::types::{AniResult, GenomeSketch};

// ---------------------------------------------------------------------------
// Panic reporting.
//
// We do NOT use console_error_panic_hook 0.1.7 here. Its cfg_if selects the
// console.error path on `target_arch = "wasm32"` only; under wasm64 that arm is
// false and it falls back to writing the panic to `std::io::stderr()`, which on
// wasm*-unknown-unknown goes nowhere. The hook installs, returns Ok, and every
// Rust panic becomes invisible — exactly the failure mode you cannot afford
// when you are deliberately pushing linear memory to its limit.
//
// This hook is ~10 lines and is arch-agnostic: it always calls console.error,
// and appends a JS stack captured from a throwaway Error so the wasm frames
// (with names, when the build is not stripped) come along.
// ---------------------------------------------------------------------------
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(msg: &str);
}

/// Install the panic hook. Idempotent; safe to call from every entry point.
pub fn set_panic_hook() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            // js-sys 0.3 exposes no Error::stack() getter, so read the
            // property reflectively. Absent stack => empty string, never a panic.
            let err = js_sys::Error::new("");
            let stack = js_sys::Reflect::get(err.as_ref(), &JsValue::from_str("stack"))
                .ok()
                .and_then(|v| v.as_string())
                .unwrap_or_default();
            console_error(&format!("sylph-wasm panic: {}\n{}", info, stack));
        }));
    });
}

/// Deliberately panic inside the wasm module. Exists so the panic hook above
/// can be proven to reach the browser console on both wasm32 and wasm64;
/// nothing in web/ calls it.
#[wasm_bindgen]
pub fn debug_force_panic() {
    set_panic_hook();
    panic!("debug_force_panic: deliberate panic to exercise the hook");
}

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
    /// Streaming single-end sample in progress, if any.
    stream: Option<StreamSketcher>,
    /// Streaming paired-end sample in progress, if any.
    stream_pe: Option<PairStreamSketcher>,
}

#[wasm_bindgen]
impl Profiler {
    /// Load a sylph database. `syldb` is the raw bytes of a `.syldb` file
    /// (bincode-serialised `Vec<GenomeSketch>`).
    #[wasm_bindgen(constructor)]
    pub fn new(syldb: &[u8]) -> Result<Profiler, JsValue> {
        // Show Rust panics in the browser console (see set_panic_hook above:
        // console_error_panic_hook is wasm32-only and silently mute on wasm64).
        set_panic_hook();
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
        Ok(Profiler {
            genome_sketches,
            stream: None,
            stream_pe: None,
        })
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
        // No `.to_vec()` here: the caller's slice already lives in linear
        // memory (wasm-bindgen copied it in), and `Cursor` reads straight from
        // a borrowed slice. Copying it again doubled peak memory for nothing —
        // 2.18 GB of the 2.72 GB peak at 3M reads.
        let sequence_sketch = sketch_sequences_from_bytes(
            fastq,
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
            r1,
            r2,
            "browser_sample".to_string(),
            c,
            k,
            /* no_dedup= */ false,
            cap,
        )
        .ok_or_else(|| JsValue::from_str("could not sketch FASTQ pair — not a valid FASTQ stream"))?;
        self.profile_sketch(sequence_sketch)
    }

    // -----------------------------------------------------------------
    // Streaming API — the FASTQ never has to exist as one buffer.
    //
    //   profiler.begin_sample(maxReads);
    //   while (chunk = await next()) {
    //       profiler.feed(chunk);
    //       if (profiler.sample_done) break;
    //   }
    //   const tsv = profiler.finish_sample();
    //
    // Chunks may be split anywhere — mid-line, mid-record; the sketcher
    // carries the partial record over. FASTQ only (4 lines per record): a
    // stream that does not open with '@' is refused outright and
    // `finish_sample()` fails, rather than being cut into 4-line pieces that
    // would mean nothing for a FASTA. `profile()`/`profile_pe()` keep reading
    // FASTA; the streaming path deliberately does not.
    // -----------------------------------------------------------------

    /// Start (or restart) a streamed single-end sample. `max_reads` caps the
    /// number of records sketched (0 = no cap). Resets any sketch in progress.
    pub fn begin_sample(&mut self, max_reads: u32) {
        let cap = if max_reads == 0 {
            None
        } else {
            Some(max_reads as usize)
        };
        let c = self.genome_sketches[0].c;
        let k = self.genome_sketches[0].k;
        self.stream_pe = None;
        self.stream = Some(StreamSketcher::new(
            "browser_sample".to_string(),
            c,
            k,
            /* no_dedup= */ false,
            cap,
        ));
    }

    /// Feed the next slice of the single-end FASTQ. Returns the cumulative
    /// number of reads sketched.
    pub fn feed(&mut self, chunk: &[u8]) -> u32 {
        match self.stream.as_mut() {
            Some(s) => s.feed(chunk) as u32,
            None => 0,
        }
    }

    /// Start (or restart) a streamed paired-end sample. `max_reads` caps the
    /// number of *pairs* sketched (0 = no cap).
    pub fn begin_sample_pe(&mut self, max_reads: u32) {
        let cap = if max_reads == 0 {
            None
        } else {
            Some(max_reads as usize)
        };
        let c = self.genome_sketches[0].c;
        let k = self.genome_sketches[0].k;
        self.stream = None;
        self.stream_pe = Some(PairStreamSketcher::new(
            "browser_sample".to_string(),
            c,
            k,
            /* no_dedup= */ false,
            cap,
        ));
    }

    /// Feed the next slice of the R1 stream. Returns the cumulative pair count.
    /// R1 and R2 advance independently; only the imbalance is buffered.
    pub fn feed_r1(&mut self, chunk: &[u8]) -> u32 {
        match self.stream_pe.as_mut() {
            Some(s) => s.feed_r1(chunk) as u32,
            None => 0,
        }
    }

    /// Feed the next slice of the R2 stream. Returns the cumulative pair count.
    pub fn feed_r2(&mut self, chunk: &[u8]) -> u32 {
        match self.stream_pe.as_mut() {
            Some(s) => s.feed_r2(chunk) as u32,
            None => 0,
        }
    }

    /// Reads (single-end) or pairs (paired-end) sketched so far.
    #[wasm_bindgen(getter)]
    pub fn sample_reads(&self) -> u32 {
        if let Some(s) = self.stream.as_ref() {
            return s.n_reads() as u32;
        }
        if let Some(s) = self.stream_pe.as_ref() {
            return s.n_reads() as u32;
        }
        0
    }

    /// True once the `max_reads` cap is reached — stop feeding.
    #[wasm_bindgen(getter)]
    pub fn sample_done(&self) -> bool {
        if let Some(s) = self.stream.as_ref() {
            return s.is_done();
        }
        if let Some(s) = self.stream_pe.as_ref() {
            return s.is_done();
        }
        false
    }

    /// True when the stream has been rejected: `finish_sample()` will fail, so
    /// there is nothing to gain from reading (and gunzipping) the rest.
    #[wasm_bindgen(getter)]
    pub fn sample_invalid(&self) -> bool {
        if let Some(s) = self.stream.as_ref() {
            return s.is_invalid();
        }
        if let Some(s) = self.stream_pe.as_ref() {
            return s.is_invalid();
        }
        false
    }

    /// True when no further byte can change the outcome: cap reached, stream
    /// rejected, or needletail gave up on a malformed record. Stop feeding.
    #[wasm_bindgen(getter)]
    pub fn sample_halted(&self) -> bool {
        if let Some(s) = self.stream.as_ref() {
            return s.is_halted();
        }
        if let Some(s) = self.stream_pe.as_ref() {
            return s.is_halted();
        }
        false
    }

    /// Paired-end only: how far ahead the leading mate is, in reads. This is
    /// the only thing the PE sketcher buffers (~184 bytes per queued read), so
    /// the JS side throttles the leading mate on it.
    #[wasm_bindgen(getter)]
    pub fn pair_lag(&self) -> u32 {
        match self.stream_pe.as_ref() {
            Some(s) => s.pair_lag() as u32,
            None => 0,
        }
    }

    /// R1 records decoded and still waiting for their mate.
    #[wasm_bindgen(getter)]
    pub fn pair_queued_r1(&self) -> u32 {
        match self.stream_pe.as_ref() {
            Some(s) => s.queued_r1() as u32,
            None => 0,
        }
    }

    /// R2 records decoded and still waiting for their mate.
    #[wasm_bindgen(getter)]
    pub fn pair_queued_r2(&self) -> u32 {
        match self.stream_pe.as_ref() {
            Some(s) => s.queued_r2() as u32,
            None => 0,
        }
    }

    /// R1 records still to come: decoded *and* still held in the carry.
    ///
    /// `pair_queued_r1` is the memory number (what the queue costs right now);
    /// this is the "can this mate still produce a partner?" number, and it is
    /// the one the JS cross-stop rule must use. The last record of a file with
    /// no trailing newline lives in the carry until `finish_sample()`, so
    /// `pair_queued_r1` reads 0 while a pair is still owed — and the surviving
    /// mate would be cut one pair short of `profile_pe()`.
    #[wasm_bindgen(getter)]
    pub fn pair_pending_r1(&self) -> u32 {
        match self.stream_pe.as_ref() {
            Some(s) => s.pending_r1() as u32,
            None => 0,
        }
    }

    /// R2 records still to come. See `pair_pending_r1`.
    #[wasm_bindgen(getter)]
    pub fn pair_pending_r2(&self) -> u32 {
        match self.stream_pe.as_ref() {
            Some(s) => s.pending_r2() as u32,
            None => 0,
        }
    }

    /// Abandon the sample in progress and free everything it holds.
    ///
    /// Without it, a cancelled or failed sample keeps its k-mer map and dedup
    /// table pinned in linear memory until the next `begin_sample*` — hundreds
    /// of MiB per worker, which wasm never returns to the OS. Safe to call at
    /// any time, including when no sample is in progress.
    pub fn cancel_sample(&mut self) {
        self.stream = None;
        self.stream_pe = None;
    }

    /// Close the streamed sample (single- or paired-end), run the profile
    /// inference and return the TSV. The sketcher is consumed; call
    /// `begin_sample*` again for the next sample.
    pub fn finish_sample(&mut self) -> Result<String, JsValue> {
        let sketch = if let Some(mut s) = self.stream.take() {
            s.finish()
        } else if let Some(mut s) = self.stream_pe.take() {
            s.finish()
        } else {
            return Err(JsValue::from_str(
                "finish_sample() called without begin_sample()/begin_sample_pe()",
            ));
        };
        let sketch = sketch.ok_or_else(|| {
            // Reached when the stream never opened with '@' (a FASTA, a text
            // file, a mis-decompressed .gz) or when a mate was empty. Say so:
            // the alternative — a sketch built out of 4-line slices of a FASTA
            // — would be reported as a perfectly ordinary "0 species detected".
            JsValue::from_str(
                "could not sketch FASTQ — not a valid FASTQ stream \
                 (this path reads FASTQ only, and both mates must be present)",
            )
        })?;
        self.profile_sketch(sketch)
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
