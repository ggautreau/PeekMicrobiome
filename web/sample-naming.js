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

// Anything after the mate marker that is a whole dot/underscore/dash-separated
// segment. Non-greedy, and each segment excludes separators, so the marker
// itself is found at the earliest position that leaves a valid tail.
const MATE_RE = new RegExp(
  `^(.+?)[._-]R?([12])((?:[._-][^._-]+)*?)\\.(${FASTQ_EXT})(\\.gz)?$`,
  "i",
);

/**
 * Recognise `<base><sep>[R]<1|2><suffixes>.<fastq ext>[.gz]`.
 *
 * Returns `{ key, mate }`, or null when the name carries no mate marker.
 *
 * `key` is base + suffixes, i.e. the whole name minus the marker — NOT just the
 * base. Mates must agree on everything else, otherwise `a_1.clean.fq.gz` would
 * pair with `a_2.raw.fq.gz`: two different files, silently profiled as one
 * sample.
 */
export function matePattern(name) {
  const m = String(name).match(MATE_RE);
  if (!m) return null;
  return { key: m[1] + (m[3] ?? ""), base: m[1], mate: String(m[2]) };
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
