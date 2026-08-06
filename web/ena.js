// ENA input mode: turn an accession into a list of runs, and turn a run's FASTQ
// URL into something `streamCore` (fastq-trim.js) can read.
//
// Two halves, and they are deliberately independent:
//
//   resolveAccession()  asks the EBI portal API which runs an accession covers
//                       and where their FASTQs are. Runs on the PAGE.
//   urlSource()         a read source over HTTP that satisfies the (tiny)
//                       contract streamCore asks of its inputs:
//                          .size
//                          .slice(0, 2).arrayBuffer()
//                          .stream().getReader()
//                       Runs inside the WORKER — an object with methods does not
//                       survive postMessage, so the page sends URLs and the
//                       worker builds the source.
//
// Everything downstream of `.stream()` is unchanged: multi-member gunzip, the
// cut on a record boundary, the incremental sketcher, the R1/R2 drift budget,
// cancellation. That is the whole point of matching the existing contract
// instead of adding a second input path.
//
// The thing that makes this more than a fetch() wrapper is RESUME. At the
// ~4 MiB/s this link measures, one paired run is eight minutes of downloading
// against one minute of profiling, so a connection cut at 90 % that starts over
// is not a slow path, it is a broken feature. `.stream()` therefore re-opens
// with `Range: bytes=<already read>-` and continues, and the rules for when it
// may do so are the expensive part — see the notes on each of them below. They
// are the same rules db-cache.js arrived at for the database download, for the
// same reasons, and every one of them exists because the alternative is a
// SILENTLY WRONG sketch rather than a visible failure.

// ---- the portal API ----------------------------------------------------------

// Measured: this endpoint answers with `access-control-allow-origin: *`, so the
// browser may call it directly, and it accepts a run (ERR14098649), a sample
// (SAMEA…) or a project (PRJEB83730) in the same `accession` parameter.
export const ENA_PORTAL_API = "https://www.ebi.ac.uk/ena/portal/api/filereport";

// Interpolated raw into the query on purpose: this is a module constant, not
// user input, and the commas are what the API expects. The ONLY thing that ever
// comes from the user is the accession, and it goes through both a strict
// whitelist regex and encodeURIComponent.
export const ENA_FIELDS = "run_accession,library_layout,fastq_ftp,fastq_bytes,read_count";

// An INSDC accession: three to six letters then digits. PRJEB83730, SAMEA…,
// ERR14098592, SRR…, ERS…, ERX…, ERP… all fit; nothing else is sent to the API.
export const ACCESSION_RE = /^[A-Z]{3,6}[0-9]+$/;

// Where a FASTQ URL is allowed to point. `fastq_ftp` is data from a remote
// service; if that service (or anything between us and it) ever returned a URL
// on another host, following it would send the user's browser somewhere they
// never asked to go, with their IP address, on a page whose entire promise is
// about where data goes. The API is the EBI's, so the answer is the EBI's hosts.
//
// Note that this is EVERY host under ebi.ac.uk, not just ftp.sra.ebi.ac.uk —
// the EBI moves files between mirrors and the API is free to name another one.
// The privacy notice on the page says exactly that ("the EBI's servers,
// *.ebi.ac.uk") rather than naming a single host the code does not enforce.
export const ENA_FASTQ_HOSTS = [/(^|\.)ebi\.ac\.uk$/i];

// ---- accession input ---------------------------------------------------------

