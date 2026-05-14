/* tslint:disable */
/* eslint-disable */

export class Profiler {
    free(): void;
    [Symbol.dispose](): void;
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
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_profiler_free: (a: number, b: number) => void;
    readonly profiler_c: (a: number) => number;
    readonly profiler_database_size: (a: number) => number;
    readonly profiler_k: (a: number) => number;
    readonly profiler_new: (a: number, b: number) => [number, number, number];
    readonly profiler_profile: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly profiler_profile_pe: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
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
