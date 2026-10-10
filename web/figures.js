// The three figures a microbiome result is normally shown as, computed from the
// matrix already in memory and drawn as inline SVG.
//
// No DOM, no fetch, no library: a table in, an SVG string out. That is what
// makes them testable, and what lets the user save one straight into a
// manuscript — an SVG is text, so "download" is a Blob and nothing more.
//
// WHAT THESE NUMBERS ARE, AND ARE NOT
// -----------------------------------
// Every figure here is computed on RELATIVE abundances against one catalogue.
// Diversity indices computed that way are diversity OF THE PROFILE, not of the
// sample: species the catalogue does not contain are absent from both, and a
// catalogue with 19,472 genomes will show more of them than one with 280. They
// compare samples profiled against the SAME catalogue, and nothing else — which
// is why every figure carries the reference in its caption.

const PALETTE = [
  "#00a3a6", "#c0392b", "#2a8a55", "#7b5ea7", "#d98c00", "#1f6fb2",
  "#c2568f", "#4d8b3f", "#a35c2a", "#5c6bc0", "#00897b", "#8d6e63",
];
const GREY = "#b8bcbd";
// One step darker, for the alternating rare wedges of the pie. Close enough that
// the pool still reads as one grey remainder, far enough that a boundary between
// two of a hundred slices is visible.
const GREY_ALT = "#a7abac";
const INK = "#1f2426";

/**
 * The colour of the nth named taxon.
 *
 * Twelve hues is what a legend can carry and what a reader can tell apart, and
 * the page now lets you ask for more taxa than that. `PALETTE[n % 12]` would
 * give the thirteenth the same teal as the first — one figure, two taxa, one
 * colour, and no way to know which segment is which. Each time round it is the
 * same twelve mixed toward white instead: related to the first cycle, never
 * equal to it, and still dark enough for inkOn to pick a readable label.
 */
function shade(hex, f) {
  const at = (i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const mix = (v) => Math.round(v + (255 - v) * f).toString(16).padStart(2, "0");
  return `#${mix(at(0))}${mix(at(1))}${mix(at(2))}`;
}
export function colourAt(n) {
  const cycle = Math.floor(n / PALETTE.length);
  const hue = PALETTE[n % PALETTE.length];
  return cycle === 0 ? hue : shade(hue, Math.min(0.6, 0.34 * cycle));
}

/**
 * How many taxa can be named before two of them share a colour.
 *
 * Three cycles: the twelve hues, the same twelve at 0.34 toward white, and at
 * 0.6. The mix is capped there because past it the swatches are pastel enough to
 * be confused with each other, so a fourth cycle would repeat the third — this
 * is the ceiling, and the control that lets you ask for more taxa is held below
 * it rather than left to discover it.
 */
export const NAMED_COLOURS = PALETTE.length * 3;

/**
 * Black or white on a given fill, whichever a reader can actually make out.
 *
 * Half this palette is light enough that white text on it lands near 3:1 —
 * #d98c00 is 2.7:1 — and a percentage nobody can read is a percentage that is
 * not there. sRGB relative luminance, per WCAG, with 0.45 as the crossover:
 * that is where the two contrast ratios meet.
 */
function inkOn(hex) {
  const v = (i) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * v(0) + 0.7152 * v(1) + 0.0722 * v(2) > 0.45 ? INK : "#ffffff";
}

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

/**
 * The three Hill numbers, per sample: q = 0, 1 and 2.
 *
 * All computed on the abundances RENORMALISED to sum to 1 within each sample.
 * sylph's taxonomic abundances already sum to ~100 per sample, but only over
 * what it detected — renormalising makes that explicit instead of letting a
 * sample that sums to 97.3 score differently for that reason alone.
 *
 * WHY THREE AND NOT ONE. They are the same family read at three weightings, and
 * the difference between them is the difference between three questions:
 *
 *   q=0  richness — every row counts the same, so a row detected on one shared
 *        hash weighs as much as one at 2%. The most exposed to the detection
 *        floor, and the number a deeper run inflates.
 *   q=1  exp(Shannon) — rows weighted by their abundance. The standard, and what
 *        the literature reports.
 *   q=2  inverse Simpson — dominated by the abundant rows, so it all but ignores
 *        the tail. On this project's own functional profiles it separates
 *        samples 1.7x better than q=1 (CV 14.2% against 8.6%), because that tail
 *        is where a sketch estimate is least reliable.
 *
 * Reporting one alone invites the reader to take it as "the" diversity. Three
 * agreeing is a result; three disagreeing says the answer depends on how the
 * rare rows are weighted, which is itself worth seeing.
 */
export function alphaDiversity(table) {
  return table.samples.map((name, c) => {
    const vals = table.rows.map((r) => r.values[c] || 0).filter((v) => v > 0);
    const total = vals.reduce((a, v) => a + v, 0);
    let shannon = 0, simpson = 0;
    if (total > 0) {
      for (const v of vals) {
        const p = v / total;
        shannon -= p * Math.log(p);
        simpson += p * p;
      }
    }
    return {
      sample: name,
      richness: vals.length,
      shannon,
      // e^H — "how many equally-abundant taxa would give this diversity". Far
      // easier to read than nats, and the unit people actually compare.
      effective: vals.length ? Math.exp(shannon) : 0,
      // 1/Σp² — the same unit again, so the three are directly comparable: all
      // three answer "how many equally-abundant rows would look like this".
      inverseSimpson: simpson > 0 ? 1 / simpson : 0,
    };
  });
}

/**
 * What one sample is, beyond its composition: how diverse, where it stands among
 * the others, and which samples it is actually nearest.
 *
 * The last one is the point. An ordination shows distance in two dimensions when
 * the real distances live in as many dimensions as there are taxa, so two points
 * that look adjacent may not be — the axis labels give the fraction that survives
 * the projection, and the rest is lost. These distances are the full ones,
 * computed on every row, and they are what the plot is an approximation OF.
 *
 * Pure arithmetic over the table already in memory: O(samples x rows), one
 * column against the rest, rather than the whole matrix for one answer.
 */
export const METRICS = {
  // Both over every row of the matrix, both on the abundances as they are.
  //
  // Bray-Curtis asks what share of the two profiles is NOT shared: 0 is the same
  // profile, 1 shares nothing. It is bounded, it ignores taxa absent from both,
  // and it is what the ordination is computed from.
  //
  // Euclidean is the straight-line distance between the two abundance vectors.
  // It is dominated by the few most abundant taxa — a sample differing by 30
  // points of Prevotella outweighs a hundred rare species — and its ceiling for
  // percentages is sqrt(2) x 100.
  bray: { label: "Bray-Curtis", max: 1, digits: 3 },
  euclid: { label: "Euclidean", max: Math.SQRT2 * 100, digits: 1 },
};

export function sampleFacts(table, sample, { neighbours = 4, metric = "bray" } = {}) {
  const c = typeof sample === "number" ? sample : table.samples.indexOf(sample);
  if (c < 0 || table.samples[c] === undefined) return null;

  const alpha = alphaDiversity(table);
  const mine = alpha[c];
  // 1 = the most diverse of the run. Ties take the same rank, as they must:
  // two identical samples cannot be 6th and 7th.
  const rank = alpha.filter((a) => a.effective > mine.effective).length + 1;

  const how = METRICS[metric] ? metric : "bray";
  const col = (j) => table.rows.map((r) => r.values[j] || 0);
  const self = col(c);
  const near = table.samples.map((name, j) => {
    if (j === c) return null;
    const other = col(j);
    let sumMin = 0, sumAll = 0, sq = 0;
    for (let k = 0; k < self.length; k++) {
      sumMin += Math.min(self[k], other[k]);
      sumAll += self[k] + other[k];
      const d = self[k] - other[k];
      sq += d * d;
    }
    return {
      sample: name,
      distance: how === "euclid"
        ? Math.sqrt(sq)
        : (sumAll === 0 ? 0 : 1 - (2 * sumMin) / sumAll),
    };
  }).filter(Boolean).sort((a, b) => a.distance - b.distance).slice(0, neighbours);

  return {
    sample: table.samples[c],
    richness: mine.richness,
    shannon: mine.shannon,
    effective: mine.effective,
    // The third weighting, carried through so the panel can print all three
    // where the figure prints all three.
    inverseSimpson: mine.inverseSimpson,
    rank,
    of: table.samples.length,
    metric: how,
    nearest: near,
  };
}

/** Bray-Curtis distance matrix over samples, as a square array. */
export function distanceMatrix(table) {
  const n = table.samples.length;
  const cols = table.samples.map((_, c) => table.rows.map((r) => r.values[c] || 0));
  const D = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let sumMin = 0, sumAll = 0;
      for (let k = 0; k < cols[i].length; k++) {
        sumMin += Math.min(cols[i][k], cols[j][k]);
        sumAll += cols[i][k] + cols[j][k];
      }
      const d = sumAll === 0 ? 0 : 1 - (2 * sumMin) / sumAll;
      D[i][j] = d; D[j][i] = d;
    }
  }
  return D;
}

/**
 * Every eigenvalue of a symmetric matrix, by cyclic Jacobi rotations.
 *
 * Values only, no vectors: this exists to answer "how much of the variation is
 * the plot NOT showing", which needs the whole spectrum and none of the
 * directions. O(n^3) in the number of SAMPLES — a few million operations for a
 * run of eighty-five, and the ordination is drawn on demand.
 */
export function eigenvaluesSym(M, { sweeps = 24, tol = 1e-10 } = {}) {
  const n = M.length;
  const a = Array.from({ length: n }, (_, i) => Float64Array.from(M[i]));
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    if (off <= tol) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-14) continue;
        // The rotation that zeroes a[p][q], from the standard stable formula.
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s2 = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s2 * akq;
          a[k][q] = s2 * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s2 * aqk;
          a[q][k] = s2 * apk + c * aqk;
        }
      }
    }
  }
  return Array.from({ length: n }, (_, i) => a[i][i]).sort((x, y) => y - x);
}

