// web/screening.js — the verdict on which catalogue a sample belongs to, and
// the sentence that comes with it.
//
//   node web/screening.test.mjs
//
// The verdict is checked in the real page by biome-page.test.mjs. What is
// checked here, in plain node, is that the sentence printed with a refusal
// gives the RIGHT reason: "every species lives in more than one catalogue" is a
// claim about the table beside it, and it was printed when the table showed a
// species found in one catalogue only.

import { normaliseMarkers, screenVerdict } from "./screening.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const markers = normaliseMarkers({
  biomes: ["human-gut", "human-oral", "human-vaginal"],
  genomes: {
    "MGYG1.fna": { s: "Lactobacillus crispatus", b: [0, 1, 2] },     // everywhere
    "MGYG2.fna": { s: "Bacteroides uniformis", b: [0] },              // gut only
    "MGYG3.fna": { s: "Streptococcus mitis", b: [1] },                 // oral only
  },
});
const tsv = (rows) => ["Genome_file\tTaxonomic_abundance\tAdjusted_ANI",
  ...rows.map(([g, a]) => `${g}\t${a}\t98.5`)].join("\n");

{
  // Shared species only: the old sentence is the right one.
  const v = screenVerdict(tsv([["MGYG1.fna.gz", 90]]), markers);
  check("with no exclusive species at all the verdict refuses, and says why",
    !v.confident && /every species detected here lives in more than one catalogue/.test(v.note), v.note);
}
{
  // A gut-only species IS detected — at 0.5 %, under the 1 % threshold. The
  // refusal stands; the sentence must not deny what the table shows.
  const v = screenVerdict(tsv([["MGYG1.fna.gz", 90], ["MGYG2.fna.gz", 0.5]]), markers);
  check("with exclusive support under the threshold it still refuses",
    !v.confident && v.best?.biome === "human-gut" && v.best.excl === 0.5);
  check("...but no longer claims every species is shared",
    !/every species detected here lives in more than one catalogue/.test(v.note) &&
    /only 0\.50% of this sample comes from species found in a single catalogue \(human-gut\)/.test(v.note),
    v.note);
}
{
  // And above it, a verdict.
  const v = screenVerdict(tsv([["MGYG1.fna.gz", 60], ["MGYG2.fna.gz", 30]]), markers);
  check("exclusive support above the threshold names the catalogue",
    v.confident && v.best.biome === "human-gut" && /human-gut explains/.test(v.note), v.note);
}

console.log(`\n${pass} passed, ${fail} failed (screening)`);
process.exit(fail ? 1 : 0);
