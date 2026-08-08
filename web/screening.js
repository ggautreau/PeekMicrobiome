// "Which of the nineteen catalogues should I profile this sample against?"
//
// Getting that wrong is the main way to be misled by this tool — sylph reports
// the closest genomes IT HOLDS, so a saliva sample against the soil catalogue
// comes back as a full, plausible, entirely wrong table. Until now the only
// answer was "you tell us". This module reads a profile against the 13 MB
// screening database (db/screening.syldb) and turns it into a ranked verdict.
//
// No DOM, no fetch: a TSV string and a marker map in, a verdict out. multi.js
// does the downloading and the drawing.
//
// WHY THE COLUMNS DO NOT SUM TO 100%
// ----------------------------------
// A detected species is credited to EVERY catalogue that contains it, not to
// the one its genome happened to come from. Lactobacillus paragasseri is in
// human-gut, human-oral and human-vaginal; charging its abundance to one of
// them would be arbitrary, and charging it to the catalogue its sketch was
// taken from would be worse — that is a build artefact, not a fact about the
// sample. So `taxo` reads "how much of this sample could a run against
// catalogue X have explained", which is exactly the question someone picking a
// database is asking.
//
// WHY `excl` IS THE ONE THAT DECIDES
// ----------------------------------
// Shared species raise every catalogue they belong to, so `taxo` alone crowns
// whichever catalogue is largest and most cosmopolitan. Measured on a real gut
// sample: human-gut 96.07% and mouse-gut 46.66% — but mouse-gut's exclusive
// support is 0.00%, i.e. every species it claims is one it shares with
// somewhere else. It is riding, not indicated.
//
// The corollary is a verdict this module must be willing to refuse. A vaginal
// sample dominated by cosmopolitan Lactobacillus scores human-gut, human-oral
// and human-vaginal alike with 0% exclusive support for any of them, and
// rebuilding the database four times finer does not change it. When nothing is
// exclusive, `confident` is false and the caller must say so rather than name
// the top row.

export const SCREENING_DB = "db/screening.syldb";
export const SCREENING_MARKERS = "db/screening-markers.json";

// Above this ANI sylph's own containment is trustworthy enough to call the
// species present rather than "something related is". Matches the threshold
// screen_biome.py reports as n_hi.
const HIGH_ANI = 97.0;

// Below this, exclusive support is too thin to separate the candidates and the
// verdict is reported as inconclusive. Not tuned: it is the level at which the
// top catalogue's exclusive abundance stops being distinguishable from the
// noise of one or two shared species landing in the wrong place.
const MIN_EXCLUSIVE_PCT = 1.0;

/**
 * Normalise the marker map as shipped (compact, biome names factored out) into
 * a lookup keyed the way sylph reports genomes.
 *
 * Keys are stored un-gzipped, like db/lineage/*.json: the screening database
 * was built from gzipped genomes and reports "MGYG….fna.gz", so the .gz is
 * stripped once, here, rather than in every caller.
 */
export function normaliseMarkers(json) {
  const biomes = Array.isArray(json?.biomes) ? json.biomes.map(String) : [];
  const genomes = new Map();
  for (const [key, v] of Object.entries(json?.genomes ?? {})) {
    const idx = Array.isArray(v?.b) ? v.b : [];
    genomes.set(key, {
      species: String(v?.s ?? ""),
      biomes: idx.map((i) => biomes[i]).filter(Boolean),
    });
  }
  if (!genomes.size) throw new Error("screening marker map is empty");
  return { biomes, genomes };
}

function lookup(markers, genomeField) {
  const base = String(genomeField ?? "").split("/").pop();
  return markers.genomes.get(base)
    ?? markers.genomes.get(base.replace(/\.gz$/i, ""))
    ?? null;
}

/**
 * Turn a `sylph profile` TSV against the screening database into a verdict.
 *
 * Returns { rows, detected, total, unmapped, best, runnerUp, confident, note }.
 * `rows` is one entry per catalogue, sorted by exclusive support — the ranking
 * that decides — with `taxo` kept for context.
 */
export function screenVerdict(tsv, markers) {
  const lines = String(tsv ?? "").trim().split("\n").filter(Boolean);
  const empty = {
    rows: [], detected: 0, total: 0, unmapped: 0,
    best: null, runnerUp: null, confident: false,
    note: "No marker species were detected. The sample may be too small, too " +
      "deeply filtered, or from an environment none of the nineteen catalogues covers.",
  };
  if (lines.length < 2) return empty;

  const head = lines[0].split("\t");
  const iGenome = head.indexOf("Genome_file");
  const iAbund = head.indexOf("Taxonomic_abundance");
  const iAni = head.indexOf("Adjusted_ANI");
  if (iGenome < 0 || iAbund < 0) {
    throw new Error("screening profile is missing Genome_file/Taxonomic_abundance");
  }

  const agg = new Map();
  let detected = 0, total = 0, unmapped = 0;
  for (const line of lines.slice(1)) {
    const f = line.split("\t");
    const m = lookup(markers, f[iGenome]);
    // A genome the map does not know cannot be credited to any catalogue.
    // Counted rather than ignored: it means the database and the map have
    // drifted apart, which is how a sample once scored zero species on a marker
    // it had correctly detected.
    if (!m) { unmapped++; continue; }
    const t = Number(f[iAbund]);
    const ani = iAni >= 0 ? Number(f[iAni]) : NaN;
    if (!Number.isFinite(t)) continue;
    detected++;
    total += t;
    for (const b of m.biomes) {
      let e = agg.get(b);
      if (!e) { e = { biome: b, taxo: 0, excl: 0, n: 0, nHigh: 0, best: 0, top: "" }; agg.set(b, e); }
      e.taxo += t;
      e.n++;
      if (m.biomes.length === 1) e.excl += t;
      if (Number.isFinite(ani) && ani >= HIGH_ANI) e.nHigh++;
      if (t > e.best) { e.best = t; e.top = m.species || String(f[iGenome]).split("/").pop(); }
    }
  }
  if (!detected) return { ...empty, unmapped };

  // Ranked by exclusive support, NOT by taxo: taxo crowns the largest and most
  // cosmopolitan catalogue regardless of the sample.
  const rows = [...agg.values()].sort((a, b) => b.excl - a.excl || b.taxo - a.taxo);
  const best = rows[0] ?? null;
  const runnerUp = rows[1] ?? null;
  const confident = !!best && best.excl >= MIN_EXCLUSIVE_PCT;

  let note;
  if (!confident) {
    const tied = rows.filter((r) => r.taxo >= (rows[0]?.taxo ?? 0) * 0.75)
      .map((r) => r.biome).slice(0, 4);
    note = `Inconclusive: every species detected here lives in more than one catalogue, ` +
      `so nothing distinguishes ${tied.length > 1 ? tied.join(", ") : "the candidates"}. ` +
      `Pick from what you know about the sample.`;
  } else {
    note = `${best.biome} explains ${best.taxo.toFixed(1)}% of this sample, ` +
      `${best.excl.toFixed(1)}% of it from species found in no other catalogue` +
      (runnerUp ? `; runner-up ${runnerUp.biome} at ${runnerUp.excl.toFixed(1)}% exclusive.` : ".");
  }
  return { rows, detected, total, unmapped, best, runnerUp, confident, note };
}
