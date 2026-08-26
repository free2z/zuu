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
# The same file also owns the browser compilation target. The required ZUULI
# frontend job restates it because an action input cannot read TOML; this check
# rejects drift between those two declarations.
#
# Usage:
#   scripts/check-rust-toolchain.sh                  verify every pin agrees
#   scripts/check-rust-toolchain.sh --print-channel  print the pinned channel (X.Y.Z)
#   scripts/check-rust-toolchain.sh --print-msrv     print the MSRV floor (X.Y)
#   scripts/check-rust-toolchain.sh --print-targets  print the canonical WASM target
#   scripts/check-rust-toolchain.sh --self-test      prove the check still fails on drift
#
# A second top-level Rust tree needs its own rust-toolchain.toml so rustup
# selects the pin when cargo runs from it, and its crates carry their own
# rust-version. Neither is a second decision: register them as restatements and
# they are held to the one below, exactly like every other restatement.
#
#   scripts/check-rust-toolchain.sh --toolchain-file rs/rust-toolchain.toml \
#                                   --manifest rs/relay/Cargo.toml
#
# Registration used to be a discipline: this script only ever looked at the
# arrays below plus whatever flags a caller passed, so a crate nobody remembered
# to register was simply invisible to it and shipped with a wrong MSRV, or none,
# behind a green check identical to the one a registered crate gets. The
# registration census (check_census) closes that: it enumerates the manifests and
# toolchain files git actually tracks and fails on any that is not registered.
# See #553.

set -euo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

# The single source of truth.
TOOLCHAIN_FILE=wallet/rust-toolchain.toml

# Crate manifests. These carry the two-component MSRV form (1.88) of the
# three-component channel (1.88.0) — Cargo's `rust-version` is a floor, not an
# exact toolchain, so the forms are deliberately different and compared as such.
#
# This array is the registry, and check_census makes it exhaustive: every
# tracked Cargo.toml outside z/ that declares a [package] table must appear
# here. `--manifest` still works for an ad-hoc or not-yet-committed manifest,
# but a workflow flag is not a registration — the census runs in every
# invocation, including the bare one the required gate runs, which passes no
# flags at all and would fail on anything registered only elsewhere.
MANIFESTS=(
  wallet/zuuli/wasm-spike/Cargo.toml
  wallet/zuuli/crypto-target-spike/Cargo.toml
  wallet/zuuli/src-tauri/Cargo.toml
  wallet/zuuallet/src-tauri/Cargo.toml
  wallet/plugins/tauri-plugin-zcash/Cargo.toml
  wallet/plugins/tauri-plugin-f2zmsg/Cargo.toml
  rs/crates/f2z-codec/Cargo.toml
  rs/crates/f2z-relay-proto/Cargo.toml
  rs/crates/f2z-authority/Cargo.toml
  rs/crates/f2z-kt-core/Cargo.toml
  rs/crates/f2z-kt-client/Cargo.toml
  rs/crates/f2z-msg-identity/Cargo.toml
  # The two AGPL-3.0-only server binaries. Registered here rather than by a
  # workflow flag for #553's reason: the census runs in every invocation,
  # including the bare one the required zuuli gate runs, and a manifest
  # registered only in a workflow would be unpoliced there.
  rs/crates/f2z-kt/Cargo.toml
  rs/crates/f2z-witness/Cargo.toml
  rs/crates/f2z-relay-store/Cargo.toml
  rs/crates/f2z-relay-testkit/Cargo.toml
  rs/crates/f2z-relay/Cargo.toml
  # The messaging crates (#312). Client-linked and permissive, so they carry the
  # same `rust-version` restatement as every other crate under rs/.
  rs/crates/f2z-msg-store/Cargo.toml
  rs/crates/f2z-msg-mls/Cargo.toml
  rs/crates/f2z-msg-dag/Cargo.toml
)

# Other rust-toolchain.toml files. Cargo picks the toolchain from the directory
# it runs in, so a second Rust tree needs its own copy — but a copy is a
# restatement, never a second source of truth, and every entry here must repeat
# TOOLCHAIN_FILE's channel exactly. Extend with --toolchain-file. check_census
# holds this array to the tracked tree the same way it holds MANIFESTS.
TOOLCHAIN_RESTATEMENTS=(
  rs/rust-toolchain.toml
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
  $'wallet/plugins/tauri-plugin-f2zmsg/CLAUDE.md\tRust edition 2024, MSRV %MSRV%.'
  $'wallet/plugins/tauri-plugin-f2zmsg/CLAUDE.md\tcargo +%CHANNEL% build --locked'
  $'wallet/zuuli/docs/releasing.md\tRust `%CHANNEL%`'
  $'AGENTS.md\tThe pin is currently `%CHANNEL%`'
  # Not prose: release-identity.mjs reads rust-toolchain.toml and asserts the
  # channel equals this literal, so the release train fails closed on a silent
  # edit to the source of truth. Checked here so a *deliberate* bump does not
  # have to discover it 18 seconds into the packaging matrix.
  $'wallet/zuuli/scripts/release-identity.mjs\t  "%CHANNEL%",'
)

# `toolchain:` may be an expression instead of a literal, but only one that
# leads back to the source of truth. Anything else is opaque to this check and
# is therefore rejected rather than quietly trusted.
ACCEPTED_EXPRESSIONS=(
  'env.ZUULI_RUST_VERSION'
  'steps.frontend_rust_toolchain.outputs.version'
  'steps.rust_toolchain.outputs.version'
)

