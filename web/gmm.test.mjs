// web/gmm.js, against definitions small enough to work out on paper — and then,
// if the reader happens to have the real file to hand, against that too.
//
//   node web/gmm.test.mjs
//   GMM_DEFS=/path/to/GMMs.v1.07.txt node web/gmm.test.mjs
//
// The real file is NOT in this repository and must not be: it is distributed
// under VIB's Academic Non-commercial Software License, whose clause 9 forbids
// transferring it outside the licensee's institution. So the checks that need it
// are skipped unless GMM_DEFS points at a copy the person running the tests
// already has. Everything that can be tested without it, is.

import fs from "node:fs";
import { parseGmms, gmmTable, gmmCoverage } from "./gmm.js";

let pass = 0, fail = 0, skip = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// Three modules covering every rule of the grammar:
//   MF0001  one step, two alternatives — OR
//   MF0002  two steps — AND across lines
//   MF0003  one step whose alternative is a complex — AND within an alternative
//           …and a trailing tab, which is the defect the real file carries.
const TEXT = [
  "MF0001\tsingle step, two ways",
  "K0001\tK0002",
  "///",
  "MF0002\ttwo steps",
  "K0003",
  "K0004\tK0005",
  "///",
  "MF0003\ta complex",
  "K0006,K0007\tK0008\t",
  "///",
  "",
].join("\n");

// ---- the grammar ---------------------------------------------------------------
{
  const d = parseGmms(TEXT);
  check("every module is read", d.modules.length === 3, String(d.modules.length));
  check("a header gives the identifier, the name and the label",
    d.modules[0].id === "MF0001" && d.modules[0].name === "single step, two ways" &&
    d.modules[0].label === "MF0001 — single step, two ways");
  check("a tab is OR: one step, two alternatives",
    d.modules[0].steps.length === 1 && d.modules[0].steps[0].length === 2);
  check("a newline is AND: two steps", d.modules[1].steps.length === 2);
  check("a comma is AND inside an alternative",
    d.modules[2].steps[0][0].length === 2 && d.modules[2].steps[0][1].length === 1,
    JSON.stringify(d.modules[2].steps[0]));
  // The defect. Three step lines of the real file end in a tab; split without
  // filtering and an empty string joins the ortholog set as a KO that can never
  // be observed, dragging one module's coverage down for ever.
  check("a trailing tab does not become an empty ortholog",
    d.modules[2].steps[0].length === 2 && !d.kos.has(""),
    JSON.stringify([...d.kos]));
  check("the ortholog set is every ortholog named, once",
    d.kos.size === 8 && d.kos.has("K0001") && d.kos.has("K0007"), String(d.kos.size));
  // A file this parser cannot read must say so rather than return a table of
  // whatever it managed: a silently half-parsed catalogue reports coverage that
  // looks like biology.
  let threw = false;
  try { parseGmms("K0001\tK0002\n"); } catch { threw = true; }
  check("a step before any header is an error, not a guess", threw);
  check("empty input parses to an empty catalogue rather than throwing",
    parseGmms("").modules.length === 0 && parseGmms(null).modules.length === 0);
}

// ---- the estimator --------------------------------------------------------------
{
  const d = parseGmms(TEXT);
  // s1 covers everything; s2 is missing K0004/K0005, so MF0002 has one step of
  // two; s3 has only half of the MF0003 complex.
  const profiles = {
    s1: { K0001: 0.4, K0003: 0.2, K0004: 0.6, K0006: 0.1, K0007: 0.3 },
    s2: { K0002: 0.5, K0003: 0.2 },
    s3: { K0006: 0.1 },
  };
  const samples = ["s1", "s2", "s3"];
  const t = gmmTable(profiles, samples, d);
  const at = (id) => t.rows.find((r) => r.id === id);

  check("a module is covered when every step has a present alternative",
    at("MF0001").coverage[0] === 1 && at("MF0002").coverage[0] === 1);
  check("a step with no present alternative is not covered",
    Math.abs(at("MF0002").coverage[1] - 0.5) < 1e-12, String(at("MF0002").coverage[1]));
  // THE property of an AND: a complex is no more present than its rarest
  // subunit, and half a complex is not the complex.
  check("half a complex covers nothing", at("MF0003").coverage[2] === 0,
    String(at("MF0003").coverage[2]));
  check("...and a whole one is the median of its own orthologs",
    Math.abs(at("MF0003").values[0] - 0.2) < 1e-12, String(at("MF0003").values[0]));
  // Below the cutoff the module reports zero rather than a quantity computed
  // from the two steps of seven that happened to be there.
  check("a module under the coverage cutoff reports nothing, not a fraction",
    at("MF0002").values[1] === 0, String(at("MF0002").values[1]));
  check("...and the cutoff is reported so the number can be read",
    t.minCoverage === 2 / 3);
  // The alternative CHOSEN is the most abundant one, since the path is meant to
  // be the one the community actually runs.
  const one = at("MF0001");
  check("the best alternative is the one taken",
    Math.abs(one.values[0] - 0.4) < 1e-12 && Math.abs(one.values[1] - 0.5) < 1e-12,
    `${one.values[0]} / ${one.values[1]}`);

  // The number that must travel with the view: most of a measured profile is
  // outside this catalogue by construction.
  check("what the catalogue can speak for is carried, not assumed",
    Math.abs(t.assigned[0] - 1.6) < 1e-12 && Math.abs(t.unassigned[0] - 0) < 1e-12,
    JSON.stringify([t.assigned[0], t.unassigned[0]]));
  const withOutsider = { ...profiles, s1: { ...profiles.s1, K9999: 1.0 } };
  check("...and an ortholog outside the catalogue lands in the remainder",
    Math.abs(gmmCoverage(withOutsider, ["s1"], d) - 1.6 / 2.6) < 1e-12,
    String(gmmCoverage(withOutsider, ["s1"], d)));
  // Prototype keys arrive from a file a reader opened.
  check("an ortholog named like an Object member is not a lookup on the prototype",
    gmmTable({ s: { constructor: 1 } }, ["s"], d).rows.every((r) => r.values[0] === 0));
}

// ---- the real catalogue, when the person running this has a copy ----------------
{
  const p = process.env.GMM_DEFS;
  if (!p || !fs.existsSync(p)) {
    skip++;
    console.log("skip GMMs.v1.07.txt — set GMM_DEFS to a copy you already have " +
      "(the file is under VIB's academic licence and is not in this repository)");
  } else {
    const d = parseGmms(fs.readFileSync(p, "utf8"));
    check("the shipped catalogue is the 103 modules the paper describes",
      d.modules.length === 103, String(d.modules.length));
    check("...numbered MF0001 to MF0103, with no gaps",
      d.modules.every((m, i) => m.id === `MF${String(i + 1).padStart(4, "0")}`));
    check("...over 270 steps and 442 distinct orthologs",
      d.modules.reduce((a, m) => a + m.steps.length, 0) === 270 && d.kos.size === 442,
      `${d.modules.reduce((a, m) => a + m.steps.length, 0)} steps, ${d.kos.size} orthologs`);
    check("...every one of which is a KEGG ortholog identifier",
      [...d.kos].every((k) => /^K\d{5}$/.test(k)));
    check("...and every module is named",
      d.modules.every((m) => m.name && m.name !== m.id));
  }
}

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ""} (gmm)`);
process.exit(fail ? 1 : 0);
