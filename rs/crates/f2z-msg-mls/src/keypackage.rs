//! Fetching a peer's `KeyPackage`, and the check that makes it safe to use.
//!
//! `WIRE.md` §12.6 puts a device's key packages at a **relay**, keyed by the
//! `contact_addr` its directory entry already publishes. The relay is not
//! trusted with them — it cannot parse one, it cannot make one, and it is
//! assumed to be hostile ([`THREAT-MODEL.md` §3.3][tm33]). What makes that
//! sound is this module: a fetched key package is authenticated **against the
//! directory entry the key-transparency log proved**, and a package that does
//! not match it is refused.
//!
//! # Why the check has to be structural
//!
//! `ARCHITECTURE.md` §9.1 states the whole problem the directory exists for:
//!
//! > Any directory that maps `@handle → identity key` and is trusted blindly
//! > reintroduces exactly that MITM, one level up. Encrypting perfectly to the
//! > wrong key is not security.
//!
//! A key package fetched from a relay and used unchecked is that sentence with
//! "relay" substituted for "directory". The relay would choose whose init key
//! the `Welcome` is encrypted to, which is [#133][i133] reintroduced at the one
//! moment the whole design is about.
//!
//! So there is no way to reach [`MlsEngine::add_member`] without one of these.
//! [`VerifiedKeyPackage`] has no public constructor and no public fields; the
//! only way to obtain one is [`VerifiedKeyPackage::verify`], which takes the
//! directory entry. That is this repository's *one door and no windows* idiom —
//! the same shape `f2z-relay-store`'s `Committed` and `f2z-kt`'s
//! `AdmittedSubmission` use — and it is used here because "remember to check
//! the credential" is exactly the kind of rule that survives review and does
//! not survive the next refactor.
//!
//! # What is checked, and what each check stops
//!
//! | Check | Without it |
//! |---|---|
//! | OpenMLS's own `KeyPackage::validate` | A package whose signature, lifetime or init/encryption keys are wrong is proposed to a group that will reject the commit. |
//! | The ciphersuite is [`CIPHERSUITE`] | A downgrade to a non-hybrid suite, chosen by whoever served the package. |
//! | The credential parses as a `DeviceCredential` | A bare handle in a `BasicCredential`, which binds nothing. |
//! | The credential's signature verifies under the **directory's** `identity_pk` | **The MITM.** Any relay-chosen package. |
//! | The credential's `handle` is the entry's handle | A genuine credential for a different person, served for this handle. |
//! | `device_pk` is a device the entry publishes | A genuine credential the owner has not put in the directory — an old one, or one issued to a device the identity key signed for and then withdrew. |
//! | `device_pk` is not in the entry's `revocations` | A stolen device that is still able to receive first contact after the owner published the revocation. |
//! | The leaf's `signature_key` is the credential's `device_pk` | A genuine credential presented in somebody else's leaf — the substitution the identity→device binding of §4.2 exists to stop. |
//!
//! The last one is [`crate::credential::validate_for_leaf`]'s and is not
//! restated here; the rest are.
//!
//! # What is deliberately *not* checked
//!
//! **Whether this is the package of last resort.** It is reported
//! ([`VerifiedKeyPackage::last_resort`]) and it is never a reason to refuse. A
//! last-resort package is a correctly signed package from the right device, and
//! the only thing wrong with it is that it may be reused — a real cost, stated
//! in [`THREAT-MODEL.md` §4.12][tm412], and one this layer must not silently
//! turn into a failure to reach somebody.
//!
//! Note that the flag is read **out of the package's own signed extensions**,
//! not out of the relay's `last_resort` response byte. The relay's byte is
//! advisory and unauthenticated; this one the device signed.
//!
//! [tm33]: https://github.com/free2z/zuu/blob/main/docs/e2ee/THREAT-MODEL.md#33-compromised-relay-operator-third-party-or-ours
//! [tm412]: https://github.com/free2z/zuu/blob/main/docs/e2ee/THREAT-MODEL.md
//! [i133]: https://github.com/free2z/zuu/issues/133
//! [`MlsEngine::add_member`]: crate::MlsEngine::add_member

use f2z_kt_core::entry::DirectoryEntryTBS;
use openmls::prelude::tls_codec::DeserializeBytes as _;
use openmls::prelude::{KeyPackage, MlsMessageBodyIn, MlsMessageIn, ProtocolVersion};
use openmls_traits::crypto::OpenMlsCrypto;
use std::time::{Duration, UNIX_EPOCH};

use crate::credential::{parse as parse_credential, validate_for_leaf};
use crate::engine::CIPHERSUITE;
use crate::error::{CredentialError, EngineError, Result};

/// A peer's `KeyPackage`, checked against the directory entry that vouches for
/// it.
///
/// Constructible only through [`VerifiedKeyPackage::verify`]. That is the
/// point: [`crate::MlsEngine::add_member`] takes one of these, so there is no
/// path from *bytes a relay handed us* to *a member of a group* that does not
/// pass through the directory.
#[derive(Clone)]
pub struct VerifiedKeyPackage {
    key_package: KeyPackage,
    device_pk: [u8; 32],
    last_resort: bool,
}

/// Hand-written, because a derived one would render `device_pk` as a list of
/// decimal integers — a dump containing no hex at all, which is precisely the
/// trap `f2z-codec`'s redaction tests are written around. A device key
/// identifies a device to anyone who has seen it elsewhere; the only field here
/// that is policy rather than material is the last-resort flag.
impl core::fmt::Debug for VerifiedKeyPackage {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("VerifiedKeyPackage")
            .field("device_pk", &"<redacted; 32 bytes>")
            .field("last_resort", &self.last_resort)
            .finish_non_exhaustive()
    }
}

