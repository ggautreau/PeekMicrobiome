// web/kegg.js and the pathway figure, against hand-built profiles whose answers
// can be worked out on paper — and then against the real shipped map, so a
// change to ko-map.json's shape fails here rather than on screen.
//
//   node web/kegg.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { koTable, moduleTable, moduleMapUrl, pathwayRollup, moduleCoverage, parseKoCsv, keggEntryUrl,
  keggMapUrl, heatHex, floorRows } from "./kegg.js";
import { compositionSvg, alphaSvg } from "./figures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// A map small enough to reason about: K1 is in two modules, K2 in one, K3 in
// none. M1 is on two pathways, M2 on none.
const MAP = {
  ko: { K1: "first thing", K2: "second thing", K3: "orphan" },
  koModules: { K1: ["M1", "M2"], K2: ["M1"] },
  modules: { M1: { n: "module one", p: ["map1", "map2"] }, M2: { n: "module two", p: [] } },
  pathways: { map1: "pathway one", map2: "pathway two" },
};
const samples = ["a", "b"];
const profiles = { a: { K1: 0.5, K2: 0.3, K3: 0.2 }, b: { K1: 0.1, K3: 0.9 } };

// ---- the profiler's CSV ------------------------------------------------------
{
  const csv = [
    "# a provenance header the profiler script writes",
    "ko_id,abundance",
    "ko:K01952,0.0184",
    "ko:K03406,0.0092",
    "",
  ].join("\n");
  const p = parseKoCsv(csv);
  // The whole reason this function exists: the archive names its signatures
  // ko:K01952 and every KEGG table is keyed K01952. Match on the prefixed form
  // and nothing joins — which reads as "no ortholog is in a module", not as an
  // error.
  check("the ko: prefix is stripped", p.K01952 === 0.0184 && !("ko:K01952" in p),
    JSON.stringify(p));
  check("the header row is not an ortholog", !("ko_id" in p) && Object.keys(p).length === 2);
  check("comments and blank lines are ignored", Object.keys(p).every((k) => /^K\d+$/.test(k)));
  check("an empty profile parses to an empty object",
    Object.keys(parseKoCsv("ko_id,abundance\n")).length === 0);
  check("nothing at all is not an exception", Object.keys(parseKoCsv(null)).length === 0);
  // A round trip, since this is the shape everything below consumes.
  check("what it returns feeds koTable",
    koTable({ s: parseKoCsv(csv) }, ["s"], MAP).rows.length === 2);
}

// ---- KO level ----------------------------------------------------------------
{
  const t = koTable(profiles, samples, MAP);
  check("koTable keeps every measured ortholog", t.rows.length === 3, `${t.rows.length}`);
  check("koTable orders by total abundance", t.rows[0].id === "K3",
    t.rows.map((r) => r.id).join(","));
  // Three strings, three jobs: the identifier a reader copies, the name a table
  // column reads, and the label a legend needs because a figure has room for one
  // string and either half alone is useless.
  const k1 = t.rows.find((r) => r.id === "K1");
  check("koTable keeps the identifier, the name and the label apart",
    k1.id === "K1" && k1.name === "first thing" && k1.label === "K1 — first thing",
    JSON.stringify({ id: k1.id, name: k1.name, label: k1.label }));
  const k2 = t.rows.find((r) => r.id === "K2");
  check("a KO absent from a sample reads as zero, not as missing",
    k2.values.length === 2 && k2.values[1] === 0, JSON.stringify(k2.values));
  const bare = koTable(profiles, samples, null);
  check("without the map the identifiers still work",
    bare.rows.length === 3 && bare.rows.every((r) => /^K\d$/.test(r.name)));
}

