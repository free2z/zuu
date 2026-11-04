#!/usr/bin/env bash
# Free2Z application check: check no migration deletions.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $(basename "$0") <base-sha> [head-ref]" >&2
  exit 2
fi

base="$1"
head="${2:-HEAD}"

# An EMPTY base is "the workflow could not work out a comparison point", not a
# usage error, and it must FAIL OPEN. This check is a safety net that has
# already run on the pull request; a `merge_group` payload that does not
# resolve must not be able to reject every group and deadlock the merge queue
# on a repository where `gate` is the only required check. Loud warning, exit
# 0. (Caught by the codex review, which correctly rated it HIGH: the first
# draft exited 2 here.)
if [ -z "$base" ]; then
  echo "::warning title=Migration-deletion check did not run::No base commit was supplied for this event, so deleted migrations could not be detected on this run."
  echo "check-no-migration-deletions: empty base; not checked" >&2
  exit 0
fi

# On a merge_group run, or a force-push that orphaned the previous tip, there
# is no base to diff against (github.event.before can even be all zeros). Say
# so loudly rather than passing silently -- a check that quietly does nothing
# is the failure mode this repo keeps writing down.
#
# RESOLVE the ref rather than pattern-matching 40 hex characters. The workflow
# always passes a full SHA, but a human debugging this locally reaches for an
# abbreviated one or a branch name, and a shape test would answer "base
# unavailable, not checked" -- turning the one honest exit into the silent
# pass. Which is precisely what happened the first time this was run by hand
# against the commit it was written for.
if ! base_commit="$(git rev-parse --verify --quiet "${base}^{commit}")"; then
  echo "::warning title=Migration-deletion check did not run::Base commit '$base' is unavailable, so deleted migrations could not be detected on this run."
  echo "check-no-migration-deletions: base '$base' unavailable; not checked" >&2
  exit 0
fi
base="$base_commit"

# --no-renames on purpose: a RENAMED migration is exactly as fatal as a deleted
# one, because `django_migrations` records the file's NAME. With rename
# detection on, git would report it as R and this check would see nothing.
deleted="$(git diff --diff-filter=D --no-renames --name-only "$base" "$head" |
  grep -E '(^|/)migrations/[^/]+\.py$' || true)"

if [ -z "$deleted" ]; then
  echo "check-no-migration-deletions: no migration files removed since ${base:0:9}"
  exit 0
fi

if [ "${ALLOW_MIGRATION_DELETIONS:-0}" = "1" ]; then
  echo "::warning title=Migration deletions explicitly allowed::ALLOW_MIGRATION_DELETIONS=1 was set; the removals below were permitted."
  printf '  %s\n' $deleted
  exit 0
fi

echo "::error title=This change DELETES a migration that exists on the base::The files below are removed relative to ${base:0:9}. Production's django_migrations table still has their rows, the schema objects they created are still there, and makemigrations will want to recreate them -- and migrate is a Cloud Build step the deploy waits on. If this is an unintended revert (a rebase or squash that took an older tree), rebuild the branch; if it is a deliberate migration squash, set ALLOW_MIGRATION_DELETIONS=1."
echo "DELETED MIGRATIONS:" >&2
printf '  %s\n' $deleted >&2
exit 1
