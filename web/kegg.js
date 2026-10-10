// KEGG orthologs into something readable, at two granularities.
//
// The functional profiler returns one line per KEGG ortholog — `ko:K01952,
// 0.0184` — which is a measurement and not yet an answer. This turns that into
// the same `{ samples, rows }` table the taxonomic figures already take, so
// composition, diversity and the ordination all work on functions with no new
// plotting code; and it rolls KOs up into modules and pathways, which is the
// granularity anyone actually reasons in.
//
// Pure functions: a table in, a table out. No DOM, no fetch, no library — the
// same contract as figures.js, and for the same reason, so every one of them can
// be tested in plain node.

/**
 * The functional profiler's CSV into the `{ K01952: 0.0184 }` shape everything
 * below reads.
 *
 * One rule worth stating rather than repeating: the reference signatures are
 * named `ko:K01952`, after the FASTA they were sketched from, and every KEGG
 * table in the world is keyed `K01952`. Stripping that prefix in one place is
 * the difference between a functional profile that joins to the map and one
 * that silently matches nothing — the failure looks like "no ortholog is in a
 * module", which is a plausible enough sentence to go unnoticed.
 *
 * Lives here so the offline build script and the in-page worker parse the same
 * bytes the same way; a second implementation is a second rule.
 */
export function parseKoCsv(csv) {
  const out = {};
  for (const line of String(csv ?? "").split("\n")) {
    const row = line.trim();
    if (!row || row.startsWith("#")) continue;
    const comma = row.indexOf(",");
    if (comma < 0) continue;
    const id = row.slice(0, comma).trim().replace(/^ko:/i, "");
    if (!/^K\d+$/.test(id)) continue;          // skips the ko_id,abundance header
    const value = Number(row.slice(comma + 1));
    if (Number.isFinite(value)) out[id] = value;
  }
  return out;
}

/**
 * `obj[key]`, but only when the object really has that key.
 *
 * `map.ko[ko]` is a bracket lookup on a JSON.parse'd plain object, so it reaches
 * Object.prototype: a profile naming an ortholog "constructor" or "toString"
 * would be "named" with a function, and `map.koModules.constructor` would be
 * treated as a list of modules and iterated. Sessions are files a user opens
 * from disk, so this is a guard on untrusted input, not a theoretical one.
 */
