# Modern Rust cryptography target spike

Issue [#385](https://github.com/free2z/zuu/issues/385) asks two different
questions: whether a representative modern cryptography crate builds for the
targets ZUULI ships, and whether its runtime CPU dispatch is correct and fast on
physical mobile hardware. This tranche answers the compile question and retains
the runtime question as an explicit release residual.

## Representative dependency

`crypto-target-spike/Cargo.toml` pins `libcrux-ml-kem` 0.0.10 and its runtime
feature detector, `libcrux-platform` 0.0.3, exactly. The harness enables only
ML-KEM-768 and supplies fixed test bytes to key generation and encapsulation,
so it needs no operating-system random-number source. Those bytes are test data,
not a product key-generation design.

The probe validates the generated public and private keys, encapsulates, and
decapsulates a shared secret through the crate's normal multiplexed API. It also
records `libcrux-platform`'s 128- and 256-bit SIMD decisions. On AArch64,
libcrux's build script includes its NEON implementation and the platform crate
reports 128-bit SIMD support; on x86-64, the platform crate performs runtime
CPUID checks before the multiplexed API selects AVX2. The 32-bit ARM and x86
builds retain the portable implementation.

For each of the nine target-specific normal/build graphs, Cargo selects no
`cc`, bindgen, Clang, or C/C++ source compiler. The lockfile does contain those
crates behind libcrux's inactive `cfg(valgrind_ct_test)` constant-time testing
path, so inspecting the lockfile alone would overstate what a release build
runs. `libcrux-ml-kem` does have a Rust `build.rs`; it reads Cargo's target
architecture and emits the SIMD configuration described above.

## Compile matrix

The issue says "six shipping targets" but names five operating-system families.
The release workflows are more precise: macOS is universal and Android has four
ABIs. Required CI therefore builds the probe library with full release code
generation for all nine Rust triples below, using the repository's canonical
Rust 1.97.1 toolchain and this crate's independent lockfile.

| Release family | Rust target | Evidence boundary |
| --- | --- | --- |
| Linux | `x86_64-unknown-linux-gnu` | Release library build; hosted Linux runtime test |
| macOS | `aarch64-apple-darwin` | Release library build; hosted macOS runtime test on the runner host |
| macOS | `x86_64-apple-darwin` | Release library build |
| Windows | `x86_64-pc-windows-msvc` | Release library build; hosted Windows runtime test |
| iOS 18 device | `aarch64-apple-ios` | Release library build only |
| Android API 29 arm64 | `aarch64-linux-android` | Release library build only |
| Android API 29 ARMv7 | `armv7-linux-androideabi` | Release library build only |
| Android API 29 x86 | `i686-linux-android` | Release library build only |
| Android API 29 x86-64 | `x86_64-linux-android` | Release library build only |

The required job first verifies that its checkout is exactly GitHub's requested
commit and clean. Repository policy binds the complete job, target matrix,
probe source, manifest, and lockfile to reviewed digests; its adversarial tests
reject stale-source substitutions, target removal, skipped tests, dependency
drift, and detachment from the required gate.

## Verdict and residual

The pinned libcrux ML-KEM class is a viable **compile-time candidate** for every
Rust target ZUULI currently releases. The desktop hosted-runner tests additionally
show that the normal runtime-dispatched ML-KEM-768 path completes on Linux,
macOS, and Windows CI hosts. This is not an adoption decision and the harness is
not linked into the product.

This evidence does **not** establish any of the following:

- execution in a signed ZUULI build on a physical iPhone running iOS 18;
- execution in ZUULI on a physical Android API-29-or-newer device;
- whether the runtime-selected SIMD path is the expected path on either device;
- key generation, encapsulation, or decapsulation latency on the slowest
  available Android device; or
- packaged-app memory, binary-size, startup, or energy impact.

Issue #385 must remain open until a device harness invokes this exact probe from
signed iOS and Android builds and records the physical-device and slow-device
performance evidence.
