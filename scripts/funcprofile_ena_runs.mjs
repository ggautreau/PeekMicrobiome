// KEGG ortholog profiles for ENA runs, by the same route the page takes.
//
//   node scripts/funcprofile_ena_runs.mjs --out data/func SRR14473825 SRR14473824 …
//   node scripts/funcprofile_ena_runs.mjs --out data/func --runs runs.txt
//   node scripts/funcprofile_ena_runs.mjs --out data/func --matrix func_matrix_human-gut.tsv …
//
// WHY THIS EXISTS. web/demo/gut-demo.session.json ships eighteen real taxonomic
// profiles and promises that re-profiling the same accessions from the page's
// ENA panel reproduces them. The Function tab needs the same promise kept: its
// numbers have to come from the same runs, the same read cap, and the same
// streaming code — not from a different depth or a different subsample, which
// would make the two tabs describe two different experiments.
//
// So this imports web/ena.js and web/fastq-trim.js exactly as
// scripts/profile_ena_runs.mjs does and drives them identically — resolve,
// stream from the EBI, gunzip, stop at the cap. The only difference is what the
// reads are fed to: a sourmash protein sketch (six-frame translation, k=11 amino
// acids, scaled 1000), which is then prefetched against the KEGG KO signatures
// the way fmh-funprofiler does. Nothing is written to disk but the profiles; the
// FASTQs are never stored.
//
// RESUMABLE ON PURPOSE. Eighteen runs is hours of downloading, and a script that
// loses all of it to one truncated gzip is a script nobody finishes. One file
// per accession, and an accession whose file already exists is skipped — so this
// can be interrupted, re-run, or run as several processes over disjoint lists.
//
// --matrix then merges those per-run files into ONE table, in exactly the shape
// the page's own "Download matrix" button writes at the ortholog level. That
// merged file is the tracked one — the counterpart of
// abundance_matrix_human-gut.tsv, and for the same reason: hours of downloading
// that nobody should have to repeat to rebuild the demo.
//
// THE REFERENCE. scripts/funprofiler/ko_full_k33.ndjson.gz, built by
// scripts/funprofiler/fixtures.sh from Zenodo record 10045253 (KEGG KO sketches,
// CC BY 4.0). 13,509 orthologs at k=11. sourmash writes a protein ksize as 3x
// the amino-acid k, which is why 33 appears everywhere below.

import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const OUT_DIR = path.resolve(REPO, flag("out", "data/func"));
const MAX_READS = Number(flag("reads", "3000000"));
const REFS = path.resolve(REPO, flag("refs", "scripts/funprofiler/ko_full_k33.ndjson.gz"));
const PKG = path.resolve(REPO, flag("pkg", "web/funprofiler-pkg"));
const MIN_OVERLAP = Number(flag("min-overlap", "1"));
const MATRIX = flag("matrix", null);
const KEGG_MAP = path.resolve(REPO, flag("kegg-map", "web/db/kegg/ko-map.json"));
const runsFile = flag("runs", null);
const RUNS = runsFile
  ? (await fs.readFile(path.resolve(REPO, runsFile), "utf8")).split(/\s+/).filter(Boolean)
  : argv.filter((a) => /^[A-Z]{3}\d+$/.test(a));

// The sketch parameters. Not options: they must match the reference archive, and
// a mismatched k or scale does not fail, it returns an empty profile.
const K_STORED = 33, SCALED = 1000, SEED = 42;

if (!RUNS.length) {
  console.error("no run accessions given");
  process.exit(2);
}

const { resolveAccession, urlSource } = await import(path.join(REPO, "web/ena.js"));
const { streamTrimMulti, streamTrimPair } = await import(path.join(REPO, "web/fastq-trim.js"));
const { parseKoCsv } = await import(path.join(REPO, "web/kegg.js"));
const sourmash = await import(path.join(PKG, "sourmash.js"));
await sourmash.default({ module_or_path: await fs.readFile(path.join(PKG, "sourmash_bg.wasm")) });

const fmtB = (n) => (!Number.isFinite(n) ? "?"
  : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KiB`
    : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MiB` : `${(n / 1024 ** 3).toFixed(2)} GiB`);

