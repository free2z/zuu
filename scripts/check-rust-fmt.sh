#!/usr/bin/env bash
# Prove every Rust crate under wallet/ is formatted the way the pinned rustfmt
# formats it.
#
# rustfmt's output is *not* stable across compiler versions: the same file
# formatted by 1.88.0 and by a newer stable can differ, and a check that runs on
# whatever compiler happens to be installed reports version skew as if it were a
# formatting mistake. So this script renders a verdict only on the toolchain
# named by wallet/rust-toolchain.toml — it runs cargo from the directory that
# holds that file, so rustup selects the pin, and it refuses to continue if the
# compiler that answers is a different one.
#
# Crates are discovered rather than listed. A new crate under wallet/ is gated
# from its first commit, which is the cheapest moment and never gets cheaper.
#
# `cargo fmt` reads the manifest with `cargo metadata --no-deps`, which does not
# resolve the dependency graph, so this runs without the z/ submodules checked
# out and without compiling anything.
#
# Usage:
#   scripts/check-rust-fmt.sh          fail on any unformatted file
#   scripts/check-rust-fmt.sh --fix    rewrite the offending files in place

set -euo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

# The directory holding rust-toolchain.toml. Cargo is invoked from here so
# rustup's toolchain selection — which keys off the working directory, not the
# --manifest-path — lands on the pinned channel.
RUST_ROOT=$REPO_ROOT/wallet
TOOLCHAIN_FILE=$RUST_ROOT/rust-toolchain.toml

mode=check
case "${1-}" in
  "") ;;
  --fix) mode=fix ;;
  -h | --help)
    awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
    exit 0
    ;;
  *)
    printf 'unknown argument: %s\n' "$1" >&2
    exit 2
    ;;
esac

if [[ ! -f $TOOLCHAIN_FILE ]]; then
  printf 'wallet/rust-toolchain.toml is missing; it decides which rustfmt this check trusts.\n' >&2
  exit 1
fi

channel=$(awk -F'"' '/^[[:space:]]*channel[[:space:]]*=/ { print $2; exit }' "$TOOLCHAIN_FILE")
if [[ ! $channel =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf 'channel in wallet/rust-toolchain.toml must be a three-component version, got "%s".\n' \
    "$channel" >&2
  exit 1
fi

cd "$RUST_ROOT"

installed=$(rustc --version)
if [[ $installed != "rustc $channel "* ]]; then
  printf 'refusing to judge formatting: wallet/rust-toolchain.toml pins %s but `rustc --version` says "%s".\n' \
    "$channel" "$installed" >&2
  printf 'rustfmt output differs between compiler versions, so this run could only produce a misleading verdict.\n' >&2
  exit 1
fi

# Tracked, buildable crates only: target/ holds vendored and generated
# manifests, node_modules/ holds npm packages that ship Rust sources.
manifests=()
while IFS= read -r manifest; do
  manifests+=("${manifest#./}")
done < <(
  find . -name Cargo.toml \
    -not -path './target/*' \
    -not -path '*/target/*' \
    -not -path '*/node_modules/*' |
    LC_ALL=C sort
)

if [[ ${#manifests[@]} -eq 0 ]]; then
  printf 'no Cargo manifests found under wallet/; this check has gone blind.\n' >&2
  exit 1
fi

failed=()
for manifest in "${manifests[@]}"; do
  crate=$(dirname "$manifest")
  if [[ $mode == fix ]]; then
    printf '==> formatting wallet/%s\n' "$crate"
    cargo fmt --all --manifest-path "$manifest"
    continue
  fi

  printf '==> checking wallet/%s\n' "$crate"
  if cargo fmt --all --check --manifest-path "$manifest"; then
    continue
  fi
  failed+=("wallet/$crate")
done

if [[ $mode == fix ]]; then
  printf 'Formatted %d crate(s) with rustfmt from the pinned %s toolchain.\n' \
    "${#manifests[@]}" "$channel"
  exit 0
fi

if [[ ${#failed[@]} -gt 0 ]]; then
  printf '\n%d crate(s) are not formatted: %s\n' "${#failed[@]}" "${failed[*]}" >&2
  printf 'Run `scripts/check-rust-fmt.sh --fix` and commit the result; do not hand-edit.\n' >&2
  exit 1
fi

printf 'All %d Rust crate(s) under wallet/ are formatted (rustfmt from %s).\n' \
  "${#manifests[@]}" "$channel"
