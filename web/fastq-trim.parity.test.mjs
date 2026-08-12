// Chunking-parity test for fastq-trim.js — runs in plain Node, no wasm needed:
//
//   node web/fastq-trim.parity.test.mjs
//
// What it proves:
//   1. concat(streamTrim chunks)      === readAndTrim(...).bytes            (byte for byte)
//   2. concat(streamTrimMulti chunks) === readAndTrimMulti(...).bytes
//   3. both equal the independently-computed expected trim: the first
//      4·min(maxReads, available) lines of the input, newline included.
//   4. the cut always lands on a FASTQ record boundary (4-line multiple).
//
// Exercised across: plain / single-member gzip / multi-member gzip input,
// several read caps (including a cap larger than the file), several stream
// chunk sizes (including sizes that split records mid-line), and a
// multi-file sample where the cap falls in the 1st, 2nd or 3rd file.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "./vendor/fflate.js";
import {
  readAndTrim, readAndTrimMulti, streamTrim, streamTrimMulti, streamTrimPair,
  PAIR_LAG_MAX,
} from "./fastq-trim.js";
import {
  detectMemory64, chooseWasmBits, readsBudget, readsOverBudgetNote, loadedBuildNote,
  progressFraction, basesForReads, BUDGET_READ_BP,
  WASM32_SAFE_READS, WASM32_CEILING_READS, WASM64_SAFE_READS, WASM64_CEILING_READS,
} from "./sylph-worker-rpc.js";

// ---- fake File --------------------------------------------------------------
// Just enough of the File interface for fastq-trim: .size, .slice().arrayBuffer()
// and .stream(). chunkSize drives where the reader splits, which is exactly what
// we want to vary.
class FakeFile {
  constructor(bytes, chunkSize = 64 * 1024, delayMs = 0) {
    this.bytes = bytes;
    this.size = bytes.length;
    this.chunkSize = chunkSize;
    // Per-chunk delay: the only way to decide, deterministically, which of two
    // concurrent mate loops gets ahead (reads resolve as microtasks otherwise).
    this.delayMs = delayMs;
  }
  slice(start, end) {
    const s = this.bytes.subarray(start, end);
    return { arrayBuffer: async () => s.slice().buffer };
  }
  stream() {
    const { bytes, chunkSize, failAfterBytes, delayMs } = this;
    let off = 0;
    return new ReadableStream({
      async pull(controller) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (failAfterBytes !== undefined && off >= failAfterBytes) {
          controller.error(new Error("simulated read failure"));
          return;
        }
        if (off >= bytes.length) { controller.close(); return; }
        const end = Math.min(off + chunkSize, bytes.length);
        controller.enqueue(bytes.slice(off, end));
        off = end;
      },
      cancel() { off = bytes.length; },
    });
  }
}

// A file whose stream errors out partway — a truncated .gz, a disk/permission
// error, a revoked blob.
class FailingFile extends FakeFile {
  constructor(bytes, chunkSize, failAfterBytes) {
    super(bytes, chunkSize);
    this.failAfterBytes = failAfterBytes;
  }
}

// ---- synthetic FASTQ --------------------------------------------------------
function makeFastq(nRecords, seed = 1) {
  // Deterministic pseudo-random, variable read length, and some awkward bytes
  // in the header/quality lines ('@', '+') to make sure nothing but '\n'
  // counting is going on.
  let x = seed;
  const rnd = () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const bases = "ACGT";
  let out = "";
  for (let i = 0; i < nRecords; i++) {
    const len = 30 + Math.floor(rnd() * 120);
    let seq = "";
    for (let j = 0; j < len; j++) seq += bases[Math.floor(rnd() * 4)];
    out += `@read_${i}/1 run=@x+y len=${len}\n${seq}\n+read_${i} @+\n${"I".repeat(len)}\n`;
  }
  return new TextEncoder().encode(out);
}

// Expected trim, computed with no shared code: keep the first 4·maxReads lines.
function expectedTrim(bytes, maxReads) {
  const target = maxReads * 4;
  let seen = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      seen++;
      if (seen === target) return bytes.subarray(0, i + 1);
    }
  }
  return bytes.subarray(0, bytes.length);
}

function concat(parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function countNewlines(b) {
  let n = 0;
  for (let i = 0; i < b.length; i++) if (b[i] === 0x0a) n++;
  return n;
}

// Multi-member gzip: exactly the shape DecompressionStream mishandles and the
// reason this project vendors fflate.
function gzipMultiMember(bytes, members = 3) {
  const per = Math.ceil(bytes.length / members);
  const parts = [];
  for (let off = 0; off < bytes.length; off += per) {
    parts.push(gzipSync(bytes.subarray(off, Math.min(off + per, bytes.length))));
  }
  return concat(parts);
}

// ---- runner -----------------------------------------------------------------
let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; }
  else { fail++; console.log(`FAIL  ${name}${extra ? "  — " + extra : ""}`); }
}

const RAW = makeFastq(50);
const RAW_RECORDS = 50;

const encodings = [
  ["plain", (b) => b],
  ["gzip", (b) => gzipSync(b)],
  ["gzip-multimember", (b) => gzipMultiMember(b, 3)],
];
const caps = [1, 2, 7, 13, 49, 50, 200];
const chunkSizes = [1, 7, 64, 997, 1 << 20];

console.log("== single file ==");
for (const [encName, enc] of encodings) {
  const stored = enc(RAW);
  for (const maxReads of caps) {
    const want = expectedTrim(RAW, maxReads);
    const wantReads = Math.min(maxReads, RAW_RECORDS);
    for (const cs of chunkSizes) {
      const label = `${encName} maxReads=${maxReads} chunk=${cs}`;

      const ref = await readAndTrim(new FakeFile(stored, cs), maxReads, null, null);
      check(`readAndTrim ${label}`, same(ref.bytes, want),
        `got ${ref.bytes.length}B want ${want.length}B`);
      check(`readAndTrim reads ${label}`, ref.reads === wantReads,
        `got ${ref.reads} want ${wantReads}`);

      const parts = [];
      const st = await streamTrim(new FakeFile(stored, cs), maxReads,
        (c) => parts.push(c.slice()), null, null);
      const got = concat(parts);
      check(`streamTrim==readAndTrim ${label}`, same(got, ref.bytes),
        `got ${got.length}B want ${ref.bytes.length}B`);
      check(`streamTrim==expected ${label}`, same(got, want));
      check(`streamTrim reads ${label}`, st.reads === wantReads,
        `got ${st.reads} want ${wantReads}`);
      check(`record boundary ${label}`, countNewlines(got) % 4 === 0,
        `${countNewlines(got)} newlines`);
    }
  }
}

console.log("== multi file (one sample split over 3 runs) ==");
// Split the same FASTQ into 3 files on record boundaries: 8 + 17 + 25 records.
const splitAt = (nRec) => {
  let seen = 0;
  for (let i = 0; i < RAW.length; i++) {
    if (RAW[i] === 0x0a && ++seen === nRec * 4) return i + 1;
  }
  return RAW.length;
};
const b1 = RAW.subarray(0, splitAt(8));
const b2 = RAW.subarray(splitAt(8), splitAt(25));
const b3 = RAW.subarray(splitAt(25));

for (const [encName, enc] of encodings) {
  const stored = [b1, b2, b3].map((b) => enc(b));
  for (const maxReads of caps) {
    const want = expectedTrim(RAW, maxReads);
    const wantReads = Math.min(maxReads, RAW_RECORDS);
    for (const cs of chunkSizes) {
      const label = `${encName} maxReads=${maxReads} chunk=${cs}`;
      const files = () => stored.map((b) => new FakeFile(b, cs));

      const ref = await readAndTrimMulti(files(), maxReads, null, null);
      check(`readAndTrimMulti ${label}`, same(ref.bytes, want),
        `got ${ref.bytes.length}B want ${want.length}B`);

      const parts = [];
      const st = await streamTrimMulti(files(), maxReads,
        (c) => parts.push(c.slice()), null, null);
      const got = concat(parts);
      check(`streamTrimMulti==readAndTrimMulti ${label}`, same(got, ref.bytes),
        `got ${got.length}B want ${ref.bytes.length}B`);
      check(`streamTrimMulti==expected ${label}`, same(got, want));
      check(`streamTrimMulti reads ${label}`, st.reads === wantReads,
        `got ${st.reads} want ${wantReads}`);
      check(`record boundary ${label}`, countNewlines(got) % 4 === 0);
    }
  }
}

console.log("== shouldStop (early stop, mirrors profiler.sample_done) ==");
{
  const stored = gzipSync(RAW);
  const parts = [];
  let fed = 0;
  const st = await streamTrimMulti([new FakeFile(stored, 512)], 50,
    (c) => { parts.push(c.slice()); fed += c.length; },
    null, null,
    () => fed > 0,     // stop after the very first chunk
  );
  check("shouldStop truncates", concat(parts).length < expectedTrim(RAW, 50).length);
  check("shouldStop reads>0", st.reads > 0);
}

console.log("== abort ==");
{
  const ac = new AbortController();
  ac.abort();
  let threw = null;
  try {
    await streamTrim(new FakeFile(RAW, 64), 50, () => {}, null, ac.signal);
  } catch (e) { threw = e; }
  check("aborted signal rejects", threw !== null && threw.name === "AbortError",
    threw ? threw.name : "no throw");
}

// ---- paired-end: bounded drift and joint failure ----------------------------
//
// Stand-in for the wasm PairStreamSketcher: it queues decoded records per side
// and consumes a pair as soon as both sides have one, which is exactly what
// PairStreamSketcher::drain_pairs does. `maxLag` is therefore the real peak of
// the wasm-side queue — the memory this test is about.
function fakePairSketcher() {
  const lines = [0, 0];
  const queued = [0, 0];
  let pairs = 0;
  let maxLag = 0;
  return {
    feed(side, chunk) {
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0x0a && ++lines[side] === 4) { lines[side] = 0; queued[side]++; }
      }
      const d = Math.min(queued[0], queued[1]);
      queued[0] -= d; queued[1] -= d; pairs += d;
      maxLag = Math.max(maxLag, queued[0], queued[1]);
    },
    queued: (side) => queued[side],
    get pairs() { return pairs; },
    get maxLag() { return maxLag; },
  };
}

console.log("== paired-end drift budget ==");
{
  const R1 = makeFastq(800, 11);
  const R2 = makeFastq(800, 22);
  // R1 is read in 1 KiB gulps (~5 records), R2 200 bytes at a time (~1 record):
  // R1 outruns R2 five to one, which is the everyday case (R2's quality lines
  // compress worse, so the same reads arrive slower).
  const run = async (lagMax) => {
    const sk = fakePairSketcher();
    await streamTrimPair([new FakeFile(R1, 1024)], [new FakeFile(R2, 200)], 800, {
      onChunk1: (c) => sk.feed(0, c),
      onChunk2: (c) => sk.feed(1, c),
      queued1: () => sk.queued(0),
      queued2: () => sk.queued(1),
      lagMax,
    });
    return sk;
  };

  const bounded = await run(50);
  const perChunk = 20; // records a single 1 KiB R1 chunk can add past the check
  check("drift stays inside the budget", bounded.maxLag <= 50 + perChunk,
    `peak lag ${bounded.maxLag}`);
  check("bounded run still pairs everything", bounded.pairs === 800,
    `paired ${bounded.pairs}`);

  // Same scenario with the budget disabled: this is what the unbounded
  // Promise.all did, and what makes the wasm queue hold a whole mate.
  const unbounded = await run(Infinity);
  check("without the budget the drift blows up", unbounded.maxLag > 300,
    `peak lag ${unbounded.maxLag}`);
  check("unbounded run pairs everything too", unbounded.pairs === 800);

  check("default budget is 100k reads (~18 MiB of wasm queue)",
    PAIR_LAG_MAX === 100000, `${PAIR_LAG_MAX}`);
}

console.log("== paired-end joint failure ==");
{
  const R1 = makeFastq(400, 33);
  const R2 = makeFastq(4000, 44);
  const sk = fakePairSketcher();
  let fed2 = 0;
  let threw = null;
  const r2File = new FakeFile(R2, 128);
  try {
    await streamTrimPair(
      [new FailingFile(R1, 256, 1024)], [r2File], 4000,
      {
        onChunk1: (c) => sk.feed(0, c),
        onChunk2: (c) => { fed2 += c.length; sk.feed(1, c); },
        queued1: () => sk.queued(0),
        queued2: () => sk.queued(1),
      },
    );
  } catch (e) { threw = e; }

  check("a failing mate rejects the pair", threw !== null && /simulated/.test(threw.message),
    threw ? threw.message : "no throw");
  check("the surviving mate was cut short, not run to completion", fed2 < r2File.size,
    `fed ${fed2} of ${r2File.size}`);

  // The dangerous part: a survivor still looping in the background keeps
  // calling feed_r2 on the shared Profiler, and those reads land in the NEXT
  // sample of the same worker. Nothing may move after the rejection.
  const fedAtThrow = fed2;
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
  check("no mate keeps feeding after the rejection", fed2 === fedAtThrow,
    `fed ${fedAtThrow} -> ${fed2}`);
}

console.log("== abort propagates to both mates ==");
{
  const R1 = makeFastq(2000, 55);
  const R2 = makeFastq(2000, 66);
  const sk = fakePairSketcher();
  const ac = new AbortController();
  let fed1 = 0, fed2 = 0;
  let threw = null;
  try {
    await streamTrimPair([new FakeFile(R1, 64)], [new FakeFile(R2, 64)], 2000, {
      // Cancel mid-run, as the UI's Cancel button does. (A timer would never
      // fire: ReadableStream reads resolve as microtasks, so the loops never
      // yield to the macrotask queue on their own.)
      onChunk1: (c) => { fed1 += c.length; if (fed1 > 5000) ac.abort(); sk.feed(0, c); },
      onChunk2: (c) => { fed2 += c.length; sk.feed(1, c); },
      queued1: () => sk.queued(0),
      queued2: () => sk.queued(1),
      signal: ac.signal,
    });
  } catch (e) { threw = e; }
  check("abort rejects", threw !== null && threw.name === "AbortError",
    threw ? threw.name : "no throw");
  const at = [fed1, fed2];
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  check("both mates are stopped by the abort", fed1 === at[0] && fed2 === at[1],
    `${at} -> ${[fed1, fed2]}`);
}

// ---- truncated gzip must FAIL, not return a partial sample ------------------
//
// The single most dangerous failure mode of this file: an interrupted download
// leaves a .gz whose deflate stream never ends. fflate raises on the final
// push; swallowing that turns the truncation into a clean EOF and the sample is
// profiled — and reported as a success — on whatever fraction of the reads
// arrived. The user reads abundances computed on 60% of their sample believing
// they have 100%.
console.log("== truncated gzip ==");
{
  const BIG = makeFastq(2000, 77);
  const gz = gzipSync(BIG);
  const truncated = gz.subarray(0, Math.floor(gz.length * 0.6));

  let fed = 0, threw = null, res = null;
  try {
    res = await streamTrim(new FakeFile(truncated, 4096), 1e9,
      (c) => { fed += c.length; }, null, null);
  } catch (e) { threw = e; }
  check("a truncated .gz rejects instead of returning a partial sample",
    threw !== null,
    threw ? threw.message : `no throw: reads=${res?.reads}/2000 bytes=${fed}/${BIG.length}`);
  check("the truncation was detected before the reads ran out", fed < BIG.length,
    `${fed} of ${BIG.length}`);

  // Same file, same truncation, but the read cap is reached before the cut:
  // the rest of the file was going to be ignored anyway, so this must succeed.
  let threwCapped = null, capped = null;
  try {
    capped = await streamTrim(new FakeFile(truncated, 4096), 200, () => {}, null, null);
  } catch (e) { threwCapped = e; }
  check("a truncation after the read cap is not an error", threwCapped === null,
    threwCapped ? threwCapped.message : "");
  check("the capped run still returns its reads", capped?.reads === 200,
    `${capped?.reads}`);

  // And an intact .gz of the same shape still succeeds, so the check above is
  // not just "gzip always throws".
  const whole = await streamTrim(new FakeFile(gz, 4096), 1e9, () => {}, null, null);
  check("an intact .gz still succeeds", whole.reads === 2000, `${whole.reads}`);
}

// ---- paired-end: the cross-stop must not ignore the carry -------------------
console.log("== paired-end cross-stop and the carry ==");
{
  // Sketcher model with a carry, i.e. what PairStreamSketcher really does: a
  // record is only queued once its 4th '\n' has arrived, and the last record of
  // a file with no trailing newline waits in the carry until finish().
  const carryPairSketcher = () => {
    const lines = [0, 0], queued = [0, 0], carry = [0, 0];
    let pairs = 0;
    const drain = () => {
      const d = Math.min(queued[0], queued[1]);
      queued[0] -= d; queued[1] -= d; pairs += d;
    };
    return {
      feed(side, chunk) {
        for (let i = 0; i < chunk.length; i++) {
          carry[side]++;
          if (chunk[i] === 0x0a && ++lines[side] === 4) {
            lines[side] = 0; queued[side]++; carry[side] = 0;
          }
        }
        drain();
      },
      finish() {
        // needletail parses a last record with no trailing newline just fine.
        for (const s of [0, 1]) if (lines[s] === 3 && carry[s] > 3) { queued[s]++; carry[s] = 0; }
        drain();
      },
      queued: (s) => queued[s],
      pending: (s) => queued[s] + (carry[s] > 0 ? 1 : 0),
      get pairs() { return pairs; },
    };
  };

  // R1: 3 records, NO trailing newline -> its 3rd record sits in the carry.
  // R2: 3 records, read one at a time and slowly, so R1's loop is over first.
  const R1 = makeFastq(3, 91);
  const R1_NO_NL = R1.subarray(0, R1.length - 1);
  const R2 = makeFastq(3, 92);
  const r2ChunkSize = Math.ceil(R2.length / 3);

  const runPair = async (useCarryAwareGetters) => {
    const sk = carryPairSketcher();
    let fed2 = 0;
    await streamTrimPair(
      [new FakeFile(R1_NO_NL, R1_NO_NL.length)],   // whole mate in one chunk
      [new FakeFile(R2, r2ChunkSize, 5)],          // one record at a time, slowly
      1e9,
      {
        onChunk1: (c) => sk.feed(0, c),
        onChunk2: (c) => { fed2 += c.length; sk.feed(1, c); },
        queued1: () => sk.queued(0),
        queued2: () => sk.queued(1),
        pending1: useCarryAwareGetters ? () => sk.pending(0) : undefined,
        pending2: useCarryAwareGetters ? () => sk.pending(1) : undefined,
      },
    );
    sk.finish();
    return { pairs: sk.pairs, fed2 };
  };

  const withPending = await runPair(true);
  check("the mate with a carried last record still gets its pair",
    withPending.pairs === 3, `paired ${withPending.pairs}/3, R2 read ${withPending.fed2}/${R2.length}`);
  check("the survivor was read to its own EOF", withPending.fed2 === R2.length,
    `${withPending.fed2}/${R2.length}`);

  // Without the carry-aware getters there is no cross-stop at all: costlier,
  // never wrong. (A queue-only cross-stop would cut R2 at 2 records here.)
  const withoutPending = await runPair(false);
  check("no pending getters means no cross-stop, not a queue-only guess",
    withoutPending.pairs === 3, `paired ${withoutPending.pairs}/3`);

  // The cross-stop must still fire when the other mate really is exhausted:
  // R1 = 3 records WITH its trailing newline, R2 = 40 records. R2 must be cut
  // long before its own EOF.
  {
    const sk = carryPairSketcher();
    const R2long = makeFastq(40, 93);
    let fed2 = 0;
    await streamTrimPair(
      [new FakeFile(R1, R1.length)],
      [new FakeFile(R2long, Math.ceil(R2long.length / 40), 2)],
      1e9,
      {
        onChunk1: (c) => sk.feed(0, c),
        onChunk2: (c) => { fed2 += c.length; sk.feed(1, c); },
        queued1: () => sk.queued(0), queued2: () => sk.queued(1),
        pending1: () => sk.pending(0), pending2: () => sk.pending(1),
      },
    );
    sk.finish();
    check("the cross-stop still cuts a mate whose partner is truly over",
      fed2 < R2long.length, `R2 read ${fed2}/${R2long.length}`);
    check("and it cuts it only after the last pair", sk.pairs === 3, `${sk.pairs}`);
  }
}