WASM_TARGET=wasm32-unknown-unknown

# Vendored ecosystem sources. Their MSRVs are upstream's decision, not ours, so
# the census stops at this prefix. They are submodules, so the superproject
# index does not list their contents in the first place — this is belt and
# braces for the day something under z/ stops being a submodule.
VENDORED_PREFIX=z/

# Every first-party Cargo manifest, including a virtual workspace manifest,
# belongs to exactly one of these independently gated Rust trees.  This is a
# path boundary, not a package registry: adding a third top-level Rust tree is
# therefore a policy change that must add both its root and its owner workflow.
POLICED_RUST_ROOTS=(
  wallet
  rs
)

# These are implementation identities, not alternate version decisions. The
# generic branch commit accepts the source-derived `toolchain:` input; the
# version-branch commit hardcodes exactly PINNED_ACTION_CHANNEL. Re-derive both
# from dtolnay/rust-toolchain's authoritative refs during a toolchain bump.
GENERIC_ACTION_SHA=4360b52568e2003a75bf9bc1d59f33a8e3fc893c
PINNED_ACTION_CHANNEL=1.97.1
PINNED_ACTION_SHA=032958afbdc797a9164d3bc0b56325c1308924a5

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

read_targets() {
  local root=$1 line
  line=$(grep -E '^[[:space:]]*targets[[:space:]]*=' "$root/$TOOLCHAIN_FILE" || true)
  if [[ $line != "targets = [\"$WASM_TARGET\"]" ]]; then
    printf '%s must declare exactly targets = ["%s"].\n' "$TOOLCHAIN_FILE" "$WASM_TARGET" >&2
    return 1
  fi
  printf '%s\n' "$WASM_TARGET"
}

