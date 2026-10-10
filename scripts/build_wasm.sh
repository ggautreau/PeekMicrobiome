#!/usr/bin/env bash
#
# Builds the sylph wasm packages that web/ loads.
#
#   ./scripts/build_wasm.sh 32      -> web/sylph-pkg/    (default, stable Rust)
#   ./scripts/build_wasm.sh 64      -> web/sylph-pkg64/  (nightly, memory64)
#   ./scripts/build_wasm.sh both
#
# Why 64-bit at all: wasm32 caps linear memory at 4 GB. memory64 raises that to
# 16 GB in V8, which gives the sketch/dedup tables room at high read counts.
# It is NOT free — measured 1.5x to 1.8x slower on the same profile() call — so
# the 32-bit package stays the default and the site only reaches for the 64-bit
# one when 32 bits will not do. Safari supports memory64 in no version at all,
# so the 32-bit package is also the mandatory fallback, not a nicety.
#
# REPRODUCIBLE, OR IT SAYS WHY NOT. The packages are committed and deployed, so
# what matters is that rebuilding them from this commit gives the same bytes:
#   - the compilers are pinned by version and checked before anything is built
#     (a different rustc is a different binary, and nothing else would say so);
#   - Cargo.lock is honoured (--locked), never re-resolved;
#   - this machine's paths are remapped out of the binaries. Panic locations
#     embed source paths — std's, the registry's, ours — and the committed
#     packages used to carry /home/<user>/.cargo/... and ~/.rustup/... in them.
#
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$HERE/sylph-wasm"
WHICH="${1:-32}"

die() { echo "build_wasm.sh: $*" >&2; exit 1; }

# The toolchains the committed packages were built with. Checked by version, not
# by name, because `rustup toolchain list` says "stable" and "nightly" for both:
# install the pinned ones under any name and pass it, e.g.
#   rustup toolchain install nightly-2026-08-03 --component rust-src
#   RUST_NIGHTLY=nightly-2026-08-03 ./scripts/build_wasm.sh 64
# ALLOW_TOOLCHAIN_DRIFT=1 builds with whatever is there, knowingly.
RUST_STABLE="${RUST_STABLE:-stable}"
RUST_STABLE_VERSION="1.95.0"
RUST_NIGHTLY="${RUST_NIGHTLY:-nightly}"
RUST_NIGHTLY_DATE="2026-08-03"
WASM_PACK_VERSION="0.13.1"

check_tool() { # <what> <version string found> <version string wanted>
  [[ "$2" == *"$3"* ]] && return 0
  if [[ "${ALLOW_TOOLCHAIN_DRIFT:-}" == 1 ]]; then
    echo "warning: $1 is '$2', not $3 — the package will not match the committed one" >&2
    return 0
  fi
  die "$1 is '$2', not $3 (the version the committed packages were built with). Install it, or set ALLOW_TOOLCHAIN_DRIFT=1."
}

check_rustc() { # <toolchain> <wanted>
  local got
  got="$(rustup run "$1" rustc --version 2>/dev/null)" || die "rustup has no toolchain named '$1'"
  check_tool "rustc ($1)" "$got" "$2"
}

# The CLI must be exactly the version the crate resolves to, or bindgen refuses
# to run; and if it is missing, say so — under `set -e` a failed $(...) used to
# end the script with status 127 and no message at all.
check_bindgen() {
  local want have
  want="$(bindgen_version)"
  command -v wasm-bindgen >/dev/null \
    || die "the wasm-bindgen CLI is not on PATH: cargo install wasm-bindgen-cli --version $want"
  have="$(wasm-bindgen --version | awk '{print $2}')"
  [[ "$have" == "$want" ]] \
    || die "wasm-bindgen CLI is $have but the crate resolves to $want. They must match exactly: cargo install wasm-bindgen-cli --version $want"
}

# Remap every path of this machine that can reach the binary. Passed as
# CARGO_ENCODED_RUSTFLAGS (0x1f-separated) so a path with a space survives.
remap_rustflags() {
  local sep=$'\x1f' cargo_home="${CARGO_HOME:-$HOME/.cargo}" rustup_home="${RUSTUP_HOME:-$HOME/.rustup}"
  printf '%s' "--remap-path-prefix=$cargo_home=/cargo${sep}--remap-path-prefix=$rustup_home=/rustup${sep}--remap-path-prefix=$HERE=/peekmicrobiome"
}
export CARGO_ENCODED_RUSTFLAGS="$(remap_rustflags)"
unset RUSTFLAGS

