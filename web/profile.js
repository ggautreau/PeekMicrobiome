// In-browser sylph profile.
//
// Pipeline:
//   1. fetch /db/gut_mini.syldb (~6 MB) and /db/lineage.json once
//   2. user picks a FASTQ; we gunzip if needed and trim to the first N reads
//   3. pass the uncompressed-trimmed bytes to Rust → Profiler.profile()
//   4. parse the TSV it returns, join against the lineage map, render a table

import {
  sylphWorkerRpc, detectMemory64, chooseWasmBits, WORKER_VERSION,
  readsBudget, readsBudgetNote, readsOverBudgetNote, loadedBuildNote, fmtReads,
} from "./sylph-worker-rpc.js?v=37";
import { dbCacheClient, fmtRate, fmtEta, cacheSummary } from "./db-cache.js?v=37";
import {
  fetchCatalog, fallbackCatalog, renderDbSelect, biomeForUrl, biomeNote,
  mgnifyGenomeUrl,
  makeDbRef, refLine, refShort, genomeCountMismatch, rememberBiome, recallBiome,
  catalogueName, LOCAL_VALUE,
  selectionMatchesLoaded, notLoadedNote, refMetaMismatch,
} from "./biomes.js?v=37";

const $ = (id) => document.getElementById(id);
const els = {
  drop: $("drop"), file: $("file"), dropLabel: $("dropLabel"),
  maxReads: $("maxReads"), maxReadsSlider: $("maxReadsSlider"), run: $("run"),
  progress: $("progress"), bar: $("bar"),
  step: $("step"), bytesIn: $("bytesIn"), reads: $("reads"), elapsed: $("elapsed"),
  error: $("error"), results: $("results"), resultsBody: $("resultsBody"),
  dbInfo: $("dbInfo"), memHint: $("memHint"),
  dbSelect: $("dbSelect"), loadDb: $("loadDb"), dbFile: $("dbFile"),
  cancelDb: $("cancelDb"), dbCacheInfo: $("dbCacheInfo"),
  dbBiomeNote: $("dbBiomeNote"), resultsRef: $("resultsRef"),
};

// One resumable, locally-cached download per database — shared with the
// multi-sample page through the same OPFS entries, so a database downloaded on
// one page is instant on the other. See db-cache.js.
const dbc = dbCacheClient({ version: WORKER_VERSION });
let dbAbort = null;
let dbSource = null;      // "cache" | "network" | "memory" | "file"
let persistence = null;

// ---- which biome ---------------------------------------------------------------
//
// One reference database at a time, picked by the user out of db/biomes.json —
// see the header of biomes.js for why they cannot be merged, and why profiling
// against the wrong one is silent rather than loud.
let catalog = null;         // db/biomes.json, normalised
let selectedBiome = null;   // what the picker points at, null for a local file
let currentRef = null;      // what is actually loaded, as makeDbRef() describes it

// See the note in multi.js: since the streaming rework nothing that grows with
// the input lives in JavaScript any more, so the cap is back on the wasm address
// width — 24 M reads at 32 bits, 96 M at 64 bits. The probe below decides which.
const READS_MIN = 10_000;
const clampReads = (v) => Math.max(READS_MIN, Math.floor(Number(v) || 0));
const currentReads = () => clampReads(els.maxReads.value);
const readsWarn = document.getElementById("readsWarn");
// profile.html carries a static "Safe up to 6,000,000 reads" line (the old
// single-ArrayBuffer wall) immediately before #readsWarn, plus the warning text
// inside it. Both are decided here now. Guarded: if the markup moves, we skip.
const staticReadsNote =
  readsWarn?.previousElementSibling?.classList.contains("info")
    ? readsWarn.previousElementSibling : null;
const readsWarnText = readsWarn?.querySelector("span") ?? null;

