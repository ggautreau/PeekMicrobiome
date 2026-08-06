/* tslint:disable */
/* eslint-disable */

export class Profiler {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Start (or restart) a streamed single-end sample. `max_reads` caps the
     * number of records sketched (0 = no cap). Resets any sketch in progress.
     */
    begin_sample(max_reads: number): void;
    /**
     * Start (or restart) a streamed paired-end sample. `max_reads` caps the
     * number of *pairs* sketched (0 = no cap).
     */
    begin_sample_pe(max_reads: number): void;
    /**
     * Abandon the sample in progress and free everything it holds.
     *
     * Without it, a cancelled or failed sample keeps its k-mer map and dedup
     * table pinned in linear memory until the next `begin_sample*` — hundreds
     * of MiB per worker, which wasm never returns to the OS. Safe to call at
     * any time, including when no sample is in progress.
     */
    cancel_sample(): void;
    /**
     * Feed the next slice of the single-end FASTQ. Returns the cumulative
     * number of reads sketched.
     */
    feed(chunk: Uint8Array): number;
    /**
     * Feed the next slice of the R1 stream. Returns the cumulative pair count.
     * R1 and R2 advance independently; only the imbalance is buffered.
     */
    feed_r1(chunk: Uint8Array): number;
    /**
     * Feed the next slice of the R2 stream. Returns the cumulative pair count.
     */
    feed_r2(chunk: Uint8Array): number;
    /**
     * Close the streamed sample (single- or paired-end), run the profile
     * inference and return the TSV. The sketcher is consumed; call
     * `begin_sample*` again for the next sample.
     */
    finish_sample(): string;
    /**
     * Load a sylph database. `syldb` is the raw bytes of a `.syldb` file
     * (bincode-serialised `Vec<GenomeSketch>`).
     */
    constructor(syldb: Uint8Array);
    /**
     * Profile a single FASTQ sample against the loaded database.
     *
     * `fastq` should be uncompressed FASTQ bytes. `max_reads` caps the number
     * of records sketched (0 = no cap).
     *
     * Returns a sylph-compatible TSV string (with the same column order
     * produced by `sylph profile`).
     */
    profile(fastq: Uint8Array, max_reads: number): string;
    /**
     * Paired-end equivalent of `profile()`. `r1` and `r2` are the uncompressed
     * FASTQ bytes for the two mates of one sample. Records are read in lockstep;
     * dedup uses an inter-mate k-mer pair to drop PCR duplicates.
     */
    profile_pe(r1: Uint8Array, r2: Uint8Array, max_reads: number): string;
    /**
     * Returns the `c` (sub-sampling rate) of the loaded database.
     */
    readonly c: number;
    /**
     * Returns the number of genome sketches loaded — handy as a smoke test.
     */
    readonly database_size: number;
    /**
     * Returns the `k` of the loaded database.
     */
    readonly k: number;
    /**
     * Paired-end only: how far ahead the leading mate is, in reads. This is
     * the only thing the PE sketcher buffers (~184 bytes per queued read), so
     * the JS side throttles the leading mate on it.
     */
    readonly pair_lag: number;
    /**
     * R1 records still to come: decoded *and* still held in the carry.
     *
     * `pair_queued_r1` is the memory number (what the queue costs right now);
     * this is the "can this mate still produce a partner?" number, and it is
     * the one the JS cross-stop rule must use. The last record of a file with
     * no trailing newline lives in the carry until `finish_sample()`, so
     * `pair_queued_r1` reads 0 while a pair is still owed — and the surviving
     * mate would be cut one pair short of `profile_pe()`.
     */
    readonly pair_pending_r1: number;
    /**
     * R2 records still to come. See `pair_pending_r1`.
     */
    readonly pair_pending_r2: number;
    /**
     * R1 records decoded and still waiting for their mate.
     */
    readonly pair_queued_r1: number;
    /**
     * R2 records decoded and still waiting for their mate.
     */
    readonly pair_queued_r2: number;
    /**
     * True once the `max_reads` cap is reached — stop feeding.
     */
    readonly sample_done: boolean;
    /**
     * True when no further byte can change the outcome: cap reached, stream
     * rejected, or needletail gave up on a malformed record. Stop feeding.
     */
    readonly sample_halted: boolean;
    /**
     * True when the stream has been rejected: `finish_sample()` will fail, so
     * there is nothing to gain from reading (and gunzipping) the rest.
     */
    readonly sample_invalid: boolean;
    /**
     * Reads (single-end) or pairs (paired-end) sketched so far.
     */
    readonly sample_reads: number;
}

/**
 * Deliberately panic inside the wasm module. Exists so the panic hook above
 * can be proven to reach the browser console on both wasm32 and wasm64;
 * nothing in web/ calls it.
 */
export function debug_force_panic(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_profiler_free: (a: number, b: number) => void;
    readonly debug_force_panic: () => void;
    readonly profiler_begin_sample: (a: number, b: number) => void;
    readonly profiler_begin_sample_pe: (a: number, b: number) => void;
    readonly profiler_c: (a: number) => number;
    readonly profiler_cancel_sample: (a: number) => void;
    readonly profiler_database_size: (a: number) => number;
    readonly profiler_feed: (a: number, b: number, c: number) => number;
    readonly profiler_feed_r1: (a: number, b: number, c: number) => number;
    readonly profiler_feed_r2: (a: number, b: number, c: number) => number;
    readonly profiler_finish_sample: (a: number) => [number, number, number, number];
    readonly profiler_k: (a: number) => number;
    readonly profiler_new: (a: number, b: number) => [number, number, number];
    readonly profiler_pair_lag: (a: number) => number;
    readonly profiler_pair_pending_r1: (a: number) => number;
    readonly profiler_pair_pending_r2: (a: number) => number;
    readonly profiler_pair_queued_r1: (a: number) => number;
    readonly profiler_pair_queued_r2: (a: number) => number;
    readonly profiler_profile: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly profiler_profile_pe: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly profiler_sample_done: (a: number) => number;
    readonly profiler_sample_halted: (a: number) => number;
    readonly profiler_sample_invalid: (a: number) => number;
    readonly profiler_sample_reads: (a: number) => number;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
