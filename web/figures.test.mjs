// web/figures.js — the checks that came out of the October review, each one a
// way a figure could show a wrong number while looking right.
//
//   node web/figures.test.mjs
//
// The older figure checks live in fastq-trim.parity.test.mjs, beside the
// export formats they grew up with. These are the ones that need more than a
// glance at the SVG: a q on the wrong row, a distance printed as 0.0, an axis
// that is a negative eigenvalue, a legend over a point. Every one of them is
// asserted on the arithmetic or on the markup, never on a picture.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  contrastSvg, contrastStats, rowKey, sampleFacts, METRICS, compositionSvg, pieSvg,
  pcoa, pcoaSvg, pcoaLayout, distanceMatrix, eigenvaluesSym, enterotypeSvg, kmeans,
  autoCluster, silhouette,
} from "./figures.js";
import { mannWhitney, benjaminiHochberg, exactWork, EXACT_TABLE_WORK } from "./stats.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// The shipped example, as the page builds it at species rank: one row per
// genome, the genome as the row's identity.
const demo = JSON.parse(fs.readFileSync(path.join(HERE, "demo/gut-demo.session.json"), "utf8"));
const demoTable = {
  samples: demo.samples,
  rows: Object.entries(demo.matrix).map(([genome, r]) => ({
    genome, species: r.species, values: demo.samples.map((s) => Number(r[s] ?? 0)),
  })),
};
const subject = new Map(fs.readFileSync(path.join(HERE, "demo/gut-demo.groups.csv"), "utf8")
  .trim().split(/\r?\n/).slice(1).map((l) => l.split(",").map((c) => c.trim())));
const bySubject = (s) => subject.get(s) ?? null;

// ---- the contrast: a q belongs to its row ------------------------------------
//
// The figure used to take handed-in statistics BY POSITION, guarded only by
// their count. The page cached them on the number of rows, so once "group
// similar rows" reordered the table the cache handed back the same rows' stats
// in the old order: on M065 against M048, 129 of 208 rows printed another
// row's q.
console.log("== the contrast's statistics ==");
{
  const pair = ["M065", "M048"];
  const stats = contrastStats(demoTable, { groupOf: bySubject, pair });
  // The same rows, in another order: what clustering the rows does.
  const shuffled = { ...demoTable, rows: [...demoTable.rows].reverse() };
  const fresh = contrastSvg(shuffled, { groupOf: bySubject, pair, topN: 10 });
  const stale = contrastSvg(shuffled, { groupOf: bySubject, pair, topN: 10, stats });
  check("statistics computed before the rows were reordered still land on their own rows",
    fresh === stale, `${fresh.length} against ${stale.length} bytes`);
  // ...and the same with the rows the figure picks checked one by one against
  // a test run on that row alone.
  const lanes = [...stale.matchAll(/<title>(?:[^<]*)<\/title><\/text>/g)];
  const qs = [...stale.matchAll(/Mann-Whitney two-sided p = ([^ ]+) /g)].map((m) => m[1]);
  check("...and every p printed is the p of the row it is printed on",
    qs.length === 10 && qs.every(Boolean), `${qs.length} p-values, ${lanes.length} lanes`);
  const rowsDrawn = [...stale.matchAll(/text-anchor="end" fill="#275662">[^<]*<title>([^<]*)<\/title>/g)]
    .map((m) => m[1]);
  const bad = rowsDrawn.filter((label, i) => {
    const r = demoTable.rows.find((x) => x.species === label);
    if (!r) return false;
    const A = demo.samples.map((s, c) => [s, c]).filter(([s]) => bySubject(s) === "M065").map(([, c]) => r.values[c]);
    const B = demo.samples.map((s, c) => [s, c]).filter(([s]) => bySubject(s) === "M048").map(([, c]) => r.values[c]);
    const p = mannWhitney(A, B).p;
    return Math.abs(Number(qs[i]) - Number(p.toFixed(3))) > 1e-3 && !(p < 0.001);
  });
  check("...checked lane by lane against the test run on that row alone",
    rowsDrawn.length === 10 && bad.length === 0, bad.join(", "));

  // A cache built for another pair must not be used for this one.
  const other = contrastStats(demoTable, { groupOf: bySubject, pair: ["M055", "M060"] });
  check("statistics for another pair of groups are not used, whatever their length",
    contrastSvg(demoTable, { groupOf: bySubject, pair, topN: 10, stats: other }) ===
    contrastSvg(demoTable, { groupOf: bySubject, pair, topN: 10 }));
  // Stats from before this change carried no key: recomputed, not trusted.
  const keyless = stats.map(({ p, q }) => ({ p, q }));
  check("...nor statistics that cannot say which row they belong to",
    contrastSvg(shuffled, { groupOf: bySubject, pair, topN: 10, stats: keyless }) === fresh);
  check("every row's key is unique across the example, at species rank",
    new Set(demoTable.rows.map(rowKey)).size === demoTable.rows.length);
  // Above species, a row is "12 genomes" of a named taxon: the count repeats,
  // the name does not.
  const genus = [
    { genome: "12 genomes", species: "Bacteroides", values: [1] },
    { genome: "12 genomes", species: "Alistipes", values: [1] },
  ];
  check("...and above it, where the genome column is a count",
    rowKey(genus[0]) !== rowKey(genus[1]));
  check("...and a functional row is keyed on its identifier",
    rowKey({ id: "K00001", name: "x" }) !== rowKey({ id: "K00002", name: "x" }));
}

