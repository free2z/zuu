#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 3 ]]; then
  echo "usage: scripts/publish-github-release.sh <tag> <identity> <artifact-root>" >&2
  exit 64
fi

tag=$1
identity=$2
artifact_root=$3
[[ -d "$artifact_root" ]] || { echo "artifact root does not exist: $artifact_root" >&2; exit 66; }

if ! gh release view "$tag" >/dev/null 2>&1; then
  gh release create "$tag" --verify-tag --draft \
    --title "ZUULI $identity" \
    --notes "Immutable ZUULI $identity release candidate. Store promotion evidence is attached; keep draft until physical-device verification passes."
elif [[ "$(gh release view "$tag" --json isDraft --jq .isDraft)" != true ]]; then
  echo "release $tag is already published; refusing to mutate it" >&2
  exit 73
fi

package_dir=$(mktemp -d "${TMPDIR:-/tmp}/zuuli-github-release.XXXXXX")
for directory in "$artifact_root"/*; do
  [[ -d "$directory" ]] || continue
  name=$(basename "$directory")
  archive="$package_dir/$name.tar.gz"
  tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
    -cf - -C "$directory" . | gzip -n > "$archive"

  comparison_dir=$(mktemp -d "${TMPDIR:-/tmp}/zuuli-release-compare.XXXXXX")
  if gh release download "$tag" --pattern "$name.tar.gz" --dir "$comparison_dir" >/dev/null 2>&1; then
    existing="$comparison_dir/$name.tar.gz"
    if [[ "$(shasum -a 256 "$existing" | cut -d ' ' -f 1)" != "$(shasum -a 256 "$archive" | cut -d ' ' -f 1)" ]]; then
      echo "release asset collision for $name.tar.gz; refusing overwrite" >&2
      exit 73
    fi
    echo "$name.tar.gz already exists with the same checksum; keeping it"
  else
    gh release upload "$tag" "$archive"
  fi
done
