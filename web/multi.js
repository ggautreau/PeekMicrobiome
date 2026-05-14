// Multi-sample WASM sylph profile: drop N FASTQs → one row per species, one
// column per sample, cells = taxonomic (relative) abundance %.
//
// Memory strategy: hold the database in WASM linear memory once via Profiler,
// then process each FASTQ sequentially. After each sample we drop the
// Uint8Array reference so the GC can reclaim it before the next.
//
// The WASM Profiler runs in a Web Worker — the main thread stays responsive
// while a sample is being sketched/profiled (which can take 5–30 s).

import { sylphWorkerRpc } from "./sylph-worker-rpc.js";

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
  dbSelect: $("dbSelect"), loadDb: $("loadDb"), dbInfo: $("dbInfo"),
};

// `files` is now really a *sample list*. Each entry can hold multiple source
// files (technical replicates of one biological sample). Shape:
//   {
//     kind: "se" | "pe",
//     sampleName,
//     sources: [{ file: File, layout: "SINGLE"|"PAIRED", mate: "1"|"2"|null }],
//     status: "pending"|"running"|"done"|"failed",
//     progress?, detected?, elapsed?, rows?, error?
//   }
let files = [];
let rpc = sylphWorkerRpc();   // WASM Profiler runs in a Web Worker
let dbMeta = null;            // { database_size, k, c, bytes } once loaded
let lineage = {};             // {genome_file: "Species name"}
let runManifest = {};         // {filename: {sample, layout, mate?}} — optional
let wasmReady = false;
let abortCtrl = null;
let lastMatrix = null;        // {samples: string[], rows: [{genome, species, values: number[]}]}

// Try to load the PRJEB83730 manifest — silent if not present.
(async () => {
  try {
    const r = await fetch("./db/prjeb83730.manifest.json");
    if (r.ok) runManifest = await r.json();
  } catch { /* manifest is optional */ }
})();

// ---- WASM init ---------------------------------------------------------------

(async () => {
  try {
    await rpc.init();
    wasmReady = true;
  } catch (e) {
    showError(`WASM init failed: ${e.message ?? e}`);
    console.error(e);
  }
})();

// ---- database loading --------------------------------------------------------

els.loadDb.addEventListener("click", loadDatabase);

async function loadDatabase() {
  els.loadDb.disabled = true;
  els.error.textContent = "";
  const url = els.dbSelect.value;
  const t0 = performance.now();
  els.dbInfo.textContent = `Loading ${url}…`;

  try {
    while (!wasmReady) await new Promise(r => setTimeout(r, 50));

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
        els.dbInfo.textContent = `Loading ${url} — ${fmtBytes(received)} / ${fmtBytes(total)} (${(received/total*100).toFixed(1)}%)`;
      }
    }
    const dbBytes = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { dbBytes.set(c, off); off += c.length; }

    const lineageResp = await fetch("./db/lineage.json");
    if (!lineageResp.ok) throw new Error(`lineage HTTP ${lineageResp.status}`);
    lineage = await lineageResp.json();

    setStep("decoding database in WASM worker…");
    dbMeta = await rpc.loadDb(dbBytes);   // transfers buffer ownership
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    els.dbInfo.textContent =
      `Database ready: ${dbMeta.database_size} genomes, k=${dbMeta.k}, c=${dbMeta.c} ` +
      `(${fmtBytes(dbMeta.bytes)}, loaded in ${dt} s).`;
    refreshRunButton();
  } catch (e) {
    els.dbInfo.textContent = "";
    showError(`Failed to load database: ${e.message ?? e}`);
    console.error(e);
  } finally {
    els.loadDb.disabled = false;
  }
}

// ---- reads slider / number sync ---------------------------------------------
//
// 3M is the safe ceiling that keeps memory under the 4 GB wasm32 limit. The
// slider covers 10k–5M and turns red past 3M. The number input has no upper
// bound so users can attempt larger values manually — they take the risk.

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

