// Which samples belong together — and where that answer comes from.
//
// Three figures read groups: the ordination colours by them, the contrast plot
// is ABOUT them, and the composition legend borrows them. Until now there was
// exactly one way to supply them — a two-column CSV the reader had to write in
// another program — which is a strange thing to demand of a page whose whole
// argument is that you should not have to install anything.
//
// So there are three ways now, and this file holds the part of all three that is
// arithmetic rather than interface:
//
//   · a CSV, as before (parseMetadata, in multi.js — it predates this file);
//   · a FIELD of the archive's own metadata, for runs that came from the ENA:
//     the answer to "group by sex" is already in the session and nobody should
//     have to retype it;
//   · groups the reader makes here, sample by sample.
//
// Pure functions, no DOM, no fetch — the same contract as figures.js and
// kegg.js, and for the same reason: every rule below can be checked in plain
// node, and the page is then only responsible for drawing what they return.

/**
 * The metadata fields worth grouping by, best first.
 *
 * A field is only useful as a grouping if it SPLITS the samples: one value for
 * everything groups nothing, and a distinct value per sample groups nothing
 * either — it just renames them. Both extremes are common in real archive
 * metadata (`country` is one value, `sample_accession` is eighteen), so both are
 * dropped rather than offered and then found useless.
 *
 * Ordered by how balanced the split is, because a 9-and-9 split is a comparison
 * and a 17-and-1 is an outlier with a label. Ties break on the field name so the
 * list does not reshuffle between renders.
 */
export function groupFields(samples, metaOf) {
  const out = [];
  const names = new Set();
  for (const s of samples ?? []) {
    for (const k of Object.keys(metaOf?.(s) ?? {})) names.add(k);
  }
  for (const name of names) {
    const counts = new Map();
    let missing = 0;
    for (const s of samples) {
      const v = metaOf(s)?.[name];
      const text = v == null ? "" : String(v).trim();
      if (!text) { missing++; continue; }
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
    const n = counts.size;
    if (n < 2 || n >= samples.length) continue;
    // How even the split is: 1 when every group is the same size, near 0 when
    // one group holds everything. Plain and explainable — the alternative was
    // entropy, which orders these the same way and needs a paragraph.
    const sizes = [...counts.values()];
    const balance = Math.min(...sizes) / Math.max(...sizes);
    out.push({ name, values: n, missing, balance });
  }
  out.sort((a, b) => b.balance - a.balance || a.values - b.values ||
    String(a.name).localeCompare(String(b.name)));
  return out;
}

/** sample -> that field's value, skipping the samples where it is blank. */
export function groupsFromField(samples, metaOf, field) {
  const out = new Map();
  for (const s of samples ?? []) {
    const v = metaOf?.(s)?.[field];
    const text = v == null ? "" : String(v).trim();
    if (text) out.set(s, text);
  }
  return out;
}

/**
 * The groups a map actually describes, largest first, with their sizes.
 *
 * Used by the editor to list what exists and by the contrast picker to offer it,
 * from ONE function so the two cannot disagree about what a group is.
 */
export function groupList(samples, groups) {
  const counts = new Map();
  for (const s of samples ?? []) {
    const g = groups?.get(s);
    if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([name, n]) => ({ name, n }));
}

/**
 * Assign a sample to a group, or to none.
 *
 * Returns a NEW map rather than mutating: the caller keeps the old one to
 * compare against, and a figure redrawn from a map that changed under it is the
 * class of bug where the picture and the legend disagree.
 *
 * A blank name removes the sample from every group, which is the only way back
 * out of a grouping made by mistake.
 */
export function assignGroup(groups, sample, name) {
  const next = new Map(groups ?? []);
  const text = String(name ?? "").trim();
  if (text) next.set(sample, text);
  else next.delete(sample);
  return next;
}

/**
 * What a grouping is worth saying about itself, in one sentence.
 *
 * The two failures this catches are the ones that produce a figure that looks
 * broken rather than one that says why: a CSV whose names match nothing, and a
 * grouping too thin to contrast (one group, or two groups of one). Both are
 * quiet — the plot simply comes out one colour, or the contrast refuses — so the
 * sentence is written wherever the grouping is chosen.
 */
export function groupSummary(samples, groups) {
  const total = (samples ?? []).length;
  const list = groupList(samples, groups);
  const placed = list.reduce((a, g) => a + g.n, 0);
  if (!total) return "";
  if (!placed) {
    return groups?.size
      ? "no sample on screen matches any of those group names"
      : "no groups yet — every sample is on its own";
  }
  const contrastable = list.filter((g) => g.n >= 2).length;
  const parts = [`${list.length} group${list.length === 1 ? "" : "s"}, ` +
    `${placed} of ${total} samples`];
  if (placed < total) parts.push(`${total - placed} ungrouped`);
  if (contrastable < 2) {
    // The contrast plot needs two groups of at least two, and a reader who has
    // just made one group of six deserves to be told that before they go looking
    // for the figure.
    parts.push(contrastable === 0
      ? "none has two samples, so nothing can be contrasted yet"
      : "only one group has two or more samples — a contrast needs two");
  }
  return parts.join(" · ");
}

// ---- the file the groups can arrive in, and leave in ------------------------
//
// parseMetadata predates this file and lived in multi.js, next to the input it
// was called from — which is why the writer that has to match it grew up in
// multi.js too. They are arithmetic, they are a matched pair, and what they
// have to agree about (quoting, the header, which separators count) is exactly
// the kind of rule that is checkable in plain node and invisible on screen.

// Two columns, any separator, header optional. Deliberately forgiving: the point
// is to colour a plot, and refusing a file over a stray quote would be a worse
// outcome than ignoring a row.
export function splitDelimited(line) {
  // The delimiter this line actually uses, then a quote-aware split of it. The
  // old version split on /[\t,;]/ and stripped the quotes afterwards, which is
  // fine until a group is called "Crohn's, active" — and this page now WRITES
  // that file, so it has to be able to read back what it wrote.
  const sep = line.includes("\t") ? "\t" : line.includes(",") ? "," : ";";
  const cells = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false; }
      else cur += c;
    } else if (c === '"' && !cur.trim()) { quoted = true; cur = ""; }
    else if (c === sep) { cells.push(cur); cur = ""; }
    else cur += c;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** One cell of a CSV this page writes, quoted only when it has to be. */
export function csvCell(v) {
  const text = String(v ?? "");
  return /["\n\r,;\t]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function parseMetadata(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const cells = splitDelimited(line);
    if (cells.length < 2 || !cells[0] || !cells[1]) continue;
    // The header this page writes, skipped so a file that made a round trip does
    // not come back carrying a sample called "sample". Any other header is left
    // alone: it names no sample in the run, so it colours nothing.
    if (!out.size && cells[0].toLowerCase() === "sample" &&
        cells[1].toLowerCase() === "group") continue;
    out.set(cells[0], cells[1]);
  }
  return out;
}

/**
 * sample,group — the file parseMetadata reads, written from what is on screen.
 *
 * Every sample of the run, including the ungrouped ones: a file that silently
 * dropped them would come back as a run with fewer samples than it has, and the
 * blank is the honest answer to "which arm is this one in".
 */
export function groupsCsvFrom(samples, groups) {
  const lines = ["sample,group"];
  for (const s of samples ?? []) lines.push(`${csvCell(s)},${csvCell(groups?.get(s) ?? "")}`);
  return lines.join("\n") + "\n";
}
