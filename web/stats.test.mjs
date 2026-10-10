// web/stats.js — against values worked out on paper, and against brute force.
//
//   node web/stats.test.mjs
//
// A statistic is the one thing on this page that CANNOT be checked by looking at
// it: a p-value that is wrong by a factor of two looks exactly like one that is
// right. So every case below is either enumerable by hand (six observations,
// twenty splits) or checked against an independent brute-force enumeration of
// the same permutation null.

import { mannWhitney, benjaminiHochberg, minAttainableP, fmtP } from "./stats.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ---- worked out by hand ------------------------------------------------------
//
// [1,2,3] against [4,5,6]: the groups separate perfectly. There are C(6,3) = 20
// ways to split six ranks into two threes, and exactly one is this extreme in
// each direction, so the two-sided p is 2/20 = 0.1 — which is also scipy's exact
// answer, and the reason nothing at three-a-group can ever reach 0.05.
{
  const r = mannWhitney([1, 2, 3], [4, 5, 6]);
  check("perfect separation at 3 v 3 gives exactly 0.1", near(r.p, 0.1), String(r.p));
  check("...and it is the exact test, not an approximation", r.exact === true);
  check("...with U at its extreme", r.u === 0, String(r.u));
}
{
  // Two a side: C(4,2) = 6, one extreme split each way, p = 2/6.
  const r = mannWhitney([1, 2], [3, 4]);
  check("perfect separation at 2 v 2 gives exactly 1/3", near(r.p, 1 / 3), String(r.p));
}
{
  // Identical groups: every split is as extreme as this one.
  const r = mannWhitney([5, 5, 5], [5, 5, 5]);
  check("two identical groups give p = 1", near(r.p, 1), String(r.p));
}
{
  // One value apart, everything else tied — the shape most rows of a functional
  // table have, where the tie correction is the whole answer.
  const r = mannWhitney([0, 0, 0], [0, 0, 1]);
  check("a single distinct value among ties is not significant", r.p > 0.4, String(r.p));
}

// ---- against brute force -----------------------------------------------------
//
// The independent check: enumerate every split of the pooled values, count how
// many give a rank sum as extreme as the observed one, and compare. Same null,
// arrived at by counting rather than by the dynamic program the module uses.
function bruteP(a, b) {
  const n1 = a.length, pooled = [...a, ...b];
  // Ranks with ties averaged, as the module does.
  const idx = pooled.map((v, i) => i).sort((x, y) => pooled[x] - pooled[y]);
  const ranks = new Array(pooled.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && pooled[idx[j + 1]] === pooled[idx[i]]) j++;
    const avg = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) ranks[idx[k]] = avg;
    i = j + 1;
  }
  const obs = ranks.slice(0, n1).reduce((x, y) => x + y, 0);
  let all = 0, le = 0, ge = 0;
  const pick = (start, chosen, sum) => {
    if (chosen === n1) {
      all++;
      if (sum <= obs + 1e-9) le++;
      if (sum >= obs - 1e-9) ge++;
      return;
    }
    for (let i = start; i < ranks.length; i++) pick(i + 1, chosen + 1, sum + ranks[i]);
  };
  pick(0, 0, 0);
  return Math.min(1, 2 * Math.min(le / all, ge / all));
}

{
  let worst = 0, worstCase = "";
  // Deterministic cases rather than random ones: a bench that draws its own
  // inputs cannot be re-run on the case that failed.
  const cases = [
    [[1, 2, 3], [4, 5, 6]],
    [[3, 1, 4], [1, 5, 9]],
    [[0, 0, 0, 0], [0, 0, 1, 2]],
    [[2, 2, 2], [2, 2, 3]],
    [[1, 2, 3, 4, 5], [3, 4, 5, 6, 7]],
    [[10, 20, 30, 40], [15, 25, 35]],
    [[1, 1, 2, 2, 3, 3], [1, 2, 3, 4, 4, 4]],
    [[0.1, 0.2, 0.35], [0.3, 0.4, 0.5, 0.6]],
  ];
  for (const [a, b] of cases) {
    const mine = mannWhitney(a, b).p, theirs = bruteP(a, b);
    const d = Math.abs(mine - theirs);
    if (d > worst) { worst = d; worstCase = `${JSON.stringify(a)} vs ${JSON.stringify(b)}: ` +
      `${mine} against ${theirs}`; }
  }
  check("the exact p matches an independent enumeration on every case",
    worst < 1e-12, worstCase);
}

// ---- the floor ---------------------------------------------------------------
check("three a group cannot reach 0.05, and the page has to say so",
  near(minAttainableP(3, 3), 0.1) && minAttainableP(3, 3) > 0.05);
