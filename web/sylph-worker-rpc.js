// Tiny promise-RPC wrapper around the WASM worker, plus the policy that decides
// WHICH wasm package the worker loads (32-bit or 64-bit).
//
// Use:
//   const rpc = sylphWorkerRpc();
//   const wasm = await rpc.init(maxReads);   // -> { bits, capped, reason, memory64 }
//   const meta = await rpc.loadDb(uint8);                           // transfers ownership
//   const meta = await rpc.loadDbCached(url);   // reads the OPFS entry db-cache.js filled
//   const { tsv } = await rpc.profileFile(file, 1_000_000, onProgress, signal);
//   const { tsv } = await rpc.profileFilesMulti(files, ..., onProgress, signal);
//   const { tsv } = await rpc.profileFilesPe(r1Files, r2Files, ..., onProgress, signal);
//
// `onProgress` is called for each progress event the worker emits.
// `signal` is an optional AbortSignal — aborting it sends a "cancel" message
// to the worker, which propagates into the streaming readAndTrim.
//
// The capability probe and the reads budget live here, not in the worker, for
// one reason: the worker cannot be imported by anything (it calls
// self.addEventListener at load time), so nothing could test them. This module
// has no top-level side effect and is imported by the worker, by both pages,
// and by web/fastq-trim.parity.test.mjs.

