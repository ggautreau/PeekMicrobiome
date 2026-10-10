// The ENA mode, driven through the REAL page in a REAL browser.
//
//   node scripts/ena-test/page.mjs
//
// node-suite.mjs proves web/ena.js behaves against a hostile server. It says
// nothing about whether index.html and multi.js are wired to it: a renamed
// element id, a descriptor the worker cannot read, a postMessage that never
// arrives, and every module test still passes while the page does nothing at
// all when you click "Look up".
//
// So this one loads web/index.html itself in headless Chrome and clicks through
// the whole feature: look up an accession, tick a run, add it to the sample
// list, load the bundled database, profile, read the matrix. The download is
// CUT AND RESUMED while it runs, so what is checked is not only "does it work"
// but "does it survive the thing it was built for", through the worker and the
// wasm sketcher rather than in isolation.
//
// Nothing here touches the real ENA:
//   - the portal API call is rewritten, in the page, to a JSON fixture served
//     locally (that call is made on the main thread, so a fetch shim reaches it);
//   - the FASTQ host is mapped to the local server by Chrome's own resolver
//     (--host-resolver-rules), because those requests are made INSIDE the worker
//     where a page-level shim cannot reach — and mapping the host rather than
//     rewriting the URL is also what keeps the allow-list in ena.js under test.
// The reads are a real subsample of ERR14098649 (already on disk), so the
// abundance matrix that comes out is a real one.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const WEB = path.join(REPO, "web");
const PORT = Number(process.env.PORT ?? 8831);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9343);
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = process.env.SCRATCH ?? fs.mkdtempSync(path.join(os.tmpdir(), "enapage-"));
const ROOT = path.join(SCRATCH, "root");
const PROFILE = path.join(SCRATCH, "chrome-profile");
const LOG = path.join(SCRATCH, "server.jsonl");
const RECORDS = Number(process.env.RECORDS ?? 120_000);   // reads per mate in the fixture
const TARGET = "/f/ERRTEST_1.fastq.gz";                   // the mate the faults hit

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `   [${detail}]` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- scratch site ------------------------------------------------------------

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, "f"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "api"), { recursive: true });
for (const n of fs.readdirSync(WEB)) fs.symlinkSync(path.join(WEB, n), path.join(ROOT, n));

// A small paired fixture cut out of the run that is already on disk. Real reads,
// so the matrix has real species in it; small, so the bench is a minute and not
// an afternoon. Nothing is added to the repo — it all lives in the scratch dir.
const SRC1 = path.join(REPO, "data/prjeb83730/fastq/ERR14098649_1.fastq.gz");
const SRC2 = path.join(REPO, "data/prjeb83730/fastq/ERR14098649_2.fastq.gz");
if (!fs.existsSync(SRC1)) {
  console.error(`missing ${SRC1} — this bench needs the sample run that is already in data/`);
  process.exit(2);
}
for (const [src, dst] of [[SRC1, "ERRTEST_1.fastq.gz"], [SRC2, "ERRTEST_2.fastq.gz"]]) {
  const out = path.join(ROOT, "f", dst);
  // No `pipefail` here on purpose: `head` closing the pipe kills `zcat` with
  // SIGPIPE (exit 141), which is the NORMAL way this finishes. The result is
  // checked by its size instead.
  execFileSync("bash", ["-c",
    `zcat ${JSON.stringify(src)} | head -n ${RECORDS * 4} | gzip -1 > ${JSON.stringify(out)}`]);
  if (fs.statSync(out).size < 1024) throw new Error(`fixture ${dst} came out empty`);
}
const size1 = fs.statSync(path.join(ROOT, "f/ERRTEST_1.fastq.gz")).size;
const size2 = fs.statSync(path.join(ROOT, "f/ERRTEST_2.fastq.gz")).size;

// The filereport answer, in the shape the real API returns it: schemeless-ish
// host, semicolon lists, string numbers. http:// (not https) because the local
// server speaks plain HTTP — the host itself is still ftp.sra.ebi.ac.uk, so
// ena.js's allow-list is exercised rather than bypassed.
// Two runs, because the worker has two URL entry points and only one of them
// would otherwise be exercised: a paired one (profileUrlsPe, the R1/R2 drift
// budget) and a single-end one (profileUrls). The SE run reuses R1 — same file,
// so the fixture stays small and the faults hit both samples.
fs.writeFileSync(path.join(ROOT, "api/filereport"), JSON.stringify([
  {
    run_accession: "ERRTEST",
    library_layout: "PAIRED",
    fastq_ftp: `http://ftp.sra.ebi.ac.uk/f/ERRTEST_1.fastq.gz;http://ftp.sra.ebi.ac.uk/f/ERRTEST_2.fastq.gz`,
    fastq_bytes: `${size1};${size2}`,
    // The ENA's read_count counts SEQUENCED READS, so a paired run of N pairs
    // publishes 2N — which is why expectedProfiledReads() halves it to compare
    // against a pair count. The fixture is RECORDS pairs (RECORDS*4 lines cut
    // out of each mate), so this has to be 2*RECORDS. It used to say RECORDS,
    // which described a run of RECORDS/2 pairs and made the page correctly
    // report the sample as INCOMPLETE — twice as many reads came out of the
    // download as the catalogue claimed the run holds.
    read_count: String(RECORDS * 2),
  },
  {
    run_accession: "ERRTESTSE",
    library_layout: "SINGLE",
    fastq_ftp: `http://ftp.sra.ebi.ac.uk/f/ERRTEST_1.fastq.gz`,
    fastq_bytes: `${size1}`,
    read_count: String(RECORDS),
  },
]));

