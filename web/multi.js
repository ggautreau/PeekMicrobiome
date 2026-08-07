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
} from "./sylph-worker-rpc.js?v=15";
import {
  dbCacheClient, fmtRate, fmtEta, cacheSummary, assertSameDatabase,
} from "./db-cache.js?v=15";
import { matePattern, stripFastqExt } from "./sample-naming.js?v=15";
import {
  resolveAccession, validateAccession, ASSUMED_BPS,
  downloadEstimate, readCountVerdict, expectedProfiledReads,
} from "./ena.js?v=15";
import {
  fetchCatalog, fallbackCatalog, renderDbSelect, biomeForUrl, biomeNote,
  makeDbRef, sameDbRef, refLine, refShort, refCommentLines, refSlug, genomeCountMismatch,
  rememberBiome, recallBiome, catalogueName, LOCAL_VALUE,
  selectionMatchesLoaded, notLoadedNote, refMetaMismatch,
} from "./biomes.js?v=15";

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
let runManifest = {};         // {filename: {sample, layout, mate?}} — optional
let wasmReady = false;        // at least the first worker's wasm is initialized
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
const currentReads = () => clampReads(els.maxReads.value);
const readsWarn = document.getElementById("readsWarn");
// index.html carries a static "Safe up to 6,000,000 reads" line (the old
// single-ArrayBuffer wall) immediately before #readsWarn, and the warning text
// inside it. Both are now decided here, so rewrite them rather than leave two
// sources of truth to disagree. Guarded: if the markup moves, we simply skip.
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
function refreshPairUnit() {
  const el = els.pairsAsTwo?.closest(".pair-unit");
  if (!el) return;
  el.classList.toggle("hide", !files.some((s) => s.kind === "pe"));
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
  els.maxReads.value = els.maxReadsSlider.value;
  updateReadsState(Number(els.maxReadsSlider.value));
  enaCostChanged();
});
els.maxReads.addEventListener("input", () => {
  const raw = Number(els.maxReads.value);
  if (!Number.isFinite(raw)) return;
  const budget = readsBudget(has64);
  els.maxReadsSlider.value = String(Math.max(READS_MIN, Math.min(budget.sliderMax, raw)));
  updateReadsState(raw);
  enaCostChanged();
});
els.maxReads.addEventListener("change", () => {
  const v = clampReads(els.maxReads.value);
  els.maxReads.value = String(v);
  els.maxReadsSlider.value = String(v);
  updateReadsState(v);
  enaCostChanged();
});
updateReadsState(Number(els.maxReads.value));
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
    showError(`WASM init failed: ${e.message ?? e}`);
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
function paintDbProgress(label, p) {
  const pct = p.total > 0 ? ((p.received ?? 0) / p.total * 100).toFixed(1) : null;
  switch (p.phase) {
    case "probe":
      els.dbInfo.textContent = `Checking ${label} on the server…`;
      break;
    case "start":
      els.dbInfo.textContent = `${p.resumed ? "Resuming" : "Downloading"} ${label} — ${p.note}`;
      break;
    case "download": {
      const speed = Number.isFinite(p.bps) ? ` · ${fmtRate(p.bps)}` : "";
      const eta = Number.isFinite(p.etaSec) ? ` · ${fmtEta(p.etaSec)} left` : "";
      els.dbInfo.textContent =
        `Downloading ${label} — ${fmtBytes(p.received)} / ${fmtBytes(p.total)}` +
        (pct ? ` (${pct}%)` : "") + speed + eta;
      break;
    }
    case "retry":
      els.dbInfo.textContent =
        `Downloading ${label} — ${fmtBytes(p.received)} / ${fmtBytes(p.total)} — ${p.note}`;
      break;
    // Queued behind another tab of this site. Without a line of its own this
    // looks exactly like a freeze, which is what it used to be: the second tab
    // waited 16 s and then gave up.
    case "wait":
      els.dbInfo.textContent = `${label} — ${p.note}`;
      break;
    case "done":
      els.dbInfo.textContent = p.source === "cache"
        ? `${label} found in the local cache (${fmtBytes(p.total)}` +
          `${p.revalidated === false ? ", not revalidated — server unreachable" : ""}) — decoding…`
        : `${label} downloaded (${fmtBytes(p.total)}) — decoding…`;
      break;
  }
}