/**
 * Principal coordinates analysis on a distance matrix.
 *
 * Classical MDS: double-centre -0.5 * D^2, then take the leading eigenvectors.
 * Power iteration with deflation rather than a full eigendecomposition — two
 * axes are all a scatter plot uses, and pulling in a linear-algebra library for
 * the other n-2 would be the largest dependency in the project.
 *
 * Returns { points: [{x, y}], explained: [f1, f2] } where the fractions are of
 * the positive eigenvalue total. Bray-Curtis is not Euclidean, so negative
 * eigenvalues are normal and are excluded from that total rather than hidden.
 */
export function pcoa(D, { dims = 2, iters = 200 } = {}) {
  const n = D.length;
  if (n < 3) return { points: D.map(() => ({ x: 0, y: 0 })), explained: [0, 0] };

  // Gower double-centring of -0.5 * D^2.
  const A = Array.from({ length: n }, (_, i) =>
    Float64Array.from({ length: n }, (_, j) => -0.5 * D[i][j] * D[i][j]));
  const rowMean = A.map((r) => r.reduce((a, v) => a + v, 0) / n);
  const grand = rowMean.reduce((a, v) => a + v, 0) / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) A[i][j] = A[i][j] - rowMean[i] - rowMean[j] + grand;
  }

  const mul = (v) => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += A[i][j] * v[j];
      out[i] = s;
    }
    return out;
  };

  // Deflate a vector against the axes already taken, in place.
  const orth = (w) => {
    for (let k = 0; k < vecs.length; k++) {
      let dot = 0;
      for (let i = 0; i < n; i++) dot += w[i] * vecs[k][i];
      for (let i = 0; i < n; i++) w[i] -= dot * vecs[k][i];
    }
    return Math.hypot(...w);
  };

  const vecs = [], vals = [];
  for (let d = 0; d < dims; d++) {
    let v = null, lambda = 0;
    // Fixed starts, not random ones: the same matrix must give the same plot
    // twice, and a sign flip between redraws reads as the points moving. Several
    // of them, because ONE fixed start is a trap — where an eigenvalue is
    // repeated, the iteration converges to the projection of its start vector
    // onto that eigenspace, and if the next start projects onto the same
    // direction, deflation leaves nothing and the axis collapses to zero. Eight
    // points at the corners of a cube did exactly that: three equal eigenvalues,
    // PCo2 reported as 0, every sample drawn on one horizontal line.
    for (let k = 0; k < 4 && !(lambda > 1e-9); k++) {
      let u = Float64Array.from({ length: n },
        (_, i) => Math.sin((i + 1) * (1 + 0.37 * k) + 1 + d + 2.1 * k));
      // The START is orthogonalised, so the iteration begins inside the subspace
      // that is left rather than being pulled back out of it every step.
      if (!(orth(u) > 1e-12)) continue;
      let norm = Math.hypot(...u);
      for (let i = 0; i < n; i++) u[i] /= norm;
      for (let it = 0; it < iters; it++) {
        const w = mul(u);
        norm = orth(w);
        if (!(norm > 1e-12)) { lambda = 0; break; }
        for (let i = 0; i < n; i++) w[i] /= norm;
        lambda = norm;
        u = w;
      }
      v = u;
    }
    vecs.push(v ?? new Float64Array(n));
    vals.push(lambda);
  }

  // Only positive eigenvalues carry variance that a plane can show; Bray-Curtis
  // routinely produces negative ones and calling their total "100%" would be a
  // lie in the axis label.
  //
  // The total is taken over the WHOLE spectrum, not over the axes that happen to
  // have been computed. Summed over `vals` — two numbers — the two fractions
  // added up to 100% whatever the data, so the plot claimed to show all of the
  // variation every time; asking for four axes changed the first two from
  // 53%/47% to 43%/37% on the same plot. What is lost in the projection is
  // exactly what these labels exist to report.
  const posTotal = eigenvaluesSym(A).filter((x) => x > 0).reduce((a, x) => a + x, 0) || 1;
  const scale = vals.map((l) => Math.sqrt(Math.max(0, l)));
  return {
    points: Array.from({ length: n }, (_, i) => ({
      x: (vecs[0]?.[i] ?? 0) * scale[0],
      y: (vecs[1]?.[i] ?? 0) * scale[1],
    })),
    explained: [Math.max(0, vals[0]) / posTotal, Math.max(0, vals[1]) / posTotal],
  };
}

import { mannWhitney, benjaminiHochberg, minAttainableP, fmtP } from "./stats.js?v=79";

// ---- drawing -----------------------------------------------------------------

