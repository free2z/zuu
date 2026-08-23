#!/usr/bin/env bash
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
  ZUULI_CONFIRM_UPLOAD
)

for variable in "${credential_variables[@]}"; do
  if [[ -n "${!variable:-}" ]]; then
    echo "Android credential canary found forbidden variable: $variable" >&2
    exit 1
  fi
done

for pattern in \
  "$RUNNER_TEMP/zuuli-android-sign."* \
  "$RUNNER_TEMP/zuuli-android-upload."*; do
  if compgen -G "$pattern" >/dev/null; then
    echo "Android credential canary found forbidden temporary material: $pattern" >&2
    exit 1
  fi
done

echo "Android credential canary: no ZUULI signing or Play-upload authority is present."
