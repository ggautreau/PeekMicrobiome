// What the archive said about a sample, made safe to print.
//
// No DOM, no fetch: values in, values out, so every rule here is testable in
// plain node beside the figures.
//
// THE PROBLEM THIS SOLVES. A metadata field is not either present or absent —
// it has four states, and three of them look like data:
//
//   · empty                      — honest, and easy
//   · a sentinel                 — "missing", "not applicable", "not collected",
//                                  "restricted access". These are INSDC's way of
//                                  saying nothing, and they render as words.
//   · boilerplate                — a title the archive generated from the taxon,
//                                  identical for every sample of a study
//   · a value that is wrong      — 0.0/0.0 coordinates, "unspecified" instruments
//
// Measured over 949,812 metagenomic samples: 9.2% of collection_date values and
// 3.2% of country values are sentinels, 36.9% of sample_title values contain no
// submitter text, and 885 samples sit at exactly 0.0 N 0.0 E — 424 of them in
// one study whose country says France and Germany. PRJEB71445 returns a
// collection_date for 129 samples out of 129 and every one of them is "not
// provided", so a page that only checks for emptiness scores that column
// perfect and prints 129 dates that do not exist.
//
// Everything dropped here is dropped SILENTLY and completely: no row, no dash,
// no "unknown". A dash teaches the reader the page is broken; an absent line
// teaches them the archive is empty, which is the truth.

// Whole-cell sentinels, matched case-insensitively. Whole-cell and never as a
// prefix: a study whose subjects are named NA1, NA2 must not vanish because
// "na" is on this list.
const SENTINEL = new Set([
  "", "-", "--", "n/a", "na", "n.a.", "nan", "none", "null", "nil",
  "unknown", "unspecified", "unidentified", "uncalculated", "undetermined",
  "missing", "not applicable", "notapplicable", "not_applicable",
  "not collected", "not provided", "not available", "not determined",
  "not recorded", "no data", "restricted access", "withheld", "n/d", "nd",
]);

// The same words used as a prefix, which is how INSDC qualifies them:
// "missing: third party data", "not applicable: control sample".
const SENTINEL_PREFIX =
  /^(missing|not applicable|not collected|not provided|not available|restricted access)\s*[:;]/i;

// Titles and descriptions the archive generated rather than a submitter typing:
// "Metagenome or environmental sample from human gut metagenome" appears on
// 49,036 samples, and per study the rate is 0% or 100% — so the filter either
// does nothing or saves the whole column.
const BOILERPLATE = [
  /^metagenome or environmental sample from /i,
  /^mi(ms|gs|marks)\b[^:]*sample from /i,
  /^(generic|environmental|metagenome) sample from /i,
  /^keywords:\s*gsc:mixs/i,
];

/** Is this cell a way of saying nothing? */
export function isMissing(value) {
  const v = String(value ?? "").trim();
  if (SENTINEL.has(v.toLowerCase())) return true;
  return SENTINEL_PREFIX.test(v);
}

const num = (v) => {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : NaN;
};

/**
 * The subset of a run's metadata that is worth showing, cleaned.
 *
 * Returns a plain object holding only usable values, plus `place` and `coords`
 * where the pieces have been put together. An empty object is a complete and
 * correct answer — it means the archive had nothing, which is the case for
 * roughly half the studies in it.
 */
export function usableMeta(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  const take = (k) => {
    const v = String(raw[k] ?? "").trim();
    return v && !isMissing(v) ? v : "";
  };

  for (const k of ["collection_date", "isolation_source", "host_scientific_name",
    "host_sex", "sample_accession", "study_accession", "study_title",
    "sample_alias", "scientific_name"]) {
    const v = take(k);
    if (v) out[k] = v;
  }

  // RANDOM is what shotgun sequencing IS — 96% of runs say it, and printing it
  // on every sample is a word that never varies. PCR is the one worth seeing:
  // it says the library was amplified, which is why a profile can be skewed.
  const selection = take("library_selection");
  if (selection && !/^random$/i.test(selection) && !/^unspecified$/i.test(selection)) {
    out.library_selection = selection;
  }

  // "unspecified" is an INSDC controlled term, not a model. One study ships it
  // on 12,353 runs.
  const model = take("instrument_model");
  if (model && model.toLowerCase() !== "unspecified") out.instrument_model = model;

  // A title that the archive wrote from the taxon says nothing this page does
  // not already show, and a title equal to the taxon says even less.
  //
  // The same test applies to the description, and it has to be written twice
  // rather than once for the title: PRJEB83730 fills BOTH with the bare taxon,
  // so a rule that only compared the description with the title would keep it —
  // the title having just been dropped, there was nothing left to compare it
  // with. The demo's own panel read "human gut metagenome" under a heading that
  // already said Human gut.
  const says = (v) => v && !BOILERPLATE.some((re) => re.test(v)) &&
    v.toLowerCase() !== (out.scientific_name ?? "").toLowerCase();
  const title = take("sample_title");
  if (says(title)) out.sample_title = title;
  const desc = take("sample_description");
  if (says(desc) && desc !== out.sample_title) out.sample_description = desc;

  // country is free text at two levels — "USA:CA:San Diego" — and half the
  // filled values carry a region after the colon. Split rather than print the
  // punctuation.
  const country = take("country");
  if (country) {
    const [head, ...rest] = country.split(":").map((s) => s.trim()).filter(Boolean);
    out.country = head;
    if (rest.length) out.region = rest.join(", ");
  }

  // Both at exactly zero is Null Island: 885 samples archive-wide, 424 of them
  // in one study that also says France and Germany. It is a submitter typing 0,
  // not a place, and drawn on a map it is a confident dot in the Atlantic.
  const lat = num(raw.lat), lon = num(raw.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon) &&
      !(Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6)) {
    out.lat = lat;
    out.lon = lon;
  }
  return out;
}

