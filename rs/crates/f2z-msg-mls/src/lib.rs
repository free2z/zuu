//! The MLS engine for free2z messaging — RFC 9420, hybrid post-quantum, one
//! crypto core, and every state change atomic.
//!
//! `docs/e2ee/ARCHITECTURE.md` §5 is the specification; this is the
//! implementation of it. One MLS group per conversation or room, 1:1 included.
//!
//! # What is settled, and why it is not re-litigated here
//!
//! [#385](https://github.com/free2z/zuu/issues/385) proved, on real hardware,
//! that OpenMLS with the libcrux provider on
//! `MLS_256_XWING_CHACHA20POLY1305_SHA256_Ed25519` builds for all nine shipping
//! triples and runs green on Android API-29 against NIST ACVP ML-KEM vectors,
//! RFC 7748, RFC 8032 and draft-connolly-cfrg-xwing-06 Appendix C. KeyPackage
//! generation is 0.20 ms; the first commit is 1.35 ms. **That measurement was
//! against `openmls 0.8.1` / `openmls_libcrux_crypto 0.3.1`**, and this crate
//! is now on the 0.9 train; #723 re-ran what it could and recorded what it
//! could not. The *library choice* is what #385 settled, and that is not open.
//!
//! **`openmls >= 0.9.0` is a hard floor**, and it carries two defects rather
//! than one: every release before 0.8.1 has the High-severity MAC
//! authentication defect, and every release before 0.9.0 resolves to a
//! `libcrux-secrets 0.0.5` carrying RUSTSEC-2026-0212 — a constant-time
//! swap/select that can return **incorrect results on aarch64**, which is every
//! phone we ship to, underneath the AEAD we use. `rs/deny.toml` holds the floor
//! with `[[bans.deny]]` entries, because a version floor nobody enforces is a
//! comment — a `[patch.crates-io]`, a path dependency or a vendored copy all
//! walk under a manifest requirement without a word.
//!
//! # The four decisions this crate makes
//!
//! **1. One crypto core, actually.** [`DeviceSigner`] implements
//! `openmls_traits::signatures::Signer` over `libcrux-ed25519` — the same
//! functions `openmls_libcrux_crypto` itself calls — instead of taking
//! `openmls_basic_credential`, which signs with `ed25519-dalek` and `p256`
//! outside the libcrux provider. That is [#693](https://github.com/free2z/zuu/issues/693),
//! and this crate closes it. See [`signer`].
//!
//! **2. The credential is the binding.** §4.2's [`DeviceCredential`] is carried
//! as the MLS `Credential`, and every point where a credential enters a group —
//! an Add, a `Welcome`, a processed message — validates it *against the leaf's
//! signature key*. A credential that is internally valid but describes a
//! different device is exactly the substitution the binding exists to stop, and
//! it is the one check that cannot be made from the credential alone. See
//! [`credential`].
//!
//! **3. Every state change is atomic.** OpenMLS has no transaction API and
//! issues many storage calls per operation. `f2z-msg-store`'s transaction is
//! what makes `process_message` → `merge_staged_commit` → the application's own
//! durable record one unit, and every mutating method here opens one. Under
//! delete-on-ack a half-applied operation is data loss, not inconvenience. See
//! [`engine`].
//!
//! **4. `PrivateMessage`, always.** §5.3: all application payloads travel as
//! MLS `PrivateMessage`, which hides the content, the sender's leaf index and
//! the content type from the relay. There is no public-message path in this
//! engine.
//!
//! # What is open, and deliberately left open
//!
//! The ciphersuite codepoint `0x004D` is **not** an IANA assignment (§13-B) and
//! will likely be relabelled. #385 checked the bytes rather than the label:
//! X-Wing draft-06 and draft-10 Appendix C vectors are byte-identical, so this
//! is a naming risk and not a re-key. A [`ProtocolVersion`] is therefore stored
//! beside every group, so a future relabel is a migration someone can write.
//! See [`version`].
//!
//! # Example
//!
//! ```no_run
//! use f2z_msg_mls::{DeviceCredential, DeviceSigner, MlsEngine};
//! use f2z_msg_store::MemoryBackend;
//!
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! # fn issue(device_pk: &[u8; 32]) -> DeviceCredential { unimplemented!() }
//! # let now = 1_700_000_000_000;
//! // The device signing key is generated on-device from the OS CSPRNG and is
//! // deliberately not seed-derivable (`ARCHITECTURE.md` §4.2).
//! let signer = DeviceSigner::from_private_key([2u8; 32])?;
//!
//! // The credential is issued by `f2z-msg-identity`'s `IdentitySigningKey`,
//! // which holds the seed-derived account key. This crate never issues one.
//! let credential = issue(signer.public_key());
//!
//! let engine = MlsEngine::new(MemoryBackend::new(), signer, credential, now)?;
//! let mut group = engine.create_group(b"conversation-1")?;
//! let wire = engine.send(&mut group, b"hello")?;
//! # Ok(())
//! # }
//! ```

#![forbid(unsafe_code)]
// The workspace denies these because a panic inside a crypto core is a crash of
// the whole client. Neither hazard exists in a test harness run on the host by
// a person reading the failure, and the same `cfg_attr` sits at the root of
// `f2z-authority` and `f2z-relay-store` for the same reason.
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing,
        clippy::arithmetic_side_effects
    )
)]

pub mod credential;
pub mod engine;
pub mod error;
pub mod exporter;
pub mod keypackage;
pub mod provider;
pub mod signer;
pub mod version;

pub use credential::{
    DEVICE_CREDENTIAL_TYPE, DeviceCredential, DeviceCredentialTBS, validate_at, validate_for_leaf,
};
pub use engine::{CIPHERSUITE, MlsEngine, Received};
pub use error::{CredentialError, EngineError, Result};
pub use exporter::ExportLabel;
pub use keypackage::VerifiedKeyPackage;
pub use provider::F2zProvider;
pub use signer::DeviceSigner;
pub use version::{ProtocolVersion, XWING_CIPHERSUITE_CODEPOINT};
