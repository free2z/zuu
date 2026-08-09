#!/usr/bin/env bash
set -euo pipefail
umask 077

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
script_path="$script_directory/$(basename -- "$0")"
plist_verifier="$script_directory/verify-ios-info-plist.py"

fail() {
  echo "iOS IPA verification failed: $*" >&2
  exit 70
}

cleanup_directory() {
  local directory=$1
  [[ -d "$directory" ]] || return 0
  find "$directory" -depth -delete 2>/dev/null || true
}

is_allowed_bundle_binary() {
  local relative=$1
  case "$relative" in
    ZUULI | Frameworks/*.framework/* | Frameworks/*.dylib | Frameworks/*.so | \
      PlugIns/*.appex/* | Extensions/*.appex/* | Watch/*.app/* | AppClips/*.app/* | \
      XPCServices/*.xpc/*)
      return 0
      ;;
  esac
  return 1
}

verify_export_compliance() {
  local app=$1 info_plist output
  info_plist="$app/Info.plist"
  [[ -f "$info_plist" && ! -L "$info_plist" ]] ||
    fail "app bundle Info.plist is not a regular file"
  command -v python3 >/dev/null 2>&1 ||
    fail "python3 is required for duplicate-safe app bundle plist verification"
  output=$(python3 "$plist_verifier" "$info_plist" 2>&1) || fail "$output"
}

verify_app_structure() {
  local app=$1 bundle_entry bundle_file relative file_kind main_kind
  [[ -d "$app" && ! -L "$app" ]] || fail "app bundle is not a regular directory"
  [[ -f "$app/ZUULI" && ! -L "$app/ZUULI" ]] ||
    fail "app bundle main executable is not a regular file"
  main_kind=$(/usr/bin/file -b "$app/ZUULI") ||
    fail "unable to inspect app bundle main executable"
  [[ "$main_kind" == *Mach-O* ]] || fail "app bundle main executable is not Mach-O"
  verify_export_compliance "$app"
  while IFS= read -r -d '' bundle_entry; do
    relative=${bundle_entry#"$app/"}
    if [[ -L "$bundle_entry" || (! -d "$bundle_entry" && ! -f "$bundle_entry") ]]; then
      fail "app bundle contains a non-regular entry: $relative"
    fi
  done < <(find "$app" -mindepth 1 -print0)
  while IFS= read -r -d '' bundle_file; do
    relative=${bundle_file#"$app/"}
    if [[ "$relative" == *.a ]]; then
      fail "app bundle contains a forbidden static archive: $relative"
    fi
    file_kind=$(/usr/bin/file -b "$bundle_file") ||
      fail "unable to inspect app bundle file: $relative"
    if [[ "$file_kind" == *"ar archive"* ]]; then
      fail "app bundle contains a forbidden static archive binary: $relative"
    fi
    if [[ "$file_kind" == *Mach-O* ]] && ! is_allowed_bundle_binary "$relative"; then
      fail "app bundle contains a forbidden standalone binary: $relative"
    fi
  done < <(find "$app" -type f -print0)
}

self_test() (
  local fixture_app fixture_dir fixture_ipa output
  python3 "$plist_verifier" --self-test ||
    fail "Info.plist duplicate-policy self-test failed"
  fixture_dir=$(mktemp -d "${TMPDIR:-/tmp}/zuuli-ipa-self-test.XXXXXX")
  trap 'cleanup_directory "$fixture_dir"' EXIT
  fixture_app="$fixture_dir/root/Payload/ZUULI.app"
  mkdir -p "$fixture_app"
  printf '\317\372\355\376\014\000\000\001' > "$fixture_app/ZUULI"
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<plist version="1.0"><dict><key>ITSAppUsesNonExemptEncryption</key><false/></dict></plist>' > "$fixture_app/Info.plist"
  printf 'fixture\n' > "$fixture_dir/expected.mobileprovision"
  fixture_ipa="$fixture_dir/missing-profile.ipa"
  (cd "$fixture_dir/root" && zip -qry "$fixture_ipa" Payload)
  if output=$("$script_path" "$fixture_ipa" "$fixture_dir/expected.mobileprovision" F9AV5HKF6N cash.free2z.zuuli 2>&1); then
    fail "missing-profile self-test unexpectedly passed"
  fi
  grep -Fq 'archive does not contain exactly one embedded.mobileprovision' <<<"$output" ||
    fail "missing-profile self-test failed for the wrong reason: $output"

  printf 'fixture\n' > "$fixture_app/embedded.mobileprovision"
  printf 'fixture\n' > "$fixture_app/libapp.a"
  fixture_ipa="$fixture_dir/static-archive.ipa"
  (cd "$fixture_dir/root" && zip -qry "$fixture_ipa" Payload)
  if output=$("$script_path" "$fixture_ipa" "$fixture_dir/expected.mobileprovision" F9AV5HKF6N cash.free2z.zuuli 2>&1); then
    fail "static-archive self-test unexpectedly passed"
  fi
  grep -Fq 'app bundle contains a forbidden static archive' <<<"$output" ||
    fail "static-archive self-test failed for the wrong reason: $output"

  rm "$fixture_app/libapp.a"
  printf '\317\372\355\376\014\000\000\001' > "$fixture_app/Sidecar"
  fixture_ipa="$fixture_dir/root-binary.ipa"
  (cd "$fixture_dir/root" && zip -qry "$fixture_ipa" Payload)
  if output=$("$script_path" "$fixture_ipa" "$fixture_dir/expected.mobileprovision" F9AV5HKF6N cash.free2z.zuuli 2>&1); then
    fail "root-binary self-test unexpectedly passed"
  fi
  grep -Fq 'app bundle contains a forbidden standalone binary: Sidecar' <<<"$output" ||
    fail "root-binary self-test failed for the wrong reason: $output"

  mkdir "$fixture_app/assets"
  mv "$fixture_app/Sidecar" "$fixture_app/assets/Sidecar"
  fixture_ipa="$fixture_dir/nested-binary.ipa"
  (cd "$fixture_dir/root" && zip -qry "$fixture_ipa" Payload)
  if output=$("$script_path" "$fixture_ipa" "$fixture_dir/expected.mobileprovision" F9AV5HKF6N cash.free2z.zuuli 2>&1); then
    fail "nested-binary self-test unexpectedly passed"
  fi
  grep -Fq 'app bundle contains a forbidden standalone binary: assets/Sidecar' <<<"$output" ||
    fail "nested-binary self-test failed for the wrong reason: $output"

  rm "$fixture_app/assets/Sidecar"
  printf '!<arch>\n' > "$fixture_app/assets/archive-data"
  fixture_ipa="$fixture_dir/renamed-static-archive.ipa"
  (cd "$fixture_dir/root" && zip -qry "$fixture_ipa" Payload)
  if output=$("$script_path" "$fixture_ipa" "$fixture_dir/expected.mobileprovision" F9AV5HKF6N cash.free2z.zuuli 2>&1); then
    fail "renamed-static-archive self-test unexpectedly passed"
  fi
  grep -Fq 'app bundle contains a forbidden static archive binary: assets/archive-data' <<<"$output" ||
    fail "renamed-static-archive self-test failed for the wrong reason: $output"

  rm "$fixture_app/assets/archive-data"
  "$script_path" --verify-app-structure "$fixture_app" ||
    fail "clean app-structure self-test unexpectedly failed"

  ln -s ZUULI "$fixture_app/linked-binary"
  if output=$("$script_path" --verify-app-structure "$fixture_app" 2>&1); then
    fail "symlink self-test unexpectedly passed"
  fi
  grep -Fq 'app bundle contains a non-regular entry: linked-binary' <<<"$output" ||
    fail "symlink self-test failed for the wrong reason: $output"

  rm "$fixture_app/linked-binary" "$fixture_app/Info.plist"
  if output=$("$script_path" --verify-app-structure "$fixture_app" 2>&1); then
    fail "missing export-compliance declaration self-test unexpectedly passed"
  fi
  grep -Fq 'app bundle Info.plist is not a regular file' <<<"$output" ||
    fail "missing export-compliance declaration self-test failed for the wrong reason: $output"

  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<plist version="1.0"><dict/></plist>' > "$fixture_app/Info.plist"
  if output=$("$script_path" --verify-app-structure "$fixture_app" 2>&1); then
    fail "missing export-compliance key self-test unexpectedly passed"
  fi
  grep -Fq 'Info.plist must contain exactly one raw ITSAppUsesNonExemptEncryption key, found 0' <<<"$output" ||
    fail "missing export-compliance key self-test failed for the wrong reason: $output"

  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<plist version="1.0"><dict><key>ITSAppUsesNonExemptEncryption</key><string>false</string></dict></plist>' > "$fixture_app/Info.plist"
  if output=$("$script_path" --verify-app-structure "$fixture_app" 2>&1); then
    fail "string export-compliance declaration self-test unexpectedly passed"
  fi
  grep -Fq 'Info.plist ITSAppUsesNonExemptEncryption must be a Boolean' <<<"$output" ||
    fail "string export-compliance declaration self-test failed for the wrong reason: $output"

  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<plist version="1.0"><dict><key>ITSAppUsesNonExemptEncryption</key><true/></dict></plist>' > "$fixture_app/Info.plist"
  if output=$("$script_path" --verify-app-structure "$fixture_app" 2>&1); then
    fail "non-exempt encryption declaration self-test unexpectedly passed"
  fi
  grep -Fq 'Info.plist must declare ITSAppUsesNonExemptEncryption=false' <<<"$output" ||
    fail "non-exempt encryption declaration self-test failed for the wrong reason: $output"

  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<plist version="1.0"><dict><key>ITSAppUsesNonExemptEncryption</key><false/><key>ITSAppUsesNonExemptEncryption</key><false/></dict></plist>' > "$fixture_app/Info.plist"
  if output=$("$script_path" --verify-app-structure "$fixture_app" 2>&1); then
    fail "same-value duplicate export-compliance declaration unexpectedly passed"
  fi
  grep -Fq 'Info.plist root dictionary contains duplicate keys: ITSAppUsesNonExemptEncryption' <<<"$output" ||
    fail "same-value duplicate export-compliance declaration failed for the wrong reason: $output"

  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<plist version="1.0"><dict><key>ITSAppUsesNonExemptEncryption</key><true/><key>ITSAppUsesNonExemptEncryption</key><false/></dict></plist>' > "$fixture_app/Info.plist"
  if output=$("$script_path" --verify-app-structure "$fixture_app" 2>&1); then
    fail "conflicting duplicate export-compliance declaration unexpectedly passed"
  fi
  grep -Fq 'Info.plist root dictionary contains duplicate keys: ITSAppUsesNonExemptEncryption' <<<"$output" ||
    fail "conflicting duplicate export-compliance declaration failed for the wrong reason: $output"
)

darwin_self_test() (
  local fixture_dir fixture_app certificate_prefix entitlements extracted_team output
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

  fixture_app="$fixture_dir/ZUULI.app"
  mkdir "$fixture_app"
  printf '\317\372\355\376\014\000\000\001' > "$fixture_app/ZUULI"
  plutil -create xml1 "$fixture_app/Info.plist"
  plutil -insert ITSAppUsesNonExemptEncryption -bool NO "$fixture_app/Info.plist"
  "$script_path" --verify-app-structure "$fixture_app" ||
    fail "Darwin Boolean export-compliance fixture unexpectedly failed"
  plutil -convert binary1 "$fixture_app/Info.plist"
  "$script_path" --verify-app-structure "$fixture_app" ||
    fail "Darwin binary-plist export-compliance fixture unexpectedly failed"
  plutil -replace ITSAppUsesNonExemptEncryption -string false "$fixture_app/Info.plist"
  if output=$("$script_path" --verify-app-structure "$fixture_app" 2>&1); then
    fail "Darwin string export-compliance fixture unexpectedly passed"
  fi
  grep -Fq 'Info.plist ITSAppUsesNonExemptEncryption must be a Boolean' <<<"$output" ||
    fail "Darwin string export-compliance fixture failed for the wrong reason: $output"
  plutil -replace ITSAppUsesNonExemptEncryption -bool YES "$fixture_app/Info.plist"
  if output=$("$script_path" --verify-app-structure "$fixture_app" 2>&1); then
    fail "Darwin non-exempt encryption fixture unexpectedly passed"
  fi
  grep -Fq 'Info.plist must declare ITSAppUsesNonExemptEncryption=false' <<<"$output" ||
    fail "Darwin non-exempt encryption fixture failed for the wrong reason: $output"
  plutil -remove ITSAppUsesNonExemptEncryption "$fixture_app/Info.plist"
  if output=$("$script_path" --verify-app-structure "$fixture_app" 2>&1); then
    fail "Darwin missing export-compliance key fixture unexpectedly passed"
  fi
  grep -Fq 'Info.plist must contain exactly one raw ITSAppUsesNonExemptEncryption key, found 0' <<<"$output" ||
    fail "Darwin missing export-compliance key fixture failed for the wrong reason: $output"
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

if [[ "${1:-}" == --verify-app-structure ]]; then
  [[ $# -eq 2 ]] || fail "--verify-app-structure requires exactly one app path"
  verify_app_structure "$2"
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
embedded_archive_path="$app_root/embedded.mobileprovision"
embedded_count=$(grep -Fxc "$embedded_archive_path" <<<"$archive_listing" || true)
[[ "$embedded_count" -eq 1 ]] ||
  fail "archive does not contain exactly one embedded.mobileprovision"

inspect_dir=$(mktemp -d "${TMPDIR:-/tmp}/zuuli-ipa-inspect.XXXXXX")
trap 'cleanup_directory "$inspect_dir"' EXIT
/usr/bin/unzip -q "$ipa" -d "$inspect_dir"
app="$inspect_dir/$app_root"
embedded_profile="$app/embedded.mobileprovision"
verify_app_structure "$app"
[[ -f "$embedded_profile" && ! -L "$embedded_profile" ]] ||
  fail "embedded provisioning profile is not a regular file"
cmp -s "$expected_profile" "$embedded_profile" ||
  fail "embedded provisioning profile differs from the protected input"

profile_plist="$inspect_dir/profile.plist"
security cms -D -i "$embedded_profile" > "$profile_plist" ||
  fail "embedded provisioning profile is not a valid CMS document"
profile_uuid=$(/usr/libexec/PlistBuddy -c 'Print :UUID' "$profile_plist")
profile_name=$(/usr/libexec/PlistBuddy -c 'Print :Name' "$profile_plist")
profile_team=$(/usr/libexec/PlistBuddy -c 'Print :TeamIdentifier:0' "$profile_plist")
profile_app=$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:application-identifier' "$profile_plist")
profile_json=$(plutil -convert json -o - "$profile_plist") ||
  fail "embedded provisioning profile is not a readable plist"
[[ "$profile_uuid" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]] ||
  fail "embedded profile UUID is malformed"
[[ "$profile_name" == 'ZUULI App Store CI' ]] ||
  fail "embedded profile name is not ZUULI App Store CI"
[[ "$profile_team" == "$team_id" ]] || fail "embedded profile team mismatch"
[[ "$profile_app" == "$team_id.$application_id" ]] ||
  fail "embedded profile application identifier mismatch"
jq -e '
  .Entitlements["com.apple.developer.associated-domains"] == ["*"]
' <<<"$profile_json" >/dev/null ||
  fail "embedded profile does not authorize the Associated Domains capability"

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
  ((has("get-task-allow") | not) or .["get-task-allow"] == false) and
  .["com.apple.developer.associated-domains"] == ["applinks:free2z.com"]
' <<<"$signed_entitlements_json" >/dev/null ||
  fail "distribution app has invalid release or associated-domain entitlements"

echo "verified exact embedded profile and Corpora distribution signature in $(basename -- "$ipa")"
