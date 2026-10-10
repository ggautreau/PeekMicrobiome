// web/sylph-worker.js and the promise side of it, driven through the worker's
// OWN message handler — not through the modules it imports.
//
//   node web/worker.test.mjs
//
// WHY A TEST AT THIS LEVEL. Every module under the worker had its own suite and
// every suite was green, while the worker itself:
//   - ran two messages at once on its one Profiler, so a sample came back with a
//     tenth of its reads, or none, depending on scheduling;
//   - answered `ok: true` to a sample cancelled half-way through an uncompressed
//     FASTQ, which the page then recorded as done;
//   - took a FASTQ that stops at a malformed record for a complete one;
//   - dropped the reference bytes the page sent it and fetched them again;
//   - and never replied at all when that fetch failed.
// None of that is visible from a module. All of it is from here.
//
// What it needs is all in the repository: the sylph wasm (web/sylph-pkg), the
// bundled smoke-test database, and for the functional checks the sourmash wasm
// and the KEGG reference. The reads are synthetic and deterministic. The real
// FASTQ fixtures (scripts/ena-test/fx/, git-ignored) add one check with real
// species when they are present, and are skipped — and said so — when not.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(HERE, "db/gut_mini.syldb");
const PKG = path.join(HERE, "funprofiler-pkg");
const REF = path.join(HERE, "db/kegg/ko-sketches-k11.ndjson.gz");
const FX1 = path.join(HERE, "../scripts/ena-test/fx/R1.fastq.gz");

let pass = 0, fail = 0, skip = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const have = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the worker's world, in this thread ---------------------------------------

// The worker fetches its wasm and, for the second sketch, the reference: here
// they come off the disk, and every URL asked for is counted.
const fetched = [];
globalThis.fetch = async (u) => {
  const s = String(u);
  fetched.push(s);
  if (!s.startsWith("file:")) throw new Error(`this test reaches no network (${s})`);
  const p = fileURLToPath(s.split("?")[0]);
  if (!have(p)) return new Response("not found", { status: 404 });
  return new Response(fs.readFileSync(p), {
    status: 200, headers: { "Content-Type": p.endsWith(".wasm") ? "application/wasm" : "application/octet-stream" },
  });
};

const listeners = [];
const replies = new Map();
const progress = new Map();
globalThis.self = {
  addEventListener: (type, fn) => { if (type === "message") listeners.push(fn); },
  postMessage: (msg) => {
    if (msg.progress) { progress.set(msg.id, (progress.get(msg.id) ?? 0) + 1); return; }
    const r = replies.get(msg.id);
    if (r) { replies.delete(msg.id); r(msg); }
  },
};
// The worker logs a line per sample; the verdicts below are what matter.
const say = console.log;
console.log = (...a) => { if (!String(a[0]).startsWith("[worker")) say(...a); };
await import(pathToFileURL(path.join(HERE, "sylph-worker.js")).href + "?v=test");

let nextId = 1;
const post = (data) => { for (const fn of listeners) fn({ data }); };
const send = (type, payload = {}) => {
  const id = nextId++;
  const reply = new Promise((r) => replies.set(id, r));
  post({ id, type, ...payload });
  return { id, reply };
};
const ask = (type, payload) => send(type, payload).reply;
const cancel = (target) => post({ id: 0, type: "cancel", target });

// A File as streamCore reads one: .size, .slice().arrayBuffer(), .stream().
// `pace` makes each 64 KiB chunk wait, so a cancel or a second message can land
// while the sample is still being read.
class LocalFile {
  constructor(bytes, name = "x.fastq", pace = 0) {
    this.bytes = bytes; this.size = bytes.length; this.name = name; this.pace = pace;
  }
  slice(a, b) {
    const v = this.bytes.subarray(a, b);
    return { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.length) };
  }
  stream() {
    const { bytes, pace } = this;
    let off = 0;
    return new ReadableStream({
      async pull(c) {
        if (pace) await sleep(pace);
        if (off >= bytes.length) { c.close(); return; }
        const end = Math.min(off + 65536, bytes.length);
        c.enqueue(new Uint8Array(bytes.subarray(off, end)));
        off = end;
      },
    });
  }
}

