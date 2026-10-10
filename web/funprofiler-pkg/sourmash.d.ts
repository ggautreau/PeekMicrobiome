/* tslint:disable */
/* eslint-disable */

export class ComputeParameters {
    free(): void;
    [Symbol.dispose](): void;
    constructor();
    set_dayhoff(dayhoff: boolean): void;
    set_hp(hp: boolean): void;
    set_ksizes(ksizes: Uint32Array): void;
    set_num(num: number): void;
    set_protein(is_protein: boolean): void;
    set_scaled(scaled: number): void;
    set_seed(seed: number): void;
    set_track_abundance(track: boolean): void;
}

export class FuncProfiler {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Load reference sketches from one sourmash `.sig` JSON document, which may
     * hold several signatures. Only sketches at the requested k and scale are
     * kept — a KO archive ships k=7, 11 and 15 together, and mixing them would
     * silently compare incomparable hashes. Returns how many were kept.
     */
    add_references_json(json: string, ksize: number, scaled: number): number;
    len(): number;
    constructor();
    /**
     * The prefetch pass, then the profile.
     *
     * For each reference, the number of hashes it shares with the sample; a
     * reference is reported when that reaches `min_overlap`. `f_match_query` is
     * the query contained by the match — sourmash's own definition, which is
     * `count_common / sample_size` — and the abundances are those fractions
     * renormalised to sum to one, which is what fmh-funprofiler writes out.
     *
     * Returned as CSV with the same two columns and the same header, so the
     * output can be diffed against the reference implementation rather than
     * eyeballed.
     */
    profile(sample: KmerMinHash, min_overlap: number): string;
}

export class KmerMinHash {
    free(): void;
    [Symbol.dispose](): void;
    add_sequence_js(buf: string): void;
    /**
     * Shared hashes with another sketch, downsampling to the coarser scale.
     */
    count_common_js(other: KmerMinHash): bigint;
    constructor(num: number, ksize: number, is_protein: boolean, dayhoff: boolean, hp: boolean, seed: number, scaled: number, track_abundance: boolean);
    /**
     * Hashes retained in this sketch. The denominator of `f_match_query`, and
     * the number that says whether a sample was deep enough to profile at all.
     */
    size_js(): number;
    to_json(): string;
}

export class Signature {
    free(): void;
    [Symbol.dispose](): void;
    add_from_file(fp: File, callback?: Function | null): void;
    add_sequence_js(buf: string): void;
    constructor(params: ComputeParameters);
    size(): number;
    to_json(): string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_computeparameters_free: (a: number, b: number) => void;
    readonly __wbg_funcprofiler_free: (a: number, b: number) => void;
    readonly __wbg_kmerminhash_free: (a: number, b: number) => void;
    readonly __wbg_signature_free: (a: number, b: number) => void;
    readonly computeparameters_new_with_params: () => number;
    readonly computeparameters_set_dayhoff: (a: number, b: number) => void;
    readonly computeparameters_set_hp: (a: number, b: number) => void;
    readonly computeparameters_set_ksizes: (a: number, b: number, c: number) => void;
    readonly computeparameters_set_num: (a: number, b: number) => void;
    readonly computeparameters_set_protein: (a: number, b: number) => void;
    readonly computeparameters_set_scaled: (a: number, b: number) => void;
    readonly computeparameters_set_seed: (a: number, b: number) => void;
    readonly computeparameters_set_track_abundance: (a: number, b: number) => void;
    readonly funcprofiler_add_references_json: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly funcprofiler_len: (a: number) => number;
    readonly funcprofiler_new: () => number;
    readonly funcprofiler_profile: (a: number, b: number, c: number) => [number, number, number, number];
    readonly kmerminhash_add_sequence_js: (a: number, b: number, c: number) => [number, number];
    readonly kmerminhash_count_common_js: (a: number, b: number) => [bigint, number, number];
    readonly kmerminhash_new_with_scaled: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
    readonly kmerminhash_size_js: (a: number) => number;
    readonly kmerminhash_to_json: (a: number) => [number, number, number, number];
    readonly signature_add_from_file: (a: number, b: any, c: number) => [number, number];
    readonly signature_add_sequence_js: (a: number, b: number, c: number) => [number, number];
    readonly signature_new_from_params: (a: number) => number;
    readonly signature_size: (a: number) => number;
    readonly signature_to_json: (a: number) => [number, number, number, number];
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