// `font` is the whole figure's type size. It is a parameter because the pie is
// drawn into a side panel — on a phone, into about 300 px of one — and an SVG
// scaled to a third of its width takes its text down with it.
const svgOpen = (w, h, title, font = 11, attrs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" ` +
  `font-family="ui-sans-serif, system-ui, sans-serif" font-size="${font}" role="img" ` +
  `${attrs}aria-label="${esc(title)}"><rect width="${w}" height="${h}" fill="#ffffff"/>`;

/**
 * Stacked composition bars, one per sample, top N rows plus "other".
 *
 * "Other" is drawn in grey and is never dropped: with 600 taxa the top 10 rarely
 * reach 100%, and a bar that stops at 60% with no explanation reads as missing
 * data rather than as a legend cut.
 *
 * `species` OR `name`, and `otherLabel`, because this now draws two kinds of
 * table. The functional tables from kegg.js are the same `{ samples, rows }`
 * shape — that is the whole reason functions need no plotting code of their own
 * — but their rows are named `name`, and a legend of ten `undefined`s under a
 * bar of "other taxa" is what reading only `species` produced.
 */
export function compositionSvg(table, {
  topN = 10, width = 900, barH = 0, height = 0, otherLabel = "other taxa",
} = {}) {
  const { samples, rows } = table;
  // `label` before `name`: kegg.js keeps the bare name in `name` for the matrix
  // column and the identifier-plus-name in `label`, which is what a legend needs.
  const labelOf = (r) => r.species ?? r.label ?? r.name ?? "";
  const totals = rows.map((r, i) => ({ i, sum: r.values.reduce((a, v) => a + v, 0) }));
  totals.sort((a, b) => b.sum - a.sum);
  const keep = totals.slice(0, topN).map((t) => t.i);
  const keepSet = new Set(keep);

  const padL = 150, padT = 16, padR = 12, gap = 5;
  const plotW = width - padL - padR;
  // As many legend columns as fit at ~190 px each. Fixed at three, a figure
  // drawn 583 px wide printed its species names over one another.
  const legendCols = Math.max(1, Math.floor(plotW / 190));
  const legendH = 18 * Math.ceil((keep.length + 1) / legendCols) + 14;
  // `height` is the room the page has for this figure. The bars are sized to
  // fill it rather than to a fixed 26 px, so the drawing is the size of the card
  // it sits in instead of leaving a band of empty card under it. Clamped: a run
  // of three samples must not get bars as tall as a hand, and a run of eighty
  // must not get bars too thin to hover.
  const room = height ? height - padT - legendH - 10 : 0;
  const bar = barH || (room
    ? Math.max(10, Math.min(46, room / samples.length - gap))
    : 26);
  const h = padT + samples.length * (bar + gap) + legendH + 10;
  let out = svgOpen(width, h, "Composition per sample");

  samples.forEach((name, c) => {
    const y = padT + c * (bar + gap);
    const total = rows.reduce((a, r) => a + (r.values[c] || 0), 0) || 1;
    let x = padL;
    // A row is a sample you can open, and the whole strip — name included — is
    // the target, not the fifteen segments it is cut into. The rect behind it
    // is what makes the gaps between segments part of the row rather than holes
    // in it, and what the page tints on hover.
    out += `<g class="sample-row" data-sample="${esc(name)}">` +
      `<rect class="row-hit" x="0" y="${y - 2}" width="${width}" height="${bar + 4}" ` +
      `fill="#275662" fill-opacity="0"/>` +
      `<text x="${padL - 8}" y="${y + bar / 2 + 4}" text-anchor="end" fill="#275662">${esc(name)}</text>`;
    keep.forEach((ri, k) => {
      const frac = (rows[ri].values[c] || 0) / total;
      const w = frac * plotW;
      if (w > 0.2) {
        out += `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${bar}" ` +
          `fill="${colourAt(k)}"><title>${esc(labelOf(rows[ri]))} — ${(frac * 100).toFixed(1)}%</title></rect>`;
      }
      x += w;
    });
    const rest = padL + plotW - x;
    if (rest > 0.2) {
      const restFrac = rest / plotW;
      out += `<rect x="${x.toFixed(1)}" y="${y}" width="${rest.toFixed(1)}" height="${bar}" ` +
        `fill="${GREY}"><title>${esc(otherLabel)} — ${(restFrac * 100).toFixed(1)}%</title></rect>`;
    }
    out += "</g>";
  });

  let ly = padT + samples.length * (bar + gap) + 12;
  [...keep.map((ri, k) => [labelOf(rows[ri]), colourAt(k)]), [otherLabel, GREY]]
    .forEach(([label, colour], k) => {
      const col = k % legendCols, row = Math.floor(k / legendCols);
      const colW = plotW / legendCols;
      const lx = padL + col * colW;
      // Clipped to what the column can hold. 6.6 px a character, MEASURED in the
      // browser on this very legend (mean 6.2, max 6.62 at 11 px) rather than
      // guessed: at the 5.6 this started at, the right-hand column's labels
      // ended at x = 711 in a 699-wide viewBox and the figure clipped its own
      // legend — in the downloaded SVG as much as on screen. The 15 px is the
      // swatch and its gap, and the 4 is a gutter so the longest label does not
      // touch the frame.
      const room = Math.max(8, Math.floor((colW - 19) / 6.6));
      const text = String(label).length > room
        ? `${String(label).slice(0, room - 1)}…` : String(label);
      // The full label on hover. KEGG module names run past any legend column —
      // "Glycolysis (Embden-Meyerhof pathway), glucose => pyruvate" is 56
      // characters against a budget of 40 — so without this the ellipsis is
      // where the name ends, and the bars carry a tooltip the legend did not.
      const tip = text === String(label) ? "" : `<title>${esc(label)}</title>`;
      out += `<g>${tip}` +
        `<rect x="${lx}" y="${ly + row * 18}" width="10" height="10" fill="${colour}"/>` +
        `<text x="${lx + 15}" y="${ly + row * 18 + 9}" fill="#5a5550">${esc(text)}</text></g>`;
    });
  return out + "</svg>";
}

/**
 * Shannon (as an effective count) and observed richness, one row per sample.
 *
 * `unit` names what is being counted. Shannon does not care whether a row is a
 * species or a KEGG module, but the reader does: "effective number of taxa"
 * over a table of pathways is the taxonomic figure's caption showing through.
 */
export function alphaSvg(table, { width = 760, rowH = 0, height = 0, unit = "taxa" } = {}) {
  const a = alphaDiversity(table);
  // padR holds the value written past the end of the longest bar. Measured from
  // the longest label there actually is, at ~6.4 px a character: fixed at 60 it
  // was cut off mid-number the moment the figure stopped being 760 px wide, and
  // any fixed number is the same bug waiting for a longer number.
  // The three numbers, in one string, so the bar is the standard index and the
  // other two weightings sit beside it rather than in a control nobody finds.
  const trail = (d) => `${d.effective.toFixed(1)}  (${d.richness} obs. · ` +
    `${d.inverseSimpson.toFixed(0)} at q=2)`;
  const longest = Math.max(8, ...a.map((d) => trail(d).length));
  const padL = 150, padT = 30, padR = Math.ceil(longest * 6.4) + 12;
  const plotW = width - padL - padR;
  // Same as the composition: the rows fill the height the page has for them.
  const row = rowH || (height
    ? Math.max(14, Math.min(40, (height - padT - 34) / a.length))
    : 22);
  const h = padT + a.length * row + 34;
  const maxEff = Math.max(1, ...a.map((d) => d.effective));
  let out = svgOpen(width, h, "Alpha diversity per sample");
  out += `<text x="${padL}" y="16" fill="#275662" font-weight="600">` +
    `Effective number of ${esc(unit)} — bar q=1 (e^Shannon), then q=0 and q=2</text>`;
  a.forEach((d, i) => {
    const y = padT + i * row;
    const w = (d.effective / maxEff) * plotW;
    out += `<g class="sample-row" data-sample="${esc(d.sample)}">` +
      `<rect class="row-hit" x="0" y="${y}" width="${width}" height="${row - 2}" ` +
      `fill="#275662" fill-opacity="0"/>` +
      `<text x="${padL - 8}" y="${(y + row / 2 + 4).toFixed(1)}" text-anchor="end" fill="#275662">${esc(d.sample)}</text>` +
      `<rect x="${padL}" y="${(y + row / 2 - 6.5).toFixed(1)}" width="${w.toFixed(1)}" ` +
      `height="13" fill="#00a3a6">` +
      `<title>${esc(d.sample)}: Hill numbers over ${esc(unit)} — ` +
      `q=0 ${d.richness} observed, q=1 ${d.effective.toFixed(1)} (Shannon ${d.shannon.toFixed(2)}), ` +
      `q=2 ${d.inverseSimpson.toFixed(1)} (inverse Simpson). All three are ` +
      `"how many equally-abundant ${esc(unit)} would look like this".</title></rect>` +
      `<text x="${padL + w + 6}" y="${(y + row / 2 + 4).toFixed(1)}" fill="#5a5550">${d.effective.toFixed(1)} ` +
      `<tspan fill="#6b7172">(${d.richness} obs. · ${d.inverseSimpson.toFixed(0)} at q=2)</tspan>` +
      `</text></g>`;
  });
  return out + "</svg>";
}

/**
 * Which rows differ between two groups of samples — or, with no groups, which
 * rows vary most across them.
 *
 * WHY THERE ARE NO P-VALUES HERE, and why that is the honest choice rather than
 * the lazy one. A run on this page is typically a handful of samples; the rows
 * are compositional, so they are not independent; and there are 100 pathways or
 * 13,509 orthologs of them, which is a multiple-testing problem no correction
 * rescues at n=9 per group. A page that printed "p = 0.03" beside a pathway
 * would be making a claim its own data cannot support, and readers would carry
 * that number into a paper. So this figure ranks by EFFECT — the difference in
 * mean relative abundance — and then shows every sample as a dot, which is the
 * thing a p-value is a lossy summary of: the reader sees the spread, the
 * overlap, and the one outlier carrying a difference, and draws their own
 * conclusion.
 *
 * `groupOf(sample)` returns a group name or null. With two or more groups the
 * two LARGEST are contrasted, and the caller is told which in the returned
 * markup's title. With fewer, rows are ranked by spread (max − min across
 * samples) and no means are drawn — there is nothing to contrast them with.
 *
 * The same `{ samples, rows }` table as every other figure here, so it draws
 * taxa and functions with no second implementation.
 */
export function contrastSvg(table, {
  topN = 10, width = 900, height = 0, rowH = 0, groupOf = () => null, unit = "taxa",
  pair = null, scale = 1, test = true, stats = null, sort = null,
} = {}) {
  const { samples, rows } = table;
  const labelOf = (r) => r.species ?? r.label ?? r.name ?? "";

  // Which groups, and how big. Sorted by size, then by name so a tie is stable
  // rather than dependent on the order samples happened to arrive in.
  const bySize = new Map();
  samples.forEach((s, i) => {
    const g = groupOf(s);
    if (!g) return;
    if (!bySize.has(g)) bySize.set(g, []);
    bySize.get(g).push(i);
  });
  const groups = [...bySize.entries()]
    .sort((a, b) => b[1].length - a[1].length || String(a[0]).localeCompare(String(b[0])));
  // The caller's pair wins, when both halves of it exist. Six groups of three
  // makes "the two largest" a coin toss settled by alphabetical order, which is
  // not a choice a reader made — so the page offers the choice and passes it
  // here. Falling back to the two largest keeps the figure drawable before
  // anyone has picked, and with no picker at all.
  const want = pair && pair.length === 2
    ? pair.map((n) => groups.find(([g]) => g === n)).filter(Boolean) : [];
  const cand = want.length === 2 && want[0][0] !== want[1][0] ? want : groups;
  const paired = cand.length >= 2 && cand[0][1].length >= 2 && cand[1][1].length >= 2;
  const [gA, gB] = paired ? [cand[0], cand[1]] : [null, null];

  const mean = (values, idx) => idx.reduce((a, i) => a + (values[i] ?? 0), 0) / idx.length;
  const scored = rows.map((r) => {
    if (paired) {
      const a = mean(r.values, gA[1]), b = mean(r.values, gB[1]);
      // `score` ranks (it is a magnitude, so the largest differences head the
      // figure whichever way they point); `signed` is the number printed in the
      // diff column, and it is what a click on that column sorts by.
      return { r, a, b, score: Math.abs(a - b), signed: a - b };
    }
    // NOT Math.min(...values, 0). That extra 0 pins the bottom of every range at
    // zero, so the "range" becomes the maximum and the figure silently ranks by
    // abundance — which is the one thing it exists not to do. A row present at
    // 50 % in every sample would head a chart titled "most variable".
    if (!r.values.length) return { r, a: null, b: null, score: 0 };
    const hi = Math.max(...r.values), lo = Math.min(...r.values);
    return { r, a: null, b: null, score: hi - lo };
  });
  // THE TEST, over EVERY row rather than over the ten that will be drawn: the
  // question is asked of the whole table at once, so correcting over the subset
  // that happened to be shown would be choosing the denominator after seeing the
  // answers. Exact Mann-Whitney at these sizes — 468 rows of the shipped example
  // take 64 ms — and Benjamini-Hochberg across the family.
  //
  // Ranked by EFFECT still, not by p. A p-value orders rows by how confident the
  // data are, which at nine samples a group is mostly a ranking of how many
  // zeros a row has; the difference in abundance is what the reader came for,
  // and the q is what says whether to believe it.
  if (paired && test) {
    // `stats` lets the caller hand in what it already computed. The test is
    // EXACT and therefore not free — 4,307 orthologs take 470 ms — and it
    // depends on the rows and the grouping, on neither the width nor the top-N.
    // Recomputing it while somebody drags the slider is half a second of blocked
    // main thread per tick, for numbers that cannot have changed.
    //
    // Computed here when nothing is handed in, so the function stays whole and
    // testable on its own.
    const ready = stats && stats.length === scored.length;
    const ps = ready ? stats.map((x) => x.p)
      : scored.map((x) => mannWhitney(gA[1].map((i) => x.r.values[i] ?? 0),
        gB[1].map((i) => x.r.values[i] ?? 0)).p);
    const qs = ready ? stats.map((x) => x.q) : benjaminiHochberg(ps);
    scored.forEach((x, i) => { x.p = ps[i]; x.q = qs[i]; });
  }
  // WHICH ROWS, then IN WHAT ORDER — and they are not the same decision. The
  // figure exists to show the largest differences, so the top-N is always cut by
  // effect: sorting by q first and cutting would answer "the ten most confident
  // rows", which at these sample sizes is mostly a ranking of how many zeros a
  // row has. The reader's click reorders what was selected; it does not select.
  scored.sort((x, y) => y.score - x.score);
  const keep = scored.slice(0, topN).filter((x) => x.score > 0);
  if (sort?.col === "diff" || sort?.col === "q") {
    const asc = sort.dir === "asc";
    // The diff column prints a signed number and the lane is drawn from its
    // magnitude, so "sort by diff" means the signed value a reader sees — which
    // is why this reads `signed` and not `score`.
    const at = (x) => (sort.col === "q"
      ? (Number.isFinite(x.q) ? x.q : Infinity)
      : (x.signed ?? x.score));
    keep.sort((x, y) => {
      const d = asc ? at(x) - at(y) : at(y) - at(x);
      // Ties on q are the rule rather than the exception once Benjamini-Hochberg
      // has flattened a family, so the effect breaks them and the order is
      // stable between two renders of the same data.
      return d || (y.score - x.score);
    });
  }

  // THE ONE FIGURE HERE THAT PRINTS AN ABUNDANCE. Composition normalises each
  // column and the diversity chart draws Hill numbers, so neither cares what
  // unit the values are in; this one writes "+0.72" beside a lane and has to
  // mean percentage points when it does. The taxonomic matrix already holds
  // percentages and the functional tables hold fractions summing to one — the
  // same split paintMatrix carries as `scale` — so the caller says which, and a
  // hard-coded x100 printed "+1367.36" for a difference of 13.67 points.
  const pc = (v) => v * scale;

  // padR holds the difference AND, when there is a test, the q beside it. Fixed
  // at 74 the q was drawn past the right edge of the figure — the same class of
  // bug as the clipped row labels, one column over.
  const showQ = paired && test;
  const qCol = 62;                       // where the q sits, from the lane's end
  // padT grows with the subtitle. SVG does not wrap text, so a caption longer
  // than the figure is a caption cut off mid-word — which is what "Benjamini-
  // Hochberg over 468 ro" was. Each line is emitted separately and the top
  // padding is sized to how many there are.
  // The label column follows the figure's width instead of being 190 px whatever
  // the room: at 740 px that fixed number truncated "Phocaeicola coprophilus" to
  // 24 characters while 150 px of lane sat empty, and at 420 px it took nearly
  // half the picture. Clamped at both ends — under 140 a species name is a
  // stub, over 280 the lanes start to lose what they are for.
  const padL = Math.round(Math.max(140, Math.min(280, width * 0.26)));
  const padR = showQ ? 128 : 74;
  // 7 px a character, not the 6.4 alphaSvg uses for its own trailing numbers:
  // those are digits, and these are names. At 6.4 a 27-character label still
  // started a few pixels left of the figure — "map00030 — Pentose phospha…"
  // rendered as "nap00030 …" — because m, w and the em dash are all wider than
  // the average this figure is measured on.
  const labelChars = Math.max(6, Math.floor((padL - 16) / 7));
  const plotW = Math.max(60, width - padL - padR);
  // Two at most now that the floor rides on the q line — and the reserved space
  // has to shrink with the text, or the rows keep being squeezed for a line that
  // is no longer drawn.
  const subLines = paired && showQ ? 2 : 1;
  // A line for the two column headings, above the first lane where a table puts
  // them. They used to share the axis line with the group legend, both anchored
  // at the same x — so "M048 ● M055" ran straight into "diff" and the figure
  // ended in "M0155 3diff".
  const headRoom = 11;
  const padT = 22 + subLines * 12 + headRoom;
  const row = rowH || (height
    // Up to 46, not 38, and measured against the room the axis and legend now
    // take: ten lanes at 38 in a 608 px box left 130 px of empty bordered card
    // under the axis, which reads as a figure that failed to fill its frame.
    ? Math.max(16, Math.min(46, (height - padT - (paired ? 62 : 46)) / Math.max(1, keep.length)))
    : 26);
  // 46 under the last lane for the axis and its ticks, and another 16 when a
  // group legend goes below them.
  const h = padT + Math.max(1, keep.length) * row + (paired ? 62 : 46);
  // Every lane on ONE scale, so a long lane means more than a short one wherever
  // it sits. Per-lane scaling would make a trace row look like the biggest thing
  // in the figure.
  const max = Math.max(1e-9, ...keep.flatMap((x) => x.r.values));

  const heading = paired
    ? `Largest differences between ${gA[0]} (n=${gA[1].length}) and ${gB[0]} (n=${gB[1].length})`
    : `Most variable ${unit} across the ${samples.length} samples`;
  let out = svgOpen(width, h, heading);
  out += `<text x="0" y="14" fill="#275662" font-weight="600">${esc(heading)}</text>`;
  // TWO LINES AT MOST, and each has to fit: SVG does not wrap, so a sentence
  // longer than the figure is one cut off mid-word with no ellipsis to say so.
  // There were three, and the third repeated what the caption under the figure
  // then said again — the method was on screen three times over a plot whose
  // rows were being squeezed to make room for it. The first line says what the
  // marks are; the second says what the q column is and, where it bites, the
  // floor: at three samples a group the smallest p the test can return is 0.1,
  // so nothing clears 0.05 however cleanly the groups separate, and a column of
  // q = 1 is arithmetic rather than a failure. That one cannot be dropped —
  // it is the difference between a null result and a broken figure.
  const floorP = paired ? minAttainableP(gA[1].length, gB[1].length) : NaN;
  const subs = paired
    ? ["Difference in mean abundance · one dot per sample · bars are the group means"]
    : ["Range across samples, largest first · make or pick two groups to contrast them"];
  if (showQ) {
    // THE FLOOR RESTS ON AN ASSUMPTION, and the figure has to say so. It is
    // computed from the NUMBER OF SAMPLES, which is the number of independent
    // observations only if each sample is one. Three stool samples from one
    // donor are near-replicates — on the shipped example the mean within-donor
    // distance is 0.326 against 0.734 between — so a nine-against-nine split by
    // sex is really three donors against three, whose floor is 0.1 and not
    // 2/48,620: the printed one is permissive by a factor of 2,431. Nothing in
    // the archive's metadata names the donor there (it is inside `sample_alias`,
    // "A.M065_1"), so guessing it would be worse than saying what is assumed.
    // The reader knows their design; the figure must not pretend the question
    // does not arise.
    subs.push(`q: Mann-Whitney, Benjamini-Hochberg over ${rows.length} rows` +
      (floorP > 0.05
        ? ` · at ${gA[1].length} v ${gB[1].length} samples nothing can reach ${fmtP(floorP)}`
        : "") +
      ` · assumes each sample is independent`);
  }
  subs.forEach((line, i) => {
    out += `<text x="0" y="${27 + i * 12}" fill="#6b7172">${esc(line)}</text>`;
  });

  if (!keep.length) {
    return out + `<text x="0" y="${padT + 20}" fill="#5a5550">` +
      `Nothing to contrast: every row is flat across these samples.</text></svg>`;
  }

  // The two column headings, and — when the figure is a contrast — the handles
  // that reorder it. Marked with a class and a data attribute so the page can
  // wire a click without the figure knowing what a click is, the same contract
  // as `pcoa-pt` and `contrast-pt`. The arrow is the matrix's convention, so a
  // reader who has sorted a table already knows what it means.
  const head = (label, x, key) => {
    const on = sort?.col === key;
    const mark = on ? (sort.dir === "asc" ? " \u2191" : " \u2193") : "";
    const attrs = paired
      ? ` class="contrast-head" data-sort="${key}" role="button" tabindex="0"` +
        ` aria-label="Sort the rows by ${label}"`
      : "";
    return `<text x="${x.toFixed(1)}" y="${padT - 5}"${attrs} ` +
      `fill="${on ? "#275662" : "#9aa0a1"}">${esc(label + mark)}` +
      (paired ? `<title>Click to sort by ${label}</title>` : "") + `</text>`;
  };
  out += head(paired ? "diff" : "range", padL + plotW + 8, "diff");
  if (showQ) out += head("q", padL + plotW + qCol, "q");

  const cA = "#00a3a6", cB = "#e8623b", cNone = "#8b9294";
  const x = (v) => padL + (Math.max(0, v) / max) * plotW;

  keep.forEach((x0, i) => {
    const y = padT + i * row;
    const mid = y + row / 2;
    out += `<g class="contrast-row">`;
    // The lane, so an empty stretch reads as "measured, and low" rather than as
    // a gap in the drawing.
    out += `<line x1="${padL}" y1="${mid.toFixed(1)}" x2="${(padL + plotW).toFixed(1)}" ` +
      `y2="${mid.toFixed(1)}" stroke="#e3e0dc"/>`;
    // Cut to the room there IS, not to a constant. Thirty characters is wider
    // than padL at ~6.4 px each, so "map01100 — Metabolic pathways" started to
    // the left of the figure and the drawing began mid-word.
    out += `<text x="${padL - 10}" y="${(mid + 4).toFixed(1)}" text-anchor="end" fill="#275662">` +
      `${esc(trunc(labelOf(x0.r), labelChars))}<title>${esc(labelOf(x0.r))}</title></text>`;
    if (paired) {
      for (const [val, col] of [[x0.a, cA], [x0.b, cB]]) {
        out += `<rect x="${(x(val) - 1).toFixed(1)}" y="${(mid - 9).toFixed(1)}" width="2" ` +
          `height="18" fill="${col}" fill-opacity="0.85"/>`;
      }
    }
    samples.forEach((s, si) => {
      const g = groupOf(s);
      const col = !paired ? cNone : g === gA[0] ? cA : g === gB[0] ? cB : cNone;
      const v = x0.r.values[si] ?? 0;
      // `contrast-pt` and `data-sample`, so the page can bind the same two
      // gestures it binds on the ordination: hover names the sample, click opens
      // what it is made of. Without them these dots were the only marks on the
      // page that stood for a sample and could not be asked about — a dot in a
      // lane is a sample exactly as a point in the ordination is.
      //
      // No tabindex: ten rows times eighteen samples is 180 tab stops, which is
      // worse for a keyboard than none. The ordination and the diversity chart
      // are the keyboard paths to the same panel.
      out += `<circle class="contrast-pt" data-sample="${esc(s)}" ` +
        `cx="${x(v).toFixed(1)}" cy="${mid.toFixed(1)}" r="3.2" fill="${col}" ` +
        `fill-opacity="0.55" stroke="${col}" stroke-opacity="0.9">` +
        `<title>${esc(s)}${g ? ` (${esc(g)})` : ""}: ${pc(v).toFixed(2)} % — ` +
        `${esc(labelOf(x0.r))}</title></circle>`;
    });
    const trail = paired
      ? `${pc(x0.a - x0.b) >= 0 ? "+" : ""}${pc(x0.a - x0.b).toFixed(2)}`
      : `${pc(x0.score).toFixed(2)}`;
    // The difference, then the q. Grey unless it clears 0.05, because at these
    // sizes almost nothing does and a column of black numbers would read as a
    // column of findings.
    const qText = Number.isFinite(x0.q) ? fmtP(x0.q) : "";
    out += `<text x="${(padL + plotW + 8).toFixed(1)}" y="${(mid + 4).toFixed(1)}" ` +
      `fill="#5a5550">${esc(trail)}</text>`;
    if (qText) {
      out += `<text x="${(padL + plotW + qCol).toFixed(1)}" y="${(mid + 4).toFixed(1)}" ` +
        `fill="${x0.q <= 0.05 ? "#275662" : "#9aa0a1"}" ` +
        `font-weight="${x0.q <= 0.05 ? "600" : "400"}">${esc(qText)}` +
        `<title>Mann-Whitney two-sided p = ${esc(fmtP(x0.p))}, ` +
        `Benjamini-Hochberg q = ${esc(fmtP(x0.q))} over ${rows.length} rows</title></text>`;
    }
    out += `</g>`;
  });

  // The axis, at the bottom, in the unit every number here is in.
  const axisY = padT + keep.length * row + 14;
  out += `<line x1="${padL}" y1="${axisY}" x2="${(padL + plotW).toFixed(1)}" y2="${axisY}" stroke="#c9c4bd"/>`;
  for (const f of [0, 0.5, 1]) {
    const xx = padL + f * plotW;
    out += `<line x1="${xx.toFixed(1)}" y1="${axisY}" x2="${xx.toFixed(1)}" y2="${axisY + 4}" stroke="#c9c4bd"/>` +
      `<text x="${xx.toFixed(1)}" y="${axisY + 16}" text-anchor="middle" fill="#6b7172">` +
      `${pc(max * f).toFixed(pc(max) < 2 ? 2 : 1)} %</text>`;
  }
  if (paired) {
    // A LINE OF ITS OWN. Right-anchored at the end of the lanes, on the same
    // baseline as the axis ticks, it landed exactly on the last tick and the two
    // printed through each other — "M0155 3 %".
    out += `<text x="${(padL + plotW).toFixed(1)}" y="${axisY + 32}" text-anchor="end">` +
      `<tspan fill="${cA}">\u25cf ${esc(gA[0])}</tspan>` +
      `<tspan fill="${cB}">  \u25cf ${esc(gB[0])}</tspan></text>`;
  }

  return out + "</svg>";
}

/**
 * The groups present in a table, largest first — what a "contrast A against B"
 * picker offers. Here rather than in the page so the ordering the picker shows
 * and the ordering contrastSvg falls back to are the same list.
 */
export function contrastGroups(table, groupOf = () => null) {
  const bySize = new Map();
  for (const s of table?.samples ?? []) {
    const g = groupOf(s);
    if (!g) continue;
    bySize.set(g, (bySize.get(g) ?? 0) + 1);
  }
  return [...bySize.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([name, n]) => ({ name, n }));
}

/**
 * The test for every row of a table, in the table's own order.
 *
 * Split out so a caller that redraws often — a slider drag, a window resize —
 * can compute it once and hand it back through `stats`. Same arithmetic either
 * way: contrastSvg calls this when nothing is handed in.
 */
export function contrastStats(table, { groupOf = () => null, pair = null } = {}) {
  const { samples, rows } = table ?? { samples: [], rows: [] };
  const bySize = new Map();
  (samples ?? []).forEach((s, i) => {
    const g = groupOf(s);
    if (!g) return;
    if (!bySize.has(g)) bySize.set(g, []);
    bySize.get(g).push(i);
  });
  const groups = [...bySize.entries()]
    .sort((a, b) => b[1].length - a[1].length || String(a[0]).localeCompare(String(b[0])));
  const want = pair && pair.length === 2
    ? pair.map((n) => groups.find(([g]) => g === n)).filter(Boolean) : [];
  const cand = want.length === 2 && want[0][0] !== want[1][0] ? want : groups;
  if (!(cand.length >= 2 && cand[0][1].length >= 2 && cand[1][1].length >= 2)) return null;
  const [gA, gB] = [cand[0], cand[1]];
  const ps = (rows ?? []).map((r) => mannWhitney(gA[1].map((i) => r.values[i] ?? 0),
    gB[1].map((i) => r.values[i] ?? 0)).p);
  const qs = benjaminiHochberg(ps);
  return ps.map((p, i) => ({ p, q: qs[i] }));
}

/** A label cut to fit the lane, with the full string left in a <title>. */
function trunc(s, n) {
  const t = String(s ?? "");
  return t.length <= n ? t : t.slice(0, n - 1) + "\u2026";
}

/**
 * The composition of ONE sample as a pie, with its taxa named beside it.
 *
 * The counterpart to a point on the ordination: the PCoA says a sample sits
 * apart from the others and never says what it is made of. `sample` is a name
 * or a column index; an unknown name gives "" rather than an empty figure.
 *
 * The top N are taken WITHIN this sample, not from the run-wide ranking the
 * composition bars use — the taxon that puts a sample on its own is usually one
 * that is nowhere else in the run, which is exactly where a run-wide top 10
 * would not have it.
 *
 * Drawn to the box it is given, exactly as the three figures are drawn to their
 * card: `width` and `height` are the room the panel has left once the numbers
 * under it have taken theirs. Fixed at 470 wide it left a strip of empty card
 * down one side of a 563 px panel and clipped its own legend labels to fit a
 * width it had chosen for itself. With no `height` it keeps its natural size,
 * which is what a caller with no box to fill wants.
 */
export function pieSvg(table, sample, {
  topN = 9, width = 470, height = 0, radius = 84, font = 12.5, unit = "taxa",
} = {}) {
  const c = typeof sample === "number" ? sample : table.samples.indexOf(sample);
  const name = table.samples[c];
  if (c < 0 || name === undefined) return "";

  const present = table.rows
    // `species` or `label`, for the reason compositionSvg spells out.
    .map((r) => ({ label: r.species ?? r.label ?? r.name ?? "", v: r.values[c] || 0 }))
    .filter((d) => d.v > 0)
    .sort((a, b) => b.v - a.v);
  const total = present.reduce((a, d) => a + d.v, 0);
  const title = `Composition of ${name}`;
  const head = `<text x="18" y="20" fill="#275662" font-weight="600" font-size="13">${esc(name)}</text>`;
  if (!(total > 0)) {
    // A sample can legitimately match nothing — the wrong catalogue, too few
    // reads. Saying so beats an empty disc.
    return svgOpen(width, 62, title, font) + head +
      `<text x="18" y="42" fill="#5a5550">No taxon detected in this sample.</text></svg>`;
  }

  const padT = 44;
  // The legend is what cannot be scaled — a row is a row — so it is settled
  // first, and it is settled in COLUMNS, as the composition's is.
  //
  // One column was a ceiling of about thirteen names in the panel beside the
  // plot: past that the pie stopped answering the control that asks for more
  // taxa, and a figure that ignores its own slider reads as a figure that is not
  // being redrawn at all. Rows are packed tighter and then flowed into a second
  // column before any taxon is given up; only when neither is enough does the
  // rest join "other taxa", which is the honest way to lose them.
  const COL = 190;                    // a legend column: swatch, name, share
  const rows1 = (st) => Math.max(3, Math.floor((height - padT - 10) / st));
  // How many columns the width could carry beside the smallest disc worth
  // drawing. Three is where a name has nothing left to be printed in.
  const colsFit = Math.max(1, Math.min(3, Math.floor((width - 2 * 46 - 40) / COL)));
  const want = Math.max(1, Math.min(topN, present.length));
  let step = 19, cols = 1, capacity = Infinity;
  if (height > 0) {
    // One column for as long as one column can hold it, tightening the rows
    // before adding a second: a column costs the disc a third of its radius, and
    // ten taxa in two columns beside a small disc is a worse figure than ten in
    // one beside a large one. Only then, and in the same order, a second.
    outer:
    for (let n = 1; n <= colsFit; n++) {
      for (const st of [24, 22, 20, 18, 16, 14]) {
        cols = n; step = st; capacity = n * rows1(st);
        if (capacity >= want + 1) break outer;
      }
    }
  }
  const keep = present.slice(0, Math.max(1, Math.min(want, capacity - 1)));
  const rest = present.slice(keep.length);
  const restV = rest.reduce((a, d) => a + d.v, 0);

  // TWO LISTS, and the split is the point of this figure.
  //
  // `wedges` is what the disc draws; `legend` is what is written beside it. They
  // used to be one, so the rare taxa were a single grey wedge with one name —
  // "other taxa (110)" — and a hundred and ten measurements were unreachable:
  // no share, no name, nothing to hover. They are drawn individually now, each
  // one its own wedge with its own name and share, and still grey and still
  // pooled into one legend row, which is the honest summary of a hundred and ten
  // things that will not fit in a legend.
  //
  // Alternating shades, because a hundred adjacent wedges of one colour is a
  // smooth arc that hides the very thing this change is for. Two greys a step
  // apart read as texture rather than as a second category.
  const legend = keep.map((d, i) => ({ ...d, colour: colourAt(i) }));
  const wedges = legend.slice();
  if (restV > 1e-9) {
    legend.push({
      label: `other ${unit} (${rest.length})`,
      v: restV,
      colour: GREY,
      rest: true,
    });
    rest.forEach((d, i) => wedges.push({
      ...d, colour: i % 2 ? GREY_ALT : GREY, rest: true,
    }));
  }

  // The disc takes what is left. It gives way to the legend rather than the
  // other way round: someone who has asked for thirty taxa wants to read their
  // names, and a disc of thirty slices is a colour wheel either way.
  const r = height > 0
    ? Math.max(46, Math.min(132,
      Math.min((height - padT - 18) / 2, (width - cols * COL - 40) / 2)))
    : radius;
  const cx = 18 + r, cy = padT + r;
  const h = height > 0 ? height : Math.max(cy + r + 16, padT + legend.length * 19 + 20);
  let out = svgOpen(width, h, title, font) + head +
    `<text x="18" y="36" fill="#6b7172">${present.length} ${esc(unit)} · ` +
    `top ${Math.min(keep.length, present.length)} shown</text>`;

  const at = (a) => `${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
  let a0 = -Math.PI / 2;
  for (const s of wedges) {
    const frac = s.v / total;
    const a1 = a0 + frac * 2 * Math.PI;
    const pct = frac >= 0.001 ? `${(frac * 100).toFixed(1)}%` : `${(frac * 100).toFixed(3)}%`;
    // `<title>` AND the data attributes. The title is what survives Download SVG
    // — a saved file has no page around it to run a tooltip — and the attributes
    // are what the page's own tooltip reads, which appears at once and is styled
    // like every other tooltip here instead of after the browser's second.
    const tip = `<title>${esc(s.label)} — ${pct}</title>`;
    const data = ` data-taxon="${esc(s.label)}" data-share="${pct}"` +
      (s.rest ? ` data-rest="1"` : "");
    if (frac > 0.9999) {
      // One taxon and nothing else: an arc whose two ends are the same point
      // draws nothing at all, so a 100% sample would come out blank.
      out += `<circle class="pie-slice" cx="${cx}" cy="${cy}" r="${r}" fill="${s.colour}"${data}>${tip}</circle>`;
    } else {
      // No white edge on the rare ones: at a hundred slices to the arc a 1 px
      // stroke is wider than the wedge it separates, so the pool would come out
      // white rather than grey.
      out += `<path class="pie-slice" d="M ${cx} ${cy} L ${at(a0)} A ${r} ${r} 0 ` +
        `${frac > 0.5 ? 1 : 0} 1 ${at(a1)} Z" fill="${s.colour}"` +
        (s.rest ? "" : ` stroke="#fff" stroke-width="1"`) + `${data}>${tip}</path>`;
    }
    if (frac >= 0.06) {
      const am = (a0 + a1) / 2, lr = r * 0.62;
      out += `<text x="${(cx + lr * Math.cos(am)).toFixed(1)}" ` +
        `y="${(cy + lr * Math.sin(am) + 4).toFixed(1)}" text-anchor="middle" ` +
        `fill="${inkOn(s.colour)}" font-weight="600">${pct}</text>`;
    }
    a0 = a1;
  }

  const lx0 = 2 * r + 34;
  const colW = (width - lx0 - 8) / cols;
  // Column-major: the ranking runs DOWN the first column and continues in the
  // second. Read across, as the composition's legend is, the fifth most abundant
  // taxon would sit beside the first.
  const perCol = Math.ceil(legend.length / cols);
  const swatch = Math.min(10, Math.max(6, step - 4));
  // Tight rows need type that fits between them.
  const lf = step >= 16 ? font : Math.max(9.5, step - 3);
  // Clipped to the room there is, not to a count picked once for one width: 29
  // characters at the old 470 px, where it was a flat 28, and in a panel half as
  // wide again the whole species name rather than a cut one beside empty card.
  const chars = Math.max(8, Math.floor((colW - swatch - 18 - 44) / (lf * 0.52)));
  out += `<g font-size="${lf}">`;
  legend.forEach((s, i) => {
    const col = Math.floor(i / perCol), lx = lx0 + col * colW;
    const y = padT + (i % perCol) * step;
    const clipped = s.label.length > chars ? `${s.label.slice(0, chars - 1)}…` : s.label;
    out += `<rect x="${lx}" y="${(y - swatch + 1).toFixed(1)}" width="${swatch}" ` +
      `height="${swatch}" fill="${s.colour}"/>` +
      `<text x="${lx + swatch + 6}" y="${y}" fill="#5a5550">${esc(clipped)}</text>` +
      `<text x="${(lx + colW - 10).toFixed(1)}" y="${y}" text-anchor="end" fill="#275662">` +
      `${((s.v / total) * 100).toFixed(1)}%</text>`;
  });
  return `${out}</g></svg>`;
}

