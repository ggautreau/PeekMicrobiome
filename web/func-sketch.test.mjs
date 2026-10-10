// web/func-sketch.js — the second reading of the reads, in protein space.
//
//   node web/func-sketch.test.mjs
//
// WHAT IS ACTUALLY AT RISK HERE. The sketcher is handed bytes by four different
// feed paths in the worker, at boundaries nobody chooses: a chunk ends in the
// middle of a quality line, a pair of downloads interleaves, a fallback delivers
// the whole sample at once. None of that changes the answer if the reader is
// right, and all of it changes the answer silently if it is not — a broken
// reader does not throw, it returns a smaller profile that looks like a sample
// with fewer functions in it. So these checks feed the SAME reads through
// different-shaped streams and demand the same profile out.
//
// The sketch itself needs the sourmash wasm (web/funprofiler-pkg, in this
// repository) and the KEGG ortholog reference (web/db/kegg/, 20 MB, also here
// because the page downloads it); without them nothing runs, and it says so.
// The stream shapes are checked twice: on reads made up here, which need
// nothing and so run in CI, comparing the sketch itself; and on the FASTQ
// fixtures in scripts/ena-test/fx/, which are not in the repository, comparing
// the KEGG profile as well — skipped, and said so, where they are absent.

import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, "funprofiler-pkg");
const REF = path.join(HERE, "db/kegg/ko-sketches-k11.ndjson.gz");
const FX1 = path.join(HERE, "../scripts/ena-test/fx/R1.fastq.gz");
const FX2 = path.join(HERE, "../scripts/ena-test/fx/R2.fastq.gz");

let pass = 0, fail = 0, skip = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const have = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

