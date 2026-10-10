#!/usr/bin/env bash
# Fetch what scripts/funprofiler/run.py needs, once.
#
#   ~98 MB from Zenodo (the KEGG KO sketches, CC BY 4.0, record 10045253) and a
#   10,000-read demo FASTQ from fmh-funprofiler's own repository, so the test
#   runs on the reference implementation's data rather than on data of ours.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

[[ -f KOs_scaled_1000.sig.zip ]] || curl -fL --progress-bar -o KOs_scaled_1000.sig.zip \
  "https://zenodo.org/records/10045253/files/KOs_sketched_scaled_1000.sig.zip?download=1"

[[ -d fmh-demo ]] || git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/KoslickiLab/fmh-funprofiler.git fmh-demo
( cd fmh-demo && git sparse-checkout set demo )

python3 - <<'PY'
import zipfile, gzip, json


def is_sig(name):
    """Every signature member, INCLUDING sourmash's collision suffixes.

    sourmash names members by an md5 stem; when two collide the second is written
    `<stem>.sig.gz_0`, the third `<stem>.sig.gz_1`. Matching only `.sig.gz`
    dropped 4,765 members of 58,425 — 1,100 of them at ksize 33.
    """
    return ".sig.gz" in name
# k=11 amino acids is written as ksize 33 by sourmash; see page.html.
z = zipfile.ZipFile("KOs_scaled_1000.sig.zip")
out, kept = [], 0
for n in z.namelist():
    if not is_sig(n):
        continue
    raw = gzip.decompress(z.read(n)).decode()
    if '"ksize":33' in raw.replace(" ", ""):
        out.append(raw)
        kept += 1
    if kept >= 4000:
        break
json.dump(out, open("ko_subset_plain.json", "w"))
print(f"{kept} KO signatures at k=33")

seqs = []
with open("fmh-demo/demo/metagenome_example.fastq") as f:
    for i, line in enumerate(f):
        if i % 4 == 1:
            seqs.append(line.strip())
json.dump(seqs, open("reads.json", "w"))
print(f"{len(seqs)} reads")

# Full scale, for run_full.py and web/db/kegg/ko-sketches-k11.ndjson.gz: every
# k=11 signature the archive holds that can match anything.
#
# The manifest declares 14,606 signatures at ksize 33 and the archive holds all
# of them. sourmash names members by the md5 of the sketch and suffixes
# collisions (`.sig.gz_0`, `.sig.gz_1`), so an earlier `.endswith(".sig.gz")`
# skipped 1,100 of them and shipped 13,506. Of those 1,100:
#
#   - 1,096 are EMPTY. Every empty sketch has the same md5, which is why they
#     collided. One more empty one, K00115, was among the 13,506 kept.
#   - 4 are NOT: each is hash-for-hash a copy of an ortholog that was kept —
#     K02370 = K02367, K16419 = K16418, K22332 = K18976, K24408 = K16116 — and
#     collided because identical sketches share an md5. sourmash reports both
#     twins when one matches, so skipping them was a real divergence from the
#     reference implementation, even though no measured sample hit one.
#
# Kept here: the 13,509 non-empty ones. An empty sketch cannot match and
# sourmash never reports one, so dropping all 1,097 changes no profile; it only
# keeps the count the page announces equal to what it can detect.
import gzip as _gz
with open("ko_full_k33.ndjson", "w") as out:
    n = empty = 0
    for name in z.namelist():
        if not is_sig(name):
            continue
        raw = _gz.decompress(z.read(name)).decode()
        if '"ksize":33' not in raw.replace(" ", ""):
            continue
        sigs = json.loads(raw)
        if not any(mh["mins"] for s in sigs for mh in s["signatures"]
                   if mh["ksize"] == 33):
            empty += 1
            continue
        out.write(json.dumps(sigs, separators=(",", ":")) + "\n")
        n += 1
print(f"{n} signatures at k=33 for the full-scale run ({empty} empty, skipped)")

PY
gzip -9 -kf "$HERE/ko_full_k33.ndjson"