// Bump this version when you change the worker or any module it imports, to
// force the browser to refetch instead of reusing its module-worker cache.
// The worker imports fastq-trim.js as "./fastq-trim.js?v=<this>" and this file
// as "./sylph-worker-rpc.js?v=<this>", so all three are always invalidated
// together — bumping only one of them can pair a new worker with a stale
// dependency, whose missing named export kills the worker module at
// instantiation (no fallback: the fallback is inside it).
// Since v9 the version also busts the wasm package (glue + .wasm), which used
// to be fetched at a bare, permanently cacheable path.
// Since v10 it also busts db-cache.js (imported by the worker for
// readCachedBytes) and db-cache-worker.js, and the worker protocol changed:
// "loadDbUrl" is gone, replaced by "loadDbCached". A page paired with a v9
// worker would ask for a message type that no longer exists, so this bump is
// what keeps a cached visitor working.
// Since v12 the worker also imports ena.js (the resumable URL read source for
// the ENA input mode) and answers two new message types, "profileUrls" and
// "profileUrlsPe". A page paired with a v11 worker would ask for message types
// that worker has never heard of and get nothing back but a rejected promise,
// so this bump is again what keeps a cached visitor working.
// The check is enforced by web/fastq-trim.parity.test.mjs.
// v15: the nineteen biome databases were published on Zenodo, so db/biomes.json
// gained the URLs that make them selectable and biomes.js gained a cache-buster
// of its own for that file. A page still holding biomes.js?v=14 would fetch the
// catalogue at its bare path and keep the cached copy in which eighteen of the
// nineteen entries are greyed out as unpublished — the databases would be live
// and the app would go on saying they are not.
// v16: ena.js asks the portal API for library_strategy/source/platform and
// flags runs sylph cannot profile (amplicon, RNA-Seq, capture). A page holding
// ena.js?v=15 would request the old field list, get no strategy back, and every
// run — including the 16S ones — would look profilable, which is the exact
// silence this release is about.
// v17: each sample line carries a progress ring whose full mark is the READ CAP
// when the cap is what ends the sample, and styles.css gained the ring and the
// ENA busy spinner. A page paired with the v16 stylesheet would render the ring
// markup unstyled — two bare SVG circles on every running line.
// v18: every catalogue got a genome -> species-name map (web/db/lineage/*.json)
// and both result tables link each genome to its MGnify page. A page holding
// biomes.js?v=17 would fetch the catalogue at CATALOG_VERSION 2, whose entries
// name no map for eighteen of the nineteen biomes — the vaginal result would go
// on reading "(MGYG000304057.fna.gz)" instead of "Lactobacillus iners".
// v19: readCountVerdict accepts both readings of the ENA read_count on paired
// runs. A page holding ena.js?v=18 goes on marking every run of the "spots"
// convention INCOMPLETE — all 91 of PRJEB34536, on downloads that were perfect.
// v20: the read cap names its own unit. "Max reads per sample: 3,000,000" with
// the pair box unticked meant three million PAIRS — six million sequenced reads
// — so the label contradicted the unit. The word now follows the box and the
// conversion is spelled out. index.html and styles.css changed with multi.js.
// v21: biome screening is wired in. multi.js imports screening.js and spawns a
// throwaway worker for it; index.html and styles.css carry the panel. A page on
// v20 has no screening.js to import, so the module graph fails to load.
// v22: db-cache trusts the size the CALLER knows over the one the headers
// report. GitHub Pages serves the bundled databases gzipped, so Content-Length
// is the compressed size while fetch() delivers them decompressed — a page on
// v21 aborts every screening download with "the server sent more than the
// 11736250 bytes it declared".
// v23: automatic mode names the sample it will screen, and says the whole batch
// follows the one catalogue it picks.
// v24: six interface bugs found by review — the mobile horizontal scroll, a
// failed wasm boot hanging Load database, zero species reported as success, an
// orphan mate building an empty sample, the ENA rows overprinting themselves,
// and a sticky matrix header that never engaged.
// v25: accessibility — the FASTQ drop zone is keyboard-reachable, status lines
// are aria-live, the progress bar has progressbar semantics, and two colour
// tokens were darkened to clear WCAG AA.
// v26: the three notice panels were halved — the two download paragraphs moved
// to the controls they describe and the duplicate biome panel went — plus the
// gut-only copy and the drop-files-only opening sentence.
// v27: the read cap is grouped ("3 000 000"), which needs a text field — so the
// value must be read back through a parser. A page on v26 pairs the new markup
// with the old handlers and reads 3 for three million.
// v28: every disabled control now carries the reason it is refusing, on the
// control itself and — for the ones frozen by a run — in a visible line, since
// a tooltip reaches neither a touch screen nor a keyboard.
// v29: a finished run says so through the tab title and, if asked, a system
// notification; the header carries a real mark instead of the letter P, and the
// favicon no longer shows an "S" left over from sylph.
// v30: the read cap can be applied in BASES, which is the only bound that means
// anything on long reads. The worker takes a maxBases argument; a page on v29
// would send none and a nanopore run would keep reading past the budget.
// v31: no two rows of an exported matrix share a label. GTDB reuses species
// names across representatives, and the rank fallbacks added more — downstream
// tools reject the duplicates outright.
// v32: the ENA result actions get their own row under the summary instead of
// sharing a wrapping flex line with it, and #maxReads is sized again — it fell
// out of the width rule when it became a text field in v27.
// v33: one ring for every wait — screening, the database download and the decode
// all use the mark the sample rows already had, instead of a trailing "…". Also
// drops the dead "Choose X above" button, which wrote into a hidden <select>.
// v34: a sticky step strip at the top of the page says which of the three steps
// is done, which can be acted on, and what to do about the one that cannot.
// v35: a resource monitor reads the workers' real linear memory through a new
// "stats" message, alongside disk and link. A page on v34 talks to a worker that
// has never heard of it.
// v36: the monitor tab is findable and its title reads horizontally once open,
// and a satisfied step in the strip carries the green background rather than
// only green text — on a dark theme it was a black tile beside a black tile.
// v37: the lineage maps carry the full GTDB ranks (schema 2), and the matrix can
// be shown at genus, family, order, class or phylum instead of species.
// v38: the matrix can be ordered by similarity on both axes, recomputed as each
// sample lands. multi.js imports cluster.js, which a page on v37 does not have.
// v39: composition, alpha diversity and PCoA, drawn as inline SVG from the
// matrix on screen, plus a CSV of sample groups to colour the ordination.
// v40: the ENA panel is a collapsed <details>, and the matrix header follows the
// rank picker instead of always saying "Species".
// v41: exports in the formats other tools read — sylph's own TSV, MetaPhlAn,
// BIOM 1.0 — plus saving and restoring a session.
// v42: a step in the strip is amber while its work is running and green only
// once it is finished — green had been claimed the moment a step was merely
// satisfied, including while a run was still chewing through it.
// v43: a Settings dialog — theme in four modes, and the three limits a browser
// can actually enforce. theme.js became a module and gained schedule support.
// v44: Settings reports what THIS browser offers on the path Load database
// takes — every line a feature test — after a Firefox report that could not be
// reproduced here.
// v45: two of those lines were probed from the page, where neither
// createSyncAccessHandle nor createWritable exists on any browser, so both read
// NO everywhere. They are probed inside a throwaway worker now.
// v46: a PCoA point names its sample on hover and opens that sample's
// composition as a pie when clicked. multi.js imports pieSvg from figures.js,
// which a page on v45 does not have, and index.html/styles.css carry the panel
// and the tooltip the page would otherwise render unstyled.
// v47: the page ships a worked example — a saved session of fifteen public runs
// of PRJEB83730 under web/demo/, loaded by a button in the page head. A page on
// v46 has no button and would not fetch it, but the pairing that matters is the
// stylesheet: the banner saying "this is the example, not your data" is styled
// there, and unstyled it reads as an ordinary paragraph under the heading.
// v48: the composition bars and the diversity rows are askable too — every
// figure carries one mark per sample now, and the panel beside it holds the
// pie, the sample's diversity and the samples it is really nearest. A page on
// v47 pairs the new markup with a stylesheet that does not tint a hovered row
// and does not lay out the panel's stat tiles.
// v49: the ordination's axis labels are true. The fractions were taken over the
// two axes that had been computed, so they added to 100% whatever the data — the
// example's plot claimed to show all of the variation and shows 41% of it. They
// are taken over the whole spectrum now (a Jacobi eigenvalue pass), and a
// repeated eigenvalue no longer collapses PCo2 to zero. The neighbour list can
// also be sorted by Euclidean distance; the stylesheet carries its switch.
// v50: the ordination zooms and pans, how many taxa the figures name is a
// slider rather than a constant, the pie is drawn to the panel it is in rather
// than to a width of its own choosing, and a neighbour's bar is how CLOSE it is
// instead of how far. The ENA lookup also asks for what a run SAYS about itself
// — 16 descriptive fields in the same request — and the page shows it: what the
// run shares above the matrix, what one sample is in its own panel. multi.js
// imports meta.js, which a page on v49 does not have, and the stylesheet
// carries the chips both are drawn as. A page on v49 pairs the new markup with
// a stylesheet that has no zoom controls and no slider to style — they would
// render as bare buttons and an unstyled range input in the tab strip.
// v51: the worked example is a different study. PRJEB83730 was the
// "metaquantibiote" contamination experiment — seven of its fifteen runs were a
// donor's stool with 0.1% to 10% of another donor's added — and it is replaced
// by eighteen runs of PRJNA728374, six people sampled three times over eight
// weeks. THE DATA CHANGING IS WHY THIS NUMBER MOVED: web/demo/*.json is fetched
// with ?v=WORKER_VERSION, so a visitor who had loaded the old example kept it
// otherwise, and got the new page's banner over the old study's numbers.
// v52: the ordination can be coloured by clusters this page computes (k-means on
// the two axes drawn, with the silhouette written into the figure) and framed
// wider than its own data so the legend stops sitting on the samples. A saved
// session can be opened from the page head rather than only from inside the
// results card it was hidden in; the worker count moved to Settings with a floor
// of two; INCOMPLETE is amber, and the status colours clear AA in both themes.
// index.html and the stylesheet carry both new controls — a page on v51 pairs
// this markup with a stylesheet that has neither.
// v53: the wheel over the ordination finishes its gesture instead of handing the
// page back the moment the zoom runs out of room — one flick used to dezoom and
// then scroll. The cluster note drops its runner-up k.
// v55: the results split into Taxonomy and Function, each with its own matrix,
// downloads and figures — and the bundled example now carries the functional
// half, which is 1 MB more session than a page on v54 expects to fetch.
// v80: THE WORKER PROTOCOL CHANGED, in four places, after a review found results
// that were wrong with nothing to say so:
//   - every profile reply carries `stop` ("eof" | "reads" | "bases" |
//     "truncated") and `stopDetail`. A FASTQ that stops at a malformed record,
//     and a pair whose two files do not hold the same number of reads, used to
//     come back as complete samples profiled on part of their reads; a page on
//     v79 would go on showing them as results.
//   - a cancelled sample replies `ok: false, name: "AbortError"` and the RPC
//     rejects with an AbortError — before, an uncompressed FASTQ cancelled
//     half-way came back `ok: true`, a partial sample recorded as done;
//   - the worker runs its messages ONE AT A TIME, in arrival order. It owns one
//     Profiler, and two profile calls, or a loadDb during a profile, used to
//     interleave on it at every await: a sample came back with 6,757 of its
//     60,000 reads, or none, depending on scheduling;
//   - "loadFuncRefs" really uses the `bytes` the page sends (v79 announced it and
//     the worker dropped the field, so the pool still fetched once per worker),
//     and a failure there is a reply instead of a promise that never settles.
// "profileFile" also takes `maxBases`, the cap the multi-sample paths already
// had, and a database too big for the loaded build is refused with a sentence
// before the constructor aborts the allocator. ena.js stops following redirects
// on FASTQ downloads and its readCountVerdict takes the `stop` above.
// v79: THE WORKER PROTOCOL CHANGED — "loadFuncRefs" now accepts a `bytes` field
// and uses it instead of fetching. A page on v79 hands the compressed reference
// to a worker; a cached v78 worker would ignore the field and fetch the URL
// itself, which is the very thing the change removes — eight workers, eight
// downloads of one 20 MB file, under a line that says "once".
// v78: no protocol change — the module GRAPH changed. parseMetadata and the CSV
// writer it has to match moved out of multi.js into groups.js, so a cached
// multi.js on v77 would import two names groups.js did not export at that
// version and fail to evaluate, taking the whole page with it. Everything
// versioned moves together for that reason: the token is not per file.
// v77: THE WORKER PROTOCOL CHANGED — it answers a new message type,
// "loadFuncRefs", and every profile reply now carries a `func` field beside the
// TSV. A page on v77 paired with a cached v76 worker would ask that worker to
// load the KEGG ortholog reference and wait forever for a reply it has no code
// to send, so this bump is what keeps a returning visitor working. The worker
// also imports a new module, func-sketch.js, which is the second sketch itself:
// the same reads, in amino acids, against 13,509 KEGG orthologs, fed from all
// four of the worker's feed paths — and per-stream, because the paired path
// calls back from two downloads at once and one parser state across both loses
// the FASTQ record phase and three quarters of the sketch. The Function tab is
// therefore measured in the browser now rather than only carried by a session,
// on both pages, behind an opt-in that says what it costs.
// Also on v77: a Contrast figure on both halves (ranked by effect, no p-values,
// every sample a dot), the GTDB release recorded per catalogue and printed
// wherever the catalogue is named, and the worker pool sized from the machine's
// cores and memory against the size of the catalogue instead of from the
// constant 4.
// v76: the three global maps are asked for on KEGG's GREY base. They are the
// ones a reader clicks first, and they were the worst case: KEGG paints
// map01100 in its own category palette — 2,473,946 coloured pixels — and our
// marks vanished in it. `coloring=grayscale` turns that into 119,352, nearly all
// ours. It exists only for 011xx (KEGG's script gates it on mapno matching
// /^011/) and only on the named-parameter URL form, since appending it to the
// keyless path form makes the CGI answer 400. That form has no `default=`, and a
// bare identifier in it gets KEGG's own RED — which on our ramp would read as
// the most abundant thing on the map — so there it drops rather than promotes.
// v75: the KEGG maps TAB is gone and the link moved into the matrix cell, where
// it belonged all along — a cell is a pathway AND a sample, which is exactly
// what a coloured map needs. Two tabs tried to be that table and both WERE the
// table: a figure of the top fourteen pathways averaged, then a list of links
// ordered by share of the profile. Measured, that ordering carries no per-sample
// information at all — two samples share 9.6 of their top 10 pathways — and it
// puts the global maps first, which are the ones our colours read worst on.
// v74 (with v73): the KEGG links actually colour, and the tab stops duplicating the matrix.
// Two things were wrong and one was an instrument. The tab drew pathways x
// samples with the abundance in each cell, which IS the matrix below it — it is
// a sample picker and a list of links now. The ramp started at lightness 0.88,
// near white, invisible on line art and hopeless on the 011xx global maps that
// KEGG already draws in its own colours (those rows now say so). And on a box
// two orthologs share, KEGG lets the LAST one in the URL win: measured, the same
// pair swapped renders 1,287 px and NOTHING for the other, so the list is chosen
// most-abundant-first and written least-abundant-first. The instrument: the
// first blob image KEGG builds is entirely uncoloured, so reading it when
// img.src turns blob: reports zero every time — which is what made this look
// broken when it was not. Measured settled, our own URL renders 13,612 pixels in
// 12 shades on map00010, against 0 for the bare map.
// v71: a KEGG maps tab — one link per pathway PER SAMPLE, each opening that map
// on kegg.jp coloured by that sample's ortholog abundances on a log ramp. Not a
// figure: KEGG draws the map, and the only thing this page can add is which
// boxes and how darkly. The URL is KEGG's own documented colouring form
// (kegg.jp/kegg/webapp/color_url.html), one colour per ortholog now rather than
// one for all; where the list outruns the 2,023-byte request target the least
// abundant lose their colour before they lose their box, because a missing box
// says "not found" and that is false. 96 of the example's 102 maps fit whole.
// v70 (with v69): the Function panel gets the rest of the taxonomic figure furniture, which
// it should have had from the start — the top-N slider, the colour control
// (groups or computed clusters) and the zoom, all on the SAME ordination code
// rather than a second copy. `pcoaSvg` was being called directly there, so the
// functional plot had no window, no clusters and no slider; that was not a
// decision, it was the half that was built second. The gestures now bind to both
// canvases, and the clusters earn their place: taxonomically they recover all
// six people of the example without being told who is who, functionally they do
// not, and reading the two side by side is the redundancy result.
// v68: the KEGG map FIGURE is gone. It drew fourteen bars of numbers the matrix
// beside it shows all 87 of, per sample, sortable and downloadable — and once
// its row labels started opening KEGG's own drawing, the honest map was on
// kegg.jp rather than in a layout of ours carrying its name. The coloured link
// moved to the pathway rows of the matrix, where the identifier already was.
// v67 (with v65 and v66): the KEGG map lists the samples instead of averaging them — one mark per
// sample per pathway, names over the columns — and each row label opens that map
// on kegg.jp with the orthologs found here coloured in. The colouring URL is
// KEGG's own documented form, show_pathway?<map>/<ko>/…/default%3d<colour>; the
// two forms that look right are not (/pathway/<map>+<ko> is a 404, and the
// multi_query variant on that path returns the map with the argument ignored).
// The request target is capped at 2,023 bytes, so long lists are cut most-
// abundant-first and the figure says how many maps were cut.
// v64: a Gut Metabolic Modules level, whose definitions this page does NOT ship
// — VIB licenses them for academic non-commercial use and forbids passing them
// outside the licensee's institution, so the page carries the parser and the
// reader opens their own copy, read in the tab and kept nowhere. It is a LEVEL
// and not a column beside the KEGG modules: only 7 of the 103 have the ortholog
// set of some KEGG module, and 32 are built entirely from orthologs no KEGG
// module contains. A second consent gate, in the shape of the KEGG one.
// v61: the Function tab gets the rest of the taxonomic half's furniture — the
// cluster checkbox, and "Pick a sample" with a functional pie, its own Hill
// numbers and its nearest neighbours by Bray-Curtis over the orthologs. The
// panel machinery is shared rather than copied: a surface descriptor names the
// canvas, the panel, the noun and whether the enterotype audit means anything
// there. Diversity is computed on the ORTHOLOGS at every level, because modules
// and maps overlap and Shannon over categories that share members is not an
// index; all three Hill numbers are reported, since q=2 separates these samples
// 1.7x better than q=1. And "Profiled against <catalogue>" moved inside the
// Taxonomy panel — over a table of KEGG pathways it was the wrong sentence.
// v60 (one release, numbered up while it was being verified): an adversarial
// review of the Function tab, and one number that could not
// be true. The KEGG map figure summed module rows per map, double-counting an
// ortholog once per module INSIDE one bar: map01100 read 43 % of a profile whose
// module-assigned part was 23 %. Orthologs are now deduplicated per map, the
// pathway coverage is measured rather than borrowed from the module level, and
// every rolled-up view says its rows overlap. The functional matrix takes a
// floor (Settings -> Function floor, 0.05 % by default) so 4,307 orthologs
// becomes a few hundred, and says what it hid and what that carried. Also: the
// Settings KEGG dropdown could never repaint the panel, the figure tabs bypassed
// the licence gate, the downloads stayed live under the refusal, and the demo
// banner promised a functional half the ENA panel cannot reproduce.
// v58: the functional CSV quotes its own separator. It was written as a TSV and
// then had its tabs swapped for commas, and 436 of the 508 KEGG module names
// carry a comma — so most rows of the downloaded file had more fields than its
// own header. A page on v57 goes on writing that file.
// v57 (with v56): the functional figures name their own rows. compositionSvg and alphaSvg
// read `species` alone, so a chart of KEGG modules printed ten `undefined`s in
// its legend and counted "effective number of taxa"; both now take the label and
// the unit. The functional matrix is drawn by the same renderer as the
// taxonomic one, with the KEGG identifier linked where the genome accession is.
export const WORKER_VERSION = "80";

