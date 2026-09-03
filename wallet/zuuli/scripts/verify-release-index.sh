#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: scripts/verify-release-index.sh <artifact-root> <identity> <expected-commit> <target>" >&2
  exit 64
fi

artifact_root=$1
identity=$2
expected_commit=$3
target=$4

[[ -d "$artifact_root" ]] || { echo "artifact root does not exist: $artifact_root" >&2; exit 66; }
[[ "$identity" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\+(0|[1-9][0-9]*)$ ]] || {
  echo "invalid release identity: $identity" >&2
  exit 65
}
[[ "$expected_commit" =~ ^[0-9a-f]{40}$ ]] || {
  echo "expected commit must be a full lowercase SHA-1" >&2
  exit 65
}

case "$target" in
  mobile) expected_platforms=(android ios) ;;
  ios) expected_platforms=(ios) ;;
  android) expected_platforms=(android) ;;
  desktop) expected_platforms=(linux macos) ;;
  all) expected_platforms=(android ios linux macos) ;;
  *) echo "invalid release target: $target" >&2; exit 65 ;;
esac

observed_platforms=""

artifact_count=0
for directory in "$artifact_root"/*; do
  [[ -e "$directory" ]] || continue
  name=$(basename "$directory")
  case "$name" in
    "zuuli-android-$identity-$expected_commit") platform=android ;;
    "zuuli-ios-$identity-$expected_commit") platform=ios ;;
    "zuuli-linux-$identity-$expected_commit") platform=linux ;;
    "zuuli-macos-$identity-$expected_commit") platform=macos ;;
    *)
      echo "unexpected release-index entry: $name" >&2
      exit 65
      ;;
  esac
  platform_selected=false
  for expected_platform in "${expected_platforms[@]}"; do
    [[ "$platform" == "$expected_platform" ]] && platform_selected=true
  done
  [[ "$platform_selected" == true ]] || {
    echo "release index contains unselected platform artifact: $name" >&2
    exit 65
  }
  [[ " $observed_platforms " != *" $platform "* ]] || {
    echo "release index contains duplicate platform artifact: $platform" >&2
    exit 65
  }
  observed_platforms="$observed_platforms $platform"

  [[ -d "$directory" ]] || { echo "release artifact is not a directory: $name" >&2; exit 65; }
  [[ -f "$directory/provenance.json" ]] || {
    echo "release artifact has no top-level provenance.json: $name" >&2
    exit 65
  }

  provenance_count=0
  while IFS= read -r -d '' manifest; do
    jq -e --arg sha "$expected_commit" '.source.commit == $sha' "$manifest" >/dev/null || {
      echo "release provenance is not bound to expected commit: $name" >&2
      exit 65
    }
    provenance_count=$((provenance_count + 1))
  done < <(find "$directory" -type f -name provenance.json -print0)
  [[ "$provenance_count" -eq 1 ]] || {
    echo "release artifact must contain exactly one provenance.json: $name" >&2
    exit 65
  }
  artifact_count=$((artifact_count + 1))
done

for platform in "${expected_platforms[@]}"; do
  [[ " $observed_platforms " == *" $platform "* ]] || {
    echo "release index is missing selected platform artifact: $platform" >&2
    exit 65
  }
done
[[ "$artifact_count" -eq "${#expected_platforms[@]}" ]] || {
  echo "release index artifact count does not match target: $target" >&2
  exit 65
}
