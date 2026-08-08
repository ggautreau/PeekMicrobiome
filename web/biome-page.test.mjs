// The biome picker, driven through the REAL pages in a REAL browser.
//
//   node web/biome-page.test.mjs            (needs google-chrome and python3)
//
// web/fastq-trim.parity.test.mjs proves the catalogue file and the helpers in
// biomes.js; it says nothing about whether the pages are wired to them — a
// renamed element id, a listener that never fires, an <option> built but never
// selected, and every source-level check still passes while the picker does
// nothing. So this loads index.html and profile.html in headless Chrome, the way
// scripts/ena-test/page.mjs does, and checks end to end:
//   - the <select> is rebuilt from db/biomes.json, grouped, with the entries
//     that have no URL present-but-disabled;
//   - the note under it changes with the choice;
//   - a profile run names its reference above the matrix and inside the TSV/CSV;
//   - loading a DIFFERENT database resets the samples profiled against the old
//     one instead of mixing two catalogues in one matrix;
//   - a second biome in the download cache is listed as itself, and switching
//     back to the first one downloads nothing.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(WEB, "..");
const PORT = Number(process.env.PORT ?? 8877);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9377);
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "biome-page-"));
const ROOT = path.join(SCRATCH, "root");
const PROFILE = path.join(SCRATCH, "chrome");

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `   [${String(detail).slice(0, 220)}]` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- scratch site: web/ symlinked, plus a SECOND database to switch to -------
fs.mkdirSync(ROOT, { recursive: true });
for (const n of fs.readdirSync(WEB)) {
  if (n !== "db") fs.symlinkSync(path.join(WEB, n), path.join(ROOT, n));
}
fs.mkdirSync(path.join(ROOT, "db"));
for (const n of fs.readdirSync(path.join(WEB, "db"))) {
  if (n !== "biomes.json") fs.symlinkSync(path.join(WEB, "db", n), path.join(ROOT, "db", n));
}
// A copy of the smoke-test database under another URL: a second "biome" that is
// cheap to load, so the reference-change path can be driven for real.
fs.copyFileSync(path.join(WEB, "db/gut_mini.syldb"), path.join(ROOT, "db/mini_clone.syldb"));
const cat = JSON.parse(fs.readFileSync(path.join(WEB, "db/biomes.json"), "utf8"));
cat.groups.find((g) => g.key === "test").biomes.push({
  key: "clone-test", label: "Second test biome", hint: "a copy of the smoke test, under another URL",
  catalogue: "human-gut", version: "v2.0.2", species: 50, bytes: 6516832,
  file: "mini_clone.syldb", url: "db/mini_clone.syldb", bundled: true,
});
// Until the nineteen databases were published, eighteen entries in the real
// catalogue had no URL and this test asserted on those eighteen. They are all
// published now, so asserting "18 disabled" against production data would just
// be asserting 0 — a check that can no longer fail, which proves nothing about
// the greying-out path. The URL-less entry is therefore injected here, and the
// reason is a sentinel this test owns, so the assertion tests the mechanism
// (json -> normaliseBiome -> option label) rather than the wording of the day.
const PENDING_SENTINEL = "not published yet — sentinel reason for the biome-page test";
cat.pendingNote = PENDING_SENTINEL;
cat.groups.find((g) => g.key === "test").biomes.push({
  key: "unpublished-test", label: "Unpublished test biome", hint: "built but with nowhere to fetch it from",
  catalogue: "human-gut", version: "v2.0.2", species: 50, bytes: 6516832,
  file: "nowhere.syldb", url: "",
});
fs.writeFileSync(path.join(ROOT, "db/biomes.json"), JSON.stringify(cat));

