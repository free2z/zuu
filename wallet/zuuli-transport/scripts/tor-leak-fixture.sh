#!/usr/bin/env bash
# Local-only network + mount namespace; never changes the host resolver.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$root"
binary=$(cargo test --locked --manifest-path wallet/zuuli-transport/Cargo.toml --test native_policy --no-run --message-format=json "$@" | python3 -c 'import json,sys; print(next(x["executable"] for line in sys.stdin if (x:=json.loads(line)).get("executable")))')
resolver=$(mktemp)
trap 'rm -f "$resolver"' EXIT
printf 'nameserver 127.0.0.1\noptions timeout:1 attempts:1\n' > "$resolver"
sudo -n unshare --mount --net bash -c '
  set -euo pipefail
  mount --make-rprivate /
  ip link set lo up
  mount --bind "$1" /etc/resolv.conf
  ZUULI_ISOLATED_DNS_FIXTURE=1 "$2" isolated_live_dns_negative_control --ignored --nocapture
' _ "$resolver" "$binary"