if (!have(PKG + "/sourmash_bg.wasm") || !have(REF)) {
  skip += 25;
  console.log(`skip the sketcher — needs ${path.relative(HERE, PKG)}/ and ` +
    `${path.relative(HERE, REF)}`);
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped (func-sketch)`);
  process.exit(0);
}

// func-sketch.js fetches its two files, because in the browser they come over
// HTTP. Here they come off the disk; nothing in this test reaches the network.
globalThis.fetch = async (u) => {
  const p = String(u).startsWith("file:") ? fileURLToPath(String(u)) : String(u);
  return new Response(fs.readFileSync(p), { status: 200 });
};

const { loadFuncRefs, funcRefsLoaded, newFuncSample } = await import("./func-sketch.js");

check("no sketch before the reference is loaded", !funcRefsLoaded() && newFuncSample() === null);

const info = await loadFuncRefs({ pkg: "file://" + PKG, refUrl: "file://" + REF });
check("the reference holds the 13,509 KEGG orthologs fmh-funprofiler ships",
  info.orthologs === 13509, String(info.orthologs));
check("loading twice loads once",
  (await loadFuncRefs({ pkg: "file://" + PKG, refUrl: "file://" + REF })).orthologs === 13509);

// The archive names members by the md5 of the sketch and suffixes collisions
// `.sig.gz_0`. Four orthologs are hash-for-hash copies of four others and live
// only under that suffix; a reader that matches `.sig.gz` alone loses them, and
// sourmash would then report a twin the page cannot. Empty sketches collide the
// same way, and can never match, so none should be shipped.
{
  const refs = zlib.gunzipSync(fs.readFileSync(REF)).toString("utf8").trim().split("\n")
    .map((l) => JSON.parse(l)[0]);
  const names = new Set(refs.map((s) => s.name.split(" ")[0]));
  const twins = ["K02370", "K16419", "K22332", "K24408"].filter((k) => !names.has("ko:" + k));
  check("the four orthologs stored under a collision suffix are in the reference",
    twins.length === 0, "missing " + twins.join(", "));
  const empty = refs.filter((s) => !s.signatures.some((m) => m.ksize === 33 && m.mins.length));
  check("no empty sketch is shipped", empty.length === 0,
    empty.map((s) => s.name.split(" ")[0]).join(", "));
}

// ---- the stream shapes, on reads made up here ---------------------------------
//
// The defect this file exists for — two mates through ONE parser state, which
// loses the 4-line record phase and three quarters of the sketch — is a property
// of the parser, not of the reads. So the shapes are fed here first with reads
// that need no fixture: random DNA from a fixed seed, every record shaped like
// the fixtures' (100 to 160 bp, a quality line as long, R2 the reverse
// complement of R1 with its quality reversed). They match no ortholog, so the
// profile is empty; what is compared is the sketch — how many reads went in and
// how many hashes it kept — which is exactly what a lost record phase changes.
// This is what CI runs; the fixtures below add the KEGG profile on real reads.
{
  let seed = 0x5eed1e55;
  const rand = () => {                      // mulberry32: small, fixed, portable
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const QUAL = "#,:FIJ";
  const COMP = { A: "T", C: "G", G: "C", T: "A" };
  const recs = [];
  for (let i = 0; i < 5000; i++) {
    const len = 100 + Math.floor(rand() * 61);
    let seq = "", qual = "";
    for (let j = 0; j < len; j++) {
      seq += "ACGT"[Math.floor(rand() * 4)];
      qual += QUAL[Math.floor(rand() * QUAL.length)];
    }
    recs.push({ id: `syn.${i}`, seq, qual });
  }
  const fq = (rs) => Buffer.from(rs.map((r) => `@${r.id}\n${r.seq}\n+\n${r.qual}\n`).join(""), "latin1");
  const S1 = fq(recs);
  const S2 = fq(recs.map((r) => ({
    id: `${r.id}/2`,
    seq: [...r.seq].reverse().map((c) => COMP[c]).join(""),
    qual: [...r.qual].reverse().join(""),
  })));
  const sketch = (bytes, chunk, stream = 0) => {
    const s = newFuncSample();
    if (chunk === Infinity) s.feed(bytes, stream);
    else for (let i = 0; i < bytes.length; i += chunk) s.feed(bytes.subarray(i, i + chunk), stream);
    return s.finish();
  };
  const alike = (a, b) => a.reads === b.reads && a.hashes === b.hashes
    && JSON.stringify(a.profile) === JSON.stringify(b.profile);
  const said = (x) => `${x.reads} reads, ${x.hashes} hashes`;

  const whole = sketch(S1, Infinity);
  check("made-up reads: 5,000 reads in, a sketch of several hundred hashes out",
    whole.reads === 5000 && whole.hashes > 300, said(whole));
  const by7919 = sketch(S1, 7919), by1 = sketch(S1, 1);
  check("made-up reads: chunked at 7,919 bytes — the same sketch", alike(whole, by7919), said(by7919));
  check("made-up reads: chunked at 1 byte — the same sketch", alike(whole, by1), said(by1));

  const pe = newFuncSample();
  pe.feed(S1, 1);
  pe.feed(S2, 2);
  const peWhole = pe.finish();
  const il = newFuncSample();
  for (let i = 0; i < Math.max(S1.length, S2.length); i += 4111) {
    if (i < S1.length) il.feed(S1.subarray(i, i + 4111), 1);
    if (i < S2.length) il.feed(S2.subarray(i, i + 4111), 2);
  }
  const ilDone = il.finish();
  check("made-up reads: interleaved mates give the same sketch as whole mates",
    alike(peWhole, ilDone), `${said(ilDone)} against ${said(peWhole)}`);
  check("made-up reads: ...and the same as one mate after the other on one stream",
    alike(peWhole, sketch(Buffer.concat([S1, S2]), 4111, 0)));

  const conflated = newFuncSample();
  for (let i = 0; i < Math.max(S1.length, S2.length); i += 4111) {
    if (i < S1.length) conflated.feed(S1.subarray(i, i + 4111), 0);
    if (i < S2.length) conflated.feed(S2.subarray(i, i + 4111), 0);
  }
  const bad = conflated.finish();
  check("made-up reads: two mates through ONE parser state lose most of the sketch",
    bad.hashes < peWhole.hashes / 2,
    `${bad.hashes} hashes against ${peWhole.hashes} — if these are equal the per-stream ` +
    `state has stopped doing anything and this check no longer bites`);

  // R2 is R1's reverse complement, and six frames read a sequence and its
  // reverse complement into the same k-mers: twice the reads, the same sketch.
  check("made-up reads: both mates are read, and a strand pair is one sketch in six frames",
    peWhole.reads === 10000 && peWhole.hashes === whole.hashes, said(peWhole));

  check("made-up reads: a stream that does not end in a newline keeps its last read",
    sketch(S1.subarray(0, S1.length - 1), 7919).reads === 5000);

  const dropped = newFuncSample();
  dropped.feed(S1.subarray(0, 100000), 0);
  dropped.drop();
  dropped.feed(S1.subarray(100000), 0);
  check("made-up reads: a dropped sample takes no more reads and returns nothing",
    dropped.finish() === null);
}

// Everything below sketches the parity fixtures in scripts/ena-test/fx/ —
// gitignored and fetched on demand, so absent from a CI checkout. The checks
// above need no fixture, and they still run there.
if (!have(FX1) || !have(FX2)) {
  skip += 11;
  console.log(`skip the read checks — need the FASTQ fixtures in ` +
    `${path.relative(HERE, path.dirname(FX1))}/`);
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped (func-sketch)`);
  process.exit(fail ? 1 : 0);
}

/** The first `n` records of a gzipped fixture, as the bytes a feed path hands over. */
const reads = (p, n) => {
  const lines = zlib.gunzipSync(fs.readFileSync(p)).toString("latin1").split("\n");
  return Buffer.from(lines.slice(0, n * 4).join("\n") + "\n", "latin1");
};
const same = (a, b) => JSON.stringify(a.profile) === JSON.stringify(b.profile);
const one = (bytes, chunk, stream = 0) => {
  const s = newFuncSample();
  if (chunk === Infinity) s.feed(bytes, stream);
  else for (let i = 0; i < bytes.length; i += chunk) s.feed(bytes.subarray(i, i + chunk), stream);
  return s.finish();
};

