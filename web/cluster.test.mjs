// web/cluster.js — reordering a table must move every number with its sample.
//
//   node web/cluster.test.mjs
//
// Clustering permutes the columns. Anything indexed by sample that is NOT
// permuted with them is then read under another sample's name, silently: the
// GMM step coverage was, and a cell read "0 % of this module's steps were
// found" over a list of steps marked found. So the checks below compare every
// per-sample field, sample by sample, before and after — on the shipped
// example's own functional tables, not on a toy.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clusterTable, PER_SAMPLE } from "./cluster.js";
import { parseGmms, gmmTable } from "./gmm.js";
import { moduleTable, pathwayRollup, koTable } from "./kegg.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const demo = JSON.parse(fs.readFileSync(path.join(HERE, "demo/gut-demo.session.json"), "utf8"));
const map = JSON.parse(fs.readFileSync(path.join(HERE, "db/kegg/ko-map.json"), "utf8"));
const samples = demo.samples;
const profiles = demo.funcProfiles;

/**
 * Every per-sample field of `before`, looked up by SAMPLE NAME in `after`. A
 * row is matched on its identity, not its position, since the rows move too.
 * Returns the mismatches.
 */
// The fields checked are the ones KNOWN to be per-sample, named here, plus
// whatever cluster.js lists — never the module's list alone: a test that asks
// the code under test which fields to check passes when a field is dropped from
// it, which is exactly the defect it exists to catch (the mutation bench found
// this one).
const TABLE_FIELDS = [...new Set(["refs", "assigned", "unassigned", ...PER_SAMPLE.table])];
const ROW_FIELDS = [...new Set(["values", "coverage", ...PER_SAMPLE.row])];

function misaligned(before, after, rowId) {
  const out = [];
  const col = new Map(after.samples.map((s, c) => [s, c]));
  for (const k of TABLE_FIELDS) {
    if (!Array.isArray(before[k])) continue;
    before.samples.forEach((s, c) => {
      if (before[k][c] !== after[k][col.get(s)]) out.push(`table.${k}[${s}]`);
    });
  }
  const rowsAfter = new Map(after.rows.map((r) => [rowId(r), r]));
  for (const r of before.rows) {
    const r2 = rowsAfter.get(rowId(r));
    if (!r2) { out.push(`row ${rowId(r)} lost`); continue; }
    for (const k of ROW_FIELDS) {
      if (!Array.isArray(r[k])) continue;
      before.samples.forEach((s, c) => {
        if (r[k][c] !== r2[k][col.get(s)]) out.push(`${rowId(r)}.${k}[${s}]`);
      });
    }
  }
  return out;
}

// ---- GMM: the field that was left behind -----------------------------------
//
// Definitions small enough to reason about, over orthologs the example really
// measured, so the coverage differs between samples and a column left in place
// shows up as a wrong number rather than as the same one.
{
  const kos = Object.entries(profiles[samples[0]]).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  // Orthologs seen in ONE sample each, taken from four different samples. Taken
  // from the pool of all samples instead, they all came from the first one —
  // the only column clustering left in place — and a coverage left unpermuted
  // read exactly as a permuted one (the mutation bench found it).
  const rareIn = (s) => Object.keys(profiles[s]).filter((k) =>
    samples.filter((x) => profiles[x][k] > 0).length === 1);
  const pick = [2, 7, 11, 14].map((i) => rareIn(samples[i]));
  const text = [
    "MF0001\tcommon then rare", kos[0], pick[0][0] ?? kos[5], pick[1][0] ?? kos[6], "///",
    "MF0002\ta complex", `${kos[1]},${pick[2][0] ?? kos[7]}\t${kos[2]}`, pick[3][0] ?? kos[8], "///",
    "MF0003\tthree steps", kos[3], pick[1][1] ?? kos[9], kos[4], "///",
  ].join("\n");
  const t = gmmTable(profiles, samples, parseGmms(text));
  const c = clusterTable(t);
  const distinct = new Set(t.rows.flatMap((r) => r.coverage)).size;
  check("the GMM table has coverage that differs from sample to sample",
    distinct > 1, `${distinct} distinct values`);
  check("clustering actually reorders its columns",
    c.clustered.samples && c.samples.join() !== t.samples.join());
  // The precondition the check below rests on: some column lands where the
  // coverage is different, so a coverage left behind cannot pass for a moved one.
  check("...and moves a column onto one whose coverage differs",
    t.rows.some((r) => c.samples.some((sm, j) => r.coverage[j] !== r.coverage[samples.indexOf(sm)])));
  const bad = misaligned(t, c, (r) => r.id);
  check("every GMM value AND its step coverage stay with their sample",
    bad.length === 0, bad.slice(0, 6).join(", "));
}