els.maxReadsSlider.addEventListener("input", () => {
  els.maxReads.value = els.maxReadsSlider.value;
  updateReadsState(Number(els.maxReadsSlider.value));
});
els.maxReads.addEventListener("input", () => {
  const raw = Number(els.maxReads.value);
  if (!Number.isFinite(raw)) return;
  els.maxReadsSlider.value = String(Math.max(READS_MIN, Math.min(SLIDER_MAX, raw)));
  updateReadsState(raw);
});
els.maxReads.addEventListener("change", () => {
  const v = clampReads(els.maxReads.value);
  els.maxReads.value = String(v);
  els.maxReadsSlider.value = String(v);
  updateReadsState(v);
});
updateReadsState(Number(els.maxReads.value));

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
els.clearFiles.addEventListener("click", () => {
  files = [];
  renderFilesList();
  refreshRunButton();
});

function matePattern(name) {
  const m = name.match(/^(.+?)[._-]R?([12])\.(fastq|fq|fnq)(\.gz)?$/i);
  return m ? { base: m[1], mate: String(m[2]) } : null;
}

function stripFastqExt(name) {
  return name.replace(/\.gz$/i, "").replace(/\.(fastq|fq|fnq)$/i, "");
}

// Find or create a sample entry by name. Pending samples can accept more files;
// completed ones get a new disambiguated copy.
function getOrCreateSample(name) {
  let s = files.find(x => x.sampleName === name && x.status === "pending");
  if (s) return s;
  s = { kind: "se", sampleName: uniqueSampleName(name), sources: [], status: "pending" };
  files.push(s);
  return s;
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
      const s = getOrCreateSample(tag.base);
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
    const label =
      cls === "pending" ? "pending" :
      cls === "running" ? `running (${s.progress ?? ""})` :
      cls === "done" ? `${s.detected ?? 0} species detected in ${s.elapsed?.toFixed(1) ?? "?"} s` :
      cls === "failed" ? `failed: ${s.error}` : "";
    const kindTag = s.kind === "pe" ? " <small>[PE]</small>" : " <small>[SE]</small>";
    return `
      <li class="${cls}">
        <span><strong>${escapeHTML(s.sampleName)}</strong>${kindTag} &mdash; ${fileSummary(s)}</span>
        <span>${escapeHTML(label)}</span>
      </li>`;
  }).join("");
}

