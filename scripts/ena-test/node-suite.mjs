// The bench for web/ena.js — accession resolution, and the resumable read
// source that feeds streamCore.
//
//   node scripts/ena-test/node-suite.mjs
//
// Nothing here touches the real ENA. The API half runs against a fetch that is
// handed to the module (so the fixtures are exactly the shapes ENA really
// returns, including the awkward ones), and the streaming half runs against
// scripts/flaky_server.py — real HTTP, real Range headers, real cuts, real
// sockets slammed shut mid-body.
//
// The question every streaming scenario asks is the same one db-cache's bench
// asks, and it is NOT "did it error": it is "are the bytes it delivered byte for
// byte the file the server holds". A resume that quietly re-delivers a prefix,
// or drops one, produces a sketch that is wrong with no symptom at all — the
// TSV comes out, it is simply not the sample's.
//
// Every mechanism in ena.js has a scenario here that FAILS if the mechanism is
// removed. Where that is not obvious the scenario says which line it is holding.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PORT = Number(process.env.ENA_SUITE_PORT ?? 8823);
const CHUNKED_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "ena-"));
const ROOT = path.join(SCRATCH, "root");
const LOG = path.join(SCRATCH, "server.jsonl");

const {
  resolveAccession, validateAccession, normaliseAccession, parseRunRow, fastqUrl,
  urlSource, totalBytes, etaSeconds, rateMeter, ACCESSION_RE, ENA_PORTAL_API,
  MAX_RANGE_RESTARTS, downloadEstimate, readCountVerdict,
} = await import(path.join(REPO, "web/ena.js"));
const { streamTrimMulti, readAndTrim } = await import(path.join(REPO, "web/fastq-trim.js"));
const { gzipSync } = await import(path.join(REPO, "web/vendor/fflate.js"));

let passes = 0, failures = 0;
function check(name, ok, detail = "") {
  if (ok) passes++; else failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `   [${detail}]` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash("sha256").update(b).digest("hex");

// Anything the source is given in this file retries fast: the waits are the
// product under test elsewhere (they are asserted directly), not something to
// sit through 200 times.
// `allowHosts` because urlSource() now applies the EBI allow-list ITSELF, at
// the fetch rather than only at resolution — the bench serves from 127.0.0.1,
// which is not the EBI, and saying so here is the point: nothing gets to fetch
// from an arbitrary host by accident, tests included.
const FAST = {
  progressRetryMs: 5, backoff: [5, 10, 20, 40, 80, 100],
  allowHosts: [/^127\.0\.0\.1$/],
};

// ---- fixtures ----------------------------------------------------------------

function makeFastq(nRecords, seed = 1) {
  // xorshift32, not the classic LCG: `x * 1103515245` leaves the float53 range
  // and the low bits collapse, which makes the "random" bases repeat and the
  // gzip fixture compress 30x. A fixture that compresses away is a fixture that
  // fits in one network chunk, and every streaming scenario below then passes
  // for the wrong reason.
  let x = seed >>> 0 || 1;
  const rnd = () => {
    x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
  const bases = "ACGT";
  let out = "";
  for (let i = 0; i < nRecords; i++) {
    const len = 90 + Math.floor(rnd() * 60);
    let seq = "";
    for (let j = 0; j < len; j++) seq += bases[Math.floor(rnd() * 4)];
    // Quality is pseudo-random rather than a run of "I": a FASTQ whose quality
    // lines are constant compresses 20x, and the gzip fixture would then be
    // smaller than a single network chunk — which quietly turns every streaming
    // scenario below into "one request, done".
    let qual = "";
    for (let j = 0; j < len; j++) qual += String.fromCharCode(35 + Math.floor(rnd() * 40));
    out += `@read_${i}/1 len=${len}\n${seq}\n+\n${qual}\n`;
  }
  return Buffer.from(out, "utf8");
}

const PLAIN = makeFastq(4000);                    // ~1.2 MB
const PLAIN_ALT = makeFastq(4000, 99);            // different bytes
const GZ = Buffer.from(gzipSync(new Uint8Array(PLAIN)));

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, "f"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "f/reads.fastq"), PLAIN);
fs.writeFileSync(path.join(ROOT, "f/reads.fastq.gz"), GZ);
// Same length, different content, and an older mtime so Last-Modified really
// differs — written in the same second it would be indistinguishable and the
// "file republished mid-read" scenario would silently test nothing.
const ALT = path.join(ROOT, "f/alt.fastq");
fs.writeFileSync(ALT, PLAIN_ALT.subarray(0, PLAIN.length));
fs.utimesSync(ALT, new Date(Date.now() - 7200_000), new Date(Date.now() - 7200_000));

const PLAIN_URL = `${BASE}/f/reads.fastq`;
const GZ_URL = `${BASE}/f/reads.fastq.gz`;
const LOCAL = [/^127\.0\.0\.1$/];

// ---- the flaky server --------------------------------------------------------