const server = spawn("python3", [
  path.join(REPO, "scripts/flaky_server.py"),
  "--root", ROOT, "--port", String(PORT), "--log", LOG,
  // Every SECOND request for R1, which lands on the body: request 1 is
  // detectGzip's two-byte probe, request 2 is the download itself, and the
  // resume that follows is request 3.
  "--target", TARGET, "--cut-every", "2", "--cut-at", "0.5",
], { stdio: ["ignore", "ignore", process.env.VERBOSE ? "inherit" : "ignore"] });

const readLog = () => (fs.existsSync(LOG)
  ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : []);

// ---- the smallest CDP client that can click a button -------------------------

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new Cdp(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const w = c.waiting.get(msg.id);
      if (w) { c.waiting.delete(msg.id); w(msg); }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description ?? "page exception");
    }
    return r.result?.result?.value;
  }
  // Waits, and keeps every distinct value it saw on the way. Progress lines are
  // transient by nature: the only way to assert that a resume was REPORTED to
  // the user is to watch the line while the run happens.
  async waitFor(expr, re, timeoutMs, label, seen = null) {
    const t0 = Date.now();
    let last = "";
    while (Date.now() - t0 < timeoutMs) {
      last = (await this.eval(expr)) ?? "";
      if (seen && (seen.length === 0 || seen[seen.length - 1] !== last)) seen.push(last);
      if (re.test(last)) return last;
      await sleep(250);
    }
    throw new Error(`${label ?? expr} never matched ${re} — last: "${String(last).slice(0, 300)}"`);
  }
}

async function targetWs(match) {
  for (let i = 0; i < 200; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const t = list.find((x) => x.type === "page" && x.url.includes(match));
      if (t?.webSocketDebuggerUrl) return t.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("no debuggable page appeared");
}

let chrome = null;
async function launch() {
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-first-run", `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`,
    "--disable-background-networking", "--disable-sync", "--disable-default-apps",
    "--disable-component-update", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    // THE hook that lets the worker's own fetch reach the test server while
    // still going through ena.js's allow-list on the real hostname.
    `--host-resolver-rules=MAP ftp.sra.ebi.ac.uk 127.0.0.1:${PORT}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore"], detached: true });
  const cdp = await Cdp.attach(await targetWs("about:blank"));
  await cdp.send("Page.enable");
  // The portal API call is made on the main thread, so a fetch shim installed
  // before the document runs is enough — and it keeps the module's own URL
  // building (encodeURIComponent, the field list, format=json) under test.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      (() => {
        const real = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = typeof input === "string" ? input : input?.url ?? "";
          if (url.startsWith("https://www.ebi.ac.uk/ena/portal/api/filereport")) {
            window.__enaApiCalls = (window.__enaApiCalls ?? 0) + 1;
            window.__enaApiUrl = url;
            return real("${BASE}/api/filereport" + url.slice(url.indexOf("?")), init);
          }
          return real(input, init);
        };
      })();`,
  });
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    const ready = await cdp.eval(
      `document.readyState === "complete" && !!document.getElementById("enaAcc")`).catch(() => false);
    if (ready === true) return cdp;
    await sleep(250);
  }
  throw new Error("index.html never finished loading");
}

function kill() {
  if (!chrome) return;
  try { process.kill(-chrome.pid, "SIGKILL"); } catch { /* gone */ }
  try { execFileSync("pkill", ["-9", "-f", `--user-data-dir=${PROFILE}`], { stdio: "ignore" }); }
  catch { /* nothing left */ }
  chrome = null;
}

// ---- the run -----------------------------------------------------------------

