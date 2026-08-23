#!/usr/bin/env bash
# Hold every Rust crate under a Rust tree to `cargo clippy -D warnings`.
#
# Clippy's lint set is not stable across compiler versions: lints are added,
# promoted between groups, and taught new patterns with every release, so the
# same source can be clean on one toolchain and warn on the next. A check that
# ran on whatever compiler happened to be installed would report that version
# skew as if it were a code defect. So, exactly like scripts/check-rust-fmt.sh,
# this renders a verdict only on the toolchain named by the tree's
# rust-toolchain.toml — it runs cargo from the directory holding that file so
# rustup selects the pin, and refuses to continue if a different compiler
# answers. Bumping the pin is therefore the one moment new lints can appear, and
# they appear in the bump's own pull request.
#
# The tree defaults to wallet/. A second top-level Rust namespace is gated by
# pointing --root at it; its rust-toolchain.toml is a restatement of
# wallet/rust-toolchain.toml, not a second decision, and
# scripts/check-rust-toolchain.sh is what holds it to that.
#
# Crates are discovered rather than listed. A new crate under the tree is gated
# from its first commit, which is the cheapest moment and never gets cheaper.
#
# Unlike scripts/check-rust-fmt.sh this genuinely compiles: clippy is a rustc
# driver and needs the whole dependency graph. The wallet crates reach the Zcash
# crates by path into z/zcash/librustzcash, so for that tree the submodule must
# be checked out and the Tauri system libraries installed — budget it alongside
# the real builds, not alongside the formatting check. That requirement is read
# out of the manifests rather than assumed, so a tree whose crates never point
# into the submodule is not held to a checkout it does not use.
#
# --all-targets so tests, benches and examples are linted too. Test code that
# nobody lints is where the next warning backlog comes from.
#
# Usage:
#   scripts/check-rust-clippy.sh          fail on any clippy warning
#   scripts/check-rust-clippy.sh --self-test <target-os>
#   scripts/check-rust-clippy.sh --root DIR   lint a different Rust tree (default: wallet)
#   scripts/check-rust-clippy.sh --fix    apply clippy's machine-applicable fixes
#
# After --fix, read every edit before committing it and run
# scripts/check-rust-fmt.sh --fix: clippy's rewrites are usually right, but
# "usually" is not a standard wallet code is held to, and its suggestions do not
# re-indent the code they restructure.

set -euo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# Absolute, because the self-test re-invokes this script after cd'ing into the
# tree under test.
SELF=$REPO_ROOT/scripts/$(basename -- "${BASH_SOURCE[0]}")

# The Rust tree to lint, relative to the repository root.
DEFAULT_ROOT=wallet
SUBMODULE=$REPO_ROOT/z/zcash/librustzcash

mode=check
root=$DEFAULT_ROOT
expected_target_os=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --self-test)
      mode=self-test
      expected_target_os=${2-}
      case "$expected_target_os" in
        linux | macos | windows) ;;
        *)
          printf '%s\n' 'Usage: scripts/check-rust-clippy.sh --self-test <linux|macos|windows>' >&2
          exit 2
          ;;
      esac
      shift
      ;;
    --fix) mode=fix ;;
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

# Tracked, buildable crates only: target/ holds vendored and generated
# manifests, node_modules/ holds npm packages that ship Rust sources.
discover_manifests() {
  find . -name Cargo.toml \
    -not -path './target/*' \
    -not -path '*/target/*' \
    -not -path '*/node_modules/*' |
    LC_ALL=C sort
}

# Whether these crates reach outside their own tree into the librustzcash
# submodule by path dependency. Derived from the manifests, not declared per
# tree, so the requirement follows the code instead of a list that can rot: the
# wallet crates say `path = "../../../z/zcash/librustzcash/..."` and are held to
# a checked-out submodule, a tree that says so nowhere is not.
manifests_need_submodule() {
  local manifest
  for manifest in "$@"; do
    if grep -qE 'path[[:space:]]*=[[:space:]]*"[^"]*z/zcash/librustzcash/' "$manifest"; then
      return 0
    fi
  done
  return 1
}

