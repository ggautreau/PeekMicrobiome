// Finding a row in a matrix of four hundred and sixty-eight.
//
// The abundance matrix is 468 species by 18 samples on the shipped example, and
// until now it could be neither searched nor sorted: a reader looking for
// Bifidobacterium scrolled for it, and "which species dominate THIS sample"
// could not be asked at all, because the rows are ordered by the total across
// every sample and by nothing else.
//
// Both of those are one function: take the rows, a search string and a column,
// give back the rows to draw. Pure, so the rules — what a search matches, what
// happens to ties, what "no matches" means — can be checked in plain node rather
// than by squinting at a table.

/**
 * The rows to draw, in the order to draw them.
 *
 *   find     matches the NAME and the IDENTIFIER, case-insensitively. Both,
 *            because a reader has one or the other in mind and no way to know
 *            which column the page keeps it in — "MGYG000002478" and
 *            "Phocaeicola" are the same question asked from two directions.
 *   sortCol  index into `samples`, or null for the table's own order. The own
 *            order is the total across samples, which is what the matrix has
 *            always been sorted by and stays the default.
 *   sortDir  "desc" or "asc".
 *
 * Returns `{ rows, hidden, total }` — hidden is what the search took out, so the
 * page can say "12 of 468" instead of silently showing a shorter table.
 */
export function arrangeRows(rows, { find = "", sortCol = null, sortDir = "desc" } = {}) {
  const all = rows ?? [];
  const needle = String(find ?? "").trim().toLowerCase();
  const kept = needle
    ? all.filter((r) => {
      const name = String(r.species ?? r.name ?? r.label ?? "").toLowerCase();
      const id = String(r.genome ?? r.id ?? "").toLowerCase();
      return name.includes(needle) || id.includes(needle);
    })
    : all.slice();

  if (sortCol != null && Number.isFinite(sortCol)) {
    const at = (r) => Number(r.values?.[sortCol] ?? 0);
    // A stable sort with an explicit tie-break on the name: a table of 468 rows
    // where 300 are zero in the chosen column would otherwise come back in an
    // order that depends on the engine, and re-sorting the same data twice would
    // reshuffle rows that did not change.
    kept.sort((a, b) => {
      const d = sortDir === "asc" ? at(a) - at(b) : at(b) - at(a);
      if (d) return d;
      return String(a.species ?? a.name ?? "").localeCompare(String(b.species ?? b.name ?? ""));
    });
  }
  return { rows: kept, hidden: all.length - kept.length, total: all.length };
}

/**
 * What to write beside the search box.
 *
 * Says the whole state in one line, and says it differently when the search
 * matches nothing — an empty table with a count of "0 of 468" reads as a broken
 * page, where "no row matches «xyz»" reads as an answer.
 */
export function arrangeNote(state, unit = "rows") {
  const { rows, hidden, total } = state;
  if (!total) return "";
  // "nothing", not a singularised unit: `"species".replace(/s$/, "")` gives
  // "specie", and every rule that guesses English plurals gets one of them
  // wrong. The sentence does not need the noun.
  if (!rows.length) return "nothing matches that search";
  // "en-US", not the reader's locale: the page is written in English and says
  // "13,509" everywhere else, and a browser set to French printed "4 307" here
  // beside it.
  const n = (x) => x.toLocaleString("en-US");
  if (!hidden) return `${n(total)} ${unit}`;
  return `${n(rows.length)} of ${n(total)} ${unit}`;
}

/**
 * The next sort state when a column header is clicked.
 *
 * Three states rather than two: descending, ascending, then back to the table's
 * own order. Without the third, a reader who sorted by one sample has no way
 * back to the ranking the matrix opened with except reloading the page.
 */
export function nextSort(current, col) {
  if (current?.col !== col) return { col, dir: "desc" };
  if (current.dir === "desc") return { col, dir: "asc" };
  return { col: null, dir: "desc" };
}
