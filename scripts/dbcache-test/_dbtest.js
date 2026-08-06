// Browser half of the db-cache test harness. Symlinked next to the real
// modules (so `./db-cache.js` is the same file the app loads), driven by
// scripts/dbcache-test/run.mjs, and it reports back by POSTing to /_report on
// the flaky test server — headless Chrome's console is not a reliable channel,
// a POST is.
//
// Scenario is picked by ?t= in the query string.

import { dbCacheClient, readCachedBytes, listCache, cacheKey } from "./db-cache.js";
import { sylphWorkerRpc } from "./sylph-worker-rpc.js";

const q = new URLSearchParams(location.search);
const scenario = q.get("t");
const dbUrl = new URL(q.get("url") ?? "./db/gut_mini.syldb", location.href).href;
const chunkSize = Number(q.get("chunk") ?? 1024 * 1024);
const out = document.getElementById("out");

const log = [];
function say(...a) {
  const s = a.map(x => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  log.push(s);
  out.textContent = log.join("\n");
  console.log("[dbtest]", s);
}

async function report(obj) {
  await fetch("/_report", {
    method: "POST",
    body: JSON.stringify({ scenario, ...obj, log }),
  }).catch(() => {});
  document.title = "DONE";
  // Let the browser exit by itself. SIGKILLing it instead leaves a live
  // SingletonLock in the profile, and the NEXT launch on the same profile (which
  // is how a "second visit" is tested) then hands its URL to the corpse and
  // exits without loading anything.
  setTimeout(() => window.close(), 50);
}

async function sha256(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// The bytes as the app would see them, hashed. This is the "identical byte for
// byte" check: the harness compares it with sha256sum of the source file.
async function hashCached(url) {
  const bytes = await readCachedBytes(url);
  return { sha: await sha256(bytes), len: bytes.length };
}

const dbc = dbCacheClient();

async function main() {
  if (scenario === "wipe") {
    await dbc.clear();
    return report({ ok: true, wiped: true });
  }

  if (scenario === "ensure") {
    // Plain download-or-reuse. Records the first "start" event, which says
    // whether this run resumed and from where.
    let firstStart = null, retries = 0, lastPct = -1;
    // Warm the client first, so `ms` times the download path and not the one-off
    // cost of spawning the cache worker (which in this headless Chrome is tens
    // of seconds and has nothing to do with what is under test).
    const tList0 = performance.now();
    await dbc.list();
    const tList = performance.now() - tList0;
    // ?probe=1 adds one bare range request of our own, purely to separate "the
    // page is slow" from "db-cache is slow". It costs a request, so it is off by
    // default (the request-count assertions would break).
    let netProbeMs = null;
    if (q.get("probe")) {
      const tp = performance.now();
      const r = await fetch(dbUrl, { headers: { Range: "bytes=0-0" }, cache: "no-store" });
      await r.arrayBuffer();
      netProbeMs = Math.round(performance.now() - tp);
    }
    const t0 = performance.now();
    const marks = {};
    const res = await dbc.ensure(dbUrl, {
      chunkSize,
      onProgress: (p) => {
        marks[p.phase] ??= Math.round(performance.now() - t0);
        if (p.phase === "start") { firstStart = p; say("start", JSON.stringify(p)); }
        if (p.phase === "retry") { retries++; say("retry", p.note); }
        if (p.phase === "download" && p.total) {
          const pct = Math.floor(p.received / p.total * 10) * 10;
          if (pct !== lastPct) { lastPct = pct; say(`… ${pct}% (${p.received}/${p.total})`); }
        }
      },
    });
    const tEnsure = Math.round(performance.now() - t0);
    const h = await hashCached(dbUrl);
    return report({
      ok: true, source: res.source, size: res.size, bytesFetched: res.bytesFetched,
      resumedFrom: firstStart?.received ?? null, resumed: firstStart?.resumed ?? false,
      retries, ms: tEnsure, marks, listMs: Math.round(tList), netProbeMs, ...h,
    });
  }

  if (scenario === "abort") {
    // Start the download, cancel it partway, and report exactly how far it got.
    // The next run has to pick up from there.
    const at = Number(q.get("at") ?? 2_000_000);
    const ac = new AbortController();
    let received = 0;
    try {
      await dbc.ensure(dbUrl, {
        chunkSize,
        signal: ac.signal,
        onProgress: (p) => {
          if (p.received != null) received = p.received;
          if (p.phase === "download" && p.received >= at) ac.abort();
        },
      });
      return report({ ok: false, why: "download finished before the abort could land", received });
    } catch (e) {
      const entries = await listCache();
      const mine = entries.find(x => x.key === cacheKey(dbUrl));
      return report({
        ok: true, aborted: e.name === "AbortError", err: e.message,
        received, entry: mine ?? null,
      });
    }
  }

  if (scenario === "twotabs") {
    // Two independent cache clients = two db-cache workers = two tabs of this
    // site (index.html and profile.html is the ordinary case) clicking Load
    // database at the same moment.
    //
    // The exclusive OPFS handle alone cannot arbitrate this: the loser polls,
    // and when it finally gets the handle it acts on a decision taken BEFORE the
    // wait — truncating away the entry the winner has just finished writing and
    // downloading the whole database a second time. What has to happen instead
    // is a queue, and a re-read of the state once the lock is held.
    const A = dbCacheClient();
    const B = dbCacheClient();
    const phases = { a: [], b: [] };
    const t0 = performance.now();
    const [a, b] = await Promise.all([
      A.ensure(dbUrl, { chunkSize, onProgress: (p) => phases.a.push(p.phase) })
        .catch(e => ({ err: e.message })),
      B.ensure(dbUrl, { chunkSize, onProgress: (p) => phases.b.push(p.phase) })
        .catch(e => ({ err: e.message })),
    ]);
    const ms = Math.round(performance.now() - t0);
    const h = await hashCached(dbUrl);
    A.close(); B.close();
    return report({
      ok: true, ms,
      a: { source: a.source, bytesFetched: a.bytesFetched, err: a.err },
      b: { source: b.source, bytesFetched: b.bytesFetched, err: b.err },
      waited: phases.a.includes("wait") || phases.b.includes("wait"),
      ...h,
    });
  }

  if (scenario === "pool") {
    // The real thing: one page, one download, N sylph workers, each reading the
    // same cache entry. This is the measurement that proves the original defect
    // (N downloads for N workers) is gone — the harness counts bytes in the
    // server log.
    const n = Number(q.get("n") ?? 4);
    const res = await dbc.ensure(dbUrl, {
      chunkSize,
      onProgress: (p) => { if (p.phase === "start" || p.phase === "done") say(p.phase, p.note ?? ""); },
    });
    say("ensure ->", res.source);
    const rpcs = [];
    for (let i = 0; i < n; i++) rpcs.push(sylphWorkerRpc());
    const infos = await Promise.all(rpcs.map(r => r.init(1_000_000, 32)));
    const metas = await Promise.all(rpcs.map(r => r.loadDbCached(dbUrl)));
    for (const r of rpcs) r.terminate();
    const h = await hashCached(dbUrl);
    return report({
      ok: true, source: res.source, workers: n,
      bits: infos.map(i => i.bits),
      metas, ...h,
    });
  }

  if (scenario === "bits") {
    // Switching wasm build destroys the workers and their linear memory. It
    // must not destroy the database: no new request may leave.
    const res = await dbc.ensure(dbUrl, { chunkSize });
    const a = sylphWorkerRpc();
    const infoA = await a.init(1_000_000, 32);
    const metaA = await a.loadDbCached(dbUrl);
    a.terminate();
    // Fresh worker, other package — exactly what ensureWasmBuildFor() does.
    const b = sylphWorkerRpc();
    const infoB = await b.init(96_000_000, 64);
    const metaB = await b.loadDbCached(dbUrl);
    b.terminate();
    return report({
      ok: true, source: res.source,
      first: { bits: infoA.bits, meta: metaA },
      second: { bits: infoB.bits, meta: metaB, reason: infoB.reason },
    });
  }

  if (scenario === "corrupt") {
    // Chop the cached file in half behind the cache's back, leaving the
    // metadata claiming it is complete. A truncated .syldb must never be
    // handed to sylph: it would decode into fewer genomes and produce
    // plausible, wrong abundances.
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle("syldb-cache")).getDirectoryHandle(cacheKey(dbUrl));
    const fh = await dir.getFileHandle("data");
    const before = (await fh.getFile()).size;
    const w = await fh.createWritable({ keepExistingData: true });
    await w.truncate(Math.floor(before / 2));
    await w.close();
    const after = (await fh.getFile()).size;
    say(`truncated ${before} -> ${after}`);

    // 1) the read path must refuse it outright
    let readErr = null;
    try { await readCachedBytes(dbUrl); } catch (e) { readErr = e.message; }
    // 2) a sylph worker asked to load it must fail rather than profile
    let workerErr = null;
    const r = sylphWorkerRpc();
    await r.init(1_000_000, 32);
    try { await r.loadDbCached(dbUrl); } catch (e) { workerErr = e.message; }
    r.terminate();
    // 3) ensure() must notice and re-download
    const res = await dbc.ensure(dbUrl, { chunkSize });
    const h = await hashCached(dbUrl);
    return report({ ok: true, before, after, readErr, workerErr, source: res.source, bytesFetched: res.bytesFetched, ...h });
  }

  if (scenario === "wrongsize") {
    // The server now offers a different file at the same URL (the harness
    // swaps it). The cached copy is a different database and must be replaced,
    // not served.
    const res = await dbc.ensure(dbUrl, { chunkSize });
    const h = await hashCached(dbUrl);
    return report({ ok: true, source: res.source, size: res.size, bytesFetched: res.bytesFetched, ...h });
  }

  if (scenario === "list") {
    const entries = await listCache();
    return report({ ok: true, entries });
  }

  if (scenario === "delete") {
    // By key, the way the UI does it.
    const before = await listCache();
    const target = before.find(e => e.key === cacheKey(dbUrl));
    await dbc.remove({ key: target?.key });
    const after = await listCache();
    return report({
      ok: true, before: before.length, after: after.length,
      deletedKey: target?.key ?? null, entries: after,
    });
  }

  return report({ ok: false, why: `unknown scenario ${scenario}` });
}

main().catch((e) => {
  console.error(e);
  report({ ok: false, err: e?.message ?? String(e), stack: String(e?.stack ?? "") });
});
