#!/usr/bin/env bash
# Write the "<sha256>  <member>" list for every payload member of an AAB, in one
# canonical order, so an unsigned bundle and its signed counterpart can be
# compared byte for byte with cmp.
#
# Excluded, deliberately: "META-INF/*" is the signature block jarsigner adds, and
# trailing-"/" entries are directories with no content. Signing may add exactly
# those and nothing else -- proving that is the whole point of the comparison.
#
# Members are LC_ALL=C sorted rather than left in archive order because jarsigner
# rewrites the central directory: it prepends its signature block and does not
# promise to keep the surviving members in their original sequence. cmp is
# byte-exact, so both sides must be produced by this one function or they compare
# unequal even when every digest matches. That is exactly what broke 0.1.0+16
# (issue #751): the unsigned side sorted and the signed side did not.
#
# Digests are taken from "unzip -p", i.e. over decompressed member content, so a
# re-compressed but otherwise untouched member still compares equal -- the check
# binds the payload, not the container's encoding.
#
# The android-sign-upload job in .github/workflows/zuuli-release.yml may not
# check out the repository (the credential boundary forbids it), so that workflow
# installs a verbatim copy of this file into $RUNNER_TEMP. The two copies are
# asserted byte-identical by aab-payload-digest.node-test.mjs, which is what
# keeps the release path and this tested file from drifting apart again.
set -euo pipefail

aab_payload_digest() {
  local aab=$1 output=$2 member
  [[ -f "$aab" && ! -L "$aab" ]] || { echo "unsafe AAB input: $aab" >&2; return 1; }
  : > "$output"
  while IFS= read -r member; do
    case "$member" in META-INF/*|*/) continue ;; esac
    printf '%s  %s\n' "$(unzip -p "$aab" "$member" | sha256sum | awk '{print $1}')" "$member" >> "$output"
  done < <(unzip -Z1 "$aab" | LC_ALL=C sort)
  [[ -s "$output" ]] || { echo "AAB has no payload members: $aab" >&2; return 1; }
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  [[ $# -eq 2 ]] || { echo "usage: $0 <aab> <output>" >&2; exit 2; }
  aab_payload_digest "$1" "$2"
fi
