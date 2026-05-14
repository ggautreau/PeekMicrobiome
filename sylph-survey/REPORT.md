# Porting sylph to WebAssembly — survey report

**Target:** `wasm32-unknown-unknown` with `wasm-bindgen`, running in a browser
worker. Profiling only — we do not need `sketch` in the browser since the
database is built natively and shipped as a static asset.

**Upstream surveyed:** `bluenote-1577/sylph` @ `cf6ee06` (v0.9.0 + docs commit).

## Summary

A WASM port is feasible without changing sylph's algorithms or sketch format.
The work is mechanical: gate out three non-WASM crates, sequentialise rayon,
and refactor FASTQ readers to accept a `Read` impl instead of a path. Estimate
**~1–2 weeks** to a working in-browser profiler.

## Dependency audit

| Crate | Status | Action |
|---|---|---|
| `needletail 0.5` | ✅ pure Rust, but default features pull C libs (bzip2/zstd/xz2) | Use `default-features = false`. Already exposes `parse_fastx_reader` for `Read` impls. |
| `rayon` | ⚠ WASM-incompatible by default | v1: feature-flag out, replace `into_par_iter()` with `into_iter()` (5 call sites). v2: `wasm-bindgen-rayon` (needs SharedArrayBuffer + COOP/COEP). |
| `flate2 (zlib-ng)` | ❌ C dep, no WASM | Switch features to `rust_backend` (miniz_oxide). May not be needed at all — browser does gzip via `DecompressionStream` before bytes enter WASM. |
| `simple_logger (stderr)` | ❌ stderr not meaningful in WASM | Replace with `console_log` crate, or no-op behind cfg. |
| `clap` | ✅ unused in WASM (no CLI) | Exclude binary target from WASM build. |
| `memory-stats` | ❌ uses platform APIs | `cfg(not(target_arch = "wasm32"))` gate on the two call sites in `src/sketch.rs:28,41`. |
| `tikv-jemallocator` | ✅ already `cfg(target_env = "musl")` only | No action. |
| `smallvec`, `serde`, `bincode`, `fxhash`, `statrs`, `nalgebra`, `rand`, `fastrand`, `regex`, `scalable_cuckoo_filter`, `serde_yaml` | ✅ pure Rust | No action. |

## Architecture — what stays, what changes

**Stays unchanged**
- `seeding.rs` (the WASM build automatically picks the scalar path; `avx2_seeding.rs` is already `#[cfg(target_arch = "x86_64")]`).
- `inference.rs`, `contain.rs`'s core math.
- `.syldb` format: bincode-serialised `Vec<GenomeSketch>` / `SequencesSketch`. Deterministic, portable, bit-identical between native and WASM.

**Needs refactor**
- `sketch.rs` and `contain.rs` open files through `parse_fastx_file(path)` (5 sites total). Pull each into a helper that takes a `Box<dyn FastxReader>`; the native CLI keeps using `parse_fastx_file`, the WASM build wraps a JS `ReadableStream` as a `Read` impl.
- `contain::contain()` builds a Rayon global pool and writes to a `Box<dyn Write>` writer. For WASM, split into a library function `profile_reads(args, db_bytes, reads_reader) -> ProfileResult` and let the CLI keep the existing wrapper.
- `into_par_iter().for_each(|i| { ... lock_mutex(state) ... })` in `sketch.rs:313,371,428` and `contain.rs:272,289,307,452,531`. Sequentialising is safe: the closures already use `Mutex<Vec<_>>` for collection, so swapping to `into_iter()` is a one-line change per site (drop the Mutex too).

**.syldb loading**
- `bincode::deserialize_from(reader)` already takes any `Read`. Pass `&db_bytes[..]` (which impls `Read`) — no path I/O needed.

## Suggested public WASM API

