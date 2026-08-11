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
const INK = "#1f2426";

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
 * Shannon index and observed richness, per sample.
 *
 * Shannon is computed on the abundances RENORMALISED to sum to 1 within each
 * sample. sylph's taxonomic abundances already sum to ~100 per sample, but only
 * over what it detected — renormalising makes that explicit instead of letting a
 * sample that sums to 97.3 score differently for that reason alone.
 */
export function alphaDiversity(table) {
  return table.samples.map((name, c) => {
    const vals = table.rows.map((r) => r.values[c] || 0).filter((v) => v > 0);
    const total = vals.reduce((a, v) => a + v, 0);
    let shannon = 0;
    if (total > 0) {
      for (const v of vals) {
        const p = v / total;
        shannon -= p * Math.log(p);
      }
    }
    return {
      sample: name,
      richness: vals.length,
      shannon,
      // e^H — "how many equally-abundant taxa would give this diversity". Far
      // easier to read than nats, and the unit people actually compare.
      effective: vals.length ? Math.exp(shannon) : 0,
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

// ---- drawing -----------------------------------------------------------------

// `font` is the whole figure's type size. It is a parameter because the pie is
// drawn into a side panel — on a phone, into about 300 px of one — and an SVG
// scaled to a third of its width takes its text down with it.
const svgOpen = (w, h, title, font = 11) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" ` +
  `font-family="ui-sans-serif, system-ui, sans-serif" font-size="${font}" role="img" ` +
  `aria-label="${esc(title)}"><rect width="${w}" height="${h}" fill="#ffffff"/>`;

/**
 * Stacked composition bars, one per sample, top N taxa plus "other".
 *
 * "Other" is drawn in grey and is never dropped: with 600 taxa the top 10 rarely
 * reach 100%, and a bar that stops at 60% with no explanation reads as missing
 * data rather than as a legend cut.
 */
export function compositionSvg(table, { topN = 10, width = 900, barH = 0, height = 0 } = {}) {
  const { samples, rows } = table;
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
          `fill="${PALETTE[k % PALETTE.length]}"><title>${esc(rows[ri].species)} — ${(frac * 100).toFixed(1)}%</title></rect>`;
      }
      x += w;
    });
    const rest = padL + plotW - x;
    if (rest > 0.2) {
      const restFrac = rest / plotW;
      out += `<rect x="${x.toFixed(1)}" y="${y}" width="${rest.toFixed(1)}" height="${bar}" ` +
        `fill="${GREY}"><title>other taxa — ${(restFrac * 100).toFixed(1)}%</title></rect>`;
    }
    out += "</g>";
  });

  let ly = padT + samples.length * (bar + gap) + 12;
  [...keep.map((ri, k) => [rows[ri].species, PALETTE[k % PALETTE.length]]), ["other taxa", GREY]]
    .forEach(([label, colour], k) => {
      const col = k % legendCols, row = Math.floor(k / legendCols);
      const colW = plotW / legendCols;
      const lx = padL + col * colW;
      // Clipped to what the column can hold, at roughly 5.6 px per character.
      const room = Math.max(8, Math.floor((colW - 20) / 5.6));
      const text = String(label).length > room
        ? `${String(label).slice(0, room - 1)}…` : String(label);
      out += `<rect x="${lx}" y="${ly + row * 18}" width="10" height="10" fill="${colour}"/>` +
        `<text x="${lx + 15}" y="${ly + row * 18 + 9}" fill="#5a5550">${esc(text)}</text>`;
    });
  return out + "</svg>";
}

