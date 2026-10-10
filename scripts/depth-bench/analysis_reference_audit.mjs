// The three page outputs analysis_reference.mjs never dumped, so
// analysis_reference_audit.py can subtract a reference from them.
//
//     node scripts/depth-bench/analysis_reference.mjs > js.json
//     node scripts/depth-bench/analysis_reference_audit.mjs js.json > aux.json
//
// Two of them are what the contrast figure PRINTS — figures.js draws `q` from
// benjaminiHochberg() and captions the figure with minAttainableP(), and neither
// appears in the earlier driver's output, so neither could have been validated.
// The third is eigenvaluesSym(), which supplies the denominator of the PCoA
// "explained" fractions: the earlier check compared only the ratio, and an error
// shared by numerator and denominator cancels in a ratio.
//
// WHAT WOULD MAKE THIS WRONG: computing the double-centred matrix differently
// from figures.js's pcoa(). The block below is that function's centring step
// with the same arithmetic in the same order, so eigenvaluesSym() is handed the
// matrix it is handed on the page; anything else would be comparing the Jacobi
// routine on an input the page never gives it.
import fs from "node:fs";

import { eigenvaluesSym } from "../../web/figures.js";
import { benjaminiHochberg, minAttainableP } from "../../web/stats.js";

const js = JSON.parse(fs.readFileSync(process.argv[2] ?? "js.json", "utf8"));

const ps = js.mannWhitney.map((m) => m.p);
const D = js.distance;
const n = D.length;

// pcoa()'s Gower double-centring of -0.5 D², verbatim in effect.
const A = Array.from({ length: n }, (_, i) =>
  Float64Array.from({ length: n }, (_, j) => -0.5 * D[i][j] * D[i][j]));
const rowMean = A.map((r) => r.reduce((a, v) => a + v, 0) / n);
const grand = rowMean.reduce((a, v) => a + v, 0) / n;
for (let i = 0; i < n; i++) {
  for (let j = 0; j < n; j++) A[i][j] = A[i][j] - rowMean[i] - rowMean[j] + grand;
}

process.stdout.write(JSON.stringify({
  q: benjaminiHochberg(ps),
  floor: minAttainableP(js.groupA.length, js.groupB.length),
  eigenvalues: eigenvaluesSym(A),
}));
