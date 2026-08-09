#!/usr/bin/env bash
# Hold every Rust crate under wallet/ to `cargo clippy -D warnings`.
#
# Clippy's lint set is not stable across compiler versions: lints are added,
# promoted between groups, and taught new patterns with every release, so the
# same source can be clean on one toolchain and warn on the next. A check that
# ran on whatever compiler happened to be installed would report that version
# skew as if it were a code defect. So, exactly like scripts/check-rust-fmt.sh,
# this renders a verdict only on the toolchain named by
# wallet/rust-toolchain.toml — it runs cargo from the directory holding that
# file so rustup selects the pin, and refuses to continue if a different
# compiler answers. Bumping the pin is therefore the one moment new lints can
# appear, and they appear in the bump's own pull request.
#
# Crates are discovered rather than listed. A new crate under wallet/ is gated
# from its first commit, which is the cheapest moment and never gets cheaper.
#
# Unlike scripts/check-rust-fmt.sh this genuinely compiles: clippy is a rustc
# driver and needs the whole dependency graph, so z/zcash/librustzcash must be
# checked out — the wallet crates reach the Zcash crates by path into it — and
# the Tauri system libraries must be installed. Budget it alongside the real
# builds, not alongside the formatting check.
#
# --all-targets so tests, benches and examples are linted too. Test code that
# nobody lints is where the next warning backlog comes from.
#
# Usage:
#   scripts/check-rust-clippy.sh          fail on any clippy warning
#   scripts/check-rust-clippy.sh --fix    apply clippy's machine-applicable fixes
#
# After --fix, read every edit before committing it and run
# scripts/check-rust-fmt.sh --fix: clippy's rewrites are usually right, but
# "usually" is not a standard wallet code is held to, and its suggestions do not
# re-indent the code they restructure.

set -euo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

# The directory holding rust-toolchain.toml. Cargo is invoked from here so
# rustup's toolchain selection — which keys off the working directory, not the
# --manifest-path — lands on the pinned channel.
RUST_ROOT=$REPO_ROOT/wallet
TOOLCHAIN_FILE=$RUST_ROOT/rust-toolchain.toml
SUBMODULE=$REPO_ROOT/z/zcash/librustzcash

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
  printf 'wallet/rust-toolchain.toml is missing; it decides which clippy this check trusts.\n' >&2
  exit 1
fi

channel=$(awk -F'"' '/^[[:space:]]*channel[[:space:]]*=/ { print $2; exit }' "$TOOLCHAIN_FILE")
if [[ ! $channel =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf 'channel in wallet/rust-toolchain.toml must be a three-component version, got "%s".\n' \
    "$channel" >&2
  exit 1
fi

if [[ ! -f $SUBMODULE/Cargo.toml ]]; then
  printf 'z/zcash/librustzcash is not checked out; clippy resolves and compiles the whole graph.\n' >&2
  printf 'Run: git submodule update --init z/zcash/librustzcash\n' >&2
  exit 1
fi

cd "$RUST_ROOT"

installed=$(rustc --version)
if [[ $installed != "rustc $channel "* ]]; then
  printf 'refusing to judge lints: wallet/rust-toolchain.toml pins %s but `rustc --version` says "%s".\n' \
    "$channel" "$installed" >&2
  printf "clippy's lint set differs between compiler versions, so this run could only produce a misleading verdict.\n" >&2
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
    printf '\n==> applying clippy fixes to wallet/%s\n' "$crate"
    # --allow-dirty/--allow-staged: this is run deliberately, mid-change, by
    # someone who will read the diff. Refusing on a dirty tree only pushes them
    # to stash and lose that context.
    cargo clippy --fix --locked --all-targets --allow-dirty --allow-staged \
      --manifest-path "$manifest"
    continue
  fi

  printf '\n==> cargo clippy -- wallet/%s\n' "$crate"
  # --locked: lint the lockfile CI actually builds, so a resolution that only
  # happens locally cannot change the verdict.
  if cargo clippy --locked --all-targets --manifest-path "$manifest" -- -D warnings; then
    continue
  fi
  failed+=("wallet/$crate")
done

if [[ $mode == fix ]]; then
  printf '\nRan clippy --fix over %d crate(s) with the pinned %s toolchain.\n' \
    "${#manifests[@]}" "$channel"
  printf 'Read every edit, then run scripts/check-rust-fmt.sh --fix.\n'
  exit 0
fi

if [[ ${#failed[@]} -gt 0 ]]; then
  printf '\n%d crate(s) have clippy warnings: %s\n' "${#failed[@]}" "${failed[*]}" >&2
  printf 'Fix the code, or add a narrow #[allow(clippy::lint)] with a comment saying why.\n' >&2
  printf 'Do not blanket-allow at crate level, and do not raise the bar for the next reader.\n' >&2
  exit 1
fi

printf '\nAll %d Rust crate(s) under wallet/ are clippy-clean (clippy from %s).\n' \
  "${#manifests[@]}" "$channel"
