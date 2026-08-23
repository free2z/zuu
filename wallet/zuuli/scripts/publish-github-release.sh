#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 4 ]]; then
  echo "usage: scripts/publish-github-release.sh <tag> <identity> <expected-commit> <artifact-root>" >&2
  exit 64
fi

tag=$1
identity=$2
expected_commit=$3
artifact_root=$4
[[ -d "$artifact_root" ]] || { echo "artifact root does not exist: $artifact_root" >&2; exit 66; }

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tag_identity="$artifact_root/release-index/release-tag-identity.json"
verification_copy=$(mktemp "${TMPDIR:-/tmp}/zuuli-release-tag-identity.XXXXXX")
trap 'rm -f "$verification_copy"' EXIT

"$script_dir/verify-release-tag.sh" "$tag" "$expected_commit" "$tag_identity"

reverify_tag_identity() {
  "$script_dir/verify-release-tag.sh" "$tag" "$expected_commit" "$verification_copy"
  cmp -s "$tag_identity" "$verification_copy" || {
    echo "release tag identity changed during publication" >&2
    exit 75
  }
}

if ! gh release view "$tag" >/dev/null 2>&1; then
  gh release create "$tag" --verify-tag --draft \
    --title "ZUULI $identity" \
    --notes "Immutable ZUULI $identity release candidate. Store promotion evidence is attached; keep draft until physical-device verification passes."
elif [[ "$(gh release view "$tag" --json isDraft --jq .isDraft)" != true ]]; then
  echo "release $tag is already published; refusing to mutate it" >&2
  exit 73
fi

# Creating even a draft release is a publication-boundary mutation. Recheck
# immediately afterward so a tag move during `gh release create` cannot make
# later asset updates appear bound to a different source.
reverify_tag_identity

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
    # Asset upload updates the GitHub Release, so verify the canonical tag at
    # the last possible moment before every mutation.
    reverify_tag_identity
    gh release upload "$tag" "$archive"
  fi
done

reverify_tag_identity
