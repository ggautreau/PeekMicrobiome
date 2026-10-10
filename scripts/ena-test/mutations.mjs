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

// The pure modules added since the functional half landed. They are tested by
// their own benches rather than by the ENA suite, and nothing checked whether
// those benches bite — a p-value that is wrong by a factor of two looks exactly
// like one that is right.
const TABLEVIEW = "web/table-view.js";
const STATS = "web/stats.js";
const GROUPS = "web/groups.js";
const KEGG = "web/kegg.js";
const FIGURES = "web/figures.js";
const FUNCSKETCH = "web/func-sketch.js";
const GMM = "web/gmm.js";
// Added with the 2026-10-10 review: each guards a result that came out wrong
// with nothing on screen to say so, and each has a bench that must notice.
const TRIM = "web/fastq-trim.js";
const NAMING = "web/sample-naming.js";
const CLUSTER = "web/cluster.js";
const EXPORTS = "web/exports.js";
const THEME = "web/theme.js";
const RPC = "web/sylph-worker-rpc.js";
const PAGE_STATE = "../../web/page-state.test.mjs";
const WORKER_TEST = "../../web/worker.test.mjs";

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

  // ---- the pure modules, and the benches that are supposed to hold them ------
  {
    name: "sort: drop the tie-break, so equal rows come back in engine order",
    file: TABLEVIEW, bench: "../../web/table-view.test.mjs",
    why: "300 rows at zero in the sorted column reshuffle between two renders of the same data",
    from: `      return String(a.species ?? a.name ?? "").localeCompare(String(b.species ?? b.name ?? ""));`,
    to: `      return 0;`,
    expect: /ties break on the name/,
  },
  {
    name: "sort: no third click, so there is no way back to the table's own order",
    file: TABLEVIEW, bench: "../../web/table-view.test.mjs",
    why: "a reader who sorted by one sample can only get the ranking back by reloading",
    from: `  if (current.dir === "desc") return { col, dir: "asc" };
  return { col: null, dir: "desc" };`,
    to: `  return { col, dir: current.dir === "desc" ? "asc" : "desc" };`,
    expect: /a third gives the table its own order back/,
  },
  {
    name: "Mann-Whitney: make the two-sided p one-sided",
    file: STATS, bench: "../../web/stats.test.mjs",
    why: "every p in the contrast is half what it should be, and a q of 0.06 reads as 0.03",
    from: `    const p = Math.min(1, 2 * Math.min(le / all, ge / all));`,
    to: `    const p = Math.min(1, Math.min(le / all, ge / all));`,
    expect: /perfect separation at 3 v 3 gives exactly 0\.1/,
  },
  {
    name: "Benjamini-Hochberg: correct for nothing",
    file: STATS, bench: "../../web/stats.test.mjs",
    why: "q becomes p, and 468 rows of uncorrected p-values are 23 false findings at 0.05",
    from: `    prev = Math.min(prev, (ps[i] * order.length) / (k + 1));`,
    to: `    prev = Math.min(prev, ps[i]);`,
    expect: /BH is monotone and matches the worked example/,
  },
  {
    name: "group fields: offer the ones with a distinct value per sample",
    file: GROUPS, bench: "../../web/groups.test.mjs",
    why: "the picker fills with sample_accession and the two fields that split the run are lost in it",
    from: `    if (n < 2 || n >= samples.length) continue;`,
    to: `    if (n < 2) continue;`,
    expect: /nor is one with a distinct value per sample/,
  },
  {
    name: "module rows: forget which orthologs they were measured from",
    file: KEGG, bench: "../../web/kegg.test.mjs",
    why: "a module cell opens to an empty list, answering how much without answering of what",
    from: `        row.kos.add(ko);`,
    to: `        void ko;`,
    expect: /a module row carries the orthologs detected in it/,
  },
  {
    name: "legend: budget the columns at the width text was assumed to have",
    file: FIGURES, bench: "../../web/fastq-trim.parity.test.mjs",
    why: "the right-hand legend column runs 26 px past the viewBox and the figure clips its own key",
    from: `Math.floor((colW - 19) / 6.6)`,
    to: `Math.floor((colW - 20) / 5.6)`,
    expect: /stays inside the figure's own frame/,
  },
  {
    name: "contrast: assume one unit, whatever the caller says",
    file: FIGURES, bench: "../../web/fastq-trim.parity.test.mjs",
    why: "the taxonomic matrix already holds percentages, so every difference is printed 100x too big",
    from: `  const pc = (v) => v * scale;`,
    to: `  const pc = (v) => v * 100;`,
    expect: /in the unit the caller says the values are in/,
  },
  {
    name: "contrast: measure the range from zero instead of from the smallest value",
    file: FIGURES, bench: "../../web/fastq-trim.parity.test.mjs",
    why: "'most variable' silently becomes 'most abundant', which is the one thing the figure exists not to do",
    from: `    const hi = Math.max(...r.values), lo = Math.min(...r.values);`,
    to: `    const hi = Math.max(...r.values), lo = 0;`,
    expect: /ranks by spread across samples/,
  },
  {
    name: "protein sketch: one parser for both mates",
    file: FUNCSKETCH, bench: "../../web/func-sketch.test.mjs",
    why: "interleaved mates lose the FASTQ record phase — 247 hashes of 1,054, with nothing thrown",
    from: `      const st = parserFor(stream);`,
    to: `      const st = parserFor(0);`,
    expect: /interleaved mates give the same profile/,
  },
  {
    name: "GMM: report a value however few of the module's steps were found",
    file: GMM, bench: "../../web/gmm.test.mjs",
    why: "a module is a path; one step found out of eight would be reported as the module being present",
    from: `      if (coverage[i] >= minCoverage && path.length) values[i] = median(path);`,
    to: `      if (path.length) values[i] = median(path);`,
    expect: /coverage|steps/,
  },

  // ---- what the pages say and do (source-level bench) ------------------------
  {
    name: "database card: drop the Zenodo paragraph",
    file: INDEX, bench: WIRING,
    why: "the page would again present the ENA mode as the only thing that leaves the tab",
    from: `<strong>Loading a reference database downloads it from <code>zenodo.org</code>.</strong>`,
    to: `<strong>Loading a reference database.</strong>`,
    // Anchored to the PAGE. The loop emits one check of this name per page, the
    // harness matches FAIL lines by regex, and an unanchored name let a
    // permanently-red check on the other page stand in for this one — which is
    // how this very mutation was recorded as caught while nothing tested it.
    expect: /^FAIL index\.html: the Zenodo download is named where the decision is taken/m,
  },
  {
    name: "README: take the database row out of the network table",
    file: README, bench: WIRING,
    why: "the table would say a local FASTQ costs no network traffic, which is false",
    from: `| **Load database** (any published biome) | the catalogue you picked coming *down* from \`zenodo.org\`, once, then cached on your computer — 454 MB for the human-gut default, 13 MB to 3.0 GB for the others | Zenodo sees your IP address and which of these files you asked for |`,
    to: ``,
    expect: /names the Zenodo download in its network table/,
  },
  {
    name: "Profile all: only `pending` samples may re-enable it",
    file: MULTI, bench: WIRING,
    why: "the retry path exists in runAll() and no button reaches it",
    from: `const RERUNNABLE = ["pending", "failed", "cancelled", "incomplete", "empty"];`,
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
    from: `          : s.origin === "ena"
            ? readCountVerdict({ observed: readsShown(s), expected: s.enaReads, maxReads,
                // Paired runs have two possible readings of the ENA's read_count.
                layout: s.kind === "pe" ? "PAIRED" : "SINGLE", stop })
            : { ok: true, note: "" };`,
    to: `          : { ok: true, note: "" };`,
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
  // ---- the 2026-10-10 review ------------------------------------------------
  {
    name: "page: let a second click start a second run",
    file: MULTI, bench: PAGE_STATE,
    why: "two runs on one pool interleave their reads: a gut sample came back with no species",
    from: `  if (busy || !dbMeta) return;
  claimBusy("run");`,
    to: `  if (!dbMeta) return;
  claimBusy("run");`,
    expect: /a second click during the run starts nothing/,
  },
  {
    name: "page: drop the INCOMPLETE flag from the exported matrix",
    file: MULTI, bench: PAGE_STATE,
    why: "a column profiled on part of its input is read, a month later, as a whole run",
    from: "  const incompleteLines = incompleteNotes(samples).map((l) => `# ${l}`);",
    to: "  const incompleteLines = [];",
    expect: /the exported matrix carries the flag/,
  },
  {
    name: "worker: handle messages as they arrive, not one at a time",
    file: WORKER, bench: WORKER_TEST,
    why: "one Profiler, two samples fed into it at once — each comes back with a fraction of its reads",
    from: "  queue = queue.then(() => handle(e.data, ac)).catch(() => { /* handle() replies itself */ });",
    to: "  handle(e.data, ac).catch(() => { /* handle() replies itself */ });",
    expect: /two samples sent together are profiled one after the other/,
  },
  {
    name: "worker: fetch the KEGG reference instead of using the bytes the page sent",
    file: WORKER, bench: WORKER_TEST,
    why: "eight workers, eight downloads of one 20 MB file, under a line that says once",
    from: `        pkg, refUrl, bytes,
        onProgress:`,
    to: `        pkg, refUrl,
        onProgress:`,
    expect: /the worker fetched NOTHING for it/,
  },
  {
    name: "worker: report a sketch that stopped on a malformed record as a whole sample",
    file: WORKER, bench: WORKER_TEST,
    why: "a FASTQ damaged at 10 % comes back as a complete sample profiled on a tenth of it",
    from: "  if (!fallback && profiler?.sample_halted === true && profiler?.sample_invalid !== true) {",
    to: "  if (false) {",
    expect: /a malformed record says stop: truncated/,
  },
  {
    name: "trimmer: leave the seam between two files without a newline",
    file: TRIM, bench: WORKER_TEST,
    why: "a first file with no final newline swallows the header of the second, and the rest of it",
    from: "            consumeChunk(Uint8Array.of(0x0A));",
    to: "            /* the seam left as it is */",
    expect: /a file with no final newline does not swallow the next one/,
  },
  {
    name: "trimmer: take a cancelled reader's end for the end of the file",
    file: TRIM, bench: "../../web/fastq-trim.parity.test.mjs",
    why: "cancelling an uncompressed FASTQ records the reads read so far as a finished sample",
    from: `          if (signal?.aborted) throw aborted();
          // Closing the gzip stream`,
    to: `          // Closing the gzip stream`,
    expect: /a cancelled .* read rejects with an AbortError/,
  },
  {
    name: "ENA: follow a redirect off the allow-list",
    file: ENA, bench: SUITE,
    why: "an EBI host answering with a redirect sends the request, and the IP address, anywhere",
    edits: [
      [`headers, signal: req.signal, cache: "no-store", redirect: "error",`,
       `headers, signal: req.signal, cache: "no-store",`],
      [`headers, signal: req.signal, cache: "no-store", redirect: "error",`,
       `headers, signal: req.signal, cache: "no-store",`],
    ],
    expect: /the stream fails instead of delivering the redirected body/,
  },
  {
    name: "pairing: let the earliest marker win over R1/R2",
    file: NAMING, bench: "../../web/fastq-trim.parity.test.mjs",
    why: "sample_1_R1 and sample_2_R1 are paired with each other: two samples profiled as one",
    from: "    if (!best || cand.r || !best.r) best = cand;",
    to: "    if (!best) best = cand;",
    expect: /sample_1_R1 is mate 1 of sample_1/,
  },
  {
    name: "pairing: pair two files that claim the same mate",
    file: NAMING, bench: PAGE_STATE,
    why: "two libraries mixed into one sample in the order the files were dropped",
    from: "    for (const name of c.names) tags.set(name, null);",
    to: "    /* both claimants kept */",
    expect: /neither claimant is paired/,
  },
  {
    name: "clustering: move the values and leave the step coverage behind",
    file: CLUSTER, bench: "../../web/cluster.test.mjs",
    why: "a Gut Metabolic Module cell describes another sample's steps",
    from: `  row: Object.freeze(["values", "coverage"]),`,
    to: `  row: Object.freeze(["values"]),`,
    expect: /every GMM value AND its step coverage stay with their sample/,
  },
  {
    name: "exports: write MetaPhlAn and BIOM from an aggregated table",
    file: EXPORTS, bench: "../../web/exports.test.mjs",
    why: "136 observations called '1 genome', and genera written as species",
    from: "  if (bad) {",
    to: "  if (false) {",
    expect: /refuses the table aggregated to genus/,
  },
  {
    name: "theme: wire the toggle to the first .theme-toggle on the page",
    file: THEME, bench: PAGE_STATE,
    why: "the moon button does nothing and the Settings gear flips the palette",
    from: `  return doc.getElementById("themeToggle")
    ?? doc.querySelector('.theme-toggle[aria-label="Toggle theme"]');`,
    to: `  return doc.querySelector(".theme-toggle");`,
    expect: /opening Settings leaves it dark|the theme button flips to dark/,
  },
  {
    name: "wasm build: ignore the database's size",
    file: RPC, bench: WORKER_TEST,
    why: "soil does not fit in 4 GB: the 32-bit build aborts inside new Profiler, and the worker is lost",
    from: "  if (need <= room) return null;",
    to: "  if (true) return null;",
    expect: /a database that cannot fit the 32-bit build is refused with a sentence/,
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

// THE ORIGINAL HAS TO BE THE COMMITTED FILE, and neither of these checks is
// hypothetical. A run killed mid-mutation — a timeout, a Ctrl-C, a terminated
// shell — leaves `if (false)` in the source. The next run reads THAT as its
// original, patches it, puts it back, and reports "sources restored: yes". The
// damage is laundered: two guards sat disabled in the working tree, one of them
// the allow-list that keeps this page from fetching a URL off any host, and the
// only trace was two mutations reporting that the code they patch had moved —
// which reads as drift in the source rather than as a missing guard.
{
  // The precise check, and a hard stop: a mutation whose `from` is gone and
  // whose `to` is present is not drift, it is this bench's own leftover. Nothing
  // else writes `if (false)` where a guard used to be.
  const leftover = SELECTED.filter((m) => {
    const src = ORIGINALS.get(m.file ?? ENA) ?? "";
    // editsOf() is defined below and gives the same [from, to] pairs the run
    // uses, so this cannot check a different edit from the one applied.
    const pairs = m.edits ?? [[m.from, m.to]];
    return pairs.some(([from, to]) => from && to && !src.includes(from) && src.includes(to));
  });
  if (leftover.length) {
    console.error(`These guards are ALREADY REMOVED in the working tree — a killed run of ` +
      `this bench left its own patch behind:\n` +
      leftover.map((m) => `  ${m.name}  (${m.file ?? ENA})`).join("\n") +
      `\n\nRestore them (git checkout -- <file>) before running: this bench would ` +
      `otherwise treat the damaged file as the original and report it restored.`);
    process.exit(2);
  }

  // The broad check, and only a warning: a dirty file is normal while the code
  // is being worked on, and CI runs on a clean checkout where this never prints.
  // Refusing here would make every local run pass an override flag, and a guard
  // everyone routinely overrides is not a guard.
  const dirty = [...ORIGINALS.keys()].filter((rel) => {
    try {
      execFileSync("git", ["diff", "--quiet", "--", rel], { cwd: REPO, stdio: "ignore" });
      return false;
    } catch { return true; }
  });
  if (dirty.length) {
    console.log(`note: ${dirty.join(", ")} differ${dirty.length === 1 ? "s" : ""} from git. ` +
      `This bench restores what it FOUND, not what was committed.`);
  }
}

// A copy on disk as well as in memory, and it survived a rewrite of the block
// above only by being put back: dropping it left `fs.rmSync(BACKUP)` at the
// bottom throwing ReferenceError after a complete, correct run — the sources
// were restored and the verdict never printed. It is the last resort if this
// process is killed in a way that runs neither the finally nor the signal
// handlers (SIGKILL, a power cut): the originals are still readable here.
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

// THE ROOT CAUSE of the laundering above: the `finally` at the bottom restores
// the sources, and a SIGNAL does not run it. `node mutations.mjs | head` is
// enough — head closes the pipe, node dies of SIGPIPE mid-mutation, and `if
// (false)` stays in the file. So the restore is also wired to every way this
// process can be told to stop.
//
// Registered BEFORE the first write, and it re-reads nothing: ORIGINALS is
// already in memory, which is the only copy that can be trusted once the file on
// disk is the mutated one.
// WHAT WE LAST WROTE to each file, so the restore can tell "this is my patch"
// from "somebody edited this while I was running".
const LAST_WRITTEN = new Map();
const write = (rel, text) => { LAST_WRITTEN.set(rel, text); fs.writeFileSync(abs(rel), text); };

// ONLY restore what we put there. This bench rewrites README.md, index.html,
// multi.js, sylph-worker.js and ena.js, and a full run takes eight minutes — long
// enough for somebody to edit one of them. Restoring blindly throws that work
// away, silently, and git then reports the file unmodified: it happened twice
// here, and the only symptom was an edit that "did not take".
//
// BOTH restore paths go through this. Putting the check only on the end-of-run
// restore left the one that actually runs constantly — after every single
// mutation — still clobbering, which a race test caught immediately.
const restoreOne = (rel, src, { quiet = false } = {}) => {
  const now = fs.readFileSync(abs(rel), "utf8");
  if (now === src) { LAST_WRITTEN.delete(rel); return true; }
  const mine = LAST_WRITTEN.get(rel);
  // `undefined` means WE HAVE NOT WRITTEN THIS FILE — not that anything goes.
  // The first version of this check read it as "no patch of mine to compare
  // against, so restore", which put back the original over an edit made while
  // the bench was running but before it reached that file's mutation. A file we
  // never touched is not ours to restore.
  if (mine === undefined || now !== mine) {
    if (!quiet) {
      console.error(`\n*** ${rel} was edited while this bench was running, and this ` +
        `bench rewrites it. Leaving it exactly as you left it — the mutation that was ` +
        `in flight may still be in there, so check it (git diff -- ${rel}). ***`);
    }
    return false;
  }
  fs.writeFileSync(abs(rel), src);
  LAST_WRITTEN.delete(rel);
  return true;
};

const restoreAll = () => {
  for (const [rel, src] of ORIGINALS) {
    try { restoreOne(rel, src); } catch { /* nothing better to do while dying */ }
  }
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGPIPE"]) {
  process.on(sig, () => { restoreAll(); process.exit(130); });
}
process.on("uncaughtException", (e) => { restoreAll(); console.error(e); process.exit(1); });

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
    // THE HOLE THE GUARD BELOW DID NOT COVER, and it cost a working feature.
    // The restore checks that the file is still OUR patch before putting the
    // original back — but nothing checked before WRITING the patch. So an edit
    // made while this bench was running, before it reached that file, was
    // overwritten by the mutation and then "restored" to the pre-edit original,
    // which the guard could not tell from a clean run. Seven changes to
    // multi.js vanished that way, with the log reporting success.
    //
    // So: refuse to mutate a file that is neither the original nor our own last
    // patch. Somebody is working in it.
    {
      const now = fs.readFileSync(abs(rel), "utf8");
      const mine = LAST_WRITTEN.get(rel);
      if (now !== original && (mine === undefined || now !== mine)) {
        console.log(`\n### ${m.name}   (${rel} → ${bench})`);
        console.log(`    SKIPPED — ${rel} changed while this bench was running. ` +
          `Not touching it.`);
        holes++;
        continue;
      }
    }
    console.log(`\n### ${m.name}   (${rel} → ${bench})`);
    console.log(`    (removing it means: ${m.why})`);
    if (!applied) {
      // "The code has moved" was the only explanation this offered, and it sent
      // a reader looking for a refactor when the truth was that the guard was
      // ALREADY GONE — the text to patch was missing because someone (a killed
      // run of this very bench) had patched it out and left it there.
      console.log(`    SKIP — the text this patches is not in ${rel}. Either the code ` +
        `moved and this file needs updating, or the guard is already gone.`);
      holes++;
      continue;
    }
    write(rel, mutated);
    let out, failed, timedOut;
    try {
      ({ out, failed, timedOut } = runBench(bench));
    } finally {
      restoreOne(rel, original);
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
  restoreAll();
}

let restored = 0;
for (const [rel, src] of ORIGINALS) if (fs.readFileSync(abs(rel), "utf8") === src) restored++;
const allRestored = restored === ORIGINALS.size;
fs.rmSync(BACKUP, { recursive: true, force: true });
console.log(`\nsources restored: ${allRestored ? "yes" : `NO (${restored}/${ORIGINALS.size}) — restore them from git`}`);
console.log(`${SELECTED.length - holes}/${SELECTED.length} mutations caught by the benches`);
process.exit(holes === 0 && allRestored ? 0 : 1);
