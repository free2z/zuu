#!/usr/bin/env bash
# Bind an unsigned Android App Bundle to the exact source that produced it, and
# seal the verifier that will later be used to inspect it.
#
# The credential-free build job and the protected signing job never share a
# machine: the signing job may not check the repository out, because holding the
# keystore and the source at the same time is the boundary this pipeline exists
# to keep. What crosses between them is this directory — the AAB, its member
# inventory, a `source-record.json` naming the commit and tree, a pinned copy of
# bundletool, and a `CHECKSUMS.sha256` over all four — plus a build-provenance
# attestation over that one checksum file. Sealing bundletool *into* the
# attested payload is what stops the signing job from downloading its own
# verifier from the network.
#
# A deliberate copy of wallet/zuuli/scripts/android-release-artifact.sh with the
# ZUULI names replaced. The two apps ship on their own schedules and must be able
# to move their bundletool pin independently.
set -euo pipefail

BUNDLETOOL_JAR=bundletool-all-1.18.3.jar
BUNDLETOOL_VERSION=1.18.3
ARTIFACT_NAME=e2e2z-android-unsigned.aab
APPLICATION_ID=cash.free2z.e2e2z
EXPECTED_ABIS=arm64-v8a,armeabi-v7a,x86,x86_64
# LC_ALL=C sorted, and computed rather than written out: ZUULI can spell its
# inventory as a literal because "ZUULI-android-unsigned.aab" happens to sort
# where a human would put it, and "e2e2z-android-unsigned.aab" does not. A
# literal that is wrong about byte order is a check that never passes.
sorted_inventory() {
  printf '%s\n' "$@" | LC_ALL=C sort | tr '\n' ' '
}
INVENTORY=$(sorted_inventory CHECKSUMS.sha256 "$ARTIFACT_NAME" aab-members.txt source-record.json)
SEALED_INVENTORY=$(sorted_inventory CHECKSUMS.sha256 "$ARTIFACT_NAME" aab-members.txt "$BUNDLETOOL_JAR" source-record.json)

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
  # Shared by stdout-producing and stdout-silent commands: keep stdout empty on
  # both success and failure, and put every diagnostic on stderr.
  unzip -Z1 "$artifact" | LC_ALL=C sort > "$listing" || return 1
  [[ -s "$listing" ]] || { echo "AAB member inventory is empty" >&2; return 1; }
  if LC_ALL=C sort "$listing" | uniq -d | grep -q .; then
    echo "AAB contains duplicate member names" >&2
    return 1
  fi
  if grep -qE '(^/|(^|/)\.\.?(/|$)|(^|/)-|\\|[[:cntrl:]])' "$listing"; then
    echo "AAB contains an unsafe member name" >&2
    return 1
  fi
  local actual_abis
  actual_abis=$(
    awk -F/ '$2 == "lib" && NF >= 4 && $NF ~ /\.so$/ {print $3}' "$listing" |
      LC_ALL=C sort -u | paste -sd, -
  )
  [[ "$actual_abis" == "$EXPECTED_ABIS" ]] || {
    echo "AAB ABI set is '$actual_abis', expected '$EXPECTED_ABIS'" >&2
    return 1
  }
}

