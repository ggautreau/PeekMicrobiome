#!/usr/bin/env bash
# Download all PRJEB83730 (MetaQuantBiote) FASTQs with per-file retry loop.
# Reads URLs + expected sizes from data/prjeb83730/urls.tsv.
# Idempotent: re-running resumes incomplete files.

set -u
ROOT="data/prjeb83730"
URLS="$ROOT/urls.tsv"
GENOMES_DIR="$ROOT/fastq"
LOG="$ROOT/download.log"
JOBS="${JOBS:-4}"

mkdir -p "$GENOMES_DIR"
: > "$LOG"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG" >&2; }

dl_one() {
  local url="$1"
  local want="$2"
  local name; name=$(basename "$url")
  local out="$GENOMES_DIR/$name"
  local attempt=0

  while :; do
    local have=0
    [ -s "$out" ] && have=$(stat -c%s "$out")
    if [ "$have" -ge "$want" ]; then
      printf '[%s] DONE %s (%s bytes)\n' "$(date +%H:%M:%S)" "$name" "$have" >> "$LOG"
      return 0
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 100 ]; then
      printf '[%s] GIVEUP %s after %d attempts (have %d / %d)\n' \
        "$(date +%H:%M:%S)" "$name" "$attempt" "$have" "$want" >> "$LOG"
      return 1
    fi
    # check disk: bail if < 1 GB free to avoid partial-fill scenarios
    local free_kb; free_kb=$(df -k . | awk 'NR==2{print $4}')
    if [ "$free_kb" -lt 1048576 ]; then
      printf '[%s] LOWDISK %s (%d KB free)\n' "$(date +%H:%M:%S)" "$name" "$free_kb" >> "$LOG"
      return 2
    fi
    wget -q -c --read-timeout=30 --timeout=60 -O "$out" "$url"
    local rc=$?
    local new_have=0
    [ -s "$out" ] && new_have=$(stat -c%s "$out")
    if [ "$new_have" -le "$have" ]; then
      sleep 5
    fi
    printf '[%s] [%s] attempt %d rc=%d %d -> %d (target %d)\n' \
      "$(date +%H:%M:%S)" "$name" "$attempt" "$rc" "$have" "$new_have" "$want" >> "$LOG"
  done
}

export -f dl_one log
export GENOMES_DIR LOG

total=$(wc -l < "$URLS")
log "starting download of $total files at JOBS=$JOBS into $GENOMES_DIR"

# xargs runs N jobs in parallel; each child runs dl_one which has its own retry loop.
awk '{printf "%s\t%s\n", $1, $2}' "$URLS" | \
  xargs -P "$JOBS" -n 1 -I {} -d '\n' bash -c '
    line="$1"
    url="${line%%	*}"
    want="${line##*	}"
    dl_one "$url" "$want"
  ' _ {}

have=$(find "$GENOMES_DIR" -name '*.fastq.gz' | wc -l)
log "all done — $have / $total files present"