// ---- cache-bust consistency -------------------------------------------------
// The worker URL is versioned in sylph-worker-rpc.js; every module it imports
// has to carry the same version, or a browser can pair a fresh worker with a
// stale dependency and fail the named import (which kills the worker outright,
// with no fallback — the fallback lives inside the worker).
console.log("== cache-bust versions ==");
const here = fileURLToPath(new URL(".", import.meta.url));
const rpcSrc = readFileSync(here + "sylph-worker-rpc.js", "utf8");
const workerSrc = readFileSync(here + "sylph-worker.js", "utf8");
{
  const rpcV = rpcSrc.match(/WORKER_VERSION\s*=\s*"(\d+)"/)?.[1];
  const trimV = workerSrc.match(/from\s+"\.\/fastq-trim\.js\?v=(\d+)"/)?.[1];
  const rpcImportV = workerSrc.match(/from\s+"\.\/sylph-worker-rpc\.js\?v=(\d+)"/)?.[1];
  check("WORKER_VERSION is set", !!rpcV, String(rpcV));
  check("worker imports fastq-trim.js with a version", !!trimV, String(trimV));
  check("worker imports sylph-worker-rpc.js with a version", !!rpcImportV, String(rpcImportV));
  check("fastq-trim version matches", rpcV === trimV, `rpc=${rpcV} import=${trimV}`);
  check("worker-rpc version matches", rpcV === rpcImportV, `rpc=${rpcV} import=${rpcImportV}`);
  check("version was bumped past 8 for the dual 32/64-bit packages", Number(rpcV) >= 9, String(rpcV));

  // db-cache.js is imported by the worker (readCachedBytes) AND is the module
  // that db-cache-worker.js is built from, so it is part of the same graph and
  // has to be busted with the same token.
  const cacheV = workerSrc.match(/from\s+"\.\/db-cache\.js\?v=(\d+)"/)?.[1];
  const cacheWorkerSrc = readFileSync(here + "db-cache-worker.js", "utf8");
  const cacheWorkerV = cacheWorkerSrc.match(/from\s+"\.\/db-cache\.js\?v=(\d+)"/)?.[1];
  check("worker imports db-cache.js with a version", !!cacheV, String(cacheV));
  check("db-cache version matches", rpcV === cacheV, `rpc=${rpcV} import=${cacheV}`);
  check("db-cache-worker imports db-cache.js with the same version",
    rpcV === cacheWorkerV, `rpc=${rpcV} import=${cacheWorkerV}`);
  check("version was bumped past 9 for the loadDbCached protocol change",
    Number(rpcV) >= 10, String(rpcV));

  // The page -> rpc edge, which is how this bit us for real: index.html asked
  // for multi.js?v=4 while multi.js imported ./sylph-worker-rpc.js with no
  // version at all. A returning visitor got the new page module against the
  // cached old rpc module and hit "r.loadDbCached is not a function" — a broken
  // app with no way back except clearing the cache by hand.
  //
  // One token for the whole graph, checked here: every module a page pulls in,
  // directly or transitively, is busted together or not at all.
  for (const [page, mod] of [["index.html", "multi.js"], ["profile.html", "profile.js"]]) {
    const pageSrc = readFileSync(here + page, "utf8");
    const modSrc = readFileSync(here + mod, "utf8");
    const pageV = pageSrc.match(new RegExp(`src="\\./${mod.replace(".", "\\.")}\\?v=(\\d+)"`))?.[1];
    const modRpcV = modSrc.match(/from\s+"\.\/sylph-worker-rpc\.js\?v=(\d+)"/)?.[1];
    check(`${page} versions ${mod}`, !!pageV, String(pageV));
    check(`${mod} imports the rpc with a version`, !!modRpcV, String(modRpcV));
    check(`${page} -> ${mod} is on WORKER_VERSION`, pageV === rpcV, `page=${pageV} rpc=${rpcV}`);
    check(`${mod} -> rpc is on WORKER_VERSION`, modRpcV === rpcV, `import=${modRpcV} rpc=${rpcV}`);
  }

  // The defect this whole cache exists to fix: a worker that fetches the
  // database itself downloads it once per worker in the pool.
  // (Matched against code, not prose: the comment explaining the removal names
  // the old message type on purpose.)
  check("the sylph worker no longer handles loadDbUrl",
    !/type\s*===\s*"loadDbUrl"/.test(workerSrc));
  check("the sylph worker issues no fetch of its own",
    !/\bfetch\s*\(/.test(workerSrc));
  check("the sylph worker reads the database from the local cache",
    /readCachedBytes/.test(workerSrc) && /loadDbCached/.test(workerSrc));

  // The wasm package is no longer a static import: it is picked at runtime.
  // A static `import ... from "./sylph-pkg/..."` would silently pin the 32-bit
  // build no matter what the probe says, because it would be hoisted above the
  // whole selection.
  check("the worker does not statically import a wasm package",
    !/^\s*import\s[^\n]*sylph-pkg/m.test(workerSrc));
  check("the worker names both packages", /sylph-pkg\/sylph_wasm\.js/.test(workerSrc)
    && /sylph-pkg64\/sylph_wasm\.js/.test(workerSrc));

  // ena.js joined the worker's module graph in v12, so it is busted with the
  // same token as everything else. A v11 worker paired with a v12 page would be
  // asked for "profileUrls" and answer nothing at all.
  const enaWorkerV = workerSrc.match(/from\s+"\.\/ena\.js\?v=(\d+)"/)?.[1];
  const multiSrcForEna = readFileSync(here + "multi.js", "utf8");
  const enaPageV = multiSrcForEna.match(/from\s+"\.\/ena\.js\?v=(\d+)"/)?.[1];
  check("the worker imports ena.js with a version", !!enaWorkerV, String(enaWorkerV));
  check("ena.js version matches in the worker", rpcV === enaWorkerV, `rpc=${rpcV} import=${enaWorkerV}`);
  check("multi.js imports ena.js with the same version", rpcV === enaPageV, `rpc=${rpcV} import=${enaPageV}`);
  check("version was bumped past 11 for the ENA message types", Number(rpcV) >= 12, String(rpcV));
}

// ---- the ENA input mode is wired to the code that already exists -------------
//
// The point of this section is NOT that ENA mode works (that is
// scripts/ena-test/node-suite.mjs, which drives the real modules against a
// server that misbehaves on purpose). It is that the second input mode did not
// become a second application: same worker branches, same sketching, same
// progress protocol, one privacy claim covering both paths.
console.log("== ENA mode wiring ==");
{
  const enaSrc = readFileSync(here + "ena.js", "utf8");
  const multiSrc = readFileSync(here + "multi.js", "utf8");
  const indexSrc = readFileSync(here + "index.html", "utf8");

  // ena.js is imported by the WORKER, which has no DOM. A stray document/window
  // reference would kill the worker module at instantiation — and only in ENA
  // mode, i.e. only for the users of the new feature.
  const enaCode = enaSrc.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check("ena.js touches no DOM (it runs inside the worker)",
    !/\bdocument\b/.test(enaCode) && !/\bwindow\./.test(enaCode));
  // `globalThis.fetch` CALLED with no receiver is an "Illegal invocation"
  // TypeError in a browser — and only in a browser, so node would never show it.
  // Every call site goes through an injected or bound function.
  check("ena.js never calls fetch detached from the global object",
    !/(await|=|\breturn)\s+fetch\(/.test(enaCode) && !/globalThis\.fetch\(/.test(enaCode),
    "fetch must be bound (boundFetch) or injected (fetchImpl)");
  check("...and it does bind it", /\.bind\(globalThis\)/.test(enaCode));

  // THE reuse claim, checked against the code: the URL variants are handled by
  // the same branch as the File variants. Two separate branches would mean two
  // copies of the sketching loop, which is exactly what this file exists to
  // stop drifting apart.
  check("profileUrls shares the branch with profileFilesMulti",
    /type === "profileFilesMulti" \|\| type === "profileUrls"/.test(workerSrc));
  check("profileUrlsPe shares the branch with profileFilesPe",
    /type === "profileFilesPe" \|\| type === "profileUrlsPe"/.test(workerSrc));
  check("there is exactly one begin_sample_pe call in the worker",
    (workerSrc.match(/begin_sample_pe\(/g) || []).length === 1);
  check("there is exactly one streamTrimPair call in the worker",
    (workerSrc.match(/streamTrimPair\(/g) || []).length === 1);
  check("the rpc exposes both URL entry points",
    /async profileUrls\(/.test(rpcSrc) && /async profileUrlsPe\(/.test(rpcSrc));

  // The progress protocol the pages already understand, plus the network fields.
  check("the worker still emits the profile_start phase", /phase: "profile_start"/.test(workerSrc));
  check("the worker emits a retry phase for cut downloads", /phase: "net_retry"/.test(workerSrc));
  check("multi.js handles the retry phase", /net_retry/.test(multiSrc));
  check("the worker attaches a network rate", /bps: bps\(/.test(workerSrc) || /bps: bps1\(/.test(workerSrc));
  check("multi.js shows that rate", /fmtRate\(/.test(multiSrc));

  // Every id multi.js reaches for has to exist in the page it is loaded from.
  // This is how the ENA panel would break: a renamed id fails silently at
  // startup and the button simply does nothing.
  const ids = [...multiSrc.matchAll(/\$\("([A-Za-z0-9_]+)"\)/g)].map((m) => m[1]);
  const missing = [...new Set(ids)].filter((id) => !indexSrc.includes(`id="${id}"`));
  check("every element multi.js looks up exists in index.html", missing.length === 0,
    missing.join(", "));
  for (const id of ["enaAcc", "enaResolve", "enaRuns", "enaAdd", "enaSummary", "enaPending"]) {
    check(`index.html has the ${id} control`, indexSrc.includes(`id="${id}"`));
  }

  // The download total has to be visible BEFORE the click, not after: a project
  // is tens of gigabytes and hours of downloading.
  // downloadEstimate() replaced the raw sum of fastq_bytes: it also bounds the
  // total by the read cap and refuses to turn an unknown size into an ETA.
  // scripts/ena-test/wiring.mjs holds the detail of both.
  check("the cost of a selection is computed from the sizes",
    /downloadEstimate\(/.test(multiSrc) && /etaNote\(/.test(multiSrc));
  check("the estimate says which rate it used",
    /measured on your link/.test(multiSrc) && /assumed until measured/.test(multiSrc));

  // Privacy. Both claims, and neither at the expense of the other.
  const banner = indexSrc.match(/<div class="privacy-notice"[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? "";
  check("the privacy banner still promises local files never leave",
    /never leave your computer/.test(banner), banner.slice(0, 80));
  check("...and no longer claims that NOTHING is sent to any server",
    !/No data is sent to any server/.test(indexSrc));
  // Was asserted on the top banner. The paragraph now lives inside the ENA
  // panel, at the control it is about — so that is where it must be found, and
  // finding it merely "somewhere in the page" would be a weaker check.
  const enaPanel = indexSrc.match(/<div class="ena-head">[\s\S]*?<\/div>/)?.[0] ?? "";
  check("...and says the ENA mode contacts the EBI, at the ENA control",
    /EBI/.test(enaPanel), enaPanel.slice(0, 80));
  check("...naming what the EBI gets to see",
    /IP address/.test(enaPanel) && /accession/.test(enaPanel));
  // The Zenodo paragraph moved the same way, to the database card.
  check("...and the database download names what Zenodo gets to see",
    /zenodo\.org/.test(indexSrc) && /Zenodo sees your IP address/.test(indexSrc));
  check("...and that downloads are streamed, not stored",
    /without ever writing them to your disk|never written to your disk/.test(indexSrc));
}

// ---- the memory64 probe -----------------------------------------------------
//
// This is the whole load-bearing decision: get it wrong and either every browser
// is told it has memory64 (silent 4 GB cap, run dies mid-sample) or none is
// (50 M reads becomes unreachable). It cannot be exercised on the real engine
// here — node 22 has no memory64, node 24 does — so the probe takes the
// WebAssembly namespace as a parameter and the engines are modelled.

// Both probe modules are 13 bytes; byte 11 is the memory's flags field, and
// 0x04 is the MEMORY64 bit.
const memoryFlags = (bytes) => (bytes.length === 13 ? bytes[11] : null);
const throwOnBigIntBounds = (desc) => {
  for (const k of ["initial", "maximum"]) {
    if (typeof desc?.[k] === "bigint") {
      // Exactly what ToNumber(BigInt) does in a real engine.
      throw new TypeError("Cannot convert a BigInt value to a number");
    }
  }
};

// A 32-bit-only engine, modelled on how the real JS API behaves: unknown
// descriptor properties are silently ignored (THE trap), BigInt bounds throw,
// and the decoder rejects a memory64 module.
const engine32 = () => ({
  Memory: function Memory(desc) { throwOnBigIntBounds(desc); this.bits = 32; },
  validate: (bytes) => memoryFlags(bytes) === 0x00,
});

// A memory64 engine as shipped: `address` is the property, BigInt bounds are
// accepted for an i64 memory, the decoder takes both modules.
const engine64 = () => ({
  Memory: function Memory(desc) {
    if (desc?.address !== "i64") throwOnBigIntBounds(desc);
    this.bits = desc?.address === "i64" ? 64 : 32;
  },
  validate: (bytes) => memoryFlags(bytes) === 0x00 || memoryFlags(bytes) === 0x04,
});

// An engine from the era when the spec draft called the property `index`: the
// decoder can do memory64 but the JS API answers to the other name.
const engineOldDraft = () => ({
  Memory: function Memory(desc) {
    if (desc?.index !== "i64") throwOnBigIntBounds(desc);
    this.bits = desc?.index === "i64" ? 64 : 32;
  },
  validate: (bytes) => memoryFlags(bytes) === 0x00 || memoryFlags(bytes) === 0x04,
});

// An engine so broken it cannot validate a plain 32-bit memory — the control
// that stops a `false` from being blamed on memory64.
const engineBroken = () => ({
  Memory: function Memory() { throw new Error("nope"); },
  validate: () => false,
});

// The bug the probe is written to avoid, spelled out: wrong property name and
// Number bounds. `index` is not a key WebAssembly.Memory knows, so it is
// dropped on the floor, the memory is built as an ordinary 32-bit one, and the
// probe reports success.
function buggyProbeWithIndex(wasm) {
  try { new wasm.Memory({ initial: 1, maximum: 4, index: "i64" }); return true; }
  catch { return false; }
}

console.log("== memory64 probe ==");
{
  check("says yes to an engine that really has memory64", detectMemory64(engine64()).ok === true);

  // Deliberate failure #1: a 32-bit-only engine. The probe MUST say no.
  const no32 = detectMemory64(engine32());
  check("says no to a 32-bit-only engine", no32.ok === false, JSON.stringify(no32));
  check("and says which half refused", /validate/.test(no32.reason), no32.reason);

  // THE point of this section. Same engine, same descriptor except for one
  // word: `index` instead of `address`. The buggy probe is handed a plain
  // 32-bit memory and reports success — no throw, nothing to notice at runtime
  // until a run dies at 4 GB. That is why the probe is tested, not eyeballed.
  check("the `index` spelling would be a FALSE POSITIVE on a 32-bit engine",
    buggyProbeWithIndex(engine32()) === true);
  check("...where the real probe correctly says no",
    detectMemory64(engine32()).ok === false);
  // Comments stripped: the file spells out the `index` trap in prose, and that
  // prose must not be mistaken for the bug it warns about.
  const rpcCode = rpcSrc.replace(/\/\/[^\n]*/g, "");
  check("the source really uses `address`, not `index`",
    /address:\s*"i64"/.test(rpcCode) && !/\bindex:\s*"i64"/.test(rpcCode));
  check("the source passes BigInt bounds (that is what makes the `no` reliable)",
    /initial:\s*1n/.test(rpcCode) && /maximum:\s*4n/.test(rpcCode));

  // Deliberate failure #2: memory64 in the decoder, old draft name in the JS
  // API. Falling back to 32-bit here is a lost opportunity, never a wrong
  // answer — the safe direction.
  const oldDraft = detectMemory64(engineOldDraft());
  check("an engine using the old `index` name falls back rather than guessing",
    oldDraft.ok === false, oldDraft.reason);
  check("and the reason blames the constructor, not the decoder",
    /WebAssembly\.Memory/.test(oldDraft.reason), oldDraft.reason);

  // Deliberate failure #3: no usable WebAssembly at all.
  check("says no when validate() is unusable", detectMemory64(engineBroken()).ok === false);
  check("and admits the probe itself is not usable there",
    /not usable/.test(detectMemory64(engineBroken()).reason),
    detectMemory64(engineBroken()).reason);
  // `undefined` is the "use globalThis.WebAssembly" default, so the no-namespace
  // case has to be spelled null.
  check("says no with no WebAssembly namespace", detectMemory64(null).ok === false);
  check("says no with a namespace missing Memory",
    detectMemory64({ validate: () => true }).ok === false);

  // And against whatever engine is actually running this file. Not asserted
  // either way (node 22 has no memory64, node 24 does) — but the two halves
  // must agree with each other, and the control must pass.
  const real = detectMemory64();
  const controlOk = WebAssembly.validate(
    Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0x05, 0x03, 0x01, 0x00, 0x01));
  check("the memory32 control module validates on the real engine", controlOk === true);
  console.log(`   (this engine: memory64 ${real.ok ? "YES" : "no"} — ${real.reason})`);
  if (real.ok) {
    let built = null;
    try { built = new WebAssembly.Memory({ initial: 1n, maximum: 4n, address: "i64" }); } catch { }
    check("a yes from the real engine really does build an i64 memory", built !== null);
  }
}

// ---- the 32/64 choice -------------------------------------------------------
console.log("== the cap in bases, for long reads ==");
{
  // A read cap is not a memory bound across platforms. The measured budget
  // (48,750,000 reads on wasm32) was taken on 150 bp reads — 7.3 Gbases — and
  // the sketch grows with BASES. The same 3 M reads is 0.45 Gbase of Illumina
  // and 30 Gbases of 10 kb nanopore: four times the whole 32-bit budget, and it
  // dies in an unrecoverable allocator abort rather than slowly.
  const mk = (n, len) => {
    let out = "";
    for (let i = 0; i < n; i++) out += `@r${i}\n${"ACGT".repeat(len / 4)}\n+\n${"I".repeat(len)}\n`;
    return new TextEncoder().encode(out);
  };
  const blobOf = (u) => ({
    size: u.length,
    slice: (a, b) => ({ arrayBuffer: async () => u.slice(a, b).buffer }),
    stream() {
      let done = false;
      return new ReadableStream({ pull(c) { if (done) { c.close(); return; } c.enqueue(u); done = true; } });
    },
  });
  const b = blobOf(mk(10, 100));           // 10 reads, 1000 sequence bases
  const run = (maxReads, maxBases) =>
    streamTrimMulti([b], maxReads, () => {}, undefined, undefined, undefined, undefined, maxBases);

  check("no base cap leaves the read cap exactly as it was",
    (await run(3, Infinity)).reads === 3);
  check("a base cap stops on the record that reaches it",
    (await run(10, 500)).reads === 5, `${(await run(10, 500)).reads} reads`);
  // Never mid-record: 250 bases falls inside read 3, so read 3 is completed.
  check("...and never mid-record — a partial read would be a corrupt sketch",
    (await run(10, 250)).bases === 300);
  check("...so a cap below one read still yields one whole read",
    (await run(10, 99)).reads === 1);
  // Whichever comes first, which is the whole point: Illumina keeps hitting the
  // read cap, nanopore starts hitting the base cap.
  check("the READ cap still wins when it is the tighter of the two",
    (await run(2, 900)).reads === 2);
  check("the BASE cap wins when it is the tighter of the two",
    (await run(10, 400)).reads === 4);

  // The equivalence the checkbox offers, and the number the budget was measured
  // at — if these drift apart the cap stops meaning what the label says.
  check("'equivalent of N reads' is N x the measured read length",
    basesForReads(3e6) === 3e6 * BUDGET_READ_BP && BUDGET_READ_BP === 150,
    `${BUDGET_READ_BP} bp`);
}

console.log("== per-sample progress fraction ==");
{
  const pf = progressFraction;
  // THE case this function exists for. Under a read cap the sample ends long
  // before the file does, so a ring driven by bytes alone would stop at 30% and
  // disappear — indistinguishable from a crash.
  check("a capped run is full when the cap is reached, not when the file ends",
    pf({ bytesIn: 30, total: 100, reads: 3e6, cap: 3e6 }) === 1);
  check("...and reads half the cap at half the ring", 
    pf({ bytesIn: 15, total: 100, reads: 1.5e6, cap: 3e6 }) === 0.5);
  // The mirror case: a file smaller than the cap never reaches it, and a ring
  // driven by reads alone would freeze at a third.
  check("a file shorter than the cap is full when the file ends",
    pf({ bytesIn: 100, total: 100, reads: 1e6, cap: 3e6 }) === 1);
  check("either input alone is enough — no declared size",
    pf({ bytesIn: NaN, total: NaN, reads: 1.5e6, cap: 3e6 }) === 0.5);
  check("either input alone is enough — no cap",
    pf({ bytesIn: 50, total: 100, reads: 9e9, cap: Infinity }) === 0.5);
  // NaN, not 0: a ring that sits at empty for ever reads as broken, while an
  // indeterminate spinner is honest about not knowing.
  check("neither input gives NaN, so the UI can show indeterminate rather than 0%",
    Number.isNaN(pf({ bytesIn: NaN, total: NaN, reads: 5, cap: Infinity })));
  check("nothing read yet is 0, which is different from unknown",
    pf({ bytesIn: 0, total: 100, reads: 0, cap: 3e6 }) === 0);
  // Both overshoots are real: the sketcher stops on a record boundary past the
  // cap, and a gzip can be served with a short declared size.
  check("overshooting the cap clamps to full, never past it",
    pf({ bytesIn: 31, total: 100, reads: 3.05e6, cap: 3e6 }) === 1);
  check("a short declared size clamps to full too",
    pf({ bytesIn: 120, total: 100, reads: 10, cap: 3e6 }) === 1);
  check("no argument at all is NaN rather than a throw", Number.isNaN(pf()));
}

console.log("== wasm package choice ==");
{
  const bits = (maxReads, memory64) => chooseWasmBits({ maxReads, memory64 }).bits;

  // 64-bit is 1.58x-1.68x slower end-to-end. It is never the default.
  check("small run on a memory64 browser still picks 32-bit", bits(1_000_000, true) === 32);
  check("the 32-bit boundary is inclusive", bits(WASM32_SAFE_READS, true) === 32);
  check("one read past it picks 64-bit", bits(WASM32_SAFE_READS + 1, true) === 64);
  check("a 50 M read run picks 64-bit", bits(50_000_000, true) === 64);
  check("the probe object is accepted as well as a boolean",
    bits(50_000_000, { ok: true }) === 64 && bits(50_000_000, { ok: false }) === 32);

  // No memory64: there is nothing else to load, so 32-bit and say so.
  const safari = chooseWasmBits({ maxReads: 50_000_000, memory64: false });
  check("no memory64 means 32-bit even for a run that will not fit", safari.bits === 32);
  check("and it is flagged as capped so the UI can explain", safari.capped === true);
  check("the reason names the browser, not sylph", /browser/.test(safari.reason), safari.reason);
  check("a run that fits is not flagged as capped",
    chooseWasmBits({ maxReads: 1_000_000, memory64: false }).capped === false);

  // Unknown reads must not silently opt into the slow build.
  check("no maxReads defaults to 32-bit", chooseWasmBits({}).bits === 32);
  check("a non-finite maxReads defaults to 32-bit", bits(NaN, true) === 32);
  check("undefined memory64 is treated as absent", bits(50_000_000, undefined) === 32);

  // The margin under the measured ceilings has to be real and generous: the
  // failure mode is an unrecoverable allocator abort, and PE roughly doubles
  // the per-read state.
  check("32-bit safe limit sits well under the measured ceiling",
    WASM32_SAFE_READS < WASM32_CEILING_READS && WASM32_SAFE_READS <= 0.6 * WASM32_CEILING_READS,
    `${WASM32_SAFE_READS} vs ${WASM32_CEILING_READS}`);
  check("64-bit safe limit sits well under its measured ceiling",
    WASM64_SAFE_READS < WASM64_CEILING_READS && WASM64_SAFE_READS <= 0.6 * WASM64_CEILING_READS,
    `${WASM64_SAFE_READS} vs ${WASM64_CEILING_READS}`);

  // The headline claim of the whole exercise: a real gut metagenome (20-50 M
  // reads) is reachable with memory64 and is not without it.
  check("50 M reads is inside the 64-bit budget", readsBudget(true).safeMax >= 50_000_000,
    `${readsBudget(true).safeMax}`);
  check("50 M reads is outside the 32-bit budget", readsBudget(false).safeMax < 50_000_000,
    `${readsBudget(false).safeMax}`);
  check("the slider can actually reach 50 M when memory64 is there",
    readsBudget(true).sliderMax >= 50_000_000, `${readsBudget(true).sliderMax}`);
  check("and stops at the safe limit when it is not",
    readsBudget(false).sliderMax === WASM32_SAFE_READS, `${readsBudget(false).sliderMax}`);

  // A Safari user has to be told it is the browser, not a broken page.
  const note = readsOverBudgetNote(50_000_000, false);
  check("the over-budget warning names memory64", /memory64/.test(note), note);
  check("the over-budget warning names a browser that would work",
    /Chrome|Firefox/.test(note), note);

  // The database line reports the ceiling of the build that is LOADED, never
  // the browser's. "32-bit WebAssembly, up to 96,000,000 reads" would be a
  // promise the loaded module cannot keep.
  const on32with64 = loadedBuildNote(32, true);
  check("a 32-bit build never advertises the 64-bit ceiling",
    !on32with64.includes(String(WASM64_SAFE_READS).replace(/\B(?=(\d{3})+(?!\d))/g, ",")),
    on32with64);
  check("...and says the switch is automatic", /switches to 64-bit/.test(on32with64), on32with64);
  check("a 64-bit build reports the 64-bit ceiling",
    /64-bit/.test(loadedBuildNote(64, true)) && /96,000,000/.test(loadedBuildNote(64, true)),
    loadedBuildNote(64, true));
  check("without memory64 the line says capped, and why",
    /capped/.test(loadedBuildNote(32, false)) && /memory64/.test(loadedBuildNote(32, false)),
    loadedBuildNote(32, false));
}

console.log("== cross-stop never cuts a mate that has delivered nothing ==");
{
  // The sketcher validates each side on its FIRST block, so a mate cut at
  // bytes_fed == 0 makes finish() sink the whole sample: a profile becomes an
  // error, decided by nothing but which mate the event loop scheduled first.
  //
  // Only one path can cut a mate at zero bytes. The read loop always consumes a
  // chunk before consulting shouldStop, so the cut has to happen at the top of
  // the FILE loop — which needs a sample split over several runs whose first run
  // yields nothing. An empty .gz among the runs of one sample is enough, and the
  // UI does group several runs into one sample.
  //
  // Two earlier versions of this test passed with the guard removed, which is to
  // say they tested nothing: the first left records queued on the other mate (so
  // the cross-stop condition was never true), the second used a single run (so
  // the file-loop check was never reached a second time).
  const run = async () => {
    const fed = [0, 0];
    // Other mate: empty, so it finishes at once with nothing queued or carried.
    // This mate: an empty run followed by a real one.
    await streamTrimPair(
      [new FakeFile(new Uint8Array(0), 64)],
      [new FakeFile(new Uint8Array(0), 64), new FakeFile(makeFastq(3), 64, 1)],
      1000,
      {
        onChunk1: (c) => { fed[0] += c.length; },
        onChunk2: (c) => { fed[1] += c.length; },
        queued1: () => 0, queued2: () => 0,
        pending1: () => 0, pending2: () => 0,
      },
    );
    return fed[1];
  };
  const delivered = await run();
  check("a mate with an empty first run still gets to deliver its second",
    delivered > 0, `mate 2 delivered ${delivered} bytes`);
}

console.log("== pairing dropped files into samples ==");
{
  const { matePattern, stripFastqExt } = await import("./sample-naming.js");
  const pairs = (a, b) => {
    const ma = matePattern(a), mb = matePattern(b);
    return !!ma && !!mb && ma.key === mb.key && ma.mate !== mb.mate;
  };

  // Reported from real data: the mate marker is followed by a pipeline suffix,
  // which the original pattern (marker glued to the extension) did not allow.
  check("_1.clean.fq.gz pairs with _2.clean.fq.gz",
    pairs("V350342913_L03_UDB-193_1.clean.fq.gz", "V350342913_L03_UDB-193_2.clean.fq.gz"));
  check("...and both land in one sample",
    matePattern("V350342913_L03_UDB-193_1.clean.fq.gz").key === "V350342913_L03_UDB-193.clean",
    matePattern("V350342913_L03_UDB-193_1.clean.fq.gz").key);

  // bcl2fastq puts the chunk index AFTER the mate marker. Same defect.
  check("Illumina _R1_001 pairs with _R2_001",
    pairs("SampleName_S1_L001_R1_001.fastq.gz", "SampleName_S1_L001_R2_001.fastq.gz"));

  check("plain ENA _1/_2 still pairs", pairs("ERR1234567_1.fastq.gz", "ERR1234567_2.fastq.gz"));
  check("dot-separated .R1/.R2 still pairs", pairs("sample.R1.fq", "sample.R2.fq"));
  check("uncompressed pairs too", pairs("s_1.fq", "s_2.fq"));
  check("several suffixes are fine",
    pairs("x_1.trimmed.paired.fq.gz", "x_2.trimmed.paired.fq.gz"));

  // The other half of the rule: mates must agree on everything but the marker.
  check("different processing does NOT pair", !pairs("a_1.clean.fq.gz", "a_2.raw.fq.gz"));
  check("different samples do not pair", !pairs("a_1.fq.gz", "b_2.fq.gz"));
  check("a lone mate is not a pair with itself", !pairs("a_1.fq.gz", "a_1.fq.gz"));

  check("a file with no marker stays single-end", matePattern("single_sample.fq.gz") === null);
  check("...and is named without its extension",
    stripFastqExt("single_sample.fq.gz") === "single_sample");
  check("a non-FASTQ extension is not a FASTQ", matePattern("x_1.clean.fs.gz") === null,
    "an unknown extension must not be guessed at");
}

// Sources read by the biome section below. `here` and `rpcSrc` come from the
// cache-bust section above.
const { existsSync } = await import("node:fs");
const indexSrcForBiome = readFileSync(here + "index.html", "utf8");
  const biomesSrc = readFileSync(here + "biomes.js", "utf8");
// Lineage files are schema 2 now: {schema, ranks, rankKeys, species, taxa}.
// The species map is what every check below is about, so unwrap once here
// rather than teaching each of them about the envelope.
const speciesMap = (json) => (json && json.schema === 2 ? json.species : json);
const profileSrcForBiome = readFileSync(here + "profile.html", "utf8");

// ---- the biome picker, and naming the reference on every result --------------
//
// There are nineteen reference databases now — one per MGnify genome catalogue —
// and they cannot be merged: each is dereplicated independently and they overlap,
// so two loaded together would count the same species twice. One at a time,
// picked by the user.
//
// That makes "which biome" the most consequential control on the page, and its
// failure mode is silent: sylph reports the closest genomes the loaded database
// holds, so a saliva sample profiled against the soil catalogue comes back as a
// full, plausible, wrong table. Nothing in the numbers reveals it. The only
// defence is that the biome is named where the result is read — on the status
// line, above the matrix, and inside the exported file — and every check below
// fails if one of those goes away.
console.log("== the biome catalogue ==");
const biomes = await import("./biomes.js");
const catalogJson = JSON.parse(readFileSync(here + "db/biomes.json", "utf8"));
const catalog = biomes.normaliseCatalog(catalogJson);
const catalogEntries = biomes.allBiomes(catalog);
{
  check("db/biomes.json parses into groups", catalog.groups.length >= 4,
    `${catalog.groups.length} groups`);
  check("...covering the four families the biomes fall into",
    ["human", "animal", "plant-soil", "marine"].every(
      (k) => catalog.groups.some((g) => g.key === k)),
    catalog.groups.map((g) => g.key).join(","));
  // Nineteen entries flat in a <select> is a scroll; the point of the file is
  // that they arrive grouped.
  check("every entry sits in exactly one group",
    catalogEntries.length === new Set(catalogEntries.map((b) => b.key)).size,
    `${catalogEntries.length} entries`);
  check("the nineteen catalogues plus the bundled smoke test are all there",
    catalogEntries.length >= 20, `${catalogEntries.length} entries`);

  // A database is offered if and only if it has a URL. Deriving availability
  // from the URL — rather than from a separate flag — is what makes it
  // impossible to publish an entry that points nowhere.
  const pending = catalogEntries.filter((b) => !b.available);
  check("an entry with no URL is marked unavailable, not dropped",
    pending.every((b) => b.unavailableReason.length > 10),
    `${pending.length} pending, e.g. ${pending[0]?.key}: ${pending[0]?.unavailableReason ?? "—"}`);
  check("...and its reason is what the option text says",
    pending.length === 0 || biomes.optionLabel(pending[0]).includes(pending[0].unavailableReason));
  check("...while an available one is not offered with an excuse",
    catalogEntries.filter((b) => b.available)
      .every((b) => b.unavailableReason === "" && b.url.length > 0));
  check("the human-gut database, whose URL is known, is available",
    biomes.biomeByKey(catalog, "human-gut")?.available === true);
  check("...and so is the bundled smoke test",
    biomes.biomeByKey(catalog, "gut-mini")?.available === true);

  // The cache is keyed by URL (db-cache.js: cacheKey -> last two path segments +
  // a hash of the whole href). Two biomes sharing a URL would therefore share a
  // cache entry, and switching between them would silently serve the other one's
  // bytes — which is the same wrong-reference failure, arriving through the
  // cache instead of through the picker.
  const urls = catalogEntries.filter((b) => b.available).map((b) => b.url);
  check("no two biomes share a URL, so no two share a cache entry",
    urls.length === new Set(urls).size, urls.length + " urls");
  check("db-cache still keys entries on the whole URL",
    /fnv1a\(u\.href\)/.test(readFileSync(here + "db-cache.js", "utf8")));

  // Every entry carries what the picker and the exports need to say. A missing
  // species count is not cosmetic: it is one half of the genome-count check that
  // catches a mislabelled deposit.
  check("every entry names its catalogue and version",
    catalogEntries.every((b) => b.catalogue && b.version),
    catalogEntries.find((b) => !b.catalogue || !b.version)?.key ?? "");
  check("every entry carries a species count and a size",
    catalogEntries.every((b) => Number.isFinite(b.species) && b.species > 0
      && Number.isFinite(b.bytes) && b.bytes > 0),
    catalogEntries.find((b) => !Number.isFinite(b.species) || !Number.isFinite(b.bytes))?.key ?? "");
  check("the option text shows both, plus where the bytes come from",
    /4,744 species/.test(biomes.optionLabel(biomes.biomeByKey(catalog, "human-gut")))
    && /433 MB/.test(biomes.optionLabel(biomes.biomeByKey(catalog, "human-gut")))
    && /Zenodo/.test(biomes.optionLabel(biomes.biomeByKey(catalog, "human-gut"))),
    biomes.optionLabel(biomes.biomeByKey(catalog, "human-gut")));

  // The lineage map names genomes, and there is one per catalogue. Declaring it
  // per entry is what stops the gut map being fetched for a soil database — the
  // names would all resolve to nothing and the table would be a column of
  // accessions again, or worse, resolve to gut species for soil genomes.
  //
  // Until the maps were generated, only human-gut had one and this checked that
  // no other entry declared it. All nineteen have their own now, so the property
  // worth pinning is the stronger one: each entry points at ITS OWN map.
  check("every entry declares the lineage map of its own biome",
    catalogEntries.every((b) => b.lineage === `db/lineage/${b.key}.json`
      // gut-mini is a 50-genome cut of human-gut; its genomes are in that map,
      // so it shares it rather than carrying a near-duplicate copy.
      || (b.key === "gut-mini" && b.lineage === "db/lineage/human-gut.json")),
    catalogEntries.find((b) => b.lineage !== `db/lineage/${b.key}.json` && b.key !== "gut-mini")?.key ?? "");

  // The figures come from data/biome-dbs/manifest.tsv, where the genome count is
  // what `sylph inspect` reported for the database that was actually built. That
  // directory is gitignored, so this cross-check runs where it exists and is
  // skipped where it does not, rather than failing on a clean checkout.
  const manifestPath = here + "../data/biome-dbs/manifest.tsv";
  if (existsSync(manifestPath)) {
    const rows = readFileSync(manifestPath, "utf8").trim().split("\n").map((l) => l.split("\t"));
    let agree = 0, disagree = [];
    for (const [name, version, genomes, bytes] of rows) {
      const b = biomes.biomeByKey(catalog, name);
      if (!b) { disagree.push(`${name}: missing from biomes.json`); continue; }
      if (b.version !== version || b.species !== Number(genomes) || b.bytes !== Number(bytes)) {
        disagree.push(`${name}: json=${b.version}/${b.species}/${b.bytes} ` +
          `manifest=${version}/${genomes}/${bytes}`);
      } else agree++;
    }
    check("every built database is in the catalogue with the figures sylph inspect measured",
      disagree.length === 0 && agree === rows.length, disagree.slice(0, 3).join(" | "));
  } else {
    console.log("    (data/biome-dbs/manifest.tsv absent — cross-check skipped)");
  }
}

console.log("== the export formats other tools read ==");
{
  const { toMetaphlan, toBiom, toSylphTsv, toSession, fromSession } =
    await import("./exports.js");
  const lin = {
    g1: { d: "Bacteria", p: "Bacillota", c: "Bacilli", o: "Lactobacillales", f: "Lactobacillaceae", g: "Lactobacillus" },
    g2: { d: "Bacteria", p: "Bacillota", c: "Bacilli", o: "Lactobacillales", f: "Lactobacillaceae", g: "Limosilactobacillus" },
    g3: { d: "Bacteria", p: "Bacteroidota" },
  };
  const sp = { g1: "Lactobacillus iners", g2: "Limosilactobacillus vaginalis", g3: "" };
  const table = { samples: ["S1", "S2"], ref: null, rows: [
    { genome: "g1", species: sp.g1, values: [60, 10] },
    { genome: "g2", species: sp.g2, values: [30, 20] },
    { genome: "g3", species: "", values: [10, 70] }] };

  const mpa = toMetaphlan(table, { lineageOf: (g) => lin[g], speciesOf: (g) => sp[g] });
  const row = (name) => mpa.split("\n").find((l) => l.startsWith(`${name}\t`))?.split("\t").slice(1).map(Number);
  // THE property of a MetaPhlAn profile: each clade holds the total of what is
  // under it. A file whose top row is 0 because nothing was assigned exactly
  // there is not one, and every tool that reads these relies on it.
  check("MetaPhlAn abundances are cumulative up the lineage",
    JSON.stringify(row("k__Bacteria")) === JSON.stringify([100, 100]),
    JSON.stringify(row("k__Bacteria")));
  check("...and the phyla under it sum back to the same total",
    Math.abs(row("k__Bacteria|p__Bacillota")[0] + row("k__Bacteria|p__Bacteroidota")[0] - 100) < 1e-6);
  // GTDB says d__, MetaPhlAn says k__; emitting d__ drops the top level in
  // every reader that only knows the latter.
  check("...and the domain is written k__, the way MetaPhlAn writes it",
    /^k__Bacteria\t/m.test(mpa) && !/^d__/m.test(mpa));
  check("...and spaces in a name become underscores, as the format requires",
    mpa.includes("s__Lactobacillus_iners"));
  // g3 has a phylum but no species: it must still contribute at the levels it
  // does have, or the phylum totals stop adding up.
  check("...and a genome with no species still counts at the ranks it has",
    JSON.stringify(row("k__Bacteria|p__Bacteroidota")) === JSON.stringify([10, 70]));

  const biom = JSON.parse(toBiom(table, { lineageOf: (g) => lin[g], speciesOf: (g) => sp[g] }));
  check("BIOM is 1.0 with the right shape", biom.format === "1.0.0"
    && JSON.stringify(biom.shape) === JSON.stringify([3, 2])
    && biom.data.length === 3 && biom.data[0].length === 2);
  // Seven ranks, always, empty where GTDB places nothing — readers index into
  // this array by position.
  check("...and every row carries all seven rank slots",
    biom.rows.every((r) => r.metadata.taxonomy.length === 7),
    JSON.stringify(biom.rows[2].metadata.taxonomy));

  // The sylph export must be sylph's own columns, not a reconstruction.
  const raw = "Sample_file\tGenome_file\tTaxonomic_abundance\tEff_lambda\n" +
    "/tmp/blob\tMGYG1.fna\t12.5\tHIGH";
  const st = toSylphTsv([{ sampleName: "ERR1", tsv: raw }, { sampleName: "empty" }]);
  check("the sylph export keeps every column sylph wrote",
    st.split("\n")[0].split("\t").includes("Eff_lambda"));
  check("...and names the sample rather than a path that points nowhere",
    st.split("\n")[1].startsWith("ERR1\t"), st.split("\n")[1]);

  // A session must come back exactly, or it is worse than not offering one.
  const state = {
    ref: { label: "Human gut", key: "human-gut" }, sampleOrder: ["S1", "S2"],
    matrix: { "MGYG1.fna": { species: "A", S1: 12.5, S2: 0 } },
    refBySample: new Map([["S1", { label: "Human gut" }]]), rank: "g",
  };
  const back = fromSession(toSession(state));
  check("a session round-trips the matrix, the order and the rank",
    JSON.stringify(back.matrix) === JSON.stringify(state.matrix)
    && JSON.stringify(back.sampleOrder) === JSON.stringify(state.sampleOrder)
    && back.rank === "g" && back.refBySample.get("S1").label === "Human gut");
  // Every shape here is a plain object, so a wrong file does not fail on its
  // own — it would restore an empty matrix and look like an empty session.
  let refusals = 0;
  for (const bad of ['not json', '{"app":"other"}', '{"app":"PeekMicrobiome","format":1,"samples":[]}',
                     '{"app":"PeekMicrobiome","format":99,"samples":[],"matrix":{}}']) {
    try { fromSession(bad); } catch { refusals++; }
  }
  check("...and a file that is not one is refused, not silently restored", refusals === 4, `${refusals}/4`);
}

console.log("== the figures compute what they claim to ==");
{
  const { alphaDiversity, distanceMatrix, pcoa, compositionSvg, alphaSvg, pcoaSvg, pcoaLayout,
    pieSvg, sampleFacts, eigenvaluesSym, colourAt, NAMED_COLOURS } =
    await import("./figures.js");
  // The palette itself is private; its size is what the ceiling is built from.
  const PALETTE_SIZE = NAMED_COLOURS / 3;

  // Shannon has known values: n equally-abundant taxa give exactly ln(n), and
  // e^H gives n back. Anything else and the index is not the index.
  let shannonOk = true;
  for (const n of [1, 2, 4, 10, 50]) {
    const t = { samples: ["S"], rows: Array.from({ length: n }, (_, i) => ({ species: `t${i}`, values: [100 / n] })) };
    const a = alphaDiversity(t)[0];
    if (Math.abs(a.shannon - Math.log(n)) > 1e-9) shannonOk = false;
    if (Math.abs(a.effective - n) > 1e-6) shannonOk = false;
    if (a.richness !== n) shannonOk = false;
  }
  check("Shannon on n equal taxa is exactly ln(n), and e^H gives n back", shannonOk);
  // Absent is not present-at-zero: a taxon with 0 must not count towards
  // richness, or every sample would report the whole catalogue.
  check("...and a zero-abundance taxon counts towards neither index",
    alphaDiversity({ samples: ["S"], rows: [{ species: "a", values: [100] }, { species: "b", values: [0] }] })[0]
      .richness === 1);

  // PCoA must separate groups that ARE separate, and give the same plot twice —
  // a random start would flip signs between redraws and read as points moving.
  const g = (k) => [k === 0 ? 90 : 1, k === 1 ? 90 : 1, k === 2 ? 90 : 1];
  const labels = [0, 0, 1, 1, 2, 2];
  const t3 = {
    samples: labels.map((k, i) => `S${i}`),
    rows: [0, 1, 2].map((k) => ({ species: `t${k}`, values: labels.map((l) => g(l)[k]) })),
  };
  const D = distanceMatrix(t3);
  check("Bray-Curtis is 0 on the diagonal and symmetric",
    D.every((row, i) => row[i] === 0 && row.every((v, j) => Math.abs(v - D[j][i]) < 1e-12)));
  const p1 = pcoa(D), p2 = pcoa(D);
  const dist = (p, a, b) => Math.hypot(p.points[a].x - p.points[b].x, p.points[a].y - p.points[b].y);
  check("PCoA puts identical samples together and different ones apart",
    dist(p1, 0, 1) < 1e-6 && dist(p1, 0, 2) > 0.5,
    `within ${dist(p1, 0, 1).toFixed(4)}, between ${dist(p1, 0, 2).toFixed(3)}`);
  check("...and is deterministic, so a redraw does not move the points",
    JSON.stringify(p1.points) === JSON.stringify(p2.points));
  // Bray-Curtis is not Euclidean, so negative eigenvalues are normal — the axis
  // label must not present a fraction of a total that includes them.
  check("...and the explained fractions are in [0,1]",
    p1.explained.every((f) => f >= 0 && f <= 1), JSON.stringify(p1.explained));

  // The SVGs must be well-formed and must escape what comes from the data: a
  // species name with an ampersand in it would otherwise break the figure.
  const nasty = {
    samples: ["S<1>", "S&2", "S3"],
    rows: [{ species: 'Bacteroides "sp" & <co>', genome: "g", values: [10, 20, 30] },
           { species: "t2", genome: "g2", values: [5, 5, 5] },
           { species: "t3", genome: "g3", values: [1, 2, 3] }],
    ref: null,
  };
  for (const [name, fn] of [["composition", compositionSvg], ["alpha", alphaSvg], ["pcoa", pcoaSvg],
                            ["pie", (t) => pieSvg(t, 0)]]) {
    const svg = fn(nasty);
    check(`${name} produces a complete SVG`, svg.startsWith("<svg") && svg.endsWith("</svg>"));
    // Species names and sample names go straight into the markup, so a name with
    // an ampersand or an angle bracket in it would produce a broken figure. Take
    // the text content of every <text> and <title> and look for a raw one.
    const contents = svg.match(/<(?:text|title)[^>]*>[^<]*/g) ?? [];
    check(`...and escapes the data it puts in there`,
      contents.length > 0 && !contents.some((c) => /&(?!amp;|lt;|gt;|quot;|#)/.test(c)),
      contents.find((c) => /&(?!amp;|lt;|gt;|quot;|#)/.test(c)) ?? `${contents.length} text nodes`);
  }

  // Every point must carry its own name: it is the only thing that lets the page
  // answer "which sample is this" on hover, and the only handle the click that
  // opens a composition has. A plot drawn without them is a plot nothing can be
  // asked of.
  const marked = pcoaSvg(nasty).match(/data-sample="([^"]*)"/g) ?? [];
  check("every PCoA point carries the sample it stands for",
    marked.length === nasty.samples.length &&
    marked.some((m) => m.includes("S&amp;2")),
    `${marked.length} of ${nasty.samples.length}: ${marked.join(" ")}`);

  // The figures are drawn to the width the page gives them — the card is half
  // the row, and a figure that ignored that either left the card half empty or
  // was scaled down by the browser with its type. So: whatever width is asked
  // for is the width declared, and nothing is drawn outside it.
  {
    const wide = {
      samples: Array.from({ length: 6 }, (_, i) => `SAMPLE_${i}`),
      rows: Array.from({ length: 14 }, (_, i) => ({
        species: `Genus species_${i} with a long name`, genome: `g${i}`,
        values: Array.from({ length: 6 }, (_, j) => (i + j) % 7),
      })),
    };
    let fits = true, why = "";
    for (const [name, fn] of [["composition", compositionSvg], ["alpha", alphaSvg], ["pcoa", pcoaSvg]]) {
      for (const width of [420, 562, 900]) {
        const svg = fn(wide, { width });
        if (!svg.includes(`width="${width}"`)) { fits = false; why = `${name} @${width} declares another width`; }
        for (const m of svg.matchAll(/<rect x="([\d.]+)" y="[\d.-]+" width="([\d.]+)"/g)) {
          if (Number(m[1]) + Number(m[2]) > width + 0.5) {
            fits = false; why = `${name} @${width}: a rect ends at ${Number(m[1]) + Number(m[2])}`;
          }
        }
      }
    }
    check("every figure is drawn to the width it is given, and stays inside it", fits, why);
  }

  // Every figure has to be askable, not only the ordination: a bar of the
  // composition and a row of the diversity chart are samples too, and the panel
  // is opened by whatever carries data-sample.
  for (const [name, fn] of [["composition", compositionSvg], ["alpha", alphaSvg]]) {
    const svg = fn(nasty);
    const marks = svg.match(/class="sample-row" data-sample="([^"]*)"/g) ?? [];
    check(`${name} makes every sample a mark that can be opened`,
      marks.length === nasty.samples.length && (svg.match(/<\/g>/g) ?? []).length === marks.length,
      `${marks.length} marks for ${nasty.samples.length} samples`);
  }

  // What fills the panel beside the pie. The distances are the ones the
  // ordination is a projection OF, so they must be the real Bray-Curtis over
  // every row — and they must not include the sample itself, which would always
  // be its own nearest neighbour at 0.
  const facts = {
    samples: ["A", "B", "C", "D"],
    rows: [
      { species: "p", values: [90, 90, 10, 50] },
      { species: "q", values: [10, 10, 90, 50] },
    ],
  };
  const fA = sampleFacts(facts, "A");
  check("sampleFacts finds the nearest samples, itself excluded and sorted",
    fA.nearest.length === 3 && fA.nearest[0].sample === "B" && fA.nearest[0].distance === 0 &&
    fA.nearest.every((n, i, a) => i === 0 || a[i - 1].distance <= n.distance) &&
    !fA.nearest.some((n) => n.sample === "A"),
    JSON.stringify(fA.nearest));
  check("...and agrees with the distance matrix the ordination is drawn from",
    fA.nearest.every((n) => Math.abs(n.distance -
      distanceMatrix(facts)[0][facts.samples.indexOf(n.sample)]) < 1e-12));
  // A and B are identical, so they cannot be ranked 1st and 2nd.
  check("...and ranks by diversity with ties sharing a rank",
    sampleFacts(facts, "A").rank === sampleFacts(facts, "B").rank &&
    sampleFacts(facts, "D").rank === 1 && fA.of === 4,
    `A=${sampleFacts(facts, "A").rank} B=${sampleFacts(facts, "B").rank} D=${sampleFacts(facts, "D").rank}`);
  check("...and an unknown sample gives null rather than a table of zeros",
    sampleFacts(facts, "nobody") === null);

  // The list can be sorted by either distance, and they are not the same order:
  // Bray-Curtis asks what share is not shared, Euclidean is dominated by the
  // most abundant taxa. Both over every row; neither comes from the ordination.
  const twoWays = {
    samples: ["me", "same-shape", "one-big-difference"],
    rows: [
      { species: "dominant", values: [50, 25, 80] },
      { species: "rest", values: [50, 75, 20] },
    ],
  };
  const byBray = sampleFacts(twoWays, "me", { metric: "bray" }).nearest;
  const byEuclid = sampleFacts(twoWays, "me", { metric: "euclid" }).nearest;
  check("the neighbour list is sorted by the distance asked for",
    byBray.every((n, i, a) => i === 0 || a[i - 1].distance <= n.distance) &&
    byEuclid.every((n, i, a) => i === 0 || a[i - 1].distance <= n.distance));
  // 25/75 against 50/50 is 25 points of Bray-Curtis and sqrt(2)*25 of Euclidean;
  // 80/20 is 30 and sqrt(2)*30. Same order here, different numbers — the check
  // that matters is that the numbers are the metric asked for, not that they
  // disagree.
  check("...and Bray-Curtis is bounded by 1 where Euclidean is not",
    byBray.every((n) => n.distance <= 1) && byEuclid.some((n) => n.distance > 1),
    `${byBray[0].distance.toFixed(3)} vs ${byEuclid[0].distance.toFixed(2)}`);
  check("...and an unknown metric falls back to Bray-Curtis rather than to nothing",
    JSON.stringify(sampleFacts(twoWays, "me", { metric: "nope" }).nearest) ===
    JSON.stringify(byBray));

  // What the ordination's axis labels claim. Summed over the two axes that were
  // computed, the two fractions added to 100% whatever the data — the plot said
  // it was showing all of the variation every time. Eight points at the corners
  // of a cube are the case that catches both halves of it: three equal
  // eigenvalues, so two axes can only ever show two thirds of it, and a repeated
  // eigenvalue is also what used to collapse PCo2 to zero.
  const at = (P) => P.map((a) => P.map((b) => Math.hypot(...a.map((v, i) => v - b[i]))));
  const cube = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1],
                [1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const pc = pcoa(at(cube));
  check("a plot of a three-dimensional cube says it is showing two thirds of it",
    Math.abs(pc.explained[0] - 1 / 3) < 0.01 && Math.abs(pc.explained[1] - 1 / 3) < 0.01,
    pc.explained.map((x) => (x * 100).toFixed(1)).join(" / "));
  check("...and neither axis of it is flat",
    pc.points.filter((p) => Math.abs(p.y) > 1e-9).length === cube.length);
  // A configuration that IS flat is the other side of the same claim.
  const flat = [[0, 0], [1, 0], [0, 1], [2, 2], [3, 1], [1, 3]];
  const pf = pcoa(at(flat));
  check("...while a plot of a flat one says it is showing all of it",
    Math.abs(pf.explained[0] + pf.explained[1] - 1) < 1e-6,
    pf.explained.map((x) => (x * 100).toFixed(1)).join(" + "));

  // The spectrum the fractions are taken over, checked against a matrix whose
  // eigenvalues are known by hand: diag(3,1) rotated 45 degrees.
  const known = eigenvaluesSym([[2, 1], [1, 2]]);
  check("eigenvaluesSym recovers eigenvalues that are known by hand",
    Math.abs(known[0] - 3) < 1e-9 && Math.abs(known[1] - 1) < 1e-9, JSON.stringify(known));

  // The pie is one sample out of the table, so the wrong column is the failure
  // that would look right — every number plausible, none of them this sample's.
  const three = {
    samples: ["A", "B"],
    rows: [{ species: "x", values: [75, 1] }, { species: "y", values: [25, 99] }],
  };
  const pieA = pieSvg(three, "A"), pieB = pieSvg(three, 1);
  check("the pie reads the column of the sample it was asked for, by name or index",
    /75\.0%/.test(pieA) && /25\.0%/.test(pieA) && /99\.0%/.test(pieB) && !/75\.0%/.test(pieB));
  check("...and an unknown sample gives nothing rather than an empty figure",
    pieSvg(three, "nobody") === "" && pieSvg(three, 7) === "");

  // A single detected taxon is a real case — low depth, the wrong catalogue —
  // and an arc whose two ends are the same point draws nothing at all, so the
  // whole figure would come out blank at exactly 100%.
  const solo = pieSvg({ samples: ["A"], rows: [{ species: "only", values: [100] }] }, "A");
  check("a sample made of one taxon draws a disc, not an empty arc",
    /<circle/.test(solo) && !/<path/.test(solo) && /100\.0%/.test(solo));
  check("...and a sample with nothing detected says so",
    /No taxon detected/.test(pieSvg({ samples: ["A"], rows: [{ species: "x", values: [0] }] }, "A")));

  // Past the top N the rest is not dropped: a pie whose slices sum to 60% with
  // no explanation reads as missing data rather than as a legend cut.
  const many = {
    samples: ["A"],
    rows: Array.from({ length: 30 }, (_, i) => ({ species: `t${i}`, values: [30 - i] })),
  };
  const wide = pieSvg(many, "A", { topN: 5 });
  const pcts = [...wide.matchAll(/>(\d+\.\d)%</g)].map((m) => Number(m[1]));
  // Each slice is written twice — once in the wedge, once in the legend — and
  // wedges under 6% carry no label, so the legend column is the one that must
  // account for all of it.
  const legend = pcts.slice(-6);
  check("the taxa past the top N are kept as one named slice, and the shares sum to 100",
    /other taxa \(25\)/.test(wide) && Math.abs(legend.reduce((a, v) => a + v, 0) - 100) < 0.3,
    `${legend.join(" + ")} = ${legend.reduce((a, v) => a + v, 0).toFixed(1)}`);

  // The pie goes in the panel beside the plot, and that panel is a fixed card
  // like the figure's own. Drawn at 470 x whatever it left a strip of empty card
  // down one side of a 563 px panel and pushed the neighbour list out of the
  // bottom of it. Given a box, it fills the box.
  {
    const discOf = (svg) => Number(/A ([\d.]+) [\d.]+ 0 /.exec(svg)?.[1] ?? 0);
    const box = pieSvg(many, "A", { width: 563, height: 300 });
    check("the pie is drawn to the box it is given",
      box.includes('width="563"') && box.includes('height="300"') &&
      box.includes('viewBox="0 0 563 300"'));
    check("...with a disc sized to that box rather than to a fixed 84 px",
      discOf(box) > 84 && discOf(pieSvg(many, "A")) === 84,
      `${discOf(box)} in the box, ${discOf(pieSvg(many, "A"))} by default`);
    // Nothing may be drawn below the box it was given: the legend rows and the
    // disc share one height, and a legend that overran it would be clipped by
    // the viewBox with no sign that anything was missing.
    const ys = [...box.matchAll(/ y="([\d.]+)"/g)].map((m) => Number(m[1]));
    check("...and nothing is drawn outside it",
      Math.max(...ys) <= 300 && discOf(box) * 2 + 44 <= 300,
      `lowest y ${Math.max(...ys)}, disc ${discOf(box) * 2 + 44}`);

    // A box too small for what was asked names fewer taxa. Squeezing ten rows
    // into eight rows of space would overlap them; dropping the last two into
    // "other taxa" is the honest way to lose them, and the slice that says so is
    // already there.
    const short = pieSvg(many, "A", { width: 320, height: 170 });
    const rowsIn = (svg) => (svg.match(/other taxa \((\d+)\)/) ?? [])[1];
    check("a box too small for the count names fewer instead of overlapping its legend",
      Number(rowsIn(short)) > Number(rowsIn(box)) &&
      Math.max(...[...short.matchAll(/ y="([\d.]+)"/g)].map((m) => Number(m[1]))) <= 170,
      `${rowsIn(short)} others at 320x170, ${rowsIn(box)} at 563x300`);

    // Labels are clipped to the room there is. Clipped to a fixed 28 characters
    // they were cut mid-word in a panel wide enough for the whole name.
    const longName = {
      samples: ["A"],
      rows: [{ species: "Faecalibacterium prausnitzii_ABCDEFGHIJ", values: [60] },
             { species: "Roseburia intestinalis_ABCDEFGHIJKLMNO", values: [40] }],
    };
    const cut = (svg) => (svg.match(/>([^<>]*…)</g) ?? []).length;
    check("legend labels are clipped to the room there is, not to a fixed count",
      cut(pieSvg(longName, "A", { width: 380, height: 300 })) > 0 &&
      cut(pieSvg(longName, "A", { width: 900, height: 300 })) === 0,
      `${cut(pieSvg(longName, "A", { width: 380, height: 300 }))} clipped at 380 px, ` +
      `${cut(pieSvg(longName, "A", { width: 900, height: 300 }))} at 900 px`);
  }

  // ---- how many taxa are named ------------------------------------------------
  //
  // The page carries a slider for it now, so both figures have to take the
  // number — and "the rest" must never quietly become "the missing": whatever is
  // not named is kept as one grey slice, at every setting.
  {
    const swatches = (svg) => (svg.match(/width="10" height="10"/g) ?? []).length;
    const deep = {
      samples: ["A", "B", "C"],
      rows: Array.from({ length: 30 }, (_, i) => ({
        species: `Genus species_${i}`, genome: `g${i}`,
        values: [30 - i, 20 + (i % 7), (i * 3) % 11],
      })),
    };
    let bars = true, why = "";
    for (const n of [3, 10, 20]) {
      const svg = compositionSvg(deep, { topN: n, width: 900, height: 520 });
      // One legend swatch per named taxon, plus the one for "other taxa".
      if (swatches(svg) !== n + 1 || !svg.includes("other taxa")) {
        bars = false; why = `${swatches(svg)} swatches and ${svg.includes("other taxa") ? "" : "no "}other at topN=${n}`;
      }
    }
    check("the composition names as many taxa as it is asked for, and keeps the rest", bars, why);

    // Twelve hues, and the slider goes past them: the thirteenth taxon must not
    // come back in the same teal as the first, in the same figure, with a legend
    // that then says two different things about one colour.
    const wheelOfColours = Array.from({ length: NAMED_COLOURS }, (_, i) => colourAt(i));
    check("every named taxon has a colour of its own, past the twelve hues too",
      new Set(wheelOfColours).size === NAMED_COLOURS &&
      wheelOfColours.every((c) => /^#[0-9a-f]{6}$/.test(c)),
      `${new Set(wheelOfColours).size} distinct of ${NAMED_COLOURS}`);
    // And that is a ceiling, not a slope: the mix toward white is capped, so the
    // cycle after the last one repeats it. The slider is what must stay below.
    check("...and the count says where they run out",
      colourAt(NAMED_COLOURS) === colourAt(NAMED_COLOURS - PALETTE_SIZE),
      `${colourAt(NAMED_COLOURS)} vs ${colourAt(NAMED_COLOURS - PALETTE_SIZE)}`);

    // The control on the page is the one that can ask for too many, so it is the
    // one checked against the figures it drives.
    const page = readFileSync(here + "index.html", "utf8");
    const slider = /<input[^>]*id="figTopNRange"[^>]*>/.exec(page)?.[0] ?? "";
    const attr = (k) => Number(new RegExp(`${k}="(\\d+)"`).exec(slider)?.[1]);
    check("the taxa slider cannot ask for more taxa than there are colours",
      slider !== "" && attr("max") >= 10 && attr("max") <= NAMED_COLOURS,
      `max=${attr("max")}, colours=${NAMED_COLOURS}`);
    check("...and it starts at ten, where both figures used to be fixed",
      attr("value") === 10 && attr("min") >= 1 && attr("min") < 10,
      `min=${attr("min")} value=${attr("value")}`);
    check("...and the figures take their colours from there",
      compositionSvg(deep, { topN: 20, width: 900, height: 520 }).includes(colourAt(12)) &&
      !compositionSvg(deep, { topN: 10, width: 900, height: 520 }).includes(colourAt(12)));

    // The pie is the one drawn into a panel rather than into the whole card, so
    // it is the one that has to work to honour the slider. One column of rows
    // ran out at about thirteen names in the panel beside the plot, and every
    // setting above that drew the same figure — a control that stops doing
    // anything reads as a panel that is not being redrawn at all.
    const panel = (n) => pieSvg(many, "A", { topN: n, width: 563, height: 284 });
    const missed = [3, 10, 13, 16, 20, 30]
      .map((n) => [n, Number((panel(n).match(/top (\d+) shown/) ?? [])[1])])
      .filter(([n, shown]) => shown !== n);
    check("the pie names every taxon the slider asks for, to its maximum",
      missed.length === 0, missed.map(([n, s]) => `${n}→${s}`).join(" "));
    // By flowing the legend into a second column, not by overlapping rows: the
    // whole figure still has to stay inside the box it was given.
    const wideSet = panel(30);
    const columns = new Set([...wideSet.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="\2"/g)]
      .map((m) => m[1]));
    check("...by flowing its legend into columns, and staying inside the box",
      columns.size === 2 &&
      Math.max(...[...wideSet.matchAll(/ y="([\d.]+)"/g)].map((m) => Number(m[1]))) <= 284,
      `${columns.size} legend column(s)`);

    // Where even that is not enough, it names fewer and says how many.
    const squat = pieSvg(many, "A", { topN: 15, width: 320, height: 170 });
    check("...and where neither rows nor columns are enough, it says how many it showed",
      /top 7 shown/.test(squat) && /other taxa \(23\)/.test(squat) &&
      Math.max(...[...squat.matchAll(/ y="([\d.]+)"/g)].map((m) => Number(m[1]))) <= 170,
      (squat.match(/top \d+ shown/) ?? [""])[0]);
  }

  // ---- the ordination, zoomed -------------------------------------------------
  //
  // Eighty-five samples in a card are a pile in the middle, and the pile is the
  // interesting part. Zooming is a window in the ordination's own units, and the
  // page has to be able to turn a pointer back into those units — so the window
  // that was actually drawn is published on the figure itself.
  {
    const spread = {
      samples: Array.from({ length: 30 }, (_, i) => `SAMPLE_${i}`),
      rows: Array.from({ length: 24 }, (_, i) => ({
        species: `t${i}`, genome: `g${i}`,
        // Every sample a different profile, so the points do not land on top of
        // each other and the window really does exclude some of them.
        values: Array.from({ length: 30 }, (_, j) => ((i * 7 + j * 13) % 23) + (j % 5)),
      })),
    };
    const layout = pcoaLayout(spread);
    const plotOf = (svg) => {
      const raw = /data-plot="([^"]+)"/.exec(svg)?.[1];
      if (!raw) return null;
      const [x0, x1, y0, y1, L, R, T, B] = raw.split(",").map(Number);
      return { x0, x1, y0, y1, L, R, T, B };
    };
    const marks = (svg) => (svg.match(/data-sample="/g) ?? []).length;

    const full = pcoaSvg(spread, { layout });
    const p0 = plotOf(full);
    check("the ordination publishes the window it drew, and the box it drew it in",
      p0 !== null && p0.x1 > p0.x0 && p0.y1 > p0.y0 && p0.R > p0.L && p0.B > p0.T,
      JSON.stringify(p0));
    check("...and unzoomed that window holds every sample",
      marks(full) === spread.samples.length, `${marks(full)} of ${spread.samples.length}`);

    // Twice the zoom is half the window, in both directions.
    const mid = { x: (p0.x0 + p0.x1) / 2, y: (p0.y0 + p0.y1) / 2 };
    const p2 = plotOf(pcoaSvg(spread, { layout, zoom: { ...mid, k: 2 } }));
    check("zooming by k narrows the window to a kth of the extent",
      Math.abs((p2.x1 - p2.x0) / (p0.x1 - p0.x0) - 0.5) < 1e-9 &&
      Math.abs((p2.y1 - p2.y0) / (p0.y1 - p0.y0) - 0.5) < 1e-9,
      `${((p2.x1 - p2.x0) / (p0.x1 - p0.x0)).toFixed(4)} x ` +
      `${((p2.y1 - p2.y0) / (p0.y1 - p0.y0)).toFixed(4)}`);

    // A window dragged past the edge of the data is a blank card with axes on
    // it, so the centre is clamped to keep the window inside the full extent.
    const far = plotOf(pcoaSvg(spread, { layout, zoom: { x: 1e6, y: -1e6, k: 3 } }));
    check("...and the window cannot be panned off the data",
      far.x0 >= p0.x0 - 1e-9 && far.x1 <= p0.x1 + 1e-9 &&
      far.y0 >= p0.y0 - 1e-9 && far.y1 <= p0.y1 + 1e-9,
      `[${far.x0}, ${far.x1}] inside [${p0.x0}, ${p0.x1}]`);

    // The samples drawn are exactly the samples in the window — no more, so the
    // plot does not spill points over its own axes, and no fewer, so nothing in
    // view is silently missing.
    const near = layout.points[0];
    const zoomed = pcoaSvg(spread, { layout, zoom: { x: near.x, y: near.y, k: 4 } });
    const win = plotOf(zoomed);
    const inWindow = layout.points.filter((p) =>
      p.x >= win.x0 && p.x <= win.x1 && p.y >= win.y0 && p.y <= win.y1).length;
    check("a zoomed plot draws the samples in the window and only those",
      marks(zoomed) === inWindow && inWindow < spread.samples.length && inWindow > 0,
      `${marks(zoomed)} drawn, ${inWindow} in the window, ${spread.samples.length} in all`);

    // The payoff for zooming: thirty points are anonymous dots, and the handful
    // left in a narrow window have room for their names.
    // Written beside the marker, not in the <title> every point carries: the
    // title is a native tooltip and thirty of them are thirty things nobody can
    // see at once.
    const named = (svg) => (svg.match(/<text[^>]*>SAMPLE_\d+<\/text>/g) ?? []).length;
    check("...and names them once few enough are left to have room",
      named(full) === 0 && inWindow <= 20 && named(zoomed) === inWindow,
      `${named(full)} named of 30, ${named(zoomed)} named of ${inWindow} in the window`);
    check("...and says on the figure itself that it is a corner of the ordination",
      /zoom ×4\.0 — \d+ of 30 samples/.test(zoomed) && !/zoom ×/.test(full));

    // The eigenproblem is solved once and the window is moved many times: a
    // dragged plot redraws by the frame, and each frame must not be an O(n^3)
    // Jacobi pass. So the drawing must take the layout it is handed.
    check("a supplied layout is the one drawn, so panning never re-solves it",
      pcoaSvg(spread, { layout }) === pcoaSvg(spread) &&
      plotOf(pcoaSvg(spread, {
        layout: { points: layout.points.map((p) => ({ x: p.x * 3, y: p.y })), explained: [0.5, 0.25] },
      })).x1 > p0.x1 * 2.5);
  }
}

console.log("== enterotypes: a split, and the names that carry it ==");
{
  const { enterotypeSplit, enterotypeSvg, ENTEROTYPE_POLES, ENTEROTYPE_GAP,
    ENTEROTYPE_MIN_MARKERS } = await import("./figures.js");
  const { fromSession } = await import("./exports.js");

  // The demo, aggregated to genus the way matrixToTable does it at rank "g".
  const lineage = JSON.parse(readFileSync(here + "db/lineage/human-gut.json", "utf8"));
  const GEN = lineage.ranks.g, gi = lineage.rankKeys.indexOf("g");
  const genusOfGenome = new Map(Object.entries(lineage.taxa).map(([g, t]) => [g, GEN[t[gi]]]));
  const st = fromSession(readFileSync(here + "demo/gut-demo.session.json", "utf8"));
  const by = new Map();
  for (const [genome, m] of Object.entries(st.matrix)) {
    const name = genusOfGenome.get(genome) ?? "unclassified";
    let e = by.get(name);
    if (!e) { e = { species: name, values: st.sampleOrder.map(() => 0) }; by.set(name, e); }
    st.sampleOrder.forEach((s, i) => { e.values[i] += Number(m[s] ?? 0); });
  }
  const table = { samples: st.sampleOrder, rows: [...by.values()] };
  const split = enterotypeSplit(table);
  const of = (s) => split.find((r) => r.sample === s);

  check("every sample is divided between the three poles, and the shares add to 100",
    split.length === 15 &&
    split.every((r) => Math.abs(r.shares.reduce((a, v) => a + v, 0) - 100) < 1e-9));

  // THE MEASUREMENT THIS FEATURE EXISTS FOR. The 2011 marker names applied to a
  // GTDB catalogue miss the genera that were split out of them, and it is not
  // academic: subject MQB_086 inverts on Phocaeicola alone.
  const b2011 = (s) => {
    const row = table.rows.find((r) => r.species === "Bacteroides");
    return row.values[table.samples.indexOf(s)];
  };
  const p2011 = (s) => {
    const row = table.rows.find((r) => r.species === "Prevotella");
    return row.values[table.samples.indexOf(s)];
  };
  const bothPoles = (s) => {
    const r = of(s);
    return { B: r.sums[0], P: r.sums[1] };
  };
  check("a rule written from the 2011 names inverts a real sample; the GTDB names do not",
    ["ERR14098625", "ERR14098650"].every((s) => {
      const { B, P } = bothPoles(s);
      return b2011(s) < p2011(s) && B > P;       // 2011 says Prevotella, GTDB says Bacteroides
    }),
    ["ERR14098625", "ERR14098650"].map((s) =>
      `${s}: 2011 ${b2011(s).toFixed(2)}v${p2011(s).toFixed(2)}, GTDB ` +
      `${bothPoles(s).B.toFixed(2)}v${bothPoles(s).P.toFixed(2)}`).join(" | "));
  // Bare `Ruminococcus` is not merely zero here — it has no row at all, its
  // genomes having been detected in none of the fifteen samples. A rule looking
  // for that one name would find nothing and could not tell that apart from a
  // gut with no Ruminococcus in it.
  const bare = table.rows.find((r) => r.species === "Ruminococcus");
  check("...and bare Ruminococcus carries nothing, so the suffixed genera are the pole",
    (bare === undefined || bare.values.every((v) => v === 0)) &&
    split.every((r) => r.sums[2] > 0),
    bare === undefined ? "no bare Ruminococcus row at all" : "present but all zero");

  // A name is only printed with more daylight than the page's own noise. The
  // example ships the measurement: seven samples sequenced twice.
  const subject = new Map(readFileSync(here + "demo/gut-demo.groups.csv", "utf8")
    .trim().split(/\r?\n/).slice(1).map((l) => l.split(",").map((c) => c.trim())));
  const said = (r) => (!r.call ? "none"
    : r.call === "between" ? `between ${r.pair.join("+")}` : ENTEROTYPE_POLES[r.lead].key);
  const pairs = new Map();
  for (const r of split) {
    const k = subject.get(r.sample);
    if (!pairs.has(k)) pairs.set(k, []);
    pairs.get(k).push(said(r));
  }
  const disagree = [...pairs].filter(([, v]) => v.length === 2 && v[0] !== v[1]);
  check("what the page says never changes between two sequencings of one sample",
    disagree.length === 0,
    disagree.map(([k, v]) => `${k}: ${v.join(" vs ")}`).join(" | "));
  // And that is not free: the same rule with no gap at all does flip one.
  const naive = [...pairs].filter(([, v]) => v.length === 2);
  check("...which a bare 'whichever pole leads' rule does not manage",
    split.filter((r) => r.call === "between").length > 0 &&
    naive.some(([k]) => {
      const two = split.filter((r) => subject.get(r.sample) === k);
      return two[0].lead !== two[1].lead;
    }),
    "MQB_032 leads on different poles in its two libraries");

  check("the gap that licenses a name is the measured one, not a round number",
    ENTEROTYPE_GAP > 5 && ENTEROTYPE_GAP < 15 &&
    split.filter((r) => r.call === "between").every((r) => r.gap < ENTEROTYPE_GAP) &&
    split.filter((r) => r.call && r.call !== "between").every((r) => r.gap >= ENTEROTYPE_GAP));
  // The pair is named in pole order, so one finding has one wording.
  check("...and a sample between two poles names them in a fixed order",
    split.filter((r) => r.call === "between")
      .every((r) => r.pair[0] < r.pair[1]));

  // Exact names. /^Bacteroides/ takes Bacteroides_F, which is a LACHNOSPIRACEAE.
  const trap = {
    samples: ["X"],
    rows: [{ species: "Bacteroides", values: [10] }, { species: "Bacteroides_F", values: [30] },
      { species: "Parabacteroides", values: [40] }, { species: "Phocaeicola", values: [5] },
      { species: "Prevotella", values: [8] }, { species: "Faecalibacterium", values: [4] }],
  };
  const t = enterotypeSplit(trap)[0];
  check("the poles match genus names exactly — no prefix, no substring",
    t.sums[0] === 15 && t.sums[1] === 8 && t.sums[2] === 4,
    `B ${t.sums[0]} (must be 15, not 45 with Bacteroides_F nor 85 with Parabacteroides)`);

  // Not enough marker abundance is not a position.
  const thin = enterotypeSplit({
    samples: ["Y"], rows: [{ species: "Bacteroides", values: [1] }, { species: "Blautia", values: [99] }],
  })[0];
  check("a sample with almost nothing on these axes gets no name and no point",
    thin.call === "" && thin.markers < ENTEROTYPE_MIN_MARKERS &&
    !enterotypeSvg({ samples: ["Y"], rows: [{ species: "Bacteroides", values: [1] }] })
      .includes('data-sample="Y"'));

  const svg = enterotypeSvg(table, { width: 562, height: 586 });
  check("the triangle is drawn to its box, names its three corners, and carries every point",
    svg.includes('width="562"') && svg.includes('height="586"') &&
    ENTEROTYPE_POLES.every((p) => svg.includes(`>${p.label}</text>`)) &&
    (svg.match(/data-sample=/g) ?? []).length === 15);
  // Corner labels hung off the corners ran out of the viewBox: the left one drew
  // as "acteroides" in the browser. Everything stays inside the box.
  const xs = [...svg.matchAll(/ x="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
  const ys = [...svg.matchAll(/ y="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
  check("...and nothing is anchored outside it",
    Math.min(...xs) >= 0 && Math.max(...xs) <= 562 &&
    Math.min(...ys) >= 0 && Math.max(...ys) <= 586,
    `x ${Math.min(...xs)}..${Math.max(...xs)}, y ${Math.min(...ys)}..${Math.max(...ys)}`);
}

console.log("== what the archive said about a sample ==");
{
  // The ENA answers with more than file URLs, and the page was throwing all of
  // it away. Every rule below comes from a census of 1,112,796 metagenomic runs
  // over 31,523 studies: these are the shapes that actually arrive, not the
  // shapes the schema allows.
  const { isMissing, usableMeta, metaLines, runFacts, fieldCoverage } =
    await import("./meta.js");
  const { ENA_FIELDS, ENA_META_FIELDS, parseRunRow } = await import("./ena.js");

  // A field name the portal does not know answers HTTP 400 for the WHOLE
  // request — fastq_ftp included — so a typo here does not degrade the page, it
  // stops it profiling anything. The live bench checks the names against the
  // API; this checks the shape, which is what a typo usually breaks.
  const names = ENA_FIELDS.split(",");
  check("the ENA field list is a clean comma list, no spaces, no duplicates",
    names.every((n) => /^[a-z_]+$/.test(n)) && new Set(names).size === names.length,
    names.filter((n) => !/^[a-z_]+$/.test(n)).join(" ") || `${names.length} fields`);
  check("...and it asks for everything the descriptive half needs",
    ENA_META_FIELDS.every((f) => names.includes(f)) &&
    ["run_accession", "fastq_ftp", "fastq_bytes", "read_count", "library_layout"]
      .every((f) => names.includes(f)),
    ENA_META_FIELDS.filter((f) => !names.includes(f)).join(" ") || "all present");

  // The fields measured empty across the whole archive must not be asked for:
  // each one is a permanent column of dashes, and the page's own rule is that
  // an absent value produces no row rather than an empty one.
  const DEAD = ["age", "disease", "host_status", "host_phenotype", "host_genotype",
    "dev_stage", "salinity", "host_body_site", "ph", "first_public"];
  check("...and does not ask for the fields the census measured empty",
    DEAD.every((f) => !names.includes(f)), DEAD.filter((f) => names.includes(f)).join(" "));

  // Saying nothing, in the four ways the archive says it.
  const nothings = ["", "  ", "missing", "Missing", "not applicable", "NOT COLLECTED",
    "not provided", "restricted access", "N/A", "na", "unknown", "none", "-",
    "missing: third party data", "missing: data agreement established pre-2023",
    "not applicable: control sample"];
  check("every way the archive says nothing is read as nothing",
    nothings.every(isMissing), nothings.filter((v) => !isMissing(v)).join(" | "));
  // Whole-cell, never a prefix: a cohort whose subjects are NA1..NA9 must not
  // disappear because one sentinel is spelled "na".
  const somethings = ["NA1", "NA12878", "None the wiser", "Missingham", "not-applicable-lab",
    "2022", "France", "Homo sapiens", "0"];
  check("...and a real value that merely starts like one is kept",
    somethings.every((v) => !isMissing(v)), somethings.filter(isMissing).join(" | "));

  const row = {
    run_accession: "ERR1", library_layout: "SINGLE", read_count: "100",
    fastq_ftp: "ftp.sra.ebi.ac.uk/vol1/fastq/ERR1/ERR1.fastq.gz", fastq_bytes: "10",
    sample_accession: "SAMEA1", study_accession: "PRJEB1", study_title: "A study",
    sample_title: "Metagenome or environmental sample from human gut metagenome",
    sample_alias: "MQB_014", scientific_name: "human gut metagenome",
    instrument_model: "Ion GeneStudio S5 Prime", collection_date: "2022",
    country: "France:Nantes", lat: "47.218", lon: "-1.553",
    isolation_source: "faeces", host_scientific_name: "Homo sapiens",
    host_sex: "not provided", library_selection: "RANDOM",
  };
  const parsed = parseRunRow(row);
  check("a resolved run carries what the archive said about its sample",
    parsed.meta?.sample_alias === "MQB_014" && parsed.meta?.collection_date === "2022" &&
    parsed.meta?.host_sex === "not provided",
    JSON.stringify(parsed.meta ?? null).slice(0, 120));
  check("...raw, so the judging happens in exactly one place",
    Object.keys(parsed.meta).every((k) => ENA_META_FIELDS.includes(k)) &&
    !("fastq_ftp" in parsed.meta));

  const clean = usableMeta(parsed.meta);
  check("the archive-generated title is dropped, the submitter's name is kept",
    clean.sample_title === undefined && clean.sample_alias === "MQB_014");
  check("...the sentinel is dropped even though the cell was full",
    clean.host_sex === undefined && "host_sex" in parsed.meta);
  check("...the two-level country is split rather than printed with its colon",
    clean.country === "France" && clean.region === "Nantes");
  check("...and the coordinates survive as numbers", clean.lat === 47.218 && clean.lon === -1.553);

  // Null Island: 885 samples archive-wide sit at exactly 0/0, 424 of them in one
  // study that also says France and Germany. A confident dot in the Atlantic.
  const nullIsland = usableMeta({ ...parsed.meta, lat: "0.0", lon: "0" });
  check("a sample at exactly 0.0 N 0.0 E has no coordinates, it has a typo",
    nullIsland.lat === undefined && nullIsland.country === "France");
  check("...but a real zero on one axis alone is a place",
    usableMeta({ lat: "0.0", lon: "-51.06" }).lat === 0);

  const model = usableMeta({ instrument_model: "unspecified", scientific_name: "soil metagenome" });
  check("an instrument of 'unspecified' is not an instrument",
    model.instrument_model === undefined && model.scientific_name === "soil metagenome");
  check("a title identical to the taxon says nothing the page does not show",
    usableMeta({ sample_title: "Human gut metagenome", scientific_name: "human gut metagenome" })
      .sample_title === undefined);

  // A sample off the user's own disk has no archive row at all, and that is the
  // common case: the panel must render nothing rather than a table of dashes.
  check("no metadata gives no lines, not empty ones",
    metaLines(null).length === 0 && metaLines({}).length === 0 &&
    metaLines({ collection_date: "not collected", country: "missing" }).length === 0);
  const lines = metaLines(parsed.meta);
  check("...and what is shown is ordered, labelled, and free of what was dropped",
    lines.map((l) => l.key).join(",") === "sample_alias,host_scientific_name," +
      "isolation_source,collection_date,country,region,coords,instrument_model," +
      "sample_accession" &&
    lines.every((l) => l.value !== "") && lines[3].label === "collected",
    lines.map((l) => l.key).join(","));
  // RANDOM is what shotgun IS: 96% of runs say it and it never varies. PCR is
  // the one worth seeing, because it says why a profile might be skewed.
  check("...a library selection of RANDOM is not news; PCR is",
    !metaLines({ library_selection: "RANDOM" }).length &&
    metaLines({ library_selection: "PCR" })[0]?.value === "PCR");

  // The line above the table: only what every sample agrees on. One sample
  // disagreeing makes it a property of the sample, not of the run.
  const store = new Map([
    ["A", { scientific_name: "human gut metagenome", study_title: "S", instrument_model: "NovaSeq" }],
    ["B", { scientific_name: "human gut metagenome", study_title: "S", instrument_model: "NovaSeq" }],
  ]);
  const agreed = runFacts(store, ["A", "B"]).map((f) => f.key);
  check("the run line carries what every sample agrees on",
    agreed.includes("scientific_name") && agreed.includes("instrument_model"));
  store.set("B", { ...store.get("B"), instrument_model: "DNBSEQ-G400" });
  const split = runFacts(store, ["A", "B"]).map((f) => f.key);
  check("...and drops a field the moment two samples disagree — that is the batch",
    !split.includes("instrument_model") && split.includes("scientific_name"),
    split.join(","));
  store.set("C", {});
  check("...and drops it when a sample has no value at all, rather than speaking for it",
    runFacts(store, ["A", "B", "C"]).length === 0);

  const cover = fieldCoverage(store, ["A", "B", "C"]);
  check("coverage counts samples, so a field held by two of three is not a grouping",
    cover.get("scientific_name") === 2 && (cover.get("host_sex") ?? 0) === 0);
}

console.log("== the worked example is what it claims to be ==");
{
  // The example is the first thing a visitor sees results in, and it arrives
  // with a banner naming a study, a catalogue and a genome count. Every one of
  // those claims is checkable against the file itself and against the catalogue
  // it says it came from — so they are checked, because a demo that quietly
  // stops matching its own label is a page lying to someone who has no way to
  // know.
  const { fromSession } = await import("./exports.js");
  const demoText = readFileSync(here + "demo/gut-demo.session.json", "utf8");
  const groupsText = readFileSync(here + "demo/gut-demo.groups.csv", "utf8");
  const st = fromSession(demoText);   // throws on anything that is not a session

  // The example is also the only place the metadata feature can be SEEN without
  // a 433 MB database: it ships what the ENA said about its own fifteen runs, so
  // the run line above the matrix and the chips in the sample panel have
  // something to draw. Checked against the runs it claims, because a stale
  // metadata block would label columns that are not there.
  {
    const { usableMeta, runFacts } = await import("./meta.js");
    const meta = st.sampleMeta ?? new Map();
    check("the example carries what the archive said about each of its runs",
      meta.size === st.sampleOrder.length &&
      st.sampleOrder.every((s) => meta.has(s)),
      `${meta.size} described of ${st.sampleOrder.length}`);
    const one = usableMeta(meta.get("ERR14098585"));
    check("...cleaned, so the archive's own boilerplate never reaches the page",
      one.sample_alias === "MQB_023" && one.collection_date === "2022" &&
      one.country === "France" && one.sample_title === undefined &&
      one.sample_description === undefined,
      JSON.stringify(one));
    // The two runs of a subject were sequenced on different machines at
    // different depths, which is the whole reason the example is what it is —
    // so the instrument must NOT reach the line that speaks for every sample.
    const shared = runFacts(meta, st.sampleOrder).map((f) => f.key);
    check("...and the run line says only what all fifteen agree on",
      shared.includes("scientific_name") && shared.includes("study_title") &&
      !shared.includes("instrument_model"),
      shared.join(",") || "(nothing)");
  }

  check("the example loads through the same reader as any saved session",
    st.sampleOrder.length >= 10 && Object.keys(st.matrix).length > 100,
    `${st.sampleOrder.length} samples x ${Object.keys(st.matrix).length} rows`);
  // Saved at any rank above species, the restore path heads the first column
  // "Genus" over per-genome rows until a database is loaded. The example ships
  // with no database, so species is the only honest rank to save it at.
  check("...at species level, the only rank it can be shown at with no database",
    st.rank === "s", st.rank);
  check("...naming public accessions, so the same runs can be profiled again",
    st.sampleOrder.every((s) => /^[EDS]RR\d+$/.test(s)), st.sampleOrder.slice(0, 3).join(" "));

  // Relative abundances of one sample sum to 100. A column that does not is not
  // a profile, whatever else it is.
  const sums = st.sampleOrder.map((s) =>
    Object.values(st.matrix).reduce((a, m) => a + (m[s] ?? 0), 0));
  check("...where every column sums to 100%",
    sums.every((v) => Math.abs(v - 100) < 0.5),
    sums.map((v) => v.toFixed(2)).join(" "));
  check("...and no row is present in name only",
    Object.values(st.matrix).every((m) => st.sampleOrder.some((s) => (m[s] ?? 0) > 0)));

  // The defect this example was first built with: it came from an export taken
  // before the app disambiguated repeated GTDB names, and shipped 8 labels over
  // 25 rows. CroCoDeEL and phyloseq reject a matrix like that outright — so the
  // demo would have been a demonstration of the bug.
  const labels = Object.values(st.matrix).map((m) => m.species);
  const seenLabel = new Map();
  for (const l of labels) seenLabel.set(l, (seenLabel.get(l) ?? 0) + 1);
  const sharedLabels = [...seenLabel].filter(([, n]) => n > 1);
  check("...and no two rows of it share a label, as no export of this app may",
    sharedLabels.length === 0, sharedLabels.slice(0, 3).map(([l, n]) => `${n}x ${l}`).join(", "));

  // The reference is what every export header, the banner and the matrix line
  // are written from. Checked against the catalogue rather than trusted.
  const demoBiome = catalogEntries.find((b) => b.key === st.ref?.key);
  check("the reference it names is a catalogue this page actually offers",
    !!demoBiome, st.ref?.key);
  check("...with the same file, URL, DOI and species count as that entry",
    demoBiome && st.ref.file === demoBiome.file && st.ref.url === demoBiome.url &&
    st.ref.doi === demoBiome.doi && st.ref.species === demoBiome.species,
    `${st.ref?.file} ${st.ref?.species} vs ${demoBiome?.file} ${demoBiome?.species}`);
  check("...and the genome count sylph loaded agrees with it",
    st.ref.genomes === demoBiome?.species, `${st.ref?.genomes} vs ${demoBiome?.species}`);

  // Loading the example borrows the catalogue's lineage map so the rank picker
  // works without the 433 MB database. A genome the map does not know would be
  // bucketed as "unclassified at genus level" — silently, in a table offered as
  // the thing to explore.
  const map = JSON.parse(readFileSync(here + demoBiome.lineage, "utf8"));
  const strangers = Object.keys(st.matrix).filter((g) => !(g in map.species));
  check("every genome in it is one the bundled lineage map can place",
    strangers.length === 0, `${strangers.length} unknown, e.g. ${strangers.slice(0, 2)}`);

  // The groups file is what colours the ordination. A name that matches no
  // sample colours nothing and says so nowhere.
  const groupOf = new Map(groupsText.trim().split(/\r?\n/).slice(1)
    .map((l) => l.split(",").map((c) => c.trim())));
  check("the groups file names every sample of the example, and only those",
    st.sampleOrder.every((s) => groupOf.has(s)) && groupOf.size === st.sampleOrder.length,
    `${groupOf.size} rows for ${st.sampleOrder.length} samples`);
  const subjects = new Set(groupOf.values());
  check("...and groups them into fewer subjects than there are runs, which is the point",
    subjects.size > 1 && subjects.size < st.sampleOrder.length,
    `${subjects.size} subjects`);

  // The wiring, same reason as the cache-bust check: the files can be perfect
  // and unreachable.
  const html = readFileSync(here + "index.html", "utf8");
  const multi = readFileSync(here + "multi.js", "utf8");
  check("the page carries the button and the banner the example needs",
    /id="demoLoad"/.test(html) && /id="demoBanner"/.test(html));
  check("...and multi.js fetches the two files that exist",
    multi.includes('"demo/gut-demo.session.json"') && multi.includes('"demo/gut-demo.groups.csv"'));
  check("...and says whose numbers they are, in the banner and nowhere else needed",
    /not your data/.test(multi));
}

console.log("== clustering orders the matrix without changing it ==");
{
  const { clusterOrder, clusterTable, brayCurtis, correlationDistance } =
    await import("./cluster.js");

  // THE property. Anything else is a nicety; losing or duplicating a row is a
  // corrupted table. An early version of clusterOrder() walked a merge tree it
  // built wrongly and only kept every leaf because of a fallback — this is the
  // check that would have caught it.
  let permOk = true;
  for (let trial = 0; trial < 30 && permOk; trial++) {
    const n = 3 + Math.floor(Math.random() * 40);
    const v = Array.from({ length: n }, () =>
      Array.from({ length: 6 }, () => Math.random() * 10));
    const o = clusterOrder(v, correlationDistance);
    permOk = o.length === n && new Set(o).size === n && o.every((i) => i >= 0 && i < n);
  }
  check("the order is always a permutation — no row lost, none twice", permOk);

  // Distances, at their defining points.
  check("Bray-Curtis is 0 for identical and 1 for disjoint",
    brayCurtis([1, 2, 3], [1, 2, 3]) === 0 && brayCurtis([1, 0], [0, 1]) === 1);
  check("correlation distance is 0 for proportional and 2 for opposed",
    correlationDistance([1, 2, 3], [2, 4, 6]) < 1e-9
    && Math.abs(correlationDistance([1, 2, 3], [3, 2, 1]) - 2) < 1e-9);
  // A flat vector has no rises and falls to compare; NaN here would poison
  // every merge it took part in.
  check("...and a zero-variance vector is 'unrelated', not NaN",
    correlationDistance([5, 5, 5], [1, 2, 3]) === 1);

  // It has to actually find structure, not merely return something.
  const g = (k) => [k === 0 ? 90 : 1, k === 1 ? 90 : 1, k === 2 ? 90 : 1];
  const labels = [0, 1, 2, 0, 1, 2, 0];
  const grouped = clusterOrder(labels.map(g), brayCurtis).map((i) => labels[i]).join("");
  check("...and groups really do end up adjacent", /^0+1+2+$|^0+2+1+$|^1+0+2+$|^1+2+0+$|^2+0+1+$|^2+1+0+$/.test(grouped), grouped);

  // The table wrapper must permute everything that is aligned with an axis, or
  // a column ends up labelled with another sample's name.
  const samples = ["S1", "S2", "S3", "S4"];
  const rows = [0, 1, 2, 3].map((t) => ({
    species: `t${t}`, genome: `g${t}`,
    values: samples.map((_, i) => (i % 2 === t % 2 ? 40 : 1)), maxAbund: 40,
  }));
  const out = clusterTable({ samples, rows, ref: null, refs: samples.map((s) => ({ label: s })) });
  check("clusterTable permutes samples, refs and every row's values together",
    out.samples.length === 4 && out.refs.length === 4 && out.rows.length === 4
    && out.rows.every((r) => r.values.length === 4)
    && out.refs.every((r, i) => r.label === out.samples[i]),
    JSON.stringify(out.samples));
  // Above the row ceiling the samples still cluster and the rows do not, and
  // the caller is told which — an order that means nothing must not look like
  // one that does.
  const many = { samples, rows: Array.from({ length: 5 }, (_, t) => rows[t % 4]), ref: null, refs: null };
  const capped = clusterTable(many, { maxRows: 4 });
  check("...and past the row limit it says rows were NOT ordered",
    capped.clustered.rows === false && capped.clustered.samples === true,
    JSON.stringify(capped.clustered));
}

console.log("== every row of an exported matrix is a distinct label ==");
{
  // CroCoDeEL, phyloseq and every other consumer key on the species column and
  // reject a repeated one: "Each species must appear exactly once — aggregate
  // the rows and reload." Two things make names repeat, and only one of them is
  // GTDB's fault:
  //   - GTDB gives one name to several representatives ("Collinsella
  //     sp002232035" is 20 genomes in human-gut);
  //   - the rank fallbacks give "Collinsella sp." to all 226 human-gut genomes
  //     that have no species name at all.
  // AGGREGATING would be wrong: those 226 are distinct unnamed species, not one
  // species seen 226 times, and summing them invents an organism.
  const shared = (m) => {
    const c = new Map();
    for (const v of Object.values(m)) c.set(v, (c.get(v) ?? 0) + 1);
    return new Set([...c].filter(([, n]) => n > 1).map(([k]) => k));
  };
  const label = (lin, amb, g) => {
    const n = lin[g] ?? lin[g.replace(/\.gz$/i, "")];
    if (!n) return `(${g})`;
    return amb.has(n) ? `${n} [${g.replace(/\.(fna|fa|fasta)(\.gz)?$/i, "")}]` : n;
  };
  let worstDup = 0, checked = 0;
  for (const b of biomes.allBiomes(catalog)) {
    if (!b.lineage) continue;
    let lin;
    try { lin = speciesMap(JSON.parse(readFileSync(here + b.lineage, "utf8"))); } catch { continue; }
    const amb = shared(lin);
    const labels = Object.keys(lin).map((g) => label(lin, amb, g));
    const dups = labels.length - new Set(labels).size;
    if (dups > worstDup) worstDup = dups;
    checked++;
  }
  check("no reference database can produce two rows with the same label",
    checked > 0 && worstDup === 0, `${checked} databases, worst duplicate count ${worstDup}`);

  // The suffix must appear ONLY where it is needed — otherwise every ordinary
  // species name gets uglier for nothing.
  const gut = speciesMap(JSON.parse(readFileSync(here + "db/lineage/human-gut.json", "utf8")));
  const ambGut = shared(gut);
  check("...an unambiguous name is left alone",
    label(gut, ambGut, "MGYG000000002.fna") === "Blautia_A faecis",
    label(gut, ambGut, "MGYG000000002.fna"));
  check("...and the two Faecalibacterium prausnitzii_C rows become distinct",
    label(gut, ambGut, "MGYG000000022.fna") !== label(gut, ambGut, "MGYG000004679.fna")
    && label(gut, ambGut, "MGYG000000022.fna").startsWith("Faecalibacterium prausnitzii_C ["),
    label(gut, ambGut, "MGYG000000022.fna"));
  // Decided from the database, not from the matrix: the same genome must get the
  // same label whatever else a particular run contained.
  check("...and the label depends on the database alone, so exports agree",
    label(gut, ambGut, "MGYG000001935.fna") === "Collinsella sp. [MGYG000001935]",
    label(gut, ambGut, "MGYG000001935.fna"));
}

console.log("== species names and MGnify links ==");
{
  // The bug this closes: profiling against any catalogue but human-gut returned
  // a column of accessions — "(MGYG000304057.fna.gz)" — because only human-gut
  // had a name map. MGYG000304057 is Lactobacillus iners.
  const lookup = (lin, g) => lin[g] ?? lin[g.replace(/\.gz$/i, "")] ?? `(${g})`;
  let mapped = 0, entries = 0;
  for (const b of biomes.allBiomes(catalog)) {
    if (!b.lineage) { check(`${b.key} declares a name map`, false, "no lineage"); continue; }
    const f = here + b.lineage;
    let lin;
    try { lin = speciesMap(JSON.parse(readFileSync(f, "utf8"))); }
    catch (e) { check(`${b.key}: ${b.lineage} is readable`, false, String(e.message).slice(0, 70)); continue; }
    entries += Object.keys(lin).length;
    // A map that does not cover its database shows names for some rows and
    // accessions for others, which reads as missing data rather than as a
    // broken build. gut-mini is a 50-genome cut sharing the human-gut map, so
    // its map is legitimately larger than the database.
    if (!b.bundled && Number.isFinite(b.species)) {
      check(`${b.key}: the map covers all ${b.species} genomes in the database`,
        Object.keys(lin).length === b.species, `${Object.keys(lin).length} entries`);
    }
    mapped++;
  }
  check("every biome has a name map", mapped === biomes.allBiomes(catalog).length,
    `${mapped}/${biomes.allBiomes(catalog).length}`);
  check("the maps together cover the whole deposit", entries > 50_000, `${entries} entries`);

  // The keys are stored un-gzipped; the eighteen new databases report .fna.gz.
  // Without the fallback every row of every catalogue but human-gut misses.
  const vag = speciesMap(JSON.parse(readFileSync(here + "db/lineage/human-vaginal.json", "utf8")));
  check("a .fna.gz genome finds its name through the un-gzipped key",
    lookup(vag, "MGYG000304057.fna.gz") === "Lactobacillus iners",
    lookup(vag, "MGYG000304057.fna.gz"));
  check("...and the .fna form still works, for the older human-gut database",
    lookup(vag, "MGYG000304057.fna") === "Lactobacillus iners");
  check("an unmapped genome still shows its accession rather than nothing",
    lookup(vag, "NOT_IN_MAP.fna.gz") === "(NOT_IN_MAP.fna.gz)");
  // No entry may be blank: a row with an empty Species column looks like a
  // rendering bug. Unclassified genomes say "unclassified".
  check("no entry is blank — unclassified is spelled out",
    Object.values(vag).every((v) => typeof v === "string" && v.length > 0));

  const url = biomes.mgnifyGenomeUrl;
  check("a genome links to its MGnify page",
    url("MGYG000304057.fna.gz") === "https://www.ebi.ac.uk/metagenomics/genomes/MGYG000304057",
    url("MGYG000304057.fna.gz"));
  check("...from the .fna form too", url("MGYG000000001.fna").endsWith("/MGYG000000001"));
  // A database the user built themselves must not link into a catalogue its
  // genomes are not in.
  check("a genome that is not an MGnify accession gets no link",
    url("my_own_genome.fna") === "" && url("GCF_000001.fna") === "" && url("") === ""
    && url(null) === "" && url(undefined) === "");
}

console.log("== the picker is built from the catalogue ==");
{
  // A <select> stub: enough of the DOM for renderDbSelect, and nothing else.
  // The alternative is a browser, and scripts/ena-test/page.mjs already drives
  // one — what is being pinned here is the shape of the list, which is exactly
  // what a stub can hold.
  const makeNode = (tag) => {
    const n = {
      tagName: tag, children: [], dataset: {}, value: "", disabled: false, label: "",
      _text: "",
      appendChild(c) { n.children.push(c); return c; },
    };
    Object.defineProperty(n, "textContent", {
      get: () => n._text,
      set: (v) => { n._text = String(v); if (v === "") n.children.length = 0; },
    });
    Object.defineProperty(n, "ownerDocument", { get: () => doc });
    return n;
  };
  const doc = { createElement: makeNode };
  const select = makeNode("select");

  const picked = biomes.renderDbSelect(select, catalog, { selected: "" });
  const groups = select.children;
  const options = groups.flatMap((g) => g.children);
  check("the list is grouped, not nineteen entries flat",
    groups.length === catalog.groups.length + 1, `${groups.length} optgroups`);
  check("every catalogue entry made it into the list",
    options.length === catalogEntries.length + 1, `${options.length} options`);
  check("the last group is the user's own file, and it is the last option",
    groups[groups.length - 1].children[0].value === biomes.LOCAL_VALUE
    && options[options.length - 1].value === biomes.LOCAL_VALUE);
  // "Local file…" is not a biome and must never be labelled as one.
  check("a local file has no catalogue entry behind it",
    biomes.biomeForUrl(catalog, biomes.LOCAL_VALUE) === null);

  // Every one of the nineteen is published now, so the real catalogue holds no
  // URL-less entry to assert on and these checks would be asserting 0 === 0 —
  // they could no longer fail. The pending entry is therefore built here, with
  // a reason this test owns, so what is pinned is the mechanism rather than the
  // wording of the day.
  const PENDING_REASON = "sentinel: built but with nowhere to fetch it from";
  const withPending = biomes.normaliseCatalog({
    ...catalogJson,
    pendingNote: PENDING_REASON,
    groups: catalogJson.groups.map((g, i) => (i > 0 ? g : {
      ...g,
      biomes: [...g.biomes, { ...g.biomes[0], key: "pending-test", label: "Pending test biome", url: "" }],
    })),
  });
  const selectP = makeNode("select");
  biomes.renderDbSelect(selectP, withPending, { selected: "" });
  const disabled = selectP.children.flatMap((g) => g.children).filter((o) => o.disabled);
  check("entries with no URL are present but unselectable",
    disabled.length === 1, `${disabled.length} disabled`);
  check("...with no value, so they cannot be loaded even by accident",
    disabled.every((o) => o.value === ""));
  check("...and the reason is in the text the user reads",
    disabled.every((o) => o.textContent.includes(PENDING_REASON)),
    disabled[0]?.textContent ?? "");
  // The other direction: with the real catalogue nothing is greyed out, and
  // every published biome is selectable. Checking only the pending case would
  // pass just as well if all nineteen had lost their URLs.
  check("...while in the real catalogue all nineteen are selectable",
    options.filter((o) => o.disabled).length === 0
    && catalogEntries.filter((b) => b.available).length === catalogEntries.length,
    `${options.filter((o) => o.disabled).length} disabled of ${catalogEntries.length}`);

  check("the first available biome is selected by default",
    picked?.key === "human-gut" && select.value === picked.url, picked?.key ?? "none");

  // Remembering the choice is worth doing with nineteen entries — but a
  // remembered entry that has since lost its URL must not leave the page
  // pointing at nothing.
  const select2 = makeNode("select");
  const p2 = biomes.renderDbSelect(select2, catalog, { selected: "gut-mini" });
  check("a remembered biome is restored", p2?.key === "gut-mini" && select2.value === p2.url);
  // Same reason as above: no real entry is unavailable any more, so the stalled
  // one has to come from the fixture rather than from the catalogue on disk.
  const stalled = biomes.allBiomes(withPending).find((b) => !b.available);
  const select3 = makeNode("select");
  const p3 = biomes.renderDbSelect(select3, withPending, { selected: stalled.key });
  check("a remembered biome that is not downloadable falls back to one that is",
    p3?.available === true && p3.key !== stalled.key, p3?.key ?? "none");

  // Losing db/biomes.json must cost the biome choice, not the application.
  const fb = biomes.fallbackCatalog();
  check("the built-in fallback still offers a database and the smoke test",
    biomes.allBiomes(fb).length === 2 && biomes.allBiomes(fb).every((b) => b.available));
  check("...and the pages ship the same two in their markup, for the same reason",
    /human-gut\.syldb\/content/.test(indexSrcForBiome) && /db\/gut_mini\.syldb/.test(indexSrcForBiome)
    && /gut\.syldb\/content/.test(profileSrcForBiome) && /db\/gut_mini\.syldb/.test(profileSrcForBiome));
  check("...including the local-file option, which is not a catalogue entry",
    /value="__local__"/.test(indexSrcForBiome) && /value="__local__"/.test(profileSrcForBiome));
}

console.log("== which database a result came from ==");
{
  const gut = biomes.biomeByKey(catalog, "human-gut");
  const soil = biomes.biomeByKey(catalog, "soil");
  const meta = { database_size: 4744, k: 31, c: 200, bytes: 454021440 };
  const ref = biomes.makeDbRef({ biome: gut, dbMeta: meta, label: "gut.syldb", source: "cache" });
  const soilRef = biomes.makeDbRef({
    biome: soil, dbMeta: { database_size: 19472, k: 31, c: 200, bytes: 2959289168 },
    label: "soil.syldb", source: "network",
  });
  const localRef = biomes.makeDbRef({
    biome: null, dbMeta: meta, label: "mine.syldb", source: "file",
  });

  check("the reference names the biome and the catalogue version",
    /Human gut/.test(biomes.refLine(ref)) && /MGnify human-gut v2\.0\.2/.test(biomes.refLine(ref)),
    biomes.refLine(ref));
  check("a database off the user's disk is not given a biome it cannot have",
    localRef.local === true && /biome unknown/i.test(biomes.refLine(localRef)),
    biomes.refLine(localRef));
  // The status line goes on to print the genome count itself, so the short form
  // stops at the identity — but it is still an identity, file included.
  check("the short form on the status line names the biome, the file and the catalogue",
    /Human gut/.test(biomes.refShort(ref)) && /gut\.syldb/.test(biomes.refShort(ref))
    && /MGnify human-gut v2\.0\.2/.test(biomes.refShort(ref)), biomes.refShort(ref));
  check("...and says plainly when there is no biome to name",
    /biome unknown/.test(biomes.refShort(localRef)), biomes.refShort(localRef));
  check("two different catalogues are not the same reference",
    biomes.sameDbRef(ref, soilRef) === false);
  check("...and reloading the same one is",
    biomes.sameDbRef(ref, biomes.makeDbRef({ biome: gut, dbMeta: meta, label: "gut.syldb" })));

  // The check that catches a mislabelled deposit: the catalogue says how many
  // genomes the file holds, sylph says how many it loaded.
  check("a file with the wrong number of genomes is called out",
    /WARNING/.test(biomes.genomeCountMismatch(biomes.makeDbRef({
      biome: soil, dbMeta: { database_size: 4744, k: 31, c: 200 }, label: "soil.syldb",
    }))));
  check("...and a matching one says nothing", biomes.genomeCountMismatch(ref) === "");
  check("...and a local file, which has nothing to compare against, is not accused",
    biomes.genomeCountMismatch(localRef) === "");

  // ---- the picker is a control, not a state ----------------------------------
  //
  // The note under the picker used to be rewritten on every `change` and to
  // assert, in the present tense, that "everything you profile will be reported
  // against THIS catalogue". Moving the dropdown after a load — one gesture, no
  // click on Load — made that sentence false while the status line and the
  // matrix header above and below it still named the loaded database. Two
  // contradictory claims on screen at once, about the single fact this page
  // exists to get right.
  check("with nothing loaded, the picker describes a plan and that is honest",
    biomes.selectionMatchesLoaded(null, soil) === true);
  check("the selection matches when it IS what was loaded",
    biomes.selectionMatchesLoaded(ref, gut) === true);
  check("moving the picker off the loaded database is a mismatch",
    biomes.selectionMatchesLoaded(ref, soil) === false);
  check("...as is pointing at 'Local file…' while a catalogue is loaded",
    biomes.selectionMatchesLoaded(ref, null, true) === false);
  check("...and pointing at a catalogue while a file off the disk is loaded",
    biomes.selectionMatchesLoaded(localRef, gut) === false);
  check("a loaded local file and the local option do agree",
    biomes.selectionMatchesLoaded(localRef, null, true) === true);
  check("the mismatch note names the database that is really in memory",
    /NOT LOADED/.test(biomes.notLoadedNote(ref)) && /Human gut/.test(biomes.notLoadedNote(ref))
    && /Load database/.test(biomes.notLoadedNote(ref)), biomes.notLoadedNote(ref).slice(0, 120));
  check("...and says which one the numbers would be reported against",
    /reported against IT/.test(biomes.notLoadedNote(ref)), biomes.notLoadedNote(ref).slice(0, 160));
  check("...and there is nothing to say when nothing is loaded",
    biomes.notLoadedNote(null) === "");
  // The entry's own sentence has to move with it: "will be reported" is a claim
  // about memory, and in this state it is not true of anything.
  check("the note commits in the present tense when the selection IS loaded",
    /Everything you profile will be reported/.test(biomes.biomeNote(gut)),
    biomes.biomeNote(gut).slice(0, 90));
  check("...and drops to the conditional when it is not",
    /WOULD report/.test(biomes.biomeNote(gut, { pending: true }))
    && !/Everything you profile will be reported/.test(biomes.biomeNote(gut, { pending: true })),
    biomes.biomeNote(gut, { pending: true }).slice(0, 140));
  check("...while still saying a foreign sample yields a full, plausible table",
    /another environment/.test(biomes.biomeNote(gut, { pending: true }))
    && /full, plausible table/.test(biomes.biomeNote(gut, { pending: true })));

  // ---- a reload can bring back a different database ---------------------------
  //
  // A 32/64-bit build switch and a bigger worker pool both re-read the database
  // out of the local cache. Another tab is free to invalidate and rewrite that
  // entry in between; every worker then agrees perfectly on a database this page
  // is not describing, so worker-vs-worker comparison cannot see it.
  check("a reload that brings back the same database says nothing",
    biomes.refMetaMismatch(ref, meta) === "");
  check("...one that brings back a different genome count is named",
    /genomes 4744 → 4700/.test(biomes.refMetaMismatch(ref, { ...meta, database_size: 4700 })),
    biomes.refMetaMismatch(ref, { ...meta, database_size: 4700 }));
  check("...and a different k, c or size too",
    /k 31 → 21/.test(biomes.refMetaMismatch(ref, { ...meta, k: 21 }))
    && /c 200 → 2000/.test(biomes.refMetaMismatch(ref, { ...meta, c: 2000 }))
    && /bytes /.test(biomes.refMetaMismatch(ref, { ...meta, bytes: 1 })));
  check("...but a field nobody can compare is not reported as a difference",
    biomes.refMetaMismatch(ref, { database_size: 4744 }) === "" &&
    biomes.refMetaMismatch(biomes.makeDbRef({ biome: gut, dbMeta: {}, label: "x" }), meta) === "");

  // The export. This is the one that matters after the fact: a matrix profiled
  // against the wrong biome is only ever caught by re-reading the file.
  const head = biomes.refCommentLines(ref, { samples: 3, rows: 120 });
  check("every reference line in an export is a comment", head.every((l) => l.startsWith("#")));
  check("the export names the biome, its key and its catalogue version",
    head.some((l) => /Human gut/.test(l) && /human-gut/.test(l) && /v2\.0\.2/.test(l)),
    head.join(" | ").slice(0, 160));
  check("...the file and URL it came from",
    head.some((l) => /gut\.syldb/.test(l) && /zenodo\.org/.test(l)));
  check("...the sketching parameters and the genome count",
    head.some((l) => /genomes=4744/.test(l) && /k=31/.test(l) && /c=200/.test(l)));
  check("...when it was exported", head.some((l) => /# exported: \d{4}-\d\d-\d\dT/.test(l)));
  check("...and that the numbers mean nothing outside that catalogue",
    head.some((l) => /relative to the reference database named above/.test(l)));
  check("a comma-separated export carries no commas inside its comment numbers",
    head.every((l) => !/\d,\d\d\d/.test(l)), head.find((l) => /\d,\d\d\d/.test(l)) ?? "");
  check("an export from a local file says the biome is unknown rather than guessing",
    biomes.refCommentLines(localRef).some((l) => /LOCAL FILE/.test(l) && /biome unknown/.test(l)));
  check("a mismatched genome count is carried into the file too",
    biomes.refCommentLines(biomes.makeDbRef({
      biome: soil, dbMeta: { database_size: 4744 }, label: "soil.syldb",
    })).some((l) => /WARNING/.test(l)));

  // The file name. A downloads folder is where these are actually told apart.
  check("the biome is in the file name", biomes.refSlug(ref) === "human-gut");
  check("...for a local file too, without pretending to know the biome",
    /^local-/.test(biomes.refSlug(localRef)), biomes.refSlug(localRef));
  check("...and it is always a safe file name",
    /^[A-Za-z0-9._-]+$/.test(biomes.refSlug(biomes.makeDbRef({
      biome: null, dbMeta: meta, label: "some name/../weird.syldb",
    }))), biomes.refSlug(biomes.makeDbRef({ biome: null, dbMeta: meta, label: "a/../b.syldb" })));
}

console.log("== the pages carry the reference through ==");
{
  const multiSrc = readFileSync(here + "multi.js", "utf8");
  const profileSrc = readFileSync(here + "profile.js", "utf8");

  // The picker is data, not markup: nineteen <option>s hand-written in two HTML
  // files is how they drift apart.
  for (const [name, src] of [["multi.js", multiSrc], ["profile.js", profileSrc]]) {
    check(`${name} builds the picker from db/biomes.json`,
      /renderDbSelect\(els\.dbSelect, catalog/.test(src) && /fetchCatalog\(\)/.test(src));
    check(`${name} survives a missing catalogue file`, /fallbackCatalog\(\)/.test(src));
    check(`${name} reads the biome from the picker once, when the database is loaded`,
      /const biome = pickedBiome\(\);/.test(src));
    check(`${name} freezes it into a reference object`,
      /makeDbRef\(\{ biome, dbMeta, label, source: dbSource, url \}\)/.test(src));
    check(`${name} names the biome on the database status line`,
      /const who = refShort\(currentRef\) \|\| label;/.test(src)
      && /Database ready[^`]*\$\{who\}/.test(src));
    check(`${name} warns when the file does not hold the genomes the catalogue promises`,
      /genomeCountMismatch\(currentRef\)/.test(src) && /if \(mismatch\)/.test(src)
      && /showError\(/.test(src));
    check(`${name} fetches the lineage map only for a catalogue that has one`,
      /lineage = \{\};[^\n]*\n\s*if \(biome\?\.lineage\)/.test(src));
    // The set of ambiguous names belongs to the loaded database. Clearing the
    // map without clearing it would label a soil genome using the gut
    // database's collisions — and only for the names that happened to overlap,
    // which is the kind of wrongness nobody notices.
    check(`${name} clears the ambiguous-name set with the map it came from`,
      !/(?<!let )lineage = \{\};(?![^\n]*ambiguousNames)/.test(src));
    check(`${name} names cached databases by biome, not by file name`,
      /function cacheEntryName/.test(src) && /escapeHTML\(cacheEntryName\(e\)\)/.test(src));
    check(`${name} marks the cached entry the picker is on`,
      /sameUrl\(e\.url, els\.dbSelect\?\.value\)/.test(src) && /nothing to download/.test(src));
    check(`${name} tells the user what the chosen biome commits them to`,
      /biomeNote\(selectedBiome, \{ pending \}\)/.test(src));

    // The picker is a control the user can move at any time; the database in
    // memory is not. When they differ the note has to say so, name the loaded
    // one, and stop claiming the present tense — otherwise moving the dropdown
    // alone puts a catalogue name on screen that no number underneath it came
    // from, which is precisely the failure this whole picker exists to prevent.
    check(`${name} compares the picker with the database actually loaded`,
      /const pending = !selectionMatchesLoaded\(currentRef, selectedBiome, local\);/.test(src));
    check(`${name} names the loaded database when the picker has moved off it`,
      /notLoadedNote\(currentRef\)/.test(src) && /const full = pending \?/.test(src));
    check(`${name} repaints that note when what is loaded changes`,
      /paintBiomeNote\(\);\s*\n\s*(refreshRunButton\(\);\s*\n\s*)?renderCacheInfo\(\);/.test(src));

    // A load that fails part-way must not leave the previous database's identity
    // standing over a pool that no longer holds it. multi.js loads the workers
    // one at a time and each frees its old Profiler before building the new one,
    // so a failure half way through is a pool with two different references in
    // it — or one and a half.
    check(`${name} drops the reference when a load fails part-way`,
      /dbMeta = null;\s*\n\s*currentRef = null;\s*\n\s*lastDbLoad = null;/.test(src));
    check(`${name} says on screen that nothing is loaded any more`,
      /No database is loaded/.test(src));

    // A reload out of the local cache can hand back different bytes than the ones
    // the reference was minted from.
    check(`${name} re-checks the reference against a database read back from cache`,
      /function revalidateRefAfterReload\(\)/.test(src)
      && /refMetaMismatch\(currentRef, dbMeta\)/.test(src));
  }

  // Both reload paths in multi.js — the 32/64-bit build switch and growing the
  // worker pool — refresh dbMeta. Neither used to re-check currentRef against it.
  check("multi.js revalidates the reference after every reload, not just some",
    (multiSrc.match(/revalidateRefAfterReload\(\);/g) ?? []).length === 2,
    `${(multiSrc.match(/revalidateRefAfterReload\(\);/g) ?? []).length} call sites`);
  check("...on the wasm build switch",
    /dbMeta = metas\[0\];\s*\n\s*if \(dbSource === "network"\) dbSource = "cache";\s*\n\s*revalidateRefAfterReload\(\);/
      .test(multiSrc));
  check("...and it adopts the new reference rather than merely describing it",
    /adoptDbRef\(makeDbRef\(\{/.test(multiSrc));
  check("multi.js re-enables (or greys out) Profile all after a failed load",
    /setRunControls\(false\);\s*\n(\s*\/\/[^\n]*\n)*\s*paintBiomeNote\(\);\s*\n\s*refreshRunButton\(\);/
      .test(multiSrc));

  // The matrix carries the reference it was PROFILED against, not the one that
  // happens to be selected when it is exported.
  check("the matrix is built with the reference of the run that filled it",
    /const runRef = currentRef;/.test(multiSrc)
    // The call now goes through lastRaw, which is what a rank change re-sums —
    // but its `ref` is still the run's, which is the property being pinned.
    && /lastRaw = \{ matrix, sampleOrder, ref: runRef,/.test(multiSrc)
    && /matrixToTable\(lastRaw\.matrix, lastRaw\.sampleOrder, lastRaw\.ref/.test(multiSrc)
    && /return \{ samples: sampleOrder, rows, ref, refs, mixed \}/.test(multiSrc));
  // Stronger than the above, and the reason it changed shape: the reference is
  // recorded on each SAMPLE as it is profiled, so a column can name the
  // catalogue it actually came from rather than inheriting a matrix-wide one.
  // With one database loaded these agree — the point is that if they ever stop
  // agreeing, the table and the exports say so instead of averaging it away.
  check("...and each sample records the reference it was profiled against",
    /s\.ref = runRef;/.test(multiSrc));
  check("...which the matrix header shows per column",
    /matrix-ref-row/.test(multiSrc) && /profiled against/.test(multiSrc));
  check("...and both exports carry per-sample references and warn if they differ",
    /# reference per sample: /.test(multiSrc)
    && /these columns were NOT all profiled against the same catalogue/.test(multiSrc));
  check("...and it is shown above the matrix on screen",
    /els\.matrixRef/.test(multiSrc) && /Profiled against \$\{line\}/.test(multiSrc));
  check("...and written into both exports",
    /refCommentLines\(ref, \{ samples: samples\.length, rows: rows\.length \}\)/.test(multiSrc));
  check("...whose file name says the biome too",
    /abundance_matrix_\$\{refSlug\(ref\)\}\.\$\{ext\}/.test(multiSrc));
  check("the single-sample page names the reference above its results",
    /els\.resultsRef/.test(profileSrc) && /Profiled against \$\{line\}/.test(profileSrc));

  // THE cross-catalogue trap. runAll() replays already-`done` samples into the
  // matrix without re-profiling them, which is right within one reference and
  // catastrophic across two — the same species would appear twice, under one
  // header, with nothing downstream able to tell.
  check("loading a different database resets samples profiled against the previous one",
    /function adoptDbRef\(ref\)/.test(multiSrc)
    && /const changed = !!currentRef && !sameDbRef\(currentRef, ref\)/.test(multiSrc)
    && /const stale = files\.filter\(\(s\) => s\.rows\)/.test(multiSrc));
  check("...and says so, rather than dropping ten minutes of profiling in silence",
    /abundances from two catalogues cannot/.test(multiSrc));
  // Two messages can want the error box on one load: "your finished samples were
  // reset" and "this file does not hold the genomes the catalogue claims".
  // Neither is expendable, so the second is prepended rather than written over.
  check("...and the genome-count warning does not write over that notice",
    /const already = els\.error\.textContent;/.test(multiSrc)
    && /already \? `\$\{mismatch\}/.test(multiSrc));
  check("the single-sample page hides a result that was profiled against another database",
    /els\.results\.classList\.add\("hide"\);\s*\n\s*describeDb\(label/.test(profileSrc));

  // Both pages say, before anything is loaded, what the choice costs.
  for (const [name, src] of [["index.html", indexSrcForBiome], ["profile.html", profileSrcForBiome]]) {
    // index.html said this THREE times: a red panel at the top, #dbBiomeNote
    // under the picker, and #dbInfo. The panel was the only one that could not
    // name the selected biome, and the furthest from the control, so it went.
    // What must survive is that the cost of the wrong choice is stated before
    // anything is loaded — on index.html by biomeNote(), which fills
    // #dbBiomeNote on load, plus the static paragraph that carries the one
    // sentence the panel alone had. profile.html still uses the panel.
    check(`${name} carries the wrong-biome warning`,
      name === "index.html"
        ? /id="dbBiomeNote"/.test(src) && /cannot be combined/.test(src)
          && /full, plausible table/.test(biomesSrc)
        : /biome-warning/.test(src) && /full, plausible, wrong table/.test(src));
    check(`${name} has somewhere to say which biome is selected`, /id="dbBiomeNote"/.test(src));
  }
  check("index.html has somewhere to name the reference above the matrix",
    /id="matrixRef"/.test(indexSrcForBiome));
  check("profile.html has somewhere to name it above the results",
    /id="resultsRef"/.test(profileSrcForBiome));

  // The new module is in the pages' graph, so it is busted with the same token
  // as everything else — see the cache-bust section above for what a mixed
  // version pair does to a returning visitor.
  const rpcVersion = rpcSrc.match(/WORKER_VERSION\s*=\s*"(\d+)"/)?.[1];
  for (const [name, src] of [["multi.js", multiSrc], ["profile.js", profileSrc]]) {
    const v = src.match(/from\s+"\.\/biomes\.js\?v=(\d+)"/)?.[1];
    check(`${name} imports biomes.js on WORKER_VERSION`, v === rpcVersion,
      `import=${v} rpc=${rpcVersion}`);
  }
  check("version was bumped past 13 for the biome picker", Number(rpcVersion) >= 14, rpcVersion);
}

console.log("== the run's reference is frozen after any reload, not before ==");
{
  const src = readFileSync(new URL("./multi.js", import.meta.url), "utf8");
  const freeze = src.indexOf("const runRef = currentRef");
  const reload = src.indexOf("await ensureWasmBuildFor(maxReads)");
  // ensureWasmBuildFor() reloads the database and may REPLACE currentRef
  // (revalidateRefAfterReload). Freezing before it would stamp the matrix, and
  // every exported file, with a reference the numbers did not come from.
  check("runAll freezes the reference", freeze > 0, String(freeze));
  check("...after the reload that can replace it, not before",
    freeze > reload && reload > 0, `freeze@${freeze} reload@${reload}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
