#!/usr/bin/env bash
# Free2Z application check: test ruff lint.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
scratch="$(mktemp -d)"
# Fixture inside the repo, needed because per-file-ignores paths and config
# discovery are both relative to ruff.toml's directory. Removed on every exit
# path, including failure, so a red control never leaves the tree dirty.
control_file="$repo_root/py/free2z/dj/apps/_ruff_positive_control_$$.py"
trap 'rm -rf "$scratch" "$control_file"' EXIT

if ! command -v ruff >/dev/null 2>&1; then
  echo "ruff is not installed. Install the pinned version, e.g." >&2
  echo "  python -m pip install 'ruff==\${RUFF_VERSION}'" >&2
  exit 1
fi

installed="$(ruff --version | awk '{print $2}')"
if [ -n "${RUFF_VERSION:-}" ] && [ "$installed" != "$RUFF_VERSION" ]; then
  echo "ruff version mismatch: pinned $RUFF_VERSION, installed $installed" >&2
  exit 1
fi
echo "ruff $installed"

expect_exit() {
  local expected=$1 label=$2
  shift 2
  set +e
  "$@" >"$scratch/$label.out" 2>&1
  local actual=$?
  set -e
  if [ "$actual" -ne "$expected" ]; then
    echo "$label: expected exit $expected, got $actual" >&2
    sed -n '1,80p' "$scratch/$label.out" >&2
    exit 1
  fi
}

# --- 2. The job is looking at the codebase, not at nothing -----------------
# The classic failure: a path typo or an over-broad exclude leaves ruff with an
# empty file set, it exits 0, and the gate is green forever.
ruff check --no-cache --show-files "$repo_root/py/free2z" "$repo_root/scripts/free2z" >"$scratch/files.txt"
file_count=$(wc -l <"$scratch/files.txt" | tr -d ' ')
if [ "$file_count" -lt 400 ]; then
  echo "ruff would check only $file_count files; expected the whole backend (400+)." >&2
  exit 1
fi
for must_cover in \
  "py/free2z/dj/free2z/settings.py" \
  "py/free2z/dj/apps/g12f/models/zpage.py" \
  "scripts/free2z/check-migration-leaves.py"; do
  if ! grep -qF "$must_cover" "$scratch/files.txt"; then
    echo "ruff is not covering $must_cover" >&2
    exit 1
  fi
done
echo "coverage control: $file_count files in scope"

# --- 3. The committed baseline holds ---------------------------------------
expect_exit 0 baseline-clean ruff check --no-cache "$repo_root/py/free2z" "$repo_root/scripts/free2z"

# --- 4. A new file with an undefined name goes red -------------------------
# F821 in a branch pytest never takes is the exact production failure this gate
# exists to stop.
cat >"$control_file" <<'PY'
def handler(exc):
    try:
        return {"ok": True}
    except Exception:
        # `loggr` does not exist. No test takes this branch; production does.
        loggr.error("boom")
PY
expect_exit 1 new-file-f821 ruff check --no-cache "$control_file"
grep -q 'F821' "$scratch/new-file-f821.out"
# ...and it fails through the repo-wide invocation the CI job actually runs,
# not only when the file is named directly.
expect_exit 1 repo-wide-f821 ruff check --no-cache "$repo_root/py/free2z" "$repo_root/scripts/free2z"
grep -q 'F821' "$scratch/repo-wide-f821.out"
rm -f "$control_file"
expect_exit 0 control-removed ruff check --no-cache "$repo_root/py/free2z" "$repo_root/scripts/free2z"

# --- 5. Private helper redefinitions are not dummy variables ---------------
# Ruff's default dummy-variable-rgx treats every underscore-prefixed name as a
# throwaway and silently suppresses F811. This fixture is deliberately inside
# the repository so both direct and repo-wide invocations discover ruff.toml;
# it tests the behavior of the lint configuration rather than restating one of
# its values.
cat >"$control_file" <<'PY'
def _model_name():
    return "first"


def _model_name():
    return "second"
PY
expect_exit 1 underscore-f811 ruff check --no-cache "$control_file"
grep -q 'F811' "$scratch/underscore-f811.out"
expect_exit 1 repo-wide-underscore-f811 ruff check --no-cache "$repo_root/py/free2z" "$repo_root/scripts/free2z"
grep -q 'F811' "$scratch/repo-wide-underscore-f811.out"

# Keep the same module-level shape while removing only the duplicate. This is
# the positive control: the guard must distinguish a real redefinition from
# ordinary private helpers.
cat >"$control_file" <<'PY'
def _model_name():
    return "first"


def _other_model_name():
    return "second"
PY
expect_exit 0 underscore-no-f811 ruff check --no-cache "$control_file"
expect_exit 0 repo-wide-underscore-no-f811 ruff check --no-cache "$repo_root/py/free2z" "$repo_root/scripts/free2z"
rm -f "$control_file"

cat >"$control_file" <<'PY'
import datetime


def stamp():
    return datetime.datetime.now(), datetime.datetime.utcnow()
PY
expect_exit 1 naive-datetime-dtz ruff check --no-cache "$control_file"
grep -q 'DTZ005' "$scratch/naive-datetime-dtz.out"
grep -q 'DTZ003' "$scratch/naive-datetime-dtz.out"
cat >"$control_file" <<'PY'
import datetime


def stamp():
    return datetime.datetime.now(tz=datetime.UTC)
PY
expect_exit 0 aware-datetime-dtz ruff check --no-cache "$control_file"
rm -f "$control_file"

# --- 6. A baselined file is still linted for everything else ---------------
# Isolated fixture: proves per-file-ignores suppresses only the listed code.
# Done out-of-tree so the assertion never depends on which files happen to be
# in the baseline today.
mkdir -p "$scratch/fixture"
cat >"$scratch/fixture/ruff.toml" <<'TOML'
target-version = "py312"
[lint]
select = ["F", "E9"]
[lint.per-file-ignores]
"legacy.py" = ["F401"]
TOML
cat >"$scratch/fixture/legacy.py" <<'PY'
import os


def go():
    return undefined_thing
PY
expect_exit 1 baselined-file-still-linted ruff check --no-cache "$scratch/fixture"
grep -q 'F821' "$scratch/baselined-file-still-linted.out"
if grep -q 'F401' "$scratch/baselined-file-still-linted.out"; then
  echo "per-file-ignores did not suppress the baselined code" >&2
  exit 1
fi

echo "python lint positive controls passed"
