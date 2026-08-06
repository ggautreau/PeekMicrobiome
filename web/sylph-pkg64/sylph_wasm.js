/* @ts-self-types="./sylph_wasm.d.ts" */

export class Profiler {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProfilerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_profiler_free(ptr, 0);
    }
    /**
     * Start (or restart) a streamed single-end sample. `max_reads` caps the
     * number of records sketched (0 = no cap). Resets any sketch in progress.
     * @param {number} max_reads
     */
    begin_sample(max_reads) {
        wasm.profiler_begin_sample(this.__wbg_ptr, max_reads);
    }
    /**
     * Start (or restart) a streamed paired-end sample. `max_reads` caps the
     * number of *pairs* sketched (0 = no cap).
     * @param {number} max_reads
     */
    begin_sample_pe(max_reads) {
        wasm.profiler_begin_sample_pe(this.__wbg_ptr, max_reads);
    }
    /**
     * Returns the `c` (sub-sampling rate) of the loaded database.
     * @returns {number}
     */
    get c() {
        const ret = wasm.profiler_c(this.__wbg_ptr);
        return ret;
    }
    /**
     * Abandon the sample in progress and free everything it holds.
     *
     * Without it, a cancelled or failed sample keeps its k-mer map and dedup
     * table pinned in linear memory until the next `begin_sample*` — hundreds
     * of MiB per worker, which wasm never returns to the OS. Safe to call at
     * any time, including when no sample is in progress.
     */
    cancel_sample() {
        wasm.profiler_cancel_sample(this.__wbg_ptr);
    }
    /**
     * Returns the number of genome sketches loaded — handy as a smoke test.
     * @returns {number}
     */
    get database_size() {
        const ret = wasm.profiler_database_size(this.__wbg_ptr);
        return ret;
    }
    /**
     * Feed the next slice of the single-end FASTQ. Returns the cumulative
     * number of reads sketched.
     * @param {Uint8Array} chunk
     * @returns {number}
     */
    feed(chunk) {
        const ptr0 = passArray8ToWasm0(chunk, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.profiler_feed(this.__wbg_ptr, ptr0, len0);
        return ret >>> 0;
    }
    /**
     * Feed the next slice of the R1 stream. Returns the cumulative pair count.
     * R1 and R2 advance independently; only the imbalance is buffered.
     * @param {Uint8Array} chunk
     * @returns {number}
     */
    feed_r1(chunk) {
        const ptr0 = passArray8ToWasm0(chunk, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.profiler_feed_r1(this.__wbg_ptr, ptr0, len0);
        return ret >>> 0;
    }
    /**
     * Feed the next slice of the R2 stream. Returns the cumulative pair count.
     * @param {Uint8Array} chunk
     * @returns {number}
     */
    feed_r2(chunk) {
        const ptr0 = passArray8ToWasm0(chunk, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.profiler_feed_r2(this.__wbg_ptr, ptr0, len0);
        return ret >>> 0;
    }
    /**
     * Close the streamed sample (single- or paired-end), run the profile
     * inference and return the TSV. The sketcher is consumed; call
     * `begin_sample*` again for the next sample.
     * @returns {string}
     */
    finish_sample() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.profiler_finish_sample(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Returns the `k` of the loaded database.
     * @returns {number}
     */
    get k() {
        const ret = wasm.profiler_k(this.__wbg_ptr);
        return ret;
    }
    /**
     * Load a sylph database. `syldb` is the raw bytes of a `.syldb` file
     * (bincode-serialised `Vec<GenomeSketch>`).
     * @param {Uint8Array} syldb
     */
    constructor(syldb) {
        const ptr0 = passArray8ToWasm0(syldb, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.profiler_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        ProfilerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Paired-end only: how far ahead the leading mate is, in reads. This is
     * the only thing the PE sketcher buffers (~184 bytes per queued read), so
     * the JS side throttles the leading mate on it.
     * @returns {number}
     */
    get pair_lag() {
        const ret = wasm.profiler_pair_lag(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * R1 records still to come: decoded *and* still held in the carry.
     *
     * `pair_queued_r1` is the memory number (what the queue costs right now);
     * this is the "can this mate still produce a partner?" number, and it is
     * the one the JS cross-stop rule must use. The last record of a file with
     * no trailing newline lives in the carry until `finish_sample()`, so
     * `pair_queued_r1` reads 0 while a pair is still owed — and the surviving
     * mate would be cut one pair short of `profile_pe()`.
     * @returns {number}
     */
    get pair_pending_r1() {
        const ret = wasm.profiler_pair_pending_r1(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * R2 records still to come. See `pair_pending_r1`.
     * @returns {number}
     */
    get pair_pending_r2() {
        const ret = wasm.profiler_pair_pending_r2(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * R1 records decoded and still waiting for their mate.
     * @returns {number}
     */
    get pair_queued_r1() {
        const ret = wasm.profiler_pair_queued_r1(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * R2 records decoded and still waiting for their mate.
     * @returns {number}
     */
    get pair_queued_r2() {
        const ret = wasm.profiler_pair_queued_r2(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Profile a single FASTQ sample against the loaded database.
     *
     * `fastq` should be uncompressed FASTQ bytes. `max_reads` caps the number
     * of records sketched (0 = no cap).
     *
     * Returns a sylph-compatible TSV string (with the same column order
     * produced by `sylph profile`).
     * @param {Uint8Array} fastq
     * @param {number} max_reads
     * @returns {string}
     */
    profile(fastq, max_reads) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passArray8ToWasm0(fastq, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.profiler_profile(this.__wbg_ptr, ptr0, len0, max_reads);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Paired-end equivalent of `profile()`. `r1` and `r2` are the uncompressed
     * FASTQ bytes for the two mates of one sample. Records are read in lockstep;
     * dedup uses an inter-mate k-mer pair to drop PCR duplicates.
     * @param {Uint8Array} r1
     * @param {Uint8Array} r2
     * @param {number} max_reads
     * @returns {string}
     */
    profile_pe(r1, r2, max_reads) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passArray8ToWasm0(r1, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(r2, wasm.__wbindgen_malloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.profiler_profile_pe(this.__wbg_ptr, ptr0, len0, ptr1, len1, max_reads);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * True once the `max_reads` cap is reached — stop feeding.
     * @returns {boolean}
     */
    get sample_done() {
        const ret = wasm.profiler_sample_done(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * True when no further byte can change the outcome: cap reached, stream
     * rejected, or needletail gave up on a malformed record. Stop feeding.
     * @returns {boolean}
     */
    get sample_halted() {
        const ret = wasm.profiler_sample_halted(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * True when the stream has been rejected: `finish_sample()` will fail, so
     * there is nothing to gain from reading (and gunzipping) the rest.
     * @returns {boolean}
     */
    get sample_invalid() {
        const ret = wasm.profiler_sample_invalid(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Reads (single-end) or pairs (paired-end) sketched so far.
     * @returns {number}
     */
    get sample_reads() {
        const ret = wasm.profiler_sample_reads(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) Profiler.prototype[Symbol.dispose] = Profiler.prototype.free;

/**
 * Deliberately panic inside the wasm module. Exists so the panic hook above
 * can be proven to reach the browser console on both wasm32 and wasm64;
 * nothing in web/ calls it.
 */
export function debug_force_panic() {
    wasm.debug_force_panic();
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_string_get_b0ca35b86a603356: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setFloat64(Number(arg0) + 8 * 1, len1, true);
            getDataViewMemory0().setFloat64(Number(arg0) + 8 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_debug_87fd9b1a625b7efb: function(arg0) {
            console.debug(arg0);
        },
        __wbg_error_744744ff0c9861e6: function(arg0) {
            console.error(arg0);
        },
        __wbg_error_d94ab0a9d169ec7f: function(arg0, arg1) {
            console.error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_get_78f252d074a84d0b: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_info_eadbe775a8e2e9eb: function(arg0) {
            console.info(arg0);
        },
        __wbg_log_d267660666346fb3: function(arg0) {
            console.log(arg0);
        },
        __wbg_new_b667d279fd5aa943: function(arg0, arg1) {
            const ret = new Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_warn_b1370d804fa3e259: function(arg0) {
            console.warn(arg0);
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./sylph_wasm_bg.js": import0,
    };
}

const ProfilerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_profiler_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1);
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1);
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1);

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1);
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1);
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('sylph_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
