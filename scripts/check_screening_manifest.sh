#!/usr/bin/env bash
#
# data/screening/manifest.tsv must describe the files that sit next to it.
# Regenerate it from those files and diff. Any difference — a stale byte count,
# a genome count that no longer matches, a below-floor number typed by hand, a
# missing caveat line — exits 1 and prints the diff.
#
#   scripts/check_screening_manifest.sh
#   scripts/check_screening_manifest.sh --fix     # rewrite it instead of failing
#
# Runtime: a few seconds per gigabyte (sha256 + one pass of syldb-reduce --list).
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${DIR:-$ROOT/data/screening}"
MAN="$DIR/manifest.tsv"

gen="$(mktemp)"
trap 'rm -f "$gen"' EXIT
bash "$ROOT/scripts/write_screening_manifest.sh" "$DIR" > "$gen"

if [ "${1:-}" = "--fix" ]; then
  cp "$gen" "$MAN"
  echo "wrote $MAN"
  exit 0
fi

if [ ! -f "$MAN" ]; then
  echo "MISSING $MAN — run scripts/check_screening_manifest.sh --fix" >&2
  exit 1
fi

if diff -u "$MAN" "$gen" > /tmp/.screening-manifest.diff 2>&1; then
  echo "OK: $MAN matches the $(ls "$DIR"/*.syldb | wc -l) databases beside it"
  exit 0
fi
echo "FAIL: $MAN does not describe the files next to it" >&2
echo "  - lines starting with '-' are what the manifest claims" >&2
echo "  - lines starting with '+' are what the files actually are" >&2
sed -n '3,200p' /tmp/.screening-manifest.diff >&2
echo >&2
echo "Fix with: scripts/check_screening_manifest.sh --fix" >&2
exit 1
