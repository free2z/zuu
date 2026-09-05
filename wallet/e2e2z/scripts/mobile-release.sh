#!/usr/bin/env bash
# Build, sign and optionally publish the e2e2z Android bundle from a workstation.
#
# This is the operator path. The workflow in .github/workflows/e2e2z-release.yml
# is the one that actually ships, and it splits the build from the signing across
# two machines; this script does both at once, which is why it insists on so much
# before it will touch a keystore:
#
#   * a clean worktree, so the bundle corresponds to a commit;
#   * a store identity that says Play knows about this package at all;
#   * an upload certificate whose SHA-256 matches the fingerprint recorded in
#     source, checked *before* jarsigner runs, so a swapped keystore is a stopped
#     build rather than a bundle Play will reject after upload;
#   * every credential present, or nothing happens.
#
# Nothing here echoes secret material. Passwords reach keytool and jarsigner
# through `-storepass:env` / `-keypass:env`, never on a command line, and the
# keystore path is canonicalized and required to be a regular file.
#
# Mirrors wallet/zuuli/scripts/mobile-release.sh. The one structural addition is
# the store-identity preflight: ZUULI can assume its Play listing exists.
set -euo pipefail
umask 077

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
app_dir=$(CDPATH='' cd -- "$script_dir/.." && pwd)
cd "$app_dir"

usage() {
  echo "usage: scripts/mobile-release.sh android [--upload]" >&2
  exit 64
}