// ---- memory64 capability probe ----------------------------------------------

// (module (memory i64 1)) — 13 bytes. Validating it asks the engine exactly one
// question: can you decode a memory whose index type is i64? Nothing is
// instantiated and nothing is allocated.
const MEMORY64_PROBE_MODULE = Uint8Array.of(
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // "\0asm", version 1
  0x05, 0x03, 0x01, 0x04, 0x01,                   // memory section: 1 memory, flags=0x04 (MEMORY64), min=1
);

// The same module with flags=0x00, i.e. an ordinary 32-bit memory. Every engine
// that runs wasm at all validates this one. It is the control that makes a
// `false` above mean "no memory64" rather than "validate() is broken here".
const MEMORY32_PROBE_MODULE = Uint8Array.of(
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x05, 0x03, 0x01, 0x00, 0x01,
);

// Does this engine really support memory64? Returns { ok, reason }.
//
// `wasm` is injectable so the test can drive the probe against engines this
// machine does not have (a 32-bit-only one, and one that honours the OLD spec
// draft's property name). Everything else passes globalThis.WebAssembly.
export function detectMemory64(wasm = globalThis.WebAssembly) {
  if (!wasm || typeof wasm.Memory !== "function" || typeof wasm.validate !== "function") {
    return { ok: false, reason: "no WebAssembly.Memory / WebAssembly.validate in this realm" };
  }

  // Static half: can the engine decode an i64-indexed memory at all?
  let validates = false;
  try { validates = wasm.validate(MEMORY64_PROBE_MODULE) === true; } catch { validates = false; }
  if (!validates) {
    let control = false;
    try { control = wasm.validate(MEMORY32_PROBE_MODULE) === true; } catch { control = false; }
    return {
      ok: false,
      reason: control
        ? "WebAssembly.validate rejects a memory64 module"
        : "WebAssembly.validate rejects even a memory32 module — the probe is not usable here",
    };
  }

  // Dynamic half: the JS API has to agree with the decoder.
  //
  // The property is `address`. NOT `index`. An unknown key on this descriptor is
  // silently ignored, so `{ index: "i64" }` hands back a perfectly ordinary
  // 32-bit memory, capped at 4 GB, with no error anywhere — a probe written that
  // way answers "yes, memory64" on every browser on earth, including the ones
  // that have never heard of it. (`index` was the property name in an early
  // draft, which is exactly why it is such an easy thing to write.)
  //
  // `initial` / `maximum` must be BigInt for the same reason: that is what makes
  // the NEGATIVE answer trustworthy. A 32-bit engine, having ignored `address`,
  // then tries to convert 1n to a Number and throws.
  try {
    new wasm.Memory({ initial: 1n, maximum: 4n, address: "i64" });
  } catch (e) {
    return { ok: false, reason: `WebAssembly.Memory rejected address:"i64" (${e?.message ?? e})` };
  }

  return { ok: true, reason: "accepted by both WebAssembly.validate and WebAssembly.Memory" };
}

