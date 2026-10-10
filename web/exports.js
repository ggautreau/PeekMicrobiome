// Writing the matrix in formats other tools already read.
//
// The native TSV is the honest one — one row per genome, the reference named in
// the header — but nothing downstream reads it. CroCoDeEL refused it outright
// over duplicate species names, and phyloseq, QIIME and the rest each expect
// something specific. These two cover most of what people actually feed things
// into.
//
// No DOM: strings in, a string out, so what is asserted in the bench is exactly
// what lands on disk.

const MPA_RANKS = [
  // GTDB says d__ where MetaPhlAn says k__. Everything downstream that parses
  // these strings splits on "|" and reads the two-letter prefix, so emitting
  // d__ would silently drop the top level in tools that only know k__.
  ["d", "k"], ["p", "p"], ["c", "c"], ["o", "o"], ["f", "f"], ["g", "g"],
];

/**
 * Refuse a table these two formats cannot be written from.
 *
 * Both are written from the PER-GENOME table, the one row per genome the
 * matrix is at species rank, because both rebuild the lineage from the genome.
 * Handed the page's view aggregated to a higher rank, whose rows are "12
 * genomes" of a genus, they found no lineage for "12 genomes", wrote every
 * genus as a species of its own with nothing above it, and gave a BIOM whose
 * observation IDs were "1 genome" over and over — a file biom-format refuses
 * outright and every other reader takes at face value. An error here is the
 * difference between no file and a wrong one.
 */
function perGenomeRows(table, format) {
  const rows = table?.rows ?? [];
  const bad = rows.find((r) => !r?.genome || /^\d+ genomes?$/.test(String(r.genome)));
  if (bad) {
    throw new Error(`${format} is written from the per-genome table, at species rank — ` +
      `this one has a row "${bad.genome ?? bad.species ?? "?"}", aggregated above species or ` +
      `with no genome`);
  }
  return rows;
}

/**
 * MetaPhlAn-style profile: one row per clade, abundances CUMULATIVE up the
 * lineage, tab separated.
 *
 * Cumulative is the part that matters and the part that is easy to get wrong: a
 * phylum's value is the sum of everything under it, not a number of its own.
 * Tools that read these files rely on it — a table whose k__Bacteria row is 0
 * because nothing was assigned exactly there is not a MetaPhlAn profile.
 *
 * `lineageOf(genome)` returns { d, p, c, o, f, g } (any may be empty) and
 * `speciesOf(genome)` the species name. Rows whose genome has no lineage are
 * still emitted at the levels they do have; a genome with none at all is
 * dropped, since a clade string of nothing but separators names no clade.
 */
