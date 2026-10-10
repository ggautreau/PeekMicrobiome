// A test for the contrast figure, and the arithmetic that says what it is worth.
//
// The figure printed no p-value on purpose and said so. That was a judgement
// about what these data can carry, and it was made for the reader rather than
// with them — so the number is here now. What does NOT change is the obligation
// that came with the refusal: a p-value on a hundred pathways at three samples a
// group has a floor it cannot go below, and printing the number without the
// floor is worse than printing neither.
//
// So this file computes three things:
//
//   · the two-sided Mann-Whitney (Wilcoxon rank-sum) p, EXACT by permutation
//     wherever the cost allows it, and the tie-corrected normal approximation
//     past that — the exact null is a dynamic program whose cost grows as the
//     fourth power of the group size, and at forty samples a side it froze the
//     page for thirteen seconds over 468 species. Every result says which one
//     it is, so the figure can say so too;
//   · the Benjamini-Hochberg q across the whole family of rows, because the
//     table asks the same question of every row at once;
//   · `minAttainableP`, the smallest p the test can produce at these group
//     sizes — the number that makes a column of q = 1 legible as arithmetic
//     rather than as a bug.
//
// Pure functions, no DOM, no fetch — the contract of figures.js and kegg.js, and
// for the same reason: every claim below is checkable in plain node against
// values worked out by hand.

/**
 * Ranks with ties averaged, DOUBLED so they stay integers.
 *
 * Doubling is not a flourish: an average of two adjacent ranks is a half, the
 * exact distribution below is a count over sums, and counting over halves means
 * floating-point keys in a table that must add up exactly.
 */
function doubledRanks(values) {
  const idx = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
  const out = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && values[idx[j + 1]] === values[idx[i]]) j++;
    // Ranks are 1-based; the average of ranks i+1..j+1, doubled, is (i+j+2).
    const doubled = i + j + 2;
    for (let k = i; k <= j; k++) out[idx[k]] = doubled;
    i = j + 1;
  }
  return out;
}

/**
 * How many ways to choose `n1` of these doubled ranks with each possible sum.
 *
 * The exact permutation null: every split of the pooled values into groups of
 * n1 and n2 is equally likely under the hypothesis that the labels carry no
 * information, so the distribution of the first group's rank sum IS the answer.
 * Counted by dynamic programming rather than enumerated — C(18,9) is 48,620
 * subsets per row and there are hundreds of rows — which makes it O(n·n1·S)
 * and exact rather than sampled.
 */
function rankSumCounts(ranks, n1) {
  const total = ranks.reduce((a, r) => a + r, 0);
  // counts[k][s] — as a flat array of Float64, because the counts overflow a
  // 32-bit integer at these sizes and only their RATIO is ever used.
  const width = total + 1;
  let table = new Float64Array((n1 + 1) * width);
  table[0] = 1;
  for (const r of ranks) {
    for (let k = Math.min(n1, ranks.length) - 1; k >= 0; k--) {
      const from = k * width, to = (k + 1) * width;
      for (let s = total - r; s >= 0; s--) {
        const c = table[from + s];
        if (c) table[to + s + r] += c;
      }
    }
  }
  return { counts: table.subarray(n1 * width, (n1 + 1) * width), total };
}

/**
 * What the exact null costs at these group sizes, in steps of the dynamic
 * program above: every pooled rank, for every subset size up to the SMALLER
 * group, over every attainable doubled rank sum (which add up to n(n+1)).
 *
 * Measured in node at about 1.2 ns a step: 9 v 9 is 55,000 steps (0.07 ms a
 * row), 20 v 20 is 1.3 million (1.6 ms), 40 v 45 is 25 million (29 ms) — and
 * 99 v 100 is 800 million, nearly a second for ONE row. The fourth power is why
 * there has to be a threshold at all.
 */