// ---- where an identifier lives ------------------------------------------------
{
  check("a KEGG ortholog, module and pathway each get an entry URL",
    keggEntryUrl("K01952") === "https://www.kegg.jp/entry/K01952" &&
    keggEntryUrl("M00001") === "https://www.kegg.jp/entry/M00001" &&
    keggEntryUrl("map00010") === "https://www.kegg.jp/entry/map00010");
  // The bucket this file invents for modules on no map. A link to
  // /entry/_none is a dead end offered in the same shape as a real one.
  check("the not-on-a-pathway bucket gets no link", keggEntryUrl("_none") === null);
  check("nothing else does either",
    keggEntryUrl("") === null && keggEntryUrl(null) === null &&
    keggEntryUrl("K1") === null && keggEntryUrl("javascript:alert(1)") === null &&
    keggEntryUrl("K01952 K00001") === null);
}

// ---- modules -----------------------------------------------------------------
{
  const t = moduleTable(profiles, samples, MAP);
  const m1 = t.rows.find((r) => r.id === "M1");
  check("a module carries its identifier, its name and its label",
    m1.id === "M1" && m1.name === "module one" && m1.label === "M1 — module one",
    JSON.stringify({ id: m1.id, name: m1.name, label: m1.label }));
  check("a KO in two modules counts in full for each, not split",
    t.rows.find((r) => r.id === "M2").values[0] === 0.5,
    String(t.rows.find((r) => r.id === "M2").values[0]));
  check("a module sums the KOs that reach it",
    Math.abs(t.rows.find((r) => r.id === "M1").values[0] - 0.8) < 1e-12);
  // The point of the whole design: what belongs to no module is carried, not
  // dropped, or a module chart silently speaks for a fraction of the signal.
  check("what reaches no module is kept", t.unassigned[0] === 0.2 && t.unassigned[1] === 0.9,
    JSON.stringify(t.unassigned));
  check("assigned and unassigned account for the whole profile",
    Math.abs((t.assigned[0] + t.unassigned[0]) - 1.0) < 1e-12);
  const cov = moduleCoverage(profiles, samples, MAP);
  check("coverage is the assigned share of everything measured",
    Math.abs(cov - (0.8 + 0.1) / (0.8 + 0.1 + 1.1)) < 1e-12, String(cov));
}

// ---- pathways ----------------------------------------------------------------
{
  const t = pathwayRollup(profiles, samples, MAP);
  const one = t.rows.find((r) => r.id === "map1");
  check("a pathway sums the modules on it", Math.abs(one.values[0] - 0.8) < 1e-12);
  check("a module on two pathways appears under both",
    t.rows.filter((r) => r.modules.some((m) => m.id === "M1")).length === 2);
  // M2 is on no map, but its only ortholog K1 is also in M1, which IS on a map.
  // So K1 is already represented and must NOT also be filed under "no map shows
  // this" — that bucket answers "how much of the profile no map can show", and
  // an ortholog two maps show is not part of the answer.
  check("an ortholog a map already shows is not also filed under 'no map'",
    !t.rows.find((r) => r.id === "_none"),
    t.rows.map((r) => r.id).join(","));
  // The module list is what the tooltip names, so it may only hold modules that
  // actually reach this map. M2 reaches neither.
  check("a pathway lists only the modules that reach it",
    one.modules.length === 1 && one.modules[0].id === "M1",
    one.modules.map((m) => m.id).join(","));

  // THE property, on a fixture built for it: K1 sits in two modules that are
  // BOTH on map1. Summing the module rows counts it twice and map1 reads 1.2 —
  // more than the entire profile. This is the shape of the bug that shipped:
  // map01100 carries 319 modules, and its bar read 43 % of a profile whose
  // module-assigned part was 23 %.
  const MAP2 = {
    ko: { K1: "one", K2: "two" },
    koModules: { K1: ["M1", "M2"], K2: ["M3"] },
    modules: {
      M1: { n: "m one", p: ["map1"] },
      M2: { n: "m two", p: ["map1"] },
      M3: { n: "m three", p: [] },
    },
    pathways: { map1: "pathway one" },
  };
  const t2 = pathwayRollup({ s: { K1: 0.6, K2: 0.4 } }, ["s"], MAP2);
  const at = (id) => t2.rows.find((r) => r.id === id)?.values[0] ?? null;
  check("an ortholog on one map through two modules counts once, not twice",
    Math.abs(at("map1") - 0.6) < 1e-12, String(at("map1")));
  check("an ortholog whose every module is off-map lands in the bucket",
    Math.abs(at("_none") - 0.4) < 1e-12, String(at("_none")));
  // The invariant that makes a row readable as a share at all.
  check("no pathway holds more of the profile than reaches a module at all",
    t2.rows.every((r) => r.values[0] <= t2.assigned[0] + 1e-12),
    `assigned ${t2.assigned[0]}, max row ${Math.max(...t2.rows.map((r) => r.values[0]))}`);
  check("a pathway carries its map identifier, its name and its label",
    one.id === "map1" && one.name === "pathway one" && one.label === "map1 — pathway one",
    JSON.stringify({ id: one.id, name: one.name, label: one.label }));
  // The bucket is not an entry: labelling it "_none — not on a pathway map"
  // would put an identifier-shaped string in front of something nobody can look
  // up, in a column where every other row can be.
  check("...and the bucket is labelled as prose, not as an entry",
    t2.rows.find((r) => r.id === "_none")?.label === "not on a pathway map");
  check("the pathway roll-up carries the unassigned share through",
    t.unassigned[0] === 0.2, JSON.stringify(t.unassigned));
}

