#!/usr/bin/env bash
# Run cargo-deny's supply-chain checks over every Rust crate under a Rust tree.
#
# The three wallet crates have independent lockfiles that resolve the Zcash and
# Tauri graphs differently, so each is checked separately — against one shared
# policy, wallet/deny.toml, so they cannot drift into disagreeing about what is
# acceptable. Crates are discovered rather than listed, so a new crate under the
# tree is gated from its first commit.
#
# The tree defaults to wallet/ and the policy to <tree>/deny.toml. A second
# top-level Rust namespace is gated by pointing --root at it; --config gives it
# its own policy, because "which advisories we accept" is a judgement about a
# particular dependency graph and a server graph is not the wallet's.
#
# cargo-deny is fetched as a checksum-verified release binary rather than built
# from source or installed by a third-party action. A tool whose job is to
# police the supply chain should not itself arrive from an unverified one: the
# version and the per-platform SHA-256 below are the whole trust decision, and
# they are in the repository where they can be reviewed and bumped deliberately.
#
# Unlike scripts/check-rust-fmt.sh this needs the dependency graph resolved, so
# z/zcash/librustzcash must be checked out for any tree whose crates reach the
# Zcash crates through path dependencies into it.
#
# Usage:
#   scripts/check-rust-deny.sh                  advisories, bans, licences, sources
#   scripts/check-rust-deny.sh advisories       one check only (any cargo-deny check)
#   scripts/check-rust-deny.sh --root DIR       judge a different Rust tree (default: wallet)
#   scripts/check-rust-deny.sh --config PATH    policy to enforce (default: <root>/deny.toml)
#   scripts/check-rust-deny.sh --print-version  print the pinned cargo-deny version
#   scripts/check-rust-deny.sh --self-test      prove the policy still decides the verdict

set -euo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# Absolute, because the self-test re-invokes this script after cd'ing into the
# tree under test, and because a relative --config is resolved against the
# directory the caller typed it in.
SELF=$REPO_ROOT/scripts/$(basename -- "${BASH_SOURCE[0]}")
INVOCATION_DIR=$PWD

# The Rust tree to judge, relative to the repository root.
DEFAULT_ROOT=wallet

# Bumping: change the version, then replace all four digests with the contents
# of the matching .sha256 files from the release. Never bump the version alone.
CARGO_DENY_VERSION=0.20.2
CARGO_DENY_SHA256_x86_64_unknown_linux_musl=9f12ed4c49936e09b48bf862b595cde2fe64fcbd9d74dfacac6131ca824c8d5f
CARGO_DENY_SHA256_aarch64_unknown_linux_musl=995c82be0defc7a025cae49a2aa2644ce8245c9a3318fc4103907c6a285e8c7d
CARGO_DENY_SHA256_x86_64_apple_darwin=248da7f581724e470071990c088ffc55c811981715f4cbdb258621fb79f8b7a6
CARGO_DENY_SHA256_aarch64_apple_darwin=fe67d82a10d8597a3549364cb733a3f9cc1bfff9031b7ae46384a9f2a72090c3

mode=check
root=$DEFAULT_ROOT
config=
check=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --print-version)
      printf '%s\n' "$CARGO_DENY_VERSION"
      exit 0
      ;;
    --self-test) mode=self-test ;;
    --root)
      root=${2-}
      if [[ -z $root ]]; then
        printf -- '--root needs a directory.\n' >&2
        exit 2
      fi
      shift
      ;;
    --config)
      config=${2-}
      if [[ -z $config ]]; then
        printf -- '--config needs a path to a deny.toml.\n' >&2
        exit 2
      fi
      shift
      ;;
    -h | --help)
      awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    -*)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
    *)
      if [[ -n $check ]]; then
        printf 'unknown argument: %s\n' "$1" >&2
        exit 2
      fi
      check=$1
      ;;
  esac
  shift
done
check=${check:-all}

