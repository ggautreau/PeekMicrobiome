// The JS side of the audit of redundancy_ratio.py: run the PAGE's own roll-ups
// and the page's own Bray-Curtis, and print the four within/between pairs.
//
//     node scripts/depth-bench/redundancy_ratio_check.mjs
//
// redundancy_ratio.py retypes moduleTable, pathwayRollup and brayCurtis in
// Python and says in its docstring that it replicates web/kegg.js "exactly".
// A retyped function that agrees with the paper only shows that the same author
// made the same choice twice; it does not show that the browser does this. So
// this file imports web/kegg.js and web/cluster.js and computes the same four
// numbers from them, and the Python is validated only if the two agree.
//
// WHAT WOULD MAKE THIS WRONG: building vectors the page would not build. The
// taxonomic rows are assembled the way multi.js's matrixToTable does at species
// rank (one row per genome, absent genomes 0), as analysis_reference.mjs already
// does; the functional vectors come straight out of kegg.js's own return values,
// in the row order kegg.js chose, so nothing about the feature set is decided
// here. If kegg.js changes, this stops agreeing and that is the point.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { moduleTable, pathwayRollup } from "../../web/kegg.js";
import { brayCurtis } from "../../web/cluster.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "../..");
const session = JSON.parse(fs.readFileSync(path.join(REPO, "web/demo/gut-demo.session.json"), "utf8"));
const map = JSON.parse(fs.readFileSync(path.join(REPO, "web/db/kegg/ko-map.json"), "utf8"));

const samples = session.samples;
const donor = new Map(
  fs.readFileSync(path.join(REPO, "web/demo/gut-demo.groups.csv"), "utf8")
    .trim().split("\n").slice(1).map((l) => l.split(",")),
);

// brayCurtis takes dense arrays, so every space is materialised as one array
// per sample over a shared row order — the shape the heatmap hands it.
const dense = (rows) => samples.map((_, i) => rows.map((r) => r.values[i]));

const spaces = {};
spaces["taxonomic (species)"] = dense(
  Object.entries(session.matrix).map(([, m]) => ({ values: samples.map((s) => m[s] ?? 0) })),
);
const kos = [...new Set(samples.flatMap((s) => Object.keys(session.funcProfiles[s] ?? {})))];
spaces["functional (orthologs)"] = samples.map((s) => kos.map((k) => session.funcProfiles[s]?.[k] ?? 0));
spaces["functional (modules)"] = dense(moduleTable(session.funcProfiles, samples, map).rows);
spaces["functional (pathways)"] = dense(pathwayRollup(session.funcProfiles, samples, map).rows);

for (const [name, vecs] of Object.entries(spaces)) {
  const within = [], between = [];
  for (let i = 0; i < samples.length; i++)
    for (let j = i + 1; j < samples.length; j++)
      (donor.get(samples[i]) === donor.get(samples[j]) ? within : between)
        .push(brayCurtis(vecs[i], vecs[j]));
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(
    `${name.padEnd(24)} rows ${String(vecs[0].length).padStart(5)}` +
    `  within ${mean(within).toFixed(4)}  between ${mean(between).toFixed(4)}` +
    `  ratio ${(mean(between) / mean(within)).toFixed(3)}`,
  );
}