platform=${1:-}
mode=${2:-}
[[ $# -le 2 ]] || usage
[[ "$platform" == android ]] || usage
[[ -z "$mode" || "$mode" == --upload ]] || usage

# Before anything expensive, and before any credential is read: does the store
# record this would upload to exist? If not, say so in full and stop.
node scripts/store-identity.mjs --require=android >/dev/null

identity_args=(--require-main)
if [[ -n "${E2E2Z_RELEASE_SOURCE_SHA:-}" ]]; then
  identity_args+=("--source-sha=$E2E2Z_RELEASE_SOURCE_SHA")
fi
identity_json=$(node scripts/release-identity.mjs "${identity_args[@]}")
identity=$(jq -r .identity <<<"$identity_json")
application_id=$(jq -r .applicationId <<<"$identity_json")
expected_upload_fingerprint=$(jq -er .google.uploadCertificateSha256 store-identity.json)

if [[ "$mode" == --upload ]]; then
  if [[ ! "${E2E2Z_RELEASE_SOURCE_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "refusing store upload: E2E2Z_RELEASE_SOURCE_SHA must be the exact full source SHA" >&2
    exit 65
  fi
  if [[ "${E2E2Z_CONFIRM_UPLOAD:-}" != "$identity" ]]; then
    echo "refusing store upload: set E2E2Z_CONFIRM_UPLOAD=$identity" >&2
    exit 65
  fi
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "refusing release from a dirty worktree" >&2
  exit 65
fi

require_value() {
  local name=$1
  if [[ -z "${!name:-}" ]]; then
    echo "missing required environment variable: $name" >&2
    exit 66
  fi
}

require_secret_file() {
  local name=$1
  require_value "$name"
  local path=${!name}
  if [[ ! -f "$path" || -L "$path" ]]; then
    echo "$name must name a regular, non-symlink file" >&2
    exit 66
  fi
}

canonical_secret_file() {
  local name=$1 path parent
  require_secret_file "$name"
  path=${!name}
  parent=$(CDPATH='' cd -P -- "$(dirname -- "$path")" && pwd)
  printf '%s/%s\n' "$parent" "$(basename -- "$path")"
}

find_one() {
  local pattern=$1
  local -a matches=()
  while IFS= read -r -d '' path; do matches+=("$path"); done < <(find . -type f -path "$pattern" -print0)
  if [[ ${#matches[@]} -ne 1 ]]; then
    echo "expected exactly one artifact matching $pattern, found ${#matches[@]}" >&2
    exit 70
  fi
  printf '%s\n' "${matches[0]}"
}

mkdir -p release-artifacts

# shellcheck source=android-toolchain-env.sh
source "$script_dir/android-toolchain-env.sh"
ANDROID_KEYSTORE_PATH=$(canonical_secret_file ANDROID_KEYSTORE_PATH)
export ANDROID_KEYSTORE_PATH
require_value ANDROID_KEYSTORE_PASSWORD
require_value ANDROID_KEY_ALIAS
require_value ANDROID_KEY_PASSWORD
ANDROID_UPLOAD_CERT_SHA256=${ANDROID_UPLOAD_CERT_SHA256:-$expected_upload_fingerprint}
if [[ "$ANDROID_UPLOAD_CERT_SHA256" != "$expected_upload_fingerprint" ]]; then
  echo "ANDROID_UPLOAD_CERT_SHA256 disagrees with the fingerprint recorded in store-identity.json" >&2
  exit 66
fi
if [[ ! "$ANDROID_UPLOAD_CERT_SHA256" =~ ^([0-9A-F]{2}:){31}[0-9A-F]{2}$ ]]; then
  echo "ANDROID_UPLOAD_CERT_SHA256 must be an uppercase colon-delimited SHA-256 fingerprint" >&2
  exit 66
fi
actual_upload_fingerprint=$(keytool -list -v \
  -keystore "$ANDROID_KEYSTORE_PATH" \
  -storepass:env ANDROID_KEYSTORE_PASSWORD \
  -alias "$ANDROID_KEY_ALIAS" | awk -F'SHA256: ' '/SHA256: / {print $2; exit}')
if [[ "$actual_upload_fingerprint" != "$ANDROID_UPLOAD_CERT_SHA256" ]]; then
  echo "Android upload certificate fingerprint does not match the protected release identity" >&2
  exit 66
fi
unset actual_upload_fingerprint

if [[ "$mode" == --upload ]]; then
  PLAY_SERVICE_ACCOUNT_JSON=$(canonical_secret_file PLAY_SERVICE_ACCOUNT_JSON)
  export PLAY_SERVICE_ACCOUNT_JSON
  if ! jq -e '
    .type == "service_account" and
    (.project_id | type == "string" and length > 0) and
    (.client_email | type == "string" and endswith(".iam.gserviceaccount.com")) and
    .token_uri == "https://oauth2.googleapis.com/token" and
    (.private_key_id | type == "string" and length > 0) and
    (.private_key | type == "string" and startswith("-----BEGIN PRIVATE KEY-----"))
  ' "$PLAY_SERVICE_ACCOUNT_JSON" >/dev/null; then
    echo "PLAY_SERVICE_ACCOUNT_JSON is not a usable Google service-account key" >&2
    exit 66
  fi
fi

./node_modules/.bin/tauri android build --ci --aab -- --locked
node scripts/normalize-generated-android-manifest.mjs
git diff --exit-code
aab=$(find_one './src-tauri/gen/android/app/build/outputs/bundle/universalRelease/*.aab')
# Android upload-key certificates are intentionally self-signed, which makes
# jarsigner --strict return 4 even when the archive signature is valid.
if ! signature_report=$(jarsigner -verify -certs "$aab" 2>&1) ||
  ! grep -Fq "jar verified." <<<"$signature_report" ||
  grep -Fqi "unsigned" <<<"$signature_report"; then
  echo "Android bundle signature verification failed" >&2
  exit 70
fi
unset signature_report
cp "$aab" "release-artifacts/e2e2z-${identity}-android.aab"

if [[ "$mode" == --upload ]]; then
  FASTLANE_SKIP_UPDATE_CHECK=1 bundle exec fastlane supply \
    --package_name "$application_id" \
    --aab "$aab" \
    --json_key "$PLAY_SERVICE_ACCOUNT_JSON" \
    --track internal \
    --release_status completed \
    --skip_upload_apk true \
    --skip_upload_metadata true \
    --skip_upload_images true \
    --skip_upload_screenshots true
fi

echo "e2e2z $identity Android release validation completed ($([[ "$mode" == --upload ]] && echo uploaded || echo dry-run))."
