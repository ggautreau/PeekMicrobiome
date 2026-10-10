// The stand-in, checked on the experiment's own reads.
//
//   node scripts/depth-bench/substitution.mjs R1.fastq.gz R2.fastq.gz
//
// §3.3 profiles the "page" arm with NATIVE sylph against the page's catalogue,
// because a browser would have cost hours the experiment did not have. That is
// only legitimate if the two really are the same profile, and §3.1 established
// that on a different run, a different database and a different depth.
//
// So this runs the page's own WebAssembly profiler — the same module the worker
// loads, the same feed path — on one of this experiment's rungs, against the
// 4,744-genome catalogue the experiment used, and prints what a comparison with
// the native TSV must be compared against. It does not run native sylph itself:
// the caller has that TSV already.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "../..");
const DB = path.join(REPO, "data/bench/refs/human-gut.syldb");

const [r1, r2, out] = process.argv.slice(2);
if (!r1) {
  console.error("usage: substitution.mjs R1.fastq.gz [R2.fastq.gz] [out.tsv]");
  process.exit(2);
}

const wasm = await import(path.join(REPO, "web/sylph-pkg/sylph_wasm.js"));
await wasm.default(fs.readFileSync(path.join(REPO, "web/sylph-pkg/sylph_wasm_bg.wasm")));
const t0 = Date.now();
const profiler = new wasm.Profiler(new Uint8Array(fs.readFileSync(DB)));
console.error(`base chargée en ${((Date.now() - t0) / 1000).toFixed(1)} s`);

// The bytes the worker would be handed: decompressed FASTQ, in whatever pieces
// the stream produces. No trimming step here — the ladder's subsamples are
// already the reads to profile, and streamTrimMulti's job (the read cap) has
// been done by seqtk.
const feed = (file, sink) => new Promise((res, rej) => {
  const gz = fs.createReadStream(file, { highWaterMark: 4 << 20 }).pipe(zlib.createGunzip());
  gz.on("data", sink);
  gz.on("end", res);
  gz.on("error", rej);
});

const t1 = Date.now();
let tsv;
if (r2) {
  profiler.begin_sample_pe(0);
  // INTERLEAVED, as the worker's paired path delivers them. The profiler's
  // paired side buffers each mate until its partner arrives, and feeding one
  // whole file before the other is not a shape the page ever produces — it
  // moved the third decimal of every abundance when it was tried.
  const chunks1 = [], chunks2 = [];
  await feed(r1, (c) => chunks1.push(Buffer.from(c)));
  await feed(r2, (c) => chunks2.push(Buffer.from(c)));
  for (let i = 0; i < Math.max(chunks1.length, chunks2.length); i++) {
    if (i < chunks1.length) profiler.feed_r1(chunks1[i]);
    if (i < chunks2.length) profiler.feed_r2(chunks2[i]);
  }
  tsv = profiler.finish_sample();
} else {
  profiler.begin_sample(0);
  await feed(r1, (c) => profiler.feed(c));
  tsv = profiler.finish_sample();
}
const ms = Date.now() - t1;
const rows = tsv.trimEnd().split("\n").length - 1;
console.error(`${profiler.sample_reads} lectures, ${rows} lignes, ${(ms / 1000).toFixed(1)} s`);
if (out) fs.writeFileSync(out, tsv);
else process.stdout.write(tsv);