// ---- reads budget ------------------------------------------------------------
//
// Measured on this machine, worst case on purpose: 150 bp reads, all distinct,
// matching nothing in the database, so every k-mer is kept and the sketch state
// grows as fast as it ever can. Streaming means the FASTQ itself is never
// materialised, so what is being measured is purely the sketch state.
//
//   wasm32: 48 750 000 reads OK, dies at 49 000 000 (2.385 GiB reserved)
//   wasm64: 195 500 000 reads OK, dies at 195 750 000 (8.762 GiB reserved)
//
// Both die on a *doubling*: wasm32 trying to go from 2.385 GiB to ~4.5 GiB (over
// the 4 GB wasm32 limit), wasm64 from 8.762 GiB to ~17 GiB (over V8's 16 GB
// memory64 limit). The failure is an unrecoverable Rust allocator abort, seen
// from JS as `RuntimeError: unreachable`, after which the module is poisoned and
// only a reload fixes it. There is no graceful degradation to lean on.
export const WASM32_CEILING_READS = 48_750_000;
export const WASM64_CEILING_READS = 195_500_000;

// Half of the measured ceilings. Two documented reasons, plus the cliff above:
//   - the ceiling runs are single-end. Paired-end stores one entry per PAIR plus
//     two inter-mate markers, so the per-read state is roughly double and the PE
//     ceiling is materially lower (not measured: each ceiling run costs 2-9 min);
//   - the ceiling runs used reads that match nothing, so finish_sample() was
//     trivial (18 ms, 0 rows) and the transient peak of the inference phase on
//     data that actually matches never appeared in the number.
export const WASM32_SAFE_READS = 24_000_000;
export const WASM64_SAFE_READS = 96_000_000;