export function toMetaphlan(table, { lineageOf, speciesOf, header = [] } = {}) {
  const { samples } = table;
  const rows = perGenomeRows(table, "A MetaPhlAn profile");
  // clade -> per-sample sums.
  const clades = new Map();
  const add = (clade, values) => {
    let e = clades.get(clade);
    if (!e) { e = new Float64Array(samples.length); clades.set(clade, e); }
    for (let i = 0; i < samples.length; i++) e[i] += values[i] || 0;
  };

  // THE SPECIES LEVEL IS ONE ROW PER GENOME, never a sum of genomes that share
  // a name. GTDB gives one name to several representative genomes, and the
  // rank fallbacks give "Collinsella sp." to dozens: summed under one s__, they
  // became one species with an abundance no organism has — 468 genomes of the
  // example came out as 453 species. The caller is expected to hand in names
  // that are already unique (the page's speciesLabel appends the accession to
  // an ambiguous one); every genome whose clade would still collide with
  // another's gets its accession appended here, the same way — all of them,
  // not all but the first, so no one of them reads as the species.
  const lineages = rows.map((r) => {
    const lin = lineageOf?.(r.genome) ?? {};
    const parts = [];
    for (const [gtdb, mpa] of MPA_RANKS) {
      const v = lin[gtdb];
      if (v) parts.push(`${mpa}__${String(v).replace(/\s+/g, "_")}`);
    }
    const sp = speciesOf?.(r.genome) || r.species;
    const clade = sp ? [...parts, `s__${String(sp).replace(/\s+/g, "_")}`].join("|") : null;
    return { parts, sp, clade };
  });
  const seen = new Map();
  for (const l of lineages) if (l.clade) seen.set(l.clade, (seen.get(l.clade) ?? 0) + 1);

  rows.forEach((r, i) => {
    const { parts, sp, clade } = lineages[i];
    // Every prefix of the lineage is a clade, and each carries the total of
    // what sits beneath it.
    for (let k = 1; k <= parts.length; k++) add(parts.slice(0, k).join("|"), r.values);
    if (!clade) return;
    add(seen.get(clade) > 1
      ? [...parts, `s__${String(`${sp} [${r.genome}]`).replace(/\s+/g, "_")}`].join("|")
      : clade, r.values);
  });

  // Shallow clades first, then alphabetically — the order MetaPhlAn emits, and
  // the one that makes a file readable by eye.
  const names = [...clades.keys()].sort((a, b) => {
    const da = a.split("|").length, db = b.split("|").length;
    return da - db || a.localeCompare(b);
  });

  // The column header is NOT a comment. MetaPhlAn's merged tables write it as a
  // plain `clade_name` line after their `#` lines, and the usual way to read
  // these files — pandas.read_csv(comment="#") — drops a `#clade_name` header
  // with the comments and takes the first clade, k__Archaea, for the column
  // names.
  const lines = [
    ...header.map((h) => `#${h}`),
    `clade_name\t${samples.join("\t")}`,
  ];
  for (const name of names) {
    lines.push(`${name}\t${[...clades.get(name)].map((v) => v.toFixed(5)).join("\t")}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * BIOM 1.0, the JSON one.
 *
 * Not the HDF5 of BIOM 2.x: that needs a binary writer and a library, and every
 * reader that takes 2.x also takes 1.0. Dense rather than sparse — a profile is
 * mostly zeros, but a few hundred rows by a few hundred samples is small enough
 * that the sparse form's index arithmetic costs more than it saves.
 */
export function toBiom(table, { lineageOf, speciesOf, generatedBy = "PeekMicrobiome", date,
  columnMeta = () => null } = {}) {
  const { samples } = table;
  const rows = perGenomeRows(table, "A BIOM table");
  const ids = new Set(rows.map((r) => r.genome));
  if (ids.size !== rows.length) throw new Error("A BIOM table needs one row per genome; two rows share one");
  // A float matrix written as floats. JSON.stringify writes 0 and 3 as integers,
  // and `biom validate-table` refuses integers in a matrix that declares itself
  // "float" — so the cells are written by hand: six decimals, as before, then
  // trailing zeros dropped down to one ("0.0", "12.5").
  const cell = (v) => {
    const t = (Number.isFinite(v) ? v : 0).toFixed(6).replace(/0+$/, "");
    return t.endsWith(".") ? `${t}0` : t;
  };
  const DATA = "\u0000data\u0000";
  const text = JSON.stringify({
    id: null,
    format: "1.0.0",
    format_url: "http://biom-format.org",
    type: "OTU table",
    generated_by: generatedBy,
    // Injected rather than read from the clock, so the same table gives the same
    // file — a diff between two exports should show the numbers, not the second
    // they were written in.
    date: biomDate(date),
    matrix_type: "dense",
    matrix_element_type: "float",
    shape: [rows.length, samples.length],
    rows: rows.map((r) => {
      const lin = lineageOf?.(r.genome) ?? {};
      const taxonomy = [];
      for (const [gtdb, mpa] of MPA_RANKS) {
        taxonomy.push(lin[gtdb] ? `${mpa}__${lin[gtdb]}` : `${mpa}__`);
      }
      const sp = speciesOf?.(r.genome) || r.species;
      taxonomy.push(sp ? `s__${sp}` : "s__");
      return { id: r.genome, metadata: { taxonomy } };
    }),
    // A column's metadata is null unless there is something to say about it — so
    // far, only that it was profiled on fewer reads than its input holds.
    columns: samples.map((s) => ({ id: s, metadata: columnMeta(s) ?? null })),
    data: DATA,
  }, null, 1);
  const data = "[\n" + rows.map((r) => `  [${samples.map((_, i) => cell(r.values[i] || 0)).join(",")}]`)
    .join(",\n") + "\n ]";
  return text.replace(JSON.stringify(DATA), data);
}

/**
 * The date in the one shape `biom validate-table` accepts: ISO 8601 to the
 * second, with no fraction and no zone — "2026-10-10T14:08:09". The page hands
 * in `new Date().toISOString()`, whose milliseconds and "Z" the validator
 * refused, so it is normalised here, whatever arrives: a Date, a string, or
 * nothing (the epoch, so the same table gives the same file).
 */
function biomDate(date) {
  const d = date instanceof Date ? date : new Date(date ?? 0);
  return (Number.isFinite(d.getTime()) ? d : new Date(0)).toISOString().slice(0, 19);
}

/**
 * sylph's own TSV, as `sylph profile` would have written it for the whole batch.
 *
 * Not reconstructed from the parsed matrix — every column sylph emits is kept,
 * including the ones this page never looks at (Eff_lambda, Containment_ind,
 * kmers_reassigned, Contig_name). Anyone reaching for this format wants those,
 * or they would take the TSV the page already offers.
 *
 * `Sample_file` is rewritten to the sample NAME. In the browser that column
 * holds whatever the worker was handed — a blob URL, or nothing — and a path
 * that points at no file on the reader's machine is worse than useless. The
 * name is what the rest of the export set is keyed on.
 */
export function toSylphTsv(samples) {
  let header = null;
  const out = [];
  for (const s of samples) {
    if (!s?.tsv) continue;
    const lines = String(s.tsv).trim().split("\n");
    if (lines.length < 2) continue;      // header only: nothing was detected
    if (!header) header = lines[0];
    const cols = lines[0].split("\t");
    const iSample = cols.indexOf("Sample_file");
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const f = line.split("\t");
      if (iSample >= 0) f[iSample] = s.sampleName;
      out.push(f.join("\t"));
    }
  }
  if (!header) return "";
  return [header, ...out].join("\n") + "\n";
}

// ---- session -----------------------------------------------------------------

export const SESSION_FORMAT = 1;

/**
 * Everything needed to put the results back on screen, and nothing else.
 *
 * Not the FASTQs and not the database: a session is a few hundred kilobytes of
 * numbers, and writing a 433 MB database into it would defeat the point. It
 * restores what was COMPUTED — reload the database yourself and the page picks
 * up where it was.
 */
export function toSession(state) {
  return JSON.stringify({
    format: SESSION_FORMAT,
    app: "PeekMicrobiome",
    savedAt: state.savedAt ?? null,
    ref: state.ref ?? null,
    samples: state.sampleOrder ?? [],
    // The per-genome matrix, not the aggregated view: every rank is a different
    // sum of it, so saving the view would freeze the choice made at save time.
    matrix: state.matrix ?? {},
    refBySample: Object.fromEntries(state.refBySample ?? []),
    // What the archive said about each sample, when it came from one. An
    // optional key, and the format number does not move for it: fromSession
    // builds a fixed object and ignores what it does not know, so a session
    // saved by this page still opens on the one before it, and a session saved
    // before this line still opens here — with no metadata, which is exactly
    // what it had.
    sampleMeta: Object.fromEntries(state.sampleMeta ?? []),
    // Functional profiles, when the run measured them: sample -> { KO: share }.
    // Optional for the same reason sampleMeta is, and the format number does not
    // move for it — a session written here still opens on a page that predates
    // functions, and a session written before them opens here with none, which
    // is what it had. The KEGG roll-ups are NOT saved: they are derived, and a
    // saved roll-up would freeze the map version the way saving the aggregated
    // matrix would freeze the rank.
    funcProfiles: state.funcProfiles ?? null,
    // Columns profiled on fewer reads than their input holds: sample -> why.
    // Optional like the keys above; a session without it opens with no column
    // flagged, which is what a session saved before it could say.
    incomplete: state.incomplete?.size ? Object.fromEntries(state.incomplete) : null,
    // The groups the reader made by hand, and nothing else about grouping. A
    // grouping derived from a metadata FIELD is not saved: the field is already
    // in `sampleMeta`, so saving the result would freeze a derivation the way a
    // saved roll-up would freeze the KEGG map. Optional, like the two above, and
    // the format number does not move for it.
    groups: state.groups?.size ? Object.fromEntries(state.groups) : null,
    rank: state.rank ?? "s",
  }, null, 1);
}

/**
 * Read one back, refusing anything that is not one.
 *
 * A wrong file here does not fail loudly on its own — the shapes are all plain
 * objects — so it is checked rather than trusted: a JSON of the wrong kind would
 * otherwise restore an empty matrix and look like a session that had nothing in
 * it.
 */
export function fromSession(text) {
  let j;
  try { j = JSON.parse(text); }
  catch { throw new Error("that file is not JSON"); }
  if (j?.app !== "PeekMicrobiome") throw new Error("that is not a PeekMicrobiome session file");
  if (j.format !== SESSION_FORMAT) {
    throw new Error(`session format ${j.format} — this page reads ${SESSION_FORMAT}`);
  }
  if (!Array.isArray(j.samples) || typeof j.matrix !== "object" || !j.matrix) {
    throw new Error("that session file has no matrix in it");
  }
  return {
    ref: j.ref ?? null,
    sampleOrder: j.samples,
    matrix: j.matrix,
    refBySample: new Map(Object.entries(j.refBySample ?? {})),
    sampleMeta: new Map(Object.entries(j.sampleMeta ?? {})),
    // A plain object, sample -> { KO: share }, or null. Never {} for "absent":
    // the Function tab has to tell "this run measured no functions" from "this
    // run measured functions and found none", and those are different answers.
    funcProfiles: (j.funcProfiles && typeof j.funcProfiles === "object") ? j.funcProfiles : null,
    incomplete: new Map(Object.entries(j.incomplete ?? {})
      .filter(([, v]) => typeof v === "string" && v.trim())),
    // Groups made by hand, or an empty map. A session written before this key
    // existed opens with no groups, which is what it had.
    groups: new Map(Object.entries(j.groups ?? {})
      .filter(([, v]) => typeof v === "string" && v.trim())),
    rank: typeof j.rank === "string" ? j.rank : "s",
    savedAt: j.savedAt ?? null,
  };
}
