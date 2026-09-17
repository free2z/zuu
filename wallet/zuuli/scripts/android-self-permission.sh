#!/usr/bin/env bash
# Assert that an Android manifest declares exactly one <permission> element: the
# "<application-id>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" that androidx.core
# injects for API 33+, at protection level signature and nothing more.
#
# The same manifest reaches this check in two renderings, and both must pass:
#   - AGP's merged manifest is source XML and keeps the symbolic value,
#     android:protectionLevel="signature".
#   - "bundletool dump manifest" decodes the compiled protobuf manifest inside the
#     AAB. aapt2 has already folded the flags into an integer there, and bundletool
#     prints it as eight hex digits, android:protectionLevel="0x00000002".
#     Comparing that to the source string is what rejected the correct bundles of
#     0.1.0+22 and 0.1.0+23 (issue #1016).
#
# The accepted value is exactly android.content.pm.PermissionInfo
# .PROTECTION_SIGNATURE, 2: base level signature and no flag bits at all. Flags are
# rejected rather than masked off because each one widens who may hold the
# permission -- privileged (0x10) admits privileged system apps, development
# (0x20) and appop (0x40) allow grants outside the signature check, knownSigner
# (0x8000000) admits other certificates -- while androidx.core injects plain
# "signature". An unexpected flag means the injector changed, which calls for a
# review, not a pass. normal (0), dangerous (1), signatureOrSystem (3) and a
# missing attribute (which Android reads as normal) all fail.
#
# The android-sign-upload job in .github/workflows/zuuli-release.yml may not
# check out the repository (the credential boundary forbids it), so that workflow
# installs a verbatim copy of this file into $RUNNER_TEMP. The two copies are
# asserted byte-identical by android-self-permission.node-test.mjs, which also
# runs this file against real bundletool 1.18.3 dumps.
set -euo pipefail

android_self_permission() {
  local application_id=$1 manifest=$2
  local expected="$application_id.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"
  local elements element count names levels level value
  [[ -f "$manifest" && -s "$manifest" ]] || { echo "unusable manifest input: $manifest" >&2; return 1; }

  # Newlines are folded first: AGP pretty-prints, so an attribute can sit on a
  # different line from its element name. The trailing class keeps
  # <permission-group> and <permission-tree> out.
  elements=$(tr '\n' ' ' < "$manifest" | tr '<' '\n' | grep -a '^permission[[:space:]/>]' | sed 's/[[:space:]]*$//' || true)
  count=0
  [[ -z "$elements" ]] || count=$(wc -l <<<"$elements" | tr -d '[:space:]')
  names=$(grep -aoE '[[:space:]]android:name="[^"]*"' <<<"$elements" | sed 's/.*"\(.*\)"/\1/' | LC_ALL=C sort | paste -sd, - || true)
  if [[ "$count" != 1 || "$names" != "$expected" ]]; then
    echo "$manifest must declare exactly one <permission>, the application's own receiver permission" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   ${names:-<none>} ($count <permission> element(s))" >&2
    if [[ -n "$elements" ]]; then
      while IFS= read -r element; do echo "  element:  <$element" >&2; done <<<"$elements"
    fi
    return 1
  fi

  levels=$(grep -aoE '[[:space:]]android:protectionLevel="[^"]*"' <<<"$elements" | sed 's/.*"\(.*\)"/\1/' || true)
  if [[ -z "$levels" ]]; then
    echo "$manifest: $expected has no android:protectionLevel, which Android reads as normal" >&2
    echo "  element:  <$elements" >&2
    return 1
  fi
  if [[ "$(wc -l <<<"$levels" | tr -d '[:space:]')" != 1 ]]; then
    echo "$manifest: $expected carries more than one android:protectionLevel" >&2
    echo "  element:  <$elements" >&2
    return 1
  fi
  level=$levels
  if [[ "$level" == signature ]]; then
    value=2
  elif [[ "$level" =~ ^0x[0-9a-fA-F]{1,8}$ ]]; then
    value=$((16#${level#0x}))
  else
    echo "$manifest: $expected has an unrecognized android:protectionLevel rendering" >&2
    echo "  expected: signature (source XML) or 0x00000002 (compiled, via bundletool)" >&2
    echo "  actual:   $level" >&2
    return 1
  fi
  if (( value != 2 )); then
    local base
    case $((value & 0xf)) in
      0) base=normal ;;
      1) base=dangerous ;;
      2) base=signature ;;
      3) base=signatureOrSystem ;;
      *) base="unknown base $((value & 0xf))" ;;
    esac
    echo "$manifest: $expected is not exactly signature-level" >&2
    echo "  expected: signature, 0x00000002 (base signature, no flags)" >&2
    printf '  actual:   %s = base %s, flags 0x%08x\n' "$level" "$base" "$((value & ~0xf))" >&2
    return 1
  fi
  echo "$expected: protectionLevel $level (signature, no flags)"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  [[ $# -eq 2 ]] || { echo "usage: $0 <application-id> <manifest.xml>" >&2; exit 2; }
  android_self_permission "$1" "$2"
fi