// ---- the family the correction is over --------------------------------------
console.log("== the family Benjamini-Hochberg corrects over ==");
{
  // At 3 v 3, most of the 468 species of the example are absent from all six
  // samples. Those rows have p = 1 whatever the labels, and counting them in m
  // only made every q larger.
  const s = contrastStats(demoTable, { groupOf: bySubject, pair: ["M065", "M048"] });
  const varying = demoTable.rows.filter((r) => {
    const v = demo.samples.map((x, c) => [x, c]).filter(([x]) => ["M065", "M048"].includes(bySubject(x)))
      .map(([, c]) => r.values[c]);
    return v.some((x) => x !== v[0]);
  }).length;
  check("the correction is over the rows that vary between the two groups' samples",
    s.tested === varying && varying < demoTable.rows.length && varying > 100,
    `${s.tested} tested, ${varying} vary, ${demoTable.rows.length} rows`);
  check("...rows that cannot differ keep p = 1 and get no q",
    s.filter((x) => !x.tested).every((x) => x.p === 1 && Number.isNaN(x.q)) &&
    s.filter((x) => x.tested).every((x) => Number.isFinite(x.q)));
  // Benjamini-Hochberg over exactly the tested rows, nothing else.
  const ps = s.filter((x) => x.tested).map((x) => x.p);
  const q2 = benjaminiHochberg(ps);
  check("...and their q is Benjamini-Hochberg over that family and no other",
    s.filter((x) => x.tested).every((x, i) => Math.abs(x.q - q2[i]) < 1e-15));
  // Nine against nine by sex: every row is present in some sample of the
  // eighteen, so the family is all 468 and the README's 0.058 stands.
  const sex = new Map(demo.samples.map((x) => [x, demo.sampleMeta?.[x]?.host_sex ?? null]));
  const s9 = contrastStats(demoTable, { groupOf: (x) => sex.get(x), pair: ["female", "male"] });
  const lowest = Math.min(...s9.map((x) => x.q).filter(Number.isFinite));
  check("on the example split by sex the family is still all 468, and the lowest q 0.058",
    s9.tested === 468 && Math.abs(lowest - 0.0578) < 0.0005 && s9.method === "exact",
    `${s9.tested} tested, lowest q ${lowest.toFixed(4)}, ${s9.method}`);
}

