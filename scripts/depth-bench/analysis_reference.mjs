// The JS half of the analysis-layer check: run the page's own functions and
// print what they return.
//
//     node scripts/depth-bench/analysis_reference.mjs > out.json
//
// §3 of the note validates the PROFILER against native sylph. Nothing validated
// what the page does with a profile afterwards — Bray-Curtis, PCoA, the Hill
// numbers and the Mann-Whitney are each checked only against values this project
// worked out for itself, which catches a typo and not a wrong formula. This
// script exists so a reference implementation can be handed the same input and
// the two answers subtracted; analysis_reference.py does the subtracting.
//
// It imports web/figures.js and web/stats.js rather than reimplementing them:
// what must be validated is the code the browser loads, so anything retyped
// here would be validating a copy. Nothing is computed in this file beyond the
// table the page itself would build.
//
// WHAT WOULD MAKE THIS WRONG: building a table that is not the one the page
// builds. The rows below are assembled the way multi.js's matrixToTable does it
// at species rank — one row per genome, absent genomes as 0, samples in the
// session's own order — and the session used is the one shipped with the page,
// so the numbers are the shipped example's real matrix and not a fixture. If
// matrixToTable's species branch changes, this stops measuring the same thing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { distanceMatrix, alphaDiversity, pcoa } from "../../web/figures.js";
import { mannWhitney } from "../../web/stats.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "../..");
const SESSION = path.join(REPO, "web/demo/gut-demo.session.json");

const session = JSON.parse(fs.readFileSync(SESSION, "utf8"));
if (session.rank !== "s") {
  // Above species rank matrixToTable sums rows per taxon, and this file does
  // not; refusing is better than silently comparing a different matrix.
  throw new Error(`session rank is ${session.rank}, expected species`);
}

const samples = session.samples;
// matrixToTable's species branch, verbatim in effect: the genome is the row, a
// sample the genome was not detected in contributes 0.
const rows = Object.entries(session.matrix).map(([genome, m]) => {
  const values = samples.map((s) => m[s] ?? 0);
  return { genome, species: m.species, values, maxAbund: Math.max(...values) };
});
rows.sort((a, b) => b.maxAbund - a.maxAbund);
const table = { samples, rows };

// The contrast the Mann-Whitney is run on. host_sex is the only field in the
// shipped session's metadata that splits these eighteen samples evenly, so it
// is the 9 v 9 the page could actually be asked for — not a split invented to
// make the test convenient.
const sexOf = (s) => session.sampleMeta?.[s]?.host_sex;
const groupA = samples.map((s, i) => [s, i]).filter(([s]) => sexOf(s) === "female").map(([, i]) => i);
const groupB = samples.map((s, i) => [s, i]).filter(([s]) => sexOf(s) === "male").map(([, i]) => i);
if (groupA.length !== 9 || groupB.length !== 9) {
  throw new Error(`expected 9 v 9, got ${groupA.length} v ${groupB.length}`);
}

const D = distanceMatrix(table);
const ord = pcoa(D);

// Every row, not a sample of them: 468 is already cheap and choosing which rows
// to compare is choosing which disagreements to see.
const mw = rows.map((r) => {
  const a = groupA.map((i) => r.values[i]);
  const b = groupB.map((i) => r.values[i]);
  const res = mannWhitney(a, b);
  return { genome: r.genome, a, b, u: res.u, p: res.p, exact: res.exact };
});

process.stdout.write(JSON.stringify({
  samples,
  groupA, groupB,
  // The matrix as the figures saw it, so Python scores the same numbers rather
  // than re-deriving them from the session and hoping the two agree.
  values: rows.map((r) => r.values),
  genomes: rows.map((r) => r.genome),
  distance: D.map((r) => Array.from(r)),
  alpha: alphaDiversity(table),
  pcoa: { points: ord.points, explained: ord.explained },
  mannWhitney: mw,
}));
