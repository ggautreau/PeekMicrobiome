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
} from "./sylph-worker-rpc.js?v=37";
import {
  dbCacheClient, fmtRate, fmtEta, cacheSummary, assertSameDatabase,
} from "./db-cache.js?v=37";
import { matePattern, stripFastqExt } from "./sample-naming.js?v=37";
import {
  resolveAccession, validateAccession, ASSUMED_BPS,
  downloadEstimate, readCountVerdict, expectedProfiledReads,
} from "./ena.js?v=37";
import { normaliseMarkers, screenVerdict, SCREENING_DB, SCREENING_MARKERS } from "./screening.js?v=37";
import {
  fetchCatalog, fallbackCatalog, renderDbSelect, biomeForUrl, biomeNote,
  mgnifyGenomeUrl,
  biomeByKey,
  makeDbRef, sameDbRef, refLine, refShort, refCommentLines, refSlug, genomeCountMismatch,
  rememberBiome, recallBiome, catalogueName, LOCAL_VALUE,
  selectionMatchesLoaded, notLoadedNote, refMetaMismatch,
} from "./biomes.js?v=37";

const $ = (id) => document.getElementById(id);
const els = {
  drop: $("drop"), file: $("file"), dropLabel: $("dropLabel"),
  filesList: $("filesList"),
  maxReads: $("maxReads"), maxReadsSlider: $("maxReadsSlider"),
  run: $("run"), cancel: $("cancel"), clearFiles: $("clearFiles"),
  progress: $("progress"), bar: $("bar"), step: $("step"),
  error: $("error"),
  results: $("results"), resultsSummary: $("resultsSummary"),
  matrixHead: $("matrixHead"), matrixBody: $("matrixBody"),
  downloadTsv: $("downloadTsv"), downloadCsv: $("downloadCsv"),
  dbSelect: $("dbSelect"), loadDb: $("loadDb"), dbInfo: $("dbInfo"), dbFile: $("dbFile"),
  cancelDb: $("cancelDb"), dbCacheInfo: $("dbCacheInfo"), dbBiomeNote: $("dbBiomeNote"),
  matrixRef: $("matrixRef"),
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

(async () => {
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
    const target = Math.max(1, Math.min(8, parseInt(els.poolSize.value, 10) || 1));
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
  const target = Math.max(1, Math.min(8, parseInt(els.poolSize.value, 10) || 1));
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
  setDisabled(els.enaResolve, busy);
  setDisabled(els.enaAdd, busy || (enaSelectedRuns().length === 0
    ? "Tick at least one run in the list above to add it."
    : ""));
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
  const okN = files.filter((f) => f.status === "done").length;
  const badN = files.filter((f) => ["failed", "empty", "incomplete"].includes(f.status)).length;
  const state = [
    dbMeta
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
        ? `${lastMatrix.rows.length} species × ${lastMatrix.samples.length} samples` +
          (badN ? ` · ${badN} need a look` : "")
        : (done[0] && done[1] ? "ready — press Profile all" : "waiting for the two steps above"),
  ];
  for (let i = 0; i < 3; i++) {
    const el = document.getElementById(`stState${i}`);
    if (el) el.textContent = state[i];
    const item = document.querySelector(`.stepper-item[data-goto="${["cardDb", "cardSamples", "results"][i]}"]`);
    if (!item) continue;
    item.classList.toggle("is-done", done[i]);
    // "now" is what the user can act on: both of the first two until each is
    // met, and the third only once they are.
    const now = i < 2 ? !done[i] : (done[0] && done[1] && !done[2]);
    item.classList.toggle("is-now", now);
    item.classList.toggle("is-running", i === 1 && running);
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
        let tsv, reads;
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
          ({ tsv, reads } = s.origin === "ena"
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
          ({ tsv, reads } = s.origin === "ena"
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
        sampleOrder.push(s.sampleName);
        mergeRowsIntoMatrix(matrix, s.sampleName, rows);
        // Show the matrix as it fills, rather than at the end. On a project of
        // 85 runs the end is hours away, and the first few samples are usually
        // enough to tell whether the run is worth waiting for. The download
        // buttons work on what is there — the summary says how much that is.
        lastRaw = { matrix, sampleOrder, ref: runRef,
          refBySample: new Map(files.filter((f) => f.ref).map((f) => [f.sampleName, f.ref])) };
        lastMatrix = matrixToTable(lastRaw.matrix, lastRaw.sampleOrder, lastRaw.ref, lastRaw.refBySample);
        renderMatrix(lastMatrix, { done: completed + 1, total: totalTodo });
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
      refBySample: new Map(files.filter((f) => f.ref).map((f) => [f.sampleName, f.ref])) };
    lastMatrix = matrixToTable(lastRaw.matrix, lastRaw.sampleOrder, lastRaw.ref, lastRaw.refBySample);
    renderMatrix(lastMatrix);
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

function rerankMatrix() {
  const wrap = document.getElementById("rankPickWrap");
  if (wrap) wrap.classList.toggle("hide", !canAggregate() || !lastRaw);
  if (!lastRaw) return;
  lastMatrix = matrixToTable(lastRaw.matrix, lastRaw.sampleOrder, lastRaw.ref, lastRaw.refBySample);
  renderMatrix(lastMatrix);
}
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

function matrixToTable(matrix, sampleOrder, ref, refBySample = new Map()) {
  const rank = currentRank();
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
  // A second header row naming the catalogue each COLUMN was profiled against.
  // With one database loaded it repeats — and that repetition is the point: the
  // reference stops being a line above the table that a screenshot or a copied
  // range leaves behind, and becomes a property of the column. It is also the
  // only thing that could show a mixed matrix if the invariant ever broke.
  const refCells = (refs ?? []).map((r) => {
    const short = r ? refShort(r) : "—";
    return `<th class="matrix-ref" title="${escapeHTML(short)}">${escapeHTML(r?.label || r?.file || "—")}</th>`;
  }).join("");
  els.matrixHead.innerHTML = `
    <tr>
      <th>Species</th>
      <th>Genome</th>
      ${samples.map(s => `<th title="${escapeHTML(s)}">${escapeHTML(s)}</th>`).join("")}
    </tr>
    <tr class="matrix-ref-row">
      <th></th><th>profiled against</th>${refCells}
    </tr>`;

  els.matrixBody.innerHTML = rows.map(r => `
    <tr>
      <td class="species" title="${escapeHTML(r.species)}">${escapeHTML(r.species)}</td>
      <td>${(() => {
        const u = mgnifyGenomeUrl(r.genome);
        const code = `<code>${escapeHTML(r.genome)}</code>`;
        return u
          ? `<a href="${escapeHTML(u)}" target="_blank" rel="noopener noreferrer"
               title="Open ${escapeHTML(r.genome)} on MGnify">${code}</a>`
          : code;
      })()}</td>
      ${r.values.map(v => {
        const display = v > 0 ? v.toFixed(2) : "";
        const bg = v > 0 ? heatColor(v) : "transparent";
        return `<td class="num" style="background:${bg}">${display}</td>`;
      }).join("")}
    </tr>`).join("");

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

els.downloadTsv.addEventListener("click", () => downloadMatrix("\t", "tsv"));
els.downloadCsv.addEventListener("click", () => downloadMatrix(",", "csv"));

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
  const header = ["species", "genome", ...samples];
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

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}
