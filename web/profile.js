// In-browser sylph profile.
//
// Pipeline:
//   1. fetch /db/gut_mini.syldb (~6 MB) and /db/lineage.json once
//   2. user picks a FASTQ; we gunzip if needed and trim to the first N reads
//   3. pass the uncompressed-trimmed bytes to Rust → Profiler.profile()
//   4. parse the TSV it returns, join against the lineage map, render a table

import { sylphWorkerRpc } from "./sylph-worker-rpc.js";

const $ = (id) => document.getElementById(id);
const els = {
  drop: $("drop"), file: $("file"), dropLabel: $("dropLabel"),
  maxReads: $("maxReads"), maxReadsSlider: $("maxReadsSlider"), run: $("run"),
  progress: $("progress"), bar: $("bar"),
  step: $("step"), bytesIn: $("bytesIn"), reads: $("reads"), elapsed: $("elapsed"),
  error: $("error"), results: $("results"), resultsBody: $("resultsBody"),
  dbInfo: $("dbInfo"), memHint: $("memHint"),
  dbSelect: $("dbSelect"), loadDb: $("loadDb"),
};

const READS_MIN = 10_000;
const READS_SAFE = 3_000_000;
const SLIDER_MAX = 5_000_000;
const clampReads = (v) => Math.max(READS_MIN, Math.floor(Number(v) || 0));
const readsWarn = document.getElementById("readsWarn");

function updateReadsState(v) {
  const over = v > READS_SAFE;
  els.maxReadsSlider.classList.toggle("over-limit", over);
  if (readsWarn) readsWarn.classList.toggle("hide", !over);
}

let selectedFile = null;
let rpc = sylphWorkerRpc();
let dbMeta = null;
let lineage = {};
let wasmReady = false;

(async () => {
  try {
    await rpc.init();
    wasmReady = true;
  } catch (e) {
    showError(`WASM init failed: ${e.message ?? e}`);
    console.error(e);
  }
})();

// ---- database loading (user-triggered, can be ~430 MB) -------------------------

els.loadDb.addEventListener("click", loadDatabase);

async function loadDatabase() {
  els.loadDb.disabled = true;
  els.error.textContent = "";
  const url = els.dbSelect.value;
  const t0 = performance.now();
  els.dbInfo.textContent = `Loading ${url}…`;

  try {
    while (!wasmReady) await new Promise(r => setTimeout(r, 50));

    // Stream the response so we can show download progress.
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const total = Number(resp.headers.get("content-length") || 0);
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total > 0) {
        const pct = (received / total * 100).toFixed(1);
        els.dbInfo.textContent =
          `Loading ${url} — ${fmtBytes(received)} / ${fmtBytes(total)} (${pct}%)`;
      } else {
        els.dbInfo.textContent = `Loading ${url} — ${fmtBytes(received)}`;
      }
    }
    const dbBytes = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { dbBytes.set(c, off); off += c.length; }

    // Lineage is small — fetch in parallel? simpler: serial after.
    const lineageResp = await fetch("./db/lineage.json");
    if (!lineageResp.ok) throw new Error(`lineage HTTP ${lineageResp.status}`);
    lineage = await lineageResp.json();

    els.dbInfo.textContent = `Decoding database in WASM worker…`;
    dbMeta = await rpc.loadDb(dbBytes);
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    els.dbInfo.textContent =
      `Database ready: ${dbMeta.database_size} genomes, k=${dbMeta.k}, c=${dbMeta.c} ` +
      `(${fmtBytes(dbMeta.bytes)}, loaded in ${dt} s).`;
    if (selectedFile) els.run.disabled = false;
  } catch (e) {
    els.dbInfo.textContent = "";
    showError(`Failed to load database: ${e.message ?? e}`);
    console.error(e);
  } finally {
    els.loadDb.disabled = false;
  }
}

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

function updateMemHint(n) {
  // Rough planning estimate only — assumes ~150 bp single-end Illumina reads
  // (~360 B per FASTQ record), plus ~600 MB baseline for the database, sketches,
  // wasm module and working buffers. Long reads or paired-end can multiply the
  // per-read figure 2–3× or more.
  const ramGB = (n * 360 + 600 * 1024 * 1024) / (1024 ** 3);
  els.memHint.textContent =
    `Rough estimate: ≳${ramGB.toFixed(1)} GB peak browser memory at ${n.toLocaleString()} reads ` +
    `(assumes short single-end reads; long or paired reads can use 2–3× more).`;
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
  els.maxReadsSlider.value = String(Math.max(READS_MIN, Math.min(SLIDER_MAX, raw)));
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
  setStep("decompressing + trimming to first N reads…");

  let lastReadsSeen = 0;
  let wasmTick = null;
  try {
    // The worker now does decompression + trim + profile end-to-end. Main
    // thread keeps no read buffer; we just relay progress events to the UI.
    const { tsv, reads, elapsedMs } = await rpc.profileFile(
      selectedFile, maxReads,
      (p) => {
        if (p.phase === "profile_start") {
          // Worker just handed the trimmed bytes to sylph. The wasm call is
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
        setStep("decompressing + trimming to first N reads in worker…");
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
    const species = lineage[gname] || `(${gname})`;
    return `
      <tr>
        <td class="num">${fmtPct(r[cols.relAbund])}</td>
        <td class="num">${fmtPct(r[cols.seqAbund])}</td>
        <td class="num">${r[cols.ani] ?? ""}</td>
        <td class="num">${r[cols.cov] ?? ""}</td>
        <td><code>${escapeHTML(gname)}</code></td>
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