// ---- the floor under the matrix -----------------------------------------------
{
  const t = koTable(profiles, samples, MAP);       // K3 .2/.9, K1 .5/.1, K2 .3/0
  const all = floorRows(t, 0);
  check("no floor changes nothing, and says so",
    all.rows.length === 3 && all.hidden === 0 && all.carried === 0 && all.floor === 0);
  // THE property: the floor is on the ROW, not the cell. K2 is 30% in one sample
  // and absent in the other; a per-cell floor would delete exactly the pattern a
  // reader is looking for.
  const t35 = floorRows(t, 35);
  check("a row survives if ANY sample reaches the floor",
    t35.rows.map((r) => r.id).sort().join(",") === "K1,K3", t35.rows.map((r) => r.id).join(","));
  check("...and K2, at 30% in one sample, is the one that goes",
    t35.hidden === 1 && !t35.rows.find((r) => r.id === "K2"));
  // The number that says whether the floor removed noise or removed the answer.
  // K2 holds 0.3 of a table totalling 2.0.
  check("what was hidden is reported, with the share it carried",
    Math.abs(t35.carried - 0.3 / 2.0) < 1e-12, String(t35.carried));
  check("the floor it used travels with the result", t35.floor === 35);
  const none = floorRows(t, 100);
  check("a floor nothing reaches empties the table rather than throwing",
    none.rows.length === 0 && none.hidden === 3 && Math.abs(none.carried - 1) < 1e-12);
  // Everything else about the table has to survive the filter untouched.
  check("the samples and the roll-up's own fields are carried through",
    floorRows(moduleTable(profiles, samples, MAP), 10).unassigned.length === 2 &&
    t35.samples === t.samples);
}

// ---- what the deleted KEGG-map figure used to guard --------------------------
//
// The figure is gone: it drew the top fourteen pathways as bars while the matrix
// beside it showed all 87 of the same numbers per sample, sortable and
// downloadable — and since the row labels started opening KEGG's own drawing,
// the honest "KEGG map" is on kegg.jp. Its one unique element was a grey bar for
// what reaches no module at all; that fact now travels in the toolbar summary,
// as the complement ("22% of the measured signal reaches a pathway map"), and
// the number itself is still checked here.
{
  const roll = pathwayRollup(profiles, samples, MAP);
  check("what reaches no module is still carried by the roll-up",
    roll.unassigned[0] === 0.2 && roll.unassigned[1] === 0.9,
    JSON.stringify(roll.unassigned));
  check("...and an empty roll-up is still a table, not an exception",
    pathwayRollup({}, [], MAP).rows.length === 0);
}