/** Shannon (as effective taxa) and observed richness, one row per sample. */
export function alphaSvg(table, { width = 760, rowH = 0, height = 0 } = {}) {
  const a = alphaDiversity(table);
  // padR holds the value written past the end of the longest bar. Measured from
  // the longest label there actually is, at ~6.4 px a character: fixed at 60 it
  // was cut off mid-number the moment the figure stopped being 760 px wide, and
  // any fixed number is the same bug waiting for a longer number.
  const longest = Math.max(8, ...a.map((d) =>
    `${d.effective.toFixed(1)} (${d.richness} obs.)`.length));
  const padL = 150, padT = 30, padR = Math.ceil(longest * 6.4) + 12;
  const plotW = width - padL - padR;
  // Same as the composition: the rows fill the height the page has for them.
  const row = rowH || (height
    ? Math.max(14, Math.min(40, (height - padT - 34) / a.length))
    : 22);
  const h = padT + a.length * row + 34;
  const maxEff = Math.max(1, ...a.map((d) => d.effective));
  let out = svgOpen(width, h, "Alpha diversity per sample");
  out += `<text x="${padL}" y="16" fill="#275662" font-weight="600">Effective number of taxa (e^Shannon)</text>`;
  a.forEach((d, i) => {
    const y = padT + i * row;
    const w = (d.effective / maxEff) * plotW;
    out += `<g class="sample-row" data-sample="${esc(d.sample)}">` +
      `<rect class="row-hit" x="0" y="${y}" width="${width}" height="${row - 2}" ` +
      `fill="#275662" fill-opacity="0"/>` +
      `<text x="${padL - 8}" y="${(y + row / 2 + 4).toFixed(1)}" text-anchor="end" fill="#275662">${esc(d.sample)}</text>` +
      `<rect x="${padL}" y="${(y + row / 2 - 6.5).toFixed(1)}" width="${w.toFixed(1)}" ` +
      `height="13" fill="#00a3a6">` +
      `<title>${esc(d.sample)}: ${d.effective.toFixed(1)} effective taxa, ` +
      `Shannon ${d.shannon.toFixed(2)}, ${d.richness} observed</title></rect>` +
      `<text x="${padL + w + 6}" y="${(y + row / 2 + 4).toFixed(1)}" fill="#5a5550">${d.effective.toFixed(1)} ` +
      `<tspan fill="#6b7172">(${d.richness} obs.)</tspan></text></g>`;
  });
  return out + "</svg>";
}

/**
 * PCoA scatter. `groupOf` maps a sample name to a group label, or null.
 *
 * Points are labelled only when there are few enough for the labels to be
 * readable; past that the tooltip carries the name, because 85 overlapping
 * labels are worse than none.
 */
export function pcoaSvg(table, { width = 620, height = 520, groupOf = null } = {}) {
  const { points, explained } = pcoa(distanceMatrix(table));
  const pad = 52;
  // Extra room on the right for point labels, which are drawn to the side of the
  // marker: without it the rightmost sample name is cut off by the viewBox.
  const labelPad = table.samples.length <= 20 ? 96 : 12;
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
  const [x0, x1] = spread(xs), [y0, y1] = spread(ys);
  const sx = (x) => pad + ((x - x0) / (x1 - x0)) * (width - pad - labelPad);
  const sy = (y) => height - pad - ((y - y0) / (y1 - y0)) * (height - 2 * pad);

  const groups = [...new Set(table.samples.map((s) => (groupOf ? groupOf(s) : null) ?? "all"))];
  const colourOf = (s) => PALETTE[groups.indexOf((groupOf ? groupOf(s) : null) ?? "all") % PALETTE.length];

  let out = svgOpen(width, height, "PCoA on Bray-Curtis distances");
  out += `<line x1="${pad}" y1="${height - pad}" x2="${width - labelPad}" y2="${height - pad}" stroke="#e6e8e8"/>` +
    `<line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" stroke="#e6e8e8"/>` +
    `<text x="${width / 2}" y="${height - 14}" text-anchor="middle" fill="#5a5550">` +
    `PCo1 — ${(explained[0] * 100).toFixed(1)}% of positive eigenvalue total</text>` +
    `<text x="14" y="${height / 2}" text-anchor="middle" fill="#5a5550" ` +
    `transform="rotate(-90 14 ${height / 2})">PCo2 — ${(explained[1] * 100).toFixed(1)}%</text>`;

  const label = table.samples.length <= 20;
  points.forEach((p, i) => {
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
      out += `<text x="${(sx(p.x) + 8).toFixed(1)}" y="${(sy(p.y) + 4).toFixed(1)}" fill="#5a5550">${esc(short)}</text>`;
    }
  });

  if (groupOf && groups.length > 1) {
    groups.forEach((g, k) => {
      out += `<rect x="${pad}" y="${16 + k * 16}" width="10" height="10" fill="${PALETTE[k % PALETTE.length]}"/>` +
        `<text x="${pad + 15}" y="${25 + k * 16}" fill="#5a5550">${esc(g)}</text>`;
    });
  }
  return out + "</svg>";
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
 * Narrower than the other figures on purpose: it is drawn into the panel beside
 * the ordination, and anything wider is scaled down to fit — which shrinks the
 * legend along with it.
 */
