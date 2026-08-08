#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
cd "$app_dir"

usage() {
  echo "usage: scripts/mobile-release.sh <ios|android> [--upload]" >&2
  exit 64
}

platform=${1:-}
mode=${2:-}
[[ $# -le 2 ]] || usage
[[ "$platform" == ios || "$platform" == android ]] || usage
[[ -z "$mode" || "$mode" == --upload ]] || usage

identity_args=(--require-main)
if [[ -n "${ZUULI_RELEASE_SOURCE_SHA:-}" ]]; then
  identity_args+=("--source-sha=$ZUULI_RELEASE_SOURCE_SHA")
fi
identity_json=$(node scripts/release-identity.mjs "${identity_args[@]}")
identity=$(jq -r .identity <<<"$identity_json")
build=$(jq -r .build <<<"$identity_json")
application_id=$(jq -r .applicationId <<<"$identity_json")

if [[ "$mode" == --upload ]]; then
  if [[ ! "${ZUULI_RELEASE_SOURCE_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "refusing store upload: ZUULI_RELEASE_SOURCE_SHA must be the exact full source SHA" >&2
    exit 65
  fi
  if [[ "${ZUULI_CONFIRM_UPLOAD:-}" != "$identity" ]]; then
    echo "refusing store upload: set ZUULI_CONFIRM_UPLOAD=$identity" >&2
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
  parent=$(CDPATH= cd -P -- "$(dirname -- "$path")" && pwd)
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

if [[ "$platform" == ios ]]; then
  require_value APPLE_TEAM_ID
  if [[ "$APPLE_TEAM_ID" != "F9AV5HKF6N" ]]; then
    echo "APPLE_TEAM_ID must be the configured Corpora team F9AV5HKF6N" >&2
    exit 66
  fi
  require_value ASC_KEY_ID
  require_value ASC_ISSUER_ID
  require_value IOS_CERTIFICATE
  require_value IOS_CERTIFICATE_PASSWORD
  require_value IOS_MOBILE_PROVISION
  ASC_KEY_PATH=$(canonical_secret_file ASC_KEY_PATH)

  key_dir=$(mktemp -d "${TMPDIR:-/tmp}/zuuli-asc.XXXXXX")
  cleanup_apple_key() {
    find "$key_dir" -type f -exec rm -f -- {} + 2>/dev/null || true
    rmdir "$key_dir/private_keys" "$key_dir" 2>/dev/null || true
  }
  trap cleanup_apple_key EXIT
  mkdir "$key_dir/private_keys"
  cp "$ASC_KEY_PATH" "$key_dir/private_keys/AuthKey_${ASC_KEY_ID}.p8"

  node scripts/normalize-generated-ios-project.mjs --prepare-manual-signing
  IOS_CERTIFICATE="$IOS_CERTIFICATE" \
    IOS_CERTIFICATE_PASSWORD="$IOS_CERTIFICATE_PASSWORD" \
    IOS_MOBILE_PROVISION="$IOS_MOBILE_PROVISION" \
    APPLE_TEAM_ID="$APPLE_TEAM_ID" \
    APPLE_API_ISSUER="$ASC_ISSUER_ID" \
    APPLE_API_KEY="$ASC_KEY_ID" \
    APPLE_API_KEY_PATH="$key_dir/private_keys/AuthKey_${ASC_KEY_ID}.p8" \
    ./node_modules/.bin/tauri ios build \
      --ci \
      --export-method app-store-connect \
      -- \
      --locked
  node scripts/normalize-generated-ios-project.mjs
  git diff --exit-code

  ipa=$(find_one './src-tauri/gen/apple/build/arm64/*.ipa')
  ipa_abs="$app_dir/${ipa#./}"
  printf '%s' "$IOS_MOBILE_PROVISION" | base64 --decode > "$key_dir/expected.mobileprovision"
  scripts/verify-ios-ipa.sh \
    "$ipa_abs" \
    "$key_dir/expected.mobileprovision" \
    "$APPLE_TEAM_ID" \
    "$application_id"
  (
    cd "$key_dir"
    xcrun altool --validate-app --type ios --file "$ipa_abs" \
      --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
  )
  cp "$ipa" "release-artifacts/ZUULI-${identity}-ios.ipa"

  if [[ "$mode" == --upload ]]; then
    (
      cd "$key_dir"
      xcrun altool --upload-app --type ios --file "$ipa_abs" \
        --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
    )
  fi
else
  # shellcheck source=android-toolchain-env.sh
  source "$script_dir/android-toolchain-env.sh"
  ANDROID_KEYSTORE_PATH=$(canonical_secret_file ANDROID_KEYSTORE_PATH)
  export ANDROID_KEYSTORE_PATH
  require_value ANDROID_KEYSTORE_PASSWORD
  require_value ANDROID_KEY_ALIAS
  require_value ANDROID_KEY_PASSWORD
  require_value ANDROID_UPLOAD_CERT_SHA256
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
      .project_id == "corpora1" and
      .client_email == "corpan-play-verifier@corpora1.iam.gserviceaccount.com" and
      (.private_key_id | type == "string" and length > 0) and
      (.private_key | type == "string" and startswith("-----BEGIN PRIVATE KEY-----"))
    ' "$PLAY_SERVICE_ACCOUNT_JSON" >/dev/null; then
      echo "PLAY_SERVICE_ACCOUNT_JSON is not the dedicated Corpora ZUULI release account" >&2
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
  cp "$aab" "release-artifacts/ZUULI-${identity}-android.aab"

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
fi

echo "ZUULI $identity $platform release validation completed ($([[ "$mode" == --upload ]] && echo uploaded || echo dry-run))."
