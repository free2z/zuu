#!/usr/bin/env bash
# Prove every Rust toolchain pin in this repository still agrees with the one
# place the version is actually decided: wallet/rust-toolchain.toml.
#
# Everything else — workflow inputs, the commit-pinned dtolnay/rust-toolchain
# refs, ZUULI_RUST_VERSION, each crate's `rust-version`, and the prose that
# quotes them — is a restatement. Restatements rot. This script fails the pull
# request when one of them stops matching, instead of letting a half-finished
# bump surface in a protected release build.
#
# Usage:
#   scripts/check-rust-toolchain.sh                  verify every pin agrees
#   scripts/check-rust-toolchain.sh --print-channel  print the pinned channel (X.Y.Z)
#   scripts/check-rust-toolchain.sh --print-msrv     print the MSRV floor (X.Y)
#   scripts/check-rust-toolchain.sh --self-test      prove the check still fails on drift

set -euo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

# The single source of truth.
TOOLCHAIN_FILE=wallet/rust-toolchain.toml

# Crate manifests. These carry the two-component MSRV form (1.88) of the
# three-component channel (1.88.0) — Cargo's `rust-version` is a floor, not an
# exact toolchain, so the forms are deliberately different and compared as such.
MANIFESTS=(
  wallet/zuuli/src-tauri/Cargo.toml
  wallet/zuuallet/src-tauri/Cargo.toml
  wallet/plugins/tauri-plugin-zcash/Cargo.toml
)

# Workflows whose jobs verify the installed compiler with
# `rustc --version | grep -F "rustc $ZUULI_RUST_VERSION "`. GitHub cannot
# compute a workflow-level `env:` from a file, so this one value is restated
# per workflow and held to the source of truth here instead.
RUST_VERSION_ENV_WORKFLOWS=(
  .github/workflows/zuuli-packaging.yml
  .github/workflows/zuuli-release.yml
)

# Prose restatements. Each entry is `path` + TAB + a line the file must still
# contain, with %CHANNEL% / %MSRV% substituted. Documentation is checked by
# exact expected text rather than by pattern so the failure message tells the
# next person precisely what to write.
DOC_PINS=(
  $'wallet/zuuallet/README.md\t- [Rust](https://rustup.rs/) %MSRV%+ (edition 2024)'
  $'wallet/plugins/tauri-plugin-zcash/README.md\tcargo +%CHANNEL% check --locked'
  $'wallet/plugins/tauri-plugin-zcash/README.md\tcargo +%CHANNEL% test --locked'
  $'wallet/plugins/tauri-plugin-zcash/README.md\t- **MSRV**: %MSRV%'
  $'wallet/plugins/tauri-plugin-zcash/CLAUDE.md\tRust edition 2024, MSRV %MSRV%.'
  $'wallet/zuuli/docs/releasing.md\tRust `%CHANNEL%`'
  $'AGENTS.md\tThe pin is currently `%CHANNEL%`'
)

# `toolchain:` may be an expression instead of a literal, but only one that
# leads back to the source of truth. Anything else is opaque to this check and
# is therefore rejected rather than quietly trusted.
ACCEPTED_EXPRESSIONS=(
  'env.ZUULI_RUST_VERSION'
  'steps.rust_toolchain.outputs.version'
)

errors=0

fail() {
  printf 'drift: %s\n' "$*" >&2
  errors=$((errors + 1))
}