// ---- the sequence lines out of a byte stream ---------------------------------
//
// streamTrim hands out decompressed FASTQ bytes at arbitrary boundaries, so the
// record structure has to be tracked across chunks: line 1 of every 4 is the
// sequence, and the cut is guaranteed to land on a record boundary, never mid
// record. Reads go to the sketch ONE AT A TIME rather than concatenated —
// joining them would put amino-acid k-mers across the junction of two unrelated
// reads, and six-frame translation makes those chimeras plausible-looking rather
// than obviously wrong.
function seqReader(onSeq) {
  const dec = new TextDecoder();
  let carry = "";
  let line = 0;
  return {
    push(chunk) {
      const text = carry + dec.decode(chunk, { stream: true });
      let start = 0;
      for (;;) {
        const nl = text.indexOf("\n", start);
        if (nl < 0) break;
        if (line % 4 === 1) {
          const seq = text.slice(start, nl).trimEnd();
          if (seq) onSeq(seq);
        }
        line++;
        start = nl + 1;
      }
      carry = text.slice(start);
    },
    // A file with no trailing newline holds its last record in the carry.
    finish() {
      if (carry && line % 4 === 1) {
        const seq = carry.trim();
        if (seq) onSeq(seq);
      }
    },
  };
}

// ---- the reference, once ------------------------------------------------------
let t = performance.now();
const refText = zlib.gunzipSync(await fs.readFile(REFS)).toString("utf8");
const profiler = new sourmash.FuncProfiler();
let refLines = 0;
for (const line of refText.split("\n")) {
  if (!line) continue;
  profiler.add_references_json(line, K_STORED, SCALED);
  refLines++;
}
console.log(`reference: ${profiler.len()} KO signatures of ${refLines} lines, ` +
  `k=${K_STORED / 3} aa, scaled=${SCALED} (${((performance.now() - t) / 1000).toFixed(1)} s)`);
console.log(`cap: ${MAX_READS.toLocaleString("en-US")} reads per mate`);
console.log(`out: ${path.relative(REPO, OUT_DIR)}`);
console.log(`runs: ${RUNS.length}\n`);

await fs.mkdir(OUT_DIR, { recursive: true });

// ---- profile each run ---------------------------------------------------------
const started = performance.now();
let done = 0, skipped = 0, failed = 0;

for (const [i, acc] of RUNS.entries()) {
  const out = path.join(OUT_DIR, `${acc}.ko.csv`);
  if (await fs.access(out).then(() => true, () => false)) {
    skipped++;
    console.log(`  [${i + 1}/${RUNS.length}] ${acc}  already done`);
    continue;
  }

  const t0 = performance.now();
  let run;
  try {
    const runs = await resolveAccession(acc);
    run = runs.find((r) => r.usable);
  } catch (e) {
    failed++;
    console.error(`  [${i + 1}/${RUNS.length}] ${acc}: ${e?.message ?? e}`);
    continue;
  }
  if (!run) { failed++; console.error(`  [${i + 1}/${RUNS.length}] ${acc}: no usable run`); continue; }

  const sample = new sourmash.KmerMinHash(0, K_STORED, true, false, false, SEED, SCALED, true);
  let seqs = 0, bases = 0;
  const feed = (s) => { seqs++; bases += s.length; sample.add_sequence_js(s); };

  let last = 0;
  const say = (bytesIn) => {
    const now = performance.now();
    if (now - last < 20000) return;
    last = now;
    console.log(`      ${fmtB(bytesIn)}  ${seqs.toLocaleString("en-US")} reads  ` +
      `${((now - t0) / 1000).toFixed(0)} s`);
  };
  const mkSource = (f) => urlSource(f.url, { size: f.bytes, name: f.name });

  let sources;
  try {
    if (run.layout === "PAIRED" && run.files.length === 2) {
      sources = run.files.map(mkSource);
      // Both mates into ONE sketch: fmh-funprofiler sketches every read of the
      // sample together, and the cap is per mate here exactly as it is for the
      // taxonomic run, so the two tabs really do see the same reads.
      const r1 = seqReader(feed), r2 = seqReader(feed);
      await streamTrimPair([sources[0]], [sources[1]], MAX_READS, {
        onChunk1: (c) => r1.push(c),
        onChunk2: (c) => r2.push(c),
        onProgress1: () => say(sources[0].received + sources[1].received),
        onProgress2: () => say(sources[0].received + sources[1].received),
      });
      r1.finish();
      r2.finish();
    } else {
      sources = run.files.map(mkSource);
      const r = seqReader(feed);
      await streamTrimMulti(sources, MAX_READS, (c) => r.push(c), (b) => say(b), null, null);
      r.finish();
    }
  } catch (e) {
    failed++;
    console.error(`  [${i + 1}/${RUNS.length}] ${acc}: ${e?.message ?? e}`);
    continue;
  }

  const hashes = sample.size_js();
  const csv = profiler.profile(sample, MIN_OVERLAP);
  const kos = Object.keys(parseKoCsv(csv)).length;
  const downloaded = sources.reduce((a, s) => a + s.received, 0);
  const sec = (performance.now() - t0) / 1000;

  // Provenance in the file, because a bare two-column CSV a year from now says
  // nothing about which run, which depth, or which reference produced it.
  const header = [
    `# PeekMicrobiome — KEGG ortholog profile (fmh-funprofiler method)`,
    `# run: ${acc}  layout=${run.layout}  files=${run.files.length}`,
    `# reads sketched: ${seqs} (${bases} bases), cap ${MAX_READS} per mate`,
    `# sketch: protein k=${K_STORED / 3} aa (ksize ${K_STORED}), scaled=${SCALED}, ` +
      `seed=${SEED}, ${hashes} hashes`,
    `# reference: ${path.basename(REFS)}, ${profiler.len()} KO signatures, ` +
      `min_overlap=${MIN_OVERLAP}`,
    `# produced: ${new Date().toISOString()} by scripts/funcprofile_ena_runs.mjs`,
  ].join("\n") + "\n";
  await fs.writeFile(out, header + csv, "utf8");

  done++;
  console.log(`  [${i + 1}/${RUNS.length}] ${acc}  ${run.layout}  ${fmtB(downloaded)} in ` +
    `${sec.toFixed(0)} s  ${seqs.toLocaleString("en-US")} reads  ${hashes} hashes  ${kos} KOs`);
}

