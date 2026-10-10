// The page's own p and q for both contrast designs, written out for checking.
//
//     node scripts/depth-bench/pseudoreplication_dump.mjs out.json
//
// pseudoreplication_null.py recomputes the same two tests from scratch, and a
// second implementation is only worth having if it can be compared cell by cell
// against the first. So this writes what web/stats.js returns for every one of
// the 468 rows — both designs, p and q — beside the values those numbers were
// computed from, and the Python file reports the largest disagreement.
//
// The donor map, the group split and the missing-cell rule are copied from
// pseudoreplication.mjs deliberately: the point of the comparison is the
// arithmetic, and changing the inputs here would compare two different tables.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = process.argv[2];
if (!out) throw new Error("usage: node pseudoreplication_dump.mjs <out.json>");

const { mannWhitney, benjaminiHochberg } = await import(path.join(REPO, "web/stats.js"));
const { contrastSvg } = await import(path.join(REPO, "web/figures.js"));
const st = JSON.parse(fs.readFileSync(path.join(REPO, "web/demo/gut-demo.session.json"), "utf8"));

const samples = st.samples;
const rows = Object.values(st.matrix);
const metaOf = (s) => st.sampleMeta?.[s] ?? {};
const donorOf = (s) => /^(?:[A-Z]\.)?(.+?)_(\d+)$/.exec(String(metaOf(s).sample_alias ?? ""))?.[1];
const female = samples.filter((s) => metaOf(s).host_sex === "female");
const male = samples.filter((s) => metaOf(s).host_sex === "male");
const donors = [...new Set(samples.map(donorOf))];
const sexOfDonor = (d) => metaOf(samples.find((s) => donorOf(s) === d)).host_sex;
const fd = donors.filter((d) => sexOfDonor(d) === "female");
const md = donors.filter((d) => sexOfDonor(d) === "male");

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const donorValue = (r, d) => mean(samples.filter((s) => donorOf(s) === d).map((s) => r[s] ?? 0));

const pS = rows.map((r) => mannWhitney(female.map((s) => r[s] ?? 0), male.map((s) => r[s] ?? 0)).p);
const pD = rows.map((r) => mannWhitney(fd.map((d) => donorValue(r, d)),
  md.map((d) => donorValue(r, d))).p);

// What the figure WRITES about the floor, which is not the same question as what
// the floor is: figures.js appends the clause only when the floor is above 0.05,
// so the sentence a reader sees depends on the group sizes. Taken from the drawn
// SVG rather than from the source, in both configurations.
const subtitles = (cols) => {
  const idx = cols.map((s) => samples.indexOf(s));
  const svg = contrastSvg({
    samples: cols,
    rows: rows.map((r) => ({ species: r.species, values: idx.map((i) => r[samples[i]] ?? 0) })),
  }, { groupOf: (s) => metaOf(s).host_sex, scale: 1 });
  return [...svg.matchAll(/<text x="0" y="(?:27|39)"[^>]*>([^<]*)</g)].map((m) => m[1]);
};
const seen = new Set();
const oneEach = samples.filter((s) => !seen.has(donorOf(s)) && seen.add(donorOf(s)));

fs.writeFileSync(out, JSON.stringify({
  subtitle9v9: subtitles(samples), subtitle3v3: subtitles(oneEach),
  species: rows.map((r) => r.species),
  samples, female, male, fd, md, donorOrder: [...fd, ...md],
  colDonor: samples.map(donorOf),
  sampleVals: rows.map((r) => samples.map((s) => r[s] ?? 0)),
  donorVals: rows.map((r) => [...fd, ...md].map((d) => donorValue(r, d))),
  pS, qS: benjaminiHochberg(pS), pD, qD: benjaminiHochberg(pD),
}));
console.log(`wrote ${out}: ${rows.length} rows, ${samples.length} samples, ${donors.length} donors`);