// What the user typed → the accession, or why it is not one.
//
// Accepts a pasted ENA browser URL as well as a bare accession, because that is
// what a browser hands you when you copy from the address bar. Everything ends
// up back at ACCESSION_RE regardless: the URL is only a way to FIND the
// candidate, never a way to skip the check.
export function normaliseAccession(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  // https://www.ebi.ac.uk/ena/browser/view/PRJEB83730  →  PRJEB83730
  const m = /^https?:\/\/[^\s]*\/([A-Za-z0-9]+)\/?(?:[?#].*)?$/.exec(s);
  if (m) s = m[1];
  return s.toUpperCase();
}

export function validateAccession(raw) {
  const acc = normaliseAccession(raw);
  if (!acc) return { ok: false, acc, error: "Type an ENA accession first (for example ERR14098592 or PRJEB83730)." };
  if (!ACCESSION_RE.test(acc)) {
    return {
      ok: false, acc,
      error: `"${acc}" is not an ENA accession. An accession is 3–6 letters followed by digits — ` +
        `a run (ERR14098592), a sample (SAMEA115468000), an experiment (ERX…) or a project (PRJEB83730).`,
    };
  }
  return { ok: true, acc, error: "" };
}

// ---- resolution --------------------------------------------------------------

// Semicolon lists, POSITIONS KEPT. `fastq_ftp` and `fastq_bytes` are parallel
// lists, so dropping the empty entries from one of them — the obvious way to
// write this — shifts every later size onto the wrong file. "a;;c" with sizes
// "1;;3" would report c as 1 byte, and the only symptom is a wrong number in
// the UI and a wrong ETA.
const splitList = (v) => String(v ?? "").split(";").map((s) => s.trim());

function basenameOf(url) {
  try { return new URL(url).pathname.split("/").filter(Boolean).pop() ?? url; }
  catch { return String(url).split("/").pop(); }
}

// `fastq_ftp` comes back without a scheme ("ftp.sra.ebi.ac.uk/vol1/fastq/…"),
// which is exactly the shape that tempts a bare string concat. Parse it, force
// https (the FTP host serves the same paths over HTTPS with CORS and Range),
// and check the host against the allow-list.
//
// Returns { url } | { blocked: hostname } | null.
export function fastqUrl(raw, allowHosts = ENA_FASTQ_HOSTS) {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^ftp:\/\//i.test(s)) s = `https://${s.slice(6)}`;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  // A plaintext URL from a page served over https. The browser would block it
  // as mixed content anyway; refusing it here makes the refusal ours, visible,
  // and named in the run's note instead of appearing as a console-only failure
  // half a minute into a download.
  if (u.protocol === "http:" && globalThis.location?.protocol === "https:") {
    return { blocked: `${u.hostname} over plain http` };
  }
  if (allowHosts && allowHosts.length && !allowHosts.some((re) => re.test(u.hostname))) {
    return { blocked: u.hostname };
  }
  return { url: u.href };
}

// One row of the filereport → one run, with the layout question already
// answered. The real-world shapes this has to survive, all seen in ENA:
//
//   - no fastq_ftp at all: the submitter deposited BAM/CRAM only. The run is
//     kept in the list, marked unusable, and says why — dropping it silently
//     from a project of 85 runs is how a user ends up with 84 samples and no
//     idea which one is missing.
//   - library_layout=PAIRED with ONE url: only one mate was archived. Profiled
//     single-end, with a note. Handing that single file to the paired path
//     would stall the R1/R2 pairing on a mate that never arrives.
//   - three urls for a PAIRED run: _1, _2 and an unpaired leftover. Take the
//     pair, say the third was left out.
//   - fastq_bytes missing or short: sizes become NaN, which the UI reports as
//     unknown rather than as zero. A "0 B" total in front of a 2 GB download is
//     worse than an honest "unknown".
export function parseRunRow(row, { allowHosts = ENA_FASTQ_HOSTS } = {}) {
  const run = String(row?.run_accession ?? "").trim();
  const declaredLayout = String(row?.library_layout ?? "").trim().toUpperCase();
  // Number("") is 0, not NaN — so an ABSENT read count would come out as a
  // confident "0 reads" instead of "unknown", which is how a run with no
  // metadata ends up looking like an empty run.
  const readsRaw = String(row?.read_count ?? "").trim();
  const readsNum = readsRaw === "" ? NaN : Number(readsRaw);
  const reads = Number.isFinite(readsNum) && readsNum >= 0 ? readsNum : NaN;

  const rawUrls = splitList(row?.fastq_ftp);
  const rawBytes = splitList(row?.fastq_bytes);
  const notes = [];
  const files = [];
  for (let i = 0; i < rawUrls.length; i++) {
    if (!rawUrls[i]) continue;                  // an empty slot, not a broken URL
    const parsed = fastqUrl(rawUrls[i], allowHosts);
    if (!parsed) { notes.push(`one file URL could not be read and was ignored`); continue; }
    if (parsed.blocked) {
      notes.push(`a file hosted on ${parsed.blocked} was ignored — this page only downloads from the EBI`);
      continue;
    }
    // Same trap as read_count: a missing size must stay unknown, never zero.
    const raw = String(rawBytes[i] ?? "").trim();
    const n = raw === "" ? NaN : Number(raw);
    files.push({
      url: parsed.url,
      name: basenameOf(parsed.url),
      bytes: Number.isFinite(n) && n > 0 ? n : NaN,
    });
  }

  const base = {
    run, declaredLayout, reads,
    bytes: files.reduce((a, f) => a + (Number.isFinite(f.bytes) ? f.bytes : 0), 0),
    bytesUnknown: files.filter((f) => !Number.isFinite(f.bytes)).length,
  };

  if (!run) {
    return { ...base, layout: "SINGLE", files: [], usable: false, note: "",
      problem: "this row has no run accession" };
  }
  if (files.length === 0) {
    return {
      ...base, layout: "SINGLE", files: [], usable: false, note: notes.join("; "),
      problem: "no FASTQ files are available for this run (the submitter may have deposited only BAM/CRAM)",
    };
  }

  const mate = (f, n) => new RegExp(`_${n}\\.(fastq|fq)(\\.gz)?$`, "i").test(f.name);
  const r1 = files.find((f) => mate(f, 1));
  const r2 = files.find((f) => mate(f, 2));

  // Sizes always follow the files actually kept, never the whole row: a run
  // whose third file is dropped must not still be announced at the size of
  // three files.
  const sized = (layout, kept, usable = true) => ({
    ...base, layout, files: kept, usable,
    bytes: kept.reduce((a, f) => a + (Number.isFinite(f.bytes) ? f.bytes : 0), 0),
    bytesUnknown: kept.filter((f) => !Number.isFinite(f.bytes)).length,
    note: notes.join("; "), problem: "",
  });

  if (declaredLayout === "PAIRED") {
    if (r1 && r2) {
      const extra = files.filter((f) => f !== r1 && f !== r2);
      if (extra.length) notes.push(`${extra.length} unpaired file(s) not used (${extra.map((f) => f.name).join(", ")})`);
      return sized("PAIRED", [r1, r2]);
    }
    // EXACTLY ONE mate is named. The positional fallback below must NOT run
    // here: pairing a recognised _1 with whatever file happened to come next
    // produces two streams that are not mates, silently truncated to the
    // shorter of the two, presented as a paired run. Half a name is not a
    // pairing — profile the mate we did recognise, single-end, and say which
    // files were left out.
    const only = r1 ?? r2;
    if (only) {
      const extra = files.filter((f) => f !== only);
      notes.push(`declared paired-end but only ${only.name} is named _1/_2 — profiled as single-end`);
      if (extra.length) {
        notes.push(`${extra.length} file(s) that could not be paired with it were left out ` +
          `(${extra.map((f) => f.name).join(", ")})`);
      }
      return sized("SINGLE", [only]);
    }
    // No file matches either mate marker. Now — and only now — position is all
    // there is to go on, and the note says so honestly.
    if (files.length >= 2) {
      notes.push("the two files are not named _1/_2 — taken in the order the API returned them");
      return sized("PAIRED", files.slice(0, 2));
    }
    notes.push("declared paired-end but only one FASTQ is archived — profiled as single-end");
    return sized("SINGLE", files);
  }

  if (files.length > 1) {
    notes.push(`${files.length} files, read one after the other as a single sample`);
  }
  return { ...base, layout: "SINGLE", files, usable: true, note: notes.join("; "), problem: "" };
}

// See the note at its call sites: fetch must not be called detached from the
// global object.
function boundFetch() {
  const f = globalThis.fetch;
  if (typeof f !== "function") throw new Error("this environment has no fetch()");
  return f.bind(globalThis);
}

function excerpt(s, n = 160) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// accession → [{ run, layout, reads, files: [{url, bytes, name}], … }].
//
// Throws — with a sentence a user can act on — for: a string that is not an
// accession (WITHOUT calling the API), an unreachable API, an HTTP error, a
// body that is not JSON, and an empty result. That last one is the important
// one: an accession that does not exist is not an HTTP error, it is `[]`.
export async function resolveAccession(acc, opts = {}) {
  const {
    signal, apiBase = ENA_PORTAL_API, fetchImpl, allowHosts = ENA_FASTQ_HOSTS,
  } = opts;
  const v = validateAccession(acc);
  if (!v.ok) throw new Error(v.error);
  // Bound, always: `globalThis.fetch` called with no receiver is an "Illegal
  // invocation" TypeError in a browser, and only in a browser — node would let
  // it through, so the tests would never see it.
  const doFetch = fetchImpl ?? boundFetch();

  // encodeURIComponent even though ACCESSION_RE already forbids every character
  // that could matter. Two independent reasons to be safe are the point: if the
  // regex is ever loosened, this line still stands between the input and the
  // query string.
  const url = `${apiBase}?accession=${encodeURIComponent(v.acc)}` +
    `&result=read_run&fields=${ENA_FIELDS}&format=json`;

  let resp;
  try {
    resp = await doFetch(url, { signal });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new Error(`could not reach the ENA API (${e?.message ?? e}). ` +
      `Check the connection — this is the one request this page makes to the EBI.`);
  }
  if (!resp.ok) {
    throw new Error(`the ENA API answered HTTP ${resp.status} for ${v.acc}. ` +
      `If this persists the service may be down; the accession itself is checked below.`);
  }
  const text = await resp.text();
  let rows;
  try { rows = JSON.parse(text); }
  catch {
    throw new Error(`the ENA API did not answer with JSON for ${v.acc} — got: ${excerpt(text)}`);
  }
  if (!Array.isArray(rows)) {
    throw new Error(`the ENA API answered something unexpected for ${v.acc} — got: ${excerpt(text)}`);
  }
  if (rows.length === 0) {
    throw new Error(`no sequencing runs found for ${v.acc}. ` +
      `An accession that does not exist gives an empty answer, not an error — check the spelling, ` +
      `and note that only read runs (and the projects/samples that contain them) can be profiled here.`);
  }
  const runs = rows.map((r) => parseRunRow(r, { allowHosts }));
  runs.sort((a, b) => a.run.localeCompare(b.run));
  return runs;
}

// Total download for a set of runs, keeping "unknown" distinct from zero.
export function totalBytes(runs) {
  let bytes = 0, unknown = 0;
  for (const r of runs) {
    bytes += Number.isFinite(r.bytes) ? r.bytes : 0;
    unknown += r.bytesUnknown ?? 0;
  }
  return { bytes, unknown };
}

// ---- the resumable read source ----------------------------------------------

// Consecutive attempts that deliver NOTHING before the read is abandoned.
export const MAX_STRIKES = 6;
// Waits after a failure that made no progress. A failure that DID make progress
// waits PROGRESS_RETRY_MS instead: the link works, it is just being cut, and
// there is nothing to back off from.
export const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];
export const PROGRESS_RETRY_MS = 250;
// How many times the server may answer a resume with the whole file from byte 0
// before we stop paying for it. Each one re-reads (and throws away) everything
// already delivered, so it is correct but expensive.
export const MAX_RANGE_RESTARTS = 3;
// Only used to scale the request ceiling to the size of the job.
const CHUNK_HINT = 8 * 1024 * 1024;

// EVERY request counts against this, not just the failed ones. That distinction
// is the exact defect that was found in db-cache.js: a server that answers a
// handful of bytes per request and closes is making "progress" every single
// time, so a budget of consecutive FAILURES never fires, there is never a wait,
// and the loop is unbounded — measured there at thousands of requests a second
// with a progress readout that kept insisting it was moving.
// How long the file is meant to be, from BOTH witnesses: what the server says
// about the object it is serving, and what the ENA API says about the file it
// catalogued. Only ever used to notice a stream that delivered less than the
// file it claims to be — never as a resume offset.
//
// The MAXIMUM, not the server's number. Preferring the server was the hole:
// a truncated object served with an honest Content-Length for that truncated
// object is indistinguishable from a complete download — emitted === expected,
// the stream closes cleanly, and the sample is profiled on a fraction of its
// reads and reported as a success. fastq_bytes is the only independent witness
// there is, so the larger of the two is the one that has to be reached.
// (sizesDisagree() below turns the disagreement itself into a hard failure, so
// in practice the two are equal by the time this matters; the max is what keeps
// the check honest if that guard is ever weakened.)
export const expectedTotal = (state) => {
  const server = Number.isFinite(state.total) && state.total > 0 ? state.total : NaN;
  const api = Number.isFinite(state.declared) && state.declared > 0 ? state.declared : NaN;
  if (Number.isFinite(server) && Number.isFinite(api)) return Math.max(server, api);
  return Number.isFinite(server) ? server : api;
};

// The two witnesses, compared. Two KNOWN and DIFFERENT sizes mean the object on
// the server is not the file the API describes — a republication, a CDN serving
// a stale or partial copy, a truncated mirror. Any of those makes the profile a
// profile of something other than the run the user asked for.
export const sizesDisagree = (state) =>
  Number.isFinite(state.total) && state.total > 0
  && Number.isFinite(state.declared) && state.declared > 0
  && state.total !== state.declared;

const requestCeiling = (state) =>
  50 + 10 * Math.ceil(Math.max(expectedTotal(state) || 0, state.emitted, 1) / CHUNK_HINT);

// What a response says about the file it is part of, recorded WITHOUT judging
// it. Called by every request the source makes — the gzip probe included — so
// that the size and the Last-Modified of the object are known from the first
// byte read rather than from the first byte streamed. Never overwrites: a value
// already recorded is the one the guards in openRequest compare against.
function noteResponse(state, resp) {
  const lm = resp.headers.get("last-modified");
  if (lm && !state.lastModified) state.lastModified = lm;
  let stated = NaN;
  if (resp.status === 206) {
    // Content-Length on a 206 is the length of the SLICE, not of the file.
    const cr = parseContentRange(resp.headers.get("content-range"));
    if (cr && Number.isFinite(cr.total)) stated = cr.total;
  } else {
    const clen = Number(resp.headers.get("content-length"));
    if (Number.isFinite(clen) && clen > 0) stated = clen;
  }
  if (Number.isFinite(stated) && stated > 0 && !Number.isFinite(state.total)) state.total = stated;
}

function parseContentRange(v) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(v ?? "").trim());
  if (!m) return null;
  return { start: +m[1], end: +m[2], total: m[3] === "*" ? NaN : +m[3] };
}