// Deterministic reads, 150 bp, matching nothing in particular: what is checked
// here is how many reads were read and why the read stopped.
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const records = (n, tag = "r") => {
  const out = [];
  for (let i = 0; i < n; i++) {
    let s = "";
    for (let j = 0; j < 150; j++) s += "ACGT"[Math.floor(rnd() * 4)];
    out.push(`@${tag}${i}`, s, "+", "I".repeat(150));
  }
  return out;
};
const fastq = (lines, finalNewline = true) =>
  Buffer.from(lines.join("\n") + (finalNewline ? "\n" : ""), "latin1");

// ---- start ---------------------------------------------------------------------

check("init", (await ask("init", { maxReads: 3_000_000, bits: 32 })).ok);
const dbBytes = new Uint8Array(fs.readFileSync(DB));
const loaded = await ask("loadDb", { bytes: dbBytes.slice() });
check("the smoke-test database loads", loaded.ok && loaded.meta?.database_size > 0,
  loaded.error ?? JSON.stringify(loaded.meta));

const SE = records(2000, "a");
const profile = (files, extra = {}) =>
  ask("profileFilesMulti", { files, maxReads: 3_000_000, ...extra });

// ---- why the read stopped -----------------------------------------------------
{
  const eof = await profile([new LocalFile(fastq(SE))]);
  check("a file read to its end says stop: eof", eof.ok && eof.stop === "eof" && eof.reads === 2000,
    `${eof.stop} ${eof.reads} ${eof.error ?? ""}`);
  check("...and carries no detail", eof.stopDetail === "");

  const capped = await profile([new LocalFile(fastq(SE))], { maxReads: 500 });
  check("the read cap says stop: reads", capped.ok && capped.stop === "reads" && capped.reads === 500,
    `${capped.stop} ${capped.reads}`);

  // 150 bp reads, a cap of 300 reads' worth of bases.
  const based = await profile([new LocalFile(fastq(SE))], { maxBases: 300 * 150 });
  check("the BASE cap says stop: bases — which the ENA check needs to know",
    based.ok && based.stop === "bases" && based.reads === 300, `${based.stop} ${based.reads}`);

  // A quality line shorter than its sequence at record 1,000. sylph's parser
  // gives up there; the sample used to be finished on the first 1,000 reads and
  // returned as complete.
  const bad = SE.slice();
  bad[1000 * 4 + 3] = bad[1000 * 4 + 3].slice(0, 20);
  const trunc = await profile([new LocalFile(fastq(bad))]);
  check("a malformed record says stop: truncated, not a result",
    trunc.ok && trunc.stop === "truncated" && trunc.reads === 1000, `${trunc.stop} ${trunc.reads}`);
  check("...and the detail says where", /malformed FASTQ record after read 1,000/.test(trunc.stopDetail),
    trunc.stopDetail);

  const blank = SE.slice();
  blank.splice(1000 * 4, 0, "");
  const blankR = await profile([new LocalFile(fastq(blank))]);
  check("a stray blank line is a truncation too", blankR.stop === "truncated", blankR.stop);

  // The last file of a sample may end without a newline: that is not damage.
  const noNl = await profile([new LocalFile(fastq(SE, false))]);
  check("a final record with no trailing newline is still read, and is not a truncation",
    noNl.ok && noNl.stop === "eof" && noNl.reads === 2000, `${noNl.stop} ${noNl.reads}`);
}

// ---- several files, one sample -------------------------------------------------
{
  // The first file ends without a newline. Read as one stream, its last quality
  // line used to swallow the second file's first header — the parser stopped
  // there and every read of the second file was left out, silently.
  const A = records(1000, "a"), B = records(1000, "b");
  const whole = await profile([new LocalFile(fastq([...A, ...B]))]);
  const seam = await profile([new LocalFile(fastq(A, false)), new LocalFile(fastq(B))]);
  check("a file with no final newline does not swallow the next one",
    seam.ok && seam.reads === 2000 && seam.stop === "eof", `${seam.reads} reads, stop ${seam.stop}`);
  check("...and the sample is the same as the two files written as one",
    seam.tsv === whole.tsv && seam.reads === whole.reads);
  const gz = await profile([
    new LocalFile(zlib.gzipSync(fastq(A, false)), "a.fastq.gz"),
    new LocalFile(zlib.gzipSync(fastq(B)), "b.fastq.gz"),
  ]);
  check("...in gzip as well", gz.ok && gz.reads === 2000 && gz.stop === "eof", `${gz.reads} ${gz.stop}`);
}