// Exported so both pages format read counts the same way these notes do —
// mixing `toLocaleString()` (which follows the browser's locale) with the
// en-US grouping used here put "24 000 000" and "24,000,000" side by side in
// the same sentence.
// The read length the memory budget above was measured at. "The equivalent of
// N reads in bases" means N x this — any other figure would describe a budget
// nobody measured.
export const BUDGET_READ_BP = 150;
export const basesForReads = (reads) =>
  Number.isFinite(reads) && reads > 0 ? reads * BUDGET_READ_BP : Infinity;

export const fmtReads = (n) => (Number.isFinite(n) ? Math.floor(n).toLocaleString("en-US") : "?");

/**
 * How far through a sample the run is, as 0..1, or NaN when nothing is known.
 *
 * A sample ends at WHICHEVER COMES FIRST: the end of the input, or the read
 * cap. So the honest fraction is the larger of the two ratios, not the byte
 * ratio alone — with a 3 M cap on a 10 M-read file the run stops at 30% of the
 * bytes, and a bar creeping to 30% and vanishing looks like a crash. Nor the
 * read ratio alone: a 1 M-read file under the same cap finishes at 100% of its
 * bytes having reached a third of the cap, and would appear stuck at 33%.
 *
 * `bytesIn` is COMPRESSED bytes read from the file, which is what streamCore
 * counts, so it is comparable with the file sizes in `total`.
 *
 * Either input may be missing — an ENA run can arrive with no fastq_bytes, and
 * the cap can be Infinity — and the other one still gives a usable answer.
 * NaN when neither does: an indeterminate spinner is honest, a 0% that never
 * moves is not.
 */
export function progressFraction({ bytesIn, total, reads, cap } = {}) {
  const byteFrac = Number.isFinite(total) && total > 0 && Number.isFinite(bytesIn)
    ? bytesIn / total : NaN;
  const readFrac = Number.isFinite(cap) && cap > 0 && Number.isFinite(reads)
    ? reads / cap : NaN;
  const known = [byteFrac, readFrac].filter(Number.isFinite);
  if (!known.length) return NaN;
  // Clamped: a gzip whose declared size is short, or a read cap the sketcher
  // overshoots by part of a block, must not render as a ring past full.
  return Math.min(1, Math.max(0, Math.max(...known)));
}