function abortError() { return new DOMException("aborted", "AbortError"); }

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(t); reject(abortError()); }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// A fatal error is one where retrying cannot help AND resuming would be a lie:
// the bytes already delivered belong to a file the server is no longer serving.
function fatal(message, code) {
  const e = new Error(message);
  e.code = code;
  e.fatal = true;
  return e;
}

// Throughput over a trailing window rather than since the start, so a link that
// really slows down shows up instead of being averaged away.
export function rateMeter(windowMs = 5000, clock = () => Date.now()) {
  const pts = [];
  return {
    push(received) {
      const now = clock();
      pts.push([now, received]);
      while (pts.length > 2 && now - pts[0][0] > windowMs) pts.shift();
      const [t0, b0] = pts[0];
      const dt = (now - t0) / 1000;
      return dt > 0.25 ? (received - b0) / dt : NaN;
    },
  };
}

// A read source over HTTP with the same surface a File gives streamCore.
//
//   size          bytes, for the progress totals. From fastq_bytes, replaced by
//                 whatever the server says as soon as it says anything.
//   slice(a, b)   one small Range request — this is what detectGzip() uses.
//   stream()      a ReadableStream that RESUMES (see resumableStream below).
//
// Options: { size, name, signal, fetchImpl, onRetry, maxStrikes, backoff,
//            progressRetryMs, maxRestarts, allowHosts }
export function urlSource(url, opts = {}) {
  // The allow-list, applied AT THE FETCH rather than only at resolution.
  // resolveAccession() filters fastq_ftp before any of it reaches the page, but
  // that is one caller and one layer; this is the line that actually opens the
  // connection, and the page's privacy notice is a promise about this line. A
  // second caller — a "paste a FASTQ URL" mode, a test harness, copied code —
  // would otherwise fetch whatever it was handed, with the user's IP, from a
  // page that says only the EBI is contacted.
  const allowHosts = opts.allowHosts ?? ENA_FASTQ_HOSTS;
  const checked = fastqUrl(url, allowHosts);
  if (!checked || checked.blocked) {
    throw new Error(
      `refusing to download from ${checked?.blocked ?? String(url)}: this page only ` +
      `fetches FASTQ files from the EBI's servers`);
  }
  url = checked.url;
  const cfg = {
    fetchImpl: opts.fetchImpl ?? boundFetch(),
    signal: opts.signal ?? null,
    onRetry: opts.onRetry ?? null,
    maxStrikes: opts.maxStrikes ?? MAX_STRIKES,
    backoff: opts.backoff ?? BACKOFF_MS,
    progressRetryMs: opts.progressRetryMs ?? PROGRESS_RETRY_MS,
    maxRestarts: opts.maxRestarts ?? MAX_RANGE_RESTARTS,
  };
  const declared = Number.isFinite(opts.size) && opts.size > 0 ? opts.size : NaN;
  // Shared across the (single) stream and the slices, so the "is this still the
  // same file" checks span every request made for this source.
  const state = {
    emitted: 0,      // bytes handed downstream: the resume offset, and the only
                     // number that may ever be used as one
    total: NaN,      // the size the SERVER states (content-range / content-length)
    // What the ENA API said (fastq_bytes). Kept SEPARATE from `total` on
    // purpose: the "did this file change under us" check may only ever compare
    // the server with itself, or a stale fastq_bytes would abort a perfectly
    // good download. It is used for one thing — knowing that a stream which
    // ended cleanly ended EARLY, which is otherwise undetectable on a chunked
    // response that carries no Content-Length at all.
    declared,
    lastModified: null,
    requests: 0,
    restarts: 0,
  };
  let streamed = false;

  return {
    url,
    name: opts.name ?? basenameOf(url),
    get size() { return Number.isFinite(state.total) ? state.total : declared; },
    get received() { return state.emitted; },
    get requests() { return state.requests; },
    get restarts() { return state.restarts; },

    // detectGzip() calls slice(0, 2).arrayBuffer(). Kept general anyway: a
    // server that ignores Range answers 200 with the whole file, and the wanted
    // window is cut out of the front of it (and the rest cancelled).
    slice(start = 0, end) {
      return {
        arrayBuffer: async () => {
          const want = Number.isFinite(end) ? Math.max(0, end - start) : Infinity;
          const headers = { Range: Number.isFinite(end) ? `bytes=${start}-${end - 1}` : `bytes=${start}-` };
          let last = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            if (cfg.signal?.aborted) throw abortError();
            try {
              state.requests++;
              const resp = await cfg.fetchImpl(url, { headers, signal: cfg.signal, cache: "no-store" });
              if (!resp.ok && resp.status !== 206) throw new Error(`HTTP ${resp.status}`);
              // This request is a request for the same file as every other one,
              // so it feeds the same two witnesses: without this the gzip probe
              // was the one request in the module that escaped both the
              // "same file" check and the size comparison.
              noteResponse(state, resp);
              const skip = resp.status === 206 ? 0 : start;
              const reader = resp.body.getReader();
              const parts = [];
              let have = 0, seen = 0;
              try {
                while (have < want) {
                  const { value, done } = await reader.read();
                  if (done) break;
                  if (!value?.length) continue;
                  const from = Math.max(0, skip - seen);
                  seen += value.length;
                  if (from >= value.length) continue;
                  const usable = value.subarray(from, Math.min(value.length, from + (want - have)));
                  parts.push(usable);
                  have += usable.length;
                }
              } finally {
                try { await reader.cancel(); } catch { /* already done */ }
              }
              // A response that ends cleanly with less than was asked for is
              // NOT an exception, so without this the retry loop below never
              // ran: an empty-but-well-formed 206 came back as a zero-length
              // buffer, detectGzip() saw fewer than two bytes and said "not
              // gzip" about a gzip file, and the compressed bytes were then fed
              // to the sketcher as if they were text.
              const known = expectedTotal(state);
              const inFile = Number.isFinite(known) ? start + want <= known : false;
              if (have < want && (inFile || have === 0)) {
                throw new Error(
                  `asked for ${Number.isFinite(want) ? want : "the rest"} bytes at ${start} ` +
                  `and the response ended after ${have}`);
              }
              const out = new Uint8Array(have);
              let off = 0;
              for (const p of parts) { out.set(p, off); off += p.length; }
              return out.buffer;
            } catch (e) {
              if (e?.name === "AbortError" || cfg.signal?.aborted) throw abortError();
              last = e;
              await sleep(cfg.progressRetryMs * (attempt + 1), cfg.signal);
            }
          }
          throw new Error(`could not read the start of ${basenameOf(url)}: ${last?.message ?? last}`);
        },
      };
    },

    // ONCE. `state.emitted` is a resume offset, so a second stream from the same
    // source would silently start in the middle of the file — a sample sketched
    // from the tail of its own FASTQ, with no error anywhere. streamCore calls
    // this exactly once per input, and the worker builds fresh sources for every
    // message, so refusing is free.
    stream() {
      if (streamed) {
        throw new Error(
          `${basenameOf(url)}: this URL source has already been read; build a new one ` +
          `(re-reading it would resume from ${state.emitted} bytes in, not from the start)`);
      }
      streamed = true;
      return resumableStream(url, state, cfg);
    },
  };
}

