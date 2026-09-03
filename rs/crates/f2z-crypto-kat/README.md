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

The required `rs / tests` job executes this suite on GitHub's Ubuntu x86_64
host with the repository's pinned Rust toolchain and lockfile. It first requires
the openmls/libcrux package versions, sources, and checksums in `rs/Cargo.lock`
to match the independent messaging-plugin and ZUULI shipping lockfiles. Both
wallet lockfiles select this required job, so a wallet-only graph refresh cannot
leave the KAT running against an old graph. Before trusting
the live result, it copies the committed vectors, corrupts one X-Wing combiner
output, and requires the same test binary to fail for that exact mismatch.

That host run catches dependency-version regressions in the x86_64 path selected
on the runner. It does **not** execute the compile-time-selected NEON backend
shipped on aarch64 Android and iOS, and the workspace's wasm job does not run
Rust tests in a browser. A cross-compile would establish type and link
compatibility, not cryptographic execution, so this PR does not present one as
target KAT evidence. The permanent host gate closes the reproducibility hole;
runtime KATs on phone targets remain additional evidence when device CI exists.
