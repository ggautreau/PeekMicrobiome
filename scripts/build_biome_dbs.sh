#!/usr/bin/env bash
#
# Build one sylph .syldb per MGnify genome catalogue.
#
#   ./scripts/build_biome_dbs.sh                 # every catalogue, smallest first
#   ./scripts/build_biome_dbs.sh human-oral      # just one
#   KEEP_FASTA=1 ./scripts/build_biome_dbs.sh …  # do not delete the genomes afterwards
#
# Generalises build_gut_db.sh, which does the same for human-gut alone. UHGG *is*
# the human-gut catalogue: same FTP layout, same genomes-all_metadata.tsv, same
# species_catalogue/<bin>/<acc>/genome/<acc>.fna paths — verified on human-gut,
# human-oral, marine and soil.
#
# Disk is the constraint, not bandwidth. The FTP serves .fna UNCOMPRESSED, and
# the species representatives of a catalogue run from 180 MiB (zebrafish) to
# ~44 GiB (soil) — more than this machine has free. So:
#   - genomes are gzipped as they arrive (sylph reads gzip natively), which cuts
#     the footprint roughly threefold;
#   - one catalogue is processed at a time and its genomes are deleted as soon as
#     its .syldb exists;
#   - everything is resumable: an interrupted run re-downloads only what is
#     missing, and a catalogue whose .syldb is already there is skipped.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT/data/biome-dbs}"
WORK_DIR="${WORK_DIR:-$ROOT/data/biome-work}"
FTP="https://ftp.ebi.ac.uk/pub/databases/metagenomics/mgnify_genomes"
JOBS="${JOBS:-12}"
C_PARAM="${C_PARAM:-200}"          # sylph -c, must match what the web app expects
K_PARAM="${K_PARAM:-31}"
MIN_FREE_GB="${MIN_FREE_GB:-8}"    # refuse to start a catalogue below this
SYLPH="${SYLPH:-$ROOT/sylph-wasm/target/release/sylph}"

# Smallest first: the pipeline gets exercised on a 79-genome catalogue in two
# minutes rather than discovering a problem four hours into soil.
CATALOGUES=(
  "marine-eukaryotes vbeta"
  "zebrafish-fecal v1.0"
  "barley-rhizosphere v2.0"
  "honeybee-gut v1.0.1"
  "non-model-fish-gut v2.0"
  "human-vaginal v1.0"
  "maize-rhizosphere v1.0"
  "human-oral v1.0.1"
  "human-skin v1.0"
  "tomato-rhizosphere v1.0"
  "chicken-gut v1.0.1"
  "pig-gut v1.0"
  "sheep-rumen v1.0"
  "cow-rumen v1.0.1"
  "mouse-gut v1.0"
  "marine-sediment v1.0"
  "marine v2.0"
  "soil v1.0"
)

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }

free_gb() { df -BG --output=avail "$1" | tail -1 | tr -dc '0-9'; }