let server = null;
async function startServer(target, extra = []) {
  await stopServer();
  server = spawn("python3", [
    path.join(REPO, "scripts/flaky_server.py"),
    "--root", ROOT, "--port", String(PORT), "--log", LOG, "--target", target, ...extra,
  ], { stdio: ["ignore", "ignore", process.env.VERBOSE ? "inherit" : "ignore"] });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/_reset`)).ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error("flaky_server did not start");
}
async function stopServer() {
  if (!server) return;
  server.kill("SIGKILL");
  server = null;
  await sleep(150);
}
function hits(target) {
  if (!fs.existsSync(LOG)) return [];
  return fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((l) => l && l.path === target);
}

// Read a source's stream to the end, collecting everything it delivers. On
// failure it returns what HAD been delivered — which is the interesting half:
// a partial delivery must always be a strict PREFIX of the real file.
async function drain(src, { limitMs = 120_000 } = {}) {
  const parts = [];
  let err = null;
  const reader = src.stream().getReader();
  const deadline = setTimeout(() => reader.cancel(new Error("bench timeout")).catch(() => {}), limitMs);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value?.length) parts.push(Buffer.from(value));
    }
  } catch (e) {
    err = e;
  } finally {
    clearTimeout(deadline);
    try { await reader.cancel(); } catch { /* already gone */ }
  }
  return { bytes: Buffer.concat(parts), err };
}

// =============================================================================
// 1. Accession input — what never reaches the network
// =============================================================================
console.log("\n== accession validation ==");
{
  check("a run accession is accepted", validateAccession("ERR14098592").ok);
  check("a project accession is accepted", validateAccession("PRJEB83730").ok);
  check("a sample accession is accepted", validateAccession("SAMEA115468000").ok);
  check("lower case is normalised", normaliseAccession(" err14098592 ") === "ERR14098592");
  check("a pasted browser URL is reduced to the accession",
    normaliseAccession("https://www.ebi.ac.uk/ena/browser/view/PRJEB83730") === "PRJEB83730");

  for (const bad of ["", "   ", "ERR", "123456", "E1", "ABCDEFG123", "ERR 14098592",
    "ERR14098592;DROP", "../../etc/passwd", "*", "%2E%2E", "ERR14098592&fields=x",
    "https://evil.example/x?a=b"]) {
    check(`refused: ${JSON.stringify(bad)}`, validateAccession(bad).ok === false);
  }
  check("the refusal says what an accession looks like",
    /3–6 letters/.test(validateAccession("nope").error), validateAccession("nope").error);
  check("the regex is anchored at both ends",
    !ACCESSION_RE.test("xERR123") && !ACCESSION_RE.test("ERR123x"));
  check("the default endpoint is the EBI's", /^https:\/\/www\.ebi\.ac\.uk\//.test(ENA_PORTAL_API));
}

console.log("\n== resolveAccession: nothing is sent before the input is checked ==");
{
  // THE mechanism: a string that is not an accession must not produce a request
  // at all. A validator that runs after the fetch is not a validator.
  let calls = 0;
  const spy = async (u) => { calls++; return new Response("[]", { status: 200 }); };
  for (const bad of ["ERR", "; rm -rf /", "ERR1 OR 1=1", "https://evil.example/"]) {
    let threw = null;
    try { await resolveAccession(bad, { fetchImpl: spy }); } catch (e) { threw = e; }
    check(`no request for ${JSON.stringify(bad)}`, threw !== null && calls === 0,
      `calls=${calls}`);
  }

  // And when it IS an accession, the value is encoded rather than pasted.
  let seen = null;
  const capture = async (u) => {
    seen = u;
    return new Response(JSON.stringify([{
      run_accession: "ERR1", library_layout: "SINGLE",
      fastq_ftp: "127.0.0.1/f/reads.fastq", fastq_bytes: "10", read_count: "5",
    }]), { status: 200 });
  };
  await resolveAccession("err14098592", { fetchImpl: capture, allowHosts: LOCAL, apiBase: `${BASE}/api` });
  check("the accession is uppercased into the query", /accession=ERR14098592(&|$)/.test(seen), seen);
  check("the query asks for read_run and json", /result=read_run/.test(seen) && /format=json/.test(seen));
  check("the source encodes the accession", /encodeURIComponent/.test(
    fs.readFileSync(path.join(REPO, "web/ena.js"), "utf8")));
}

console.log("\n== resolveAccession: the answers ENA really gives ==");
{
  const api = (rows, init = {}) => async () =>
    new Response(typeof rows === "string" ? rows : JSON.stringify(rows), { status: 200, ...init });

  // An accession that does not exist is an EMPTY ARRAY with status 200. Treating
  // "ok" as "found" is how a typo becomes a run with zero samples and no error.
  let threw = null;
  try { await resolveAccession("ERR999999999", { fetchImpl: api([]) }); } catch (e) { threw = e; }
  check("an unknown accession is an error, not an empty run list",
    threw !== null && /no sequencing runs found/.test(threw.message), threw?.message);

  threw = null;
  try {
    await resolveAccession("ERR1", { fetchImpl: async () => new Response("nope", { status: 503 }) });
  } catch (e) { threw = e; }
  check("an HTTP error names the status", threw !== null && /503/.test(threw.message), threw?.message);

  threw = null;
  try {
    await resolveAccession("ERR1", { fetchImpl: api("<html>maintenance</html>") });
  } catch (e) { threw = e; }
  check("a non-JSON body is reported, with an excerpt",
    threw !== null && /did not answer with JSON/.test(threw.message) && /maintenance/.test(threw.message),
    threw?.message);

  threw = null;
  try {
    await resolveAccession("ERR1", { fetchImpl: async () => { throw new TypeError("network down"); } });
  } catch (e) { threw = e; }
  check("an unreachable API says so plainly",
    threw !== null && /could not reach the ENA API/.test(threw.message), threw?.message);

  // A run with no FASTQ at all (BAM/CRAM only submission). It stays in the list,
  // unusable, with a reason — dropping it silently from a 85-run project leaves
  // the user counting samples.
  const [noFastq] = await resolveAccession("ERR1", {
    fetchImpl: api([{ run_accession: "ERR1", library_layout: "PAIRED", fastq_ftp: "", fastq_bytes: "", read_count: "100" }]),
  });
  check("a run with no fastq_ftp is kept and marked unusable",
    noFastq.usable === false && /no FASTQ files/.test(noFastq.problem), noFastq.problem);

  // PAIRED with a single URL: only one mate was archived. Handing that to the
  // paired path would wait for ever for a mate that does not exist.
  const [oneMate] = await resolveAccession("ERR2", {
    fetchImpl: api([{
      run_accession: "ERR2", library_layout: "PAIRED",
      fastq_ftp: "ftp.sra.ebi.ac.uk/vol1/fastq/ERR2/ERR2.fastq.gz",
      fastq_bytes: "12345", read_count: "100",
    }]),
  });
  check("PAIRED with one file degrades to single-end", oneMate.layout === "SINGLE" && oneMate.usable);
  check("...and says why", /only one FASTQ/.test(oneMate.note), oneMate.note);

  // PAIRED, two files, and only ONE of them is named _1. The positional
  // fallback ("take the first two") must NOT run here: it would hand sylph a
  // file of orphan reads as R1 and the real _1 as R2 — two streams that are not
  // mates, paired record by record, truncated to the shorter of the two, and
  // presented as a paired run. The note that used to be shown was itself false
  // ("the two files are not named _1/_2" — one of them is).
  const [halfNamed] = await resolveAccession("ERR7", {
    fetchImpl: api([{
      run_accession: "ERR7", library_layout: "PAIRED",
      fastq_ftp: "ftp.sra.ebi.ac.uk/x/ERR7.fastq.gz;ftp.sra.ebi.ac.uk/x/ERR7_1.fastq.gz",
      fastq_bytes: "10;20", read_count: "100",
    }]),
  });
  check("PAIRED with only ONE mate named is not paired positionally",
    halfNamed.layout === "SINGLE",
    `${halfNamed.layout}: ${halfNamed.files.map((f) => f.name).join(",")}`);
  check("...the file that IS a named mate is the one profiled",
    halfNamed.files.length === 1 && halfNamed.files[0].name === "ERR7_1.fastq.gz",
    halfNamed.files.map((f) => f.name).join(","));
  check("...the note is true: it names the mate and the file left out",
    /ERR7_1\.fastq\.gz is named _1\/_2/.test(halfNamed.note)
    && /ERR7\.fastq\.gz/.test(halfNamed.note)
    && !/the two files are not named/.test(halfNamed.note), halfNamed.note);
  check("...and the size is the one file's, not both",
    halfNamed.bytes === 20, String(halfNamed.bytes));

  // Neither file is named: position really is all there is, and the note that
  // says so is now the truth rather than a default.
  const [unnamed] = await resolveAccession("ERR8", {
    fetchImpl: api([{
      run_accession: "ERR8", library_layout: "PAIRED",
      fastq_ftp: "ftp.sra.ebi.ac.uk/x/a.fastq.gz;ftp.sra.ebi.ac.uk/x/b.fastq.gz",
      fastq_bytes: "10;20", read_count: "100",
    }]),
  });
  check("PAIRED with NO named mate still falls back to position",
    unnamed.layout === "PAIRED" && unnamed.files.length === 2
    && /not named _1\/_2/.test(unnamed.note), `${unnamed.layout}: ${unnamed.note}`);

  // The common three-file PAIRED row: _1, _2 and an unpaired leftover.
  const [three] = await resolveAccession("ERR3", {
    fetchImpl: api([{
      run_accession: "ERR3", library_layout: "PAIRED",
      fastq_ftp: "ftp.sra.ebi.ac.uk/x/ERR3.fastq.gz;ftp.sra.ebi.ac.uk/x/ERR3_1.fastq.gz;ftp.sra.ebi.ac.uk/x/ERR3_2.fastq.gz",
      fastq_bytes: "10;20;30", read_count: "100",
    }]),
  });
  check("three files: the _1/_2 pair is the one taken",
    three.layout === "PAIRED" && three.files.length === 2
    && three.files[0].name === "ERR3_1.fastq.gz" && three.files[1].name === "ERR3_2.fastq.gz",
    three.files.map((f) => f.name).join(","));
  check("...the leftover is reported, not hidden", /unpaired/.test(three.note), three.note);
  check("...and the size is the pair's, not all three", three.bytes === 50, String(three.bytes));

  // Sizes missing: unknown must not become zero, or a 2 GB download is announced
  // as "0 B".
  const [nosize] = await resolveAccession("ERR4", {
    fetchImpl: api([{
      run_accession: "ERR4", library_layout: "SINGLE",
      fastq_ftp: "ftp.sra.ebi.ac.uk/x/ERR4.fastq.gz", fastq_bytes: "", read_count: "",
    }]),
  });
  check("a missing fastq_bytes is unknown, not zero",
    Number.isNaN(nosize.files[0].bytes) && nosize.bytesUnknown === 1);
  check("a missing read_count is unknown too", Number.isNaN(nosize.reads));
  const t = totalBytes([nosize, three]);
  check("totals keep the unknown count separate", t.bytes === 50 && t.unknown === 1, JSON.stringify(t));

  // fastq_ftp has no scheme. Prefixing by hand is where an injection would live.
  check("a schemeless URL becomes https", three.files[0].url.startsWith("https://ftp.sra.ebi.ac.uk/"),
    three.files[0].url);
  check("an ftp:// URL becomes https too",
    fastqUrl("ftp://ftp.sra.ebi.ac.uk/x/a.fastq.gz").url === "https://ftp.sra.ebi.ac.uk/x/a.fastq.gz");

  // THE host allow-list. `fastq_ftp` is data from a remote service; following it
  // anywhere it points would send the user's browser (and IP) to a host they
  // never asked for, from a page whose entire promise is about where data goes.
  const [evil] = await resolveAccession("ERR5", {
    fetchImpl: api([{
      run_accession: "ERR5", library_layout: "SINGLE",
      fastq_ftp: "evil.example.com/steal.fastq.gz;ftp.sra.ebi.ac.uk/x/ERR5.fastq.gz",
      fastq_bytes: "10;20", read_count: "9",
    }]),
  });
  check("a file on a non-EBI host is dropped",
    evil.files.length === 1 && evil.files[0].url.includes("ftp.sra.ebi.ac.uk"),
    evil.files.map((f) => f.url).join(","));
  check("...and the user is told it was dropped", /evil\.example\.com/.test(evil.note), evil.note);
  check("a lookalike host does not pass either",
    fastqUrl("ebi.ac.uk.evil.example/x.gz")?.blocked === "ebi.ac.uk.evil.example");
  check("a subdomain of the real host does pass",
    fastqUrl("ftp.sra.ebi.ac.uk/x.gz").url.startsWith("https://ftp.sra.ebi.ac.uk/"));
  check("a javascript: URL is refused outright", fastqUrl("javascript:alert(1)") === null);

  // A plaintext URL from a page served over https. The browser blocks mixed
  // content anyway, but a refusal that comes from HERE lands in the run's note
  // where the user can read it, instead of surfacing as a console-only failure
  // half a minute into a download.
  {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", {
      value: { protocol: "https:" }, configurable: true, writable: true,
    });
    try {
      check("http: is refused when the page itself is https",
        /over plain http/.test(fastqUrl("http://ftp.sra.ebi.ac.uk/x.gz")?.blocked ?? ""),
        JSON.stringify(fastqUrl("http://ftp.sra.ebi.ac.uk/x.gz")));
      check("...while the https form of the same URL is not",
        fastqUrl("https://ftp.sra.ebi.ac.uk/x.gz")?.url === "https://ftp.sra.ebi.ac.uk/x.gz");
    } finally {
      if (saved) Object.defineProperty(globalThis, "location", saved);
      else delete globalThis.location;
    }
  }

  // fastq_ftp and fastq_bytes are PARALLEL lists. An empty slot in one of them
  // must not shift the others: dropping it would attach the wrong size to every
  // later file, and a wrong size is a wrong download total and a wrong ETA with
  // no other symptom.
  const [gappy] = await resolveAccession("ERR6", {
    fetchImpl: api([{
      run_accession: "ERR6", library_layout: "SINGLE",
      fastq_ftp: "ftp.sra.ebi.ac.uk/x/a.fastq.gz;ftp.sra.ebi.ac.uk/x/b.fastq.gz;ftp.sra.ebi.ac.uk/x/c.fastq.gz",
      fastq_bytes: "100;;300", read_count: "9",
    }]),
  });
  check("a gap in fastq_bytes does not shift the sizes of the files after it",
    gappy.files.map((f) => (Number.isFinite(f.bytes) ? f.bytes : "?")).join(",") === "100,?,300",
    gappy.files.map((f) => `${f.name}=${f.bytes}`).join(" "));
  check("...and the unknown one is counted as unknown, not as zero",
    gappy.bytesUnknown === 1 && gappy.bytes === 400, `${gappy.bytes} / ${gappy.bytesUnknown}`);

  // Several runs come back sorted, so a project of 85 is readable.
  const many = await resolveAccession("PRJEB1", {
    fetchImpl: api([
      { run_accession: "ERR9", library_layout: "SINGLE", fastq_ftp: "ftp.sra.ebi.ac.uk/x/ERR9.fastq.gz", fastq_bytes: "3", read_count: "1" },
      { run_accession: "ERR2", library_layout: "SINGLE", fastq_ftp: "ftp.sra.ebi.ac.uk/x/ERR2.fastq.gz", fastq_bytes: "2", read_count: "1" },
    ]),
  });
  check("runs come back sorted by accession", many.map((r) => r.run).join(",") === "ERR2,ERR9");

  // The ETA arithmetic the UI shows before a click.
  check("eta is bytes/rate", etaSeconds(8 * 1024 * 1024, 4 * 1024 * 1024) === 2);
  check("eta of an unknown size is unknown, not zero", Number.isNaN(etaSeconds(NaN, 1000)));
  check("eta at an impossible rate is unknown", Number.isNaN(etaSeconds(10, 0)));
}

console.log("\n== what the download is going to cost, before the click ==");
{
  const MB = 1024 ** 2;
  const run = (bytes, reads, unknown = 0) => ({ bytes, reads, bytesUnknown: unknown });

  // The plain case: nothing capped, everything known.
  const plain = downloadEstimate([run(100 * MB, 1000), run(100 * MB, 1000)],
    { maxReads: 10_000, bps: 4 * MB });
  check("a total is the sum of the runs", plain.bytes === 200 * MB, String(plain.bytes));
  check("...with an ETA in seconds", plain.seconds === 50, String(plain.seconds));
  check("...and it is not marked as capped", plain.capped === false);

  // THE read cap. streamCore stops on the 4*maxReads-th newline and cancels the
  // download, so a run profiled at 1 M of its 6 M reads transfers about a sixth
  // of its bytes. Announcing the whole file is how a user walks away from an
  // analysis that would have taken twenty minutes.
  const capped = downloadEstimate([run(600 * MB, 6_000_000)], { maxReads: 1_000_000, bps: 4 * MB });
  check("the read cap bounds the estimate", capped.bytes === 100 * MB, String(capped.bytes));
  check("...and the estimate says it was bounded", capped.capped === true);
  check("...while a cap above the run changes nothing",
    downloadEstimate([run(600 * MB, 6_000_000)], { maxReads: 60_000_000 }).bytes === 600 * MB);
  check("a run with no read_count is not scaled by the cap",
    downloadEstimate([run(600 * MB, NaN)], { maxReads: 1000 }).bytes === 600 * MB);

  // UNKNOWN sizes. NaN sums as 0, so a project whose rows have no fastq_bytes
  // was announced as "0 B … about 0 s" in front of tens of gigabytes. An
  // estimate that cannot be made must not be printed as a number.
  const unknown = downloadEstimate([{ bytes: 0, bytesUnknown: 3, reads: 1000 }], { maxReads: 1e9 });
  check("an unknown size does not become a zero-byte total",
    unknown.unknown === 3 && unknown.bytes === 0);
  check("...and no ETA is offered for it",
    unknown.estimable === false && Number.isNaN(unknown.seconds), String(unknown.seconds));
  check("one unknown among known sizes still refuses the ETA",
    downloadEstimate([run(100 * MB, 1000), { bytes: 0, bytesUnknown: 1 }],
      { maxReads: 1e9 }).estimable === false);
  check("nothing selected is not an estimate either",
    downloadEstimate([], { maxReads: 1e9 }).estimable === false);
}

console.log("\n== the profiled read count, against the count the ENA published ==");
{
  // The cheapest end-to-end check there is, and the only one that can see a
  // truncation both size witnesses agreed on.
  const v = (o) => readCountVerdict(o);
  check("the expected count reached is a pass",
    v({ observed: 845_387, expected: 845_387, maxReads: 1e9 }).ok === true);
  check("rounding inside the tolerance is a pass",
    v({ observed: 845_000, expected: 845_387, maxReads: 1e9 }).ok === true);
  const short = v({ observed: 5_400_000, expected: 13_510_300, maxReads: 1e9 });
  check("a download that ended at 40 % is NOT a pass", short.ok === false);
  check("...and the shortfall is named in reads and in percent",
    /5,400,000/.test(short.note) && /13,510,300/.test(short.note) && /60\.0% missing/.test(short.note),
    short.note);
  check("stopping AT the cap is not a shortfall",
    v({ observed: 1_000_000, expected: 13_510_300, maxReads: 1_000_000 }).ok === true
    && v({ observed: 1_000_000, expected: 13_510_300, maxReads: 1_000_000 }).capped === true);
  check("a run with no read_count cannot be checked, and does not fail",
    v({ observed: 100, expected: NaN, maxReads: 1e9 }).ok === true);
  check("more reads than the catalogue lists is a mismatch too",
    v({ observed: 2_000_000, expected: 1_000_000, maxReads: 1e9 }).ok === false);
}

// =============================================================================
// 2. The read source, against a server that misbehaves on purpose
// =============================================================================

const TARGET = "/f/reads.fastq";
const GZ_TARGET = "/f/reads.fastq.gz";

try {
  console.log("\n== A. a link that works ==");
  await startServer(TARGET);
  {
    const src = urlSource(PLAIN_URL, { size: PLAIN.length, ...FAST });
    const { bytes, err } = await drain(src);
    check("the whole file arrives", !err && bytes.length === PLAIN.length, err?.message);
    check("byte for byte", sha(bytes) === sha(PLAIN));
    check("one request, no Range on it", src.requests === 1 && !hits(TARGET)[0]?.range,
      `${src.requests} requests`);
    check("the size is taken from the server", src.size === PLAIN.length, String(src.size));
  }

  console.log("\n== B. every second response is cut mid-body (RST) ==");
  // The scenario this whole file exists for: at 4 MiB/s a 1.8 GB run is eight
  // minutes, and a cut at 90 % that starts over is a broken feature.
  await startServer(TARGET, ["--cut-every", "2", "--cut-at", "0.4"]);
  {
    const src = urlSource(PLAIN_URL, { size: PLAIN.length, ...FAST });
    // detectGzip's 2-byte read comes first in the real flow, and it is what
    // makes the server's every-second-request fault land on the body rather
    // than on the probe. Without it the very first request delivers the whole
    // file and the scenario tests nothing — which is exactly what it did until
    // the request count was asserted.
    await src.slice(0, 2).arrayBuffer();
    const { bytes, err } = await drain(src);
    check("it finishes anyway", !err, err?.message);
    check("BYTE FOR BYTE, across the cuts", sha(bytes) === sha(PLAIN),
      `${bytes.length} vs ${PLAIN.length} bytes`);
    check("it really resumed instead of restarting", src.requests > 2 && src.restarts === 0,
      `${src.requests} requests, ${src.restarts} restarts`);
    const ranges = hits(TARGET).filter((h) => h.range).length;
    check("...with Range headers", ranges >= 1, `${ranges} ranged requests`);
    // The bytes actually shipped by the server: with a working resume this is
    // barely more than the file. Re-downloading from zero on each cut would be
    // several times it — the number, not the adjective.
    const served = hits(TARGET).reduce((a, h) => a + (h.sent ?? 0), 0);
    check("and it did not re-download the file several times over",
      served < PLAIN.length * 2, `${served} bytes served for a ${PLAIN.length} byte file`);
  }

  console.log("\n== C. the server stops honouring Range (proxy / captive portal) ==");
  // The defect this guards: the answer to a resume is a 200 with the WHOLE file
  // from byte 0. Appending that to the prefix already delivered gives a stream
  // that is a valid prefix followed by the entire file again — longer than the
  // real one, and a perfectly silent wrong answer downstream.
  await startServer(TARGET, ["--no-ranges", "--cut-every", "2", "--cut-at", "0.4"]);
  {
    const src = urlSource(PLAIN_URL, { size: PLAIN.length, ...FAST });
    await src.slice(0, 2).arrayBuffer();     // see the note in B
    const { bytes, err } = await drain(src);
    check("it still finishes", !err, err?.message);
    check("nothing was spliced: the length is exact", bytes.length === PLAIN.length,
      `${bytes.length} vs ${PLAIN.length}`);
    check("BYTE FOR BYTE", sha(bytes) === sha(PLAIN));
    check("it restarted rather than pasted", src.restarts > 0, `${src.restarts} restarts`);
  }

  console.log("\n== C2. a server that ONLY ever ignores Range, for ever ==");
  await startServer(TARGET, ["--no-ranges", "--cut-every", "1", "--cut-at", "0.3"]);
  {
    // Every response is the whole file from 0, cut at 30 %. Each resume costs a
    // full re-read, so this can never converge: it has to give up, and say why,
    // instead of looping. (The restart cap is the mechanism; without it this
    // runs until the request ceiling, still bounded, but with a message that
    // blames the rate rather than the server's Range handling.)
    const src = urlSource(PLAIN_URL, { size: PLAIN.length, ...FAST });
    const t0 = Date.now();
    const { bytes, err } = await drain(src);
    check("it gives up instead of looping", err !== null, `${bytes.length} bytes delivered`);
    check("...naming Range as the reason", /Range/.test(err?.message ?? ""), err?.message);
    check("...after the documented number of restarts", src.restarts === MAX_RANGE_RESTARTS + 1,
      `${src.restarts} restarts`);
    check("...quickly", Date.now() - t0 < 60_000, `${Date.now() - t0} ms`);
    check("what it did deliver is a prefix of the file, never a splice",
      PLAIN.subarray(0, bytes.length).equals(bytes), `${bytes.length} bytes`);
  }

  console.log("\n== D. a server that answers a few bytes per request, for ever ==");
  // Honest to the letter: the right offset, a truthful Content-Range, and 512
  // bytes of progress per request. Every response is a SUCCESS, so a budget that
  // counts only consecutive failures never fires. This is the exact hole that
  // was found in db-cache.js, and the reason ena.js counts EVERY request.
  await startServer(TARGET, ["--drip", "512", "--cut-every", "2", "--cut-at", "0.2"]);
  {
    const src = urlSource(PLAIN_URL, { size: PLAIN.length, ...FAST });
    await src.slice(0, 2).arrayBuffer();     // see the note in B

    const t0 = Date.now();
    const { bytes, err } = await drain(src, { limitMs: 60_000 });
    check("it stops instead of spinning for ever", err !== null, `${bytes.length} bytes`);
    check("...saying the server is not delivering at a usable rate",
      /usable rate|requests/.test(err?.message ?? ""), err?.message);
    check("...within the request ceiling", src.requests <= 61, `${src.requests} requests`);
    check("...in seconds, not minutes", Date.now() - t0 < 30_000, `${Date.now() - t0} ms`);
    check("and what it delivered is still a clean prefix",
      PLAIN.subarray(0, bytes.length).equals(bytes), `${bytes.length} bytes`);
  }

  console.log("\n== E. successful responses that carry no bytes ==");
  // A 206 with Content-Length: 0 — what a connection dropped right after the
  // headers looks like. A success carrying nothing.
  await startServer(TARGET, ["--empty-every", "2"]);
  {
    const src = urlSource(PLAIN_URL, { size: PLAIN.length, ...FAST });
    const { bytes, err } = await drain(src);
    check("empty successes do not stall it", !err, err?.message);
    check("BYTE FOR BYTE", sha(bytes) === sha(PLAIN), `${bytes.length} bytes`);
  }

  console.log("\n== F. a 206 answering a different interval ==");
  // A CDN clamping ranges, or a cache serving another variant. Written at the
  // offset that was ASKED for, it makes a file of plausible length and shuffled
  // contents — undetectable afterwards.
  await startServer(TARGET, ["--cut-every", "3", "--cut-at", "0.3", "--shift-range", "2"]);
  {
    const src = urlSource(PLAIN_URL, { size: PLAIN.length, ...FAST });
    const { bytes, err } = await drain(src);
    check("it copes with ranges answered from the wrong offset", !err, err?.message);
    check("BYTE FOR BYTE", sha(bytes) === sha(PLAIN), `${bytes.length} bytes`);
  }

  console.log("\n== G. 503s in the middle ==");
  await startServer(TARGET, ["--fail-every", "3"]);
  {
    const src = urlSource(PLAIN_URL, { size: PLAIN.length, ...FAST });
    const { bytes, err } = await drain(src);
    check("it retries through 503s", !err, err?.message);
    check("BYTE FOR BYTE", sha(bytes) === sha(PLAIN));
  }

  console.log("\n== H. the file is republished mid-read ==");
  // Same length, different bytes, different Last-Modified. Every response is
  // individually valid; the assembled stream would be two files spliced
  // together, and NOTHING downstream can see that. It must fail.
  await startServer(TARGET, ["--cut-every", "1", "--cut-at", "0.35", "--alt", ALT, "--alt-after", "1"]);
  {
    const src = urlSource(PLAIN_URL, { size: PLAIN.length, ...FAST });
    const { bytes, err } = await drain(src);
    check("a file that changes under the read is a hard failure", err !== null,
      `${bytes.length} bytes delivered`);
    check("...and says the file changed on the server",
      /changed on the server/.test(err?.message ?? ""), err?.message);
    check("...having delivered nothing but a prefix of the ORIGINAL file",
      PLAIN.subarray(0, bytes.length).equals(bytes), `${bytes.length} bytes`);
    check("...and nothing of the new one",
      bytes.length === 0 || !PLAIN_ALT.subarray(0, bytes.length).equals(bytes));
  }

  console.log("\n== I. detectGzip's 2-byte slice ==");
  await startServer(GZ_TARGET);
  {
    const src = urlSource(GZ_URL, { size: GZ.length, ...FAST });
    const head = new Uint8Array(await src.slice(0, 2).arrayBuffer());
    check("the gzip magic is read with one small Range request",
      head.length === 2 && head[0] === 0x1f && head[1] === 0x8b, Array.from(head).join(","));
    const ranged = hits(GZ_TARGET).some((h) => h.range === "bytes=0-1");
    check("...and it really was a Range request", ranged);
  }
  await startServer(GZ_TARGET, ["--no-ranges"]);
  {
    // A host that ignores Range answers with the whole file; the window still has
    // to come out right (and the rest of the body must be dropped).
    const src = urlSource(GZ_URL, { size: GZ.length, ...FAST });
    const head = new Uint8Array(await src.slice(0, 2).arrayBuffer());
    check("it still works where Range is ignored entirely",
      head.length === 2 && head[0] === 0x1f && head[1] === 0x8b, Array.from(head).join(","));
  }

  console.log("\n== J. cancellation ==");
  await startServer(TARGET, ["--delay", "0.02"]);
  {
    const ac = new AbortController();
    const src = urlSource(PLAIN_URL, { size: PLAIN.length, signal: ac.signal, ...FAST });
    const reader = src.stream().getReader();
    await reader.read();
    ac.abort();
    let threw = null;
    try { for (;;) { const { done } = await reader.read(); if (done) break; } }
    catch (e) { threw = e; }
    check("an aborted signal stops the stream", threw !== null && threw.name === "AbortError",
      threw ? `${threw.name}: ${threw.message}` : "no throw");
    const before = src.requests;
    await sleep(300);
    check("...and makes no further requests", src.requests === before, `${before} → ${src.requests}`);
  }

  // ---------------------------------------------------------------------------
  // K. THE END-TO-END PROOF: the same bytes streamCore would have got from a File
  // ---------------------------------------------------------------------------
  console.log("\n== K. gunzip + trim through the adapter, against a flaky link ==");
  await startServer(GZ_TARGET, ["--cut-every", "2", "--cut-at", "0.45"]);
  {
    // The reference: the local file, read the way the app reads a dropped file.
    class LocalFile {
      constructor(b) { this.bytes = b; this.size = b.length; }
      slice(s, e) { const v = this.bytes.subarray(s, e); return { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.length) }; }
      stream() {
        const { bytes } = this; let off = 0;
        return new ReadableStream({ pull(c) {
          if (off >= bytes.length) { c.close(); return; }
          const end = Math.min(off + 64 * 1024, bytes.length);
          c.enqueue(new Uint8Array(bytes.subarray(off, end))); off = end;
        } });
      }
    }
    for (const maxReads of [500, 4000, 10_000]) {
      const ref = await readAndTrim(new LocalFile(GZ), maxReads, null, null);
      const src = urlSource(GZ_URL, { size: GZ.length, ...FAST });
      const parts = [];
      const st = await streamTrimMulti([src], maxReads, (c) => parts.push(Buffer.from(c)), null, null);
      const got = Buffer.concat(parts);
      check(`maxReads=${maxReads}: the trimmed FASTQ is byte-identical to the local read`,
        sha(got) === sha(Buffer.from(ref.bytes)),
        `${got.length} vs ${ref.bytes.length} bytes, ${src.requests} requests`);
      check(`maxReads=${maxReads}: same read count`, st.reads === ref.reads,
        `${st.reads} vs ${ref.reads}`);
      check(`maxReads=${maxReads}: the cut is still on a record boundary`,
        got.length === 0 || got[got.length - 1] === 0x0a);
    }
  }

  console.log("\n== L. the cap really stops the download ==");
  // Not a nicety: reading 1.8 GB to keep the first 500 reads is the difference
  // between eight minutes and one second. streamCore stops pulling, and the
  // adapter must let go of the connection.
  await startServer(GZ_TARGET, ["--delay", "0.01"]);
  {
    const src = urlSource(GZ_URL, { size: GZ.length, ...FAST });
    const parts = [];
    await streamTrimMulti([src], 200, (c) => parts.push(Buffer.from(c)), null, null);
    check("a small cap reads a fraction of the file", src.received < GZ.length / 2,
      `${src.received} of ${GZ.length} bytes downloaded`);
  }
} finally {
  await stopServer();
}

// =============================================================================
// 3. A body that ends cleanly but early (chunked, no Content-Length)
// =============================================================================
//
// flaky_server's cut is a lie about Content-Length followed by an RST, which
// fetch() surfaces as an error. The nastier shape is the one that raises
// nothing: a chunked response that simply stops. Without the "did it end early"
// check, the stream closes normally and the sample is profiled on a fraction of
// its reads — reported as a success.
console.log("\n== M. a chunked response that ends early raises nothing by itself ==");
{
  let n = 0;
  const srv = http.createServer((req, res) => {
    n++;
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const body = PLAIN.subarray(start);
    // No Content-Length at all: chunked, so a short body is a clean EOF.
    res.writeHead(range ? 206 : 200, {
      "Content-Type": "text/plain",
      ...(range ? { "Content-Range": `bytes ${start}-${PLAIN.length - 1}/${PLAIN.length}` } : {}),
    });
    // First response stops after 30 %, cleanly. Later ones are complete.
    res.end(n === 1 ? body.subarray(0, Math.floor(body.length * 0.3)) : body);
  });
  await new Promise((r) => srv.listen(CHUNKED_PORT, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${CHUNKED_PORT}/reads.fastq`;
    // The declared size is the ONLY thing that can reveal the truncation here:
    // the response carries no length of its own.
    const src = urlSource(url, { size: PLAIN.length, ...FAST });
    const { bytes, err } = await drain(src);
    check("the short clean ending is noticed and resumed", !err, err?.message);
    check("BYTE FOR BYTE", sha(bytes) === sha(PLAIN), `${bytes.length} vs ${PLAIN.length}`);
    check("it took more than one request", src.requests > 1, `${src.requests}`);

    // With no size to compare against, the same truncation cannot be seen at
    // this layer — stated here so the limit is on the record rather than
    // discovered later. (fastq-trim.js still catches it for a .gz: a truncated
    // deflate stream throws.)
    n = 0;
    const blind = urlSource(url, { ...FAST });
    const { bytes: short } = await drain(blind);
    check("with no declared size a chunked truncation is invisible here (documented limit)",
      short.length < PLAIN.length, `${short.length} of ${PLAIN.length}`);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

// =============================================================================
// 3b. A resume answered from FURTHER ON than it asked for
// =============================================================================
//
// The mirror image of the whole-file answer: a 206 that starts AFTER the resume
// point, declared honestly in Content-Range. Writing it where it was asked for
// leaves a HOLE — bytes that were never delivered — in the middle of a gzip
// member. flaky_server cannot produce this (its --shift-range always answers
// from the start of the file, i.e. from BEFORE the resume point), so it takes a
// server of its own.
console.log("\n== O. a range answered from further on than it asked for ==");
{
  const SKIPPED = 1024;
  let n = 0;
  const srv = http.createServer((req, res) => {
    n++;
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    if (!range) {
      // First response: chunked, and it stops after 30 %.
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(PLAIN.subarray(0, Math.floor(PLAIN.length * 0.3)));
      return;
    }
    // Every resume is answered from 1 KB further on than it asked for, and says
    // so truthfully in Content-Range.
    const start = Number(range[1]) + SKIPPED;
    res.writeHead(206, {
      "Content-Type": "text/plain",
      "Content-Range": `bytes ${start}-${PLAIN.length - 1}/${PLAIN.length}`,
    });
    res.end(PLAIN.subarray(start));
  });
  await new Promise((r) => srv.listen(CHUNKED_PORT + 1, "127.0.0.1", r));
  try {
    const src = urlSource(`http://127.0.0.1:${CHUNKED_PORT + 1}/reads.fastq`,
      { size: PLAIN.length, ...FAST });
    const { bytes, err } = await drain(src);
    check("a hole is refused rather than written around", err !== null,
      `${bytes.length} bytes delivered`);
    check("...and what was delivered is an unbroken prefix of the file",
      PLAIN.subarray(0, bytes.length).equals(bytes), `${bytes.length} bytes`);
    check("...with none of the bytes that came after the hole",
      bytes.length === Math.floor(PLAIN.length * 0.3), `${bytes.length}`);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

// =============================================================================
// 3c. The two size witnesses, against each other
// =============================================================================
//
// Everything above compares the server with itself, and that cannot see a
// server which is consistently wrong. The shape: an object truncated somewhere
// upstream (a bad sync, a CDN that stored a partial copy) served with a
// Content-Length that is honest ABOUT THE TRUNCATED OBJECT. Every check in
// ena.js is satisfied — the length matches what arrives, the stream ends
// cleanly, emitted === total — and the sample is profiled on a fraction of its
// reads and reported as a success. fastq_bytes is the only number that comes
// from somewhere else.
const PORT_Q = CHUNKED_PORT + 2;
console.log("\n== Q. the server serves a truncated file, honestly measured ==");
{
  const TRUNC = Math.floor(PLAIN.length * 0.4);
  const srv = http.createServer((req, res) => {
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const body = PLAIN.subarray(start, TRUNC);
    res.writeHead(range ? 206 : 200, {
      "Content-Type": "text/plain",
      "Content-Length": String(body.length),
      "Last-Modified": "Wed, 01 Jan 2025 00:00:00 GMT",
      ...(range ? { "Content-Range": `bytes ${start}-${TRUNC - 1}/${TRUNC}` } : {}),
    });
    res.end(body);
  });
  await new Promise((r) => srv.listen(PORT_Q, "127.0.0.1", r));
  try {
    // fastq_bytes says the file is PLAIN.length; the server says (and delivers)
    // 40 % of that, with no error of any kind.
    const src = urlSource(`http://127.0.0.1:${PORT_Q}/reads.fastq`, { size: PLAIN.length, ...FAST });
    const { bytes, err } = await drain(src);
    check("a silently truncated file is a FAILURE, not a short success",
      err !== null, `${bytes.length} of ${PLAIN.length} bytes delivered with no error`);
    check("...and the failure names the two sizes that disagree",
      /the ENA API says this file is/.test(err?.message ?? "")
      && new RegExp(`${PLAIN.length}`).test(err?.message ?? "")
      && new RegExp(`${TRUNC}`).test(err?.message ?? ""), err?.message);
    check("...and it is fatal: no retry loop against a file that will not grow",
      src.requests <= 2, `${src.requests} requests`);

    // The same thing the other way round — the server holding MORE than the
    // catalogue describes is the same disagreement and gets the same answer.
    const bigger = urlSource(`http://127.0.0.1:${PORT_Q}/reads.fastq`,
      { size: Math.floor(TRUNC / 2), ...FAST });
    const { err: err2 } = await drain(bigger);
    check("a file LONGER than the API says is refused too",
      err2 !== null && /the ENA API says this file is/.test(err2.message), err2?.message);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

// =============================================================================
// 3d. A resume that carries the WHOLE file, with nothing to measure it by
// =============================================================================
//
// Invariant 2 ("a 200 where a 206 was expected is never pasted onto what we
// already have") had a hole: it was enforced only where the SERVER had stated a
// size. A first response sent chunked states nothing, Content-Range is not
// readable cross-origin, and a 206 answering from byte 0 was then believed —
// prefix + whole file, no error, a sketch of duplicated reads.
console.log("\n== R. a 206 carrying the whole file, no Content-Length anywhere ==");
{
  let n = 0;
  const srv = http.createServer((req, res) => {
    n++;
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    // Chunked throughout: no Content-Length on any response, and no
    // Content-Range on the 206 either (which is what a cross-origin read of it
    // looks like). Nothing the server says can be measured.
    res.writeHead(range ? 206 : 200, { "Content-Type": "text/plain" });
    if (n === 1) { res.end(PLAIN.subarray(0, Math.floor(PLAIN.length * 0.3))); return; }
    res.end(PLAIN);                      // the WHOLE file, whatever was asked for
  });
  await new Promise((r) => srv.listen(PORT_Q + 1, "127.0.0.1", r));
  try {
    const src = urlSource(`http://127.0.0.1:${PORT_Q + 1}/reads.fastq`,
      { size: PLAIN.length, ...FAST });
    const { bytes, err } = await drain(src);
    check("the splice is caught even with nothing but fastq_bytes to catch it with",
      err !== null, `${bytes.length} delivered for a ${PLAIN.length} byte file`);
    check("...and never more bytes than the file is meant to have",
      bytes.length <= PLAIN.length, `${bytes.length} vs ${PLAIN.length}`);
    check("...and the failure says the server answered with the whole file again",
      /answering resumes with the whole file/.test(err?.message ?? ""), err?.message);
    // The residual, stated rather than discovered later: with NO readable
    // length on the resume — no Content-Range, no Content-Length — nothing
    // identifies the body as the whole file before it is read, so the splice is
    // caught by the byte count and some duplicated bytes have already been
    // handed downstream when it fires. The sample FAILS, which is the point;
    // it fails a few hundred KB late. Scenario S is the same splice with a
    // readable length, where it is caught before a single wrong byte moves.
    check("...(documented: without any readable length it is caught by the count, late)",
      bytes.length > Math.floor(PLAIN.length * 0.3), `${bytes.length} bytes`);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

console.log("\n== S. the same splice, but the 206 states its length ==");
{
  // Same server, except the resume carries Content-Length = the whole file.
  // That is enough to RECOGNISE the whole file — against fastq_bytes, since the
  // server never stated a total — and the read recovers instead of failing:
  // respStart goes back to 0, the prefix is skipped, the file arrives intact.
  let n = 0;
  const srv = http.createServer((req, res) => {
    n++;
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    if (n === 1) {
      res.writeHead(200, { "Content-Type": "text/plain" });   // chunked, no length
      res.end(PLAIN.subarray(0, Math.floor(PLAIN.length * 0.3)));
      return;
    }
    res.writeHead(range ? 206 : 200, {
      "Content-Type": "text/plain",
      "Content-Length": String(PLAIN.length),
    });
    res.end(PLAIN);
  });
  await new Promise((r) => srv.listen(PORT_Q + 2, "127.0.0.1", r));
  try {
    const src = urlSource(`http://127.0.0.1:${PORT_Q + 2}/reads.fastq`,
      { size: PLAIN.length, ...FAST });
    const { bytes, err } = await drain(src);
    check("a whole-file 206 is recognised and restarted, not pasted", !err, err?.message);
    check("BYTE FOR BYTE", sha(bytes) === sha(PLAIN), `${bytes.length} vs ${PLAIN.length}`);
    check("...and it is counted as a restart", src.restarts > 0, `${src.restarts} restarts`);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

// =============================================================================
// 3e. The gzip probe is a request like any other
// =============================================================================
console.log("\n== T. the two-byte probe is answered with an empty body ==");
{
  // A 206 with no body at all, closed cleanly: not an exception, so the retry
  // loop around slice() never ran. detectGzip() then read fewer than two bytes,
  // said "not gzip" about a gzip file, and the compressed bytes were fed to the
  // sketcher as text — which surfaces much later as "not a valid FASTQ stream",
  // blaming the file for a request that failed.
  let n = 0;
  const srv = http.createServer((req, res) => {
    n++;
    const range = /bytes=(\d+)-(\d+)?/.exec(req.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Number(range[2]) + 1 : GZ.length;
    const body = n === 1 ? Buffer.alloc(0) : GZ.subarray(start, end);
    res.writeHead(range ? 206 : 200, {
      "Content-Type": "application/gzip",
      "Content-Length": String(body.length),
      "Content-Range": `bytes ${start}-${end - 1}/${GZ.length}`,
    });
    res.end(body);
  });
  await new Promise((r) => srv.listen(PORT_Q + 3, "127.0.0.1", r));
  try {
    const src = urlSource(`http://127.0.0.1:${PORT_Q + 3}/reads.fastq.gz`,
      { size: GZ.length, ...FAST });
    const head = new Uint8Array(await src.slice(0, 2).arrayBuffer());
    check("an empty-but-clean answer to the probe is retried, not believed",
      head.length === 2, `${head.length} bytes`);
    check("...so the gzip magic is still read", head[0] === 0x1f && head[1] === 0x8b,
      Array.from(head).join(","));
    check("...and it took more than one request to get it", n > 1, `${n} requests`);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

console.log("\n== U. the allow-list is enforced at the fetch, not only at resolution ==");
{
  // resolveAccession() filters fastq_ftp, but that is one caller and one layer.
  // The source is what opens the connection, and the page's privacy notice is a
  // promise about that connection.
  let threw = null;
  try { urlSource("https://evil.example/x.fastq.gz", { size: 10 }); } catch (e) { threw = e; }
  check("a source on a non-EBI host is refused before any request",
    threw !== null && /only\s+fetches FASTQ files from the EBI/.test(threw.message), threw?.message);
  threw = null;
  try { urlSource("https://ftp.sra.ebi.ac.uk/x.fastq.gz", { size: 10 }); } catch (e) { threw = e; }
  check("...and an EBI host is not", threw === null, threw?.message);
  threw = null;
  try { urlSource("javascript:alert(1)"); } catch (e) { threw = e; }
  check("...nor is a URL that is not one", threw !== null, threw?.message);
}

// =============================================================================
// 4. Small units that hold the UI's numbers up
// =============================================================================
console.log("\n== P. a source is read once ==");
{
  // `emitted` is a resume offset. Streaming the same source twice would start
  // in the middle of the file and sketch a sample from its own tail, with no
  // error anywhere.
  const src = urlSource("http://127.0.0.1:1/never", { size: 10, ...FAST });
  src.stream().cancel();
  let threw = null;
  try { src.stream(); } catch (e) { threw = e; }
  check("a second stream() is refused rather than resumed into",
    threw !== null && /already been read/.test(threw.message), threw?.message);
}

console.log("\n== N. rate meter ==");
{
  let t = 0;
  const m = rateMeter(5000, () => t);
  m.push(0);
  t = 1000; const bps = m.push(4 * 1024 * 1024);
  check("a trailing-window rate is bytes over seconds", Math.abs(bps - 4 * 1024 * 1024) < 1024,
    String(bps));
  t = 1100;
  check("too short a window gives no number, rather than a wild one",
    Number.isFinite(m.push(4 * 1024 * 1024 + 10)) === true);
  const m2 = rateMeter(5000, () => 0);
  m2.push(0);
  check("no elapsed time gives NaN, not Infinity", Number.isNaN(m2.push(1000)));
}

// The failure this exists for is not a crash: an amplicon run profiles cleanly,
// finds nothing, and shows an empty table. Correct, and indistinguishable from a
// bug — PRJNA1270378 (26 AMPLICON/Nanopore runs, 4.89 GiB) is what surfaced it.
// The ENA does not use one convention for read_count on paired runs, and does
// not say which it used. Measured live, both real:
//   ERR14098649  read_count 13,510,300  base_count/read_count = 149.8  -> READS
//   ERR4421639   read_count 14,091      base_count/read_count = 302.0  -> SPOTS
// Assuming the first marked every run of the second kind INCOMPLETE with
// "100.0% more — the file served does not match the catalogue", on downloads
// that were perfect.
console.log("\n== P. read_count means pairs on some runs and reads on others ==");
{
  const v = (o) => readCountVerdict({ maxReads: 3e6, ...o });
  // expected is derived as round(read_count / 2); under the spots convention the
  // observed pair count is read_count itself, i.e. twice expected.
  check("a paired run whose read_count counts SPOTS is accepted (ERR4421639)",
    v({ observed: 14091, expected: 7046, layout: "PAIRED" }).ok === true);
  check("...and ERR4421640 with it",
    v({ observed: 13441, expected: 6721, layout: "PAIRED" }).ok === true);
  check("a paired run whose read_count counts READS is still accepted (ERR14098649)",
    v({ observed: 6755150, expected: 6755150, layout: "PAIRED" }).ok === true);

  // The check must keep its teeth. Accepting two readings is not accepting any.
  check("a paired run truncated to 10% is still caught",
    v({ observed: 700, expected: 7046, layout: "PAIRED" }).ok === false);
  check("a paired run with four times too many reads is still caught",
    v({ observed: 56364, expected: 7046, layout: "PAIRED" }).ok === false);
  check("a paired run at half of expected is still caught — that is neither reading",
    v({ observed: 3523, expected: 7046, layout: "PAIRED" }).ok === false);
  // Single-end has one convention, so nothing is ambiguous and doubling must NOT
  // be tolerated there.
  check("a single-end run with twice the reads is still caught",
    v({ observed: 14092, expected: 7046, layout: "SINGLE" }).ok === false);
  check("a single-end run truncated by half is still caught",
    v({ observed: 3523, expected: 7046, layout: "SINGLE" }).ok === false);

  // The documented cost, asserted rather than described, so it cannot quietly
  // widen: a SPOTS-convention run truncated to exactly half now passes, because
  // that is precisely what the other reading predicts.
  check("KNOWN BLIND SPOT: a spots-convention paired run cut to exactly half passes",
    v({ observed: 7046, expected: 7046, layout: "PAIRED" }).ok === true);
}

console.log("\n== O. library types sylph cannot profile ==");
{
  const row = (over) => ({
    run_accession: "SRRX", library_layout: "SINGLE",
    fastq_ftp: "ftp.sra.ebi.ac.uk/x.fastq.gz", fastq_bytes: "100", read_count: "10",
    ...over,
  });
  const amplicon = parseRunRow(row({
    library_strategy: "AMPLICON", library_source: "GENOMIC",
    instrument_platform: "OXFORD_NANOPORE",
  }));
  check("an amplicon run is flagged before anything is downloaded",
    amplicon.unprofilable !== "", amplicon.unprofilable.slice(0, 60));
  check("...and the reason names amplicons rather than blaming the database",
    /amplicon/i.test(amplicon.unprofilable) && !/database is wrong/i.test(amplicon.unprofilable));
  check("...and the run stays usable, so the user may still tick it",
    amplicon.usable === true);
  check("...and the strategy is carried for display", amplicon.strategy === "AMPLICON");

  check("a metatranscriptomic run is flagged through library_source",
    parseRunRow(row({ library_strategy: "OTHER", library_source: "METATRANSCRIPTOMIC" }))
      .unprofilable !== "");

  // The other half, and the one that makes the check worth having: shotgun
  // metagenomes must pass silently. A warning that fires on good runs is one
  // the user learns to click through on the bad ones.
  check("a WGS metagenome is NOT flagged",
    parseRunRow(row({ library_strategy: "WGS", library_source: "METAGENOMIC" }))
      .unprofilable === "");
  check("OTHER/METAGENOMIC is NOT flagged — that is how many shotgun runs are declared",
    parseRunRow(row({ library_strategy: "OTHER", library_source: "METAGENOMIC" }))
      .unprofilable === "");
  check("a run with no library metadata at all is NOT flagged",
    parseRunRow(row({})).unprofilable === "");
  check("case and padding in the ENA's fields do not change the verdict",
    parseRunRow(row({ library_strategy: " amplicon " })).unprofilable !== "");
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