if [[ ! -f $TOOLCHAIN_FILE ]]; then
  printf '%s/rust-toolchain.toml is missing; it decides which clippy this check trusts.\n' "$LABEL" >&2
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
  printf 'refusing to judge lints: %s/rust-toolchain.toml pins %s but `rustc --version` says "%s".\n' \
    "$LABEL" "$channel" "$installed" >&2
  printf "clippy's lint set differs between compiler versions, so this run could only produce a misleading verdict.\n" >&2
  exit 1
fi

if [[ $mode == self-test ]]; then
  fixture=$(mktemp -d "${TMPDIR:-/tmp}/zuuli-clippy-self-test.XXXXXX")
  trap 'rm -rf -- "$fixture"' EXIT
  mkdir "$fixture/src"
  cat > "$fixture/Cargo.toml" <<'EOF'
[package]
name = "zuuli-clippy-negative-control"
version = "0.0.0"
edition = "2024"

[workspace]
EOF
  cat > "$fixture/build.rs" <<'EOF'
fn main() {
    let expected = std::env::var("ZUU_CLIPPY_EXPECT_TARGET_OS")
        .expect("self-test expected target OS is missing");
    let actual = std::env::var("CARGO_CFG_TARGET_OS")
        .expect("Cargo did not report the selected target OS");
    assert_eq!(actual, expected, "clippy selected the wrong target OS");
}
EOF
  cat > "$fixture/src/lib.rs" <<'EOF'
