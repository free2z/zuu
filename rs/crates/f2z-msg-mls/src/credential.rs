//! `DeviceCredential` on the MLS side: parsing, the validity check, and the
//! binding to a leaf.
//!
//! `ARCHITECTURE.md` §4.2 defines the structure and `KT.md` §4.1 encodes it:
//!
//! ```text
//! DeviceCredential = {
//!   type:          "free2z/device-credential/v1",
//!   identity_pk:   ISK.public,
//!   handle:        "@alice",
//!   device_pk:     DSK.public,
//!   device_kem_pk: DeviceInitKey.public,
//!   not_before, not_after,
//!   signature:     Sign(ISK, canonical(everything above))
//! }
//! ```
//!
//! # There is exactly one definition of these bytes, and it is not here
//!
//! [`DeviceCredential`] and [`DeviceCredentialTBS`] are **`f2z-kt-core`'s**,
//! re-exported rather than restated, and `f2z-msg-identity` issues them with
//! `IdentitySigningKey::issue_device_credential`. This module owns none of the
//! structure and none of the issuance — it owns the *MLS-side obligation*: turn
//! the opaque identity string out of an MLS `BasicCredential` back into a
//! credential, check it, and check that it describes **this leaf's** signature
//! key.
//!
//! An earlier revision of this crate defined its own `DeviceCredential`, because
//! `f2z-msg-identity` had not landed when it was written. It has (#694), so this
//! is a thin adapter and the duplicate is gone. A construction crate, a
//! directory validator and an MLS engine that each owned a copy of the structure
//! would be one field-order edit away from issuing credentials the other two
//! reject, and the failure would land on users rather than on CI.
//!
//! # The binding is the part MLS adds
//!
//! `f2z-kt-core`'s `DeviceCredentialTBS::validate` checks the label, the handle
//! charset and the validity window; its §4.4 rules check the identity signature
//! at directory-submission time. **Neither can check the one thing an MLS peer
//! is in a position to check**: that `device_pk` is the `signature_key` of the
//! leaf the credential arrived in.
//!
//! That is the substitution the identity→device binding exists to stop — a
//! genuine, correctly-signed credential for Alice's phone, presented in a leaf
//! whose signature key belongs to somebody else. [`validate_for_leaf`] is that
//! check, and it is why §4.2 says the credential "is carried as the MLS
//! `Credential` in the member's `LeafNode`, so **every MLS peer validates the
//! identity→device binding as part of ordinary MLS processing**".
//!
//! # Why `CredentialType::Basic`
//!
//! RFC 9420's `BasicCredential` carries an opaque, application-defined identity
//! string, which is exactly what this is. The alternative — a private-use
//! `CredentialType` — would additionally require every member's `Capabilities`
//! to advertise that type, and buys nothing: a peer sending a *bare* handle in
//! a `BasicCredential` fails [`parse`] on the leading label
//! ([`CredentialError::WrongType`]), so a plain basic credential is rejected
//! either way. The credential type is recorded next to the group by
//! [`ProtocolVersion`](crate::ProtocolVersion), so moving to a registered
//! codepoint later is a migration rather than a fork.
//!
//! # Signature verification goes through `f2z-kt-core`
//!
//! `f2z_kt_core::sig::verify` uses `ed25519_dalek::verify_strict`, which rejects
//! small-order public keys and non-canonical encodings. Using it here rather
//! than a second verifier is the same argument as re-using the structure: an MLS
//! peer and the transparency log must agree about whether a credential is valid,
//! and two verifiers with different strictness are two answers waiting to
//! disagree.
//!
//! This is **not** in tension with #693 and ADR 0001's single crypto core.
//! `DeviceCredential`'s signature is an *identity*-domain signature that
//! `f2z-kt-core` already owns, verified by the same code the directory runs;
//! what #693 is about is MLS **framing**, which [`crate::DeviceSigner`] and
//! `openmls_libcrux_crypto` both do through libcrux.

use f2z_codec::canonical::{decode_canonical, encode as canonical_encode};

