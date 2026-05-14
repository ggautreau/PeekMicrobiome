// Smoke-test the WASM Profiler from Node — same surface the browser uses.
import init, { Profiler } from "../web/sylph-pkg/sylph_wasm.js";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";

const wasmBytes = await fs.readFile("./web/sylph-pkg/sylph_wasm_bg.wasm");
await init(wasmBytes);

const syldb = new Uint8Array(await fs.readFile("./web/db/gut_mini.syldb"));
const fastq = new Uint8Array(await fs.readFile(process.argv[2] ?? "/tmp/smoke_100k.fastq"));
const maxReads = Number(process.argv[3] ?? 100000);

const t0 = performance.now();
const profiler = new Profiler(syldb);
console.log(`loaded db: ${profiler.database_size} genomes, k=${profiler.k}, c=${profiler.c}`);

const tsv = profiler.profile(fastq, maxReads);
const dt = (performance.now() - t0) / 1000;
console.log(`profiled in ${dt.toFixed(2)} s`);
console.log("---");
console.log(tsv);
