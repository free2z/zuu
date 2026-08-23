# Source this file from Bash before every Android build. Tauri supplies these
# values too, but explicit exports prevent a developer's stale cargo linker
# environment from silently selecting a different NDK or API level.
case "$(uname -s)" in
  Darwin) zuuli_ndk_host=darwin-x86_64 ;;
  Linux) zuuli_ndk_host=linux-x86_64 ;;
  *) echo "unsupported Android build host: $(uname -s)" >&2; return 1 ;;
esac

: "${ANDROID_HOME:?ANDROID_HOME must point at the Android SDK}"
export NDK_HOME="$ANDROID_HOME/ndk/27.0.12077973"
export ANDROID_NDK_HOME="$NDK_HOME"
zuuli_ndk_bin="$NDK_HOME/toolchains/llvm/prebuilt/$zuuli_ndk_host/bin"

export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$zuuli_ndk_bin/aarch64-linux-android29-clang"
export CARGO_TARGET_ARMV7_LINUX_ANDROIDEABI_LINKER="$zuuli_ndk_bin/armv7a-linux-androideabi29-clang"
export CARGO_TARGET_I686_LINUX_ANDROID_LINKER="$zuuli_ndk_bin/i686-linux-android29-clang"
export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER="$zuuli_ndk_bin/x86_64-linux-android29-clang"
export CC_aarch64_linux_android="$CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER"
export CC_armv7_linux_androideabi="$CARGO_TARGET_ARMV7_LINUX_ANDROIDEABI_LINKER"
export CC_i686_linux_android="$CARGO_TARGET_I686_LINUX_ANDROID_LINKER"
export CC_x86_64_linux_android="$CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER"
export CXX_aarch64_linux_android="${CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER}++"
export CXX_armv7_linux_androideabi="${CARGO_TARGET_ARMV7_LINUX_ANDROIDEABI_LINKER}++"
export CXX_i686_linux_android="${CARGO_TARGET_I686_LINUX_ANDROID_LINKER}++"
export CXX_x86_64_linux_android="${CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER}++"
export AR_aarch64_linux_android="$zuuli_ndk_bin/llvm-ar"
export AR_armv7_linux_androideabi="$zuuli_ndk_bin/llvm-ar"
export AR_i686_linux_android="$zuuli_ndk_bin/llvm-ar"
export AR_x86_64_linux_android="$zuuli_ndk_bin/llvm-ar"

for zuuli_compiler in \
  "$CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER" \
  "$CARGO_TARGET_ARMV7_LINUX_ANDROIDEABI_LINKER" \
  "$CARGO_TARGET_I686_LINUX_ANDROID_LINKER" \
  "$CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER"; do
  [[ -x "$zuuli_compiler" ]] || { echo "missing pinned NDK compiler: $zuuli_compiler" >&2; return 1; }
done
[[ -x "$zuuli_ndk_bin/llvm-ar" ]] || {
  echo "missing pinned NDK archiver: $zuuli_ndk_bin/llvm-ar" >&2
  return 1
}
unset zuuli_compiler zuuli_ndk_bin zuuli_ndk_host