try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/_reset`)).ok) break; } catch { /* wait */ }
    await sleep(100);
  }
  console.log(`driving index.html against ${BASE}`);
  console.log(`fixture: ${RECORDS.toLocaleString("en-US")} pairs, ` +
    `${(size1 / 1024 ** 2).toFixed(1)} + ${(size2 / 1024 ** 2).toFixed(1)} MiB, ` +
    `R1 cut every 2nd request\n`);

  const cdp = await launch();

  // The two claims the banner makes, in the page as shipped.
  const banner = await cdp.eval(`document.querySelector(".privacy-notice").textContent`);
  check("the banner still promises local files never leave",
    /never leave your computer/.test(banner));
  // The EBI claim is NOT in the top banner any more, and should not be: that
  // banner is about the reader's own files, and mixing "yours never leave" with
  // "these ones come from Bethesda" into one paragraph blunted both. It now sits
  // inside the ENA card, where someone about to use that mode reads it — which
  // is what this checks, rather than merely that the words exist somewhere.
  const enaHead = await cdp.eval(
    `document.querySelector("#enaPanel .ena-head").textContent`);
  check("the ENA card says the mode downloads from the EBI, which sees the request",
    /EBI/.test(enaHead) && /IP address/.test(enaHead), enaHead.slice(0, 100));
  check("...and the top banner keeps to the reader's own files",
    !/EBI/.test(banner), banner.slice(0, 100));

  // ---- 1. look up ------------------------------------------------------------
  await cdp.eval(`
    (() => {
      const i = document.getElementById("enaAcc");
      i.value = "err14098592";               // lower case on purpose
      document.getElementById("enaResolve").click();
    })()`);
  const summary = await cdp.waitFor(
    `document.getElementById("enaSummary").textContent`, /to download/, 30_000, "#enaSummary");
  console.log(`   ${summary}`);
  check("the accession was normalised before it was sent",
    /accession=ERR14098592&/.test(await cdp.eval(`window.__enaApiUrl ?? ""`)),
    await cdp.eval(`window.__enaApiUrl ?? ""`));
  check("exactly one request went to the portal API",
    (await cdp.eval(`window.__enaApiCalls`)) === 1);
  const runsText = await cdp.eval(`document.getElementById("enaRuns").textContent`);
  // The layout tag is bracketed in the SAMPLE list below and bare in the run
  // list here — renderEnaRuns writes `<small>PE</small>`, renderFilesList writes
  // `<small>[PE]</small>`. This check used to demand brackets in both.
  check("both runs are listed, with their layout and size",
    /ERRTEST\b/.test(runsText) && /ERRTESTSE/.test(runsText)
    && /\bPE\b/.test(runsText) && /\bSE\b/.test(runsText), runsText.replace(/\s+/g, " ").slice(0, 200));
  check("the download total is shown BEFORE anything starts",
    /MB|KB|GB/.test(summary) && /2 runs/.test(summary), summary);
  check("...with an ETA and where the rate came from",
    /(measured on your link|assumed until measured)/.test(summary), summary);
  check("nothing has been downloaded yet",
    readLog().filter((l) => l.path.startsWith("/f/")).length === 0);

  // ---- 2. add to the sample list --------------------------------------------
  await cdp.eval(`document.getElementById("enaAdd").click()`);
  const listed = await cdp.waitFor(
    `document.getElementById("filesList").textContent`, /ERRTEST/, 10_000, "#filesList");
  check("both runs joined the same sample list as dropped files",
    /ERRTEST\b/.test(listed) && /ERRTESTSE/.test(listed));
  check("...marked as paired-end and as coming from the ENA",
    /\[PE\]/.test(listed) && /\[ENA\]/.test(listed), listed.slice(0, 160));
  const pending = await cdp.eval(`document.getElementById("enaPending").textContent`);
  // "never written to your disk" became "never permanently saved to your disk"
  // when the resumable OPFS cache landed: reference databases ARE written to
  // disk, reads are not, and the old wording no longer distinguished them.
  check("the pending download total sits next to the run button",
    /still to download/.test(pending) && /never permanently saved to your disk/.test(pending),
    pending.slice(0, 160));

  // ---- 3. the database, then the run ----------------------------------------
  await cdp.eval(`
    (() => {
      const s = document.getElementById("dbSelect");
      s.value = [...s.options].find(o => o.value.includes("gut_mini")).value;
      document.getElementById("poolSize").value = "2";
      document.getElementById("loadDb").click();
    })()`);
  await cdp.waitFor(`document.getElementById("dbInfo").textContent`, /Database ready/, 180_000, "#dbInfo");

  // The second sketch, ON, for this run. It is the only way to find out whether
  // the wiring holds end to end: the reference has to reach both workers, every
  // feed path has to hand it the same bytes sylph gets, and the profile has to
  // come back on the same reply as the TSV. Nothing below the browser can tell
  // you that — a worker that never loaded the reference returns an empty profile
  // and no error at all.
  await cdp.eval(`document.getElementById("funcOn").checked = true`);

  await cdp.eval(`document.getElementById("run").click()`);
  const steps = [];
  const step = await cdp.waitFor(`document.getElementById("step").textContent`,
    /done — \d+ sample/, 600_000, "#step", steps);
  console.log(`   ${step}`);
  check("both samples profiled without failing", /done — 2 samples ok, 0 failed/.test(step), step);
  // The paired path and the single-end path, both over URLs.
  check("the run line named the download while it was happening",
    steps.some((l) => /downloading \+ decompressing/.test(l)),
    steps.find((l) => /decompressing/.test(l))?.slice(0, 90) ?? "never seen");
  check("a resume was reported to the user, not swallowed",
    steps.some((l) => /resuming at/.test(l)),
    steps.find((l) => /resuming|resum/.test(l))?.slice(0, 120) ?? "no retry line seen");

  const status = await cdp.eval(`document.getElementById("filesList").textContent`);
  check("the sample list says species were detected", /species detected/.test(status),
    status.slice(0, 200));
  const rows = await cdp.eval(`document.querySelectorAll("#matrixBody tr").length`);
  check("the abundance matrix has rows", rows > 0, `${rows} rows`);
  // The FIRST header row. There are two: the second carries the reference each
  // column was profiled against, and counting both made this read 8 for a
  // 4-column table — a number that says nothing about whether the samples are
  // there.
  const cols = await cdp.eval(
    `document.querySelectorAll("#matrixHead tr:first-child th").length`);
  check("...and a column per sample (species, genome, then the two runs)", cols === 4, `${cols} columns`);
  // The second row is not decoration: it is what the numbers above it are
  // relative to, and a matrix that lost it would be a matrix of bare percentages.
  const refRow = await cdp.eval(
    `document.querySelector("#matrixHead .matrix-ref-row")?.textContent.replace(/\\s+/g, " ").trim() ?? ""`);
  check("...each column saying which reference it was profiled against",
    /\S/.test(refRow), refRow.slice(0, 120));
  check("the results card is visible",
    (await cdp.eval(`!document.getElementById("results").classList.contains("hide")`)) === true);
  check("no error was shown", (await cdp.eval(`document.getElementById("error").textContent`)) === "");

  // ---- 3b. the functional half of the same run -------------------------------
  const funcRefLine = steps.find((l) => /KEGG ortholog reference/.test(l));
  check("the run said it was loading the KEGG ortholog reference",
    !!funcRefLine, funcRefLine?.slice(0, 90) ?? "never seen");
  // Both samples, not one: the paired path and the single-end path each carry
  // their own feed loop, and each is a separate chance to sketch nothing.
  await cdp.eval(`document.querySelector('.res-tab[data-res="func"]').click()`);
  const funcSamples = await cdp.eval(
    `document.querySelectorAll("#funcHead th").length`);
  const funcText = await cdp.eval(`document.getElementById("funcPanel").textContent`);
  check("the Function tab is not refusing after a run that asked for functions",
    !/not measured for this run|does not measure functions/.test(funcText),
    funcText.slice(0, 160));
  // KEGG's own terms come BEFORE any of KEGG's identifiers, on a browser that
  // has never answered — which this one has not. Nothing of KEGG's is on screen
  // until the question is answered, and that is the point of the gate.
  const gate = await cdp.eval(
    `document.getElementById("funcPanel").textContent.replace(/\\s+/g, " ").trim()`);
  check("KEGG's terms are asked before any KEGG identifier is shown",
    /Academic use of KEGG is free/.test(gate) && !/\bK\d{5}\b|\bmap\d{5}\b/.test(gate),
    gate.slice(-140));
  await cdp.eval(`document.getElementById("keggAcademic").click()`);
  await cdp.waitFor(`document.querySelectorAll("#funcBody tr").length`, /^[1-9]/, 30_000,
    "#funcBody rows");

  const funcRows = await cdp.eval(`document.querySelectorAll("#funcBody tr").length`);
  check("...and it has rows, measured in this browser from these reads",
    funcRows > 0, `${funcRows} rows, ${funcSamples} header cells`);
  // A column per sample, both of them: the paired path and the single-end path
  // each carry their own feed loop, and each is a separate chance to sketch
  // nothing and report it as a sample with no functions.
  const funcCols = await cdp.eval(`document.querySelectorAll("#funcHead th").length`);
  check("...for BOTH samples, the paired one and the single-end one",
    funcCols >= 3, `${funcCols} header cells`);
  const funcBody = await cdp.eval(
    `document.getElementById("funcBody").textContent.replace(/\\s+/g, " ").trim().slice(0, 300)`);
  check("...naming KEGG pathways by identifier", /map\d{5}/.test(funcBody), funcBody.slice(0, 120));

  // ---- 3c. the single-sample page, which has the same two tabs ---------------
  //
  // A separate page with its own script, sharing kegg.js and the worker. It is
  // checked HERE rather than in a harness of its own because the browser, the
  // server and the database cache are already up — and because one thing worth
  // proving is that the KEGG licence answer given on the multi-sample page above
  // carries over, which needs both pages in one browser profile.
  await cdp.send("Page.navigate", { url: `${BASE}/profile.html` });
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000) {
      if (await cdp.eval(`document.readyState === "complete" && !!document.getElementById("funcOn")`)
        .catch(() => false) === true) break;
      await sleep(250);
    }
  }
  check("the single-sample page has the same two tabs",
    (await cdp.eval(`document.querySelectorAll(".res-tab").length`)) === 2);
  check("...and the same functional opt-in, off by default",
    (await cdp.eval(`document.getElementById("funcOn").checked`)) === false);

  // A file, a database, a run — with functions on.
  const { root } = await cdp.send("DOM.getDocument").then((r) => r.result);
  const { nodeId } = await cdp.send("DOM.querySelector",
    { nodeId: root.nodeId, selector: "#file" }).then((r) => r.result);
  await cdp.send("DOM.setFileInputFiles",
    { nodeId, files: [path.join(ROOT, "f/ERRTEST_1.fastq.gz")] });
  await cdp.eval(`document.getElementById("file").dispatchEvent(new Event("change", { bubbles: true }))`);
  await cdp.eval(`
    (() => {
      const s = document.getElementById("dbSelect");
      s.value = [...s.options].find(o => o.value.includes("gut_mini")).value;
      s.dispatchEvent(new Event("change", { bubbles: true }));
      document.getElementById("loadDb").click();
    })()`);
  await cdp.waitFor(`document.getElementById("dbInfo").textContent`, /Database ready/, 180_000,
    "profile.html #dbInfo");
  await cdp.eval(`document.getElementById("funcOn").checked = true`);
  await cdp.eval(`document.getElementById("run").click()`);
  const done = await cdp.waitFor(`document.getElementById("step").textContent`,
    /done in /, 600_000, "profile.html #step");
  check("the single-sample run finished", /done in /.test(done), done);
  check("no error was shown on the single-sample page",
    (await cdp.eval(`document.getElementById("error").textContent`)) === "");

  await cdp.eval(`document.querySelector('.res-tab[data-res="func"]').click()`);
  // The licence answer was given on the OTHER page, in this browser. One key,
  // one question, one answer — which is why it lives in kegg.js and not in
  // either page's own script.
  const pFunc = await cdp.eval(
    `document.getElementById("funcPanel").textContent.replace(/\\s+/g, " ").trim()`);
  check("the KEGG answer given on the multi-sample page carries to this one",
    !/Academic use of KEGG is free/.test(pFunc), pFunc.slice(0, 120));
  await cdp.waitFor(`document.querySelectorAll("#funcBody tr").length`, /^[1-9]/, 30_000,
    "profile.html #funcBody rows");
  const pRows = await cdp.eval(`document.querySelectorAll("#funcBody tr").length`);
  const pBody = await cdp.eval(
    `document.getElementById("funcBody").textContent.replace(/\\s+/g, " ").trim().slice(0, 200)`);
  check("...and the single sample has a functional profile of its own",
    pRows > 0 && /map\d{5}/.test(pBody), `${pRows} rows: ${pBody.slice(0, 100)}`);
  // The completeness figure, on screen, in the same voice as the biome warning:
  // a reader who takes an empty row as "this sample cannot do that" is reading
  // four times more into it than the method supports.
  const pNote = await cdp.eval(`document.getElementById("funcRef").textContent`);
  check("...with a line saying what the method finds and what it misses",
    /relative to the orthologs detected/.test(pNote) && /60 %/.test(pNote) && /85 %/.test(pNote),
    pNote.slice(0, 120));

  // ---- 4. what the network actually did --------------------------------------
  const log = readLog();
  const r1 = log.filter((l) => l.path === TARGET);
  const r2 = log.filter((l) => l.path === "/f/ERRTEST_2.fastq.gz");
  const cuts = r1.filter((l) => l.fault === "cut").length;
  const ranged = r1.filter((l) => l.range && l.range !== "bytes=0-1").length;
  console.log(`   R1: ${r1.length} requests, ${cuts} cut, ${ranged} resumed with Range; ` +
    `R2: ${r2.length} requests`);
  // ONE download of the KEGG ortholog reference, whatever the pool size. Every
  // worker needs its own copy in its own wasm memory, but they must not each
  // fetch 20 MB: two workers starting together both miss the browser's cache and
  // both pull the file. This is the same rule db-cache.js exists to keep for the
  // 433 MB database, applied to the 20 MB one.
  const refHits = log.filter((l) => /ko-sketches-k11/.test(l.path));
  const refBody = refHits.filter((l) => !l.range || !/bytes=0-1$/.test(l.range));
  console.log(`   KEGG reference: ${refHits.length} requests, ${refBody.length} for the body ` +
    `(pool of 2)`);
  check("the KEGG reference is downloaded once for the whole pool",
    refBody.length === 1, `${refBody.length} full-body requests: ${refHits.map((l) => l.range ?? "no range").join(", ")}`);

  check("the download really was cut mid-run", cuts > 0, `${cuts} cuts`);
  check("...and really was resumed with a Range request", ranged > 0, `${ranged} ranged requests`);
  check("the whole run was streamed, never stored",
    r1.reduce((a, l) => a + (l.sent ?? 0), 0) > size1 * 0.9,
    `${r1.reduce((a, l) => a + (l.sent ?? 0), 0)} bytes for a ${size1} byte file`);
  check("no request ever went anywhere but the test server",
    log.every((l) => typeof l.path === "string"));

  // ---- 5. the contrast figure, on the bundled example -------------------------
  //
  // The two-sample run above cannot exercise it: contrasting needs two groups of
  // at least two samples each, and the example is the only thing on hand that
  // has them — 18 runs across six volunteers, with functional profiles already
  // in it. Loaded here rather than in a harness of its own for the same reason
  // profile.html was: the browser and the server are already up.
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000) {
      if (await cdp.eval(`document.readyState === "complete" && !!document.getElementById("demoLoad")`)
        .catch(() => false) === true) break;
      await sleep(250);
    }
  }
  await cdp.eval(`document.getElementById("demoLoad").click()`);
  await cdp.waitFor(`document.querySelectorAll("#matrixBody tr").length`, /^[1-9]/, 120_000,
    "the example's matrix");
  await cdp.eval(`document.querySelector('.fig-tab[data-fig="contrast"]').click()`);
  const cSvg = await cdp.eval(`document.getElementById("figCanvas").innerHTML`);
  check("the taxonomic contrast figure draws, and names the two groups it contrasts",
    /Largest differences between/.test(cSvg) && /n=\d+/.test(cSvg),
    (cSvg.match(/Largest differences between[^<]*/) ?? ["no heading"])[0]);
  // The test is printed, and so is what bounds it. On the example's donor
  // grouping — three samples a side — the smallest p the test can return is 0.1,
  // so no row can reach 0.05: without that sentence the q column reads as a
  // column of failures rather than as arithmetic.
  // Said the right way round — 0.1 itself IS reached, by a perfect split — and
  // in whichever of its shortenings fits the width the page gives the figure.
  check("...with a q per row, and the floor that q cannot go below",
    /Benjamini-Hochberg q = /.test(cSvg) &&
    /at 3 v 3 is 0\.1, so nothing reaches 0\.05|0\.1 at 3 v 3: nothing reaches 0\.05|at 3 v 3 p ≥ 0\.1 > 0\.05/
      .test(cSvg) && !/nothing can reach 0\.1/.test(cSvg),
    (cSvg.match(/q: [^<]*/) ?? ["no floor sentence"])[0]);
  const cDots = (cSvg.match(/<circle /g) ?? []).length;
  check("...with one dot per sample per row", cDots >= 18, `${cDots} dots`);
  const cNote = await cdp.eval(`document.getElementById("figNote").textContent`);
  // The caption used to repeat the method the figure already carries, at greater
  // length — three statements of one sentence on one screen. What it owes the
  // reader is the part the picture cannot say: what a dot is FOR.
  check("...and the caption says what the figure cannot, rather than repeating it",
    /click a dot/.test(cNote) && !/Mann-Whitney/.test(cNote), cNote.slice(0, 140));

  // The same figure on the functional half, at the level the picker is on.
  await cdp.eval(`document.querySelector('.res-tab[data-res="func"]').click()`);
  await cdp.eval(`document.querySelector('.func-tab[data-ffig="contrast"]').click()`);
  // The functional panel fetches KEGG's ortholog map before it can draw anything,
  // so the figure appears a beat after the click rather than with it.
  await cdp.waitFor(`document.getElementById("funcCanvas").innerHTML.slice(0, 40)`,
    /<svg/, 30_000, "the functional figure");
  const fSvg = await cdp.eval(`document.getElementById("funcCanvas").innerHTML`);
  check("the functional contrast figure draws over KEGG pathways",
    /Largest differences between/.test(fSvg) && /map\d{5}/.test(fSvg),
    (fSvg.match(/map\d{5}[^<]*/) ?? ["no pathway named"])[0]);
  const fNote = await cdp.eval(`document.getElementById("funcFigNote").textContent`);
  // The same caption as the taxonomic half — the two halves are symmetrical on
  // purpose, and a reader who learns one learns the other. Neither restates the
  // method the figure already carries.
  check("...and says the same thing under it as the other half",
    /click a dot/.test(fNote) && !/Mann-Whitney/.test(fNote), fNote.slice(0, 140));
  // Top-N names rows here as it does on the composition bars, so the slider has
  // to be reachable — it was hidden on every figure but the composition.
  check("...with the Top N slider reachable on it",
    (await cdp.eval(`!document.getElementById("funcTopN").classList.contains("hide")`)) === true);

  // Six volunteers of three samples each makes "the two largest groups" a coin
  // toss settled by alphabetical order. The reader picks instead — and picking
  // has to change the figure, not only the dropdown.
  const opts = await cdp.eval(
    `[...document.getElementById("funcContrastA").options].map(o => o.value).join(",")`);
  check("the contrast pair is the reader's to choose",
    (await cdp.eval(`!document.getElementById("funcContrastWrap").classList.contains("hide")`)) === true &&
    opts.split(",").length >= 3, opts);
  const before = await cdp.eval(`document.getElementById("funcCanvas").innerHTML`);
  await cdp.eval(`
    (() => {
      const b = document.getElementById("funcContrastB");
      const a = document.getElementById("funcContrastA").value;
      b.value = [...b.options].map(o => o.value).filter(v => v !== a && v !== b.value)[0];
      b.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
  const after = await cdp.eval(`document.getElementById("funcCanvas").innerHTML`);
  check("...and changing it redraws the figure against the group picked",
    before !== after && /Largest differences between/.test(after),
    (after.match(/Largest differences between[^<"]*/) ?? ["no heading"])[0]);
  // Picking the group already on the other side would contrast a group with
  // itself: every difference zero, every row dropped, an empty figure.
  await cdp.eval(`
    (() => {
      const a = document.getElementById("funcContrastA"), b = document.getElementById("funcContrastB");
      b.value = a.value;
      b.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
  const swapped = await cdp.eval(`document.getElementById("funcCanvas").innerHTML`);
  check("...and a group cannot be contrasted with itself",
    !/Nothing to contrast/.test(swapped) &&
    (await cdp.eval(`document.getElementById("funcContrastA").value !== document.getElementById("funcContrastB").value`)) === true,
    (swapped.match(/Largest differences between[^<"]*/) ?? ["no heading"])[0]);

  // ---- 5b. making the groups, and keeping the click --------------------------
  //
  // Contrasting needs groups, and until now the only way to have any was a CSV
  // written elsewhere. The archive's own metadata was in the session all along.
  const gOpts = await cdp.eval(
    `[...document.getElementById("funcGroupSource").options].map(o => o.value).join(",")`);
  check("groups can come from a field of the archive's own metadata",
    /field:host_sex/.test(gOpts) && !/field:country/.test(gOpts), gOpts);
  await cdp.eval(`(() => { const s = document.getElementById("funcGroupSource");
    s.value = "field:host_sex"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await cdp.waitFor(`document.getElementById("funcCanvas").innerHTML`,
    /female \(n=9\)/, 20_000, "the contrast regrouped by host_sex");
  check("...and picking one regroups the figure", true, "female (n=9) vs male (n=9)");

  // With no groups the figure must ASK, not substitute: it used to draw "most
  // variable rows", which is a real answer to a different question under a tab
  // labelled Contrast, and the only hint was a grey clause inside the picture.
  await cdp.eval(`(() => { const s = document.getElementById("funcGroupSource");
    s.value = "none"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await cdp.waitFor(`document.getElementById("funcCanvas").textContent`,
    /A contrast is between two groups/, 20_000, "the contrast's refusal");
  check("a contrast with no groups asks for them, in the canvas, with buttons",
    (await cdp.eval(`!!document.getElementById("contrastMakeGroups")`)) === true &&
    (await cdp.eval(`!!document.getElementById("contrastByField")`)) === true);
  await cdp.eval(`document.getElementById("contrastByField").click()`);
  await cdp.waitFor(`document.getElementById("funcCanvas").innerHTML`,
    /female \(n=9\)/, 20_000, "one click to group by the best field");
  check("...and one click on the field it offers is enough", true, "female (n=9) vs male (n=9)");

  // Made by hand, in the editor, on a run with no useful metadata at all — which
  // is every local FASTQ.
  await cdp.eval(`document.getElementById("funcGroupEdit").click()`);
  const gRows = await cdp.eval(`document.querySelectorAll("#groupList input[data-group-for]").length`);
  check("the editor lists every sample with a field of its own", gRows === 18, `${gRows} rows`);
  await cdp.eval(`
    (() => {
      [...document.querySelectorAll("#groupList input[data-group-for]")].forEach((el, i) => {
        el.value = i < 9 ? "oil A" : "oil B";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    })()`);
  check("...and says what the grouping is worth as it is made",
    /2 groups, 18 of 18 samples/.test(
      await cdp.eval(`document.getElementById("groupEditNote").textContent`)));
  // AND THEY CAN LEAVE. Eighteen names typed into eighteen boxes lived in this
  // tab and nowhere else; the file is the only way to keep them, or to run the
  // same grouping through anything else. The anchor's click is intercepted
  // rather than followed, because a headless browser has nowhere to put a
  // download and what is being checked is that the button is wired at all —
  // a handler that throws leaves a button that looks fine and does nothing.
  const saved = await cdp.eval(`(() => {
    const errs = [];
    const real = HTMLAnchorElement.prototype.click;
    let name = null, text = null;
    const realCreate = URL.createObjectURL;
    HTMLAnchorElement.prototype.click = function () { name = this.download; };
    try { document.getElementById("groupSave").click(); } catch (e) { errs.push(String(e)); }
    HTMLAnchorElement.prototype.click = real;
    URL.createObjectURL = realCreate;
    return JSON.stringify({ name, errs });
  })()`);
  check("...and they can be saved as the two-column CSV the page reads back",
    /peekmicrobiome-groups-.*\.csv/.test(saved) && /"errs":\[\]/.test(saved), saved);
  await cdp.eval(`document.getElementById("groupEdit").close()`);
  await cdp.waitFor(`document.getElementById("funcCanvas").innerHTML`,
    /oil A \(n=9\)/, 20_000, "the contrast regrouped by hand");
  check("...and the groups made here become the contrast", true, "oil A (n=9) vs oil B (n=9)");

  // The test, and the sentence that bounds it. At nine a group the floor does not
  // apply; the demo's donor grouping (three a side) is where it does, and that is
  // checked below by regrouping.
  const fSvg2 = await cdp.eval(`document.getElementById("funcCanvas").innerHTML`);
  // Corrected over every row that CAN differ, and saying how many: all of them
  // when every row varies across the samples, "the k of n rows that vary" when
  // some are equal in every sample of both groups (p = 1 by construction).
  check("the contrast carries a q, corrected across every row that can differ",
    /Benjamini-Hochberg q = /.test(fSvg2) &&
    /(Benjamini-Hochberg|BH) over (all \d+|the \d+ of \d+|\d+ of \d+) rows/.test(fSvg2),
    (fSvg2.match(/over [^<·]*rows/) ?? ["none"])[0]);

  // A dot in a lane stands for a sample, exactly as a point in the ordination
  // does — and it was the only such mark on the page that could not be asked
  // about. Reported as "clicking the points does not work for the contrast".
  const dot = await cdp.eval(`
    (() => { const p = document.querySelector('#funcCanvas .contrast-pt');
      if (!p) return ""; p.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return p.getAttribute("data-sample"); })()`);
  await cdp.waitFor(`document.getElementById("funcDetail").textContent`,
    new RegExp(dot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), 20_000, "the sample panel");
  check("a dot in a contrast lane opens that sample too", !!dot, dot);
  // Closed again before moving on. The open sample is a page-level notion shared
  // by both halves, so leaving it open here makes the next section's click on the
  // SAME sample a close rather than an open — the toggle doing exactly what it
  // says, and a check below reading it as a failure.
  await cdp.eval(`
    (() => { const p = document.querySelector('#funcCanvas .contrast-pt');
      p?.dispatchEvent(new MouseEvent("click", { bubbles: true })); })()`);
  await sleep(400);

  // 468 species by 18 samples, and until this there was no way to reach one of
  // them but scrolling.
  await cdp.eval(`(() => { const i = document.getElementById("funcFind");
    i.value = "glycol"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await sleep(400);
  const found = await cdp.eval(`document.querySelectorAll("#funcBody tr").length`);
  const foundNote = await cdp.eval(`document.getElementById("funcFindNote").textContent`);
  check("a matrix of hundreds can be searched", found > 0 && /of \d+/.test(foundNote),
    `${found} rows — ${foundNote}`);
  await cdp.eval(`(() => { const i = document.getElementById("funcFind");
    i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await sleep(400);
  // Clicking a sample column answers "what dominates THIS sample", which the
  // table's own order — the total across every sample — cannot.
  const firstFive = `[...document.querySelectorAll("#funcBody tr")].slice(0,5).map(t=>t.cells[0].textContent).join("|")`;
  const beforeSort = await cdp.eval(firstFive);
  await cdp.eval(`document.querySelectorAll("#funcHead th[data-sort-col]")[4].click()`);
  await sleep(400);
  const afterSort = await cdp.eval(firstFive);
  check("...and sorted by a sample, with a third click back to its own order",
    beforeSort !== afterSort, `${beforeSort.slice(0, 30)} -> ${afterSort.slice(0, 30)}`);
  await cdp.eval(`document.querySelectorAll("#funcHead th[data-sort-col]")[4].click()`);
  await cdp.eval(`document.querySelectorAll("#funcHead th[data-sort-col]")[4].click()`);
  await sleep(400);
  check("...which it does", (await cdp.eval(firstFive)) === beforeSort);

  // A module cell opens to say what it was measured from. "0.88 %" answers how
  // much without answering of what.
  await cdp.eval(`(() => { const s = document.getElementById("funcGrain");
    s.value = "module"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await cdp.waitFor(`String(document.querySelectorAll("#funcBody .cell-open").length)`,
    /^[1-9]/, 20_000, "openable cells at the module level");
  await cdp.eval(`document.querySelector("#funcBody .cell-open").click()`);
  const cellPop = await cdp.eval(
    `document.getElementById("cellPop") ? document.getElementById("cellPop").textContent : ""`);
  check("a module cell opens to the orthologs it was measured from",
    /orthologs of this module were detected/.test(cellPop) && /K\d{5}/.test(cellPop),
    cellPop.replace(/\s+/g, " ").slice(0, 110));
  await cdp.eval(`document.querySelector("#funcBody .cell-open").click()`);
  check("...and a second click on the same cell closes it",
    (await cdp.eval(`!document.getElementById("cellPop")`)) === true);
  // An ortholog row is not a set of orthologs: there is nothing inside it that
  // its own identifier does not already link to.
  await cdp.eval(`(() => { const s = document.getElementById("funcGrain");
    s.value = "ko"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await sleep(900);
  check("...while an ortholog cell offers nothing beyond its identifier",
    (await cdp.eval(`document.querySelectorAll("#funcBody .cell-open").length`)) === 0);
  await cdp.eval(`(() => { const s = document.getElementById("funcGrain");
    s.value = "pathway"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await sleep(900);

  // The rare taxa in the open sample: one wedge each, still grey and still one
  // legend row, and each answering to a hover. They were a single wedge labelled
  // "other taxa (110)" — a hundred and ten measurements with nothing to ask.
  {
    // Opened again: the check above closed it, to leave the toggle where the
    // section after this one expects it.
    await cdp.eval(`
      (() => { const p = document.querySelector('#funcCanvas .contrast-pt');
        p?.dispatchEvent(new MouseEvent("click", { bubbles: true })); })()`);
    await cdp.waitFor(`String(document.querySelectorAll("#funcDetail .pie-slice").length)`,
      /^[1-9]/, 20_000, "the open sample's pie");
    const rare = await cdp.eval(
      `document.querySelectorAll("#funcDetail .pie-slice[data-rest]").length`);
    const named = await cdp.eval(
      `document.querySelectorAll("#funcDetail .pie-slice:not([data-rest])").length`);
    check("the pooled rows each get their own wedge in the open sample",
      rare > 5 && named > 0, `${named} named, ${rare} pooled`);
    const tip = await cdp.eval(`
      (() => {
        const el = document.querySelector('#funcDetail .pie-slice[data-rest]');
        if (!el) return "";
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new PointerEvent("pointermove",
          { bubbles: true, clientX: r.x + 1, clientY: r.y + 1, pointerType: "mouse" }));
        const t = document.getElementById("figTip");
        return (t && !t.classList.contains("hide")) ? t.textContent : "";
      })()`);
    check("...and hovering one names it at once, in the page's own tooltip",
      /\S/.test(tip) && /of this sample/.test(tip), tip.slice(0, 80));
    // Closed again, for the same reason it was closed above.
    await cdp.eval(`
      (() => { const p = document.querySelector('#funcCanvas .contrast-pt');
        p?.dispatchEvent(new MouseEvent("click", { bubbles: true })); })()`);
    await sleep(400);
  }

  // THE CONSTRAINT, checked rather than asserted: making groups must not cost
  // the gesture the figures are read with. A "click to group" mode would.
  await cdp.eval(`document.querySelector('.res-tab[data-res="taxo"]').click()`);
  await cdp.eval(`document.querySelector('.fig-tab[data-fig="pcoa"]').click()`);
  await cdp.waitFor(`document.getElementById("figCanvas").innerHTML.slice(0, 40)`,
    /<svg/, 20_000, "the ordination");
  const clicked = await cdp.eval(`
    (() => { const p = document.querySelector('#figCanvas [data-sample]');
      if (!p) return ""; p.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return p.getAttribute("data-sample"); })()`);
  await cdp.waitFor(`document.getElementById("figDetail").textContent`,
    new RegExp(clicked.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), 20_000, "the sample panel");
  check("a point on the plot still opens what that sample is made of", !!clicked, clicked);

} catch (e) {
  console.error(e);
  failures++;
} finally {
  kill();
  server.kill("SIGKILL");
}

console.log(failures === 0 ? "\nall page checks passed" : `\n${failures} page check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
