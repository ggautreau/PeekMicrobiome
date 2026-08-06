// THE criterion: the same data profiled through the local-file path and through
// the ENA path must produce the SAME TSV.
//
//   node scripts/ena-test/tsv-parity.mjs
//
// Everything else in this directory tests a mechanism. This tests the promise.
// node-suite.mjs proves the resumable source delivers the file byte for byte and
// that the trimmed output matches a local read — single-end, one file, on the
// bytes. It stops there. Nothing compared two abundance TABLES, and nothing at
// all covered the PAIRED path, which is where the two streams interact: the
// R1/R2 drift budget, the cross-stop when one mate reaches the cap, and the
// fail-together rule. A regression confined to that path would pass all 113
// checks of node-suite and the headless page suite without being seen.
//
// So: one real fixture (see fixtures.mjs), profiled twice against
// web/db/gut_mini.syldb —
//
//   local  the file, read the way a dropped File is read
//   ena    the same bytes over HTTP through urlSource(), against a server that
//          cuts every second request mid-body and forces a resume
//
// — and the two TSVs compared byte for byte, three times:
//
//   1. single-end, capped below the fixture (the cap ends the read)
//   2. paired-end, capped        (both streams, cross-stop, drift budget)
//   3. single-end, no cap        (the whole file, clean EOF)
//
// Three things are asserted each time, and all three matter: the TSV, the read
// count, and a hash of the bytes actually fed to the sketcher. The last one is
// what keeps the test honest if the database ever stops matching the fixture —
// two empty tables are equal, two hashes of nothing are not.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ensureFixture } from "./fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PORT = Number(process.env.PARITY_PORT ?? 8871);

const { urlSource } = await import(path.join(REPO, "web/ena.js"));
const { streamTrimMulti, streamTrimPair } = await import(path.join(REPO, "web/fastq-trim.js"));
const wasm = await import(path.join(REPO, "web/sylph-pkg/sylph_wasm.js"));

const fx = await ensureFixture();
const R1 = fs.readFileSync(fx.r1);
const R2 = fs.readFileSync(fx.r2);
const BLOBS = { "/R1.fastq.gz": R1, "/R2.fastq.gz": R2 };

// ---- the server that cuts ----------------------------------------------------
//
// Honest Content-Length, honest Content-Range, a stable Last-Modified — and
// every second response stops at 40 % of its body and slams the socket, which
// is what a dropped connection looks like to fetch(). CUT=0 turns it off, to
// check that the parity is not an artefact of both sides failing the same way.
let requests = 0;
let perPath = new Map();
const CUT = process.env.CUT !== "0";
const srv = http.createServer((req, res) => {
  const key = req.url.split("?")[0];
  const body = BLOBS[key];
  if (!body) { res.writeHead(404); res.end(); return; }
  requests++;
  // Counted per FILE, so the cut lands on the body rather than on the probe:
  // request 1 for a file is detectGzip's two-byte read, request 2 is the
  // download itself. Counting globally made the paired case cut both bodies and
  // the single-end case cut neither, which is how a resume test ends up
  // testing a link that was never interrupted.
  const n = (perPath.get(key) ?? 0) + 1;
  perPath.set(key, n);
  const m = /bytes=(\d+)-/.exec(req.headers.range ?? "");
  const start = m ? Number(m[1]) : 0;
  const slice = body.subarray(start);
  const headers = {
    "Content-Type": "application/gzip",
    "Content-Length": String(slice.length),
    "Last-Modified": "Wed, 01 Jan 2025 00:00:00 GMT",
    "Accept-Ranges": "bytes",
  };
  if (m) headers["Content-Range"] = `bytes ${start}-${body.length - 1}/${body.length}`;
  res.writeHead(m ? 206 : 200, headers);
  if (CUT && n % 2 === 0) {
    res.write(slice.subarray(0, Math.floor(slice.length * 0.4)));
    setTimeout(() => res.socket?.destroy(), 5);
  } else {
    res.end(slice);
  }
});
await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));

// A dropped File, as streamCore sees one.
class LocalFile {
  constructor(b) { this.bytes = b; this.size = b.length; }
  slice(s, e) {
    const v = this.bytes.subarray(s, e);
    return { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.length) };
  }
  stream() {
    const { bytes } = this; let off = 0;
    return new ReadableStream({ pull(c) {
      if (off >= bytes.length) { c.close(); return; }
      const end = Math.min(off + 65536, bytes.length);
      c.enqueue(new Uint8Array(bytes.subarray(off, end))); off = end;
    } });
  }
}

const FAST = {
  progressRetryMs: 5, backoff: [5, 10, 20, 40, 80, 100],
  allowHosts: [/^127\.0\.0\.1$/],
};
let resumes = 0;
const remote = (name, size) =>
  urlSource(`http://127.0.0.1:${PORT}/${name}`, { size, ...FAST, onRetry: () => resumes++ });

// ---- the profiler ------------------------------------------------------------