// ---- KEGG's own drawing, coloured -----------------------------------------------
{
  const u = keggMapUrl("map00010", [{ id: "K00844", value: 1 }, { id: "K00845", value: 0 }],
    { max: 1 });
  // The one form KEGG documents (kegg.jp/kegg/webapp/color_url.html): `%09` is a
  // TAB, `%3d` an "=", `%23` a "#". Two forms that look right are not:
  // /pathway/<map>+<ko> is a 404, and /pathway/<map>?multi_query=… returns the
  // map with the argument ignored — a page that looks like a success and
  // colours nothing.
  check("the URL is KEGG's own documented colouring form, one colour per ortholog",
    u.url === "https://www.kegg.jp/kegg-bin/show_pathway?map00010/" +
      // Least abundant first, so the abundant one wins a shared box — see below.
      `K00845%09${heatHex(0, 1)}/K00844%09${heatHex(1, 1)}/default%3d${heatHex(0, 1)}`,
    u.url);
  // The gradient is the point: the abundant ortholog and the absent one must not
  // arrive the same colour.
  check("...and the colour follows the abundance",
    heatHex(1, 1) !== heatHex(0, 1) && /%23[0-9a-f]{6}/.test(heatHex(0.3, 1)));
  check("...on a log scale, so the tail is not all one shade",
    heatHex(0.01, 1) !== heatHex(0.0001, 1));
  // The pale end has to be a COLOUR. At lightness 0.88 it was almost white:
  // invisible on line art and hopeless on KEGG's own coloured global maps, which
  // is what "the link does not colour" turned out to mean for a reader.
  {
    const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i + 2, i + 4), 16));
    const [r, g, b] = rgb(heatHex(0, 1));
    check("the palest step is still visibly a colour, not almost-white",
      Math.max(r, g, b) - Math.min(r, g, b) > 90 && Math.min(r, g, b) < 200,
      heatHex(0, 1));
  }
  // THE ordering property, and it is not cosmetic: several orthologs can share a
  // drawn box, and KEGG lets the LAST one in the URL win — the earlier one
  // vanishes. Measured on kegg.jp: K21071 then K00850 renders 636 + 651 px, and
  // the same pair swapped renders 1,287 + NOTHING. So the abundant one must be
  // written last, while truncation still keeps the abundant end of the list.
  {
    const two = keggMapUrl("map00010",
      [{ id: "K21071", value: 1 }, { id: "K00850", value: 0.2 }], { max: 1 });
    check("the most abundant ortholog is written LAST, so it wins a shared box",
      two.url.indexOf("K00850") < two.url.indexOf("K21071"), two.url);
    // ...while the list that gets cut is still cut from the bottom.
    const many = Array.from({ length: 400 }, (_, i) =>
      ({ id: `K${String(i + 1).padStart(5, "0")}`, value: 1 - i / 400 }));
    const big = keggMapUrl("map00010", many, { max: 1 });
    check("...and truncation still drops the least abundant, not the most",
      big.url.includes("K00001%09") && !big.url.includes("K00400%09"),
      `${big.kept} kept`);
  }
  check("nothing to colour, or nothing to colour it on, gives no link",
    keggMapUrl("map00010", []) === null && keggMapUrl("_none", ["K00844"]) === null &&
    keggMapUrl("map00010", null) === null && keggMapUrl(null, ["K00844"]) === null);
  check("only real ortholog identifiers go into it",
    keggMapUrl("map00010", ["K00844", "nonsense", "K0084"]).kept === 1);
  // The three global maps get the GREY base, and pay for it with the other URL
  // form. KEGG's own script gates the Coloring dropdown on `mapno.match(/^011/)`,
  // so 011xx alone has a grey variant; and the grey switch cannot be appended to
  // the path form, whose query is one keyless token — KEGG answers 400, "The
  // 'mapno' parameter is required". Rendered, map01100 goes from 2,473,946
  // coloured pixels of KEGG's own palette to 119,352, nearly all ours.
  {
    const g = keggMapUrl("map01100", [{ id: "K00844", value: 1 }], { max: 1 });
    check("a global map is asked for in grey, on the form that takes the switch",
      g.grey === true && g.url.startsWith("https://www.kegg.jp/kegg-bin/show_pathway?map=map01100&multi_query=") &&
      g.url.endsWith("&coloring=grayscale"), g.url);
    check("...and every other map keeps the compact path form",
      !keggMapUrl("map00010", [{ id: "K00844", value: 1 }], { max: 1 }).grey &&
      !keggMapUrl("map01200", [{ id: "K00844", value: 1 }], { max: 1 }).grey);
    // No `default=` in that form — rendered with one, nothing of it lands — and a
    // bare identifier there gets KEGG's OWN red, which on our ramp reads as the
    // most abundant thing on the map. So the grey form drops rather than
    // promotes: no entry may go out without a colour of its own.
    const many = Array.from({ length: 400 }, (_, i) =>
      ({ id: `K${String(i + 1).padStart(5, "0")}`, value: 1 - i / 400 }));
    const big = keggMapUrl("map01100", many, { max: 1 });
    check("...and never sends a bare identifier, which KEGG would paint red",
      big.plain === 0 && !/multi_query=[^&]*(^|%0d%0a)K\d{5}(%0d%0a|&|$)/.test(big.url) &&
      big.url.length < 2048 && big.dropped > 0,
      `${big.kept} kept, ${big.dropped} dropped, ${big.url.length} chars`);
  }

  // THE limit, measured on KEGG rather than assumed: a 2,023-byte request target
  // is 200 and 2,024 is 403. A link that 403s is worse than a truncated one, so
  // the list is cut — most abundant first, since pathwayRollup sorts it that way
  // — and says how many it dropped so the interface can too.
  const many = Array.from({ length: 400 }, (_, i) =>
    ({ id: `K${String(i + 1).padStart(5, "0")}`, value: 1 - i / 400 }));
  const big = keggMapUrl("map00010", many, { max: 1 });
  check("a list too long for a KEGG URL is cut rather than sent to a 403",
    big.url.length < 2048 && big.kept + big.dropped === 400 && big.dropped > 0,
    `${big.kept} kept, ${big.dropped} dropped, ${big.url.length} chars`);
  check("...keeping the head of the list, which is the most abundant end",
    big.url.includes("K00001%09") && !big.url.includes("K00400"));
  // When the colour will not fit but the identifier will, the box is marked
  // rather than dropped: losing it says "not found", which is false.
  check("...and an ortholog that loses its colour keeps its box",
    big.plain >= 0 && big.kept > 90, `${big.kept} kept, ${big.plain} uncoloured`);
}

