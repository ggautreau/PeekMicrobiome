// web/multi.js — the page's own state, driven through its own listeners.
//
//   node web/page-state.test.mjs
//
// WHAT IS AT RISK HERE. Every module this page is built from has a bench of its
// own, and every one of them passed while the page itself mixed two samples'
// reads, profiled half a batch against one catalogue and half against another,
// and hung for good when Settings was touched — because none of that is in a
// module. It is in the ORDER things happen on the page: a second click before a
// permission prompt resolves, a file dropped while a run is going, a database
// loaded under one. The worker does not queue (its handler is async and shares
// one Profiler), so whatever the page lets through reaches it.
//
// So this imports the REAL multi.js against a stand-in DOM and stand-in
// workers, and drives it the way a reader does — through the listeners on its
// buttons and fields. The stand-in worker holds every profile request until the
// scenario releases it, so what is "in flight" is decided here, exactly as a
// slow sample would decide it.
//
// Each scenario runs in a fresh node process: multi.js is a page, with page
// state, and two scenarios sharing one instance would be testing each other.
// Nothing here touches the network; the site's own files are read off the disk.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ---- the parent: one child per scenario --------------------------------------

const only = process.argv[2];
if (!only) {
  let pass = 0, fail = 0;
  const names = Object.keys(await scenarios());
  for (const name of names) {
    const r = spawnSync(process.execPath, [SELF, name], { encoding: "utf8", timeout: 90_000 });
    const lines = (r.stdout ?? "").split("\n").filter((l) => /^(ok  |FAIL)/.test(l));
    console.log(`\n== ${name} ==`);
    for (const l of lines) {
      console.log(l);
      if (l.startsWith("ok")) pass++; else fail++;
    }
    // A scenario that died before saying anything is a failure, not a pass of
    // zero checks: a page that throws on import is exactly what this is for.
    if (r.status !== 0 || !lines.length) {
      fail++;
      console.log(`FAIL ${name} did not finish — exit ${r.status}${r.signal ? ` (${r.signal})` : ""}`);
      const err = (r.stderr ?? "").trim().split("\n").slice(-8).join("\n");
      if (err) console.log(err);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed (page state)`);
  process.exit(fail ? 1 : 0);
}

// ---- the child: a stage, the page, one scenario ------------------------------

// The page logs freely and is silenced while it runs (quiet() below); the
// checks write through the console as it was before that.
const say = console.log.bind(console);
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; say(`ok   ${name}`); }
  else { fail++; say(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

class ClassList {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  toggle(c, force) {
    const on = force === undefined ? !this.s.has(c) : !!force;
    if (on) this.s.add(c); else this.s.delete(c);
    return on;
  }
  contains(c) { return this.s.has(c); }
}

class El {
  constructor(id, tag = "div") {
    this.id = id; this.tagName = String(tag).toUpperCase();
    this.classList = new ClassList(); this.dataset = {}; this.style = {}; this.attrs = {};
    this.listeners = {}; this._html = ""; this.textContent = ""; this.value = "";
    this.checked = false; this.disabled = false; this.title = ""; this.hidden = false;
    this.options = []; this.files = []; this.children = []; this.isConnected = true;
  }
  get ownerDocument() { return globalThis.document; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; if (k === "title") this.title = ""; }
  toggleAttribute(k, f) { if (f) this.attrs[k] = ""; else delete this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  dispatchEvent(ev) {
    const e = { type: ev.type, target: ev.target ?? this, currentTarget: this,
      preventDefault() {}, stopPropagation() {}, key: ev.key };
    for (const fn of this.listeners[ev.type] || []) fn(e);
    if (typeof this["on" + ev.type] === "function") this["on" + ev.type](e);
    return true;
  }
  click() { if (!this.disabled) this.dispatchEvent({ type: "click" }); }
  // "#id" inside a dialog is the element of that id, as it is in the page.
  querySelector(sel) {
    const m = /^#([\w-]+)$/.exec(String(sel));
    return m ? document.getElementById(m[1]) : null;
  }
  querySelectorAll() { return []; }
  closest() { return null; }
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  appendChild(c) { this.children.push(c); return c; }
  append(...c) { this.children.push(...c); }
  removeChild() {}
  remove() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  setPointerCapture() {}
  releasePointerCapture() {}
  get clientWidth() { return 800; }
  get clientHeight() { return 500; }
  get offsetWidth() { return 100; }
  get offsetHeight() { return 50; }
  get previousElementSibling() { return null; }
  get parentElement() { return null; }
}

const byId = new Map();
const tabsOf = (sel, key, vals) => vals.map((v) => { const b = new El(null, "button"); b.dataset[key] = v; return b; });
const tabs = {
  ".fig-tab": tabsOf(".fig-tab", "fig", ["composition", "alpha", "pcoa", "contrast", "enterotype"]),
  ".func-tab": tabsOf(".func-tab", "ffig", ["composition", "alpha", "pcoa", "contrast"]),
  ".res-tab": tabsOf(".res-tab", "res", ["taxo", "func"]),
};
const figTab = (f) => tabs[".fig-tab"].find((b) => b.dataset.fig === f);
const $ = (id) => document.getElementById(id);

globalThis.window = globalThis;
globalThis.document = {
  title: "PeekMicrobiome — test", hidden: false,
  getElementById(id) { if (!byId.has(id)) byId.set(id, new El(id)); return byId.get(id); },
  querySelector() { return null; },
  querySelectorAll(sel) { return tabs[sel] ?? []; },
  createElement(tag) { const e = new El(null, tag); if (tag === "a") anchors.push(e); return e; },
  addEventListener() {},
  dispatchEvent() { return true; },
  createRange() { return { selectNodeContents() {} }; },
  body: new El("body"), documentElement: new El("html"),
};
globalThis.addEventListener = () => {};
globalThis.innerWidth = 1280; globalThis.innerHeight = 900;
globalThis.getComputedStyle = () => ({ paddingBottom: "0" });
globalThis.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k),
};
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
  hardwareConcurrency: 5, deviceMemory: undefined, userAgent: "node",
  storage: { estimate: async () => ({ usage: 0, quota: 1e9 }), persisted: async () => false,
    persist: async () => false },
  clipboard: { writeText: async () => {} },
} });
globalThis.location = { href: "http://localhost:8000/index.html", origin: "http://localhost:8000",
  pathname: "/index.html" };

// Files the page saves (exports, sessions), captured instead of downloaded, and
// the <a> elements that name them.
const saved = [];
const anchors = [];
URL.createObjectURL = (blob) => { saved.push(blob); return `blob:test/${saved.length}`; };
URL.revokeObjectURL = () => {};
const exportAs = async (kind) => {
  saved.length = 0;
  $("exportAs").value = kind;
  $("exportAs").dispatchEvent({ type: "change" });
  await tick(5);
  return saved.length ? saved.at(-1).text() : null;
};

// The site's own files, off the disk; the ENA portal, from `portal` when a
// scenario sets one; anything else is a 404.
let portal = null;
globalThis.fetch = async (u) => {
  const url = new URL(String(u), location.href);
  if (portal && url.href.startsWith("https://www.ebi.ac.uk/ena/portal/api/filereport")) {
    return new Response(JSON.stringify(portal), { status: 200 });
  }
  if (url.origin === location.origin) {
    const p = path.join(HERE, decodeURIComponent(url.pathname));
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return new Response(fs.readFileSync(p));
  }
  return new Response("not found", { status: 404 });
};

// ---- the worker stand-in -----------------------------------------------------
//
// Answers init and every database load at once, and HOLDS every profile request
// until release(). A request answered by a worker whose database changed since
// it was sent fails, as the real one does ("finish_sample() called without
// begin_sample()").
const workers = [];
const held = [];
const opts = { bootError: null, genomes: () => 50, reply: () => ({}) };
let peak = 0;
class FakeWorker {
  constructor(url) {
    this.url = String(url); this.ls = { message: [], error: [] }; this.dead = false;
    this.funcOn = false; this.idx = workers.length; this.inflight = 0; workers.push(this);
  }
  addEventListener(t, fn) { (this.ls[t] ??= []).push(fn); }
  terminate() { this.dead = true; }
  reply(data) { setTimeout(() => { if (!this.dead) for (const fn of this.ls.message) fn({ data }); }, 0); }
  postMessage(m) {
    if (this.dead) return;
    if (this.url.includes("db-cache-worker")) {
      if (m.type === "list") this.reply({ id: m.id, ok: true, result: { entries: [] } });
      return;
    }
    switch (m.type) {
      case "init":
        if (opts.bootError) this.reply({ id: m.id, ok: false, error: opts.bootError });
        else this.reply({ id: m.id, ok: true, wasm: { bits: 32, capped: false, memory64: false, reason: "test", pkg: "x" } });
        return;
      case "loadDb": case "loadDbCached": case "loadDbFile": {
        const name = m.file?.name ?? m.url ?? "db";
        this.db = name;
        this.reply({ id: m.id, ok: true, meta: { database_size: opts.genomes(name), k: 31, c: 200, bytes: 1000 } });
        return;
      }
      case "loadFuncRefs":
        this.funcOn = m.on !== false;
        this.reply({ id: m.id, ok: true, result: { orthologs: 3 } });
        return;
      case "stats": this.reply({ id: m.id, ok: true, result: {} }); return;
      case "cancel": {
        const i = held.findIndex((h) => h.w === this && h.m.id === m.target);
        if (i >= 0) {
          const [h] = held.splice(i, 1);
          this.inflight--;
          const e = { id: h.m.id, ok: false, error: "aborted", name: "AbortError" };
          this.reply(e);
        }
        return;
      }
      default:
        if (/^profile/.test(m.type)) {
          this.inflight++; peak = Math.max(peak, this.inflight);
          held.push({ w: this, m, funcOn: this.funcOn, db: this.db });
        }
    }
  }
}
globalThis.Worker = FakeWorker;

const sampleOf = (h) => {
  const list = h.m.files ?? h.m.r1Files ?? h.m.urls ?? h.m.r1 ?? [];
  return list.map((f) => f.name ?? f.url).join("+");
};
const tsvOf = (rows) =>
  ["Sample_file\tGenome_file\tTaxonomic_abundance\tSequence_abundance\tAdjusted_ANI\tEff_cov",
    ...rows.map(([g, a]) => `s.fq\tdb/${g}\t${a}\t${a}\t98\t1.2`)].join("\n") + "\n";
const defaultTsv = (h) => tsvOf([[`${h.db}--g1.fna`, 60], [`${h.db}--g2.fna`, 40]]);

function release(pred = () => true, tsvFor = defaultTsv) {
  for (const h of held.filter(pred)) {
    held.splice(held.indexOf(h), 1);
    h.w.inflight--;
    if (h.db !== h.w.db) {
      h.w.reply({ id: h.m.id, ok: false, error: "finish_sample() called without begin_sample()" });
      continue;
    }
    const func = h.funcOn ? { profile: { K00001: 0.6, K00002: 0.4 }, hashes: 5 } : null;
    h.w.reply({ id: h.m.id, ok: true, tsv: tsvFor(h), elapsedMs: 1, reads: 1000, func,
      stop: "eof", stopDetail: "", ...opts.reply(h) });
  }
}

const file = (name, size = 1000) => ({ name, size });
function drop(...names) {
  $("file").files = names.map((n) => file(n));
  $("file").dispatchEvent({ type: "change" });
}
const statuses = () => ($("filesList").innerHTML
  .match(/<li class="([a-z]+)">[\s\S]*?<strong>([^<]+)<\/strong>[\s\S]*?<\/span>\s*<span>([^<]*)<\/span>/g) ?? [])
  .map((li) => {
    const m = /<li class="([a-z]+)">[\s\S]*?<strong>([^<]+)<\/strong>[\s\S]*?<\/span>\s*<span>([^<]*)<\/span>/.exec(li);
    return { status: m[1], name: m[2], label: m[3] };
  });
const columns = () => [...$("matrixHead").innerHTML.matchAll(/<button type="button" class="th-sort">([^<]+)</g)]
  .map((m) => m[1]);
const until = async (cond, n = 120) => { for (let i = 0; i < n && !cond(); i++) await tick(10); };
const finishRun = async (pred = () => true, tsvFor = defaultTsv) => {
  for (let i = 0; i < 120 && !/^done —/.test($("step").textContent); i++) { release(pred, tsvFor); await tick(10); }
};

let page = null;
async function boot() {
  const log = console.log, warn = console.warn, error = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    page = await import(pathToFileURL(path.join(HERE, "multi.js")).href + "?v=80");
    await tick(30);
  } finally {
    console.log = log; console.warn = warn; console.error = error;
  }
}
// Quiet while the page runs: it logs freely, and this bench's output is the
// list of checks.
const quiet = async (fn) => {
  const log = console.log, warn = console.warn, error = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.warn = warn; console.error = error; }
};

async function loadLocalDb(name) {
  $("dbInfo").textContent = "";
  $("dbSelect").value = "__local__";
  $("loadDb").click();
  await until(() => typeof $("dbFile").onchange === "function");
  $("dbFile").onchange({ target: { files: [file(name)], value: name } });
  $("dbFile").onchange = null;
  await until(() => /Database ready/.test($("dbInfo").textContent) && $("dbInfo").textContent.includes(name));
  await tick(5);
}

const sessionText = (samples, matrix, groups = null, extra = {}) => JSON.stringify({
  format: 1, app: "PeekMicrobiome",
  ref: { key: "local", label: "Local file — x.syldb", file: "x.syldb", url: "__local__", local: true, genomes: 3 },
  samples, matrix, refBySample: {}, sampleMeta: {}, funcProfiles: null, groups, rank: "s", ...extra,
});
async function openSession(text) {
  $("loadSession").files = [{ name: "s.json", text: async () => text }];
  $("loadSession").dispatchEvent({ type: "change" });
  await tick(30);
}

// ---- the scenarios -------------------------------------------------------------

async function scenarios() {
  return {
    // A file dropped mid-run re-enabled Profile all, and the second click sent
    // the in-flight samples to the same workers again.
    async "one run at a time, whatever is added during it"() {
      await loadLocalDb("gut.syldb");
      drop("S1.fastq.gz", "S2.fastq.gz", "S3.fastq.gz", "S4.fastq.gz", "S5.fastq.gz");
      $("run").click();
      await tick(30);
      check("Profile all is frozen while the run goes", $("run").disabled === true);
      drop("S6.fastq.gz");
      await tick(5);
      check("...and stays frozen when a file is dropped mid-run", $("run").disabled === true,
        `disabled=${$("run").disabled}`);
      $("run").disabled = false;            // a click that gets through anyway
      $("run").click();
      await tick(30);
      check("a second click during the run starts nothing", peak === 1,
        `${peak} requests on one worker at once`);
      await finishRun();
      const st = statuses();
      check("the first run profiles its five samples, each once",
        st.filter((s) => s.status === "done").length === 5, JSON.stringify(st.map((s) => s.status)));
      check("the sample dropped mid-run waits for the next run",
        st.find((s) => s.name === "S6")?.status === "pending");
      check("Profile all is offered again for it once the run is over", $("run").disabled === false);
    },

    // runAll awaited the notification permission BEFORE disabling anything.
    async "a double click while the permission prompt is open starts one run"() {
      await loadLocalDb("gut.syldb");
      // ONE prompt, as a browser shows one: both clicks wait on the same answer.
      let resolvePrompt;
      const prompt = new Promise((r) => { resolvePrompt = r; });
      globalThis.Notification = { permission: "default", requestPermission: () => prompt };
      $("notifyDone").checked = true;
      drop("S1.fastq.gz", "S2.fastq.gz");
      $("run").click();
      $("run").disabled = false;
      $("run").click();                     // second click, prompt still open
      await tick(5);
      resolvePrompt?.("denied");
      await tick(40);
      const sent = held.map(sampleOf);
      check("each sample is sent once", sent.length === 2 && new Set(sent).size === 2, sent.join(", "));
      await finishRun();
      check("and the run ends", /^done — 2 samples ok/.test($("step").textContent), $("step").textContent);
    },

    // Load database during a run replaced the database under half the batch.
    async "the database cannot be changed under a run"() {
      await loadLocalDb("db1.syldb");
      drop("S1.fastq.gz", "S2.fastq.gz", "S3.fastq.gz", "S4.fastq.gz", "S5.fastq.gz", "S6.fastq.gz");
      $("run").click();
      await tick(30);
      check("Load database is frozen during the run", $("loadDb").disabled === true);
      check("...and so is the biome picker", $("dbSelect").disabled === true);
      $("loadDb").disabled = false;
      $("dbSelect").value = "__local__";
      $("loadDb").click();
      await tick(20);
      check("a click that gets through opens no file dialog", typeof $("dbFile").onchange !== "function");
      await finishRun();
      const st = statuses();
      check("every sample is profiled against the one database",
        st.every((s) => s.status === "done"), JSON.stringify(st.map((s) => s.status)));
      check("the matrix names one reference per column, the same for all",
        !/WARNING/.test(await exportAs("tsv") ?? ""));
    },

    // Profile all stayed live during a database load.
    async "a run cannot start while a database is loading"() {
      await loadLocalDb("db1.syldb");
      drop("S1.fastq.gz", "S2.fastq.gz");
      $("dbSelect").value = "__local__";
      $("loadDb").click();
      await tick(20);
      check("Profile all is frozen while the database loads", $("run").disabled === true);
      check("the frozen line says it is the database, not a run",
        /database is loading/.test($("runControlsNote").textContent), $("runControlsNote").textContent);
      $("run").disabled = false;
      $("run").click();
      await tick(30);
      check("a click that gets through starts nothing", held.length === 0, `${held.length} in flight`);
      $("dbFile").onchange({ target: { files: [file("db2.syldb")], value: "db2.syldb" } });
      await until(() => /db2/.test($("dbInfo").textContent));
      await tick(10);
      check("once loaded, Profile all is offered", $("run").disabled === false);
    },

    // Settings → Workers resized the pool under a run, which then never ended.
    async "the pool cannot be resized under a run"() {
      await loadLocalDb("gut.syldb");
      const live = () => workers.filter((w) => !w.url.includes("db-cache") && !w.dead).length;
      const before = live();
      drop(...Array.from({ length: 8 }, (_, i) => `S${i + 1}.fastq.gz`));
      $("run").click();
      await tick(30);
      check("the Workers field in Settings is frozen", $("setWorkers").disabled === true);
      const set = $("setWorkers");
      set.value = "2";
      $("settings").dispatchEvent({ type: "change", target: set });
      await tick(30);
      check("a change that gets through is put back", live() === before && $("poolSize").value === String(before),
        `live ${live()} of ${before}, poolSize=${$("poolSize").value}`);
      await finishRun();
      check("the run ends with every sample done",
        /^done — 8 samples ok, 0 failed/.test($("step").textContent), $("step").textContent);
      check("nothing is left waiting on a terminated worker", held.filter((h) => h.w.dead).length === 0);
    },

    // A failed WebAssembly boot left Load database's freeze on, Explore included.
    async "a failed WebAssembly boot leaves the page usable"() {
      await until(() => /WASM init failed/.test($("error").textContent));
      $("loadDb").click();
      await tick(20);
      check("the click says the profiler could not start",
        /could not start/.test($("dbInfo").textContent), $("dbInfo").textContent.slice(0, 80));
      check("Load database is not left frozen", $("loadDb").disabled === false);
      check("Explore example results stays usable", $("demoLoad").disabled === false);
      check("the read cap stays usable", $("maxReads").disabled === false);
      check("no 'A profiling run is going' line", !/profiling run is going/.test($("runControlsNote").textContent));
    },

    // A dismissed file dialog never settled, and the load held the pool for ever.
    async "closing the file dialog without a file lets go of the page"() {
      $("dbSelect").value = "__local__";
      $("loadDb").click();
      await until(() => typeof $("dbFile").oncancel === "function");
      $("dbFile").oncancel();
      await tick(20);
      check("the line says no file was chosen", /No file selected/.test($("dbInfo").textContent));
      check("Load database is usable again", $("loadDb").disabled === false);
    },

    // The sylph export read the sample list, not the matrix on screen.
    async "the sylph export is the matrix on screen, and only what this tab profiled"() {
      opts.genomes = (name) => (/db2/.test(name) ? 60 : 50);
      await loadLocalDb("db1.syldb");
      drop("S1.fastq.gz", "S2.fastq.gz", "S3.fastq.gz");
      $("run").click();
      await tick(20);
      await finishRun(() => true, () => tsvOf([["DB1_genomeA.fna", 70], ["DB1_genomeB.fna", 30]]));
      await loadLocalDb("db2.syldb");
      $("step").textContent = "";
      $("run").click();
      await tick(20);
      release((h) => sampleOf(h) === "S1.fastq.gz", () => tsvOf([["DB2_genomeX.fna", 100]]));
      await tick(20);
      $("cancel").click();
      await until(() => /^done —/.test($("step").textContent));
      const tsv = await exportAs("sylph") ?? "";
      check("only the sample profiled against the new database is exported",
        /DB2_genomeX/.test(tsv) && !/DB1_genome/.test(tsv), tsv.split("\n").slice(1, 4).join(" | "));
      await openSession(sessionText(["S1", "S2"],
        { "g1.fna": { species: "Alpha", S1: 50, S2: 60 }, "g2.fna": { species: "Beta", S1: 50, S2: 40 } }));
      check("a session's matrix exports no sylph output of the sample list",
        (await exportAs("sylph")) === null && /not part of a saved session/.test($("error").textContent));
    },

    // Groups of one session coloured the next.
    async "a session without groups clears the groups on screen"() {
      const mx = (v) => ({ "g1.fna": { species: "Alpha one", S1: v[0], S2: v[1], S3: v[2], S4: v[3] },
        "g2.fna": { species: "Beta two", S1: 100 - v[0], S2: 100 - v[1], S3: 100 - v[2], S4: 100 - v[3] } });
      await openSession(sessionText(["S1", "S2", "S3", "S4"], mx([90, 80, 20, 10]),
        { S1: "TREATED", S2: "TREATED", S3: "CONTROL", S4: "CONTROL" }));
      figTab("pcoa").click(); await tick(10);
      check("the first session's groups colour its ordination", /TREATED/.test($("figCanvas").innerHTML));
      await openSession(sessionText(["S1", "S2", "S3", "S4"], mx([50, 55, 60, 65]), null));
      check("a second session with no groups shows none", !/TREATED|CONTROL/.test($("figCanvas").innerHTML));
      check("...and the Groups export is no longer offered", $("exportGroups").hidden === true);
      figTab("contrast").click(); await tick(10);
      check("...and the contrast asks for groups instead of drawing old ones",
        /fig-refusal/.test($("figCanvas").innerHTML) && !/TREATED/.test($("figCanvas").innerHTML));
    },

    // Functional profiles were nulled at every Profile all.
    async "functional profiles survive a second run"() {
      await loadLocalDb("gut.syldb");
      $("funcOn").checked = true;
      drop("S1.fastq.gz", "S2.fastq.gz", "S3.fastq.gz");
      $("run").click();
      await finishRun();
      drop("S4.fastq.gz");
      $("step").textContent = "";
      $("run").click();
      await finishRun();
      const j = JSON.parse(await exportAs("session"));
      check("the session holds every sample's functional profile",
        Object.keys(j.funcProfiles ?? {}).sort().join(",") === "S1,S2,S3,S4",
        Object.keys(j.funcProfiles ?? {}).join(","));
    },

    // Columns came in the order the workers finished.
    async "columns follow the sample list, not the order samples finish in"() {
      await loadLocalDb("gut.syldb");
      drop("S1.fastq.gz", "S2.fastq.gz", "S3.fastq.gz");
      $("run").click();
      await tick(30);
      for (const n of ["S3", "S2", "S1"]) { release((h) => sampleOf(h) === `${n}.fastq.gz`); await tick(20); }
      await finishRun();
      check("the matrix columns are S1, S2, S3", columns().join(",") === "S1,S2,S3", columns().join(","));
      const tsv = await exportAs("tsv") ?? "";
      const head = tsv.split("\n").find((l) => !l.startsWith("#")) ?? "";
      check("...and so are the exported file's", /\tS1\tS2\tS3$/.test(head), head);
    },

    // Clear during a run emptied the list and left the run going.
    async "Clear is refused while a run goes"() {
      await loadLocalDb("gut.syldb");
      drop("S1.fastq.gz", "S2.fastq.gz", "S3.fastq.gz");
      $("run").click();
      await tick(30);
      check("Clear is frozen during the run", $("clearFiles").disabled === true);
      $("clearFiles").disabled = false;
      $("clearFiles").click();
      await tick(5);
      check("a click that gets through clears nothing", statuses().length === 3, `${statuses().length} listed`);
      await finishRun();
      check("Clear is offered again afterwards", $("clearFiles").disabled === false);
    },

    // A re-run cancelled before its first sample hid the results that were there.
    async "a cancelled re-run leaves the results on screen"() {
      await loadLocalDb("gut.syldb");
      drop("S1.fastq.gz", "S2.fastq.gz");
      $("run").click();
      await finishRun();
      drop("S3.fastq.gz");
      $("step").textContent = "";
      $("run").click();
      await tick(20);
      $("cancel").click();
      await until(() => /^done —/.test($("step").textContent));
      check("the results card is still shown", !$("results").classList.contains("hide"));
      check("...with the two samples it had", columns().join(",") === "S1,S2", columns().join(","));
    },

    // Sample names are object keys, and a few names are already taken.
    async "a sample may be called anything"() {
      await loadLocalDb("gut.syldb");
      drop("species.fastq.gz", "constructor.fastq.gz", "toString.fastq.gz");
      check("the reserved names are renamed",
        statuses().map((s) => s.name).join(",") === "species_2,constructor_2,toString_2",
        statuses().map((s) => s.name).join(","));
      $("run").click();
      await finishRun();
      const tsv = await exportAs("tsv") ?? "";
      const rows = tsv.split("\n").filter((l) => l && !l.startsWith("#")).slice(1);
      check("every cell is a number", rows.length > 0 && rows.every((l) => l.split("\t").slice(2).every((v) => /^\d+\.\d{4}$/.test(v))),
        rows[0]);
      // A colleague's session with such a column: the cells it lacks are 0, not
      // whatever Object.prototype holds under that name.
      await openSession(sessionText(["toString", "S2"],
        { "g1.fna": { species: "Alpha", S2: 100 }, "g2.fna": { species: "Beta", toString: 100 } }));
      const t2 = await exportAs("tsv") ?? "";
      const g1 = t2.split("\n").find((l) => l.startsWith("Alpha"));
      check("a session's sample called toString reads as a column like any other",
        g1 === "Alpha\tg1.fna\t0.0000\t100.0000", g1);
    },

    // Two files claiming the same mate of one sample were lined up by order.
    async "files that claim the same mate are not paired by guess"() {
      drop("a_1.fastq.gz", "a_1.fq.gz", "a_2.fastq.gz");
      const st = statuses();
      check("neither claimant is paired, and each is listed on its own",
        st.length === 3 && st.every((x) => /single-end/.test($("filesList").innerHTML)) &&
        !/\[PE\]/.test($("filesList").innerHTML), st.map((x) => x.name).join(","));
      check("...and the page names the files and the mate they both claim",
        /Not paired/.test($("error").textContent) && /a_1\.fastq\.gz, a_1\.fq\.gz/.test($("error").textContent),
        $("error").textContent.slice(0, 120));
      $("error").textContent = "";
      drop("b_1.fastq.gz");
      drop("b_1.fq.gz", "b_2.fastq.gz");
      check("...the same across two drops",
        /Not paired/.test($("error").textContent) && /b_1\.fastq\.gz, b_1\.fq\.gz/.test($("error").textContent),
        $("error").textContent.slice(0, 120));
    },

    // The read cap read "3.000.000" as 10,000 without a word.
    async "the read cap reads what people type, and says when it cannot"() {
      const p = page.parseReads;
      const cases = [["3 000 000", 3e6], ["3,000,000", 3e6], ["3.000.000", 3e6], ["3'000'000", 3e6],
        ["3000000", 3e6], ["3M", 3e6], ["2.5M", 2.5e6], ["2,5M", 2.5e6], ["500k", 5e5], ["3e6", 3e6]];
      for (const [t, want] of cases) check(`"${t}" is ${want.toLocaleString("en-US")}`, p(t) === want, String(p(t)));
      for (const t of ["abc", "2.5", "3.000,000", "", "1,00,000"]) {
        check(`"${t}" is refused`, Number.isNaN(p(t)), String(p(t)));
      }
      const field = $("maxReads");
      field.value = "abc";
      field.dispatchEvent({ type: "change" });
      check("an unreadable cap is put back to the last good one", /3\u202f000\u202f000/.test(field.value), field.value);
      check("...and the page says so", !$("readsBad").classList.contains("hide") && /not a number of reads/.test($("readsBad").textContent));
      field.value = "1.500.000";
      field.dispatchEvent({ type: "change" });
      check("a cap written with dots is taken", /1\u202f500\u202f000/.test(field.value), field.value);
      check("...and the message goes", $("readsBad").classList.contains("hide"));
    },

    // A truncated read is a part of the input, and the page has to say so.
    async "a sample that stops at a malformed record is reported incomplete"() {
      await loadLocalDb("gut.syldb");
      opts.reply = (h) => (sampleOf(h) === "S2.fastq.gz"
        ? { reads: 6000, stop: "truncated", stopDetail: "the reads stop at a malformed record after read 6,000" }
        : {});
      drop("S1.fastq.gz", "S2.fastq.gz");
      $("run").click();
      await finishRun();
      const s2 = statuses().find((s) => s.name === "S2");
      check("the sample is INCOMPLETE, with the reason", s2?.status === "incomplete" && /malformed record/.test(s2.label),
        JSON.stringify(s2));
      check("the summary counts it apart", /1 incomplete/.test($("step").textContent), $("step").textContent);
      const tsv = await exportAs("tsv") ?? "";
      check("the exported matrix carries the flag", /^# INCOMPLETE: S2 — the reads stop at a malformed record/m.test(tsv));
    },

    // A run stopped by the base cap was reported as a download that ended early.
    async "an ENA run stopped by a cap is not incomplete"() {
      await loadLocalDb("gut.syldb");
      portal = [{ run_accession: "ERR9000001", library_layout: "SINGLE",
        fastq_ftp: "http://ftp.sra.ebi.ac.uk/f/ERR9000001.fastq.gz", fastq_bytes: "1000000",
        read_count: "2000", base_count: "16000000" }];
      $("enaAcc").value = "ERR9000001";
      $("enaResolve").click();
      // The stand-in DOM starts with no classes, so "the result panel is shown"
      // says nothing here; the status line is written when the lookup is over.
      await until(() => /1 run in ERR9000001/.test($("enaStatus").textContent));
      $("enaAdd").click();
      await tick(10);
      $("capInBases").checked = true;
      opts.reply = () => ({ reads: 188, stop: "bases" });
      $("run").click();
      await finishRun();
      const s = statuses()[0];
      check("profiled to the base cap, and said to be done", s?.status === "done",
        `${JSON.stringify(s)} · ${$("enaStatus").textContent} · ${$("enaError").textContent} · ` +
        `${$("step").textContent} · ${$("filesList").innerHTML.slice(0, 300)}`);
    },

    // The light/dark button was wired to the Settings gear.
    async "the theme button flips the theme, and the gear does not"() {
      const theme = await import(pathToFileURL(path.join(HERE, "theme.js")).href + "?v=80");
      check("nothing chosen follows the OS", theme.currentMode() === "auto");
      const html = document.documentElement;
      html.setAttribute("data-theme", "light");
      $("themeToggle").click();
      check("the theme button flips to dark", html.getAttribute("data-theme") === "dark");
      $("settingsBtn").click();
      await tick(10);
      check("opening Settings leaves it dark", html.getAttribute("data-theme") === "dark");
      $("themeToggle").click();
      check("and the button flips it back", html.getAttribute("data-theme") === "light");
    },

    // The caches were keyed on the NUMBER of rows.
    async "a table's fingerprint changes with its rows, not only with their number"() {
      const t = { samples: ["A", "B"], rows: [
        { id: "x", name: "X", values: [1, 2] }, { id: "y", name: "Y", values: [3, 4] }] };
      const swapped = { samples: ["A", "B"], rows: [t.rows[1], t.rows[0]] };
      const changed = { samples: ["A", "B"], rows: [t.rows[0], { id: "y", name: "Y", values: [3, 5] }] };
      const same = { samples: ["A", "B"], rows: t.rows.map((r) => ({ ...r, values: [...r.values] })) };
      const fp = page.tableFingerprint;
      check("reordered rows are another table", fp(t) !== fp(swapped));
      check("a changed value is another table", fp(t) !== fp(changed));
      check("an equal table is the same table", fp(t) === fp(same));
    },

    // MetaPhlAn and BIOM were built from whatever level was on screen.
    async "MetaPhlAn and BIOM are per genome at every level"() {
      $("demoLoad").click();
      await until(() => !$("results").classList.contains("hide") && /species across 18/.test($("resultsSummary").textContent), 300);
      $("rankPick").value = "g";
      $("rankPick").dispatchEvent({ type: "change" });
      await tick(20);
      const biom = JSON.parse(await exportAs("biom") ?? "{}");
      const ids = (biom.rows ?? []).map((r) => r.id);
      check("BIOM rows are genomes, 468 of them, all distinct",
        ids.length === 468 && new Set(ids).size === 468 && ids.every((i) => /^MGYG/.test(i)),
        `${ids.length} rows, first ${ids[0]}`);
      check("BIOM's date has no fraction and no zone", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(biom.date ?? ""), biom.date);
      const mpa = await exportAs("mpa") ?? "";
      const species = mpa.split("\n").filter((l) => /\|s__/.test(l.split("\t")[0]));
      check("MetaPhlAn writes every genome as a species under its lineage",
        species.length === 468 && species.every((l) => /^k__[^|]+\|p__/.test(l)), `${species.length} species clades`);
      check("...and no genus as a top-level species", !mpa.split("\n").some((l) => /^s__/.test(l)));
    },

    // Soil cannot be constructed in the 32-bit build, at any read cap.
    async "a database no build can hold is refused before anything is fetched"() {
      const fetched = [];
      const real = globalThis.fetch;
      globalThis.fetch = async (u, o) => { fetched.push(String(u)); return real(u, o); };
      const plan = (await import(pathToFileURL(path.join(HERE, "sylph-worker-rpc.js")).href + "?v=80"))
        .chooseWasmBits({ maxReads: 3e6, memory64: false, dbBytes: 2_962_000_000 });
      if (!plan.refuse) { check("chooseWasmBits refuses soil without memory64 (contract C3)", false); return; }
      // The soil entry of the catalogue the page loaded.
      const catalog = JSON.parse(fs.readFileSync(path.join(HERE, "db/biomes.json"), "utf8"));
      const soil = catalog.groups.flatMap((g) => g.biomes).find((b) => b.key === "soil");
      $("dbSelect").value = soil?.url ?? "";
      $("dbSelect").dispatchEvent({ type: "change" });
      $("loadDb").click();
      await until(() => /Not loaded/.test($("dbInfo").textContent));
      check("the load is refused, and says why", /^Not loaded: this database/.test($("dbInfo").textContent),
        $("dbInfo").textContent.slice(0, 90));
      check("nothing was downloaded", !fetched.some((u) => /zenodo/.test(u)), fetched.join(", "));
      check("Load database is usable again", $("loadDb").disabled === false);
    },
  };
}

// The scenarios that need the profiler NOT to start.
const BOOT_FAILS = new Set(["a failed WebAssembly boot leaves the page usable"]);

const all = await scenarios();
if (!all[only]) {
  console.log(`FAIL no scenario called "${only}"`);
  process.exit(1);
}
if (BOOT_FAILS.has(only)) opts.bootError = "WebAssembly.instantiate(): out of memory";
await boot();
await quiet(() => all[only]())
  .catch((e) => { fail++; say(`FAIL threw: ${e?.stack?.split("\n").slice(0, 3).join(" | ")}`); });
process.exit(fail ? 1 : 0);
