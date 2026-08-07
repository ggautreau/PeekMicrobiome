// The reference-database picker, and everything that has to say WHICH database
// a result came from.
//
// Why this file exists at all
// ---------------------------
// Until now there was one reference database — the human-gut UHGG catalogue —
// so "which database" was not a question anyone could get wrong. There are now
// nineteen, one per MGnify genome catalogue, and getting it wrong is the main
// way to be misled by this tool: sylph reports the closest genomes IT HOLDS. Profile
// a saliva sample against the soil catalogue and you get a full, plausible,
// entirely wrong table — no error, no warning, no empty result. Nothing in the
// output distinguishes it from a good run except knowing which catalogue was
// loaded.
//
// So the biome is not a dropdown value here. It is carried on the result, shown
// on the matrix, and written into the exported TSV/CSV, because an export that
// does not name its reference cannot be checked afterwards — and "afterwards" is
// when this mistake is found.
//
// Why one at a time, never merged
// -------------------------------
// MGnify publishes no unified catalogue. Each one is dereplicated
// independently and they overlap (measured: 10% of the named species are shared
// between human-oral and human-skin). Loading two would put the same species in
// twice with its k-mers split arbitrarily between the copies. sylph's pseudotax
// reassignment separates close genomes WITHIN one database; it cannot arbitrate
// between two catalogues that were dereplicated apart. Hence: one database, the
// user picks it, and the page says loudly which one it is.

export const CATALOG_URL = "./db/biomes.json";
export const LOCAL_VALUE = "__local__";
// Remembered across visits and shared by both pages: with nineteen entries,
// re-picking on every load is friction, and friction is what makes people click
// whatever is already selected.
export const BIOME_STORAGE_KEY = "sylph-db-biome";

const PENDING_DEFAULT = "no public URL yet — this database is built but not published";

// ---- the catalogue -----------------------------------------------------------

// A single biome entry, with the defaults and the availability rule applied.
// `available` is derived from `url` alone: that is the one field a human edits
// after a Zenodo deposit, and deriving from it means an entry can never be
// marked available while pointing nowhere.
function normaliseBiome(raw, pendingNote) {
  const url = typeof raw?.url === "string" ? raw.url.trim() : "";
  const species = Number(raw?.species);
  const bytes = Number(raw?.bytes);
  return {
    key: String(raw?.key ?? ""),
    label: String(raw?.label ?? raw?.key ?? "(unnamed)"),
    hint: raw?.hint ? String(raw.hint) : "",
    catalogue: String(raw?.catalogue ?? raw?.key ?? ""),
    version: raw?.version ? String(raw.version) : "",
    species: Number.isFinite(species) ? species : NaN,
    bytes: Number.isFinite(bytes) ? bytes : NaN,
    file: raw?.file ? String(raw.file) : "",
    url,
    doi: raw?.doi ? String(raw.doi) : "",
    source: raw?.source ? String(raw.source) : "",
    lineage: raw?.lineage ? String(raw.lineage) : "",
    bundled: raw?.bundled === true,
    available: url.length > 0,
    unavailableReason: url.length > 0 ? "" : (raw?.unavailable || pendingNote || PENDING_DEFAULT),
  };
}

export function normaliseCatalog(json) {
  const pendingNote = json?.pendingNote ? String(json.pendingNote) : PENDING_DEFAULT;
  const groups = (Array.isArray(json?.groups) ? json.groups : [])
    .map((g) => ({
      key: String(g?.key ?? ""),
      label: String(g?.label ?? g?.key ?? ""),
      biomes: (Array.isArray(g?.biomes) ? g.biomes : []).map((b) => normaliseBiome(b, pendingNote)),
    }))
    .filter((g) => g.biomes.length > 0);
  if (!groups.length) throw new Error("biome catalogue has no entries");
  return {
    schema: Number(json?.schema ?? 0),
    warning: json?._warning ? String(json._warning) : "",
    pendingNote,
    groups,
  };
}

// The picker must exist even when db/biomes.json does not answer — a stale
// service worker, a half-deployed site, a file the user removed. Losing the
// catalogue must cost the biome choice, not the whole application, so this is
// the same two databases index.html used to hard-code.
export function fallbackCatalog() {
  return normaliseCatalog({
    schema: 1,
    groups: [{
      key: "human",
      label: "Human",
      biomes: [
        {
          key: "human-gut", label: "Human gut", catalogue: "human-gut", version: "v2.0.2",
          species: 4744, bytes: 454021440, file: "gut.syldb",
          url: "https://zenodo.org/api/records/20180025/files/gut.syldb/content",
          lineage: "db/lineage.json",
        },
        {
          key: "gut-mini", label: "Smoke test — 50 human-gut species", catalogue: "human-gut",
          version: "v2.0.2", species: 50, bytes: 6516832, file: "gut_mini.syldb",
          url: "db/gut_mini.syldb", bundled: true, lineage: "db/lineage.json",
        },
      ],
    }],
  });
}