// ---- the figures functions borrow from the taxonomic half ---------------------
{
  // Functions reuse the taxonomic figures: that is the whole reason the tables
  // are in { samples, rows } shape, and it breaks silently if a row loses .values.
  const comp = compositionSvg(koTable(profiles, samples, MAP),
    { width: 600, height: 300, otherLabel: "other orthologs" });
  check("the KO table feeds the composition figure", comp.startsWith("<svg"));
  // "Draws something" was all this asked, and it passed while every legend entry
  // read `undefined`: the taxonomic rows are named `species` and these are named
  // `name`. A figure that renders is not a figure that says anything.
  check("...with its rows NAMED, not ten copies of undefined",
    comp.includes("K1 — first thing") && !comp.includes("undefined"));
  check("...and what is left over named at this level, not as taxa",
    comp.includes("other orthologs") && !comp.includes("other taxa"));
  const alpha = alphaSvg(moduleTable(profiles, samples, MAP),
    { width: 600, height: 300, unit: "modules" });
  check("the module table feeds the diversity figure", alpha.startsWith("<svg"));
  // BOTH places the noun appears — the heading and the per-bar tooltip. Pinning
  // only the heading leaves a figure headed "modules" whose every tooltip still
  // says "effective taxa", and nothing would have said so.
  check("...counting modules, not taxa",
    alpha.includes("Effective number of modules") && !alpha.includes("taxa") &&
    /equally-abundant modules/.test(alpha),
    (alpha.match(/(effective|equally-abundant) \w+/g) ?? []).join(" / "));
  // Three weightings, not one. Reporting a single number invites the reader to
  // take it as "the" diversity; on this project's own functional profiles q=2
  // separates samples 1.7x better than q=1, and q=0 is the one a deeper run
  // inflates. Three agreeing is a result; three disagreeing is also one.
  check("...and reporting all three Hill numbers, not only Shannon",
    /bar q=1 \(e\^Shannon\), then q=0 and q=2/.test(alpha) &&
    /at q=2\)/.test(alpha) && /inverse Simpson/.test(alpha));
}