// ---- exact or not, decided for the table -------------------------------------
console.log("== which test, and saying so ==");
{
  // Forty against forty-five, sixty rows: 60 x 25 million steps is past the
  // table's budget, so the whole table takes the normal approximation — and
  // the caption has to say so, or an approximation reads as the permutation p.
  const nA = 40, nB = 45;
  const samples = Array.from({ length: nA + nB }, (_, i) => `s${i}`);
  const groupOf = (x) => (Number(x.slice(1)) < nA ? "A" : "B");
  const rows = Array.from({ length: 60 }, (_, k) => ({
    species: `r${k}`,
    values: samples.map((_, i) => ((i * 37 + k * 11) % 17) / 17 + (i < nA && k < 5 ? 0.5 : 0)),
  }));
  const big = { samples, rows };
  check("a table whose exact tests would cost more than the budget is not tested exactly",
    rows.length * exactWork(nA, nB) > EXACT_TABLE_WORK);
  const t0 = performance.now();
  const s = contrastStats(big, { groupOf });
  const ms = performance.now() - t0;
  check("...it takes the normal approximation for every row, quickly",
    s.method === "normal" && ms < 500, `${s.method} in ${ms.toFixed(0)} ms`);
  const svg = contrastSvg(big, { groupOf, stats: s, width: 900 });
  check("...and the caption and every tooltip say which test it was",
    /q: Mann-Whitney \(normal approximation\)/.test(svg) &&
    /normal approximation, tie-corrected/.test(svg) && !/exact, by permutation/.test(svg));
  const small = contrastStats({ samples: samples.slice(0, 6), rows }, { groupOf: (x) => (Number(x.slice(1)) < 3 ? "A" : "B") });
  check("...while three against three is always the exact test",
    small.method === "exact");
}

// ---- the caption fits the figure it is printed on ----------------------------
{
  const t = {
    samples: ["a1", "a2", "a3", "b1", "b2", "b3"],
    rows: [{ species: "x", values: [1, 2, 3, 0, 0, 0] }, { species: "y", values: [0, 0, 0, 0, 0, 0] }],
  };
  const groupOf = (x) => (x.startsWith("a") ? "A" : "B");
  const lines = (w) => [...contrastSvg(t, { groupOf, width: w })
    .matchAll(/<text x="0" y="(?:27|39)" fill="#6b7172">([^<]*)<\/text>/g)].map((m) => m[1]);
  const tooLong = [900, 760, 560, 420].flatMap((w) => lines(w)
    .filter((l) => l.length * 6.2 > w).map((l) => `${w}px: ${l}`));
  check("each caption line fits the width it is drawn at, from 420 to 900 px",
    tooLong.length === 0, tooLong.join(" | "));
  check("...and the floor survives every shortening",
    [900, 760, 560, 420].every((w) => lines(w).some((l) => /0\.1/.test(l) && /0\.05/.test(l))),
    [900, 760, 560, 420].map((w) => lines(w).join(" / ")).join(" || "));
}

