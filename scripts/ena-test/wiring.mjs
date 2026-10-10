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

// ---- the modules parse at all -----------------------------------------------
//
// `node --check web/multi.js` is NOT this guard, and believing it was cost an
// afternoon: on this very file it accepts a dangling ternary — a deletion that
// left `canvas.innerHTML =` followed by a comment and then `: kind === …` — that
// Chrome rejects with "Unexpected token ':'". Verified in both directions.
// A SyntaxError there takes the whole page down: the module graph never
// finishes, so nothing is wired, and the failure a reader sees is a blank page
// rather than a broken figure.
//
// `import()` is the real parse, because it is the same parse. These modules
// reach for `document` and `matchMedia` as soon as they evaluate, so most of
// them throw — and that is fine. Only a SyntaxError is a failure here; anything
// else means the file parsed, which is the whole question.
{
  const { pathToFileURL } = await import("node:url");
  for (const f of ["web/multi.js", "web/figures.js", "web/kegg.js", "web/gmm.js",
                   "web/exports.js", "web/cluster.js", "web/meta.js"]) {
    let err = null;
    try { await import(pathToFileURL(path.join(REPO, f)).href); } catch (e) { err = e; }
    check(`${f} parses as the browser parses it`,
      !(err instanceof SyntaxError), err instanceof SyntaxError ? err.message : "");
  }
}

console.log("== the privacy banner says everything that leaves this tab ==");
// The version this replaces made TWO claims — "your files never leave" and "the
// ENA mode is a download" — and by structure that reads as "the ENA mode is the
// only exception". It is not: the default database option downloads 454 MB from
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
// gut — 4,744 species, 454 MB, downloads from Zenodo", "6.5 MB, bundled" and
// "__local__" — so /zenodo\.org/, /454 MB/, /bundled/ and /local/ all match with
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
  // FAIL line that quotes the decoy ("…454 MB, downloads from Zenodo", from the
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
    /database is 454 MB/i.test(detail), want("database is 454 MB"));
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

console.log("\n== the second sketch: opt-in, and it says what it costs ==");
// Off by default, and it has to stay off by default: it costs a 20 MB download
// and takes about four times as long per sample, and someone who came for "which
// species" must not pay for it without asking. The cost has to be MEASURED and
// stated: the control said "roughly doubles" until it was timed, which was wrong
// by more than a factor of two, in the direction that flatters the feature.
check("the functional opt-in exists and is not checked",
  /id="funcOn"/.test(index) && !/id="funcOn"\s+checked/.test(index));
check("...and says what it costs before it is ticked, in both money and time",
  /<label[^>]*title="[^"]*20 MB[^"]*"[^>]*>\s*<input type="checkbox" id="funcOn"/.test(index) &&
  /<label[^>]*title="[^"]*200,000 reads[^"]*"[^>]*>\s*<input type="checkbox" id="funcOn"/.test(index));
// The claim has to be a measurement, not an impression. "roughly doubles" sat in
// both tooltips until the pair was timed at 2.4 s against 11 s.
check("...and neither page still claims the second sketch merely doubles the time",
  !/roughly doubles/.test(index) && !/roughly doubles/.test(read("web/profile.html")) &&
  !/roughly doubles/.test(multi) && !/roughly doubles/.test(read("web/profile.js")));
// A run that asked for functions and a run that did not are different silences.
// The claim the example makes about itself has to track the code. It said the
// functional pass "runs offline for now" for as long as that was true, and the
// moment the page grew the second sketch that sentence started sending readers
// to look for a limitation that no longer exists.
check("the example no longer says the functional pass runs offline",
  !/runs offline for now/.test(multi) && /also profile functions<\/em> before a run/.test(multi));
