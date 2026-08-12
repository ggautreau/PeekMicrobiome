// Profile ENA runs into the abundance matrix the demo builder reads.
//
//   node scripts/profile_ena_runs.mjs --db gut.syldb --out matrix.tsv SRR14473825 SRR14473824 …
//   node scripts/profile_ena_runs.mjs --runs runs.txt --out matrix.tsv
//
// WHY THIS EXISTS. web/demo/gut-demo.session.json is real measurements, and the
// banner promises that profiling the same accessions from the page's own ENA
// panel reproduces them. That promise is only keepable if the demo is built by
// the SAME code the page runs: this script imports web/ena.js, web/fastq-trim.js
// and the wasm profiler, and drives them exactly as web/multi.js does — resolve,
// stream from the EBI, gunzip, sketch, stop at the read cap, finish the sample.
// Nothing is written to disk but the matrix; the FASTQs are never stored.
//
// The read cap defaults to the page's own default (3,000,000 reads), because a
// demo built with a different cap would not be what a visitor gets when they
// type those accessions.
//
// Species labels are built here the way web/multi.js:3871 builds them — the
// lineage name, plus the accession when that name is shared by several genomes.
// GTDB gives one name to many representatives ("Collinsella sp002232035" is 20
// of them), and a matrix with duplicate labels is rejected by the demo builder
// and by downstream tools.

import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const DB = flag("db", "gut.syldb");
const OUT = flag("out", "matrix.tsv");
const MAX_READS = Number(flag("reads", "3000000"));
const BIOME_KEY = flag("biome", "human-gut");
const LINEAGE = flag("lineage", `web/db/lineage/${BIOME_KEY}.json`);
const runsFile = flag("runs", null);
const RUNS = runsFile
  ? (await fs.readFile(path.resolve(REPO, runsFile), "utf8")).split(/\s+/).filter(Boolean)
  : argv.filter((a) => /^[A-Z]{3}\d+$/.test(a));

if (!RUNS.length) {
  console.error("no run accessions given");
  process.exit(2);
}

const { resolveAccession, urlSource } = await import(path.join(REPO, "web/ena.js"));
const { streamTrimMulti, streamTrimPair } = await import(path.join(REPO, "web/fastq-trim.js"));
const initWasm = (await import(path.join(REPO, "web/sylph-pkg/sylph_wasm.js"))).default;
const { Profiler } = await import(path.join(REPO, "web/sylph-pkg/sylph_wasm.js"));

// ---- the labels, as the page makes them --------------------------------------
const lineageJson = JSON.parse(await fs.readFile(path.resolve(REPO, LINEAGE), "utf8"));
const speciesOf = lineageJson.species ?? {};
const shared = new Set();
{
  const seen = new Map();
  for (const name of Object.values(speciesOf)) seen.set(name, (seen.get(name) ?? 0) + 1);
  for (const [name, n] of seen) if (n > 1) shared.add(name);
}
const speciesLabel = (genome) => {
  const name = speciesOf[genome] ?? speciesOf[genome.replace(/\.gz$/i, "")];
  if (!name) return `(${genome})`;
  if (!shared.has(name)) return name;
  return `${name} [${String(genome).replace(/\.(fna|fa|fasta)(\.gz)?$/i, "")}]`;
};

const fmtB = (n) => (!Number.isFinite(n) ? "?"
  : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KiB`
    : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MiB` : `${(n / 1024 ** 3).toFixed(2)} GiB`);

await initWasm(await fs.readFile(path.join(REPO, "web/sylph-pkg/sylph_wasm_bg.wasm")));
const profiler = new Profiler(new Uint8Array(await fs.readFile(path.resolve(REPO, DB))));
console.log(`database: ${profiler.database_size} genomes, k=${profiler.k}, c=${profiler.c} (${DB})`);
console.log(`cap: ${MAX_READS.toLocaleString("en-US")} reads per sample`);
console.log(`runs: ${RUNS.length}\n`);

// ---- profile each run ---------------------------------------------------------
const matrix = new Map();          // genome -> { species, values: Map<run, %> }
const done = [];
const started = performance.now();