// The resuming ReadableStream.
//
// Invariants, in the order they matter:
//
//  1. Bytes are delivered ONCE, in order, with no gap and no repeat. Everything
//     else here serves that. `emitted` is the absolute offset of the next byte
//     the consumer expects; `pos` is the absolute offset of the next byte the
//     CURRENT response will yield. A response may start before `emitted` (the
//     server ignored our Range and sent the whole file) and the overlap is
//     thrown away; it may never start after it, because that is a hole, and a
//     hole in a gzip member is not detectable downstream — fflate would simply
//     fail somewhere else, or worse, not fail.
//
//  2. A 200 where a 206 was expected NEVER gets pasted onto what we already
//     have. It restarts from byte 0 and re-reads the prefix — correct, and
//     costly enough that it is capped and reported. Concatenating instead is the
//     defect this file exists to avoid: the sketch would be computed on a
//     prefix followed by the whole file again, and nothing downstream can see it.
//
//  3. If the file changes on the server mid-read (Last-Modified or size), the
//     read FAILS. It cannot resume: the bytes already fed to the sketcher belong
//     to the other version, and a sample sketched from two versions of a FASTQ
//     is wrong in a way that no check downstream can catch.
//
//  4. Every request is counted (see requestCeiling).
function resumableStream(url, state, cfg) {
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort();
  if (cfg.signal) {
    if (cfg.signal.aborted) ctrl.abort();
    else cfg.signal.addEventListener("abort", onOuterAbort);
  }
  let reader = null;
  let pos = 0;                 // absolute offset the current response is at
  let emittedAtOpen = 0;       // to tell a retry that progressed from one that did not
  let strikes = 0;
  let finished = false;

  const cleanup = () => {
    if (finished) return;
    finished = true;
    cfg.signal?.removeEventListener("abort", onOuterAbort);
  };

  async function openRequest() {
    if (state.requests >= requestCeiling(state)) {
      throw fatal(
        `giving up on ${basenameOf(url)} after ${state.requests} requests, still only ` +
        `${state.emitted} of ${Number.isFinite(state.total) ? state.total : "?"} bytes — ` +
        `the server is not delivering this file at a usable rate`, "CEILING");
    }
    state.requests++;
    emittedAtOpen = state.emitted;
    const start = state.emitted;
    const headers = {};
    // No Range on the first request: a plain GET is what every server answers
    // best, and there is nothing to resume yet.
    // No If-Range either — it is NOT a CORS-safelisted request header, so it
    // would turn every request into a preflighted one, and ftp.sra.ebi.ac.uk
    // answers OPTIONS with an Access-Control-Allow-Headers that lists Range and
    // not If-Range. The Last-Modified check below does the same job with a
    // header that can actually be read cross-origin.
    if (start > 0) headers.Range = `bytes=${start}-`;

    const resp = await cfg.fetchImpl(url, { headers, signal: ctrl.signal, cache: "no-store" });
    // Every error path in this function lets go of the body before it throws.
    // A rejected response whose body is neither read nor cancelled keeps its
    // socket until the garbage collector gets to it, and a run that fails its
    // six strikes against a host that is 503-ing leaves six of them behind —
    // on a page whose worker pool is already using every connection this host
    // allows.
    if (!resp.ok && resp.status !== 206) {
      try { await resp.body?.cancel(); } catch { /* nothing to let go of */ }
      throw new Error(`HTTP ${resp.status}`);
    }
    if (!resp.body) throw new Error("the response has no body stream");

    // Where does this body start, and how big is the file, according to the
    // server itself?
    let respStart;
    let statedTotal = NaN;
    const clen = Number(resp.headers.get("content-length"));
    if (resp.status === 206) {
      const cr = parseContentRange(resp.headers.get("content-range"));
      if (cr) {
        respStart = cr.start;
        statedTotal = cr.total;
      } else {
        // Content-Range is not a CORS-safelisted RESPONSE header, so cross-origin
        // it can read as null even when the server sends it. The status is then
        // all we have: a 206 means "the range you asked for". Documented residual
        // risk, identical to the one db-cache.js carries against Zenodo.
        //
        // One cheap cross-check is still possible: if the body is as long as the
        // WHOLE file rather than the tail we asked for, it is not the tail.
        //
        // Against BOTH witnesses, not just the server's. `state.total` is NaN
        // in exactly the case this check is most needed — a first response sent
        // chunked, with no Content-Length at all — and fastq_bytes is then the
        // only number available to recognise a body that carries the whole file.
        // It is used here as a witness, never as an offset and never as grounds
        // for dropping bytes.
        respStart = start;
        const ref = expectedTotal(state);
        if (Number.isFinite(ref) && Number.isFinite(clen) && start > 0 && clen === ref) {
          respStart = 0;
        }
      }
    } else {
      // 200 is always the whole file, whatever we asked for.
      respStart = 0;
      if (Number.isFinite(clen) && clen > 0) statedTotal = clen;
    }

    // Same file? Last-Modified IS safelisted, so this check works cross-origin,
    // and it is the one that catches a republication (or a multi-backend CDN)
    // between two requests — the case where every response is individually valid
    // and the assembled stream is two files spliced together.
    const lm = resp.headers.get("last-modified");
    if (lm) {
      if (!state.lastModified || state.emitted === 0) state.lastModified = lm;
      else if (lm !== state.lastModified) {
        try { await resp.body.cancel(); } catch { /* fine */ }
        throw fatal(
          `${basenameOf(url)} changed on the server while it was being read ` +
          `(Last-Modified ${state.lastModified} → ${lm}). The reads already profiled came from ` +
          `the other version, so this sample cannot be finished — start it again.`, "CHANGED");
      }
    }
    if (Number.isFinite(statedTotal) && statedTotal > 0) {
      if (!Number.isFinite(state.total) || state.emitted === 0) state.total = statedTotal;
      else if (statedTotal !== state.total) {
        try { await resp.body.cancel(); } catch { /* fine */ }
        throw fatal(
          `${basenameOf(url)} changed size on the server while it was being read ` +
          `(${state.total} → ${statedTotal} bytes) — this sample cannot be finished.`, "CHANGED");
      }
    }

    // The two witnesses, compared. Everything else in this file compares the
    // server with itself, which cannot see a server that is consistently wrong:
    // an object truncated upstream, served with an honest Content-Length for
    // the truncated object, satisfies every check here and ends the stream
    // cleanly. fastq_bytes is the only number that comes from somewhere else,
    // and a disagreement between the two means the bytes on this host are not
    // the file the ENA catalogue describes. Measured on the reference run
    // (ERR14098592): Content-Length and fastq_bytes agree exactly, 106897414.
    if (sizesDisagree(state)) {
      try { await resp.body.cancel(); } catch { /* fine */ }
      throw fatal(
        `${basenameOf(url)}: the ENA API says this file is ${state.declared} bytes and the ` +
        `server is serving ${state.total}. They describe different files, so a profile made ` +
        `from this download would not be the run that was asked for — stopping rather than ` +
        `reporting a result. (If the ENA record was updated very recently, look the accession ` +
        `up again to pick up the new size.)`, "SIZE_MISMATCH");
    }

    if (respStart > state.emitted) {
      // A hole. Never write around it: fflate would fail somewhere unrelated, or
      // not fail at all and sketch garbage.
      try { await resp.body.cancel(); } catch { /* fine */ }
      throw new Error(
        `the server answered from byte ${respStart} when ${state.emitted} was asked for`);
    }
    if (respStart < state.emitted) {
      state.restarts++;
      if (state.restarts > cfg.maxRestarts) {
        try { await resp.body.cancel(); } catch { /* fine */ }
        throw fatal(
          `${basenameOf(url)}: the server keeps ignoring Range and answering with the whole file ` +
          `(${state.restarts} times), so every resume costs the ${state.emitted} bytes already read. ` +
          `Giving up rather than looping.`, "NO_RANGE");
      }
      cfg.onRetry?.({
        received: state.emitted, total: state.total, attempt: strikes, waitMs: 0,
        requests: state.requests, restart: true,
        note: `${basenameOf(url)}: the server ignored the resume request and started over — ` +
          `re-reading ${state.emitted} bytes to get back to where it was`,
      });
    }
    pos = respStart;
    reader = resp.body.getReader();
  }

  // One failed attempt: decide whether to retry, how long to wait, and say so.
  async function failedAttempt(err) {
    if (err?.fatal) throw err;
    if (err?.name === "AbortError" || ctrl.signal.aborted) throw abortError();
    reader = null;
    const progressed = state.emitted > emittedAtOpen;
    strikes = progressed ? 0 : strikes + 1;
    if (strikes >= cfg.maxStrikes) {
      throw new Error(
        `${basenameOf(url)}: ${cfg.maxStrikes} attempts in a row delivered nothing at ` +
        `${state.emitted}/${Number.isFinite(state.total) ? state.total : "?"} bytes ` +
        `(last error: ${err?.message ?? err})`);
    }
    const wait = strikes === 0
      ? cfg.progressRetryMs
      : cfg.backoff[Math.min(strikes - 1, cfg.backoff.length - 1)];
    cfg.onRetry?.({
      received: state.emitted, total: state.total, attempt: strikes, waitMs: wait,
      requests: state.requests, restart: false,
      note: `${basenameOf(url)}: ${err?.message ?? err} — resuming at ${state.emitted} bytes ` +
        `in ${(wait / 1000).toFixed(1)} s`,
    });
    await sleep(wait, ctrl.signal);
  }

  return new ReadableStream({
    async pull(controller) {
      for (;;) {
        if (ctrl.signal.aborted) { cleanup(); controller.error(abortError()); return; }
        try {
          if (!reader) await openRequest();
          const { value, done } = await reader.read();

          if (done) {
            reader = null;
            // A body that ends cleanly but short. This is NOT an error at the
            // HTTP level and it is what a chunked response cut mid-transfer
            // looks like — treated as a cut, or the sample would be profiled on
            // a fraction of its reads and reported as a success. (fastq-trim.js
            // catches the same thing for a truncated .gz, at the cost of failing
            // the sample; here it is merely resumed.)
            const expected = expectedTotal(state);
            if (Number.isFinite(expected) && state.emitted < expected) {
              await failedAttempt(new Error(
                `the connection ended after ${state.emitted} of ${expected} bytes`));
              continue;
            }
            cleanup();
            controller.close();
            return;
          }
          if (!value?.length) continue;

          const chunkStart = pos;
          pos += value.length;
          // Against the expected size in the WIDE sense (server or API), not
          // just against what the server declared. A response that carries the
          // whole file where a tail was asked for is caught in openRequest when
          // its length is readable; when it is not — a chunked 206, no
          // Content-Length, nothing to compare — this is the last place the
          // splice can still be seen, and it can only see it if fastq_bytes
          // counts. Without it, prefix + whole file goes through in silence.
          const cap = expectedTotal(state);
          if (Number.isFinite(cap) && pos > cap) {
            throw fatal(
              `${basenameOf(url)}: the server sent more than the ${cap} bytes this file is ` +
              `meant to be — it is answering resumes with the whole file again`,
              "OVERRUN");
          }
          if (pos <= state.emitted) continue;                 // still re-reading a known prefix
          const keep = chunkStart >= state.emitted
            ? value
            : value.subarray(state.emitted - chunkStart);
          state.emitted = pos;
          strikes = 0;
          controller.enqueue(keep);
          return;
        } catch (err) {
          try {
            await failedAttempt(err);
          } catch (stop) {
            cleanup();
            controller.error(stop);
            return;
          }
        }
      }
    },
    cancel() {
      cleanup();
      ctrl.abort();
      reader = null;
    },
  });
}

