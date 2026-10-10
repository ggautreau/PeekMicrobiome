// Multi-sample WASM sylph profile: drop N FASTQs → one row per species, one
// column per sample, cells = taxonomic (relative) abundance %.
//
// Memory strategy: hold the database in WASM linear memory once via Profiler,
// then process each FASTQ sequentially. After each sample we drop the
// Uint8Array reference so the GC can reclaim it before the next.
//
// The WASM Profiler runs in a Web Worker — the main thread stays responsive
// while a sample is being sketched/profiled (which can take 5–30 s).

import {
  sylphWorkerRpc, detectMemory64, chooseWasmBits, WORKER_VERSION,
  readsBudget, readsBudgetNote, readsOverBudgetNote, loadedBuildNote, fmtReads,
  progressFraction, basesForReads, BUDGET_READ_BP,
} from "./sylph-worker-rpc.js?v=79";
import {
  dbCacheClient, fmtRate, fmtEta, cacheSummary, assertSameDatabase,
} from "./db-cache.js?v=79";
import { matePattern, stripFastqExt } from "./sample-naming.js?v=79";
import {
  resolveAccession, validateAccession, ASSUMED_BPS,
  downloadEstimate, readCountVerdict, expectedProfiledReads,
} from "./ena.js?v=79";
import { normaliseMarkers, screenVerdict, SCREENING_DB, SCREENING_MARKERS } from "./screening.js?v=79";
import { metaLines, runFacts } from "./meta.js?v=79";
import { clusterTable, MAX_ROWS as CLUSTER_MAX_ROWS } from "./cluster.js?v=79";
import { compositionSvg, alphaSvg, pcoaSvg, pcoaLayout, pieSvg, sampleFacts, METRICS, alphaDiversity,
  enterotypeSvg, enterotypeSplit, ENTEROTYPE_POLES, ENTEROTYPE_GAP, ENTEROTYPE_MIN_MARKERS,
  kmeans, silhouette, autoCluster, contrastSvg, contrastStats, contrastGroups, PCOA_MIN_ZOOM }
  from "./figures.js?v=79";
import { koTable, moduleTable, pathwayRollup, moduleCoverage, pathwayCoverage, keggEntryUrl,
  keggMapUrl, moduleMapUrl, floorRows, NO_PATHWAY,
  KEGG_CONSENT_KEY, keggConsent, storeKeggConsent, keggGateHtml,
  FUNC_METHOD_NOTE } from "./kegg.js?v=79";
import { parseGmms, gmmTable, gmmCoverage } from "./gmm.js?v=79";
import { arrangeRows, arrangeNote, nextSort } from "./table-view.js?v=79";
import { groupFields, groupsFromField, groupList, assignGroup, groupSummary,
  parseMetadata, groupsCsvFrom } from "./groups.js?v=79";
import { toMetaphlan, toBiom, toSylphTsv, toSession, fromSession } from "./exports.js?v=79";
import { currentMode as themeMode, setMode as setThemeMode, applyTheme,
  loadSchedule, saveSchedule } from "./theme.js?v=79";
import {
  fetchCatalog, fallbackCatalog, renderDbSelect, biomeForUrl, biomeNote,
  mgnifyGenomeUrl,
  biomeByKey,
  makeDbRef, sameDbRef, refLine, refShort, refCommentLines, refSlug, genomeCountMismatch,
  rememberBiome, recallBiome, catalogueName, LOCAL_VALUE,
  selectionMatchesLoaded, notLoadedNote, refMetaMismatch,
} from "./biomes.js?v=79";

const $ = (id) => document.getElementById(id);
const els = {
  drop: $("drop"), file: $("file"), dropLabel: $("dropLabel"),
  filesList: $("filesList"),
  maxReads: $("maxReads"), maxReadsSlider: $("maxReadsSlider"),
  run: $("run"), cancel: $("cancel"), clearFiles: $("clearFiles"), funcOn: $("funcOn"),
  progress: $("progress"), bar: $("bar"), step: $("step"),
  error: $("error"),
  results: $("results"), resultsSummary: $("resultsSummary"),
  matrixHead: $("matrixHead"), matrixBody: $("matrixBody"),
  dbSelect: $("dbSelect"), loadDb: $("loadDb"), dbInfo: $("dbInfo"), dbFile: $("dbFile"),
  cancelDb: $("cancelDb"), dbCacheInfo: $("dbCacheInfo"), dbBiomeNote: $("dbBiomeNote"),
  matrixRef: $("matrixRef"),
  matrixMeta: $("matrixMeta"),
  poolSize: $("poolSize"),
  // ENA input mode
  enaAcc: $("enaAcc"), enaResolve: $("enaResolve"), enaCancelLookup: $("enaCancelLookup"),
  enaStatus: $("enaStatus"), enaError: $("enaError"), enaResult: $("enaResult"),
  enaSummary: $("enaSummary"), enaRuns: $("enaRuns"), enaAll: $("enaAll"),
  enaNone: $("enaNone"), enaAdd: $("enaAdd"), enaPending: $("enaPending"),
  runHint: $("runHint"), pairsAsTwo: $("pairsAsTwo"),
  runControlsNote: $("runControlsNote"),
  basesUnit: $("basesUnit"), capInBases: $("capInBases"),
  cardDb: $("cardDb"), cardSamples: $("cardSamples"),
};

// `files` is now really a *sample list*. Each entry can hold multiple source
// files (technical replicates of one biological sample). Shape:
//   {
//     kind: "se" | "pe",
//     sampleName,
//     origin: undefined | "ena",
//     sources: [{ file: File|UrlDesc, layout: "SINGLE"|"PAIRED", mate: "1"|"2"|null }],
//     status: "pending"|"running"|"done"|"incomplete"|"failed"|"cancelled",
//     progress?, detected?, elapsed?, rows?, error?, reads?, enaNote?, enaReads?
//   }
//
// "incomplete" is a RESULT, not a failure: the profile finished and its rows are
// in the matrix, but fewer reads came out of the download than the ENA says the
// run has. "cancelled" is neither — it is what the user asked for. Both are
// re-runnable, which is why refreshRunButton() counts them.
//
// A source is either a real File (dropped by the user) or, in ENA mode, a
// descriptor { url, name, size }. The descriptor deliberately carries `size`
// under the name File uses, so everything that only measures inputs — the
// grouping, the pairing, the per-sample byte totals — is shared by both modes
// with no branching at all. The branch exists in exactly one place: which rpc
// method runAll() calls (profileFiles* vs profileUrls*), because only the worker
// can turn a URL into a read source.
let files = [];
// Pool of WASM workers. Each holds its own copy of the DB and processes
// samples independently — N samples run end-to-end in parallel (decompress
// + sylph profile both on the worker). Default is 2; user can change it via
// the "Threads" picker, and the change takes effect at once: a new worker reads
// the database out of the OPFS cache instead of downloading it again, which is
// what used to make resizing the pool expensive enough to defer.
let rpcs = [];                // filled by ensurePool(); loadDatabase resizes & inits
let dbMeta = null;            // { database_size, k, c, bytes } once loaded
let lineage = {};             // {genome_file: "Species name"}
// Species names that more than one genome in the loaded database carries. See
// speciesLabel(): those rows get the accession appended so the label is unique.
let ambiguousNames = new Set();
let runManifest = {};         // {filename: {sample, layout, mate?}} — optional
let wasmReady = false;        // at least the first worker's wasm is initialized
// Set once, if the boot fails. Checked by loadDatabase() and by runAll(): both
// otherwise wait on wasmReady for ever, with the controls already disabled.
let wasmBootError = null;
// The last failure on the "Load database" path, kept for the diagnostics panel:
// the message the user saw is the one thing a bug report needs and the one
// thing that scrolls away.
let lastLoadError = null;
let abortCtrl = null;
// {samples, rows, ref} — `ref` is the database the numbers came from, frozen at
// the start of the run that produced them. The exports and the on-screen header
// read it from here rather than from the picker: the picker is a control the
// user can move after the fact, and a matrix labelled with a reference it was
// not profiled against is worse than one labelled with none.
let lastMatrix = null;

// ---- which biome ---------------------------------------------------------------
//
// There are nineteen reference databases now, one per MGnify catalogue, and they
// cannot be merged (see the header of biomes.js). Which one is loaded is
// therefore the single most consequential thing on this page, and the failure it
// creates is silent: profiled against the wrong biome, sylph returns a full,
// plausible table. So the choice is tracked as state, not read off the <select>
// at the moment it happens to be needed.
let catalog = null;           // db/biomes.json, normalised
let selectedBiome = null;     // the entry the picker is pointing at, or null for a local file
let currentRef = null;        // the database actually LOADED, as makeDbRef() describes it

// The same memory64 probe the worker runs, run here as well: the reads control
// has to be honest about the ceiling from the first paint, before any worker has
// had time to answer. Workers and window share one WebAssembly implementation,
// so this cannot disagree with them.
const memory64Probe = detectMemory64();
// Turned off for the session if a worker asks for the 64-bit package and gets
// the 32-bit one anyway (a missing sylph-pkg64/ on the server). Without this,
// every single run would tear the pool down and rebuild it to get the same no.
let has64 = memory64Probe.ok;

// Which wasm package the live workers actually loaded. `wasmInfo` comes back
// from the worker's own probe — it reports what really got instantiated, not a
// second guess made here.
let wasmInfo = null;          // { bits, capped, memory64, reason, pkg }
let poolBits = null;          // bits every worker in `rpcs` was booted with
// Remembered so a wasm-build switch can reload the database without asking the
// user to pick the file again. { label, loadFn }.
//
// For a URL database, loadFn reads the OPFS cache entry — so switching the wasm
// build, which throws the whole pool (and its linear memory) away, costs a
// local read and NOT another 433 MB download. That property is the reason the
// bytes live in OPFS rather than in a JS variable on this page.
let lastDbLoad = null;

// ---- database download cache -------------------------------------------------
//
// One download per database for the whole page, no matter how many workers are
// in the pool, resumable and kept in OPFS. See db-cache.js — in particular the
// note explaining why the old "the HTTP cache collapses the N fetches" comment
// that used to sit here was wrong.
const dbc = dbCacheClient({ version: WORKER_VERSION });

// ---- biome screening ---------------------------------------------------------
//
// Runs in a worker of its OWN, created for the screen and terminated after it.
// The obvious implementation — load the marker database into one of the pool
// workers — would silently REPLACE the reference database that worker holds,
// and the next sample it drained would be profiled against 4,169 screening
// markers while the matrix went on naming the catalogue the user chose. There
// is no cheaper way to be sure: a module worker has one module graph for life,
// and the pool's whole design is that every worker holds the same database.
let screenAbort = null;

function paintScreen(html, cls = "") {
  const el = document.getElementById("screenResult");
  if (!el) return;
  el.className = `info${cls ? " " + cls : ""}`;
  el.innerHTML = html;
  el.classList.toggle("hide", !html);
}

// ---- telling you it is over --------------------------------------------------
//
// A project of 85 runs takes hours. Nobody watches it, and the page gives no
// signal you can see from another tab — the run ends, and you find out whenever
// you happen to look.
//
// Two channels, because they fail in different places:
//   - the TAB TITLE, which costs nothing, needs no permission, works in every
//     browser, and is visible in the tab strip from anywhere;
//   - a system NOTIFICATION, which reaches you when the browser is behind
//     something else, and needs permission.
//
// Permission is asked when the box is ticked, NOT on load: a page that asks for
// notifications before you have done anything is a page people click "block" on,
// and after that neither channel can be offered again.
const BASE_TITLE = document.title;

function setTabTitle(prefix) {
  document.title = prefix ? `${prefix} ${BASE_TITLE}` : BASE_TITLE;
}

// Only when the tab is NOT in front. Notifying someone about something they are
// already watching is noise, and noise is what makes notifications get turned off.
function notifyDone(text) {
  setTabTitle("✓ done —");
  if (!document.hidden) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const n = new Notification("PeekMicrobiome — profiling finished", {
      body: text,
      tag: "peek-run-done",     // a second run replaces the first rather than stacking
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* some browsers refuse Notification outside a service worker */ }
}

// Coming back to the tab IS the acknowledgement. Leaving "✓ done" in the title
// for ever would make it meaningless the next time it appears.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && document.title.startsWith("✓")) setTabTitle("");
});

async function wantNotify() {
  const box = document.getElementById("notifyDone");
  if (!box?.checked) return false;
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try { return (await Notification.requestPermission()) === "granted"; }
  catch { return false; }
}

// Long reads make the read cap meaningless as a memory bound: the sketch grows
// with bases, and the measured budget assumed 150 bp. 3 M nanopore reads at
// 10 kb is 30 Gbases against a 7.3 Gbase 32-bit budget — an unrecoverable
// allocator abort, not a slow run.
//
// For an ENA run the mean length is known BEFORE anything is downloaded:
// base_count / read_count, the same pair of fields that settled the spots-vs-
// reads question. For a dropped file it is not, so the cap simply applies.
const LONG_READ_BP = 400;   // comfortably above any Illumina run, below any ONT/PacBio one

function sampleMeanReadBp(s) {
  if (!Number.isFinite(s?.enaBases) || !Number.isFinite(s?.enaReadCount) || !s.enaReadCount) return NaN;
  return s.enaBases / s.enaReadCount;
}
const anyLongReads = () => files.some((s) => sampleMeanReadBp(s) >= LONG_READ_BP);
const capInBases = () => !!els.capInBases?.checked;

// The cap actually handed to the worker, in bases. Infinity means "count reads
// only", which is what every Illumina run wants.
function basesCapFor(maxReads) {
  return capInBases() ? basesForReads(maxReads) : Infinity;
}

function refreshLongReadUnit() {
  if (!els.basesUnit) return;
  const long = anyLongReads();
  els.basesUnit.classList.toggle("hide", !long);
  if (!long) return;
  const worst = Math.max(...files.map(sampleMeanReadBp).filter(Number.isFinite));
  const v = currentReads();
  els.basesUnit.title =
    `These reads average ${Math.round(worst).toLocaleString("en-US")} bp — ` +
    `${(worst / BUDGET_READ_BP).toFixed(0)}x an Illumina read. Ticked, reading stops at ` +
    `${fmtReads(basesForReads(v))} bases (the equivalent of ${fmtReads(v)} reads at ` +
    `${BUDGET_READ_BP} bp). Unticked, it stops at ${fmtReads(v)} reads — about ` +
    `${fmtReads(v * worst)} bases, which is what the memory budget is measured against.`;
}

const autoMode = () => !!document.getElementById("modeAuto")?.checked;

// Manual and automatic are two situations, not two skins: one needs the picker,
// the other needs a sample and no picker at all. Showing both at once invites
// choosing a biome and then screening for it, which is two answers to one
// question.
function refreshDbMode() {
  const auto = autoMode();
  const manual = document.getElementById("manualRow");
  const screenRow = document.getElementById("screenRow");
  if (manual) manual.classList.toggle("hide", auto);
  // The static helper text under the picker described the picker — while the
  // picker was hidden. It is only written when no database has been loaded yet;
  // once one is, dbInfo carries the live status and must not be overwritten.
  if (els.dbInfo && !dbMeta && !els.dbInfo.dataset.busy) {
    els.dbInfo.textContent = auto
      ? "Screening reads one sample, decides which catalogue fits it, and loads that one for the whole batch."
      : "Pick the biome your samples come from and click Load database.";
  }
  // Automatic has nothing to screen until a sample is in the list, and saying
  // so on the button beats a button that fails when pressed.
  const btn = document.getElementById("screenBtn");
  const hint = document.getElementById("screenHint");
  if (screenRow) screenRow.classList.toggle("hide", !auto);
  if (btn) btn.disabled = files.length === 0;
  if (hint && auto) {
    // Name the sample rather than say "the first one". With twelve in the list,
    // "the first" is a rule the user has to apply themselves against an order
    // they did not choose — and the answer is about ONE sample's environment,
    // which is worth knowing before the screen rather than after it.
    const first = files[0];
    hint.textContent = !first
      ? "Add a sample below first — screening reads one of them to decide."
      : `Screens ${first.sampleName}` +
        (files.length > 1 ? ` — the first of ${files.length}` : "") +
        ` against a 13 MB marker set, then loads the catalogue it points to. ` +
        `The whole batch is then profiled against that one catalogue.`;
  }
}

function paintScreenVerdict(sample, v) {
  if (!v.detected) { paintScreen(escapeHTML(v.note), "screen-bad"); return; }
  const rows = v.rows.slice(0, 5).map((r) => {
    const strong = r === v.best && v.confident;
    return `<tr${strong ? ' class="screen-win"' : ""}>` +
      `<td>${escapeHTML(r.biome)}</td><td class="num">${r.taxo.toFixed(1)}%</td>` +
      `<td class="num">${r.excl.toFixed(1)}%</td><td class="num">${r.n}</td>` +
      `<td>${escapeHTML(r.top)}</td></tr>`;
  }).join("");
  const winner = v.confident ? biomeByKey(catalog, v.best.biome) : null;
  const pick = winner?.url
    // No button: the caller loads this database next, so an action the user has
    // to take would be an action that has already been taken for them.
    ? `<div class="screen-next">${ring(NaN, `loading ${winner.label}`, { pct: false })}` +
      `<span>Loading <strong>${escapeHTML(winner.label)}</strong> — it is the catalogue this ` +
      `sample points at.</span></div>`
    // Inconclusive is a dead end in automatic mode unless it offers the way out.
    : `<button id="screenManual">Choose the catalogue myself</button>`;
  paintScreen(
    `<div><strong>${escapeHTML(sample.sampleName)}</strong> — ${v.detected} marker species detected` +
    (v.unmapped ? ` (${v.unmapped} not in the marker map)` : "") + `.</div>` +
    `<table class="screen-table"><tr><th>catalogue</th><th>explains</th>` +
    `<th>exclusive</th><th>n</th><th>top species</th></tr>${rows}</table>` +
    `<div class="screen-note">${escapeHTML(v.note)}</div>` +
    `<div class="screen-caveat">A hint about which catalogue to load — not a profile, and not a ` +
    `diagnosis. Only the <em>exclusive</em> column distinguishes: shared species raise every ` +
    `catalogue they belong to.</div>${pick}`,
    v.confident ? "" : "screen-weak");
}

async function runScreen() {
  const btn = document.getElementById("screenBtn");
  const cancel = document.getElementById("screenCancel");
  // The first sample, not a chosen one: screening asks which ENVIRONMENT this
  // batch came from, and a batch whose samples disagree on that is a mistake the
  // user has to resolve themselves.
  const s = files[0];
  if (!s) return;

  screenAbort = new AbortController();
  if (btn) btn.disabled = true;
  cancel?.classList.remove("hide");
  let rpc = null;
  try {
    const screenWait = (frac, what) =>
      paintScreen(`<div class="screen-next">${ring(frac, what, { pct: Number.isFinite(frac) })}` +
        `<span>Screening <strong>${escapeHTML(s.sampleName)}</strong> — ${escapeHTML(what)}</span></div>`);
    screenWait(NaN, "fetching the marker set");
    const r = await fetch(`./${SCREENING_MARKERS}?v=${WORKER_VERSION}`, { signal: screenAbort.signal });
    if (!r.ok) throw new Error(`marker map: HTTP ${r.status}`);
    const markersJson = await r.json();
    const markers = normaliseMarkers(markersJson);

    // Enough reads to see the dominant species, not enough to quantify them.
    const SCREEN_READS = 500_000;
    rpc = sylphWorkerRpc();
    await rpc.init(SCREEN_READS, chooseWasmBits({ maxReads: SCREEN_READS, memory64: has64 }).bits);
    const abs = new URL(SCREENING_DB, location.href).href;
    const res = await dbc.ensure(abs, {
      onProgress: (p) => screenWait(
        p.total ? (p.received ?? 0) / p.total : NaN, "downloading the 13 MB marker set"),
      signal: screenAbort.signal,
      // Declared in the marker map rather than read from a header: GitHub Pages
      // serves this file gzipped, so Content-Length (and Content-Range) report
      // the compressed size while fetch() hands over the decompressed body.
      expectedSize: Number(markersJson?.dbBytes) || null,
    });
    if (res.opfs) await rpc.loadDbCached(abs); else await rpc.loadDb(res.bytes.slice());

    const onProgress = (p) => {
      if (p.phase || !Number.isFinite(p.reads)) return;
      // Against the screening cap, so the ring means the same thing here as it
      // does on a sample row: how far through THIS pass we are.
      screenWait(p.reads / SCREEN_READS, `${p.reads.toLocaleString("en-US")} reads read`);
    };
    // R1 alone: screening needs presence, and one mate carries the same species.
    const inputs = s.kind === "pe" ? s.peRuns.map((p) => p.r1) : s.seRuns;
    const { tsv } = s.origin === "ena"
      ? await rpc.profileUrls(inputs.map(toUrlDesc), SCREEN_READS, onProgress, screenAbort.signal,
          basesCapFor(SCREEN_READS))
      : await rpc.profileFilesMulti(inputs, SCREEN_READS, onProgress, screenAbort.signal,
          basesCapFor(SCREEN_READS));
    const v = screenVerdict(tsv, markers);
    paintScreenVerdict(s, v);
    // Terminate before loading: the screening worker has served its purpose and
    // loadDatabase() is about to build the real pool.
    rpc.terminate(); rpc = null;
    const winner = v.confident ? biomeByKey(catalog, v.best.biome) : null;
    if (winner?.url) {
      els.dbSelect.value = winner.url;
      els.dbSelect.dispatchEvent(new Event("change"));
      await loadDatabase();
    }
  } catch (e) {
    const cancelled = screenAbort?.signal.aborted;
    paintScreen(cancelled ? "Screening cancelled."
      : `Screening failed: ${escapeHTML(e?.message ?? String(e))}`,
      cancelled ? "" : "screen-bad");
  } finally {
    rpc?.terminate();          // the whole point: it never outlives the screen
    screenAbort = null;
    if (btn) btn.disabled = false;
    cancel?.classList.add("hide");
  }
}

