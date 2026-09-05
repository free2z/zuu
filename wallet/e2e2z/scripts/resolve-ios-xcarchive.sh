#!/usr/bin/env bash
# Print the single .xcarchive that `tauri ios build` produced.
#
# Tauri writes the archive flat at `src-tauri/gen/apple/build/<scheme>.xcarchive`
# (`config.archive_dir().join("<scheme>.xcarchive")`) regardless of `--target`.
# The arch-scoped `src-tauri/gen/apple/build/<arch>/` directories hold *export*
# products and never the archive itself.
#
# Resolving through one script rather than a path literal in the workflow means
# the release cannot consume a path that has never been proven to exist, and
# that "more than one archive" is an error rather than a silent first match.
set -euo pipefail

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
app_dir=$(CDPATH='' cd -- "$script_dir/.." && pwd)
build_dir="$app_dir/src-tauri/gen/apple/build"

archives=()
if [[ -d "$build_dir" ]]; then
  while IFS= read -r -d '' archive; do
    archives+=("$archive")
  done < <(find "$build_dir" -type d -name '*.xcarchive' -prune -print0)
fi

if [[ ${#archives[@]} -ne 1 ]]; then
  echo "expected exactly one iOS .xcarchive under $build_dir, found ${#archives[@]}" >&2
  [[ ${#archives[@]} -eq 0 ]] || printf '%s\n' "${archives[@]}" >&2
  exit 1
fi

printf '%s\n' "${archives[0]}"
