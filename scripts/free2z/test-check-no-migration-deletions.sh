#!/usr/bin/env bash
# Free2Z application check: test check no migration deletions.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/free2z/check-no-migration-deletions.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

REPO="${WORK}/repo"
mkdir -p "${REPO}"
cd "${REPO}"
git init -q .
git config user.email test@example.com
git config user.name test
git config commit.gpgsign false

mkdir -p py/free2z/dj/apps/search/migrations py/free2z/dj/apps/g12f
printf '' > py/free2z/dj/apps/search/migrations/__init__.py
printf 'initial\n' > py/free2z/dj/apps/search/migrations/0001_initial.py
printf 'hnsw\n' > py/free2z/dj/apps/search/migrations/0002_hnsw_cosine_opclass.py
printf 'view\n' > py/free2z/dj/apps/g12f/views.py
printf 'readme\n' > README.md
git add -A && git commit -qm base
BASE="$(git rev-parse HEAD)"

run() {
  set +e
  out="$("${SCRIPT}" "$@" 2>&1)"
  rc=$?
  set -e
}

# --- 1. The accident: a migration disappears. Must block. -------------------
git checkout -q -b revert-accident
git rm -q py/free2z/dj/apps/search/migrations/0002_hnsw_cosine_opclass.py
git commit -qm "silently drops a migration"
run "${BASE}" HEAD
[ "${rc}" -eq 1 ] || fail "a deleted migration did not fail the check (got ${rc})"
grep -q '0002_hnsw_cosine_opclass.py' <<<"${out}" || fail "the deleted file is not named in the output"
grep -q '::error title=' <<<"${out}" || fail "no ::error annotation for a deleted migration"
grep -qi 'django_migrations' <<<"${out}" || fail "the error does not explain the production consequence"

# --- 1a. The base may be given abbreviated, or as a ref. It must be RESOLVED.
#         A 40-hex shape test instead of a resolve turns the one honest exit
#         ("could not check") into a silent pass, and that is how the first
#         hand-run of this script reported EXIT=0 on the very commit it was
#         written to catch.
run "$(git rev-parse --short "${BASE}")" HEAD
[ "${rc}" -eq 1 ] || fail "an abbreviated base SHA was treated as unavailable (got ${rc})"
grep -q '::error title=' <<<"${out}" || fail "abbreviated base did not produce the real error"

# --- 1b. Same tree, explicit opt-out. Must pass, and must say it did. -------
ALLOW_MIGRATION_DELETIONS=1 run "${BASE}" HEAD
[ "${rc}" -eq 0 ] || fail "ALLOW_MIGRATION_DELETIONS=1 did not permit the deletion (got ${rc})"
grep -q '::warning' <<<"${out}" || fail "an allowed deletion was not disclosed"

# --- 2. A RENAMED migration is just as fatal (django_migrations stores the
#        name). Rename detection would report R, not D -- this pins --no-renames.
git checkout -q "${BASE}" -- . 2>/dev/null || true
git checkout -q -B rename-migration "${BASE}"
git mv py/free2z/dj/apps/search/migrations/0002_hnsw_cosine_opclass.py \
       py/free2z/dj/apps/search/migrations/0002_renamed.py
git commit -qm "renames a migration"
run "${BASE}" HEAD
[ "${rc}" -eq 1 ] || fail "a RENAMED migration was not caught (got ${rc}) -- rename detection is on"

# --- 3. Deleting migrations/__init__.py breaks the package. Must block. -----
git checkout -q -B drop-init "${BASE}"
git rm -q py/free2z/dj/apps/search/migrations/__init__.py
git commit -qm "drops the migrations package marker"
run "${BASE}" HEAD
[ "${rc}" -eq 1 ] || fail "deleting migrations/__init__.py was not caught (got ${rc})"

# --- 4. NEGATIVE CONTROLS: things that must NOT be blocked. -----------------
git checkout -q -B add-migration "${BASE}"
printf 'new\n' > py/free2z/dj/apps/search/migrations/0003_drop_l2_hnsw_index.py
git add -A && git commit -qm "adds a migration"
run "${BASE}" HEAD
[ "${rc}" -eq 0 ] || fail "ADDING a migration was blocked (got ${rc})"

git checkout -q -B edit-elsewhere "${BASE}"
printf 'edited\n' > README.md
git add -A && git commit -qm "edits an unrelated file"
run "${BASE}" HEAD
[ "${rc}" -eq 0 ] || fail "an unrelated edit was blocked (got ${rc})"

git checkout -q -B delete-normal-py "${BASE}"
git rm -q py/free2z/dj/apps/g12f/views.py
git commit -qm "deletes a normal python file"
run "${BASE}" HEAD
[ "${rc}" -eq 0 ] || fail "deleting a NON-migration .py was blocked (got ${rc}); this guard must stay narrow"

# --- 5. An unusable base must SAY it could not check, never pass quietly. ---
run "not-a-sha" HEAD
[ "${rc}" -eq 0 ] || fail "an unavailable base should not fail the build (got ${rc})"
grep -q '::warning title=Migration-deletion check did not run' <<<"${out}" ||
  fail "an unchecked run did not disclose that it was unchecked"

# An EMPTY base must FAIL OPEN, not reject the build. `merge_group` payloads
# carry no `pull_request.base.sha` and no `before`, so a checker that exits
# nonzero on an empty base rejects every merge-queue group -- and `gate` is the
# only required check, so that deadlocks the queue for the whole repository.
run "" HEAD
[ "${rc}" -eq 0 ] || fail "an empty base must fail open, or it deadlocks the merge queue (got ${rc})"
grep -q '::warning title=Migration-deletion check did not run' <<<"${out}" ||
  fail "an empty base passed without disclosing that nothing was checked"

# Genuinely calling it wrong -- no argument at all -- is still a usage error.
set +e
out="$("${SCRIPT}" 2>&1)"; rc=$?
set -e
[ "${rc}" -eq 2 ] || fail "no arguments at all is a usage error (got ${rc})"

# Verify the application workflow supplies an exact comparison commit.
WORKFLOW="${REPO_ROOT}/.github/workflows/free2z-web-ci.yml"
step="$(sed -n '/Migration deletion and assertion quality guards/,/Missing migrations check/p' "$WORKFLOW")"
[ -n "$step" ] || fail "migration-deletion step is absent"
grep -q 'pull_request.base.sha' <<<"$step" || fail "PR comparison commit is absent"
grep -q 'github.event.before' <<<"$step" || fail "push comparison commit is absent"
grep -q 'check-no-migration-deletions.sh' <<<"$step" || fail "deletion checker is not called"
echo "PASS: migration-deletion guard rejects deletions and renames with explicit controls"
