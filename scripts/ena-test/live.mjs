// ONE run against the real ENA, end to end: accession -> resolution -> streamed
// download -> gunzip -> incremental sketch -> TSV. Nothing is written to disk.
//
//   node scripts/ena-test/live.mjs [accession] [maxReads]
//
// Defaults to ERR14098592 — the smallest run of PRJEB83730 (102 MiB) — on
// purpose: this is the only test here that costs bandwidth, and it exists to
// prove the shipped modules work against the real service, not to benchmark it.
// It uses the bundled 6 MB gut_mini.syldb, not the 433 MB database, for the same
// reason.
//
// The numbers it prints (throughput, wall time, requests, resumes) are the ones
// the UI's ETA is built on.

import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

const ACC = process.argv[2] ?? "ERR14098592";
const MAX_READS = Number(process.argv[3] ?? 20_000_000);

const { resolveAccession, urlSource, readCountVerdict, ENA_FIELDS, ENA_META_FIELDS } =
  await import(path.join(REPO, "web/ena.js"));

// Every field name, against the API's own list, BEFORE anything else runs.
//
// The portal answers one unknown name with `HTTP 400: Invalid fieldName(s)
// supplied` and no rows at all — so a typo in ENA_FIELDS does not lose a column,
// it loses fastq_ftp, and the page stops being able to profile anything. Nothing
// else catches it: node-suite.mjs serves its own fixtures and asserts only
// accession/result/format on the query, and the field list is the one part of
// that URL the ENA gets to have an opinion about.
{
  const url = "https://www.ebi.ac.uk/ena/portal/api/returnFields?result=read_run&format=json";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`returnFields: HTTP ${res.status}`);
  const known = new Set((await res.json()).map((f) => f.columnId));
  const asked = ENA_FIELDS.split(",");
  const bad = asked.filter((f) => !known.has(f));
  if (bad.length) {
    throw new Error(`ENA_FIELDS names ${bad.length} field(s) the portal does not have: ` +
      `${bad.join(", ")} — this returns HTTP 400 for the WHOLE request, fastq_ftp included`);
  }
  const orphan = ENA_META_FIELDS.filter((f) => !asked.includes(f));
  if (orphan.length) throw new Error(`ENA_META_FIELDS asks for what ENA_FIELDS never requests: ${orphan.join(", ")}`);
  console.log(`ENA_FIELDS: ${asked.length} fields, all known to the portal ` +
    `(${ENA_META_FIELDS.length} of them descriptive)`);
}
const { streamTrimMulti, streamTrimPair } = await import(path.join(REPO, "web/fastq-trim.js"));
const initWasm = (await import(path.join(REPO, "web/sylph-pkg/sylph_wasm.js"))).default;
const { Profiler } = await import(path.join(REPO, "web/sylph-pkg/sylph_wasm.js"));

const fmtB = (n) => (!Number.isFinite(n) ? "?"
  : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KiB`
    : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MiB` : `${(n / 1024 ** 3).toFixed(2)} GiB`);

console.log(`resolving ${ACC} against ${"https://www.ebi.ac.uk/ena/portal/api/filereport"}…`);
const t0 = performance.now();
const runs = await resolveAccession(ACC);
console.log(`  ${runs.length} run(s) in ${((performance.now() - t0) / 1000).toFixed(2)} s`);
for (const r of runs.slice(0, 5)) {
  console.log(`  ${r.run}  ${r.layout}  ${fmtB(r.bytes)}  ${Number.isFinite(r.reads) ? r.reads.toLocaleString("en-US") : "?"} reads` +
    `${r.note ? `  (${r.note})` : ""}${r.problem ? `  [${r.problem}]` : ""}`);
  for (const f of r.files) console.log(`      ${f.url}  ${fmtB(f.bytes)}`);
}
const run = runs.find((r) => r.usable);
if (!run) throw new Error("no usable run in that accession");

