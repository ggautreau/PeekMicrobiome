// What the pages CLAIM, and whether the code they ship does it.
//
//   node scripts/ena-test/wiring.mjs        (instant, no server, no browser)
//
// Source-level assertions, and labelled as such. node-suite.mjs owns the
// behaviour of web/ena.js and page.mjs owns the rendered page; what neither of
// them reads is a sentence in a banner, a button that stays greyed out, or a
// field that is written and never displayed. Every check here fails if its fix
// is removed — that is what makes it a test — but none of them proves a running
// page, so the browser suite stays the authority on everything it can reach.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.join(REPO, p), "utf8");

let passes = 0, failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `   [${detail}]` : ""}`);
};

const ena = read("web/ena.js");
const multi = read("web/multi.js");
const worker = read("web/sylph-worker.js");
const index = read("web/index.html");
const profileHtml = read("web/profile.html");
const readme = read("README.md");

// The banner, isolated: a claim made three sections further down the page is
// not the claim a user reads before dropping a file.
const banner = (src) => src.match(/<div class="privacy-notice"[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? "";
const indexBanner = banner(index);
const profileBanner = banner(profileHtml);

console.log("== the privacy banner says everything that leaves this tab ==");
// The version this replaces made TWO claims — "your files never leave" and "the
// ENA mode is a download" — and by structure that reads as "the ENA mode is the
// only exception". It is not: the default database option downloads 433 MB from
// zenodo.org, and loading a database is REQUIRED before anything can be
// profiled, including a purely local FASTQ. The omission was in the one
// sentence the whole project is judged on.
// CONTRACT CHANGE, 2026-08-08. The banner used to carry the full detail of both
// downloads, and on a phone that made it 894 px tall — taller than the screen —
// with the first control 2,080 px down. The detail moved to the CONTROLS: the
// Zenodo paragraph now sits under the biome picker, the ENA one inside the ENA
// panel, each next to the button that makes the request.
//
// SCOPED, and matched on the CLAIM rather than on a word that appears in it.
//
// Both halves of that matter, and both were learned the hard way in this file.
// index.html's database card holds a biome <select> whose options read "Human
// gut — 4,744 species, 433 MB, downloads from Zenodo", "6 MB, bundled" and
// "__local__" — so /zenodo\.org/, /433 MB/, /bundled/ and /local/ all match with
// the prose deleted. Every one of those was a check that could not fail. What is
// asserted below is the sentence the reader needs, on the tag-stripped text, so
// a decoy in an attribute or an option label cannot stand in for it.
const dbCard = (src) => src.match(/<section class="card" id="cardDb">[\s\S]*?<\/section>/)?.[0] ?? "";
const enaPanel = (src) => src.match(/<details class="ena" id="enaPanel">[\s\S]*?<\/details>/)?.[0] ?? "";
const prose = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

// WHERE the detail lives differs between the pages, and this bench used to
// assume it did not. index.html moved it to the database card in the 2026-08-08
// change; profile.html has no `id="cardDb"` — its cards are unnamed — and keeps
// the detail in the banner. `dbCard(src) || b` covers both without naming a
// file, and keeps working the day profile.html grows a card of its own.
//
// `ena` is declared here rather than sniffed from the page: a guard whose
// precondition is read out of the artefact it audits cannot fail closed. Reword
// the page to say "EBI" everywhere and a sniffing gate would silently delete the
// check it is gating.
for (const [name, b, src, ena] of [["index.html", indexBanner, index, true],
                                   ["profile.html", profileBanner, profileHtml, false]]) {
  const detail = prose(dbCard(src) || b);
  // On failure, name what was looked for — never a near-miss found nearby. A
  // FAIL line that quotes the decoy ("…433 MB, downloads from Zenodo", from the
  // option) reads as a false alarm and gets dismissed, which is how a real
  // deletion survives review.
  const want = (t) => `expected the sentence: "…${t}…"`;
  check(`${name}: the banner exists at all`, b.length > 200, `${b.length} chars`);
  check(`${name}: your own files never leave, in any mode`,
    /never leave your computer/.test(b));
  // The reason this bench exists: the banner once named only the ENA download,
  // which by structure read as "the ENA mode is the only exception" when loading
  // a database is REQUIRED before anything can be profiled, including a purely
  // local FASTQ. So the database download must be named on both pages — and the
  // ENA one on the page that has an ENA mode. profile.html has none: zero
  // occurrences of "ENA" or "accession" in the file.
  check(`${name}: the banner names the database download, which every mode makes`,
    /reference database/i.test(b), prose(b).slice(0, 130));
  if (ena) {
    check(`${name}: ...and the ENA download beside it, on the page that makes it`,
      /(ENA|EBI)/.test(b), prose(b).slice(0, 130));
  }
  check(`${name}: the Zenodo download is named where the decision is taken`,
    /downloads it from zenodo\.org/i.test(detail), want("downloads it from zenodo.org"));
  check(`${name}: ...with its size`,
    /database is 433 MB/i.test(detail), want("database is 433 MB"));
  check(`${name}: ...and who sees the request`,
    /zenodo sees your ip address/i.test(detail), want("Zenodo sees your IP address"));
  check(`${name}: ...and the way to avoid it`,
    /downloads nothing at all/i.test(detail), want("downloads nothing at all"));
}
check("index.html: the ENA download is named too, with what the EBI learns",
  /EBI/.test(index) && /accessions you looked up/.test(index));
check("profile.html no longer claims no data is sent to any server",
  !/No data is sent to any server/i.test(profileHtml));
// The allow-list accepts every host under ebi.ac.uk; naming one host in the
// banner promised something narrower than the code enforces.
// The host rule moved with the rest of the detail: it is stated at the ENA
// panel, next to the field that takes an accession. Scoped to that panel and not
// to the file — the whole-source form is the weakness described above, and it
// would pass with the sentence moved to the footer.
check("index.html: the ENA panel describes the allow-list the code applies",
  /any host under ebi\.ac\.uk/i.test(prose(enaPanel(index))),
  prose(enaPanel(index)).match(/[^.]*any host under[^.]*\./i)?.[0]?.slice(0, 120) ?? "(sentence absent)");
check("ena.js says the same thing where the list is defined",
  /every host under ebi\.ac\.uk/i.test(ena));

console.log("\n== the README table lists every request, not one of them ==");
check("the README names the Zenodo download in its network table",
  /\| \*\*Load database\*\*[^|]*\|[^|]*zenodo\.org/.test(readme),
  readme.match(/\| \*\*Load database\*\*[^\n]*/)?.[0]?.slice(0, 120));
check("...and says a database load is required before anything is profiled",
  /required before anything can be profiled/.test(readme));
check("the README no longer calls the ENA mode the one place data crosses the network",
  !/the one place data does cross the network/.test(readme));
check("...and the read-count check is documented", /read_count/.test(readme));

console.log("\n== multi.js: what the user is shown ==");
// enaNote was written onto every ENA sample and read by nobody: "profiled as
// single-end", "not named _1/_2", "3 files read one after the other" all
// vanished the moment a run joined the sample list.
check("the ENA note parseRunRow took the trouble to write is rendered",
  /s\.enaNote[\s\S]{0,200}ena-note/.test(multi), "renderFilesList");
// The profiled read count was neither compared with read_count nor displayed.
check("the profiled read count is kept from the RPC answer",
  /\(\{ tsv, reads \} = s\.origin === "ena"/.test(multi));
// Shown WITH ITS UNIT: "3,000,000" alone is ambiguous between three million
// pairs and three million sequenced reads, and the two differ by 2x.
check("...and shown on the finished sample, with the unit named",
  /\$\{shown\.toLocaleString\(\)\} \$\{unit\} profiled/.test(multi) &&
  /const unit = s\.kind === "pe" && !pairsCountAsTwo\(\) \? "pairs" : "reads"/.test(multi));
// Compared in the unit the user is reading, not the worker's raw pair count.
// Written across lines, and with a fourth argument, since this was pinned to one
// line of source. The claim is the arguments, not their layout.
// Across lines, but every argument named: `layout` decides whether the
// spots-convention branch in readCountVerdict can fire at all, and dropping it
// reports every paired run whose read_count counts spots as INCOMPLETE. Nothing
// else in any bench asserts this call site.
check("...and compared with the count the ENA published, in the same unit",
  /readCountVerdict\(\{\s*observed:\s*readsShown\(s\),\s*expected:\s*s\.enaReads,\s*maxReads,[\s\S]{0,120}?layout:/
    .test(multi));
// Carried onto the sample CONVERTED, and the raw figure kept beside it so the
// conversion can be redone when the unit changes. Asserting `enaReads: r.reads`
// here — as this check once did — pinned the bug rather than the behaviour.
check("...with the run's read count carried onto the sample, converted to the unit in force",
  /enaReads: expectedProfiledReads\(\{/.test(multi) &&
  /pairsAsTwo: pairsCountAsTwo\(\)/.test(multi) &&
  /enaReadCount: r\.reads/.test(multi));
// The cap crosses over in exactly one place, on the way into the worker.
check("...and the cap is converted once, where it enters the worker",
  /const cap = capFor\(s, maxReads\)/.test(multi) &&
  !/rpc\.profileFilesPe\(r1Files, r2Files, maxReads/.test(multi));
// The rule is now written the other way round and carries the "empty" case that
// was added beside it, so the old spelling matched nothing.
check("a shortfall becomes a status of its own, not a plain 'done'",
  /!verdict\.ok \? "incomplete"/.test(multi) && /"empty" : "done"/.test(multi));

console.log("\n== multi.js: the buttons and the counters ==");
// runAll() has always re-queued failed samples; the only button that reaches it
// was disabled as soon as nothing was `pending` any more — while the error text
// on the line said "start it again".
check("Profile all is re-enabled for samples that can be run again",
  /RERUNNABLE\s*=\s*\[[^\]]*"failed"[^\]]*\]/.test(multi)
  && /files\.some\(f => RERUNNABLE\.includes\(f\.status\)\)/.test(multi),
  multi.match(/const RERUNNABLE[^\n]*/)?.[0]);
check("...including cancelled and incomplete ones",
  /RERUNNABLE\s*=\s*\[[^\]]*"cancelled"[^\]]*"incomplete"[^\]]*\]/.test(multi));
// A click on Cancel used to report "0 samples ok, 12 failed", console.error and
// all, which is indistinguishable from a network collapse.
check("a user cancellation is not counted as a failure",
  /const cancelled = abortCtrl\.signal\.aborted \|\| e\?\.name === "AbortError"/.test(multi)
  && /if \(cancelled\) cancelCount\+\+; else \{ failCount\+\+;/.test(multi));
check("...and it is reported apart in the final line",
  /cancelCount \? `, \$\{cancelCount\} cancelled`/.test(multi));

console.log("\n== multi.js: the numbers shown before a click ==");
// The rate came from ONE stream while N ran in parallel, and was labelled
// "measured on your link".
check("the measured rate is scaled by the number of streams sharing the link",
  /const linkBps = bps \* Math\.max\(1, streams\)/.test(multi));
check("...counted by the samples actually downloading",
  /if \(s\.origin === "ena"\) netActive\+\+/.test(multi)
  && /netActive = Math\.max\(0, netActive - 1\)/.test(multi));
// localStorage.setItem is synchronous, on the main thread, and noteRate runs on
// every progress event of every stream.
check("the rate is not persisted on every progress event",
  /now - bpsPersistedAt < BPS_PERSIST_MS/.test(multi));
// "0 B … about 0 s" in front of a multi-hour download.
check("both cost lines go through downloadEstimate",
  (multi.match(/downloadEstimate\(/g) ?? []).length >= 2);
check("...bounded by the read cap",
  /downloadEstimate\([\s\S]{0,200}maxReads: currentReads\(\)/.test(multi));
check("...and recomputed when the read cap moves",
  /function enaCostChanged/.test(multi)
  && (multi.match(/enaCostChanged\(\);/g) ?? []).length >= 3);
check("an unknown size never becomes an ETA",
  /if \(!est\.estimable\)/.test(multi) && /cannot be estimated/.test(multi));

console.log("\n== the guards that have no other witness ==");
// Four of the six error paths in openRequest cancelled the body; two did not,
// leaving a response (and its socket) pinned until the garbage collector.
check("ena.js releases the response body on the unexpected-status path",
  /if \(!resp\.ok && resp\.status !== 206\) \{[\s\S]{0,600}?resp\.body\?\.cancel\(\)/.test(ena));
// The worker is the boundary that opens the connection.
check("the worker re-checks the host allow-list on what arrives by postMessage",
  /function urlSources[\s\S]{0,600}?fastqUrl\(d\?\.url\)/.test(worker)
  && /refusing to download/.test(worker));
check("...and the source itself refuses a host outside the list",
  /const checked = fastqUrl\(url, allowHosts\)/.test(ena));

console.log("\n== enaLookup(): one missing element must not kill the panel ==");
// The module-level guards all use `?.`; enaLookup checked #enaAcc and then
// dereferenced four other elements directly — including in its `finally`, where
// the exception swallowed the resolved runs and left "Look up" disabled.
check("every element enaLookup touches is optional",
  /els\.enaCancelLookup\?\.classList\.add\("hide"\)/.test(multi)
  && !/els\.enaCancelLookup\.classList/.test(multi)
  && /els\.enaResult\?\.classList\.add\("hide"\)/.test(multi)
  && /if \(els\.enaResolve\) els\.enaResolve\.disabled = false;/.test(multi));

console.log("== the ENA read_count is not in the unit the worker reports ==");
{
  const { expectedProfiledReads } = await import("../../web/ena.js");

  // Measured, not assumed: the ENA lists read_count = 13,510,300 for
  // ERR14098649, and zcat of its R1 gives 27,020,600 lines = 6,755,150 records.
  // read_count therefore counts BOTH mates, while the worker counts PAIRS.
  check("a PAIRED run is halved to match what the worker counts",
    expectedProfiledReads({ readCount: 13_510_300, layout: "PAIRED" }) === 6_755_150,
    String(expectedProfiledReads({ readCount: 13_510_300, layout: "PAIRED" })));
  check("a SINGLE run is left alone",
    expectedProfiledReads({ readCount: 845_387, layout: "SINGLE" }) === 845_387);
  check("an unknown count stays unknown",
    Number.isNaN(expectedProfiledReads({ readCount: NaN, layout: "PAIRED" })));

  // The point of the conversion: without it every paired run reads as 50% short,
  // i.e. the whole paired-end mode reports itself truncated.
  const src = read("web/multi.js");
  check("multi.js converts before comparing, rather than passing read_count straight through",
    /enaReads:\s*expectedProfiledReads\(/.test(src));
}

console.log("== the wheel over the ordination finishes its gesture ==");
{
  const src = read("web/multi.js");
  // Handing the wheel back to the page as soon as the zoom cannot move meant one
  // flick of a trackpad zoomed out to the end of the range and then scrolled the
  // page with what was left of the same flick: two things from one gesture.
  check("a wheel that cannot zoom any further is still swallowed mid-gesture",
    /sameGesture/.test(src) && /const stuck = /.test(src) &&
    /if \(stuck && !sameGesture\) return;/.test(src));
  // ...but not for ever: the plot must not be a hole a scroll disappears into.
  check("...and a fresh gesture at the end of the range belongs to the page",
    /wheelAt = now;/.test(src) && /now - wheelAt < \d+/.test(src));
}

console.log("== a saved session can be opened on a page with nothing on it ==");
{
  const html = read("web/index.html");
  const js = read("web/multi.js");
  // "Save session" writes a file whose only door used to be inside the results
  // card — which carries `hide` until there ARE results. So the one moment the
  // door is wanted, a fresh tab, it was not there, and the feature was only
  // reachable by first producing the results it exists to replace.
  const head = html.indexOf('id="openSession"');
  const results = html.indexOf('<section id="results"');
  check("the head carries a way to open a saved session",
    head > 0 && results > 0 && head < results,
    head < 0 ? "no #openSession" : `#openSession at ${head}, #results at ${results}`);
  check("...and it drives the one file input rather than a second one",
    /getElementById\("openSession"\)[\s\S]{0,160}getElementById\("loadSession"\)\?\.click\(\)/.test(js) &&
    (html.match(/id="loadSession"/g) || []).length === 1);
}