document.getElementById("screenBtn")?.addEventListener("click", runScreen);
for (const id of ["modeManual", "modeAuto"]) {
  document.getElementById(id)?.addEventListener("change", refreshDbMode);
}
// Apply the mode once at load: renderFilesList() only runs when there are
// samples, and until then the screening row would be visible in manual mode.
refreshDbMode();
document.getElementById("screenCancel")?.addEventListener("click", () => screenAbort?.abort());
document.getElementById("screenResult")?.addEventListener("click", (e) => {
  if (e.target.closest("#screenManual")) {
    const m = document.getElementById("modeManual");
    if (m) { m.checked = true; refreshDbMode(); }
    els.dbSelect?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
});
let dbAbort = null;          // AbortController for the download in flight
let dbSource = null;         // "cache" | "network" | "memory" | "file"
let persistence = null;      // result of navigator.storage.persist()

// Try to load the PRJEB83730 manifest — silent if not present.
(async () => {
  try {
    const r = await fetch("./db/prjeb83730.manifest.json");
    if (r.ok) runManifest = await r.json();
  } catch { /* manifest is optional */ }
})();

// ---- reads slider / number sync ---------------------------------------------
//
// This block has to come before the WASM boot below: the boot needs the reads
// value to pick a wasm package, and these are `const` (temporal dead zone).
//
// History of this ceiling, because it has moved three times:
//   3 M   — the original wasm32 4 GB guess;
//   6 M   — after the redundant in-wasm FASTQ copy was removed and the trimmer
//           started releasing its chunks: the wall became JavaScript's 2 GiB
//           single-ArrayBuffer limit, not wasm's;
//   now   — the streaming sketcher never materialises the FASTQ at all, so the
//           only thing left that grows with the input is the sketch state
//           inside wasm. That puts the ceiling back where it belongs: on the
//           address width. 24 M reads at 32 bits, 96 M at 64 bits — see
//           WASM32_SAFE_READS / WASM64_SAFE_READS in sylph-worker-rpc.js for
//           the measurements and the margin.
//
// Both numbers depend on the browser, which is why they are not constants here:
// they follow `has64`, decided by the memory64 probe above. Safari has no
// memory64 in any version, so on Safari the 24 M line is the real one and the
// UI has to say why.

const READS_MIN = 10_000;
const clampReads = (v) => Math.max(READS_MIN, Math.floor(Number(v) || 0));
// "3000000" is a number nobody can read at a glance, and this one decides how
// long a run takes. <input type="number"> cannot show a separator — the browser
// only accepts bare digits — so the field is text and the grouping is ours.
//
// A NARROW NO-BREAK SPACE (U+202F), not a comma or a full space: a comma is a
// decimal separator in half of Europe, and a normal space can wrap mid-number.
const READS_SEP = "\u202f";
const fmtGrouped = (n) =>
  Number.isFinite(n) ? Math.floor(n).toLocaleString("en-US").replace(/,/g, READS_SEP) : "";
// Every separator a user might paste or type: our own, plain spaces, commas,
// and the non-breaking space Excel and Word produce.
const readsFromField = (v) => clampReads(String(v ?? "").replace(/[\s,\u202f\u00a0]/g, ""));
const currentReads = () => readsFromField(els.maxReads.value);
const readsWarn = document.getElementById("readsWarn");
// index.html carries a static note immediately before #readsWarn, and the
// warning text inside it. Both are decided here — the budget depends on whether
// this browser has memory64 — so rewrite them rather than leave two sources of
// truth to disagree. The markup keeps a number-free version for the case where
// this never runs. Guarded: if the markup moves, we simply skip.
const staticReadsNote =
  readsWarn?.previousElementSibling?.classList.contains("info")
    ? readsWarn.previousElementSibling : null;
const readsWarnText = readsWarn?.querySelector("span") ?? null;

// Ticked, "Max reads per sample" and every read count on screen are in
// SEQUENCED READS — the unit the ENA publishes. Unticked, they are in PAIRS,
// the unit sylph counts in: one pair, one number. The two differ by exactly 2x
// on a paired run, which is enough to make a cap or a shortfall look wrong.
// One worker both streams a sample and sketches it, so with a pool of one the
// download stops dead for the whole of every sketch — measured at 3.1 MiB/s
// against 5.2 on the same file when the sketch was not in the way. Two is the
// floor because the second worker is what keeps the wire busy.
const MIN_WORKERS = 2;
// What a fresh tab starts with. Four is the default because the pool is what
// keeps the wire busy while a sample is being sketched, and a run of eighteen
// samples spends most of its wall time waiting for one or the other. It is a
// starting point, not a claim about the machine: Settings moves it, and the
// browser reports how many cores it will admit to.
const DEFAULT_WORKERS = 4;
const MAX_WORKERS = 8;

// ---- how many workers this machine should actually run -----------------------
//
// Four was a constant, and a constant is wrong in both directions. MEASURED on a
// 32-core host: 32 samples took 86.3 s through one worker and 20.0 s through
// eight — a 4.32x speed-up the default left on the table. In the other direction
// every worker holds its OWN copy of the database in its own WebAssembly heap,
// and peak resident memory rose from 1.89 GB at one worker to 14.55 GB at eight
// for the 454 MB human-gut catalogue: a near-constant 1.85 GB per worker. Eight
// workers on the 3.0 GB soil catalogue would ask far more than a 16 GB laptop
// has, and nothing in the page stopped it.
//
// (Measured with node worker threads standing in for Web Workers — the same
// one-database-per-worker shape. The ratio is one measured point, not a fitted
// model, and it is used as one: scaled linearly with the catalogue and nothing
// else read into it.)
//
// `deviceMemory` is a LOWER BOUND — the spec rounds it down to a power of two and
// Chrome caps it at 8, so a 64 GB machine reports 8. Being bounded by that is the
// safe direction, and the reason the number the page chose is shown in Settings
// with its reason rather than applied silently: moving it is one click.
const GB_PER_WORKER_PER_BYTE = 1.85 / 454_021_440;

// Set the moment the reader moves the control in Settings. The page sizes the
// pool for them until then, and never again after.
let workersChosen = false;

function suggestedWorkers(catalogueBytes = 0) {
  const cores = Number(navigator.hardwareConcurrency);
  // One core is left for the page itself: the main thread still parses every
  // TSV, rebuilds the matrix and redraws the figures between samples.
  let n = Number.isFinite(cores) && cores > 0
    ? Math.max(MIN_WORKERS, Math.min(MAX_WORKERS, cores - 1))
    : DEFAULT_WORKERS;
  const gb = Number(navigator.deviceMemory);
  if (Number.isFinite(gb) && gb > 0 && catalogueBytes > 0) {
    // Half the memory the browser will admit to. Not all of it: the page, the
    // browser and everything else the machine is doing are in the other half.
    const perWorker = Math.max(0.35, GB_PER_WORKER_PER_BYTE * catalogueBytes);
    n = Math.max(MIN_WORKERS, Math.min(n, Math.floor((gb * 0.5) / perWorker)));
  }
  return n;
}

/** Why the page chose that number, in one sentence, for the Settings dialog. */
function workersReason(catalogueBytes = 0) {
  const cores = Number(navigator.hardwareConcurrency);
  const gb = Number(navigator.deviceMemory);
  const parts = [];
  parts.push(Number.isFinite(cores) && cores > 0
    ? `${cores} cores reported, one left for the page`
    : `this browser does not report its core count, so ${DEFAULT_WORKERS} is assumed`);
  if (Number.isFinite(gb) && gb > 0 && catalogueBytes > 0) {
    const perWorker = Math.max(0.35, GB_PER_WORKER_PER_BYTE * catalogueBytes);
    parts.push(`at least ${gb} GB of memory, and each worker holds its own copy of ` +
      `this ${(catalogueBytes / 1e9).toFixed(2)} GB catalogue — about ` +
      `${perWorker.toFixed(1)} GB apiece`);
  } else if (catalogueBytes > 0) {
    parts.push("this browser does not report its memory, so only the core count bounds it");
  }
  return parts.join("; ");
}

const pairsCountAsTwo = () => !!els.pairsAsTwo?.checked;

// The cap actually handed to the worker for one sample. The worker always
// counts pairs, so a cap expressed in sequenced reads has to be halved before
// it gets there.
function capFor(sample, maxReads) {
  return sample.kind === "pe" && pairsCountAsTwo()
    ? Math.max(1, Math.floor(maxReads / 2))
    : maxReads;
}

// ...and the reverse, for anything shown to the user.
function readsShown(sample) {
  if (!Number.isFinite(sample.reads)) return sample.reads;
  return sample.kind === "pe" && pairsCountAsTwo() ? sample.reads * 2 : sample.reads;
}

// The choice only means something once a paired sample is in the list; before
// that it is a control for a situation the user is not in.
//
// It also renames the cap. "Max reads per sample: 3,000,000" with the box
// unticked meant three million PAIRS — six million sequenced reads — so the
// label said the opposite of the unit it was in. The word now follows the box,
// and the conversion is spelled out underneath rather than left as arithmetic
// the reader has to do while deciding how long a run will take.
function refreshPairUnit() {
  const el = els.pairsAsTwo?.closest(".pair-unit");
  const anyPaired = files.some((s) => s.kind === "pe");
  if (el) el.classList.toggle("hide", !anyPaired);

  const asTwo = pairsCountAsTwo();
  const word = document.getElementById("capUnitWord");
  // Without a paired sample there is nothing to convert and only one unit in
  // play, so the plain wording is the honest one.
  if (word) word.textContent = anyPaired && !asTwo ? "pairs" : "reads";

  const equiv = document.getElementById("capEquiv");
  if (!equiv) return;
  const v = currentReads();
  equiv.classList.toggle("hide", !anyPaired);
  equiv.textContent = !anyPaired ? "" : asTwo
    ? `= ${fmtReads(Math.round(v / 2))} pairs for a paired run — the unit sylph works in. `
      + `Single-end samples are counted in reads either way.`
    : `= ${fmtReads(v * 2)} sequenced reads for a paired run — the unit the ENA publishes. `
      + `Single-end samples are counted in reads either way.`;
}

function updateReadsState(v) {
  const budget = readsBudget(has64);
  els.maxReadsSlider.max = String(budget.sliderMax);
  const over = v > budget.safeMax;
  els.maxReadsSlider.classList.toggle("over-limit", over);
  if (staticReadsNote) staticReadsNote.textContent = readsBudgetNote(has64);
  // Only written when it is true: an accurate-but-hidden warning is fine, a
  // stale one sitting in the DOM waiting to be unhidden is not.
  if (readsWarnText) readsWarnText.textContent = over ? readsOverBudgetNote(v, has64) : "";
  if (readsWarn) readsWarn.classList.toggle("hide", !over);
  refreshPairUnit();
}

// The read cap bounds how much of each ENA run is actually downloaded, so both
// cost lines are wrong the moment this control moves. Called from the listeners
// rather than from updateReadsState() because that one also runs at module load,
// before the ENA state below it exists.
function enaCostChanged() {
  updateEnaSummary();
  renderEnaPending();
}

els.maxReadsSlider.addEventListener("input", () => {
  els.maxReads.value = fmtGrouped(Number(els.maxReadsSlider.value));
  updateReadsState(Number(els.maxReadsSlider.value));
  enaCostChanged();
});
// NOT reformatted while typing: re-grouping on every keystroke moves the caret
// out from under the cursor, so "3000000" typed left to right becomes unusable.
// The field is read through readsFromField() everywhere, so the digits are
// understood whatever the user has typed so far.
els.maxReads.addEventListener("input", () => {
  const raw = readsFromField(els.maxReads.value);
  if (!Number.isFinite(raw)) return;
  const budget = readsBudget(has64);
  els.maxReadsSlider.value = String(Math.max(READS_MIN, Math.min(budget.sliderMax, raw)));
  updateReadsState(raw);
  enaCostChanged();
});
// On leaving the field: clamp, then group. This is also what repairs anything
// pasted in — "3,000,000", "3 000 000" or "3000000" all come back the same.
els.maxReads.addEventListener("change", () => {
  const v = currentReads();
  els.maxReads.value = fmtGrouped(v);
  els.maxReadsSlider.value = String(v);
  updateReadsState(v);
  enaCostChanged();
});
updateReadsState(currentReads());
// Paint the step state on load, not only after the first click: an empty page
// is exactly when the user needs to be told where to start.
refreshRunButton();

// ---- WASM init ---------------------------------------------------------------

// Which package the current reads setting calls for. 32-bit unless the run is
// too big for it AND the browser can do better — see chooseWasmBits().
function plannedBits(maxReads) {
  return chooseWasmBits({ maxReads, memory64: has64 }).bits;
}

// Boot just the first worker; the rest are spawned + initialized on demand
// when the user clicks Load database with a different Threads value.
(async () => {
  try {
    await ensurePool(1, currentReads());
    wasmReady = true;
  } catch (e) {
    // Remembered, not just displayed. Without this, loadDatabase() below waits
    // on `while (!wasmReady)` for ever — having already disabled every control
    // — so a failed boot turned the page into a dead form with a message far
    // above it that most people scroll past.
    wasmBootError = e?.message ?? String(e);
    showError(`WASM init failed: ${wasmBootError}`);
    console.error(e);
  }
})();

// Grow/shrink the pool to `target` workers, all running the package that
// `maxReads` calls for.
//
// A module worker has one module graph for its whole life: a worker that loaded
// sylph-pkg/ cannot be talked into sylph-pkg64/ afterwards. So when the required
// build changes the whole pool is thrown away and rebuilt — and with it the
// database, which lived in the discarded workers' linear memory. That is the
// real cost of changing "Max reads per sample" after loading a database, and it is
// paid here explicitly instead of silently profiling with the wrong build.
async function ensurePool(target, maxReads) {
  const want = plannedBits(maxReads);
  if (rpcs.length && poolBits !== null && poolBits !== want) {
    for (const r of rpcs) r.terminate();
    rpcs = [];
    dbMeta = null;
    poolBits = null;
  }
  while (rpcs.length > target) rpcs.pop().terminate();
  const spawned = [];
  while (rpcs.length < target) {
    const r = sylphWorkerRpc();
    rpcs.push(r);
    spawned.push(r.init(maxReads, want));
  }
  if (spawned.length) {
    const infos = await Promise.all(spawned);
    wasmInfo = infos[0];
    poolBits = wasmInfo.bits;
    // Asked for 64, got 32: either the worker's own probe vetoed it, or the
    // package is missing/broken on the server. Say so once, and stop planning
    // for a build that is not going to appear.
    if (has64 && wasmInfo.bits === 32 && wasmInfo.capped) {
      has64 = false;
      showError(`The 64-bit WebAssembly build is not available (${wasmInfo.reason}). ` +
        `Falling back to 32-bit: reads per sample are limited to ` +
        `${fmtReads(readsBudget(has64).safeMax)}.`);
      console.error(`[multi] ${wasmInfo.reason}`);
      updateReadsState(Number(els.maxReads.value));
    }
  }
}

// Called right before a run: if the user moved "Max reads per sample" across the
// 32/64-bit boundary since the database was loaded, swap the pool and reload the
// database. Loud, because it costs a database load.
async function ensureWasmBuildFor(maxReads) {
  if (poolBits === plannedBits(maxReads)) return;
  const target = Math.max(1, rpcs.length);
  const from = poolBits;
  const to = plannedBits(maxReads);
  if (!lastDbLoad) { await ensurePool(target, maxReads); return; }
  setStep(`Max reads per sample now ${fmtReads(maxReads)}: switching from the ${from}-bit ` +
    `to the ${to}-bit wasm build and reloading ${lastDbLoad.label}…`);
  els.dbInfo.textContent = `Switching to the ${to}-bit wasm build (reads per sample changed)…`;
  await ensurePool(target, maxReads);          // terminates the old pool, dbMeta = null
  // No network here, and that is the point: killing the pool destroys the
  // database along with the workers' linear memory, but the bytes are in OPFS,
  // so the new workers re-read them locally. Before the cache this replayed a
  // fetch(url) in every worker — a 32→64-bit switch cost another 433 MB.
  const metas = await loadOnAllWorkers(lastDbLoad.loadFn, lastDbLoad.label);
  dbMeta = metas[0];
  if (dbSource === "network") dbSource = "cache";
  revalidateRefAfterReload();
  describeDb(lastDbLoad.label, null);
}

// ---- the biome picker ---------------------------------------------------------
//
// The <select> is built from db/biomes.json, grouped by family. index.html ships
// a two-entry fallback in the markup and this replaces it; if the catalogue file
// cannot be read, fallbackCatalog() keeps the same two entries rather than
// leaving an empty control on a page that cannot profile without a database.

// The catalogue entry the picker points at, or null for "Local file…" — a file
// off the user's disk has no catalogue and must never be labelled as if it did.
function pickedBiome() {
  const v = els.dbSelect?.value ?? "";
  if (!v || v === LOCAL_VALUE) return null;
  return biomeForUrl(catalog ?? fallbackCatalog(), v);
}

// The note under the picker. It describes the SELECTION — and a selection is not
// a state: moving the dropdown after a load costs one gesture and used to leave
// this line asserting, in the present tense, that everything profiled from now on
// is reported against a catalogue that is not the one in memory. Meanwhile the
// status line above and the matrix header below still named the loaded one, so
// the screen contradicted itself on the single fact this page exists to get
// right. When they differ, the loaded database is named FIRST and the entry
// below it drops to the conditional.
function paintBiomeNote() {
  if (!els.dbBiomeNote) return;
  selectedBiome = pickedBiome();
  const local = (els.dbSelect?.value ?? "") === LOCAL_VALUE;
  const pending = !selectionMatchesLoaded(currentRef, selectedBiome, local);
  const txt = local
    ? "A .syldb from your own disk. This page cannot tell which catalogue it was built " +
      "from, so the status line and the exported files will say the biome is unknown — " +
      "which is the honest answer, and the reason to keep a note of it yourself."
    : biomeNote(selectedBiome, { pending });
  const full = pending ? `${notLoadedNote(currentRef)} ${txt}` : txt;
  els.dbBiomeNote.textContent = full;
  els.dbBiomeNote.classList.toggle("hide", !full);
  els.dbBiomeNote.classList.toggle("db-note-pending", pending);
}

els.dbSelect?.addEventListener("change", () => {
  paintBiomeNote();
  if (selectedBiome) rememberBiome(selectedBiome.key);
  // The cache listing marks the entry the picker is on. Moving the picker moves
  // that mark, and with it the answer to "will this one have to be downloaded".
  renderCacheInfo();
});

// Kept as a promise, not only as the variable it fills: the catalogue is a real
// network round trip, and anything that runs off a click in the first second of
// the page — the example does — would otherwise read `catalog` as null and
// quietly do without it.
const catalogReady = (async () => {
  try {
    catalog = await fetchCatalog();
  } catch (e) {
    catalog = fallbackCatalog();
    console.warn("[multi] db/biomes.json could not be read — falling back to the built-in list", e);
  }
  selectedBiome = renderDbSelect(els.dbSelect, catalog, { selected: recallBiome() });
  paintBiomeNote();
  renderCacheInfo();
})();

// ---- database loading --------------------------------------------------------

els.loadDb.addEventListener("click", loadDatabase);

function pickLocalDb() {
  return new Promise((resolve) => {
    els.dbFile.onchange = (e) => {
      const f = e.target.files?.[0];
      e.target.value = "";   // allow re-picking the same file later
      resolve(f || null);
    };
    els.dbFile.click();
  });
}

// The download line. This is where a user stares for five minutes, so it says
// how much, how fast, and how long is left — a bare "Loading…" for that long is
// indistinguishable from a hang, which is exactly what was being reported.
// The same ring as everywhere else, in front of the line. `frac` NaN while there
// is nothing to measure — probing, waiting on another tab — so the arc spins
// instead of showing a 0% that never moves.
function paintDbWait(frac, text) {
  els.dbInfo.innerHTML =
    `<span class="wait-line">${ring(frac, text, { pct: false })}<span>${escapeHTML(text)}</span></span>`;
}

function paintDbProgress(label, p) {
  const frac = p.total > 0 ? (p.received ?? 0) / p.total : NaN;
  const pct = p.total > 0 ? (frac * 100).toFixed(1) : null;
  switch (p.phase) {
    case "probe":
      paintDbWait(NaN, `Checking ${label} on the server`);
      break;
    case "start":
      paintDbWait(frac, `${p.resumed ? "Resuming" : "Downloading"} ${label} — ${p.note}`);
      break;
    case "download": {
      const speed = Number.isFinite(p.bps) ? ` · ${fmtRate(p.bps)}` : "";
      const eta = Number.isFinite(p.etaSec) ? ` · ${fmtEta(p.etaSec)} left` : "";
      paintDbWait(frac,
        `Downloading ${label} — ${fmtBytes(p.received)} / ${fmtBytes(p.total)}` +
        (pct ? ` (${pct}%)` : "") + speed + eta);
      break;
    }
    case "retry":
      paintDbWait(frac,
        `Downloading ${label} — ${fmtBytes(p.received)} / ${fmtBytes(p.total)} — ${p.note}`);
      break;
    // Queued behind another tab of this site. Without a line of its own this
    // looks exactly like a freeze, which is what it used to be: the second tab
    // waited 16 s and then gave up.
    case "wait":
      paintDbWait(NaN, `${label} — ${p.note}`);
      break;
    case "done":
      // Decoding is the one wait with no measurable progress: the whole file is
      // handed to wasm and comes back parsed. A full ring would lie, a spinner
      // does not.
      paintDbWait(NaN, p.source === "cache"
        ? `${label} found in the local cache (${fmtBytes(p.total)}` +
          `${p.revalidated === false ? ", not revalidated — server unreachable" : ""}) — decoding`
        : `${label} downloaded (${fmtBytes(p.total)}) — decoding`);
      break;
  }
}

// Download-or-reuse, exactly once, then hand every worker a way to get the
// bytes locally. Returns the loadFn the pool will run.
async function prepareUrlDb(url, label, expectedSize = null) {
  const abs = new URL(url, location.href).href;
  dbAbort = new AbortController();
  refreshSteps();      // the strip turns amber for the length of the download
  els.cancelDb.classList.remove("hide");
  els.cancelDb.disabled = false;
  try {
    // Asking for persistent storage is what turns "cached until the browser
    // feels like evicting it" into "kept". A refusal is not an error and is not
    // reported as one — the cache still works, it is just evictable.
    if (persistence === null) persistence = await dbc.requestPersistence();

    const res = await dbc.ensure(abs, {
      onProgress: (p) => paintDbProgress(label, p),
      signal: dbAbort.signal,
      // What db/biomes.json says this database weighs, checked against the file
      // at deposit time. It overrides the headers on any host that compresses —
      // GitHub Pages serves the bundled databases gzipped, and its Content-Length
      // is then the compressed size while fetch() delivers them decompressed.
      expectedSize,
    });
    dbSource = res.opfs ? res.source : "memory";
    if (res.opfs) {
      // THE fix: N workers, one download. Each worker opens the same OPFS file
      // itself, so the 433 MB never crosses postMessage and is never duplicated
      // in JS. It also survives a wasm-build switch, which destroys the workers
      // but not the file.
      return (r) => r.loadDbCached(abs);
    }
    // No OPFS: still one download — which is the property the bug report was
    // about — but the bytes live in this page's memory and each worker needs its
    // own copy, because loadDb transfers ownership into the worker. Holding the
    // original keeps a wasm-build switch off the network, at the cost of pinning
    // one database-sized buffer on the main thread for the life of the page.
    // The OPFS path pins nothing.
    const shared = res.bytes;
    return (r) => r.loadDb(shared.slice());
  } finally {
    els.cancelDb.classList.add("hide");
    dbAbort = null;
    refreshSteps();
  }
}

els.cancelDb?.addEventListener("click", () => {
  els.cancelDb.disabled = true;
  dbAbort?.abort();
});

// Hand the database to the workers ONE AT A TIME.
//
// Not for the network's sake — nothing is fetched here any more — but for
// memory's. Loading a database means a full-size Uint8Array in the worker's JS
// heap plus the copy Profiler makes in wasm linear memory: about 900 MB of
// transient peak for the 433 MB database. Four workers doing that at once is
// 3.5 GB of peak on top of whatever the tab already holds, on a page whose
// entire design is about staying under memory ceilings. Sequentially it is
// 900 MB once, and the extra cost is a local disk read per worker.
async function loadOnAllWorkers(loadFn, label) {
  const metas = [];
  for (const [i, r] of rpcs.entries()) {
    els.dbInfo.textContent =
      `Decoding ${label} — worker ${i + 1} of ${rpcs.length}…`;
    metas.push(await loadFn(r));
  }
  // Sequential loads are seconds apart, and another tab is free to invalidate
  // and rewrite the cache entry in between. Each read checks ITSELF against the
  // metadata of the moment; only this compares worker 1 with worker 4. Two
  // references mixed into one abundance matrix, under one header, would be
  // silent and unrecoverable.
  assertSameDatabase(metas);
  return metas;
}

async function loadDatabase() {
  setRunControls(true);
  // BEFORE anything is disabled and before the error line is cleared: if the
  // profiler never started, there is nothing to wait for and the wait below
  // never ends. Say so where the click happened, and leave every control alive.
  if (wasmBootError) {
    els.dbInfo.textContent =
      `The WebAssembly profiler could not start (${wasmBootError}). Nothing on this page ` +
      `can profile until that is fixed — reload the page, and if it happens again your ` +
      `browser may be too old or WebAssembly may be blocked here.`;
    return;
  }
  els.error.textContent = "";
  const url = els.dbSelect.value;
  const t0 = performance.now();

  try {
    while (!wasmReady) await new Promise(r => setTimeout(r, 50));

    // The wasm package is chosen here, from the reads setting, because this is
    // the last moment at which it is free to choose: after this the database
    // sits in the workers' linear memory and swapping builds means reloading it.
    const maxReads = currentReads();
    // Sized HERE, because this is the first moment the catalogue is known and the
    // last moment the pool is free: after this the database is in the workers'
    // linear memory, and changing the count reloads it. A catalogue eight times
    // the size of another needs a different pool, and until now the page used
    // four whatever it was about to load.
    if (!workersChosen) {
      const bytes = Number(biomeForUrl(catalog, url)?.bytes) || 0;
      els.poolSize.value = String(suggestedWorkers(bytes));
    }
    const target = Math.max(MIN_WORKERS, Math.min(MAX_WORKERS, parseInt(els.poolSize.value, 10) || MIN_WORKERS));
    if (target !== rpcs.length || poolBits !== plannedBits(maxReads)) {
      els.dbInfo.textContent = `Preparing ${target} ${plannedBits(maxReads)}-bit worker${target === 1 ? "" : "s"}…`;
      await ensurePool(target, maxReads);
      dbMeta = null;  // any previously-loaded DB is in old (or terminated) workers only
    }

    // Read ONCE, here: everything downstream — the status line, the matrix
    // header, the exports — describes the database that is about to be loaded,
    // not whatever the picker says by the time it is asked.
    const biome = pickedBiome();

    let label, loadFn;
    if (url === LOCAL_VALUE) {
      const file = await pickLocalDb();
      if (!file) { els.dbInfo.textContent = "No file selected."; return; }
      label = file.name;
      dbSource = "file";
      // Untouched by the cache work: a file already on the user's disk needs no
      // downloading and no second copy of itself in OPFS.
      loadFn = (r) => r.loadDbFile(file);
    } else {
      // Named by biome wherever there is one: five minutes of "Downloading
      // content (zenodo.org)" tells the user nothing about what they are
      // waiting for, and nothing about whether it is the right thing.
      label = biome ? `${biome.label} (${biome.file})` : dbLabel(url);
      // biome.bytes is the size db/biomes.json declares, and biomes.js already
      // refuses a database whose size disagrees with it — so it is the same
      // number, used one step earlier, where a compressing host would otherwise
      // have made the download fail before it could be checked.
      loadFn = await prepareUrlDb(url, label, Number.isFinite(biome?.bytes) ? biome.bytes : null);
    }
    // Every worker now reads the SAME local copy (OPFS file, or one in-memory
    // buffer on the fallback path). Before this, each worker ran its own
    // fetch(url) — with a pool of 4 that was four simultaneous 433 MB
    // downloads competing for the same link, which is what made loading the
    // Zenodo database unreliable.
    const metas = await loadOnAllWorkers(loadFn, label);
    dbMeta = metas[0];
    // Kept so ensureWasmBuildFor() can redo this load after a build switch
    // without making the user pick the file again. `biome` travels with it, or a
    // build switch would silently relabel the reload as a local file.
    lastDbLoad = { label, loadFn, biome, url };

    // The identity of what is now in the workers. Everything that names the
    // reference reads this.
    const ref = makeDbRef({ biome, dbMeta, label, source: dbSource, url });
    adoptDbRef(ref);

    // Lineage maps a genome filename to a species name, and there is one per
    // catalogue — the gut map does not describe soil genomes. Loaded only when
    // the entry declares one; otherwise cleared, so the previous biome's names
    // cannot be pinned onto this one's genomes. Without a map the matrix shows
    // the genome accession, which is right rather than merely blank.
    // The example is over: this database, and the map that belongs to it, take
    // the page back. Cleared before the assignments below so that the restore
    // inside clearDemo() cannot put the borrowed map back afterwards.
    clearDemo();
    lineage = {}; ambiguousNames = new Set(); taxonomy = normaliseLineage(null);
    if (biome?.lineage) {
      try {
        const lineageResp = await fetch(`./${biome.lineage}`);
        if (lineageResp.ok) {
          taxonomy = normaliseLineage(await lineageResp.json());
          lineage = taxonomy.species;
          ambiguousNames = sharedNames(lineage);
        }
      } catch { /* leave lineage empty: genome accessions instead of names */ }
    }

    describeDb(label, (performance.now() - t0) / 1000);
    refreshRunButton();
  } catch (e) {
    els.dbInfo.textContent = "";
    if (e?.name === "AbortError") {
      // Cancelling is not failing. Say where the download stopped, because the
      // next click continues from there rather than from zero.
      els.dbInfo.textContent = "Download cancelled — the bytes already fetched are kept, " +
        "clicking Load database again resumes where it stopped.";
    } else {
      // A load that fails PART-WAY is the dangerous one. loadOnAllWorkers goes
      // one worker at a time and each worker frees its old Profiler before
      // building the new one, so "worker 1 succeeded, worker 2 ran out of
      // memory" leaves the pool holding two different references — or one and a
      // half. Leaving dbMeta and currentRef describing the OLD database then
      // lets the next run distribute samples across that pool and export them
      // under a label that is true of at most half of them.
      //
      // So failure is total: nothing loaded, no reference, no replayable load
      // (which also stops the pool-resize and 32/64-bit paths from rebuilding
      // half a database from it), and refreshRunButton() in the finally greys
      // "Profile all" out and says why.
      dbMeta = null;
      currentRef = null;
      lastDbLoad = null;
      // Kept for the diagnostics panel: this message is what a bug report needs,
      // and it is also the one that scrolls away first.
      lastLoadError = String(e?.message ?? e).slice(0, 300);
      lineage = {}; ambiguousNames = new Set(); taxonomy = normaliseLineage(null);
      els.dbInfo.textContent =
        "No database is loaded. The load failed part-way through, and a pool where some " +
        "workers hold the new database and some hold nothing would profile different samples " +
        "against different references — so everything was dropped. Click \"Load database\" to " +
        "try again.";
      showError(`Failed to load database: ${e.message ?? e}`);
      console.error(e);
    }
  } finally {
    setRunControls(false);
    // The note under the picker asserts things about what is loaded, and what is
    // loaded has just changed (or been dropped).
    paintBiomeNote();
    refreshRunButton();
    renderCacheInfo();
  }
}

// Re-check the reference against the database that just came back from a RELOAD
// (a 32/64-bit build switch, or new workers joining the pool). Both paths reload
// out of the local cache without touching the network, and both used to trust
// that the bytes were the ones currentRef was minted from. assertSameDatabase
// cannot see the difference: it compares the workers with each other, and after
// a rewrite by another tab they all agree — on a database this page is not
// describing. adoptDbRef, not describeDb, because a different database means the
// finished samples were profiled against something else and have to go back to
// pending.
function revalidateRefAfterReload() {
  if (!currentRef || !dbMeta) return;
  const drift = refMetaMismatch(currentRef, dbMeta);
  if (!drift) return;
  adoptDbRef(makeDbRef({
    biome: lastDbLoad?.biome ?? null,
    dbMeta,
    label: lastDbLoad?.label ?? currentRef.file,
    source: dbSource,
    url: lastDbLoad?.url ?? currentRef.url,
  }));
  const msg = `The database re-read from the local cache is not the one that was loaded ` +
    `(${drift}). Another tab replaced the cached copy at that URL. The reference has been ` +
    `updated to the database now in memory.`;
  const already = els.error.textContent;
  showError(already ? `${msg}\n\n${already}` : msg);
  paintBiomeNote();
}

// A short name for a database URL. The Zenodo URL ends in "/content", which is
// a uselessly generic thing to put in a progress line.
function dbLabel(url) {
  try {
    const u = new URL(url, location.href);
    const segs = u.pathname.split("/").filter(Boolean);
    const name = segs.reverse().find(s => /\.syldb$/i.test(s)) ?? segs[0] ?? u.hostname;
    return u.origin === location.origin ? name : `${name} (${u.hostname})`;
  } catch {
    return url;
  }
}

// ---- what is cached, and how to get rid of it --------------------------------

// Same URL, whatever form it was written in. The cache stores absolute URLs;
// the picker holds whatever db/biomes.json says, which for the bundled database
// is a relative path.
function sameUrl(a, b) {
  if (!a || !b) return false;
  try { return new URL(a, location.href).href === new URL(b, location.href).href; }
  catch { return a === b; }
}

// A cached entry, named as the user chose it. The cache is keyed by URL, so
// several biomes coexist in it happily — but listed by file name alone they read
// as "gut.syldb", "soil.syldb", "marine.syldb", which is exactly the moment at
// which someone deletes the wrong 2.8 GB.
function cacheEntryName(e) {
  const b = e.url ? biomeForUrl(catalog ?? fallbackCatalog(), e.url) : null;
  if (b) return `${b.label} — ${catalogueName(b)} (${b.file})`;
  return e.url ? dbLabel(e.url) : e.key;
}

// Databases are hundreds of megabytes of the user's disk. They are entitled to
// see that, and to reclaim it, without opening DevTools.
async function renderCacheInfo() {
  if (!els.dbCacheInfo) return;
  let entries = [];
  try { entries = (await dbc.list()).entries ?? []; } catch { /* no OPFS: nothing to show */ }
  if (!entries.length) { els.dbCacheInfo.innerHTML = ""; return; }
  const est = await dbc.estimate();
  // Asked, not remembered: `persistence` is only ever set by the first download
  // of a session, so a returning visitor who already has persistent storage was
  // being told the browser might evict their 433 MB.
  const persisted = persistence?.persisted ?? await dbc.persisted();
  els.dbCacheInfo.innerHTML =
    `<div><strong>Cached on this computer</strong> ` +
    `(${cacheSummary({ estimate: est, persisted, entries })}):</div>` +
    entries.map(e => {
      // Deleted by KEY, not by URL: an entry whose meta.json is unreadable has
      // no URL, and that is precisely the entry a user needs to be able to
      // remove.
      const name = escapeHTML(cacheEntryName(e));
      // The entry the picker is on, marked: this is the answer to "if I click
      // Load database now, does it download 2.8 GB again or not".
      const picked = e.complete && sameUrl(e.url, els.dbSelect?.value)
        ? ` — <strong>the biome selected above: it will load from here, nothing to download</strong>`
        : "";
      const state = (e.complete
        ? fmtBytes(e.bytes)
        : `${fmtBytes(e.bytes)} of ${e.size ? fmtBytes(e.size) : "?"} — incomplete, will resume`)
        // What "still the right file" was actually checked against. On a host
        // that sends no ETag and no Last-Modified it can only ever mean "the same
        // number of bytes", and saying so is the difference between a check and
        // the appearance of one.
        + (e.validators === "size-only" ? " — checked on its length only" : "");
      return `<div style="display:flex;gap:.5rem;align-items:center;margin-top:.2rem">` +
        `<span>${name} — ${state}${picked}</span>` +
        `<button type="button" data-cache-key="${escapeHTML(e.key)}" ` +
        `style="padding:.1rem .5rem;font-size:.8rem">Delete</button></div>`;
    }).join("");
}

els.dbCacheInfo?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-cache-key]");
  if (!btn) return;
  btn.disabled = true;
  // removeCachedKey returns false when the directory could not be removed —
  // which is exactly what happens while a download holds the exclusive sync
  // handle on that entry. Silently redrawing the same list and saying nothing is
  // how the Delete button came to look broken.
  const { removed } = await dbc.remove({ key: btn.dataset.cacheKey });
  if (!removed) {
    btn.disabled = false;
    showError("This database could not be deleted — a download of it is probably still " +
      "running. Cancel the download first, then delete it.");
  }
  await renderCacheInfo();
});

renderCacheInfo();

// The database line, plus which wasm build is behind it. The build is not a
// detail: it is what decides whether the reads setting is reachable at all, and
// on a browser without memory64 this is the only place the user can find out
// why they cannot go as high as the documentation says.
// Take on a newly loaded database as THE reference, and refuse to let results
// from the previous one survive beside it.
//
// runAll() replays samples that are already `done` straight into the matrix
// without re-profiling them. That is right within one reference and catastrophic
// across two: MGnify dereplicates every catalogue separately and they overlap,
// so a matrix holding rows from human-oral and rows from soil would put the same
// species in twice, under one header, with no way to tell afterwards. Changing
// the loaded database therefore resets every finished sample instead of quietly
// mixing references — and says so, because losing ten minutes of profiling
// without being told is its own bug.
function adoptDbRef(ref) {
  const changed = !!currentRef && !sameDbRef(currentRef, ref);
  currentRef = ref;
  if (!changed) return;
  const stale = files.filter((s) => s.rows);
  for (const s of stale) {
    s.status = "pending";
    s.rows = undefined;
    s.detected = undefined;
    s.reads = undefined;
    s.elapsed = undefined;
    s.error = undefined;
  }
  if (stale.length) {
    showError(
      `Reference database changed to ${refLine(ref)}. ` +
      `${stale.length} sample${stale.length === 1 ? "" : "s"} profiled against the previous ` +
      `one ${stale.length === 1 ? "was" : "were"} reset: abundances from two catalogues cannot ` +
      `share a matrix — MGnify dereplicates each catalogue on its own and they overlap, so the ` +
      `same species would appear twice. Click "Profile all" to run them against this database. ` +
      `The matrix already on screen keeps the reference it was profiled against.`);
    renderFilesList();
    refreshRunButton();
  }
}

function describeDb(label, seconds) {
  if (!dbMeta) return;
  const when = seconds == null ? "" : `, loaded in ${seconds.toFixed(1)} s`;
  const build = wasmInfo ? ` — ${loadedBuildNote(wasmInfo.bits, has64, "reads/sample")}` : "";
  // Where the bytes came from. Worth a clause of its own: it is the difference
  // between "this took five minutes and will again" and "this is instant from
  // now on", and it is the only signal that the cache is doing its job.
  const from =
    dbSource === "cache" ? " · loaded from local cache" :
    dbSource === "network" ? " · downloaded and cached locally" :
    dbSource === "memory" ? " · downloaded (not cached: this browser has no OPFS)" : "";
  // The BIOME first, before the byte counts: it is the one fact on this line
  // that decides whether the results mean anything at all.
  const who = refShort(currentRef) || label;
  els.dbInfo.textContent =
    `Database ready on ${rpcs.length} worker${rpcs.length === 1 ? "" : "s"} — ${who}${from}: ` +
    `${dbMeta.database_size} genomes, k=${dbMeta.k}, c=${dbMeta.c} ` +
    `(${fmtBytes(dbMeta.bytes)}${when})${build}.`;
  // The catalogue says how many genomes this database holds and sylph says how
  // many it loaded. When they disagree, the file behind that URL is not the one
  // the entry describes — and every export of this session would carry a label
  // that is not true of its numbers.
  // Prepended, not written over: loading a database can already have said that
  // it reset the samples profiled against the previous one, and that message is
  // not expendable. loadDatabase() clears this box on entry, so nothing older
  // than the current load can be sitting here.
  const mismatch = genomeCountMismatch(currentRef);
  if (mismatch) {
    const already = els.error.textContent;
    showError(already ? `${mismatch}\n\n${already}` : mismatch);
  }
}

// ---- file picker -------------------------------------------------------------

["dragenter", "dragover"].forEach(ev =>
  els.drop.addEventListener(ev, e => { e.preventDefault(); els.drop.classList.add("over"); })
);
["dragleave", "drop"].forEach(ev =>
  els.drop.addEventListener(ev, e => { e.preventDefault(); els.drop.classList.remove("over"); })
);
els.drop.addEventListener("drop", e => {
  e.preventDefault();
  addFiles(Array.from(e.dataTransfer.files));
});
els.file.addEventListener("change", () => {
  addFiles(Array.from(els.file.files));
});
// Threads used to take effect only on the next "Load database", because a new
// worker meant another 433 MB download — with a pool of 4, four of them at once.
// Since the database is cached in OPFS a new worker just reads the local file,
// so the change can be applied on the spot. Nothing to re-click, nothing
// re-downloaded.
// Changing the unit re-reads every ENA expectation: they were stored in the old
// one, and a stale expectation is exactly how a good sample gets flagged short.
els.capInBases?.addEventListener("change", () => { refreshLongReadUnit(); enaCostChanged(); });
els.pairsAsTwo?.addEventListener("change", () => {
  refreshPairUnit();
  for (const s of files) {
    if (s.origin === "ena" && Number.isFinite(s.enaReadCount)) {
      s.enaReads = expectedProfiledReads({
        readCount: s.enaReadCount, layout: s.enaLayout, pairsAsTwo: pairsCountAsTwo(),
      });
    }
  }
  renderFilesList();
});

els.poolSize?.addEventListener("change", async () => {
  const target = Math.max(MIN_WORKERS, Math.min(MAX_WORKERS, parseInt(els.poolSize.value, 10) || MIN_WORKERS));
  if (!wasmReady || target === rpcs.length) return;
  const shrinking = target < rpcs.length;
  els.poolSize.disabled = true;
  try {
    await ensurePool(target, currentReads());
    // Growing the pool leaves the new workers without a database; re-run the
    // same load, which comes from the OPFS cache (or from the file the user
    // picked) rather than from the network.
    if (!shrinking && lastDbLoad) {
      els.dbInfo.textContent =
        `Adding worker${target === 1 ? "" : "s"} — reading ${lastDbLoad.label} from the local cache…`;
      const metas = await loadOnAllWorkers(lastDbLoad.loadFn, lastDbLoad.label);
      dbMeta = metas[0];
      if (dbSource === "network") dbSource = "cache";
      revalidateRefAfterReload();
      describeDb(lastDbLoad.label, null);
    } else if (shrinking && dbMeta) {
      describeDb(lastDbLoad?.label ?? "database", null);
    }
  } catch (e) {
    showError(`Could not resize the worker pool: ${e.message ?? e}`);
    console.error(e);
  } finally {
    els.poolSize.disabled = false;
    refreshRunButton();
  }
});

els.clearFiles.addEventListener("click", () => {
  files = [];
  renderFilesList();
  // The ENA list marks runs that are already in the sample list; clearing the
  // samples has to give those runs back, or they stay unselectable for good.
  renderEnaRuns();
  refreshRunButton();
});

// ---- ENA input mode ----------------------------------------------------------
//
// The second way in: an accession instead of a file. The runs it resolves to
// join the SAME sample list as dropped files — that is what makes the two modes
// coexist rather than being two half-applications.
//
// The one thing this section owes the user, and the reason it is not just an
// input and a button: a project accession is 85 runs, 72 GiB and several hours.
// That number is shown BEFORE the click, next to the box that starts it, and it
// is recomputed from what is actually ticked.

let enaResolved = [];          // runs from the last successful lookup
const enaSelected = new Set(); // run accessions ticked in that list
let enaAbort = null;           // AbortController for a lookup in flight

// Measured download rate, remembered across visits so the very first estimate a
// returning user sees is their own link's, not a guess. Only ever used for
// estimates.
const BPS_KEY = "sylph-ena-bps";
let observedBps = (() => {
  try {
    const v = Number(localStorage.getItem(BPS_KEY));
    return Number.isFinite(v) && v > 0 ? v : NaN;
  } catch { return NaN; }
})();

// How many samples are downloading right now. The rate a sample sees is its
// share of the link, not the link: with a pool of 2 each stream measures about
// half of what the connection delivers, and an ETA for a whole batch built on
// that number is twice too long — presented as "measured on your link". This is
// what turns the per-stream measurement back into a link measurement.
let netActive = 0;
// localStorage.setItem is synchronous and on the main thread; noteRate is
// called from every progress event (~10/s per stream). Persisting on every one
// of them is hundreds of thousands of synchronous writes over a large batch,
// for a number whose only use is the next page load.
const BPS_PERSIST_MS = 5000;
let bpsPersistedAt = 0;

// Smoothed, so one slow chunk does not rewrite the estimate.
function noteRate(bps, streams = Math.max(1, netActive)) {
  if (!Number.isFinite(bps) || bps <= 0) return;
  const linkBps = bps * Math.max(1, streams);
  observedBps = Number.isFinite(observedBps) ? observedBps * 0.8 + linkBps * 0.2 : linkBps;
  const now = performance.now();
  if (now - bpsPersistedAt < BPS_PERSIST_MS) return;
  bpsPersistedAt = now;
  try { localStorage.setItem(BPS_KEY, String(Math.round(observedBps))); } catch { /* private mode */ }
}

const currentBps = () => (Number.isFinite(observedBps) && observedBps > 0 ? observedBps : ASSUMED_BPS);

// "about 8 min 20 s at 4.0 MB/s (assumed)". Always says which rate it used:
// an ETA whose provenance is hidden is a number people plan around.
//
// `est` comes from downloadEstimate(), which is the one place that knows
// whether an estimate can be made at all. When it cannot — any run whose
// fastq_bytes is missing — this says so instead of printing the "0 s" that a
// zero-byte total used to produce in front of a multi-hour download.
function etaNote(est) {
  if (!est.estimable) {
    return est.unknown
      ? `${est.unknown} file${est.unknown === 1 ? " has" : "s have"} no size in the ENA record, ` +
        `so how long this takes cannot be estimated`
      : "how long this takes cannot be estimated";
  }
  const bps = currentBps();
  const measured = Number.isFinite(observedBps) && observedBps > 0;
  return `about ${fmtEta(est.seconds)} at ${fmtRate(bps)} ` +
    `(${measured ? "measured on your link" : "assumed until measured"})`;
}

// The size half of the same line. Never "0 B" when the truth is "unknown".
function sizeNote(est) {
  const known = est.bytes > 0 ? fmtBytes(est.bytes) : "";
  const unk = est.unknown ? `${est.unknown} file${est.unknown === 1 ? "" : "s"} of unknown size` : "";
  const head = known && unk ? `${known} + ${unk}` : (known || unk || "nothing");
  return est.capped && known ? `at most ${head}` : head;
}

// Every ENA control is reached through optional chaining, and each renderer
// returns early if its element is missing. Not defensive programming for its own
// sake: index.html is the ONE file whose cache token cannot be busted by
// anything else, so a visitor holding a stale copy of it gets this module
// against a page with no ENA panel. Without the guards the first
// addEventListener throws, the module dies at import, and the page loses the
// file-drop mode as well — a feature they cannot use taking down the one they
// can.
function enaShowError(msg) {
  if (els.enaError) els.enaError.textContent = msg ?? "";
}

async function enaLookup() {
  if (!els.enaAcc) return;
  const v = validateAccession(els.enaAcc.value);
  enaShowError("");
  // Optional chaining on EVERY element, not only on the two that happened to
  // get it: the guard above only proves #enaAcc exists. A stale index.html that
  // kept the input but renamed the cancel button used to throw inside the
  // `finally` below, which swallowed the resolved runs and left "Look up"
  // disabled for the rest of the session.
  if (els.enaStatus) els.enaStatus.textContent = "";
  if (!v.ok) { enaShowError(v.error); return; }
  els.enaAcc.value = v.acc;
  if (els.enaResolve) els.enaResolve.disabled = true;
  els.enaCancelLookup?.classList.remove("hide");
  // A line of text that does not move is indistinguishable from a hang. The
  // portal usually answers in well under a second, but "usually" is exactly the
  // case that needs no feedback — it is the slow one the user is staring at.
  // The elapsed seconds are what a spinner alone cannot give: proof that time is
  // passing HERE rather than that an animation is looping over a dead request.
  const askedAt = performance.now();
  const sayWaiting = () => {
    if (!els.enaStatus) return;
    const sec = (performance.now() - askedAt) / 1000;
    els.enaStatus.textContent =
      `Asking the EBI which runs ${v.acc} covers…` + (sec >= 1.5 ? ` (${sec.toFixed(0)} s)` : "");
  };
  els.enaStatus?.classList.add("busy");
  sayWaiting();
  const waitTick = setInterval(sayWaiting, 500);
  const stopWaiting = () => {
    clearInterval(waitTick);
    els.enaStatus?.classList.remove("busy");
  };
  enaAbort = new AbortController();
  try {
    const runs = await resolveAccession(v.acc, { signal: enaAbort.signal });
    enaResolved = runs;
    enaSelected.clear();
    // Runs whose library type cannot be profiled are listed and can be ticked,
    // but are NOT ticked for you: the default should not spend 200 MB a run on
    // a download whose result is known in advance to be empty. "Select all"
    // still takes them — that is an explicit instruction, this is a default.
    for (const r of runs) if (r.usable && !r.unprofilable) enaSelected.add(r.run);
    const bad = runs.filter((r) => !r.usable).length;
    const unprofilable = runs.filter((r) => r.usable && r.unprofilable).length;
    if (els.enaStatus) {
      const asides = [];
      if (bad) asides.push(`${bad} without downloadable FASTQ`);
      if (unprofilable) {
        asides.push(`${unprofilable} not shotgun metagenomics — left unticked, see below`);
      }
      els.enaStatus.textContent =
        `${runs.length} run${runs.length === 1 ? "" : "s"} in ${v.acc}` +
        (asides.length ? ` (${asides.join("; ")})` : "");
    }
    renderEnaRuns();
  } catch (e) {
    enaResolved = [];
    enaSelected.clear();
    els.enaResult?.classList.add("hide");
    if (els.enaStatus) els.enaStatus.textContent = "";
    if (e?.name !== "AbortError") enaShowError(e?.message ?? String(e));
    else if (els.enaStatus) els.enaStatus.textContent = "Lookup cancelled.";
  } finally {
    stopWaiting();
    if (els.enaResolve) els.enaResolve.disabled = false;
    els.enaCancelLookup?.classList.add("hide");
    enaAbort = null;
  }
}

function enaSelectedRuns() {
  return enaResolved.filter((r) => r.usable && enaSelected.has(r.run));
}

function renderEnaRuns() {
  if (!els.enaResult || !els.enaRuns) return;
  if (!enaResolved.length) { els.enaResult.classList.add("hide"); return; }
  els.enaResult.classList.remove("hide");
  els.enaRuns.innerHTML = enaResolved.map((r) => {
    const size = Number.isFinite(r.bytes) && r.bytes > 0
      ? fmtBytes(r.bytes) + (r.bytesUnknown ? " + unknown" : "")
      : "size unknown";
    const reads = Number.isFinite(r.reads) ? `${fmtReads(r.reads)} reads` : "read count unknown";
    const notes = [r.problem, r.note].filter(Boolean).join(" — ");
    if (!r.usable) {
      return `<li class="unusable"><span class="ena-id">${escapeHTML(r.run)}</span>` +
        `<span class="ena-note">${escapeHTML(notes)}</span></li>`;
    }
    // Already added? Adding it twice profiles the same download twice and puts a
    // duplicate column in the matrix — never what anyone means to do.
    const already = enaAlreadyAdded(r.run);
    const tag = r.layout === "PAIRED" ? "PE" : "SE";
    if (already) {
      return `<li class="unusable">
        <span class="ena-id">${escapeHTML(r.run)} <small>${tag}</small></span>
        <span class="ena-note">already in the sample list below</span>
      </li>`;
    }
    // The library type goes on its own line, not folded into `notes`: the other
    // notes are about which FILES were taken, this one is about whether the run
    // can answer the question at all, and it is the reason the box is unticked.
    const lib = r.unprofilable
      ? `<span class="ena-note ena-row-note ena-unprofilable">` +
        `${escapeHTML(r.strategy || "this run")} — ${escapeHTML(r.unprofilable)}</span>`
      : "";
    // Two columns rather than one run-on line: with 85 runs the sizes and read
    // counts are what you scan down, and they only compare if they line up.
    return `<li${r.unprofilable ? ' class="ena-warned"' : ""}>
      <label class="ena-pick">
        <input type="checkbox" data-run="${escapeHTML(r.run)}" ${enaSelected.has(r.run) ? "checked" : ""}>
        <span class="ena-id">${escapeHTML(r.run)} <small>${tag}</small></span>
      </label>
      <span class="ena-figs">
        <span class="ena-size">${escapeHTML(size)}</span>
        <span class="ena-reads">${escapeHTML(reads)}</span>
      </span>
      ${notes ? `<span class="ena-note ena-row-note">${escapeHTML(notes)}</span>` : ""}
      ${lib}
    </li>`;
  }).join("");
  updateEnaSummary();
}

