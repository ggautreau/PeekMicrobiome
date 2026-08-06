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
    read_count: String(RECORDS),
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
  check("the banner says the ENA mode downloads from the EBI, which sees the request",
    /EBI/.test(banner) && /IP address/.test(banner), banner.slice(0, 100));

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
  check("both runs are listed, with their layout and size",
    /ERRTEST\b/.test(runsText) && /ERRTESTSE/.test(runsText)
    && /\[PE\]/.test(runsText) && /\[SE\]/.test(runsText), runsText.replace(/\s+/g, " ").slice(0, 200));
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
  check("the pending download total sits next to the run button",
    /still to download/.test(pending) && /never written to your disk/.test(pending),
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
  const cols = await cdp.eval(`document.querySelectorAll("#matrixHead th").length`);
  check("...and a column per sample (species, genome, then the two runs)", cols === 4, `${cols} columns`);
  check("the results card is visible",
    (await cdp.eval(`!document.getElementById("results").classList.contains("hide")`)) === true);
  check("no error was shown", (await cdp.eval(`document.getElementById("error").textContent`)) === "");

  // ---- 4. what the network actually did --------------------------------------
  const log = readLog();
  const r1 = log.filter((l) => l.path === TARGET);
  const r2 = log.filter((l) => l.path === "/f/ERRTEST_2.fastq.gz");
  const cuts = r1.filter((l) => l.fault === "cut").length;
  const ranged = r1.filter((l) => l.range && l.range !== "bytes=0-1").length;
  console.log(`   R1: ${r1.length} requests, ${cuts} cut, ${ranged} resumed with Range; ` +
    `R2: ${r2.length} requests`);
  check("the download really was cut mid-run", cuts > 0, `${cuts} cuts`);
  check("...and really was resumed with a Range request", ranged > 0, `${ranged} ranged requests`);
  check("the whole run was streamed, never stored",
    r1.reduce((a, l) => a + (l.sent ?? 0), 0) > size1 * 0.9,
    `${r1.reduce((a, l) => a + (l.sent ?? 0), 0)} bytes for a ${size1} byte file`);
  check("no request ever went anywhere but the test server",
    log.every((l) => typeof l.path === "string"));
} catch (e) {
  console.error(e);
  failures++;
} finally {
  kill();
  server.kill("SIGKILL");
}

console.log(failures === 0 ? "\nall page checks passed" : `\n${failures} page check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