// ---- enterotypes -------------------------------------------------------------
//
// WHAT THIS IS, AND WHAT IT IS NOT. Enterotypes are dense regions in a continuum
// of gut composition, not categories — "not as sharply delimited as, for
// example, human blood groups", in the words of the paper that named them. So
// this returns a SPLIT between three poles, never one word: the split is the
// finding, and a sample sitting between two of them is a real answer rather
// than a failure to decide.
//
// THE NAMES ARE THE TRAP, and it is measured. The poles were named in 2011
// taxonomy; this catalogue is GTDB, where the genera have been carved up. On the
// fifteen runs of the shipped example, aggregated to genus:
//
//   · bare `Ruminococcus` is 0.00% in EVERY sample. The signal is in
//     `Ruminococcus_E` (which holds R. bromii): 2.55% mean, 9.32% max. A rule
//     looking for "Ruminococcus" finds nothing and cannot tell that apart from a
//     sample that really has none.
//   · `Phocaeicola` carries 7.51% against `Bacteroides`' 8.94% — 46% of that
//     pole. Subject MQB_086 inverts on it: 6.59 + 4.77 = 11.36 against 8.00 of
//     Prevotella is the Bacteroides side, while `Bacteroides` alone is 6.59 and
//     reads as the Prevotella side. Both of its libraries flip together, so it
//     is the name and not the noise.
//   · `Methanobrevibacter` does not exist here at all — only
//     `Methanobrevibacter_A`.
//
// EXACT STRING EQUALITY, never startsWith and never a regex. `/^Bacteroides/`
// sweeps in `Bacteroides_F`, which is in the LACHNOSPIRACEAE — a Clostridium
// relative, not a Bacteroides — and `includes("Bacteroides")` also takes
// `Parabacteroides`, a different family again.
//
// The names GTDB has not used here yet are listed anyway: r220 moves the
// Prevotella that carry this pole (copri, and the sp-numbered genomes) to
// Segatella, Hoylesella, Leyella and Xylanibacter, while the ORAL Prevotella
// keep the name. A catalogue rebuilt on r220 would empty this pole with nothing
// on screen out of place — ERR14098633 would go from 40.19% to 0.00%.
export const ENTEROTYPE_POLES = [
  { key: "B", label: "Bacteroides", genera: ["Bacteroides", "Phocaeicola"] },
  {
    key: "P",
    label: "Prevotella",
    genera: ["Prevotella", "Prevotellamassilia",
      // Not in UHGG v2.0.2. Here so a GTDB r220 rebuild cannot silently empty
      // this pole; harmless until the day they appear.
      "Segatella", "Hoylesella", "Leyella", "Xylanibacter"],
  },
  {
    key: "R",
    label: "Ruminococcus",
    genera: ["Ruminococcus", "Ruminococcus_A", "Ruminococcus_B", "Ruminococcus_C",
      "Ruminococcus_D", "Ruminococcus_E", "Ruminococcus_F", "Ruminococcus_G",
      "Faecalibacterium"],
  },
];