function updateEnaSummary() {
  if (!els.enaSummary || !els.enaAdd) return;
  const chosen = enaSelectedRuns();
  // Bounded by the read cap, and recomputed whenever that control moves: the
  // total is what this download is going to cost AT THE CURRENT SETTING, not
  // what the files weigh.
  const est = downloadEstimate(chosen, { maxReads: currentReads(), bps: currentBps() });
  setDisabled(els.enaAdd, chosen.length === 0
    ? "Tick at least one run in the list above to add it." : "");
  if (!chosen.length) {
    els.enaSummary.textContent = "Nothing selected.";
    return;
  }
  // Loud past 10 GB: that is the point where "a project" stops being a click and
  // becomes an afternoon.
  const heavy = est.bytes > 10 * 1024 ** 3;
  els.enaSummary.innerHTML =
    `<span class="ena-cost${heavy ? " heavy" : ""}">${chosen.length} run${chosen.length === 1 ? "" : "s"} · ` +
    `${escapeHTML(sizeNote(est))} to download</span> — ${escapeHTML(etaNote(est))}` +
    (est.capped ? `, because <em>Max reads per sample</em> stops each run early` : "") + `.`;
}

els.enaResolve?.addEventListener("click", enaLookup);
els.enaAcc?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); enaLookup(); } });
els.enaCancelLookup?.addEventListener("click", () => enaAbort?.abort());
els.enaRuns?.addEventListener("change", (e) => {
  const cb = e.target.closest("input[type=checkbox][data-run]");
  if (!cb) return;
  if (cb.checked) enaSelected.add(cb.dataset.run); else enaSelected.delete(cb.dataset.run);
  updateEnaSummary();
});
els.enaAll?.addEventListener("click", () => {
  for (const r of enaResolved) if (r.usable) enaSelected.add(r.run);
  renderEnaRuns();
});
els.enaNone?.addEventListener("click", () => { enaSelected.clear(); renderEnaRuns(); });
// ---- what the archive said about each sample ---------------------------------
//
// Keyed on the sample name as SHOWN, never on the run accession: two runs of
// one sample, or a name already taken, and uniqueSampleName has made it
// `ERR14098576_2`. The matrix knows that name and nothing else.
//
// Rebuilt from `files` on every redraw, like refBySample beside it, so a sample
// removed from the list takes its metadata with it instead of leaving a label
// hanging over a column that no longer exists.
const metaStore = () =>
  new Map(files.filter((f) => f.enaMeta).map((f) => [f.sampleName, f.enaMeta]));

const metaOf = (sample) => lastRaw?.metaBySample?.get(sample) ?? null;

els.enaAdd?.addEventListener("click", () => {
  const chosen = enaSelectedRuns();
  for (const r of chosen) {
    // Same shape as a dropped sample, with URL descriptors in place of Files.
    // resolveSampleKind()/pairUp() below are reused verbatim: they only ever
    // look at `layout` and `mate`.
    const s = {
      kind: "se",
      sampleName: uniqueSampleName(r.run),
      origin: "ena",
      enaRun: r.run,
      enaNote: r.note,
      // What the ENA says this run holds, converted to the unit the worker
      // reports back.
      //
      // For a PAIRED run the ENA's read_count counts BOTH mates, while the
      // worker returns pairs. Measured on ERR14098649: read_count = 13,510,300
      // and R1 really holds 6,755,150 records — exactly half. Comparing the two
      // directly would mark every paired run as 50% short, i.e. flag the whole
      // paired-end mode as truncated.
      // Both the raw catalogue figure and its converted form: the unit can change
      // after the sample is in the list.
      enaReadCount: r.reads,
      enaBases: r.bases,
      enaLayout: r.layout,
      // What the archive says this sample IS. Carried here and nowhere else:
      // the run row is gone by the time the matrix exists, and re-fetching it
      // to label a column would be a second request for something we were
      // already told.
      enaMeta: r.meta,
      enaReads: expectedProfiledReads({
        readCount: r.reads, layout: r.layout, pairsAsTwo: pairsCountAsTwo(),
      }),
      sources: r.files.map((f, i) => ({
        file: { url: f.url, name: f.name, size: f.bytes },
        layout: r.layout,
        mate: r.layout === "PAIRED" ? String(i + 1) : null,
      })),
      status: "pending",
    };
    files.push(s);
    resolveSampleKind(s);
  }
  enaSelected.clear();
  renderEnaRuns();
  renderFilesList();
  refreshRunButton();
});

// The total that has to be visible next to the Profile all button, not only
// inside the ENA panel: by the time the samples are in the list, the panel may
// well be scrolled away.
function renderEnaPending() {
  if (!els.enaPending) return;
  const pend = files.filter((s) => s.origin === "ena" && s.status === "pending");
  if (!pend.length) {
    els.enaPending.classList.add("hide");
    els.enaPending.textContent = "";
    return;
  }
  // Same arithmetic as the panel above, from the same function: the read cap
  // bounds this total too, and an unknown size still refuses to become an ETA.
  const est = downloadEstimate(pend.map((s) => ({
    bytes: s.sources.reduce((a, src) => a + (Number.isFinite(src.file.size) ? src.file.size : 0), 0),
    bytesUnknown: s.sources.filter((src) => !Number.isFinite(src.file.size)).length,
    reads: s.enaReads,
  })), { maxReads: currentReads(), bps: currentBps() });
  els.enaPending.classList.remove("hide");
  els.enaPending.innerHTML =
    `<span class="ena-cost">${pend.length} ENA sample${pend.length === 1 ? "" : "s"} still to download: ` +
    `${escapeHTML(sizeNote(est))}</span> — ${escapeHTML(etaNote(est))}. ` +
    `The download starts when you click <em>Profile all</em>, ` +
    `is streamed straight into the profiler, and is never permanently saved to your disk.`;
}

// A URL source, as the worker wants it. `size` may be NaN (fastq_bytes missing);
// the worker treats that as "unknown", not as zero.
const toUrlDesc = (d) => ({ url: d.url, bytes: d.size, name: d.name });

// matePattern / stripFastqExt now live in sample-naming.js (imported at the top),
// where they can be tested without a DOM. The pattern that used to be here
// required the mate marker to be glued to the extension, so anything a pipeline
// had touched — `_1.clean.fq.gz`, `_R1_001.fastq.gz` — never paired up.

// Find or create a sample entry by name. Pending samples can accept more files;
// completed ones get a new disambiguated copy.
function getOrCreateSample(name) {
  let s = files.find(x => x.sampleName === name && x.status === "pending");
  if (s) return s;
  s = { kind: "se", sampleName: uniqueSampleName(name), sources: [], status: "pending" };
  files.push(s);
  return s;
}

// Is this ENA run already among the samples? Matched on the run accession the
// sample was built from, not on the display name, which uniqueSampleName() may
// have suffixed — and not on the URLs, which would miss a run whose files the
// ENA re-published.
function enaAlreadyAdded(run) {
  return files.some((s) => s.origin === "ena" && s.enaRun === run);
}

function uniqueSampleName(base) {
  const taken = files.map(s => s.sampleName);
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

function addFiles(fs) {
  for (const f of fs) {
    const m = runManifest[f.name];
    if (m) {
      // Manifest hit: group by the canonical sample alias (e.g. MQB_014).
      const s = getOrCreateSample(m.sample);
      s.sources.push({ file: f, layout: m.layout, mate: m.mate });
      continue;
    }
    // Otherwise fall back to mate-pattern auto-grouping.
    const tag = matePattern(f.name);
    if (tag) {
      // tag.key, not tag.base: mates have to agree on the suffixes too, or
      // a_1.clean.fq.gz would pair with a_2.raw.fq.gz.
      const s = getOrCreateSample(tag.key);
      s.sources.push({ file: f, layout: "PAIRED", mate: tag.mate });
    } else {
      const s = getOrCreateSample(stripFastqExt(f.name));
      s.sources.push({ file: f, layout: "SINGLE", mate: null });
    }
  }
  for (const s of files) resolveSampleKind(s);
  renderFilesList();
  refreshRunButton();
}

// Pick an effective layout for a sample. Prefer PE when any pairs are present:
// dropping SE technical replicates loses some reads but keeps the paired info
// intact, which is more informative for sylph than ignoring R2s.
function resolveSampleKind(s) {
  const peRuns = pairUp(s.sources.filter(x => x.layout === "PAIRED"));
  const seRuns = s.sources.filter(x => x.layout === "SINGLE");
  if (peRuns.length > 0) {
    s.kind = "pe";
    s.peRuns = peRuns;
    s.dropped = seRuns.length > 0 ? `${seRuns.length} SE run(s) ignored` : "";
  } else {
    // A file named _1 with no _2 is tagged PAIRED by addFiles(), pairUp() makes
    // no pair out of it, and it used to be dropped here — leaving a sample with
    // ZERO inputs that was still queued, sent to the worker, and reported as a
    // broken FASTQ. It is a perfectly good single-end read set; the ENA path
    // already says exactly that when only one mate is archived, and dropping a
    // file the user deliberately added is the wrong answer either way.
    const orphans = s.sources.filter(x => x.layout === "PAIRED");
    s.kind = "se";
    s.seRuns = [...seRuns, ...orphans].map(x => x.file);
    s.dropped = orphans.length
      ? `${orphans.map(o => o.file.name).join(", ")} has no mate — profiled single-end`
      : "";
  }
}

// Pair up files where mate=1/2 come together. Orphan mates (only _1 or _2)
// fall back to SE on that one file.
function pairUp(peSources) {
  const r1 = peSources.filter(x => x.mate === "1").map(x => x.file);
  const r2 = peSources.filter(x => x.mate === "2").map(x => x.file);
  const orphans1 = peSources.filter(x => x.mate === null);
  if (orphans1.length) console.warn("paired sources with null mate:", orphans1);
  const n = Math.min(r1.length, r2.length);
  const pairs = [];
  for (let i = 0; i < n; i++) pairs.push({ r1: r1[i], r2: r2[i] });
  return pairs;
}

function fileSummary(s) {
  if (s.kind === "pe") {
    const totalBytes = s.peRuns.reduce((a, p) => a + p.r1.size + p.r2.size, 0);
    const note = s.dropped ? ` <small style="color:#888">(${escapeHTML(s.dropped)})</small>` : "";
    return `${s.peRuns.length} paired run${s.peRuns.length === 1 ? "" : "s"} (${fmtBytes(totalBytes)})${note}`;
  }
  const totalBytes = s.seRuns.reduce((a, f) => a + f.size, 0);
  // The SE branch dropped the note the PE branch shows. That is where "no mate —
  // profiled single-end" has to appear: a degradation the user is not told about
  // is one they will attribute to the data.
  const note = s.dropped ? ` <small style="color:#888">(${escapeHTML(s.dropped)})</small>` : "";
  return `${s.seRuns.length} single-end run${s.seRuns.length === 1 ? "" : "s"} (${fmtBytes(totalBytes)})${note}`;
}

// The per-sample progress ring, on the right of its line.
//
// Only while the sample is running: a finished line already says how many reads
// went in and how many species came out, and a ring stuck at full next to it
// says nothing the text does not.
//
// Full means "this sample is done", which under a read cap is NOT the end of
// the file — see progressFraction(). A run capped at 3 M reads on a 10 M-read
// file completes at 30% of the bytes, and a ring that measured only bytes
// would vanish at a third, looking like a crash.
//
// SVG rather than a CSS conic-gradient: stroke-dasharray on a circle is one
// attribute to animate, it degrades to a plain circle where SVG is styled out,
// and it does not need a repaint of a gradient on every progress event — with
// two workers and 100 ms events, that is 20 repaints a second.
const RING_R = 8;
const RING_C = 2 * Math.PI * RING_R;
// ONE ring for every wait on this page — per-sample profiling, the database
// download, the screening pass. Three different waits drawn three different ways
// (a ring here, a trailing "…" there) make the reader learn three things instead
// of one, and the "…" cannot say how far along it is even when that is known.
//
// `frac` NaN means "working, nothing to measure against yet": a spinning arc
// rather than a 0% ring, because an empty ring that never fills reads as broken
// while a spinner is honest about not knowing.
function ring(frac, title, { pct = true } = {}) {
  const known = Number.isFinite(frac);
  const v = known ? Math.max(0, Math.min(1, frac)) : 0;
  const shown = known ? Math.round(v * 100) : null;
  const dash = known
    ? `${(v * RING_C).toFixed(2)} ${RING_C.toFixed(2)}`
    : `${(RING_C * 0.25).toFixed(2)} ${RING_C.toFixed(2)}`;
  const label = title || (known ? `${shown}%` : "working");
  return `<span class="ring${known ? "" : " ring-spin"}" role="img"
      aria-label="${escapeHTML(label)}" title="${escapeHTML(label)}">
      <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
        <circle class="ring-track" cx="10" cy="10" r="${RING_R}"></circle>
        <circle class="ring-fill" cx="10" cy="10" r="${RING_R}"
          stroke-dasharray="${dash}" stroke-dashoffset="0"></circle>
      </svg>${known && pct ? `<b>${shown}%</b>` : ""}</span>`;
}

function progressRing(s) {
  if (s.status !== "running") return "";
  return ring(s.frac, Number.isFinite(s.frac)
    ? `${Math.round(s.frac * 100)}% of this sample — whichever comes first, the end of the input or the read cap`
    : "running — no size or read cap to measure against yet");
}

function renderFilesList() {
  refreshDbMode();
  refreshLongReadUnit();
  renderEnaPending();
  if (files.length === 0) {
    els.filesList.classList.add("hide");
    els.filesList.innerHTML = "";
    setDisabled(els.clearFiles, "Nothing to clear — no samples have been added yet.");
    return;
  }
  els.filesList.classList.remove("hide");
  setDisabled(els.clearFiles, "");
  els.filesList.innerHTML = files.map((s) => {
    const cls = s.status;
    // How many reads actually went into the profile. It was not shown at all,
    // which meant a run that downloaded 40 % of its file and stopped cleanly
    // reported "6 species detected in 18 s" and nothing else — no number on
    // screen, in the TSV or in the log could have revealed it.
    // Shown in whatever unit the checkbox says, and NAMED, so "3,000,000" is
    // never ambiguous between three million pairs and three million reads.
    const shown = readsShown(s);
    const unit = s.kind === "pe" && !pairsCountAsTwo() ? "pairs" : "reads";
    const readsPart = Number.isFinite(shown)
      ? `${shown.toLocaleString()} ${unit} profiled, ` : "";
    const label =
      cls === "pending" ? (s.origin === "ena" ? "pending — will download from the EBI" : "pending") :
      cls === "running" ? `running (${s.progress ?? ""})` :
      cls === "done" ? `${readsPart}${s.detected ?? 0} species detected in ${s.elapsed?.toFixed(1) ?? "?"} s` :
      cls === "empty" ? `${readsPart}NO species matched this catalogue in ${s.elapsed?.toFixed(1) ?? "?"} s — ` +
        `the reads were profiled, nothing in them is in the catalogue that is loaded. ` +
        `Usually the wrong biome, an amplicon (16S) run, or a blank.` :
      cls === "incomplete" ? `INCOMPLETE — ${readsPart}${s.detected ?? 0} species — ${s.error}` :
      cls === "cancelled" ? "cancelled — click Profile all to run it again" :
      cls === "failed" ? `failed: ${s.error}` : "";
    const kindTag = s.kind === "pe" ? " <small>[PE]</small>" : " <small>[SE]</small>";
    // Where this sample comes from is not decoration: one of them is on the
    // user's disk and one is going to be fetched over the network.
    const originTag = s.origin === "ena" ? " <small>[ENA]</small>" : "";
    // Everything parseRunRow took the trouble to name — "profiled as
    // single-end", "not named _1/_2", "3 files read one after the other" —
    // used to be written onto the sample and then read by nobody. A degradation
    // the user is never told about is a degradation they will attribute to the
    // data.
    const note = s.enaNote
      ? `<br><small class="ena-note">${escapeHTML(s.enaNote)}</small>` : "";
    return `
      <li class="${cls}">
        <span><strong>${escapeHTML(s.sampleName)}</strong>${kindTag}${originTag} &mdash; ${fileSummary(s)}${note}</span>
        <span>${escapeHTML(label)}</span>
        ${progressRing(s)}
      </li>`;
  }).join("");
}

// Anything that is not finished-and-complete can be run again. `failed` was
// missing, and runAll() has always re-queued failures — so the retry path
// existed and the only button that reaches it was greyed out the moment
// nothing was `pending` any more, while the error text on the line said
// "start it again".
const RERUNNABLE = ["pending", "failed", "cancelled", "incomplete", "empty"];

// Frozen for the duration of a run, alongside Load database and Threads.
// `maxReads` is read ONCE, when the run starts: moving the slider afterwards
// changes nothing for the samples in flight, so leaving it live would show a
// number that is not the one being used — and could ask for a 32/64-bit build
// switch while the current build is busy profiling.
// A greyed-out control with a not-allowed cursor states a refusal and gives no
// way out of it. Every disable now carries its reason.
//
// The reason goes on `title` AND, for the controls whose card has room, into a
// visible line — because a tooltip is worth nothing on a touch screen, where
// there is no hover, and nothing to a keyboard user either, since a disabled
// button is not focusable. (Chrome does deliver mouseover to disabled buttons —
// measured — so the tooltip is a real bonus on desktop, not a decoration.)
function setDisabled(el, why) {
  if (!el) return;
  el.disabled = !!why;
  if (why) el.title = why; else el.removeAttribute("title");
}

function setRunControls(running) {
  // One moment, one reason: everything here is frozen for the duration of a run,
  // because changing the database or the read cap mid-run would leave the matrix
  // describing numbers that came from something else.
  const busy = running
    ? "A profiling run is going. This is frozen until it finishes, or until you click Cancel."
    : "";
  setDisabled(els.loadDb, busy);
  setDisabled(els.poolSize, busy);
  setDisabled(els.maxReads, busy);
  setDisabled(els.maxReadsSlider, busy);
  // The pair unit IS the read cap, in another unit: capFor() halves the cap for
  // a paired sample when this is ticked, and the cap is read per sample as the
  // run walks the list. Toggling it at sample nine would profile the first eight
  // at three million pairs and the rest at one and a half, and the matrix would
  // say nothing about it — the exact failure the comment above this function
  // describes, through the one control that was left out of it.
  setDisabled(els.pairsAsTwo, busy);
  // Same reason, one tab over: the reference is loaded into the pool once, at the
  // start. Ticking this at sample nine would give the first eight no functional
  // profile and the rest one, and the Function tab would show half a matrix with
  // nothing saying why.
  setDisabled(els.funcOn, busy);
  setDisabled(els.enaResolve, busy);
  setDisabled(els.enaAdd, busy || (enaSelectedRuns().length === 0
    ? "Tick at least one run in the list above to add it."
    : ""));
  // The example lends the page the gut lineage map, and the map is what names
  // every row a finishing sample adds. Loading it mid-run would put gut species
  // names on genomes from whatever catalogue is actually loaded.
  setDisabled(document.getElementById("demoLoad"), busy);
  // Visible, not only on hover: there is no hover on a phone.
  if (els.runControlsNote) {
    els.runControlsNote.textContent = busy;
    els.runControlsNote.classList.toggle("hide", !busy);
  }
}

function refreshRunButton() {
  const haveSamples = files.length > 0;
  const runnable = haveSamples && files.some(f => RERUNNABLE.includes(f.status));
  els.run.disabled = !(dbMeta && runnable);   // `why` below carries the reason

  // A greyed-out button that does not say why is a dead end — and the usual
  // reason is that the database has not been loaded yet, which is a separate
  // card further up the page and easy to walk straight past.
  const why =
    !haveSamples ? "Add some samples first — drop FASTQ files above, or look one up from the ENA."
    : !dbMeta ? "Load a reference database first (the card above): profiling needs it, and the full one takes a few minutes to fetch the first time."
    : !runnable ? "Every sample here is already done. Add more, or press Clear to start over."
    : "";
  els.run.title = why;
  if (els.runHint) {
    els.runHint.textContent = why;
    els.runHint.classList.toggle("hide", !why);
  }
  refreshSteps();
  refreshPairUnit();
}

// The three cards are a sequence, and it now shows: each number fills in green
// when its step is satisfied, and the step you can act on carries the accent.
// Same facts as the hint above, said in a way you do not have to read.
function refreshSteps() {
  const done = [!!dbMeta, files.length > 0, !!lastMatrix];
  // The current step is the first unsatisfied one — except that the database
  // and the samples can be done in either order, so both stay "now" until each
  // is met rather than forcing an order the page does not actually impose.
  const cards = [els.cardDb, els.cardSamples, els.results];
  cards.forEach((card, i) => {
    if (!card) return;
    card.classList.toggle("step-done", done[i]);
    const now = !done[i] && (i < 2 ? true : done[0] && done[1]);
    card.classList.toggle("step-now", now && i < 2);
  });

  // The same three states, said in words, in a strip that does not scroll away.
  // Each line answers "what is there now", and where nothing is there yet, "what
  // to do" — because a step that only says "none yet" tells the user they are
  // stuck without telling them how to stop being stuck.
  const running = files.some((f) => f.status === "running");
  // The database step is busy while its bytes are still being fetched or
  // decoded — dbAbort is live for exactly that window.
  const dbBusy = () => !!dbAbort;
  const okN = files.filter((f) => f.status === "done").length;
  const badN = files.filter((f) => ["failed", "empty", "incomplete"].includes(f.status)).length;
  const state = [
    dbBusy()
      ? "downloading and decoding — see the line in the card"
      : dbMeta
        ? `${currentRef?.label ?? "loaded"} · ${fmtCountish(dbMeta.database_size)} genomes`
        : (autoMode() ? "screen a sample to pick one" : "pick a biome and load it"),
    files.length
      ? `${files.length} sample${files.length === 1 ? "" : "s"}` +
        (running ? ` · ${files.filter((f) => f.status === "running").length} running` : "")
      : "drop FASTQs, or paste an ENA accession",
    // A run in flight outranks both — "ready, press Profile all" while it is
    // already running is the one line that could send someone to press it twice.
    running
      ? `profiling — ${okN} of ${files.length} done`
      : lastMatrix
        // The strip is the one place a table with no run behind it could pass
        // for one: steps 1 and 2 sit there unstarted while this line turns
        // green. It says which it is.
        ? `${demoOn ? "the example — " : ""}${lastMatrix.rows.length} species × ` +
          `${lastMatrix.samples.length} samples` + (badN ? ` · ${badN} need a look` : "")
        : (done[0] && done[1] ? "ready — press Profile all" : "waiting for the two steps above"),
  ];
  for (let i = 0; i < 3; i++) {
    const el = document.getElementById(`stState${i}`);
    if (el) el.textContent = state[i];
    const item = document.querySelector(`.stepper-item[data-goto="${["cardDb", "cardSamples", "results"][i]}"]`);
    if (!item) continue;
    // Green means FINISHED. A step whose work is still going is amber, whatever
    // else is true of it — the database is "loaded" the moment its bytes are in
    // memory, but calling that step done while a run is chewing through it was
    // the thing that read wrong.
    const working = [dbBusy(), running, running][i];
    item.classList.toggle("is-done", done[i] && !working);
    // "now" is what the user can act on: both of the first two until each is
    // met, and the third only once they are. Never while it is working.
    const now = !working && (i < 2 ? !done[i] : (done[0] && done[1] && !done[2]));
    item.classList.toggle("is-now", now);
    item.classList.toggle("is-running", working);
  }
}

// Genome counts are the one figure here that is always a plain integer.
const fmtCountish = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString("en-US") : "?");

// The strip is a set of jump links: seeing that step 1 is unmet is only half the
// answer if reaching it means hunting for the card.
document.getElementById("stepper")?.addEventListener("click", (e) => {
  const b = e.target.closest(".stepper-item");
  if (!b) return;
  const el = document.getElementById(b.dataset.goto);
  if (!el || el.classList.contains("hide")) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
});

// ---- settings ----------------------------------------------------------------
//
// The theme, and the four things a browser can actually bound. Deliberately not
// a "CPU limit" or a "bandwidth limit": neither exists in a page, and a control
// that claims one and does nothing is worse than no control. Workers ARE the CPU
// dial, the read cap IS the memory bound, and fewer streams IS the network one.
const SETTINGS_KEY = "peek-settings";
// funcMinPct: the floor under the FUNCTIONAL MATRIX, in percent of a sample.
// 4,307 orthologs is what a 3M-read profile reports, and the great majority of
// them sit at the detection floor — one shared hash, about 0.0003% — where the
// number is a presence, not a quantity. 0.05% keeps a few hundred rows a reader
// can actually scan. It bounds the TABLE and its downloads only: a diversity
// index computed on a display threshold is not a diversity index, so the figures
// keep every row.
const DEFAULT_SETTINGS = { diskGb: 8, funcMinPct: 0.05 };
let settings = { ...DEFAULT_SETTINGS };
try { settings = { ...settings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; }
catch { /* private mode */ }
const saveSettings = () => {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
};

async function paintSettings() {
  const dlg = document.getElementById("settings");
  if (!dlg) return;
  const mode = themeMode();
  for (const r of dlg.querySelectorAll('input[name="thememode"]')) r.checked = r.value === mode;
  const sched = loadSchedule();
  dlg.querySelector("#darkFrom").value = sched.from;
  dlg.querySelector("#darkTo").value = sched.to;
  // The value that WILL be used, not the pool that happens to exist. At rest the
  // pool holds one worker — nothing has been profiled yet — and showing that
  // printed "1" into a field whose own minimum is 2, under a heading that says
  // what this page is allowed to use.
  dlg.querySelector("#setWorkers").value = String(Math.max(MIN_WORKERS,
    Math.min(MAX_WORKERS, Number(els.poolSize?.value) || DEFAULT_WORKERS)));
  // A number the page chose has to say why it chose it, or the reader has no
  // basis for moving it — and this one is bounded by a measurement they cannot
  // see: every worker holds its own copy of the catalogue.
  const why = dlg.querySelector("#setWorkersWhy");
  if (why) {
    const bytes = Number(currentRef?.bytes) || 0;
    why.textContent = workersChosen
      ? "You set this. The page no longer sizes it for you."
      : bytes
        ? `Chosen for this machine: ${workersReason(bytes)}.`
        : "Sized when a database is loaded, from this machine's cores and memory and the size of that catalogue.";
  }
  dlg.querySelector("#setReads").value = fmtGrouped(currentReads());
  const kegg = dlg.querySelector("#setKegg");
  if (kegg) {
    kegg.value = keggConsent();
    kegg.onchange = () => {
      // "not answered" is a real choice: it puts the question back, which is the
      // only way to undo an answer given by mistake.
      try {
        if (kegg.value) localStorage.setItem(KEGG_CONSENT_KEY, kegg.value);
        else localStorage.removeItem(KEGG_CONSENT_KEY);
      } catch { /* private mode */ }
      // Repaint the PANEL, not a figure. `openFig` holds one of the four
      // `data-fig` values or null and never "function" — the Function tab is a
      // level up now, with its own `openFuncFig` — so this branch was dead, and
      // "not answered" cleared the stored answer while the KEGG matrix, figures
      // and summary stayed on screen. The undo promised two lines above did
      // nothing unless the reader happened to switch tabs and back.
      if (!document.getElementById("funcPanel")?.classList.contains("hide")) refreshFunc();
    };
  }
  dlg.querySelector("#setDisk").value = String(settings.diskGb);
  const gmm = dlg.querySelector("#setGmm");
  if (gmm) {
    gmm.value = gmmConsent();
    gmm.onchange = () => {
      try {
        if (gmm.value) localStorage.setItem(GMM_CONSENT_KEY, gmm.value);
        else localStorage.removeItem(GMM_CONSENT_KEY);
      } catch { /* private mode */ }
      if (!document.getElementById("funcPanel")?.classList.contains("hide")) refreshFunc();
    };
  }
  const funcMin = dlg.querySelector("#setFuncMin");
  if (funcMin) funcMin.value = String(settings.funcMinPct ?? DEFAULT_SETTINGS.funcMinPct);
  // What is on disk right now, so the cap is set against a number rather than a
  // guess. Live, because it changes every time a database is loaded.
  const now = dlg.querySelector("#diskNow");
  if (now) {
    try {
      const { entries } = await dbc.list();
      const used = entries.reduce((a, e) => a + (e.bytes || 0), 0);
      now.textContent = `Using ${fmtBytes(used)} across ${entries.length} database${entries.length === 1 ? "" : "s"}.`;
    } catch { now.textContent = ""; }
  }
}

// What this browser actually offers on the path "Load database" takes. Every
// line is a real feature test, not a user-agent guess: the point is to tell a
// Firefox that works from one that does not, and the UA string says neither.
// Ask a throwaway worker whether an OPFS write primitive is there. Classic
// worker, not a module one: this needs no imports, and a module worker from a
// blob URL is one more thing that can fail while answering "what can fail".
function workerHas(method) {
  return new Promise((resolve) => {
    let w;
    const done = (v) => { try { w?.terminate(); } catch { /* gone */ } resolve(v); };
    const timer = setTimeout(() => done("no answer"), 4000);
    try {
      const src = `self.onmessage = async () => {
        try {
          const root = await navigator.storage.getDirectory();
          const f = await root.getFileHandle("diagprobe", { create: true });
          const ok = typeof f[${JSON.stringify(method)}] === "function";
          await root.removeEntry("diagprobe").catch(() => {});
          self.postMessage(ok ? "yes" : "NO");
        } catch (e) { self.postMessage("NO — " + (e.name || e.message)); }
      };`;
      w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
      w.onmessage = (e) => { clearTimeout(timer); done(e.data); };
      w.onerror = () => { clearTimeout(timer); done("worker failed to start"); };
      w.postMessage(1);
    } catch (e) { clearTimeout(timer); done(`could not start a worker: ${e?.message ?? e}`); }
  });
}

async function diagnostics() {
  const has = (v) => (v ? "yes" : "NO");
  const out = [
    ["userAgent", navigator.userAgent],
    ["secure context", has(window.isSecureContext)],
    ["OPFS (storage.getDirectory)", has(typeof navigator.storage?.getDirectory === "function")],
    // Tested INSIDE a worker, which is the only place either exists and the only
    // place db-cache runs. Probed from the page they read `undefined` on every
    // browser — Chrome included — so the first version of this panel reported
    // "NO" on a machine where the feature works, which is worse than reporting
    // nothing: it points the next bug report at the wrong thing.
    ["createSyncAccessHandle (in worker)", await workerHas("createSyncAccessHandle")],
    ["createWritable (in worker)", await workerHas("createWritable")],
    ["Web Locks", has(typeof navigator.locks?.request === "function")],
    ["module workers", has(true)],   // this file is one; if it were not, nothing would run
    ["WebAssembly.validate", has(typeof WebAssembly?.validate === "function")],
    ["memory64", detectMemory64().ok ? "yes" : `no — ${detectMemory64().reason}`],
    ["wasm booted", wasmBootError ? `NO — ${wasmBootError}` : has(wasmReady)],
    ["workers in pool", String(rpcs.length)],
  ];
  try {
    const est = await navigator.storage?.estimate?.();
    out.push(["storage quota", est ? `${fmtBytes(est.usage ?? 0)} of ${fmtBytes(est.quota ?? 0)}` : "unavailable"]);
    out.push(["persistent storage", has(await navigator.storage?.persisted?.())]);
  } catch (e) { out.push(["storage estimate", `failed: ${e?.message ?? e}`]); }
  // The last thing that went wrong on this path, whatever it was.
  if (lastLoadError) out.push(["last load error", lastLoadError]);
  return out;
}

async function paintDiagnostics() {
  const el = document.getElementById("settingsDiag");
  if (!el) return;
  const rows = await diagnostics();
  el.textContent = rows.map(([k, v]) => `${k}: ${v}`).join("\n");
}

document.getElementById("copyDiag")?.addEventListener("click", async () => {
  const btn = document.getElementById("copyDiag");
  try {
    await navigator.clipboard.writeText(document.getElementById("settingsDiag")?.textContent ?? "");
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = "Copy for a bug report"; }, 2000);
  } catch {
    // Clipboard needs a permission in some browsers; selecting the text is the
    // fallback that always works.
    const r = document.createRange();
    r.selectNodeContents(document.getElementById("settingsDiag"));
    getSelection().removeAllRanges(); getSelection().addRange(r);
    btn.textContent = "Selected — press Ctrl+C";
  }
});

document.getElementById("settingsBtn")?.addEventListener("click", async () => {
  paintDiagnostics();
  await paintSettings();
  document.getElementById("settings")?.showModal();
});

