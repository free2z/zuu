#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 record <aab> <identity> <source-sha> <source-tree> <output-dir> | seal-verifier <directory> <jar> <sha256> | verify <directory>" >&2
  exit 2
}

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

validate_identity() {
  [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\+(0|[1-9][0-9]*)$ ]]
}

validate_archive() {
  local artifact=$1 listing=$2
  unzip -Z1 "$artifact" | LC_ALL=C sort > "$listing" || return 1
  [[ -s "$listing" ]] || { echo "AAB member inventory is empty" >&2; return 1; }
  if LC_ALL=C sort "$listing" | uniq -d | grep -q .; then
    echo "AAB contains duplicate member names" >&2
    return 1
  fi
  if grep -E '(^/|(^|/)\.\.?(/|$)|(^|/)-|\\|[[:cntrl:]])' "$listing"; then
    echo "AAB contains an unsafe member name" >&2
    return 1
  fi
  actual_abis=$(
    awk -F/ '$2 == "lib" && NF >= 4 && $NF ~ /\.so$/ {print $3}' "$listing" |
      LC_ALL=C sort -u | paste -sd, -
  )
  expected_abis=arm64-v8a,armeabi-v7a,x86,x86_64
  [[ "$actual_abis" == "$expected_abis" ]] || {
    echo "AAB ABI set is '$actual_abis', expected '$expected_abis'" >&2
    return 1
  }
}

record() {
  [[ $# -eq 5 ]] || usage
  local artifact=$1 identity=$2 source_sha=$3 source_tree=$4 output=$5
  validate_identity "$identity" || { echo "invalid release identity" >&2; return 1; }
  [[ "$source_sha" =~ ^[0-9a-f]{40}$ && "$source_tree" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid source identity" >&2; return 1; }
  [[ -f "$artifact" && ! -L "$artifact" ]] || { echo "unsafe AAB input" >&2; return 1; }
  mkdir -p "$output" || return 1
  cp "$artifact" "$output/ZUULI-android-unsigned.aab" || return 1
  validate_archive "$output/ZUULI-android-unsigned.aab" "$output/aab-members.txt" || return 1
  artifact_sha=$(sha256_file "$output/ZUULI-android-unsigned.aab")
  artifact_bytes=$(wc -c < "$output/ZUULI-android-unsigned.aab" | tr -d '[:space:]')
  jq -n \
    --arg identity "$identity" \
    --arg sourceSha "$source_sha" \
    --arg sourceTree "$source_tree" \
    --arg artifactSha256 "$artifact_sha" \
    --argjson artifactBytes "$artifact_bytes" \
    '{schemaVersion:1,kind:"android-unsigned-universal-aab",applicationId:"cash.free2z.zuuli",identity:$identity,version:($identity|split("+")[0]),build:($identity|split("+")[1]|tonumber),source:{repository:"free2z/zuu",sha:$sourceSha,tree:$sourceTree},artifact:{name:"ZUULI-android-unsigned.aab",sha256:$artifactSha256,bytes:$artifactBytes},abis:["arm64-v8a","armeabi-v7a","x86","x86_64"]}' \
    > "$output/source-record.json" || return 1
  (
    cd "$output"
    sha256sum ZUULI-android-unsigned.aab aab-members.txt source-record.json > CHECKSUMS.sha256
  ) || return 1
  sha256_file "$output/CHECKSUMS.sha256"
}

seal_verifier() {
  [[ $# -eq 3 ]] || usage
  local directory=$1 verifier=$2 expected_sha=$3
  [[ "$expected_sha" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid verifier digest" >&2; return 1; }
  [[ -d "$directory" && ! -L "$directory" && -f "$verifier" && ! -L "$verifier" ]] || { echo "unsafe verifier input" >&2; return 1; }
  [[ "$(sha256_file "$verifier")" == "$expected_sha" ]] || { echo "verifier checksum mismatch" >&2; return 1; }
  (
    cd "$directory"
    actual_inventory=$({ for path in ./*; do [[ -f "$path" && ! -L "$path" ]] || exit 1; printf '%s\n' "${path#./}"; done; } | LC_ALL=C sort | tr '\n' ' ') || exit 1
    [[ "$actual_inventory" == \
      "CHECKSUMS.sha256 ZUULI-android-unsigned.aab aab-members.txt source-record.json " ]] || exit 1
    # Stdout of seal_verifier is the sealed digest and nothing else; `-c` reports
    # every member on stdout, so keep only its exit status. Redirecting rather
    # than passing --status keeps sha256sum's stderr diagnostics (unreadable
    # members, the mismatch warning).
    sha256sum -c CHECKSUMS.sha256 >/dev/null
  ) || { echo "unsigned artifact is not ready to seal" >&2; return 1; }
  cp "$verifier" "$directory/bundletool-all-1.18.3.jar" || return 1
  local source_record_tmp="$directory/source-record.json.tmp"
  jq --arg sha "$expected_sha" \
    '.verifier = {name:"bundletool-all-1.18.3.jar",version:"1.18.3",sha256:$sha}' \
    "$directory/source-record.json" > "$source_record_tmp" || { rm -f "$source_record_tmp"; return 1; }
  mv "$source_record_tmp" "$directory/source-record.json" || return 1
  (
    cd "$directory"
    sha256sum ZUULI-android-unsigned.aab aab-members.txt bundletool-all-1.18.3.jar source-record.json > CHECKSUMS.sha256
  ) || return 1
  sha256_file "$directory/CHECKSUMS.sha256"
}

verify() {
  [[ $# -eq 1 ]] || usage
  local directory=$1
  [[ -d "$directory" && ! -L "$directory" ]] || { echo "unsafe artifact directory" >&2; return 1; }
  (
    cd "$directory"
    actual_inventory=$({ for path in ./*; do [[ -f "$path" && ! -L "$path" ]] || exit 1; printf '%s\n' "${path#./}"; done; } | LC_ALL=C sort | tr '\n' ' ') || exit 1
    [[ "$actual_inventory" == \
      "CHECKSUMS.sha256 ZUULI-android-unsigned.aab aab-members.txt bundletool-all-1.18.3.jar source-record.json " ]] || exit 1
    sha256sum -c CHECKSUMS.sha256
    [[ "$(sha256_file bundletool-all-1.18.3.jar)" == "$(jq -er .verifier.sha256 source-record.json)" ]] || exit 1
  ) || { echo "artifact inventory or checksum verification failed" >&2; return 1; }
  validate_archive "$directory/ZUULI-android-unsigned.aab" "$directory/current-members.txt" || return 1
  cmp "$directory/aab-members.txt" "$directory/current-members.txt" || { rm -f "$directory/current-members.txt"; return 1; }
  rm "$directory/current-members.txt" || return 1
  jq -e '.schemaVersion == 1 and .kind == "android-unsigned-universal-aab" and .applicationId == "cash.free2z.zuuli" and .abis == ["arm64-v8a","armeabi-v7a","x86","x86_64"] and .verifier.name == "bundletool-all-1.18.3.jar" and .verifier.version == "1.18.3" and (.verifier.sha256 | test("^[0-9a-f]{64}$"))' \
    "$directory/source-record.json" >/dev/null
}

case "${1:-}" in
  record) shift; record "$@" ;;
  seal-verifier) shift; seal_verifier "$@" ;;
  verify) shift; verify "$@" ;;
  *) usage ;;
esac
