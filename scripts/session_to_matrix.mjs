// The shipped example's taxonomic matrix, back out as the TSV it was built from.
//
//   node scripts/session_to_matrix.mjs > abundance_matrix_human-gut.tsv
//   node scripts/session_to_matrix.mjs --session web/demo/gut-demo.session.json
//
// WHY THIS EXISTS. `scripts/build_demo_session.py` turns an exported matrix into
// `web/demo/gut-demo.session.json`. The matrix that produced the SHIPPED session
// was never committed: the tracked `abundance_matrix_human-gut.tsv` was the
// PREVIOUS demo's, eighty-four ERR columns of PRJEB83730, and the demo has been
// eighteen SRR columns of PRJNA728374 since. So the example could not be rebuilt
// from anything in this repository — the one input it needs was missing, and the
// only honest operation left was `--only-func`, which patches the session on
// disk and cannot check the taxonomy it is patching.
//
// This closes that loop from the other end. The session HOLDS the numbers; this
// writes them back in the export format, and `build_demo_session.py` reading
// that file must reproduce the session byte for byte. It does — that is the
// check at the bottom of this file's own test, and the reason to trust the
// output rather than the reason to be suspicious of it.
//
// It is NOT a substitute for re-profiling. If the demo's runs are ever profiled
// again — a new database, a new sylph — the real export from that run replaces
// this file, and this script goes back to being a one-off repair.
//
// The header comes from web/biomes.js, the page's own writer, so a file made
// here and a file the Download TSV button makes cannot drift apart.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const flag = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const sessionPath = path.resolve(REPO, flag("session", "web/demo/gut-demo.session.json"));
const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));

const { refCommentLines } = await import(path.join(REPO, "web/biomes.js"));

// A session saved before the GTDB release was recorded carries no `gtdb`, and the
// export header would then lose a line the page now writes. The release is a
// property of the CATALOGUE, not of the run, so it is looked up by key rather
// than left out — the file is read a year later with no page around it.
if (!session.ref?.gtdb && session.ref?.key) {
  const cat = JSON.parse(fs.readFileSync(path.join(REPO, "web/db/biomes.json"), "utf8"));
  const entry = cat.groups.flatMap((g) => g.biomes).find((b) => b.key === session.ref.key);
  if (entry?.gtdb) session.ref = { ...session.ref, gtdb: entry.gtdb };
}

const samples = session.samples ?? [];
const matrix = session.matrix ?? {};
if (!samples.length) throw new Error(`${sessionPath} lists no samples`);
if (!Object.keys(matrix).length) throw new Error(`${sessionPath} holds no matrix`);

// The rows, in the session's own order. Not re-sorted: the session's key order is
// the order the page wrote, and reordering here would make a rebuilt session
// differ from the shipped one in nothing but line order — a diff that says
// "something changed" while nothing did.
const rows = Object.entries(matrix).map(([genome, entry]) => ({
  genome,
  species: entry.species ?? "",
  values: samples.map((s) => Number(entry[s] ?? 0)),
}));

// `# exported:` is a timestamp, and a timestamp is the one thing here that is not
// a measurement. Taken from the session's own savedAt so that running this twice
// produces the same file: a script whose output changes every time it runs makes
// every rebuild look like a change.
const lines = refCommentLines(session.ref, { samples: samples.length, rows: rows.length })
  .map((l) => (l.startsWith("# exported: ") ? `# exported: ${session.savedAt}` : l));

// One catalogue per column, named per column — the same line the page writes, and
// what build_demo_session.py checks before it will ship anything.
const refOf = (s) => session.refBySample?.[s] ?? session.ref;
lines.push("# reference per sample: " +
  samples.map((s) => `${s}=${refOf(s)?.label || refOf(s)?.file || "unknown"}`).join("; "));
// Where this particular file came from, in the file. Someone reading it in a year
// must not take it for the direct output of a profiling run.
lines.push(`# rebuilt from ${path.relative(REPO, sessionPath)} by scripts/session_to_matrix.mjs — ` +
  `the numbers are the session's, which are the numbers that run produced`);

lines.push(["species", "genome", ...samples].join("\t"));
for (const r of rows) {
  lines.push([r.species, r.genome, ...r.values.map((v) => v.toFixed(4))].join("\t"));
}

const out = flag("out");
const text = lines.join("\n") + "\n";
if (out) {
  fs.writeFileSync(path.resolve(REPO, out), text);
  console.error(`${rows.length} rows x ${samples.length} samples -> ${out}`);
} else {
  process.stdout.write(text);
}