# Print `line-number<TAB>value` for toolchain inputs that are structurally
# nested under this exact action step's `with:` mapping. Comments, sibling
# steps, and values at the wrong indentation cannot satisfy the contract.
step_toolchain_inputs() {
  local file=$1 uses_line=$2
  awk -v target="$uses_line" '
    function indentation(line, copy) {
      copy = line
      sub(/[^ ].*$/, "", copy)
      return length(copy)
    }
    NR == target {
      uses_indent = indentation($0)
      copy = $0
      sub(/^[ ]*/, "", copy)
      step_indent = uses_indent
      if (copy !~ /^-[ ]+/) step_indent -= 2
      next
    }
    NR > target {
      if ($0 ~ /^[ ]*$/ || $0 ~ /^[ ]*#/) next
      current_indent = indentation($0)
      if (current_indent <= step_indent) exit

      if (!in_with) {
        if (current_indent == step_indent + 2 && $0 ~ /^[ ]*with:[ ]*$/) {
          in_with = 1
          with_indent = current_indent
        }
        next
      }

      if (current_indent <= with_indent) {
        in_with = 0
        next
      }
      if (current_indent == with_indent + 2 && $0 ~ /^[ ]*toolchain:[ ]*/) {
        value = $0
        sub(/^[ ]*toolchain:[ ]*/, "", value)
        print NR "\t" value
      }
    }
  ' "$file"
}

check_workflows() {
  local root=$1 channel=$2
  local file rel lineno text ref comment value expression job binding binding_count input_lineno
  local refs=0 inputs=0 floating=0

  if [[ $PINNED_ACTION_CHANNEL != "$channel" ]]; then
    fail "dtolnay/rust-toolchain expected-commit map is for $PINNED_ACTION_CHANNEL, expected $channel"
  fi

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
      job=$(awk -v end="$lineno" '
        NR >= end { exit }
        /^  [A-Za-z0-9_-]+:[[:space:]]*$/ {
          value=$0
          sub(/^  /, "", value)
          sub(/:[[:space:]]*$/, "", value)
          job=value
        }
        END { print job }
      ' "$file")

      if [[ $ref =~ ^[0-9a-f]{40}$ ]]; then
        # A commit from a version branch hardcodes that compiler and is marked
        # with the canonical channel. A commit from the generic stable branch
        # pins the action implementation while `toolchain:` remains the
        # compiler input; the one canary with no input deliberately follows
        # rustup's stable channel. The comment distinguishes those two upstream
        # action shapes without making the action ref mutable again.
        if [[ -z $comment ]]; then
          fail "$rel:$lineno pins dtolnay/rust-toolchain by commit with no '# <version-or-channel>' comment"
        elif [[ $comment == stable ]]; then
          if [[ $ref != "$GENERIC_ACTION_SHA" ]]; then
            fail "$rel:$lineno labels dtolnay/rust-toolchain@$ref as stable, expected verified generic commit $GENERIC_ACTION_SHA"
          fi
          binding=$(step_toolchain_inputs "$file" "$lineno")
          binding_count=$(awk 'NF { count++ } END { print count + 0 }' <<<"$binding")
          if (( binding_count == 0 )); then
            if [[ $rel == .github/workflows/zuuallet.yml && $job == upstream-canary ]]; then
              floating=$((floating + 1))
            else
              fail "$rel:$lineno ($job) pins the generic stable action without a source-derived toolchain input; only zuuallet/upstream-canary may follow stable"
            fi
          elif (( binding_count != 1 )); then
            fail "$rel:$lineno ($job) must have exactly one toolchain input in its own with: mapping, found $binding_count"
          else
            input_lineno=${binding%%$'\t'*}
            value=${binding#*$'\t'}
            inputs=$((inputs + 1))
            if [[ $value == '"'* ]]; then
              value=${value#\"}
              value=${value%%\"*}
            fi
            if [[ $value == '${{'* ]]; then
              expression=${value#*\{\{}
              expression=${expression%%\}\}*}
              expression=$(trim "$expression")
              if ! contains "$expression" "${ACCEPTED_EXPRESSIONS[@]}"; then
                fail "$rel:$input_lineno resolves the toolchain from \${{ $expression }}, which cannot be traced back to $TOOLCHAIN_FILE"
              fi
            else
              value=${value%%[[:space:]]*}
              [[ $value == "$channel" ]] ||
                fail "$rel:$input_lineno sets toolchain: $value, expected $channel"
            fi
          fi
        elif [[ $comment != "$channel" ]]; then
          fail "$rel:$lineno pins dtolnay/rust-toolchain by commit commented '# $comment', expected '# stable' or '# $channel'"
        elif [[ $ref != "$PINNED_ACTION_SHA" ]]; then
          fail "$rel:$lineno labels dtolnay/rust-toolchain@$ref as $channel, expected verified version-branch commit $PINNED_ACTION_SHA"
        fi
      elif [[ $ref =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
        [[ $ref == "$channel" ]] ||
          fail "$rel:$lineno uses dtolnay/rust-toolchain@$ref, expected @$channel"
      elif [[ $ref =~ ^(stable|beta|nightly|master|main)$ ]]; then
        # A moving ref is only a pin when the step also passes `toolchain:`.
        # Without one the job deliberately floats (the zuuallet canary does);
        # that is reported, not failed.
        binding=$(step_toolchain_inputs "$file" "$lineno")
        binding_count=$(awk 'NF { count++ } END { print count + 0 }' <<<"$binding")
        if (( binding_count == 0 )); then
          floating=$((floating + 1))
        fi
      else
        fail "$rel:$lineno uses an unrecognized dtolnay/rust-toolchain ref '@$ref'"
      fi
    done < <(grep -nE 'uses:[[:space:]]*dtolnay/rust-toolchain@' "$file" || true)

    # 2. Other explicit `toolchain:` inputs, in both block and flow mapping
    #    style. The generic-action inputs were already structurally bound above;
    #    this inventory also checks the inert but documented release inputs.
    while IFS=: read -r lineno text; do
      value=$(trim "$text")
      [[ $value == \#* ]] && continue
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
  (( floating == 1 )) ||
    fail "expected exactly one stable-following Rust compiler selection at zuuallet/upstream-canary, found $floating"

  if (( floating > 0 )); then
    printf 'note: %d Rust compiler selection(s) intentionally follow the stable channel (upstream canaries).\n' \
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

check_toolchain_restatements() {
  local root=$1 channel=$2
  local rel value

  (( ${#TOOLCHAIN_RESTATEMENTS[@]} > 0 )) || return 0

  for rel in "${TOOLCHAIN_RESTATEMENTS[@]}"; do
    if [[ $rel == "$TOOLCHAIN_FILE" ]]; then
      fail "$rel is the source of truth, not a restatement of it"
      continue
    fi
    if [[ ! -f "$root/$rel" ]]; then
      fail "$rel is missing"
      continue
    fi
    value=$(awk -F'"' '/^[[:space:]]*channel[[:space:]]*=/ { print $2; exit }' "$root/$rel")
    if [[ -z $value ]]; then
      fail "$rel does not declare a channel"
      continue
    fi
    [[ $value == "$channel" ]] ||
      fail "$rel pins channel \"$value\", expected \"$channel\" (from $TOOLCHAIN_FILE)"
  done
}

# Ask the pinned Cargo itself whether a manifest is a package or a virtual
# workspace.  TOML permits whitespace and quoted, inline, and dotted keys, so a
# source grep for `[package]` is neither complete nor sound. `read-manifest`
# succeeds only for a package. When it fails, a second semantic command,
# `metadata`, succeeds for a valid virtual workspace. Classification never
# depends on Cargo/rustup diagnostic wording, ANSI colour, or startup prelude;
# both commands failing is malformed or otherwise unclassifiable and fails
# closed.
CARGO_MANIFEST_KIND=
classify_cargo_manifest() {
  local root=$1 rel=$2 channel=$3
  local read_diagnostic_file metadata_diagnostic_file read_diagnostic metadata_diagnostic

  CARGO_MANIFEST_KIND=
  read_diagnostic_file=$(mktemp "${TMPDIR:-/tmp}/cargo-read-manifest.XXXXXX")
  metadata_diagnostic_file=$(mktemp "${TMPDIR:-/tmp}/cargo-metadata.XXXXXX")
  if cargo +"$channel" read-manifest --manifest-path "$root/$rel" \
    >/dev/null 2>"$read_diagnostic_file"; then
    CARGO_MANIFEST_KIND=package
    rm -f -- "$read_diagnostic_file" "$metadata_diagnostic_file"
    return 0
  fi

  if cargo +"$channel" metadata --no-deps --format-version 1 \
    --manifest-path "$root/$rel" >/dev/null 2>"$metadata_diagnostic_file"; then
    CARGO_MANIFEST_KIND=virtual
    rm -f -- "$read_diagnostic_file" "$metadata_diagnostic_file"
    return 0
  fi

  read_diagnostic=$(tail -n 3 "$read_diagnostic_file")
  metadata_diagnostic=$(tail -n 3 "$metadata_diagnostic_file")
  rm -f -- "$read_diagnostic_file" "$metadata_diagnostic_file"
  read_diagnostic=${read_diagnostic//$'\n'/; }
  metadata_diagnostic=${metadata_diagnostic//$'\n'/; }
  fail "$rel could not be classified by pinned Cargo $channel (read-manifest: ${read_diagnostic:-no diagnostic}; metadata: ${metadata_diagnostic:-no diagnostic})"
  return 1
}

# --- the registration census -------------------------------------------------
#
# Everything above verifies what it was *told about*. This is what makes the
# telling mandatory: the tracked tree is the input, so a crate cannot escape the
# MSRV check by never being mentioned. Without it, `check_manifests` and
# `check_toolchain_restatements` return the same green verdict whether a new
# crate was registered or forgotten, and only a reviewer noticing tells the two
# apart.

# The census input: every Cargo.toml and rust-toolchain.toml git tracks.
# `git ls-files` rather than a filesystem walk, so build artefacts, scratch
# checkouts and target/ directories cannot inflate or distract it.
census_tracked_files() {
  local root=$1 output=$2
  git -C "$root" ls-files -z -- '*Cargo.toml' '*rust-toolchain.toml' >"$output"
}

# Consume the NUL-delimited inventory directly. Shell variables never hold the
# complete stream, so tabs and newlines in a tracked path remain data rather
# than becoming record separators (and Bash 3.2 does not need mapfile).
check_census_inventory() {
  local root=$1 inventory=$2 channel=$3
  local rel base seen=0 owner owner_count
  local registered_toolchains=("$TOOLCHAIN_FILE")

  if (( ${#TOOLCHAIN_RESTATEMENTS[@]} > 0 )); then
    registered_toolchains+=("${TOOLCHAIN_RESTATEMENTS[@]}")
  fi

  while IFS= read -r -d '' rel; do
    if [[ $rel == "$VENDORED_PREFIX"* ]]; then
      continue
    fi

    base=${rel##*/}
    seen=$((seen + 1))

    if [[ $base == Cargo.toml ]]; then
      owner_count=0
      for owner in "${POLICED_RUST_ROOTS[@]}"; do
        if [[ $rel == "$owner/"* ]]; then
          owner_count=$((owner_count + 1))
        fi
      done
      if (( owner_count != 1 )); then
        fail "$rel belongs to $owner_count policed Rust roots; every first-party Cargo.toml must belong to exactly one of: ${POLICED_RUST_ROOTS[*]}"
      fi
    fi

    if [[ $base == rust-toolchain.toml ]]; then
      if contains "$rel" "${registered_toolchains[@]}"; then
        continue
      fi
      fail "$rel is an unregistered Rust toolchain file; nothing holds it to $TOOLCHAIN_FILE. Add it to TOOLCHAIN_RESTATEMENTS in scripts/check-rust-toolchain.sh"
      continue
    fi

    # Registered paths are checked for existence by check_manifests; a listed
    # path absent from this root is the staged-tree case, not a finding.
    if [[ ! -f "$root/$rel" ]]; then
      continue
    fi

    # Let the pinned Cargo parse and classify the manifest. This recognizes
    # every Cargo-valid spelling of the package table and cannot be vouched for
    # by a comment or multiline string containing `[package]`.
    if ! classify_cargo_manifest "$root" "$rel" "$channel"; then
      continue
    fi
    if [[ $CARGO_MANIFEST_KIND == virtual ]]; then
      if contains "$rel" "${MANIFESTS[@]}"; then
        fail "$rel is registered in MANIFESTS as a package, but pinned Cargo $channel classifies it as a virtual manifest"
      fi
      continue
    fi

    if contains "$rel" "${MANIFESTS[@]}"; then
      continue
    fi
    fail "$rel declares [package] but is registered nowhere, so nothing holds its rust-version to $TOOLCHAIN_FILE. Add it to MANIFESTS in scripts/check-rust-toolchain.sh"
  done <"$inventory"

  (( seen > 0 )) ||
    fail "no tracked crate manifests or toolchain files were enumerated; the registration census has gone blind"
}

check_census() {
  local root=$1 channel=$2 inventory

  inventory=$(mktemp "${TMPDIR:-/tmp}/rust-census.XXXXXX")
  if ! census_tracked_files "$root" "$inventory" 2>/dev/null; then
    rm -f -- "$inventory"
    fail "git could not enumerate tracked files; the registration census has gone blind"
    return
  fi
  check_census_inventory "$root" "$inventory" "$channel"
  rm -f -- "$inventory"
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

check_wasm_target() {
  local root=$1 target count
  target=$(read_targets "$root") || {
    fail "$TOOLCHAIN_FILE does not carry the canonical WASM target"
    return
  }
  count=$(grep -cE "^[[:space:]]*targets:[[:space:]]*${target}[[:space:]]*$" \
    "$root/.github/workflows/zuuli.yml" || true)
  [[ $count == 1 ]] ||
    fail ".github/workflows/zuuli.yml must restate targets: $target exactly once for the frontend compiler; found $count"
}

run_checks() {
  local root=$1 channel msrv

  errors=0
  channel=$(read_channel "$root") || return 1
  msrv=${channel%.*}

  check_workflows "$root" "$channel"
  check_manifests "$root" "$channel" "$msrv"
  check_toolchain_restatements "$root" "$channel"
  check_census "$root" "$channel"
  check_docs "$root" "$channel" "$msrv"
  check_wasm_target "$root"

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
  $'a generic action revision loses stable provenance\t.github/workflows/zuuallet.yml\ts|# stable|# beta|'
  $'a generic action SHA disagrees with its stable label\t.github/workflows/zuuallet.yml\ts|%GENERIC_ACTION_SHA% # stable|%PINNED_ACTION_SHA% # stable|'
  $'a version action SHA disagrees with its channel label\t.github/workflows/zuuallet.yml\ts|%PINNED_ACTION_SHA% # %CHANNEL%|%GENERIC_ACTION_SHA% # %CHANNEL%|'
  $'a required job cannot borrow another step toolchain input\t.github/workflows/zuuli.yml\t/^  rust_fmt:/,/^  rust_deny:/ s|toolchain: \${{ steps.rust_toolchain.outputs.version }}|compiler: \${{ steps.rust_toolchain.outputs.version }}|'
  $'a commented-out toolchain input is not real\t.github/workflows/zuuli.yml\t/^  rust_fmt:/,/^  rust_deny:/ s|          toolchain: \${{ steps.rust_toolchain.outputs.version }}|          # toolchain: \${{ steps.rust_toolchain.outputs.version }}|'
  $'a wrongly indented toolchain input is not step-bound\t.github/workflows/zuuli.yml\t/^  rust_fmt:/,/^  rust_deny:/ s|          toolchain: \${{ steps.rust_toolchain.outputs.version }}|        toolchain: \${{ steps.rust_toolchain.outputs.version }}|'
  $'the required gate stops reading the source of truth\t.github/workflows/zuuli.yml\ts|steps.rust_toolchain.outputs.version|steps.somewhere_else.outputs.version|'
  $'a crate manifest MSRV drifts\twallet/zuuli/src-tauri/Cargo.toml\ts|rust-version = "%MSRV%"|rust-version = "%BOGUS_MSRV%"|'
  $'documentation still names the old version\twallet/plugins/tauri-plugin-zcash/README.md\ts|MSRV\\*\\*: %MSRV%|MSRV**: %BOGUS_MSRV%|'
  $'only the source of truth is bumped and nothing follows\twallet/rust-toolchain.toml\ts|channel = "%CHANNEL%"|channel = "%BOGUS%"|'
  $'the canonical WASM target disappears from the source of truth\twallet/rust-toolchain.toml\ts|targets = \["wasm32-unknown-unknown"\]|targets = ["wasm32-wasip1"]|'
  $'the frontend compiler target drifts from the source of truth\t.github/workflows/zuuli.yml\ts|targets: wasm32-unknown-unknown|targets: wasm32-wasip1|'
)

staged_paths() {
  local entry file
  printf '%s\n' "$TOOLCHAIN_FILE"
  printf '%s\n' "${MANIFESTS[@]}"
  if (( ${#TOOLCHAIN_RESTATEMENTS[@]} > 0 )); then
    printf '%s\n' "${TOOLCHAIN_RESTATEMENTS[@]}"
  fi
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
  local dest=$1 rel manifest_dir target
  while IFS= read -r rel; do
    [[ -e "$dest/$rel" ]] && continue
    # A registered path that does not exist yet is the check's own finding to
    # report, not the staging step's to die on.
    [[ -e "$REPO_ROOT/$rel" ]] || continue
    mkdir -p "$dest/$(dirname "$rel")"
    cp "$REPO_ROOT/$rel" "$dest/$rel"
  done < <(staged_paths)

  # Include virtual workspace manifests in the census even though they are not
  # package registrations, then make the scratch tree a real Git index so the
  # self-test exercises the production producer end to end.
  while IFS= read -r -d '' rel; do
    [[ -e "$dest/$rel" ]] && continue
    mkdir -p "$dest/$(dirname "$rel")"
    cp "$REPO_ROOT/$rel" "$dest/$rel"
  done < <(git -C "$REPO_ROOT" ls-files -z -- '*Cargo.toml' '*rust-toolchain.toml')

  # Cargo's semantic package classifier also verifies that a package has a
  # target. Preserve the conventional tracked targets in the staged tree so
  # classification exercises the manifest, rather than failing because the
  # deliberately minimal fixture omitted src/lib.rs or src/main.rs.
  while IFS= read -r -d '' rel; do
    manifest_dir=$(dirname "$rel")
    for target in \
      "$manifest_dir/src/lib.rs" \
      "$manifest_dir/src/main.rs" \
      "$manifest_dir/build.rs"; do
      [[ -e "$REPO_ROOT/$target" ]] || continue
      mkdir -p "$dest/$(dirname "$target")"
      cp "$REPO_ROOT/$target" "$dest/$target"
    done
  done < <(git -C "$REPO_ROOT" ls-files -z -- '*Cargo.toml')

  git -C "$dest" init -q
  git -C "$dest" add -A
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
    script=${script//%GENERIC_ACTION_SHA%/$GENERIC_ACTION_SHA}
    script=${script//%PINNED_ACTION_SHA%/$PINNED_ACTION_SHA}
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

  self_test_census "$scratch" || failures=$((failures + $?))
  self_test_second_tree "$scratch" "$channel" "$msrv" || failures=$((failures + $?))

  if (( failures > 0 )); then
    printf '%d self-test case(s) failed.\n' "$failures" >&2
    return 1
  fi
  printf 'self-test: %d drift case(s) caught.\n' "${#SELF_TEST_MUTATIONS[@]}"
}

# --- self-test: the registration census --------------------------------------
#
# Every census case mutates a real staged Git index and enters through
# run_checks. This proves the filename producer, NUL boundary, ownership rule,
# and registration verdict together rather than testing a synthetic parser.
self_test_census_case() {
  local root=$1 description=$2 expect=$3 needle=$4
  local output

  output=$(run_checks "$root" 2>&1) && {
    if [[ $expect == reject ]]; then
      printf 'self-test FAILED: the census accepted %s.\n' "$description" >&2
      return 1
    fi
    printf 'self-test: the census accepts %s.\n' "$description"
    return 0
  }

  if [[ $expect == accept ]]; then
    printf 'self-test FAILED: the census rejected %s:\n%s\n' "$description" "$output" >&2
    return 1
  fi
  if [[ $output != *"$needle"* ]]; then
    printf 'self-test FAILED: the census rejected %s without naming the expected finding (%s):\n%s\n' \
      "$description" "$needle" "$output" >&2
    return 1
  fi
  printf 'self-test: the census rejects %s.\n' "$description"
}

self_test_census() {
  local scratch=$1
  local tree rel case_index=0
  local failures=0
  local saved_roots=("${POLICED_RUST_ROOTS[@]}")
  local saved_manifests=("${MANIFESTS[@]}")

  for rel in \
    outside/ordinary/Cargo.toml \
    outside/wallet/nested/Cargo.toml \
    walletish/Cargo.toml \
    rs-other/Cargo.toml \
    zebra/Cargo.toml \
    ' leading/Cargo.toml' \
    'outside/trailing /Cargo.toml' \
    'outside/space root/Cargo.toml' \
    $'outside/tab\troot/Cargo.toml' \
    $'outside/back\\slash/Cargo.toml' \
    $'outside/newline\nroot/Cargo.toml'; do
    case_index=$((case_index + 1))
    tree=$scratch/census-path-$case_index
    stage_tree "$tree"
    mkdir -p "$tree/$(dirname "$rel")"
    printf '[workspace]\nresolver = "3"\n' >"$tree/$rel"
    git -C "$tree" add -- "$rel"
    self_test_census_case "$tree" "an unowned Cargo manifest named $(printf '%q' "$rel")" \
      reject "drift: $rel belongs to 0 policed Rust roots" || failures=$((failures + 1))
  done

  tree=$scratch/census-overlapping-owner
  stage_tree "$tree"
  rel=wallet/nested/Cargo.toml
  mkdir -p "$tree/$(dirname "$rel")"
  printf '[workspace]\nresolver = "3"\n' >"$tree/$rel"
  git -C "$tree" add -- "$rel"
  POLICED_RUST_ROOTS+=(wallet/nested)
  self_test_census_case "$tree" 'a manifest claimed by overlapping Rust roots' \
    reject "$rel belongs to 2 policed Rust roots" || failures=$((failures + 1))
  POLICED_RUST_ROOTS=("${saved_roots[@]}")

  tree=$scratch/census-unregistered
  stage_tree "$tree"
  rel=rs/crates/scratch/Cargo.toml
  mkdir -p "$tree/$(dirname "$rel")/src"
  printf '[package]\nname = "scratch"\nversion = "0.0.0"\n' >"$tree/$rel"
  printf 'pub fn scratch() {}\n' >"$tree/$(dirname "$rel")/src/lib.rs"
  git -C "$tree" add -- "$rel" "$(dirname "$rel")/src/lib.rs"
  self_test_census_case "$tree" 'a new crate under rs/ that nobody registered' \
    reject "$rel declares [package] but is registered nowhere" || failures=$((failures + 1))

  # Cargo accepts many TOML spellings of the package table. Each fixture is a
  # real staged path with a real target, and must reach the same registration
  # verdict; a source grep for the canonical `[package]` spelling misses all
  # but the first control.
  local package_form description manifest package_case=0
  local package_forms=(
    $'canonical table\t[package]\nname = "census-form-%INDEX%"\nversion = "0.0.0"\nedition = "2024"'
    $'space inside table brackets\t[ package ]\nname = "census-form-%INDEX%"\nversion = "0.0.0"\nedition = "2024"'
    $'space before closing table bracket\t[package ]\nname = "census-form-%INDEX%"\nversion = "0.0.0"\nedition = "2024"'
    $'double-quoted table key\t["package"]\nname = "census-form-%INDEX%"\nversion = "0.0.0"\nedition = "2024"'
    $'single-quoted table key\t[\'package\']\nname = "census-form-%INDEX%"\nversion = "0.0.0"\nedition = "2024"'
    $'inline package table\tpackage = { name = "census-form-%INDEX%", version = "0.0.0", edition = "2024" }'
    $'dotted package keys\tpackage.name = "census-form-%INDEX%"\npackage.version = "0.0.0"\npackage.edition = "2024"'
  )
  for package_form in "${package_forms[@]}"; do
    package_case=$((package_case + 1))
    description=${package_form%%$'\t'*}
    manifest=${package_form#*$'\t'}
    manifest=${manifest//%INDEX%/$package_case}
    tree=$scratch/census-package-form-$package_case
    stage_tree "$tree"
    rel=wallet/census-package-form-$package_case/Cargo.toml
    mkdir -p "$tree/$(dirname "$rel")/src"
    printf '%s\n' "$manifest" >"$tree/$rel"
    printf 'pub fn package_form() {}\n' >"$tree/$(dirname "$rel")/src/lib.rs"
    git -C "$tree" add -- "$rel" "$(dirname "$rel")/src/lib.rs"
    self_test_census_case "$tree" "an unregistered Cargo-valid package using $description" \
      reject "$rel declares [package] but is registered nowhere" || failures=$((failures + 1))
  done

  # Cargo and rustup may decorate stderr before Cargo's own diagnostic. CI
  # deliberately sets CARGO_TERM_COLOR=always, and rustup may print a sync
  # prelude on a cold runner. A real wrapper injects both shapes before the
  # pinned Cargo commands: semantic command success must remain the only
  # classifier, while a malformed manifest must still fail closed.
  local cargo_noise_bin real_cargo
  cargo_noise_bin=$scratch/cargo-classifier-noise-bin
  real_cargo=$(command -v cargo)
  mkdir -p "$cargo_noise_bin"
  cat >"$cargo_noise_bin/cargo" <<'EOF'
#!/usr/bin/env bash
printf '\033[1;33minfo: syncing channel updates for classifier fixture\033[0m\n' >&2
exec "$CENSUS_REAL_CARGO" "$@"
EOF
  chmod +x "$cargo_noise_bin/cargo"

  tree=$scratch/census-invalid-manifest
  stage_tree "$tree"
  rel=wallet/census-invalid/Cargo.toml
  mkdir -p "$tree/$(dirname "$rel")/src"
  printf '[package\nname = "invalid"\nversion = "0.0.0"\n' >"$tree/$rel"
  printf 'pub fn invalid() {}\n' >"$tree/$(dirname "$rel")/src/lib.rs"
  git -C "$tree" add -- "$rel" "$(dirname "$rel")/src/lib.rs"
  (
    export PATH="$cargo_noise_bin:$PATH"
    export CENSUS_REAL_CARGO="$real_cargo"
    export CARGO_TERM_COLOR=always
    self_test_census_case "$tree" \
      'a malformed manifest despite ANSI and rustup prelude diagnostics' \
      reject "$rel could not be classified by pinned Cargo"
  ) || failures=$((failures + 1))

  tree=$scratch/census-virtual-string
  stage_tree "$tree"
  rel=wallet/census-virtual-string/Cargo.toml
  mkdir -p "$tree/$(dirname "$rel")"
  printf 'note = """\n[package]\n"""\n[workspace]\nresolver = "3"\n' >"$tree/$rel"
  git -C "$tree" add -- "$rel"
  (
    export PATH="$cargo_noise_bin:$PATH"
    export CENSUS_REAL_CARGO="$real_cargo"
    export CARGO_TERM_COLOR=always
    self_test_census_case "$tree" \
      'a valid virtual manifest despite ANSI/rustup prelude and multiline [package] text' \
      accept ''
  ) || failures=$((failures + 1))

  tree=$scratch/census-registered-virtual
  stage_tree "$tree"
  rel=wallet/census-registered-virtual/Cargo.toml
  local registered_msrv
  registered_msrv=$(read_channel "$tree")
  registered_msrv=${registered_msrv%.*}
  mkdir -p "$tree/$(dirname "$rel")"
  printf 'note = """\nrust-version = "%s"\n"""\n[workspace]\nresolver = "3"\n' \
    "$registered_msrv" >"$tree/$rel"
  git -C "$tree" add -- "$rel"
  MANIFESTS+=("$rel")
  self_test_census_case "$tree" \
    'a virtual manifest cannot masquerade as a registered package through string text' \
    reject "$rel is registered in MANIFESTS as a package" || failures=$((failures + 1))
  MANIFESTS=("${saved_manifests[@]}")

  tree=$scratch/census-third-root
  stage_tree "$tree"
  rel=third/Cargo.toml
  mkdir -p "$tree/third"
  printf '[workspace]\nresolver = "3"\n' >"$tree/$rel"
  git -C "$tree" add -- "$rel"
  self_test_census_case "$tree" 'a virtual manifest introduces a third Rust root' \
    reject "$rel belongs to 0 policed Rust roots" || failures=$((failures + 1))

  tree=$scratch/census-z
  stage_tree "$tree"
  rel=z/Cargo.toml
  mkdir -p "$tree/z"
  printf '[package]\nname = "vendored"\nversion = "0.0.0"\n' >"$tree/$rel"
  git -C "$tree" add -- "$rel"
  self_test_census_case "$tree" 'the exact vendored z/ boundary' accept '' ||
    failures=$((failures + 1))

  tree=$scratch/census-empty
  stage_tree "$tree"
  while IFS= read -r -d '' rel; do
    git -C "$tree" rm --cached -q -- "$rel"
  done < <(git -C "$tree" ls-files -z -- '*Cargo.toml' '*rust-toolchain.toml')
  self_test_census_case "$tree" 'an empty tracked Rust inventory' reject 'gone blind' ||
    failures=$((failures + 1))

  return "$failures"
}

# --- self-test: a second Rust tree -------------------------------------------
#
# The capability that lets `rs/` be policed by the same source of truth is
# proven here rather than by the existence of a second tree, so it is verified
# before the first one lands. A synthetic tree is registered through
# --toolchain-file and --manifest, confirmed to pass while it restates the pin,
# and then broken one way at a time.
self_test_second_tree() {
  local scratch=$1 channel=$2 msrv=$3
  local tree=$scratch/second-tree
  local failures=0
  local saved_manifests=("${MANIFESTS[@]}")
  local saved_restatements=()
  (( ${#TOOLCHAIN_RESTATEMENTS[@]} > 0 )) &&
    saved_restatements=("${TOOLCHAIN_RESTATEMENTS[@]}")

  stage_tree "$tree"
  mkdir -p "$tree/rs/crates/relay/src"
  printf '[toolchain]\nchannel = "%s"\n' "$channel" > "$tree/rs/rust-toolchain.toml"
  printf '[package]\nname = "relay"\nversion = "0.0.0"\nedition = "2024"\nrust-version = "%s"\n' \
    "$msrv" > "$tree/rs/crates/relay/Cargo.toml"
  printf 'pub fn relay() {}\n' > "$tree/rs/crates/relay/src/lib.rs"
  git -C "$tree" add -- \
    rs/rust-toolchain.toml rs/crates/relay/Cargo.toml rs/crates/relay/src/lib.rs

  MANIFESTS+=(rs/crates/relay/Cargo.toml)
  TOOLCHAIN_RESTATEMENTS+=(rs/rust-toolchain.toml)

  if run_checks "$tree" >/dev/null; then
    printf 'self-test: a second Rust tree that restates the pin passes.\n'
  else
    printf 'self-test FAILED: a second tree that restates the pin must pass.\n' >&2
    failures=$((failures + 1))
  fi

  self_test_second_tree_case "$tree" \
    'a second tree pins a channel of its own' \
    rs/rust-toolchain.toml "s|channel = \"$channel\"|channel = \"9.99.9\"|" ||
    failures=$((failures + 1))

  self_test_second_tree_case "$tree" \
    "a second tree's crate MSRV drifts" \
    rs/crates/relay/Cargo.toml "s|rust-version = \"$msrv\"|rust-version = \"9.99\"|" ||
    failures=$((failures + 1))

  rm -f "$tree/rs/rust-toolchain.toml"
  if run_checks "$tree" >/dev/null 2>&1; then
    printf 'self-test FAILED: drift went undetected when a second tree loses its toolchain file.\n' >&2
    failures=$((failures + 1))
  else
    printf 'self-test: caught drift when a second tree loses its toolchain file.\n'
  fi

  # A restatement that is really the source of truth proves nothing, so saying
  # so must be an error rather than a tautological pass.
  printf '[toolchain]\nchannel = "%s"\n' "$channel" > "$tree/rs/rust-toolchain.toml"
  TOOLCHAIN_RESTATEMENTS+=("$TOOLCHAIN_FILE")
  if run_checks "$tree" >/dev/null 2>&1; then
    printf 'self-test FAILED: the source of truth was accepted as a restatement of itself.\n' >&2
    failures=$((failures + 1))
  else
    printf 'self-test: the source of truth is rejected as a restatement of itself.\n'
  fi

  MANIFESTS=("${saved_manifests[@]}")
  TOOLCHAIN_RESTATEMENTS=()
  (( ${#saved_restatements[@]} > 0 )) &&
    TOOLCHAIN_RESTATEMENTS=("${saved_restatements[@]}")

  return "$failures"
}

self_test_second_tree_case() {
  local tree=$1 description=$2 rel=$3 script=$4
  local before after

  before=$(cat "$tree/$rel")
  apply_sed "$tree/$rel" "$script"
  after=$(cat "$tree/$rel")
  if [[ $before == "$after" ]]; then
    printf 'self-test FAILED: the second-tree case (%s) changed nothing.\n' "$description" >&2
    return 1
  fi

  if run_checks "$tree" >/dev/null 2>&1; then
    printf 'self-test FAILED: drift went undetected when %s.\n' "$description" >&2
    printf '%s\n' "$before" > "$tree/$rel"
    return 1
  fi
  printf 'self-test: caught drift when %s.\n' "$description"
  printf '%s\n' "$before" > "$tree/$rel"
}

usage() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
}

main() {
  local mode=''
  local channel

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --print-channel | --print-msrv | --print-targets | --self-test)
        if [[ -n $mode ]]; then
          printf 'conflicting arguments: %s and %s\n' "$mode" "$1" >&2
          usage >&2
          return 2
        fi
        mode=$1
        ;;
      --toolchain-file)
        if [[ -z ${2-} ]]; then
          printf -- '--toolchain-file needs a path relative to the repository root.\n' >&2
          return 2
        fi
        TOOLCHAIN_RESTATEMENTS+=("$2")
        shift
        ;;
      --manifest)
        if [[ -z ${2-} ]]; then
          printf -- '--manifest needs a path relative to the repository root.\n' >&2
          return 2
        fi
        MANIFESTS+=("$2")
        shift
        ;;
      -h | --help)
        usage
        return 0
        ;;
      *)
        printf 'unknown argument: %s\n' "$1" >&2
        usage >&2
        return 2
        ;;
    esac
    shift
  done

  case "$mode" in
    "")
      run_checks "$REPO_ROOT"
      ;;
    --print-channel)
      read_channel "$REPO_ROOT"
      ;;
    --print-msrv)
      channel=$(read_channel "$REPO_ROOT")
      printf '%s\n' "${channel%.*}"
      ;;
    --print-targets)
      read_targets "$REPO_ROOT"
      ;;
    --self-test)
      self_test
      ;;
  esac
}

main "$@"
