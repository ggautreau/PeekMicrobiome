// Ordering a matrix so that what is alike sits together.
//
// A relative-abundance matrix in the order sylph happened to emit is a wall of
// numbers: the samples are in the order they were dropped, the taxa in the order
// they were detected, and neither says anything. Reordered by similarity, the
// same numbers show their blocks — which samples resemble each other, and which
// taxa move together across them.
//
// No DOM, no fetch: numbers in, orders out. multi.js decides when to call it.
//
// WHY BRAY-CURTIS FOR SAMPLES
// ---------------------------
// It is the distance the field uses for compositional abundance data, it needs
// no transformation, and it is bounded in [0,1] so a dendrogram cut means the
// same thing everywhere in the matrix. Euclidean distance on relative
// abundances is dominated by whichever taxon happens to be most abundant.
//
// WHY CORRELATION FOR TAXA
// ------------------------
// Rows are asked a different question: not "how much of this is there" but
// "does it rise and fall with that one". Two taxa at 0.1% and 40% that track
// each other perfectly are the same answer to that question, and Bray-Curtis
// would put them at opposite ends.
//
// COST, MEASURED IN THE SHAPE THIS ACTUALLY RUNS AT
// -------------------------------------------------
// Average-linkage agglomerative clustering, O(n^2) distances then O(n^2) merges
// with a running nearest-neighbour scan. At 85 samples that is instant; at 600
// taxa it is a few tens of milliseconds. Above `MAX_ROWS` the rows are left in
// abundance order instead — an ordering nobody waits for beats a better one
// that stalls the page after every sample.

export const MAX_ROWS = 1200;

/** Bray-Curtis between two abundance vectors. 0 = identical, 1 = disjoint. */
export function brayCurtis(a, b) {
  let sumMin = 0, sumAll = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    sumMin += Math.min(x, y);
    sumAll += x + y;
  }
  return sumAll === 0 ? 0 : 1 - (2 * sumMin) / sumAll;
}

/**
 * 1 - Pearson correlation, as a distance in [0,2].
 *
 * A vector with no variance correlates with nothing — every value identical
 * means there is no "rises and falls" to compare. Those get distance 1, i.e.
 * "unrelated", rather than NaN, which would poison every merge it touched.
 */
export function correlationDistance(a, b) {
  const n = a.length;
  if (n < 2) return 1;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i] || 0; mb += b[i] || 0; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = (a[i] || 0) - ma, y = (b[i] || 0) - mb;
    num += x * y; da += x * x; db += y * y;
  }
  if (da === 0 || db === 0) return 1;
  return 1 - num / Math.sqrt(da * db);
}

/**
 * Average-linkage agglomerative clustering, returning the leaf order.
 *
 * `vectors` is an array of arrays; the result is a permutation of their indices
 * with similar vectors adjacent. Fewer than three vectors have only one
 * ordering worth having, so they come back untouched.
 */
export function clusterOrder(vectors, distFn) {
  const n = vectors.length;
  if (n < 3) return vectors.map((_, i) => i);

  // Full symmetric matrix rather than a condensed one: merging rewrites whole
  // rows, and the index arithmetic for a condensed triangle costs more here
  // than the memory it saves.
  const D = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const v = distFn(vectors[i], vectors[j]);
      D[i * n + j] = v; D[j * n + i] = v;
    }
  }

  const size = new Int32Array(n).fill(1);   // members per cluster
  const alive = new Uint8Array(n).fill(1);
  // The leaves under each live cluster, IN ORDER. Concatenating on merge is what
  // produces the final ordering — no tree to walk back out, and no chance of a
  // leaf being dropped by a bookkeeping mistake, which is exactly what the first
  // version of this did.
  const leaves = Array.from({ length: n }, (_, i) => [i]);

  // Nearest neighbour of each live cluster, and its distance. Keeping these is
  // what turns the O(n^3) "rescan every pair on every merge" into O(n^2): a
  // merge only invalidates the entries that pointed at the two clusters it
  // consumed.
  const nn = new Int32Array(n).fill(-1);
  const nnd = new Float64Array(n).fill(Infinity);
  const rescan = (i) => {
    let best = Infinity, bj = -1;
    for (let j = 0; j < n; j++) {
      if (j === i || !alive[j]) continue;
      const v = D[i * n + j];
      if (v < best) { best = v; bj = j; }
    }
    nn[i] = bj; nnd[i] = best;
  };
  for (let i = 0; i < n; i++) rescan(i);

  let remaining = n;
  while (remaining > 1) {
    let best = Infinity, a = -1;
    for (let i = 0; i < n; i++) {
      if (alive[i] && nnd[i] < best) { best = nnd[i]; a = i; }
    }
    if (a < 0) break;
    const b = nn[a];
    if (b < 0 || !alive[b]) break;

    // Lance-Williams for average linkage: the distance from the merged cluster
    // to any other is the size-weighted mean of the two it came from. Exact,
    // and O(n) instead of re-averaging every member pair.
    const sa = size[a], sb = size[b], st = sa + sb;
    for (let k = 0; k < n; k++) {
      if (k === a || k === b || !alive[k]) continue;
      const v = (sa * D[a * n + k] + sb * D[b * n + k]) / st;
      D[a * n + k] = v; D[k * n + a] = v;
    }
    leaves[a] = leaves[a].concat(leaves[b]);
    leaves[b] = null;
    alive[b] = 0;
    size[a] = st;
    remaining--;

    // Only entries that pointed at a or b are stale.
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      if (i === a || nn[i] === a || nn[i] === b) rescan(i);
    }
  }

  // One live cluster in the normal case; more only if the loop bailed out, and
  // then their concatenation is still every leaf exactly once.
  const order = [];
  for (let i = 0; i < n; i++) if (alive[i] && leaves[i]) order.push(...leaves[i]);
  return order;
}

/**
 * Reorder a matrix table in place-ish, returning a new one.
 *
 * `table` is what matrixToTable() produces: { samples, rows, ... } where each
 * row has `values` aligned with `samples`. Returns the same shape with both
 * axes permuted, plus `clustered` saying which axes were actually reordered —
 * the caller says so on screen rather than leaving the user to wonder whether
 * the order means anything.
 */
export function clusterTable(table, { maxRows = MAX_ROWS } = {}) {
  const { samples, rows } = table;
  if (!rows?.length || !samples?.length) return { ...table, clustered: { rows: false, samples: false } };

  const doRows = rows.length >= 3 && rows.length <= maxRows;
  const doCols = samples.length >= 3;

  // Columns are clustered on the sample profiles: one vector per sample, over
  // every taxon. Built from the rows, since that is where the numbers live.
  let sampleOrder = samples.map((_, i) => i);
  if (doCols) {
    const profiles = samples.map((_, c) => rows.map((r) => r.values[c] || 0));
    sampleOrder = clusterOrder(profiles, brayCurtis);
  }

  let rowOrder = rows.map((_, i) => i);
  if (doRows) rowOrder = clusterOrder(rows.map((r) => r.values), correlationDistance);

  return {
    ...table,
    samples: sampleOrder.map((i) => samples[i]),
    refs: table.refs ? sampleOrder.map((i) => table.refs[i]) : table.refs,
    rows: rowOrder.map((i) => {
      const r = rows[i];
      return { ...r, values: sampleOrder.map((c) => r.values[c]) };
    }),
    clustered: { rows: doRows, samples: doCols },
  };
}