export async function fetchCatalog(fetchImpl = (...a) => fetch(...a), url = CATALOG_URL) {
  const r = await fetchImpl(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return normaliseCatalog(await r.json());
}

export function allBiomes(catalog) {
  return catalog.groups.flatMap((g) => g.biomes);
}

// ---- lookups -----------------------------------------------------------------

// URLs are compared as the browser resolves them, so "db/gut_mini.syldb" and
// "http://host/db/gut_mini.syldb" are one entry — which is what the download
// cache keys on too, and the reason a cached database is recognised as the
// biome it is rather than as an anonymous file.
function absolute(u) {
  try { return new URL(u, typeof location !== "undefined" ? location.href : "http://x/").href; }
  catch { return u; }
}

export function biomeForUrl(catalog, url) {
  if (!url) return null;
  const want = absolute(url);
  return allBiomes(catalog).find((b) => b.url && absolute(b.url) === want) ?? null;
}

export function biomeByKey(catalog, key) {
  return allBiomes(catalog).find((b) => b.key === key) ?? null;
}

// ---- formatting --------------------------------------------------------------

export function fmtCount(n) {
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "?";
}

export function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return "size unknown";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

// "MGnify human-gut v2.0.2" — the catalogue, not our file. Two databases built
// from the same catalogue at different versions are not the same reference, and
// the version is the only thing that says so.
export function catalogueName(b) {
  if (!b?.catalogue) return "";
  return `MGnify ${b.catalogue}${b.version ? ` ${b.version}` : ""}`;
}

// What goes in the <option>. Long on purpose: species count and size are the two
// figures that decide whether an entry is the right one and whether it is worth
// the wait, and a dropdown is read once, quickly.
export function optionLabel(b) {
  const bits = [`${fmtCount(b.species)} species`, fmtSize(b.bytes)];
  const where = b.bundled ? "bundled" : b.available ? "downloads from Zenodo" : null;
  if (where) bits.push(where);
  const head = `${b.label} — ${bits.join(", ")}`;
  return b.available ? head : `${head} — ${b.unavailableReason}`;
}

// The line under the picker, BEFORE anything is loaded. This is the only moment
// at which the choice is still free, so it is where the warning belongs.
//
// `pending` is the whole reason this takes an option: the sentence below is in
// the present tense, and the present tense is a claim about the database in
// memory, not about the dropdown. Once something IS loaded and the picker has
// been moved off it, the same words become false — and false in the one
// direction this page exists to prevent, naming a catalogue nothing was
// profiled against. So the commitment moves to the conditional.
export function biomeNote(b, { pending = false } = {}) {
  if (!b) return "";
  if (!b.available) {
    return `${b.label} (${catalogueName(b)}) is not downloadable yet — ${b.unavailableReason}. ` +
      `Pick another biome, or load the file from your own disk.`;
  }
  const hint = b.hint ? ` — ${b.hint}` : "";
  const commits = pending
    ? `Loading it WOULD report everything you profile against THIS catalogue: sylph would name `
    : `Everything you profile will be reported against THIS catalogue: sylph names `;
  const rest = pending
    ? `the closest genomes it contains and say nothing about anything it does not contain, so a ` +
      `sample from another environment would still produce a full, plausible table. ` +
      `Pick the biome your sample came from.`
    : `the closest ` +
      `genomes it contains and says nothing about anything it does not contain, so a sample from ` +
      `another environment still produces a full, plausible table. Pick the biome your sample came from.`;
  return `${b.label}${hint}. ${catalogueName(b)}, ${fmtCount(b.species)} species, ${fmtSize(b.bytes)}. ` +
    commits + rest;
}

// Is the picker pointing at the database that is actually in memory?
//
// Nothing compared these two before, and nothing had to: with one reference
// database the picker could not be wrong. With nineteen, moving the dropdown is
// a one-gesture way to put a catalogue name on screen that no number underneath
// it came from — no click, no load, no warning. `loaded` null means nothing is
// in memory yet, and then the picker describes a plan, which is honest.
export function selectionMatchesLoaded(loaded, picked, localSelected = false) {
  if (!loaded) return true;
  if (localSelected) return !!loaded.local;
  if (!picked || loaded.local) return false;
  return picked.key === loaded.key;
}

// Said FIRST, before the entry the picker is on, and it names the database that
// is really loaded — the four surfaces that can name a reference (this note, the
// status line, the matrix header, the exports) then say the same thing instead
// of two of them contradicting the other two.
export function notLoadedNote(loaded) {
  if (!loaded) return "";
  const who = loaded.local
    ? `your own file ${loaded.file}`
    : `${loaded.label} (${loaded.catalogue})`;
  return `NOT LOADED — ${who} is still the database in memory, and anything you profile now is ` +
    `reported against IT, not against the entry selected above. Click "Load database" to switch. ` +
    `If you did:`;
}

// Does the reference we are NAMING still describe the database the workers hold?
//
// Re-reading a database out of the local cache — a 32/64-bit build switch, or a
// bigger worker pool — can hand back different bytes than the ones currentRef
// was minted from: another tab is free to invalidate and rewrite that entry in
// between. Comparing the workers with each other cannot see it (they all read
// the same new file and agree perfectly); only comparing them with what the page
// still claims can.
export function refMetaMismatch(ref, meta) {
  if (!ref || !meta) return "";
  const diffs = [];
  const cmp = (name, was, now) => {
    if (was == null || now == null) return;
    if (typeof was === "number" && !Number.isFinite(was)) return;
    if (typeof now === "number" && !Number.isFinite(now)) return;
    if (was !== now) diffs.push(`${name} ${was} → ${now}`);
  };
  cmp("genomes", ref.genomes, Number(meta.database_size));
  cmp("k", ref.k, meta.k);
  cmp("c", ref.c, meta.c);
  cmp("bytes", ref.bytes, Number(meta.bytes));
  return diffs.join(", ");
}

// ---- the <select> ------------------------------------------------------------

// One <optgroup> per family. Nineteen entries flat is a scroll; grouped, the
// four families are what you scan and the entry is what you pick.
//
// Unavailable entries are rendered DISABLED rather than dropped: a database that
// exists but has no URL yet is information ("it is coming"), and silently
// missing entries are indistinguishable from a broken catalogue.
export function renderDbSelect(select, catalog, { selected } = {}) {
  if (!select) return null;
  const doc = select.ownerDocument;
  select.textContent = "";
  for (const g of catalog.groups) {
    const og = doc.createElement("optgroup");
    og.label = g.label;
    for (const b of g.biomes) {
      const opt = doc.createElement("option");
      opt.textContent = optionLabel(b);
      opt.dataset.biome = b.key;
      if (b.available) {
        opt.value = b.url;
      } else {
        opt.value = "";
        opt.disabled = true;
      }
      og.appendChild(opt);
    }
    select.appendChild(og);
  }
  // Always last, always present, and NOT part of the catalogue: it is a path
  // into the application, not a reference database. A user with their own
  // .syldb keeps working whatever the catalogue says.
  const og = doc.createElement("optgroup");
  og.label = "Your own file";
  const local = doc.createElement("option");
  local.value = LOCAL_VALUE;
  local.textContent = "Local file… (.syldb on your computer)";
  og.appendChild(local);
  select.appendChild(og);

  const wanted = selected && biomeByKey(catalog, selected);
  const pick = (wanted?.available && wanted) ||
    allBiomes(catalog).find((b) => b.available) || null;
  if (pick) select.value = pick.url;
  return pick;
}

export function rememberBiome(key) {
  try { localStorage.setItem(BIOME_STORAGE_KEY, key); } catch { /* private mode */ }
}

export function recallBiome() {
  try { return localStorage.getItem(BIOME_STORAGE_KEY) || ""; } catch { return ""; }
}

// ---- what a result was profiled against --------------------------------------

// The identity of the database a run used, frozen at load time. Everything that
// has to name the reference — the status line, the matrix header, the exports —
// reads this and only this, so they cannot drift apart or describe the picker's
// CURRENT value instead of the one the numbers came from.
export function makeDbRef({ biome, dbMeta, label, source, url }) {
  return {
    key: biome?.key ?? "local",
    label: biome?.label ?? `Local file — ${label ?? "unknown"}`,
    catalogue: biome ? catalogueName(biome) : "",
    version: biome?.version ?? "",
    species: biome?.species ?? NaN,
    file: biome?.file || label || "",
    url: biome?.url || url || "",
    doi: biome?.doi ?? "",
    local: !biome,
    genomes: Number(dbMeta?.database_size),
    k: dbMeta?.k,
    c: dbMeta?.c,
    bytes: Number(dbMeta?.bytes),
    source: source ?? "",
    at: new Date().toISOString(),
  };
}

// Two databases are the same reference when they are the same file from the same
// place. Used to decide whether results already on screen may be kept when a
// different database is loaded — they may not, ever, because a matrix that mixes
// two catalogues is wrong in a way nothing downstream can detect.
export function sameDbRef(a, b) {
  if (!a || !b) return false;
  return a.key === b.key && a.url === b.url && a.file === b.file && a.genomes === b.genomes;
}

// The check that costs nothing and catches a mislabelled deposit: the catalogue
// says how many genomes this database has, sylph says how many it loaded. If
// they disagree, the label on every export from this session is wrong.
export function genomeCountMismatch(ref) {
  if (!ref || ref.local) return "";
  if (!Number.isFinite(ref.species) || !Number.isFinite(ref.genomes)) return "";
  if (ref.species === ref.genomes) return "";
  return `WARNING: this file holds ${fmtCount(ref.genomes)} genomes but the catalogue entry ` +
    `"${ref.key}" says ${fmtCount(ref.species)}. The file at that URL is not the one this ` +
    `entry describes — treat the biome label as unverified.`;
}

// The short form, for the database status line — which goes on to give the
// genome count, k and c itself, so this stops at the identity.
export function refShort(ref) {
  if (!ref) return "";
  return ref.local
    ? `${ref.file} — biome unknown (your own file)`
    : `${ref.label} (${ref.file}) — ${ref.catalogue}`;
}

// One line, for the matrix header: the same identity plus what sylph actually
// loaded, which is what makes it checkable rather than merely stated.
export function refLine(ref) {
  if (!ref) return "";
  if (ref.local) {
    return `Local database ${ref.file} — biome unknown: this page cannot tell which catalogue ` +
      `a file from your disk was built from.`;
  }
  return `${ref.label} — ${ref.catalogue}, ${fmtCount(ref.genomes)} genomes`;
}

// ---- exports -----------------------------------------------------------------

// An exported matrix has to be readable a year later, on someone else's
// computer, with no memory of which biome was picked. That is the whole reason
// these lines exist — a plausible-but-wrong profile is only ever caught by
// re-reading the file that came out of it.
//
// Comment lines rather than an extra column: `#` is what sylph, MetaPhlAn and
// every TSV reader in this field already skip (pandas: comment="#"), the header
// row stays exactly what it was, and a spreadsheet that does not skip them shows
// them at the top rather than hiding them. Numbers are written plain (no
// thousands separators) so a comma-separated file has no commas inside them.
export function refCommentLines(ref, { samples, rows, tool = "PeekMicrobiome" } = {}) {
  const out = [`# ${tool} — abundance matrix, taxonomic (relative) abundance in %`];
  if (ref?.local) {
    out.push(`# reference database: LOCAL FILE ${ref.file} — biome unknown, chosen from disk`);
  } else if (ref) {
    out.push(`# reference database: ${ref.label} [${ref.key}] — ${ref.catalogue}`);
    if (ref.url) out.push(`# database file: ${ref.file} — ${ref.url}`);
    if (ref.doi) out.push(`# database DOI: ${ref.doi}`);
  } else {
    out.push("# reference database: unknown");
  }
  if (ref) {
    const params = [`genomes=${Number.isFinite(ref.genomes) ? ref.genomes : "?"}`];
    if (ref.k != null) params.push(`k=${ref.k}`);
    if (ref.c != null) params.push(`c=${ref.c}`);
    if (Number.isFinite(ref.species) && !ref.local) params.push(`catalogue_species=${ref.species}`);
    out.push(`# database: ${params.join(", ")}`);
    const mismatch = genomeCountMismatch(ref);
    if (mismatch) out.push(`# ${mismatch}`);
  }
  if (Number.isFinite(samples) || Number.isFinite(rows)) {
    out.push(`# matrix: ${Number.isFinite(rows) ? rows : "?"} species x ` +
      `${Number.isFinite(samples) ? samples : "?"} samples`);
  }
  out.push(`# exported: ${new Date().toISOString()}`);
  out.push("# every abundance below is relative to the reference database named above and to " +
    "nothing else: sylph reports the closest genomes that database contains, and reports " +
    "nothing at all about species it does not contain. A sample from another environment " +
    "still produces a full, plausible table.");
  return out;
}

// The biome in the file NAME too. A downloads folder is where these files are
// actually told apart, and "abundance_matrix.tsv" is the same name for all
// nineteen references.
export function refSlug(ref) {
  const raw = ref?.local ? `local-${ref.file || "db"}` : (ref?.key || "unknown");
  return String(raw).replace(/\.syldb$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40)
    || "unknown";
}
