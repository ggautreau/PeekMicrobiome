// FASTQ downsampler — streams a (possibly gzipped) FASTQ and writes back the
// first N records. Byte-exact: we cut after the (4 * N)-th newline in the
// decompressed stream, so we don't allocate per-record and don't decode UTF-8.

const $ = (id) => document.getElementById(id);
const els = {
  drop: $('drop'), file: $('file'), dropLabel: $('dropLabel'),
  maxReads: $('maxReads'), gzip: $('gzip'),
  run: $('run'), cancel: $('cancel'),
  progress: $('progress'), bar: $('bar'),
  bytesIn: $('bytesIn'), reads: $('reads'), rate: $('rate'), elapsed: $('elapsed'),
  error: $('error'), done: $('done'),
};

let selectedFile = null;
let abortCtrl = null;

// ---- file selection ----------------------------------------------------------

['dragenter', 'dragover'].forEach(ev =>
  els.drop.addEventListener(ev, e => { e.preventDefault(); els.drop.classList.add('over'); })
);
['dragleave', 'drop'].forEach(ev =>
  els.drop.addEventListener(ev, e => { e.preventDefault(); els.drop.classList.remove('over'); })
);
els.drop.addEventListener('drop', e => {
  e.preventDefault();
  if (e.dataTransfer.files.length) selectFile(e.dataTransfer.files[0]);
});
els.file.addEventListener('change', () => {
  if (els.file.files.length) selectFile(els.file.files[0]);
});

function selectFile(f) {
  selectedFile = f;
  els.dropLabel.innerHTML = `<strong>${escapeHTML(f.name)}</strong> &mdash; ${fmtBytes(f.size)}`;
  els.run.disabled = false;
  els.error.textContent = '';
  els.done.classList.add('hide');
}

// ---- run / cancel ------------------------------------------------------------

els.run.addEventListener('click', run);
els.cancel.addEventListener('click', () => abortCtrl?.abort());

async function run() {
  if (!selectedFile) return;
  els.error.textContent = '';
  els.done.classList.add('hide');
  els.progress.classList.remove('hide');
  els.run.disabled = true;
  els.cancel.disabled = false;
  abortCtrl = new AbortController();

  const maxReads = Math.max(1, Math.floor(Number(els.maxReads.value) || 5_000_000));
  const wantGzip = els.gzip.checked;
  const outName = makeOutputName(selectedFile.name, maxReads, wantGzip);

  // Collect output in memory; auto-download when finished.
  const chunks = [];
  const writable = new WritableStream({
    write(chunk) { chunks.push(chunk); },
  });

  try {
    const stats = await downsample(selectedFile, maxReads, wantGzip, writable, abortCtrl.signal);
    triggerDownload(chunks, outName, stats);
  } catch (err) {
    if (err.name === 'AbortError') {
      els.error.textContent = 'Cancelled.';
    } else {
      els.error.textContent = `Error: ${err.message}`;
      console.error(err);
    }
  } finally {
    resetButtons();
  }
}

function resetButtons() {
  els.run.disabled = !selectedFile;
  els.cancel.disabled = true;
}

// ---- core pipeline -----------------------------------------------------------

