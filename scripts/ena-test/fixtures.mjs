// The fixture tsv-parity.mjs profiles: a small, REAL pair of FASTQ files.
//
//   node scripts/ena-test/fixtures.mjs        (tsv-parity.mjs calls this itself)
//
// Why real reads rather than the synthetic ones node-suite.mjs generates: the
// question tsv-parity asks is whether both input paths produce the same
// abundance TABLE, and random ACGT matches nothing in any database, so a
// synthetic fixture would compare two empty tables and pass for ever. A few
// tens of thousands of reads of a real gut metagenome are enough for
// gut_mini.syldb to report species — measured: 50 000 reads of ERR14098592
// gives 2 species, 200 000 gives 3 — which is what makes the comparison mean
// something.
//
// It is fetched ONCE, with a single Range request for the first few MiB of the
// run (the file itself is 102 MiB and nothing here needs it), then trimmed to a
// whole number of records and re-gzipped so the fixture is a valid, complete
// gzip member rather than a truncated one. R2 is the reverse complement of R1:
// canonical k-mers are unchanged, so the pair profiles like the single file
// does, while the two streams still carry different bytes — a paired test whose
// two files were identical would not notice a mate being read twice.
//
// Output lands in scripts/ena-test/fx/, which is git-ignored. Delete it to
// re-fetch.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FX = path.join(HERE, "fx");

// The reference run of this project, and the one the live test uses.
export const RUN = "ERR14098592";
const URL_GZ = "https://ftp.sra.ebi.ac.uk/vol1/fastq/ERR140/092/ERR14098592/ERR14098592.fastq.gz";
// 8 MiB is about 66 000 records of this run: enough for species to be detected,
// small enough that fetching it is not an event.
const SLICE_BYTES = 8 * 1024 * 1024;
const RECORDS = Number(process.env.PARITY_RECORDS ?? 60000);

const R1 = path.join(FX, "R1.fastq.gz");
const R2 = path.join(FX, "R2.fastq.gz");
const META = path.join(FX, "meta.json");

const RC = { A: "T", C: "G", G: "C", T: "A", N: "N", a: "t", c: "g", g: "c", t: "a", n: "n" };
const revComp = (s) => { let o = ""; for (let i = s.length - 1; i >= 0; i--) o += RC[s[i]] ?? "N"; return o; };

export async function ensureFixture({ quiet = false } = {}) {
  if (fs.existsSync(R1) && fs.existsSync(R2) && fs.existsSync(META)) {
    return { ...JSON.parse(fs.readFileSync(META, "utf8")), r1: R1, r2: R2, fresh: false };
  }
  fs.mkdirSync(FX, { recursive: true });
  if (!quiet) console.log(`fixture: fetching the first ${SLICE_BYTES / 1024 ** 2} MiB of ${RUN} from the EBI…`);
  const resp = await fetch(URL_GZ, { headers: { Range: `bytes=0-${SLICE_BYTES - 1}` } });
  if (!resp.ok && resp.status !== 206) throw new Error(`the EBI answered HTTP ${resp.status} for ${RUN}`);
  const slice = Buffer.from(await resp.arrayBuffer());
  if (slice.length < 1024 * 1024) throw new Error(`got only ${slice.length} bytes of ${RUN}`);

  // A truncated gzip member: inflate as far as it goes and stop, rather than
  // treating the missing tail as corruption.
  const raw = zlib.gunzipSync(slice, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  const lines = raw.toString("latin1").split("\n");
  const recs = [];
  for (let i = 0; i + 3 < lines.length && recs.length < RECORDS; i += 4) {
    if (!lines[i].startsWith("@")) break;      // not on a record boundary any more
    recs.push([lines[i], lines[i + 1], lines[i + 2], lines[i + 3]]);
  }
  if (recs.length < 1000) throw new Error(`only ${recs.length} whole records came out of the slice`);

  const text1 = recs.map((r) => r.join("\n")).join("\n") + "\n";
  const text2 = recs.map((r) =>
    [`${r[0]}/2`, revComp(r[1]), r[2], [...r[3]].reverse().join("")].join("\n")).join("\n") + "\n";
  fs.writeFileSync(R1, zlib.gzipSync(Buffer.from(text1, "latin1"), { level: 6 }));
  fs.writeFileSync(R2, zlib.gzipSync(Buffer.from(text2, "latin1"), { level: 6 }));
  const meta = {
    run: RUN, records: recs.length,
    bytes1: fs.statSync(R1).size, bytes2: fs.statSync(R2).size,
  };
  fs.writeFileSync(META, JSON.stringify(meta, null, 2));
  if (!quiet) {
    console.log(`fixture: ${meta.records.toLocaleString("en-US")} records → ` +
      `${(meta.bytes1 / 1024 ** 2).toFixed(1)} + ${(meta.bytes2 / 1024 ** 2).toFixed(1)} MiB in ${FX}`);
  }
  return { ...meta, r1: R1, r2: R2, fresh: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await ensureFixture();
  console.log(m.fresh ? "built" : `already present: ${m.records} records`);
}