for (const [i, acc] of RUNS.entries()) {
  const t0 = performance.now();
  const runs = await resolveAccession(acc);
  const run = runs.find((r) => r.usable);
  if (!run) { console.error(`  ${acc}: no usable run`); continue; }

  let last = 0;
  const say = (bytesIn, reads) => {
    const now = performance.now();
    if (now - last < 15000) return;
    last = now;
    console.log(`      ${fmtB(bytesIn)}  ${reads.toLocaleString("en-US")} reads  ` +
      `${((now - t0) / 1000).toFixed(0)} s`);
  };
  const mkSource = (f) => urlSource(f.url, { size: f.bytes, name: f.name });

  let sources;
  if (run.layout === "PAIRED" && run.files.length === 2) {
    profiler.begin_sample_pe(MAX_READS);
    sources = run.files.map(mkSource);
    await streamTrimPair([sources[0]], [sources[1]], MAX_READS, {
      onChunk1: (c) => profiler.feed_r1(c),
      onChunk2: (c) => profiler.feed_r2(c),
      onProgress1: (b, r) => say(b + sources[1].received, r),
      onProgress2: (b, r) => say(b + sources[0].received, r),
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
      (c) => profiler.feed(c), (b, r) => say(b, r), null,
      () => profiler.sample_done === true || profiler.sample_halted === true);
  }

  const reads = profiler.sample_reads;
  const tsv = profiler.finish_sample();
  const downloaded = sources.reduce((a, s) => a + s.received, 0);
  const sec = (performance.now() - t0) / 1000;

  // Same parse as web/multi.js:2565.
  const lines = tsv.trim().split("\n");
  const head = lines[0].split("\t");
  const cGenome = head.indexOf("Genome_file");
  const cAbund = head.indexOf("Taxonomic_abundance");
  let hits = 0;
  for (const l of lines.slice(1)) {
    if (!l) continue;
    const f = l.split("\t");
    const genome = (f[cGenome] || "").split("/").pop();
    const v = Number(f[cAbund]) || 0;
    if (!genome) continue;
    hits++;
    let e = matrix.get(genome);
    if (!e) { e = { species: speciesLabel(genome), values: new Map() }; matrix.set(genome, e); }
    e.values.set(acc, v);
  }
  done.push(acc);
  console.log(`  [${i + 1}/${RUNS.length}] ${acc}  ${run.layout}  ${fmtB(downloaded)} in ` +
    `${sec.toFixed(0)} s  ${reads?.toLocaleString?.("en-US") ?? "?"} reads  ${hits} species` +
    `${run.note ? `  (${run.note})` : ""}`);
}

// ---- write the matrix ---------------------------------------------------------
const rows = [...matrix.entries()]
  .map(([genome, e]) => ({ genome, species: e.species, values: e.values }))
  .sort((a, b) => Math.max(...done.map((r) => b.values.get(r) ?? 0)) -
                  Math.max(...done.map((r) => a.values.get(r) ?? 0)));

const label = BIOME_KEY === "human-gut" ? "Human gut" : BIOME_KEY;
const out = [
  `# PeekMicrobiome — abundance matrix, taxonomic (relative) abundance in %`,
  `# reference database: ${label} [${BIOME_KEY}] — MGnify ${BIOME_KEY} v2.0.2`,
  `# database: genomes=${profiler.database_size}, k=${profiler.k}, c=${profiler.c}, ` +
    `catalogue_species=${profiler.database_size}`,
  `# reads per sample: capped at ${MAX_READS}`,
  `# exported: ${new Date().toISOString()}`,
  `# matrix: ${rows.length} species x ${done.length} samples`,
  ["species", "genome", ...done].join("\t"),
  ...rows.map((r) => [r.species, r.genome,
    ...done.map((acc) => (r.values.get(acc) ?? 0).toFixed(4))].join("\t")),
].join("\n") + "\n";

await fs.writeFile(path.resolve(REPO, OUT), out, "utf8");
const mins = (performance.now() - started) / 60000;
console.log(`\n${rows.length} species x ${done.length} samples -> ${OUT}  ` +
  `(${mins.toFixed(1)} min)`);
// Columns must sum to ~100: the demo builder refuses anything else, and a column
// that does not is a sample whose profile was cut short.
for (const acc of done) {
  const sum = rows.reduce((a, r) => a + (r.values.get(acc) ?? 0), 0);
  if (Math.abs(sum - 100) > 0.5) console.log(`  ! ${acc} sums to ${sum.toFixed(2)}`);
}
