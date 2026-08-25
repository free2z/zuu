#!/usr/bin/env bash
set -euo pipefail

[[ "$(uname -m)" == "x86_64" ]]
[[ "$(rustc +1.97.1 --version)" == rustc\ 1.97.1\ * ]]
[[ "$(cargo +1.97.1 --version)" == cargo\ 1.97.1\ * ]]
rustup target list --installed --toolchain 1.97.1 \
  | grep -Fqx -- "wasm32-unknown-unknown"
node --version
npm --version

browser_count="$({ find /ms-playwright -type f \
  \( -path '*/chromium-*/*/chrome' -o -path '*/chromium-*/*/headless_shell' \) \
  -perm -0111 -print 2>/dev/null || true; } | awk 'NF { count += 1 } END { print count + 0 }')"
if (( browser_count < 1 )); then
  echo "pinned Playwright Chromium executable is unavailable" >&2
  exit 1
fi

printf 'ZUULI store-capture image inventory verified (%s Chromium executable(s)).\n' "$browser_count"
