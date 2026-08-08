// The one place a reference database is ever downloaded.
//
// It is a worker for a single technical reason: OPFS can only be written in
// place — without rewriting the whole file on every commit — through
// createSyncAccessHandle(), which does not exist on the main thread. See the
// long note at the top of db-cache.js.
//
// Protocol (every message carries `id`):
//   in  { id, type: "ensure", url, chunkSize? }
//   out { id, progress: { phase, received, total, bps, etaSec, note, ... } }   // repeatedly
//   out { id, ok: true, result: { source, size, lastModified, url, opfs, bytes? } }
//   in  { id, type: "list"   }  -> { entries: [...] }
//   in  { id, type: "remove", key? , url? } -> { removed: bool }   // key wins
//   in  { id, type: "clear"  }  -> { cleared: bool }
//   in  { id: 0, type: "cancel", target }   // aborts an in-flight "ensure"
//   err { id, ok: false, error, errorName }
//
// `result.bytes` is present ONLY on the no-OPFS fallback path, and is
// transferred (not copied). On the normal path nothing large crosses this
// boundary at all: the sylph workers read the file out of OPFS themselves.

// The ?v= must match WORKER_VERSION in sylph-worker-rpc.js — same reason as in
// sylph-worker.js: a fresh worker paired with a stale module is a broken app.
import {
  ensureDb, downloadToMemory, listCache, removeCached, removeCachedKey, clearCache,
  canWriteCache,
} from "./db-cache.js?v=23";

const aborters = new Map();

self.addEventListener("message", async (e) => {
  const { id, type } = e.data;

  if (type === "cancel") {
    aborters.get(e.data.target)?.abort();
    return;
  }

  const ac = new AbortController();
  aborters.set(id, ac);
  try {
    if (type === "ensure") {
      const { url, chunkSize, expectedSize } = e.data;
      const onProgress = (p) => self.postMessage({ id, progress: p });
      if (canWriteCache()) {
        const r = await ensureDb(url, { onProgress, signal: ac.signal, chunkSize, expectedSize });
        self.postMessage({ id, ok: true, result: { ...r, opfs: true } });
      } else {
        // No OPFS here. Still ONE download — the bytes go back to the page once
        // and the page hands a copy to each sylph worker.
        console.warn("[db-cache] OPFS is not writable in this worker; " +
          "falling back to a single in-memory download (no persistence, no resume after reload)");
        const r = await downloadToMemory(url, { onProgress, signal: ac.signal, chunkSize, expectedSize });
        self.postMessage({ id, ok: true, result: { ...r, opfs: false } }, [r.bytes.buffer]);
      }
    } else if (type === "list") {
      self.postMessage({ id, ok: true, result: { entries: await listCache() } });
    } else if (type === "remove") {
      const removed = e.data.key
        ? await removeCachedKey(e.data.key)
        : await removeCached(e.data.url);
      self.postMessage({ id, ok: true, result: { removed } });
    } else if (type === "clear") {
      self.postMessage({ id, ok: true, result: { cleared: await clearCache() } });
    } else {
      throw new Error(`unknown message type: ${type}`);
    }
  } catch (err) {
    self.postMessage({
      id, ok: false,
      error: err?.message ?? String(err),
      errorName: err?.name ?? "Error",
    });
  } finally {
    aborters.delete(id);
  }
});