// How far apart the top two shares must be before the page says a name.
//
// Measured, not chosen — and measured on a study this repository no longer
// ships, which is worth saying plainly.
//
// The threshold answers one question: how far apart must two poles be before the
// difference is more than the measurement moving? That needs the same material
// profiled twice, and the retired example had it. PRJEB83730 is the
// "metaquantibiote" contamination experiment: each donor's stool, and the same
// DNA with another donor's added, re-sequenced about six times deeper.
//
//   0.1% to 1% added (five pairs) ....... 3.3 points   — near-technical noise
//   10% added (two pairs) ............... 8.3 points   — a tenth of another gut
//
// The larger is used: it is the point at which this page can tell a donor apart
// from the same donor carrying a tenth of someone else. Below it a name would be
// a coin flipped on the reader's behalf.
//
// What the CURRENT example shows is the other half of the same caution, and it
// is biology rather than noise: eighteen samples, six people, three visits over
// eight weeks. One person's split moves by up to 39 points between visits —
// M092 leads Bacteroides, then Ruminococcus, then Bacteroides again; M060 goes
// from 3% Prevotella to 42% in eight weeks. So a name here is a statement about
// a SAMPLE and never about a person, which is what the panel prints beside it.
export const ENTEROTYPE_GAP = 8.3;