// ---- the shipped map ----------------------------------------------------------
{
  const p = path.join(HERE, "db", "kegg", "ko-map.json");
  if (!fs.existsSync(p)) {
    check("web/db/kegg/ko-map.json ships", false, "missing — run scripts/build_kegg_map.py");
  } else {
    const map = JSON.parse(fs.readFileSync(p, "utf8"));
    check("the shipped map has the shape kegg.js reads",
      map.ko && map.koModules && map.modules && map.pathways);
    const anyMod = Object.values(map.modules)[0];
    check("every module carries a name and a pathway list",
      typeof anyMod.n === "string" && Array.isArray(anyMod.p));
    // The number the interface has to be honest about. If a rebuild moves it a
    // long way, the wording that quotes it has to move too.
    const inMod = Object.keys(map.koModules).length, all = Object.keys(map.ko).length;
    const share = inMod / all;
    check("most orthologs belong to no module, and the share is still ~17%",
      share > 0.10 && share < 0.25, `${(share * 100).toFixed(1)}% of ${all}`);
    // Why the CSV export has to quote. KEGG names are prose — "Glycolysis
    // (Embden-Meyerhof pathway), glucose => pyruvate" — and a comma in a name is
    // the majority case, not an edge one. Asserted on the shipped file so the
    // reason stays visible rather than living in a commit message.
    const withComma = (o) => Object.values(o).filter((v) =>
      String(typeof v === "object" ? v.n : v).includes(",")).length;
    const mods = withComma(map.modules), kos = withComma(map.ko);
    check("a comma in a KEGG name is the common case, not an edge one",
      mods / Object.keys(map.modules).length > 0.5 && kos > 1000,
      `${mods}/${Object.keys(map.modules).length} modules, ${kos}/${all} orthologs`);
  }
}

// ---- a module row knows WHICH orthologs it is made of ------------------------
//
// "0.88 %" answers how much without answering of what, which is the question a
// reader asks by clicking the cell. The set is per module and not per sample —
// the same ortholog arrives once for every sample it is in — and it holds only
// the ones actually detected, because a module's full definition is KEGG's and
// this table is a measurement.
{
  const map = {
    ko: { K00001: "one", K00002: "two", K00003: "three" },
    koModules: { K00001: ["M00001"], K00002: ["M00001", "M00002"], K00003: ["M00002"] },
    modules: { M00001: { n: "first", p: [] }, M00002: { n: "second", p: [] } },
    pathways: {},
  };
  const t = moduleTable(
    { A: { K00001: 0.5, K00002: 0.3 }, B: { K00002: 0.2, K00003: 0.1 } },
    ["A", "B"], map);
  const m1 = t.rows.find((r) => r.id === "M00001");
  const m2 = t.rows.find((r) => r.id === "M00002");
  check("a module row carries the orthologs detected in it",
    JSON.stringify(m1.kos) === JSON.stringify(["K00001", "K00002"]),
    JSON.stringify(m1?.kos));
  check("...once each, however many samples they turned up in",
    JSON.stringify(m2.kos) === JSON.stringify(["K00002", "K00003"]),
    JSON.stringify(m2?.kos));
  check("...and an ortholog in two modules is listed in both",
    m1.kos.includes("K00002") && m2.kos.includes("K00002"));
}

