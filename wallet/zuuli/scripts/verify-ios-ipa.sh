#!/usr/bin/env bash
set -euo pipefail
umask 077

script_path=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/$(basename -- "$0")

fail() {
  echo "iOS IPA verification failed: $*" >&2
  exit 70
}

cleanup_directory() {
  local directory=$1
  [[ -d "$directory" ]] || return 0
  find "$directory" -depth -delete 2>/dev/null || true
}

self_test() (
  local fixture_dir fixture_ipa output
  fixture_dir=$(mktemp -d "${TMPDIR:-/tmp}/zuuli-ipa-self-test.XXXXXX")
  trap 'cleanup_directory "$fixture_dir"' EXIT
  mkdir -p "$fixture_dir/root/Payload/ZUULI.app"
  printf 'fixture\n' > "$fixture_dir/root/Payload/ZUULI.app/ZUULI"
  printf 'fixture\n' > "$fixture_dir/expected.mobileprovision"
  fixture_ipa="$fixture_dir/missing-profile.ipa"
  (cd "$fixture_dir/root" && zip -qry "$fixture_ipa" Payload)
  if output=$("$script_path" "$fixture_ipa" "$fixture_dir/expected.mobileprovision" F9AV5HKF6N cash.free2z.zuuli 2>&1); then
    fail "missing-profile self-test unexpectedly passed"
  fi
  grep -Fq 'archive does not contain exactly one embedded.mobileprovision' <<<"$output" ||
    fail "missing-profile self-test failed for the wrong reason: $output"

  printf 'fixture\n' > "$fixture_dir/root/Payload/ZUULI.app/embedded.mobileprovision"
  printf 'fixture\n' > "$fixture_dir/root/Payload/ZUULI.app/libapp.a"
  fixture_ipa="$fixture_dir/static-archive.ipa"
  (cd "$fixture_dir/root" && zip -qry "$fixture_ipa" Payload)
  if output=$("$script_path" "$fixture_ipa" "$fixture_dir/expected.mobileprovision" F9AV5HKF6N cash.free2z.zuuli 2>&1); then
    fail "static-archive self-test unexpectedly passed"
  fi
  grep -Fq 'app bundle contains a forbidden static archive' <<<"$output" ||
    fail "static-archive self-test failed for the wrong reason: $output"

  rm "$fixture_dir/root/Payload/ZUULI.app/libapp.a"
  printf '\317\372\355\376\014\000\000\001' > "$fixture_dir/root/Payload/ZUULI.app/Sidecar"
  fixture_ipa="$fixture_dir/root-binary.ipa"
  (cd "$fixture_dir/root" && zip -qry "$fixture_ipa" Payload)
  if output=$("$script_path" "$fixture_ipa" "$fixture_dir/expected.mobileprovision" F9AV5HKF6N cash.free2z.zuuli 2>&1); then
    fail "root-binary self-test unexpectedly passed"
  fi
  grep -Fq 'app bundle contains a forbidden root binary' <<<"$output" ||
    fail "root-binary self-test failed for the wrong reason: $output"
)

darwin_self_test() (
  local fixture_dir certificate_prefix entitlements extracted_team
  [[ "$(uname -s)" == Darwin ]] || fail "--self-test-darwin requires macOS"
  fixture_dir=$(mktemp -d "${TMPDIR:-/tmp}/zuuli-ipa-darwin-self-test.XXXXXX")
  trap 'cleanup_directory "$fixture_dir"' EXIT

  certificate_prefix="$fixture_dir/system-certificate-"
  codesign -d --extract-certificates="$certificate_prefix" /usr/bin/ssh 2>/dev/null ||
    fail "Darwin self-test could not extract certificates"
  [[ -f "${certificate_prefix}0" ]] ||
    fail "Darwin self-test did not extract the signing leaf certificate"

  entitlements="$fixture_dir/entitlements.plist"
  plutil -create xml1 "$entitlements"
  plutil -insert 'com\.apple\.developer\.team-identifier' -string F9AV5HKF6N "$entitlements"
  extracted_team=$(plutil -extract 'com\.apple\.developer\.team-identifier' raw -o - "$entitlements")
  [[ "$extracted_team" == F9AV5HKF6N ]] ||
    fail "Darwin self-test could not extract the dotted entitlement key"
)

