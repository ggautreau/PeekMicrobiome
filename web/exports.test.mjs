// web/exports.js — the formats other tools read, held to what those tools do.
//
//   node web/exports.test.mjs
//   EXPORT_DIR=/tmp/x node web/exports.test.mjs     (also writes the files out)
//
// The checks in fastq-trim.parity.test.mjs are about the arithmetic of the
// formats — cumulative clades, seven taxonomy slots. These are about the ways a
// file came out WRONG while looking like the format: a BIOM whose observation
// IDs were "1 genome" over and over, genera written as species, two genomes
// summed under one species name, a header a reader drops as a comment, and a
// float matrix the validator refuses. The shipped example is the input, at
// species rank and above it, because that is where every one of them was found.
//
// With EXPORT_DIR set, the files are written there too, so they can be put to
// the real readers: `biom validate-table -i table.biom`, biom.load_table, and
// pandas.read_csv(..., sep="\t", comment="#"). That was done for this commit
// (biom-format 2.1.16, pandas 2) and is recorded beside the checks it backs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toMetaphlan, toBiom, toSession, fromSession } from "./exports.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const demo = JSON.parse(fs.readFileSync(path.join(HERE, "demo/gut-demo.session.json"), "utf8"));
const lineage = JSON.parse(fs.readFileSync(path.join(HERE, "db/lineage/human-gut.json"), "utf8"));
const lineageOf = (g) => {
  const t = lineage.taxa[g];
  if (!t) return {};
  return Object.fromEntries(lineage.rankKeys.map((k, i) => [k, lineage.ranks[k][t[i]]]));
};
const speciesName = (g) => lineage.species[g] ?? "";
// What the page passes as `speciesOf`: the name, with the accession appended
// when the reference gives the same name to more than one genome.
const counts = new Map();
for (const n of Object.values(lineage.species)) counts.set(n, (counts.get(n) ?? 0) + 1);
const speciesLabel = (g) => (counts.get(speciesName(g)) > 1 ? `${speciesName(g)} [${g.replace(/\.fna$/, "")}]` : speciesName(g));

// The per-genome table, as the page builds it at species rank.
const perGenome = {
  samples: demo.samples,
  rows: Object.entries(demo.matrix).map(([genome, r]) => ({
    genome, species: r.species, values: demo.samples.map((s) => Number(r[s] ?? 0)),
  })),
};
// And the view aggregated to genus — what the page used to hand both exports
// whenever the rank picker was above species.
const byGenus = new Map();
for (const r of perGenome.rows) {
  const name = lineageOf(r.genome).g || "unclassified at genus level";
  const e = byGenus.get(name) ?? { name, values: demo.samples.map(() => 0), n: 0 };
  r.values.forEach((v, i) => { e.values[i] += v; });
  e.n++;
  byGenus.set(name, e);
}
const genusView = {
  samples: demo.samples,
  rows: [...byGenus.values()].map((e) => ({ genome: `${e.n} genome${e.n === 1 ? "" : "s"}`, species: e.name, values: e.values })),
};

// ---- an aggregated table is refused, not written wrong -------------------------
console.log("== what the exports accept ==");
for (const [name, fn] of [["MetaPhlAn", toMetaphlan], ["BIOM", toBiom]]) {
  let message = "";
  try { fn(genusView, { lineageOf, speciesOf: speciesLabel }); } catch (e) { message = e.message; }
  check(`${name} refuses the table aggregated to genus instead of writing genera as species`,
    /per-genome table/.test(message), message || "it wrote a file");
}