export function exactWork(n1, n2) {
  const n = n1 + n2;
  return n * Math.min(n1, n2) * n * (n + 1);
}

/**
 * The most one exact test may cost when it is asked for on its own: about 35
 * ms, which takes the exact branch up to roughly 45 samples a side. A whole
 * table is held to a budget of its own — see EXACT_TABLE_WORK.
 */
export const EXACT_ROW_WORK = 3e7;

/**
 * The most a whole table's worth of exact tests may cost: about half a second
 * of main thread. The test runs on the page's own thread, every time the
 * groups change, so the budget is per TABLE — 4,307 orthologs at 9 v 9 fit
 * (2.4e8, the 470 ms this figure has always cost), 468 species at 22 v 22 do
 * not (9e8), and those are drawn with the normal approximation instead.
 */
export const EXACT_TABLE_WORK = 4e8;

/**
 * Two-sided Mann-Whitney U for two groups of numbers.
 *
 * Returns { u, p, n1, n2, exact, method }. `method` is "exact" — the
 * permutation p, counted — or "normal": the tie-corrected normal approximation
 * with a continuity correction, the same statistic as scipy's `asymptotic`
 * branch. Which one is decided by `method`: "exact" and "normal" force it,
 * "auto" (the default) takes the exact branch while `exactWork` stays under
 * `maxWork`. The exact branch is also refused past `exactCells` cells of
 * table, whatever was asked, because that is memory rather than time.
 *
 * Two-sided as 2 x min(P(S <= s), P(S >= s)), capped at 1: the conservative
 * convention, and the one scipy's exact branch uses, so a reader who checks
 * this against scipy gets the same number rather than a defensible different
 * one. (scipy's exact branch assumes no ties; this one counts the permutation
 * null of the tied ranks as they are, which is what a brute-force enumeration
 * gives.)
 */
export function mannWhitney(a, b, { method = "auto", maxWork = EXACT_ROW_WORK, exactCells = 4e6 } = {}) {
  const n1 = a.length, n2 = b.length;
  if (!n1 || !n2) return { u: NaN, p: NaN, n1, n2, exact: false, method: "none" };
  const pooled = [...a, ...b];
  const ranks = doubledRanks(pooled);
  const s1 = ranks.slice(0, n1).reduce((x, y) => x + y, 0);   // doubled rank sum
  // U from the doubled rank sum: R1 = s1/2, U1 = R1 - n1(n1+1)/2.
  const u1 = s1 / 2 - (n1 * (n1 + 1)) / 2;
  const u = Math.min(u1, n1 * n2 - u1);

  const totalRank = ranks.reduce((x, y) => x + y, 0);
  // The distribution is counted over the SMALLER group, which is the cheaper
  // table to build and the same answer: the second group's rank sum is the
  // total minus the first's, so P(S2 >= s2) is exactly P(S1 <= s1).
  const small = Math.min(n1, n2);
  const wantExact = method === "exact" ||
    (method !== "normal" && exactWork(n1, n2) <= maxWork);
  if (wantExact && (small + 1) * (totalRank + 1) <= exactCells) {
    // The observed sum of the group the table is counted over.
    const obs = n1 <= n2 ? s1 : totalRank - s1;
    const { counts } = rankSumCounts(ranks, small);
    let all = 0, le = 0, ge = 0;
    for (let s = 0; s < counts.length; s++) {
      const c = counts[s];
      if (!c) continue;
      all += c;
      if (s <= obs) le += c;
      if (s >= obs) ge += c;
    }
    const p = Math.min(1, 2 * Math.min(le / all, ge / all));
    return { u, p, n1, n2, exact: true, method: "exact" };
  }

  // Normal approximation, with the tie correction — without it, a table of
  // mostly-zero rows (which is most of a functional table) gets a p that is far
  // too small, because ties shrink the variance and the uncorrected formula
  // does not know it. The continuity correction is scipy's default too, and it
  // is what keeps the approximation on the conservative side of the exact p at
  // the group sizes where the switch happens.
  const n = n1 + n2;
  const mean = (n1 * n2) / 2;
  const tieTerm = tieCorrection(ranks);
  const varU = (n1 * n2 / 12) * ((n + 1) - tieTerm / (n * (n - 1)));
  if (!(varU > 0)) return { u, p: 1, n1, n2, exact: false, method: "normal" };
  const z = (Math.abs(u1 - mean) - 0.5) / Math.sqrt(varU);   // continuity correction
  return { u, p: Math.min(1, 2 * normalUpper(Math.max(0, z))), n1, n2, exact: false, method: "normal" };
}

