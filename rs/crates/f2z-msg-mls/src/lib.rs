//! The MLS engine for free2z messaging — RFC 9420, hybrid post-quantum, one
//! crypto core, and every state change atomic.
//!
//! `docs/e2ee/ARCHITECTURE.md` §5 is the specification; this is the
//! implementation of it. One MLS group per conversation or room, 1:1 included.
//!
//! # What is settled, and why it is not re-litigated here
//!
//! [#385](https://github.com/free2z/zuu/issues/385) proved, on real hardware,
//! that `openmls 0.8.1` with `openmls_libcrux_crypto 0.3.1` on
//! `MLS_256_XWING_CHACHA20POLY1305_SHA256_Ed25519` builds for all nine shipping
//! triples and runs green on Android API-29 against NIST ACVP ML-KEM vectors,
//! RFC 7748, RFC 8032 and draft-connolly-cfrg-xwing-06 Appendix C. KeyPackage
//! generation is 0.20 ms; the first commit is 1.35 ms. Those versions are the
//! ones this crate pins and the choice is not open.
//!
//! **`openmls >= 0.8.1` is a hard floor**: every earlier release carries the
//! High-severity MAC authentication defect. `rs/deny.toml` holds the floor with
//! a `[[bans.deny]]` entry, because a version floor nobody enforces is a
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
//! use f2z_msg_mls::{DeviceCredential, DeviceCredentialTbs, DeviceSigner, MlsEngine};
//! use f2z_msg_store::MemoryBackend;
//!
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! # let identity_private = [1u8; 32];
//! # let mut identity_public = [0u8; 32];
//! # libcrux_ed25519::secret_to_public(&mut identity_public, &identity_private);
//! # let now = 1_700_000_000_000;
//! let signer = DeviceSigner::from_private_key([2u8; 32]);
//! let tbs = DeviceCredentialTbs::new(
//!     &identity_public, "alice", signer.public_key(), &[0; 1216], 0, u64::MAX,
//! )?;
//! let credential = DeviceCredential::sign(tbs, &identity_private)?;
//!
//! let engine = MlsEngine::new(MemoryBackend::new(), signer, credential, now)?;
//! let mut group = engine.create_group(b"conversation-1")?;
//! let wire = engine.send(&mut group, b"hello")?;
//! # Ok(())
//! # }
//! ```

#![forbid(unsafe_code)]

pub mod credential;
pub mod engine;
pub mod error;
pub mod exporter;
pub mod provider;
pub mod signer;
pub mod version;

pub use credential::{
    DEVICE_CREDENTIAL_TYPE, DeviceCredential, DeviceCredentialTbs, MAX_HANDLE_LEN,
};
pub use engine::{CIPHERSUITE, MlsEngine, Received};
pub use error::{CredentialError, EngineError, Result};
pub use exporter::ExportLabel;
pub use provider::F2zProvider;
pub use signer::{DeviceSigner, verify};
pub use version::{ProtocolVersion, XWING_CIPHERSUITE_CODEPOINT};