await initWasm(await fs.readFile(path.join(REPO, "web/sylph-pkg/sylph_wasm_bg.wasm")));
const db = new Uint8Array(await fs.readFile(path.join(REPO, "web/db/gut_mini.syldb")));
const profiler = new Profiler(db);
console.log(`\ndatabase: ${profiler.database_size} genomes, k=${profiler.k}, c=${profiler.c} (bundled gut_mini.syldb)`);

let retries = 0;
const mkSource = (f) => urlSource(f.url, {
  size: f.bytes, name: f.name,
  onRetry: (r) => { retries++; console.log(`  [resume] ${r.note}`); },
});

const started = performance.now();
let last = started;
const say = (bytesIn, reads, total) => {
  const now = performance.now();
  if (now - last < 2000) return;
  last = now;
  const sec = (now - started) / 1000;
  console.log(`  ${fmtB(bytesIn)} / ${fmtB(total)}  ${reads.toLocaleString("en-US")} reads` +
    `  ${fmtB(bytesIn / sec)}/s  ${sec.toFixed(0)} s`);
};

let sources, downloaded;
if (run.layout === "PAIRED") {
  profiler.begin_sample_pe(MAX_READS);
  sources = run.files.map(mkSource);
  await streamTrimPair([sources[0]], [sources[1]], MAX_READS, {
    onChunk1: (c) => profiler.feed_r1(c),
    onChunk2: (c) => profiler.feed_r2(c),
    onProgress1: (b, r, t) => say(b + sources[1].received, r, run.bytes),
    onProgress2: (b, r, t) => say(b + sources[0].received, r, run.bytes),
    queued1: () => profiler.pair_queued_r1,
    queued2: () => profiler.pair_queued_r2,
    pending1: () => profiler.pair_pending_r1,
    pending2: () => profiler.pair_pending_r2,
    shouldStop: () => profiler.sample_done === true || profiler.sample_halted === true,
  });
} else {
  profiler.begin_sample(MAX_READS);
  sources = run.files.map(mkSource);
  await streamTrimMulti(sources, MAX_READS,
    (c) => profiler.feed(c),
    (b, r, t) => say(b, r, t),
    null,
    () => profiler.sample_done === true || profiler.sample_halted === true);
}
downloaded = sources.reduce((a, s) => a + s.received, 0);
const dlSec = (performance.now() - started) / 1000;

// Read BEFORE finish_sample(): finishing takes the sketch, and the counter with it.
const sketchedReads = profiler.sample_reads;
const tSketch = performance.now();
const tsv = profiler.finish_sample();
const profSec = (performance.now() - tSketch) / 1000;

const lines = tsv.trim().split("\n").filter(Boolean);
console.log(`\ndownloaded+sketched ${fmtB(downloaded)} in ${dlSec.toFixed(1)} s ` +
  `= ${fmtB(downloaded / dlSec)}/s` +
  `  (${sources.reduce((a, s) => a + s.requests, 0)} HTTP requests, ${retries} resumes, ` +
  `${sources.reduce((a, s) => a + s.restarts, 0)} restarts)`);
console.log(`reads sketched: ${sketchedReads?.toLocaleString?.("en-US") ?? "?"}`);
// The end-to-end check the page now makes: what came out of the decompressor
// against what the ENA published for this run. Against the real service this is
// also the check that says the download was complete — the one thing no byte
// count can establish on its own.
const verdict = readCountVerdict({ observed: sketchedReads, expected: run.reads, maxReads: MAX_READS });
console.log(verdict.capped
  ? `read count: stopped at the ${MAX_READS.toLocaleString("en-US")} read cap ` +
    `(the run holds ${run.reads?.toLocaleString?.("en-US") ?? "?"}), so it is not compared`
  : verdict.ok
    ? `read count: matches the ${run.reads?.toLocaleString?.("en-US") ?? "?"} the ENA publishes for ${run.run}`
    : `read count: MISMATCH — ${verdict.note}`);
console.log(`profile finished in ${profSec.toFixed(1)} s — ${Math.max(0, lines.length - 1)} species`);
console.log("--- first rows of the TSV ---");
console.log(lines.slice(0, 6).join("\n"));
