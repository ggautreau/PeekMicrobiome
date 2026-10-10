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
//     wherever the counts allow it — which at these sizes is always;
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
 * Two-sided Mann-Whitney U for two groups of numbers.
 *
 * Returns { u, p, n1, n2, exact }. `p` is the exact permutation p when the
 * table is small enough to build — always, at the sizes this page deals in —
 * and the tie-corrected normal approximation otherwise.
 *
 * Two-sided as 2 x min(P(S <= s), P(S >= s)), capped at 1: the conservative
 * convention, and the one scipy's exact branch uses, so a reader who checks
 * this against scipy gets the same number rather than a defensible different
 * one.
 */
export function mannWhitney(a, b, { exactCells = 4e6 } = {}) {
  const n1 = a.length, n2 = b.length;
  if (!n1 || !n2) return { u: NaN, p: NaN, n1, n2, exact: false };
  const pooled = [...a, ...b];
  const ranks = doubledRanks(pooled);
  const s1 = ranks.slice(0, n1).reduce((x, y) => x + y, 0);   // doubled rank sum
  // U from the doubled rank sum: R1 = s1/2, U1 = R1 - n1(n1+1)/2.
  const u1 = s1 / 2 - (n1 * (n1 + 1)) / 2;
  const u = Math.min(u1, n1 * n2 - u1);

  const totalRank = ranks.reduce((x, y) => x + y, 0);
  if ((n1 + 1) * (totalRank + 1) <= exactCells) {
    const { counts } = rankSumCounts(ranks, n1);
    let all = 0, le = 0, ge = 0;
    for (let s = 0; s < counts.length; s++) {
      const c = counts[s];
      if (!c) continue;
      all += c;
      if (s <= s1) le += c;
      if (s >= s1) ge += c;
    }
    const p = Math.min(1, 2 * Math.min(le / all, ge / all));
    return { u, p, n1, n2, exact: true };
  }

  // Normal approximation, with the tie correction — without it, a table of
  // mostly-zero rows (which is most of a functional table) gets a p that is far
  // too small, because ties shrink the variance and the uncorrected formula
  // does not know it.
  const n = n1 + n2;
  const mean = (n1 * n2) / 2;
  const tieTerm = tieCorrection(ranks);
  const varU = (n1 * n2 / 12) * ((n + 1) - tieTerm / (n * (n - 1)));
  if (!(varU > 0)) return { u, p: 1, n1, n2, exact: false };
  const z = (Math.abs(u1 - mean) - 0.5) / Math.sqrt(varU);   // continuity correction
  return { u, p: Math.min(1, 2 * (1 - normalCdf(Math.max(0, z)))), n1, n2, exact: false };
}

/** Sum of (t^3 - t) over tie groups, on the ORIGINAL rank scale (ranks/2). */
function tieCorrection(doubled) {
  const counts = new Map();
  for (const r of doubled) counts.set(r, (counts.get(r) ?? 0) + 1);
  let sum = 0;
  for (const t of counts.values()) sum += t * t * t - t;
  return sum;
}

/** Φ(z), Abramowitz & Stegun 7.1.26 through erf — five-digit accuracy, plenty here. */
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
    t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
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