// ---- paired ---------------------------------------------------------------------
{
  const R1 = records(2000, "p"), R2 = records(2000, "q");
  const pe = (r1, r2) => ask("profileFilesPe", {
    r1Files: [new LocalFile(fastq(r1))], r2Files: [new LocalFile(fastq(r2))], maxReads: 3_000_000,
  });
  const clean = await pe(R1, R2);
  check("two mates of the same length: stop eof", clean.ok && clean.stop === "eof" && clean.reads === 2000,
    `${clean.stop} ${clean.reads}`);
  // R2 a quarter short. The extra R1 reads have no mate and were dropped with
  // nothing said: a pair of files that disagree is a damaged sample.
  const short = await pe(R1, R2.slice(0, 1500 * 4));
  check("mates of different lengths are a truncation, not a result",
    short.ok && short.stop === "truncated" && short.reads === 1500, `${short.stop} ${short.reads}`);
  check("...and the detail says so", /R1 and R2 do not hold the same number of reads/.test(short.stopDetail),
    short.stopDetail);
  const badR1 = R1.slice();
  badR1[700 * 4 + 3] = "II";
  const bad = await pe(badR1, R2);
  check("a malformed R1 record truncates the pair", bad.stop === "truncated" && bad.reads === 700,
    `${bad.stop} ${bad.reads}`);

  // THE FALSE ALARM the real-page bench found. One mate slower than the other —
  // R1 cut and resumed mid-download — and the fast one done: the cross-stop
  // then fired on the slow mate right after its LAST chunk, before its reader
  // had said "end of file", and the sample came back "R1 and R2 do not hold the
  // same number of reads" with 2 x 120,000 reads. The cut only says the other
  // mate has nothing left; it never said this one had anything left.
  const timed = (r1, r2, { slow = 1, gz = false } = {}) => {
    const file = (lines, name, pace) => new LocalFile(
      gz ? zlib.gzipSync(fastq(lines)) : fastq(lines), name + (gz ? ".fastq.gz" : ".fastq"), pace);
    return ask("profileFilesPe", {
      r1Files: [file(r1, "r1", slow === 1 ? 2 : 0)],
      r2Files: [file(r2, "r2", slow === 2 ? 2 : 0)],
      maxReads: 3_000_000,
    });
  };
  for (const gz of [false, true]) {
    const kind = gz ? "gzip" : "plain";
    const slowR1 = await timed(R1, R2, { slow: 1, gz });
    check(`equal mates, R1 slow and R2 done first (${kind}): a result, not a truncation`,
      slowR1.ok && slowR1.stop === "eof" && slowR1.reads === 2000,
      `${slowR1.stop} ${slowR1.reads} ${slowR1.stopDetail}`);
    const slowR2 = await timed(R1, R2, { slow: 2, gz });
    check(`...and with R2 the slow one (${kind})`,
      slowR2.ok && slowR2.stop === "eof" && slowR2.reads === 2000, `${slowR2.stop} ${slowR2.reads}`);
    // The real inequality must still be caught, both ways round and however
    // small — including ONE read, which the old count comparison let through.
    const extra = [...R1, ...records(1, "extra")];
    const oneSlow = await timed(extra, R2, { slow: 1, gz });
    check(`R1 one read longer, R1 slow (${kind}): still a truncation`,
      oneSlow.stop === "truncated" && /same number of reads/.test(oneSlow.stopDetail), oneSlow.stop);
    const oneFast = await timed(extra, R2, { slow: 2, gz });
    check(`R1 one read longer, R1 fast (${kind}): still a truncation`, oneFast.stop === "truncated",
      oneFast.stop);
    const r2Longer = await timed(R1, [...R2, ...records(1, "extra2")], { slow: 1, gz });
    check(`R2 one read longer (${kind}): a truncation`, r2Longer.stop === "truncated", r2Longer.stop);
    const many = await timed([...R1, ...records(600, "many")], R2, { slow: 2, gz });
    check(`R1 600 reads longer (${kind}): a truncation`, many.stop === "truncated", many.stop);
  }
}

