#!/usr/bin/env bash
# Free2Z application check: test check python requirements lock.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
source_file="$scratch/main.in"
lock_file="$scratch/main.txt"
dockerfile="$scratch/Dockerfile"
checker="$repo_root/scripts/free2z/check-python-requirements-lock.py"

cat >"$source_file" <<'REQ'
Foo_Pkg[extra]==1.2.3
bar==4.5
REQ
cat >"$dockerfile" <<'DOCKER'
FROM python:3.12-bookworm@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
DOCKER

write_lock() {
  cat >"$lock_file" <<'LOCK'
# Target image: python:3.12-bookworm@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (linux/amd64)
# pip-compile output
foo-pkg[extra]==1.2.3 \
    --hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
# via -r requirements/main.in
bar==4.5 \
    --hash=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
# via -r requirements/main.in
transitive==9.0 \
    --hash=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
# via bar
LOCK
}
replace_text() {
  python3 - "$1" "$2" "$3" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
old, new = sys.argv[2], sys.argv[3]
if text.count(old) != 1:
    raise SystemExit(f"expected one occurrence of {old!r} in {path}")
path.write_text(text.replace(old, new), encoding="utf-8")
PY
}
write_lock
"$checker" --source "$source_file" --lock "$lock_file" --dockerfile "$dockerfile"

# Dependabot uses the input's directory as its working directory. Both
# single-source and multiline annotations must preserve direct provenance.
python3 - "$lock_file" <<'PYTEST'
from pathlib import Path
import sys
p = Path(sys.argv[1])
p.write_text(p.read_text().replace("-r requirements/main.in", "-r main.in"))
PYTEST
"$checker" --source "$source_file" --lock "$lock_file" --dockerfile "$dockerfile"
python3 - "$lock_file" <<'PYTEST'
from pathlib import Path
import sys
p = Path(sys.argv[1])
p.write_text(p.read_text().replace("# via -r main.in", "# via\n#   -r main.in"))
PYTEST
"$checker" --source "$source_file" --lock "$lock_file" --dockerfile "$dockerfile"
python3 - "$lock_file" <<'PYTEST'
from pathlib import Path
import sys
p = Path(sys.argv[1])
p.write_text(p.read_text().replace("-r main.in", "-r unrelated.in"))
PYTEST
if "$checker" --source "$source_file" --lock "$lock_file" --dockerfile "$dockerfile" >"$scratch/provenance.out" 2>&1; then
  echo "unrelated source provenance unexpectedly passed" >&2
  exit 1
fi
grep -q 'missing direct provenance' "$scratch/provenance.out"
write_lock

replace_text "$lock_file" 'foo-pkg[extra]==1.2.3' 'foo-pkg[extra]==1.2.4'
if "$checker" --source "$source_file" --lock "$lock_file" --dockerfile "$dockerfile" >"$scratch/stale.out" 2>&1; then
  echo "stale direct pin unexpectedly passed" >&2
  exit 1
fi
grep -q 'does not match direct lock entry' "$scratch/stale.out"

write_lock
replace_text "$lock_file" 'foo-pkg[extra]==1.2.3' 'foo-pkg==1.2.3'
if "$checker" --source "$source_file" --lock "$lock_file" --dockerfile "$dockerfile" >"$scratch/extras.out" 2>&1; then
  echo "direct extras drift unexpectedly passed" >&2
  exit 1
fi
grep -q 'including extras and markers' "$scratch/extras.out"

write_lock
replace_text "$lock_file" '--hash=sha256:bbbb' '--hash=sha256:bad'
if "$checker" --source "$source_file" --lock "$lock_file" --dockerfile "$dockerfile" >"$scratch/hash.out" 2>&1; then
  echo "malformed hash unexpectedly passed" >&2
  exit 1
fi
grep -q 'invalid SHA-256 hash option' "$scratch/hash.out"

write_lock
replace_text "$lock_file" '--hash=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' ''
python3 - "$lock_file" <<'PY'
from pathlib import Path
import sys

p = Path(sys.argv[1])
s = p.read_text()
s = s.replace('bar==4.5 ' + chr(92) + '\n', 'bar==4.5\n')
p.write_text(s)
PY
if "$checker" --source "$source_file" --lock "$lock_file" --dockerfile "$dockerfile" >"$scratch/missing-hash.out" 2>&1; then
  echo "missing hash unexpectedly passed" >&2
  exit 1
fi
grep -q 'has no SHA-256 hash' "$scratch/missing-hash.out"

write_lock
replace_text "$dockerfile" \
  'python:3.12-bookworm@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  'python:3.12-bookworm@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
if "$checker" --source "$source_file" --lock "$lock_file" --dockerfile "$dockerfile" >"$scratch/image.out" 2>&1; then
  echo "lock compiled for a different image unexpectedly passed" >&2
  exit 1
fi
grep -q 'target image metadata does not match' "$scratch/image.out"

grep -Fq 'pip install --disable-pip-version-check --require-hashes -r /requirements.txt' \
  "$repo_root/build/free2z/backend.Dockerfile"
grep -Fq -- '--require-hashes' "$repo_root/scripts/free2z/run-dependency-audits.sh"
grep -Fq -- '--no-deps' "$repo_root/scripts/free2z/run-dependency-audits.sh"
grep -Fq 'python -m pip install --disable-pip-version-check --require-hashes -r requirements/main.txt' "$repo_root/.github/workflows/free2z-web-ci.yml"
grep -Fq 'check-python-requirements-installed.py' "$repo_root/.github/workflows/free2z-web-ci.yml"
grep -Fq 'python -m pip check' "$repo_root/.github/workflows/free2z-web-ci.yml"
grep -Fq '/py/free2z/requirements' "$repo_root/.github/dependabot.yml"
echo "Python requirements lock controls passed"
