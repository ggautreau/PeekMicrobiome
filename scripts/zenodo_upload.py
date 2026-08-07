#!/usr/bin/env python3
"""Upload the biome databases to Zenodo as ONE record.

    export ZENODO_TOKEN=...                 # zenodo.org/account/settings/applications/tokens/new
    python3 scripts/zenodo_upload.py                 # create a draft and upload
    python3 scripts/zenodo_upload.py --sandbox       # rehearse on sandbox.zenodo.org first
    python3 scripts/zenodo_upload.py --deposition 12345   # resume / add to an existing draft

One record rather than nineteen: Zenodo allows 50 GB and 100 files per record,
and the whole set is 5.9 GB across 19 files. One DOI to cite, one page to
maintain, and the per-file URLs the web app needs come out of the same record.

It does NOT publish. Publishing mints a permanent DOI and cannot be undone, so
the script stops at the draft and prints the link for you to review. Upload is
resumable: a file already present with the right size is skipped.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DBS = ROOT / "data" / "biome-dbs"
MANIFEST = DBS / "manifest.tsv"
GUT = ROOT / "gut.syldb"

# What the databases were actually built with. build_biome_dbs.sh defaults to the
# same values; if you change them there, change them here — the description is
# the only place a reader can learn what they are holding.
SYLPH_VERSION = "0.9.0"
C_PARAM = 200
K_PARAM = 31


def api(base, path, token, method="GET", data=None, ctype="application/json"):
    url = f"{base}{path}{'&' if '?' in path else '?'}access_token={token}"
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    if body:
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf8", "replace")[:400]
        raise SystemExit(f"Zenodo {method} {path} -> HTTP {e.code}\n{detail}")


def put_file(bucket, name, path: Path, token):
    """Zenodo's bucket API: a plain PUT of the file, streamed."""
    url = f"{bucket}/{name}?access_token={token}"
    size = path.stat().st_size
    with path.open("rb") as fh:
        req = urllib.request.Request(url, data=fh, method="PUT")
        req.add_header("Content-Type", "application/octet-stream")
        req.add_header("Content-Length", str(size))
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read() or b"{}")


def md5(path: Path, chunk=1 << 20):
    h = hashlib.md5()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def read_manifest():
    """(name, version, genomes, bytes) per catalogue, from what was actually built."""
    rows = []
    with MANIFEST.open() as fh:
        for r in csv.reader(fh, delimiter="\t"):
            if len(r) >= 4:
                rows.append((r[0], r[1], int(r[2]), int(r[3])))
    return rows


