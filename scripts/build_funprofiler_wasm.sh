#!/usr/bin/env bash
# Build sourmash for the browser, with the half fmh-funprofiler needs.
#
#   ./scripts/build_funprofiler_wasm.sh 32|64|both
#
# WHY THIS EXISTS. fmh-funprofiler (Hera et al., Bioinformatics 40, ii165, 2024)
# is FracMinHash on amino-acid k-mers: it profiles KEGG orthologs from reads,
# 39-99x faster than DIAMOND. Its pipeline is `sourmash sketch translate` then
# `sourmash prefetch` — and sourmash's own WebAssembly surface stops after the
# first of those. It can sketch in a browser (Mibianto ships that) but cannot
# compare the sketch against anything, so the assignment half has always run
# server-side.
#
# scripts/funprofiler/funcprofiler.rs supplies the missing half: a FuncProfiler
# that loads reference signatures and does the prefetch pass. That pass is one
# intersection per reference, not a greedy cover, which is why it fits under
# wasm at all — sourmash's accelerated index is RocksDB, which the crate
# excludes from wasm targets.
#
# Verified 2026-08-13 against sourmash 4.9.4 on the project's own demo FASTQ:
# the wasm32 sketch is hash-for-hash identical (2,318 of 2,318), and the profile
# matches `sourmash prefetch` normalised the way funcprofiler.py normalises it —
# 147 KOs both sides, none unique to either, largest abundance difference 0.
# wasm32 and wasm64 return byte-identical profiles in Chrome 151.

set -euo pipefail

WHICH="${1:-both}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${FUNPROF_WORK:-$HERE/.funprofiler-build}"
SOURMASH_REF="${SOURMASH_REF:-38d1f632ccdcbd28db87f528e345b8835634e655}"
SRC="$WORK/sourmash/src/core"

need() { command -v "$1" >/dev/null || { echo "missing: $1" >&2; exit 1; }; }
need cargo
need git

# ---- fetch and patch ---------------------------------------------------------
if [[ ! -d "$WORK/sourmash" ]]; then
  mkdir -p "$WORK"
  git clone --filter=blob:none https://github.com/sourmash-bio/sourmash.git "$WORK/sourmash"
fi
git -C "$WORK/sourmash" checkout -q "$SOURMASH_REF"

# Three edits, each for a reason worth stating.
#
# 1. niffler's zstd feature is a C library, and cc-rs needs clang to target
#    wasm32 — which a machine with only gcc does not have. Nothing here reads
#    zstd: signatures are gzip inside a zip, and the zip is opened in JS.
sed -i 's|features = \[ "gz", "zstd" \]|features = [ "gz" ]|' "$SRC/Cargo.toml"
#
# 2. Every wasm guard in sourmash keys on target_arch = "wasm32". On wasm64 the
#    arch is "wasm64", so js-sys, web-sys, wasm-bindgen and getrandom's js
#    feature all silently vanish — and rocksdb, guarded by NOT wasm32, silently
#    comes back. Keying on the family fixes both directions at once. (The same
#    trap is documented for sylph in the README; it costs a day if rediscovered.)
sed -i 's/target_arch = "wasm32"/target_family = "wasm"/g' "$SRC/Cargo.toml"
find "$SRC/src" -name '*.rs' -exec sed -i 's/target_arch = "wasm32"/target_family = "wasm"/g' {} +
#
# 3. wasm-bindgen before 0.2.126 cannot describe a 64-bit module: its interpreter
#    reads pointers as i32 and panics with "non-i32 constant".
sed -i 's|^wasm-bindgen = "0.2.89"|wasm-bindgen = "0.2.126"|; s|^js-sys = "0.3.72"|js-sys = "0.3.79"|; s|^web-sys = { version = "0.3.72"|web-sys = { version = "0.3.79"|' "$SRC/Cargo.toml"

if ! grep -q "FuncProfiler" "$SRC/src/wasm.rs"; then
  tail -n +2 "$HERE/scripts/funprofiler/funcprofiler.rs" >> "$SRC/src/wasm.rs"
fi

bindgen_version() {
  ( cd "$SRC" && cargo tree -i wasm-bindgen --target wasm32-unknown-unknown 2>/dev/null \
      | head -1 | awk '{print $2}' | tr -d 'v' )
}

emit() { # <target-dir> <out-dir>
  local want have
  want="$(bindgen_version)"
  have="$(wasm-bindgen --version 2>/dev/null | awk '{print $2}' || true)"
  if [[ "$have" != "$want" ]]; then
    echo "wasm-bindgen CLI is ${have:-absent} but the crate resolves to $want." >&2
    echo "They must match exactly:  cargo install wasm-bindgen-cli --version $want" >&2
    exit 1
  fi
  wasm-bindgen --target web --out-dir "$2" --out-name sourmash "$1/sourmash.wasm"
}

build32() {
  echo "==> wasm32 -> web/funprofiler-pkg/"
  ( cd "$SRC" && cargo build --lib --release --target wasm32-unknown-unknown )
  emit "$WORK/sourmash/target/wasm32-unknown-unknown/release" "$HERE/web/funprofiler-pkg"
}

build64() {
  echo "==> wasm64 -> web/funprofiler-pkg64/"
  # wasm64-unknown-unknown is Tier 3 with no prebuilt std, so nightly + build-std.
  #   rustup toolchain install nightly
  #   rustup component add rust-src --toolchain nightly
  ( cd "$SRC" && rustup run nightly cargo build --lib --release \
      --target wasm64-unknown-unknown -Z build-std=std,panic_abort )
  emit "$WORK/sourmash/target/wasm64-unknown-unknown/release" "$HERE/web/funprofiler-pkg64"
}

case "$WHICH" in
  32) build32 ;;
  64) build64 ;;
  both) build32; build64 ;;
  *) echo "usage: $0 32|64|both" >&2; exit 2 ;;
esac

echo
echo "Note: a wasm64 module carries a 64-bit table, which node 22 refuses with"
echo "\"invalid table elements limits flags\" — the same refusal it gives the"
echo "sylph wasm64 package that works in production. Test the 64-bit build in a"
echo "browser, never in node."