// Below this, the three poles are too small a part of the profile to be worth
// splitting: MQB_041's markers are 14.3% of it, and a "60% Ruminococcus" printed
// over a sample that is 86% something else is a statement about the 14%.
export const ENTEROTYPE_MIN_MARKERS = 5;

/**
 * How each sample divides between the three poles, at GENUS rank.
 *
 * `table` must be aggregated to genus — the caller does that, since the page
 * already has the picker for it. Rows whose genus is not one of the poles are
 * not in the split at all, and `markers` says how much of the profile that
 * leaves out.
 *
 * Returns one entry per sample: the three sums, the three shares (which add to
 * 100), which pole leads, the gap to the second, and `call` — the pole's key
 * when the gap clears ENTEROTYPE_GAP, "between" when it does not, and "" when
 * there is not enough marker abundance to divide.
 */
export function enterotypeSplit(table, { genusOf = null } = {}) {
  const gOf = genusOf ?? ((row) => String(row.species ?? "").split(" ")[0]);
  return table.samples.map((name, c) => {
    const per = new Map();          // genus -> abundance, only for pole genera
    const sums = ENTEROTYPE_POLES.map(() => 0);
    for (const row of table.rows) {
      const g = gOf(row);
      const i = ENTEROTYPE_POLES.findIndex((p) => p.genera.includes(g));
      if (i < 0) continue;
      const v = row.values[c] || 0;
      sums[i] += v;
      per.set(g, (per.get(g) ?? 0) + v);
    }
    const markers = sums.reduce((a, v) => a + v, 0);
    const shares = sums.map((v) => (markers > 0 ? (v / markers) * 100 : 0));
    const order = shares.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
    const gap = order[0].v - order[1].v;
    const enough = markers >= ENTEROTYPE_MIN_MARKERS;
    return {
      sample: name,
      sums, shares, markers,
      // Every pole genus that carried anything, so the panel can show WHICH
      // names were summed. The failures this whole block is about — Phocaeicola
      // missing, bare Ruminococcus reading zero — are invisible in a total and
      // obvious in the list.
      genera: [...per].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]),
      lead: order[0].i,
      second: order[1].i,
      // The two poles a "between" sample is between, in POLE order and never in
      // the order they happened to come out: the two libraries of MQB_032 lead
      // on different poles by 4 points, and printing "between Bacteroides and
      // Ruminococcus" for one and "between Ruminococcus and Bacteroides" for the
      // other is the same finding wearing two faces.
      pair: [order[0].i, order[1].i].sort((x, y) => x - y),
      gap,
      call: !enough ? "" : gap >= ENTEROTYPE_GAP ? ENTEROTYPE_POLES[order[0].i].key : "between",
    };
  });
}

/**
 * The ordination itself, without the drawing: computed once, drawn many times.
 */
// How far out the plot may be pulled. Below 1 the window is WIDER than the data,
// which is what moves the points out from under the legend in the corner; half
// is the floor because past it the samples are a knot in the middle of an empty
// square and the extra room has stopped buying anything.
export const PCOA_MIN_ZOOM = 0.5;

export function pcoaLayout(table) {
  return pcoa(distanceMatrix(table));
}