// ---- the KEGG roll-ups: per-sample fields at the table level too ---------------
for (const [name, build, id] of [
  ["modules", () => moduleTable(profiles, samples, map), (r) => r.id],
  ["pathways", () => pathwayRollup(profiles, samples, map), (r) => r.id],
  ["orthologs", () => koTable(profiles, samples, map), (r) => r.id],
]) {
  const t = build();
  const c = clusterTable(t);
  const bad = misaligned(t, c, id);
  check(`the ${name} table keeps every per-sample field with its sample`,
    c.clustered.samples && bad.length === 0, bad.slice(0, 6).join(", "));
}

// ---- nothing per-sample is left off the list --------------------------------
//
// The list in cluster.js is explicit on purpose — a length test would also
// permute a GMM's `steps` when there happened to be as many steps as samples.
// So it has to be kept complete by hand, and this is what holds it to that: any
// array of numbers with one entry per sample, on a table or on a row of one of
// the tables the page builds, must be on the list.
{
  const kos = Object.keys(profiles[samples[0]]).slice(0, 6);
  const tables = [
    moduleTable(profiles, samples, map), pathwayRollup(profiles, samples, map), koTable(profiles, samples, map),
    gmmTable(profiles, samples, parseGmms(`MF0001\tx\n${kos[0]}\n${kos[1]}\n///\n`)),
  ];
  const perSample = (v) => Array.isArray(v) && v.length === samples.length &&
    v.every((x) => x == null || typeof x === "number");
  const unlisted = new Set();
  for (const t of tables) {
    for (const [k, v] of Object.entries(t)) {
      if (k !== "samples" && perSample(v) && !PER_SAMPLE.table.includes(k)) unlisted.add(`table.${k}`);
    }
    for (const r of t.rows) {
      for (const [k, v] of Object.entries(r)) {
        if (perSample(v) && !PER_SAMPLE.row.includes(k)) unlisted.add(`row.${k}`);
      }
    }
  }
  check("every per-sample field the tables carry is on the list that moves with the columns",
    unlisted.size === 0, [...unlisted].join(", "));
}

// ---- and a field that only LOOKS per-sample is left alone ---------------------
{
  const t = {
    samples: ["a", "b", "c"],
    rows: [
      { id: "m1", values: [1, 0, 1], coverage: [1, 0, 1], steps: [["K1"], ["K2"], ["K3"]] },
      { id: "m2", values: [0, 1, 1], coverage: [0, 1, 1], steps: [["K4"], ["K5"], ["K6"]] },
      { id: "m3", values: [1, 1, 0], coverage: [1, 1, 0], steps: [["K7"], ["K8"], ["K9"]] },
    ],
  };
  const c = clusterTable(t);
  check("a definition with as many steps as there are samples is not reordered",
    c.rows.every((r) => JSON.stringify(r.steps) === JSON.stringify(t.rows.find((x) => x.id === r.id).steps)));
}

console.log(`\n${pass} passed, ${fail} failed (cluster)`);
process.exit(fail ? 1 : 0);
