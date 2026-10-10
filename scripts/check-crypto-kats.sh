#!/usr/bin/env bash
# Run the permanent libcrux known-answer suite, or prove it notices a corrupted
# standards vector before trusting its live verdict.

set -euo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
CRATE=$REPO_ROOT/rs/crates/f2z-crypto-kat
mode=${1-}

case "$mode" in
  --verify-aarch64-neon | --arm-native | --arm-emulated) ;;
  "") ;;
  --self-test) ;;
  -h | --help)
    printf '%s\n' \
      'Usage: scripts/check-crypto-kats.sh [--self-test | --verify-aarch64-neon | --arm-native | --arm-emulated]' \
      '  no flag      run every committed known-answer test' \
      '  --self-test  corrupt an X-Wing answer and require a test failure' \
      '  --verify-aarch64-neon  require native Linux ARM64 with runtime and rustc NEON' \
      '  --arm-native  verify native ARM64, then run KATs and current Cargo backend evidence' \
      '  --arm-emulated  explicitly verify aarch64 Cargo runner, then run KATs and the same artifact verifier'
    exit 0
    ;;
  *)
    printf 'unknown argument: %s\n' "$mode" >&2
    exit 2
    ;;
esac

if [[ $mode == --verify-aarch64-neon ]]; then
  node "$REPO_ROOT/scripts/check-crypto-kat-arm.mjs" --verify-native
  exit 0
fi

cd "$REPO_ROOT/rs"

if [[ $mode == --arm-native || $mode == --arm-emulated ]]; then
  verifier_mode=native
  if [[ $mode == --arm-native ]]; then
    node "$REPO_ROOT/scripts/check-crypto-kat-arm.mjs" --verify-native
  else
    verifier_mode=emulated
    node "$REPO_ROOT/scripts/check-crypto-kat-arm.mjs" --verify-emulated
  fi
  node "$REPO_ROOT/scripts/check-crypto-kat-locks.mjs"
  # Force the selected ML-KEM build script to run in this invocation. Its
  # Cargo JSON event is then bound to the KAT crate's rebuilt test executable.
  # This removes only that package's artifacts from Cargo's configured target
  # directory; dependency caches and unrelated package outputs stay warm.
  cargo clean --locked -p libcrux-ml-kem
  evidence=$(mktemp "${TMPDIR:-/tmp}/zuu-crypto-kat-cargo.XXXXXX")
  trap 'rm -f -- "$evidence"' EXIT
  if ! cargo test --locked -p f2z-crypto-kat --message-format=json-render-diagnostics >"$evidence" 2>&1; then
    cat "$evidence" >&2
    exit 1
  fi
  node "$REPO_ROOT/scripts/check-crypto-kat-arm.mjs" --verify-cargo-messages "$evidence" "$verifier_mode"
  exit 0
fi

if [[ $mode != --self-test ]]; then
  node "$REPO_ROOT/scripts/check-crypto-kat-locks.mjs"
  cargo test --locked -p f2z-crypto-kat
  exit 0
fi

node "$REPO_ROOT/scripts/check-crypto-kat-locks.mjs" --self-test

fixture=$(mktemp -d "${TMPDIR:-/tmp}/f2z-crypto-kat-self-test.XXXXXX")
trap 'rm -rf -- "$fixture"' EXIT
cp -R "$CRATE/vectors/." "$fixture/"

# Flip the first nibble of Appendix C vector 1's expected combiner output. The
# exact original anchors this mutation to source material instead of whatever
# output the implementation currently emits.
original=d2df0522128f09dd8e2c92b1e905c793d8f57a54c3da25861f10bf4ca613e384
corrupt=02df0522128f09dd8e2c92b1e905c793d8f57a54c3da25861f10bf4ca613e384
if ! grep -F "$original" "$fixture/xwing-draft-06.json" >/dev/null; then
  printf 'self-test cannot find the pinned X-Wing vector-1 shared secret\n' >&2
  exit 1
fi
sed "s/$original/$corrupt/" "$fixture/xwing-draft-06.json" > "$fixture/xwing-mutated.json"
mv "$fixture/xwing-mutated.json" "$fixture/xwing-draft-06.json"

log=$fixture/test.log
if F2Z_CRYPTO_KAT_VECTOR_DIR=$fixture \
  cargo test --locked -p f2z-crypto-kat x_wing_draft_06_appendix_c_all_vectors \
  >"$log" 2>&1; then
  printf 'crypto KAT self-test FAILED: a corrupted X-Wing combiner answer passed\n' >&2
  exit 1
fi
if ! grep -F 'x-wing vector 1 shared secret' "$log" >/dev/null; then
  printf 'crypto KAT self-test failed for an unexpected reason:\n' >&2
  cat "$log" >&2
  exit 1
fi

printf 'crypto KAT self-test: corrupted X-Wing vector 1 was rejected\n'
