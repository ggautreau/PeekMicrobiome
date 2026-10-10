#!/usr/bin/env bash
# Every sketch against both databases, in two loads rather than forty-eight.
#
#   scripts/depth-bench/profile_all.sh [threads]
#
# sylph reads the database once and profiles every sketch handed to it, and the
# GTDB database is 14 GB off a spinning disk — profiling one rung at a time
# would spend more wall-clock loading the reference than reading the reads.
set -euo pipefail
THREADS=${1:-24}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BENCH=$ROOT/data/bench
SYLPH=/home/ggautreau/miniconda3/envs/sylph/bin/sylph
GTDB=/home/ggautreau/FermenTwin/FT1/gtdb-r220-c200-dbv1.syldb

SKETCHES=$(ls "$BENCH"/out/*/sketch/*.sylsp 2>/dev/null)
[ -n "$SKETCHES" ] || { echo "aucun sketch"; exit 1; }
echo "$(echo "$SKETCHES" | wc -l) sketches"

# One TSV per database, split afterwards: sylph writes one table with a
# Sample_file column, and the sample name is the rung's tag.
for DB in uhgg gtdb; do
  [ "$DB" = uhgg ] && FILE=$BENCH/refs/human-gut.syldb || FILE=$GTDB
  echo "== $DB =="
  # shellcheck disable=SC2086
  /usr/bin/time -f "%e s, %M kB" "$SYLPH" profile "$FILE" $SKETCHES -t "$THREADS" \
    > "$BENCH/all.$DB.tsv" 2> "$BENCH/all.$DB.log"
  tail -1 "$BENCH/all.$DB.log"
  python3 "$ROOT/scripts/depth-bench/split_profiles.py" "$DB" "$BENCH"
done