if [[ "${1:-}" == --self-test ]]; then
  [[ $# -eq 1 ]] || fail "--self-test takes no additional arguments"
  self_test
  exit 0
fi

if [[ "${1:-}" == --self-test-darwin ]]; then
  [[ $# -eq 1 ]] || fail "--self-test-darwin takes no additional arguments"
  darwin_self_test
  exit 0
fi

if [[ $# -ne 4 ]]; then
  echo "usage: scripts/verify-ios-ipa.sh <ipa> <expected.mobileprovision> <team-id> <application-id>" >&2
  exit 64
fi

ipa=$1
expected_profile=$2
team_id=$3
application_id=$4

[[ -f "$ipa" && ! -L "$ipa" ]] || fail "IPA must be a regular, non-symlink file"
[[ -f "$expected_profile" && ! -L "$expected_profile" ]] ||
  fail "expected provisioning profile must be a regular, non-symlink file"
[[ "$team_id" == F9AV5HKF6N ]] || fail "unexpected Apple team $team_id"
[[ "$application_id" == cash.free2z.zuuli ]] ||
  fail "unexpected application identifier $application_id"

archive_listing=$(/usr/bin/unzip -Z1 "$ipa") || fail "IPA is not a readable zip archive"
if grep -Eq '(^/|(^|/)\.\.(/|$))' <<<"$archive_listing"; then
  fail "IPA contains an unsafe archive path"
fi

app_roots=()
while IFS= read -r path; do
  [[ -n "$path" ]] && app_roots+=("$path")
done < <(
  awk -F/ '$1 == "Payload" && $2 ~ /\.app$/ { print $1 "/" $2 }' <<<"$archive_listing" |
    sort -u
)
[[ ${#app_roots[@]} -eq 1 ]] ||
  fail "archive must contain exactly one top-level Payload app, found ${#app_roots[@]}"
app_root=${app_roots[0]}
app_prefix="$app_root/"
forbidden_static_archive=$(awk -v prefix="$app_prefix" '
  index($0, prefix) == 1 && $0 ~ /\.a$/ { print; exit }
' <<<"$archive_listing")
[[ -z "$forbidden_static_archive" ]] ||
  fail "app bundle contains a forbidden static archive: $forbidden_static_archive"
forbidden_root_library=$(awk -v prefix="$app_prefix" '
  index($0, prefix) == 1 {
    relative = substr($0, length(prefix) + 1)
    if (relative !~ /\// && relative ~ /\.(dylib|so)$/) { print; exit }
  }
' <<<"$archive_listing")
[[ -z "$forbidden_root_library" ]] ||
  fail "app bundle contains a forbidden root binary: $forbidden_root_library"
embedded_archive_path="$app_root/embedded.mobileprovision"
embedded_count=$(grep -Fxc "$embedded_archive_path" <<<"$archive_listing" || true)
[[ "$embedded_count" -eq 1 ]] ||
  fail "archive does not contain exactly one embedded.mobileprovision"

inspect_dir=$(mktemp -d "${TMPDIR:-/tmp}/zuuli-ipa-inspect.XXXXXX")
trap 'cleanup_directory "$inspect_dir"' EXIT
/usr/bin/unzip -q "$ipa" -d "$inspect_dir"
app="$inspect_dir/$app_root"
embedded_profile="$app/embedded.mobileprovision"
[[ -d "$app" && ! -L "$app" ]] || fail "app bundle is not a regular directory"
[[ -f "$embedded_profile" && ! -L "$embedded_profile" ]] ||
  fail "embedded provisioning profile is not a regular file"
while IFS= read -r -d '' root_file; do
  [[ "$(basename -- "$root_file")" == ZUULI ]] && continue
  file_kind=$(/usr/bin/file -b "$root_file") || fail "unable to inspect app root file"
  if [[ "$file_kind" == *Mach-O* || "$file_kind" == *"ar archive"* ]]; then
    fail "app bundle contains a forbidden root binary: $(basename -- "$root_file")"
  fi
done < <(find "$app" -maxdepth 1 -type f -print0)
cmp -s "$expected_profile" "$embedded_profile" ||
  fail "embedded provisioning profile differs from the protected input"

profile_plist="$inspect_dir/profile.plist"
security cms -D -i "$embedded_profile" > "$profile_plist" ||
  fail "embedded provisioning profile is not a valid CMS document"
profile_uuid=$(/usr/libexec/PlistBuddy -c 'Print :UUID' "$profile_plist")
profile_name=$(/usr/libexec/PlistBuddy -c 'Print :Name' "$profile_plist")
profile_team=$(/usr/libexec/PlistBuddy -c 'Print :TeamIdentifier:0' "$profile_plist")
profile_app=$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:application-identifier' "$profile_plist")
[[ "$profile_uuid" == e5ead62c-83ec-4e54-abb6-4770833b5e0d ]] ||
  fail "embedded profile UUID is not the protected ZUULI profile"
[[ "$profile_name" == 'ZUULI App Store CI' ]] ||
  fail "embedded profile name is not ZUULI App Store CI"
[[ "$profile_team" == "$team_id" ]] || fail "embedded profile team mismatch"
[[ "$profile_app" == "$team_id.$application_id" ]] ||
  fail "embedded profile application identifier mismatch"

codesign --verify --deep --strict --verbose=2 "$app" ||
  fail "app bundle signature is invalid"
signature=$(codesign -dvvv "$app" 2>&1) || fail "app signature metadata is unreadable"
grep -Fxq "Identifier=$application_id" <<<"$signature" ||
  fail "signed bundle identifier mismatch"
grep -Fxq "Authority=Apple Distribution: Corpora Inc ($team_id)" <<<"$signature" ||
  fail "app is not signed by the dedicated Corpora distribution certificate"
grep -Fxq "TeamIdentifier=$team_id" <<<"$signature" ||
  fail "signed team identifier mismatch"

certificate_prefix="$inspect_dir/signing-certificate-"
codesign -d --extract-certificates="$certificate_prefix" "$app" 2>/dev/null ||
  fail "unable to extract the app signing certificate"
[[ -f "${certificate_prefix}0" ]] || fail "app signing certificate is missing"
signer_sha=$(openssl x509 -inform DER -in "${certificate_prefix}0" -noout -fingerprint -sha1 |
  cut -d= -f2 | tr -d ':')
profile_authorizes_signer=false
certificate_index=0
while certificate_base64=$(plutil -extract "DeveloperCertificates.$certificate_index" raw -o - "$profile_plist" 2>/dev/null); do
  printf '%s' "$certificate_base64" | base64 --decode > "$inspect_dir/profile-certificate.der"
  profile_sha=$(openssl x509 -inform DER -in "$inspect_dir/profile-certificate.der" -noout -fingerprint -sha1 |
    cut -d= -f2 | tr -d ':')
  if [[ "$signer_sha" == "$profile_sha" ]]; then
    profile_authorizes_signer=true
    break
  fi
  certificate_index=$((certificate_index + 1))
done
[[ "$profile_authorizes_signer" == true ]] ||
  fail "app signer is not authorized by the embedded provisioning profile"

signed_entitlements="$inspect_dir/signed-entitlements.plist"
codesign -d --entitlements "$signed_entitlements" --xml "$app" 2>/dev/null ||
  fail "unable to extract signed entitlements"
signed_app=$(plutil -extract application-identifier raw -o - "$signed_entitlements")
signed_team=$(plutil -extract 'com\.apple\.developer\.team-identifier' raw -o - "$signed_entitlements")
signed_entitlements_json=$(plutil -convert json -o - "$signed_entitlements") ||
  fail "signed entitlements are not a readable plist"
[[ "$signed_app" == "$team_id.$application_id" ]] ||
  fail "signed application entitlement mismatch"
[[ "$signed_team" == "$team_id" ]] || fail "signed team entitlement mismatch"
jq -e '
  type == "object" and
  ((has("get-task-allow") | not) or .["get-task-allow"] == false)
' <<<"$signed_entitlements_json" >/dev/null ||
  fail "distribution app enables or has an invalid get-task-allow entitlement"

echo "verified exact embedded profile and Corpora distribution signature in $(basename -- "$ipa")"
