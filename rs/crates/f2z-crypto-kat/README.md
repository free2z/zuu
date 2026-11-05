# f2z-crypto-kat

This crate makes the dependency-validation evidence behind free2z's hybrid
messaging ciphersuite reproducible. It calls the exact libcrux crates resolved
in `rs/Cargo.lock` and compares their bytes with standards-publisher vectors:

- NIST ACVP ML-KEM-768 key generation, encapsulation, and decapsulation;
- RFC 7748 X25519, in both agreement directions, plus free2z's stricter policy
  of refusing an all-zero result from a low-order public input (the RFC permits
  this check but does not mandate it);
- RFC 8032 Ed25519 TEST 1 and TEST 2, exact public keys and signatures, one-bit
  tamper refusal, and refusal of an all-zero signing seed at the shipping
  `DeviceSigner` boundary used by enrollment and restore;
- all three X-Wing draft-06 Appendix C vectors, including exact public key,
  ciphertext, and 32-byte combiner output, followed by decapsulation.

See [`vectors/README.md`](vectors/README.md) for provenance and licensing.

## What CI proves, and what it does not

The required `rs / tests` job runs this suite on Ubuntu x86_64 with the
repository's pinned Rust toolchain and lockfile. A second required lane runs it
on GitHub's native Ubuntu ARM64 runner. Both lanes first require the
openmls/libcrux package versions, sources, and checksums in `rs/Cargo.lock` to
match the independent messaging-plugin and ZUULI shipping lockfiles. The shared
change selector includes both wallet lockfiles and all relevant manifests,
source, and toolchain pins, so a wallet-only graph refresh cannot leave either
KAT lane testing an old graph. Each lane corrupts one X-Wing combiner output
and requires the test binary to reject that exact mismatch before running all
committed vectors.

The ARM lane fails unless the runner and rustc host are Linux aarch64, rustc
reports its default `neon` target feature, and every runtime CPU feature row
reports ASIMD or NEON. The lane also runs a focused verifier self-test covering
missing NEON, wrong host/target, feature overrides, malformed or absent current
build evidence, stale test executables, and valid ARM evidence. Before the live
KAT run, it clears only the selected `libcrux-ml-kem` package artifacts. That
run emits Cargo JSON which binds the selected, locked libcrux package's current
`simd128` build-script event to the rebuilt `f2z-crypto-kat` test executable.
The verifier checks that executable's ELF machine is AArch64 and locates it
under Cargo's active target directory, including when Cargo target-directory
configuration is used. A stale `simd128` marker from another package or an old
build cannot satisfy the check.

This verifies the compile-time-selected ARM backend and its execution on a
native ARM host; it is not an Android or iOS device run. The workspace's wasm
job builds client libraries but does not execute these Rust tests in a browser.
Browser/WASM and on-device Android/iOS KAT execution remain uncovered.