// A real subsample where the run that the other benches use is already on disk,
// so the matrix comes out with real species in it. Where it is not (data/ is
// gitignored), synthetic reads: they detect nothing, which changes none of the
// claims below — every one of them is about which reference is NAMED, not about
// what was found.
const SRC = path.join(REPO, "data/prjeb83730/fastq/ERR14098649_1.fastq.gz");
const FASTQ = path.join(SCRATCH, "sampleA.fastq");
if (fs.existsSync(SRC)) {
  execFileSync("bash", ["-c",
    `zcat ${JSON.stringify(SRC)} | head -n 240000 > ${JSON.stringify(FASTQ)}`]);
} else {
  console.log("(no data/prjeb83730 sample on disk — using synthetic reads)");
  const rnd = (n, seed) => {
    let x = seed;
    let s = "";
    for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += "ACGT"[x % 4]; }
    return s;
  };
  let out = "";
  for (let i = 0; i < 20_000; i++) {
    const seq = rnd(150, i + 1);
    out += `@r${i}\n${seq}\n+\n${"I".repeat(150)}\n`;
  }
  fs.writeFileSync(FASTQ, out);
}
const fastqText = fs.readFileSync(FASTQ, "utf8");

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1",
  "--directory", ROOT], { stdio: "ignore" });

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
    return new Promise((resolve) => { this.waiting.set(id, resolve); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "page exception");
    return r.result?.result?.value;
  }
  async waitFor(expr, re, timeoutMs, label) {
    const t0 = Date.now();
    let last = "";
    while (Date.now() - t0 < timeoutMs) {
      last = (await this.eval(expr)) ?? "";
      if (re.test(last)) return last;
      await sleep(200);
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
    } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error("no debuggable page");
}

let chrome = null;
async function launch(page, fresh = false) {
  if (fresh && chrome) {
    try { process.kill(-chrome.pid, "SIGKILL"); } catch { /* gone */ }
    try { execFileSync("pkill", ["-9", "-f", `--user-data-dir=${PROFILE}`], { stdio: "ignore" }); }
    catch { /* none */ }
    chrome = null;
    await sleep(1000);
  }
  if (!chrome) {
    chrome = spawn("google-chrome", [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--no-first-run", `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`,
      "--disable-background-networking", "--disable-sync", "--disable-default-apps",
      "--disable-component-update", "--no-default-browser-check",
      "about:blank",
    ], { stdio: "ignore", detached: true });
  }
  const cdp = await Cdp.attach(await targetWs("about:blank"));
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: `${BASE}/${page}` });
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    const ready = await cdp.eval(`document.readyState === "complete" && document.getElementById("dbSelect").querySelectorAll("optgroup").length > 2`).catch(() => false);
    if (ready === true) return cdp;
    await sleep(200);
  }
  throw new Error(`${page} never finished loading`);
}