// ---- cancellation ---------------------------------------------------------------
{
  // Uncompressed, so nothing downstream throws on its own: a cancelled reader
  // resolves with done:true, which is exactly what the end of a file looks like.
  const big = fastq(records(20000, "c"));
  const { id, reply } = send("profileFilesMulti",
    { files: [new LocalFile(big, "c.fastq", 2)], maxReads: 3_000_000 });
  await sleep(40);
  cancel(id);
  const r = await reply;
  check("cancelling an uncompressed FASTQ half-way is NOT a result",
    r.ok === false && r.name === "AbortError", JSON.stringify({ ok: r.ok, name: r.name, reads: r.reads }));
  const after = await profile([new LocalFile(fastq(SE))]);
  check("...and the worker profiles the next sample normally", after.ok && after.reads === 2000,
    after.error ?? String(after.reads));

  // A sample cancelled while it is still WAITING its turn ends without starting.
  const first = send("profileFilesMulti", { files: [new LocalFile(big, "d.fastq", 1)], maxReads: 3_000_000 });
  const second = send("profileFilesMulti", { files: [new LocalFile(fastq(SE))], maxReads: 3_000_000 });
  cancel(second.id);
  const [r1, r2] = await Promise.all([first.reply, second.reply]);
  check("a queued sample cancelled before its turn is cancelled, not run",
    r2.ok === false && r2.name === "AbortError" && !progress.has(second.id), JSON.stringify(r2));
  check("...and the one before it is untouched", r1.ok && r1.reads === 20000, `${r1.reads}`);
}

// ---- one message at a time -------------------------------------------------------
{
  const X = new LocalFile(fastq(records(6000, "x")), "x.fastq", 1);
  const Y = new LocalFile(fastq(records(4000, "y")), "y.fastq", 1);
  const soloX = await profile([X]);
  const soloY = await profile([Y]);
  // What a page with two runs going at once sends one worker.
  const [cx, cy] = await Promise.all([profile([X]), profile([Y])]);
  check("two samples sent together are profiled one after the other, each whole",
    cx.ok && cy.ok && cx.reads === soloX.reads && cy.reads === soloY.reads,
    `${cx.reads}/${soloX.reads}, ${cy.reads}/${soloY.reads}`);
  check("...with the same profiles as alone", cx.tsv === soloX.tsv && cy.tsv === soloY.tsv);

  // A database load arriving mid-sample waits for the sample to finish.
  const during = send("profileFilesMulti", { files: [X], maxReads: 3_000_000 });
  await sleep(20);
  const reload = send("loadDb", { bytes: dbBytes.slice() });
  const [d, l] = await Promise.all([during.reply, reload.reply]);
  check("a loadDb sent during a sample waits for it", d.ok && d.reads === soloX.reads && l.ok,
    `${d.reads} ${d.error ?? ""} ${l.error ?? ""}`);
}

// ---- a database too big for the loaded build ---------------------------------------
{
  // soil.syldb is 2.96 GB and needs ~6 GB of linear memory once loaded. In the
  // 32-bit build the constructor aborted the allocator — `unreachable` — and the
  // worker was unusable until a reload. It is refused before it is read now.
  let read = false;
  const huge = { size: 2_959_289_168, name: "soil.syldb", arrayBuffer: async () => { read = true; throw new Error("read"); } };
  const r = await ask("loadDbFile", { file: huge });
  check("a database that cannot fit the 32-bit build is refused with a sentence",
    r.ok === false && /64-bit build/.test(r.error), r.error);
  check("...before a byte of it is read", read === false);
  const still = await profile([new LocalFile(fastq(SE))]);
  check("...and the database already loaded is still there", still.ok && still.reads === 2000,
    still.error ?? "");
}

// ---- the KEGG reference: bytes from the page, and a failure that answers -----------
if (have(path.join(PKG, "sourmash_bg.wasm")) && have(REF)) {
  const refUrl = pathToFileURL(REF).href;
  const pkg = pathToFileURL(PKG).href;
  // A package that is not there. The error used to escape the handler: no reply,
  // and the page waited for ever behind "Loading the KEGG ortholog reference…".
  const broken = await Promise.race([
    ask("loadFuncRefs", { pkg: pathToFileURL(path.join(HERE, "no-such-pkg")).href, refUrl }),
    sleep(20_000).then(() => ({ timedOut: true })),
  ]);
  check("a failed reference load REPLIES, as a failure", !broken.timedOut && broken.ok === false,
    JSON.stringify(broken).slice(0, 160));

  const before = fetched.filter((u) => u.includes("ko-sketches")).length;
  const bytes = new Uint8Array(fs.readFileSync(REF));
  const ok = await ask("loadFuncRefs", { pkg, refUrl, bytes });
  check("the reference loads from the bytes the page sent", ok.ok && ok.result?.orthologs === 13509,
    ok.error ?? JSON.stringify(ok.result));
  check("...and the worker fetched NOTHING for it",
    fetched.filter((u) => u.includes("ko-sketches")).length === before,
    fetched.filter((u) => u.includes("ko-sketches")).join(", "));
  const withFunc = await profile([new LocalFile(fastq(SE))]);
  check("...and a sample then carries a functional profile", withFunc.ok && withFunc.func !== null,
    withFunc.error ?? "");
  await ask("loadFuncRefs", { on: false });
} else {
  skip += 5;
  console.log("skip the KEGG reference checks — need web/funprofiler-pkg/ and web/db/kegg/");
}