impl VerifiedKeyPackage {
    /// Check a fetched key package against a directory entry.
    ///
    /// `entry` is the `DirectoryEntryTBS` a key-transparency lookup proved —
    /// **the verified one**, not a copy of it a caller assembled. Everything
    /// this function trusts comes from there: the identity key, the handle, the
    /// published device set and the revocations.
    ///
    /// # Errors
    ///
    /// [`EngineError::Mls`] if the bytes are not a key package, do not validate
    /// under RFC 9420, or use a ciphersuite other than [`CIPHERSUITE`];
    /// [`EngineError::Credential`] if the credential does not parse, does not
    /// verify under the entry's identity key, names a different handle,
    /// describes a device the entry does not publish, describes a revoked
    /// device, or does not bind to the leaf it arrived in.
    pub fn verify(
        wire: &[u8],
        entry: &DirectoryEntryTBS,
        crypto: &impl OpenMlsCrypto,
        now_ms: u64,
    ) -> Result<Self> {
        let key_package = parse(wire, crypto)?;

        // A relay that could choose the ciphersuite could choose a weaker one.
        // §5.2 fixes exactly one, and #385's whole hybrid-PQ argument is about
        // that one.
        if key_package.ciphersuite() != CIPHERSUITE {
            return Err(EngineError::Mls("key package ciphersuite"));
        }

        let leaf = key_package.leaf_node();
        let identity = crate::engine::basic_credential_identity(leaf.credential())?;
        let credential = parse_credential(identity)?;

        // The binding, the identity signature, the label, the charset and the
        // validity window — `credential`'s job, not restated here.
        validate_for_leaf(&credential, leaf.signature_key().as_slice(), now_ms)?;

        // **This is the check the whole module exists for.** The signature
        // above verified under the key *inside the credential*; nothing so far
        // has said that key is the one the log proved for this handle. A relay
        // that made up an identity key, issued itself a credential under it and
        // signed a key package with the matching device key passes everything
        // above and fails here.
        if credential.credential.identity_pk != entry.identity_pk {
            return Err(EngineError::Credential(CredentialError::BadSignature));
        }
        if credential.credential.handle != entry.handle {
            return Err(EngineError::Credential(CredentialError::InvalidHandle));
        }

        // The entry publishes the device set. A credential the identity key
        // signed but the owner never published — an old one, or one for a
        // device since withdrawn — is not a device this handle speaks through.
        let device_pk = credential.credential.device_pk;
        if !entry
            .devices
            .as_slice()
            .iter()
            .any(|published| published.credential.device_pk == device_pk)
        {
            return Err(EngineError::Credential(CredentialError::DeviceKeyMismatch));
        }
        if entry
            .revocations
            .as_slice()
            .iter()
            .any(|revoked| revoked.device_pk == device_pk)
        {
            return Err(EngineError::Credential(CredentialError::DeviceKeyMismatch));
        }

        Ok(Self {
            last_resort: key_package.last_resort(),
            device_pk: *device_pk.as_bytes(),
            key_package,
        })
    }

    /// Whether this is the reusable package of last resort — read from the
    /// package's own signed extensions, never from the relay's advisory byte.
    ///
    /// **Advisory to the caller too.** A hostile relay that holds a full pool
    /// can serve the last-resort package anyway, so a `false` here proves
    /// forward secrecy and a `true` proves nothing beyond what the device
    /// signed. `THREAT-MODEL.md` §4.13.
    #[must_use]
    pub const fn last_resort(&self) -> bool {
        self.last_resort
    }

    /// The device this package belongs to — `DSK.public`, and the leaf
    /// `signature_key` the peer will sign with.
    #[must_use]
    pub const fn device_pk(&self) -> &[u8; 32] {
        &self.device_pk
    }

    /// Check this package's signed MLS lifetime at an explicit Unix time.
    ///
    /// This complements verification's wall-clock check for clients that
    /// schedule replacement ahead of expiry and need to prove the replacement
    /// covers the boundary they persisted.
    pub fn lifetime_valid_at(&self, unix_seconds: u64) -> Result<()> {
        let at = UNIX_EPOCH
            .checked_add(Duration::from_secs(unix_seconds))
            .ok_or(EngineError::Mls("key package lifetime timestamp"))?;
        self.key_package
            .life_time()
            .validate_with_time(at)
            .map_err(|_| EngineError::Mls("key package lifetime"))
    }

    pub(crate) const fn inner(&self) -> &KeyPackage {
        &self.key_package
    }
}

fn parse(wire: &[u8], crypto: &impl OpenMlsCrypto) -> Result<KeyPackage> {
    let (message, rest) = MlsMessageIn::tls_deserialize_bytes(wire)
        .map_err(|_| EngineError::Mls("key package deserialisation"))?;
    if !rest.is_empty() {
        // §3.3's rule applied to MLS framing: exactly one encoding, or nothing,
        // so a relay cannot append a byte and have two implementations disagree
        // about what it served.
        return Err(EngineError::Mls("trailing bytes after a key package"));
    }
    match message.extract() {
        // `validate` and not `into`: it checks the key package's own signature,
        // the leaf node's signature, the lifetime, the extensions and that the
        // init key differs from the encryption key.
        MlsMessageBodyIn::KeyPackage(key_package) => key_package
            .validate(crypto, ProtocolVersion::Mls10)
            .map_err(|_| EngineError::Mls("key package validation")),
        _ => Err(EngineError::Mls("expected a key package")),
    }
}