await wasm.default(fs.readFileSync(path.join(REPO, "web/sylph-pkg/sylph_wasm_bg.wasm")));
const profiler = new wasm.Profiler(
  new Uint8Array(fs.readFileSync(path.join(REPO, "web/db/gut_mini.syldb"))));

const stop = () => profiler.sample_done === true || profiler.sample_halted === true;

async function profileSe(sources, maxReads) {
  const h = createHash("sha256");
  profiler.begin_sample(maxReads);
  await streamTrimMulti(sources, maxReads, (c) => { h.update(c); profiler.feed(c); }, null, null, stop);
  const reads = profiler.sample_reads;
  return { tsv: profiler.finish_sample(), reads, fed: h.digest("hex") };
}

async function profilePe(a, b, maxReads) {
  const h1 = createHash("sha256"), h2 = createHash("sha256");
  profiler.begin_sample_pe(maxReads);
  await streamTrimPair([a], [b], maxReads, {
    onChunk1: (c) => { h1.update(c); profiler.feed_r1(c); },
    onChunk2: (c) => { h2.update(c); profiler.feed_r2(c); },
    queued1: () => profiler.pair_queued_r1, queued2: () => profiler.pair_queued_r2,
    pending1: () => profiler.pair_pending_r1, pending2: () => profiler.pair_pending_r2,
    shouldStop: stop,
  });
  const reads = profiler.sample_reads;
  return { tsv: profiler.finish_sample(), reads, fed: `${h1.digest("hex")}/${h2.digest("hex")}` };
}

// ---- the comparison ----------------------------------------------------------

let passes = 0, failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `   [${detail}]` : ""}`);
};

function compare(label, local, ena) {
  check(`${label}: the TSV is identical BYTE FOR BYTE`, local.tsv === ena.tsv,
    local.tsv === ena.tsv ? "" : firstDiff(local.tsv, ena.tsv));
  check(`${label}: the same number of reads was profiled`, local.reads === ena.reads,
    `${local.reads} vs ${ena.reads}`);
  check(`${label}: the same bytes reached the sketcher`, local.fed === ena.fed,
    `${local.fed.slice(0, 16)} vs ${ena.fed.slice(0, 16)}`);
  // Two empty tables are identical too. This is what stops the test passing for
  // that reason if the fixture and the database ever stop overlapping.
  const rows = local.tsv.trim().split("\n").length - 1;
  check(`${label}: the table is not empty (${rows} species)`, rows > 0, local.tsv.slice(0, 120));
}

function firstDiff(a, b) {
  const la = a.split("\n"), lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return `line ${i}: ${JSON.stringify(la[i])} vs ${JSON.stringify(lb[i])}`;
  }
  return `${a.length} vs ${b.length} bytes`;
}

const CAP = Number(process.env.PARITY_CAP ?? 40000);
const NOCAP = fx.records * 10;

console.log(`fixture ${fx.run}: ${fx.records.toLocaleString("en-US")} records, ` +
  `cap ${CAP.toLocaleString("en-US")}, server cuts every 2nd request: ${CUT}\n`);

try {
  console.log("== 1. single-end, capped ==");
  {
    const local = await profileSe([new LocalFile(R1)], CAP);
    requests = 0; resumes = 0; perPath = new Map();
    const ena = await profileSe([remote("R1.fastq.gz", R1.length)], CAP);
    console.log(`   ${requests} http requests, ${resumes} resumes, ${ena.reads} reads`);
    compare("SE capped", local, ena);
    check("SE capped: the download really was cut and resumed", CUT ? resumes > 0 : true,
      `${resumes} resumes`);
    check("SE capped: the cap stopped the read", ena.reads === CAP, `${ena.reads}`);
  }

  console.log("\n== 2. paired-end, capped ==");
  {
    const local = await profilePe(new LocalFile(R1), new LocalFile(R2), CAP);
    requests = 0; resumes = 0; perPath = new Map();
    const ena = await profilePe(remote("R1.fastq.gz", R1.length), remote("R2.fastq.gz", R2.length), CAP);
    console.log(`   ${requests} http requests, ${resumes} resumes, ${ena.reads} pairs`);
    compare("PE capped", local, ena);
    check("PE capped: both mates were cut and resumed", CUT ? resumes > 1 : true,
      `${resumes} resumes`);
  }

  console.log("\n== 3. single-end, whole file ==");
  {
    const local = await profileSe([new LocalFile(R1)], NOCAP);
    requests = 0; resumes = 0; perPath = new Map();
    const ena = await profileSe([remote("R1.fastq.gz", R1.length)], NOCAP);
    console.log(`   ${requests} http requests, ${resumes} resumes, ${ena.reads} reads`);
    compare("SE whole file", local, ena);
    check("SE whole file: it was cut and resumed too", CUT ? resumes > 0 : true, `${resumes} resumes`);
    check("SE whole file: every record was read", ena.reads === fx.records,
      `${ena.reads} of ${fx.records}`);
  }
} finally {
  await new Promise((r) => srv.close(r));
}

console.log(`\n${passes} passed, ${failures} failed (tsv parity)`);
process.exit(failures ? 1 : 0);