// ---- the promise side: what the pages actually await ---------------------------------
{
  const { rpcOver } = await import("./sylph-worker-rpc.js");
  class FakeWorker {
    constructor() { this.sent = []; this.on = { message: [], error: [] }; }
    postMessage(m) { this.sent.push(m); }
    addEventListener(t, f) { this.on[t].push(f); }
    terminate() { this.terminated = true; }
    reply(data) { for (const f of this.on.message) f({ data }); }
    fail(message) { for (const f of this.on.error) f({ message }); }
  }
  const settle = (p) => p.then((v) => ({ v }), (e) => ({ e }));

  let w = new FakeWorker(), rpc = rpcOver(w);
  let ac = new AbortController();
  const pending = settle(rpc.call("profileFilesMulti", {}, { signal: ac.signal }));
  const id = w.sent[0].id;
  ac.abort();
  const cancelled = await pending;
  check("a cancelled call rejects with an AbortError at once, without waiting for the worker",
    cancelled.e?.name === "AbortError", String(cancelled.e ?? cancelled.v));
  check("...and the worker is told to cancel it",
    w.sent.some((m) => m.type === "cancel" && m.target === id));
  w.reply({ id, ok: true, tsv: "late" });
  check("...and a result arriving afterwards is dropped, never delivered", true);

  const named = settle(rpc.call("profileFilesMulti", {}));
  w.reply({ id: w.sent.at(-1).id, ok: false, error: "cancelled", name: "AbortError" });
  check("a worker reply named AbortError rejects as an AbortError", (await named).e?.name === "AbortError");

  ac = new AbortController(); ac.abort();
  const before = w.sent.length;
  const pre = await settle(rpc.call("profileFilesMulti", {}, { signal: ac.signal }));
  check("a call on an already-cancelled signal rejects without being sent",
    pre.e?.name === "AbortError" && w.sent.length === before);

  // A module worker that fails to load fires `error` and then answers nothing.
  w = new FakeWorker(); rpc = rpcOver(w);
  const held = settle(rpc.call("loadDb", {}));
  w.fail("SyntaxError: the module would not load");
  const heldR = await held;
  check("a worker that dies takes its pending calls down with it",
    heldR.e && /would not load/.test(heldR.e.message), String(heldR.e ?? heldR.v));
  const later = await Promise.race([settle(rpc.call("init", {})), sleep(500).then(() => ({ hung: true }))]);
  check("...and a call made AFTER it died rejects at once instead of waiting for ever",
    !later.hung && later.e && /would not load/.test(later.e.message), JSON.stringify(later));

  w = new FakeWorker(); rpc = rpcOver(w);
  const t1 = settle(rpc.call("profileFilesPe", {}));
  rpc.terminate();
  check("terminate() rejects what was pending", /terminated/.test((await t1).e?.message ?? ""));
  const t2 = await Promise.race([settle(rpc.call("init", {})), sleep(500).then(() => ({ hung: true }))]);
  check("...and every call after it", !t2.hung && /terminated/.test(t2.e?.message ?? ""), JSON.stringify(t2));
}

// ---- real reads, when the fixtures are on disk ---------------------------------------
if (have(FX1)) {
  const real = new LocalFile(fs.readFileSync(FX1), "R1.fastq.gz");
  const solo = await profile([real]);
  const [a, b] = await Promise.all([profile([real]), profile([new LocalFile(fastq(SE))])]);
  check("real reads beside another sample come back identical to real reads alone",
    a.ok && a.tsv === solo.tsv && a.reads === solo.reads && solo.tsv.trim().split("\n").length > 1,
    `${a.reads} vs ${solo.reads}`);
  void b;
} else {
  skip += 1;
  console.log(`skip the real-reads check — need ${path.relative(HERE, FX1)}`);
}

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ""} (worker)`);
process.exit(fail ? 1 : 0);