check("...nine a group can: 2 in 48,620",
  near(minAttainableP(9, 9), 2 / 48620), String(minAttainableP(9, 9)));
check("...and the floor is the p of perfect separation, not a separate rule",
  near(minAttainableP(3, 4), mannWhitney([1, 2, 3], [4, 5, 6, 7]).p),
  `${minAttainableP(3, 4)} against ${mannWhitney([1, 2, 3], [4, 5, 6, 7]).p}`);

// ---- Benjamini-Hochberg ------------------------------------------------------
{
  // The textbook worked example: four p-values, n = 4.
  //   sorted: 0.01, 0.02, 0.03, 0.04  ->  q = 0.04, 0.04, 0.04, 0.04
  // because each p·n/k is 0.04, 0.04, 0.04, 0.04 and the running minimum from
  // the largest down keeps them monotone.
  const q = benjaminiHochberg([0.01, 0.02, 0.03, 0.04]);
  check("BH is monotone and matches the worked example",
    q.every((v) => near(v, 0.04)), JSON.stringify(q));
}
{
  const q = benjaminiHochberg([0.001, 0.5, 0.9]);
  check("...the smallest p keeps a small q when the rest are large",
    near(q[0], 0.003) && near(q[1], 0.75) && near(q[2], 0.9), JSON.stringify(q));
}
{
  // The order of the OUTPUT must follow the input, or a q lands on another row.
  const q = benjaminiHochberg([0.9, 0.001, 0.5]);
  check("...and q comes back in the order the p-values went in",
    near(q[1], 0.003) && near(q[0], 0.9), JSON.stringify(q));
}
check("BH never returns more than 1", benjaminiHochberg([0.9, 0.95]).every((v) => v <= 1));
{
  const q = benjaminiHochberg([0.02, NaN, 0.04]);
  check("...and a row with no p at all gets no q rather than a wrong one",
    Number.isNaN(q[1]) && Number.isFinite(q[0]), JSON.stringify(q));
}

// ---- formatting --------------------------------------------------------------
check("a p-value is printed at the width a column has",
  fmtP(0.0312) === "0.031" && fmtP(1) === "1" && fmtP(0.5) === "0.5",
  [fmtP(0.0312), fmtP(1), fmtP(0.5)].join(" "));
check("...and a tiny one does not become 0.000",
  /e-/.test(fmtP(4.1e-5)) && fmtP(0) === "<1e-9", `${fmtP(4.1e-5)} ${fmtP(0)}`);

// ---- the real example --------------------------------------------------------
//
// The shipped session, split the way the page's own picker splits it: nine
// against nine on host_sex. The point is not the biology — it is that the test
// runs over a real table in a sane time and produces q-values that are not all 1.
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const p = path.join(here, "demo/gut-demo.session.json");
  if (fs.existsSync(p)) {
    const st = JSON.parse(fs.readFileSync(p, "utf8"));
    const { groupsFromField } = await import("./groups.js");
    const g = groupsFromField(st.samples, (s) => st.sampleMeta?.[s] ?? {}, "host_sex");
    const A = st.samples.filter((s) => g.get(s) === "female");
    const B = st.samples.filter((s) => g.get(s) === "male");
    const rows = Object.values(st.matrix);
    const t0 = Date.now();
    const ps = rows.map((r) => mannWhitney(A.map((s) => r[s] ?? 0), B.map((s) => r[s] ?? 0)).p);
    const ms = Date.now() - t0;
    const q = benjaminiHochberg(ps);
    const lowest = Math.min(...q.filter(Number.isFinite));
    console.log(`     ${rows.length} rows, 9 v 9, exact, in ${ms} ms — lowest q ${lowest.toExponential(2)}`);
    check("the exact test runs over the whole example in under two seconds",
      ms < 2000, `${ms} ms`);
    // ATTAINABLE by design: perfect separation at 9 v 9 is p = 2/48,620, and
    // even multiplied by 468 rows that is q = 0.019. So a significant row is
    // possible here, unlike at 3 v 3 where it is arithmetically impossible.
    check("...and at 9 v 9 a significant q is arithmetically possible",
      minAttainableP(9, 9) * rows.length < 0.05,
      String(minAttainableP(9, 9) * rows.length));
    // AND NOT ATTAINED, on this data: the smallest q over 468 species split by
    // sex is 0.058. Recorded because it is the case the figure will usually be
    // in — nothing survives the correction — and a display that only looks right
    // when something is significant would be wrong almost always.
    check("...while on the shipped example nothing actually survives it",
      lowest > 0.05 && lowest < 0.1, lowest.toFixed(4));
  } else {
    console.log("skip the shipped example — demo/gut-demo.session.json is not here");
  }
}

console.log(`\n${pass} passed, ${fail} failed (stats)`);
process.exit(fail ? 1 : 0);
