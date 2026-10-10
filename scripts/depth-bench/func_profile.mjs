// The page's own functional profile, computed outside the browser.
//
//   node scripts/depth-bench/func_profile.mjs R1.fastq.gz R2.fastq.gz out.json
//
// NOT A REIMPLEMENTATION. It imports web/func-sketch.js — the module the worker
// feeds — and hands it the same bytes over the same two-stream interface the
// paired download path uses. The only thing replaced is `fetch`, because in the
// browser the wasm and the KEGG reference arrive over HTTP and here they are on
// disk. A second implementation of the sketching rules would measure the second
// implementation; this measures the page.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, "../../web");
const PKG = path.join(WEB, "funprofiler-pkg");
const REF = path.join(WEB, "db/kegg/ko-sketches-k11.ndjson.gz");

const [r1, r2, out] = process.argv.slice(2);
if (!r1 || !out) {
  console.error("usage: func_profile.mjs R1.fastq.gz [R2.fastq.gz] out.json");
  process.exit(2);
}

globalThis.fetch = async (u) => {
  const p = String(u).startsWith("file:") ? fileURLToPath(String(u)) : String(u);
  return new Response(fs.readFileSync(p), { status: 200 });
};

const { loadFuncRefs, newFuncSample } = await import(path.join(WEB, "func-sketch.js"));
const t0 = Date.now();
const info = await loadFuncRefs({ pkg: "file://" + PKG, refUrl: "file://" + REF });
const tRef = Date.now() - t0;

// Streamed through gunzip in 4 MB pieces, so the sketcher sees chunk boundaries
// that fall wherever they fall — exactly the condition the worker is under, and
// the one the parser has to be right about.
const feedFile = (file, sample, stream) => new Promise((res, rej) => {
  const gz = fs.createReadStream(file, { highWaterMark: 4 << 20 }).pipe(zlib.createGunzip());
  gz.on("data", (chunk) => sample.feed(chunk, stream));
  gz.on("end", res);
  gz.on("error", rej);
});

const t1 = Date.now();
const sample = newFuncSample();
await feedFile(r1, sample, 1);
if (r2) await feedFile(r2, sample, 2);
const prof = sample.finish();
const ms = Date.now() - t1;

fs.writeFileSync(out, JSON.stringify({
  r1: path.basename(r1), r2: r2 ? path.basename(r2) : null,
  orthologsInReference: info.orthologs, refLoadMs: tRef, profileMs: ms,
  reads: prof.reads, detected: Object.keys(prof.profile).length, profile: prof.profile,
}));
console.log(`${path.basename(out)}: ${prof.reads} reads, ` +
  `${Object.keys(prof.profile).length} orthologs, ${ms} ms`);
