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
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$HERE/sylph-wasm"
WHICH="${1:-32}"

# wasm-opt is optional and only shrinks the artifact. It MUST be binaryen >= 129:
# the wasm-opt bundled with wasm-pack 0.13.1 is binaryen 117, which fails on a
# 64-bit module with "Tables may not be 64-bit".
WASM_OPT="${WASM_OPT:-$(command -v wasm-opt || true)}"

build32() {
  echo "==> wasm32 -> web/sylph-pkg/"
  cd "$CRATE"
  wasm-pack build --target web --release \
    --out-dir ../web/sylph-pkg --out-name sylph_wasm \
    -- --no-default-features --features wasm
  # wasm-pack rewrites the package .gitignore with `*`; the deployed site needs
  # these files tracked, so put our override back.
  cat > "$HERE/web/sylph-pkg/.gitignore" <<'IGN'
# wasm-pack stamps this directory with `*` to keep the build artifact
# out of the source repo. We override that here because the deployed
# site (GitHub Pages) needs sylph_wasm.js + sylph_wasm_bg.wasm at runtime.
!*
IGN
}

build64() {
  echo "==> wasm64 -> web/sylph-pkg64/"
  # wasm-pack cannot do this: it hard-codes --target wasm32-unknown-unknown and
  # never passes -Z build-std, which a Tier 3 target without a prebuilt std needs.
  # Prerequisites (idempotent):
  #   rustup toolchain install nightly
  #   rustup component add rust-src --toolchain nightly
  #   cargo install wasm-bindgen-cli --version "$(bindgen_version)"
  local want; want="$(bindgen_version)"
  local have; have="$(wasm-bindgen --version 2>/dev/null | awk '{print $2}')"
  if [[ "$have" != "$want" ]]; then
    echo "wasm-bindgen CLI is $have but the crate resolves to $want." >&2
    echo "They must match exactly:  cargo install wasm-bindgen-cli --version $want" >&2
    exit 1
  fi

  cd "$CRATE"
  rustup run nightly cargo build --lib --release \
    --target wasm64-unknown-unknown \
    --no-default-features --features wasm \
    -Z build-std=std,panic_abort

  wasm-bindgen --target web --out-dir "$HERE/web/sylph-pkg64" --out-name sylph_wasm \
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
      "$HERE/web/sylph-pkg64/sylph_wasm_bg.wasm" \
      -o "$HERE/web/sylph-pkg64/sylph_wasm_bg.wasm.tmp"
    mv "$HERE/web/sylph-pkg64/sylph_wasm_bg.wasm.tmp" "$HERE/web/sylph-pkg64/sylph_wasm_bg.wasm"
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
ls -la "$HERE/web/sylph-pkg"* 2>/dev/null