document.getElementById("settings")?.addEventListener("change", (e) => {
  const dlg = e.currentTarget;
  const t = e.target;
  if (t.name === "thememode") setThemeMode(t.value);
  if (t.id === "darkFrom" || t.id === "darkTo") {
    saveSchedule({ from: dlg.querySelector("#darkFrom").value, to: dlg.querySelector("#darkTo").value });
    if (themeMode() === "schedule") applyTheme("schedule");
  }
  if (t.id === "setWorkers" && els.poolSize) {
    // The reader has chosen. From here on the page stops sizing the pool for
    // them: a suggestion that overrides the choice it was made to inform is not
    // a suggestion.
    workersChosen = true;
    els.poolSize.value = String(Math.max(MIN_WORKERS, Math.min(MAX_WORKERS, Number(t.value) || MIN_WORKERS)));
    els.poolSize.dispatchEvent(new Event("change"));
  }
  if (t.id === "setReads" && els.maxReads) {
    els.maxReads.value = t.value;
    els.maxReads.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (t.id === "setDisk") {
    settings.diskGb = Math.max(0, Number(t.value) || 0);
    saveSettings();
  }
  if (t.id === "setFuncMin") setFuncFloor(t.value);
});

/**
 * The function matrix's display floor, from either of the two boxes that set it.
 *
 * Two boxes because the caption under the table used to point at Settings —
 * "Settings changes the floor" — which is a page admitting its control is in the
 * wrong place. One rule, so the two cannot disagree; and both are written back,
 * because a setting shown in two places that differ is worse than one that is
 * merely hard to find.
 */
function setFuncFloor(value) {
  // Clamped at both ends: a negative floor is meaningless, and above 100 the
  // table is empty with nothing on screen explaining why.
  settings.funcMinPct = Math.min(100, Math.max(0, Number(value) || 0));
  for (const id of ["setFuncMin", "funcMinInline"]) {
    const el = document.getElementById(id);
    if (el) el.value = String(settings.funcMinPct);
  }
  saveSettings();
  if (!document.getElementById("funcPanel")?.classList.contains("hide")) refreshFunc();
}

document.getElementById("funcMinInline")?.addEventListener("change",
  (e) => setFuncFloor(e.target.value));
// Filled at load, not only when Settings is opened: the box beside the table is
// the one most readers will ever see, and an empty number field says nothing
// about the floor that is actually in force.
{
  const inline = document.getElementById("funcMinInline");
  if (inline) inline.value = String(settings.funcMinPct ?? DEFAULT_SETTINGS.funcMinPct);
}

document.getElementById("settingsPurge")?.addEventListener("click", async () => {
  const btn = document.getElementById("settingsPurge");
  btn.disabled = true;
  try {
    const { entries } = await dbc.list();
    for (const e of entries) await dbc.remove(e.key ?? e.url);
    await paintSettings();
    await renderCacheInfo();
  } catch (err) {
    showError(`Could not clear the cache: ${err?.message ?? err}`);
  } finally {
    btn.disabled = false;
  }
});

// ---- resource monitor --------------------------------------------------------
//
// Three things bound this page: linear memory, disk, and the link. The first two
// were invisible until they failed — an out-of-memory abort is unrecoverable and
// arrives with no warning, and a full disk stops a download that looked fine.
//
// Polled, not pushed, and only while the panel is open: a figure nobody is
// looking at is not worth a message per second across four workers.
const MON_MS = 1000;
let monTimer = null;

const monEl = (id) => document.getElementById(id);
const setBar = (id, frac, danger = 0.85) => {
  const b = monEl(id);
  if (!b) return;
  const v = Number.isFinite(frac) ? Math.max(0, Math.min(1, frac)) : 0;
  b.style.width = `${(v * 100).toFixed(1)}%`;
  b.classList.toggle("hot", v >= danger);
};

async function refreshMonitor() {
  const mon = document.getElementById("monitor");
  if (!mon || mon.classList.contains("collapsed")) return;

  // WASM: the real linear memory, summed across the pool. This is the number the
  // reads budget is a proxy for, and the only one that can end a run outright.
  try {
    const all = await Promise.all(rpcs.map((r) => r.stats().catch(() => null)));
    const live = all.filter((s) => s && Number.isFinite(s.wasmBytes));
    if (live.length) {
      const total = live.reduce((a, s) => a + s.wasmBytes, 0);
      const bits = live[0].bits ?? (has64 ? 64 : 32);
      // What the engine will hand out at all: 4 GB for wasm32, 16 GB for V8's
      // memory64. Per worker, since each has its own linear memory.
      const ceiling = (bits === 64 ? 16 : 4) * 2 ** 30 * live.length;
      monEl("monWasm").textContent = fmtBytes(total);
      setBar("monWasmBar", total / ceiling);
      monEl("monWasmNote").textContent =
        `${live.length} × ${bits}-bit · ceiling ${fmtBytes(ceiling)} · never released until reload`;
    } else {
      // The wasm module takes several seconds to boot, and a bare "—" during
      // that window reads as "this panel is broken" rather than "not yet".
      monEl("monWasm").textContent = rpcs.length ? "starting" : "—";
      setBar("monWasmBar", 0);
      monEl("monWasmNote").textContent = rpcs.length
        ? "the WebAssembly module is still loading" : "no worker yet";
    }
  } catch { /* a worker mid-restart is not an error worth showing */ }

  // Disk: what the browser will admit to. Both figures are the origin's, not
  // this page's alone, so they are labelled as such.
  try {
    const est = await navigator.storage?.estimate?.();
    if (est && Number.isFinite(est.quota)) {
      monEl("monDisk").textContent = fmtBytes(est.usage ?? 0);
      setBar("monDiskBar", (est.usage ?? 0) / est.quota);
      monEl("monDiskNote").textContent =
        `of ${fmtBytes(est.quota)} this browser allows${persistence ? " · persistent" : " · evictable"}`;
    }
  } catch { /* storage estimate is not available everywhere */ }

  // Network: the same trailing-window rate the ETA uses, so the two agree.
  const bps = currentBps();
  const active = netActive;
  monEl("monNet").textContent = active && Number.isFinite(bps) ? fmtRate(bps) : "idle";
  // 12.5 MB/s is a fast domestic link; the bar is a feel, not a limit.
  setBar("monNetBar", Number.isFinite(bps) ? bps / (12.5 * 2 ** 20) : 0, 2);
  monEl("monNetNote").textContent = active
    ? `${active} stream${active === 1 ? "" : "s"} downloading`
    : "nothing downloading";

  const running = files.filter((f) => f.status === "running").length;
  monEl("monPool").textContent = `${running} / ${rpcs.length}`;
  monEl("monPoolNote").textContent = rpcs.length
    ? `${rpcs.length} worker${rpcs.length === 1 ? "" : "s"}, ${running} profiling`
    : "no workers yet";
}

function setMonitorOpen(open) {
  const mon = document.getElementById("monitor");
  const btn = document.getElementById("monitorToggle");
  if (!mon) return;
  mon.classList.toggle("collapsed", !open);
  btn?.setAttribute("aria-expanded", String(open));
  try { localStorage.setItem("peek-monitor", open ? "1" : "0"); } catch { /* private mode */ }
  clearInterval(monTimer);
  monTimer = null;
  if (open) { refreshMonitor(); monTimer = setInterval(refreshMonitor, MON_MS); }
}

document.getElementById("monitorToggle")?.addEventListener("click", () => {
  setMonitorOpen(document.getElementById("monitor")?.classList.contains("collapsed"));
});
try { if (localStorage.getItem("peek-monitor") === "1") setMonitorOpen(true); } catch { /* ignore */ }

// ---- run all -----------------------------------------------------------------

els.run.addEventListener("click", runAll);
els.cancel.addEventListener("click", () => abortCtrl?.abort());

async function runAll() {
  // Asked here, on a real click, and only if the box is ticked — never on load.
  // The answer is not needed before the run ends, but the PROMPT must come from
  // a user gesture or the browser refuses it outright.
  await wantNotify();
  if (!dbMeta) return;
  // A real run replaces the example — and must, before anything is profiled: the
  // example lends the page the gut lineage map, and a run against another
  // catalogue would take its species names from it.
  clearDemo();
  els.error.textContent = "";
  els.results.classList.add("hide");
  els.progress.classList.remove("hide");
  els.run.disabled = true;
  setDisabled(els.cancel, "");
  setRunControls(true);
  abortCtrl = new AbortController();

  const maxReads = currentReads();
  // "Max reads per sample" may have moved across the 32/64-bit boundary since the
  // database was loaded. A worker cannot swap its wasm package, so this rebuilds
  // the pool and reloads the database before anything is profiled. Doing it here
  // rather than refusing to run keeps the failure out of the middle of a long
  // multi-sample batch.
  //
  // This has to happen BEFORE the reference is frozen: reloading revalidates
  // currentRef against the database the workers actually hold, and may replace
  // it (see revalidateRefAfterReload). Freezing first would stamp the matrix —
  // and every exported file — with a reference the numbers did not come from.
  try {
    await ensureWasmBuildFor(maxReads);
  } catch (e) {
    showError(`Could not switch to the ${plannedBits(maxReads)}-bit wasm build: ${e.message ?? e}. ` +
      `Click "Load database" again.`);
    console.error(e);
    setDisabled(els.cancel, "Cancelling — waiting for the workers to stop.");
    setRunControls(false);
    refreshRunButton();
    return;
  }

  // Frozen now, after any reload: every row of the matrix this run builds comes
  // from this one reference, and the matrix carries it rather than pointing at
  // whatever happens to be loaded when it is exported.
  const runRef = currentRef;

  // Aggregate matrix as we go: { genome_file -> { sampleName -> relAbund } }
  const matrix = {};
  const sampleOrder = [];
  // Whatever functional profile is on screen belongs to the example or to the
  // session that was open, not to the run starting now. Left in place it would
  // sit under the new matrix in the Function tab, labelled with these samples'
  // names — the demo's orthologs presented as yours.
  //
  // Repainted, not merely nulled: clearing the variable while the Function panel
  // is the one on screen leaves the old table and the old figure standing until
  // something else happens to redraw them, which is the same thing seen by a
  // reader.
  funcProfiles = null;
  if (!document.getElementById("funcPanel")?.classList.contains("hide")) refreshFunc();

  // The second sketch, if it was asked for. Loaded HERE — after the pool has
  // settled at its final size and its final wasm build, before the first sample
  // reaches a worker — because a worker spawned later would sketch reads against
  // no reference and return an empty profile that looks like "no functions
  // found" rather than "never measured".
  //
  // Always the 32-bit sourmash, whatever bit-width sylph is running beside it:
  // the two are separate wasm modules with separate memories, 13,509 ortholog
  // sketches need ~39 MB, and matching the build the offline script uses keeps a
  // run in this tab numerically comparable with the bundled example.
  funcWanted = !!els.funcOn?.checked;
  if (funcWanted) {
    setStep("Loading the KEGG ortholog reference (20 MB, once)…");
    try {
      // DOWNLOADED ONCE, HERE, and handed to every worker. Each worker is its own
      // realm, so the module-level memo inside func-sketch.js cannot be shared:
      // `rpcs.map(r => r.loadFuncRefs(url))` issued one fetch per worker — eight
      // concurrent downloads of the same 20 MB file, under a line that says
      // "once". The parse and the 38 MB of WebAssembly are still per worker, and
      // always were; only the download is now what the sentence claims.
      const res = await fetch(FUNC_REF_URL);
      if (!res.ok) throw new Error(`${FUNC_REF_URL} — HTTP ${res.status}`);
      const refBytes = await res.arrayBuffer();
      // Sequentially rather than all at once: the bytes are structured-cloned
      // into each worker, and eight clones of 20 MB in flight together is a
      // spike worth not having for a step that is already off the critical path.
      const infos = [];
      for (const [i, r] of rpcs.entries()) {
        infos.push(await r.loadFuncRefs(
          "./funprofiler-pkg", FUNC_REF_URL,
          // One worker's count is every worker's count; showing the first keeps
          // the line from flickering between N loads.
          i === 0 ? (p) => {
            if (p.progress?.phase === "func_refs") {
              setStep(`Loading the KEGG ortholog reference — ${p.progress.n.toLocaleString()} orthologs…`);
            }
          } : undefined,
          refBytes));
      }
      console.log(`[func] ${infos[0]?.orthologs?.toLocaleString?.() ?? "?"} KEGG orthologs loaded in ${rpcs.length} worker${rpcs.length === 1 ? "" : "s"}`);
    } catch (e) {
      // Not fatal to the run: the taxonomy is what most readers came for, and
      // failing the whole batch over the optional half would be a worse trade
      // than saying so and profiling species anyway.
      funcWanted = false;
      showError(`Functions are off for this run: the KEGG ortholog reference could not be loaded (${e?.message ?? e}). ` +
        `Species profiling continues.`);
      console.error(e);
    }
  } else {
    // The pool outlives a run. A worker that loaded the reference last time
    // would keep sketching this time, unasked, at roughly double the cost.
    await Promise.all(rpcs.map((r) => r.funcOff().catch(() => {})));
  }

  // Pick up already-done samples and replay them into the matrix without
  // re-running. Build the parallel-work queue from the rest.
  const queue = [];
  for (const s of files) {
    if (s.status === "done") {
      sampleOrder.push(s.sampleName);
      mergeRowsIntoMatrix(matrix, s.sampleName, s.rows);
    } else {
      // Back to pending, so the line stops showing the previous attempt's
      // error while it is being retried.
      s.status = "pending";
      s.error = undefined;
      queue.push(s);
    }
  }

  const totalTodo = queue.length;
  let okCount = 0, failCount = 0, cancelCount = 0, shortCount = 0, completed = 0;
  let emptyCount = 0;

  // Each worker independently drains the shared queue. Two workers run end-
  // to-end (decompress + sylph profile) in parallel.
  async function drain(rpc, slotIdx) {
    while (queue.length > 0 && !abortCtrl.signal.aborted) {
      const s = queue.shift();
      if (!s) break;
      s.status = "running";
      s.frac = NaN;   // running, nothing measured yet: indeterminate, not 0%
      const verb = s.origin === "ena" ? "downloading + decompressing" : "decompressing";
      // No trailing "…": the row carries a ring of its own, and two marks for
      // one idea is one too many.
      s.progress = s.kind === "pe" ? `${verb} both mates` : verb;
      renderFilesList();
      // "trimming" was the word here, and it was wrong in a way that mattered:
      // nothing is trimmed. No quality filter, no adapter clipping, not a base
      // removed — the stream stops after the Nth record and everything past it
      // is never read. Nor is it downsampling, which implies a random draw;
      // these are the FIRST N, in file order. The unit is named for the same
      // reason it is named everywhere else: "3,000,000" alone is ambiguous
      // between reads and pairs.
      const capUnit = s.kind === "pe" && !pairsCountAsTwo() ? "pairs" : "reads";
      setStep(`[w${slotIdx}] ${s.sampleName} — ${verb}, first ${fmtReads(maxReads)} ${capUnit}`);

      const t0 = performance.now();
      let wasmTick = null;
      // One more stream on the link, for as long as this sample runs. See
      // noteRate(): a per-stream rate is only a link rate once it is multiplied
      // by the number of streams sharing that link.
      if (s.origin === "ena") netActive++;
      try {
        let tsv, reads, func;
        function startWasmHeartbeat(label, reads) {
          s.frac = 1;
          const wasmT0 = performance.now();
          wasmTick = setInterval(() => {
            const sec = ((performance.now() - wasmT0) / 1000).toFixed(1);
            s.progress = `sketching ${reads.toLocaleString()} ${label} in WASM (${sec} s)`;
            renderFilesList();
            setStep(`[w${slotIdx}] ${s.sampleName} — WASM compute, ${sec} s`);
          }, 250);
        }
        // A download that is cut and resumed must SAY so. Eight minutes of a
        // frozen line is indistinguishable from a hang, and the one thing worse
        // than a slow download is a slow download that looks broken.
        const netRetry = (p) => {
          if (p.phase !== "net_retry") return false;
          s.progress = p.note;
          renderFilesList();
          setStep(`[w${slotIdx}] ${s.sampleName} — ${p.note}`);
          return true;
        };
        // Throughput, from the worker's own trailing-window meter. Also feeds
        // the ETA shown before the next run.
        const rate = (bps) => {
          if (!Number.isFinite(bps) || bps <= 0) return "";
          noteRate(bps);
          return ` · ↓ ${fmtRate(bps)}`;
        };

        // The worker counts pairs, always. If the user asked to read the cap in
        // sequenced reads, halve it here — the one place it crosses over.
        const cap = capFor(s, maxReads);

        if (s.kind === "pe") {
          const r1Files = s.peRuns.map(p => p.r1);
          const r2Files = s.peRuns.map(p => p.r2);
          const total1 = r1Files.reduce((a, f) => a + f.size, 0);
          const total2 = r2Files.reduce((a, f) => a + f.size, 0);
          let p1 = { bytesIn: 0, reads: 0, fi: 0, bps: NaN };
          let p2 = { bytesIn: 0, reads: 0, fi: 0, bps: NaN };
          const onProgress = (p) => {
            if (p.phase === "profile_start") { startWasmHeartbeat("pairs", p.reads); return; }
            if (netRetry(p)) return;
            if (p.mate === 1) p1 = { bytesIn: p.bytesIn, reads: p.reads, fi: p.fi, bps: p.bps };
            else p2 = { bytesIn: p.bytesIn, reads: p.reads, fi: p.fi, bps: p.bps };
            const reads = Math.min(p1.reads, p2.reads);
            s.frac = progressFraction({
              bytesIn: p1.bytesIn + p2.bytesIn, total: total1 + total2, reads, cap,
            });
            // Both mates stream at once, so the rate the user cares about is
            // the sum of the two.
            const bothBps = (Number.isFinite(p1.bps) ? p1.bps : 0) + (Number.isFinite(p2.bps) ? p2.bps : 0);
            s.progress =
              `${reads.toLocaleString()} pairs across ${r1Files.length} run${r1Files.length === 1 ? "" : "s"}; ` +
              `R1 file ${p1.fi + 1}/${r1Files.length} ${fmtBytes(p1.bytesIn)}/${fmtBytes(total1)}, ` +
              `R2 file ${p2.fi + 1}/${r2Files.length} ${fmtBytes(p2.bytesIn)}/${fmtBytes(total2)}` +
              (p.net ? rate(bothBps) : "");
            renderFilesList();
          };
          ({ tsv, reads, func } = s.origin === "ena"
            ? await rpc.profileUrlsPe(r1Files.map(toUrlDesc), r2Files.map(toUrlDesc), cap,
              onProgress, abortCtrl.signal)
            : await rpc.profileFilesPe(r1Files, r2Files, cap, onProgress, abortCtrl.signal));
        } else {
          const seFiles = s.seRuns;
          // NOT named totalBytes: fileSummary() above already uses that name for
          // a local, and reusing it inside the one function that also computes
          // ENA totals is how a "why is this a number" bug gets written.
          const totalSeBytes = seFiles.reduce((a, f) => a + f.size, 0);
          const onProgress = (p) => {
            if (p.phase === "profile_start") { startWasmHeartbeat("reads", p.reads); return; }
            if (netRetry(p)) return;
            s.frac = progressFraction({
              bytesIn: p.bytesIn, total: totalSeBytes, reads: p.reads, cap,
            });
            s.progress =
              `${p.reads.toLocaleString()} reads, file ${p.fi + 1}/${seFiles.length} ` +
              `(${fmtBytes(p.bytesIn)} / ${fmtBytes(totalSeBytes)} total)` +
              (p.net ? rate(p.bps) : "");
            renderFilesList();
          };
          ({ tsv, reads, func } = s.origin === "ena"
            ? await rpc.profileUrls(seFiles.map(toUrlDesc), cap, onProgress, abortCtrl.signal,
                basesCapFor(cap))
            : await rpc.profileFilesMulti(seFiles, cap, onProgress, abortCtrl.signal,
                basesCapFor(cap)));
        }

        const rows = parseTsv(tsv);
        s.reads = Number.isFinite(reads) ? reads : undefined;
        // The end-to-end check. Every other guard watches bytes; this one counts
        // what actually came out of the decompressor and compares it with the
        // number the ENA published for the run. A file truncated upstream, with
        // a Content-Length that matches the truncation, passes every byte check
        // there is and fails only here.
        const verdict = s.origin === "ena"
          ? readCountVerdict({ observed: readsShown(s), expected: s.enaReads, maxReads,
              // Paired runs have two possible readings of the ENA's read_count.
              layout: s.kind === "pe" ? "PAIRED" : "SINGLE" })
          : { ok: true, note: "" };
        // "done" means species came out. Zero is a distinct outcome and gets its
        // own status, so it can be counted apart and coloured apart.
        s.status = !verdict.ok ? "incomplete" : (rows.length === 0 ? "empty" : "done");
        s.error = verdict.ok ? undefined : verdict.note;
        s.detected = rows.length;
        s.ref = runRef;
        s.elapsed = (performance.now() - t0) / 1000;
        s.progress = undefined;
        s.frac = undefined;
        s.rows = rows;
        // sylph's own TSV, kept verbatim for the sylph export: it carries
        // columns this page never parses, and reconstructing them from the
        // matrix would be inventing them.
        s.tsv = tsv;
        // The second sketch, when it was asked for. Accumulated per sample the
        // way the matrix is, so a run that is still going shows the functions of
        // the samples that are done — the same rule the taxonomic table follows.
        if (func?.profile && Object.keys(func.profile).length) {
          funcProfiles = { ...(funcProfiles ?? {}), [s.sampleName]: func.profile };
          s.funcHashes = func.hashes;
        }
        sampleOrder.push(s.sampleName);
        mergeRowsIntoMatrix(matrix, s.sampleName, rows);
        // Show the matrix as it fills, rather than at the end. On a project of
        // 85 runs the end is hours away, and the first few samples are usually
        // enough to tell whether the run is worth waiting for. The download
        // buttons work on what is there — the summary says how much that is.
        lastRaw = { matrix, sampleOrder, ref: runRef,
          refBySample: new Map(files.filter((f) => f.ref).map((f) => [f.sampleName, f.ref])),
          metaBySample: metaStore() };
        lastMatrix = matrixToTable(lastRaw.matrix, lastRaw.sampleOrder, lastRaw.ref, lastRaw.refBySample);
        renderMatrix(viewOf(lastMatrix), { done: completed + 1, total: totalTodo });
        // Same rule for the other tab, and only when it is the one on screen:
        // the functional table is expensive to build (13,509 orthologs rolled up
        // over every sample) and nobody is looking at it.
        if (funcWanted && !document.getElementById("funcPanel")?.classList.contains("hide")) refreshFunc();
        if (!verdict.ok) shortCount++;
        else if (rows.length === 0) emptyCount++;
        else okCount++;
      } catch (e) {
        // Cancelling is not failing. The worker reports an abort as a plain
        // Error("aborted"), so `e.name` is "Error" and the only reliable
        // witness is the signal the user tripped.
        const cancelled = abortCtrl.signal.aborted || e?.name === "AbortError";
        s.status = cancelled ? "cancelled" : "failed";
        s.frac = undefined;
        s.error = cancelled ? "" : (e?.message ?? String(e)).slice(0, 200);
        if (cancelled) cancelCount++; else { failCount++; console.error(e); }
      } finally {
        if (s.origin === "ena") netActive = Math.max(0, netActive - 1);
        if (wasmTick) { clearInterval(wasmTick); wasmTick = null; }
        completed++;
        renderFilesList();
        paintOverall(completed, totalTodo, 0);
      }
    }
  }

  await Promise.all(rpcs.map((rpc, i) => drain(rpc, i + 1)));

  setDisabled(els.cancel, "Nothing is running — this stops a profiling run once one has started.");
  setRunControls(false);
  refreshRunButton();
  if (okCount > 0) {
    lastRaw = { matrix, sampleOrder, ref: runRef,
      refBySample: new Map(files.filter((f) => f.ref).map((f) => [f.sampleName, f.ref])),
      metaBySample: metaStore() };
    lastMatrix = matrixToTable(lastRaw.matrix, lastRaw.sampleOrder, lastRaw.ref, lastRaw.refBySample);
    renderMatrix(viewOf(lastMatrix));
  }
  // Cancelled samples are counted apart from failures: twelve red "failed:
  // aborted" lines after a deliberate click on Cancel is a report of an
  // incident that did not happen.
  const summary = `${okCount} sample${okCount === 1 ? "" : "s"} ok` +
    (shortCount ? `, ${shortCount} incomplete (fewer reads than the ENA lists)` : "") +
    (emptyCount ? `, ${emptyCount} with NO species — check the biome` : "") +
    `, ${failCount} failed` +
    (cancelCount ? `, ${cancelCount} cancelled` : "");
  setStep(`done — ${summary} (pool=${rpcs.length})`);
  notifyDone(summary);
}

function mergeRowsIntoMatrix(matrix, sampleName, rows) {
  for (const r of rows) {
    matrix[r.genome] ??= { species: r.species };
    matrix[r.genome][sampleName] = r.relAbund;
  }
}

// Streaming decompression + trim across one or many input files now lives in
// the worker (see fastq-trim.js and sylph-worker.js). Main thread just ships
// File handles via rpc.profileFilesMulti / profileFilesPe and relays progress.

// ---- TSV parsing + matrix assembly -------------------------------------------

function parseTsv(tsv) {
  const lines = tsv.trim().split("\n");
  if (lines.length < 2) return [];
  const header = lines[0].split("\t");
  const idx = (n) => header.indexOf(n);
  const cGenome = idx("Genome_file");
  const cAbund = idx("Taxonomic_abundance");
  const cAni = idx("Adjusted_ANI");
  const cCov = idx("Eff_cov");
  return lines.slice(1).map(l => {
    const f = l.split("\t");
    const genome = (f[cGenome] || "").split("/").pop();
    return {
      genome,
      species: speciesLabel(genome),
      relAbund: Number(f[cAbund]) || 0,
      ani: Number(f[cAni]) || 0,
      cov: Number(f[cCov]) || 0,
    };
  });
}

// `refBySample` is what each column was ACTUALLY profiled against, which is
// not necessarily `ref`: see the note where s.ref is set.
// GTDB gives the same species name to more than one representative genome —
// "Collinsella sp002232035" is 20 of them in human-gut — and the rank fallbacks
// make it worse: 226 genomes with no species name at all are all "Collinsella
// sp.". A matrix keyed on the name alone therefore has duplicate rows, which
// downstream tools reject outright (CroCoDeEL: "Each species must appear exactly
// once — aggregate the rows and reload").
//
// Aggregating would be WRONG here. Those 226 are distinct unnamed species of the
// genus, not one species seen 226 times; summing them would invent an abundance
// for an organism that does not exist. So the accession is appended instead —
// the row stays one genome, and the label becomes unique.
//
// Decided from the LINEAGE MAP, not from the matrix: which names are ambiguous
// is a property of the reference database, so the same genome gets the same
// label in every export, whatever else the run contained.
// The lineage file, in either shape. Schema 2 carries the higher ranks as
// indices into interned lists; schema 1 (and the bundled db/lineage.json) is a
// flat {genome: "Species name"}. Everything below goes through this, so the two
// are one thing from here on.
const RANK_LABELS = { s: "Species", g: "Genus", f: "Family", o: "Order", c: "Class", p: "Phylum" };
let taxonomy = { species: {}, ranks: {}, taxa: {}, rankKeys: [] };

function normaliseLineage(json) {
  if (json && json.schema === 2) {
    return {
      species: json.species ?? {},
      ranks: json.ranks ?? {},
      taxa: json.taxa ?? {},
      rankKeys: json.rankKeys ?? [],
    };
  }
  // Schema 1: names only, so no rank above species is available and the picker
  // says so rather than offering an aggregation it cannot compute.
  return { species: json ?? {}, ranks: {}, taxa: {}, rankKeys: [] };
}

// The taxon a genome belongs to at `rank`, or "" when the catalogue does not
// place it there. "" is not an error — GTDB genuinely leaves ranks empty.
function taxonAt(genome, rank) {
  if (rank === "s") return taxonomy.species[genome] ?? taxonomy.species[genome.replace(/\.gz$/i, "")] ?? "";
  const i = taxonomy.rankKeys.indexOf(rank);
  if (i < 0) return "";
  const row = taxonomy.taxa[genome] ?? taxonomy.taxa[genome.replace(/\.gz$/i, "")];
  const idx = row?.[i];
  return Number.isInteger(idx) && idx >= 0 ? (taxonomy.ranks[rank]?.[idx] ?? "") : "";
}

const currentRank = () => document.getElementById("rankPick")?.value || "s";

// Re-aggregate what is already on screen. No profiling is redone: the matrix
// holds per-genome abundances and every rank is a different sum of the same
// numbers.
// The PER-GENOME matrix, kept so a rank change can re-sum it. matrixToTable()
// output is already aggregated and cannot be un-aggregated.
let lastRaw = null;

const clusterOn = () => !!document.getElementById("clusterPick")?.checked;

// Similarity ordering, applied to the aggregated table just before it is drawn.
// A view, never the data: the numbers are untouched and the exports keep the
// order the user is looking at, which is the one they will describe.
function viewOf(table) {
  if (!clusterOn() || !table?.rows?.length) return table;
  const t0 = performance.now();
  const out = clusterTable(table);
  const ms = performance.now() - t0;
  const note = document.getElementById("clusterNote");
  if (note) {
    note.textContent = out.clustered.rows
      ? `rows and samples ordered by similarity (${ms.toFixed(0)} ms)`
      // Past the ceiling the samples still cluster — they are few — and the rows
      // stay in abundance order rather than freezing the page after every
      // sample. Said out loud, because an order that means nothing must not
      // look like one that does.
      : `samples ordered by similarity; ${table.rows.length} rows is past the ` +
        `${CLUSTER_MAX_ROWS}-row limit, so rows stay in abundance order`;
  }
  return out;
}

function rerankMatrix() {
  const wrap = document.getElementById("rankPickWrap");
  if (wrap) wrap.classList.toggle("hide", !canAggregate() || !lastRaw);
  if (!lastRaw) return;
  lastMatrix = matrixToTable(lastRaw.matrix, lastRaw.sampleOrder, lastRaw.ref, lastRaw.refBySample);
  renderMatrix(viewOf(lastMatrix));
  // An open figure is drawn from the matrix, so it has to follow it: leaving a
  // species-level pie beside a phylum-level table shows two different runs.
  if (openFig) drawFigure(openFig);
}
document.getElementById("clusterPick")?.addEventListener("change", rerankMatrix);
document.getElementById("funcClusterPick")?.addEventListener("change", () => {
  if (!document.getElementById("funcPanel")?.classList.contains("hide")) refreshFunc();
});

// ---- figures -----------------------------------------------------------------
//
// Drawn on demand from whatever is on screen, so they follow the rank and the
// clustering without knowing about either. Not redrawn on every finished sample:
// a PCoA after each of 85 would be work nobody asked for, and the matrix
// underneath already shows the run filling in.
let openFig = null;
// sample name -> group label, from a CSV the user picks. Never uploaded: it is
// read with FileReader in this tab, like every FASTQ on this page.
let metaGroups = new Map();
const metaGroupOf = (sample) => metaGroups.get(sample) ?? null;

// ---- where the groups come from ----------------------------------------------
//
// There used to be exactly one answer — a two-column CSV — which is a strange
// thing to require of a page whose argument is that you should not have to open
// another program. There are three now, and they all end in `metaGroups`, so the
// ordination and the contrast plot read one map and know nothing about where it
// was filled from:
//
//   "none"     nobody has said anything yet
//   "field:X"  a field of the archive's own metadata, already in the session
//   "custom"   made in the editor, sample by sample
//   "csv"      the file, as before
//
// `customGroups` is kept apart from `metaGroups` so that switching to a metadata
// field and back does not destroy an assignment somebody typed by hand.
let groupSource = "none";
let customGroups = new Map();

// metaOf(), NOT metaStore(): the store is rebuilt from the ENA sample list, which
// is empty for a session or the bundled example — where the archive's metadata
// lives in lastRaw.metaBySample. Reading the store there offered an empty list of
// fields on the one run that has the richest metadata of any.
const metaFieldsFor = (samples) => groupFields(samples ?? [], (s) => metaOf(s) ?? {});

/** Rebuild `metaGroups` from whatever the source currently is. */
function applyGroupSource() {
  const samples = lastMatrix?.samples ?? [];
  if (groupSource === "custom") {
    metaGroups = new Map(customGroups);
  } else if (groupSource.startsWith("field:")) {
    metaGroups = groupsFromField(samples, (s) => metaOf(s) ?? {},
      groupSource.slice("field:".length));
  } else if (groupSource === "none") {
    metaGroups = new Map();
  }
  // "csv" leaves metaGroups exactly as the file set it: the file is the source,
  // and rebuilding it from anything else would be inventing it.
  contrastPair = null;   // the old pair may name groups that no longer exist
  // The reader's ordering goes with it: a sort by q means nothing once the
  // groups it was computed over have changed.
  contrastSort = null;
  // Someone who asked for the variable-rows view because they had no groups, and
  // then made some, asked for the contrast. Leaving the fallback latched would
  // hide the figure they had just done the work for.
  contrastFallback = false;
}

// ---- the contrast figure has to ASK for what it needs -------------------------
//
// It used to substitute. With no groups it drew "most variable rows", which is a
// real answer to a real question — and, under a tab labelled Contrast, an answer
// that looks like the one that was asked for. Nothing said a group was missing
// except a grey clause inside the picture, and the way in was a button marked
// "Edit…" beside a dropdown reading "none".
//
// So it refuses instead, and the refusal carries the actions rather than
// describing them: one click for the best metadata field this run has, one to
// open the editor, and the old view still available by name.
let contrastFallback = false;   // the reader asked for the variable-rows view

const contrastable = (view) =>
  groupList(view?.samples ?? [], metaGroups).filter((g) => g.n >= 2).length >= 2;

function contrastRefusalHtml(view) {
  const samples = view?.samples ?? [];
  const fields = metaFieldsFor(samples);
  const best = fields[0];
  const list = groupList(samples, metaGroups);
  const where = list.length === 0
    ? "This run has none yet."
    : list.length === 1
      ? `This run has one group (${escapeHTML(list[0].name)}), and a contrast needs two.`
      : `This run has ${list.length} groups but only ` +
        `${list.filter((g) => g.n >= 2).length} with two or more samples in it.`;
  return `<div class="fig-refusal">
    <b>A contrast is between two groups of samples</b>
    <span>${where} A group is any label you give to samples that belong together —
      treated and control, before and after, one donor and another.</span>
    <div class="kegg-gate-actions">
      ${best ? `<button type="button" id="contrastByField">Group by ${escapeHTML(best.name)} ` +
        `(${best.values} groups)</button>` : ""}
      <button type="button" id="contrastMakeGroups" class="primary">Make groups\u2026</button>
    </div>
    <span class="kegg-gate-fine">${best
      ? `${escapeHTML(best.name)} is what this run's own archive metadata offers. `
      : `This run carries no metadata to group by, so the groups are yours to name. `}
      <button type="button" class="linky" id="contrastVariable">Or show the most variable
      rows instead</button></span>
  </div>`;
}

/** Wire the refusal's buttons. Called wherever it has just been painted. */
function wireContrastRefusal(root, view) {
  root?.querySelector("#contrastByField")?.addEventListener("click", () => {
    const best = metaFieldsFor(view?.samples ?? [])[0];
    if (!best) return;
    groupSource = `field:${best.name}`;
    applyGroupSource();
    redrawGroupedFigures();
  });
  root?.querySelector("#contrastMakeGroups")?.addEventListener("click", openGroupEditor);
  root?.querySelector("#contrastVariable")?.addEventListener("click", () => {
    contrastFallback = true;
    redrawGroupedFigures();
  });
}

/** Fill both source pickers from what this run can actually offer. */
/**
 * Show only the exports there is something behind.
 *
 * The menu used to be the taxonomic half's, so every entry always applied. It
 * serves the whole card now: the function matrix exists only when functions were
 * profiled, and a groups file only when there are groups. An entry offered and
 * then refused with an error is a worse answer than an entry that is not there.
 */
function syncExportMenu() {
  const funcOn = document.getElementById("funcPanel")?.classList.contains("hide") === false;
  const g = document.getElementById("exportFuncGroup");
  if (g) g.hidden = !funcOn;
  const gr = document.getElementById("exportGroups");
  if (gr) gr.hidden = !metaGroups.size;
}

function paintGroupControls(view) {
  syncExportMenu();
  const samples = view?.samples ?? [];
  const fields = metaFieldsFor(samples);
  const opts = [`<option value="none">none</option>`];
  for (const f of fields) {
    opts.push(`<option value="field:${escapeHTML(f.name)}">by ${escapeHTML(f.name)} ` +
      `(${f.values} group${f.values === 1 ? "" : "s"}${f.missing ? `, ${f.missing} without` : ""})</option>`);
  }
  if (customGroups.size) opts.push(`<option value="custom">made here</option>`);
  // Two entries, not one, and the reason is a trap rather than a nicety: a
  // single "from a CSV…" that is BOTH the current state and the way to open the
  // picker cannot be chosen twice — re-selecting the option already selected
  // fires no change event, so a reader who had loaded one file could never load
  // another. So the state is one entry, shown only when it is the state, and the
  // action is a separate one that is always there.
  if (groupSource === "csv") {
    const placed = groupList(samples, metaGroups).reduce((a, g) => a + g.n, 0);
    opts.push(`<option value="csv">from a CSV — ${placed} of ${samples.length} matched</option>`);
  }
  opts.push(`<option value="csv-load">load a CSV…</option>`);
  for (const [wrapId, selId, on] of [
    ["figGroupWrap", "figGroupSource", !funcVisible() && (openFig === "pcoa" || openFig === "contrast")],
    ["funcGroupWrap", "funcGroupSource", funcVisible() && (openFuncFig === "pcoa" || openFuncFig === "contrast")],
  ]) {
    document.getElementById(wrapId)?.classList.toggle("hide", !on);
    // "Make groups…" when there are none, "Edit groups…" once there are: the
    // button that opens the editor is also the sentence that says whether this
    // run has any, and "Edit…" answered neither question.
    const edit = document.getElementById(wrapId.replace("Wrap", "Edit"));
    // THE LABEL, NOT THE BUTTON. `textContent =` on the button threw away the
    // icon the markup carries — every other control in this row has one, and
    // this was the only one that lost it the first time the controls repainted,
    // which is why it looked like it never had one. The span is there to be
    // written into.
    const editLabel = edit?.querySelector(".btn-label") ?? edit;
    if (editLabel) {
      editLabel.textContent = metaGroups.size ? "Edit groups\u2026" : "Make groups\u2026";
    }
    const sel = document.getElementById(selId);
    if (!sel || !on) continue;
    sel.innerHTML = opts.join("");
    sel.value = [...sel.options].some((o) => o.value === groupSource) ? groupSource : "none";
  }
}

for (const id of ["figGroupSource", "funcGroupSource"]) {
  document.getElementById(id)?.addEventListener("change", (e) => {
    if (e.target.value === "csv-load") {
      // The file picker, not a source in itself: the source becomes "csv" only
      // once a file has actually been read, or an abandoned dialog would leave
      // the control claiming a grouping that does not exist.
      e.target.value = groupSource;
      document.getElementById("metaFile")?.click();
      return;
    }
    groupSource = e.target.value;
    applyGroupSource();
    redrawGroupedFigures();
  });
}

for (const id of ["figGroupEdit", "funcGroupEdit"]) {
  document.getElementById(id)?.addEventListener("click", openGroupEditor);
}

/** Both halves may be showing a figure that reads groups. Redraw whichever is. */
function redrawGroupedFigures() {
  if (funcVisible()) refreshFunc(); else drawFigure(openFig);
}

// ---- the editor ---------------------------------------------------------------
//
// A dialog rather than a panel over the plot, and that is the whole design
// decision: clicking a point opens what that sample is made of, and a "click
// samples to group them" mode would take that gesture away for as long as it was
// on. Groups are made here; the points stay what they were.
function openGroupEditor() {
  const dlg = document.getElementById("groupEdit");
  if (!dlg) return;
  const samples = lastMatrix?.samples ?? [];
  // Editing starts from what is on screen, whatever put it there: switching from
  // "by host_sex" into the editor should show those groups to adjust, not an
  // empty table.
  if (!customGroups.size) customGroups = new Map(metaGroups);

  const field = dlg.querySelector("#groupFromField");
  if (field) {
    const fields = metaFieldsFor(samples);
    field.innerHTML = fields.length
      ? fields.map((f) => `<option value="${escapeHTML(f.name)}">${escapeHTML(f.name)} ` +
        `(${f.values} groups)</option>`).join("")
      : `<option value="">nothing to fill from — this run carries no metadata</option>`;
    field.disabled = !fields.length;
    const apply = dlg.querySelector("#groupApplyField");
    if (apply) apply.disabled = !fields.length;
  }

  const paint = () => {
    const list = dlg.querySelector("#groupList");
    if (list) {
      list.innerHTML = samples.map((s, i) => {
        const g = customGroups.get(s) ?? "";
        return `<label class="group-row">
          <span class="group-sample" title="${escapeHTML(s)}">${escapeHTML(s)}</span>
          <input type="text" data-group-for="${escapeHTML(s)}" value="${escapeHTML(g)}"
                 list="groupNames" placeholder="—" aria-label="Group for ${escapeHTML(s)}">
        </label>`;
      }).join("") +
        `<datalist id="groupNames">${groupList(samples, customGroups)
          .map((g) => `<option value="${escapeHTML(g.name)}"></option>`).join("")}</datalist>`;
    }
    const note = dlg.querySelector("#groupEditNote");
    if (note) note.textContent = groupSummary(samples, customGroups);
  };
  paint();

  // One listener on the container rather than one per row: the rows are redrawn
  // whenever the summary changes, and per-row listeners would be re-attached to
  // elements that had just been replaced.
  const list = dlg.querySelector("#groupList");
  if (list && !list.dataset.wired) {
    list.dataset.wired = "1";
    list.addEventListener("input", (e) => {
      const name = e.target?.dataset?.groupFor;
      if (!name) return;
      customGroups = assignGroup(customGroups, name, e.target.value);
      groupSource = "custom";
      const note = dlg.querySelector("#groupEditNote");
      if (note) note.textContent = groupSummary(lastMatrix?.samples ?? [], customGroups);
      applyGroupSource();
      redrawGroupedFigures();
    });
  }
  // ASSIGNED, not added: openGroupEditor runs on every opening, and
  // addEventListener would stack a handler per opening. `once: true` was the
  // first attempt at that and traded one bug for a worse one — the listener
  // removed itself after the first click, so applying a second field, or
  // clearing after applying, did nothing at all and looked like a dead button.
  const saveBtn = dlg.querySelector("#groupSave");
  if (saveBtn) saveBtn.onclick = () => {
    // The editor's own map, not metaGroups: a reader who has just typed eight
    // names and not yet closed the dialog means those, and metaGroups is only
    // caught up once the source is applied.
    const list = lastMatrix?.samples ?? [];
    saveBlob(groupsCsvFrom(list, customGroups), "text/csv",
      `peekmicrobiome-groups-${refSlug(lastMatrix?.ref)}.csv`);
  };

  const applyBtn = dlg.querySelector("#groupApplyField");
  if (applyBtn) applyBtn.onclick = () => {
    const f = dlg.querySelector("#groupFromField")?.value;
    if (!f) return;
    customGroups = groupsFromField(lastMatrix?.samples ?? [], (s) => metaOf(s) ?? {}, f);
    groupSource = "custom";
    applyGroupSource();
    paint();
    redrawGroupedFigures();
  };
  const clearBtn = dlg.querySelector("#groupClear");
  if (clearBtn) clearBtn.onclick = () => {
    customGroups = new Map();
    groupSource = "none";
    applyGroupSource();
    paint();
    redrawGroupedFigures();
  };
  dlg.onclose = () => paintGroupControls(lastMatrix ? viewOf(lastMatrix) : null);
  dlg.showModal();
}

document.getElementById("metaFile")?.addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    metaGroups = parseMetadata(await f.text());
    // The file IS the source now, so the picker says so rather than still
    // reading "none" over a plot that has just been coloured.
    groupSource = "csv";
    contrastPair = null;
    const known = lastMatrix?.samples?.filter((s) => metaGroups.has(s)).length ?? 0;
    const note = document.getElementById("figNote");
    if (note) {
      note.textContent = known
        ? `${known} of ${lastMatrix.samples.length} samples matched a group`
        // Names that match nothing are the usual failure — an accession in the
        // file, a file name on screen — and silence would leave the plot
        // stubbornly one colour with no reason given.
        : `no sample name in that file matches this run — the first column must ` +
          `be the sample name as shown here (e.g. ${lastMatrix?.samples?.[0] ?? "ERR…"})`;
    }
    // Redrawn, not closed: loading groups used to make the plot disappear —
    // the one action the caption under the ordination asks for.
    if (openFig === "pcoa") drawFigure("pcoa");
  } catch (err) {
    const note = document.getElementById("figNote");
    if (note) note.textContent = `could not read that file: ${err?.message ?? err}`;
  }
  e.target.value = "";
});

// a rank or clustering change needs: the figure on screen has to follow the
// matrix under it, and a plain drawFigure(openFig) would read as the tab being
// clicked again and shut it.
// One plain sentence per figure, before the technical one.
//
// The captions under the figures are precise and they are written for someone
// who already knows what a PCoA is; "PCoA" itself is four letters that mean
// nothing to a clinician or a student. This says what the picture is FOR, in
// words that assume nothing, and the existing caption follows with the numbers.
// The contrast's test, computed once per (table, grouping) rather than per
// redraw. It is EXACT — 4,307 orthologs take 470 ms — and it depends on the rows
// and on who is in which group, on neither the width of the card nor the top-N.
// Dragging the slider recomputed all of it on every tick, for numbers that could
// not have changed.
//
// Keyed on what the answer actually depends on, and holding ONE entry: the
// reader is looking at one table at a time, and a cache that grows with every
// grain and grouping they try is a leak with extra steps.
let statsCache = { key: "", stats: null };

function contrastStatsFor(t, tag) {
  const groups = [...metaGroups.entries()].sort().map(([k, v]) => `${k}=${v}`).join(",");
  const key = [tag, t.samples.join("|"), t.rows.length, groups,
    (contrastPair ?? []).join(">")].join("::");
  if (statsCache.key === key) return statsCache.stats;
  const stats = contrastStats(t, { groupOf: metaGroupOf, pair: contrastPair });
  statsCache = { key, stats };
  return stats;
}

const FIG_PLAIN = {
  composition: "What each sample is made of, as a bar.",
  alpha: "How many different things are in each sample, and how evenly.",
  pcoa: "Samples that look alike sit close together. Distance is the whole message; the axes have no units.",
  contrast: "Which rows differ most between two groups of samples.",
  enterotype: "Where each sample sits between the three ways a gut community is usually dominated.",
};

function drawFigure(kind) {
  const canvas = document.getElementById("figCanvas");
  const note = document.getElementById("figNote");
  const dl = document.getElementById("figDownload");
  if (!canvas) return;
  // NOT a toggle any more. Clicking the tab that was already on used to blank
  // the figure — the figures being "an aside, not a mode" — and it is a trap:
  // the tab still looks selected, the area under it is empty, and nothing says
  // why. It caught three separate test runs of this page's own bench before it
  // was reported, which is about as clear a signal as a control can give.
  //
  // A tab bar is a radio group: one is always on, and clicking the one that is
  // on does nothing. Closing is still possible and still useful — there is a ✕
  // beside the figure for it. The `toggle` option every caller had to remember
  // to pass is gone with the trap it existed to avoid.
  if (!kind || !lastMatrix?.rows?.length) {
    openFig = null;
    canvas.classList.add("hide");
    canvas.innerHTML = "";
    dl?.classList.add("hide");
    document.getElementById("figClose")?.classList.add("hide");
    pickedSample = null;
    pcoaZoom = null;
    paintZoomControls();
    paintTopN();
    // openFig is null now, so this hides both pickers rather than leaving one
    // floating over a closed figure.
    paintContrastControls(null);
    paintGroupControls(null);
    hideDetail();
    if (note) note.textContent = "";
    for (const b of document.querySelectorAll(".fig-tab")) b.classList.remove("is-on");
    return;
  }
  const view = viewOf(lastMatrix);
  // A sample that no longer exists cannot stay open — a session reloaded, a run
  // restarted. Checked before the panel is painted, since the panel is what the
  // figure is measured against.
  if (pickedSample && !view.samples.includes(pickedSample)) closePie();
  // The card is sized by the stylesheet — half the row, always, whether a sample
  // is open or not — and the figure is then drawn to fit it exactly. Both halves
  // of that matter:
  //   · drawn to fit, so no figure has empty card beside it and none is scaled
  //     down by the browser, which takes its type with it;
  //   · always half, so clicking a point does not resize the plot under the
  //     pointer that clicked it. The panel was appearing and taking 600 px off
  //     the figure at the exact moment the figure was being used.
  canvas.classList.remove("hide");
  // Measure an EMPTY card. The panel beside it is what the row is sized by —
  // both cards stretch to it — so with the old figure cleared out, the card's
  // own box is exactly the room the new one has, in both directions. Drawn to
  // that, every figure is the same size as every other and the same size as the
  // panel, instead of leaving a band of empty card under a short one.
  canvas.innerHTML = "";
  if (pickedSample) showPie(view, pickedSample); else showDetailPrompt();
  const w = Math.max(320, Math.floor(canvas.clientWidth - 20));
  const h = Math.max(300, Math.floor(canvas.clientHeight - 20));
  figView = view;
  // The one figure that can refuse. A card saying why, in the card the figure
  // would have been in — and Download SVG stays hidden, because a downloadable
  // picture of the word "no" is not a figure.
  const refusal = kind === "enterotype" ? enterotypeRefusal(view) : "";
  // The contrast's refusal is not a sentence: it carries the two actions that
  // resolve it, so it is built as markup rather than passed through the plain
  // "Not this run" card below.
  const needsGroups = kind === "contrast" && !contrastable(view) && !contrastFallback;
  const svg = (refusal || needsGroups) ? ""
    : kind === "composition" ? compositionSvg(view, { width: w, height: h, topN: figTopN })
    : kind === "alpha" ? alphaSvg(view, { width: w, height: h })
    // The groups the reader loaded, and only those. NOT the computed clusters:
    // the clusters come out of these same abundances, so contrasting two of them
    // would rank rows by the thing that defined the split and hand back the
    // input as a finding.
    : kind === "contrast"
      ? contrastSvg(view, { width: w, height: h, topN: figTopN, groupOf: metaGroupOf,
        // scale 1: the taxonomic matrix already holds percentages. The functional
        // tables hold fractions and pass 100 — the same split paintMatrix carries.
        unit: "taxa", pair: contrastPair, scale: 1, sort: contrastSort,
        stats: contrastStatsFor(view, `taxo:${currentRank()}`) })
    : kind === "enterotype"
      ? enterotypeSvg(genusTable(), { width: w, height: h, groupOf: metaGroupOf })
      : ordinationSvg(view, w, h);
  canvas.innerHTML = needsGroups
    ? contrastRefusalHtml(view)
    : refusal
      ? `<div class="fig-refusal"><b>Not this run</b><span>${escapeHTML(refusal)}</span></div>`
      : svg;
  if (needsGroups) wireContrastRefusal(canvas, view);
  // A downloadable picture of a question is not a figure.
  dl?.classList.toggle("hide", !!refusal || needsGroups);
  document.getElementById("figClose")?.classList.remove("hide");
  openFig = kind;
  paintZoomControls();
  paintTopN();
  paintContrastControls(view);
  paintGroupControls(view);
  for (const b of document.querySelectorAll(".fig-tab")) {
    b.classList.toggle("is-on", b.dataset.fig === kind);
  }
  wireFigure(canvas, view);
  // Every figure is relative to one catalogue and to nothing else. Said here
  // too, because a figure is the thing that gets pasted into a slide with no
  // page around it.
  if (note) {
    note.textContent = `${FIG_PLAIN[kind] ?? ""} ` +
      `${view.rows.length} ${RANK_LABELS[currentRank()].toLowerCase()}` +
      `${view.rows.length === 1 ? "" : currentRank() === "s" ? "" : ""} × ${view.samples.length} samples, ` +
      `against ${refShort(view.ref) || "the loaded catalogue"}` +
      (kind === "pcoa" ? " · hover a point to name it, click it for that sample · scroll over the plot to zoom, drag to pan"
        : kind === "enterotype" ? " · at genus rank, whatever the picker says · click a point for the genera behind it"
        // The method is IN the figure, in the line under its title, where it
        // travels with the picture. Saying it again here — at greater length —
        // was the page explaining itself twice to the same reader.
        : kind === "contrast" ? " · click a dot for that sample"
        : " · click a sample for what it is made of") +
      // Only where it is the whole story. On the contrast with no groups the
      // card in the canvas already says this, at length and with the buttons
      // that fix it, so repeating it in the caption is the page telling the
      // reader twice and pointing "beside the figure" at something that is now
      // IN the figure.
      (kind === "pcoa" && !metaGroups.size
        ? " · no groups yet — pick a source or make them, beside the figure" : "");
  }
}

for (const b of document.querySelectorAll(".fig-tab")) {
  b.addEventListener("click", () => drawFigure(b.dataset.fig));
}
document.getElementById("figClose")?.addEventListener("click", () => drawFigure(null));
document.getElementById("funcFigClose")?.addEventListener("click", () => {
  openFuncFig = null;
  refreshFunc();
});


// ---- how many taxa are named -------------------------------------------------
//
// Ten was a constant in two figures, and ten is not the right number for every
// run: a gut sample where Prevotella is 60% of everything is described by three,
// and a soil profile with no dominant taxon needs twenty before the bars stop
// being mostly grey. The rest are never dropped — they stay as "other taxa" —
// so this changes how much of a profile is NAMED, never how much is counted.
//
// Kept for the session, across figures and redraws: someone who has decided
// they want fifteen has decided it for the run, not for one click.
//
// ONE PER HALF, and not one shared. They were tied together on the argument that
// a reader decides a number "for the run" — but a run has two tables of very
// different shapes, and the number that suits one does not suit the other: ten
// species is a legible bar and thirty pathways is still legible, because 468
// species have a long tail and 102 pathways do not. Tying them made choosing
// thirty on one side quietly rewrite the other.
let figTopN = 10;
let funcTopNValue = 10;
let topNFrame = 0;
const topNFor = (func) => (func ? funcTopNValue : figTopN);

// The two figures that NAME rows one by one — the composition bars and the
// contrast lanes — plus the pie of an open sample. The ordination and the
// diversity chart name none, and a slider that does nothing is worse than one
// that is not there.
const NAMES_ROWS = new Set(["composition", "contrast"]);

function paintTopN() {
  document.getElementById("figTopN")
    ?.classList.toggle("hide", !(NAMES_ROWS.has(openFig) || (openFig && pickedSample)));
  // The functional half asks the same question of its own figures.
  const funcOn = !document.getElementById("funcPanel")?.classList.contains("hide") &&
    (NAMES_ROWS.has(openFuncFig) || pickedSample);
  document.getElementById("funcTopN")?.classList.toggle("hide", !funcOn);
}

/** Each slider shows its own half's number. */
function syncTopN() {
  for (const [range, out, v] of [["figTopNRange", "figTopNOut", figTopN],
                                 ["funcTopNRange", "funcTopNOut", funcTopNValue]]) {
    const r = document.getElementById(range), o = document.getElementById(out);
    if (r) r.value = String(v);
    if (o) o.textContent = String(v);
  }
}

for (const id of ["figTopNRange", "funcTopNRange"]) {
document.getElementById(id)?.addEventListener("input", (e) => {
  const n = Math.max(1, Number(e.target.value) || 10);
  if (id === "funcTopNRange") funcTopNValue = n; else figTopN = n;
  syncTopN();
  // A drag fires this by the pixel and each one redraws a figure over every row
  // of the matrix. Coalesced, so the value the drag ends on is the one drawn —
  // on a timer rather than an animation frame, which a tab in the background
  // never runs, leaving the figure showing a number the slider no longer says.
  clearTimeout(topNFrame);
  topNFrame = setTimeout(() => {
    // Whichever half is on screen — and only that one, since each keeps its own
    // number now.
    if (funcVisible()) { if (openFuncFig) drawFuncFigure(openFuncFig); }
    else if (openFig) drawFigure(openFig);
  }, 60);
});
}

// ---- enterotypes ---------------------------------------------------------------
//
// The one figure that is not drawable from any run. Everything else here works
// on whatever was profiled against whatever catalogue; the poles of an
// enterotype are three named genera of the adult human gut, so the page has to
// know it is looking at one — and every obvious way of asking that question is
// broken, each for a measured reason.
const HUMAN_GUT_GENOMES = 4744;

function enterotypeRefusal(view) {
  const ref = view?.ref;
  if (view?.mixed) {
    return "This session mixes two reference databases. A marker share is a share " +
      "of one catalogue, so there is nothing here to divide.";
  }
  if (!ref || ref.local) {
    return "These are shares of a profile made against a database whose contents this " +
      "page does not know. Load a named catalogue to draw this.";
  }
  // `ref.key`, and never `ref.catalogue`: catalogueName() makes that
  // "MGnify human-gut v2.0.2", so `ref.catalogue === "human-gut"` is false for
  // every biome there is, human gut included. It would not be a gate, it would
  // be an off switch nobody noticed.
  if (ref.key !== "human-gut") {
    return `Enterotypes are described for adult human stool. This run is against ` +
      `${refShort(ref) || "another catalogue"}. Composition, Diversity and PCoA work on any run.`;
  }
  // The smoke-test database declares catalogue "human-gut", version "v2.0.2"
  // and the SAME lineage file — with 50 genomes of the 4,744. A catalogue check
  // and a version check both wave it through; the genome count is what separates
  // them. It also pins the build: GTDB renames genera between releases, and the
  // pole names above were verified against this one.
  if (Number(ref.genomes) !== HUMAN_GUT_GENOMES) {
    return `The marker genera were checked against MGnify human-gut v2.0.2 ` +
      `(${HUMAN_GUT_GENOMES.toLocaleString("en-US")} genomes); this database holds ` +
      `${Number(ref.genomes).toLocaleString("en-US")}. Genus names move between GTDB ` +
      `releases, so the poles have to be re-checked before this can be drawn.`;
  }
  if (!canAggregate()) {
    return "This session was saved at species level and its database is not loaded, so " +
      "genus names are unavailable. Load the catalogue to draw this.";
  }
  return "";
}

// ---- functions ---------------------------------------------------------------
//
// Functions here are MEASURED, not inferred from the taxa. The alternative was
// tempting and much cheaper — multiply the abundance of each reference genome by
// the functions that genome is annotated with — but that profile is a
// deterministic function of the species profile: two samples with the same taxa
// necessarily get the same functions, so "same organisms, different capability"
// is unrepresentable, and it is exactly the question a functional view is asked.
// So the reads are sketched a second time, in amino-acid k-mers, against KEGG
// orthologs.
//
// Which means a result profiled before this existed carries none, and neither
// does a session saved then. The tab refuses with the reason, as the enterotype
// tab does, rather than drawing an empty chart.
let funcProfiles = null;    // sample -> { K01952: 0.0184, ... }
// True while a run that asked for functions is going. Read by the Function
// tab's refusal, so a run in progress says "still measuring" rather than the
// "this page does not measure functions" sentence that predates the wiring.
let funcWanted = false;
// 13,509 KEGG ortholog sketches at k=11, from Zenodo 10045253 (CC BY 4.0).
// See web/db/kegg/README.md for what it is and where it came from.
const FUNC_REF_URL = "./db/kegg/ko-sketches-k11.ndjson.gz";
let keggMap = null;         // web/db/kegg/ko-map.json, fetched once, on demand
let funcGrain = "pathway";

async function loadKeggMap() {
  if (keggMap) return keggMap;
  try {
    const res = await fetch(`./db/kegg/ko-map.json?v=${WORKER_VERSION}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    keggMap = await res.json();
  } catch (e) {
    // Names are a convenience; the identifiers are the measurement. Without the
    // map the KO level still works, and the roll-ups say why they cannot.
    keggMap = { ko: {}, koModules: {}, modules: {}, pathways: {}, missing: String(e.message || e) };
  }
  return keggMap;
}

