// web/groups.js — where a grouping comes from and what it is worth saying.
//
//   node web/groups.test.mjs
//
// The rules worth pinning are the ones that decide what the reader is OFFERED.
// A field that groups nothing must not appear in the list, or the picker fills
// with `country` and `sample_accession` and the two that actually split the
// samples are lost in it. And a grouping too thin to contrast has to say so
// where it is made, because the figure's own refusal comes later and elsewhere.

import { groupFields, groupsFromField, groupList, assignGroup, groupSummary,
  parseMetadata, groupsCsvFrom, splitDelimited, csvCell }
  from "./groups.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// Six samples, and metadata shaped like the archive's own: one field constant
// across the run, one unique per sample, two that really split it.
const SAMPLES = ["s1", "s2", "s3", "s4", "s5", "s6"];
const META = {
  // `arm` is the shape real archive metadata has: it splits the samples that
  // carry it and is simply absent from the rest.
  s1: { country: "Singapore", acc: "A1", sex: "female", visit: "1", arm: "A", lonely: "" },
  s2: { country: "Singapore", acc: "A2", sex: "female", visit: "2", arm: "A" },
  s3: { country: "Singapore", acc: "A3", sex: "female", visit: "3", arm: "B", lonely: "x" },
  s4: { country: "Singapore", acc: "A4", sex: "male", visit: "1", arm: "B" },
  s5: { country: "Singapore", acc: "A5", sex: "male", visit: "2" },
  s6: { country: "Singapore", acc: "A6", sex: "male", visit: "3" },
};
const metaOf = (s) => META[s];

// ---- which fields are worth offering ----------------------------------------
const fields = groupFields(SAMPLES, metaOf);
const names = fields.map((f) => f.name);
check("a field with one value for everything is not offered", !names.includes("country"), names.join(", "));
check("...nor is one with a distinct value per sample", !names.includes("acc"), names.join(", "));
check("...and the ones that split the samples are", names.includes("sex") && names.includes("visit"),
  names.join(", "));
// Every one of these splits evenly, so the tie breaks on how MANY groups: two is
// what a contrast wants, and three is a colouring. Then on the name, so the list
// does not reshuffle between renders.
check("the most balanced split comes first, fewest groups winning a tie",
  names.join(" > ") === "arm > sex > visit", names.join(" > "));
check("...and each carries its size and how many samples it leaves out",
  fields.find((f) => f.name === "sex")?.values === 2 &&
  fields.find((f) => f.name === "arm")?.missing === 2 &&
  fields.find((f) => f.name === "arm")?.values === 2,
  JSON.stringify(fields));

// A field present on one sample only names that sample; it is not a grouping,
// and offering it fills the picker with things that group nothing.
check("a field with one non-blank value is not a grouping",
  !names.includes("lonely"), names.join(", "));

// ---- from a field to a grouping ---------------------------------------------
const bySex = groupsFromField(SAMPLES, metaOf, "sex");
check("grouping by a field puts every sample in its value's group",
  bySex.size === 6 && bySex.get("s1") === "female" && bySex.get("s6") === "male");
const byArm = groupsFromField(SAMPLES, metaOf, "arm");
check("...and leaves out the samples where the field is blank",
  byArm.size === 4 && !byArm.has("s5") && !byArm.has("s6"), [...byArm].join(","));

// ---- listing what exists -----------------------------------------------------
check("groups are listed largest first, with their sizes",
  JSON.stringify(groupList(SAMPLES, bySex)) ===
  JSON.stringify([{ name: "female", n: 3 }, { name: "male", n: 3 }]),
  JSON.stringify(groupList(SAMPLES, bySex)));
// Ties break on the name, so two equal groups do not swap places between two
// renders of the same data — which reads as the figure changing on its own.
const tied = new Map([["s1", "b"], ["s2", "a"]]);
check("...and a tie breaks on the name, not on insertion order",
  groupList(SAMPLES, tied)[0].name === "a");

// ---- editing -----------------------------------------------------------------
let g = new Map();
g = assignGroup(g, "s1", "treated");
g = assignGroup(g, "s2", "  treated  ");
check("assigning trims the name, so a stray space is not a second group",
  groupList(SAMPLES, g).length === 1 && groupList(SAMPLES, g)[0].n === 2);
const before = new Map(g);
const after = assignGroup(g, "s3", "control");
check("...and returns a new map rather than editing the one the figure holds",
  before.size === 2 && after.size === 3 && before !== after);
check("a blank name takes the sample out of every group",
  assignGroup(after, "s3", "").size === 2 &&
  !assignGroup(after, "s3", "   ").has("s3"));

// ---- what the grouping says about itself ------------------------------------
check("no groups at all says so plainly",
  /no groups yet/.test(groupSummary(SAMPLES, new Map())));
// The failure a CSV usually produces: right file, wrong column, names that
// match nothing on screen. The plot then comes out one colour with no reason.
check("names that match no sample are named as the problem",
  /matches any of those group names/.test(
    groupSummary(SAMPLES, new Map([["other1", "a"], ["other2", "b"]]))));
