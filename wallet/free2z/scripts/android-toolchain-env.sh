# Source this file from Bash before every Android build. Tauri supplies these
# values too, but explicit exports prevent a developer's stale cargo linker
# environment from silently selecting a different NDK or API level.
#
# This is a deliberate copy of wallet/zuuli/scripts/android-toolchain-env.sh
# (by way of e2e2z's) rather than a shared file. The three apps ship
# independently: free2z must be able to pin its own NDK and API level without
# moving anyone else's, and no other app's release path should start depending
# on a file that lives in this tree.
# `release-identity.mjs` asserts that the API level here equals `minimums.android`
# in release.json, so the pin cannot drift away from what the manifest promises.
case "$(uname -s)" in
  Darwin) free2z_ndk_host=darwin-x86_64 ;;
  Linux) free2z_ndk_host=linux-x86_64 ;;
  *) echo "unsupported Android build host: $(uname -s)" >&2; return 1 ;;
esac

: "${ANDROID_HOME:?ANDROID_HOME must point at the Android SDK}"
export NDK_HOME="$ANDROID_HOME/ndk/27.0.12077973"
export ANDROID_NDK_HOME="$NDK_HOME"
free2z_ndk_bin="$NDK_HOME/toolchains/llvm/prebuilt/$free2z_ndk_host/bin"

export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$free2z_ndk_bin/aarch64-linux-android29-clang"
export CARGO_TARGET_ARMV7_LINUX_ANDROIDEABI_LINKER="$free2z_ndk_bin/armv7a-linux-androideabi29-clang"
export CARGO_TARGET_I686_LINUX_ANDROID_LINKER="$free2z_ndk_bin/i686-linux-android29-clang"
export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER="$free2z_ndk_bin/x86_64-linux-android29-clang"
export CC_aarch64_linux_android="$CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER"
export CC_armv7_linux_androideabi="$CARGO_TARGET_ARMV7_LINUX_ANDROIDEABI_LINKER"
export CC_i686_linux_android="$CARGO_TARGET_I686_LINUX_ANDROID_LINKER"
export CC_x86_64_linux_android="$CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER"
export CXX_aarch64_linux_android="${CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER}++"
export CXX_armv7_linux_androideabi="${CARGO_TARGET_ARMV7_LINUX_ANDROIDEABI_LINKER}++"
export CXX_i686_linux_android="${CARGO_TARGET_I686_LINUX_ANDROID_LINKER}++"
export CXX_x86_64_linux_android="${CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER}++"
export AR_aarch64_linux_android="$free2z_ndk_bin/llvm-ar"
export AR_armv7_linux_androideabi="$free2z_ndk_bin/llvm-ar"
export AR_i686_linux_android="$free2z_ndk_bin/llvm-ar"
export AR_x86_64_linux_android="$free2z_ndk_bin/llvm-ar"

for free2z_compiler in \
  "$CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER" \
  "$CARGO_TARGET_ARMV7_LINUX_ANDROIDEABI_LINKER" \
  "$CARGO_TARGET_I686_LINUX_ANDROID_LINKER" \
  "$CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER"; do
  [[ -x "$free2z_compiler" ]] || { echo "missing pinned NDK compiler: $free2z_compiler" >&2; return 1; }
done
[[ -x "$free2z_ndk_bin/llvm-ar" ]] || {
  echo "missing pinned NDK archiver: $free2z_ndk_bin/llvm-ar" >&2
  return 1
}
unset free2z_compiler free2z_ndk_bin free2z_ndk_host
