#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 3 ]]; then
  echo "usage: scripts/verify-release-tag.sh <tag> <expected-commit> <metadata-output>" >&2
  exit 64
fi

tag=$1
expected_commit=$2
metadata_output=$3
remote=${RELEASE_TAG_REMOTE:-origin}

[[ "$tag" =~ ^zuuli-v[0-9]+\.[0-9]+\.[0-9]+\+[0-9]+$ ]] || {
  echo "invalid ZUULI release tag: $tag" >&2
  exit 65
}
[[ "$expected_commit" =~ ^[0-9a-f]{40}$ ]] || {
  echo "expected release commit must be a full lowercase SHA-1" >&2
  exit 65
}

tag_ref="refs/tags/$tag"
peeled_ref="$tag_ref^{}"
remote_refs=$(git ls-remote --tags "$remote" "$tag_ref" "$peeled_ref")
tag_object=$(awk -v ref="$tag_ref" '$2 == ref { print $1 }' <<<"$remote_refs")
peeled_commit=$(awk -v ref="$peeled_ref" '$2 == ref { print $1 }' <<<"$remote_refs")

[[ "$tag_object" =~ ^[0-9a-f]{40}$ ]] || {
  echo "required annotated release tag is missing on $remote: $tag" >&2
  exit 66
}
[[ "$peeled_commit" =~ ^[0-9a-f]{40}$ ]] || {
  echo "release tag must be annotated and peel to a commit: $tag" >&2
  exit 65
}

# Fetch into an isolated non-tag ref so the check observes the canonical
# remote without mutating or trusting an existing local tag.
verification_ref="refs/zuuli-release-verification/${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$"
trap 'git update-ref -d "$verification_ref" >/dev/null 2>&1 || true' EXIT
git fetch --quiet --no-tags "$remote" "+$tag_ref:$verification_ref"

fetched_object=$(git rev-parse "$verification_ref")
[[ "$fetched_object" == "$tag_object" ]] || {
  echo "release tag moved while its identity was being verified" >&2
  exit 75
}
[[ "$(git cat-file -t "$fetched_object")" == tag ]] || {
  echo "release tag must point through an annotated tag object" >&2
  exit 65
}
fetched_commit=$(git rev-parse "$verification_ref^{}")
[[ "$(git cat-file -t "$fetched_commit")" == commit ]] || {
  echo "release tag does not peel to a commit" >&2
  exit 65
}
[[ "$fetched_commit" == "$peeled_commit" ]] || {
  echo "remote release tag peel changed while its identity was being verified" >&2
  exit 75
}
[[ "$peeled_commit" == "$expected_commit" ]] || {
  echo "release tag $tag resolves to $peeled_commit, not prepared commit $expected_commit" >&2
  exit 65
}

mkdir -p "$(dirname "$metadata_output")"
printf '{\n  "schemaVersion": 1,\n  "tag": "%s",\n  "tagObject": "%s",\n  "peeledCommit": "%s",\n  "expectedCommit": "%s"\n}\n' \
  "$tag" "$tag_object" "$peeled_commit" "$expected_commit" > "$metadata_output"

