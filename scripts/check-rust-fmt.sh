#!/usr/bin/env bash
# Prove every Rust crate under a Rust tree is formatted the way the pinned
# rustfmt formats it.
#
# rustfmt's output is *not* stable across compiler versions: the same file
# formatted by 1.88.0 and by a newer stable can differ, and a check that runs on
# whatever compiler happens to be installed reports version skew as if it were a
# formatting mistake. So this script renders a verdict only on the toolchain
# named by the tree's rust-toolchain.toml — it runs cargo from the directory that
# holds that file, so rustup selects the pin, and it refuses to continue if the
# compiler that answers is a different one.
#
# The tree defaults to wallet/. A second top-level Rust namespace is gated by
# pointing --root at it; its rust-toolchain.toml is a restatement of
# wallet/rust-toolchain.toml, not a second decision, and
# scripts/check-rust-toolchain.sh is what holds it to that.
#
# Crates are discovered rather than listed. A new crate under the tree is gated
# from its first commit, which is the cheapest moment and never gets cheaper.
#
# `cargo fmt` reads the manifest with `cargo metadata --no-deps`, which does not
# resolve the dependency graph, so this runs without the z/ submodules checked
# out and without compiling anything.
#
# Usage:
#   scripts/check-rust-fmt.sh              fail on any unformatted file
#   scripts/check-rust-fmt.sh --fix        rewrite the offending files in place
#   scripts/check-rust-fmt.sh --root DIR   judge a different Rust tree (default: wallet)
#   scripts/check-rust-fmt.sh --self-test  prove the check still fails on unformatted code

set -euo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# Absolute, because the self-test re-invokes this script after cd'ing into the
# tree under test.
SELF=$REPO_ROOT/scripts/$(basename -- "${BASH_SOURCE[0]}")

# The Rust tree to judge, relative to the repository root.
DEFAULT_ROOT=wallet

mode=check
root=$DEFAULT_ROOT
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fix) mode=fix ;;
    --self-test) mode=self-test ;;
    --root)
      root=${2-}
      if [[ -z $root ]]; then
        printf -- '--root needs a directory.\n' >&2
        exit 2
      fi
      shift
      ;;
    -h | --help)
      awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