# wasm-opt is optional and only shrinks the artifact. It MUST be binaryen >= 129:
# the wasm-opt bundled with wasm-pack 0.13.1 is binaryen 117, which fails on a
# 64-bit module with "Tables may not be 64-bit". The committed sylph-pkg64 went
# through binaryen version_133 (213 KB; 297 KB without the pass) — point WASM_OPT
# at that release's bin/wasm-opt to rebuild it byte for byte.
WASM_OPT="${WASM_OPT:-$(command -v wasm-opt || true)}"

# Where the packages land. Overridable so a rebuild can be checked in a scratch
# directory before it replaces the committed one.
OUT32="${OUT32:-$HERE/web/sylph-pkg}"
OUT64="${OUT64:-$HERE/web/sylph-pkg64}"

build32() {
  echo "==> wasm32 -> $OUT32"
  check_rustc "$RUST_STABLE" "$RUST_STABLE_VERSION"
  check_tool "wasm-pack" "$(wasm-pack --version 2>/dev/null || echo absent)" "$WASM_PACK_VERSION"
  # wasm-pack takes the wasm-bindgen on PATH when its version matches, and
  # otherwise downloads one: checking it here keeps the build off the network.
  check_bindgen
  cd "$CRATE"
  RUSTUP_TOOLCHAIN="$RUST_STABLE" wasm-pack build --target web --release \
    --out-dir "$OUT32" --out-name sylph_wasm \
    -- --no-default-features --features wasm --locked
  # wasm-pack rewrites the package .gitignore with `*`; the deployed site needs
  # these files tracked, so put our override back.
  cat > "$OUT32/.gitignore" <<'IGN'
# wasm-pack stamps this directory with `*` to keep the build artifact
# out of the source repo. We override that here because the deployed
# site (GitHub Pages) needs sylph_wasm.js + sylph_wasm_bg.wasm at runtime.
!*
IGN
}

build64() {
  echo "==> wasm64 -> $OUT64"
  # wasm-pack cannot do this: it hard-codes --target wasm32-unknown-unknown and
  # never passes -Z build-std, which a Tier 3 target without a prebuilt std needs.
  # Prerequisites (idempotent):
  #   rustup toolchain install nightly-2026-08-03 --component rust-src
  #   cargo install wasm-bindgen-cli --version "$(bindgen_version)"
  check_rustc "$RUST_NIGHTLY" "$RUST_NIGHTLY_DATE"
  check_bindgen

  cd "$CRATE"
  rustup run "$RUST_NIGHTLY" cargo build --lib --release --locked \
    --target wasm64-unknown-unknown \
    --no-default-features --features wasm \
    -Z build-std=std,panic_abort

  wasm-bindgen --target web --out-dir "$OUT64" --out-name sylph_wasm \
    target/wasm64-unknown-unknown/release/sylph.wasm

  if [[ -n "$WASM_OPT" ]]; then
    # Guard the version explicitly: binaryen < 129 does not merely skip the
    # 64-bit module, it dies with "Tables may not be 64-bit" after having
    # already been handed the only copy of the artifact.
    local bv; bv="$("$WASM_OPT" --version 2>/dev/null | grep -oE '[0-9]+' | head -1)"
    if [[ -z "$bv" || "$bv" -lt 129 ]]; then
      echo "wasm-opt at $WASM_OPT is binaryen ${bv:-?}; wasm64 needs >= 129." >&2
      echo "Skipping the size pass (the module is still correct, just larger)." >&2
      return 0
    fi
    echo "==> wasm-opt ($("$WASM_OPT" --version))"
    "$WASM_OPT" -O2 \
      --enable-memory64 --enable-bulk-memory --enable-reference-types \
      --enable-nontrapping-float-to-int --enable-sign-ext \
      "$OUT64/sylph_wasm_bg.wasm" \
      -o "$OUT64/sylph_wasm_bg.wasm.tmp"
    mv "$OUT64/sylph_wasm_bg.wasm.tmp" "$OUT64/sylph_wasm_bg.wasm"
  else
    echo "note: no wasm-opt on PATH (set WASM_OPT=/path/to/wasm-opt, binaryen >= 129) — skipping size pass"
  fi
}

# The CLI and the crate must be the same version or bindgen refuses to run.
bindgen_version() {
  awk '/^name = "wasm-bindgen"$/{f=1;next} f&&/^version = /{gsub(/"/,"");print $3;exit}' \
    "$CRATE/Cargo.lock"
}

case "$WHICH" in
  32)   build32 ;;
  64)   build64 ;;
  both) build32; build64 ;;
  *)    echo "usage: $0 [32|64|both]" >&2; exit 2 ;;
esac

echo "==> done"
ls -la "$OUT32" "$OUT64" 2>/dev/null || true