// Download-or-reuse, exactly once, then hand every worker a way to get the
// bytes locally. Returns the loadFn the pool will run.
async function prepareUrlDb(url, label) {
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
      loadFn = await prepareUrlDb(url, label);
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
    lineage = {};
    if (biome?.lineage) {
      try {
        const lineageResp = await fetch(`./${biome.lineage}`);
        if (lineageResp.ok) lineage = await lineageResp.json();
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
      lineage = {};
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
els.pairsAsTwo?.addEventListener("change", () => {
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
  if (els.enaStatus) els.enaStatus.textContent = `Asking the EBI which runs ${v.acc} covers…`;
  enaAbort = new AbortController();
  try {
    const runs = await resolveAccession(v.acc, { signal: enaAbort.signal });
    enaResolved = runs;
    enaSelected.clear();
    for (const r of runs) if (r.usable) enaSelected.add(r.run);
    const bad = runs.filter((r) => !r.usable).length;
    if (els.enaStatus) {
      els.enaStatus.textContent =
        `${runs.length} run${runs.length === 1 ? "" : "s"} in ${v.acc}` +
        (bad ? ` (${bad} without downloadable FASTQ)` : "");
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
    // Two columns rather than one run-on line: with 85 runs the sizes and read
    // counts are what you scan down, and they only compare if they line up.
    return `<li>
      <label class="ena-pick">
        <input type="checkbox" data-run="${escapeHTML(r.run)}" ${enaSelected.has(r.run) ? "checked" : ""}>
        <span class="ena-id">${escapeHTML(r.run)} <small>${tag}</small></span>
      </label>
      <span class="ena-figs">
        <span class="ena-size">${escapeHTML(size)}</span>
        <span class="ena-reads">${escapeHTML(reads)}</span>
      </span>
      ${notes ? `<span class="ena-note ena-row-note">${escapeHTML(notes)}</span>` : ""}
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
  els.enaAdd.disabled = chosen.length === 0;
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
    s.kind = "se";
    s.seRuns = seRuns.map(x => x.file);
    s.dropped = "";
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
  return `${s.seRuns.length} single-end run${s.seRuns.length === 1 ? "" : "s"} (${fmtBytes(totalBytes)})`;
}

function renderFilesList() {
  renderEnaPending();
  if (files.length === 0) {
    els.filesList.classList.add("hide");
    els.filesList.innerHTML = "";
    els.clearFiles.disabled = true;
    return;
  }
  els.filesList.classList.remove("hide");
  els.clearFiles.disabled = false;
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
      </li>`;
  }).join("");
}

// Anything that is not finished-and-complete can be run again. `failed` was
// missing, and runAll() has always re-queued failures — so the retry path
// existed and the only button that reaches it was greyed out the moment
// nothing was `pending` any more, while the error text on the line said
// "start it again".
const RERUNNABLE = ["pending", "failed", "cancelled", "incomplete"];

// Frozen for the duration of a run, alongside Load database and Threads.
// `maxReads` is read ONCE, when the run starts: moving the slider afterwards
// changes nothing for the samples in flight, so leaving it live would show a
// number that is not the one being used — and could ask for a 32/64-bit build
// switch while the current build is busy profiling.
function setRunControls(running) {
  els.loadDb.disabled = running;
  els.poolSize.disabled = running;
  if (els.maxReads) els.maxReads.disabled = running;
  if (els.maxReadsSlider) els.maxReadsSlider.disabled = running;
  if (els.enaResolve) els.enaResolve.disabled = running;
  if (els.enaAdd) els.enaAdd.disabled = running || enaSelectedRuns().length === 0;
}

function refreshRunButton() {
  const haveSamples = files.length > 0;
  const runnable = haveSamples && files.some(f => RERUNNABLE.includes(f.status));
  els.run.disabled = !(dbMeta && runnable);

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
}

// ---- run all -----------------------------------------------------------------

els.run.addEventListener("click", runAll);
els.cancel.addEventListener("click", () => abortCtrl?.abort());

async function runAll() {
  if (!dbMeta) return;
  els.error.textContent = "";
  els.results.classList.add("hide");
  els.progress.classList.remove("hide");
  els.run.disabled = true;
  els.cancel.disabled = false;
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
    els.cancel.disabled = true;
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

  // Each worker independently drains the shared queue. Two workers run end-
  // to-end (decompress + sylph profile) in parallel.
  async function drain(rpc, slotIdx) {
    while (queue.length > 0 && !abortCtrl.signal.aborted) {
      const s = queue.shift();
      if (!s) break;
      s.status = "running";
      const verb = s.origin === "ena" ? "downloading + decompressing" : "decompressing";
      s.progress = s.kind === "pe" ? `${verb} both mates…` : `${verb}…`;
      renderFilesList();
      setStep(`[w${slotIdx}] ${s.sampleName} — ${verb} + trimming`);

      const t0 = performance.now();
      let wasmTick = null;
      // One more stream on the link, for as long as this sample runs. See
      // noteRate(): a per-stream rate is only a link rate once it is multiplied
      // by the number of streams sharing that link.
      if (s.origin === "ena") netActive++;
      try {
        let tsv, reads;
        function startWasmHeartbeat(label, reads) {
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
            s.progress =
              `${p.reads.toLocaleString()} reads, file ${p.fi + 1}/${seFiles.length} ` +
              `(${fmtBytes(p.bytesIn)} / ${fmtBytes(totalSeBytes)} total)` +
              (p.net ? rate(p.bps) : "");
            renderFilesList();
          };
          ({ tsv, reads } = s.origin === "ena"
            ? await rpc.profileUrls(seFiles.map(toUrlDesc), cap, onProgress, abortCtrl.signal)
            : await rpc.profileFilesMulti(seFiles, cap, onProgress, abortCtrl.signal));
        }

        const rows = parseTsv(tsv);
        s.reads = Number.isFinite(reads) ? reads : undefined;
        // The end-to-end check. Every other guard watches bytes; this one counts
        // what actually came out of the decompressor and compares it with the
        // number the ENA published for the run. A file truncated upstream, with
        // a Content-Length that matches the truncation, passes every byte check
        // there is and fails only here.
        const verdict = s.origin === "ena"
          ? readCountVerdict({ observed: readsShown(s), expected: s.enaReads, maxReads })
          : { ok: true, note: "" };
        s.status = verdict.ok ? "done" : "incomplete";
        s.error = verdict.ok ? undefined : verdict.note;
        s.detected = rows.length;
        s.elapsed = (performance.now() - t0) / 1000;
        s.progress = undefined;
        s.rows = rows;
        sampleOrder.push(s.sampleName);
        mergeRowsIntoMatrix(matrix, s.sampleName, rows);
        // Show the matrix as it fills, rather than at the end. On a project of
        // 85 runs the end is hours away, and the first few samples are usually
        // enough to tell whether the run is worth waiting for. The download
        // buttons work on what is there — the summary says how much that is.
        lastMatrix = matrixToTable(matrix, sampleOrder, runRef);
        renderMatrix(lastMatrix, { done: completed + 1, total: totalTodo });
        if (verdict.ok) okCount++; else shortCount++;
      } catch (e) {
        // Cancelling is not failing. The worker reports an abort as a plain
        // Error("aborted"), so `e.name` is "Error" and the only reliable
        // witness is the signal the user tripped.
        const cancelled = abortCtrl.signal.aborted || e?.name === "AbortError";
        s.status = cancelled ? "cancelled" : "failed";
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

  els.cancel.disabled = true;
  setRunControls(false);
  refreshRunButton();
  if (okCount > 0) {
    lastMatrix = matrixToTable(matrix, sampleOrder, runRef);
    renderMatrix(lastMatrix);
  }
  // Cancelled samples are counted apart from failures: twelve red "failed:
  // aborted" lines after a deliberate click on Cancel is a report of an
  // incident that did not happen.
  setStep(`done — ${okCount} sample${okCount === 1 ? "" : "s"} ok` +
    (shortCount ? `, ${shortCount} incomplete (fewer reads than the ENA lists)` : "") +
    `, ${failCount} failed` +
    (cancelCount ? `, ${cancelCount} cancelled` : "") +
    ` (pool=${rpcs.length})`);
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
      species: lineage[genome] || `(${genome})`,
      relAbund: Number(f[cAbund]) || 0,
      ani: Number(f[cAni]) || 0,
      cov: Number(f[cCov]) || 0,
    };
  });
}

function matrixToTable(matrix, sampleOrder, ref) {
  const rows = Object.entries(matrix).map(([genome, m]) => {
    const values = sampleOrder.map(s => m[s] ?? 0);
    return {
      genome,
      species: m.species,
      values,
      maxAbund: Math.max(...values),
    };
  });
  rows.sort((a, b) => b.maxAbund - a.maxAbund);
  // `ref` travels WITH the numbers, all the way to the exported file.
  return { samples: sampleOrder, rows, ref };
}

// ---- matrix rendering --------------------------------------------------------

// `progress` is passed while a run is still going: the table is shown as it
// fills, and the summary has to say so — a matrix that looks finished but holds
// 3 of 85 samples is worse than no matrix at all, because it will be exported
// and read as the whole thing.
function renderMatrix({ samples, rows, ref }, progress = null) {
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
  els.matrixHead.innerHTML = `
    <tr>
      <th>Species</th>
      <th>Genome</th>
      ${samples.map(s => `<th title="${escapeHTML(s)}">${escapeHTML(s)}</th>`).join("")}
    </tr>`;

  els.matrixBody.innerHTML = rows.map(r => `
    <tr>
      <td class="species" title="${escapeHTML(r.species)}">${escapeHTML(r.species)}</td>
      <td><code>${escapeHTML(r.genome)}</code></td>
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
  const { samples, rows, ref } = lastMatrix;
  const header = ["species", "genome", ...samples];
  const lines = [
    ...refCommentLines(ref, { samples: samples.length, rows: rows.length }),
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
  const overall = (doneCount + currentFracIn) / Math.max(1, totalCount) * 100;
  els.bar.style.width = `${Math.min(100, overall).toFixed(1)}%`;
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
