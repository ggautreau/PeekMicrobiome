// The contrast test at the level the samples were actually drawn at.
//
//     node scripts/depth-bench/pseudoreplication.mjs
//
// §2.6 describes the contrast plot's floor as 2/48,620 when a run is split nine
// against nine, and adds that on the eighteen runs of §4 those nine are three
// donors with three stool samples each. Both halves of that sentence are in the
// paper; the arithmetic behind the second half is not. So the number the page
// prints (nine against nine) and the number the design supports (three donors
// against three) are computed here side by side, on the shipped session, and
// the difference between them is what the pseudoreplication was worth.
//
// The test is NOT reimplemented. web/stats.js and web/groups.js are imported —
// the same modules figures.js loads — because a second implementation that
// disagreed with the page would measure the wrong thing, and one that agreed
// would only prove it had been copied correctly.
//
// WHAT WOULD MAKE THIS WRONG
//
//   · the donor assignment. It is read from the archive's own `sample_alias`
//     ("A.M065_1" -> M065) and then cross-checked against the demo's grouping
//     CSV; if the two disagree the script stops rather than reporting a split
//     it invented. Everything below is a statement about six donors, and a
//     wrong donor map would make it a statement about nothing.
//   · the aggregation. Averaging a donor's three profiles is one choice among
//     several (median, or one sample picked at random per donor); it is the one
//     that uses all the data and keeps the columns summing to what they summed
//     to, and the p-values at 3 v 3 are so floor-bound that no aggregation rule
//     could change the conclusion. That last part is asserted below rather than
//     assumed: the floor is printed, not taken on trust.
//   · treating a missing cell as zero. That is what the page does
//     (`r.values[i] ?? 0` in figures.js), and doing anything else here would be
//     testing a different table from the one on screen.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "../..");
const SESSION = path.join(REPO, "web/demo/gut-demo.session.json");
const GROUPS_CSV = path.join(REPO, "web/demo/gut-demo.groups.csv");

const { mannWhitney, benjaminiHochberg, minAttainableP } =
  await import(path.join(REPO, "web/stats.js"));
const { groupsFromField, parseMetadata } =
  await import(path.join(REPO, "web/groups.js"));

const st = JSON.parse(fs.readFileSync(SESSION, "utf8"));
const samples = st.samples;
const rows = Object.values(st.matrix);          // 468 species, the whole family
const metaOf = (s) => st.sampleMeta?.[s] ?? {};

// ---- who is who --------------------------------------------------------------

// The sex split exactly as the page makes it: a field of the archive metadata,
// through the page's own picker code.
const bySex = groupsFromField(samples, metaOf, "host_sex");
const female = samples.filter((s) => bySex.get(s) === "female");
const male = samples.filter((s) => bySex.get(s) === "male");

// The donor, from the alias the study wrote: "A.M065_1" is subject M065's first
// stool sample. Anchored at the end so a subject id containing an underscore
// would still lose only the replicate number.
const donorOf = (s) => {
  const alias = String(metaOf(s).sample_alias ?? "");
  const m = /^(?:[A-Z]\.)?(.+?)_(\d+)$/.exec(alias);
  return m ? m[1] : null;
};

// The cross-check. The demo ships a sample,subject CSV; it is not what the page
// reads for this figure, which makes it an independent witness to the same fact.
const declared = parseMetadata(fs.readFileSync(GROUPS_CSV, "utf8"));
for (const s of samples) {
  const mine = donorOf(s), theirs = declared.get(s);
  if (!mine) throw new Error(`no donor in the alias of ${s}`);
  if (theirs && theirs !== mine) {
    throw new Error(`donor disagreement for ${s}: alias says ${mine}, CSV says ${theirs}`);
  }
}

const donors = [...new Set(samples.map(donorOf))];
const donorSex = new Map(donors.map((d) => {
  const of = samples.filter((s) => donorOf(s) === d);
  const sexes = new Set(of.map((s) => metaOf(s).host_sex));
  if (sexes.size !== 1) throw new Error(`donor ${d} has more than one host_sex`);
  return [d, [...sexes][0]];
}));
const femaleDonors = donors.filter((d) => donorSex.get(d) === "female");
const maleDonors = donors.filter((d) => donorSex.get(d) === "male");

console.log(`${samples.length} samples, ${rows.length} species rows, ${donors.length} donors`);
for (const d of donors) {
  const of = samples.filter((s) => donorOf(s) === d);
  console.log(`  ${d}  ${donorSex.get(d).padEnd(6)}  ${of.length} samples  ${of.join(" ")}`);
}
console.log(`female: ${femaleDonors.join(", ")} — male: ${maleDonors.join(", ")}`);
console.log();