function refreshRunButton() {
  els.run.disabled = !(dbMeta && files.length > 0 && files.some(f => f.status === "pending"));
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
  els.loadDb.disabled = true;
  abortCtrl = new AbortController();

  const maxReads = clampReads(els.maxReads.value);
  // Aggregate matrix as we go: { genome_file -> { sampleName -> relAbund } }
  const matrix = {};
  const sampleOrder = [];

  let okCount = 0, failCount = 0;
  for (let i = 0; i < files.length; i++) {
    if (abortCtrl.signal.aborted) break;
    const s = files[i];
    if (s.status === "done") {
      sampleOrder.push(s.sampleName);
      mergeRowsIntoMatrix(matrix, s.sampleName, s.rows);
      continue;
    }
    s.status = "running";
    s.progress = s.kind === "pe" ? "decompressing both mates…" : "decompressing…";
    renderFilesList();
    setStep(`[${i + 1}/${files.length}] ${s.sampleName} — decompressing + trimming`);
    paintOverall(i, files.length, 0);

    const t0 = performance.now();
    let wasmTick = null;
    try {
      let tsv;
      function startWasmHeartbeat(label, reads) {
        const wasmT0 = performance.now();
        wasmTick = setInterval(() => {
          const sec = ((performance.now() - wasmT0) / 1000).toFixed(1);
          s.progress = `sketching ${reads.toLocaleString()} ${label} in WASM worker (${sec} s)`;
          renderFilesList();
          setStep(`[${i + 1}/${files.length}] ${s.sampleName} — WASM compute, ${sec} s`);
        }, 250);
      }
      if (s.kind === "pe") {
        const r1Files = s.peRuns.map(p => p.r1);
        const r2Files = s.peRuns.map(p => p.r2);
        const total1 = r1Files.reduce((a, f) => a + f.size, 0);
        const total2 = r2Files.reduce((a, f) => a + f.size, 0);
        let p1 = { bytesIn: 0, reads: 0, fi: 0 };
        let p2 = { bytesIn: 0, reads: 0, fi: 0 };
        ({ tsv } = await rpc.profileFilesPe(r1Files, r2Files, maxReads, (p) => {
          if (p.phase === "profile_start") { startWasmHeartbeat("pairs", p.reads); return; }
          if (p.mate === 1) p1 = { bytesIn: p.bytesIn, reads: p.reads, fi: p.fi };
          else p2 = { bytesIn: p.bytesIn, reads: p.reads, fi: p.fi };
          const reads = Math.min(p1.reads, p2.reads);
          s.progress =
            `${reads.toLocaleString()} pairs across ${r1Files.length} run${r1Files.length === 1 ? "" : "s"}; ` +
            `R1 file ${p1.fi + 1}/${r1Files.length} ${fmtBytes(p1.bytesIn)}/${fmtBytes(total1)}, ` +
            `R2 file ${p2.fi + 1}/${r2Files.length} ${fmtBytes(p2.bytesIn)}/${fmtBytes(total2)}`;
          renderFilesList();
          paintOverall(i, files.length,
            (p1.bytesIn + p2.bytesIn) / Math.max(1, total1 + total2));
          setStep(`[${i + 1}/${files.length}] ${s.sampleName} — decompress + sketch (PE)`);
        }, abortCtrl.signal));
      } else {
        const seFiles = s.seRuns;
        const totalBytes = seFiles.reduce((a, f) => a + f.size, 0);
        ({ tsv } = await rpc.profileFilesMulti(seFiles, maxReads, (p) => {
          if (p.phase === "profile_start") { startWasmHeartbeat("reads", p.reads); return; }
          s.progress =
            `${p.reads.toLocaleString()} reads, file ${p.fi + 1}/${seFiles.length} ` +
            `(${fmtBytes(p.bytesIn)} / ${fmtBytes(totalBytes)} total)`;
          renderFilesList();
          paintOverall(i, files.length, totalBytes > 0 ? p.bytesIn / totalBytes : 0);
          setStep(`[${i + 1}/${files.length}] ${s.sampleName} — decompress + sketch`);
        }, abortCtrl.signal));
      }

      const rows = parseTsv(tsv);
      s.status = "done";
      s.detected = rows.length;
      s.elapsed = (performance.now() - t0) / 1000;
      s.progress = undefined;
      s.rows = rows;
      sampleOrder.push(s.sampleName);
      mergeRowsIntoMatrix(matrix, s.sampleName, rows);
      okCount++;
    } catch (e) {
      s.status = "failed";
      s.error = (e?.message ?? String(e)).slice(0, 200);
      failCount++;
      if (e?.name === "AbortError") {
        renderFilesList();
        break;
      }
      console.error(e);
    } finally {
      if (wasmTick) { clearInterval(wasmTick); wasmTick = null; }
      renderFilesList();
      paintOverall(i + 1, files.length, 0);
    }
  }

  els.cancel.disabled = true;
  els.loadDb.disabled = false;
  refreshRunButton();
  if (okCount > 0) {
    lastMatrix = matrixToTable(matrix, sampleOrder);
    renderMatrix(lastMatrix);
  }
  setStep(`done — ${okCount} sample${okCount === 1 ? "" : "s"} ok, ${failCount} failed`);
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

function matrixToTable(matrix, sampleOrder) {
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
  return { samples: sampleOrder, rows };
}

// ---- matrix rendering --------------------------------------------------------

function renderMatrix({ samples, rows }) {
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

  els.resultsSummary.textContent =
    `${rows.length} species across ${samples.length} sample${samples.length === 1 ? "" : "s"}`;
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

function downloadMatrix(sep, ext) {
  if (!lastMatrix) return;
  const { samples, rows } = lastMatrix;
  const header = ["species", "genome", ...samples];
  const lines = [header.map(csvEscape(sep)).join(sep)];
  for (const r of rows) {
    lines.push([
      r.species, r.genome,
      ...r.values.map(v => v.toFixed(4))
    ].map(csvEscape(sep)).join(sep));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `abundance_matrix.${ext}`;
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
