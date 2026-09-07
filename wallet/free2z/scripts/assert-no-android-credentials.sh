#!/usr/bin/env bash
# A canary, not a control.
#
# What actually keeps the free2z Android build credential-free is that its job
# declares no `environment:` and references no `secrets.*` expression, which is
# a property of .github/workflows/free2z-release.yml rather than of this file.
# This runs immediately before dependency installation and again after the
# build, so that if that property is ever quietly lost the build stops at a
# named variable instead of shipping a bundle that was signed on the same
# machine that fetched a thousand transitive dependencies.
set -euo pipefail

credential_variables=(
  ANDROID_KEYSTORE_BASE64
  ANDROID_KEYSTORE_PATH
  ANDROID_KEYSTORE_PASSWORD
  ANDROID_KEY_ALIAS
  ANDROID_KEY_PASSWORD
  PLAY_SERVICE_ACCOUNT_JSON_BASE64
  PLAY_SERVICE_ACCOUNT_JSON
  GOOGLE_APPLICATION_CREDENTIALS
  FREE2Z_CONFIRM_UPLOAD
)

for variable in "${credential_variables[@]}"; do
  if [[ -n "${!variable:-}" ]]; then
    echo "Android credential canary found forbidden variable: $variable" >&2
    exit 1
  fi
done

runner_temp=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
for pattern in \
  'free2z-android-sign.*' \
  'free2z-android-upload.*'; do
  if find "$runner_temp" -maxdepth 1 -name "$pattern" -print -quit | grep -q .; then
    echo "Android credential canary found forbidden temporary material: $pattern" >&2
    exit 1
  fi
done

echo "Android credential canary: no free2z signing or Play-upload authority is present."