build_one() {
  local name="$1" version="$2"
  local base="$FTP/$name/$version"
  local work="$WORK_DIR/$name"
  local db="$OUT_DIR/$name.syldb"

  if [[ -s "$db" ]]; then
    log "$name: already built ($(du -h "$db" | cut -f1)) — skipping"
    return 0
  fi

  local avail; avail="$(free_gb "$ROOT")"
  if (( avail < MIN_FREE_GB )); then
    log "$name: only ${avail} GB free, need at least ${MIN_FREE_GB} — stopping"
    return 3
  fi

  mkdir -p "$work/genomes" "$OUT_DIR"
  local meta="$work/metadata.tsv" urls="$work/urls.txt"

  if [[ ! -s "$meta" ]]; then
    log "$name: metadata"
    curl -fsSL --retry 5 --retry-all-errors -o "$meta" \
      "$base/genomes-all_metadata.tsv" || { log "$name: metadata FAILED"; return 1; }
  fi

  if [[ ! -s "$urls" ]]; then
    # Species representatives only: Genome == Species_rep. The bin directory
    # groups accessions in hundreds (MGYG000000001 -> MGYG0000000).
    awk -F'\t' -v base="$base" '
      NR == 1 {
        for (i=1; i<=NF; i++) col[$i] = i
        g = col["Genome"]; r = col["Species_rep"]
        if (!g || !r) { print "metadata missing Genome/Species_rep" > "/dev/stderr"; exit 2 }
        next
      }
      $g == $r {
        acc = $g
        bin = sprintf("MGYG%07d", int(substr(acc, 5) / 100))
        printf "%s/species_catalogue/%s/%s/genome/%s.fna\n", base, bin, acc, acc
      }
    ' "$meta" > "$urls" || { log "$name: could not read metadata"; return 1; }
  fi

  local want; want="$(wc -l < "$urls")"
  log "$name: $want species representatives"

  # Gzipped on arrival — the FTP has no compressed variant, and the uncompressed
  # genomes of the larger catalogues do not fit on this disk.
  log "$name: downloading (JOBS=$JOBS, gzip on the fly)"
  xargs -P "$JOBS" -n 1 -I {} bash -c '
    url="$1"; dir="$2"
    out="$dir/$(basename "${url%.fna}").fna.gz"
    [[ -s "$out" ]] && exit 0
    curl -fsSL --retry 5 --retry-all-errors --max-time 300 "$url" \
      | gzip -1 > "$out.part" && [[ -s "$out.part" ]] && mv "$out.part" "$out" || rm -f "$out.part"
  ' _ {} "$work/genomes" < "$urls"

  local have; have="$(find "$work/genomes" -name '*.fna.gz' | wc -l)"
  log "$name: have $have / $want"
  # A few missing genomes would silently shrink the database. 99% is the same
  # bar build_gut_db.sh uses; below it, stop and let the run be repeated.
  if (( have < want * 99 / 100 )); then
    log "$name: too many missing ($have/$want) — leaving genomes in place for a retry"
    return 1
  fi

  log "$name: sketching (c=$C_PARAM k=$K_PARAM)"
  find "$work/genomes" -name '*.fna.gz' | sort > "$work/genome_list.txt"
  "$SYLPH" sketch -l "$work/genome_list.txt" -c "$C_PARAM" -k "$K_PARAM" \
    -t "${THREADS:-8}" -o "${db%.syldb}" 2> "$work/sketch.log" || {
      log "$name: sylph sketch FAILED — see $work/sketch.log"; return 1; }

  [[ -s "$db" ]] || { log "$name: no .syldb produced"; return 1; }
  log "$name: built $(du -h "$db" | cut -f1)"

  # Verify before throwing the genomes away: a database that does not open is
  # worth less than the genomes it came from.
  local n; n="$("$SYLPH" inspect "$db" 2>&1 | grep -oE 'with [0-9]+ genomes' | grep -oE '[0-9]+')"
  if [[ "${n:-0}" -lt 1 ]]; then
    log "$name: built database does not inspect — keeping genomes"
    return 1
  fi
  log "$name: inspect reports $n genomes"
  printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$version" "$n" "$(stat -c%s "$db")" "$(date -Iseconds)" \
    >> "$OUT_DIR/manifest.tsv"

  if [[ -z "${KEEP_FASTA:-}" ]]; then
    log "$name: removing genomes"
    rm -rf "$work/genomes"
  fi
  return 0
}

mkdir -p "$OUT_DIR" "$WORK_DIR"
[[ -x "$SYLPH" ]] || { log "sylph not found at $SYLPH (cargo build --release in sylph-wasm/)"; exit 2; }

if (( $# > 0 )); then
  for want in "$@"; do
    for entry in "${CATALOGUES[@]}"; do
      set -- $entry
      [[ "$1" == "$want" ]] && build_one "$1" "$2"
    done
  done
else
  for entry in "${CATALOGUES[@]}"; do
    set -- $entry
    build_one "$1" "$2" || log "continuing after failure on $1"
  done
fi

log "done — $(ls -1 "$OUT_DIR"/*.syldb 2>/dev/null | wc -l) databases in $OUT_DIR"
ls -lh "$OUT_DIR"/*.syldb 2>/dev/null