// ---- the two tests -----------------------------------------------------------

/** The page's arithmetic: one p per row, then BH across every row of the table. */
function contrast(valuesOf, A, B) {
  const ps = rows.map((r) => mannWhitney(A.map((k) => valuesOf(r, k) ?? 0),
    B.map((k) => valuesOf(r, k) ?? 0)).p);
  const qs = benjaminiHochberg(ps);
  return rows.map((r, i) => ({
    name: r.species ?? Object.keys(r)[0], p: ps[i], q: qs[i],
    a: mean(A.map((k) => valuesOf(r, k) ?? 0)), b: mean(B.map((k) => valuesOf(r, k) ?? 0)),
  }));
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// (a) as the page does it now: eighteen columns, nine against nine.
const perSample = contrast((r, s) => r[s], female, male);

// (b) at the level the design has: each donor's three samples averaged into one
// profile first, so a donor contributes one observation instead of three.
const donorValue = (r, d) => mean(samples.filter((s) => donorOf(s) === d).map((s) => r[s] ?? 0));
const perDonor = contrast(donorValue, femaleDonors, maleDonors);

// ---- what came out -----------------------------------------------------------

const report = (label, res, n1, n2) => {
  const finite = res.filter((x) => Number.isFinite(x.q));
  const minQ = Math.min(...finite.map((x) => x.q));
  const minP = Math.min(...res.filter((x) => Number.isFinite(x.p)).map((x) => x.p));
  const floor = minAttainableP(n1, n2);
  // The smallest q ANY table of this shape could produce. BH's q at rank k is
  // p(k)·n/k with n/k >= 1, so no q can fall below the smallest attainable p —
  // which is the whole point at 3 v 3, where that bound is already above 0.05.
  console.log(`(${label}) ${n1} v ${n2}`);
  console.log(`  floor: smallest attainable two-sided p = ${floor.toExponential(3)}` +
    ` (2 / C(${n1 + n2},${n1}) = 2/${Math.round(2 / floor)})`);
  console.log(`  no BH q can be below that floor, so q <= 0.05 is ` +
    `${floor > 0.05 ? "ARITHMETICALLY IMPOSSIBLE here" : "attainable"}`);
  console.log(`  smallest raw p observed: ${minP.toExponential(3)}`);
  console.log(`  smallest q observed:     ${minQ.toPrecision(4)}`);
  console.log(`  rows with q <= 0.05: ${res.filter((x) => x.q <= 0.05).length}` +
    ` · q <= 0.1: ${res.filter((x) => x.q <= 0.1).length}` +
    ` · raw p <= 0.05: ${res.filter((x) => x.p <= 0.05).length}`);
  // Rows AT the floor: the groups separate as cleanly as this design allows.
  // At 3 v 3 this is the interesting count, because it is the set of rows that
  // are as significant as they can possibly get — and they are still at q = 1.
  console.log(`  rows sitting exactly at the floor (p = ${floor.toExponential(3)}): ` +
    `${res.filter((x) => Math.abs(x.p - floor) < 1e-12).length}`);
  const top = [...res].sort((x, y) => x.q - y.q || x.p - y.p).slice(0, 3);
  for (const t of top) {
    console.log(`    ${t.name.padEnd(34)} p=${t.p.toExponential(3)} q=${t.q.toPrecision(4)}` +
      ` mean ${t.a.toFixed(3)} vs ${t.b.toFixed(3)}`);
  }
  console.log();
  return { minP, minQ, floor, sig: res.filter((x) => x.q <= 0.05).length };
};

const A = report("a — as the page tests it, samples as observations", perSample, female.length, male.length);
const B = report("b — donors as observations, three profiles averaged", perDonor, femaleDonors.length, maleDonors.length);

// The row the page would have called the closest to significant, followed to the
// donor level: what the correction did to the number a reader would have read.
const best = [...perSample].sort((x, y) => x.q - y.q)[0];
const same = perDonor[perSample.indexOf(best)];
console.log(`the sample-level best row, at donor level:`);
console.log(`  ${best.name}: q ${best.q.toPrecision(4)} (9 v 9) -> ${same.q.toPrecision(4)} (3 v 3)` +
  `, raw p ${best.p.toExponential(3)} -> ${same.p.toExponential(3)}`);
console.log();
console.log(`the floor the page prints:  ${A.floor.toExponential(3)}`);
console.log(`the floor the design has:   ${B.floor.toExponential(3)}` +
  `  (${(B.floor / A.floor).toPrecision(4)} times larger)`);
console.log(`rows called significant at q <= 0.05 — nine against nine: ${A.sig}` +
  `, three donors against three: ${B.sig}`);