const mins = (performance.now() - started) / 60000;
console.log(`\n${done} profiled, ${skipped} already done, ${failed} failed ` +
  `(${mins.toFixed(1)} min)`);

// ---- the merged matrix --------------------------------------------------------
//
// One table, one header, one row per ortholog — the shape web/multi.js's
// funcMatrixTsv() writes at the "Orthologs (KO)" level, so the file kept in the
// repository and the file a reader downloads from the page are the same thing.
if (MATRIX) {
  if (failed) {
    console.error(`\nnot writing ${MATRIX}: ${failed} run(s) failed, and a matrix ` +
      `missing a column would be a demo missing a sample`);
    process.exit(1);
  }
  const names = await fs.readFile(KEGG_MAP, "utf8").then((t) => JSON.parse(t).ko ?? {}, () => ({}));
  const cols = [], per = new Map(), meta = [];
  for (const acc of RUNS) {
    const text = await fs.readFile(path.join(OUT_DIR, `${acc}.ko.csv`), "utf8");
    const head = text.split("\n").filter((l) => l.startsWith("#")).join("\n");
    const cap = /cap (\d+) per mate/.exec(head)?.[1];
    const reads = /reads sketched: (\d+)/.exec(head)?.[1];
    const hashes = /(\d+) hashes/.exec(head)?.[1];
    const ref = /^# reference: (.+)$/m.exec(head)?.[1];
    meta.push({ acc, cap, reads, hashes, ref });
    cols.push(acc);
    per.set(acc, parseKoCsv(text));
  }
  // Every column read to the same depth against the same reference, or the rows
  // are not comparable and the table would say nothing about which is which.
  const caps = new Set(meta.map((m) => m.cap));
  const refs = new Set(meta.map((m) => m.ref));
  if (caps.size !== 1 || refs.size !== 1) {
    console.error(`not writing ${MATRIX}: the columns disagree — caps ${[...caps]}, ` +
      `references ${[...refs]}`);
    process.exit(1);
  }

  const kos = [...new Set(cols.flatMap((c) => Object.keys(per.get(c))))];
  kos.sort((a, b) => {
    const sa = cols.reduce((t, c) => t + (per.get(c)[a] ?? 0), 0);
    const sb = cols.reduce((t, c) => t + (per.get(c)[b] ?? 0), 0);
    return sb - sa || a.localeCompare(b);          // ties broken by id, so the file is stable
  });

  const out = [
    `# PeekMicrobiome - functional abundance, KEGG orthologs`,
    `# measured from reads with FracMinHash on amino-acid k-mers (k=11), against KEGG orthologs`,
    `# values are each row's share of the sample's matched functional signal`,
    `# every measured ortholog is here`,
    `# reads per sample: capped at ${[...caps][0]}`,
    `# reference: ${[...refs][0]}`,
    `# reads sketched: ${meta.map((m) => `${m.acc}=${m.reads}`).join("; ")}`,
    `# hashes: ${meta.map((m) => `${m.acc}=${m.hashes}`).join("; ")}`,
    `# produced: ${new Date().toISOString()} by scripts/funcprofile_ena_runs.mjs`,
    `# matrix: ${kos.length} orthologs x ${cols.length} samples`,
    ["id", "name", ...cols].join("\t"),
    ...kos.map((ko) => [ko, names[ko] ?? ko,
      ...cols.map((c) => (per.get(c)[ko] ?? 0).toExponential(4))].join("\t")),
  ].join("\n") + "\n";
  await fs.writeFile(path.resolve(REPO, MATRIX), out, "utf8");
  console.log(`${kos.length} orthologs x ${cols.length} samples -> ${MATRIX}`);
}

process.exit(failed ? 1 : 0);
