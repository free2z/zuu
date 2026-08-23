#!/usr/bin/env bash
# Fail if a tracked text file in this public repository references the private
# backend repository. Keep the two path components separate so the guard does
# not trigger on its own source.

set -euo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
PRIVATE_OWNER=free2z
PRIVATE_REPOSITORY=tuzi
FORBIDDEN_REPOSITORY="$PRIVATE_OWNER/$PRIVATE_REPOSITORY"

check_repo() {
  local root=$1 matches status

  set +e
  matches=$(git -C "$root" grep -I -n -i -F -- "$FORBIDDEN_REPOSITORY" -- .)
  status=$?
  set -e

  case $status in
    0)
      printf 'private repository reference found in tracked public content:\n%s\n' "$matches" >&2
      return 1
      ;;
    1)
      return 0
      ;;
    *)
      printf 'unable to scan tracked repository content (git grep exited %s)\n' "$status" >&2
      return "$status"
      ;;
  esac
}

self_test() {
  local fixture
  fixture=$(mktemp -d)
  trap 'rm -rf -- "$fixture"' RETURN

  git -C "$fixture" init -q
  printf 'See https://github.com/%s/issues/1\n' "$FORBIDDEN_REPOSITORY" > "$fixture/reference.txt"
  git -C "$fixture" add reference.txt

  if check_repo "$fixture" >/dev/null 2>&1; then
    printf 'self-test failed: a private repository reference was accepted\n' >&2
    return 1
  fi

  printf 'Public documentation only.\n' > "$fixture/reference.txt"
  git -C "$fixture" add reference.txt
  check_repo "$fixture"
}

case ${1-} in
  '')
    check_repo "$REPO_ROOT"
    ;;
  --self-test)
    self_test
    ;;
  *)
    printf 'usage: %s [--self-test]\n' "${0##*/}" >&2
    exit 2
    ;;
esac