// ---- the database's share of the same memory ---------------------------------
//
// The reads budget above was measured as if the sketch had the address space to
// itself. It does not: the catalogue lives in the same linear memory, and it is
// not small. `new Profiler(bytes)` copies the .syldb in and decodes it beside
// the copy, and wasm never hands the high-water mark back. Measured with the
// shipped wasm32 package, linear memory right after the constructor:
//
//   human-oral        33,236,205 B  ->    67,633,152 B  (2.035x)
//   cow-rumen        248,090,414 B  ->   497,483,776 B  (2.005x)
//   human-gut        454,021,440 B  ->   909,377,536 B  (2.003x)
//   marine-sediment  706,660,184 B  -> 1,414,725,632 B  (2.002x)
//
// so `soil` (2,959,289,168 B) needs ~5.9 GB before a single read is sketched and
// cannot load in 32 bits at all — it died in the constructor with `unreachable`,
// which poisons the worker — while `marine` (1.28 GB) loads at 2.39 GiB and
// leaves too little of the 4 GiB for the reads budget to mean anything.
export const DB_LOAD_FACTOR = 2.05;
const GIB = 2 ** 30;
export const WASM32_MEMORY_BYTES = 4 * GIB;
export const WASM64_MEMORY_BYTES = 16 * GIB;
// What the ceiling runs had reserved when they died: an upper bound on the
// sketch state at the SAFE read count, which is half of what those runs held.
export const WASM32_STATE_BYTES = 2.385 * GIB;
export const WASM64_STATE_BYTES = 8.762 * GIB;
// Never fill the address space with the catalogue alone: the inference pass
// and the first reads need somewhere to go.
const DB_HEADROOM_BYTES = GIB / 4;

/** Linear memory a database takes once loaded, at the measured factor. */
export const dbLoadBytes = (dbBytes) =>
  Number.isFinite(dbBytes) && dbBytes > 0 ? DB_LOAD_FACTOR * dbBytes : 0;

// The sketch state of `reads` (single-end equivalents), scaled from the state
// the ceiling run held. Linear, which overstates small runs a little: a bound,
// not a prediction.
function stateBytes(reads, bits) {
  const r = Number.isFinite(reads) && reads > 0 ? reads : 0;
  return bits === 64
    ? WASM64_STATE_BYTES * (r / WASM64_SAFE_READS)
    : WASM32_STATE_BYTES * (r / WASM32_SAFE_READS);
}

/**
 * Why a database of `dbBytes` cannot be loaded into the `bits` build at all, or
 * null when it can. Asked BEFORE `new Profiler(bytes)`: past the address space
 * the constructor does not throw, it aborts the allocator, and the worker is
 * unusable until the page is reloaded. A sentence beats that.
 */
export function dbRefusal(bits, dbBytes) {
  const need = dbLoadBytes(dbBytes);
  const room = (bits === 64 ? WASM64_MEMORY_BYTES : WASM32_MEMORY_BYTES) - DB_HEADROOM_BYTES;
  if (need <= room) return null;
  const gb = (n) => `${(n / 1e9).toFixed(1)} GB`;
  return bits === 64
    ? `this database (${gb(dbBytes)}) needs about ${gb(need)} of WebAssembly memory once ` +
      `loaded, past the 16 GB a browser allows even the 64-bit build`
    : `this database (${gb(dbBytes)}) needs about ${gb(need)} of WebAssembly memory once ` +
      `loaded, past the 4 GB of the 32-bit build — it needs the 64-bit build, which needs ` +
      `memory64 (Chrome 133+, Firefox 134+; no version of Safari)`;
}