trim() {
  local s=$1
  s=${s#"${s%%[![:space:]]*}"}
  s=${s%"${s##*[![:space:]]}"}
  printf '%s' "$s"
}

contains() {
  local needle=$1 item
  shift
  for item in "$@"; do
    [[ $item == "$needle" ]] && return 0
  done
  return 1
}

# Turn a version into a literal for use inside an extended regular expression.
quote_re() {
  printf '%s' "${1//./\\.}"
}

read_channel() {
  local root=$1 channel
  if [[ ! -f "$root/$TOOLCHAIN_FILE" ]]; then
    printf '%s is missing; it is the single source of truth for the Rust toolchain.\n' \
      "$TOOLCHAIN_FILE" >&2
    return 1
  fi
  channel=$(awk -F'"' '/^[[:space:]]*channel[[:space:]]*=/ { print $2; exit }' "$root/$TOOLCHAIN_FILE")
  if [[ ! $channel =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf 'channel in %s must be a three-component version, got "%s".\n' \
      "$TOOLCHAIN_FILE" "$channel" >&2
    return 1
  fi
  printf '%s\n' "$channel"
}

check_workflows() {
  local root=$1 channel=$2
  local file rel lineno text ref comment window value expression
  local refs=0 inputs=0 floating=0

  local files=()
  shopt -s nullglob
  files=("$root"/.github/workflows/*.yml)
  shopt -u nullglob

  if [[ ${#files[@]} -eq 0 ]]; then
    fail "no workflows found under .github/workflows; this check has gone blind"
    return
  fi

  for file in "${files[@]}"; do
    rel=${file#"$root"/}

    # 1. How each job selects the action, which on the version branches *is*
    #    the version selection.
    while IFS=: read -r lineno text; do
      refs=$((refs + 1))
      ref=${text#*dtolnay/rust-toolchain@}
      ref=${ref%%[[:space:]]*}
      comment=""
      if [[ $text == *"#"* ]]; then
        comment=$(trim "${text#*#}")
        comment=${comment%%[[:space:]]*}
      fi
      window=$(awk -v start="$lineno" '
        NR > start {
          if ($0 ~ /^[[:space:]]*-[[:space:]]/ || NR > start + 10) exit
          print
        }' "$file")

      if [[ $ref =~ ^[0-9a-f]{40}$ ]]; then
        # dtolnay/rust-toolchain's version branches hardcode the toolchain in
        # action.yml and do not even declare a `toolchain` input, so a
        # commit-pinned ref decides the compiler on its own and any
        # `toolchain:` beside it is inert. The trailing comment is the only
        # human- and machine-readable record of what the SHA installs.
        if [[ -z $comment ]]; then
          fail "$rel:$lineno pins dtolnay/rust-toolchain by commit with no '# <version>' comment; the SHA alone selects the compiler"
        elif [[ $comment != "$channel" ]]; then
          fail "$rel:$lineno pins dtolnay/rust-toolchain by commit commented '# $comment', expected '# $channel'"
        fi
      elif [[ $ref =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
        [[ $ref == "$channel" ]] ||
          fail "$rel:$lineno uses dtolnay/rust-toolchain@$ref, expected @$channel"
      elif [[ $ref =~ ^(stable|beta|nightly|master|main)$ ]]; then
        # A moving ref is only a pin when the step also passes `toolchain:`.
        # Without one the job deliberately floats (the zuuallet canary does);
        # that is reported, not failed.
        if ! grep -qE '(^|[[:space:],{])toolchain:' <<<"$window"; then
          floating=$((floating + 1))
        fi
      else
        fail "$rel:$lineno uses an unrecognized dtolnay/rust-toolchain ref '@$ref'"
      fi
    done < <(grep -nE 'uses:[[:space:]]*dtolnay/rust-toolchain@' "$file" || true)

    # 2. Explicit `toolchain:` inputs, in both block and flow mapping style.
    while IFS=: read -r lineno text; do
      inputs=$((inputs + 1))
      value=$(trim "${text#*toolchain:}")
      if [[ $value == '"'* ]]; then
        value=${value#\"}
        value=${value%%\"*}
      fi
      if [[ $value == '${{'* ]]; then
        expression=${value#*\{\{}
        expression=${expression%%\}\}*}
        expression=$(trim "$expression")
        if ! contains "$expression" "${ACCEPTED_EXPRESSIONS[@]}"; then
          fail "$rel:$lineno resolves the toolchain from \${{ $expression }}, which cannot be traced back to $TOOLCHAIN_FILE"
        fi
      else
        value=${value%%[[:space:]]*}
        value=${value%,}
        value=${value%\}}
        value=${value%,}
        [[ $value == "$channel" ]] ||
          fail "$rel:$lineno sets toolchain: $value, expected $channel"
      fi
    done < <(grep -nE '(^|[[:space:],{])toolchain:[[:space:]]' "$file" || true)

    # 3. The verified release environment variable.
    while IFS=: read -r lineno text; do
      value=$(trim "${text#*ZUULI_RUST_VERSION:}")
      value=${value#\"}
      value=${value%\"}
      [[ $value == "$channel" ]] ||
        fail "$rel:$lineno declares ZUULI_RUST_VERSION: $value, expected $channel"
    done < <(grep -nE '^[[:space:]]*ZUULI_RUST_VERSION:' "$file" || true)
  done

  # The release jobs grep the installed compiler against this variable. If a
  # workflow stops declaring it, the safety net is gone and the check must say so.
  for rel in "${RUST_VERSION_ENV_WORKFLOWS[@]}"; do
    if [[ ! -f "$root/$rel" ]]; then
      fail "$rel is missing"
      continue
    fi
    grep -qE "^[[:space:]]*ZUULI_RUST_VERSION:[[:space:]]*\"$(quote_re "$channel")\"[[:space:]]*$" "$root/$rel" ||
      fail "$rel does not declare ZUULI_RUST_VERSION: \"$channel\""
  done

  (( refs > 0 )) ||
    fail "no dtolnay/rust-toolchain steps matched; this check has gone blind"
  (( inputs > 0 )) ||
    fail "no 'toolchain:' inputs matched; this check has gone blind"

  if (( floating > 0 )); then
    printf 'note: %d rust-toolchain step(s) intentionally float on a moving ref (upstream canaries).\n' \
      "$floating"
  fi
}

check_manifests() {
  local root=$1 channel=$2 msrv=$3
  local rel line value

  for rel in "${MANIFESTS[@]}"; do
    if [[ ! -f "$root/$rel" ]]; then
      fail "$rel is missing"
      continue
    fi
    line=$(grep -E '^[[:space:]]*rust-version[[:space:]]*=' "$root/$rel" || true)
    if [[ -z $line ]]; then
      fail "$rel does not declare rust-version"
      continue
    fi
    value=$(sed -nE 's/^[[:space:]]*rust-version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' <<<"$line")
    [[ $value == "$msrv" ]] ||
      fail "$rel declares rust-version = \"$value\", expected \"$msrv\" (the MSRV form of channel $channel)"
  done
}

check_docs() {
  local root=$1 channel=$2 msrv=$3
  local entry rel needle

  for entry in "${DOC_PINS[@]}"; do
    rel=${entry%%$'\t'*}
    needle=${entry#*$'\t'}
    needle=${needle//%CHANNEL%/$channel}
    needle=${needle//%MSRV%/$msrv}
    if [[ ! -f "$root/$rel" ]]; then
      fail "$rel is missing"
      continue
    fi
    grep -qF -- "$needle" "$root/$rel" ||
      fail "$rel no longer says: $needle"
  done
}

run_checks() {
  local root=$1 channel msrv

  errors=0
  channel=$(read_channel "$root") || return 1
  msrv=${channel%.*}

  check_workflows "$root" "$channel"
  check_manifests "$root" "$channel" "$msrv"
  check_docs "$root" "$channel" "$msrv"

  if (( errors > 0 )); then
    printf '%d pin(s) disagree with %s (channel %s, MSRV %s).\n' \
      "$errors" "$TOOLCHAIN_FILE" "$channel" "$msrv" >&2
    return 1
  fi

  printf 'Every Rust toolchain pin agrees with %s: channel %s, MSRV %s.\n' \
    "$TOOLCHAIN_FILE" "$channel" "$msrv"
}

# --- self-test ---------------------------------------------------------------
#
# Copies the files this check reads into a scratch tree, confirms the untouched
# copy passes, then breaks one pin at a time and confirms each break is caught.
# A check that cannot be shown to fail is not a check.

SELF_TEST_MUTATIONS=(
  $'a commit-pinned action loses its version comment\t.github/workflows/zuuli-packaging.yml\ts| # %CHANNEL%||'
  $'a workflow declares a stale ZUULI_RUST_VERSION\t.github/workflows/zuuli-packaging.yml\ts|ZUULI_RUST_VERSION: "%CHANNEL%"|ZUULI_RUST_VERSION: "%BOGUS%"|'
  $'a version-branch action ref drifts\t.github/workflows/zuuallet.yml\ts|rust-toolchain@%CHANNEL%|rust-toolchain@%BOGUS%|'
  $'the required gate stops reading the source of truth\t.github/workflows/zuuli.yml\ts|steps.rust_toolchain.outputs.version|steps.somewhere_else.outputs.version|'
  $'a crate manifest MSRV drifts\twallet/zuuli/src-tauri/Cargo.toml\ts|rust-version = "%MSRV%"|rust-version = "%BOGUS_MSRV%"|'
  $'documentation still names the old version\twallet/plugins/tauri-plugin-zcash/README.md\ts|MSRV\\*\\*: %MSRV%|MSRV**: %BOGUS_MSRV%|'
  $'only the source of truth is bumped and nothing follows\twallet/rust-toolchain.toml\ts|channel = "%CHANNEL%"|channel = "%BOGUS%"|'
)

staged_paths() {
  local entry file
  printf '%s\n' "$TOOLCHAIN_FILE"
  printf '%s\n' "${MANIFESTS[@]}"
  for entry in "${DOC_PINS[@]}"; do
    printf '%s\n' "${entry%%$'\t'*}"
  done
  shopt -s nullglob
  for file in "$REPO_ROOT"/.github/workflows/*.yml; do
    printf '.github/workflows/%s\n' "$(basename "$file")"
  done
  shopt -u nullglob
}

stage_tree() {
  local dest=$1 rel
  while IFS= read -r rel; do
    [[ -e "$dest/$rel" ]] && continue
    mkdir -p "$dest/$(dirname "$rel")"
    cp "$REPO_ROOT/$rel" "$dest/$rel"
  done < <(staged_paths)
}

apply_sed() {
  local file=$1 script=$2 scratch
  scratch=$(mktemp)
  sed "$script" "$file" >"$scratch"
  cat "$scratch" >"$file"
  rm -f "$scratch"
}

SELF_TEST_SCRATCH=

cleanup_self_test() {
  [[ -n $SELF_TEST_SCRATCH ]] && rm -rf "$SELF_TEST_SCRATCH"
  return 0
}

self_test() {
  local scratch channel msrv bogus bogus_msrv
  local mutation description rel script staged before after
  local failures=0

  SELF_TEST_SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/rust-toolchain-check.XXXXXX")
  scratch=$SELF_TEST_SCRATCH
  trap cleanup_self_test EXIT

  stage_tree "$scratch/baseline"
  if ! run_checks "$scratch/baseline" >/dev/null; then
    printf 'self-test FAILED: the unmodified tree must pass the drift check.\n' >&2
    return 1
  fi
  printf 'self-test: the unmodified tree passes.\n'

  channel=$(read_channel "$scratch/baseline")
  msrv=${channel%.*}
  bogus=9.99.9
  bogus_msrv=9.99

  local index=0
  for mutation in "${SELF_TEST_MUTATIONS[@]}"; do
    index=$((index + 1))
    IFS=$'\t' read -r description rel script <<<"$mutation"
    script=${script//%CHANNEL%/$channel}
    script=${script//%MSRV%/$msrv}
    script=${script//%BOGUS_MSRV%/$bogus_msrv}
    script=${script//%BOGUS%/$bogus}

    staged="$scratch/mutation-$index"
    stage_tree "$staged"
    before=$(cat "$staged/$rel")
    apply_sed "$staged/$rel" "$script"
    after=$(cat "$staged/$rel")

    if [[ $before == "$after" ]]; then
      printf 'self-test FAILED: mutation %d (%s) changed nothing; the case no longer applies.\n' \
        "$index" "$description" >&2
      failures=$((failures + 1))
      continue
    fi

    if run_checks "$staged" >/dev/null 2>&1; then
      printf 'self-test FAILED: drift went undetected when %s.\n' "$description" >&2
      failures=$((failures + 1))
      continue
    fi
    printf 'self-test: caught drift when %s.\n' "$description"
  done

  if (( failures > 0 )); then
    printf '%d self-test case(s) failed.\n' "$failures" >&2
    return 1
  fi
  printf 'self-test: %d drift case(s) caught.\n' "${#SELF_TEST_MUTATIONS[@]}"
}

usage() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
}

main() {
  case "${1-}" in
    "")
      run_checks "$REPO_ROOT"
      ;;
    --print-channel)
      read_channel "$REPO_ROOT"
      ;;
    --print-msrv)
      local channel
      channel=$(read_channel "$REPO_ROOT")
      printf '%s\n' "${channel%.*}"
      ;;
    --self-test)
      self_test
      ;;
    -h | --help)
      usage
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage >&2
      return 2
      ;;
  esac
}

main "$@"
