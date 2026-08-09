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

  const vecs = [], vals = [];
  for (let d = 0; d < dims; d++) {
    // A fixed start, not a random one: the same matrix must give the same plot
    // twice, and a sign flip between redraws reads as the points moving.
    let v = Float64Array.from({ length: n }, (_, i) => Math.sin(i + 1 + d));
    let lambda = 0;
    for (let it = 0; it < iters; it++) {
      let w = mul(v);
      // Deflate against the axes already taken, so this one is orthogonal.
      for (let k = 0; k < vecs.length; k++) {
        let dot = 0;
        for (let i = 0; i < n; i++) dot += w[i] * vecs[k][i];
        for (let i = 0; i < n; i++) w[i] -= dot * vecs[k][i];
      }
      let norm = Math.hypot(...w);
      if (!(norm > 1e-12)) { w = new Float64Array(n); norm = 0; break; }
      for (let i = 0; i < n; i++) w[i] /= norm;
      lambda = norm;
      v = w;
    }
    vecs.push(v);
    vals.push(lambda);
  }

  // Only positive eigenvalues carry variance that a plane can show; Bray-Curtis
  // routinely produces negative ones and calling their total "100%" would be a
  // lie in the axis label.
  const posTotal = vals.filter((x) => x > 0).reduce((a, x) => a + x, 0) || 1;
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

const svgOpen = (w, h, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" ` +
  `font-family="ui-sans-serif, system-ui, sans-serif" font-size="11" role="img" ` +
  `aria-label="${esc(title)}"><rect width="${w}" height="${h}" fill="#ffffff"/>`;

/**
 * Stacked composition bars, one per sample, top N taxa plus "other".
 *
 * "Other" is drawn in grey and is never dropped: with 600 taxa the top 10 rarely
 * reach 100%, and a bar that stops at 60% with no explanation reads as missing
 * data rather than as a legend cut.
 */
export function compositionSvg(table, { topN = 10, width = 900, barH = 26 } = {}) {
  const { samples, rows } = table;
  const totals = rows.map((r, i) => ({ i, sum: r.values.reduce((a, v) => a + v, 0) }));
  totals.sort((a, b) => b.sum - a.sum);
  const keep = totals.slice(0, topN).map((t) => t.i);
  const keepSet = new Set(keep);

  const padL = 150, padT = 16, padR = 12, gap = 5;
  const legendH = 18 * Math.ceil((keep.length + 1) / 3) + 14;
  const plotW = width - padL - padR;
  const height = padT + samples.length * (barH + gap) + legendH + 10;
  let out = svgOpen(width, height, "Composition per sample");

  samples.forEach((name, c) => {
    const y = padT + c * (barH + gap);
    const total = rows.reduce((a, r) => a + (r.values[c] || 0), 0) || 1;
    let x = padL;
    out += `<text x="${padL - 8}" y="${y + barH / 2 + 4}" text-anchor="end" fill="#275662">${esc(name)}</text>`;
    keep.forEach((ri, k) => {
      const frac = (rows[ri].values[c] || 0) / total;
      const w = frac * plotW;
      if (w > 0.2) {
        out += `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${barH}" ` +
          `fill="${PALETTE[k % PALETTE.length]}"><title>${esc(rows[ri].species)} — ${(frac * 100).toFixed(1)}%</title></rect>`;
      }
      x += w;
    });
    const rest = padL + plotW - x;
    if (rest > 0.2) {
      const restFrac = rest / plotW;
      out += `<rect x="${x.toFixed(1)}" y="${y}" width="${rest.toFixed(1)}" height="${barH}" ` +
        `fill="${GREY}"><title>other taxa — ${(restFrac * 100).toFixed(1)}%</title></rect>`;
    }
  });

  let ly = padT + samples.length * (barH + gap) + 12;
  [...keep.map((ri, k) => [rows[ri].species, PALETTE[k % PALETTE.length]]), ["other taxa", GREY]]
    .forEach(([label, colour], k) => {
      const col = k % 3, row = Math.floor(k / 3);
      const lx = padL + col * (plotW / 3);
      out += `<rect x="${lx}" y="${ly + row * 18}" width="10" height="10" fill="${colour}"/>` +
        `<text x="${lx + 15}" y="${ly + row * 18 + 9}" fill="#5a5550">${esc(String(label).slice(0, 34))}</text>`;
    });
  return out + "</svg>";
}

/** Shannon (as effective taxa) and observed richness, one row per sample. */
export function alphaSvg(table, { width = 760, rowH = 22 } = {}) {
  const a = alphaDiversity(table);
  const padL = 150, padT = 30, padR = 60;
  const plotW = width - padL - padR;
  const height = padT + a.length * rowH + 34;
  const maxEff = Math.max(1, ...a.map((d) => d.effective));
  let out = svgOpen(width, height, "Alpha diversity per sample");
  out += `<text x="${padL}" y="16" fill="#275662" font-weight="600">Effective number of taxa (e^Shannon)</text>`;
  a.forEach((d, i) => {
    const y = padT + i * rowH;
    const w = (d.effective / maxEff) * plotW;
    out += `<text x="${padL - 8}" y="${y + 12}" text-anchor="end" fill="#275662">${esc(d.sample)}</text>` +
      `<rect x="${padL}" y="${y + 3}" width="${w.toFixed(1)}" height="13" fill="#00a3a6">` +
      `<title>${esc(d.sample)}: ${d.effective.toFixed(1)} effective taxa, ` +
      `Shannon ${d.shannon.toFixed(2)}, ${d.richness} observed</title></rect>` +
      `<text x="${padL + w + 6}" y="${y + 14}" fill="#5a5550">${d.effective.toFixed(1)} ` +
      `<tspan fill="#969c9d">(${d.richness} obs.)</tspan></text>`;
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
    out += `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="5.5" ` +
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
