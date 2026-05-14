// Tiny promise-RPC wrapper around the WASM worker.
// Use:
//   const rpc = sylphWorkerRpc();
//   await rpc.init();
//   const meta = await rpc.loadDb(uint8);                           // transfers ownership
//   const { tsv } = await rpc.profileFile(file, 1_000_000, onProgress, signal);
//   const { tsv } = await rpc.profileFilesMulti(files, ..., onProgress, signal);
//   const { tsv } = await rpc.profileFilesPe(r1Files, r2Files, ..., onProgress, signal);
//
// `onProgress` is called for each progress event the worker emits.
// `signal` is an optional AbortSignal — aborting it sends a "cancel" message
// to the worker, which propagates into the streaming readAndTrim.

// Bump this version when you change the worker or any module it imports,
// to force the browser to refetch instead of reusing its module-worker cache.
const WORKER_VERSION = "5";

export function sylphWorkerRpc() {
  const workerUrl = new URL(`./sylph-worker.js?v=${WORKER_VERSION}`, import.meta.url);
  const worker = new Worker(workerUrl, { type: "module" });
  const pending = new Map();
  let nextId = 1;

  worker.addEventListener("message", (e) => {
    const { id } = e.data;
    const resolver = pending.get(id);
    if (!resolver) return;
    if (e.data.progress) {
      resolver.onProgress?.(e.data.progress);
      return;
    }
    pending.delete(id);
    if (resolver.signal && resolver.onAbort) {
      resolver.signal.removeEventListener("abort", resolver.onAbort);
    }
    if (e.data.ok) resolver.resolve(e.data);
    else resolver.reject(new Error(e.data.error));
  });
  worker.addEventListener("error", (e) => {
    for (const { reject } of pending.values()) reject(new Error(e.message ?? "worker error"));
    pending.clear();
  });

  function call(type, payload, { transfer, onProgress, signal } = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, onProgress, signal };
      if (signal) {
        entry.onAbort = () => worker.postMessage({ id: 0, type: "cancel", target: id });
        signal.addEventListener("abort", entry.onAbort);
      }
      pending.set(id, entry);
      worker.postMessage({ id, type, ...payload }, transfer ?? []);
    });
  }

  return {
    worker,
    async init() {
      await call("init");
    },
    async loadDb(bytes) {
      const { meta } = await call("loadDb", { bytes }, { transfer: [bytes.buffer] });
      return meta;
    },
    async profileFile(file, maxReads, onProgress, signal) {
      return call("profileFile", { file, maxReads }, { onProgress, signal });
    },
    async profileFilesMulti(files, maxReads, onProgress, signal) {
      return call("profileFilesMulti", { files, maxReads }, { onProgress, signal });
    },
    async profileFilesPe(r1Files, r2Files, maxReads, onProgress, signal) {
      return call("profileFilesPe", { r1Files, r2Files, maxReads }, { onProgress, signal });
    },
    terminate() {
      worker.terminate();
      for (const { reject } of pending.values()) reject(new Error("worker terminated"));
      pending.clear();
    },
  };
}
