#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: scripts/verify-release-index.sh <artifact-root> <identity> <expected-commit>" >&2
  exit 64
fi

artifact_root=$1
identity=$2
expected_commit=$3

[[ -d "$artifact_root" ]] || { echo "artifact root does not exist: $artifact_root" >&2; exit 66; }
[[ "$identity" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\+(0|[1-9][0-9]*)$ ]] || {
  echo "invalid release identity: $identity" >&2
  exit 65
}
[[ "$expected_commit" =~ ^[0-9a-f]{40}$ ]] || {
  echo "expected commit must be a full lowercase SHA-1" >&2
  exit 65
}

artifact_count=0
for directory in "$artifact_root"/*; do
  [[ -e "$directory" ]] || continue
  name=$(basename "$directory")
  case "$name" in
    "zuuli-android-$identity-$expected_commit"|\
    "zuuli-ios-$identity-$expected_commit"|\
    "zuuli-linux-$identity-$expected_commit"|\
    "zuuli-macos-$identity-$expected_commit") ;;
    *)
      echo "unexpected release-index entry: $name" >&2
      exit 65
      ;;
  esac

  [[ -d "$directory" ]] || { echo "release artifact is not a directory: $name" >&2; exit 65; }
  [[ -f "$directory/provenance.json" ]] || {
    echo "release artifact has no top-level provenance.json: $name" >&2
    exit 65
  }

  provenance_count=0
  while IFS= read -r -d '' manifest; do
    jq -e --arg sha "$expected_commit" '.source.commit == $sha' "$manifest" >/dev/null
    provenance_count=$((provenance_count + 1))
  done < <(find "$directory" -type f -name provenance.json -print0)
  [[ "$provenance_count" -eq 1 ]] || {
    echo "release artifact must contain exactly one provenance.json: $name" >&2
    exit 65
  }
  artifact_count=$((artifact_count + 1))
done

[[ "$artifact_count" -gt 0 ]] || { echo "release index contains no platform artifacts" >&2; exit 65; }