// ---- clusters of the plot ----------------------------------------------------
//
// k-means over the ordination's own coordinates — the ones the scatter draws,
// not the full distance space. That is a deliberate limit: a cluster computed on
// axes the reader cannot see would put two points that sit on top of each other
// into different colours, and the figure would look broken while being right.
// These are clusters OF THE PICTURE, and the picture says in its own axis labels
// what fraction of the variation it holds.
//
// No Math.random anywhere: the same table must give the same colours twice, and
// a seed that moved between redraws would read as the samples moving. Seeding is
// farthest-point: the first centre is the point nearest the middle, and each
// next one is the point furthest from every centre so far.

/** Squared distance, which is all k-means ever needs. */
const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

export function kmeans(points, k, { iters = 60 } = {}) {
  const n = points.length;
  if (!(k >= 1) || n === 0) return { labels: points.map(() => 0), centres: [], k: 0 };
  if (k >= n) return { labels: points.map((_, i) => i), centres: points.map((p) => ({ ...p })), k: n };

  const mean = points.reduce((a, p) => ({ x: a.x + p.x / n, y: a.y + p.y / n }), { x: 0, y: 0 });
  const centres = [{ ...points.reduce((best, p) => (d2(p, mean) < d2(best, mean) ? p : best), points[0]) }];
  while (centres.length < k) {
    let far = points[0], farD = -1;
    for (const p of points) {
      let nearest = Infinity;
      for (const c of centres) nearest = Math.min(nearest, d2(p, c));
      if (nearest > farD) { farD = nearest; far = p; }
    }
    centres.push({ ...far });
  }

  const labels = new Array(n).fill(0);
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const dd = d2(points[i], centres[c]);
        if (dd < bestD) { bestD = dd; best = c; }
      }
      if (labels[i] !== best) { labels[i] = best; moved = true; }
    }
    for (let c = 0; c < centres.length; c++) {
      const mine = points.filter((_, i) => labels[i] === c);
      // An empty cluster keeps its centre rather than being dropped: k is what
      // the caller asked for, and silently returning k-1 groups would make the
      // legend disagree with the control that asked for k.
      if (!mine.length) continue;
      centres[c] = {
        x: mine.reduce((a, p) => a + p.x, 0) / mine.length,
        y: mine.reduce((a, p) => a + p.y, 0) / mine.length,
      };
    }
    if (!moved && it > 0) break;
  }
  return { labels, centres, k };
}

/**
 * Mean silhouette: how much better each point fits its own cluster than the
 * next-best one. 1 is a clean split, 0 is a point on a border, below 0 is a
 * point in the wrong cluster.
 *
 * Reported rather than hidden, because k-means ALWAYS returns clusters. On
 * fifteen samples with no structure at all this score still averages about 0.3
 * and can reach 0.67, so the number is the whole difference between "there are
 * groups here" and "here is a partition".
 */
export function silhouette(points, labels) {
  const n = points.length;
  const groups = new Map();
  labels.forEach((l, i) => { if (!groups.has(l)) groups.set(l, []); groups.get(l).push(i); });
  if (groups.size < 2) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const own = groups.get(labels[i]);
    // A cluster of one has no within-distance to speak of; its silhouette is 0
    // by convention rather than 1, which would reward splitting off singletons.
    if (own.length < 2) continue;
    const a = own.reduce((s, j) => (j === i ? s : s + Math.sqrt(d2(points[i], points[j]))), 0) /
      (own.length - 1);
    let b = Infinity;
    for (const [l, idx] of groups) {
      if (l === labels[i]) continue;
      const other = idx.reduce((s, j) => s + Math.sqrt(d2(points[i], points[j])), 0) / idx.length;
      if (other < b) b = other;
    }
    total += (b - a) / Math.max(a, b);
  }
  return total / n;
}

/**
 * The k the data argues for, and every k it was compared against.
 *
 * The scores come back with the answer so the page can say what the runner-up
 * was: "6 at 0.62, 5 at 0.61" is a different message from "6 at 0.62, 5 at
 * 0.31", and only one of them is a reason to believe six.
 */
export function autoCluster(points, { maxK = 8 } = {}) {
  const top = Math.max(2, Math.min(maxK, points.length - 1));
  const scores = [];
  let best = null;
  for (let k = 2; k <= top; k++) {
    const fit = kmeans(points, k);
    const score = silhouette(points, fit.labels);
    scores.push({ k, score });
    if (!best || score > best.score) best = { ...fit, score };
  }
  return best ? { ...best, scores } : { labels: points.map(() => 0), k: 1, score: 0, scores };
}

/**
 * PCoA scatter. `groupOf` maps a sample name to a group label, or null.
 *
 * Points are labelled only when there are few enough for the labels to be
 * readable; past that the tooltip carries the name, because 85 overlapping
 * labels are worse than none.
 *
 * `layout` takes an already-computed ordination — zooming redraws this figure by
 * the frame and the eigenproblem must not be solved again for each one.
 *
 * `zoom` is {x, y, k}: the centre of the window in the ordination's own units
 * and how much of the full extent to leave out of it. The centre is clamped here
 * rather than by the caller, so the window can never leave the data behind, and
 * the window that was actually drawn is published on the root element for
 * whoever has to turn a pointer back into a coordinate.
 */
export function pcoaSvg(table, {
  width = 620, height = 520, groupOf = null, layout = null, zoom = null, legendNote = "",
} = {}) {
  const { points, explained } = layout ?? pcoa(distanceMatrix(table));
  const pad = 52;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  // 6% of the range on each side. Points landing exactly on the axis line read
  // as clipped rather than as extreme, which is the wrong impression for the two
  // samples that are furthest apart.
  const spread = (v) => {
    const lo = Math.min(...v), hi = Math.max(...v);
    if (hi - lo < 1e-12) return [lo - 1, hi + 1];
    const m = (hi - lo) * 0.06;
    return [lo - m, hi + m];
  };
  const [fx0, fx1] = spread(xs), [fy0, fy1] = spread(ys);
  const k = Math.min(24, Math.max(PCOA_MIN_ZOOM, zoom?.k ?? 1));
  // The window is a share of the full extent, kept inside it: a plot panned off
  // its own data is a blank card with axes.
  const frame = (lo, hi, c) => {
    const half = (hi - lo) / (2 * k);
    // Below k=1 the window is wider than the data, and then there is nothing to
    // clamp a centre against: the arithmetic that keeps a zoomed window inside
    // the extent inverts — hi - half < lo + half — and would pin the view to one
    // side. Wider than the data means centred on it.
    const span = (hi - lo) / 2;
    const mid = half >= span ? (lo + hi) / 2
      : Number.isFinite(c) ? Math.min(hi - half, Math.max(lo + half, c)) : (lo + hi) / 2;
    return [mid - half, mid + half];
  };
  const [x0, x1] = frame(fx0, fx1, zoom?.x), [y0, y1] = frame(fy0, fy1, zoom?.y);
  // Which samples the window holds — decided in the ordination's units, before
  // anything is turned into pixels, because what is on screen is what decides
  // whether there is room to write the names.
  const shown = points
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1);
  const label = shown.length <= 20;
  // Extra room on the right for point labels, which are drawn to the side of the
  // marker: without it the rightmost sample name is cut off by the viewBox.
  const labelPad = label ? 96 : 12;
  const sx = (x) => pad + ((x - x0) / (x1 - x0)) * (width - pad - labelPad);
  const sy = (y) => height - pad - ((y - y0) / (y1 - y0)) * (height - 2 * pad);

  const groups = [...new Set(table.samples.map((s) => (groupOf ? groupOf(s) : null) ?? "all"))];
  const colourOf = (s) => colourAt(groups.indexOf((groupOf ? groupOf(s) : null) ?? "all"));

  // The window and the box it is drawn into, published for the page: a pointer
  // has pixels and the ordination has its own units, and the page must not
  // re-derive this mapping from constants it would then hold a second copy of.
  const plot = [x0, x1, y0, y1, pad, width - labelPad, pad, height - pad].join(",");
  let out = svgOpen(width, height, "PCoA on Bray-Curtis distances", 11,
    `data-plot="${plot}" `);
  out += `<line x1="${pad}" y1="${height - pad}" x2="${width - labelPad}" y2="${height - pad}" stroke="#e6e8e8"/>` +
    `<line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" stroke="#e6e8e8"/>` +
    `<text x="${width / 2}" y="${height - 14}" text-anchor="middle" fill="#5a5550">` +
    `PCo1 — ${(explained[0] * 100).toFixed(1)}% of positive eigenvalue total</text>` +
    `<text x="14" y="${height / 2}" text-anchor="middle" fill="#5a5550" ` +
    `transform="rotate(-90 14 ${height / 2})">PCo2 — ${(explained[1] * 100).toFixed(1)}%</text>`;
  // A zoomed plot that does not say so is a lie once it is downloaded: the axis
  // fractions are of the whole ordination, and this one is a corner of it.
  if (Math.abs(k - 1) > 0.001) {
    out += `<text x="${width - 14}" y="20" text-anchor="end" fill="#5a5550">` +
      (k < 1
        // Wider than the data is a framing choice, not a window onto part of it:
        // every sample is still there, with room around them.
        ? `zoom ×${k.toFixed(1)} — wider than the samples`
        : `zoom ×${k.toFixed(1)} — ${shown.length} of ${points.length} samples`) + `</text>`;
    // A window can be dragged onto a patch of the ordination with nothing in it
    // — the points are not spread evenly over their own bounding box — and an
    // empty card with axes on it reads as something having gone wrong.
    if (!shown.length) {
      out += `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="#6b7172">` +
        `No sample in this window — drag, or Reset for all of them.</text>`;
    }
  }

  // ---- where a name can be written -------------------------------------------
  //
  // Every label was drawn to the right of its marker, whatever was already
  // there, so two samples a few pixels apart printed one name over the other and
  // the legend printed over both. It is the most visible thing on the figure and
  // it makes an otherwise honest plot look broken.
  //
  // So: four candidate positions per point — right, left, above, below — taken
  // in that order, and the first that hits nothing already written wins. A point
  // that has no free position keeps its marker, its <title> and its click; only
  // the written name goes. Nothing is invented and nothing moves: the label is
  // beside its own point or it is not drawn.
  const taken = [];
  const hits = (b) => taken.some((t) =>
    b.x < t.x + t.w && t.x < b.x + b.w && b.y < t.y + t.h && t.y < b.y + b.h);
  // The legend is drawn last but occupies its corner from the start, or the
  // first eight labels are written under it.
  if (groupOf && groups.length > 1) {
    const longest = Math.max(...groups.map((g) => String(g).length),
      legendNote ? legendNote.length * 0.62 : 0);
    taken.push({ x: pad - 6, y: 8, w: Math.ceil(longest * 6.2) + 30,
      h: groups.length * 16 + (legendNote ? 18 : 4) + 8 });
  }
  const LH = 12;                      // a line of 11 px type, with its leading
  // MEASURED, not guessed: "SRR14473840" renders 78 px wide at 11 px in the
  // page's own stack — 7.1 a character, because the run names are capitals and
  // digits rather than the lowercase an average is usually taken over. At the
  // 5.9 this started at, two labels judged clear of each other overlapped by
  // nine pixels and printed "SRR1447385ARR14473855".
  const CH = 7.1;

  shown.forEach(({ p, i }) => {
    const name = table.samples[i];
    // data-sample is what makes the point findable from the page: the plot is
    // handed over as one string, so the only way to answer "which sample is
    // this" on hover or on click is for each marker to carry its own name.
    // Inert in a downloaded SVG, where the <title> is what remains.
    // Focusable only while the plot is small enough to be labelled. Above that
    // it is a picture of a distance matrix, not a control panel, and putting
    // eighty-five tab stops between the tabs and the table would cost every
    // keyboard user more than it gives the ones who want the plot — who still
    // have every number, per sample, in the matrix below.
    out += `<circle class="pcoa-pt" data-sample="${esc(name)}" ` +
      (label ? `tabindex="0" role="button" aria-label="${esc(name)}, open its composition" ` : "") +
      `cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="5.5" ` +
      `fill="${colourOf(name)}" fill-opacity="0.85" stroke="#fff" stroke-width="1">` +
      `<title>${esc(name)}${groupOf && groupOf(name) ? ` — ${esc(groupOf(name))}` : ""}</title></circle>`;
    if (label) {
      const short = name.length > 14 ? `${name.slice(0, 13)}…` : name;
      const w = short.length * CH + 4, cx = sx(p.x), cy = sy(p.y);
      // Each candidate is a BOX (what must be free) and the anchor point the
      // text is actually drawn from — they are not the same coordinate for a
      // right-aligned or centred label, and conflating them is how a collision
      // check ends up guarding a rectangle the text is not in.
      const spots = [
        { x: cx + 8, y: cy - LH / 2, tx: cx + 8, ty: cy + 4, anchor: "start" },
        { x: cx - 8 - w, y: cy - LH / 2, tx: cx - 8, ty: cy + 4, anchor: "end" },
        { x: cx - w / 2, y: cy - 10 - LH, tx: cx, ty: cy - 11, anchor: "middle" },
        { x: cx - w / 2, y: cy + 8, ty: cy + 19, tx: cx, anchor: "middle" },
      ];
      const spot = spots.find((c) => c.x >= 2 && c.x + w <= width - 2 &&
        c.y >= 2 && c.y + LH <= height - 2 && !hits({ x: c.x, y: c.y, w, h: LH }));
      if (spot) {
        taken.push({ x: spot.x, y: spot.y, w, h: LH });
        out += `<text x="${spot.tx.toFixed(1)}" y="${spot.ty.toFixed(1)}" ` +
          `text-anchor="${spot.anchor}" fill="#5a5550">${esc(short)}</text>`;
      }
    }
  });

  if (groupOf && groups.length > 1) {
    // A panel behind it. The legend sits at a fixed corner and the points land
    // where the data puts them, so the two collide as soon as a sample is up
    // there — and a legend printed over markers is unreadable exactly when it
    // matters. Semi-opaque rather than solid: a point under it is still visible
    // as a point, so nothing is hidden, only quietened.
    const longest = Math.max(...groups.map((g) => String(g).length),
      legendNote ? legendNote.length * 0.62 : 0);
    out += `<rect x="${pad - 6}" y="8" width="${Math.ceil(longest * 6.2) + 30}" ` +
      `height="${groups.length * 16 + (legendNote ? 18 : 4) + 8}" fill="#ffffff" ` +
      `fill-opacity="0.82" rx="3"/>`;
    groups.forEach((g, gi) => {
      out += `<rect x="${pad}" y="${16 + gi * 16}" width="10" height="10" fill="${colourAt(gi)}"/>` +
        `<text x="${pad + 15}" y="${25 + gi * 16}" fill="#5a5550">${esc(g)}</text>`;
    });
    // What the colours ARE, inside the figure. A scatter coloured by something
    // the page computed, downloaded and pasted into a slide with no caption, is
    // a claim with nothing behind it — and clusters are the colouring most
    // likely to be read as a finding.
    if (legendNote) {
      out += `<text x="${pad}" y="${25 + groups.length * 16}" fill="#6b7172">${esc(legendNote)}</text>`;
    }
  }
  return out + "</svg>";
}