check("the Function tab tells a run in progress from a run that never measured",
  /if \(funcWanted\) \{[\s\S]{0,300}Measuring\./.test(multi) &&
  /Functions were not measured for this run/.test(multi));
// The pool outlives a run: a worker that loaded the reference last time would
// keep sketching this time, unasked, at roughly double the cost.
check("...and an unticked run turns the sketch off again in every worker",
  /rpcs\.map\(\(r\) => r\.funcOff\(\)/.test(multi));
// ~60% overall, ~85% on the abundant tail. A reader who takes an empty row as
// "this sample cannot do that" is reading four times more into it than the
// method supports, and nothing else on the page would say otherwise.
const kegg = read("web/kegg.js");
check("what the functional method misses is stated, with the number",
  /export const FUNC_METHOD_NOTE/.test(kegg) && /60 %/.test(kegg) && /85 %/.test(kegg));
// ONE sentence, in ONE place, shown by both pages — not two that can drift.
check("...in one place, shown by both pages",
  /FUNC_METHOD_NOTE/.test(multi) && /FUNC_METHOD_NOTE/.test(read("web/profile.js")) &&
  !/85 %/.test(multi) && !/85 %/.test(read("web/profile.js")));
// Same for the licence question: one key, one wording, one answer covering both
// pages — a reader who answered on one must not be asked again on the other.
check("the KEGG licence question is asked from one place too",
  /export const KEGG_CONSENT_KEY/.test(kegg) && /export function keggGateHtml/.test(kegg) &&
  /keggGateHtml/.test(multi) && /keggGateHtml/.test(read("web/profile.js")) &&
  !/peek-kegg-use/.test(multi) && !/peek-kegg-use/.test(read("web/profile.js")));

// The taxonomic matrix holds percentages, the functional tables hold fractions.
// The one figure that PRINTS an abundance has to be told which, and getting it
// wrong is silent: "+1367.36" for a species that differs by 13.67 points.
check("the contrast figure is told which unit each half's numbers are in",
  /unit: "taxa", pair: contrastPair, scale: 1,/.test(multi) &&
  /pair: contrastPair, scale: 100,/.test(multi));

console.log("\n== the results card, ranked rather than flat ==");
// Five bordered buttons in a row with the same weight as every other control
// read as five actions of equal standing. One joined strip with a selected
// segment reads as "these are views of the same thing".
check("the figures are a segmented switch, with an icon each",
  /class="fig-switch"/.test(index) &&
  (index.match(/class="fig-tab"[^>]*><svg/g) ?? []).length === 5 &&
  (index.match(/class="func-tab"[^>]*><svg/g) ?? []).length === 4);
// Settings on the left, what the run says about itself in the middle, actions on
// the right — ranks instead of one undifferentiated row. Two bars rather than
// three: the results toolbar has no actions left to push right, because the ones
// it had belonged to the card and now sit on the card's title line.
check("...and settings and actions sit at opposite ends of their bar",
  (index.match(/class="tb-spacer"/g) ?? []).length >= 2 &&
  /\.tb-spacer \{ flex: 1 1 2rem/.test(read("web/styles.css")));
// Saving a picture is not one of the five things the figure area is for.
check("...with the save action quieter than the navigation",
  // A menu now, not a button: there are three things a reader may want out of a
  // figure — the plot, the sample panel beside it, or both composed side by
  // side — and a button can only ever offer one.
  /class="fig-action fig-svg-pick hide"/.test(index) &&
  /\.fig-action \{/.test(read("web/styles.css")) &&
  /<option value="both">/.test(index) && /function sideBySideSvg\(/.test(multi));
// The panel holds a pie and three numbers; the figure is a plot of eighteen
// samples or a list of thirty rows. At 50/50 the contrast lanes were 250 px of a
// 570 px card with the other half showing "Pick a sample".
check("...and the figure takes the room the empty panel was holding",
  /flex: 0 1 clamp\(20rem, 32%, 26rem\)/.test(read("web/styles.css")) &&
  /\.fig-canvas \{ flex: 1 1 0; \}/.test(read("web/styles.css")));
// A hundred and two pathways and four hundred and sixty-eight species do not
// want the same top-N, and tying them made choosing thirty on one side quietly
// rewrite the other.
check("each half keeps its own top-N",
  /let funcTopNValue = 10;/.test(multi) && /topN: funcTopNValue/.test(multi) &&
  /if \(id === "funcTopNRange"\) funcTopNValue = n; else figTopN = n;/.test(multi));
// The label column follows the figure's width: fixed at 190 px it truncated a
// species name at 740 px and took half the picture at 420.
check("...and the contrast's labels follow the width they have",
  /width \* 0\.26/.test(read("web/figures.js")));

console.log("\n== a matrix of hundreds has to be searchable ==");
// 468 species by 18 samples, and scrolling was the only way to reach one of
// them: no search, no sort. Both halves get both, from one pure function.
const tv = read("web/table-view.js");
check("both matrices can be searched, by name and by identifier",
  /id="matrixFind"/.test(index) && /id="funcFind"/.test(index) &&
  /export function arrangeRows/.test(tv) && /name\.includes\(needle\) \|\| id\.includes\(needle\)/.test(tv));
check("...and say how many of how many are showing",
  /export function arrangeNote/.test(tv) && /id="matrixFindNote"/.test(index) &&
  /noteEl\.textContent = arrangeNote/.test(multi));
// Clicking a sample column answers "what dominates THIS sample", which the
// matrix's own order — the total across every sample — cannot.
check("...and sorted by clicking a sample column",
  /data-sort-col=/.test(multi) && /aria-sort=/.test(multi) &&
  /export function nextSort/.test(tv));
// Three states, not two: without the third a reader who sorted has no way back
// to the ranking the matrix opened with short of reloading.
check("...with a third click that gives the original order back",
  /if \(current\.dir === "desc"\) return \{ col, dir: "asc" \};/.test(tv) &&
  /return \{ col: null, dir: "desc" \};/.test(tv));

console.log("\n== the tab bar is a radio group, not a toggle ==");
// Clicking the tab that was already on used to blank the figure. It caught three
// separate runs of this page's own bench before it was reported.
check("clicking the open figure tab no longer empties the figure",
  !/toggle && kind === openFig/.test(multi) && /if \(!kind \|\| !lastMatrix\?\.rows\?\.length\)/.test(multi));
check("...and closing is a button of its own, on both halves",
  /id="figClose"/.test(index) && /id="funcFigClose"/.test(index) &&
  /drawFigure\(null\)/.test(multi));

console.log("\n== fewer controls, plainer words ==");
// "Download TSV", "Download CSV" and a dropdown labelled "Also as:" were three
// ways to say one verb, in a toolbar that already had too many slots.
check("the exports are one menu rather than three controls",
  !/id="downloadTsv"/.test(index) && !/id="downloadCsv"/.test(index) &&
  /<option value="tsv">/.test(index) && /<option value="session">/.test(index));
// `>Also as:` — the LABEL as it renders, not the phrase wherever it appears: the
// comment explaining why the control went away names it, and a check that reads
// its own documentation as a failure stays red for ever.
check("...and the labels say what they do",
  // The mark comes first and the word after it — both halves of every control in
  // this rank now read the same way — so the label is matched past whatever
  // stands between the tag and the text rather than immediately after it.
  /id="rankPickWrap">(<svg[^>]*>.*?<\/svg>)?Level:/.test(index) &&
  /group similar rows/.test(index) && !/>\s*Also as:/.test(index));
// ---- one menu for the whole card, at the card's own level --------------------
//
// Export and "Open a session" sat inside the taxonomic toolbar, in the same row
// and at the same weight as "Level" and "group similar rows" — so a save read as
// a setting — and the functional half, plainly not served by that menu, grew a
// second pair of download buttons. Both halves export through one control now,
// and it sits on the card's title line.
check("the card's actions sit on the card's title line, not inside one half's toolbar",
  /<div class="card-head">/.test(index) && /<div class="card-actions">/.test(index) &&
  // Exactly one of each: a duplicate id is a control that silently stops working
  // because the first one on the page is the one the code found.
  (index.match(/id="exportAs"/g) ?? []).length === 1 &&
  (index.match(/id="loadSession"/g) ?? []).length === 1 &&
  !/id="funcTsv"/.test(index) && !/id="funcCsv"/.test(index));
// An entry offered and then refused with an error message is a worse answer than
// an entry that is not there: the function matrix exists only when functions
// were profiled, and a groups file only when there are groups.
check("...and the menu offers only what there is something behind",
  /function syncExportMenu\(/.test(multi) && /id="exportFuncGroup"/.test(index) &&
  /id="exportGroups"/.test(index) &&
  /g\.hidden = !funcOn/.test(multi) && /gr\.hidden = !metaGroups\.size/.test(multi));
// Groups could be READ from a CSV since the first version and made in the page
// since the editor landed — and a grouping made here, eighteen samples clicked
// into two arms, existed only in that tab. The way back out was to write the
// file by hand in another program.
const groupsMod = read("web/groups.js");
check("groups made in the page can leave it, in the format the page reads",
  // In groups.js, beside the reader it has to match, rather than in multi.js
  // beside the <input> the reader happened to be wired to.
  /export function groupsCsvFrom\(/.test(groupsMod) &&
  /export function parseMetadata\(/.test(groupsMod) &&
  /<option value="groups"/.test(index) &&
  // And from the editor, where somebody has just typed them and has not closed
  // the dialog yet — that map is the one they mean.
  /id="groupSave"/.test(index) && /groupsCsvFrom\(list, customGroups\)/.test(multi) &&
  // Every sample, including the ungrouped: a file that dropped them would come
  // back as a run with fewer samples than it has.
  /groups\?\.get\(s\) \?\? ""/.test(groupsMod));
// And what it writes, it can read: a group called "Crohn's, active" survived the
// writer and then broke the splitter it was written for.
check("...and a group name with a comma in it survives the round trip",
  /export function splitDelimited\(/.test(groupsMod) && /export function csvCell\(/.test(groupsMod) &&
  !/split\(\/\[\t,;\]\/\)/.test(groupsMod) &&
  // Under test where the arithmetic is, not only through the page.
  /groupsCsvFrom/.test(read("web/groups.test.mjs")));

// The caption under the function table used to point at Settings for the floor,
// which is a page admitting its control is in the wrong place.
check("the function floor sits beside the table it filters",
  /id="funcMinInline"/.test(index) && /function setFuncFloor/.test(multi) &&
  // The rendered sentence ended in a bracket; the comment that explains the move
  // does not.
  !/Settings changes the floor\)/.test(multi));
// A figure named "PCoA" tells a clinician nothing. The precise caption follows.
check("every figure says in plain words what it is for",
  /const FIG_PLAIN = \{/.test(multi) && /Samples that look alike sit close together/.test(multi) &&
  /FIG_PLAIN\[kind\]/.test(multi));
// 150 px off the top of every visit for a panel read once.
check("the citation notice folds once it has been read",
  /<details class="notice notice-fold" id="noticeCite"/.test(index) &&
  /peek-cite-read/.test(multi));

console.log("\n== what is inside a matrix cell ==");
// "0.88 %" answers how much without answering of what. A KEGG module and a gut
// metabolic module are SETS of orthologs, and the question a reader asks by
// clicking is which ones — in this sample, at what abundance.
check("a module cell can be opened to see what it was measured from",
  /const funcCellDetail = /.test(multi) && /function cellPopHtml/.test(multi) &&
  /cellDetail: \(r, c\) => funcCellDetail\(t, r, c\)/.test(multi));
check("...and the module rows carry the orthologs to show",
  /row\.kos\.add\(ko\)/.test(read("web/kegg.js")) &&
  /kos: \[\.\.\.r\.kos\]\.sort\(\)/.test(read("web/kegg.js")));
// A GMM is a PATH, not a set: a cell can be empty while its orthologs are
// present, because one missing step breaks the module. The detail says which.
check("...a gut metabolic module shows its steps, found and missing",
  /step \$\{i \+ 1\}/.test(multi) && /step-off/.test(multi) &&
  /of this module's steps were found/.test(multi));
// The ortholog level has nothing inside a row that the row's own identifier does
// not already link to, and the pathway level opens KEGG's map instead.
check("...while an ortholog row offers nothing beyond its own identifier",
  /if \(funcGrain !== "module" && funcGrain !== "gmm"\) return null;/.test(multi));
// The card is positioned against the cell's box and is `fixed`: scrolling would
// leave it floating over whatever slid under it, still claiming to describe a
// cell that is no longer there.
check("...and the card closes on Escape, on an outside click, and on scroll",
  /if \(e\.key === "Escape"\) closeCellPop\(\)/.test(multi) &&
  /window\.addEventListener\("scroll", closeCellPop/.test(multi) &&
  /e\.target\.closest\?\.\("#cellPop, \.cell-open"\)/.test(multi));

console.log("\n== the rare taxa are measurements too ==");
// The pie pooled them into ONE grey wedge labelled "other taxa (110)": a hundred
// and ten measurements with no share, no name and nothing to hover. They keep
// the grey and the single legend row — that part was right — and each gets its
// own wedge, its own name and its own share.
{
  const figs2 = read("web/figures.js");
  check("every taxon in an open sample gets its own wedge, pooled or not",
    /const legend = keep\.map/.test(figs2) && /const wedges = legend\.slice\(\)/.test(figs2) &&
    /rest\.forEach/.test(figs2));
  check("...still grey, and still one line in the legend",
    /colour: i % 2 \? GREY_ALT : GREY/.test(figs2) &&
    /label: `other \$\{unit\} \(\$\{rest\.length\}\)`/.test(figs2));
  // Two readers, two mechanisms: the page's tooltip reads the attribute and
  // answers at once, the downloaded file has no page around it and reads the
  // title.
  check("...named for the page and for a file saved out of it",
    /data-taxon="\$\{esc\(s\.label\)\}"/.test(figs2) && /<title>\$\{esc\(s\.label\)\}/.test(figs2) &&
    /function wirePie/.test(multi) && /\.pie-slice/.test(multi));
}

console.log("\n== the contrast's test, and what bounds it ==");
const figs = read("web/figures.js");
const stats = read("web/stats.js");
// The figure carried no p-value and said why. It carries one now because it was
// asked for — and the obligation the refusal came with did not go away.
check("the contrast is tested, exactly, and corrected across the whole table",
  /export function mannWhitney/.test(stats) && /export function benjaminiHochberg/.test(stats) &&
  /benjaminiHochberg\(ps\)/.test(figs) && /Benjamini-Hochberg over \$\{rows\.length\} rows/.test(figs));
// THE FLOOR. At three samples a group the smallest attainable two-sided p is
// 0.1: no row can reach 0.05 however cleanly the groups separate, and a column
// of q near 1 is arithmetic rather than a failure of the data.
check("...and says what the test cannot do at the group sizes in front of it",
  /export function minAttainableP/.test(stats) &&
  /nothing can reach \$\{fmtP\(floorP\)\}/.test(figs));
// Exact, not approximate: 468 rows of the example take 64 ms, so there is no
// reason to reach for the normal approximation at these sizes.
check("...exactly, by permutation, rather than by a normal approximation",
  /exact permutation null/.test(stats) && /exact: true/.test(stats));
// Ranked by EFFECT still. A p-value ordering at nine samples a group is mostly
// an ordering of how many zeros a row has.
check("...while the rows are still ordered by difference, not by p",
  /scored\.sort\(\(x, y\) => y\.score - x\.score\)/.test(figs));
// The claim under the figure had to change with it: it said "not tested". And it
// is said ONCE — inside the figure, where it travels with the picture into
// whatever slide the reader pastes it in. Both captions repeated it at greater
// length, so the same sentence was on screen three times over a plot whose rows
// were being squeezed to fit it.
check("...and neither caption still says the figure is untested",
  !/not tested/.test(multi) && /Mann-Whitney/.test(figs) &&
  !/Mann-Whitney with/.test(multi));

// A dot in a contrast lane stands for a sample exactly as a point in the
// ordination does, and it was the only such mark on the page that could not be
// asked about.
check("a dot in a contrast lane carries the sample it stands for",
  /class="contrast-pt" data-sample=/.test(figs) &&
  /\.pcoa-pt, \.contrast-pt, \.sample-row/.test(multi));
check("...and is painted at its own size, not the ordination's",
  /el\.classList\.contains\("contrast-pt"\)/.test(multi));

console.log("\n== the stylesheet's own names ==");
// Six declarations named --line and --card, which this stylesheet has never
// declared, so every one of them was invalid and dropped: the KEGG gate's
// buttons had no border and no background, and the selected Taxonomy/Function
// tab had neither its border nor its card fill. Found only when two new buttons
// landed in that card and did not look like buttons.
{
  const css = read("web/styles.css");
  const used = new Set([...css.matchAll(/var\(--([a-z0-9-]+)/g)].map((m) => m[1]));
  const declared = new Set([...css.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const ghosts = [...used].filter((v) => !declared.has(v));
  check("every custom property the stylesheet uses is one it declares",
    ghosts.length === 0, ghosts.join(", "));
}

console.log("\n== groups: three ways in, and none of them takes the click ==");
// Groups were a two-column CSV and nothing else — a file the reader had to write
// in another program, on a page whose argument is that you should not have to
// open one. The archive's own metadata was sitting in the session all along.
const groupsSrc = read("web/groups.js");
check("a run's groups can come from a metadata field, from the editor, or from a CSV",
  /export function groupFields/.test(groupsSrc) && /export function groupsFromField/.test(groupsSrc) &&
  /groupSource = "custom"/.test(multi) && /groupSource = "csv"/.test(multi));
// A field with one value, or a distinct value per sample, groups nothing. Both
// are common in archive metadata and offering them buries the two that work.
check("...and only the fields that actually split the run are offered",
  /if \(n < 2 \|\| n >= samples\.length\) continue;/.test(groupsSrc));
// THE DISCOVERABILITY DEFECT, and it was reported as "I do not understand how to
// make the groups". With none, the contrast drew "most variable rows" — a real
// answer to a different question, under a tab labelled Contrast, so nothing said
// a group was missing. It refuses now, and the refusal carries the actions.
check("a contrast with no groups asks for them instead of drawing another figure",
  /function contrastRefusalHtml/.test(multi) &&
  /A contrast is between two groups of samples/.test(multi) &&
  /const needsGroups = kind === "contrast" && !contrastable\(view\)/.test(multi));
check("...with one click for the best field this run has, and one for the editor",
  /id="contrastByField"/.test(multi) && /id="contrastMakeGroups"/.test(multi) &&
  /function wireContrastRefusal/.test(multi));
// The old view is still an answer — it just has to be asked for by name.
check("...and the most-variable view stays available, on request",
  /id="contrastVariable"/.test(multi) && /contrastFallback = true/.test(multi) &&
  /contrastFallback = false/.test(multi));
// "Edit…" answered neither "edit what" nor "does this run have any".
check("...and the button says which of make or edit it is about to do",
  // The LABEL is written, not the button: `button.textContent = ` threw away the
  // icon the markup carries, so the one control in that row that had none was the
  // one whose text was rewritten.
  /editLabel\.textContent = metaGroups\.size \? "Edit groups/.test(multi) &&
  /class="btn-label">Make groups…<\/span>/.test(index));
check("the group editor exists, and is reachable from both halves",
  /id="groupEdit"/.test(index) && /id="figGroupEdit"/.test(index) &&
  /id="funcGroupEdit"/.test(index) && /function openGroupEditor/.test(multi));
// THE CONSTRAINT: the plot's click opens what a sample is made of. A
// "click samples to group them" mode would take that gesture away for as long as
// it was on, so grouping happens in a dialog and the points stay what they were.
check("...as a dialog, so the plot's own click still opens a sample",
  /<dialog id="groupEdit"/.test(index) &&
  /dlg\.showModal\(\)/.test(multi) &&
  !/data-group-click|groupPickMode/.test(multi));
// Groups made by hand travel with the session; groups derived from a field do
// not, because the field is saved beside them and deriving it again is free.
check("hand-made groups are saved with the session, derived ones are not",
  /groups: state\.groups\?\.size \? Object\.fromEntries\(state\.groups\) : null/.test(read("web/exports.js")) &&
  /groups: customGroups/.test(multi) &&
  /customGroups = st\.groups\?\.size/.test(multi));
// The editor has to say when a grouping cannot be contrasted — one group, or two
// groups of one — because the figure's own refusal comes later and elsewhere.
// A single entry that is BOTH the current state and the way to open the file
// picker cannot be chosen twice: re-selecting the selected option fires no
// change event, so one CSV could never be replaced by another.
check("...and loading a CSV stays reachable after one has been loaded",
  /value="csv-load"/.test(multi) && /=== "csv-load"/.test(multi));
// The buttons in the editor are ASSIGNED, not added: openGroupEditor runs on
// every opening, and `once: true` made Apply and Clear dead after one click.
check("...and the editor's buttons work more than once per opening",
  /applyBtn\.onclick = /.test(multi) && /clearBtn\.onclick = /.test(multi) &&
  !/\{ once: true \}/.test(multi));
check("...and a grouping too thin to contrast says so where it is made",
  /export function groupSummary/.test(groupsSrc) && /a contrast needs two/.test(groupsSrc) &&
  /groupEditNote/.test(index) && /groupSummary\(/.test(multi));

console.log("\n== the numbers the page chooses for the machine ==");
// Four was a constant that read neither the core count nor the memory, under a
// comment claiming "the browser reports how many cores it will admit to".
check("the worker pool is sized from the machine, not from a constant",
  /navigator\.hardwareConcurrency/.test(multi) && /navigator\.deviceMemory/.test(multi) &&
  /function suggestedWorkers/.test(multi));
// Every worker holds its own copy of the catalogue — 1.85 GB apiece for the
// 454 MB human-gut database, measured — so the pool has to be bounded by the
// size of the catalogue about to be loaded, not by a fixed number.
check("...and bounded by the size of the catalogue it is about to load",
  /suggestedWorkers\(bytes\)/.test(multi) &&
  /GB_PER_WORKER_PER_BYTE = 1\.85 \/ 454_021_440/.test(multi));
// A number the page chose must say why, or the reader has no basis for moving
// it — and it must stop choosing once they have.
check("...and says why, and stops choosing once the reader has",
  /function workersReason/.test(multi) && /setWorkersWhy/.test(multi) &&
  /setWorkersWhy/.test(index) && /workersChosen = true/.test(multi));

// UHGG v2.0.2's names were generated with GTDB r202, and four releases have
// passed: 631 of the 4,744 human-gut representatives carry a name whose genus is
// gone from r220. A name with no release beside it sends the reader to look it
// up in a GTDB that does not have it.
const biomes = read("web/db/biomes.json");
const bio = read("web/biomes.js");
check("the GTDB release the names come from is recorded",
  /"gtdb": "r202"/.test(biomes) && /"gtdb": "r207"/.test(biomes));
check("...and shown wherever the catalogue is named, on screen and in the export",
  /names from GTDB \$\{ref\.gtdb\}/.test(bio) && /# species names: GTDB \$\{ref\.gtdb\}/.test(bio));
// Only five of the nineteen READMEs state a release. Printing one for the other
// fourteen would be a citation nobody checked.
check("...and NOT invented for the catalogues whose README does not say",
  /ref\.gtdb \?/.test(bio) && /gtdb: biome\?\.gtdb \?\? ""/.test(bio));

console.log("\n== multi.js: what the user is shown ==");
// enaNote was written onto every ENA sample and read by nobody: "profiled as
// single-end", "not named _1/_2", "3 files read one after the other" all
// vanished the moment a run joined the sample list.
check("the ENA note parseRunRow took the trouble to write is rendered",
  /s\.enaNote[\s\S]{0,200}ena-note/.test(multi), "renderFilesList");
// The profiled read count was neither compared with read_count nor displayed.
// `func` joined the destructuring when the second sketch was wired in; `reads`
// is what this line is about, and it must stay whatever else is beside it.
check("the profiled read count is kept from the RPC answer",
  /\(\{ tsv, reads[^}]*\} = s\.origin === "ena"/.test(multi));
// The functional profile arrives on the SAME reply as the TSV — one pass over
// the reads, two sketches — so a sample cannot end up with species from one run
// and functions from another.
check("...and so is the functional profile, from the same reply",
  /\(\{ tsv, reads, func \} = s\.origin === "ena"/.test(multi) &&
  /funcProfiles = \{ \.\.\.\(funcProfiles \?\? \{\}\), \[s\.sampleName\]: func\.profile \}/.test(multi));
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
  // The functional reference goes into the workers once, before the first
  // sample. Ticked mid-run it would leave the earlier samples without a
  // functional profile and the later ones with one.
  check("...and the functional opt-in, which is read once at the start",
    frozen("funcOn"));
  // The point of the helper: no path can freeze some controls and forget others.
  check("nothing freezes loadDb on its own any more",
    !/els\.loadDb\.disabled = (true|false);/.test(src));
  check("the helper is called on entry and on every exit",
    (src.match(/setRunControls\(true\)/g) || []).length >= 2 &&
    (src.match(/setRunControls\(false\)/g) || []).length >= 3);
}

// ---- KEGG is asked about before it is shown ----------------------------------
//
// KEGG's own terms say it "is not a public database" and that non-academic use
// needs a commercial licence. Everything the Function tab draws is KEGG's, so
// the page has to say so BEFORE drawing any of it. These check the sentence and
// the two doors, not the word "KEGG" — the tab label alone would satisfy a
// looser test while the terms went unmentioned.
{
  const index = read("web/index.html");
  const gateProse = prose(multi);
  // Taxonomy and Function are a choice ABOVE the toolbars, not a fifth figure:
  // each side owns a matrix, downloads and figures of its own.
  check("the results split into a taxonomic and a functional half",
    /data-res="taxo"/.test(index) && /data-res="func"/.test(index));
  // Two of them and only two, so each takes half the bar. Left-aligned they read
  // as a button group inside the taxonomic results — which is the reading the
  // whole restructure exists to kill.
  {
    const bar = index.match(/<div class="res-tabs"[\s\S]*?<\/div>/)?.[0] ?? "";
    // `res-tab(?: |")` and not `res-tab[^"]*"`: the container is class="res-tabs"
    // and would count itself as a third tab.
    const tabs = bar.match(/class="res-tab(?: |")/g) ?? [];
    const css = read("web/styles.css").match(/^\.res-tab \{[\s\S]*?\n\}/m)?.[0] ?? "";
    check("the two halves share the bar rather than huddling at its left edge",
      tabs.length === 2 && /flex:\s*1/.test(css), `${tabs.length} tabs`);
    // An icon each: at half the bar the label alone is a lot of empty width, and
    // the pair is easier to tell apart at a glance with a mark than with two
    // words of similar length.
    check("each half carries its own icon", (bar.match(/<svg/g) ?? []).length === 2);
  }
  check("the functional half has its own matrix, and exports through the card's menu",
    /id="funcHead"/.test(index) && /id="funcBody"/.test(index) &&
    /<option value="functsv">/.test(index) && /function downloadFuncMatrix/.test(multi));
  // ONE renderer for both, not two that happen to agree. They agreed for about a
  // day: the functional matrix had one header row instead of two, no heat
  // colour, no identifier column and three decimals instead of two — none of
  // which was visible until the two were seen side by side. Asserted as "neither
  // writes its own rows" rather than "both call the helper", because a caller
  // can call the helper and then overwrite what it drew.
  {
    const calls = (multi.match(/\bpaintMatrix\(/g) ?? []).length;
    check("both matrices are drawn by one renderer",
      calls === 3, `${calls} mentions of paintMatrix (1 definition + 2 callers)`);
    check("...and neither half writes matrix rows of its own",
      !/els\.matrixBody\.innerHTML\s*=/.test(multi) &&
      !/\bbody\.innerHTML\s*=\s*t\.rows/.test(multi));
    // The two things that made them look different, pinned inside the shared
    // renderer so a change moves both halves at once.
    check("...one heat scale and one number format for both",
      /heatColor\(pct\)/.test(multi) && /pct\.toFixed\(2\)/.test(multi));
  }
  // The identifier column: a genome accession opens on MGnify, a KEGG entry on
  // KEGG. Without the link the id is a string a reader has to retype.
  // `urlOf` is conditional now — the GMM level has no KEGG entry to open, since
  // its identifiers are not KEGG's — so the check is on the fallback being
  // keggEntryUrl rather than on the property being spelled one way.
  check("a KEGG identifier in the matrix opens its KEGG entry",
    /urlOf:[^,]*keggEntryUrl/.test(multi) && /keggEntryUrl/.test(read("web/kegg.js")) &&
    /www\.kegg\.jp\/entry\//.test(read("web/kegg.js")));
  check("...in a new tab, with the opener cut",
    /rel="noopener noreferrer"/.test(multi));
  // The functional CSV used to be built by writing the TSV and swapping tabs for
  // commas, with no quoting — and 436 of the 508 KEGG module names carry a comma,
  // so most rows of the downloaded file had more fields than its own header. A
  // broken export is worse than no export: it opens.
  // EVERY join, not "a join somewhere in the function". Written the obvious way
  // — does `.map(esc).join(sep)` appear? — this passed a mutation that removed
  // the escaping from the DATA rows, because the header line still had it. The
  // header is the one line whose fields never contain a comma.
  {
    const body = multi.slice(multi.indexOf("function funcMatrixTsv("));
    const fn = body.slice(0, body.indexOf("\n}\n") + 2);
    const joins = (fn.match(/\.join\(sep\)/g) ?? []).length;
    const escaped = (fn.match(/\.map\(esc\)\.join\(sep\)/g) ?? []).length;
    check("the functional export quotes its own separator, on every line it writes",
      /function funcMatrixTsv\(view, sep = "\\t"\)/.test(multi) &&
      /const esc = csvEscape\(sep\)/.test(multi) &&
      joins > 1 && joins === escaped,
      `${escaped} of ${joins} joins escaped`);
  }
  check("...and is not rebuilt by swapping tabs for commas",
    !/split\("\\t"\)\.join\(","\)/.test(multi));
  // kegg.js invents `_none` for modules on no map. It must not be offered as
  // something to look up: only KEGG's own three identifier shapes get a URL, and
  // the bucket shows no identifier at all rather than this file's own token in a
  // column where every other row can be looked up.
  check("...and only real KEGG identifiers get one",
    /\^\(K\\d\{5\}\|M\\d\{5\}\|map\\d\{5\}\)\$/.test(read("web/kegg.js")));
  check("...while the not-on-a-map bucket shows none",
    /export const NO_PATHWAY/.test(read("web/kegg.js")) &&
    /r\.id === NO_PATHWAY \? "" : r\.id/.test(multi) &&
    // The literal, in an EXPRESSION — `=== "_none"`, `("_none")`, `["_none"]`.
    // Matching the bare string would fail on the comment that explains why the
    // constant exists, which is a check that punishes the explanation.
    !/[=(,[]\s*["']_none["']/.test(multi), "_none must not be spelled out in multi.js");
  // Adapted, not copied: there is no enterotype of a pathway. And no KEGG map
  // figure either — it drew fourteen bars of numbers the matrix beside it shows
  // all 87 of, per sample, and since the pathway rows started opening KEGG's own
  // drawing the honest map is on kegg.jp. A figure that duplicates the table it
  // sits above is a figure the reader has to reconcile.
  check("the functional figures are the ones that make sense for functions",
    /data-ffig="composition"/.test(index) && /data-ffig="pcoa"/.test(index) &&
    !/data-ffig="enterotype"/.test(index) && !/data-ffig="pathway"/.test(index) &&
    !/data-ffig="keggmaps"/.test(index));
  // The coloured KEGG map is per PATHWAY and per SAMPLE, which is a matrix cell.
  // Two tabs tried to be that table and both were the table: a figure of the top
  // fourteen pathways averaged, then a list of links ordered by a quantity that
  // barely distinguishes samples — two of them share 9.6 of their top 10
  // pathways, so its sample picker changed almost nothing on screen.
  check("a matrix cell opens that pathway's map for that sample",
    /cellUrl: funcGrain !== "pathway" \? null/.test(multi) &&
    /keggMapUrl\(r\.id, kos, \{ max \}\)/.test(multi) &&
    /const prof = funcProfiles\?\.\[t\.samples\[c\]\]/.test(multi));
  check("...and the identifier column keeps the plain entry page",
    /linkTitle: \(id\) => `Open \$\{id\} on KEGG`/.test(multi));
  // The three maps KEGG draws in its own palette are asked for in GREY, which is
  // the difference between 2,473,946 coloured pixels that are KEGG's and 119,352
  // that are ours. The switch exists only for 011xx — KEGG's own script gates it
  // on mapno matching /^011/ — and only on the named-parameter URL form.
  check("the global maps are asked for on the grey base",
    /const GREYABLE = \/\^map011/.test(read("web/kegg.js")) &&
    /coloring=grayscale/.test(read("web/kegg.js")) &&
    /multi_query=/.test(read("web/kegg.js")));
  // The colour is the measurement, so it has to be read against something the
  // reader is told about, and the same something on every map.
  check("...on one scale, stated, and log because the tail is three decades down",
    /heatHex/.test(read("web/kegg.js")) && /log scale/.test(prose(multi)) &&
    /Math\.log10\(1 \+ 9 \* x\)/.test(read("web/kegg.js")));
  // The link the deleted figure carried, now on the row it belongs to. A pathway
  // row opens the map with the orthologs found here coloured in; an ortholog or
  // a module has only its entry page, which is what it gets.
  // The coloured map lives on the CELL now — the one place that names both a
  // pathway and a sample — so the row keeps only its plain entry page.
  check("a pathway cell opens KEGG's own map with what that sample carries",
    /keggMapUrl\(r\.id, kos, \{ max \}\)/.test(multi) && /show_pathway/.test(read("web/kegg.js")));
  check("...and a row may still name its own destination, which wins over the identifier's",
    /r\.url \?\? \(id \? urlOf\(id\) : null\)/.test(multi));
  // Shannon needs a partition. The orthologs are one — each measured once, the
  // column summing to 1 — and modules and maps are not: an ortholog in three
  // modules is in all three and the column sums to 1.49. So the diversity figure
  // is computed on the ortholog table WHATEVER the level picker says, or it is
  // an index over categories that share members, which is not an index.
  check("diversity is computed on the one level that is a partition",
    /alphaSvg\(funcTableFor\(view, "ko"\)/.test(multi));
  // The two ordinations are ONE ordination drawn twice: the same layout cache,
  // the same zoom window, the same colour control. Drawn with pcoaSvg directly
  // the functional one had no zoom and no clusters — not a decision, just the
  // half that was built second. And the clusters say something across the two:
  // taxonomically they recover all six people of the example without being told
  // who is who (k=5, silhouette 0.84, nobody split); functionally they do not
  // (k=3, 0.66 over the orthologs). Reading the two plots side by side is the
  // functional-redundancy result.
  check("both ordinations go through the same code, with the same controls",
    /kind === "pcoa" \? ordinationSvg\(t, w, h\)/.test(multi) &&
    /id="funcZoom"/.test(index) && /id="funcColourWrap"/.test(index) &&
    /id="funcTopN"/.test(index));
  check("...and the gestures are bound to both canvases, not one",
    /FIG_CANVASES/.test(multi) && /for \(const el of FIG_CANVASES\)/.test(multi) &&
    !/figCanvasEl/.test(multi));

  // ---- the OTHER licence, and the promise not to carry it --------------------
  //
  // Gut Metabolic Modules are curated by VIB, who license them for academic
  // non-commercial use and forbid passing them outside the licensee's
  // institution. The page therefore ships the parser and asks the reader for
  // their own copy.
  {
    const gmm = read("web/gmm.js");
    // The licence question comes FIRST — before the fetch, before the file
    // picker, before anything of VIB's is on screen.
    check("the GMM level asks about its licence before it fetches anything",
      multi.indexOf('return "gate:gmm"') >= 0 &&
      multi.indexOf('return "gate:gmm"') < multi.indexOf('return "fetch:gmm"'));
    // Answering IS the instruction to fetch. Asking the reader to then go and
    // download a file by hand turned a licence question into a chore, which is
    // how a feature gets abandoned rather than respected.
    check("...and answering it fetches them, with no second errand",
      /loadGmmDefs\(\)\.then\(refreshFunc\)/.test(multi) &&
      /raw\.githubusercontent\.com\/raeslab\/GMMs/.test(multi));
    // From the Raes lab's repository, never from this one: fetching on the
    // reader's instruction is not redistributing, and the difference is the
    // whole licence question.
    // `gmm.js` holds the parser and no definitions — the file name appears there
    // only in the comment explaining why it is not committed.
    check("...from the Raes lab's own repository, and never from this one",
      /const GMM_URL = "https:\/\/raw\.githubusercontent\.com\/raeslab\//.test(multi) &&
      !/K\d{5}\\tK\d{5}/.test(read("web/gmm.js")));
    // A fetch can fail — offline, a proxy, a rename upstream — and a licence the
    // reader holds must not be defeated by a firewall.
    check("...with the file picker still there when the fetch cannot happen",
      /id="gmmRetry"/.test(multi) && /id="gmmPick"/.test(multi) &&
      /Could not fetch the GMM definitions/.test(multi));
    // The page enumerates every request it makes. This is a new one.
    check("...and the new request is declared where the others are",
      /raw\.githubusercontent\.com/.test(index) && /three kinds of request/.test(index));
    check("...names the licence and links to it",
      /Academic\s+Non-commercial Software License/.test(prose(multi)) &&
      /github\.com\/raeslab\/GMMs\/blob\/master\/LICENSE/.test(multi));
    check("...offers both answers the licence allows, as the KEGG gate does",
      /id="gmmAcademic"/.test(multi) && /id="gmmPermitted"/.test(multi) &&
      /I have a licence from VIB/.test(prose(multi)));
    check("...and can be changed where it says it can",
      /Change it under Settings/.test(prose(multi)) && /id="setGmm"/.test(index));
    // THE promise. A future contributor vendoring the file "to make it work out
    // of the box" is precisely the transfer the licence names, and it would look
    // like a helpful commit. Checked on the shipped tree, not on intent: no file
    // may carry the catalogue's own text.
    {
      const tracked = [];
      const walk = (dir) => {
        for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
          if (e.name === "node_modules" || e.name.startsWith(".")) continue;
          const rel = `${dir}/${e.name}`;
          if (e.isDirectory()) walk(rel);
          else if (/\.(js|mjs|json|txt|tsv|csv|md|html|py|sh|yml)$/.test(e.name)) tracked.push(rel);
        }
      };
      walk("web"); walk("scripts"); walk("docs");
      const carriers = tracked.map((f) => {
        const text = fs.readFileSync(path.join(REPO, f), "utf8");
        // The catalogue's own shape — an MF identifier, a tab, a name — counted
        // rather than merely spotted. web/gmm.test.mjs builds three of those by
        // hand and must: a parser with no fixture is a parser nothing tests. The
        // real catalogue is 103, and any appreciable slice of it is the transfer
        // the licence names, so the line sits well above a fixture and well
        // below a subset worth having.
        return [f, (text.match(/\bMF\d{4}\t\S/g) ?? []).length];
      }).filter(([, n]) => n >= 20).map(([f, n]) => `${f} (${n})`);
      check("...and not one file of ours carries the definitions",
        carriers.length === 0, carriers.join(", "));
    }
    // The page contacts two hosts and says so. Fetching the definitions for the
    // reader would be kind and would make the banner false.
    check("the page does not fetch the definitions on the reader's behalf",
      !/fetch\([^)]*raeslab/.test(multi) && !/fetch\([^)]*githubusercontent/.test(multi) &&
      !/fetch\(/.test(gmm));
    // A GMM value is the median along its covered path, gated by a cutoff. It is
    // not a share of the sample, and a column that let a reader add it up would
    // be inviting a total that means nothing.
    check("the GMM level says what its numbers are, and are not",
      /not shares/.test(prose(multi)) && /median along each module's covered path/.test(multi));
    // MF0088 is "butyrate production I" in v1.07 and a different module in the
    // same lab's GOmixer set, where not one of the 103 identifiers keeps its
    // name. An MF number with no version beside it names nothing.
    check("...and names the file its identifiers are meaningful against",
      /gmmName/.test(multi) && /Identifiers are only meaningful against that file/.test(multi));
  }

  check("the answer stays in this browser",
    /localStorage\.setItem\(KEGG_CONSENT_KEY/.test(multi) &&
    !/fetch\([^)]*KEGG_CONSENT/.test(multi));
}

// ---- the GMM fetch has a way out ---------------------------------------------
//
// The screen before it reads "Fetching the GMM definitions" and has no other
// exit. A fetch that never settles — a captive portal, a proxy that accepts the
// connection and then holds it — leaves that sentence up for ever, with the file
// picker that needs no network at all unreachable behind it.
check("the GMM fetch gives up rather than hanging on that sentence for ever",
  /const GMM_TIMEOUT_MS = /.test(multi) && /new AbortController\(\)/.test(multi) &&
  /signal: ctl\.signal/.test(multi) &&
  /setTimeout\(\(\) => ctl\.abort\(\), GMM_TIMEOUT_MS\)/.test(multi));
// The number in the message and the number in the timer are one number.
check("...and the message quotes the deadline rather than repeating it",
  /GMM_TIMEOUT_MS \/ 1000/.test(multi) && !/nothing after 20 seconds/.test(multi));
// 429 is the failure a reader actually meets: raw.githubusercontent.com limits
// by network address, so a shared institutional connection hits it without
// anybody having done anything — and "Try again" is the wrong advice there.
check("...and a rate-limit says what it is instead of printing a bare code",
  /HTTP 429, too many requests/.test(multi) && /rate-limits by network address/.test(multi));

console.log(`\n${passes} passed, ${failures} failed (wiring)`);
process.exit(failures ? 1 : 0);