pub fn target_native_warning(value: bool) -> bool {
    if value { true } else { false }
}
EOF
  if ZUU_CLIPPY_EXPECT_TARGET_OS="$expected_target_os" \
    CARGO_TARGET_DIR="$fixture/target" cargo clippy \
    --manifest-path "$fixture/Cargo.toml" -- -D warnings \
    > "$fixture/clippy.log" 2>&1; then
    printf 'clippy negative control unexpectedly accepted a known warning on %s.\n' \
      "$(rustc -vV | awk -F': ' '/^host:/ { print $2 }')" >&2
    exit 1
  fi
  if ! grep -F 'clippy::needless_bool' "$fixture/clippy.log" >/dev/null; then
    printf 'clippy negative control failed for an unexpected reason:\n' >&2
    cat "$fixture/clippy.log" >&2
    exit 1
  fi
  printf 'Clippy -D warnings rejected the target-native negative control for %s on %s.\n' \
    "$expected_target_os" "$(rustc -vV | awk -F': ' '/^host:/ { print $2 }')"

  # The submodule requirement is per-tree and derived, so prove the derivation
  # both ways: this tree — wallet, unless --root said otherwise — must still be
  # held to a checked-out librustzcash, and a tree that never points into it
  # must not be.
  self_test_manifests=()
  while IFS= read -r manifest; do
    self_test_manifests+=("${manifest#./}")
  done < <(discover_manifests)
  if [[ ${#self_test_manifests[@]} -eq 0 ]]; then
    printf 'self-test FAILED: no Cargo manifests found under %s/ to derive the submodule requirement from.\n' \
      "$LABEL" >&2
    exit 1
  fi
  if ! manifests_need_submodule "${self_test_manifests[@]}"; then
    printf 'self-test FAILED: %s/ no longer reads as needing z/zcash/librustzcash; the requirement has gone silent.\n' \
      "$LABEL" >&2
    exit 1
  fi
  printf 'self-test: %s/ still requires the z/zcash/librustzcash checkout.\n' "$LABEL"

  if manifests_need_submodule "$fixture/Cargo.toml"; then
    printf 'self-test FAILED: a tree with no path dependency into z/zcash/librustzcash was held to it anyway.\n' >&2
    exit 1
  fi
  printf 'self-test: a tree that never points into z/zcash/librustzcash is not held to it.\n'

  # And prove --root reaches a second tree at all, with the negative control
  # first: an unlintable crate under --root must fail.
  mkdir -p "$fixture/tree/relay/src"
  printf '[toolchain]\nchannel = "%s"\n' "$channel" > "$fixture/tree/rust-toolchain.toml"
  cat > "$fixture/tree/relay/Cargo.toml" <<'EOF'
[package]
name = "zuuli-clippy-root-control"
version = "0.0.0"
edition = "2024"

[workspace]
EOF
  cp "$fixture/src/lib.rs" "$fixture/tree/relay/src/lib.rs"
  # The real run lints --locked, so the fixture needs the lockfile it judges.
  cargo generate-lockfile --manifest-path "$fixture/tree/relay/Cargo.toml"
  if CARGO_TARGET_DIR="$fixture/target" "$SELF" --root "$fixture/tree" >/dev/null 2>&1; then
    printf 'self-test FAILED: --root accepted a crate with a known clippy warning.\n' >&2
    exit 1
  fi
  printf 'self-test: --root rejects a crate with a known clippy warning.\n'

  printf 'pub fn negate(value: bool) -> bool {\n    !value\n}\n' > "$fixture/tree/relay/src/lib.rs"
  if ! CARGO_TARGET_DIR="$fixture/target" "$SELF" --root "$fixture/tree" >/dev/null; then
    printf 'self-test FAILED: --root rejected a clippy-clean second tree.\n' >&2
    exit 1
  fi
  printf 'self-test: --root accepts a clippy-clean second tree.\n'
  exit 0
fi

manifests=()
while IFS= read -r manifest; do
  manifests+=("${manifest#./}")
done < <(discover_manifests)

if [[ ${#manifests[@]} -eq 0 ]]; then
  printf 'no Cargo manifests found under %s/; this check has gone blind.\n' "$LABEL" >&2
  exit 1
fi

if manifests_need_submodule "${manifests[@]}" && [[ ! -f $SUBMODULE/Cargo.toml ]]; then
  printf 'z/zcash/librustzcash is not checked out; clippy resolves and compiles the whole graph.\n' >&2
  printf 'Run: git submodule update --init z/zcash/librustzcash\n' >&2
  exit 1
fi

failed=()
for manifest in "${manifests[@]}"; do
  crate=$(dirname "$manifest")
  if [[ $mode == fix ]]; then
    printf '\n==> applying clippy fixes to %s/%s\n' "$LABEL" "$crate"
    # --allow-dirty/--allow-staged: this is run deliberately, mid-change, by
    # someone who will read the diff. Refusing on a dirty tree only pushes them
    # to stash and lose that context.
    cargo clippy --fix --locked --all-targets --allow-dirty --allow-staged \
      --manifest-path "$manifest"
    continue
  fi

  printf '\n==> cargo clippy -- %s/%s\n' "$LABEL" "$crate"
  # --locked: lint the lockfile CI actually builds, so a resolution that only
  # happens locally cannot change the verdict.
  if cargo clippy --locked --all-targets --manifest-path "$manifest" -- -D warnings; then
    continue
  fi
  failed+=("$LABEL/$crate")
done

if [[ $mode == fix ]]; then
  printf '\nRan clippy --fix over %d crate(s) with the pinned %s toolchain.\n' \
    "${#manifests[@]}" "$channel"
  printf 'Read every edit, then run scripts/check-rust-fmt.sh --fix.\n'
  exit 0
fi

if [[ ${#failed[@]} -gt 0 ]]; then
  printf '\n%d crate(s) failed the clippy gate: %s\n' "${#failed[@]}" "${failed[*]}" >&2
  printf 'Inspect the Cargo error above: this may be a lint, compile error, or missing target-native build prerequisite.\n' >&2
  printf 'For a real lint, fix the code or add only a narrow, justified #[allow(clippy::lint)].\n' >&2
  exit 1
fi

printf '\nAll %d Rust crate(s) under %s/ are clippy-clean (clippy from %s).\n' \
  "${#manifests[@]}" "$LABEL" "$channel"
