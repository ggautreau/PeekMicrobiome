// web/table-view.js — searching and sorting a matrix of hundreds of rows.
//
//   node web/table-view.test.mjs
//
// The rules that matter are the ones a reader would notice only as strangeness:
// a search that looks in one column and not the other, a sort that reshuffles
// rows it did not touch, a third click that does not take them back.

import { arrangeRows, arrangeNote, nextSort } from "./table-view.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ROWS = [
  { species: "Phocaeicola dorei", genome: "MGYG000002478", values: [6.2, 1.1, 0] },
  { species: "Bacteroides uniformis", genome: "MGYG000001234", values: [5.0, 9.9, 0] },
  { species: "Agathobacter rectalis", genome: "MGYG000002492", values: [2.4, 0, 0] },
  { species: "Prevotella copri", genome: "MGYG000000999", values: [0, 0, 0] },
];

// ---- searching ---------------------------------------------------------------
check("a search matches the name",
  arrangeRows(ROWS, { find: "bacteroides" }).rows.length === 1);
// The reader has one of the two in mind and no way to know which column the page
// keeps it in.
check("...and the identifier, which is the same question from the other side",
  arrangeRows(ROWS, { find: "MGYG000002492" }).rows[0]?.species === "Agathobacter rectalis");
check("...case does not matter", arrangeRows(ROWS, { find: "PREVOTELLA" }).rows.length === 1);
check("...a partial word matches", arrangeRows(ROWS, { find: "phoca" }).rows.length === 1);
check("...and whitespace either side is not part of the search",
  arrangeRows(ROWS, { find: "  copri  " }).rows.length === 1);
check("an empty search keeps everything, in the order it came in",
  arrangeRows(ROWS, { find: "" }).rows.length === 4 &&
  arrangeRows(ROWS).rows[0].species === "Phocaeicola dorei");
{
  const st = arrangeRows(ROWS, { find: "bacteroides" });
  check("...and the count says what was taken out",
    st.total === 4 && st.hidden === 3 && st.rows.length === 1,
    JSON.stringify({ total: st.total, hidden: st.hidden }));
}

// ---- sorting -----------------------------------------------------------------
{
  const byB = arrangeRows(ROWS, { sortCol: 1 }).rows.map((r) => r.species);
  check("sorting by a sample puts that sample's largest first",
    byB[0] === "Bacteroides uniformis" && byB[1] === "Phocaeicola dorei", byB.join(" > "));
  const asc = arrangeRows(ROWS, { sortCol: 1, sortDir: "asc" }).rows.map((r) => r.species);
  check("...and ascending is the same list the other way up",
    asc[asc.length - 1] === "Bacteroides uniformis", asc.join(" > "));
}
// Three hundred zeroes in the chosen column must not come back in an order that
// depends on the engine: re-sorting the same data twice would reshuffle rows
// that did not change, which reads as the table moving on its own.
{
  const tied = arrangeRows(ROWS, { sortCol: 2 }).rows.map((r) => r.species);
  const again = arrangeRows(ROWS, { sortCol: 2 }).rows.map((r) => r.species);
  check("ties break on the name, so the same data sorts the same way twice",
    JSON.stringify(tied) === JSON.stringify(again) &&
    tied[0] === "Agathobacter rectalis", tied.join(" > "));
}
check("a row with no value in that column counts as zero, not as missing",
  arrangeRows([{ species: "a", values: [1] }, { species: "b", values: [] }],
    { sortCol: 0 }).rows[0].species === "a");
check("searching and sorting compose",
  arrangeRows(ROWS, { find: "MGYG", sortCol: 1 }).rows[0].species === "Bacteroides uniformis");

// ---- the third click ---------------------------------------------------------
//
// Without it a reader who sorted by one sample has no way back to the ranking
// the matrix opened with, short of reloading the page.
{
  let st = null;
  st = nextSort(st, 2);
  check("a first click sorts that column, largest first", st.col === 2 && st.dir === "desc");
  st = nextSort(st, 2);
  check("...a second reverses it", st.col === 2 && st.dir === "asc");
  st = nextSort(st, 2);
  check("...and a third gives the table its own order back", st.col === null);
  st = nextSort({ col: 2, dir: "asc" }, 5);
  check("clicking another column starts that one over, largest first",
    st.col === 5 && st.dir === "desc");
}

// ---- what the line beside the box says ---------------------------------------
check("with no search the line is just the count",
  arrangeNote(arrangeRows(ROWS), "species") === "4 species");
check("with a search it says how many of how many",
  arrangeNote(arrangeRows(ROWS, { find: "MGYG0000024" }), "species") === "2 of 4 species",
  arrangeNote(arrangeRows(ROWS, { find: "MGYG0000024" }), "species"));
// An empty table with "0 of 468" reads as a broken page; a sentence reads as an
// answer.
check("and a search that matches nothing says so in words",
  arrangeNote(arrangeRows(ROWS, { find: "zzz" }), "species") === "nothing matches that search");
check("an empty table says nothing at all",
  arrangeNote(arrangeRows([]), "species") === "");

console.log(`\n${pass} passed, ${fail} failed (table-view)`);
process.exit(fail ? 1 : 0);