# An absolute --root is accepted so the self-test can point this at a scratch
# tree; a relative one is a path from the repository root.
case "$root" in
  /*) RUST_ROOT=$root ;;
  *) RUST_ROOT=$REPO_ROOT/$root ;;
esac
LABEL=${root%/}

# --config is resolved before the cd below, against the directory the caller was
# standing in, so a relative path means what it looks like it means.
if [[ -z $config ]]; then
  CONFIG=$RUST_ROOT/deny.toml
else
  case "$config" in
    /*) CONFIG=$config ;;
    *) CONFIG=$INVOCATION_DIR/$config ;;
  esac
fi
CONFIG_LABEL=${CONFIG#"$REPO_ROOT"/}

host_target() {
  local os arch
  os=$(uname -s)
  arch=$(uname -m)
  case "$os/$arch" in
    Linux/x86_64) printf 'x86_64-unknown-linux-musl' ;;
    Linux/aarch64 | Linux/arm64) printf 'aarch64-unknown-linux-musl' ;;
    Darwin/x86_64) printf 'x86_64-apple-darwin' ;;
    Darwin/arm64) printf 'aarch64-apple-darwin' ;;
    *) return 1 ;;
  esac
}

expected_sha() {
  local var="CARGO_DENY_SHA256_${1//-/_}"
  printf '%s' "${!var-}"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Install into the repository rather than the user's PATH so a stale global
# cargo-deny cannot silently decide the verdict, and so the version in use is
# always the pinned one.
install_cargo_deny() {
  local target sha dest tmp url archive actual
  target=$(host_target) || {
    printf 'no pinned cargo-deny binary for %s/%s; install cargo-deny %s manually and re-run.\n' \
      "$(uname -s)" "$(uname -m)" "$CARGO_DENY_VERSION" >&2
    exit 1
  }
  sha=$(expected_sha "$target")
  if [[ -z $sha ]]; then
    printf 'no SHA-256 pinned for %s; refusing to run an unverified cargo-deny.\n' "$target" >&2
    exit 1
  fi

  dest=$REPO_ROOT/.cargo-deny/$CARGO_DENY_VERSION/cargo-deny
  if [[ -x $dest ]]; then
    printf '%s' "$dest"
    return
  fi

  url="https://github.com/EmbarkStudios/cargo-deny/releases/download/$CARGO_DENY_VERSION/cargo-deny-$CARGO_DENY_VERSION-$target.tar.gz"
  tmp=$(mktemp -d)
  archive=$tmp/cargo-deny.tar.gz
  printf 'Fetching cargo-deny %s for %s\n' "$CARGO_DENY_VERSION" "$target" >&2
  curl --fail --silent --show-error --location --retry 3 --output "$archive" "$url"

  # Lower-cased with tr rather than ${var,,} so this still runs on the bash 3.2
  # that ships with macOS, where developers verify before pushing.
  actual=$(sha256_of "$archive" | tr 'A-F' 'a-f')
  sha=$(printf '%s' "$sha" | tr 'A-F' 'a-f')
  if [[ $actual != "$sha" ]]; then
    printf 'cargo-deny download failed verification.\n  expected %s\n  actual   %s\n' \
      "$sha" "$actual" >&2
    rm -rf "$tmp"
    exit 1
  fi

  tar -xzf "$archive" -C "$tmp"
  mkdir -p "$(dirname "$dest")"
  mv "$tmp/cargo-deny-$CARGO_DENY_VERSION-$target/cargo-deny" "$dest"
  chmod +x "$dest"
  rm -rf "$tmp"
  printf '%s' "$dest"
}

# --- self-test ---------------------------------------------------------------
#
# Builds a scratch crate with a known licence and judges it twice under two
# policies that disagree about that licence. Passing both ways would mean
# --config is decorative; failing both ways would mean the tree is unreachable.
# A check nobody has watched fail is not a check.
if [[ $mode == self-test ]]; then
  fixture=$(mktemp -d "${TMPDIR:-/tmp}/zuuli-deny-self-test.XXXXXX")
  trap 'rm -rf -- "$fixture"' EXIT

  if "$SELF" --root "$fixture" >/dev/null 2>&1; then
    printf 'self-test FAILED: --root accepted a tree with no policy to enforce.\n' >&2
    exit 1
  fi
  printf 'self-test: --root refuses a tree whose deny.toml is missing.\n'

  mkdir -p "$fixture/relay/src"
  cat > "$fixture/relay/Cargo.toml" <<'EOF'
[package]
name = "zuuli-deny-self-test"
version = "0.0.0"
edition = "2024"
license = "GPL-3.0"

[workspace]
EOF
  printf 'pub fn negate(value: bool) -> bool {\n    !value\n}\n' > "$fixture/relay/src/lib.rs"
  # cargo-deny judges --locked, so the fixture needs the lockfile it judges.
  cargo generate-lockfile --manifest-path "$fixture/relay/Cargo.toml"

  printf '[licenses]\nallow = ["GPL-3.0"]\n' > "$fixture/deny.toml"
  if ! "$SELF" --root "$fixture" licenses >/dev/null 2>&1; then
    printf 'self-test FAILED: a permitted licence was rejected under <root>/deny.toml.\n' >&2
    exit 1
  fi
  printf 'self-test: --root enforces <root>/deny.toml.\n'

  # Negative control: same tree, same crate, a policy that forbids its licence.
  printf '[licenses]\nallow = ["MIT"]\n' > "$fixture/strict.toml"
  if "$SELF" --root "$fixture" --config "$fixture/strict.toml" licenses >/dev/null 2>&1; then
    printf 'self-test FAILED: --config did not decide the verdict; a forbidden licence passed.\n' >&2
    exit 1
  fi
  printf 'self-test: --config decides the verdict (a forbidden licence fails).\n'

  if "$SELF" --root "$fixture" --config "$fixture/absent.toml" licenses >/dev/null 2>&1; then
    printf 'self-test FAILED: --config accepted a policy file that does not exist.\n' >&2
    exit 1
  fi
  printf 'self-test: --config refuses a policy file that is not there.\n'

  printf 'self-test: 4 case(s) passed; cargo-deny %s.\n' "$CARGO_DENY_VERSION"
  exit 0
fi

if [[ ! -f $CONFIG ]]; then
  printf '%s is missing; it is the supply-chain policy this check enforces.\n' "$CONFIG_LABEL" >&2
  exit 1
fi

CARGO_DENY=$(install_cargo_deny)

cd "$RUST_ROOT"

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
  printf 'no Cargo manifests found under %s/; this check has gone blind.\n' "$LABEL" >&2
  exit 1
fi

failed=()
for manifest in "${manifests[@]}"; do
  crate=$(dirname "$manifest")
  printf '\n==> cargo-deny check %s -- %s/%s\n' "$check" "$LABEL" "$crate"
  # One shared policy across three lockfiles means some ignore entries apply to
  # a different lockfile than the one being checked; cargo-deny reports those as
  # `advisory-not-detected` warnings. They are expected and are not failures.
  # --locked: judge the lockfile CI actually builds. Without it cargo-deny may
  # regenerate the graph and clear an advisory that the committed Cargo.lock
  # still carries.
  if "$CARGO_DENY" --manifest-path "$manifest" --config "$CONFIG" --locked check "$check"; then
    continue
  fi
  failed+=("$LABEL/$crate")
done

if [[ ${#failed[@]} -gt 0 ]]; then
  printf '\n%d crate(s) failed the supply-chain policy: %s\n' "${#failed[@]}" "${failed[*]}" >&2
  printf 'Fix the dependency, or add a specific, reasoned entry to %s.\n' "$CONFIG_LABEL" >&2
  printf 'Do not broaden a category to make this pass.\n' >&2
  exit 1
fi

printf '\nAll %d Rust crate(s) under %s/ satisfy %s.\n' "${#manifests[@]}" "$LABEL" "$CONFIG_LABEL"
