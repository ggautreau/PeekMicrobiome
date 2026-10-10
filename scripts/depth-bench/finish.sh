#!/usr/bin/env bash
# Everything after the ladders: profile, measure, write, draw.
#
#   scripts/depth-bench/finish.sh [threads]
#
# Separate from the ladders because it is the cheap half — two database loads and
# some arithmetic — and because it is the half that gets re-run when a metric
# changes its mind. Re-running it is safe and idempotent: it recomputes every
# number from the tools' own output files and rewrites §3.3 of the note from
# those numbers rather than editing prose in place.
set -euo pipefail
THREADS=${1:-16}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

echo "== profils sylph, deux chargements =="
bash scripts/depth-bench/profile_all.sh "$THREADS"

echo "== mesures =="
python3 scripts/depth-bench/analyse.py

echo "== figure =="
python3 scripts/depth-bench/figure.py

echo "== §3.3 de la note =="
python3 scripts/depth-bench/insert_section.py
