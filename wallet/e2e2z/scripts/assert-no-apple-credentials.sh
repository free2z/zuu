#!/usr/bin/env bash
# A canary, not a control. See assert-no-android-credentials.sh for why.
#
# The profile-file check is written against whatever UUID
# `store-identity.json` records, because e2e2z has no profile yet: hardcoding a
# UUID that does not exist would be a check that can never fire. When the
# profile is issued and its UUID recorded, this starts proving the same thing
# ZUULI's canary proves — that the credential-free runner is not carrying a
# distribution profile someone left behind.
set -euo pipefail

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

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
)

for variable in "${credential_variables[@]}"; do
  if [[ -n "${!variable-}" ]]; then
    echo "Apple credential canary found forbidden variable: $variable" >&2
    exit 1
  fi
done

runner_temp=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
for pattern in \
  'e2e2z-ios-sign.*' \
  'e2e2z-ios-asc.*'; do
  if find "$runner_temp" -maxdepth 1 -name "$pattern" -print -quit | grep -q .; then
    echo "Apple credential canary found forbidden temporary material: $pattern" >&2
    exit 1
  fi
done

profile_uuid=$(jq -r '.apple.provisioningProfileUuid // empty' "$script_dir/../store-identity.json")
if [[ -n "$profile_uuid" ]] &&
  [[ -d "${HOME}/Library/MobileDevice/Provisioning Profiles" ]] &&
  find "${HOME}/Library/MobileDevice/Provisioning Profiles" -maxdepth 1 \
    -name "$profile_uuid.mobileprovision" -print -quit | grep -q .; then
  echo "Apple credential canary found the e2e2z provisioning profile" >&2
  exit 1
fi

if command -v security >/dev/null 2>&1; then
  identities=$(security find-identity -v -p codesigning 2>/dev/null || true)
  if grep -Fq 'F9AV5HKF6N' <<<"$identities"; then
    echo "Apple credential canary found a Corpora signing identity" >&2
    exit 1
  fi
fi

echo "Apple credential canary: no e2e2z signing or store-upload authority is present."