// ---- KEGG is not a public database -------------------------------------------
//
// Its own terms say so in those words. Academic users may use KEGG freely;
// non-academic use requires a commercial licence from Pathway Solutions. Every
// identifier, name and roll-up this tab shows is KEGG's, so the tab asks once
// which of those the reader is, and remembers the answer.
//
// The answer is kept in localStorage and goes nowhere — the page has no server
// to send it to, which is the whole argument of the rest of it. It is an
// acknowledgement, not a check: nothing here can verify who anyone is, and
// pretending otherwise would be theatre. What it can do is make sure nobody
// reads KEGG data here without having been told the terms.
// ---- Gut Metabolic Modules ---------------------------------------------------
//
// The definitions are NOT shipped. VIB licenses them for academic,
// non-commercial use and forbids transferring them outside the licensee's
// institution, so committing them to a public repository that deploys to a
// public site is the one thing the licence names. The reader brings their own
// copy from github.com/raeslab/GMMs; it is read in this tab, like the groups
// CSV, and not kept when the tab closes — which is also why the page does not
// fetch it for them: the privacy notice promises that Zenodo and the EBI are the
// only hosts contacted, and quietly adding a third would make that false.
let gmmDefs = null;          // { modules, kos } — this session only
let gmmName = "";            // where the definitions came from, so the version is named
let gmmFetchError = "";      // why the automatic fetch failed, if it did

const GMM_CONSENT_KEY = "peek-gmm-use";
function gmmConsent() {
  try { return localStorage.getItem(GMM_CONSENT_KEY) || ""; } catch { return ""; }
}
// 8 KB from the Raes lab's own repository, and NOT from this one.
//
// The distinction is the whole licence question. VIB licenses these definitions
// for use inside one institution and forbids passing them on, so this project
// ships none of them and never will. Fetching them, on the reader's instruction,
// from the address their authors publish them at is a different act: the bytes
// go from the Raes lab to the reader, and nothing of theirs sits on our server
// or in our repository.
//
// Asking the reader to download a file by hand and open it with a picker was the
// cautious reading of that, and it was too cautious: it turned a licence
// question into a chore, which is how a feature gets abandoned rather than
// respected. The question is still asked first and answered — and then the page
// fetches, exactly as it fetches KEGG's ortholog map once that gate is answered.
const GMM_URL = "https://raw.githubusercontent.com/raeslab/GMMs/master/GMMs.v1.07.txt";
// How long the fetch above is given before the panel gives up and offers the
// file picker instead. Long for an 8 KB file, short enough that nobody waits
// twice — and the message quotes this number rather than repeating it, so the
// two cannot drift apart.
const GMM_TIMEOUT_MS = 20_000;
let gmmLoading = null;

function setGmmConsent(v) {
  try { localStorage.setItem(GMM_CONSENT_KEY, v); } catch { /* private mode: ask again */ }
  // The answer is what unlocks the fetch, so the fetch follows the answer rather
  // than a second click on a second panel.
  loadGmmDefs().then(refreshFunc);
  refreshFunc();
}

/**
 * The definitions, fetched once per page load. Never written to disk: they live
 * in this tab and go with it, which is what "not passed on" means for a page.
 *
 * Resolves either way — a failure leaves `gmmDefs` null and the panel falls back
 * to the file picker, which is the path that needs no network at all.
 */
function loadGmmDefs() {
  if (gmmDefs) return Promise.resolve(gmmDefs);
  if (gmmLoading) return gmmLoading;
  gmmLoading = (async () => {
    try {
      // A DEADLINE, because the screen that precedes this one says "Fetching…"
      // and has no other exit. A fetch that never settles — a captive portal, a
      // proxy that accepts the connection and then holds it — leaves that
      // sentence on screen for ever, and the reader has no way to reach the
      // file picker that needs no network at all. Twenty seconds is long for an
      // 8 KB file and short enough that nobody waits twice.
      const ctl = new AbortController();
      const deadline = setTimeout(() => ctl.abort(), GMM_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(GMM_URL, { cache: "no-store", signal: ctl.signal });
      } finally {
        clearTimeout(deadline);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseGmms(await res.text());
      if (!parsed.modules.length) throw new Error("no modules in what came back");
      gmmDefs = parsed;
      gmmName = "GMMs.v1.07.txt — raeslab/GMMs";
    } catch (e) {
      // Not an error banner: the reader has done nothing wrong, and there is a
      // way through that needs no network. gmmLoadHtml() says both.
      gmmDefs = null;
      gmmName = "";
      // The code alone is not an answer. 429 is the one a reader will actually
      // meet — raw.githubusercontent.com rate-limits by network, so a shared
      // institutional address hits it without anybody here doing anything — and
      // it is the one where "Try again" is the wrong advice.
      gmmFetchError = e?.name === "AbortError"
        ? `nothing after ${Math.round(GMM_TIMEOUT_MS / 1000)} seconds`
        : /HTTP 429/.test(String(e?.message ?? e))
          ? "HTTP 429, too many requests — GitHub rate-limits by network address, " +
            "so this is usually a shared connection rather than anything you did. " +
            "It clears on its own; opening the file yourself does not wait"
          : String(e?.message ?? e);
      console.warn(`[gmm] ${GMM_URL}: ${gmmFetchError}`);
    }
    gmmLoading = null;
    return gmmDefs;
  })();
  return gmmLoading;
}

function gmmGateHtml() {
  return `<div class="fig-refusal kegg-gate">
    <b>These definitions are licensed by VIB</b>
    <span>Gut Metabolic Modules are curated by the Raes lab and distributed under VIB's
      <a href="https://github.com/raeslab/GMMs/blob/master/LICENSE" target="_blank" rel="noopener">Academic
      Non-commercial Software License</a>: free for academic, non-commercial use; any other use needs a
      licence from VIB. This page ships none of them — answering fetches them from
      <a href="https://github.com/raeslab/GMMs" target="_blank" rel="noopener">the Raes lab's own
      repository</a> into this tab, where they stay.</span>
    <div class="kegg-gate-actions">
      <button type="button" id="gmmAcademic">I am an academic user</button>
      <button type="button" id="gmmPermitted">I have a licence from VIB</button>
    </div>
    <span class="kegg-gate-fine">Kept in this browser. Change it under Settings.</span>
  </div>`;
}

/** The panel shown once the terms are answered and before a file has arrived. */
/**
 * Only reached when the automatic fetch could not deliver — offline, a corporate
 * proxy, the file renamed upstream. The manual path is kept for exactly that: it
 * needs no network, and a licence the reader holds should not be defeated by a
 * firewall.
 */
function gmmLoadHtml() {
  return `<div class="fig-refusal">
    <b>Could not fetch the GMM definitions</b>
    <span>${gmmFetchError
      ? `<code>raw.githubusercontent.com</code> answered ${escapeHTML(gmmFetchError)}. `
      : ""}Download <code>GMMs.v1.07.txt</code> from
      <a href="https://github.com/raeslab/GMMs" target="_blank" rel="noopener">github.com/raeslab/GMMs</a>
      and open it here instead. It is read in this tab and goes nowhere — the same as the groups CSV —
      and it is not stored, so it has to be opened again in a new tab.</span>
    <div class="kegg-gate-actions">
      <button type="button" id="gmmRetry">Try again</button>
      <button type="button" id="gmmPick">Open GMMs.v1.07.txt…</button>
    </div>
    <span class="kegg-gate-fine">103 modules over 442 orthologs, curated for the human gut by
      Vieira-Silva <i>et al.</i>, <i>Nat Microbiol</i> <b>1</b>, 16088 (2016).</span>
  </div>`;
}

// The question, the key and the wording all live in kegg.js, so the single-sample
// page asks exactly the same thing and one answer covers both. What stays here is
// what happens AFTER the answer, which is this page's business.
function setKeggConsent(v) {
  storeKeggConsent(v);
  // The gate is the whole Function panel, not a figure inside it: answering has
  // to put the panel on screen, and the panel needs the map the reader has just
  // agreed to be shown.
  loadKeggMap().then(refreshFunc);
}

function functionRefusal(view) {
  if (!funcProfiles || !Object.keys(funcProfiles).length) {
    // Three different situations, three different sentences. Telling someone who
    // has functions running that the page cannot measure them — which is what
    // this said before the wiring existed — sends them to look for a problem
    // that is not there.
    if (funcWanted) {
      return "Measuring. Each sample's functional profile appears here as it " +
        "finishes — the amino-acid pass runs alongside the species pass, on the " +
        "same reads.";
    }
    return "Functions were not measured for this run. They are read from the same " +
      "FASTQs a second way — amino-acid k-mers against 13,509 KEGG orthologs " +
      "(fmh-funprofiler) — and that pass is off unless \u201calso profile " +
      "functions\u201d is ticked before the run, because it costs a 20 MB " +
      "reference download and takes about four times as long per sample. The " +
      "bundled example carries one already.";
  }
  const missing = (view?.samples ?? []).filter((s) => !funcProfiles[s]);
  if (missing.length === (view?.samples ?? []).length) {
    return "None of the samples on screen has a functional profile. " +
      "They were profiled without the functional reference.";
  }
  // The GMM level asks its own question before it shows anything, because the
  // definitions carry their own licence — and it asks BEFORE looking for the
  // file, for the same reason the KEGG gate comes before the data check: a
  // reader who has not answered must not be told "no file", which is a different
  // sentence that skips the terms.
  if (funcGrain === "gmm") {
    if (!gmmConsent()) return "gate:gmm";
    // Consent given and nothing in hand: either the fetch is running, or it has
    // been tried and failed. Those are different sentences — one is a wait, the
    // other is a way out.
    if (!gmmDefs) {
      if (gmmLoading) return "fetch:gmm";
      if (!gmmFetchError) { loadGmmDefs().then(refreshFunc); return "fetch:gmm"; }
      return "load:gmm";
    }
  }
  if (keggMap?.missing && funcGrain !== "ko" && funcGrain !== "gmm") {
    return `KEGG's module and pathway map could not be loaded (${keggMap.missing}), ` +
      `so orthologs cannot be rolled up. The Orthologs (KO) level still works.`;
  }
  return "";
}

// The functional table, in the same { samples, rows } shape the taxonomic
// figures take — which is why composition, diversity and the ordination need no
// new plotting code to work on functions.
// ---- what is inside a cell ----------------------------------------------------
//
// "0.88 %" answers how much without answering of what. A KEGG module and a gut
// metabolic module are both SETS of orthologs, and a reader who clicks a cell is
// asking which ones — in this sample, at what abundance. The ortholog level
// needs none of this: a row that IS an ortholog has nothing inside it that its
// own identifier does not already link to. The pathway level opens KEGG's
// drawing of the map instead, which is a better answer than a list.
let cellPopKey = "";

const funcCellDetail = (t, r, c) => {
  if (funcGrain !== "module" && funcGrain !== "gmm") return null;
  return {
    key: `${r.id}:${c}`,
    hint: funcGrain === "gmm"
      ? `${r.id} in ${t.samples[c]} — which of its steps were found`
      : `${r.id} in ${t.samples[c]} — which orthologs it was measured from`,
  };
};

/** The card, built when the cell is actually clicked. */
function cellPopHtml(t, r, c) {
  const sample = t.samples[c];
  const prof = funcProfiles?.[sample] ?? {};
  const pct = (v) => `${(v * 100).toFixed(v * 100 >= 0.01 ? 2 : 4)} %`;

  if (funcGrain === "gmm") {
    // The steps, in the module's own order, each with the alternative that was
    // found — which is why a GMM cell can be empty while its orthologs are
    // present: the module is a PATH, and a missing step breaks it.
    const cov = r.coverage?.[c] ?? 0;
    const steps = (r.steps ?? []).map((step, i) => {
      const found = step.filter((alt) => alt.every((k) => prof[k] > 0));
      const shown = (found.length ? found : step).map((alt) =>
        alt.map((k) => `<code>${escapeHTML(k)}</code>`).join(" + ")).join(" or ");
      return `<li class="${found.length ? "step-on" : "step-off"}">` +
        `<span>step ${i + 1}</span> ${shown}` +
        `<b>${found.length ? "found" : "missing"}</b></li>`;
    }).join("");
    return `<div class="cell-pop-body"><p class="info">` +
      `${(cov * 100).toFixed(0)} % of this module's steps were found in this sample` +
      `${r.values?.[c] > 0 ? "" : " — below the two thirds a value is reported at"}.</p>` +
      `<ul class="cell-pop-list">${steps}</ul></div>`;
  }

  const kos = (r.kos ?? []).slice().sort((a, b) => (prof[b] ?? 0) - (prof[a] ?? 0));
  const koLine = (k) => {
    const url = keggEntryUrl(k);
    const nm = keggMap?.ko && Object.prototype.hasOwnProperty.call(keggMap.ko, k)
      ? keggMap.ko[k] : "";
    return `<li><code>${url
      ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(k)}</a>`
      : escapeHTML(k)}</code> <span>${escapeHTML(nm)}</span>` +
      `<b>${prof[k] > 0 ? pct(prof[k]) : "not in this sample"}</b></li>`;
  };
  // KEGG'S MODULE PAGE CANNOT BE COLOURED — probed, see moduleMapUrl — so the
  // module is offered where it can be: on the pathway map that holds it, with
  // only this module's detected orthologs lit, at this sample's abundances. The
  // link is a link: it is followed on a click, never fetched, and it carries
  // ortholog identifiers, so it is offered rather than opened.
  let mapLine = "";
  if (funcGrain === "module") {
    const detected = kos.map((k) => ({ id: k, value: prof[k] ?? 0 }))
      .filter((k) => k.value > 0)
      .sort((a, b) => b.value - a.value);
    // The same denominator the pathway cells use: the sample's own maximum, so
    // the ramp reads within one sample rather than across the run.
    let max = 0;
    for (const v of Object.values(prof)) if (v > max) max = v;
    const m = detected.length ? moduleMapUrl(r.id, detected, keggMap, { max }) : null;
    const entry = keggEntryUrl(r.id);
    const bits = [];
    if (m) {
      bits.push(`<a href="${escapeHTML(m.url)}" target="_blank" rel="noopener noreferrer">` +
        `see it on ${escapeHTML(m.map)}, coloured by this sample</a>`);
    }
    if (entry) {
      bits.push(`<a href="${escapeHTML(entry)}" target="_blank" rel="noopener noreferrer">` +
        `KEGG's own diagram</a>`);
    }
    if (bits.length) {
      mapLine = `<p class="info cell-pop-links">${bits.join(" · ")}` +
        // Said plainly rather than left to be discovered: KEGG paints pathway
        // maps and not module diagrams, so the second link is the module and the
        // first is where the colour is possible.
        (m ? "" : " — this module is on no pathway map") + `</p>`;
    }
  }

  return `<div class="cell-pop-body"><p class="info">` +
    `${kos.length} ortholog${kos.length === 1 ? "" : "s"} of this module were detected in ` +
    `this run — their abundance in ${escapeHTML(sample)}:</p>` + mapLine +
    `<ul class="cell-pop-list">${kos.map(koLine).join("")}</ul></div>`;
}

function closeCellPop() {
  document.getElementById("cellPop")?.remove();
  cellPopKey = "";
}

