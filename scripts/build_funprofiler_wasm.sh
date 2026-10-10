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
#
# Rebuilt 2026-10-10 by this script as it stands (pinned toolchains, the lock in
# scripts/funprofiler/, wasm-bindgen 0.2.126 instead of the 0.2.127 a caret had
# let in): functional profiles byte-identical to the previous package on three
# inputs — 60,000 single-end reads, the same as pairs, and 100,000 real pairs of
# ERR14098649 (325, 325 and 887 orthologs).

#
# REPRODUCIBLE, OR IT SAYS WHY NOT — the same rules as scripts/build_wasm.sh:
# pinned compilers, checked before anything is built; every dependency pinned
# by scripts/funprofiler/Cargo.lock (the commit pins sourmash, and the edits
# below change its dependency set, so its own lock no longer applies); and this
# machine's paths remapped out of the binary.

set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"

WHICH="${1:-both}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Outside the repository: a clone inside it is an untracked directory of several
# hundred MB that `git status` lists and `git add -A` would take.
WORK="${FUNPROF_WORK:-${XDG_CACHE_HOME:-$HOME/.cache}/peekmicrobiome/funprofiler-build}"
SOURMASH_REF="${SOURMASH_REF:-38d1f632ccdcbd28db87f528e345b8835634e655}"
SRC="$WORK/sourmash/src/core"
LOCK="$HERE/scripts/funprofiler/Cargo.lock"
OUT32="${OUT32:-$HERE/web/funprofiler-pkg}"
OUT64="${OUT64:-$HERE/web/funprofiler-pkg64}"

# The toolchains the committed package was built with (see build_wasm.sh for
# how to pin them under another name). ALLOW_TOOLCHAIN_DRIFT=1 builds anyway.
RUST_STABLE="${RUST_STABLE:-stable}"
RUST_STABLE_VERSION="1.95.0"
RUST_NIGHTLY="${RUST_NIGHTLY:-nightly}"
RUST_NIGHTLY_DATE="2026-08-03"

