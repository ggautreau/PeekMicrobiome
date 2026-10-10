// Working out which dropped files belong to the same sample, and which two are
// the mates of one paired run.
//
// Lives apart from multi.js so it can be tested in plain Node: multi.js touches
// the DOM as soon as it is imported.
//
// The rule this file exists for: a mate marker is NOT usually glued to the
// extension. Pipelines write their own suffixes after it, and sequencers put the
// lane/chunk index after it:
//
//   V350342913_L03_UDB-193_1.clean.fq.gz     <- .clean after the marker
//   SampleName_S1_L001_R1_001.fastq.gz       <- _001 after the marker (bcl2fastq)
//   sample_2.trimmed.paired.fq.gz            <- two suffixes
//
// The previous pattern required `_1` to be immediately followed by `.fastq`, so
// none of these grouped: every file landed as its own single-end sample and the
// paired-end path was never taken.

const FASTQ_EXT = "fastq|fq|fnq";

const EXT_RE = new RegExp(`^(.+)\\.(${FASTQ_EXT})(\\.gz)?$`, "i");
// A candidate marker: a separator, an optional R, a 1 or a 2, and then either
// the end of the name or another separator. A name can hold several.
const MARKER_RE = /[._-](R?)([12])(?=[._-]|$)/gi;
// What may follow the marker: whole dot/underscore/dash-separated segments.
const TAIL_RE = /^(?:[._-][^._-]+)*$/;

/**
 * Recognise `<base><sep>[R]<1|2><suffixes>.<fastq ext>[.gz]`.
 *
 * Returns `{ key, base, mate }`, or null when the name carries no mate marker.
 *
 * `key` is base + suffixes, i.e. the whole name minus the marker — NOT just the
 * base. Mates must agree on everything else, otherwise `a_1.clean.fq.gz` would
 * pair with `a_2.raw.fq.gz`: two different files, silently profiled as one
 * sample.
 *
 * WHICH MARKER, when a name has several. The pattern used to take the LEFTMOST,
 * and a `_1` inside the sample's own name then became the mate:
 * `sample_1_R1` and `sample_2_R1` both read as "sample_R1", mates 1 and 2 —
 * the first reads of two different samples profiled as one pair, with nothing
 * to say so. Taking the rightmost instead breaks the other way (`s_R1_2`, R1 in
 * two parts, would read as mate 2). So: an `R1`/`R2` marker wins over a bare
 * digit, because it is the one convention that only ever means a mate; among
 * markers of the same kind, the rightmost wins, because sample names come
 * first and sequencer suffixes after.
 */
export function matePattern(name) {
  const m = String(name).match(EXT_RE);
  if (!m) return null;
  const stem = m[1];
  let best = null;
  for (const c of stem.matchAll(MARKER_RE)) {
    if (c.index === 0) continue;                    // a marker needs a name before it
    const tail = stem.slice(c.index + c[0].length);
    if (!TAIL_RE.test(tail)) continue;
    const cand = { base: stem.slice(0, c.index), mate: c[2], tail, r: c[1] !== "" };
    if (!best || cand.r || !best.r) best = cand;
  }
  if (!best) return null;
  return { key: best.base + best.tail, base: best.base, mate: best.mate };
}

/**
 * Mate tags for every file of a drop at once — with the ambiguous ones refused.
 *
 * Returns `{ tags, conflicts }`: `tags` maps each name to its matePattern tag,
 * or to null when the name has no marker OR when another file claims the same
 * mate of the same sample; `conflicts` lists those as `{ key, mate, names }`.
 *
 * Two files that both say "I am mate 1 of x" cannot both be, and pairing them
 * with the mate-2 files in the order they were dropped is how two libraries get
 * mixed into one sample. Refused, the files are profiled single-end, each under
 * its own name — a sample the user can see is wrong, instead of one that only
 * looks right — and the page says why.
 */
export function mateTags(names) {
  const tags = new Map();
  const claims = new Map();
  for (const name of names) {
    const tag = matePattern(name);
    tags.set(name, tag);
    if (!tag) continue;
    const claim = `${tag.key}\u0000${tag.mate}`;
    if (!claims.has(claim)) claims.set(claim, { key: tag.key, mate: tag.mate, names: [] });
    claims.get(claim).names.push(name);
  }
  const conflicts = [];
  for (const c of claims.values()) {
    if (c.names.length < 2) continue;
    conflicts.push(c);
    for (const name of c.names) tags.set(name, null);
  }
  return { tags, conflicts };
}

/** Strip `.gz` and the FASTQ extension, for naming a single-end sample. */
export function stripFastqExt(name) {
  return String(name)
    .replace(/\.gz$/i, "")
    .replace(new RegExp(`\\.(${FASTQ_EXT})$`, "i"), "");
}

/** True when the name looks like a FASTQ this app can read. */
export function looksLikeFastq(name) {
  return new RegExp(`\\.(${FASTQ_EXT})(\\.gz)?$`, "i").test(String(name));
}