// THE POLICY. wasm64 is 1.58x-1.68x slower end-to-end than wasm32 on the same
// profile() (measured; the cost is in the inference phase, not the sketching,
// which is within 1.7%). So 32-bit is the default and 64-bit is chosen only when
// 32-bit provably will not hold the run.
//
// Two things have to fit, not one: the reads, and the database they are
// profiled against. `maxReads` is in the unit the worker counts — PAIRS for a
// paired sample — and `pairs: true` says so: a pair stores one entry plus two
// inter-mate markers, so it costs about what two single-end reads do, and the
// budget was measured on single-end reads. `dbBytes` is the .syldb size.
//
// Returns { bits, capped, memory64, reason, refuse }. `capped` means the user
// asked for more reads than this browser can deliver — the run is going to be
// attempted at 32 bits and may abort. Say so in the UI; do not swallow it.
// `refuse` is a sentence when NO build this browser has can even load the
// database (it is null otherwise): do not load it, show the sentence.
export function chooseWasmBits({ maxReads, memory64, dbBytes = 0, pairs = false } = {}) {
  const has64 = memory64 === true || memory64?.ok === true;
  const why64 = memory64?.reason ?? (has64 ? "memory64 available" : "memory64 unavailable");
  const readsEq = Number.isFinite(maxReads) ? maxReads * (pairs ? 2 : 1) : maxReads;
  const unit = pairs ? "pairs" : "reads";
  const asked = `${fmtReads(maxReads)} ${unit}${pairs ? ` (${fmtReads(readsEq)} reads' worth)` : ""}`;
  const readsFit32 = !(Number.isFinite(readsEq) && readsEq > WASM32_SAFE_READS);
  const dbFits32 = dbRefusal(32, dbBytes) === null;
  // The catalogue and the reads together, against the 32-bit address space.
  const bothFit32 = dbLoadBytes(dbBytes) + stateBytes(readsEq, 32) <= WASM32_MEMORY_BYTES;
  const dbNote = dbBytes > 0
    ? ` with a ${(dbBytes / 1e9).toFixed(2)} GB database (~${(dbLoadBytes(dbBytes) / 1e9).toFixed(1)} GB loaded)`
    : "";

  if (readsFit32 && bothFit32) {
    return {
      bits: 32, capped: false, memory64: has64, refuse: null,
      reason: `${asked} is inside the 32-bit budget${dbNote} ` +
        `(safe up to ${fmtReads(WASM32_SAFE_READS)} reads); the 32-bit build is ~1.6x faster`,
    };
  }
  const why = !readsFit32
    ? `${asked} needs more than the 32-bit budget (safe up to ${fmtReads(WASM32_SAFE_READS)} reads)`
    : `${asked}${dbNote} does not fit the 32-bit build's 4 GB`;
  if (!has64) {
    return {
      bits: 32, capped: true, memory64: false,
      refuse: dbFits32 ? null : dbRefusal(32, dbBytes),
      reason: `${why} but this browser has no memory64 (${why64}), so there is nothing else to load`,
    };
  }
  return {
    bits: 64, capped: false, memory64: true,
    refuse: dbRefusal(64, dbBytes),
    reason: `${why}; switching to the 64-bit build ` +
      `(safe up to ${fmtReads(WASM64_SAFE_READS)} reads) at ~1.6x the run time`,
  };
}

// How many reads this browser can be asked for, and where the slider should
// stop. Shared by both pages so they cannot drift apart.
export function readsBudget(memory64) {
  const has64 = memory64 === true || memory64?.ok === true;
  return {
    memory64: has64,
    safeMax: has64 ? WASM64_SAFE_READS : WASM32_SAFE_READS,
    // Slider stops a little past the 64-bit target range (a real gut metagenome
    // is 20-50 M reads) rather than at the safe max, which is far past anything
    // a browser tab should be asked to do in one sitting.
    sliderMax: has64 ? 60_000_000 : WASM32_SAFE_READS,
    ceiling: has64 ? WASM64_CEILING_READS : WASM32_CEILING_READS,
  };
}

// The one sentence the UI shows under the reads control. Kept here so the two
// pages say exactly the same thing.
// What this control is FOR, first; what it is limited BY, second.
//
// It used to be a memory guard: 3 M reads was the most the old one-buffer path
// could hold, so the note was a warning and the slider turned red early. Since
// the streaming sketcher the ceiling is 24 M reads (32-bit) or 96 M (64-bit) —
// past what most gut metagenomes contain. So the real question a user faces is
// no longer "will this fit" but "how much of my sample do I want to spend time
// on": fewer reads finish sooner, more reads find rarer species. The ceiling is
// still stated, because on a browser without memory64 it is what stops them.
export function readsBudgetNote(memory64) {
  const b = readsBudget(memory64);
  const tradeoff =
    `Fewer reads finish sooner; more reads detect species at lower abundance. `;
  if (!b.memory64) {
    return tradeoff +
      `This browser holds up to ${fmtReads(b.safeMax)} reads — it has no WebAssembly ` +
      `memory64, so 32-bit WebAssembly's 4 GB is the limit, not sylph. Chrome 133+ and ` +
      `Firefox 134+ raise it to ${fmtReads(WASM64_SAFE_READS)}; Safari supports it in no version.`;
  }
  return tradeoff +
    `This browser holds up to ${fmtReads(b.safeMax)} reads. Past ${fmtReads(WASM32_SAFE_READS)} ` +
    `the 64-bit build loads by itself — same results, about 1.6x the run time.`;
}

// One clause describing the build that is actually loaded, for the database
// line. Deliberately reports the CURRENT build's own ceiling and not the
// browser's: "32-bit WebAssembly, up to 96,000,000 reads" reads as a promise the
// loaded module cannot keep.
export function loadedBuildNote(bits, memory64, unit = "reads") {
  const has64 = memory64 === true || memory64?.ok === true;
  if (bits === 64) {
    return `64-bit WebAssembly, up to ${fmtReads(WASM64_SAFE_READS)} ${unit}`;
  }
  if (has64) {
    return `32-bit WebAssembly (the faster build); past ${fmtReads(WASM32_SAFE_READS)} ${unit} ` +
      `it switches to 64-bit by itself`;
  }
  return `32-bit WebAssembly, capped at ${fmtReads(WASM32_SAFE_READS)} ${unit} ` +
    `because this browser has no memory64`;
}

// The warning shown when the requested value is past the safe max.
export function readsOverBudgetNote(maxReads, memory64) {
  const b = readsBudget(memory64);
  if (!b.memory64) {
    return `${fmtReads(maxReads)} reads is past the ${fmtReads(b.safeMax)} this browser can hold: ` +
      `32-bit WebAssembly stops at 4 GB and the sketch state grows with every read, so the run ` +
      `will abort mid-sample with an out-of-memory error. Lower the value, use Chrome 133+ or ` +
      `Firefox 134+ (which support memory64), or run sylph on a server.`;
  }
  return `${fmtReads(maxReads)} reads is past the ${fmtReads(b.safeMax)} measured as safe even for ` +
    `the 64-bit build (V8 stops at 16 GB). The run may abort mid-sample. Lower the value, or run ` +
    `sylph on a server.`;
}

// How a cancelled call rejects, everywhere: the DOMException a fetch() or a
// stream gives, so a caller asks one question (`err.name === "AbortError"`)
// whatever was cancelled and wherever.
const abortError = () => new DOMException("cancelled", "AbortError");

/**
 * The promise side of the worker protocol, without the Worker: `worker` is
 * anything with postMessage / addEventListener / terminate. Exported so node can
 * drive it against a fake worker; the pages go through sylphWorkerRpc().
 *
 * Three promises the pages build on, and none of them held before:
 *   - a cancelled call REJECTS with an AbortError, at once, and never resolves —
 *     not even if the worker finished the sample on the same tick the user
 *     clicked Cancel and its result was already on the way;
 *   - a call to a worker that is gone (terminated, or failed to load) rejects
 *     at once instead of waiting for a reply nobody is left to send;
 *   - a worker that dies takes every call it was holding down with it.
 */
export function rpcOver(worker) {
  const pending = new Map();
  let nextId = 1;
  let dead = null;      // why this worker can no longer answer, once it cannot

  const settle = (id, entry) => {
    pending.delete(id);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
  };
  const die = (why) => {
    if (!dead) dead = why;
    for (const [id, entry] of [...pending]) { settle(id, entry); entry.reject(new Error(why)); }
  };

  worker.addEventListener("message", (e) => {
    const { id } = e.data;
    const entry = pending.get(id);
    if (!entry) return;
    if (e.data.progress) {
      entry.onProgress?.(e.data.progress);
      return;
    }
    settle(id, entry);
    if (entry.signal?.aborted) entry.reject(abortError());
    else if (e.data.ok) entry.resolve(e.data);
    else if (e.data.name === "AbortError") entry.reject(abortError());
    else entry.reject(new Error(e.data.error));
  });
  // A module worker that fails to load fires this and then answers nothing,
  // ever. An exception inside a message is a reply (the worker catches them all),
  // so reaching here means the worker is not going to answer what it holds.
  worker.addEventListener("error", (e) => {
    die(`the profiling worker stopped: ${e?.message ?? "worker error"}`);
  });

  function call(type, payload, { transfer, onProgress, signal } = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      if (dead) { reject(new Error(dead)); return; }
      if (signal?.aborted) { reject(abortError()); return; }
      const entry = { resolve, reject, onProgress, signal };
      if (signal) {
        // Settled HERE, not when the worker gets round to answering: a sample
        // the worker is still finishing (a wasm call cannot be interrupted) is
        // already cancelled as far as the page is concerned, and whatever the
        // worker replies later finds no one waiting for it.
        entry.onAbort = () => {
          worker.postMessage({ id: 0, type: "cancel", target: id });
          if (pending.get(id) === entry) { settle(id, entry); reject(abortError()); }
        };
        signal.addEventListener("abort", entry.onAbort);
      }
      pending.set(id, entry);
      worker.postMessage({ id, type, ...payload }, transfer ?? []);
    });
  }

  return {
    call,
    get dead() { return dead; },
    terminate() {
      worker.terminate();
      die("worker terminated");
    },
  };
}