async function downsample(file, maxReads, gzipOutput, writable, signal) {
  const isGz = await detectGzip(file);
  const totalBytes = file.size;            // always compressed-or-raw input size
  const targetNewlines = maxReads * 4;

  const stats = {
    bytesIn: 0,                            // bytes consumed from the underlying file
    newlines: 0,
    t0: performance.now(),
    lastReport: 0,
  };

  // Tap the file stream BEFORE decompression so bytesIn is always "input file
  // bytes consumed" and progress against totalBytes is meaningful for both
  // gzipped and plain input.
  const tap = new TransformStream({
    transform(chunk, controller) {
      stats.bytesIn += chunk.length;
      controller.enqueue(chunk);
    },
  });

  let inStream = file.stream().pipeThrough(tap);
  if (isGz) inStream = inStream.pipeThrough(new DecompressionStream('gzip'));

  // Trim to the first N records by counting 0x0A bytes in the decompressed stream.
  // FASTQ has exactly 4 lines per record; we stop after the (4*N)-th newline.
  const trimmed = new ReadableStream({
    async start(controller) {
      const reader = inStream.getReader();
      const onAbort = () => reader.cancel().catch(() => {});
      signal.addEventListener('abort', onAbort);
      try {
        while (true) {
          if (signal.aborted) throw new DOMException('aborted', 'AbortError');
          const { value, done } = await reader.read();
          if (done) break;

          let cutoff = -1;
          for (let i = 0; i < value.length; i++) {
            if (value[i] === 0x0A) {
              stats.newlines++;
              if (stats.newlines === targetNewlines) { cutoff = i + 1; break; }
            }
          }
          if (cutoff >= 0) {
            controller.enqueue(value.subarray(0, cutoff));
            controller.close();
            await reader.cancel();             // stop pulling from the file
            return;
          }
          controller.enqueue(value);

          const now = performance.now();
          if (now - stats.lastReport > 100) {
            updateProgress(stats, totalBytes, maxReads);
            stats.lastReport = now;
          }
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
  });

  let pipe = trimmed;
  if (gzipOutput) pipe = pipe.pipeThrough(new CompressionStream('gzip'));

  await pipe.pipeTo(writable, { signal });

  // Final progress paint.
  updateProgress(stats, totalBytes, maxReads, /*final=*/true);

  return {
    readsKept: Math.floor(stats.newlines / 4),
    bytesIn: stats.bytesIn,
    elapsed: (performance.now() - stats.t0) / 1000,
    hitCap: stats.newlines >= targetNewlines,
  };
}

// ---- gzip detection ----------------------------------------------------------

async function detectGzip(file) {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return head.length === 2 && head[0] === 0x1f && head[1] === 0x8b;
}

// ---- output download ---------------------------------------------------------
// Collect chunks in memory, build a Blob, auto-trigger a download to the
// browser's default Downloads folder. Simple, one-click. For multi-GB outputs
// we may need to switch back to File System Access streaming later.

function triggerDownload(chunks, name, stats) {
  const type = name.endsWith('.gz') ? 'application/gzip' : 'text/plain';
  const blob = new Blob(chunks, { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // revoke the object URL after the click handler has fired
  setTimeout(() => URL.revokeObjectURL(url), 60_000);

  els.done.innerHTML =
    `Done — kept <strong>${stats.readsKept.toLocaleString()}</strong> reads ` +
    `in ${stats.elapsed.toFixed(1)} s` +
    (stats.hitCap ? '' : ' (reached end of input before cap)') +
    `. Downloaded <code>${escapeHTML(name)}</code> (${fmtBytes(blob.size)}).`;
  els.done.classList.remove('hide');
}

// ---- progress / formatting ---------------------------------------------------

function updateProgress(stats, totalBytes, maxReads, final = false) {
  const reads = Math.floor(stats.newlines / 4);
  const elapsed = (performance.now() - stats.t0) / 1000;
  const bytePct = totalBytes > 0 ? (stats.bytesIn / totalBytes) * 100 : 0;
  const readPct = (reads / maxReads) * 100;
  const pct = final ? 100 : Math.min(100, Math.max(bytePct, readPct));
  els.bar.style.width = pct.toFixed(1) + '%';
  els.bytesIn.textContent = `${fmtBytes(stats.bytesIn)} / ${fmtBytes(totalBytes)}`;
  els.reads.textContent = `${reads.toLocaleString()} / ${maxReads.toLocaleString()}`;
  const mbps = elapsed > 0 ? stats.bytesIn / 1024 / 1024 / elapsed : 0;
  els.rate.textContent = `${mbps.toFixed(1)} MB/s`;
  els.elapsed.textContent = `${elapsed.toFixed(1)} s`;
}

function makeOutputName(name, maxReads, gz) {
  const base = name.replace(/\.gz$/i, '').replace(/\.(fastq|fq)$/i, '');
  const tag = (maxReads >= 1_000_000 && maxReads % 1_000_000 === 0)
    ? `${maxReads / 1_000_000}M`
    : (maxReads >= 1_000 && maxReads % 1_000 === 0)
      ? `${maxReads / 1_000}k`
      : `${maxReads}`;
  return `${base}.first${tag}.fastq${gz ? '.gz' : ''}`;
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