function own(obj, key) {
  return obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/**
 * Every row of every table below carries three strings, and the difference
 * between them is not cosmetic.
 *
 *   id     the KEGG identifier — K01952, M00001, map00010. What the measurement
 *          is ABOUT, what joins to any other KEGG table, and what a reader
 *          copies into a paper.
 *   name   the human name, alone. What a table column reads.
 *   label  `id — name`. What a legend or a bar needs, because a figure has one
 *          string per row and dropping either half makes it useless: "K01952"
 *          says nothing, and "aldehyde dehydrogenase" is a dozen orthologs.
 *
 * The matrix shows id and name in two columns, the way the taxonomic matrix
 * shows a species and its genome accession; the figures show the label.
 */
function rowNames(id, name) {
  return { id, name: name || id, label: name ? `${id} — ${name}` : id };
}

/**
 * Where an identifier lives on KEGG, or null.
 *
 * Null rather than a guess: `pathwayRollup` invents a `_none` bucket for modules
 * on no map, and a link to https://www.kegg.jp/entry/_none is a dead end offered
 * in the same style as a real one. Anything that is not one of KEGG's three
 * identifier shapes gets no link at all.
 */
export function keggEntryUrl(id) {
  return /^(K\d{5}|M\d{5}|map\d{5})$/.test(String(id ?? ""))
    ? `https://www.kegg.jp/entry/${id}` : null;
}

/**
 * An abundance as a colour KEGG will accept: `%23rrggbb`.
 *
 * LOG, not linear. Ortholog abundances in a functional profile span three orders
 * of magnitude — the most abundant is around 2 % of the sample and the tail sits
 * at one shared hash, near 0.0003 % — so a linear ramp paints everything but the
 * top few boxes the same pale colour, which is a map with one thing on it.
 * `log10(1 + 9x)` keeps 0 at 0 and 1 at 1 and opens out the bottom.
 *
 * Pale sand to deep rust: one hue, so the ramp reads as "more" rather than as
 * categories, and dark enough at the top that KEGG's black box labels stay
 * legible over it.
 */
export function heatHex(value, max) {
  const x = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const t = Math.log10(1 + 9 * x);
  // The pale end is a COLOUR, not almost-white. At lightness 0.88 the bottom of
  // the ramp was invisible on white line art and hopeless on KEGG's own coloured
  // global maps; 0.74 down to 0.36 keeps every step legible while leaving the
  // black box labels readable at the dark end.
  const hue = 40 - 26 * t, sat = 0.95 - 0.08 * t, light = 0.74 - 0.38 * t;
  // HSL to RGB, written out rather than pulled in: this file has no dependencies
  // and one colour conversion is not a reason to grow one.
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const h = hue / 60;
  const xx = c * (1 - Math.abs((h % 2) - 1));
  const [r, g, b] = h < 1 ? [c, xx, 0] : h < 2 ? [xx, c, 0] : [0, c, xx];
  const m = light - c / 2;
  const hex = (v) => Math.round(Math.min(255, Math.max(0, (v + m) * 255)))
    .toString(16).padStart(2, "0");
  return `%23${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * KEGG's own drawing of a map, with the orthologs found here coloured in.
 *
 * KEGG documents exactly one URL for this (kegg.jp/kegg/webapp/color_url.html):
 * `show_pathway?<map>/<ko>%09<colour>[/...][/default%3d<colour>]`, where %09 is
 * a tab, %3d an `=`, and %23 the `#` of a hex colour. Two forms that look right
 * are not: `/pathway/map00010+K00844` is a 404, and `/pathway/map00010?
 * multi_query=…` returns the map with the argument silently ignored — a page
 * that looks like a success and highlights nothing.
 *
 * A COLOUR PER ORTHOLOG, on the sample's own log scale (heatHex). This said
 * "one colour, not a scale" for as long as the code below has done the
 * opposite. Each colour costs 19 characters against a request-target ceiling
 * measured at 2,023 bytes — 2,024 is a 403 — so the most abundant orthologs get
 * theirs, the ones that do not fit are still marked with the palest step
 * (`default=`), and only past that are any dropped: a box left out reads as "not
 * found", which is a different and false statement.
 *
 * WHAT THE LINK CARRIES. It is the reader's data in a URL: the orthologs of this
 * map detected in one sample, each with a colour that encodes its abundance —
 * no sample name, no read, nothing else — and it reaches kegg.jp only when the
 * reader follows it. The pages say so where the link is offered, and in the
 * privacy notice, rather than leaving "nothing of yours is sent" untrue by one
 * click.
 *
 * Returns null when there is nothing to colour, and truncates — most abundant
 * first — when the list does not fit, so the caller can say it did.
 */
/**
 * Which maps KEGG will draw in grey, and it is a narrow family.
 *
 * KEGG's own script gates the Coloring dropdown on `mapno.match(/^011/)`, so the
 * 011xx "global maps" — map01100 Metabolic pathways, map01110, map01120 — are
 * the only ones with a grey variant (`map011x0nc.png`). Everything else, the
 * 012xx overview maps included, ships `image_grayscale` equal to `image_normal`
 * and ignores the parameter.
 *
 * It matters because those three are the worst case for us: KEGG draws them in
 * its own category palette, 2,473,944 coloured pixels on map01100, and our marks
 * are lost in it. Asked in grey the same map renders 3,588 coloured pixels of
 * which 3,348 are ours and the remaining 240 are the anti-aliasing of our own
 * marks — not one KEGG palette colour survives.
 */
const GREYABLE = /^map011\d\d$/;

/**
 * The pathway map on which a module is best seen, and the orthologs to light up.
 *
 * KEGG's own module page cannot be coloured. Probed 2026-08-16: `/module/M00001`
 * ignores every parameter, `/module/M00001+K00844` is a 404, and the diagram
 * image takes a colour list only through a file KEGG Mapper writes on its own
 * server — which would mean posting the reader's ortholog list to kegg.jp, and
 * that list is the reader's data. So a module is shown where it CAN be shown
 * coloured: on the pathway map that contains it, with only its own orthologs
 * lit. That is the reader's question — "this module, in what I have" — answered
 * on a canvas KEGG will paint.
 *
 * `modules[m].b` is the map chosen at build time by COVERAGE, not by KEGG's
 * order: M00074 has three of its eleven orthologs on the first map it lists and
 * ten on another, and fourteen modules of 508 turn on this. Global 011xx maps
 * rank last whatever their coverage — a ten-ortholog module is a speck on the
 * whole of metabolism.
 *
 * Returns null when the module has no map at all (28 of 508), which the caller
 * must render as an absence and not as a broken link.
 */
export function moduleMapUrl(moduleId, kos, map, opts = {}) {
  const rec = own(map?.modules, moduleId);
  const best = rec?.b ?? rec?.p?.[0];
  if (!best || !kos?.length) return null;
  const url = keggMapUrl(best, kos, opts);
  return url ? { ...url, map: best,
    alternatives: (rec?.p ?? []).filter((m) => m !== best) } : null;
}

export function keggMapUrl(mapId, kos, { max = 0, maxBytes = 2000 } = {}) {
  if (!/^map\d{5}$/.test(String(mapId ?? "")) || !kos?.length) return null;
  // KEGG documents two URL forms and they are not interchangeable here. The
  // path form — `?map00010/<ko>%09<colour>/…/default%3d<c>` — is the compact one
  // (19 bytes an ortholog against 22) and the only one that takes `default=`.
  // But its query string is a single keyless token, so appending `&coloring=`
  // makes the CGI reparse it and answer 400, "The 'mapno' parameter is
  // required". The grey base therefore costs the other form, and only the three
  // maps that have a grey base pay for it.
  if (GREYABLE.test(mapId)) return greyMapUrl(mapId, kos, max, maxBytes);
  const base = `https://www.kegg.jp/kegg-bin/show_pathway?${mapId}`;
  // Every listed ortholog gets its own background, so the map is a gradient and
  // not a set of marks. `default` is still there for the ones whose colour did
  // not fit: they are the palest end of the ramp anyway, so a box that loses its
  // own colour keeps very nearly the right one.
  const tail = `/default%3d${heatHex(0, 1)}`;
  const budget = maxBytes - (base.length - "https://www.kegg.jp".length) - tail.length;
  // THE ORDER MATTERS, and not in the obvious way. Several orthologs can share a
  // drawn box, and on a shared box KEGG lets the LAST one in the URL win — the
  // earlier one vanishes entirely. Measured: `?map00010/K21071<red>/K00850<green>`
  // renders 636 red and 651 green, and the same pair swapped renders 1,287 red
  // and NOTHING green. So the list is chosen most-abundant-first (truncation has
  // to keep what matters) and then EMITTED least-abundant-first, so that where
  // two orthologs collide the abundant one is the one that shows.
  const parts = [];
  let used = 0, plain = 0;
  const chosen = [];
  for (const k of kos) {
    const id = typeof k === "string" ? k : k?.id;
    if (!/^K\d{5}$/.test(String(id ?? ""))) continue;
    const value = typeof k === "string" ? 0 : (k.value ?? 0);
    const coloured = `${id}%09${heatHex(value, max)}`;
    if (used + coloured.length + 1 <= budget) {
      used += coloured.length + 1;
      chosen.push(coloured);
    } else if (used + id.length + 1 <= budget) {
      // No room for a colour, but room for the ortholog: mark it rather than
      // drop it. Losing a box entirely says "not found", which is a different
      // and false statement. `default=` then gives it a full box fill rather
      // than the thin marker a bare identifier gets on its own — measured at
      // 1,326 px against 366.
      used += id.length + 1;
      chosen.push(id);
      plain++;
    } else break;
  }
  // Reversed here, once, rather than by sorting the input: the choice of WHICH
  // orthologs to send and the order they are WRITTEN in answer two different
  // questions, and conflating them drops the abundant ones instead of promoting
  // them.
  parts.push(...chosen.reverse());
  if (!parts.length) return null;
  return {
    url: `${base}/${parts.join("/")}${tail}`,
    kept: parts.length,
    plain,
    dropped: kos.length - parts.length,
  };
}

/**
 * The same map, on the grey base, in KEGG's named-parameter form.
 *
 * `<kid>+<colour>` separated by `%0d%0a` (CR LF), which costs 22 bytes an
 * ortholog against the path form's 19 — the price of the grey.
 *
 * NO BARE IDENTIFIERS HERE. In the path form an ortholog with no colour of its
 * own falls back to `default=`, the palest step of our ramp. This form has no
 * `default=` — rendered with one, nothing of it lands — and a bare identifier
 * gets KEGG's OWN red instead, which on our scale reads as the most abundant
 * thing on the map. So when the budget runs out the ortholog is dropped rather
 * than promoted to a colour that lies.
 */
function greyMapUrl(mapId, kos, max, maxBytes) {
  const base = `https://www.kegg.jp/kegg-bin/show_pathway?map=${mapId}&multi_query=`;
  const tail = "&coloring=grayscale";
  const budget = maxBytes - (base.length - "https://www.kegg.jp".length) - tail.length;
  const chosen = [];
  let used = 0;
  for (const k of kos) {
    const id = typeof k === "string" ? k : k?.id;
    if (!/^K\d{5}$/.test(String(id ?? ""))) continue;
    const value = typeof k === "string" ? 0 : (k.value ?? 0);
    const entry = `${id}+${heatHex(value, max)}`;
    if (used + entry.length + 6 > budget) break;      // 6 = the %0d%0a separator
    used += entry.length + 6;
    chosen.push(entry);
  }
  if (!chosen.length) return null;
  // Least abundant first, so the abundant one wins a shared box — the same rule
  // and the same reason as the path form.
  return {
    url: `${base}${chosen.reverse().join("%0d%0a")}${tail}`,
    kept: chosen.length,
    plain: 0,
    dropped: kos.length - chosen.length,
    grey: true,
  };
}

/**
 * The row `pathwayRollup` invents for modules that are on no KEGG map.
 *
 * Exported because the interface has to know it is NOT a KEGG identifier: it
 * needs a key to group by, like every other row, but printing "_none" in a
 * column of `map00010`s hands the reader this file's internal token as if it
 * were something to look up. Named here rather than spelled out wherever it is
 * checked — a magic string in two files is a magic string that will disagree.
 */
export const NO_PATHWAY = "_none";

/**
 * KEGG's "global and overview maps": map011xx (Metabolic pathways and the two
 * other global maps), map012xx (carbon, amino-acid, cofactor… metabolism) and
 * map013xx (the nitrogen and sulfur cycles). Thirteen maps, and none of them is
 * a pathway of its own — each is drawn from the orthologs of the specific maps,
 * so it carries their signal a second time.
 *
 * That is fine in a table, where a row is read on its own. It is not fine in a
 * composition, where rows are shares of one bar: on the shipped example the
 * seven largest slices were all overview maps, map01100 alone a fifth of every
 * bar, and the specific pathways a reader came to compare were pushed into grey.
 */
export const isOverviewMap = (id) => /^map01[123]\d\d$/.test(String(id ?? ""));

/** Rows the profiler produced, named and sorted. `map` is web/db/kegg/ko-map.json. */
/**
 * What the functional measurement is, and what it misses — in one sentence, in
 * one place, shown by both pages.
 *
 * THE NUMBER MATTERS. fmh-funprofiler recovers about 60 % of a sample's
 * orthologs overall and about 85 % of the abundant ones (Hera et al.,
 * "Metagenomic functional profiling: to sketch or not to sketch?",
 * Bioinformatics 40, ii165–ii173, 2024). A reader who takes an empty row as
 * "this sample cannot do that" is reading four times more into it than the
 * method supports, and nothing else on the page would tell them otherwise —
 * the same reason the taxonomic matrix says which catalogue it is relative to
 * rather than letting a reader assume "all bacteria".
 */
export const FUNC_METHOD_NOTE =
  "Measured from these reads, not inferred from the species: amino-acid k-mers " +
  "against 13,509 KEGG orthologs (fmh-funprofiler, protein k=11, scaled 1000). " +
  "The method finds about 60 % of a sample\u2019s orthologs overall and about " +
  "85 % of the abundant ones, so a function missing here is not necessarily " +
  "missing from the sample. Abundances are relative to the orthologs detected.";

// ---- KEGG is not a public database -------------------------------------------
//
// Its own terms say so in those words: academic use is free, and any non-
// academic use needs a commercial licence from Pathway Solutions. Every
// identifier, name and roll-up above is KEGG's, so both pages ask once which of
// those the reader is, and remember the answer.
//
// HERE rather than in either page, because it is ONE question with ONE answer:
// the multi-sample page and the single-sample page share the key, so answering
// on one answers on the other, and the wording cannot drift between them. The
// answer is kept in localStorage and goes nowhere — there is no server to send
// it to.
export const KEGG_CONSENT_KEY = "peek-kegg-use";

/** "academic", "licensed", or "" — meaning the question has not been answered. */
export function keggConsent() {
  try { return localStorage.getItem(KEGG_CONSENT_KEY) || ""; } catch { return ""; }
}

export function storeKeggConsent(v) {
  try { localStorage.setItem(KEGG_CONSENT_KEY, v); } catch { /* private mode: ask again */ }
}

/** The question itself. Both pages render this string, and neither writes its own. */
export function keggGateHtml() {
  return `<div class="fig-refusal kegg-gate">
    <b>This tab shows KEGG data</b>
    <span>Academic use of KEGG is free. Any non-academic use requires a commercial licence —
      see <a href="https://www.kegg.jp/kegg/legal.html" target="_blank" rel="noopener">KEGG's
      terms of use</a>.</span>
    <div class="kegg-gate-actions">
      <button type="button" id="keggAcademic">I am an academic user</button>
      <button type="button" id="keggLicensed">I have a commercial licence</button>
    </div>
    <span class="kegg-gate-fine">Kept in this browser. Change it under Settings.</span>
  </div>`;
}

export function koTable(profiles, samples, map = null) {
  const byKo = new Map();
  for (const [i, sample] of samples.entries()) {
    for (const [ko, value] of Object.entries(profiles[sample] ?? {})) {
      let row = byKo.get(ko);
      if (!row) {
        row = { values: samples.map(() => 0) };
        byKo.set(ko, row);
      }
      row.values[i] = value;
    }
  }
  const rows = [...byKo.entries()].map(([ko, row]) => ({
    ...row,
    ...rowNames(ko, own(map?.ko, ko) ?? ""),
  }));
  rows.sort((a, b) => sum(b.values) - sum(a.values));
  return { samples, rows };
}

/**
 * KOs rolled up into KEGG modules.
 *
 * A KO can belong to several modules, and most belong to none: of the 13,476
 * orthologs this project's reference can report, 2,275 — 17% — sit in a module
 * at all. So the roll-up is deliberately NOT a partition. `unassigned` carries
 * everything that reaches no module, and it is returned rather than dropped,
 * because a module chart that quietly represents a sixth of the signal while
 * looking like all of it is worse than no chart.
 */
export function moduleTable(profiles, samples, map) {
  const byMod = new Map();
  const unassigned = samples.map(() => 0);
  const assigned = samples.map(() => 0);
  for (const [i, sample] of samples.entries()) {
    for (const [ko, value] of Object.entries(profiles[sample] ?? {})) {
      const mods = own(map?.koModules, ko);
      if (!mods || !mods.length) {
        unassigned[i] += value;
        continue;
      }
      assigned[i] += value;
      // A KO in several modules is evidence for each of them, not a third of
      // evidence for three. Splitting the abundance would make a module look
      // rarer for being well connected.
      //
      // ONCE PER MODULE, though. KEGG lists an ortholog once per STEP it appears
      // in, so an ortholog used at two steps of one module arrives twice and its
      // abundance would be added twice — 39 modules of 508 were inflated that
      // way, M00001 among them, because K00918 serves two of its steps. The
      // build now dedupes, and this guards a map built before it did.
      for (const m of new Set(mods)) {
        let row = byMod.get(m);
        if (!row) {
          row = { ...rowNames(m, own(map?.modules, m)?.n ?? ""),
            values: samples.map(() => 0), kos: new Set() };
          byMod.set(m, row);
        }
        row.values[i] += value;
        // WHICH orthologs, not only how many. A module is a set of them, and
        // "0.88 %" answers how much without answering of what — the question a
        // reader asks by clicking the cell. Carried as a set here and flattened
        // below, because the same ortholog arrives once per sample.
        row.kos.add(ko);
      }
    }
  }
  const rows = [...byMod.values()]
    .map((r) => ({ ...r, kos: [...r.kos].sort() }))
    .sort((a, b) => sum(b.values) - sum(a.values));
  return { samples, rows, unassigned, assigned };
}

/**
 * Orthologs grouped under the KEGG maps they appear on — the "KEGG map" view.
 *
 * Not KEGG's own pathway diagrams: those are copyrighted images and cannot be
 * shipped. This is the same membership drawn as our own layout, which is what
 * the abundances can actually support anyway — a coloured-in KEGG map implies
 * per-reaction evidence that a sketch profile does not have.
 *
 * EACH ORTHOLOG COUNTS ONCE PER MAP, and that is the whole of this function.
 * The obvious implementation — sum the module rows on each map — was what
 * shipped first, and it double-counts INSIDE a single row: map01100 "Metabolic
 * pathways" carries 319 modules, so an ortholog in three of them was counted
 * three times in one bar. On the bundled example that bar read 43.00 % of the
 * profile while the whole of the module-assigned signal was 22.75 % — a number
 * that cannot be true, printed as if it were a share.
 *
 * So the sum runs over ORTHOLOGS, deduplicated per map. A row is then a real
 * share of the measured profile: the part of it carrying orthologs that appear
 * on that map. Rows still overlap ACROSS the table — an ortholog on two maps is
 * genuine evidence for both, exactly as in `moduleTable` — so the rows do not
 * add to 100 %, and every view that draws them has to say so.
 */
export function pathwayRollup(profiles, samples, map) {
  const mods = moduleTable(profiles, samples, map);
  const modOf = new Map(mods.rows.map((r) => [r.id, r]));
  const byPath = new Map();
  const seenMods = new Map();          // pathway -> Set of module ids that fed it

  const row = (p) => {
    let e = byPath.get(p);
    if (!e) {
      e = {
        // `_none` is this file's own bucket, not a KEGG entry: it gets the
        // sentence as its label with no identifier in front, because prefixing
        // it would offer `_none` in the shape of something you could look up.
        ...(p === NO_PATHWAY
          ? { id: p, name: "not on a pathway map", label: "not on a pathway map" }
          : rowNames(p, own(map?.pathways, p) ?? "")),
        values: samples.map(() => 0),
        modules: [],
        kos: new Map(),
      };
      byPath.set(p, e);
      seenMods.set(p, new Set());
    }
    return e;
  };

  for (const [i, sample] of samples.entries()) {
    for (const [ko, value] of Object.entries(profiles[sample] ?? {})) {
      const koMods = own(map?.koModules, ko);
      if (!koMods || !koMods.length) continue;    // no module: counted as unassigned
      // Where this ONE ortholog goes, as a set, so a map that holds several of
      // its modules still receives it once.
      const paths = new Set();
      const offMap = [];
      for (const m of koMods) {
        const ps = own(map?.modules, m)?.p ?? [];
        if (ps.length) for (const p of ps) paths.add(p);
        else offMap.push(m);
      }
      // Only when NO map shows it at all. An ortholog that is on map00010 via
      // one module does not also belong in "no map shows this" because a second,
      // off-map module happens to contain it.
      const targets = paths.size ? [...paths] : [NO_PATHWAY];
      for (const p of targets) {
        const e = row(p);
        e.values[i] += value;
        // Which orthologs put the profile on this map. Kept because it is what a
        // link to KEGG's own drawing has to carry: "colour the boxes we actually
        // saw". A Map rather than a Set so the most abundant survive when the
        // list has to be cut to fit a URL.
        e.kos.set(ko, (e.kos.get(ko) ?? 0) + value);
        const seen = seenMods.get(p);
        for (const m of (p === NO_PATHWAY ? offMap : koMods)) {
          if (seen.has(m)) continue;
          // The module list is what the tooltip names; it must only hold modules
          // that actually reach this map.
          if (p !== NO_PATHWAY && !(own(map?.modules, m)?.p ?? []).includes(p)) continue;
          seen.add(m);
          const mr = modOf.get(m);
          if (mr) e.modules.push(mr);
        }
      }
    }
  }
  const rows = [...byPath.values()].sort((a, b) => sum(b.values) - sum(a.values));
  const n = Math.max(1, samples.length);
  let koMax = 0;
  for (const r of rows) {
    r.modules.sort((a, b) => sum(b.values) - sum(a.values));
    // Most abundant first, so a list cut to fit a URL keeps what matters — and
    // carrying the value, because a link that colours by abundance needs it.
    // The mean across the samples on screen: the link is one map for the run,
    // not one map per column.
    r.kos = [...r.kos.entries()]
      .map(([id, total]) => ({ id, value: total / n }))
      .sort((a, b) => b.value - a.value);
    if (r.kos.length && r.kos[0].value > koMax) koMax = r.kos[0].value;
  }
  // The scale every map is coloured against. Shared rather than per-map, so the
  // same colour means the same abundance wherever a reader lands: normalising
  // each map to its own maximum would paint a map of trace orthologs as darkly
  // as the one carrying a fifth of the profile.
  return { samples, rows, koMax, unassigned: mods.unassigned, assigned: mods.assigned };
}

/**
 * Rows worth putting in a table, and an honest account of the rest.
 *
 * A 3-million-read profile reports about 4,300 orthologs, and most of them sit
 * at the detection floor: one shared hash out of ~300,000 is 0.0003% of the
 * sample, which is a presence, not a quantity. A table of 4,300 rows in which
 * 3,500 read "0.00" is not more informative than one of 800 — it is the same
 * information, unreadable, and it costs two seconds of blocking render.
 *
 * The floor is on the ROW, not the cell: a row survives if ANY sample reaches
 * it. A function present in one person and absent in five is exactly what a
 * reader is looking for, and a per-cell floor would delete it.
 *
 * Returns what was hidden as well as what was kept, because a filtered table
 * that does not say what it dropped is a table claiming to be the measurement.
 * `carried` is the share of the whole table those hidden rows held — the number
 * that says whether the floor threw away noise or a third of the signal.
 */
export function floorRows(table, minPct) {
  const floor = Number(minPct) || 0;
  if (!(floor > 0)) return { ...table, hidden: 0, carried: 0, floor: 0 };
  const cut = floor / 100;
  const keep = [], drop = [];
  for (const r of table.rows) {
    (Math.max(...r.values, 0) >= cut ? keep : drop).push(r);
  }
  const total = table.rows.reduce((a, r) => a + sum(r.values), 0);
  const lost = drop.reduce((a, r) => a + sum(r.values), 0);
  return {
    ...table,
    rows: keep,
    hidden: drop.length,
    carried: total > 0 ? lost / total : 0,
    floor,
  };
}

/** What fraction of the measured signal a module-level view can speak for. */
export function moduleCoverage(profiles, samples, map) {
  const { unassigned, assigned } = moduleTable(profiles, samples, map);
  const a = sum(assigned), u = sum(unassigned);
  return a + u > 0 ? a / (a + u) : 0;
}

/**
 * The same question one level up, and it is NOT the module number.
 *
 * Being in a module does not put an ortholog on a map: 28 of the 508 modules the
 * shipped reference knows appear on no pathway map at all. Borrowing
 * `moduleCoverage` for the pathway view — which is what the interface did —
 * overstates what a map-level chart can speak for, and does it in the one
 * sentence whose whole job is to be honest about that.
 */
export function pathwayCoverage(profiles, samples, map) {
  const roll = pathwayRollup(profiles, samples, map);
  const none = roll.rows.find((r) => r.id === NO_PATHWAY);
  const onMap = sum(roll.assigned) - (none ? sum(none.values) : 0);
  const total = sum(roll.assigned) + sum(roll.unassigned);
  return total > 0 ? onMap / total : 0;
}

function sum(xs) {
  let t = 0;
  for (const x of xs) t += x;
  return t;
}
