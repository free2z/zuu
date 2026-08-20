#!/usr/bin/env bash
set -euo pipefail

# This canary runs immediately before dependency installation and again after
# the unsigned Apple build. The workflow boundary checker separately proves
# that no protected environment or secret expression exists in either job.
credential_variables=(
  APPLE_API_ISSUER
  APPLE_API_KEY
  APPLE_API_KEY_PATH
  ASC_ISSUER_ID
  ASC_KEY_BASE64
  ASC_KEY_ID
  CERTIFICATE_BASE64
  CERTIFICATE_PASSWORD
  IOS_CERTIFICATE
  IOS_CERTIFICATE_PASSWORD
  IOS_MOBILE_PROVISION
  PROVISIONING_PROFILE_BASE64
  ZUULI_PREFLIGHT_KEYCHAIN
)

for variable in "${credential_variables[@]}"; do
  if [[ -n "${!variable-}" ]]; then
    echo "Apple credential canary found forbidden variable: $variable" >&2
    exit 1
  fi
done

runner_temp=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
for pattern in \
  'zuuli-ios-sign.*' \
  'zuuli-ios-upload.*' \
  'zuuli-macos-app-sign.*' \
  'zuuli-macos-app-notary.*' \
  'zuuli-macos-dmg-sign.*' \
  'zuuli-macos-dmg-notary.*'; do
  if find "$runner_temp" -maxdepth 1 -name "$pattern" -print -quit | grep -q .; then
    echo "Apple credential canary found forbidden temporary material: $pattern" >&2
    exit 1
  fi
done

if [[ -d "${HOME}/Library/MobileDevice/Provisioning Profiles" ]] &&
  find "${HOME}/Library/MobileDevice/Provisioning Profiles" -maxdepth 1 \
    -name 'e5ead62c-83ec-4e54-abb6-4770833b5e0d.mobileprovision' -print -quit | grep -q .; then
  echo "Apple credential canary found the ZUULI provisioning profile" >&2
  exit 1
fi

if command -v security >/dev/null 2>&1; then
  identities=$(security find-identity -v -p codesigning 2>/dev/null || true)
  if grep -Fq 'F9AV5HKF6N' <<<"$identities"; then
    echo "Apple credential canary found a Corpora signing identity" >&2
    exit 1
  fi
fi

echo "Apple credential canary: no ZUULI signing or store-upload authority is present."