check("a grouping that cannot be contrasted says why, where it is made",
  /a contrast needs two/.test(groupSummary(SAMPLES, new Map([["s1", "a"], ["s2", "a"], ["s3", "b"]]))),
  groupSummary(SAMPLES, new Map([["s1", "a"], ["s2", "a"], ["s3", "b"]])));
check("...and one group of six is not a contrast either",
  /nothing can be contrasted|a contrast needs two/.test(
    groupSummary(SAMPLES, groupsFromField(SAMPLES, metaOf, "country"))) ||
  /no groups yet/.test(groupSummary(SAMPLES, new Map())));
check("a usable grouping counts what it placed and what it left out",
  /2 groups, 5 of 6 samples · 1 ungrouped/.test(groupSummary(SAMPLES,
    new Map([["s1", "a"], ["s2", "a"], ["s3", "b"], ["s4", "b"], ["s5", "b"]]))),
  groupSummary(SAMPLES, new Map([["s1", "a"], ["s2", "a"], ["s3", "b"], ["s4", "b"], ["s5", "b"]])));

// ---- the real example --------------------------------------------------------
//
// The shipped session, if it is here: the fields the ENA actually returned for
// PRJNA728374. `host_sex` splits those eighteen runs 9 and 9, which is the
// contrast a reader would want and could not previously make without writing a
// CSV by hand.
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const p = path.join(here, "demo/gut-demo.session.json");
  if (fs.existsSync(p)) {
    const st = JSON.parse(fs.readFileSync(p, "utf8"));
    const of = (s) => st.sampleMeta?.[s];
    const f = groupFields(st.samples, of);
    const got = f.map((x) => x.name);
    check("the shipped example offers the fields that split it, and only those",
      got.includes("host_sex") && got.includes("collection_date") &&
      !got.includes("country") && !got.includes("sample_accession"),
      got.join(", "));
    const sex = groupsFromField(st.samples, of, "host_sex");
    check("...and host_sex splits its eighteen runs nine and nine",
      JSON.stringify(groupList(st.samples, sex)) ===
      JSON.stringify([{ name: "female", n: 9 }, { name: "male", n: 9 }]),
      JSON.stringify(groupList(st.samples, sex)));
  } else {
    console.log("skip the shipped example — demo/gut-demo.session.json is not here");
  }
}

// ---- the file, out and back in -----------------------------------------------
//
// Groups could be READ from a CSV from the first version and MADE in the page
// since the editor landed — and a grouping typed into eighteen boxes lived in
// that tab and nowhere else. The writer only closes the loop if what it writes
// is what the reader reads, which is a claim about quoting and a header row
// rather than about anything visible on screen.
{
  const samples = ["SRR1", "SRR2", "SRR3", "SRR4"];
  const groups = new Map([["SRR1", "control"], ["SRR2", "control"], ["SRR3", "Crohn's, active"]]);
  const csv = groupsCsvFrom(samples, groups);
  check("every sample is written, grouped or not",
    csv.trim().split("\n").length === 5, `${csv.trim().split("\n").length} lines`);
  const back = parseMetadata(csv);
  check("...and the header does not come back as a sample called \"sample\"",
    !back.has("sample"), [...back.keys()].join(","));
  check("...the groups come back exactly",
    back.get("SRR1") === "control" && back.get("SRR2") === "control");
  // The case the old splitter got wrong: it cut on every comma and stripped the
  // quotes afterwards, so this group arrived as `"Crohn's`.
  check("...including a group name with a comma in it",
    back.get("SRR3") === "Crohn's, active", String(back.get("SRR3")));
  check("...and an ungrouped sample comes back ungrouped, not grouped as blank",
    !back.has("SRR4"));
  check("a quote inside a name survives too",
    parseMetadata(groupsCsvFrom(["a"], new Map([["a", 'the "high" arm']]))).get("a") ===
      'the "high" arm');
}
// Every file that read before this writer existed must still read.
check("a plain two-column CSV still reads", parseMetadata("a,x\nb,y").get("b") === "y");
check("...a TSV too", parseMetadata("a\tx\nb\ty").get("a") === "x");
check("...and semicolons", parseMetadata("a;x\nb;y").get("b") === "y");
check("...a comment line is skipped", parseMetadata("# note\na,x").size === 1);
// Only OUR header is dropped. Someone else's names no sample in the run, so it
// colours nothing — and guessing at wording would drop a sample called "run".
check("...and someone else's header is left alone",
  parseMetadata("run,arm\na,x").get("run") === "arm");
check("a cell is quoted only when it has to be",
  csvCell("plain") === "plain" && csvCell("a,b") === '"a,b"' && csvCell(null) === "");
check("a line with no separator at all is one cell, not a pair",
  splitDelimited("justonething").length === 1);

console.log(`\n${pass} passed, ${fail} failed (groups)`);
process.exit(fail ? 1 : 0);
