// Gut Metabolic Modules — the reader's own copy of the definitions, read here.
//
// GMMs are 103 gut-specific metabolic processes curated by hand from the
// literature: Vieira-Silva et al., "Species-function relationships shape
// ecological properties of the human gut microbiome", Nature Microbiology 1,
// 16088 (2016), with the module framework in Darzi et al., ISME J 10, 1025
// (2016). They are defined over the same KEGG orthologs this page already
// measures, which is why they can be computed here at all.
//
// WHY THIS FILE SHIPS NO DEFINITIONS. They are distributed under VIB's Academic
// Non-commercial Software License, whose clause 9 forbids transferring them
// outside the licensee's institution. Committing GMMs.v1.07.txt to a public
// repository that deploys to a public site is exactly that transfer. So the
// page ships the parser and the reader brings the file — read in this tab, like
// the groups CSV, and never sent anywhere. The page does not fetch it either:
// its privacy notice promises that the only hosts it contacts are Zenodo and the
// EBI, and quietly adding raw.githubusercontent.com would make that false.
//
// WHY GMMs ARE NOT KEGG MODULES, MEASURED RATHER THAN ASSERTED. Only 7 of the
// 103 have a KO set identical to some KEGG module; the median best Jaccard
// against any KEGG module is 0.118; and 32 of them contain no KO that belongs to
// any KEGG module at all — including nearly the whole glycan-degradation block
// (arabinoxylan, fructan, lactose, maltose, melibiose, sucrose, trehalose),
// which is the catalogue's reason to exist. For a third of the catalogue the
// KEGG roll-up is not coarser, it is silent. So this is a LEVEL of its own, in
// its own namespace, never a column beside the KEGG modules.
//
// Pure functions, like kegg.js: text in, tables out. No DOM, no fetch.

/**
 * The definition file's grammar, which is three rules and one defect.
 *
 *   MF0003<TAB>pectin degradation I     a module header
 *   K01051                              a step: one alternative, one ortholog
 *   K01184,K01213<TAB>K18650            a step: two alternatives; the first
 *                                       needs BOTH orthologs
 *   ///                                 end of module
 *
 * So: newline is AND (every step must be covered), tab is OR (any alternative
 * covers the step), comma is AND within an alternative (a complex needs all its
 * subunits). The defect: three step lines carry a trailing tab, which splits
 * into an empty field — parse without filtering and an empty string joins the
 * ortholog set as a 443rd "KO" that can never be observed and drags one module's
 * coverage down for ever.
 */
export function parseGmms(text) {
  const modules = [];
  const kos = new Set();
  let current = null;
  let line = 0;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    line++;
    const row = raw.replace(/\s+$/, "");
    if (!row) continue;
    if (row === "///") { current = null; continue; }
    const fields = raw.split("\t");
    if (!current) {
      // A header, or a step with no module open — which is a malformed file, not
      // a step to guess at.
      if (!/^MF\d+$/.test(fields[0].trim())) {
        throw new Error(`line ${line}: expected a module header like "MF0001<TAB>name", got ${JSON.stringify(raw.slice(0, 40))}`);
      }
      const id = fields[0].trim();
      const name = (fields[1] ?? "").trim();
      current = { id, name, label: name ? `${id} — ${name}` : id, steps: [] };
      modules.push(current);
      continue;
    }
    const step = fields
      .map((f) => f.trim())
      .filter(Boolean)                       // the trailing-tab defect
      .map((alt) => alt.split(",").map((k) => k.trim()).filter(Boolean));
    if (!step.length) continue;
    for (const alt of step) for (const k of alt) kos.add(k);
    current.steps.push(step);
  }
  const bad = modules.filter((m) => !m.steps.length).map((m) => m.id);
  if (bad.length) throw new Error(`${bad.length} module(s) have no steps: ${bad.slice(0, 3).join(", ")}`);
  return { modules, kos };
}

/**
 * How much of a module was seen, and how abundant it is, per sample.
 *
 * THE ESTIMATOR, AND WHAT IT IS NOT. omixer-rpm — the reference implementation —
 * takes the median of the ortholog abundances along the highest-scoring
 * alternative path, and gates it with a coverage cutoff which by DEFAULT it
 * learns from the distribution of every module's coverage in that sample. This
 * reimplements the first half faithfully and replaces the second with a fixed
 * cutoff, because a learned one makes a module's number depend on which other
 * modules happened to be in the run — defensible in the published pipeline,
 * surprising in a table a reader is scrolling. So: not an omixer-rpm number, and
 * the interface has to say so rather than let the identifier imply it.
 *
 * A step's alternative is present only if EVERY ortholog of it was measured; its
 * abundance is the smallest of them, because a complex is no more present than
 * its rarest subunit. The step takes its best alternative. A module reaching the
 * cutoff reports the median over the orthologs of its chosen path; below it,
 * zero — the process was not seen, and a number computed from two steps of seven
 * would be a quantity for something that is not there.
 */
export function gmmTable(profiles, samples, defs, { minCoverage = 2 / 3 } = {}) {
  const mods = defs?.modules ?? [];
  const rows = [];
  // What share of each sample's measured signal this view can speak for at all.
  // The GMM catalogue covers 442 orthologs; a 3M-read gut profile reports around
  // 4,300, so most of what was measured is outside this table by construction.
  const inCatalogue = samples.map(() => 0);
  const measured = samples.map(() => 0);
  for (const [i, sample] of samples.entries()) {
    for (const [ko, v] of Object.entries(profiles?.[sample] ?? {})) {
      measured[i] += v;
      if (defs?.kos?.has(ko)) inCatalogue[i] += v;
    }
  }

  for (const m of mods) {
    const values = samples.map(() => 0);
    const coverage = samples.map(() => 0);
    for (const [i, sample] of samples.entries()) {
      const p = profiles?.[sample] ?? {};
      const path = [];
      let covered = 0;
      for (const step of m.steps) {
        let best = null;
        for (const alt of step) {
          // Every ortholog of the alternative, or the alternative is not there.
          let low = Infinity;
          for (const k of alt) {
            const v = Object.prototype.hasOwnProperty.call(p, k) ? p[k] : 0;
            if (!(v > 0)) { low = 0; break; }
            if (v < low) low = v;
          }
          if (!(low > 0)) continue;
          if (!best || low > best.low) best = { low, alt };
        }
        if (!best) continue;
        covered++;
        for (const k of best.alt) path.push(p[k]);
      }
      coverage[i] = m.steps.length ? covered / m.steps.length : 0;
      if (coverage[i] >= minCoverage && path.length) values[i] = median(path);
    }
    rows.push({ ...m, values, coverage });
  }
  rows.sort((a, b) => sum(b.values) - sum(a.values));
  return {
    samples,
    rows,
    // Named `assigned`/`unassigned` so the interface's coverage line reads the
    // same fields it reads for the KEGG roll-ups.
    assigned: inCatalogue,
    unassigned: samples.map((_, i) => measured[i] - inCatalogue[i]),
    minCoverage,
  };
}

/** The share of the measured signal that the GMM catalogue can speak for. */
export function gmmCoverage(profiles, samples, defs) {
  const t = gmmTable(profiles, samples, defs);
  const a = sum(t.assigned), u = sum(t.unassigned);
  return a + u > 0 ? a / (a + u) : 0;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function sum(xs) {
  let t = 0;
  for (const x of xs) t += x;
  return t;
}