die() { echo "build_funprofiler_wasm.sh: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "missing: $1"; }
need cargo
need git
need rustup

check_rustc() { # <toolchain> <string its rustc --version must contain>
  local got
  got="$(rustup run "$1" rustc --version 2>/dev/null)" || die "rustup has no toolchain named '$1'"
  [[ "$got" == *"$2"* ]] && return 0
  if [[ "${ALLOW_TOOLCHAIN_DRIFT:-}" == 1 ]]; then
    echo "warning: rustc ($1) is '$got', not $2 — the package will not match the committed one" >&2
    return 0
  fi
  die "rustc ($1) is '$got', not $2. Install it, or set ALLOW_TOOLCHAIN_DRIFT=1."
}

sep=$'\x1f'
export CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo${sep}--remap-path-prefix=${RUSTUP_HOME:-$HOME/.rustup}=/rustup${sep}--remap-path-prefix=$WORK=/build"
unset RUSTFLAGS

# ---- fetch and reset ---------------------------------------------------------
if [[ ! -d "$WORK/sourmash/.git" ]]; then
  mkdir -p "$WORK"
  git clone --filter=blob:none https://github.com/sourmash-bio/sourmash.git "$WORK/sourmash"
fi
git -C "$WORK/sourmash" cat-file -e "$SOURMASH_REF^{commit}" 2>/dev/null \
  || git -C "$WORK/sourmash" fetch -q origin
# A plain checkout keeps local modifications, and the edits below are made in
# place: run twice, the second run patched an already-patched tree, and an
# edited funcprofiler.rs was never appended again. Every build starts from the
# pinned commit exactly. (`clean` leaves ignored files, so target/ survives.)
git -C "$WORK/sourmash" checkout -q -f "$SOURMASH_REF"
git -C "$WORK/sourmash" clean -fdq

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
#    reads pointers as i32 and panics with "non-i32 constant". Pinned EXACTLY
#    (`=`): a caret let the resolver take 0.2.127 for the committed package while
#    the CLI on the machine was 0.2.126, and the glue and the wasm must come from
#    the same version. 0.2.126 is also the version sylph-wasm's Cargo.lock
#    resolves to, so the site loads one wasm-bindgen, not two.
sed -i 's|^wasm-bindgen = "0.2.89"|wasm-bindgen = "=0.2.126"|; s|^js-sys = "0.3.72"|js-sys = "0.3.79"|; s|^web-sys = { version = "0.3.72"|web-sys = { version = "0.3.79"|' "$SRC/Cargo.toml"
grep -q '^wasm-bindgen = "=0.2.126"' "$SRC/Cargo.toml" \
  || die "the wasm-bindgen pin did not apply: sourmash's Cargo.toml no longer reads wasm-bindgen = \"0.2.89\""

# 4. The FuncProfiler itself, appended to the pristine wasm.rs every time.
tail -n +2 "$HERE/scripts/funprofiler/funcprofiler.rs" >> "$SRC/src/wasm.rs"

# ---- pin every dependency ----------------------------------------------------
# The edits above change sourmash's dependency set, so the lock it ships does not
# describe this build. Ours does: copied in and built with --locked. The first
# build without it resolves once and saves the result here, to be committed.
if [[ -f "$LOCK" ]]; then
  cp "$LOCK" "$WORK/sourmash/Cargo.lock"
  LOCKED=(--locked)
else
  echo "note: no $LOCK yet — resolving now, and saving the result there (commit it)." >&2
  LOCKED=()
fi
save_lock() {
  [[ ${#LOCKED[@]} -eq 0 ]] || return 0
  cp "$WORK/sourmash/Cargo.lock" "$LOCK"
  echo "saved $LOCK" >&2
}

bindgen_version() {
  ( cd "$SRC" && cargo tree -i wasm-bindgen --target wasm32-unknown-unknown "${LOCKED[@]}" 2>/dev/null \
      | head -1 | awk '{print $2}' | tr -d 'v' )
}

emit() { # <target-dir> <out-dir>
  local want have
  want="$(bindgen_version)"
  command -v wasm-bindgen >/dev/null \
    || die "the wasm-bindgen CLI is not on PATH: cargo install wasm-bindgen-cli --version $want"
  have="$(wasm-bindgen --version | awk '{print $2}')"
  [[ "$have" == "$want" ]] \
    || die "wasm-bindgen CLI is $have but the crate resolves to $want. They must match exactly: cargo install wasm-bindgen-cli --version $want"
  wasm-bindgen --target web --out-dir "$2" --out-name sourmash "$1/sourmash.wasm"
}

build32() {
  echo "==> wasm32 -> $OUT32"
  check_rustc "$RUST_STABLE" "$RUST_STABLE_VERSION"
  ( cd "$SRC" && rustup run "$RUST_STABLE" cargo build --lib --release "${LOCKED[@]}" \
      --target wasm32-unknown-unknown )
  save_lock
  emit "$WORK/sourmash/target/wasm32-unknown-unknown/release" "$OUT32"
}

build64() {
  echo "==> wasm64 -> $OUT64"
  # wasm64-unknown-unknown is Tier 3 with no prebuilt std, so nightly + build-std.
  #   rustup toolchain install nightly-2026-08-03 --component rust-src
  check_rustc "$RUST_NIGHTLY" "$RUST_NIGHTLY_DATE"
  ( cd "$SRC" && rustup run "$RUST_NIGHTLY" cargo build --lib --release "${LOCKED[@]}" \
      --target wasm64-unknown-unknown -Z build-std=std,panic_abort )
  save_lock
  emit "$WORK/sourmash/target/wasm64-unknown-unknown/release" "$OUT64"
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
echo "sylph wasm64 package that works in production. Node 24 loads both: test the"
echo "64-bit build there, or in a browser, never in node 22."