def description(rows):
    total_species = sum(r[2] for r in rows)
    lines = [
        "<p>Pre-built <a href='https://github.com/bluenote-1577/sylph'>sylph</a> databases built "
        "<strong>from</strong> the "
        "<a href='https://www.ebi.ac.uk/metagenomics/browse/genomes'>MGnify genome catalogues</a>, "
        "one file per biome. Ready for <code>sylph profile</code> on the command line, and used by "
        "<a href='https://github.com/ggautreau/PeekMicrobiome'>PeekMicrobiome</a> in the browser.</p>",
        f"<p><strong>Built with sylph {SYLPH_VERSION}</strong>, "
        f"<code>sylph sketch -c {C_PARAM} -k {K_PARAM}</code> "
        "(default <code>--min-spacing 30</code>, pseudotax tracking enabled). The version matters: "
        "the <code>.syldb</code> format has changed across sylph releases, and a database has to be "
        "read by a version that understands it. Re-sketch from the source genomes if you need "
        "another <code>c</code> or <code>k</code> — the pipeline that produced these is "
        "<code>scripts/build_biome_dbs.sh</code> in the PeekMicrobiome repository.</p>",
        f"<p><strong>{len(rows)} catalogues, {total_species:,} species representatives.</strong> "
        "Each database was sketched from the species representatives of its catalogue and verified "
        "with <code>sylph inspect</code> before publication; the species counts below are the ones "
        "sylph reports, not the ones the API announces.</p>",
        "<p><strong>They are not interchangeable and must not be merged.</strong> MGnify "
        "dereplicates each catalogue independently and they overlap — 10% of the named species are "
        "shared between human-oral and human-skin. Loading two at once lists the same species "
        "twice and splits its k-mers arbitrarily: sylph's pseudotax reassignment settles close "
        "genomes within one database, it does not arbitrate between two separately dereplicated "
        "catalogues. Profile against the catalogue matching your sample's biome.</p>",
        "<table><tr><th>catalogue</th><th>MGnify version</th><th>species</th><th>size</th></tr>",
    ]
    for name, ver, n, size in sorted(rows, key=lambda r: -r[3]):
        lines.append(f"<tr><td>{name}</td><td>{ver}</td><td>{n:,}</td>"
                     f"<td>{size / 2**20:.0f} MB</td></tr>")
    lines.append("</table>")
    lines.append(
        "<p><strong>Please cite</strong>, if you use these: "
        "<a href='https://doi.org/10.1093/nar/gkac1080'>MGnify</a>, the catalogue paper for the "
        "biome you profiled against, and "
        "<a href='https://doi.org/10.1038/s41587-024-02412-y'>sylph</a> (Shaw &amp; Yu, "
        "Nat. Biotechnol. 2024).</p>")
    lines.append(
        "<p>Released under <strong>CC0</strong>: no rights are asserted over the sketches "
        "themselves. A .syldb is a FracMinHash of genomes that are not ours — a mechanical "
        "transform, with no creative step to own. EMBL-EBI places no restriction on "
        "redistribution and asks for attribution as good scientific practice, which is what the "
        "citations above are for. The databases are data, not code: the GPL of PeekMicrobiome "
        "does not cover them.</p>")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sandbox", action="store_true", help="use sandbox.zenodo.org")
    ap.add_argument("--deposition", type=int, help="resume an existing draft")
    ap.add_argument("--dry-run", action="store_true", help="show what would be sent, upload nothing")
    args = ap.parse_args()

    token = os.environ.get("ZENODO_SANDBOX_TOKEN" if args.sandbox else "ZENODO_TOKEN")
    if not token and not args.dry_run:
        raise SystemExit("Set ZENODO_TOKEN (or ZENODO_SANDBOX_TOKEN with --sandbox).")
    base = "https://sandbox.zenodo.org/api" if args.sandbox else "https://zenodo.org/api"

    rows = read_manifest()
    files = [(DBS / f"{name}.syldb", name) for name, *_ in rows]
    if GUT.exists():
        files.append((GUT, "human-gut"))
        rows.append(("human-gut", "v2.0.2", 4744, GUT.stat().st_size))
    missing = [p for p, _ in files if not p.exists()]
    if missing:
        raise SystemExit("missing: " + ", ".join(str(p) for p in missing))

    total = sum(p.stat().st_size for p, _ in files)
    print(f"{len(files)} files, {total / 2**30:.2f} GiB")
    if total > 50 * 2**30:
        raise SystemExit("over Zenodo's 50 GB per-record limit — ask for a quota increase first")

    meta = {"metadata": {
        "title": "sylph databases for the MGnify genome catalogues (19 biomes)",
        "upload_type": "dataset",
        "description": description(rows),
        "creators": [{"name": "Gautreau, Guillaume",
                      "affiliation": "MaIAGE (UR 1404), INRAE, Université Paris-Saclay"}],
        "keywords": ["metagenomics", "sylph", "MGnify", "microbiome", "reference database",
                     "taxonomic profiling"],
        # CC0, not CC-BY: a .syldb is a FracMinHash of genomes that are not ours,
        # a mechanical transform with no creative step. Asserting a licence over
        # it would claim rights we do not hold. EMBL-EBI places no restriction on
        # redistribution and asks for attribution "in accordance with good
        # scientific practice" — which the description handles, and which academic
        # norms enforce better than a licence clause.
        "license": "cc-zero",
        "related_identifiers": [
            {"relation": "isSupplementTo", "identifier": "https://github.com/ggautreau/PeekMicrobiome",
             "scheme": "url"},
            {"relation": "isDerivedFrom", "identifier": "https://www.ebi.ac.uk/metagenomics/browse/genomes",
             "scheme": "url"},
            # The two papers this record stands on. Listed as related works so a
            # reader of the Zenodo page finds them without reading the prose, and
            # so the citation graph records that these databases lean on both.
            # Shaw & Yu, Nat. Biotechnol. 2024 — the tool that built them:
            {"relation": "cites", "identifier": "10.1038/s41587-024-02412-y",
             "scheme": "doi", "resource_type": "publication-article"},
            # Richardson et al., Nucleic Acids Res. 2023 — the genomes they came from:
            {"relation": "cites", "identifier": "10.1093/nar/gkac1080",
             "scheme": "doi", "resource_type": "publication-article"},
        ],
    }}

    if args.dry_run:
        print(json.dumps(meta, indent=1)[:1500])
        for p, name in files:
            print(f"  would upload {name}.syldb  {p.stat().st_size / 2**20:.0f} MB")
        return

    if args.deposition:
        dep = api(base, f"/deposit/depositions/{args.deposition}", token)
        api(base, f"/deposit/depositions/{args.deposition}", token, "PUT", meta)
    else:
        dep = api(base, "/deposit/depositions", token, "POST", meta)
    dep_id, bucket = dep["id"], dep["links"]["bucket"]
    print(f"draft {dep_id}: {dep['links']['html']}")

    present = {f["filename"]: f["filesize"] for f in
               api(base, f"/deposit/depositions/{dep_id}/files", token)}

    for p, name in files:
        fn, size = f"{name}.syldb", p.stat().st_size
        if present.get(fn) == size:
            print(f"  = {fn} already there ({size / 2**20:.0f} MB)")
            continue
        print(f"  ↑ {fn} ({size / 2**20:.0f} MB)…", flush=True)
        got = put_file(bucket, fn, p, token)
        # Zenodo returns the checksum it computed; compare rather than trust.
        remote = (got.get("checksum") or "").replace("md5:", "")
        local = md5(p)
        if remote and remote != local:
            raise SystemExit(f"checksum mismatch on {fn}: zenodo {remote} != local {local}")
        print(f"    ok, md5 {local}")

    print(f"\nDraft ready — NOT published: {dep['links']['html']}")
    print("Review it, then publish from the web page (or POST .../actions/publish).")
    print("Publishing mints a permanent DOI and cannot be undone.")
    print("\nOnce published, each file is reachable at:")
    print(f"  https://zenodo.org/api/records/<record_id>/files/<name>.syldb/content")
    print("which is the form web/db/biomes.json expects (CORS-enabled).")


if __name__ == "__main__":
    sys.exit(main())
