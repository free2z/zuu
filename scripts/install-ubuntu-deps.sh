#!/usr/bin/env bash
# Install distribution packages without consulting unrelated runner repositories.
# Keep the runner's complete Ubuntu definition (including security and Signed-By).
# UBUNTU_APT_SOURCE_FILE is only an input override for isolated fixture tests.
set -euo pipefail

if (( EUID != 0 )); then
  echo 'Run this installer with sudo.' >&2
  exit 2
fi
if (( $# == 0 )); then
  echo 'At least one Ubuntu package is required.' >&2
  exit 2
fi
for package in "$@"; do
  if [[ -z "$package" || "$package" == -* ]]; then
    echo 'Package arguments must not be apt options.' >&2
    exit 2
  fi
done

source_file=${UBUNTU_APT_SOURCE_FILE:-/etc/apt/sources.list.d/ubuntu.sources}
if [[ ! -s "$source_file" ]]; then
  echo "Missing or empty Ubuntu source definition: $source_file" >&2
  exit 2
fi

apt_workspace=$(mktemp -d /tmp/ubuntu-apt.XXXXXXXX)
trap 'rm -rf -- "$apt_workspace"' EXIT
mkdir "$apt_workspace/sources" "$apt_workspace/lists"
# The _apt sandbox user must be able to traverse the private index location.
chmod 755 "$apt_workspace" "$apt_workspace/sources" "$apt_workspace/lists"
cp -- "$source_file" "$apt_workspace/sources/ubuntu.sources"
chmod 644 "$apt_workspace/sources/ubuntu.sources"

apt_options=(
  -o Dir::Etc::sourcelist=/dev/null
  -o "Dir::Etc::sourceparts=$apt_workspace/sources"
  -o "Dir::State::lists=$apt_workspace/lists"
  -o "Dir::Cache::pkgcache=$apt_workspace/packages.bin"
  -o "Dir::Cache::srcpkgcache=$apt_workspace/source-packages.bin"
  -o APT::Update::Error-Mode=any
)
apt-get "${apt_options[@]}" update
apt-get "${apt_options[@]}" install -y "$@"
