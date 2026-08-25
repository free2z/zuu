#!/bin/sh
set -eu

version=0.7.5
checksum=cd121127b91d68074770a620544182345d7db56d03dcbd85316ab11e54a5b1bc
script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
temporary=$(mktemp -d "${RUNNER_TEMP:-/tmp}/zuuli-cargo-auditable-source.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
archive="$temporary/cargo-auditable-$version.crate"

curl --fail --location --proto '=https' --tlsv1.2 \
  "https://static.crates.io/crates/cargo-auditable/cargo-auditable-$version.crate" \
  --output "$archive"
printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check
tar -xzf "$archive" -C "$temporary"
patch --fuzz=0 --batch --forward -d "$temporary" -p0 \
  --input="$script_directory/cargo-auditable-0.7.5-root.patch"
cargo install --force --locked --path "$temporary/cargo-auditable-$version"
installed=$(cargo install --list)
expected="cargo-auditable v${version} ($temporary/cargo-auditable-$version):"
printf '%s\n' "$installed" | grep -Fx -- "$expected"