pub use f2z_kt_core::entry::{DeviceCredential, DeviceCredentialTBS};
/// The label every `DeviceCredential` carries, re-exported from the one place it
/// is defined.
///
/// A `free2z/` label, swept by `scripts/check-hash-domain-labels.mjs` along with
/// every other label in the tree. It is leafless —
/// `free2z/device-credential/v1` with no `/leaf` — which is the sharpest shape
/// the prefix-free rule exists for.
pub use f2z_kt_core::labels::LABEL_DEVICE_CREDENTIAL as DEVICE_CREDENTIAL_TYPE;

use crate::error::CredentialError;

/// Encode a credential for the MLS `BasicCredential` identity field.
///
/// # Errors
///
/// [`CredentialError::Malformed`] if the structure cannot be encoded.
pub fn encode(credential: &DeviceCredential) -> Result<Vec<u8>, CredentialError> {
    canonical_encode(credential).map_err(|_| CredentialError::Malformed)
}

/// Parse a credential out of an MLS `BasicCredential` identity string.
///
/// Decoding is `f2z-codec`'s **canonical** decode, so `WIRE.md` §3.3's
/// re-encode-equality rule applies: a credential that decodes but re-encodes to
/// different bytes is refused, and so are trailing bytes. Exactly one encoding,
/// or nothing.
///
/// # Errors
///
/// [`CredentialError::Malformed`] if the bytes are not a canonically encoded
/// credential, and [`CredentialError::WrongType`] if the leading label is not
/// [`DEVICE_CREDENTIAL_TYPE`] — which is what a *bare* handle in a
/// `BasicCredential` looks like from here.
pub fn parse(bytes: &[u8]) -> Result<DeviceCredential, CredentialError> {
    let credential = decode_canonical::<DeviceCredential>(bytes)
        .map_err(|_| CredentialError::Malformed)?
        .into_value();
    if credential.credential.label.as_slice() != DEVICE_CREDENTIAL_TYPE {
        return Err(CredentialError::WrongType);
    }
    Ok(credential)
}

/// Check everything about a credential that can be checked from the credential
/// alone: the label, the handle, the validity window and the identity signature.
///
/// This is **not sufficient**. A credential that passes every check here and
/// describes somebody else's device is exactly the substitution the binding
/// exists to stop — use [`validate_for_leaf`].
///
/// # Errors
///
/// A [`CredentialError`] naming the check that failed.
pub fn validate_at(credential: &DeviceCredential, now_ms: u64) -> Result<(), CredentialError> {
    // Label, handle charset, non-empty KEM key, and a forward-ordered window —
    // `KT.md` §4.1's structural rules, checked by the crate that owns them.
    credential
        .credential
        .validate()
        .map_err(|_| CredentialError::Malformed)?;

    // The window, against the caller's clock. `f2z-kt-core` is `no_std` with no
    // I/O and deliberately has no clock, so "is it valid *now*" is the caller's
    // question and this is where it is asked.
    if now_ms < credential.credential.not_before_ms || now_ms > credential.credential.not_after_ms {
        return Err(CredentialError::Expired);
    }

    let signing_bytes = credential
        .credential
        .signing_bytes()
        .map_err(|_| CredentialError::Malformed)?;

    f2z_kt_core::sig::verify(
        &credential.credential.identity_pk,
        &signing_bytes,
        &credential.signature,
    )
    .map_err(|_| CredentialError::BadSignature)
}

/// [`validate_at`], **and** the binding: that this credential's `device_pk` is
/// the leaf's MLS `signature_key`.
///
/// The order matters and is deliberate. The signature is checked before the
/// binding, so a credential whose `device_pk` was edited to match a leaf fails
/// on the signature rather than reaching the comparison — and the caller
/// therefore never sees [`CredentialError::DeviceKeyMismatch`] for a forgery,
/// only for a genuine credential presented on the wrong leaf.
///
/// # Errors
///
/// A [`CredentialError`] naming the check that failed;
/// [`CredentialError::DeviceKeyMismatch`] if the binding does not hold.
pub fn validate_for_leaf(
    credential: &DeviceCredential,
    leaf_signature_key: &[u8],
    now_ms: u64,
) -> Result<(), CredentialError> {
    validate_at(credential, now_ms)?;
    if credential.credential.device_pk.as_bytes() != leaf_signature_key {
        return Err(CredentialError::DeviceKeyMismatch);
    }
    Ok(())
}
