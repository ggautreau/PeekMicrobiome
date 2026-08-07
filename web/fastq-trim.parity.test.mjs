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
  check("...and says the ENA mode contacts the EBI", /EBI/.test(banner));
  check("...naming what the EBI gets to see", /IP address/.test(banner) && /accession/.test(banner));
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
  // per entry is what stops the gut map being fetched for a soil database.
  check("only the catalogues that have a lineage map declare one",
    catalogEntries.filter((b) => b.lineage).every((b) => b.catalogue === "human-gut"),
    catalogEntries.filter((b) => b.lineage).map((b) => b.key).join(","));

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
      /lineage = \{\};\s*\n\s*if \(biome\?\.lineage\)/.test(src));
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
    && /matrixToTable\(matrix, sampleOrder, runRef\)/.test(multiSrc)
    && /return \{ samples: sampleOrder, rows, ref \}/.test(multiSrc));
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
    check(`${name} carries the wrong-biome warning`,
      /biome-warning/.test(src) && /full, plausible, wrong table/.test(src));
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
