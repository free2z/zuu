#!/usr/bin/env bash
set -euo pipefail

readonly package_manifest=/usr/local/share/zuuli-linux-image/packages.txt

fail() {
  echo "ZUULI Linux image inventory check failed: $*" >&2
  exit 1
}

[[ -r "$package_manifest" ]] || fail "missing package manifest"

# This is the canonical OS identity supplied by Ubuntu.
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == ubuntu ]] || fail "expected Ubuntu, found ${ID:-unknown}"
[[ "${VERSION_ID:-}" == 24.04 ]] || fail "expected Ubuntu 24.04, found ${VERSION_ID:-unknown}"
[[ "$(uname -m)" == x86_64 ]] || fail "expected x86_64, found $(uname -m)"

while IFS= read -r package; do
  [[ -n "$package" ]] || continue
  status=$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null || true)
  [[ "$status" == "installed" ]] || fail "required package is not installed: $package"
done < "$package_manifest"

for module in \
  ayatana-appindicator3-0.1 \
  dbus-1 \
  gtk+-3.0 \
  javascriptcoregtk-4.1 \
  librsvg-2.0 \
  libsoup-3.0 \
  webkit2gtk-4.1; do
  pkg-config --exists "$module" || fail "pkg-config cannot resolve $module"
  printf '%s=%s\n' "$module" "$(pkg-config --modversion "$module")"
done

# Ubuntu's libxdo-dev package does not ship pkg-config metadata. Verify the
# development interface that xdotool-sys actually links against instead.
[[ -r /usr/include/xdo.h ]] || fail "libxdo development header is missing"
/usr/local/bin/verify-zuuli-libxdo || fail "libxdo shared library is missing"

for command in \
  desktop-file-validate \
  dpkg-deb \
  fakeroot \
  file \
  patchelf \
  readelf \
  rpm2archive \
  rpmbuild \
  tar \
  timeout \
  unsquashfs \
  xz \
  zsync; do
  command -v "$command" >/dev/null 2>&1 || fail "packaging command is missing: $command"
done

for forbidden in cargo rustc rustup; do
  if command -v "$forbidden" >/dev/null 2>&1; then
    fail "OS-dependency image must not contain $forbidden"
  fi
done

for forbidden_path in \
  /.cargo \
  /app/Cargo.toml \
  /github/workspace/Cargo.toml \
  /root/.cargo \
  /workspace/Cargo.toml; do
  [[ ! -e "$forbidden_path" ]] || fail "forbidden source/cache path exists: $forbidden_path"
done

if find /var/lib/apt/lists -mindepth 1 -print -quit | grep -q .; then
  fail "apt package indexes must not be retained in the runtime image"
fi
[[ ! -e /tmp/zuuli-linux-packages.txt ]] || fail "temporary package manifest was retained"

[[ "${APPIMAGE_EXTRACT_AND_RUN:-}" == 1 ]] || fail "APPIMAGE_EXTRACT_AND_RUN must be 1"

printf 'os=%s %s architecture=%s packages=%s\n' \
  "$ID" "$VERSION_ID" "$(uname -m)" "$(grep -cve '^$' "$package_manifest")"