// ---- the neighbours' distances, in the table's own unit -----------------------
//
// Euclidean distance is in the unit of the table. The functional tables hold
// fractions summing to 1, and the panel printed their distances — 0.0086 to
// 0.011 on the example — with one decimal, against a ceiling of sqrt(2) x 100
// meant for percentages: "0.0" beside a bar 99.99 % full, for every sample.
console.log("== the neighbour list ==");
{
  const { koTable } = await import("./kegg.js");
  const map = JSON.parse(fs.readFileSync(path.join(HERE, "db/kegg/ko-map.json"), "utf8"));
  const ko = koTable(demo.funcProfiles, demo.samples, map);
  const f = sampleFacts(ko, "SRR14473825", { metric: "euclid" });
  const top = Math.max(...demo.samples.map((_, j) => ko.rows.reduce((a, r) => a + (r.values[j] || 0), 0)));
  check("the Euclidean ceiling is the table's own: sqrt(2) times a column total",
    Math.abs(f.max - Math.SQRT2 * top) < 1e-12 && f.max < 2, `${f.max} for column totals of ${top}`);
  check("...so the distances print as numbers, not as 0.0",
    f.nearest.every((n) => n.text !== "0.0" && Number(n.text) > 0 && /^\d\.\d+$/.test(n.text)),
    f.nearest.map((n) => n.text).join(" "));
  check("...with three significant digits",
    f.nearest.every((n) => n.text.replace(/^0\.0*/, "").length === 3),
    f.nearest.map((n) => n.text).join(" "));
  check("...and the closeness they draw is neither full nor empty",
    f.nearest.every((n) => n.closeness > 0 && n.closeness < 1), f.nearest.map((n) => n.closeness).join(" "));
  // The distance itself, against a computation that shares nothing with it.
  const c = demo.samples.indexOf("SRR14473825"), j = demo.samples.indexOf(f.nearest[0].sample);
  const byHand = Math.sqrt(ko.rows.reduce((a, r) => a + ((r.values[c] || 0) - (r.values[j] || 0)) ** 2, 0));
  check("...and is the Euclidean distance computed directly",
    Math.abs(byHand - f.nearest[0].distance) < 1e-15, `${byHand} against ${f.nearest[0].distance}`);
  // Bray-Curtis is bounded by 1 in any unit, and prints as it always did.
  const b = sampleFacts(demoTable, "SRR14473825");
  check("Bray-Curtis keeps a ceiling of 1 and its three decimals",
    b.max === 1 && b.nearest.every((n) => n.text === n.distance.toFixed(3)),
    b.nearest.map((n) => `${n.text}/${n.distance.toFixed(3)}`).join(" "));
}

// ---- nothing detected is not "other" ------------------------------------------
console.log("== composition ==");
{
  const t = {
    samples: ["full", "empty"],
    rows: [{ species: "a", values: [60, 0] }, { species: "b", values: [40, 0] }],
  };
  const svg = compositionSvg(t, { topN: 1 });
  const emptyRow = svg.slice(svg.indexOf('data-sample="empty"'));
  check("a sample with nothing detected is drawn as nothing detected",
    /nothing detected/.test(emptyRow) && !/other taxa — 100\.0%/.test(svg),
    (svg.match(/<title>[^<]*<\/title>/g) ?? []).join(" "));
  check("...while a sample with something keeps its bar and its remainder",
    /a — 60\.0%/.test(svg) && /other taxa — 40\.0%/.test(svg));
}

// ---- a share is said to be a share of what it is a share of -------------------
{
  const { GMM_SHARE } = await import("./figures.js");
  const t = { samples: ["S"], rows: [{ label: "MF0001 — x", values: [0.002] }, { label: "MF0002 — y", values: [0.006] }] };
  const bars = compositionSvg(t, { share: GMM_SHARE, otherLabel: "other modules" });
  check("GMM bars say what their percentages are of, and that the values are not shares",
    bars.includes(`75.0% ${GMM_SHARE.of}`) && bars.includes(GMM_SHARE.note));
  const pie = pieSvg(t, "S", { share: GMM_SHARE, unit: "modules" });
  check("...and so does the pie, in its subtitle and on every wedge",
    pie.includes(GMM_SHARE.short) && /data-share-of="of the sum of this sample&#39;s module values"|data-share-of="of the sum of this sample's module values"/.test(pie));
  const plain = pieSvg({ samples: ["S"], rows: [{ species: "x", values: [1] }] }, "S");
  check("...while a taxonomic pie is a share of the sample, as before",
    /data-share-of="of this sample"/.test(plain) && !plain.includes(GMM_SHARE.short));
}

