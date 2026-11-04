#!/usr/bin/env bash
# Free2Z application check: test check python requirements installed.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
lock_file="$scratch/main.txt"
installed_file="$scratch/installed.json"
checker="$repo_root/scripts/free2z/check-python-requirements-installed.py"
cat >"$lock_file" <<'LOCK'
# Target image: fixture
foo-pkg[extra]==1.2.3 ; python_version >= "3.0" \
    --hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
inactive-marker==4.0 ; python_version < "3.0" \
    --hash=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
LOCK

cat >"$installed_file" <<'JSON'
[
  {"name": "foo_pkg", "version": "1.2.3", "editable": false}
]
JSON
"$checker" --lock "$lock_file" --installed-json "$installed_file"

cat >"$installed_file" <<'JSON'
[
  {"name": "foo-pkg", "version": "1.2.4", "editable": false}
]
JSON
if "$checker" --lock "$lock_file" --installed-json "$installed_file" >"$scratch/version.out" 2>&1; then
  echo "replaced production pin unexpectedly passed" >&2
  exit 1
fi
grep -q 'production lock requires 1.2.3' "$scratch/version.out"

cat >"$installed_file" <<'JSON'
[]
JSON
if "$checker" --lock "$lock_file" --installed-json "$installed_file" >"$scratch/missing.out" 2>&1; then
  echo "missing production package unexpectedly passed" >&2
  exit 1
fi
grep -q 'is missing from the installed environment' "$scratch/missing.out"

cat >"$installed_file" <<'JSON'
[
  {"name": "foo-pkg", "version": "1.2.3", "editable": false},
  {"name": "foo_pkg", "version": "1.2.3", "editable": false}
]
JSON
if "$checker" --lock "$lock_file" --installed-json "$installed_file" >"$scratch/duplicate.out" 2>&1; then
  echo "duplicate installed metadata unexpectedly passed" >&2
  exit 1
fi
grep -q 'duplicate installed distribution metadata' "$scratch/duplicate.out"

cat >"$installed_file" <<'JSON'
[
  {"name": "foo-pkg", "version": "1.2.3", "editable": true}
]
JSON
if "$checker" --lock "$lock_file" --installed-json "$installed_file" >"$scratch/editable.out" 2>&1; then
  echo "editable production distribution unexpectedly passed" >&2
  exit 1
fi
grep -q 'installed as an editable distribution' "$scratch/editable.out"

echo "Installed production requirements controls passed"