```rust
// crates/sylph-wasm/src/lib.rs
#[wasm_bindgen]
pub struct Profiler { /* holds Vec<GenomeSketch> + params */ }

#[wasm_bindgen]
impl Profiler {
    #[wasm_bindgen(constructor)]
    pub fn new(syldb: &[u8], opts: JsValue) -> Result<Profiler, JsValue> { ... }

    /// `reads_reader` is a JS ReadableStream wrapped by streaming-iterator glue.
    /// `progress` is an optional JS callback (records_seen, bytes_seen).
    pub async fn profile(
        &self,
        reads_reader: JsReadableStream,
        max_reads: Option<usize>,
        progress: Option<js_sys::Function>,
    ) -> Result<JsValue /* JSON result */, JsValue> { ... }
}
```

`max_reads` lets the browser side cut off after N records without needing to
pre-truncate the FASTQ — the existing downsampler stays useful for offline
exports, but the WASM build can do the same cap internally.

## Cargo.toml changes (concrete diff)

```toml
[features]
default = ["native"]
native = ["rayon", "memory-stats", "simple_logger", "clap"]
wasm   = []

[dependencies]
needletail = { version = "0.5", default-features = false }
rayon = { version = "1", optional = true }
memory-stats = { version = "1", optional = true }
simple_logger = { version = "3", optional = true, features = ["stderr"] }
clap = { version = "3", optional = true, features = ["derive"] }
flate2 = { version = "1.0.17", default-features = false, features = ["rust_backend"] }
# ...rest unchanged...

[target.'cfg(target_arch = "wasm32")'.dependencies]
wasm-bindgen = "0.2"
js-sys = "0.3"
web-sys = { version = "0.3", features = ["ReadableStream", "console"] }
console_error_panic_hook = "0.1"
```

Each `use rayon::prelude::*;` site gets a parallel-or-sequential wrapper:

```rust
#[cfg(feature = "rayon")] use rayon::prelude::*;
#[cfg(feature = "rayon")] fn par_iter<T>(v: Vec<T>) -> impl ParallelIterator<Item = T> where T: Send { v.into_par_iter() }
#[cfg(not(feature = "rayon"))] fn par_iter<T>(v: Vec<T>) -> impl Iterator<Item = T> { v.into_iter() }
```

Then `iter_vec.into_par_iter().for_each(...)` becomes `par_iter(iter_vec).for_each(...)`.

## Order of work

1. **Fork repo as `sylph-wasm` submodule of nano_gut_sylph**.
2. **Add `wasm` feature** + cfg-gates listed above. Verify native build still
   works (`cargo build --no-default-features --features native`).
3. **Refactor 5 `parse_fastx_file` sites** to accept a reader; native callers
   open the file, WASM caller passes a streaming JS bridge.
4. **Sequentialise rayon** under `#[cfg(not(feature = "rayon"))]`. Keep the
   Mutex-based collection patterns; they're trivial under sequential
   iteration but no harm.
5. **First WASM build**: `cargo build --target wasm32-unknown-unknown --no-default-features --features wasm`. Expect dep errors; iterate.
6. **wasm-bindgen glue**: a thin crate that exposes `Profiler` and a small JS
   adapter that bridges `ReadableStream` → `std::io::Read`.
7. **Equivalence test**: profile the same FASTQ + `.syldb` natively and in
   WASM; diff TSV output — should be bit-identical (sketches are deterministic).
8. **Optional: threading via `wasm-bindgen-rayon`**. Pulls in SharedArrayBuffer
   requirements (COOP/COEP headers). Worth doing only after measuring.

## Open questions before coding

- Memory budget: at runtime we hold `Vec<GenomeSketch>` (the loaded `.syldb`)
  + per-query state. Need to measure peak RSS for native profiling against the
  built gut `.syldb` to confirm we stay under wasm32's 4 GB ceiling. See
  `docs/syldb_size_estimate.md`.
- ReadableStream → `Read` bridge: needs to be `async` on the JS side but
  needletail's API is sync. Either (a) buffer the whole FASTQ in memory first
  (bad for 5M reads), or (b) write a synchronous `Read` impl that blocks on a
  `BroadcastChannel`-fed buffer queue fed by an async pump in JS — non-trivial
  but standard pattern.
