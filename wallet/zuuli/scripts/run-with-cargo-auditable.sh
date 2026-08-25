#!/bin/sh
set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
real_cargo=$(command -v cargo)
wrapper_parent=${RUNNER_TEMP:-/tmp}
wrapper_directory=$(mktemp -d "$wrapper_parent/zuuli-cargo-auditable.XXXXXX")
ln -s "$script_directory/cargo-auditable-cargo.sh" "$wrapper_directory/cargo"

PATH="$wrapper_directory:$PATH" \
  ZUULI_REAL_CARGO="$real_cargo" \
  RUSTC_BOOTSTRAP=1 \
  RUSTC_WRAPPER="$script_directory/rustc-without-bootstrap.sh" \
  CARGO_UNSTABLE_SBOM=true \
  CARGO_BUILD_SBOM=true \
  exec "$@"