console.log("== the reads control is frozen while a run is going ==");
{
  const src = read("web/multi.js");
  // maxReads is read once, when the run starts. A live slider during a run
  // shows a number that is not the one being used, and can ask for a 32/64-bit
  // build switch while the current build is busy.
  check("there is one helper for the controls a run freezes",
    /function setRunControls\(running\)/.test(src));
  // Written against setDisabled(), which replaced direct `.disabled =` writes:
  // the assertions below used to name the old shape and had been failing green-
  // washed ever since, which is how a bench stops being one.
  const frozen = (name) => new RegExp(`setDisabled\\(els\\.${name}, busy\\)`).test(src);
  check("...and it covers the reads number and the slider",
    frozen("maxReads") && frozen("maxReadsSlider"));
  check("...and the database and pool controls it replaced",
    frozen("loadDb") && frozen("poolSize"));
  // The pair unit is the read cap in another unit — capFor() halves the cap when
  // it is ticked — so leaving it live during a run profiles half the samples at
  // half the cap with nothing on screen saying so.
  check("...and the pair unit, which is the cap wearing another name",
    frozen("pairsAsTwo"));
  // The point of the helper: no path can freeze some controls and forget others.
  check("nothing freezes loadDb on its own any more",
    !/els\.loadDb\.disabled = (true|false);/.test(src));
  check("the helper is called on entry and on every exit",
    (src.match(/setRunControls\(true\)/g) || []).length >= 2 &&
    (src.match(/setRunControls\(false\)/g) || []).length >= 3);
}

console.log(`\n${passes} passed, ${failures} failed (wiring)`);
process.exit(failures ? 1 : 0);
