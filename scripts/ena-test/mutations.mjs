// "A test that fails if you remove the mechanism" — checked, not claimed.
//
//   node scripts/ena-test/mutations.mjs
//
// Every guard in the ENA mode is here as a MUTATION: a small, plausible edit of
// the kind a later cleanup would make ("this Range header looks redundant",
// "why count successful requests?", "this note is never read anyway"). For each
// one the named bench is run against the mutated tree, and this script asserts
// that the bench NOTICES — naming the scenario that catches it. A mutation that
// survives is reported as a hole in the bench, which is the only interesting
// result here.
//
// A mutation names:
//   file    which source is edited            (default web/ena.js)
//   bench   which bench must fail because of it (default node-suite.mjs)
//   edits   one or more literal from → to replacements; several when the
//           mechanism is two lines working together, or when the mutation is
//           "put back exactly what was there before the fix"
//
// Every file touched is restored afterwards, always, including on a crash.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

const ENA = "web/ena.js";
const MULTI = "web/multi.js";
const WORKER = "web/sylph-worker.js";
const INDEX = "web/index.html";
const README = "README.md";

const SUITE = "node-suite.mjs";
const WIRING = "wiring.mjs";

// Each mutation: what it removes, the edit(s), and the scenario that must break.
const MUTATIONS = [
  {
    name: "resume: stop sending Range when re-opening",
    why: "every cut would restart from byte 0 — eight minutes of downloading, again",
    from: `    if (start > 0) headers.Range = \`bytes=\${start}-\`;`,
    to: `    if (false) headers.Range = \`bytes=\${start}-\`;`,
    expect: /resumed instead of restarting|BYTE FOR BYTE/,
  },
  {
    name: "no-splice: paste a whole-file response onto the prefix already read",
    why: "THE silent corruption: a valid prefix followed by the entire file again",
    from: `          if (pos <= state.emitted) continue;                 // still re-reading a known prefix
          const keep = chunkStart >= state.emitted
            ? value
            : value.subarray(state.emitted - chunkStart);
          state.emitted = pos;`,
    to: `          const keep = value;
          state.emitted += value.length;`,
    expect: /nothing was spliced|BYTE FOR BYTE/,
  },
  {
    name: "hole guard: accept a response that starts AFTER the resume point",
    why: "a gap in the middle of a gzip member, which nothing downstream can see",
    from: `    if (respStart > state.emitted) {`,
    to: `    if (false) {`,
    expect: /hole is refused|unbroken prefix|none of the bytes/,
  },
  {
    name: "request ceiling: count only the FAILED requests",
    why: "a server dripping 512 bytes per request never 'fails', so nothing ever fires",
    from: `    if (state.requests >= requestCeiling(state)) {`,
    to: `    if (false) {`,
    expect: /spinning for ever|usable rate|request ceiling/,
  },
  {
    name: "restart cap: allow unlimited whole-file restarts",
    why: "a host that never honours Range and keeps cutting would loop until the ceiling",
    from: `      if (state.restarts > cfg.maxRestarts) {`,
    to: `      if (false) {`,
    expect: /gives up instead of looping|naming Range|documented number of restarts/,
  },
  {
    name: "Last-Modified: do not compare it between requests",
    why: "a file republished mid-read assembles two different files into one sample",
    from: `      else if (lm !== state.lastModified) {`,
    to: `      else if (false) {`,
    expect: /hard failure|changed on the server|prefix of the ORIGINAL/,
  },
  {
    name: "short clean EOF: treat any `done` as the end of the file",
    why: "a chunked response that just stops profiles the sample on a fraction of its reads",
    from: `            const expected = expectedTotal(state);
            if (Number.isFinite(expected) && state.emitted < expected) {`,
    to: `            const expected = expectedTotal(state);
            if (false) {`,
    expect: /short clean ending|BYTE FOR BYTE/,
  },
  {
    name: "accession check: validate AFTER calling the API",
    why: "whatever the user typed is then sent to the EBI",
    from: `  const v = validateAccession(acc);
  if (!v.ok) throw new Error(v.error);`,
    to: `  const v = { ok: true, acc: String(acc), error: "" };`,
    expect: /no request for/,
  },
  {
    name: "host allow-list: follow whatever host fastq_ftp names",
    why: "the page would fetch from a host the EBI's answer chose, not the EBI",
    from: `  if (allowHosts && allowHosts.length && !allowHosts.some((re) => re.test(u.hostname))) {`,
    to: `  if (false) {`,
    expect: /non-EBI host is dropped|lookalike host|non-EBI host is refused/,
  },
  {
    name: "parallel lists: drop the empty slots from fastq_bytes",
    why: "every size after the gap is attached to the wrong file",
    from: `const splitList = (v) => String(v ?? "").split(";").map((s) => s.trim());`,
    to: `const splitList = (v) => String(v ?? "").split(";").map((s) => s.trim()).filter(Boolean);`,
    expect: /does not shift the sizes|counted as unknown/,
  },
  {
    name: "unknown sizes: let a missing fastq_bytes become 0",
    why: "a 2 GB download announced as '0 B', and an ETA of zero seconds",
    // The guard is really two lines working together (an empty entry is not a
    // number, and a non-number is not a zero); the mutation has to take out the
    // half that decides what an unusable value becomes.
    from: `      bytes: Number.isFinite(n) && n > 0 ? n : NaN,`,
    to: `      bytes: Number(rawBytes[i]) || 0,`,
    expect: /unknown, not zero|unknown count separate|counted as unknown/,
  },
  {
    name: "declared size: never use it, so a length-less response is trusted",
    why: "the chunked truncation above becomes invisible again",
    from: `  if (Number.isFinite(server) && Number.isFinite(api)) return Math.max(server, api);
  return Number.isFinite(server) ? server : api;`,
    to: `  return server;`,
    expect: /short clean ending|BYTE FOR BYTE/,
  },

  // ---- the fixes this round added -------------------------------------------
  {
    name: "size witnesses: stop comparing fastq_bytes with what the server serves",
    why: "a truncated object with an honest Content-Length is a silent partial profile",
    from: `    if (sizesDisagree(state)) {`,
    to: `    if (false) {`,
    expect: /names the two sizes that disagree|silently truncated file is a FAILURE/,
  },
  {
    name: "size witnesses: put back the OLD rule — the server's number wins, never compared",
    why: "exactly the state before the fix: emitted === expected, clean close, 40 % of the reads",
    edits: [
      [`  if (Number.isFinite(server) && Number.isFinite(api)) return Math.max(server, api);
  return Number.isFinite(server) ? server : api;`, `  return Number.isFinite(server) ? server : api;`],
      [`    if (sizesDisagree(state)) {`, `    if (false) {`],
    ],
    expect: /silently truncated file is a FAILURE/,
  },
  {
    name: "overrun: measure it against the server's size only",
    why: "a 206 carrying the whole file is undetectable when the server states no length",
    from: `          const cap = expectedTotal(state);
          if (Number.isFinite(cap) && pos > cap) {`,
    to: `          const cap = state.total;
          if (Number.isFinite(cap) && pos > cap) {`,
    expect: /splice is caught even with nothing but fastq_bytes/,
  },
  {
    name: "whole-file 206: recognise it only against a size the SERVER stated",
    why: "the cheap cross-check is inert in the one case it is needed — a chunked first response",
    from: `        const ref = expectedTotal(state);`,
    to: `        const ref = state.total;`,
    expect: /recognised and restarted, not pasted|BYTE FOR BYTE/,
  },
  {
    name: "slice(): accept a short answer to the gzip probe",
    why: "detectGzip says 'not gzip' about a gzip file, and compressed bytes are sketched as text",
    from: `              if (have < want && (inFile || have === 0)) {`,
    to: `              if (false) {`,
    expect: /retried, not believed|gzip magic is still read/,
  },
  {
    name: "urlSource(): fetch whatever URL it is handed",
    why: "the allow-list would exist only in the page, not at the connection",
    from: `  if (!checked || checked.blocked) {`,
    to: `  if (false) {`,
    expect: /non-EBI host is refused before any request/,
  },
  {
    name: "mixed content: follow an http: URL from an https: page",
    why: "the refusal would come from the browser, in the console, mid-download",
    from: `  if (u.protocol === "http:" && globalThis.location?.protocol === "https:") {`,
    to: `  if (false) {`,
    expect: /http: is refused when the page itself is https/,
  },
  {
    name: "PAIRED: pair a recognised _1 with whatever file came next",
    why: "two files that are not mates, paired record by record, presented as a paired run",
    from: `    const only = r1 ?? r2;
    if (only) {`,
    to: `    const only = r1 ?? r2;
    if (false) {`,
    expect: /not paired positionally|the one profiled|note is true/,
  },
  {
    name: "cost: ignore the read cap when adding up a project",
    why: "72 GB and several hours announced for a batch that will transfer a sixth of it",
    from: `    if (Number.isFinite(reads) && Number.isFinite(maxReads) && maxReads < reads) {`,
    to: `    if (false) {`,
    expect: /read cap bounds the estimate|estimate says it was bounded/,
  },
  {
    name: "cost: let an unknown size be an estimate like any other",
    why: "'0 B … about 0 s' in front of a download of tens of gigabytes",
    from: `  const estimable = unknown === 0 && bytes > 0;`,
    to: `  const estimable = true;`,
    expect: /no ETA is offered|refuses the ETA|not an estimate either/,
  },
  {
    name: "read count: never compare it with the ENA's read_count",
    why: "the last check that can see a truncation both size witnesses agreed on",
    from: `  const missing = expected - observed;`,
    to: `  const missing = 0;`,
    expect: /ended at 40 % is NOT a pass|shortfall is named/,
  },

  // ---- what the pages say and do (source-level bench) ------------------------
  {
    name: "banner: drop the Zenodo paragraph",
    file: INDEX, bench: WIRING,
    why: "the page would again present the ENA mode as the only thing that leaves the tab",
    from: `<strong>Loading the reference database downloads it from <code>zenodo.org</code>.</strong>`,
    to: `<strong>Loading the reference database.</strong>`,
    expect: /Zenodo download is named IN THE BANNER/,
  },
  {
    name: "README: take the database row out of the network table",
    file: README, bench: WIRING,
    why: "the table would say a local FASTQ costs no network traffic, which is false",
    from: `| **Load database** (any published biome) | the catalogue you picked coming *down* from \`zenodo.org\`, once, then cached on your computer — 433 MB for the human-gut default, 12 MB to 2.8 GB for the others | Zenodo sees your IP address and which of these files you asked for |`,
    to: ``,
    expect: /names the Zenodo download in its network table/,
  },
  {
    name: "Profile all: only `pending` samples may re-enable it",
    file: MULTI, bench: WIRING,
    why: "the retry path exists in runAll() and no button reaches it",
    from: `const RERUNNABLE = ["pending", "failed", "cancelled", "incomplete"];`,
    to: `const RERUNNABLE = ["pending"];`,
    expect: /re-enabled for samples that can be run again|including cancelled and incomplete/,
  },
  {
    name: "the ENA note: write it on the sample and never show it",
    file: MULTI, bench: WIRING,
    why: "every degradation parseRunRow names disappears at the moment it matters",
    from: `    const note = s.enaNote
      ? \`<br><small class="ena-note">\${escapeHTML(s.enaNote)}</small>\` : "";`,
    to: `    const note = "";`,
    expect: /ENA note parseRunRow took the trouble to write is rendered/,
  },
  {
    name: "read count: profile it, do not check it",
    file: MULTI, bench: WIRING,
    why: "a run that downloaded 40 % of its file reports 'N species detected' and nothing else",
    from: `        const verdict = s.origin === "ena"
          ? readCountVerdict({ observed: readsShown(s), expected: s.enaReads, maxReads,
              // Paired runs have two possible readings of the ENA's read_count.
              layout: s.kind === "pe" ? "PAIRED" : "SINGLE" })
          : { ok: true, note: "" };`,
    to: `        const verdict = { ok: true, note: "" };`,
    expect: /compared with the count the ENA published/,
  },
  {
    name: "cancel: count a user's cancellation as a failure",
    file: MULTI, bench: WIRING,
    why: "'0 samples ok, 12 failed' after a deliberate click on Cancel",
    from: `        if (cancelled) cancelCount++; else { failCount++; console.error(e); }`,
    to: `        failCount++; console.error(e);`,
    expect: /cancellation is not counted as a failure/,
  },
  {
    name: "rate: keep measuring one stream and calling it the link",
    file: MULTI, bench: WIRING,
    why: "with a pool of 2 every batch ETA is twice too long, labelled 'measured on your link'",
    from: `  const linkBps = bps * Math.max(1, streams);`,
    to: `  const linkBps = bps;`,
    expect: /scaled by the number of streams/,
  },
  {
    name: "rate: persist it on every progress event again",
    file: MULTI, bench: WIRING,
    why: "hundreds of thousands of synchronous localStorage writes on the main thread",
    from: `  if (now - bpsPersistedAt < BPS_PERSIST_MS) return;`,
    to: `  if (false) return;`,
    expect: /not persisted on every progress event/,
  },
  {
    name: "worker: trust whatever URL arrives over postMessage",
    file: WORKER, bench: WIRING,
    why: "the boundary that opens the connection would not enforce the promise the banner makes",
    from: `    const checked = fastqUrl(d?.url);`,
    to: `    const checked = { url: d?.url };`,
    expect: /re-checks the host allow-list/,
  },
  {
    name: "openRequest: leave the body of a rejected response hanging",
    why: "six strikes against a 503-ing host leave six sockets pinned until the GC",
    bench: WIRING,
    from: `    if (!resp.ok && resp.status !== 206) {
      try { await resp.body?.cancel(); } catch { /* nothing to let go of */ }
      throw new Error(\`HTTP \${resp.status}\`);
    }`,
    to: `    if (!resp.ok && resp.status !== 206) throw new Error(\`HTTP \${resp.status}\`);`,
    expect: /releases the response body/,
  },
  {
    // The failure mode here is an EMPTY TABLE, not an exception: without this
    // check an amplicon run downloads, profiles, finds nothing, and looks
    // exactly like a bug in the database.
    name: "library type: profile amplicon runs as if they were shotgun",
    why: "26 runs and 4.89 GiB downloaded to produce a blank result with no explanation",
    from: `  const why = UNPROFILABLE_STRATEGY[strategy] ?? UNPROFILABLE_SOURCE[source] ?? "";`,
    to: `  const why = "";`,
    expect: /amplicon run is flagged|metatranscriptomic run is flagged/,
  },
  {
    // The other direction, and the one that rots quietly: a check that fires on
    // everything is worse than no check, because the user stops reading it.
    name: "library type: warn on every run, including good shotgun ones",
    why: "a warning on WGS metagenomes is one the user learns to click through",
    from: `  const why = UNPROFILABLE_STRATEGY[strategy] ?? UNPROFILABLE_SOURCE[source] ?? "";`,
    to: `  const why = "this run may not be shotgun metagenomics";`,
    expect: /WGS metagenome is NOT flagged|OTHER\/METAGENOMIC is NOT flagged/,
  },
  {
    // Restores the assumption that read_count always counts both mates. That is
    // true of ERR14098649 and false of ERR4421639, and being wrong about it
    // marks perfectly downloaded runs "INCOMPLETE — the file served does not
    // match the catalogue".
    name: "read_count: assume one convention for paired runs",
    why: "every run whose read_count counts spots is reported as corrupt",
    from: `  if (String(layout).toUpperCase() === "PAIRED" && fits(expected * 2)) {
    return { ok: true, capped: false, missing: expected * 2 - observed, note: "" };
  }`,
    to: ``,
    expect: /read_count counts SPOTS is accepted/,
  },
  {
    // The other direction: tolerating a doubling everywhere would gut the check
    // for single-end runs, where there is no ambiguity to tolerate.
    name: "read_count: tolerate a doubling on single-end runs too",
    why: "a single-end file delivering twice its reads would pass unremarked",
    from: `  if (String(layout).toUpperCase() === "PAIRED" && fits(expected * 2)) {`,
    to: `  if (fits(expected * 2)) {`,
    expect: /single-end run with twice the reads is still caught/,
  },
];