function openCellPop(t, r, c, anchorEl) {
  const key = `${funcGrain}:${r.id}:${c}`;
  const already = cellPopKey === key;
  closeCellPop();
  if (already) return;                 // a second click on the same cell closes it
  cellPopKey = key;
  const el = document.createElement("div");
  el.id = "cellPop";
  el.className = "cell-pop";
  el.innerHTML =
    `<div class="cell-pop-head"><strong>${escapeHTML(r.id)}</strong>` +
    `<span>${escapeHTML(r.name ?? "")}</span>` +
    `<span class="cell-pop-sample">${escapeHTML(t.samples[c])}</span>` +
    `<button type="button" class="cell-pop-close" aria-label="Close">\u2715</button></div>` +
    cellPopHtml(t, r, c);
  document.body.appendChild(el);
  const box = anchorEl.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  // Below the cell where there is room, above it otherwise; never off an edge.
  el.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - w - 8))}px`;
  el.style.top = box.bottom + h + 12 < window.innerHeight
    ? `${box.bottom + 6}px` : `${Math.max(8, box.top - h - 6)}px`;
  el.querySelector(".cell-pop-close")?.addEventListener("click", closeCellPop);
}

// One listener for the whole matrix rather than one per cell: the body is
// rebuilt on every redraw, and per-cell listeners would be attached to elements
// that had just been replaced.
document.getElementById("funcBody")?.addEventListener("click", (e) => {
  const btn = e.target.closest?.(".cell-open");
  if (!btn) return;
  const [id, col] = (btn.dataset.cell ?? "").split(":");
  const view = lastMatrix ? viewOf(lastMatrix) : null;
  const t = view ? funcViewOf(funcTableFor(view, funcGrain, { floored: true })) : null;
  const r = t?.rows.find((x) => x.id === id);
  if (r) openCellPop(t, r, Number(col), btn);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCellPop(); });
// Closed on scroll, exactly as the tooltip is: the card is positioned against
// the cell's box at the moment of the click and is `fixed`, so scrolling would
// leave it floating over whatever happened to slide under it, still claiming to
// describe a cell that is no longer there.
window.addEventListener("scroll", closeCellPop, { passive: true, capture: true });
document.addEventListener("click", (e) => {
  if (!document.getElementById("cellPop")) return;
  if (e.target.closest?.("#cellPop, .cell-open")) return;
  closeCellPop();
});

function funcTableFor(view, grain = funcGrain, { floored = false } = {}) {
  const samples = (view?.samples ?? []).filter((s) => funcProfiles?.[s]);
  if (!samples.length) return { samples: [], rows: [] };
  const t = grain === "ko" ? koTable(funcProfiles, samples, keggMap)
    : grain === "module" ? moduleTable(funcProfiles, samples, keggMap)
      : grain === "gmm" ? gmmTable(funcProfiles, samples, gmmDefs)
        : pathwayRollup(funcProfiles, samples, keggMap);
  // `floored` is asked for, never assumed. The MATRIX and its downloads take the
  // floor — that is what it is for, a table a reader can scan — and the figures
  // do not: Shannon and the ordination over a display threshold are answers to a
  // question nobody asked, and richness in particular would just report the
  // threshold back.
  return floored ? floorRows(t, settings.funcMinPct ?? DEFAULT_SETTINGS.funcMinPct) : t;
}


/**
 * The function matrix, as a delimited file that names what it is a matrix of.
 *
 * `sep` is honoured through `csvEscape`, exactly as the taxonomic export does,
 * and NOT by splitting the TSV back apart on tabs and rejoining with commas —
 * which is what this did until a review counted the damage: 436 of the 508 KEGG
 * module names carry a comma, and 1,736 of the 13,476 ortholog names do, so the
 * CSV a reader downloaded had more fields than its own header on most rows. A
 * broken export is worse than none: it opens.
 */
function funcMatrixTsv(view, sep = "\t") {
  const esc = csvEscape(sep);
  // The file is what the table shows — the same rows, in the same order. A
  // download that silently held rows the screen did not, or listed them
  // differently, is two answers to one question.
  const t = funcViewOf(funcTableFor(view, funcGrain, { floored: true }));
  const level = funcGrain === "ko" ? "KEGG orthologs"
    : funcGrain === "module" ? "KEGG modules"
      : funcGrain === "gmm" ? `Gut Metabolic Modules (${gmmName || "your definitions"})`
        : "KEGG pathways";
  // ONE BRANCH PER LEVEL, and the GMM level had none: it fell through to
  // pathwayCoverage and the file went out claiming a KEGG-map figure as its GMM
  // coverage — 22.3% in a header while the panel beside the same table said 5%.
  // The `!keggMap` short-circuit is not shared either: multi.js:3788 exempts the
  // GMM level from the KEGG gate on purpose, so a GMM table renders with no KEGG
  // map at all and would have exported "100.0% reaches a gmm".
  const cov = funcGrain === "ko" ? 1
    : funcGrain === "gmm" ? gmmCoverage(funcProfiles, t.samples, gmmDefs)
      : !keggMap ? 1
        : funcGrain === "module" ? moduleCoverage(funcProfiles, t.samples, keggMap)
          : pathwayCoverage(funcProfiles, t.samples, keggMap);
  const head = [
    `# PeekMicrobiome - functional abundance, ${level}`,
    `# measured from reads with FracMinHash on amino-acid k-mers (k=11), against KEGG orthologs`,
    // Per grain, because only one of the three is a partition. The orthologs are:
    // each is measured once and the column sums to 1. Modules and maps are not —
    // an ortholog in three modules is evidence for all three — so the rows
    // overlap and a reader adding them up gets more than the sample.
    funcGrain === "ko"
      // "summing to 1" is only true of the WHOLE ortholog table. With a floor it
      // is a claim the file contradicts on its own rows, which is the worst kind.
      ? `# values are each ortholog's share of the sample's matched functional signal` +
        (t.hidden ? `, and the rows here do not sum to 1: see the floor below` : `, summing to 1`)
      // A GMM VALUE IS NOT A SHARE. It is the median of the ortholog abundances
      // along the module's best-covered path, so it is not a share of anything
      // and a column must not be added up — measured on the shipped example, a
      // GMM column sums to about 0.019, not to more than 1. The screen says this
      // (multi.js, funcNote); the exported header said the opposite.
      : funcGrain === "gmm"
        ? `# values are the median ortholog abundance along each module's covered path. ` +
          `NOT SHARES: a column does not sum to 1 and adding it up means nothing`
        : `# values are each row's share of the sample's matched functional signal. ROWS OVERLAP: an ` +
          `ortholog in several ${funcGrain === "module" ? "module" : "pathway map"}s counts in each, ` +
          `so a column sums to more than 1`,
    funcGrain === "ko" ? null
      : funcGrain === "gmm"
        ? `# the GMM catalogue covers ${(cov * 100).toFixed(1)}% of the measured signal`
        : `# ${(cov * 100).toFixed(1)}% of the measured signal reaches a ` +
          `${funcGrain === "module" ? "module" : "pathway map"}; the rest has none`,
    // The floor travels with the file. Opened a year later, a table missing
    // three quarters of its rows with nothing saying so is a table nobody can
    // reproduce or trust.
    t.hidden
      ? `# floor: rows are here when at least one sample reaches ${t.floor}% — ` +
        `${t.hidden} row(s) hidden, holding ${(t.carried * 100).toFixed(2)}% of the table`
      : `# floor: none — every row is here`,
    `# exported: ${new Date().toISOString()}`,
  ].filter(Boolean);
  const rows = t.rows.map((r) =>
    // No identifier for the not-on-a-map bucket, exactly as the table on screen
    // shows none: `_none` is this page's own token and the column is headed `id`,
    // every other row of which can be looked up on KEGG.
    [r.id === NO_PATHWAY ? "" : (r.id ?? r.name), r.name,
      ...r.values.map((v) => v.toFixed(6))].map(esc).join(sep));
  return [...head, ["id", "name", ...t.samples].map(esc).join(sep), ...rows].join("\n") + "\n";
}


// The table at genus rank, whatever the picker says, built from the same
// matrixToTable the page uses everywhere else so there is one aggregation and
// not two.
function genusTable() {
  return matrixToTable(lastRaw.matrix, lastRaw.sampleOrder, lastRaw.ref,
    lastRaw.refBySample, { rank: "g" });
}

// What the archive knows about the specimen, which is a different question from
// what the catalogue is. The gate checks the database; this checks the sample,
// and says so when it cannot.
function specimenNote(samples) {
  const seen = new Map();
  for (const s of samples) {
    const v = (metaOf(s) ?? {}).scientific_name;
    if (v) seen.set(v, (seen.get(v) ?? 0) + 1);
  }
  if (!seen.size) {
    return "The catalogue was checked, not the specimen: nothing here says whether these " +
      "FASTQs are human stool.";
  }
  const odd = [...seen].filter(([v]) => !/human gut|gut metagenome/i.test(v));
  if (odd.length) {
    return `The archive calls ${odd.length === seen.size ? "these samples" : "some of these samples"} ` +
      `${odd.map(([v, n]) => `"${v}" (${n})`).join(", ")} — which is not human stool.`;
  }
  return `The archive calls all ${samples.length} of these ${[...seen.keys()].join(", ")}.`;
}

// ---- zooming the ordination --------------------------------------------------
//
// Fifteen samples fit in a card; eighty-five in a gut study do not, and the
// interesting ones are precisely the ones piled on top of each other in the
// middle. Zooming is what makes that pile readable — and it pays twice, because
// the names are printed once few enough points are in the window to have room
// for them, so a cluster that was anonymous dots becomes a labelled cluster.
//
// The window lives here, in the ordination's own units, and the eigenproblem
// does not: the layout is computed once per matrix and every frame of a drag
// reuses it. Panning an 85-sample PCoA would otherwise solve it sixty times a
// second.
// WHICH HALF the ordination on screen belongs to. Only one panel is visible at a
// time, so the zoom, the colouring and the layout cache below are shared rather
// than duplicated — and switching halves changes `viewKey`, which resets the
// window, because a window onto the taxonomic ordination means nothing on the
// functional one.
const funcVisible = () =>
  document.getElementById("funcPanel")?.classList.contains("hide") === false;
const activeFigId = () => (funcVisible() ? "funcCanvas" : "figCanvas");
const activeOpenFig = () => (funcVisible() ? openFuncFig : openFig);

let pcoaZoom = null;      // {x, y, k} or null for the whole thing
let pcoaFit = null;       // {key, layout} — the ordination, cached against redraws
let figView = null;       // the view the open figure was drawn from

const viewKey = (view) =>
  `${view.samples.join("\u0001")}|${view.rows.length}|${view.ref ?? ""}`;

// What the points are coloured by: the groups the user loaded, or clusters this
// page computes. Kept across redraws, like the neighbour metric — someone who
// asked for clusters asked for the session, not for one draw.
let pcoaColour = "groups";
let pcoaClusters = null;   // { key, mode, groupOf, note }

/**
 * Colours from k-means over the ordination's own coordinates.
 *
 * Cached against the layout AND the mode, because it is recomputed on every
 * zoom step and every pan frame otherwise — k-means over eight values of k on
 * eighty-five points, sixty times a second.
 */
function clusterColours(view, mode) {
  const key = `${pcoaFit.key}|${mode}`;
  if (pcoaClusters?.key === key) return pcoaClusters;
  const points = pcoaFit.layout.points;
  const fit = mode === "auto"
    ? autoCluster(points)
    : (() => {
      const k = Math.max(2, Math.min(8, Number(mode) || 2));
      const f = kmeans(points, k);
      return { ...f, score: silhouette(points, f.labels) };
    })();
  const byName = new Map(view.samples.map((s, i) => [s, `cluster ${(fit.labels[i] ?? 0) + 1}`]));
  pcoaClusters = {
    key,
    groupOf: (s) => byName.get(s) ?? null,
    // The score travels with the colours, into the downloaded SVG. k-means
    // always returns clusters; this is what says whether they are separated.
    note: `k-means on these two axes · k=${fit.k}` +
      `${mode === "auto" ? " chosen by silhouette" : ""} · silhouette ${fit.score.toFixed(2)}`,
  };
  return pcoaClusters;
}

function ordinationSvg(view, w, h) {
  const key = viewKey(view);
  if (pcoaFit?.key !== key) {
    // Different data, so a window onto the old data means nothing: a zoom is
    // remembered across a resize or a recolouring and not across a new run.
    pcoaFit = { key, layout: pcoaLayout(view) };
    pcoaZoom = null;
    pcoaClusters = null;
  }
  // Fewer than three samples is not a thing to cluster.
  const clustered = pcoaColour !== "groups" && view.samples.length >= 3
    ? clusterColours(view, pcoaColour) : null;
  return pcoaSvg(view, {
    width: w, height: h, layout: pcoaFit.layout, zoom: pcoaZoom,
    groupOf: clustered ? clustered.groupOf : metaGroupOf,
    legendNote: clustered ? clustered.note : "",
  });
}

for (const id of ["figColour", "funcColour"]) {
  document.getElementById(id)?.addEventListener("change", (e) => {
    pcoaColour = e.target.value;
    // Both selects show the one choice, so the two halves cannot disagree.
    for (const other of ["figColour", "funcColour"]) {
      const el = document.getElementById(other);
      if (el && el.value !== pcoaColour) el.value = pcoaColour;
    }
    if (activeOpenFig() === "pcoa") {
      if (funcVisible()) drawFuncFigure("pcoa"); else drawFigure("pcoa");
    }
  });
}

// Redraw the plot alone, at the size it already has. drawFigure() measures an
// empty card and repaints the panel beside it; neither can happen on every frame
// of a drag, and neither needs to — a zoom changes the window and nothing else.
function redrawPcoa() {
  const canvas = document.getElementById(activeFigId());
  if (!canvas || activeOpenFig() !== "pcoa" || !figView) return;
  const old = canvas.querySelector("svg");
  const w = Number(old?.getAttribute("width")) || Math.max(320, canvas.clientWidth - 20);
  const h = Number(old?.getAttribute("height")) || Math.max(300, canvas.clientHeight - 20);
  canvas.innerHTML = ordinationSvg(figView, w, h);
  wireFigure(canvas, figView, funcVisible() ? FUNC_SURFACE : TAXO_SURFACE);
  paintZoomControls();
}

// Which two groups the contrast is between. Shared by both halves, like the
// top-N: someone who has decided they are comparing M048 with M055 has decided
// it for the run, not for one tab. Null until a run has groups.
let contrastPair = null;
// Which of the contrast's two right-hand columns the reader sorted by, and which
// way. null is the figure's own order: largest difference first, which is what it
// is for. Kept beside the pair because the two are invalidated together.
let contrastSort = null;

/**
 * Fill both pickers from the groups this view actually has, and show them only
 * on the figure that uses them.
 *
 * Re-read every redraw rather than kept in sync by hand: a session can be
 * loaded, a groups CSV replaced, a run cleared, and a picker still offering a
 * group that no longer exists would contrast a name against nothing.
 */
function paintContrastControls(view) {
  const groups = contrastGroups(view ?? { samples: [] }, metaGroupOf);
  // Two groups of at least two samples, or there is nothing to contrast and the
  // figure says so itself rather than through an empty pair of dropdowns.
  const usable = groups.filter((g) => g.n >= 2);
  if (contrastPair && !contrastPair.every((n) => usable.some((g) => g.name === n))) {
    contrastPair = null;
  }
  if (!contrastPair && usable.length >= 2) contrastPair = [usable[0].name, usable[1].name];
  for (const [wrapId, aId, bId, on] of [
    ["figContrastWrap", "figContrastA", "figContrastB", !funcVisible() && openFig === "contrast"],
    ["funcContrastWrap", "funcContrastA", "funcContrastB", funcVisible() && openFuncFig === "contrast"],
  ]) {
    document.getElementById(wrapId)?.classList.toggle("hide", !on || usable.length < 2);
    if (!on) continue;
    for (const [id, pick] of [[aId, 0], [bId, 1]]) {
      const sel = document.getElementById(id);
      if (!sel) continue;
      sel.innerHTML = usable.map((g) =>
        `<option value="${escapeHTML(g.name)}">${escapeHTML(g.name)} (n=${g.n})</option>`).join("");
      if (contrastPair) sel.value = contrastPair[pick];
    }
  }
}

for (const [aId, bId, pick] of [["figContrastA", "figContrastB", 0], ["funcContrastA", "funcContrastB", 1]]) {
  for (const [id, slot] of [[aId, 0], [bId, 1]]) {
    document.getElementById(id)?.addEventListener("change", (e) => {
      if (!contrastPair) return;
      const other = contrastPair[1 - slot];
      // Picking the group that is already on the other side would contrast a
      // group with itself: every difference zero, every row dropped, an empty
      // figure with no explanation. Swap instead, which is what the click meant.
      contrastPair = slot === 0 ? [e.target.value, e.target.value === other ? contrastPair[0] : other]
        : [e.target.value === other ? contrastPair[1] : other, e.target.value];
      if (funcVisible()) refreshFunc(); else drawFigure(openFig);
    });
  }
}

function paintZoomControls() {
  const k = pcoaZoom?.k ?? 1;
  // Both halves, every time: the controls of the half that is NOT on screen have
  // to go away, or leaving the Function tab with its ordination open leaves a
  // zoom readout floating over the taxonomic toolbar.
  for (const [zoomId, colourId, canvasId, on] of [
    ["figZoom", "figColourWrap", "figCanvas", !funcVisible() && openFig === "pcoa"],
    ["funcZoom", "funcColourWrap", "funcCanvas", funcVisible() && openFuncFig === "pcoa"],
  ]) {
    const box = document.getElementById(zoomId);
    box?.classList.toggle("hide", !on);
    document.getElementById(colourId)?.classList.toggle("hide", !on);
    if (box && on) {
      const out = box.querySelector(".fig-zoom-k");
      if (out) out.textContent = `×${k.toFixed(1)}`;
      box.querySelector('[data-zoom="reset"]')?.toggleAttribute("disabled", Math.abs(k - 1) < 0.01);
      box.querySelector('[data-zoom="out"]')?.toggleAttribute("disabled", k <= PCOA_MIN_ZOOM + 1e-9);
    }
    // Only the ordination pans, and only while it is the figure on screen: the
    // zoom survives a trip to the composition tab, and the composition must not
    // come back with a grab cursor and a finger that cannot scroll the page.
    document.getElementById(canvasId)?.classList.toggle("can-pan", on && k > 1.001);
  }
}

/**
 * The mapping the plot published on itself: pixels in, ordination units out.
 *
 * Read off the SVG rather than recomputed here — the padding, the room kept for
 * the labels and the window that survived clamping are the figure's business,
 * and a second copy of them in this file would be a second copy to get wrong.
 */
function plotGeom(svg) {
  const raw = svg?.getAttribute?.("data-plot");
  if (!raw) return null;
  const [x0, x1, y0, y1, L, R, T, B] = raw.split(",").map(Number);
  const rect = svg.getBoundingClientRect();
  const vw = Number(svg.getAttribute("width")), vh = Number(svg.getAttribute("height"));
  if (!(rect.width > 0 && rect.height > 0 && vw > 0 && vh > 0)) return null;
  // The card may be showing the figure scaled — a viewBox unit is not a pixel.
  const ux = vw / rect.width, uy = vh / rect.height;
  const toBox = (cx, cy) => ({ x: (cx - rect.left) * ux, y: (cy - rect.top) * uy });
  return {
    centre: () => ({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }),
    // How far one pixel of drag moves the window, in ordination units.
    perPx: { x: ((x1 - x0) / (R - L)) * ux, y: ((y1 - y0) / (B - T)) * uy },
    over: (cx, cy) => cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom,
    at: (cx, cy) => {
      const v = toBox(cx, cy);
      return {
        x: x0 + ((v.x - L) / (R - L)) * (x1 - x0),
        y: y1 - ((v.y - T) / (B - T)) * (y1 - y0),
      };
    },
  };
}

// Zoom by `factor`, keeping `p` — the point under the pointer, or the middle of
// the window for a button — where it is.
function zoomBy(factor, p = null) {
  // The plot on screen, not the taxonomic one by name — the buttons of the
  // functional half read ×1.0 for ever otherwise, because the geometry is read
  // off an SVG that is not there.
  const canvas = document.getElementById(activeFigId());
  const g = plotGeom(canvas?.querySelector("svg"));
  if (!g) return;
  const k0 = pcoaZoom?.k ?? 1;
  const k1 = Math.min(16, Math.max(PCOA_MIN_ZOOM, k0 * factor));
  if (Math.abs(k1 - k0) < 1e-6) return;
  // Exactly 1 is "the whole thing", which is what no zoom at all means. Below it
  // the window is wider than the data — the way to get the points out from under
  // the legend — and that is a state to keep, not to round away.
  if (Math.abs(k1 - 1) < 0.01) {
    pcoaZoom = null;
  } else {
    const c = g.centre(), at = p ?? c, r = k0 / k1;
    // The classic: the window shrinks about `at`, so whatever was under the
    // pointer stays under it instead of sliding away as the plot grows.
    pcoaZoom = { x: at.x - (at.x - c.x) * r, y: at.y - (at.y - c.y) * r, k: k1 };
  }
  redrawPcoa();
}

// Both canvases carry the same gestures. `el` is the one the listener is on, so
// nothing below has to ask which half it is in — the handlers already gate on
// activeOpenFig(), and a hidden canvas receives no events.
const FIG_CANVASES = ["figCanvas", "funcCanvas"]
  .map((id) => document.getElementById(id)).filter(Boolean);

// The button has no pointer to zoom about, so it uses the sample that is open
// beside the plot if there is one: the middle of the ordination is usually where
// nothing is, and "zoom in" landing on empty space is a worse answer than
// "zoom in on the one I am reading".
function zoomFocus() {
  if (!pickedSample || !pcoaFit || !figView) return null;
  const p = pcoaFit.layout.points[figView.samples.indexOf(pickedSample)];
  return p ? { x: p.x, y: p.y } : null;
}

for (const b of document.querySelectorAll("#figZoom [data-zoom], #funcZoom [data-zoom]")) {
  b.addEventListener("click", () => {
    if (b.dataset.zoom === "reset") { pcoaZoom = null; redrawPcoa(); return; }
    const inward = b.dataset.zoom === "in";
    zoomBy(inward ? 1.6 : 1 / 1.6, inward ? zoomFocus() : null);
  });
}

// Over the plot the wheel zooms, in both directions, between half and sixteen.
// The page gets it back only at the end of the range AND only on a fresh
// gesture.
//
// That second condition is the whole rule. Handing over as soon as the zoom
// cannot move meant one flick of a trackpad zoomed out to the full extent and
// then scrolled the page with what was left of the same flick — two things from
// one gesture, and the second one unasked for. A wheel that has been quiet for a
// quarter of a second is someone starting again; anything faster is the tail of
// the gesture that was already zooming, and it is swallowed.
//
// The plot is still not a hole a scroll disappears into: at the floor, let go
// and scroll again and the page moves.
let wheelAt = 0;
for (const el of FIG_CANVASES) {
el.addEventListener("wheel", (e) => {
  if (activeOpenFig() !== "pcoa") return;
  const g = plotGeom(el.querySelector("svg"));
  if (!g || !g.over(e.clientX, e.clientY)) return;
  // Lines and pages, not just pixels: Firefox reports a wheel in lines.
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  const k = pcoaZoom?.k ?? 1;
  const stuck = dy > 0 ? k <= PCOA_MIN_ZOOM + 1e-9 : k >= 16 - 1e-9;
  const now = e.timeStamp || Date.now();
  const sameGesture = now - wheelAt < 250;
  wheelAt = now;
  if (stuck && !sameGesture) return;      // a new gesture at the end of the range: the page's
  e.preventDefault();
  if (stuck) return;                      // the tail of a gesture that has run out of zoom
  zoomBy(Math.exp(-dy * 0.0018), g.at(e.clientX, e.clientY));
}, { passive: false });
}

// Drag to pan, once there is something outside the window to drag into view. The
// capture is on the card, not on the plot: the plot is replaced by a new one on
// every frame, and a pointer captured by an element that no longer exists stops
// reporting halfway through the gesture.
let figPan = null;
for (const el of FIG_CANVASES) {
el.addEventListener("pointerdown", (e) => {
  if (activeOpenFig() !== "pcoa" || e.button !== 0 || !((pcoaZoom?.k ?? 1) > 1.001)) return;
  if (e.target.closest?.(".pcoa-pt")) return;         // that is a click on a sample
  const g = plotGeom(el.querySelector("svg"));
  if (!g || !g.over(e.clientX, e.clientY)) return;
  figPan = { x: e.clientX, y: e.clientY, from: g.centre(), perPx: g.perPx };
  el.setPointerCapture(e.pointerId);
  el.classList.add("is-panning");
  hideTip();
});
el.addEventListener("pointermove", (e) => {
  if (!figPan) return;
  e.preventDefault();
  // Drag right and the points follow the pointer right, which means the window
  // moves left. Screen y counts downwards and the ordination's y does not.
  pcoaZoom = {
    ...pcoaZoom,
    x: figPan.from.x - (e.clientX - figPan.x) * figPan.perPx.x,
    y: figPan.from.y + (e.clientY - figPan.y) * figPan.perPx.y,
  };
  redrawPcoa();
});
const endPan = (e) => {
  if (!figPan) return;
  figPan = null;
  el.classList.remove("is-panning");
  try { el.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
};
el.addEventListener("pointerup", endPan);
el.addEventListener("pointercancel", endPan);
// Back to every sample. Not on a point: two clicks there are open-then-close.
el.addEventListener("dblclick", (e) => {
  if (activeOpenFig() !== "pcoa" || !pcoaZoom || e.target.closest?.(".pcoa-pt")) return;
  pcoaZoom = null;
  redrawPcoa();
});
}

// ---- the figures, made answerable -------------------------------------------
//
// A point on a PCoA is a sample, and nothing on screen said which one. The SVG
// carries a <title>, but that is a native tooltip: half a second of stillness,
// no highlight, nothing at all under a finger. Hover names the mark under the
// pointer; a click opens what that sample is made of, its diversity, and the
// samples it is really nearest — the questions all three figures raise and none
// of them answers. The same two gestures on all three: a bar of the composition
// and a row of the diversity chart are samples too, and a plot you can ask
// nothing of is a picture.
let pickedSample = null;
let hoverSample = null;

// WHICH HALF a click happened in. Taxonomy and Function ask a point the same
// question — "this sample sits apart; apart in WHAT?" — so they share every line
// of the machinery below and differ only in these five facts. Threaded as an
// argument with the taxonomic surface as the default, so the side that was here
// first is untouched by the side that arrived second.
const TAXO_SURFACE = {
  canvas: "figCanvas", panel: "figDetail",
  unit: "taxa", slug: "composition",
  // The enterotype audit is a statement about gut GENERA. There is no enterotype
  // of an ortholog, and printing one under a functional pie would be the
  // taxonomic panel showing through.
  enterotype: true,
  // What a sample is made of, on this side. The functional surface answers at
  // the ortholog level whatever the matrix picker says, for the reason the
  // diversity figure does: it is the level that is a partition.
  view: () => (lastMatrix ? viewOf(lastMatrix) : null),
};
const FUNC_SURFACE = {
  canvas: "funcCanvas", panel: "funcDetail",
  unit: "orthologs", slug: "functions",
  enterotype: false,
  // TWO tables, because the panel asks two questions of one sample and they do
  // not have the same right answer.
  //
  // `view` — what the NUMBERS are computed on: the orthologs, always. Shannon
  // and the nearest-neighbour distances need each row measured once, and modules
  // and maps overlap.
  //
  // `pie` — what the sample is MADE of, at the level the reader is looking at.
  // Pinned to the orthologs it was 93 % grey "other orthologs (2241)": a
  // functional profile is flat, so no ortholog is 2 % of it, and a pie of ten
  // slices under a tenth of a disc says nothing a reader can use. At the pathway
  // level the same sample is legible. Both are true; they answer different
  // questions, and the panel labels which is which.
  view: () => (lastMatrix ? funcTableFor(viewOf(lastMatrix), "ko") : null),
  pie: () => (lastMatrix ? funcTableFor(viewOf(lastMatrix), funcGrain) : null),
  pieUnit: () => (funcGrain === "ko" ? "orthologs" : funcGrain === "module" ? "modules"
    : funcGrain === "gmm" ? "gut metabolic modules" : "pathways"),
};

const FIG_INK = "#275662";
const sampleSlug = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "sample";

function paintPoint(el) {
  const name = el.getAttribute("data-sample");
  const picked = name === pickedSample, hot = name === hoverSample;
  if (el.classList.contains("sample-row")) {
    // A bar or a diversity row: the strip behind it takes the tint, since the
    // bar itself is the data and must not change colour.
    const hit = el.querySelector(".row-hit");
    if (hit) hit.setAttribute("fill-opacity", picked ? "0.13" : hot ? "0.06" : "0");
    return;
  }
  if (el.classList.contains("contrast-pt")) {
    // Its own sizes: the ordination's 5.5 -> 8 would swallow a contrast lane,
    // where eighteen dots share a row 26 px tall and the marks are 3.2.
    el.setAttribute("r", picked ? "6" : hot ? "5" : "3.2");
    el.setAttribute("stroke", picked ? FIG_INK : el.getAttribute("fill"));
    el.setAttribute("stroke-opacity", "1");
    el.setAttribute("stroke-width", picked ? "2" : hot ? "1.5" : "1");
    el.setAttribute("fill-opacity", picked || hot ? "0.9" : "0.55");
    return;
  }
  el.setAttribute("r", picked || hot ? "8" : "5.5");
  el.setAttribute("stroke", picked ? FIG_INK : "#ffffff");
  el.setAttribute("stroke-width", picked ? "2.5" : hot ? "2" : "1");
}
const repaintPoints = (root) => {
  for (const el of root.querySelectorAll(".pcoa-pt, .contrast-pt, .sample-row")) paintPoint(el);
};

// The point a keyboard-painted tooltip belongs to. A pointer tooltip is hidden
// on scroll — the plot slides out from under it — but a focused one must not be,
// because tabbing to a point is itself what scrolls the page: the tooltip would
// be dismissed by the act of asking for it. It follows its point instead.
let tipAnchor = null;

function showTip(html, e) {
  const tip = document.getElementById("figTip");
  if (!tip) return;
  tip.innerHTML = html;
  tip.classList.remove("hide");
  // Measured only once it is visible; a hidden element has no size, and the
  // tooltip would then always be placed as if it were 0 x 0.
  const r = tip.getBoundingClientRect();
  const x = Math.min(e.clientX + 16, window.innerWidth - r.width - 8);
  const y = Math.min(e.clientY + 16, window.innerHeight - r.height - 8);
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
const hideTip = () => {
  tipAnchor = null;
  document.getElementById("figTip")?.classList.add("hide");
};

// The one line worth having before the click: the dominant row and its share.
// `species` on the taxonomic side, `label` on the functional one — the same
// fallback figures.js uses, and for the same reason.
function topTaxonOf(view, name) {
  const c = view.samples.indexOf(name);
  if (c < 0) return null;
  let best = null, total = 0;
  for (const r of view.rows) {
    const v = r.values[c] || 0;
    if (v <= 0) continue;
    total += v;
    if (!best || v > best.v) best = { label: r.species ?? r.label ?? r.name ?? "", v };
  }
  return best ? { ...best, share: best.v / total } : null;
}

function wireFigure(canvas, view, surface = TAXO_SURFACE) {
  const svg = canvas.querySelector("svg");
  if (!svg) return;
  hoverSample = null;

  // The contrast's two right-hand columns reorder the rows on a click, the same
  // three-state cycle the matrix headers use: descending, ascending, then back
  // to the figure's own order — largest difference first, which is what the
  // figure is for and what a reader must be able to get back to without
  // reloading. The redraw goes through the surface's own refresh so that the
  // functional half re-reads its level and the taxonomic half its rank; calling
  // drawFigure directly here would draw the taxonomic figure over the
  // functional canvas.
  for (const th of svg.querySelectorAll(".contrast-head")) {
    const key = th.dataset.sort;
    const cycle = () => {
      contrastSort = nextSort(contrastSort, key);
      if (surface === FUNC_SURFACE) refreshFunc(); else drawFigure(openFig);
    };
    th.addEventListener("click", cycle);
    // A handle that answers the mouse and not the keyboard is a handle half the
    // readers cannot reach; it carries role="button" and tabindex, so it owes
    // them Enter and Space.
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); cycle(); }
    });
  }

  // `e` may be a real pointer event or a point element — focus has no
  // coordinates, and the tooltip has to go somewhere.
  const paintTip = (name, e) => {
    if (!name) { hideTip(); return; }
    if (!("clientX" in e)) {
      const el = e;
      const r = el.getBoundingClientRect();
      e = { clientX: r.right, clientY: r.bottom };
      tipAnchor = el;
    } else {
      tipAnchor = null;
    }
    const group = metaGroupOf(name);
    const top = topTaxonOf(view, name);
    showTip(
      `<strong>${escapeHTML(name)}</strong>` +
      (group ? `<span class="fig-tip-group">${escapeHTML(group)}</span>` : "") +
      (top ? `<span>${escapeHTML(top.label)} — ${(top.share * 100).toFixed(1)}%</span>` : "") +
      `<span class="fig-tip-hint">${name === pickedSample ? "click to close" : "click for the full composition"}</span>`,
      e);
  };

  // A finger has no hover: it moves the pointer once, on the way to the tap, and
  // never leaves. The tooltip would then stay printed over the plot with nothing
  // to dismiss it — so on touch the tap opens the panel and that is all.
  let touch = false;
  const fromFinger = (e) => e.pointerType === "touch" || e.pointerType === "pen";
  // On pointerdown as well as on move: a stationary tap can produce no
  // pointermove at all, and the click that follows would then be taken for a
  // mouse click and print a tooltip nothing will ever dismiss.
  svg.addEventListener("pointerdown", (e) => { touch = fromFinger(e); });
  svg.addEventListener("pointermove", (e) => {
    touch = fromFinger(e);
    const name = e.target.closest?.(".pcoa-pt, .contrast-pt, .sample-row")?.getAttribute("data-sample") ?? null;
    if (name !== hoverSample) {
      hoverSample = name;
      repaintPoints(svg);
    }
    if (touch) hideTip(); else paintTip(name, e);
  });
  svg.addEventListener("pointerleave", () => {
    hoverSample = null;
    repaintPoints(svg);
    hideTip();
  });
  svg.addEventListener("click", (e) => {
    const name = e.target.closest?.(".pcoa-pt, .contrast-pt, .sample-row")?.getAttribute("data-sample");
    if (!name) return;
    if (name === pickedSample) closePie(surface); else showPie(view, name, surface);
    repaintPoints(svg);
    // The pointer has not moved, so nothing else would redraw the tooltip — and
    // it is still offering "click for the full composition" for the sample that
    // was just opened.
    if (touch) hideTip(); else paintTip(name, e);
  });
  // The same two gestures without a mouse. Focus stands in for hover, Enter and
  // Space for the click — the points carry tabindex only while the plot is
  // small enough for that to be a reasonable number of stops (see pcoaSvg).
  svg.addEventListener("focusin", (e) => {
    const pt = e.target.closest?.(".pcoa-pt, .contrast-pt, .sample-row");
    if (!pt) return;
    hoverSample = pt.getAttribute("data-sample");
    repaintPoints(svg);
    paintTip(hoverSample, pt);
  });
  svg.addEventListener("focusout", () => {
    hoverSample = null;
    repaintPoints(svg);
    hideTip();
  });
  svg.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const name = e.target.closest?.(".pcoa-pt, .contrast-pt, .sample-row")?.getAttribute("data-sample");
    if (!name) return;
    e.preventDefault();   // Space would scroll the page out from under the plot
    if (name === pickedSample) closePie(surface); else showPie(view, name, surface);
    repaintPoints(svg);
    paintTip(name, e.target);
  });

  repaintPoints(svg);
}

function closePie(surface = TAXO_SURFACE) {
  pickedSample = null;
  showDetailPrompt(surface);
  paintTopN();
  const canvas = document.getElementById(surface.canvas);
  if (canvas) repaintPoints(canvas);
}

// The right half while no sample is open. Not blank and not absent: absent is
// what used to make the figure jump when a point was clicked, and blank is a
// question nobody asked. It says what the half is for.
function showDetailPrompt(surface = TAXO_SURFACE) {
  const panel = document.getElementById(surface.panel);
  if (!panel) return;
  panel.innerHTML =
    `<div class="fig-detail-prompt">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ` +
    `stroke-linecap="round" aria-hidden="true">` +
    `<circle cx="12" cy="12" r="9"/><path d="M12 12 12 4"/><path d="M12 12 19 15"/></svg>` +
    `<b>Pick a sample</b>` +
    `<span>Click a point, a bar or a row and this is where it opens: what it is ` +
    `made of, how diverse it is, and which samples it is really nearest.</span>` +
    `</div>`;
  panel.classList.remove("hide");
}

// Closing the figures closes the panel with them — there is nothing left for it
// to be beside.
function hideDetail(surface = TAXO_SURFACE) {
  const panel = document.getElementById(surface.panel);
  if (!panel) return;
  panel.classList.add("hide");
  panel.innerHTML = "";
}

function showPie(view, name, surface = TAXO_SURFACE) {
  const panel = document.getElementById(surface.panel);
  if (!panel) return;
  pickedSample = name;
  const group = metaGroupOf(name);
  panel.innerHTML =
    `<div class="fig-detail-head">` +
    `<strong>${escapeHTML(name)}</strong>` +
    (group ? `<span class="info">${escapeHTML(group)}</span>` : "") +
    `<span class="fig-detail-actions">` +
    `<button type="button" class="pie-download">Download SVG</button>` +
    `<button type="button" class="pie-close" aria-label="Close this sample">✕</button>` +
    `</span></div>` +
    `<div class="fig-detail-body"></div>` +
    factsHtml(view, name, surface);
  panel.classList.remove("hide");
  fitPie(panel, surface.pie ? (surface.pie() ?? view) : view, name, surface);
  paintTopN();
  // WITHIN THE PANEL, never by id. Both halves render this same head, so as soon
  // as a sample is open on each, `pieClose` and `pieDownload` exist twice and
  // getElementById returns the taxonomic one: the functional panel's own ✕ and
  // Download SVG got no listener at all, and the taxonomic ones got a second
  // listener closing over the wrong panel. Measured: 0 downloads from the
  // Function panel's button, and its ✕ did nothing.
  panel.querySelector(".pie-close")?.addEventListener("click", () => {
    closePie(surface);
    hideTip();
  });
  panel.querySelector(".pie-download")?.addEventListener("click", () => {
    const svg = panel.querySelector(".fig-detail-body")?.innerHTML;
    if (svg) saveBlob(svg, "image/svg+xml", `${surface.slug}_${sampleSlug(name)}.svg`);
  });
  for (const b of panel.querySelectorAll("[data-metric]")) {
    b.addEventListener("click", () => {
      neighbourMetric = b.dataset.metric;
      showPie(view, name, surface);
    });
  }
  // A neighbour is a sample: opening it is the same thing as clicking its point.
  for (const b of panel.querySelectorAll("[data-jump]")) {
    b.addEventListener("click", () => {
      showPie(view, b.dataset.jump, surface);
      const canvas = document.getElementById(surface.canvas);
      if (canvas) repaintPoints(canvas);
    });
  }
}

/**
 * Draw the pie into the room the panel has left, once everything else in the
 * panel has taken its own.
 *
 * The panel is a fixed card — the same box as the figure beside it — and the
 * numbers under the pie are as tall as they are: three tiles and four
 * neighbours, more of both on a narrow window where they wrap. What is left over
 * is the pie's, and it is measured rather than guessed. Drawn at a fixed 470 px
 * it left a strip of empty card down one side of a 563 px panel and pushed the
 * neighbour list out of the bottom of it, which is the one part of the panel
 * nobody scrolls to find.
 */
