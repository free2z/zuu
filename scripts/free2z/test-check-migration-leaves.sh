#!/usr/bin/env bash
# Free2Z application check: test check migration leaves.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$SCRIPT_DIR/check-migration-leaves.py"
PYTHON="${PYTHON:-python3}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/test-migration-leaves.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

grepo() {
  local repo="${1:-}"
  shift
  case "$repo" in
    "$WORK"/*) ;;
    *)
      echo "FATAL: refusing to run 'git $*' against '${repo:-<empty>}'" >&2
      echo "       fixture repositories must live under $WORK" >&2
      exit 3
      ;;
  esac
  if [[ ! -d "$repo" ]]; then
    echo "FATAL: fixture repo does not exist: $repo" >&2
    exit 3
  fi
  command git -C "$repo" "$@"
}

new_repo() {
  # new_repo <name> -> sets the global $repo; leaves a committed 0001_initial
  # on `main`. Sets a global rather than echoing a path because every git
  # command below would otherwise have to be silenced to keep the substitution
  # clean -- and a stray line of git output silently becoming the repo path is
  # the kind of thing that makes a test pass for the wrong reason.
  local name="$1"
  repo="$WORK/$name"
  mkdir -p "$repo/py/demoapp/migrations"
  cat >"$repo/py/settings.py" <<'EOF'
SECRET_KEY = "test-only"
# contenttypes is here so a fixture can declare a genuine CROSS-APP dependency
# (see the repair-preserves-cross-app-dependency case). Its own migrations are
# linear and never conflict.
INSTALLED_APPS = ["django.contrib.contenttypes", "demoapp"]
# Deliberately empty: the guard must never need a database. If a future change
# makes it open a connection, these tests fail loudly instead of quietly
# depending on a Postgres that CI happens to have running.
DATABASES = {}
USE_TZ = True
DEFAULT_AUTO_FIELD = "django.db.models.AutoField"
EOF
  : >"$repo/py/demoapp/__init__.py"
  : >"$repo/py/demoapp/models.py"
  : >"$repo/py/demoapp/migrations/__init__.py"
  grepo "$repo" init -q -b main
  grepo "$repo" config user.email "test@example.invalid"
  grepo "$repo" config user.name "migration leaf test"
  grepo "$repo" config commit.gpgsign false
  write_migration "$repo" "0001_initial" "" ""
  commit "$repo" "initial"
}

write_migration() {
  # write_migration <repo> <name> <deps-python-list-body> <run_before-body>
  local repo="$1" name="$2" deps="$3" run_before="$4"
  cat >"$repo/py/demoapp/migrations/$name.py" <<EOF
from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [$deps]
    run_before = [$run_before]
    operations = []
EOF
}

commit() {
  grepo "$1" add -A
  grepo "$1" commit -q -m "$2"
}

run_guard() {
  # run_guard <repo> <base> -> exit code; output captured in $GUARD_OUT
  local repo="$1" base="$2"
  GUARD_OUT="$("$PYTHON" "$GUARD" \
      --repo-root "$repo" --py-dir "$repo/py" \
      --settings settings --base "$base" --no-fetch 2>&1)"
  return $?
}

expect_exit() {
  # expect_exit <label> <expected> <repo> <base> [substring...]
  local label="$1" expected="$2" repo="$3" base="$4"
  shift 4
  run_guard "$repo" "$base"
  local actual=$?
  local ok=1
  if [[ "$actual" != "$expected" ]]; then
    ok=0
    echo "FAIL  $label: expected exit $expected, got $actual"
  fi
  local needle
  for needle in "$@"; do
    if ! grep -qF -- "$needle" <<<"$GUARD_OUT"; then
      ok=0
      echo "FAIL  $label: output does not mention '$needle'"
    fi
  done
  if [[ "$ok" == 1 ]]; then
    echo "ok    $label (exit $actual)"
    PASS=$((PASS + 1))
  else
    echo "----- output -----"
    echo "$GUARD_OUT"
    echo "------------------"
    FAIL=$((FAIL + 1))
  fi
}

# --- case 0: the sandbox guard itself fires ----------------------------------
# Positive control for the control. If `grepo` ever stopped rejecting a path
# outside $WORK, these fixtures could once again mutate the repo they are run
# from, and every assertion below would become untrustworthy.

for bad_path in "" "$PWD" "/tmp"; do
  ( grepo "$bad_path" status ) >/dev/null 2>&1
  if [[ $? -eq 3 ]]; then
    echo "ok    fixture-guard-rejects '${bad_path:-<empty>}' (exit 3)"
    PASS=$((PASS + 1))
  else
    echo "FAIL  fixture-guard did NOT reject '${bad_path:-<empty>}'"
    FAIL=$((FAIL + 1))
  fi
done

# --- case 1: linear history, nothing added anywhere --------------------------

new_repo clean-linear
expect_exit "clean-linear" 0 "$repo" main

# --- case 2: linear branch on top of an unmoved main -------------------------

new_repo clean-branch
grepo "$repo" checkout -q -b feature
write_migration "$repo" "0002_feature" '("demoapp", "0001_initial")' ""
commit "$repo" "feature migration"
expect_exit "clean-branch-on-unmoved-main" 0 "$repo" main

new_repo stale-base-collision
grepo "$repo" checkout -q -b feature
write_migration "$repo" "0002_foo" '("demoapp", "0001_initial")' ""
commit "$repo" "our migration"
grepo "$repo" checkout -q main
write_migration "$repo" "0002_bar" '("demoapp", "0001_initial")' ""
commit "$repo" "somebody else's migration, merged first"
grepo "$repo" checkout -q feature

# NEGATIVE CONTROL: the branch in isolation is clean. This is precisely the
# answer today's gate computes, and precisely why it is green on a PR that will
# break the production deploy the moment it merges.
expect_exit "stale-base: branch in isolation is GREEN (negative control)" \
  0 "$repo" HEAD

# POSITIVE CONTROL: the same tree, merged against the main that moved.
expect_exit "stale-base: merged against moved main is RED" \
  1 "$repo" main \
  "MIGRATION LEAF COLLISION" "demoapp" "0002_foo" "0002_bar" \
  "makemigrations --merge"

# --- case 4: a merge migration resolves the fork -----------------------------
# `makemigrations --merge` output must be ACCEPTED. Same fork as case 3, plus a
# migration depending on both sides -- one leaf again.

new_repo merge-migration-resolves
grepo "$repo" checkout -q -b feature
write_migration "$repo" "0002_foo" '("demoapp", "0001_initial")' ""
write_migration "$repo" "0003_merge" \
  '("demoapp", "0002_foo"), ("demoapp", "0002_bar")' ""
commit "$repo" "our migration plus the merge migration"
grepo "$repo" checkout -q main
write_migration "$repo" "0002_bar" '("demoapp", "0001_initial")' ""
commit "$repo" "somebody else's migration"
grepo "$repo" checkout -q feature
expect_exit "merge-migration-resolves-the-fork" 0 "$repo" main

# --- case 5: a fork whose numbers DIFFER -------------------------------------
# main is at 0002_bar; the branch adds 0003_foo but depends on 0001_initial.
# Two leaves, different numeric prefixes. A filename-based check sees "0002"
# and "0003", calls it a clean linear history, and ships a broken deploy.

new_repo fork-with-different-numbers
grepo "$repo" checkout -q -b feature
write_migration "$repo" "0003_foo" '("demoapp", "0001_initial")' ""
commit "$repo" "branch migration numbered ahead but chained behind"
grepo "$repo" checkout -q main
write_migration "$repo" "0002_bar" '("demoapp", "0001_initial")' ""
commit "$repo" "main migration"
grepo "$repo" checkout -q feature
expect_exit "fork-with-different-numbers-is-RED" 1 "$repo" main \
  "0002_bar" "0003_foo"

# --- case 6: run_before linearises a duplicate number ------------------------
# Both sides are called 0002. `run_before` makes main's 0002_bar run after the
# branch's 0002_foo, so there is exactly one leaf and `migrate` is happy.
# A filename check would block this. Django's loader does not, and neither
# does the guard.

new_repo run-before-resolves
grepo "$repo" checkout -q -b feature
write_migration "$repo" "0002_foo" '("demoapp", "0001_initial")' \
  '("demoapp", "0002_bar")'
commit "$repo" "branch migration that declares it runs first"
grepo "$repo" checkout -q main
write_migration "$repo" "0002_bar" '("demoapp", "0001_initial")' ""
commit "$repo" "main migration"
grepo "$repo" checkout -q feature
expect_exit "run-before-resolves-duplicate-number" 0 "$repo" main

# --- case 7: fail closed on an unresolvable base -----------------------------
# Exit 2, never 0. A guard that cannot see the base must not report success.

new_repo unresolvable-base
expect_exit "unresolvable-base-fails-closed" 2 "$repo" "origin/does-not-exist" \
  "CANNOT RUN"

# --- case 8: a fork committed entirely within the branch ---------------------
# Not a stale-base problem -- somebody committed two children of the same
# parent in one PR. Must be red even with no overlay at all.

new_repo fork-within-branch
grepo "$repo" checkout -q -b feature
write_migration "$repo" "0002_a" '("demoapp", "0001_initial")' ""
write_migration "$repo" "0002_b" '("demoapp", "0001_initial")' ""
commit "$repo" "two children of 0001 in one branch"
expect_exit "fork-within-branch-is-RED-with-no-overlay" 1 "$repo" HEAD \
  "0002_a" "0002_b"

# --- case 9: main's migration imports a helper this branch does not have -----
# Codex finding 3. Migrations in this repo import application code. Overlaying
# main's newest migration onto an older branch's `py/` can therefore raise
# ImportError even though the merged graph is fine -- after a real merge the
# helper is present too. The guard must swap the sides and still return the
# right answer, not paint the branch red for the wrong reason.

new_repo stale-code-vs-new-migration
grepo "$repo" checkout -q -b feature
write_migration "$repo" "0002_foo" '("demoapp", "0001_initial")' ""
commit "$repo" "branch migration"
grepo "$repo" checkout -q main
cat >"$repo/py/demoapp/helpers.py" <<'EOF'
def backfill(apps, schema_editor):
    pass
EOF
cat >"$repo/py/demoapp/migrations/0002_bar.py" <<'EOF'
from django.db import migrations

from demoapp.helpers import backfill


class Migration(migrations.Migration):
    dependencies = [("demoapp", "0001_initial")]
    run_before = []
    operations = [migrations.RunPython(backfill, migrations.RunPython.noop)]
EOF
commit "$repo" "main migration plus the helper it imports"
grepo "$repo" checkout -q feature
expect_exit "main-migration-importing-new-helper-still-detected" 1 "$repo" main \
  "0002_foo" "0002_bar" "retrying with the sides swapped"

# --- case 10: neither arrangement imports -> exit 2, never 0 -----------------
# Both sides added a migration importing a helper only that side has. No
# arrangement of the union imports, so the graph genuinely cannot be resolved.
# The guard must say so and fail closed rather than report success.

new_repo unresolvable-both-sides
grepo "$repo" checkout -q -b feature
cat >"$repo/py/demoapp/branch_helper.py" <<'EOF'
MARKER = 1
EOF
cat >"$repo/py/demoapp/migrations/0002_foo.py" <<'EOF'
from django.db import migrations

from demoapp.branch_helper import MARKER


class Migration(migrations.Migration):
    dependencies = [("demoapp", "0001_initial")]
    run_before = []
    operations = []
EOF
commit "$repo" "branch migration importing a branch-only helper"
grepo "$repo" checkout -q main
cat >"$repo/py/demoapp/main_helper.py" <<'EOF'
MARKER = 2
EOF
cat >"$repo/py/demoapp/migrations/0002_bar.py" <<'EOF'
from django.db import migrations

from demoapp.main_helper import MARKER


class Migration(migrations.Migration):
    dependencies = [("demoapp", "0001_initial")]
    run_before = []
    operations = []
EOF
commit "$repo" "main migration importing a main-only helper"
grepo "$repo" checkout -q feature
expect_exit "both-arrangements-fail-to-import-exits-2" 2 "$repo" main \
  "CANNOT RUN" "git rebase origin/main"

# --- case 11: the repair instructions keep cross-app dependencies ------------
# Codex finding 1. The printed `dependencies = [...]` must repoint ONLY the
# stale same-app edge and reproduce every other dependency verbatim. Telling an
# agent to overwrite the whole list would trade a detected collision for an
# undetected ordering bug -- which also stops the deploy, just later and with
# no guard watching.

new_repo repair-preserves-cross-app-dependency
grepo "$repo" checkout -q -b feature
write_migration "$repo" "0002_foo" \
  '("demoapp", "0001_initial"), ("contenttypes", "0002_remove_content_type_name")' ""
commit "$repo" "branch migration with a cross-app dependency"
grepo "$repo" checkout -q main
write_migration "$repo" "0002_bar" '("demoapp", "0001_initial")' ""
commit "$repo" "main migration"
grepo "$repo" checkout -q feature
expect_exit "repair-keeps-cross-app-dependency" 1 "$repo" main \
  'dependencies = [("demoapp", "0002_bar"), ("contenttypes", "0002_remove_content_type_name")]' \
  "do not drop them"

# --- case 12: a failed fetch is fatal, not a silent fallback -----------------
# The ONLY thing this guard has over the rest of the gate is a fresh base. If
# the fetch fails it must not quietly fall back to whatever `origin/main`
# happened to be hours ago. These fixtures have no remotes at all, so any
# fetch fails.

new_repo fetch-must-not-be-silently-skipped
run_guard_fetching() {
  GUARD_OUT="$("$PYTHON" "$GUARD" --repo-root "$1" --py-dir "$1/py" \
      --settings settings --base "$2" 2>&1)"
  return $?
}
run_guard_fetching "$repo" "origin/main"
actual=$?
if [[ "$actual" == 2 ]] && grep -qF "Refusing to fall back" <<<"$GUARD_OUT"; then
  echo "ok    failed-fetch-fails-closed (exit 2)"
  PASS=$((PASS + 1))
else
  echo "FAIL  failed-fetch-fails-closed: exit $actual"
  echo "$GUARD_OUT"
  FAIL=$((FAIL + 1))
fi

# --- case 13: missing Django is an environment problem, not stale history ----
# The configured interpreter cannot import Django even with repository code and
# Python path environment variables excluded. Nothing about either migration
# arrangement can repair that, and no rebase advice is warranted.

new_repo django-unimportable-is-environment-not-branch
fake_python="$WORK/fake-python-without-django"
cat >"$fake_python" <<'EOF'
#!/bin/sh
echo "ModuleNotFoundError: No module named 'django'" >&2
exit 1
EOF
chmod +x "$fake_python"
GUARD_OUT="$("$PYTHON" "$GUARD" \
    --repo-root "$repo" --py-dir "$repo/py" \
    --settings settings --base main --no-fetch \
    --python "$fake_python" 2>&1)"
actual=$?
if [[ "$actual" == 2 ]] \
   && grep -qF "clean external context" <<<"$GUARD_OUT" \
   && grep -qF "environment problem" <<<"$GUARD_OUT" \
   && ! grep -qiF "rebase" <<<"$GUARD_OUT"; then
  echo "ok    django-unimportable-is-environment-not-branch (exit 2)"
  PASS=$((PASS + 1))
else
  echo "FAIL  django-unimportable-is-environment-not-branch: exit $actual"
  echo "$GUARD_OUT"
  FAIL=$((FAIL + 1))
fi

# --- case 14: branch-local Django shadow is a TREE failure, not environment --
# The clean isolated probe imports the real installed package. The branch tree
# then shadows it with py/free2z/django.py and raises before `import django` completes.
# A marker printed after that import cannot distinguish this from missing Django;
# the clean preflight can. The guard must still try base code + branch migration,
# which has one leaf and succeeds.

new_repo branch-django-shadow-is-not-an-environment-failure
grepo "$repo" checkout -q -b feature
cat >"$repo/py/django.py" <<'EOF'
raise RuntimeError("branch-local django shadow imported")
EOF
write_migration "$repo" "0002_feature" '("demoapp", "0001_initial")' ""
commit "$repo" "branch migration plus broken django shadow"

if ! "$PYTHON" -B -c 'import django' >/dev/null 2>&1; then
  echo "FAIL  branch-django-shadow negative control: real Django is unavailable"
  FAIL=$((FAIL + 1))
else
  expect_exit "branch-django-shadow-is-not-an-environment-failure" \
    0 "$repo" main "retrying with the sides swapped"
  if grep -qF "environment problem" <<<"$GUARD_OUT"; then
    echo "FAIL  branch-django-shadow was mislabeled as an environment problem"
    echo "$GUARD_OUT"
    FAIL=$((FAIL + 1))
  else
    echo "ok    branch-django-shadow was attributed to the code tree"
    PASS=$((PASS + 1))
  fi
fi

# --- case 15: the clean preflight is mechanically isolated from repo input ---
# Codex review finding 2: a fake interpreter that always fails proves only the
# diagnosis text. This control poisons inherited PYTHONPATH with a fake Django,
# then wraps the REAL interpreter and refuses the probe unless its cwd is empty
# and the repository-influenced environment has been removed. The later graph
# loader must still succeed, proving the wrapper did not merely refuse all runs.

new_repo django-preflight-excludes-repository-input
poison="$WORK/preflight-poison"
mkdir -p "$poison"
cat >"$poison/django.py" <<'EOF'
raise RuntimeError("inherited PYTHONPATH reached the clean Django preflight")
EOF
probe_python="$WORK/preflight-contract-python"
cat >"$probe_python" <<EOF
#!/bin/sh
is_probe=0
for arg in "\$@"; do
  if [ "\$arg" = "import django" ]; then is_probe=1; fi
done
if [ "\$is_probe" -eq 1 ]; then
  if [ -n "\${PYTHONPATH+x}" ] \
     || [ -n "\${DJANGO_SETTINGS_MODULE+x}" ] \
     || [ -n "\${PYTHONSTARTUP+x}" ]; then
    echo "preflight inherited repository-influenced Python environment" >&2
    exit 91
  fi
  if find "\$PWD" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    echo "preflight cwd is not an empty external directory: \$PWD" >&2
    exit 92
  fi
fi
exec "$PYTHON" "\$@"
EOF
chmod +x "$probe_python"
GUARD_OUT="$(PYTHONPATH="$poison" \
    DJANGO_SETTINGS_MODULE=poison.settings \
    PYTHONSTARTUP="$poison/startup.py" \
    "$PYTHON" "$GUARD" \
      --repo-root "$repo" --py-dir "$repo/py" \
      --settings settings --base main --no-fetch \
      --python "$probe_python" 2>&1)"
actual=$?
if [[ "$actual" == 0 ]] \
   && grep -qF "migration-leaves: OK" <<<"$GUARD_OUT"; then
  echo "ok    django-preflight-excludes-repository-input (exit 0)"
  PASS=$((PASS + 1))
else
  echo "FAIL  django-preflight-excludes-repository-input: exit $actual"
  echo "$GUARD_OUT"
  FAIL=$((FAIL + 1))
fi

# --- summary -----------------------------------------------------------------

echo
echo "migration-leaves self-test: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
