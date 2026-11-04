#!/usr/bin/env bash
# Free2Z application check: install ubuntu ci packages.
set -euo pipefail
playwright_deps=false
if [[ "${1:-}" == --playwright-deps ]]; then
  [[ $# == 3 && "$2" == /* && -x "$2" && "$3" == /* && -f "$3" ]] || {
    echo "usage: install-ubuntu-ci-packages.sh --playwright-deps ABSOLUTE_NODE ABSOLUTE_CLI" >&2
    exit 2
  }
  playwright_deps=true
  shift
fi
if (( $# == 0 )); then
  echo 'usage: install-ubuntu-ci-packages.sh PACKAGE...' >&2
  exit 2
fi
if ! "$playwright_deps"; then
for package in "$@"; do
  [[ "$package" =~ ^[a-z0-9][a-z0-9+.-]*$ ]] || {
    echo "invalid package name: $package" >&2
    exit 2
  }
done
fi
# Override is used only by the signed, local-repository regression harness.
source_file="${UBUNTU_APT_SOURCE_FILE:-/etc/apt/sources.list.d/ubuntu.sources}"
[[ -s "$source_file" ]] || {
  echo "missing Ubuntu deb822 sources: $source_file" >&2
  exit 1
}
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/sources" "$work/lists"
# Permit APT's unprivileged download user to traverse the temporary directory.
chmod 755 "$work" "$work/sources" "$work/lists"
# The runner's Azure mirror can stall before test execution. Use Ubuntu's
# fixed archives for known runner URI tokens, preserving suites, components,
# architectures and Signed-By verbatim. Local signed test sources are unchanged.
python3 - "$source_file" "$work/sources/ubuntu.sources" <<'PY'
from pathlib import Path
import re
import sys

archives = {
    'mirror+file:/etc/apt/apt-mirrors.txt': 'https://archive.ubuntu.com/ubuntu',
    'mirror+file:/etc/apt/apt-security-mirrors.txt': 'https://security.ubuntu.com/ubuntu',
    'http://azure.archive.ubuntu.com/ubuntu': 'https://archive.ubuntu.com/ubuntu',
    'https://azure.archive.ubuntu.com/ubuntu': 'https://archive.ubuntu.com/ubuntu',
    'http://archive.ubuntu.com/ubuntu': 'https://archive.ubuntu.com/ubuntu',
    'http://security.ubuntu.com/ubuntu': 'https://security.ubuntu.com/ubuntu',
}
lines = []
field = None
for line in Path(sys.argv[1]).read_text().splitlines(keepends=True):
    if not line.strip():
        field = None
    elif not line.startswith((' ', '\t', '#')):
        field = line.split(':', 1)[0].lower()
    if field == 'uris' and not line.lstrip().startswith('#'):
        line = re.sub(r'\S+', lambda match: archives.get(match[0].rstrip('/'), match[0]), line)
    lines.append(line)
Path(sys.argv[2]).write_text(''.join(lines))
PY
options=(
  -o "Dir::Etc::sourcelist=/dev/null"
  -o "Dir::Etc::sourceparts=$work/sources"
  -o "Dir::State::lists=$work/lists"
  -o "Dir::Cache::pkgcache=$work/pkgcache.bin"
  -o "Dir::Cache::srcpkgcache=$work/srcpkgcache.bin"
  -o "APT::Update::Error-Mode=any"
  -o "Acquire::http::Timeout=30"
  -o "Acquire::https::Timeout=30"
  -o "Acquire::Retries=2"
  -o "DPkg::Lock::Timeout=30"
)
run_bounded() {
  if timeout --signal=TERM --kill-after=15s 300s "$@"; then
    return 0
  else
    result=$?
    if [[ "$result" == 124 || "$result" == 137 ]]; then
      echo 'Ubuntu dependency setup exceeded its five-minute deadline' >&2
    fi
    return "$result"
  fi
}
apt_get="$(command -v apt-get)"
if "$playwright_deps"; then
  # Run this mode via sudo: the pinned local Playwright CLI then launches sh
  # directly, avoiding a second sudo that would discard our PATH. Only its
  # Ubuntu dependency install runs here; browser downloads remain runner-owned.
  # A child adapter injects the same CLI options as the direct package path,
  # without depending on APT_CONFIG precedence or rewriting global sources.
  mkdir "$work/bin"
  {
    printf '#!/usr/bin/env bash\nexec '
    printf '%q ' "$apt_get" "${options[@]}"
    printf '"$@"\n'
  } > "$work/bin/apt-get"
  chmod 755 "$work/bin/apt-get"
  run_bounded env PATH="$work/bin:$PATH" "$1" "$2" install-deps chromium
else
  run_bounded bash -e -c '
    apt_get="$1"; count="$2"; shift 2
    options=("${@:1:count}"); shift "$count"
    "$apt_get" "${options[@]}" update
    "$apt_get" "${options[@]}" install -y "$@"
  ' ubuntu-ci-packages "$apt_get" "${#options[@]}" "${options[@]}" "$@"
fi
