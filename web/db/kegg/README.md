# What is in here, and where it came from

## `ko-map.json` — 0.88 MB (0.21 MB gzipped)

KEGG ortholog names, and the KO → module → pathway membership, built by
`scripts/build_kegg_map.py` from KEGG's REST endpoints. Identifiers, names and
membership; no sequence.

KEGG is copyrighted by Kanehisa Laboratories. Academic use is free; any
non-academic use requires a commercial licence — see
<https://www.kegg.jp/kegg/legal.html>. The page asks the reader which they are
before it shows anything of KEGG's, and links those terms.

## `ko-sketches-k11.ndjson.gz` — 20 MB (48 MB of text)

FracMinHash sketches of 13,509 KEGG orthologs, amino-acid k = 11 (written as
ksize 33, sourmash's convention), scaled = 1000, seed 42. One signature per
line, so the file can be streamed into the profiler a line at a time rather than
parsed whole.

Derived by `scripts/funprofiler/fixtures.sh` from **Zenodo record 10045253**,
"KOs sketched, scaled 1000", Koslicki Lab, Penn State, **CC BY 4.0** — which is
what makes it redistributable here, with this attribution. The archive ships
k = 7, 11 and 15 together and only one is needed; extracting k = 11 alone is
what turns 98 MB into 20.

Why 13,509 and not the 14,606 the manifest declares: **1,097 of the 14,606 are
empty**, and an empty sketch cannot match anything, so sourmash never reports
one. They are orthologs too short to leave a hash at scaled = 1000. Leaving them
out changes no profile; it keeps the number the page announces equal to what it
can detect.

An earlier version shipped 13,506, for a different reason. sourmash names archive
members by the md5 of the sketch and suffixes collisions (`.sig.gz_0`,
`.sig.gz_1`), and `fixtures.sh` matched only `.sig.gz`, which skipped 1,100
signatures at ksize 33. 1,096 of them were empty — every empty sketch shares one
md5, hence the collisions. The other **4 were not**: each is hash for hash a copy
of an ortholog that was kept (K02370 = K02367, K16419 = K16418, K22332 = K18976,
K24408 = K16116). sourmash reports both twins when one matches; the page reported
one. No measured sample hit any of the four pairs, so no published comparison
changes, but it was a divergence from the reference implementation and it is
fixed. The manifest itself was right all along.

Cite: Hera, Liu, Wei, Rodriguez, Koslicki, "Metagenomic functional profiling: to
sketch or not to sketch?", *Bioinformatics* **40**, ii165–ii173 (2024),
doi:10.1093/bioinformatics/btae397.