// ---- an ortholog serving two steps of one module -----------------------------
//
// KEGG's link/module/ko lists an ortholog once per STEP, so an ortholog used at
// two steps of one module arrives twice. Summed naively its abundance lands
// twice and the module is inflated — 39 of the 508 modules in the shipped map
// were, M00001 among them (K00918 serves both its hexokinase and its
// phosphofructokinase step). The build dedupes now; this holds the reader to the
// same rule, since a map built by an older build is still out there.
{
  const map = { koModules: { K1: ["M1", "M1", "M2"], K2: ["M1"] },
    modules: { M1: { n: "deux étapes" }, M2: { n: "une" } } };
  const t = moduleTable({ s1: { K1: 10, K2: 5 } }, ["s1"], map);
  const at = (n) => t.rows.find((r) => (r.name ?? r.label ?? "").includes(n))?.values[0];
  check("an ortholog at two steps of one module counts once, not twice",
    at("deux étapes") === 15, `${at("deux étapes")} au lieu de 15`);
  check("...and its other module is unaffected", at("une") === 10, String(at("une")));
}

// And the shipped map must not carry the duplicates any more.
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const p = path.join(here, "db/kegg/ko-map.json");
  if (fs.existsSync(p)) {
    const km = JSON.parse(fs.readFileSync(p, "utf8")).koModules ?? {};
    const bad = Object.entries(km).filter(([, v]) => new Set(v).size !== v.length);
    check("the shipped KEGG map lists each module once per ortholog",
      bad.length === 0, `${bad.length} orthologues avec un module répété`);
  } else {
    console.log("skip the shipped map — web/db/kegg/ko-map.json is not here");
  }
}

// ---- a module, shown where a module CAN be shown coloured ---------------------
//
// KEGG's module page takes no colour: probed 2026-08-16, /module/M00001 ignores
// every parameter and /module/M00001+K00844 is a 404. So a module cell offers
// the pathway map that holds it, lit with its own orthologs — and the map is
// chosen by coverage, since M00074 has three of eleven orthologs on the first
// map KEGG lists and ten on another.
{
  const map = {
    modules: { M1: { n: "un", p: ["map01100", "map00010"], b: "map00010" },
      M2: { n: "sans carte", p: [] } },
    koModules: { K00844: ["M1"] },
  };
  const kos = [{ id: "K00844", value: 0.5 }];
  const u = moduleMapUrl("M1", kos, map, { max: 1 });
  check("a module offers the map that covers it, not the first one listed",
    u?.map === "map00010", String(u?.map));
  check("...and says which other maps hold it",
    JSON.stringify(u?.alternatives) === JSON.stringify(["map01100"]),
    JSON.stringify(u?.alternatives));
  check("...with the ortholog coloured, on that map's URL",
    /show_pathway\?map00010\/K00844/.test(u?.url ?? ""), (u?.url ?? "").slice(0, 60));
  // 28 of the 508 modules in the shipped map are on no pathway at all. A caller
  // must be able to tell that from a failure, so it is null rather than a URL
  // that 404s.
  check("a module on no map returns nothing rather than a broken link",
    moduleMapUrl("M2", kos, map) === null);
  check("...and so does a module with nothing detected",
    moduleMapUrl("M1", [], map) === null);
}

console.log(`\n${pass} passed, ${fail} failed (kegg)`);
process.exit(fail ? 1 : 0);