const R1 = reads(FX1, 5000);
const R2 = reads(FX2, 5000);

// ---- single-end: the answer must not depend on where the chunks fall ---------
const whole = one(R1, Infinity);
check("5,000 reads give a profile that sums to 1",
  whole.reads === 5000 && Math.abs(Object.values(whole.profile).reduce((a, v) => a + v, 0) - 1) < 1e-9,
  `${whole.reads} reads, ${Object.keys(whole.profile).length} orthologs`);
// 7919 is prime and larger than a record, so no chunk boundary lands on the same
// place twice; 1 puts every boundary inside a line. Both are the reader's job.
check("chunked at 7,919 bytes — same profile", same(whole, one(R1, 7919)));
check("chunked at 1 byte — same profile", same(whole, one(R1, 1)));

// ---- paired: two streams, one sketch ----------------------------------------
//
// This is the check that caught a real defect. The worker's paired path calls
// back from both downloads as their bytes arrive, in whatever order the network
// delivers them. Through one parser state, R2's bytes land on the end of a
// half-read R1 line and the 4-line phase is lost for the rest of the file: the
// sketch keeps 247 of 1,054 hashes and the sample loses three quarters of its
// functions, with nothing thrown and nothing logged.
const pe = newFuncSample();
pe.feed(R1, 1);
pe.feed(R2, 2);
const peWhole = pe.finish();

const il = newFuncSample();
for (let i = 0; i < Math.max(R1.length, R2.length); i += 4111) {
  if (i < R1.length) il.feed(R1.subarray(i, i + 4111), 1);
  if (i < R2.length) il.feed(R2.subarray(i, i + 4111), 2);
}
check("interleaved mates give the same profile as whole mates",
  same(peWhole, il.finish()));

const merged = one(Buffer.concat([R1, R2]), 4111, 0);
check("...and the same as reading one mate after the other on one stream",
  same(peWhole, merged));

const conflated = newFuncSample();
for (let i = 0; i < Math.max(R1.length, R2.length); i += 4111) {
  if (i < R1.length) conflated.feed(R1.subarray(i, i + 4111), 0);
  if (i < R2.length) conflated.feed(R2.subarray(i, i + 4111), 0);
}
const bad = conflated.finish();
check("interleaving two mates through ONE parser state loses most of the sketch",
  bad.hashes < peWhole.hashes / 2,
  `${bad.hashes} hashes against ${peWhole.hashes} — if these are equal the ` +
  `per-stream state has stopped doing anything and this test no longer bites`);

// ---- both mates belong to the same sample -----------------------------------
//
// The fixture's R2 is the exact reverse complement of R1 — it was built that way
// for the trimmer's parity tests — and six-frame translation reads a sequence
// and its reverse complement into the SAME six frames. So the pair contributes
// the same amino-acid k-mers as R1 alone, and this check says exactly that:
// 10,000 reads went in, and the sketch is byte-for-byte the one mate's.
//
// It is not a tautology. It only holds if the mates really are translated in six
// frames; a sketcher that read one strand would give the pair a larger sketch
// than either mate, and this line would fail.
const r1Only = one(R1, Infinity, 1);
check("both mates are read, and six-frame translation makes a strand pair one sketch",
  peWhole.reads === 10000 && r1Only.reads === 5000 && same(peWhole, r1Only)
    && peWhole.hashes === r1Only.hashes,
  `${peWhole.reads} reads / ${peWhole.hashes} hashes against ${r1Only.reads} / ${r1Only.hashes}`);

// ---- a cancelled sample must not be usable, or leak -------------------------
const dropped = newFuncSample();
dropped.feed(R1.subarray(0, 100000), 0);
dropped.drop();
dropped.feed(R1.subarray(100000), 0);
check("a dropped sample takes no more reads and returns nothing",
  dropped.finish() === null);

// ---- a file with no trailing newline holds its last read in the carry -------
const noNl = R1.subarray(0, R1.length - 1);
check("a stream that does not end in a newline keeps its last read",
  one(noNl, 7919).reads === 5000, String(one(noNl, 7919).reads));

// ---- the bytes path, which is what the pool actually uses --------------------
//
// Each worker is its own realm, so the module-level memo cannot be shared
// between them: handing every worker the URL produced one download per worker —
// eight copies of the same 20 MB file under a line promising "once". The page
// downloads once and hands over the compressed bytes now, and what comes out has
// to be the same profile.
{
  const raw = fs.readFileSync(REF);
  const mod = await import("./func-sketch.js?bytes=1");
  const info2 = await mod.loadFuncRefs({ pkg: "file://" + PKG, bytes: raw });
  check("the reference loads from bytes the caller already holds",
    info2.orthologs === 13509, String(info2.orthologs));
  const viaBytes = mod.newFuncSample();
  viaBytes.feed(R1, 0);
  check("...and gives the same profile as the URL path",
    JSON.stringify(viaBytes.finish().profile) === JSON.stringify(whole.profile));
}

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ""} (func-sketch)`);
process.exit(fail ? 1 : 0);
