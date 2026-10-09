# OpenMLS libcrux provider source bridge

This package is a local security bridge based on the published
`openmls_libcrux_crypto 0.4.0` crate (crates.io checksum
`41e6367fb30f91f21e4d30f4f58a8d3b41f96f55c3e4b5acfa1d6d18c9dd4855`). The
source came from OpenMLS commit
`3a3e35de3feeca8f6605143c464d5452ae584d43`, recorded by the published package
in `.cargo_vcs_info.json`. Its upstream MIT license is retained in `LICENSE`.
`Cargo.toml.orig` preserves the published source manifest.

The tracked package version is `0.4.1` to identify this local adaptation; it is
not an upstream release. `Cargo.toml` raises the Rust floor to this repository's
pinned toolchain and updates only dependency requirements needed to resolve
patched libcrux and HPKE releases. `src/crypto.rs` adapts the provider's HMAC
call to the output-buffer API in `libcrux-hmac 0.0.9`; output lengths match the
SHA-2 digest selected by OpenMLS. It also rejects small-order Ed25519 public
keys and signature `R` before delegating the signature equation to libcrux.
The checksum-verified `libcrux-ed25519 0.0.10` verifier does not reject those
weak points itself, so without this check an identity public key accepts
signatures for arbitrary messages. The provider integration test exercises a
valid signature and the identity-key forgery; the workspace strict-verification
census binds the guard and verifier call order.

The bridge retires when upstream publishes a provider release whose actual
manifest, source and lock graph select `libcrux-hmac-drbg >=0.0.2`, the HPKE
0.8 family, and `libcrux-kem >=0.0.10`, and whose Ed25519 verifier rejects
small-order public keys and signature `R` before the libcrux equation verifier.

See `docs/DEPENDENCIES.md` for the enforced registration and exit condition.
