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
cp "$source_file" "$work/sources/ubuntu.sources"
options=(
  -o "Dir::Etc::sourcelist=/dev/null"
  -o "Dir::Etc::sourceparts=$work/sources"
  -o "Dir::State::lists=$work/lists"
  -o "Dir::Cache::pkgcache=$work/pkgcache.bin"
  -o "Dir::Cache::srcpkgcache=$work/srcpkgcache.bin"
  -o "APT::Update::Error-Mode=any"
)
if "$playwright_deps"; then
  # Run this mode via sudo: the pinned local Playwright CLI then launches sh
  # directly, avoiding a second sudo that would discard our PATH. Only its
  # Ubuntu dependency install runs here; browser downloads remain runner-owned.
  # A child adapter injects the same CLI options as the direct package path,
  # without depending on APT_CONFIG precedence or rewriting global sources.
  apt_get="$(command -v apt-get)"
  mkdir "$work/bin"
  {
    printf '#!/usr/bin/env bash\nexec '
    printf '%q ' "$apt_get" "${options[@]}"
    printf '"$@"\n'
  } > "$work/bin/apt-get"
  chmod 755 "$work/bin/apt-get"
  PATH="$work/bin:$PATH" "$1" "$2" install-deps chromium
else
  apt-get "${options[@]}" update
  apt-get "${options[@]}" install -y "$@"
fi