// The same memory64 probe the worker runs, run here too so the reads control is
// honest from the first paint instead of after the first round-trip. Turned off
// for the session if the worker asks for the 64-bit package and gets 32-bit.
const memory64Probe = detectMemory64();
let has64 = memory64Probe.ok;

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

let selectedFile = null;
let rpc = null;
let dbMeta = null;
let lineage = {};
// Species names carried by more than one genome of the loaded database — GTDB
// reuses them, and the rank fallbacks add more. speciesLabel() appends the
// accession to those, so no two rows of an export share a label.
let ambiguousNames = new Set();

function sharedNames(map) {
  const seen = new Map();
  for (const name of Object.values(map ?? {})) seen.set(name, (seen.get(name) ?? 0) + 1);
  const out = new Set();
  for (const [name, n] of seen) if (n > 1) out.add(name);
  return out;
}

function speciesLabel(genome) {
  const name = lineage[genome] ?? lineage[genome.replace(/\.gz$/i, "")];
  if (!name) return `(${genome})`;
  if (!ambiguousNames.has(name)) return name;
  return `${name} [${String(genome).replace(/\.(fna|fa|fasta)(\.gz)?$/i, "")}]`;
}
let wasmReady = false;
let wasmInfo = null;      // { bits, capped, memory64, reason, pkg } from the worker
let workerBits = null;    // bits the live worker was booted with
let lastDbLoad = null;    // { label, load } — replayed when the build has to change

// Which package the current reads setting calls for. 32-bit unless the run does
// not fit in it AND the browser can do better — see chooseWasmBits().
function plannedBits(maxReads) {
  return chooseWasmBits({ maxReads, memory64: has64 }).bits;
}

// (Re)create the worker for a given reads budget. A module worker has one module
// graph for its whole life, so switching between sylph-pkg/ and sylph-pkg64/
// means a new worker — and a new worker has no database.
async function spawnWorker(maxReads) {
  if (rpc) { rpc.terminate(); rpc = null; dbMeta = null; workerBits = null; }
  rpc = sylphWorkerRpc();
  wasmInfo = await rpc.init(maxReads, plannedBits(maxReads));
  workerBits = wasmInfo.bits;
  if (has64 && wasmInfo.bits === 32 && wasmInfo.capped) {
    // Asked for 64, got 32: either the worker's own probe vetoed it, or
    // sylph-pkg64/ is missing or broken on the server.
    has64 = false;
    showError(`The 64-bit WebAssembly build is not available (${wasmInfo.reason}). ` +
      `Falling back to 32-bit: reads are limited to ${fmtReads(readsBudget(has64).safeMax)}.`);
    console.error(`[profile] ${wasmInfo.reason}`);
    updateReadsState(Number(els.maxReads.value));
  }
}

(async () => {
  try {
    await spawnWorker(currentReads());
    wasmReady = true;
  } catch (e) {
    showError(`WASM init failed: ${e.message ?? e}`);
    console.error(e);
  }
})();

// Called right before a run: if the reads value crossed the 32/64-bit boundary
// since the database was loaded, replace the worker and reload the database
// rather than profile with a build that cannot hold the run.
async function ensureWasmBuildFor(maxReads) {
  if (workerBits === plannedBits(maxReads)) return;
  const to = plannedBits(maxReads);
  if (!lastDbLoad) { await spawnWorker(maxReads); return; }
  setStep(`Reads now ${fmtReads(maxReads)}: switching to the ${to}-bit wasm build ` +
    `and reloading ${lastDbLoad.label}…`);
  els.dbInfo.textContent = `Switching to the ${to}-bit wasm build (reads changed)…`;
  await spawnWorker(maxReads);
  // Local read, no network: the new worker takes the database out of the OPFS
  // cache (or, on the fallback path, out of the buffer this page already holds).
  dbMeta = await lastDbLoad.load(rpc);
  if (dbSource === "network") dbSource = "cache";
  revalidateRefAfterReload();
  describeDb(lastDbLoad.label, null);
}