/** Sum of (t^3 - t) over tie groups, on the ORIGINAL rank scale (ranks/2). */
function tieCorrection(doubled) {
  const counts = new Map();
  for (const r of doubled) counts.set(r, (counts.get(r) ?? 0) + 1);
  let sum = 0;
  for (const t of counts.values()) sum += t * t * t - t;
  return sum;
}

/**
 * 1 - Φ(z), the upper tail of the standard normal, through erfc.
 *
 * The RELATIVE error is what matters here, and it is what the old 1 - Φ(z)
 * (Abramowitz & Stegun 26.2.17) did not bound: its guarantee was 7.5e-8
 * ABSOLUTE, as large as a quarter of the tail itself at z = 5 — exactly where a
 * large-sample contrast puts its smallest p — and measured against scipy it was
 * 0.5 % off at p = 3e-11. This is the Chebyshev fit of erfc from Numerical
 * Recipes (erfcc), whose error is under 1.2e-7 of the value, everywhere.
 */
function normalUpper(z) {
  const x = z / Math.SQRT2;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.5 * ax);
  const r = t * Math.exp(-ax * ax - 1.26551223 + t * (1.00002368 + t * (0.37409196 +
    t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 +
    t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  const erfc = x >= 0 ? r : 2 - r;
  return erfc / 2;
}

/**
 * The smallest two-sided p this test can return at these group sizes.
 *
 * THE NUMBER THAT MAKES THE COLUMN LEGIBLE. With three samples a group there are
 * C(6,3) = 20 splits, so the most extreme possible result has p = 2/20 = 0.1 —
 * nothing can reach 0.05, however cleanly the groups separate, and a column of
 * q = 1 is arithmetic rather than a failure. At nine a group it is 2/48,620.
 */
export function minAttainableP(n1, n2) {
  if (!n1 || !n2) return NaN;
  // C(n1+n2, n1), by multiplicative build-up so it stays exact for the sizes
  // that matter and merely large for the ones that do not.
  let c = 1;
  for (let i = 1; i <= n1; i++) c = (c * (n2 + i)) / i;
  return Math.min(1, 2 / c);
}

/**
 * Benjamini-Hochberg q-values, in the input's order.
 *
 * Over the WHOLE family the table asks about, not over the ten rows on screen:
 * the question is asked of every row at once, and correcting over the subset
 * that happened to be displayed would be choosing the denominator after seeing
 * the answers.
 */
export function benjaminiHochberg(ps) {
  const n = ps.length;
  const order = ps.map((p, i) => i)
    .filter((i) => Number.isFinite(ps[i]))
    .sort((a, b) => ps[a] - ps[b]);
  const q = new Array(n).fill(NaN);
  let prev = 1;
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    prev = Math.min(prev, (ps[i] * order.length) / (k + 1));
    q[i] = Math.min(1, prev);
  }
  return q;
}

/** "0.031", "3.4e-5", "<1e-9" — a p-value in the width a table column has. */
export function fmtP(p) {
  if (!Number.isFinite(p)) return "—";
  if (p < 1e-9) return "<1e-9";
  if (p >= 0.001) return p.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  const e = p.toExponential(1);
  return e.replace("e-", "e-").replace(/\.0e/, "e");
}