// ---- MetaPhlAn ---------------------------------------------------------------
console.log("== MetaPhlAn ==");
{
  const mpa = toMetaphlan(perGenome, { lineageOf, speciesOf: speciesName, header: ["reference: test"] });
  const lines = mpa.trim().split("\n");
  const header = lines.find((l) => !l.startsWith("#"));
  check("the column header is a header, not a comment a reader drops",
    header === `clade_name\t${demo.samples.join("\t")}` && !lines.some((l) => l.startsWith("#clade_name")),
    header?.slice(0, 40));
  const species = lines.filter((l) => /\|s__[^|\t]*\t/.test(l));
  // 468 genomes, 468 species rows — even with the plain GTDB names, of which
  // the example shares nine among fifteen genomes.
  check("one species row per genome, even when GTDB gives two genomes one name",
    species.length === perGenome.rows.length, `${species.length} species rows for ${perGenome.rows.length} genomes`);
  const shared = species.filter((l) => /_\[MGYG\d+\.fna\]\t/.test(l)).length;
  check("...the genomes that share a name told apart by their accession",
    shared > 0 && shared < 30, `${shared} rows disambiguated`);
  // The property of the format: each clade is the sum of what is under it. A
  // species absorbed into another's row leaves the totals intact, so this is
  // checked on the species rows themselves: each equals its genome.
  const byClade = new Map(lines.filter((l) => !l.startsWith("#") && l !== header)
    .map((l) => { const f = l.split("\t"); return [f[0], f.slice(1).map(Number)]; }));
  const top = [...byClade].filter(([k]) => !k.includes("|"));
  const totals = demo.samples.map((_, i) => top.reduce((a, [, v]) => a + v[i], 0));
  const want = demo.samples.map((_, i) => perGenome.rows.reduce((a, r) => a + r.values[i], 0));
  check("...and the top clades still add up to every genome in the sample",
    totals.every((t, i) => Math.abs(t - want[i]) < 1e-3), `${totals[0]} against ${want[0]}`);
  // With the names the page passes, nothing is left to disambiguate.
  const labelled = toMetaphlan(perGenome, { lineageOf, speciesOf: speciesLabel });
  check("...and with the page's own labels the names are unique as they come",
    labelled.trim().split("\n").filter((l) => /\|s__/.test(l)).length === perGenome.rows.length &&
    !/_\[MGYG\d+\.fna\]/.test(labelled));
  if (process.env.EXPORT_DIR) fs.writeFileSync(path.join(process.env.EXPORT_DIR, "metaphlan.tsv"), mpa);
}

// ---- BIOM ----------------------------------------------------------------------
console.log("== BIOM ==");
{
  const text = toBiom(perGenome, { lineageOf, speciesOf: speciesLabel, date: "2026-10-10T14:08:09.168Z" });
  const biom = JSON.parse(text);
  check("one observation per genome, each with its own ID",
    biom.rows.length === perGenome.rows.length && new Set(biom.rows.map((r) => r.id)).size === biom.rows.length);
  // `biom validate-table` refuses integers in a matrix declared "float" — and
  // JSON.stringify writes 0 as 0. Every cell has to carry its decimal point.
  const cells = text.slice(text.indexOf('"data"')).match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? [];
  check("every cell of the float matrix is written as a float",
    cells.length === perGenome.rows.length * demo.samples.length && cells.every((c) => c.includes(".")),
    cells.filter((c) => !c.includes(".")).slice(0, 5).join(" "));
  check("...and is the abundance it stands for",
    biom.data.every((row, i) => row.every((v, j) => Math.abs(v - perGenome.rows[i].values[j]) < 5e-7)));
  // The validator's date: to the second, no fraction, no zone — whatever the
  // page hands in.
  check("the date is in the shape the validator accepts",
    biom.date === "2026-10-10T14:08:09", biom.date);
  check("...and with no date the file is the same every time",
    toBiom(perGenome, { lineageOf }) === toBiom(perGenome, { lineageOf }) &&
    JSON.parse(toBiom(perGenome, { lineageOf })).date === "1970-01-01T00:00:00");
  if (process.env.EXPORT_DIR) fs.writeFileSync(path.join(process.env.EXPORT_DIR, "table.biom"), text);
}

// ---- a column profiled on part of its input stays flagged -----------------------
//
// The page marks a sample INCOMPLETE when it was profiled on fewer reads than its
// input holds (a download cut short, a FASTQ that stops being FASTQ). The flag
// used to live only on the sample list, so it reached the TSV and nothing else:
// the BIOM and a saved session came back with the column looking whole.
console.log("== the incomplete flag travels ==");
{
  const why = "the reads stop at a malformed FASTQ record after read 6,000";
  const flagged = demo.samples[1];
  const biom = JSON.parse(toBiom(perGenome, {
    lineageOf, speciesOf: speciesLabel, date: "2026-10-10T12:00:00",
    columnMeta: (n) => (n === flagged ? { incomplete: why } : null),
  }));
  check("BIOM: the flagged column carries why, the others carry nothing",
    biom.columns[1].metadata?.incomplete === why
      && biom.columns.filter((c) => c.metadata !== null).length === 1,
    JSON.stringify(biom.columns.slice(0, 3)));
  const back = fromSession(toSession({
    sampleOrder: demo.samples, matrix: demo.matrix, incomplete: new Map([[flagged, why]]),
  }));
  check("a saved session brings the flag back with the matrix",
    back.incomplete instanceof Map && back.incomplete.get(flagged) === why && back.incomplete.size === 1,
    JSON.stringify([...(back.incomplete ?? [])]));
  check("a session saved before the flag existed opens with no column flagged",
    fromSession(JSON.stringify({ ...JSON.parse(toSession({ sampleOrder: demo.samples, matrix: demo.matrix })),
      incomplete: undefined })).incomplete.size === 0);
}

console.log(`\n${pass} passed, ${fail} failed (exports)`);
process.exit(fail ? 1 : 0);