export function sylphWorkerRpc() {
  const workerUrl = new URL(`./sylph-worker.js?v=${WORKER_VERSION}`, import.meta.url);
  const worker = new Worker(workerUrl, { type: "module" });
  const { call, terminate } = rpcOver(worker);

  return {
    worker,
    // `maxReads` is the number of reads this worker is going to be asked for and
    // `bits` is the caller's chooseWasmBits() verdict on it. Together they pick
    // the wasm package, and a package cannot be swapped afterwards: a module
    // worker has one module graph for its whole life. Changing the reads budget
    // later means terminate() + a fresh sylphWorkerRpc(), which is what both
    // pages do. Pass `bits` whenever you have run the policy yourself, so the
    // worker's own probe acts as a veto instead of deciding again; omit it and
    // the worker runs the policy on maxReads.
    // Resolves to { bits, capped, memory64, reason, pkg } — what actually
    // loaded, which is not always what was asked for.
    async init(maxReads, bits) {
      const { wasm } = await call("init", { maxReads, bits });
      return wasm;
    },
    async loadDb(bytes) {
      const { meta } = await call("loadDb", { bytes }, { transfer: [bytes.buffer] });
      return meta;
    },
    // Load a database the page has ALREADY downloaded into the OPFS cache (see
    // db-cache.js). Nothing is fetched here. This replaced loadDbUrl(), which
    // fetched inside every worker and therefore downloaded the database once
    // per worker in the pool.
    async loadDbCached(url) {
      const { meta } = await call("loadDbCached", { url });
      return meta;
    },
    /**
     * Turn the second sketch on for this worker, and load the KEGG ortholog
     * sketches it matches against.
     *
     * The PARSE is per worker, and there is no way around it: each worker owns
     * its own wasm memory, so the 39 MB of references is paid once per worker
     * rather than once per page. The 20 MB DOWNLOAD is not, when the caller
     * passes `bytes` (the compressed reference it fetched once): the worker
     * then reads those and fetches nothing. Resolves to { orthologs }; a failure
     * rejects like any other call, it does not hang.
     */
    async loadFuncRefs(pkg, refUrl, onProgress, bytes) {
      const { result } = await call("loadFuncRefs", { pkg, refUrl, bytes }, { onProgress });
      return result;
    },
    /** Stop sketching functions, without unloading the reference. */
    async funcOff() {
      await call("loadFuncRefs", { on: false });
    },
    async loadDbFile(file) {
      const { meta } = await call("loadDbFile", { file });
      return meta;
    },
    // Every profile call below resolves to { tsv, reads, func, stop, stopDetail }
    // (plus elapsedMs). `stop` says what ended the read: "eof", "reads" (the
    // read cap), "bases" (the base cap) or "truncated" — the input stops at a
    // malformed record, or the two mates do not hold the same number of reads,
    // and `stopDetail` says which in a sentence for the page. A truncated sample
    // is a PART of the input: show it as incomplete, never as a result. A
    // cancelled one rejects with an AbortError and never resolves.
    async profileFile(file, maxReads, onProgress, signal, maxBases) {
      return call("profileFile", { file, maxReads, maxBases }, { onProgress, signal });
    },
    async profileFilesMulti(files, maxReads, onProgress, signal, maxBases) {
      return call("profileFilesMulti", { files, maxReads, maxBases }, { onProgress, signal });
    },
    async profileFilesPe(r1Files, r2Files, maxReads, onProgress, signal) {
      return call("profileFilesPe", { r1Files, r2Files, maxReads }, { onProgress, signal });
    },
    // ENA mode. `urls` / `r1` / `r2` are plain {url, bytes, name} descriptors —
    // the read source itself is built inside the worker, because an object with
    // methods does not survive postMessage. Same progress callback, same signal,
    // same results; the progress events additionally carry `net: true`, a `bps`
    // rate, and `phase: "net_retry"` events when a download is cut and resumed.
    async profileUrls(urls, maxReads, onProgress, signal, maxBases) {
      return call("profileUrls", { urls, maxReads, maxBases }, { onProgress, signal });
    },
    async profileUrlsPe(r1, r2, maxReads, onProgress, signal) {
      return call("profileUrlsPe", { r1, r2, maxReads }, { onProgress, signal });
    },
    // Linear memory as the worker sees it. Deliberately a pull rather than a
    // push: the page asks when it is showing the figure, so a hidden panel
    // costs nothing.
    async stats() {
      // call() resolves with the whole envelope, as every method here does —
      // returning it unwrapped made every field read as undefined.
      const { result } = await call("stats", {});
      return result;
    },
    terminate,
  };
}