/**
 * The three-pole split as a triangle, one point per sample.
 *
 * A ternary plot because the quantity IS a three-way share: a point's position
 * in the triangle is the split, and the corner it sits near is the name. A
 * sample in the middle is drawn in the middle, which is the honest picture of a
 * concept whose own authors called it a continuum — where three bars with a
 * winner marked would read as a verdict.
 *
 * Markers carry `class="pcoa-pt"` and `data-sample` so the page's existing
 * hover, click and keyboard handling works on them unchanged: a point here is
 * the same kind of thing as a point on the ordination, and a second set of
 * handlers for it would be a second thing to keep in step.
 */
export function enterotypeSvg(table, {
  width = 620, height = 520, groupOf = null, genusOf = null, split = null,
} = {}) {
  const rows = split ?? enterotypeSplit(table, { genusOf });
  const padT = 44, padB = 54, padX = 64;
  // The triangle is equilateral or it is not a ternary plot: distances have to
  // mean the same thing in every direction, so the side is whatever fits BOTH
  // the width and the height, not one of them.
  const side = Math.max(120, Math.min(width - 2 * padX, (height - padT - padB) / (Math.sqrt(3) / 2)));
  const h = side * (Math.sqrt(3) / 2);
  const x0 = (width - side) / 2, y0 = padT;
  const at = (s) => {
    const [b, p, r] = s.map((v) => v / 100);
    return [x0 + side * (p + r / 2), y0 + h * (1 - r)];
  };

  let out = svgOpen(width, height, "Enterotype split — Bacteroides, Prevotella, Ruminococcus");
  // The grid is lines of constant share, so a reader can put a number on a
  // position without the panel.
  for (let f = 0.25; f < 1; f += 0.25) {
    const line = (a, b) => `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" ` +
      `x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="#eef1f1"/>`;
    const g = f * 100;
    out += line(at([100 - g, g, 0]), at([0, g, 100 - g]));       // constant P
    out += line(at([100 - g, 0, g]), at([0, 100 - g, g]));       // constant R
    out += line(at([g, 100 - g, 0]), at([g, 0, 100 - g]));       // constant B
  }
  const corners = [at([100, 0, 0]), at([0, 100, 0]), at([0, 0, 100])];
  out += `<path d="M ${corners[0][0].toFixed(1)} ${corners[0][1].toFixed(1)} ` +
    `L ${corners[1][0].toFixed(1)} ${corners[1][1].toFixed(1)} ` +
    `L ${corners[2][0].toFixed(1)} ${corners[2][1].toFixed(1)} Z" ` +
    `fill="none" stroke="#d3d9d9" stroke-width="1.2"/>`;

  // The two base labels are anchored INTO the triangle, not away from it: hung
  // off the corners they run out of the viewBox and the left one was drawn as
  // "acteroides". The top one has the whole width above it and is centred.
  ENTEROTYPE_POLES.forEach((pole, i) => {
    const [cx, cy] = corners[i];
    const anchor = i === 0 ? "start" : i === 1 ? "end" : "middle";
    const dy = i === 2 ? -12 : 18;
    out += `<text x="${cx.toFixed(1)}" y="${(cy + dy).toFixed(1)}" ` +
      `text-anchor="${anchor}" fill="#275662" font-weight="600">${esc(pole.label)}</text>`;
  });

  const groups = [...new Set(table.samples.map((s) => (groupOf ? groupOf(s) : null) ?? "all"))];
  const colourOf = (s) => colourAt(groups.indexOf((groupOf ? groupOf(s) : null) ?? "all"));
  const label = rows.length <= 20;
  for (const r of rows) {
    // No marker abundance is not a position: there is nothing to divide, and a
    // point drawn anywhere in the triangle would be a claim.
    if (!(r.markers >= ENTEROTYPE_MIN_MARKERS)) continue;
    const [cx, cy] = at(r.shares);
    out += `<circle class="pcoa-pt" data-sample="${esc(r.sample)}" ` +
      (label ? `tabindex="0" role="button" aria-label="${esc(r.sample)}, open its composition" ` : "") +
      `cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5.5" fill="${colourOf(r.sample)}" ` +
      `fill-opacity="0.85" stroke="#fff" stroke-width="1"><title>${esc(r.sample)} — ` +
      ENTEROTYPE_POLES.map((p, i) => `${p.label} ${r.shares[i].toFixed(0)}%`).join(", ") +
      `</title></circle>`;
    if (label) {
      const short = r.sample.length > 14 ? `${r.sample.slice(0, 13)}…` : r.sample;
      out += `<text x="${(cx + 8).toFixed(1)}" y="${(cy + 4).toFixed(1)}" fill="#5a5550">${esc(short)}</text>`;
    }
  }

  const quiet = rows.filter((r) => !(r.markers >= ENTEROTYPE_MIN_MARKERS)).length;
  out += `<text x="${width / 2}" y="${height - 30}" text-anchor="middle" fill="#5a5550">` +
    `Share of the three marker groups, not of the profile</text>` +
    `<text x="${width / 2}" y="${height - 14}" text-anchor="middle" fill="#6b7172">` +
    `A position in a continuum, not a category` +
    (quiet ? ` · ${quiet} sample${quiet === 1 ? "" : "s"} not drawn: under ` +
      `${ENTEROTYPE_MIN_MARKERS}% of the profile is in these groups` : "") +
    `</text>`;
  return out + "</svg>";
}