// The bytes that come back from a reload are not necessarily the bytes the
// reference was minted from: another tab of this site may have invalidated and
// rewritten the cache entry for that URL in between. Nothing else can notice —
// there is one worker here, so there is nothing to compare it with except what
// this page still claims. See the same function in multi.js.
function revalidateRefAfterReload() {
  if (!currentRef || !dbMeta) return;
  const drift = refMetaMismatch(currentRef, dbMeta);
  if (!drift) return;
  currentRef = makeDbRef({
    biome: lastDbLoad?.biome ?? null,
    dbMeta,
    label: lastDbLoad?.label ?? currentRef.file,
    source: dbSource,
    url: lastDbLoad?.url ?? currentRef.url,
  });
  // A result on screen came from the database that WAS there. It is not this one.
  els.results.classList.add("hide");
  showError(`The database re-read from the local cache is not the one that was loaded ` +
    `(${drift}). Another tab replaced the cached copy at that URL. The reference has been ` +
    `updated to the database now in memory, and the result on screen was hidden: it was ` +
    `profiled against the previous one.`);
  paintBiomeNote();
}

// The database line, plus which wasm build is behind it. The build decides
// whether the reads setting is reachable at all, and on a browser without
// memory64 this is the only place a user can find out why they cannot go higher.
function describeDb(label, seconds) {
  if (!dbMeta) return;
  const when = seconds == null ? "" : `, loaded in ${seconds.toFixed(1)} s`;
  const build = wasmInfo ? ` — ${loadedBuildNote(wasmInfo.bits, has64)}` : "";
  // Where the bytes came from: the difference between a five-minute wait and an
  // instant one, and the only visible sign the local cache is working.
  const from =
    dbSource === "cache" ? " · loaded from local cache" :
    dbSource === "network" ? " · downloaded and cached locally" :
    dbSource === "memory" ? " · downloaded (not cached: this browser has no OPFS)" : "";
  // The BIOME first: it is the one fact on this line that decides whether the
  // numbers underneath mean anything.
  const who = refShort(currentRef) || label;
  els.dbInfo.textContent =
    `Database ready — ${who}${from}: ${dbMeta.database_size} genomes, ` +
    `k=${dbMeta.k}, c=${dbMeta.c} (${fmtBytes(dbMeta.bytes)}${when})${build}.`;
  // The catalogue says how many genomes are in this database; sylph says how
  // many it loaded. A disagreement means the file behind that URL is not the one
  // the entry describes, and the biome label cannot be trusted.
  const mismatch = genomeCountMismatch(currentRef);
  if (mismatch) showError(mismatch);
}

// ---- the biome picker ---------------------------------------------------------
//
// Built from db/biomes.json (grouped by family); profile.html ships a two-entry
// fallback in the markup for the case where that file cannot be read, so the
// page never ends up with an empty database picker.

function pickedBiome() {
  const v = els.dbSelect?.value ?? "";
  if (!v || v === LOCAL_VALUE) return null;
  return biomeForUrl(catalog ?? fallbackCatalog(), v);
}

// See multi.js: this line describes the SELECTION, and a selection is not a
// state. Once a database is in memory, moving the picker off it made this line
// claim in the present tense that results are reported against a catalogue that
// nothing was profiled against, while the status line above still named the real
// one. When they differ, the loaded database is named first.
function paintBiomeNote() {
  if (!els.dbBiomeNote) return;
  selectedBiome = pickedBiome();
  const local = (els.dbSelect?.value ?? "") === LOCAL_VALUE;
  const pending = !selectionMatchesLoaded(currentRef, selectedBiome, local);
  const txt = local
    ? "A .syldb from your own disk. This page cannot tell which catalogue it was built " +
      "from, so the status line and the results will say the biome is unknown — which is " +
      "the honest answer, and the reason to keep a note of it yourself."
    : biomeNote(selectedBiome, { pending });
  const full = pending ? `${notLoadedNote(currentRef)} ${txt}` : txt;
  els.dbBiomeNote.textContent = full;
  els.dbBiomeNote.classList.toggle("hide", !full);
  els.dbBiomeNote.classList.toggle("db-note-pending", pending);
}

