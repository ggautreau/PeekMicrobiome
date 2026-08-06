// Are the pages actually wired to what db-cache.js now offers?
//
//   node scripts/dbcache-test/wiring.mjs        (also run by run.mjs)
//
// These are source-level assertions, and they are labelled as such on purpose.
// What they cover is UI behaviour that the headless scenarios do not read: a
// status line, a delete that quietly failed, which wasm build gets loaded when,
// and a README paragraph that claimed the opposite of what the code does. Each
// one fails if its fix is removed, which is what a test is for — but none of
// them proves the rendered page, so the browser suite remains the authority on
// everything it can reach.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.join(REPO, p), "utf8");

let failures = 0, passes = 0;
const check = (name, ok, detail = "") => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `   [${detail}]` : ""}`);
};

const multi = read("web/multi.js");
const profile = read("web/profile.js");
const readme = read("README.md");
const index = read("web/index.html");
const profileHtml = read("web/profile.html");

// The pool loads one worker at a time, seconds apart. Nothing but this compares
// what worker 1 got with what worker 4 got.
check("multi.js compares the metadata of every worker in the pool",
  /assertSameDatabase\(metas\)/.test(multi));

for (const [name, src] of [["multi.js", multi], ["profile.js", profile]]) {
  // `persistence` is only ever set by the first download of a session; a
  // returning visitor whose storage IS persistent was told the opposite.
  check(`${name} asks the browser for the real persistence state`,
    /await dbc\.persisted\(\)/.test(src));
  // est.quota is the TOTAL, and the same estimate carries est.usage.
  check(`${name} reports free space, not the total quota`,
    /cacheSummary\(/.test(src) && !/fmtBytes\(est\.quota\)\} available/.test(src));
  // removeCachedKey returns false while a download holds the entry's handle.
  check(`${name} tells the user when a delete did not happen`,
    /const \{ removed \} = await dbc\.remove/.test(src) && /if \(!removed\)/.test(src));
  // Queued behind another tab: without this the page looks frozen.
  check(`${name} shows the "waiting for the other tab" phase`, /case "wait":/.test(src));
  // An entry checked on its length alone must say so.
  check(`${name} says when an entry could only be checked on its length`,
    /size-only/.test(src));
}

// ensureWasmBuildFor() reloads the database currently in use — pointless and
// expensive when the user is about to replace it three lines later.
check("profile.js does not reload the old database before replacing it",
  !/await ensureWasmBuildFor\(currentReads\(\)\);/.test(profile)
  && /if \(workerBits !== plannedBits\(currentReads\(\)\)\)/.test(profile));

// The README described a Range probe that was deliberately removed.
check("the README describes the probe the code actually performs",
  /support is \*assumed\* rather than probed/.test(readme)
  && !/probes with a real range request rather than trusting the header/.test(readme));

// The pages promised unconditional persistence in static text while the cache
// listing said the browser might evict it.
for (const [name, src] of [["index.html", index], ["profile.html", profileHtml]]) {
  check(`${name} does not promise persistence the code cannot guarantee`,
    /unless the browser evicts it/.test(src), src.match(/it is then kept[^<]*/)?.[0]?.slice(0, 80));
}

console.log(`\n${passes} passed, ${failures} failed (wiring)`);
process.exit(failures ? 1 : 0);