// ---- running them ------------------------------------------------------------

// MUT=<substring> runs only the mutations whose name contains it — for working
// on one guard without paying for the whole sweep. The unfiltered run is the
// one that counts.
const ONLY = process.env.MUT ?? "";
const SELECTED = ONLY ? MUTATIONS.filter((m) => m.name.includes(ONLY)) : MUTATIONS;
if (ONLY) console.log(`MUT=${JSON.stringify(ONLY)}: ${SELECTED.length} of ${MUTATIONS.length} mutations`);

const ORIGINALS = new Map();
const abs = (rel) => path.join(REPO, rel);
for (const rel of new Set(SELECTED.map((m) => m.file ?? ENA))) {
  ORIGINALS.set(rel, fs.readFileSync(abs(rel), "utf8"));
}
const BACKUP = path.join(os.tmpdir(), `ena-mutations-${process.pid}`);
fs.mkdirSync(BACKUP, { recursive: true });
for (const [rel, src] of ORIGINALS) fs.writeFileSync(path.join(BACKUP, rel.replace(/\//g, "_")), src);

function runBench(bench) {
  try {
    const out = execFileSync("node", [path.join(HERE, bench)], {
      cwd: REPO, encoding: "utf8", timeout: 300_000,
      env: { ...process.env, ENA_SUITE_PORT: String(8843) },
    });
    return { out, failed: false };
  } catch (e) {
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, failed: true, timedOut: e.killed };
  }
}

const editsOf = (m) => m.edits ?? [[m.from, m.to]];

let holes = 0;
try {
  for (const m of SELECTED) {
    const rel = m.file ?? ENA;
    const bench = m.bench ?? SUITE;
    const original = ORIGINALS.get(rel);
    let mutated = original;
    let applied = true;
    for (const [from, to] of editsOf(m)) {
      if (!mutated.includes(from)) { applied = false; break; }
      mutated = mutated.replace(from, to);
    }
    console.log(`\n### ${m.name}   (${rel} → ${bench})`);
    console.log(`    (removing it means: ${m.why})`);
    if (!applied) {
      console.log(`    SKIP — the code it patches has moved; update this file`);
      holes++;
      continue;
    }
    fs.writeFileSync(abs(rel), mutated);
    let out, failed, timedOut;
    try {
      ({ out, failed, timedOut } = runBench(bench));
    } finally {
      fs.writeFileSync(abs(rel), original);
    }
    const failLines = out.split("\n").filter((l) => l.startsWith("FAIL"));
    const caught = failed && (timedOut || failLines.some((l) => m.expect.test(l)));
    if (caught) {
      console.log(timedOut
        ? "    caught: the bench never terminated — which is the symptom itself"
        : `    caught by ${failLines.length} failing check(s):`);
      for (const l of failLines.slice(0, 6)) console.log(`      ${l}`);
    } else {
      holes++;
      console.log(`    *** NOT CAUGHT — the bench passes without this guard ***`);
      console.log(out.split("\n").slice(-3).join("\n"));
    }
  }
} finally {
  for (const [rel, src] of ORIGINALS) fs.writeFileSync(abs(rel), src);
}

let restored = 0;
for (const [rel, src] of ORIGINALS) if (fs.readFileSync(abs(rel), "utf8") === src) restored++;
const allRestored = restored === ORIGINALS.size;
fs.rmSync(BACKUP, { recursive: true, force: true });
console.log(`\nsources restored: ${allRestored ? "yes" : `NO (${restored}/${ORIGINALS.size}) — restore them from git`}`);
console.log(`${SELECTED.length - holes}/${SELECTED.length} mutations caught by the benches`);
process.exit(holes === 0 && allRestored ? 0 : 1);