els.dbSelect?.addEventListener("change", () => {
  paintBiomeNote();
  if (selectedBiome) rememberBiome(selectedBiome.key);
  renderCacheInfo();
});

(async () => {
  try {
    catalog = await fetchCatalog();
  } catch (e) {
    catalog = fallbackCatalog();
    console.warn("[profile] db/biomes.json could not be read — falling back to the built-in list", e);
  }
  selectedBiome = renderDbSelect(els.dbSelect, catalog, { selected: recallBiome() });
  paintBiomeNote();
  renderCacheInfo();
})();

// ---- database loading (user-triggered, can be ~430 MB) -------------------------

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

// The download line. The full database is a five-minute download at the
// measured 1.48 MB/s, and five minutes of an unchanging "Loading…" is
// indistinguishable from a crash — so this reports bytes, rate and time left,
// and there is a Cancel button beside it.
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
    // Queued behind another tab of this site (the multi-sample page, typically).
    // Without a line of its own this looks exactly like a freeze.
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

els.cancelDb?.addEventListener("click", () => {
  els.cancelDb.disabled = true;
  dbAbort?.abort();
});

async function loadDatabase() {
  els.loadDb.disabled = true;
  els.error.textContent = "";
  const url = els.dbSelect.value;
  const t0 = performance.now();

  try {
    while (!wasmReady) await new Promise(r => setTimeout(r, 50));

    // The wasm package is chosen here, from the reads setting: this is the last
    // moment at which the choice is free. After this the database lives in the
    // worker's linear memory and changing builds means loading it again.
    //
    // Only the WORKER is replaced, deliberately not ensureWasmBuildFor(): that
    // function's job is to re-load the database that is currently in use, and
    // here the user is about to replace it. Calling it re-read the OLD database
    // — up to 433 MB out of OPFS and a full Profiler built in wasm, several
    // seconds and ~900 MB of peak — three lines before throwing it away.
    if (workerBits !== plannedBits(currentReads())) {
      els.dbInfo.textContent = `Preparing the ${plannedBits(currentReads())}-bit wasm build…`;
      await spawnWorker(currentReads());
      dbMeta = null;
      lastDbLoad = null;
    }

    // Read ONCE, here: the status line and the results header describe the
    // database that is about to be loaded, not whatever the picker says later.
    const biome = pickedBiome();

    let label;
    if (url === LOCAL_VALUE) {
      const file = await pickLocalDb();
      if (!file) { els.dbInfo.textContent = "No file selected."; return; }
      label = file.name;
      dbSource = "file";
      // loadDbFile keeps the read inside the worker, and is replayable by
      // ensureWasmBuildFor without asking the user to pick the file again.
      lastDbLoad = { label, biome, url, load: (r) => r.loadDbFile(file) };
      els.dbInfo.textContent = `Reading ${label} (${fmtBytes(file.size)})…`;
    } else {
      // Named by biome wherever there is one: a five-minute progress line that
      // says "content (zenodo.org)" names neither what is coming nor whether it
      // is the right thing.
      label = biome ? `${biome.label} (${biome.file})` : dbLabel(url);
      const abs = new URL(url, location.href).href;
      dbAbort = new AbortController();
      els.cancelDb?.classList.remove("hide");
      if (els.cancelDb) els.cancelDb.disabled = false;
      try {
        if (persistence === null) persistence = await dbc.requestPersistence();
        // ONE download, in slices, resumable, written straight into OPFS. The
        // old code here read the whole body into an array of chunks and then
        // copied them into one 433 MB buffer on the main thread — no resume, no
        // reuse on the next visit, and a second full download whenever the wasm
        // build had to change.
        const res = await dbc.ensure(abs, {
          onProgress: (p) => paintDbProgress(label, p),
          signal: dbAbort.signal,
        });
        dbSource = res.opfs ? res.source : "memory";
        // `biome` and `url` travel with it: a build switch replays this load,
        // and a replay that forgot which catalogue it came from would relabel
        // the reference as a local file.
        lastDbLoad = res.opfs
          ? { label, biome, url, load: (r) => r.loadDbCached(abs) }
          // No OPFS: one download, held here, copied per worker. A replay after
          // a build switch still costs nothing on the network.
          : { label, biome, url, load: (r) => r.loadDb(res.bytes.slice()) };
      } finally {
        els.cancelDb?.classList.add("hide");
        dbAbort = null;
      }
    }

    // One lineage map per catalogue: the gut map names gut genomes and says
    // nothing about soil ones. Loaded only when the entry declares one, and
    // cleared otherwise, so the previous biome's names can never be pinned onto
    // this one's genomes. With no map the table shows genome accessions.
    lineage = {}; ambiguousNames = new Set();
    if (biome?.lineage) {
      try {
        const lineageResp = await fetch(`./${biome.lineage}`);
        if (lineageResp.ok) { lineage = await lineageResp.json(); ambiguousNames = sharedNames(lineage); }
      } catch { /* leave lineage empty: genome accessions instead of names */ }
    }

    els.dbInfo.textContent = `Decoding database in WASM worker…`;
    dbMeta = await lastDbLoad.load(rpc);
    // The identity of what is now in the worker. Everything that names the
    // reference — the status line, the results header — reads this.
    currentRef = makeDbRef({ biome, dbMeta, label, source: dbSource, url });
    // A result on screen was profiled against the database that was loaded THEN.
    // Loading another one makes it stale, and a stale table under a fresh
    // reference is the exact mistake this page is trying to make impossible.
    els.results.classList.add("hide");
    describeDb(label, (performance.now() - t0) / 1000);
    if (selectedFile) els.run.disabled = false;
  } catch (e) {
    els.dbInfo.textContent = "";
    if (e?.name === "AbortError") {
      els.dbInfo.textContent = "Download cancelled — the bytes already fetched are kept, " +
        "clicking Load database again resumes where it stopped.";
    } else {
      // Failure is total. lastDbLoad was already pointing at the NEW database by
      // the time the load threw, so leaving dbMeta and currentRef describing the
      // OLD one would let the next run profile against whatever the worker holds
      // and name it something else — and a build switch would replay the load
      // that just failed. Nothing loaded, no reference, no replay.
      dbMeta = null;
      currentRef = null;
      lastDbLoad = null;
      lineage = {}; ambiguousNames = new Set(); ambiguousNames = new Set();
      els.run.disabled = true;
      els.results.classList.add("hide");
      els.dbInfo.textContent =
        "No database is loaded — the load failed part-way through, so everything it had " +
        "started on was dropped rather than left half-done. Click \"Load database\" to try again.";
      showError(`Failed to load database: ${e.message ?? e}`);
      console.error(e);
    }
  } finally {
    els.loadDb.disabled = false;
    // The note under the picker asserts things about what is loaded, and what is
    // loaded has just changed (or been dropped).
    paintBiomeNote();
    renderCacheInfo();
  }
}