// ---- the ordination's axes -----------------------------------------------------
console.log("== the ordination ==");
{
  // Four points whose distances are not Euclidean: the centred matrix has
  // eigenvalues 0.5346, 0.0426, 0 and -0.1219 (numpy.linalg.eigvalsh). The
  // second axis is the SECOND POSITIVE one, 7.38 % of the positive total; power
  // iteration took the negative one, larger in magnitude, and printed 21.1 %.
  const M = [[0, 0.408, 0.208, 0.826], [0.408, 0, 0.254, 0.084],
    [0.208, 0.254, 0, 0.926], [0.826, 0.084, 0.926, 0]];
  const p = pcoa(M);
  check("a negative eigenvalue is never taken as an axis",
    Math.abs(p.explained[0] - 0.92621908) < 1e-6 && Math.abs(p.explained[1] - 0.07378092) < 1e-6,
    p.explained.map((x) => (x * 100).toFixed(2)).join(" / "));

  // Ten points in a plane, the second principal direction aligned with the
  // fixed vector the iteration started from. Power iteration found that one
  // first and printed PCo1 49.24 %, PCo2 50.76 %: the axes in the wrong order.
  const P = [[-0.412985, 0.408382], [-0.376957, 0.078967], [-0.353926, -0.306086],
    [-0.261199, -0.392761], [-0.080164, -0.10137], [0.126603, 0.300185], [0.272868, 0.442715],
    [0.32802, 0.195179], [0.34522, -0.21484], [0.41252, -0.410371]];
  const Dp = P.map((a) => P.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1])));
  const q = pcoa(Dp);
  check("the axes come out largest first",
    q.explained[0] >= q.explained[1] && Math.abs(q.explained[0] + q.explained[1] - 1) < 1e-9,
    q.explained.map((x) => (x * 100).toFixed(2)).join(" / "));
  // ...and they are eigenpairs: a point's coordinate on PCo1 times the square
  // root of its eigenvalue reproduces the centred matrix along that axis. The
  // independent check is the distances: a configuration that is exactly planar
  // must come back with every distance intact.
  const worst = Math.max(...P.flatMap((_, i) => P.map((__, j) =>
    Math.abs(Math.hypot(q.points[i].x - q.points[j].x, q.points[i].y - q.points[j].y) - Dp[i][j]))));
  check("...and a planar configuration comes back with every distance intact",
    worst < 1e-9, worst.toExponential(2));

  // The shipped example: the numbers the README quotes.
  const L = pcoaLayout(demoTable);
  check("the example's axes still carry 25.8 % and 22.9 %",
    (L.explained[0] * 100).toFixed(1) === "25.8" && (L.explained[1] * 100).toFixed(1) === "22.9",
    L.explained.map((x) => (x * 100).toFixed(2)).join(" / "));
  check("...and the full spectrum it is a fraction of is the same one eigenvaluesSym finds",
    (() => {
      const D = distanceMatrix(demoTable), n = D.length;
      const A = D.map((r) => r.map((v) => -0.5 * v * v));
      const rm = A.map((r) => r.reduce((a, v) => a + v, 0) / n), g = rm.reduce((a, v) => a + v, 0) / n;
      const G = A.map((r, i) => r.map((v, j) => v - rm[i] - rm[j] + g));
      const ev = eigenvaluesSym(G), pos = ev.filter((x) => x > 0).reduce((a, x) => a + x, 0);
      return Math.abs(ev[0] / pos - L.explained[0]) < 1e-9 && Math.abs(ev[1] / pos - L.explained[1]) < 1e-9;
    })());
}