function fitPie(panel, view, name, surface = TAXO_SURFACE) {
  const body = panel.querySelector(".fig-detail-body");
  if (!body) return;
  const foot = panel.querySelector(".pie-facts") ?? body;
  // Measured with the body EMPTY: the bottom of the numbers is then everything
  // above the pie plus everything below it, margins and all, in one number.
  const used = foot.getBoundingClientRect().bottom - panel.getBoundingClientRect().top;
  const padB = parseFloat(getComputedStyle(panel).paddingBottom) || 0;
  const room = Math.floor(panel.clientHeight - used - padB - 4);
  body.innerHTML = pieSvg(view, name, {
    // The half this panel belongs to, not always the taxonomic one: the pie
    // beside the functional figures names pathways, and it should name as many
    // of them as that half's own slider asks for.
    topN: topNFor(surface === FUNC_SURFACE),
    unit: surface.pieUnit ? surface.pieUnit() : surface.unit,
    width: Math.max(240, body.clientWidth),
    // A floor, because a phone-sized panel would otherwise get a pie the size of
    // its own legend; a ceiling, because a stacked card is 600 px tall and a
    // 600 px disc is not more informative than a 400 px one.
    height: Math.max(180, Math.min(440, room)),
  });
  wirePie(body);
}

/**
 * Name a slice under the pointer, at once.
 *
 * The slices carry a `<title>`, which is what a downloaded SVG needs — but in
 * the page a native title is a second's wait and a system tooltip, and the rare
 * taxa are the whole reason this exists: a hundred and ten wedges nobody can
 * read is a hundred and ten wedges nobody can ask about. The page's own tooltip
 * answers on the first pixel, in the page's own type.
 */
function wirePie(body) {
  const svg = body?.querySelector("svg");
  if (!svg) return;
  const name = (e) => e.target?.closest?.(".pie-slice");
  svg.addEventListener("pointermove", (e) => {
    const el = name(e);
    if (!el) { hideTip(); return; }
    // Touch has no hover: a finger would leave the tooltip printed over the disc
    // with nothing to dismiss it, exactly as on the plots.
    if (e.pointerType === "touch" || e.pointerType === "pen") { hideTip(); return; }
    showTip(
      `<strong>${escapeHTML(el.getAttribute("data-taxon") ?? "")}</strong>` +
      `<span>${escapeHTML(el.getAttribute("data-share") ?? "")} of this sample</span>` +
      (el.getAttribute("data-rest")
        ? `<span class="fig-tip-hint">among the ones pooled as “other”</span>` : ""),
      e);
  });
  svg.addEventListener("pointerleave", hideTip);
}

// The rest of the panel, and the reason the panel is as tall as the plot beside
// it: composition alone leaves the two questions a point raises unanswered — how
// much is in there, and what is it actually near.
// Which distance the neighbour list is sorted by. Kept across samples and
// redraws: someone who has decided they want Euclidean has decided it for the
// session, not for one click.
let neighbourMetric = "bray";

/**
 * What the archive said this sample is — when there is anything to say.
 *
 * An accession is not a sample: ERR14098585 tells a reader nothing, and the
 * EBI told us in the same request that it was collected in 2022, in France,
 * from a human gut, on an Ion GeneStudio. That was being fetched and thrown
 * away.
 *
 * Every value here has been through meta.js, so a sentinel ("not provided"), an
 * archive-generated title, or a pair of zero coordinates never reaches the
 * page. A field with nothing behind it produces no chip at all — never a dash,
 * because a dash reads as a broken page rather than as an empty archive. A
 * sample with no metadata at all — a FASTQ off the user's own disk — produces
 * nothing, which is the truth about it.
 */
function metaHtml(name) {
  // Everything the run line above the matrix already carries is left out here.
  const shared = new Set((lastRaw?.metaBySample?.size
    ? runFacts(lastRaw.metaBySample, lastMatrix?.samples ?? []) : []).map((f) => f.key));
  const lines = metaLines(metaOf(name), { except: shared });
  if (!lines.length) return "";
  return `<div class="pie-meta" title="From the ENA, in the same request that ` +
    `found this run's files. Values the archive marks as missing are not shown.">` +
    lines.map((l) =>
      `<span class="pie-meta-bit">` +
      (l.label ? `<i>${escapeHTML(l.label)}</i> ` : "") +
      `${escapeHTML(l.value)}</span>`).join("") +
    `</div>`;
}

/**
 * The genera behind one sample's split, and the name that follows from them.
 *
 * The reason this is not optional: every failure the pole names can have is
 * invisible in a total and obvious in a list. `Ruminococcus 0.00` beside
 * `Ruminococcus_E 9.32` is the whole GTDB problem in one line, and a reader who
 * knows the field will spot a missing genus here in a second — where they could
 * stare at a triangle for an hour and see nothing wrong.
 */
function enterotypeHtml(name) {
  if (openFig !== "enterotype" || !lastRaw?.matrix) return "";
  const table = genusTable();
  const row = enterotypeSplit(table).find((r) => r.sample === name);
  if (!row) return "";
  const pct = (v) => v.toFixed(v < 10 ? 2 : 1);
  let out = `<div class="pie-pole">`;
  ENTEROTYPE_POLES.forEach((pole, i) => {
    const mine = row.genera.filter(([g]) => pole.genera.includes(g));
    out += `<div class="pie-pole-head">${escapeHTML(pole.label)}` +
      `<span class="share">${row.shares[i].toFixed(0)}%</span>` +
      `<span class="sum">${pct(row.sums[i])}% of the profile</span></div>` +
      `<div class="pie-pole-genera">` +
      (mine.length
        ? mine.map(([g, v]) => `<span><i>${escapeHTML(g)}</i> ${pct(v)}</span>`).join("")
        // Naming what was looked for and not found is the point: "no Prevotella
        // detected" and "we never looked for Segatella" are different answers.
        : `<span class="zero">none of ${pole.genera.slice(0, 3).map(escapeHTML).join(", ")}` +
          `${pole.genera.length > 3 ? "…" : ""} detected</span>`) +
      `</div>`;
  });
  out += `</div>`;

  const lead = ENTEROTYPE_POLES[row.lead].label;
  const pair = row.pair.map((i) => ENTEROTYPE_POLES[i].label).join(" and ");
  out += `<div class="pie-call">` +
    (!row.call
      ? `<b>No call.</b> These three groups are ${pct(row.markers)}% of this profile — ` +
        `under ${ENTEROTYPE_MIN_MARKERS}%, there is not enough here to divide.`
      : row.call === "between"
        ? `Between <b>${escapeHTML(pair)}</b> — ${row.gap.toFixed(0)} points apart.`
        : `Leaning <b>${escapeHTML(lead)}</b> — ${row.gap.toFixed(0)} points clear.`) +
    `<span title="A name needs ${ENTEROTYPE_GAP} points of daylight, which is how far the ` +
    `split moves between two profiles of essentially the same material. It describes this ` +
    `SAMPLE, not this person: in the shipped example one person's split moves by up to 39 ` +
    `points between visits eight weeks apart, and one of the six changes which pole leads ` +
    `twice.">` +
    `${pct(row.markers)}% of the profile is on these three axes, ${pct(100 - row.markers)}% is not.` +
    `</span></div>`;
  return out;
}

function factsHtml(view, name, surface = TAXO_SURFACE) {
  const f = sampleFacts(view, name, { metric: neighbourMetric });
  if (!f) return "";
  const stat = (v, label, title) =>
    `<div class="pie-stat" title="${escapeHTML(title)}"><b>${v}</b><span>${label}</span></div>`;
  let out = `<div class="pie-facts"><div class="pie-stats">` +
    stat(f.richness.toLocaleString(), `${surface.unit} detected`,
      `Rows with an abundance above zero in this sample, out of ${view.rows.length} in the matrix.`) +
    stat(f.effective.toFixed(1), `effective ${surface.unit}`,
      `e^Shannon (H = ${f.shannon.toFixed(2)}): how many equally-abundant ${surface.unit} would give ` +
      `this diversity. Fewer than the count above, because the abundances are uneven. ` +
      `Inverse Simpson, which all but ignores the rare tail, is ${f.inverseSimpson.toFixed(1)}.`) +
    stat(`${f.rank}<span class="of"> / ${f.of}</span>`, "by diversity",
      `1 is the most diverse sample of the ${f.of} on screen, by effective ${surface.unit}.`) +
    `</div>` +
    // When the pie is drawn at another level than the numbers are computed at,
    // say so. Three tiles reading "orthologs" under a disc of pathways is two
    // answers presented as one.
    (surface.pieUnit && surface.pieUnit() !== surface.unit
      ? `<div class="pie-note info">The disc is ${escapeHTML(surface.pieUnit())}, at the level ` +
        `chosen above; the three numbers are over the ${escapeHTML(surface.unit)}, which are ` +
        `measured once each — ${escapeHTML(surface.pieUnit())} overlap, and a diversity index ` +
        `over categories that share members is not one.</div>`
      : "") +
    (surface.enterotype ? enterotypeHtml(name) : "") + metaHtml(name);

  // Not on the enterotype tab: "which samples is this one nearest" is the
  // ordination's question, it is one tab away, and the panel is a fixed box that
  // the pole audit already spends 250 px of. Something had to go and this is the
  // part that is drawn twice.
  if (f.nearest.length && !(surface.enterotype && openFig === "enterotype")) {
    // The distances are the FULL ones. The ordination is a projection of them
    // onto two axes and says so in its own labels; these are what it projects.
    const m = METRICS[f.metric];
    out += `<div class="pie-near"><div class="pie-near-head">Closest samples` +
      `<label class="pie-metric" title="Computed over all ${view.rows.length} rows of the ` +
      `matrix — the real distance, not the two-dimensional shadow of it the ordination ` +
      `draws. Bray-Curtis is the share of the two profiles that is not shared, 0 to 1, and ` +
      `is what the ordination itself is computed from. Euclidean is the straight-line ` +
      `distance between the two abundance vectors, which the most abundant taxa dominate.">` +
      Object.entries(METRICS).map(([key, meta]) =>
        `<button type="button" data-metric="${key}"` +
        `${key === f.metric ? ' class="is-on"' : ""}>${escapeHTML(meta.label)}</button>`).join("") +
      `</label></div>`;
    for (const n of f.nearest) {
      const g = metaGroupOf(n.sample);
      // How CLOSE, not how far: the list is sorted nearest first, and drawing
      // the distance gave the nearest sample the shortest bar — a chart that
      // shrank as it went down a list headed "Closest samples".
      //
      // Against the metric's own ceiling, not against the nearest neighbour: a
      // sample whose closest relative is far away must not look as close as one
      // with a twin. So a full bar is an identical profile, an empty one shares
      // nothing, and the number beside it stays the distance itself.
      const close = Math.max(0, Math.min(100, (1 - n.distance / m.max) * 100));
      out += `<button type="button" class="pie-near-row" data-jump="${escapeHTML(n.sample)}" ` +
        `title="Open ${escapeHTML(n.sample)}">` +
        `<span class="pie-near-name">${escapeHTML(n.sample)}` +
        (g ? `<span class="pie-near-group">${escapeHTML(g)}</span>` : "") + `</span>` +
        `<span class="pie-near-bar" title="${close.toFixed(0)}% of the way to an ` +
        `identical profile — a full bar is the same sample twice, an empty one ` +
        `shares nothing. The number is the ${escapeHTML(m.label)} distance itself.">` +
        `<i style="width:${close.toFixed(1)}%"></i></span>` +
        `<span class="pie-near-d">${n.distance.toFixed(m.digits)}</span></button>`;
    }
    out += `</div>`;
  }
  return out + `</div>`;
}

// Drawn to fit, so it has to be redrawn when the fit changes. Debounced: a drag
// of the window edge fires this by the hundred, and a PCoA is an eigenproblem.
let figResize = null;
addEventListener("resize", () => {
  if (!openFig) return;
  clearTimeout(figResize);
  figResize = setTimeout(() => { if (openFig) drawFigure(openFig); }, 200);
});

// The tooltip is positioned in the viewport, so a scroll slides the plot out
// from under it and leaves it labelling whatever is now there. The next pointer
// move puts it back where it belongs — unless it belongs to a focused point, in
// which case it goes with it.
addEventListener("scroll", () => {
  const tip = document.getElementById("figTip");
  if (!tip || tip.classList.contains("hide")) return;
  if (!tipAnchor?.isConnected) { hideTip(); return; }
  const r = tipAnchor.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(r.right + 16, window.innerWidth - tip.offsetWidth - 8))}px`;
  tip.style.top = `${Math.max(8, Math.min(r.bottom + 16, window.innerHeight - tip.offsetHeight - 8))}px`;
}, { passive: true, capture: true });

// Escape closes the sample, as it would a dialog — but only when no real dialog
// is open, which handles its own Escape and must not be shadowed.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !pickedSample) return;
  if (document.querySelector("dialog[open]")) return;
  closePie();
  hideTip();
});
// The full GTDB lineage of a genome, in the shape exports.js wants.
function lineageOf(genome) {
  const out = {};
  for (const k of taxonomy.rankKeys) {
    const v = taxonAt(genome, k);
    if (v) out[k] = v;
  }
  return out;
}

function saveBlob(text, type, name) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

document.getElementById("exportAs")?.addEventListener("change", (e) => {
  const kind = e.target.value;
  e.target.value = "";
  if (!kind || !lastMatrix) return;
  const slug = refSlug(lastMatrix.ref);
  const view = viewOf(lastMatrix);
  // A sample that no longer exists cannot stay open — a session reloaded, a run
  // restarted. Checked before the panel is painted, since the panel is what the
  // figure is measured against.
  if (pickedSample && !view.samples.includes(pickedSample)) closePie();
  if (kind === "tsv" || kind === "csv") {
    // The two that were buttons of their own until the toolbar was folded into
    // one menu. Same function, same file, one slot instead of three.
    downloadMatrix(kind === "tsv" ? "\t" : ",", kind);
    return;
  }
  if (kind === "functsv" || kind === "funccsv") {
    downloadFuncMatrix(kind === "functsv" ? "\t" : ",", kind === "functsv" ? "tsv" : "csv");
    return;
  }
  if (kind === "groups") {
    // The way back out. Groups could be READ from a CSV since the first version
    // and made in the page since the editor landed, but a grouping made here —
    // eighteen samples clicked into two arms — existed only in this tab, and the
    // only way to keep it was to write the file by hand in another program. It
    // is the same two columns the page reads, so it goes straight back in, and
    // it travels to whatever else the reader's analysis runs in.
    saveBlob(groupsCsv(view.samples), "text/csv", `peekmicrobiome-groups-${slug}.csv`);
    return;
  }
  if (kind === "session") {
    saveSession();
    return;
  }
  if (kind === "sylph") {
    // Straight from what sylph wrote, so every column survives — including the
    // ones this page never reads.
    const tsv = toSylphTsv(files.filter((f) => f.tsv));
    // A matrix on screen is not enough: this export is sylph's own output, kept
    // per sample as it was written, and neither a saved session nor the example
    // carries it — they hold the assembled matrix and nothing else.
    if (!tsv) {
      showError(lastMatrix
        ? "The raw sylph output is not part of a saved session — only the matrix is, which is " +
          "what the TSV, CSV, MetaPhlAn and BIOM exports write. Profile a sample here to get " +
          "sylph's own columns."
        : "No sylph output to export — no sample has finished yet.");
      return;
    }
    saveBlob(tsv, "text/tab-separated-values", `sylph_profile_${slug}.tsv`);
  } else if (kind === "mpa") {
    saveBlob(toMetaphlan(view, {
      lineageOf, speciesOf: (g) => taxonAt(g, "s"),
      header: refCommentLines(view.ref, { samples: view.samples.length, rows: view.rows.length })
        .map((l) => l.replace(/^#\s?/, "")),
    }), "text/tab-separated-values", `metaphlan_${slug}.tsv`);
  } else if (kind === "biom") {
    saveBlob(toBiom(view, { lineageOf, speciesOf: (g) => taxonAt(g, "s"),
      date: new Date().toISOString() }), "application/json", `table_${slug}.biom`);
  }
});

function saveSession() {
  if (!lastRaw) { showError("Nothing to save yet — no sample has been profiled."); return; }
  saveBlob(toSession({
    ref: lastRaw.ref, sampleOrder: lastRaw.sampleOrder, matrix: lastRaw.matrix,
    refBySample: lastRaw.refBySample, sampleMeta: lastRaw.metaBySample,
    funcProfiles,
    // Only the hand-made ones. A grouping by metadata field is recomputed on
    // open from the metadata that is saved beside it.
    groups: customGroups,
    rank: currentRank(),
    savedAt: new Date().toISOString(),
    // Named for what it is. Saving while the example is on screen writes the
    // example out, and a file called session_human-gut.json would be indexed a
    // month later as somebody's own run.
  }), "application/json", `${demoOn ? "example_" + DEMO_STUDY + "_" : "session_"}${refSlug(lastRaw.ref)}.json`);
}

// Putting a saved matrix back on screen. Shared by the file picker and by the
// bundled example, so the example cannot drift into being a mock of the results:
// it goes through the same restore as any session from disk.
function applySession(st) {
  lastRaw = { matrix: st.matrix, sampleOrder: st.sampleOrder, ref: st.ref,
    refBySample: st.refBySample, metaBySample: st.sampleMeta ?? new Map() };
  // Groups the reader made, back as they were — and selected, since a session
  // that carries them was saved by somebody who wanted them.
  customGroups = st.groups?.size ? new Map(st.groups) : new Map();
  if (customGroups.size) { groupSource = "custom"; applyGroupSource(); }
  // Null, not {}: the Function tab distinguishes "this run measured no
  // functions" from "it measured them and found none", and only one of those is
  // a reason to explain rather than to draw.
  funcProfiles = st.funcProfiles ?? null;
  const pick = document.getElementById("rankPick");
  if (pick && st.rank) pick.value = st.rank;
  lastMatrix = matrixToTable(lastRaw.matrix, lastRaw.sampleOrder, lastRaw.ref, lastRaw.refBySample);
  renderMatrix(viewOf(lastMatrix));
  els.results.classList.remove("hide");
  refreshSteps();
  // A figure left open was drawn from the table that has just been replaced.
  // Redrawn rather than left there: the SVG of the previous run beside the new
  // matrix is two different results under one heading.
  if (openFig) drawFigure(openFig);
  // Same rule one level up: if the Function panel is the one on screen, it is
  // showing the orthologs of the run that has just been replaced.
  if (!document.getElementById("funcPanel")?.classList.contains("hide")) refreshFunc();
}

// One input, two ways in: the row inside the results card, and the button in the
// page head for a tab that has no results yet. Triggering the same hidden input
// rather than adding a second one keeps the reader and the handler single.
document.getElementById("openSession")?.addEventListener("click", () => {
  document.getElementById("loadSession")?.click();
});

document.getElementById("loadSession")?.addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  e.target.value = "";
  if (!f) return;
  try {
    const st = fromSession(await f.text());
    // A session of your own replaces the example, lineage map included.
    clearDemo({ wipe: false });
    applySession(st);
    // The saved rank may not be reachable: a session taken at genus level and
    // reopened before its database is loaded has no lineage map to aggregate
    // with, and silently showing species instead would be a different table
    // under the same heading.
    if (st.rank !== "s" && !canAggregate()) {
      showError(`This session was saved at ${RANK_LABELS[st.rank] ?? st.rank} level. ` +
        `Load ${st.ref?.label ?? "its reference database"} to get that view back — ` +
        `the numbers below are per genome until you do.`);
    }
  } catch (err) {
    showError(`Could not read that session: ${err?.message ?? err}`);
  }
});

// ---- the worked example ------------------------------------------------------
//
// Nothing on this page shows a number until a 433 MB catalogue has come down the
// wire and a sample has been profiled. That is a long way to walk to find out
// whether the results are worth walking for — and it is the reason people close
// the tab.
//
// So: a real run, saved and shipped. Eighteen public runs of PRJNA728374
// profiled against Human gut (UHGG), in the same JSON the Save session button
// writes, rebuilt from the exported matrix by scripts/build_demo_session.py. Not
// a mock and not simulated numbers: profile the same accessions from the ENA
// panel below, at the read cap this page already defaults to, and the table
// comes back.
//
// Six people, three stool samples each over eight weeks. That is the example
// doing a job no synthetic one could: a visitor colours the ordination by
// subject and sees each person's three samples land together, which is the one
// intuition worth leaving with — the individual is the signal.
//
// It replaced fifteen runs of PRJEB83730, which looked like the same thing and
// was not: metaquantibiote is a contamination experiment, and what looked like
// repeat samples of one donor were that donor's stool with 0.1% to 10% of
// another's added. It said so only in the `comment` attribute of the sample XML,
// which no portal field carries and no amount of reading the run table would
// have shown.
const DEMO_SESSION = "demo/gut-demo.session.json";
const DEMO_GROUPS = "demo/gut-demo.groups.csv";
const DEMO_STUDY = "PRJNA728374";
let demoOn = false;
// Everything the example borrows from the page, handed back when it leaves.
//
// The lineage map, because a map from one catalogue names nothing in another —
// leaving the gut map in place while a soil database is loaded would put gut
// species names on soil genomes. And the results, because the button sits at the
// top of the page and stays clickable after a run that took an hour: the example
// has to be something you can look at and step out of, not something that eats
// what you came for.
let preDemo = null;
// Bumped by anything that ends the example. loadDemo() checks it after every
// await, so a database load or a run started while its three fetches are in
// flight is not overwritten by them when they land.
let demoEpoch = 0;

async function loadDemo() {
  const btn = document.getElementById("demoLoad");
  // Only the title line: the button holds an icon and a second line, and writing
  // over its textContent would flatten both away and never bring them back.
  const title = btn?.querySelector(".demo-btn-title");
  const label = title?.textContent;
  setDisabled(btn, "Loading the example…");
  if (title) title.textContent = "Loading the example…";
  const mine = ++demoEpoch;
  const stale = () => mine !== demoEpoch;
  try {
    const bust = `?v=${WORKER_VERSION}`;
    const grab = async (path) => {
      const r = await fetch(`./${path}${bust}`);
      if (!r.ok) throw new Error(`${path} — HTTP ${r.status}`);
      return r.text();
    };
    const [sessionText, groupsText] = await Promise.all([grab(DEMO_SESSION), grab(DEMO_GROUPS)]);
    if (stale()) return;
    const st = fromSession(sessionText);

    if (!preDemo) {
      preDemo = {
        lineage, taxonomy, ambiguousNames, metaGroups, groupSource, customGroups,
        lastRaw, lastMatrix, openFig, rank: currentRank(),
        // The example ships its own orthologs. Without this, clearing it would
        // leave them in the Function tab beside whatever was on screen before.
        funcProfiles,
      };
    }

    // The catalogue's lineage map is a 399 kB static file, independent of the
    // 433 MB database beside it — so the example can offer genus, family and
    // phylum, which is half of what there is to explore, without downloading
    // anything of consequence. Awaited rather than read off `catalog`: a visitor
    // who clicks this in the first second of the page would otherwise find the
    // rank picker missing, with nothing saying why.
    await catalogReady;
    if (stale()) return;
    const entry = catalog ? biomeByKey(catalog, st.ref?.key) : null;
    if (entry?.lineage) {
      try {
        // No cache-buster: the same URL loadDatabase() uses, so a visitor who
        // goes on to load the catalogue itself does not fetch this twice.
        const r = await fetch(`./${entry.lineage}`);
        if (r.ok) {
          const map = await r.json();
          if (stale()) return;
          taxonomy = normaliseLineage(map);
          lineage = taxonomy.species;
          ambiguousNames = sharedNames(lineage);
        }
      } catch { /* species level still works: the labels are in the session */ }
    }
    if (stale()) return;

    metaGroups = parseMetadata(groupsText);
    // The example ships its own groups file, so the picker says so: it read
    // "none" over a plot coloured by six donors, which is the same inconsistency
    // the CSV path had.
    groupSource = "csv";
    contrastPair = null;
    // Before applySession, which paints the step strip: the strip asks demoOn
    // whether to call this the example, and would otherwise announce it as a
    // finished run of yours for as long as nothing else refreshed it.
    demoOn = true;
    applySession(st);
    paintDemoBanner(st);
    // Opened rather than merely offered: the ordination with its groups coloured
    // is the one view that says in a glance what the example is for, and a tab
    // nobody clicks shows nothing.
    drawFigure("pcoa");
    els.results.scrollIntoView({ block: "start", behavior: "smooth" });
  } catch (err) {
    showError(`Could not load the example: ${err?.message ?? err}. ` +
      `It ships with the page, so this usually means the files were not deployed.`);
  } finally {
    setDisabled(btn, "");
    if (title && label) title.textContent = label;
  }
}

function paintDemoBanner(st) {
  const el = document.getElementById("demoBanner");
  if (!el) return;
  const n = st.sampleOrder.length;
  // Counted over the samples on screen, not over the file: parseMetadata keeps
  // the header row as an entry of its own, and every group it names for a sample
  // this session does not have would be counted here as a subject.
  const groups = new Set(st.sampleOrder.map((s) => metaGroupOf(s)).filter(Boolean)).size;
  // A <details>, because on a narrow screen this paragraph was a whole screen of
  // reading between the page and its own results — measured at 420 px, where the
  // banner alone filled the viewport before the tab bar. The line that MUST be
  // met is the first one, and it is the summary; the rest is there for whoever
  // wants it.
  el.innerHTML =
    `<details class="demo-fold" open><summary><strong>This is the example, not your data.</strong> ` +
    `${n} public runs of ${DEMO_STUDY}, already profiled.</summary>` +
    `<div>${n} public runs of ` +
    `<a href="https://www.ebi.ac.uk/ena/browser/view/${DEMO_STUDY}" target="_blank" ` +
    `rel="noopener noreferrer">${DEMO_STUDY}</a> — ${groups || "six"} volunteers in Singapore, ` +
    `each of whom gave a stool sample three times over eight weeks while eating one of three ` +
    `cooking oils in a blinded trial. Profiled with this page against ` +
    `${escapeHTML(st.ref?.label ?? "a catalogue")} and saved. The numbers are real measurements, ` +
    `but nothing was computed on your computer just now: profile the same accessions from the ` +
    `ENA panel above and they come back.` +
    // Only when there is one. The example shipped taxonomy alone for a year, and
    // a banner promising a tab that refuses is worse than a banner that is quiet.
    //
    // And it must not inherit the sentence before it: "profile the same accessions
    // and they come back" was true of the taxonomy and false of the functions for
    // as long as that half could only be computed by a script. Since the page grew
    // the second sketch it is true of both, and this sentence says so — a banner
    // still describing the old limitation would send a reader looking for a
    // control that is right there on the page.
    (st.funcProfiles && Object.keys(st.funcProfiles).length
      ? ` The Function tab is the same reads read a second way — KEGG orthologs, ` +
        `at the same depth. Tick <em>also profile functions</em> before a run and ` +
        `this page measures that half too.`
      : "") +
    `</div></details>` +
    `<button type="button" id="demoClear">Clear the example</button>`;
  el.classList.remove("hide");
  document.getElementById("demoClear")?.addEventListener("click", () => clearDemo());
}

// `wipe: false` when something else is about to put its own results on screen —
// the lineage still has to be handed back, but blanking the table first would
// make the page flash empty on the way.
function clearDemo({ wipe = true } = {}) {
  demoEpoch++;
  if (!demoOn) return;
  demoOn = false;
  const back = preDemo;
  preDemo = null;
  document.getElementById("demoBanner")?.classList.add("hide");
  // Groups and the lineage map go back whatever happens next: the example's
  // subjects must not colour a later run, and its map must not name a later
  // catalogue's genomes.
  if (back) {
    ({ lineage, taxonomy, ambiguousNames, metaGroups } = back);
    // Where the groups came from goes back with them. Without this the picker
    // kept saying "from a CSV…" over a cleared page with no groups in it.
    groupSource = back.groupSource ?? "none";
    customGroups = back.customGroups ?? new Map();
  } else {
    metaGroups = new Map();
    groupSource = "none";
    customGroups = new Map();
  }
  if (!wipe) return;

  // What was on screen before the example, put back — including nothing, which
  // is the usual case.
  lastRaw = back?.lastRaw ?? null;
  lastMatrix = back?.lastMatrix ?? null;
  funcProfiles = back?.funcProfiles ?? null;
  const pick = document.getElementById("rankPick");
  if (pick) pick.value = back?.rank ?? "s";
  if (lastMatrix) {
    renderMatrix(viewOf(lastMatrix));
    els.results.classList.remove("hide");
    drawFigure(back?.openFig ?? null);
  } else {
    drawFigure(null);
    els.results.classList.add("hide");
    const note = document.getElementById("figNote");
    if (note) note.textContent = "";
  }
  if (!document.getElementById("funcPanel")?.classList.contains("hide")) refreshFunc();
  refreshSteps();
}

document.getElementById("demoLoad")?.addEventListener("click", loadDemo);

/**
 * Two SVGs into one, side by side.
 *
 * A figure and the sample panel beside it are what a reader looked at; saving
 * them apart and re-assembling them in another program is work the page can do
 * once. Both are complete documents with their own viewBox, so each goes into a
 * translated group and the outer box is their sum — no scaling, so a 900-pixel
 * plot stays 900 pixels wide and the type keeps its size.
 */
function sideBySideSvg(a, b, gap = 24) {
  const box = (svg) => {
    const m = /viewBox="([\d.\-]+) +([\d.\-]+) +([\d.\-]+) +([\d.\-]+)"/.exec(svg);
    return m ? { w: Number(m[3]), h: Number(m[4]) } : { w: 0, h: 0 };
  };
  const A = box(a), B = box(b);
  if (!A.w || !B.w) return a || b;
  const w = A.w + gap + B.w, h = Math.max(A.h, B.h);
  // The inner <svg> elements are kept whole rather than unwrapped: each carries
  // its own font-family and font-size, and hoisting their children would leave
  // them inheriting the outer document's.
  const place = (svg, x) => `<g transform="translate(${x},0)">${svg}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ` +
    `viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#ffffff"/>` +
    place(a, 0) + place(b, A.w + gap) + `</svg>`;
}

/** Wire one figure's "save as SVG" menu. Both halves have one; they differ only
 *  in which elements they read and what the file is called. */
function wireSvgPick(selId, canvasId, panelId, nameOf) {
  const sel = document.getElementById(selId);
  if (!sel) return;
  sel.addEventListener("change", () => {
    const want = sel.value;
    sel.value = "";
    if (!want) return;
    const figure = document.getElementById(canvasId)?.querySelector("svg")?.outerHTML ?? "";
    const panel = document.getElementById(panelId)?.querySelector(".fig-detail-body svg")?.outerHTML ?? "";
    // Offered but empty is a worse answer than offered and refused: with no
    // sample open there is no right-hand panel to save, and silently writing the
    // figure under a name that says "both" would be the wrong file.
    if (want !== "figure" && !panel) {
      showError("No sample is open beside the figure — click a point, a bar or a row first.");
      return;
    }
    const svg = want === "figure" ? figure
      : want === "panel" ? panel
        : sideBySideSvg(figure, panel);
    if (!svg) return;
    saveBlob(svg, "image/svg+xml", `${nameOf()}-${want}.svg`);
  });
}
wireSvgPick("figSvgPick", "figCanvas", "figDetail",
  () => `${openFig ?? "figure"}_${refSlug(lastMatrix?.ref)}`);
wireSvgPick("funcSvgPick", "funcCanvas", "funcDetail",
  () => `peekmicrobiome-function-${openFuncFig}`);
document.getElementById("rankPick")?.addEventListener("change", rerankMatrix);
const canAggregate = () => taxonomy.rankKeys.length > 0;

function sharedNames(map) {
  const seen = new Map();
  for (const name of Object.values(map ?? {})) seen.set(name, (seen.get(name) ?? 0) + 1);
  const out = new Set();
  for (const [name, n] of seen) if (n > 1) out.add(name);
  return out;
}

// The eighteen biome databases report "MGYG….fna.gz", the older human-gut one
// "MGYG….fna", and the maps hold the un-gzipped form.
function speciesLabel(genome) {
  const name = lineage[genome] ?? lineage[genome.replace(/\.gz$/i, "")];
  if (!name) return `(${genome})`;
  if (!ambiguousNames.has(name)) return name;
  // Accession only — the extension is noise and differs between catalogues.
  const acc = String(genome).replace(/\.(fna|fa|fasta)(\.gz)?$/i, "");
  return `${name} [${acc}]`;
}

function matrixToTable(matrix, sampleOrder, ref, refBySample = new Map(), { rank = null } = {}) {
  // `rank` overrides the picker. One figure needs genus whatever the table is
  // showing — the enterotype poles are genera — and re-ranking the page under
  // the user to draw it would be a figure moving the matrix.
  rank = rank ?? currentRank();
  // At species level a row is one genome, as it always was. Above it, rows are
  // SUMMED per taxon — which is the arithmetic a rank actually means, and the
  // reason it is done here rather than in the renderer: the exports must carry
  // the same numbers the screen shows.
  let rows;
  if (rank === "s" || !canAggregate()) {
    rows = Object.entries(matrix).map(([genome, m]) => {
      const values = sampleOrder.map(s => m[s] ?? 0);
      return { genome, species: m.species, values, maxAbund: Math.max(...values) };
    });
  } else {
    const byTaxon = new Map();
    for (const [genome, m] of Object.entries(matrix)) {
      // Unplaced at this rank is its own bucket, named. Dropping those rows
      // would silently lose abundance and make the columns stop summing to what
      // the species-level view showed.
      const name = taxonAt(genome, rank) || `unclassified at ${RANK_LABELS[rank].toLowerCase()} level`;
      let e = byTaxon.get(name);
      if (!e) { e = { name, values: sampleOrder.map(() => 0), n: 0 }; byTaxon.set(name, e); }
      sampleOrder.forEach((s, i) => { e.values[i] += m[s] ?? 0; });
      e.n++;
    }
    rows = [...byTaxon.values()].map((e) => ({
      genome: `${e.n} genome${e.n === 1 ? "" : "s"}`,
      species: e.name,
      values: e.values,
      maxAbund: Math.max(...e.values),
    }));
  }
  rows.sort((a, b) => b.maxAbund - a.maxAbund);
  // `ref` travels WITH the numbers, all the way to the exported file.
  const refs = sampleOrder.map((n) => refBySample.get(n) ?? ref);
  const mixed = refs.some((r) => !sameDbRef(r, refs[0]));
  return { samples: sampleOrder, rows, ref, refs, mixed };
}

// ---- matrix rendering --------------------------------------------------------

// `progress` is passed while a run is still going: the table is shown as it
// fills, and the summary has to say so — a matrix that looks finished but holds
// 3 of 85 samples is worse than no matrix at all, because it will be exported
// and read as the whole thing.
/**
 * The abundance matrix — ONE renderer, both halves.
 *
 * Taxonomy and Function are the same table of the same shape asked two
 * questions, and the page says so by drawing them with the same code rather
 * than with two functions that happen to agree today. They agreed for about a
 * day: the functional one had one header row instead of two, no heat colour, no
 * identifier column and three decimals instead of two, and every one of those
 * was invisible until the two were seen side by side.
 *
 * What differs is passed in, and it is exactly four things: what a row IS
 * (species / pathway), what identifies it (a genome accession / a KEGG entry),
 * where that identifier can be looked up (MGnify / KEGG), and what the columns
 * were measured against. Everything else — the sticky header, the second header
 * row naming the reference per column, the heat scale, the two decimals, the
 * empty cell for absent rather than "0.00" for trace — is shared by
 * construction.
 *
 *   rows      [{ name, id, values }]  the name is the first column, the
 *             identifier the second — never both in one cell, which is what
 *             passing kegg.js's `label` here produced: "map01100 — Metabolic
 *             pathways" beside a column already reading "map01100".
 *   scale     multiplier onto a percentage: 1 for sylph's own %, 100 for a
 *             functional fraction. The heat scale reads percentages.
 *   urlOf     (id) => string | null. Null renders the identifier unlinked,
 *             which is what a genome with no MGnify page and a `_none` bucket
 *             both need.
 */
// The citation notice folds after it has been read once. It is correct and it
// matters — it is also 150 px off the top of the page on every visit, met once
// and scrolled past for ever after. Open the first time so a first-time reader
// still meets it; remembered closed after that, in this browser only.
{
  const cite = document.getElementById("noticeCite");
  if (cite) {
    let seen = false;
    try { seen = localStorage.getItem("peek-cite-read") === "1"; } catch { /* private mode */ }
    cite.open = !seen;
    cite.addEventListener("toggle", () => {
      if (cite.open) return;
      try { localStorage.setItem("peek-cite-read", "1"); } catch { /* private mode */ }
    });
  }
}


// ---- searching and sorting a matrix -------------------------------------------
//
// One state per half, because the two tables are asked different questions and a
// search typed into one has no meaning in the other. Both live here rather than
// in paintMatrix, which is a renderer and should hold no memory.
let taxoFind = "", funcFind = "";
let taxoSort = null, funcSort = null;   // { col, dir } or null for the table's own order