// ---- what a download is going to cost ----------------------------------------

// Seconds, from a byte count and a rate. Kept here so the page and any test
// agree on the arithmetic.
export function etaSeconds(bytes, bps) {
  if (!Number.isFinite(bytes) || !Number.isFinite(bps) || bps <= 0) return NaN;
  return bytes / bps;
}

// The rate used for an estimate BEFORE anything has been measured. 4 MiB/s is
// what this link actually delivers from ftp.sra.ebi.ac.uk; the UI labels it as
// assumed until a real measurement replaces it.
export const ASSUMED_BPS = 4 * 1024 * 1024;

// What a set of runs is really going to cost to download.
//
// Two things the naive sum gets wrong, both of them in the number a user reads
// before committing to an afternoon:
//
//   - the READ CAP. streamCore stops pulling on the 4*maxReads-th newline and
//     cancels the connection, so a 12 GB run profiled at 1 M reads out of 6.6 M
//     transfers about a sixth of that. Summing fastq_bytes announces the whole
//     file.
//   - UNKNOWN sizes. fastq_bytes is missing on some ENA depositions; those runs
//     contribute NaN, which sums as 0. A project of unknown-size runs was
//     therefore announced as "0 B … about 0 s" in front of a download of tens of
//     gigabytes. An estimate that cannot be made must not be printed as zero.
//
// `items` are runs (from parseRunRow) or anything with the same three fields.
export function downloadEstimate(items, { maxReads = Infinity, bps = ASSUMED_BPS } = {}) {
  let bytes = 0, unknown = 0, capped = false;
  for (const it of items ?? []) {
    unknown += it?.bytesUnknown ?? 0;
    const b = Number.isFinite(it?.bytes) && it.bytes > 0 ? it.bytes : NaN;
    if (!Number.isFinite(b)) continue;
    const reads = Number.isFinite(it?.reads) && it.reads > 0 ? it.reads : NaN;
    if (Number.isFinite(reads) && Number.isFinite(maxReads) && maxReads < reads) {
      bytes += Math.ceil(b * (maxReads / reads));
      capped = true;
    } else {
      bytes += b;
    }
  }
  // One unknown size is enough to make the total a floor rather than a total,
  // and a floor is not something to hang an ETA on.
  const estimable = unknown === 0 && bytes > 0;
  return { bytes, unknown, capped, estimable, seconds: estimable ? etaSeconds(bytes, bps) : NaN };
}

