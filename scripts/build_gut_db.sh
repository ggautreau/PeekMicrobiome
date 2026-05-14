#!/usr/bin/env bash
# Build a gut-only sylph database from UHGG v2.0.2 species representatives.
#
# Output:
#   data/uhgg/gut.syldb           — sylph database, c=200 k=31
#   data/uhgg/gut.taxonomy.tsv    — genome → GTDB lineage (for sylph-tax)
#   data/uhgg/genomes/            — downloaded species-rep FNAs (~5 GB)
#
# Prerequisites on PATH:
#   curl, awk, gzip, parallel-or-xargs, sylph (>=0.6)
#
# Runtime estimates (UHGG v2.0.2 has ~4744 species reps):
#   download   : 30–90 min on a typical home link (~5 GB)
#   sketching  : 10–30 min on a 16-core box
#   .syldb size: ~300–600 MB (see docs/syldb_size_estimate.md)

set -euo pipefail

# ---- config ------------------------------------------------------------------

UHGG_VERSION="${UHGG_VERSION:-v2.0.2}"
UHGG_BASE="${UHGG_BASE:-https://ftp.ebi.ac.uk/pub/databases/metagenomics/mgnify_genomes/human-gut/${UHGG_VERSION}}"
OUT_ROOT="${OUT_ROOT:-data/uhgg}"
GENOMES_DIR="${OUT_ROOT}/genomes"
METADATA_TSV="${OUT_ROOT}/genomes-all_metadata.tsv"
URLS_FILE="${OUT_ROOT}/species_rep_urls.txt"
SYLDB_OUT="${OUT_ROOT}/gut.syldb"
TAXONOMY_OUT="${OUT_ROOT}/gut.taxonomy.tsv"

K="${K:-31}"           # sylph default k
C="${C:-200}"          # sylph default subsampling rate
JOBS="${JOBS:-8}"      # parallel downloads / sketch threads

# ---- helpers -----------------------------------------------------------------

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing tool: $1" >&2; exit 1; }
}

# ---- preflight ---------------------------------------------------------------

for t in curl awk gzip xargs sylph; do need "$t"; done
mkdir -p "$GENOMES_DIR"

# ---- step 1: metadata --------------------------------------------------------

if [[ ! -s "$METADATA_TSV" ]]; then
  log "downloading metadata"
  curl -fL --retry 3 -o "${METADATA_TSV}.gz" "${UHGG_BASE}/genomes-all_metadata.tsv.gz" \
    || curl -fL --retry 3 -o "$METADATA_TSV" "${UHGG_BASE}/genomes-all_metadata.tsv"
  [[ -s "${METADATA_TSV}.gz" ]] && gzip -d "${METADATA_TSV}.gz"
fi

# ---- step 2: build the species-rep URL list ---------------------------------
# UHGG TSV columns include "Genome" and "Species_rep". Rows where Genome ==
# Species_rep are themselves the rep; everything else points at one.

if [[ ! -s "$URLS_FILE" ]]; then
  log "extracting species-rep URLs from metadata"
  awk -F'\t' '
    NR == 1 {
      for (i=1; i<=NF; i++) col[$i] = i
      g = col["Genome"]; r = col["Species_rep"]
      if (!g || !r) { print "metadata missing Genome/Species_rep cols" > "/dev/stderr"; exit 2 }
      next
    }
    $g == $r {
      # Accession: MGYG + 9 digits (e.g. MGYG000000001).
      # Bin dir:   MGYG + 7 digits, grouping species in batches of 100
      # (e.g. MGYG000000001 → MGYG0000000; MGYG000000100 → MGYG0000001).
      acc = $g
      num = substr(acc, 5) + 0
      bin = sprintf("MGYG%07d", int(num / 100))
      printf "%s/species_catalogue/%s/%s/genome/%s.fna\n", "'"$UHGG_BASE"'", bin, acc, acc
    }
  ' "$METADATA_TSV" > "$URLS_FILE"
  log "found $(wc -l < "$URLS_FILE") species reps"
fi

# ---- step 3: parallel download ----------------------------------------------

log "downloading species-rep FNAs to $GENOMES_DIR (skipping existing)"
xargs -P "$JOBS" -n 1 -I {} bash -c '
  url="$1"
  out="'"$GENOMES_DIR"'/$(basename "$url")"
  [[ -s "$out" ]] && exit 0
  curl -fsSL --retry 3 -o "$out.tmp" "$url" && mv "$out.tmp" "$out"
' _ {} < "$URLS_FILE"

n_have=$(find "$GENOMES_DIR" -name '*.fna' | wc -l)
n_want=$(wc -l < "$URLS_FILE")
log "have $n_have / $n_want genome FNAs"
[[ "$n_have" -ge $((n_want * 99 / 100)) ]] || {
  log "more than 1% of genomes failed to download — re-run to retry"
  exit 3
}

# ---- step 4: sketch with sylph ----------------------------------------------

log "running sylph sketch (k=$K c=$C jobs=$JOBS)"
# sylph sketch -g for genome databases. -l reads list from file.
find "$GENOMES_DIR" -name '*.fna' > "${OUT_ROOT}/genome_list.txt"
sylph sketch \
  -t "$JOBS" \
  -c "$C" \
  -k "$K" \
  --gl "${OUT_ROOT}/genome_list.txt" \
  -o "${SYLDB_OUT%.syldb}"

log "sketched: $(ls -lh "$SYLDB_OUT" | awk '{print $5}') — $SYLDB_OUT"

# ---- step 5: taxonomy mapping (for sylph-tax) -------------------------------

log "writing taxonomy mapping"
awk -F'\t' '
  NR == 1 {
    for (i=1; i<=NF; i++) col[$i] = i
    g = col["Genome"]; r = col["Species_rep"]; lin = col["Lineage"]
    if (!g || !r || !lin) { print "metadata missing required columns" > "/dev/stderr"; exit 2 }
    print "genome_file\tlineage"
    next
  }
  $g == $r {
    printf "%s.fna\t%s\n", $g, $lin
  }
' "$METADATA_TSV" > "$TAXONOMY_OUT"

log "done."
log "  database : $SYLDB_OUT"
log "  taxonomy : $TAXONOMY_OUT"
log "  genomes  : $GENOMES_DIR ($(du -sh "$GENOMES_DIR" | cut -f1))"
