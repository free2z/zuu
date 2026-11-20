#!/usr/bin/env bash
# Runs the actual shipping Tauri factory on Linux WebKitGTK, with live local
# DNS/TCP counters. No host resolver changes or external network are possible.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$root"
cargo build --locked --manifest-path wallet/zuuli/src-tauri/Cargo.toml --example navigation_probe "$@"
resolver=$(mktemp)
trap 'python3 -c "import os,sys; os.unlink(sys.argv[1])" "$resolver"' EXIT
printf 'nameserver 127.0.0.1\noptions timeout:1 attempts:1\n' > "$resolver"
sudo -n unshare --mount --net bash -c '
  set -euo pipefail
  mount --make-rprivate /
  ip link set lo up
  # WebKit/GIO suppresses networking when a namespace has no default route.
  # A dummy documentation-range interface makes the negative control live;
  # it has no peer or physical uplink and cannot reach external services.
  ip link add fixture0 type dummy
  ip addr add 192.0.2.1/24 dev fixture0
  ip link set fixture0 up
  ip route add default dev fixture0
  export GIO_USE_NETWORK_MONITOR=base
  mount --bind "$1" /etc/resolv.conf
  export ZUULI_NAVIGATION_FIXTURE_NAMESPACE=1
  # Root fixture only, no remote content or wallet state. Not a shipping flag.
  export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
  export WEBKIT_DISABLE_COMPOSITING_MODE=1 LIBGL_ALWAYS_SOFTWARE=1
  unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
  for case in assign anchor popup blank-popup redirect form; do
    dbus-run-session -- xvfb-run -a "$2" protected "$case"
  done
  dbus-run-session -- xvfb-run -a "$2" control assign
  dbus-run-session -- xvfb-run -a "$2" control redirect
' _ "$resolver" "$root/wallet/zuuli/src-tauri/target/debug/examples/navigation_probe"