# The directory holding rust-toolchain.toml. Cargo is invoked from here so
# rustup's toolchain selection — which keys off the working directory, not the
# --manifest-path — lands on the pinned channel. An absolute --root is accepted
# so the self-test can point this at a scratch tree.
case "$root" in
  /*) RUST_ROOT=$root ;;
  *) RUST_ROOT=$REPO_ROOT/$root ;;
esac
LABEL=${root%/}
TOOLCHAIN_FILE=$RUST_ROOT/rust-toolchain.toml

if [[ ! -f $TOOLCHAIN_FILE ]]; then
  printf '%s/rust-toolchain.toml is missing; it decides which rustfmt this check trusts.\n' "$LABEL" >&2
  exit 1
fi

channel=$(awk -F'"' '/^[[:space:]]*channel[[:space:]]*=/ { print $2; exit }' "$TOOLCHAIN_FILE")
if [[ ! $channel =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf 'channel in %s/rust-toolchain.toml must be a three-component version, got "%s".\n' \
    "$LABEL" "$channel" >&2
  exit 1
fi

cd "$RUST_ROOT"

installed=$(rustc --version)
if [[ $installed != "rustc $channel "* ]]; then
  printf 'refusing to judge formatting: %s/rust-toolchain.toml pins %s but `rustc --version` says "%s".\n' \
    "$LABEL" "$channel" "$installed" >&2
  printf 'rustfmt output differs between compiler versions, so this run could only produce a misleading verdict.\n' >&2
  exit 1
fi

# --- self-test ---------------------------------------------------------------
#
# Builds a scratch Rust tree, points --root at it, and confirms the verdict
# tracks the fixture: blind on an empty tree, clean on formatted code, and —
# the case that matters — failing on unformatted code. A check nobody has
# watched fail is not a check.
if [[ $mode == self-test ]]; then
  fixture=$(mktemp -d "${TMPDIR:-/tmp}/zuuli-fmt-self-test.XXXXXX")
  trap 'rm -rf -- "$fixture"' EXIT
  cases=0

  # Install the required toolchain declaration before the empty-tree control.
  # Otherwise the child can fail early for a missing pin and never exercise
  # the manifest-count guard that this case claims to prove.
  printf '[toolchain]\nchannel = "%s"\n' "$channel" > "$fixture/rust-toolchain.toml"

  if "$SELF" --root "$fixture" >/dev/null 2>&1; then
    printf 'self-test FAILED: --root accepted a tree holding no Cargo manifests.\n' >&2
    exit 1
  fi
  cases=$((cases + 1))
  printf 'self-test: --root refuses a tree with no crates to judge.\n'

  mkdir -p "$fixture/relay/src"
  cat > "$fixture/relay/Cargo.toml" <<'EOF'
[package]
name = "zuuli-fmt-self-test"
version = "0.0.0"
edition = "2024"

[workspace]
EOF
  printf 'pub fn negate(value: bool) -> bool {\n    !value\n}\n' > "$fixture/relay/src/lib.rs"

  if ! "$SELF" --root "$fixture" >/dev/null; then
    printf 'self-test FAILED: --root rejected a correctly formatted second tree.\n' >&2
    exit 1
  fi
  cases=$((cases + 1))
  printf 'self-test: --root accepts a formatted second tree.\n'

  # A depth limit is a future-crate escape: the ownership census permits Rust
  # roots to grow at any depth, so formatting discovery must do the same.
  mkdir -p "$fixture/future/depth/four/src"
  cat > "$fixture/future/depth/four/Cargo.toml" <<'EOF'
[package]
name = "zuuli-fmt-deep-control"
version = "0.0.0"
edition = "2024"

[workspace]
EOF
  printf 'pub fn deep(  value:bool )->bool{value}\n' \
    > "$fixture/future/depth/four/src/lib.rs"
  if "$SELF" --root "$fixture" >/dev/null 2>&1; then
    printf 'self-test FAILED: --root missed an unformatted crate below depth three.\n' >&2
    exit 1
  fi
  cases=$((cases + 1))
  printf 'self-test: --root discovers crates below depth three.\n'

  "$SELF" --root "$fixture" --fix >/dev/null
  if ! "$SELF" --root "$fixture" >/dev/null; then
    printf 'self-test FAILED: --fix missed a crate below depth three.\n' >&2
    exit 1
  fi
  cases=$((cases + 1))
  printf 'self-test: --fix formats crates below depth three.\n'

  # Negative control: the same tree, unformatted.
  printf 'pub fn negate(  value:bool )->bool{!value}\n' > "$fixture/relay/src/lib.rs"
  if "$SELF" --root "$fixture" >/dev/null 2>&1; then
    printf 'self-test FAILED: --root accepted an unformatted crate.\n' >&2
    exit 1
  fi
  cases=$((cases + 1))
  printf 'self-test: --root rejects an unformatted crate.\n'

  "$SELF" --root "$fixture" --fix >/dev/null
  if ! "$SELF" --root "$fixture" >/dev/null; then
    printf 'self-test FAILED: --fix did not reach the crate under --root.\n' >&2
    exit 1
  fi
  cases=$((cases + 1))
  printf 'self-test: --fix formats crates under --root.\n'

  printf 'self-test: %d case(s) passed; rustfmt from %s.\n' "$cases" "$channel"
  exit 0
fi

# Tracked, buildable crates only: target/ holds vendored and generated
# manifests, node_modules/ holds npm packages that ship Rust sources.
manifests=()
manifest_count=0
while IFS= read -r manifest; do
  manifests+=("${manifest#./}")
  manifest_count=$((manifest_count + 1))
done < <(
  find . -name Cargo.toml \
    -not -path './target/*' \
    -not -path '*/target/*' \
    -not -path '*/node_modules/*' |
    LC_ALL=C sort
)

if (( manifest_count == 0 )); then
  printf 'no Cargo manifests found under %s/; this check has gone blind.\n' "$LABEL" >&2
  exit 1
fi

failed=()
failed_count=0
if (( manifest_count > 0 )); then
  for manifest in "${manifests[@]}"; do
    crate=$(dirname "$manifest")
    if [[ $mode == fix ]]; then
      printf '==> formatting %s/%s\n' "$LABEL" "$crate"
      cargo fmt --all --manifest-path "$manifest"
      continue
    fi

    printf '==> checking %s/%s\n' "$LABEL" "$crate"
    if cargo fmt --all --check --manifest-path "$manifest"; then
      continue
    fi
    failed+=("$LABEL/$crate")
    failed_count=$((failed_count + 1))
  done
fi

if [[ $mode == fix ]]; then
  printf 'Formatted %d crate(s) with rustfmt from the pinned %s toolchain.\n' \
    "$manifest_count" "$channel"
  exit 0
fi

if (( failed_count > 0 )); then
  printf '\n%d crate(s) are not formatted: %s\n' "$failed_count" "${failed[*]}" >&2
  printf 'Run `scripts/check-rust-fmt.sh --fix` and commit the result; do not hand-edit.\n' >&2
  exit 1
fi

printf 'All %d Rust crate(s) under %s/ are formatted (rustfmt from %s).\n' \
  "$manifest_count" "$LABEL" "$channel"