document.getElementById("matrixFind")?.addEventListener("input", (e) => {
  taxoFind = e.target.value;
  if (lastMatrix) renderMatrix(viewOf(lastMatrix));
});
document.getElementById("funcFind")?.addEventListener("input", (e) => {
  funcFind = e.target.value;
  refreshFunc();
});
// Delegated, because the header row is rebuilt on every redraw and listeners
// attached to the old one would be attached to elements that no longer exist.
document.getElementById("matrixHead")?.addEventListener("click", (e) => {
  const th = e.target.closest?.("th[data-sort-col]");
  if (!th) return;
  taxoSort = nextSort(taxoSort, Number(th.dataset.sortCol));
  if (lastMatrix) renderMatrix(viewOf(lastMatrix));
});
document.getElementById("funcHead")?.addEventListener("click", (e) => {
  const th = e.target.closest?.("th[data-sort-col]");
  if (!th) return;
  funcSort = nextSort(funcSort, Number(th.dataset.sortCol));
  refreshFunc();
});

function paintMatrix(headEl, bodyEl, {
  samples, rows, nameHead, idHead, subHead, subCells, scale = 1, urlOf = () => null,
  linkTitle = (id) => String(id), cellUrl = null, cellTitle = () => "",
  cellDetail = null, find = "", sort = null, unit = "rows", noteEl = null,
}) {
  if (!headEl || !bodyEl) return;
  // Searched and sorted HERE rather than by the callers, so both matrices get
  // both for free and cannot drift apart in how they interpret either.
  // A sort on a column this table does not have: a run with fewer samples than
  // the last one, a session opened over another. arrangeRows would read
  // `values[7]` as 0 for every row and hand back an alphabetical table with no
  // arrow anywhere to say why.
  const sortCol = sort?.col != null && sort.col < samples.length ? sort.col : null;
  const arranged = arrangeRows(rows, { find, sortCol, sortDir: sort?.dir });
  rows = arranged.rows;
  if (noteEl) noteEl.textContent = arrangeNote(arranged, unit);
  const mark = (c) => (sortCol === c ? (sort.dir === "asc" ? " ↑" : " ↓") : "");
  headEl.innerHTML = `
    <tr>
      <th>${escapeHTML(nameHead)}</th>
      <th>${escapeHTML(idHead)}</th>
      ${samples.map((s, c) => `<th class="sortable" data-sort-col="${c}" ` +
        `aria-sort="${sortCol === c ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}" ` +
        `title="${escapeHTML(s)} — click to sort by this sample">${escapeHTML(s)}` +
        `<span class="sort-mark">${mark(c)}</span></th>`).join("")}
    </tr>
    <tr class="matrix-ref-row">
      <th></th><th>${escapeHTML(subHead)}</th>${subCells}
    </tr>`;

  bodyEl.innerHTML = rows.map((r) => {
    const id = r.id ?? "";
    // A row may name its own destination. Most cannot — an accession or an
    // identifier is all there is to go on — but a KEGG pathway row knows which
    // orthologs were found on it, and that turns a link to an entry page into a
    // link to the map with those boxes coloured in.
    const url = r.url ?? (id ? urlOf(id) : null);
    const code = id ? `<code>${escapeHTML(id)}</code>` : "—";
    return `
    <tr>
      <td class="species" title="${escapeHTML(r.name)}">${escapeHTML(r.name)}</td>
      <td>${url
        ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer"
             title="${escapeHTML(linkTitle(id))}">${code}</a>`
        : code}</td>
      ${r.values.map((v, c) => {
        const pct = v * scale;
        // Present-but-trace reads "0.00" on a tinted cell; absent is an empty,
        // untinted one. Two different facts, two different cells.
        const text = pct > 0 ? pct.toFixed(2) : "";
        const bg = pct > 0 ? heatColor(pct) : "transparent";
        // A cell is a row AND a column, which is exactly what a KEGG map needs:
        // this pathway, in THIS sample. The tab that used to list those links
        // was the same table with the columns thrown away — ordered, moreover,
        // by a quantity that barely differs between samples (two of them share
        // 9.6 of their top 10 pathways), so its sample picker changed nothing.
        const href = pct > 0 && cellUrl ? cellUrl(r, c) : null;
        // A cell that HAS a detail says so by being a button. Which cells have
        // one depends on what a row is: a row that is a SET of orthologs — a
        // KEGG module, a gut metabolic module — can be opened to see the set,
        // and one that IS an ortholog has nothing to open that its identifier
        // does not already link to.
        //
        // Offered on empty cells too, where there is a detail: an empty GMM cell
        // is the interesting one, because the detail says how many of the
        // module's steps were found and therefore why it is empty.
        const detail = cellDetail ? cellDetail(r, c) : null;
        const body = href
          ? `<a href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer" ` +
            `title="${escapeHTML(cellTitle(r, c))}">${text}</a>`
          : detail
            ? `<button type="button" class="cell-open" data-cell="${escapeHTML(detail.key)}" ` +
              `title="${escapeHTML(detail.hint)}">${text || "·"}</button>`
            : text;
        return `<td class="num" style="background:${bg}">${body}</td>`;
      }).join("")}
    </tr>`;
  }).join("");
}

function renderMatrix({ samples, rows, ref, refs, mixed }, progress = null) {
  const rankWrap = document.getElementById("rankPickWrap");
  if (rankWrap) rankWrap.classList.toggle("hide", !canAggregate());
  // The reference, above the numbers, every time they are drawn. A matrix on
  // screen with no reference beside it is the same trap as an export with none:
  // nothing in the species names says which catalogue they were drawn from.
  if (els.matrixRef) {
    const line = refLine(ref);
    els.matrixRef.textContent = line
      ? `Profiled against ${line}. Abundances are relative to this catalogue only.`
      : "";
    els.matrixRef.classList.toggle("hide", !line);
    els.matrixRef.classList.toggle("db-ref-local", !!ref?.local);
  }
  // What the whole run shares, from the archive: the biome it says these
  // samples are, the study they came from, the machine that read them. Only
  // fields every sample agrees on get here — the moment two disagree it is a
  // property of the sample and belongs in its own panel, not printed once over
  // all of them. Measured across 31,523 studies, this is where 78-100% of the
  // filled descriptive fields belong: they are constant within a study, and a
  // constant repeated down 85 rows of a table is noise.
  if (els.matrixMeta) {
    const facts = lastRaw?.metaBySample?.size
      ? runFacts(lastRaw.metaBySample, samples) : [];
    els.matrixMeta.innerHTML = facts.map((f) =>
      `<span class="matrix-meta-bit">` +
      (f.label ? `<i>${escapeHTML(f.label)}</i> ` : "") +
      `${escapeHTML(f.value)}</span>`).join("");
    els.matrixMeta.classList.toggle("hide", !facts.length);
  }
  // A second header row naming the catalogue each COLUMN was profiled against.
  // With one database loaded it repeats — and that repetition is the point: the
  // reference stops being a line above the table that a screenshot or a copied
  // range leaves behind, and becomes a property of the column. It is also the
  // only thing that could show a mixed matrix if the invariant ever broke.
  const refCells = (refs ?? []).map((r) => {
    const short = r ? refShort(r) : "—";
    return `<th class="matrix-ref" title="${escapeHTML(short)}">${escapeHTML(r?.label || r?.file || "—")}</th>`;
  }).join("");

  paintMatrix(els.matrixHead, els.matrixBody, {
    find: taxoFind,
    sort: taxoSort,
    unit: RANK_LABELS[currentRank()].toLowerCase(),
    noteEl: document.getElementById("matrixFindNote"),
    samples,
    // The shared renderer reads `name` and `id`; here they are the species name
    // and the genome accession it was measured on.
    rows: rows.map((r) => ({ name: r.species, id: r.genome, values: r.values })),
    nameHead: RANK_LABELS[currentRank()] ?? "Species",
    idHead: currentRank() === "s" || !canAggregate() ? "Genome" : "Genomes",
    subHead: "profiled against",
    subCells: refCells,
    urlOf: (g) => mgnifyGenomeUrl(g),
    linkTitle: (g) => `Open ${g} on MGnify`,
  });

  const partial = progress && progress.done < progress.total;
  els.resultsSummary.textContent =
    `${rows.length} species across ${samples.length} sample${samples.length === 1 ? "" : "s"}` +
    (partial ? ` — still running, ${progress.done} of ${progress.total} done. ` +
               `Downloads below give you these ${samples.length} for now.` : "");
  els.resultsSummary.classList.toggle("partial", !!partial);
  els.results.classList.remove("hide");
}

function heatColor(pct) {
  // log scale so 0.1% is visible and 50% isn't blinding
  const v = Math.min(1, Math.log10(pct + 1) / Math.log10(60));
  // blue→teal→green ramp
  return `hsla(${200 - v * 80}, 65%, 50%, ${0.15 + v * 0.45})`;
}

// ---- export ------------------------------------------------------------------

// The two download buttons became entries in the Export menu — one verb, one
// control, instead of three slots in a toolbar that had too many. downloadMatrix
// is still the one function that writes them; the exportAs handler calls it.

// An exported matrix has to stand on its own: opened months later, on another
// computer, it must still say which catalogue produced it. That is not
// decoration — a profile run against the wrong biome looks exactly like a good
// one, and re-reading the file is the only way it is ever caught.
//
// The reference is written as `#` comment lines above the header row (what
// sylph, MetaPhlAn and pandas' comment="#" all already skip), and the biome key
// goes in the FILE NAME, because a downloads folder is where these are actually
// told apart and "abundance_matrix.tsv" is the same name for all nineteen.
function downloadMatrix(sep, ext) {
  if (!lastMatrix) return;
  const { samples, rows, ref, refs, mixed } = lastMatrix;
  // The export header follows the rank too: a file whose first column says
  // "species" but holds phyla is worse than one that says nothing.
  const rankKey = (RANK_LABELS[currentRank()] ?? "Species").toLowerCase();
  const header = [rankKey, currentRank() === "s" || !canAggregate() ? "genome" : "genomes", ...samples];
  // Per-column reference, as a comment line, in the same order as the header.
  // The block above already names the reference once; this names it per sample,
  // so a file read months later cannot be misattributed column by column — and
  // if a matrix ever did mix catalogues, the file says so rather than averaging
  // it into one heading.
  const perSample = (refs ?? []).length === samples.length
    ? ["# reference per sample: " +
       samples.map((n, i) => `${n}=${refs[i]?.label || refs[i]?.file || "unknown"}`).join("; ")]
    : [];
  const mixedLine = mixed
    ? ["# WARNING: these columns were NOT all profiled against the same catalogue. " +
       "Abundances from different catalogues are not comparable."]
    : [];
  const lines = [
    ...refCommentLines(ref, { samples: samples.length, rows: rows.length }),
    ...perSample, ...mixedLine,
    header.map(csvEscape(sep)).join(sep),
  ];
  for (const r of rows) {
    lines.push([
      r.species, r.genome,
      ...r.values.map(v => v.toFixed(4))
    ].map(csvEscape(sep)).join(sep));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `abundance_matrix_${refSlug(ref)}.${ext}`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function csvEscape(sep) {
  return (s) => {
    const t = String(s);
    return t.includes(sep) || t.includes("\"") || t.includes("\n")
      ? `"${t.replace(/"/g, '""')}"` : t;
  };
}

// ---- chrome ------------------------------------------------------------------

function setStep(s) { els.step.textContent = s; }
function showError(s) { els.error.textContent = s; }
function paintOverall(doneCount, totalCount, currentFracIn) {
  setTabTitle(totalCount ? `(${Math.floor(doneCount)}/${totalCount})` : "");
  const overall = Math.min(100, (doneCount + currentFracIn) / Math.max(1, totalCount) * 100);
  els.bar.style.width = `${overall.toFixed(1)}%`;
  // The width alone says nothing to a screen reader: role="progressbar" needs
  // its value kept up to date or it announces 0 for the whole run.
  els.bar.parentElement?.setAttribute("aria-valuenow", String(Math.round(overall)));
}

/**
 * Bytes, in the units the things this page names are published in.
 *
 * DECIMAL, not binary. Every figure a reader can check this against is decimal:
 * Zenodo lists the human-gut catalogue at 454.0 MB, `web/db/biomes.json` carries
 * its exact byte count, and the ENA reports FASTQ sizes the same way. Dividing by
 * 1024 and writing "MB" made the page offer a "433.0 MB" download for the very
 * file Zenodo calls 454.0 MB — a 4.6% gap the reader cannot explain and would
 * reasonably read as the wrong file.
 */
function fmtBytes(n) {
  if (!Number.isFinite(n)) return "\u2014";
  if (n < 1e3) return `${n} B`;
  if (n < 1e6) return `${(n / 1e3).toFixed(1)} kB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

// ---- the functional half -----------------------------------------------------
//
// Symmetrical with the taxonomic half above — its own matrix, its own downloads,
// its own figures — and separate from it on purpose: the rows are not the same
// kind of thing, and one table carrying both would be a matrix of two different
// units under one heading.
//
// The figures are NOT the same four. Composition, diversity and the ordination
// carry over unchanged, because kegg.js hands back the same { samples, rows }
// shape they already take. Enterotype does not: there is no enterotype of a
// pathway. In its place, the KEGG map — which is the one figure that has no
// taxonomic counterpart.
let openFuncFig = "composition";

function showResultsTab(which) {
  const taxo = document.getElementById("taxoPanel");
  const func = document.getElementById("funcPanel");
  if (!taxo || !func) return;
  taxo.classList.toggle("hide", which !== "taxo");
  func.classList.toggle("hide", which !== "func");
  for (const b of document.querySelectorAll(".res-tab")) {
    b.classList.toggle("is-on", b.dataset.res === which);
  }
  // Each side is redrawn when it BECOMES visible. An SVG is sized from
  // clientWidth, and a hidden panel measures 0 — so a figure repainted while its
  // half was off screen came back at the 320x300 floor and stayed there, a
  // postage stamp in a full-width card, until something resized the window. That
  // is now a state that cannot persist: whatever was drawn small is drawn again
  // at the size it actually has.
  if (which === "func") refreshFunc();
  else if (openFig) drawFigure(openFig);
}

for (const b of document.querySelectorAll(".res-tab")) {
  b.addEventListener("click", async () => {
    // The names and the roll-ups live in a file. Fetched once, before anything
    // is drawn, so no figure is ever painted with bare identifiers and then
    // silently repainted with names under the reader.
    if (b.dataset.res === "func" && keggConsent()) await loadKeggMap();
    showResultsTab(b.dataset.res);
  });
}

/** Everything the functional panel shows, from whatever state there is. */
function refreshFunc() {
  const canvas = document.getElementById("funcCanvas");
  const head = document.getElementById("funcHead");
  const body = document.getElementById("funcBody");
  const summary = document.getElementById("funcSummary");
  const bar = document.getElementById("funcToolbar");
  if (!canvas) return;

  // Everything that offers to hand the reader something — the level picker, the
  // two downloads, Download SVG, the figure note — has to go with the table it
  // describes. Blanked here and restored below, once, so a state that returns
  // early cannot leave one of them behind: Download TSV stayed clickable under
  // "Nothing measured here" and wrote a header quoting a coverage figure for a
  // profile that did not exist.
  const methodRef = document.getElementById("funcMethodRef");
  const blank = () => {
    if (head) head.innerHTML = "";
    if (body) body.innerHTML = "";
    if (summary) summary.textContent = "";
    // Blanked with the rest: the sentence describes numbers, and there are none.
    if (methodRef) { methodRef.textContent = ""; methodRef.classList.add("hide"); }
    document.getElementById("funcContrastWrap")?.classList.add("hide");
    document.getElementById("funcGroupWrap")?.classList.add("hide");
    bar?.classList.add("hide");
    document.getElementById("funcFigDownload")?.classList.add("hide");
    const note = document.getElementById("funcFigNote");
    if (note) note.textContent = "";
    hideDetail(FUNC_SURFACE);
    const cn = document.getElementById("funcClusterNote");
    if (cn) cn.textContent = "";
    for (const b of document.querySelectorAll(".func-tab")) b.classList.add("hide");
  };

  // The licence question comes before the data question. A reader who has not
  // answered must not be told "nothing was measured": that is a different
  // sentence, and it skips the terms.
  if (!keggConsent()) {
    canvas.classList.remove("hide");
    canvas.innerHTML = keggGateHtml();
    canvas.querySelector("#keggAcademic")?.addEventListener("click", () => setKeggConsent("academic"));
    canvas.querySelector("#keggLicensed")?.addEventListener("click", () => setKeggConsent("licensed"));
    blank();
    return;
  }

  // Names and roll-ups live in a file. Without it every KO falls into "no
  // module" and the panel would draw that as a finding rather than as a missing
  // download, so fetch it first and come back.
  if (!keggMap) { blank(); loadKeggMap().then(refreshFunc); return; }

  const view = lastMatrix ? viewOf(lastMatrix) : null;
  const why = functionRefusal(view);
  if (why) {
    canvas.classList.remove("hide");
    // Two of the refusals are not "nothing measured" — they are a question and a
    // request. Printing them under that heading would tell a reader their data
    // is empty when what is missing is an answer or a file.
    if (why === "gate:gmm") {
      canvas.innerHTML = gmmGateHtml();
      canvas.querySelector("#gmmAcademic")?.addEventListener("click", () => setGmmConsent("academic"));
      canvas.querySelector("#gmmPermitted")?.addEventListener("click", () => setGmmConsent("permitted"));
    } else if (why === "fetch:gmm") {
      // Said rather than left blank: 8 KB over a slow link is a moment of nothing
      // happening, and a panel that goes quiet after a click reads as a click
      // that did not register.
      canvas.innerHTML = `<div class="fig-refusal"><b>Fetching the GMM definitions</b>` +
        `<span>From the Raes lab's own repository, into this tab.</span></div>`;
    } else if (why === "load:gmm") {
      canvas.innerHTML = gmmLoadHtml();
      canvas.querySelector("#gmmPick")?.addEventListener("click",
        () => document.getElementById("gmmFile")?.click());
      canvas.querySelector("#gmmRetry")?.addEventListener("click", () => {
        gmmFetchError = "";
        loadGmmDefs().then(refreshFunc);
        refreshFunc();
      });
    } else {
      canvas.innerHTML = `<div class="fig-refusal"><b>Nothing measured here</b>` +
        `<span>${escapeHTML(why)}</span></div>`;
    }
    blank();
    // The level picker stays reachable, or the only way out of the GMM level is
    // to answer a question the reader may have opened it by accident.
    if (why === "gate:gmm" || why === "load:gmm" || why === "fetch:gmm") {
      bar?.classList.remove("hide");
    }
    return;
  }
  bar?.classList.remove("hide");
  // What these numbers are, and what the method misses — the functional half's
  // answer to the taxonomic half's "Profiled against …", and shown for the same
  // reason. The GMM level is measured the same way and gets the same sentence;
  // what changes there is only which definitions the identifiers mean, and the
  // matrix's own column heads say that.
  if (methodRef) {
    methodRef.textContent = FUNC_METHOD_NOTE;
    methodRef.classList.add("db-ref-long");
    methodRef.classList.remove("hide");
  }
  for (const b of document.querySelectorAll(".func-tab")) b.classList.remove("hide");
  renderFuncMatrix(view);
  drawFuncFigure(openFuncFig);
}

/**
 * Similarity ordering for the functional table — the same control the taxonomic
 * toolbar has, and a better question on this side: functions that rise and fall
 * together across samples are a pathway acting as a unit, which a list ordered
 * by mean abundance hides completely.
 *
 * A VIEW, never the data. Applied after the floor, so what is clustered is what
 * is on screen — clustering rows the reader cannot see would spend the row
 * budget on them and order the visible ones by their company.
 */
function funcViewOf(table) {
  if (!document.getElementById("funcClusterPick")?.checked || !table?.rows?.length) return table;
  const t0 = performance.now();
  const out = clusterTable(table);
  const ms = performance.now() - t0;
  const note = document.getElementById("funcClusterNote");
  if (note) {
    note.textContent = out.clustered.rows
      ? `rows and samples ordered by similarity (${ms.toFixed(0)} ms)`
      : `samples ordered by similarity; ${table.rows.length} rows is past the ` +
        `${CLUSTER_MAX_ROWS}-row limit, so rows stay in abundance order — raise the ` +
        `function floor in Settings to bring them under it`;
  }
  // clusterTable returns a fresh object, so the floor's own fields — how many
  // rows it hid and what they carried — would be dropped on the way to the
  // summary that prints them.
  return { ...table, ...out };
}

function renderFuncMatrix(view) {
  syncExportMenu();
  const head = document.getElementById("funcHead");
  const body = document.getElementById("funcBody");
  const summary = document.getElementById("funcSummary");
  const t = funcViewOf(funcTableFor(view, funcGrain, { floored: true }));
  if (!head || !body) return;

  // Drawn by the taxonomic matrix's own renderer, so the two are the same table
  // asked two questions rather than two tables that look alike. The KEGG entry
  // goes exactly where the genome accession goes on the other side, linked the
  // same way, in the same <code>.
  // The open cell card describes a row of the table about to be replaced. Left
  // standing across a level change it said "M00001" over a table of pathways.
  closeCellPop();
  paintMatrix(head, body, {
    find: funcFind,
    sort: funcSort,
    unit: funcGrain === "ko" ? "orthologs" : funcGrain === "module" ? "modules"
      : funcGrain === "gmm" ? "gut metabolic modules" : "pathways",
    noteEl: document.getElementById("funcFindNote"),
    samples: t.samples,
    // `name`, not `label`: the identifier has a column of its own here, so the
    // combined form kegg.js keeps for figure legends would print it twice.
    // And no identifier at all for the not-on-a-map bucket — it needs a key to
    // group by, but "_none" printed in a column of map00010s hands the reader
    // kegg.js's own token in the shape of something to look up.
    rows: t.rows.map((r) => ({
      name: r.name,
      id: r.id === NO_PATHWAY ? "" : r.id,
      // Carried through: the cell link needs to know which orthologs put this
      // profile on this map. The identifier column keeps the plain entry page —
      // the COLOURED map is per sample, so it belongs on the cell, which is the
      // one place that names both a pathway and a sample.
      kos: r.kos,
      values: r.values,
    })),
    nameHead: funcGrain === "ko" ? "Ortholog" : funcGrain === "module" ? "Module"
      : funcGrain === "gmm" ? "Gut metabolic module" : "Pathway",
    idHead: funcGrain === "gmm" ? "GMM" : "KEGG",
    subHead: "measured against",
    // The functional counterpart of "profiled against <catalogue>". One reference
    // for every column, and named rather than assumed: the numbers are shares of
    // what matched THIS set of orthologs and of nothing else.
    //
    // For GMMs the reference is the FILE THE READER OPENED, and naming it is not
    // decoration: MF0088 is "butyrate production I" in GMMs.v1.07 and a different
    // module entirely in the Raes lab's own GOmixer set, where not one of the 103
    // identifiers keeps its name. An MF number with no version beside it answers
    // "which process is this?" with a token whose meaning depends on a file the
    // column never names.
    subCells: t.samples.map(() => (funcGrain === "gmm"
      ? `<th class="matrix-ref" title="Gut Metabolic Modules, from the definitions you opened ` +
        `(${escapeHTML(gmmName)}). Identifiers are only meaningful against that file.">` +
        `${escapeHTML(gmmName || "your GMM definitions")}</th>`
      : `<th class="matrix-ref" title="KEGG orthologs, sketched from the reads in amino-acid ` +
        `k-mers (k=11) — fmh-funprofiler">KEGG orthologs</th>`)).join(""),
    // The profiler's fractions sum to one; the taxonomic column is already a
    // percentage. The heat scale reads percentages, so this is where they meet.
    scale: 100,
    urlOf: funcGrain === "gmm" ? () => null : keggEntryUrl,
    linkTitle: (id) => `Open ${id} on KEGG`,
    // Every cell of the pathway table opens THAT map for THAT sample, coloured
    // by that sample's own ortholog abundances. A cell is a row and a column,
    // which is exactly what a coloured map needs — and it is why the two tabs
    // that tried to be this list were both the table again.
    //
    // The scale is the SAMPLE's own most abundant ortholog: a map is read on its
    // own, and against the whole run's maximum every map but one comes out
    // uniformly pale.
    cellUrl: funcGrain !== "pathway" ? null : (r, c) => {
      const prof = funcProfiles?.[t.samples[c]] ?? {};
      let max = 0;
      for (const v of Object.values(prof)) if (v > max) max = v;
      const kos = (r.kos ?? [])
        .map((k) => ({ id: k.id, value: prof[k.id] ?? 0 }))
        .filter((k) => k.value > 0)
        .sort((a, b) => b.value - a.value);
      return keggMapUrl(r.id, kos, { max })?.url ?? null;
    },
    // A module row is a SET of orthologs, so its cell can be opened to see the
    // set. A pathway row opens KEGG's coloured map instead (cellUrl above), and
    // an ortholog row has nothing inside it that its own identifier does not
    // already link to.
    cellDetail: (r, c) => funcCellDetail(t, r, c),
    cellTitle: (r, c) => {
      // Three families, three cases, and only one is still a caveat.
      //   011xx  KEGG draws them in its own palette AND offers a grey base, so
      //          the link asks for grey: 2,473,946 coloured pixels become
      //          119,352, nearly all of them ours.
      //   012xx  drawn in KEGG's colours with NO grey variant — its own script
      //          gates the option on mapno matching /^011/ — so ours compete.
      //   the rest  line art on white, where a colour simply reads.
      const noGrey = /^map012\d\d$/.test(r.id);
      return `Open ${r.id} on KEGG for ${t.samples[c]}, coloured by this sample's ` +
        `ortholog abundances on a log scale` +
        (noGrey ? " — an overview map, which KEGG draws in its own colours and " +
          "offers no grey version, so ours read less clearly there" : "");
    },
  });

  if (summary) {
    const level = funcGrain === "ko" ? "orthologs" : funcGrain === "module" ? "modules"
      : funcGrain === "gmm" ? "gut metabolic modules" : "pathways";
    // The number that must travel with every functional view: most orthologs
    // belong to no module, so a rolled-up table speaks for a fraction of what
    // was measured and has to say which fraction. And it is a DIFFERENT number
    // per level — 28 of the 508 modules appear on no map, so module coverage
    // overstates what a pathway view can speak for, and the GMM catalogue is
    // 442 orthologs against the ~4,300 a gut profile reports.
    const cov = funcGrain === "ko" ? 1
      : funcGrain === "module" ? moduleCoverage(funcProfiles, t.samples, keggMap)
        : funcGrain === "gmm" ? gmmCoverage(funcProfiles, t.samples, gmmDefs)
          : pathwayCoverage(funcProfiles, t.samples, keggMap);
    // Worded like the taxonomic summary — "N rows across M samples" — because it
    // sits in the same place in the same toolbar. Plus the one thing a reader
    // must not assume about a rolled-up level: the rows are not a partition.
    const missing = (view?.samples ?? []).filter((s) => !funcProfiles?.[s]).length;
    summary.textContent =
      `${t.rows.length} ${level} across ${t.samples.length} sample${t.samples.length === 1 ? "" : "s"}` +
      // What the floor took out, and what it was carrying. A filtered table that
      // does not say so is a table claiming to be the measurement — and the
      // second number is the one that matters: 3,500 hidden rows holding 4% of
      // the signal is noise removed, holding 40% would be the answer removed.
      (t.hidden
        ? ` (${t.hidden.toLocaleString()} more below ${t.floor}%, holding ` +
          `${(t.carried * 100).toFixed(1)}% of the table)`
        : "") +
      (funcGrain === "ko"
        ? (t.hidden ? "" : " — every measured ortholog, summing to 100%")
        : funcGrain === "gmm"
          // Not "reaches a module": a GMM value is the median along its covered
          // path, so the column is not a share of anything and adding it up is
          // meaningless. What the percentage says is how much of the measured
          // signal this catalogue can see at all.
          ? ` — the GMM catalogue covers ${(cov * 100).toFixed(0)}% of the measured signal; ` +
            `values are the median along each module's covered path, not shares`
          : ` — ${(cov * 100).toFixed(0)}% of the measured signal reaches a ` +
            `${funcGrain === "module" ? "module" : "pathway map"}; rows overlap, so they do not add to 100%`) +
      // A run where only some samples carry a profile shows a subset. Saying so
      // beats a table that quietly has fewer columns than the one next door.
      (missing ? ` · ${missing} sample${missing === 1 ? " has" : "s have"} no functional profile and ${missing === 1 ? "is" : "are"} not shown` : "");
  }
}

function drawFuncFigure(kind) {
  const canvas = document.getElementById("funcCanvas");
  const dl = document.getElementById("funcFigDownload");
  const note = document.getElementById("funcFigNote");
  if (!canvas) return;
  // Every pixel this draws is KEGG's. The terms are asked in refreshFunc, and
  // this is the only function that can paint them, so it refuses on its own too
  // rather than trusting every future caller to have gone through the gate.
  if (!keggConsent() || !keggMap) return;
  // Closed: the ✕ beside the tabs sets openFuncFig to null, which is the only
  // way to shut a figure now that the tab bar is a radio group.
  if (!kind) {
    canvas.classList.add("hide");
    canvas.innerHTML = "";
    dl?.classList.add("hide");
    document.getElementById("funcFigClose")?.classList.add("hide");
    hideDetail(FUNC_SURFACE);
    if (note) note.textContent = "";
    for (const b of document.querySelectorAll(".func-tab")) b.classList.remove("is-on");
    return;
  }
  const view = lastMatrix ? viewOf(lastMatrix) : null;
  const t = funcTableFor(view, funcGrain);
  canvas.classList.remove("hide");
  canvas.innerHTML = "";
  document.getElementById("funcFigClose")?.classList.remove("hide");

  // The panel FIRST, then the measurement. It sits beside the canvas and takes
  // half the row, so drawing before it appears sizes the figure to a width it is
  // about to lose — a 440 px SVG in a 460 px box with the rest of the card empty
  // under it.
  wireFigure(canvas, funcTableFor(view, "ko"), FUNC_SURFACE);
  if (pickedSample && t.samples.includes(pickedSample)) {
    showPie(funcTableFor(view, "ko"), pickedSample, FUNC_SURFACE);
  } else {
    showDetailPrompt(FUNC_SURFACE);
  }
  const w = Math.max(320, Math.floor(canvas.clientWidth - 20));
  const h = Math.max(300, Math.floor(canvas.clientHeight - 20));
  openFuncFig = kind;
  // What a row IS, at the level on screen. The taxonomic figures name their rows
  // "taxa" in a legend and in a heading, and left at their default a chart of
  // KEGG pathways says "effective number of taxa" and calls its grey remainder
  // "other taxa" — the previous figure's caption showing through this one.
  const unit = funcGrain === "ko" ? "orthologs" : funcGrain === "module" ? "modules"
    : funcGrain === "gmm" ? "gut metabolic modules" : "pathways";
  canvas.innerHTML =
    // Diversity is computed on the ORTHOLOGS whatever level is on screen, and
    // that is not a shortcut. Shannon needs a partition: p_i over disjoint
    // categories summing to one. Orthologs are that — each measured once. Modules
    // and maps are not: an ortholog in three modules is in all three, the column
    // sums to 1.49, and -Σp·ln p over those numbers is not a diversity index, it
    // is arithmetic on a quantity with no meaning. Drawing it under the word
    // "Diversity" because a picker happened to be set to Modules would be a
    // figure that changes what it measures when the reader changes what they
    // look at.
    kind === "alpha" ? alphaSvg(funcTableFor(view, "ko"), { width: w, height: h, unit: "orthologs" })
    // The SAME ordination code as the taxonomic half — the cached layout, the
    // zoom window, the colouring by groups or by computed clusters. Drawn with
    // pcoaSvg directly it had none of them, which is not a design: it is the
    // half that was built second.
    //
    // And the clusters say something here. Taxonomically they recover all six
    // people without being told who is who (k=5, silhouette 0.84, nobody split);
    // functionally they do not (k=3, 0.66 over the orthologs, 0.49 over the
    // modules, with one and two people split). Reading those two plots side by
    // side IS the functional-redundancy result.
    : kind === "pcoa" ? ordinationSvg(t, w, h)
    // Drawn at the level on screen, unlike Diversity: "which pathways differ"
    // is a well-posed question over overlapping categories — a difference in a
    // pathway's abundance is a difference whether or not its orthologs are
    // counted elsewhere too — where an entropy over them is not.
    : kind === "contrast"
      // Same refusal as the taxonomic half, from the same function: a contrast
      // with no groups must ask for them rather than quietly draw the other
      // figure, and it must ask in the half the reader is looking at.
      ? (contrastable(t) || contrastFallback
        ? contrastSvg(t, { width: w, height: h, topN: funcTopNValue, groupOf: metaGroupOf, unit,
          pair: contrastPair, scale: 100, sort: contrastSort,
          stats: contrastStatsFor(t, `func:${funcGrain}`) })
        : contrastRefusalHtml(t))
    : compositionSvg(t, { width: w, height: h, topN: funcTopNValue, otherLabel: `other ${unit}` });
  const funcNeedsGroups = kind === "contrast" && !contrastable(t) && !contrastFallback;
  if (funcNeedsGroups) wireContrastRefusal(canvas, t);
  dl?.classList.toggle("hide", funcNeedsGroups);
  // What the open plot was drawn from, so a zoom or a pan can redraw it without
  // going back through the whole panel.
  if (kind === "pcoa") figView = t;
  paintZoomControls();
  paintTopN();
  paintContrastControls(t);
  paintGroupControls(t);
  syncTopN();
  // "Top 10 taxa" over a chart of KEGG pathways is the other half's caption.
  const unitOut = document.getElementById("funcTopNUnit");
  if (unitOut) unitOut.textContent = unit;
  // Re-wired after the redraw: the listeners were attached to the SVG that has
  // just been replaced. The same two gestures as the taxonomic figures — hover
  // names the mark, a click opens what that sample is made of. Without them the
  // functional points carried tabindex and an aria-label offering to open a
  // composition, and nothing was listening.
  wireFigure(canvas, funcTableFor(view, "ko"), FUNC_SURFACE);
  for (const b of document.querySelectorAll(".func-tab")) {
    b.classList.toggle("is-on", b.dataset.ffig === kind);
  }
  if (note) {
    // What a rolled-up level costs the figure, said under the figure. The
    // orthologs are a partition — each measured once, the column summing to one
    // — and modules and maps are not: an ortholog in three modules is evidence
    // for all three. So a composition bar reaching the right-hand edge is the
    // renormalisation doing that, not the pathways accounting for the sample,
    // and e^Shannon over overlapping categories is a spread, not a count of
    // things present.
    const overlap = funcGrain !== "ko";
    const plain = FIG_PLAIN[kind] ? `${FIG_PLAIN[kind]} ` : "";
    note.textContent = plain + (kind === "composition"
        ? `${t.rows.length} rows, measured from the reads in amino-acid k-mers` +
          (overlap ? ` · each bar is renormalised, because ${unit} overlap and do not sum to the sample`
            : " · every measured ortholog, summing to the whole")
        : kind === "alpha"
          ? `Shannon over the orthologs, which are measured once each and sum to one` +
            (overlap ? ` — not over ${unit}, which overlap: an index over categories that ` +
              `share members is not a diversity index` : "")
          : kind === "contrast"
            ? `${t.rows.length} rows · click a dot for that sample`
          : `${t.rows.length} rows, measured from the reads in amino-acid k-mers` +
            (overlap ? ` · ${unit} overlap` : ""));
  }
}

for (const b of document.querySelectorAll(".func-tab")) {
  // Through refreshFunc, not straight into drawFuncFigure: the gate and the
  // refusal both live in refreshFunc, and a button that draws KEGG data on its
  // own is a way past them. The buttons are hidden in those states now, but a
  // control whose safety depends on being invisible is one stylesheet away from
  // being a hole.
  b.addEventListener("click", () => { openFuncFig = b.dataset.ffig; refreshFunc(); });
}

document.getElementById("funcGrain")?.addEventListener("change", (e) => {
  funcGrain = e.target.value;
  refreshFunc();
});

// The definitions, read here and kept nowhere. `e.target.value = ""` so opening
// the same file twice still fires — a reader who edited it would otherwise get
// silence.
document.getElementById("gmmFile")?.addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  e.target.value = "";
  if (!f) return;
  try {
    const parsed = parseGmms(await f.text());
    if (!parsed.modules.length) throw new Error("no modules in it");
    gmmDefs = parsed;
    gmmName = f.name;
  } catch (err) {
    gmmDefs = null;
    gmmName = "";
    showError(`Could not read ${f.name} as GMM definitions: ${err?.message ?? err}. ` +
      `It should be the tab-delimited GMMs.v1.07.txt from github.com/raeslab/GMMs.`);
  }
  refreshFunc();
});

/** The same file, from the grouping the figures are drawn with. */
const groupsCsv = (samples) => groupsCsvFrom(samples, metaGroups);

/** The function matrix, at the level on screen. Called by the Export menu. */
function downloadFuncMatrix(sep, ext) {
  const view = lastMatrix ? viewOf(lastMatrix) : null;
  if (!view) return;
  const level = funcGrain === "ko" ? "orthologs" : funcGrain === "module" ? "modules" : "pathways";
  // The separator goes IN, so every field is escaped for it. Writing the TSV
  // and swapping tabs for commas afterwards is what broke most rows of the CSV.
  const text = funcMatrixTsv(view, sep);
  saveBlob(text, sep === "\t" ? "text/tab-separated-values" : "text/csv",
    `peekmicrobiome-functions-${level}.${ext}`);
}