// How far apart the profiled read count may be from the count the ENA lists
// before it stops being rounding and starts being a truncated download.
export const READ_COUNT_TOLERANCE = 0.01;

// The cheapest end-to-end check there is: did we profile the number of reads
// the catalogue says this run has?
//
// Every other guard in this file watches bytes, and bytes can be consistently
// wrong (a truncated object with a matching Content-Length, an API size that
// agrees with it). The read count is counted from the decompressed FASTQ by the
// trimmer itself, and compared with a number that came from the ENA. Nothing
// else in the pipeline can see a truncation that both size witnesses missed.
//
// Only meaningful when the cap did NOT stop the read: below the cap, a short
// count is missing data; at the cap, it is the cap.
/**
 * The ENA's read_count, converted to the unit the worker reports back.
 *
 * For a PAIRED run read_count counts BOTH mates, while the worker counts PAIRS.
 * Measured on ERR14098649: the ENA lists 13,510,300 and R1 really holds
 * 6,755,150 records — exactly half. Comparing the two as-is would report every
 * paired run as 50% short, which is to say it would declare the whole
 * paired-end mode truncated.
 */
export function expectedProfiledReads({ readCount, layout, pairsAsTwo = false } = {}) {
  if (!Number.isFinite(readCount)) return NaN;
  // read_count is already in sequenced reads, so when the user asks to count a
  // pair as two there is nothing to convert — the two units agree.
  if (pairsAsTwo) return readCount;
  return layout === "PAIRED" ? Math.round(readCount / 2) : readCount;
}

export function readCountVerdict({ observed, expected, maxReads } = {}) {
  if (!Number.isFinite(observed)) return { ok: true, capped: false, missing: NaN, note: "" };
  const capped = Number.isFinite(maxReads) && observed >= maxReads;
  if (capped) return { ok: true, capped: true, missing: NaN, note: "" };
  if (!Number.isFinite(expected) || expected <= 0) {
    return { ok: true, capped: false, missing: NaN, note: "" };
  }
  const missing = expected - observed;
  if (Math.abs(missing) <= Math.max(1, expected * READ_COUNT_TOLERANCE)) {
    return { ok: true, capped: false, missing, note: "" };
  }
  const pct = (Math.abs(missing) / expected * 100).toFixed(1);
  return {
    ok: false, capped: false, missing,
    note: missing > 0
      ? `only ${observed.toLocaleString("en-US")} of the ${expected.toLocaleString("en-US")} reads ` +
        `the ENA lists for this run were profiled (${pct}% missing) — the download ended early, ` +
        `so these abundances come from part of the run`
      : `${observed.toLocaleString("en-US")} reads were profiled but the ENA lists only ` +
        `${expected.toLocaleString("en-US")} for this run (${pct}% more) — the file served does ` +
        `not match the catalogue`,
  };
}