// ---- the legend is not drawn over a point -----------------------------------------
{
  const svg = pcoaSvg(demoTable, { groupOf: bySubject, width: 760, height: 480 });
  const [, , , , L, R, T, B] = /data-plot="([^"]+)"/.exec(svg)[1].split(",").map(Number);
  const cys = [...svg.matchAll(/<circle class="pcoa-pt"[^>]* cy="([\d.]+)"/g)].map((m) => Number(m[1]));
  const legendYs = [...svg.matchAll(/<rect x="[\d.]+" y="([\d.]+)" width="10" height="10"/g)].map((m) => Number(m[1]));
  check("the ordination's legend sits above the plot, and every point below it",
    legendYs.length === 6 && Math.max(...legendYs) + 10 < T && cys.length === 18 && Math.min(...cys) >= T - 6,
    `legend to y=${Math.max(...legendYs) + 10}, plot from y=${T}, highest point at ${Math.min(...cys)}`);
  check("...and SRR14473842, which the legend used to cover, is clear of it",
    (() => {
      const cy = Number(/data-sample="SRR14473842" [^>]*cy="([\d.]+)"/.exec(svg)?.[1]);
      return cy > Math.max(...legendYs) + 16;
    })());
  check("...with the published plot box below the legend",
    T > 26 && B > T && R > L);
}

// ---- names do not print over each other ---------------------------------------------
{
  // The demo at genus rank, which is what the enterotype is drawn from.
  const lineage = JSON.parse(fs.readFileSync(path.join(HERE, "db/lineage/human-gut.json"), "utf8"));
  const GEN = lineage.ranks.g, gi = lineage.rankKeys.indexOf("g");
  const genusOf = new Map(Object.entries(lineage.taxa).map(([g, t]) => [g, GEN[t[gi]]]));
  const by = new Map();
  for (const r of demoTable.rows) {
    const name = genusOf.get(r.genome) ?? "unclassified";
    const e = by.get(name) ?? { species: name, values: demo.samples.map(() => 0) };
    r.values.forEach((v, i) => { e.values[i] += v; });
    by.set(name, e);
  }
  const genusTable = { samples: demo.samples, rows: [...by.values()] };
  const svg = enterotypeSvg(genusTable, { width: 760, height: 520, groupOf: bySubject });
  const boxes = [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)" text-anchor="(start|end|middle)" fill="#5a5550">(SRR[^<]*)<\/text>/g)]
    .map(([, x, y, anchor, t]) => {
      const w = t.length * 7.1 + 4, X = Number(x);
      const left = anchor === "start" ? X : anchor === "end" ? X - w : X - w / 2;
      return { t, x: left, y: Number(y) - 10, w, h: 12 };
    });
  const clash = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) clash.push(`${a.t}/${b.t}`);
  }
  check("the enterotype's sample names do not print over one another",
    boxes.length > 0 && clash.length === 0, `${boxes.length} names, overlaps: ${clash.join(", ")}`);
  check("...and every point is still drawn, named or not",
    (svg.match(/class="pcoa-pt"/g) ?? []).length === 18);
}

// ---- k-means says how many clusters it found ----------------------------------------
console.log("== clusters ==");
{
  // Three points on one spot and three on another: whatever k is asked for,
  // there are two clusters, and the figure must not print "k=4" over two colours.
  const pts = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0 }];
  const f = kmeans(pts, 4);
  check("k-means reports the clusters that hold a point, not the k it was asked for",
    f.k === 2 && f.asked === 4 && new Set(f.labels).size === 2 && f.labels.every((l) => l === 0 || l === 1),
    JSON.stringify({ k: f.k, asked: f.asked, labels: f.labels }));
  const g = kmeans([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 5, y: 5 }], 2);
  check("...and when every cluster holds a point the two agree",
    g.k === 2 && g.asked === 2);
  check("autoCluster's answer carries the same count",
    autoCluster(pts).k === new Set(autoCluster(pts).labels).size);
  check("silhouette is undisturbed by the renumbering",
    Math.abs(silhouette(pts, f.labels) - 1) < 1e-12, String(silhouette(pts, f.labels)));
}

console.log(`\n${pass} passed, ${fail} failed (figures)`);
process.exit(fail ? 1 : 0);
