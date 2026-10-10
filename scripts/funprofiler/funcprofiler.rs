// Appended to sourmash src/core/src/wasm.rs by scripts/build_funprofiler_wasm.sh.

// Functional profiling in the browser.
//
// sourmash's WASM surface stops at sketching: it can turn reads into a
// signature and hand back JSON, but it cannot compare that signature against
// anything, so the half of fmh-funprofiler that assigns KEGG orthologs had to
// run elsewhere. This adds it.
//
// What fmh-funprofiler actually does is smaller than "gather" suggests, which
// is why this fits: `sourmash prefetch` is a linear pass computing one
// intersection per reference, and the profile is each match's share of the
// query's hashes, renormalised. No greedy min-set-cover, and — the reason this
// works at all under wasm32 — no RocksDB index, which sourmash excludes from
// the wasm target anyway.

use crate::signature::Signature as SigForRefs;

#[wasm_bindgen]
pub struct FuncProfiler {
    names: Vec<String>,
    refs: Vec<_KmerMinHash>,
}

#[wasm_bindgen]
impl FuncProfiler {
    #[wasm_bindgen(constructor)]
    pub fn new() -> FuncProfiler {
        FuncProfiler {
            names: Vec::new(),
            refs: Vec::new(),
        }
    }

    /// Load reference sketches from one sourmash `.sig` JSON document, which may
    /// hold several signatures. Only sketches at the requested k and scale are
    /// kept — a KO archive ships k=7, 11 and 15 together, and mixing them would
    /// silently compare incomparable hashes. Returns how many were kept.
    #[wasm_bindgen]
    pub fn add_references_json(
        &mut self,
        json: &str,
        ksize: u32,
        scaled: ScaledType,
    ) -> Result<usize, JsErrors> {
        let sigs = SigForRefs::from_reader(json.as_bytes())?;
        let mut kept = 0;
        for sig in sigs {
            let name = sig.name_str();
            for sketch in sig.sketches() {
                if let crate::sketch::Sketch::MinHash(mh) = sketch {
                    if mh.ksize() as u32 == ksize && mh.scaled() == scaled {
                        self.names.push(name.clone());
                        self.refs.push(mh);
                        kept += 1;
                    }
                }
            }
        }
        Ok(kept)
    }

    #[wasm_bindgen]
    pub fn len(&self) -> usize {
        self.refs.len()
    }

    /// The prefetch pass, then the profile.
    ///
    /// For each reference, the number of hashes it shares with the sample; a
    /// reference is reported when that reaches `min_overlap`. `f_match_query` is
    /// the query contained by the match — sourmash's own definition, which is
    /// `count_common / sample_size` — and the abundances are those fractions
    /// renormalised to sum to one, which is what fmh-funprofiler writes out.
    ///
    /// Returned as CSV with the same two columns and the same header, so the
    /// output can be diffed against the reference implementation rather than
    /// eyeballed.
    #[wasm_bindgen]
    pub fn profile(&self, sample: &KmerMinHash, min_overlap: u32) -> Result<String, JsErrors> {
        let sample_size = sample.0.size() as f64;
        let mut hits: Vec<(String, f64)> = Vec::new();
        let mut total = 0f64;

        for (name, r) in self.names.iter().zip(self.refs.iter()) {
            let common = sample.0.count_common(r, true)?;
            if common < min_overlap as u64 {
                continue;
            }
            let f_match_query = if sample_size > 0.0 {
                common as f64 / sample_size
            } else {
                0.0
            };
            total += f_match_query;
            hits.push((name.clone(), f_match_query));
        }

        hits.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        let mut out = String::from("ko_id,abundance\n");
        for (name, f) in hits {
            let abundance = if total > 0.0 { f / total } else { 0.0 };
            out.push_str(&format!("{},{}\n", name, abundance));
        }
        Ok(out)
    }
}

#[wasm_bindgen]
impl KmerMinHash {
    /// Hashes retained in this sketch. The denominator of `f_match_query`, and
    /// the number that says whether a sample was deep enough to profile at all.
    #[wasm_bindgen]
    pub fn size_js(&self) -> usize {
        self.0.size()
    }

    /// Shared hashes with another sketch, downsampling to the coarser scale.
    #[wasm_bindgen]
    pub fn count_common_js(&self, other: &KmerMinHash) -> Result<u64, JsErrors> {
        Ok(self.0.count_common(&other.0, true)?)
    }
}