try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/db/biomes.json`)).ok) break; } catch { /* wait */ }
    await sleep(100);
  }
  const cdp = await launch("index.html");

  // ---- 0. the two modes ------------------------------------------------------
  // Manual and automatic need different controls, and showing both at once
  // invites choosing a biome and then screening for it — two answers to one
  // question. Automatic must NOT be the default: it costs a 13 MB download and
  // a screening pass, and most users know their biome.
  const m0 = await cdp.eval(`(() => ({
    manual: document.getElementById("modeManual").checked,
    pickerShown: !document.getElementById("manualRow").classList.contains("hide"),
    screenShown: !document.getElementById("screenRow").classList.contains("hide"),
  }))()`);
  check("manual is the default mode", m0.manual === true);
  check("...so the picker is shown", m0.pickerShown === true);
  check("...and the screening row is not", m0.screenShown === false);

  const m1 = await cdp.eval(`(() => {
    document.getElementById("modeAuto").click();
    return {
      pickerShown: !document.getElementById("manualRow").classList.contains("hide"),
      screenShown: !document.getElementById("screenRow").classList.contains("hide"),
      btnDisabled: document.getElementById("screenBtn").disabled,
      hint: document.getElementById("screenHint").textContent,
    };
  })()`);
  check("switching to automatic hides the picker", m1.pickerShown === false);
  check("...and shows the screening control", m1.screenShown === true);
  // Nothing to screen yet: a button that fails when pressed is worse than one
  // that says why it cannot be pressed.
  check("...with the button disabled while no sample is loaded", m1.btnDisabled === true);
  check("...and says so rather than leaving a dead button",
    /Add a sample below first/.test(m1.hint), m1.hint.slice(0, 60));
  await cdp.eval(`document.getElementById("modeManual").click()`);

  // ---- 0b. the read cap is readable ------------------------------------------
  // "3000000" is the number that decides how long a run takes, and it was shown
  // as seven bare digits. <input type="number"> cannot group them, so the field
  // is text — which means the code must read it back through a parser, and a
  // paste from a spreadsheet must not silently become 3.
  const reads = await cdp.eval(`(() => {
    const f = document.getElementById("maxReads");
    const initial = f.value;
    f.value = "2,500,000"; f.dispatchEvent(new Event("change", { bubbles: true }));
    const afterPaste = f.value;
    const slider = document.getElementById("maxReadsSlider").value;
    const s = document.getElementById("maxReadsSlider");
    s.value = "500000"; s.dispatchEvent(new Event("input", { bubbles: true }));
    const afterSlider = f.value;
    f.value = initial; f.dispatchEvent(new Event("change", { bubbles: true }));
    return { initial, afterPaste, slider, afterSlider, type: f.type };
  })()`);
  const grouped = (v) => /^\d{1,3}(\u202f\d{3})+$/.test(v);
  check("the read cap is grouped, not seven bare digits",
    grouped(reads.initial), JSON.stringify(reads.initial));
  check("...in a text field, since type=number cannot group", reads.type === "text");
  // A spreadsheet paste is the realistic way this field gets a comma.
  check("...a pasted '2,500,000' is understood and regrouped",
    grouped(reads.afterPaste) && reads.slider === "2500000",
    `${reads.afterPaste} / slider ${reads.slider}`);
  check("...and moving the slider regroups it too",
    reads.afterSlider.replace(/\u202f/g, "") === "500000" && grouped(reads.afterSlider),
    JSON.stringify(reads.afterSlider));

  // ---- 1. the picker ---------------------------------------------------------
  const shape = await cdp.eval(`(() => {
    const s = document.getElementById("dbSelect");
    const groups = [...s.querySelectorAll("optgroup")].map(g => g.label);
    const opts = [...s.options].map(o => ({ t: o.textContent, v: o.value, d: o.disabled }));
    return { groups, opts, value: s.value, note: document.getElementById("dbBiomeNote").textContent };
  })()`);
  check("the picker is grouped by family", shape.groups.length === 6, shape.groups.join(" | "));
  check("...and lists every catalogue", shape.opts.length === 23, `${shape.opts.length} options`);
  check("entries with no URL are shown, disabled, with the reason",
    shape.opts.filter(o => o.d).length === 1
    && shape.opts.filter(o => o.d).every(o => o.t.includes(PENDING_SENTINEL)),
    shape.opts.find(o => o.d)?.t);
  check("...and cannot be selected", shape.opts.filter(o => o.d).every(o => o.v === ""));
  // The other side of the same coin: now that they are published, the nineteen
  // real catalogues must all be selectable. Asserting only on the disabled one
  // would pass just as well if every entry had lost its URL.
  check("every published biome is selectable",
    shape.opts.filter(o => /zenodo\.org/.test(o.v)).length === 19
    && shape.opts.filter(o => /zenodo\.org/.test(o.v)).every(o => !o.d),
    `${shape.opts.filter(o => /zenodo\.org/.test(o.v)).length} zenodo options`);
  check("...all from the one published record, not the superseded one",
    shape.opts.filter(o => /zenodo\.org/.test(o.v)).every(o => o.v.includes("/records/21842023/")),
    shape.opts.find(o => /zenodo\.org/.test(o.v) && !o.v.includes("21842023"))?.v ?? "all on 21842023");
  check("the local-file option survived", shape.opts.some(o => o.v === "__local__"));
  check("the human-gut database is selected by default", /human-gut\.syldb/.test(shape.value), shape.value);
  check("the note under the picker names the biome and warns about the wrong one",
    /Human gut/.test(shape.note) && /another environment/.test(shape.note), shape.note.slice(0, 120));

  const soilNote = await cdp.eval(`(() => {
    const s = document.getElementById("dbSelect");
    const o = [...s.options].find(o => /^Soil/.test(o.textContent));
    return { text: o.textContent, disabled: o.disabled };
  })()`);
  check("soil is listed with its species count and size", /19,472 species/.test(soilNote.text) && /2.8 GB/.test(soilNote.text), soilNote.text);

  // The note follows the picker.
  const noteAfter = await cdp.eval(`(() => {
    const s = document.getElementById("dbSelect");
    s.value = [...s.options].find(o => o.value.includes("gut_mini")).value;
    s.dispatchEvent(new Event("change"));
    return document.getElementById("dbBiomeNote").textContent;
  })()`);
  check("choosing another biome rewrites the note", /Smoke test/.test(noteAfter), noteAfter.slice(0, 90));

  // ---- 2. profile against the smoke test ------------------------------------
  await cdp.eval(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(fastqText)}], "sampleA.fastq", { type: "text/plain" }));
    const inp = document.getElementById("file");
    inp.files = dt.files;
    inp.dispatchEvent(new Event("change"));
    document.getElementById("loadDb").click();
  })()`);
  // With a sample in the list, automatic mode must name the one it will read.
  // "the first sample" is a rule the user has to apply themselves against an
  // order they did not choose.
  const autoHint = await cdp.eval(`(() => {
    document.getElementById("modeAuto").click();
    const t = document.getElementById("screenHint").textContent;
    const d = document.getElementById("screenBtn").disabled;
    document.getElementById("modeManual").click();
    return { t, d };
  })()`);
  check("automatic mode names the sample it will screen",
    /sampleA/.test(autoHint.t), autoHint.t.slice(0, 90));
  check("...and says the whole batch follows that one catalogue",
    /whole batch/.test(autoHint.t));
  check("...and the button is live now that there is something to screen",
    autoHint.d === false);

  const dbLine = await cdp.waitFor(`document.getElementById("dbInfo").textContent`, /Database ready/, 120_000, "#dbInfo");
  check("the database line names the biome that was loaded",
    /Smoke test/.test(dbLine) && /gut_mini\.syldb/.test(dbLine)
    && /MGnify human-gut v2\.0\.2/.test(dbLine), dbLine.slice(0, 170));

  await cdp.eval(`document.getElementById("run").click()`);
  await cdp.waitFor(`document.getElementById("step").textContent`, /done — \d+ sample/, 300_000, "#step");
  const matrixRef = await cdp.eval(`document.getElementById("matrixRef").textContent`);
  check("the matrix names the reference it was profiled against",
    /Profiled against/.test(matrixRef) && /Smoke test/.test(matrixRef)
    && /relative to this catalogue only/.test(matrixRef), matrixRef);

  const tsv = await cdp.eval(`(async () => {
    window.__blobs = [];
    const real = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b) => { window.__blobs.push(b); return real(b); };
    document.getElementById("downloadTsv").click();
    await new Promise(r => setTimeout(r, 200));
    return await window.__blobs[0].text();
  })()`);
  const head = tsv.split("\n").filter(l => l.startsWith("#"));
  check("the exported TSV carries a reference header", head.length >= 5, `${head.length} comment lines`);
  check("...naming the biome, its key and its catalogue",
    head.some(l => /Smoke test/.test(l) && /gut-mini/.test(l) && /MGnify human-gut v2\.0\.2/.test(l)),
    head[1]);
  check("...the database file and the genome count",
    head.some(l => /gut_mini\.syldb/.test(l)) && head.some(l => /genomes=50/.test(l) && /k=31/.test(l)));
  check("...and the warning that the numbers only mean anything inside it",
    head.some(l => /relative to the reference database named above/.test(l)));
  check("the data rows still parse as a plain TSV under the comments",
    tsv.split("\n").find(l => !l.startsWith("#")).split("\t")[0] === "species",
    tsv.split("\n").find(l => !l.startsWith("#")));

  // ---- 3. the picker is a control; the database in memory is a state ---------
  //
  // Moving the dropdown costs one gesture and no click on "Load database". The
  // note under it used to be rewritten from the SELECTION and to assert, in the
  // present tense, "everything you profile will be reported against THIS
  // catalogue" — about a database that was not loaded and that nothing had been
  // profiled against, while the status line above and the matrix header below
  // still named the real one. Three surfaces, two contradictory answers, on the
  // one fact this page exists to get right.
  const moved = await cdp.eval(`(() => {
    const s = document.getElementById("dbSelect");
    s.value = [...s.options].find(o => o.value.includes("mini_clone")).value;
    s.dispatchEvent(new Event("change"));
    const n = document.getElementById("dbBiomeNote");
    return {
      note: n.textContent,
      pending: n.classList.contains("db-note-pending"),
      dbLine: document.getElementById("dbInfo").textContent,
    };
  })()`);
  check("moving the picker without loading says NOT LOADED, before anything else",
    /^NOT LOADED/.test(moved.note), moved.note.slice(0, 130));
  check("...and names the database that is still in memory",
    /Smoke test/.test(moved.note.split("If you did:")[0]), moved.note.slice(0, 220));
  check("...and stops claiming the selected catalogue is what you profile against",
    !/Everything you profile will be reported/.test(moved.note) && /WOULD report/.test(moved.note),
    moved.note.slice(-160));
  check("...and no longer reads as a plain statement of fact",
    moved.pending === true);
  check("...so the status line and the note now agree with each other",
    /Smoke test/.test(moved.dbLine), moved.dbLine.slice(0, 110));

  // ---- 4. switching biome must not mix two catalogues ------------------------
  const before = await cdp.eval(`document.getElementById("filesList").textContent`);
  check("the sample is done before the switch", /species detected/.test(before), before.slice(0, 80));
  await cdp.eval(`(() => {
    const s = document.getElementById("dbSelect");
    s.value = [...s.options].find(o => o.value.includes("mini_clone")).value;
    s.dispatchEvent(new Event("change"));
    document.getElementById("loadDb").click();
  })()`);
  await cdp.waitFor(`document.getElementById("dbInfo").textContent`,
    /Database ready[\s\S]*Second test biome/, 120_000, "#dbInfo (clone)");
  await sleep(500);   // renderCacheInfo runs in loadDatabase's finally
  const err = await cdp.eval(`document.getElementById("error").textContent`);
  const after = await cdp.eval(`document.getElementById("filesList").textContent`);
  check("changing the reference resets the sample profiled against the old one",
    /pending/.test(after) && !/species detected/.test(after), after.slice(0, 90));
  check("...and says why, instead of silently discarding the work",
    /two catalogues cannot share a matrix/.test(err), err.slice(0, 160));
  check("the matrix already on screen keeps the reference it was profiled against",
    /Smoke test/.test(await cdp.eval(`document.getElementById("matrixRef").textContent`)));

  // THE property the whole page rests on, and the only state in which it is
  // testable: the reference is FROZEN on the matrix at the moment the run
  // produced it, and does not follow the database that is loaded now.
  //
  // Every check before this one — the header above the matrix, the TSV, the file
  // name — was made while the loaded database and the matrix's reference were
  // the same object, so none of them can tell "reads lastMatrix.ref" apart from
  // "reads whatever is currently loaded". Here they differ: the numbers came
  // from the smoke test, the database in memory is the clone. An export that
  // named the clone would put the wrong catalogue on the right numbers — the one
  // mistake that survives into a file and is never caught again.
  const frozen = await cdp.eval(`(async () => {
    window.__b2 = []; window.__names = [];
    const realURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b) => { window.__b2.push(b); return realURL(b); };
    const realAppend = document.body.appendChild.bind(document.body);
    document.body.appendChild = (el) => {
      if (el && el.download) window.__names.push(el.download);
      return realAppend(el);
    };
    document.getElementById("downloadTsv").click();
    await new Promise(r => setTimeout(r, 300));
    document.body.appendChild = realAppend;
    return { text: await window.__b2[0].text(), name: window.__names[0] ?? "" };
  })()`);
  const head2 = frozen.text.split("\n").filter((l) => l.startsWith("#"));
  check("an export taken AFTER loading another database still names the first one",
    head2.some((l) => /reference database:/.test(l) && /Smoke test/.test(l) && /gut-mini/.test(l)),
    head2.find((l) => /reference database:/.test(l)));
  check("...and does not name the one that is loaded now",
    !head2.some((l) => /Second test biome/.test(l) || /clone-test/.test(l)),
    head2.find((l) => /Second test biome|clone-test/.test(l)) ?? "none");
  check("...and its file name says the first biome too, not the current selection",
    frozen.name === "abundance_matrix_gut-mini.tsv", frozen.name);
  check("...and the database file it names is the one the numbers came from",
    head2.some((l) => /gut_mini\.syldb/.test(l))
    && !head2.some((l) => /mini_clone\.syldb/.test(l)),
    head2.find((l) => /syldb/.test(l)));

  // ---- 5. the cache tells the two databases apart ----------------------------
  const cacheText = await cdp.eval(`document.getElementById("dbCacheInfo").textContent`);
  check("both databases are in the cache, named as biomes",
    /Smoke test/.test(cacheText) && /Second test biome/.test(cacheText), cacheText.slice(0, 200));
  check("...and the one the picker is on is marked as needing no download",
    /Second test biome[^]*nothing to download/.test(cacheText), cacheText.slice(0, 240));

  // Switching back must not re-download: the cache is keyed by URL, so the first
  // database is still there.
  const t0 = Date.now();
  await cdp.eval(`(() => {
    const s = document.getElementById("dbSelect");
    s.value = [...s.options].find(o => o.value.includes("gut_mini")).value;
    s.dispatchEvent(new Event("change"));
    document.getElementById("loadDb").click();
  })()`);
  const back = await cdp.waitFor(`document.getElementById("dbInfo").textContent`,
    /Database ready[\s\S]*Smoke test/, 120_000, "#dbInfo (back)");
  check("switching back to the first biome loads it from the local cache",
    /loaded from local cache/.test(back), back.slice(0, 160));
  console.log(`   (reload took ${((Date.now() - t0) / 1000).toFixed(1)} s)`);

  // Delete works per biome too: the button belongs to one cache entry, and the
  // entry is a URL. Deleting the 2.8 GB soil database must not take the gut one
  // with it — which is only checkable once two of them are in there.
  const deleted = await cdp.eval(`(async () => {
    const rows = [...document.getElementById("dbCacheInfo").querySelectorAll("div")]
      .filter(d => d.querySelector("button[data-cache-key]"));
    const target = rows.find(d => /Second test biome/.test(d.textContent));
    target.querySelector("button[data-cache-key]").click();
    await new Promise(r => setTimeout(r, 1500));
    return document.getElementById("dbCacheInfo").textContent;
  })()`);
  check("deleting one biome from the cache leaves the other one alone",
    !/Second test biome/.test(deleted) && /Smoke test/.test(deleted), deleted.slice(0, 200));

  // ---- 6. a load that fails leaves NOTHING loaded ----------------------------
  //
  // The workers are loaded one at a time and each frees its old Profiler before
  // building the new one, so a failure part-way is a pool where some workers hold
  // the new database, some hold the old one and some hold nothing. Keeping the
  // previous dbMeta and reference over that pool is the worst of the three: the
  // run button stays live, samples go to whichever worker is free, and the matrix
  // and its export carry a label that is true of at most half of them.
  //
  // Driven for real with a URL that 404s. Before the fix, "Profile all" stayed
  // enabled and the status line still described the database from the last
  // successful load.
  const runBefore = await cdp.eval(`document.getElementById("run").disabled`);
  check("Profile all is live before the failing load", runBefore === false);
  await cdp.eval(`(() => {
    const s = document.getElementById("dbSelect");
    const opt = document.createElement("option");
    opt.value = "db/no_such_database.syldb";
    opt.textContent = "a database that is not there";
    s.appendChild(opt);
    s.value = opt.value;
    document.getElementById("loadDb").click();
  })()`);
  // Waited on the error box, not on the status line: the status line is what is
  // under test here, and a check that waits for its own expectation reports a
  // timeout instead of a difference.
  const failErr = await cdp.waitFor(`document.getElementById("error").textContent`,
    /Failed to load database/, 60_000, "#error (failed load)");
  await sleep(300);   // the finally runs right behind the error
  const failLine = await cdp.eval(`document.getElementById("dbInfo").textContent`);
  check("a failed load says that nothing is loaded any more",
    /No database is loaded/.test(failLine), failLine.slice(0, 160) || "(empty)");
  check("...and the error names the failure",
    /Failed to load database/.test(failErr), failErr.slice(0, 120));
  check("...and Profile all is greyed out rather than left pointing at a mixed pool",
    (await cdp.eval(`document.getElementById("run").disabled`)) === true);
  check("...and says why, so the dead button is not a dead end",
    /Load a reference database first/.test(
      await cdp.eval(`document.getElementById("runHint").textContent`)),
    await cdp.eval(`document.getElementById("runHint").textContent`));

  // ---- 7. the single-sample page --------------------------------------------
  // Same tab, same session: the point is that the biome chosen on one page is
  // remembered on the other, not that it survives a SIGKILL'd browser (Chrome
  // flushes localStorage lazily, and killing it is not a user action).
  await cdp.send("Page.navigate", { url: `${BASE}/profile.html` });
  for (let i = 0; i < 300; i++) {
    const ready = await cdp.eval(`document.readyState === "complete" && !!document.getElementById("resultsRef") && document.getElementById("dbSelect").querySelectorAll("optgroup").length > 2`).catch(() => false);
    if (ready === true) break;
    await sleep(200);
  }
  const cdp2 = cdp;
  const shape2 = await cdp2.eval(`(() => {
    const s = document.getElementById("dbSelect");
    return {
      groups: s.querySelectorAll("optgroup").length,
      opts: s.options.length,
      disabled: [...s.options].filter(o => o.disabled).length,
      note: document.getElementById("dbBiomeNote").textContent,
      remembered: s.value,
    };
  })()`);
  check("profile.html builds the same grouped picker",
    shape2.groups === 6 && shape2.opts === 23 && shape2.disabled === 1, JSON.stringify(shape2).slice(0, 120));
  check("...and remembers the biome chosen on the other page",
    /gut_mini/.test(shape2.remembered), shape2.remembered);
  check("...with the same note under it", /Smoke test/.test(shape2.note), shape2.note.slice(0, 80));
} catch (e) {
  console.error(e);
  failures++;
} finally {
  try { process.kill(-chrome.pid, "SIGKILL"); } catch { /* gone */ }
  try { execFileSync("pkill", ["-9", "-f", `--user-data-dir=${PROFILE}`], { stdio: "ignore" }); } catch { /* none */ }
  server.kill("SIGKILL");
}

console.log(failures === 0 ? "\nall biome page checks passed" : `\n${failures} biome page check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