// What each field is called on screen, and the order it is read in: what the
// sample IS, then where and when it came from, then how it was measured.
const LABELS = [
  ["sample_title", "sample"],
  ["sample_alias", "named"],
  ["host_scientific_name", "host"],
  ["host_sex", "sex"],
  ["isolation_source", "from"],
  ["collection_date", "collected"],
  ["country", "in"],
  ["region", ""],
  ["coords", "at"],
  ["instrument_model", "sequenced on"],
  ["library_selection", "selection"],
  ["sample_accession", "sample id"],
];

/**
 * The cleaned metadata as ordered label/value pairs, ready to print.
 *
 * `scientific_name`, `study_title` and `study_accession` are deliberately not
 * here: they are the same for 90-100% of the samples of a study, so they belong
 * in one line above the table rather than repeated down every sample.
 */
export function metaLines(raw, { except = null } = {}) {
  const m = usableMeta(raw);
  if (Number.isFinite(m.lat)) {
    m.coords = `${m.lat.toFixed(3)}, ${m.lon.toFixed(3)}`;
  }
  return LABELS
    .filter(([k]) => m[k] !== undefined && m[k] !== "")
    // `except` is what the line above the table already says. The two must not
    // repeat each other: "Singapore" printed once over the run and again on
    // every sample of it is the same word eighteen times, and it costs the panel
    // two lines that the pie beside it needs.
    .filter(([k]) => !except?.has(k))
    .map(([k, label]) => ({ key: k, label, value: String(m[k]) }));
}

// The fields that go ABOVE the table when every sample agrees on them, in
// reading order. Deliberately not sample_alias, sample_accession or
// collection_date: those are what tells one sample from another, and a run where
// they were constant would be a run of one sample repeated.
const RUN_LEVEL = [
  ["scientific_name", "biome"],
  ["study_title", "study"],
  ["study_accession", ""],
  ["host_scientific_name", "host"],
  ["instrument_model", "sequenced on"],
  ["library_selection", "selection"],
  ["country", "in"],
  ["coords", "at"],
];

/**
 * What a whole run shares, for the line above the table.
 *
 * A field is only offered here when every sample that has it agrees: one study,
 * one biome, one platform. The moment two samples disagree the field is a
 * property of the sample, not of the run, and printing either value at the top
 * would be printing one sample's answer over all of them.
 */
export function runFacts(store, samples) {
  const out = [];
  for (const [key, label] of RUN_LEVEL) {
    const seen = new Set();
    let held = 0;
    for (const s of samples) {
      const m = usableMeta(store.get(s));
      const v = key === "coords"
        ? (Number.isFinite(m.lat) ? `${m.lat.toFixed(3)}, ${m.lon.toFixed(3)}` : "")
        : m[key];
      if (v) { seen.add(v); held++; }
    }
    if (seen.size === 1 && held === samples.length && samples.length > 0) {
      out.push({ key, label, value: [...seen][0] });
    }
  }
  return out;
}

/**
 * How many of these samples carry a usable value for each field.
 *
 * The number a picker needs: a field held by 3 of 40 samples is not a grouping,
 * it is three samples and a hole.
 */
export function fieldCoverage(store, samples) {
  const count = new Map();
  for (const s of samples) {
    for (const [k, v] of Object.entries(usableMeta(store.get(s)))) {
      if (v === "" || v === undefined) continue;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  return count;
}