// ---- what is cached, and how to get rid of it --------------------------------

// Same URL whatever form it was written in — the cache stores absolute URLs,
// the catalogue may hold a relative one for the bundled database.
function sameUrl(a, b) {
  if (!a || !b) return false;
  try { return new URL(a, location.href).href === new URL(b, location.href).href; }
  catch { return a === b; }
}

// Several biomes can sit in the cache at once (it is keyed by URL). Listed by
// file name alone they read as "gut.syldb", "soil.syldb", "marine.syldb" —
// which is how the wrong 2.8 GB gets deleted.
function cacheEntryName(e) {
  const b = e.url ? biomeForUrl(catalog ?? fallbackCatalog(), e.url) : null;
  if (b) return `${b.label} — ${catalogueName(b)} (${b.file})`;
  return e.url ? dbLabel(e.url) : e.key;
}

async function renderCacheInfo() {
  if (!els.dbCacheInfo) return;
  let entries = [];
  try { entries = (await dbc.list()).entries ?? []; } catch { /* no OPFS */ }
  if (!entries.length) { els.dbCacheInfo.innerHTML = ""; return; }
  const est = await dbc.estimate();
  // Asked, not remembered — see the note in multi.js.
  const persisted = persistence?.persisted ?? await dbc.persisted();
  els.dbCacheInfo.innerHTML =
    `<div><strong>Cached on this computer</strong> ` +
    `(${cacheSummary({ estimate: est, persisted, entries })}):</div>` +
    entries.map(e => {
      // Deleted by KEY, not by URL: an entry whose meta.json is unreadable has
      // no URL, and that is precisely the entry a user needs to be able to
      // remove.
      const name = escapeHTML(cacheEntryName(e));
      // Whether clicking Load database now costs a download or nothing at all.
      const picked = e.complete && sameUrl(e.url, els.dbSelect?.value)
        ? ` — <strong>the biome selected above: it will load from here, nothing to download</strong>`
        : "";
      const state = (e.complete
        ? fmtBytes(e.bytes)
        : `${fmtBytes(e.bytes)} of ${e.size ? fmtBytes(e.size) : "?"} — incomplete, will resume`)
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
  // See multi.js: a failed removal (a download still holds the entry's exclusive
  // handle) must say so instead of silently redrawing the same list.
  const { removed } = await dbc.remove({ key: btn.dataset.cacheKey });
  if (!removed) {
    btn.disabled = false;
    showError("This database could not be deleted — a download of it is probably still " +
      "running. Cancel the download first, then delete it.");
  }
  await renderCacheInfo();
});

renderCacheInfo();

// ---- file selection -------------------------------------------------------------

["dragenter", "dragover"].forEach(ev =>
  els.drop.addEventListener(ev, e => { e.preventDefault(); els.drop.classList.add("over"); })
);
["dragleave", "drop"].forEach(ev =>
  els.drop.addEventListener(ev, e => { e.preventDefault(); els.drop.classList.remove("over"); })
);
els.drop.addEventListener("drop", e => {
  e.preventDefault();
  if (e.dataTransfer.files.length) selectFile(e.dataTransfer.files[0]);
});
els.file.addEventListener("change", () => {
  if (els.file.files.length) selectFile(els.file.files[0]);
});

function selectFile(f) {
  selectedFile = f;
  els.dropLabel.innerHTML = `<strong>${escapeHTML(f.name)}</strong> &mdash; ${fmtBytes(f.size)}`;
  els.run.disabled = !dbMeta;
  els.error.textContent = "";
  els.results.classList.add("hide");
}

// Peak wasm linear memory, straight off the ceiling runs rather than modelled.
// The FASTQ is no longer held anywhere — the streaming sketcher never
// materialises it — so the only term that grows with the input is the sketch
// state, and it is linear: the reserved-memory ladder measured at 7 M / 13 M /
// 25 M reads gives 90.7 MB per million reads with a 175 MB intercept (module +
// database + working buffers), to three matching digits on both builds.
//
// That slope is the WORST case on purpose: 150 bp reads, all distinct, matching
// nothing. Real, redundant gut data measures around 25 MB per million.
// (No constants here any more — the figures above are kept as the record of what
// was measured, and are what WASM32_SAFE_READS / WASM64_SAFE_READS were derived
// from. Re-measure them before moving either ceiling.)

// Time, not memory. Memory used to be what this control was about — at 3 M reads
// it decided whether the run survived. It no longer is: the ceiling now sits at
// 24 M reads (32-bit) or 96 M (64-bit) and the note above states it. What the
// user actually trades at this slider is minutes against sensitivity, so that is
// what gets estimated.
//
// SKETCH_READS_PER_S is measured on this codebase: 382,609 reads/s at 32 bits,
// 376,068 at 64 bits, both on 150 bp single-end reads. It is the read-scanning
// half and does not depend on the database. The inference pass that follows does
// — it walks every genome — so it is named rather than guessed at: on the 50
// genomes of the smoke-test database it is seconds, on the 4,744 of the full UHGG
// database it is the larger share for small samples.
const SKETCH_READS_PER_S = 380_000;

function updateMemHint(n) {
  const sketchS = n / SKETCH_READS_PER_S;
  const t = sketchS >= 90 ? `${Math.round(sketchS / 60)} min` : `${Math.round(sketchS)} s`;
  els.memHint.textContent =
    `About ${t} to read ${n.toLocaleString()} reads, plus the profiling pass against the ` +
    `database (which grows with the number of genomes in it, not with the number of reads). ` +
    `Paired-end reads both mates, so roughly twice that.`;
}

els.maxReadsSlider.addEventListener("input", () => {
  const v = Number(els.maxReadsSlider.value);
  els.maxReads.value = String(v);
  updateMemHint(v);
  updateReadsState(v);
});
els.maxReads.addEventListener("input", () => {
  const raw = Number(els.maxReads.value);
  if (!Number.isFinite(raw)) return;
  els.maxReadsSlider.value =
    String(Math.max(READS_MIN, Math.min(readsBudget(has64).sliderMax, raw)));
  updateMemHint(raw > 0 ? raw : 1);
  updateReadsState(raw);
});
els.maxReads.addEventListener("change", () => {
  const v = clampReads(els.maxReads.value);
  els.maxReads.value = String(v);
  els.maxReadsSlider.value = String(v);
  updateMemHint(v);
  updateReadsState(v);
});
updateMemHint(currentReads());
updateReadsState(Number(els.maxReads.value));

// ---- run -----------------------------------------------------------------------

els.run.addEventListener("click", run);

async function run() {
  if (!selectedFile || !dbMeta) return;
  els.error.textContent = "";
  els.results.classList.add("hide");
  els.progress.classList.remove("hide");
  els.run.disabled = true;

  const maxReads = clampReads(els.maxReads.value || 1_000_000);
  const t0 = performance.now();
  setStep("decompressing, keeping the first N reads…");

  let lastReadsSeen = 0;
  let wasmTick = null;
  try {
    // The reads value may have crossed the 32/64-bit boundary since the database
    // was loaded. A worker cannot swap its wasm package, so this replaces it and
    // reloads the database before a single read is sketched.
    await ensureWasmBuildFor(maxReads);

    // The worker now does decompression + trim + profile end-to-end. Main
    // thread keeps no read buffer; we just relay progress events to the UI.
    const { tsv, reads, elapsedMs } = await rpc.profileFile(
      selectedFile, maxReads,
      (p) => {
        if (p.phase === "profile_start") {
          // Worker just handed the capped bytes to sylph. The wasm call is
          // synchronous in the worker — drive a heartbeat from the main
          // thread so the user sees the elapsed counter moving.
          paintProgress(100, selectedFile.size, selectedFile.size, p.reads, maxReads, t0);
          const wasmT0 = performance.now();
          wasmTick = setInterval(() => {
            const sec = ((performance.now() - wasmT0) / 1000).toFixed(1);
            setStep(`sketching + profiling ${p.reads.toLocaleString()} reads in WASM worker (${sec} s)`);
            els.elapsed.textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`;
          }, 250);
          return;
        }
        lastReadsSeen = p.reads;
        const pct = p.total > 0 ? Math.min(100, (p.bytesIn / p.total) * 100) : 0;
        paintProgress(pct, p.bytesIn, p.total, p.reads, maxReads, t0);
        setStep("decompressing in worker, keeping the first N reads…");
      },
    );
    paintProgress(100, selectedFile.size, selectedFile.size, reads ?? lastReadsSeen, maxReads, t0);
    renderResults(tsv);
    setStep(`done in ${((performance.now() - t0) / 1000).toFixed(1)} s (worker ${(elapsedMs / 1000).toFixed(1)} s)`);
  } catch (e) {
    showError(`${e.message ?? e}\n\nCheck DevTools console for details.`);
    console.error(e);
  } finally {
    if (wasmTick) clearInterval(wasmTick);
    els.run.disabled = false;
  }
}

// Streaming decompression + trim now lives in the worker (see fastq-trim.js
// and sylph-worker.js). Main thread just sends the File handle to the worker
// and consumes progress events.

// ---- output rendering ----------------------------------------------------------

function renderResults(tsv) {
  // The reference, above the rows, every time they are drawn. Nothing in a list
  // of species names says which catalogue they came out of.
  if (els.resultsRef) {
    const line = refLine(currentRef);
    els.resultsRef.textContent = line
      ? `Profiled against ${line}. Abundances are relative to this catalogue only.`
      : "";
    els.resultsRef.classList.toggle("hide", !line);
    els.resultsRef.classList.toggle("db-ref-local", !!currentRef?.local);
  }
  const lines = tsv.trim().split("\n");
  if (lines.length < 2) {
    els.resultsBody.innerHTML = `<tr><td colspan="6">No genomes passed the profiling threshold.</td></tr>`;
    els.results.classList.remove("hide");
    return;
  }
  const header = lines[0].split("\t");
  const idx = (name) => header.indexOf(name);
  const cols = {
    relAbund: idx("Taxonomic_abundance"),
    seqAbund: idx("Sequence_abundance"),
    ani: idx("Adjusted_ANI"),
    cov: idx("Eff_cov"),
    genomeFile: idx("Genome_file"),
  };

  const rows = lines.slice(1).map((l) => l.split("\t"));
  els.resultsBody.innerHTML = rows.map((r) => {
    const gname = (r[cols.genomeFile] || "").split("/").pop();
    // Same two conventions as multi.js: the eighteen biome databases report
    // "MGYG….fna.gz", the older human-gut one "MGYG….fna", and the maps hold
    // the un-gzipped form. speciesLabel() also disambiguates the names GTDB
    // gives to more than one genome, so no two rows share a label.
    const species = speciesLabel(gname);
    const mgnify = mgnifyGenomeUrl(gname);
    return `
      <tr>
        <td class="num">${fmtPct(r[cols.relAbund])}</td>
        <td class="num">${fmtPct(r[cols.seqAbund])}</td>
        <td class="num">${r[cols.ani] ?? ""}</td>
        <td class="num">${r[cols.cov] ?? ""}</td>
        <td>${mgnify
          ? `<a href="${escapeHTML(mgnify)}" target="_blank" rel="noopener noreferrer"
               title="Open ${escapeHTML(gname)} on MGnify"><code>${escapeHTML(gname)}</code></a>`
          : `<code>${escapeHTML(gname)}</code>`}</td>
        <td>${escapeHTML(species)}</td>
      </tr>`;
  }).join("");
  els.results.classList.remove("hide");
}

function fmtPct(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) + " %" : (v ?? "");
}

// ---- chrome ---------------------------------------------------------------------

function setStep(s) { els.step.textContent = s; }
function showError(s) { els.error.textContent = s; }
function paintProgress(pct, bytesIn, totalBytes, reads, maxReads, t0) {
  els.bar.style.width = pct.toFixed(1) + "%";
  els.bytesIn.textContent = `${fmtBytes(bytesIn)} / ${fmtBytes(totalBytes)}`;
  els.reads.textContent = `${reads.toLocaleString()} / ${maxReads.toLocaleString()}`;
  els.elapsed.textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`;
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