export function pieSvg(table, sample, { topN = 9, width = 470, radius = 84, font = 12.5 } = {}) {
  const c = typeof sample === "number" ? sample : table.samples.indexOf(sample);
  const name = table.samples[c];
  if (c < 0 || name === undefined) return "";

  const present = table.rows
    .map((r) => ({ label: r.species, v: r.values[c] || 0 }))
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

  const keep = present.slice(0, topN);
  const restV = total - keep.reduce((a, d) => a + d.v, 0);
  const slices = keep.map((d, i) => ({ ...d, colour: PALETTE[i % PALETTE.length] }));
  if (restV > 1e-9) {
    slices.push({
      label: `other taxa (${present.length - keep.length})`,
      v: restV,
      colour: GREY,
    });
  }

  const padT = 44, cx = 18 + radius, cy = padT + radius;
  const height = Math.max(cy + radius + 16, padT + slices.length * 19 + 20);
  let out = svgOpen(width, height, title, font) + head +
    `<text x="18" y="36" fill="#6b7172">${present.length} taxa · ` +
    `top ${Math.min(topN, present.length)} shown</text>`;

  const at = (a) => `${(cx + radius * Math.cos(a)).toFixed(1)} ${(cy + radius * Math.sin(a)).toFixed(1)}`;
  let a0 = -Math.PI / 2;
  for (const s of slices) {
    const frac = s.v / total;
    const a1 = a0 + frac * 2 * Math.PI;
    const pct = `${(frac * 100).toFixed(1)}%`;
    const tip = `<title>${esc(s.label)} — ${pct}</title>`;
    if (frac > 0.9999) {
      // One taxon and nothing else: an arc whose two ends are the same point
      // draws nothing at all, so a 100% sample would come out blank.
      out += `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${s.colour}">${tip}</circle>`;
    } else {
      out += `<path d="M ${cx} ${cy} L ${at(a0)} A ${radius} ${radius} 0 ` +
        `${frac > 0.5 ? 1 : 0} 1 ${at(a1)} Z" fill="${s.colour}" stroke="#fff" ` +
        `stroke-width="1">${tip}</path>`;
    }
    if (frac >= 0.06) {
      const am = (a0 + a1) / 2, lr = radius * 0.62;
      out += `<text x="${(cx + lr * Math.cos(am)).toFixed(1)}" ` +
        `y="${(cy + lr * Math.sin(am) + 4).toFixed(1)}" text-anchor="middle" ` +
        `fill="${inkOn(s.colour)}" font-weight="600">${pct}</text>`;
    }
    a0 = a1;
  }

  const lx = 2 * radius + 34;
  slices.forEach((s, k) => {
    const y = padT + k * 19;
    const clipped = s.label.length > 28 ? `${s.label.slice(0, 27)}…` : s.label;
    out += `<rect x="${lx}" y="${y - 9}" width="10" height="10" fill="${s.colour}"/>` +
      `<text x="${lx + 16}" y="${y}" fill="#5a5550">${esc(clipped)}</text>` +
      `<text x="${width - 14}" y="${y}" text-anchor="end" fill="#275662">` +
      `${((s.v / total) * 100).toFixed(1)}%</text>`;
  });
  return out + "</svg>";
}