record() {
  # Stdout contract: exactly one bare CHECKSUMS.sha256 digest on success and
  # nothing on failure. All diagnostics belong on stderr.
  [[ $# -eq 5 ]] || usage
  local artifact=$1 identity=$2 source_sha=$3 source_tree=$4 output=$5
  validate_identity "$identity" || { echo "invalid release identity" >&2; return 1; }
  [[ "$source_sha" =~ ^[0-9a-f]{40}$ && "$source_tree" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid source identity" >&2; return 1; }
  [[ -f "$artifact" && ! -L "$artifact" ]] || { echo "unsafe AAB input" >&2; return 1; }
  mkdir -p "$output" || return 1
  cp "$artifact" "$output/$ARTIFACT_NAME" || return 1
  validate_archive "$output/$ARTIFACT_NAME" "$output/aab-members.txt" || return 1
  local artifact_sha artifact_bytes
  artifact_sha=$(sha256_file "$output/$ARTIFACT_NAME")
  artifact_bytes=$(wc -c < "$output/$ARTIFACT_NAME" | tr -d '[:space:]')
  jq -n \
    --arg name "$ARTIFACT_NAME" \
    --arg applicationId "$APPLICATION_ID" \
    --arg identity "$identity" \
    --arg sourceSha "$source_sha" \
    --arg sourceTree "$source_tree" \
    --arg artifactSha256 "$artifact_sha" \
    --argjson artifactBytes "$artifact_bytes" \
    '{schemaVersion:1,kind:"android-unsigned-universal-aab",applicationId:$applicationId,identity:$identity,version:($identity|split("+")[0]),build:($identity|split("+")[1]|tonumber),source:{repository:"free2z/zuu",sha:$sourceSha,tree:$sourceTree},artifact:{name:$name,sha256:$artifactSha256,bytes:$artifactBytes},abis:["arm64-v8a","armeabi-v7a","x86","x86_64"]}' \
    > "$output/source-record.json" || return 1
  (
    cd "$output"
    sha256sum "$ARTIFACT_NAME" aab-members.txt source-record.json > CHECKSUMS.sha256
  ) || return 1
  sha256_file "$output/CHECKSUMS.sha256"
}

seal_verifier() {
  # Stdout contract: exactly one bare sealed CHECKSUMS.sha256 digest on success
  # and nothing on failure. All diagnostics belong on stderr.
  [[ $# -eq 3 ]] || usage
  local directory=$1 verifier=$2 expected_sha=$3
  [[ "$expected_sha" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid verifier digest" >&2; return 1; }
  [[ -d "$directory" && ! -L "$directory" && -f "$verifier" && ! -L "$verifier" ]] || { echo "unsafe verifier input" >&2; return 1; }
  [[ "$(sha256_file "$verifier")" == "$expected_sha" ]] || { echo "verifier checksum mismatch" >&2; return 1; }
  (
    cd "$directory"
    actual_inventory=$({ for path in ./*; do [[ -f "$path" && ! -L "$path" ]] || exit 1; printf '%s\n' "${path#./}"; done; } | LC_ALL=C sort | tr '\n' ' ') || exit 1
    [[ "$actual_inventory" == "$INVENTORY" ]] || exit 1
    # Stdout of seal_verifier is the sealed digest and nothing else; `-c` reports
    # every member on stdout, so keep only its exit status. Redirecting rather
    # than passing --status keeps sha256sum's stderr diagnostics.
    sha256sum -c CHECKSUMS.sha256 >/dev/null
  ) || { echo "unsigned artifact is not ready to seal" >&2; return 1; }
  cp "$verifier" "$directory/$BUNDLETOOL_JAR" || return 1
  local source_record_tmp="$directory/source-record.json.tmp"
  jq --arg name "$BUNDLETOOL_JAR" --arg version "$BUNDLETOOL_VERSION" --arg sha "$expected_sha" \
    '.verifier = {name:$name,version:$version,sha256:$sha}' \
    "$directory/source-record.json" > "$source_record_tmp" || { rm -f "$source_record_tmp"; return 1; }
  mv "$source_record_tmp" "$directory/source-record.json" || return 1
  (
    cd "$directory"
    sha256sum "$ARTIFACT_NAME" aab-members.txt "$BUNDLETOOL_JAR" source-record.json > CHECKSUMS.sha256
  ) || return 1
  sha256_file "$directory/CHECKSUMS.sha256"
}

verify() {
  # Stdout contract: always empty. Verification detail and failures belong on
  # stderr so callers may safely use stdout as a machine-readable channel.
  [[ $# -eq 1 ]] || usage
  local directory=$1
  [[ -d "$directory" && ! -L "$directory" ]] || { echo "unsafe artifact directory" >&2; return 1; }
  (
    cd "$directory"
    actual_inventory=$({ for path in ./*; do [[ -f "$path" && ! -L "$path" ]] || exit 1; printf '%s\n' "${path#./}"; done; } | LC_ALL=C sort | tr '\n' ' ') || exit 1
    [[ "$actual_inventory" == "$SEALED_INVENTORY" ]] || exit 1
    sha256sum -c CHECKSUMS.sha256 >/dev/null
    [[ "$(sha256_file "$BUNDLETOOL_JAR")" == "$(jq -er .verifier.sha256 source-record.json)" ]] || exit 1
  ) || { echo "artifact inventory or checksum verification failed" >&2; return 1; }
  validate_archive "$directory/$ARTIFACT_NAME" "$directory/current-members.txt" || return 1
  cmp -s "$directory/aab-members.txt" "$directory/current-members.txt" || {
    rm -f "$directory/current-members.txt"
    echo "AAB member inventory changed" >&2
    return 1
  }
  rm "$directory/current-members.txt" || return 1
  jq -e --arg applicationId "$APPLICATION_ID" --arg name "$BUNDLETOOL_JAR" --arg version "$BUNDLETOOL_VERSION" \
    '.schemaVersion == 1 and .kind == "android-unsigned-universal-aab" and .applicationId == $applicationId and .abis == ["arm64-v8a","armeabi-v7a","x86","x86_64"] and .verifier.name == $name and .verifier.version == $version and (.verifier.sha256 | test("^[0-9a-f]{64}$"))' \
    "$directory/source-record.json" >/dev/null
}

case "${1:-}" in
  record) shift; record "$@" ;;
  seal-verifier) shift; seal_verifier "$@" ;;
  verify) shift; verify "$@" ;;
  *) usage ;;
esac
