#!/usr/bin/env bash
#
# Build the multi-biome SCREENING database from the per-catalogue .syldb files
# that build_biome_dbs.sh already produced. No genome is re-downloaded and none
# is re-sketched: the whole thing is derived from data/biome-dbs/*.syldb plus
# gut.syldb, in about four minutes.
#
#   ./scripts/build_screening_db.sh
#   C=4000 ./scripts/build_screening_db.sh        # smaller, still same verdict
#   VARIANTS="4000 8000" ./scripts/build_screening_db.sh   # extra coarser builds
#   MANIFEST_ONLY=1 ./scripts/build_screening_db.sh        # only rewrite manifest.tsv
#
# WHAT IT IS FOR
# --------------
# With 19 catalogues to choose from, the main way to get a wrong answer is to
# profile a sample against the wrong biome: sylph reports whatever looks
# closest and never says "this sample is not from here". The screening database
# holds every catalogue at once, at a coarse `c`, purely to answer "which
# catalogue should I actually use?" — then the user profiles against that one
# catalogue at c=200 for the real numbers.
#
# HOW IT IS BUILT, IN THREE STEPS
# -------------------------------
# 1. syldb-reduce re-sub-samples every catalogue from c=200 to c=2000. This is
#    exact, not approximate: .syldb stores FracMinHash *hashes*, kept when
#    hash < u64::MAX/c, so dropping those >= u64::MAX/2000 gives precisely the
#    sketch that -c 2000 would have produced. See the header of
#    sylph-wasm/src/bin/syldb-reduce.rs for the full argument and its caveat.
#    That caveat is NOT small and the header spells it out: min_spacing
#    re-partitions markers between genome_kmers and the pseudotax list, and only
#    genome_kmers feeds the containment count. The union is exact, but
#    genome_kmers ends ~11% smaller than in a fresh sketch at the same c
#    (measured: 2228 vs 2509 and 1555 vs 1755 on two control genomes; 13.3% of
#    the union sits in the pseudotax list here against 1.6-1.8% in a fresh
#    build). For containment this database behaves like c ~ 2250, not 2000.
#
# 2. The catalogues are dereplicated AGAINST EACH OTHER by GTDB species name.
#    MGnify dereplicates each catalogue independently, so 2114 species exist in
#    two or more catalogues as two or more different assemblies. Merged into
#    one database those copies compete, pseudotax reassignment gives each k-mer
#    to whichever copy scored higher, and the loser vanishes — which is how, in
#    the un-dereplicated build, a human gut sample got Coprococcus eutactus_A
#    labelled mouse-gut and Agathobacter rectalis labelled marine-sediment.
#    One genome per species, labelled with the SET of catalogues containing it.
#
#    WHAT THIS STEP CANNOT DO: 23312 of the 56782 merged genomes (41.1%) have no
#    GTDB species name at all — novel species, overwhelmingly soil (10348),
#    marine (5796) and marine-sediment (2050). Name-based dereplication cannot
#    reach them: two unnamed genomes from two catalogues may be the same
#    organism and both are kept. Those biomes are over-represented in the merged
#    database by an unknown amount, and their screening scores read as a floor.
#
# 3. scripts/screen_biome.py turns a profile run into a per-catalogue verdict,
#    crediting each detected species to every catalogue that contains it and
#    reporting separately the abundance that is exclusive to each.
#
# NOT FOR PROFILING. The screening database mixes biomes on purpose; its
# abundances are a signal for catalogue choice, not taxonomy. Profile against a
# single catalogue for that.
#
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${OUT:-$ROOT/data/screening}"
DBS="${DBS:-$ROOT/data/biome-dbs}"
GUT="${GUT:-$ROOT/gut.syldb}"
C="${C:-2000}"
REDUCE="${REDUCE:-$ROOT/sylph-wasm/target/release/syldb-reduce}"
# Extra, coarser builds derived from the dereplicated database at $C.
VARIANTS="${VARIANTS:-4000 8000}"
# Optional: UHGG genomes-all_metadata.tsv, to fill the human-gut lineages that
# web/db/lineage.json leaves empty. Everything works without it.
UHGG_META="${UHGG_META:-}"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }

[ -x "$REDUCE" ] || { log "building syldb-reduce"; (cd "$ROOT/sylph-wasm" && cargo build --release --bin syldb-reduce); }
mkdir -p "$OUT"

# The manifest is never typed: it is regenerated from the files that exist, so
# it cannot drift away from them. MANIFEST_ONLY=1 stops right after that.
write_manifest() {
  log "writing $OUT/manifest.tsv from the files themselves"
  bash "$ROOT/scripts/write_screening_manifest.sh" "$OUT" > "$OUT/manifest.tsv"
  bash "$ROOT/scripts/check_screening_manifest.sh"
}
if [ -n "${MANIFEST_ONLY:-}" ]; then
  write_manifest
  exit 0
fi

# --- 1. reduce + merge -------------------------------------------------------
INPUTS=("human-gut=$GUT")
for f in "$DBS"/*.syldb; do
  INPUTS+=("$(basename "$f" .syldb)=$f")
done
log "reducing and merging ${#INPUTS[@]} catalogues to c=$C"
"$REDUCE" --c "$C" \
  --out "$OUT/screening-c$C.syldb" \
  --biome-tsv "$OUT/genome-biome.raw.tsv" \
  "${INPUTS[@]}"

# --- 2. lineage + cross-catalogue dereplication ------------------------------
log "annotating with GTDB lineage"
python3 "$ROOT/scripts/annotate_screening_map.py" \
  "$OUT/genome-biome.raw.tsv" -o "$OUT/genome-biome.tsv" \
  ${UHGG_META:+--uhgg-metadata "$UHGG_META"}

log "dereplicating across catalogues by species name"
python3 "$ROOT/scripts/derep_screening.py" "$OUT/genome-biome.tsv" \
  --keep-out "$OUT/keep.txt" --map-out "$OUT/species-biome.tsv"

log "writing the dereplicated screening database"
"$REDUCE" --c "$C" --keep "$OUT/keep.txt" \
  --out "$OUT/screening-c$C-derep.syldb" \
  "screening=$OUT/screening-c$C.syldb"

# --- 3. audit ----------------------------------------------------------------
# This is a real gate, not a printout: --check recomputes u64::MAX/c on its own
# (it does not call the tool's threshold(), which is what made the old check
# unable to fail), walks BOTH hash vectors, and exits 1 on any violation, on a
# mixed k / min_spacing / c, on a missing pseudotax vector or on a duplicate
# genome name. Under `set -e` that stops the build.
log "auditing the result"
"$REDUCE" --check "$OUT/screening-c$C-derep.syldb"
"$REDUCE" --check "$OUT/screening-c$C.syldb"

# --- 4. coarser variants + manifest ------------------------------------------
for v in $VARIANTS; do
  [ "$v" -gt "$C" ] || continue
  log "deriving the c=$v variant"
  "$REDUCE" --c "$v" \
    --out "$OUT/screening-c$v-derep.syldb" \
    "screening-c$v=$OUT/screening-c$C-derep.syldb"
  "$REDUCE" --check "$OUT/screening-c$v-derep.syldb"
done

write_manifest

cat >&2 <<EOF

Done.
  $OUT/screening-c$C-derep.syldb   <- ship this one
  $OUT/species-biome.tsv           <- genome_file -> species + catalogue set
  $OUT/screening-c$C.syldb         <- pre-dereplication, kept for comparison only
  $OUT/manifest.tsv                <- measured off the files above

Screen a sample:
  sylph profile $OUT/screening-c$C-derep.syldb sample.sylsp -o screen.tsv
  python3 scripts/screen_biome.py screen.tsv
EOF
