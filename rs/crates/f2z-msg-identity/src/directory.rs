//! A directory submission, signed by the two seed-derived keys it needs —
//! `KT.md` §4.4's `auth_signature` and §4.5's identity binding — and nothing
//! else.
//!
//! [ADR 0017](../../../../docs/e2ee/decisions/0017-internal-directory-activation.md)
//! puts this here and not in the app that calls it, for the reason
//! [`crate::account`]'s key table gives: the `DirectoryAuthKey` and the
//! `IdentitySigningKey` expose no general `sign(&[u8])`, so every structure
//! either key signs has to be named in this crate. A submission needs both,
//! over two different structures, and building it anywhere else would mean
//! handing one of those keys out.
//!
//! ```text
//!   SubmissionDraft ──► DirectoryEntryTBS ──DirectoryAuthKey──► DirectoryEntry
//!                                                                    │
//!                                        entry_digest = H(value, entry bytes)
//!                                                                    │
//!   HandleAssertion (from the authority) ──digest──► AssertionBindingTBS
//!                                                                    │
//!                                                   IdentitySigningKey
//!                                                                    ▼
//!                                  SubmissionEnvelope { entry, assertion, sig }
//! ```
//!
//! # What this refuses, and why here
//!
//! Only what **this** crate can know is wrong without a network: a predecessor
//! whose keys are not this account's (that is a `key_change` or a
//! `platform_reset`, neither of which a routine enrollment may perform), a
//! first entry with no assertion and a routine entry with one (the log refuses
//! both, `f2z-authority` calls the second a category error), and an assertion
//! that does not decode canonically. Everything else — the authority's
//! signature, its validity window, its `log_id` — is the log's to decide and
//! the caller's to pre-check with `f2z_authority::AuthorityConfig`. This crate
//! does **no** signature verification (see the crate note), and that stays
//! true: nothing below verifies anything.

use alloc::vec::Vec;

use f2z_authority::assertion::{AssertionBindingTBS, HandleAssertion};
use f2z_authority::types::{Handle as AuthorityHandle, LogId as AuthorityLogId};
use f2z_codec::canonical::{Canonical as _, decode_canonical, encode};
use f2z_codec::types::{Digest, PublicKey};
use f2z_kt_core::KT_VERSION;
use f2z_kt_core::api::SubmissionEnvelope;
use f2z_kt_core::entry::{
    ContactEndpoint, DeviceCredential, DeviceRevocation, DirectoryEntry, DirectoryEntryTBS,
    EntryAuthorization, EntryKind, entry_label,
};
use f2z_kt_core::labels::entry_value;
use f2z_kt_core::types::{Handle, LogId};

use crate::account::{AccountKeys, IdentitySigningKey};
use crate::error::IdentityError;

/// What a caller knows before it signs: the handle, the devices and contact
/// endpoints to publish, and the entry this one follows, if any.
#[derive(Clone, Debug)]
pub struct SubmissionDraft<'a> {
    /// The log this entry is for (`KT.md` §6.1).
    pub log_id: LogId,
    /// The handle.
    pub handle: Handle,
    /// The device credentials in force after this entry. A routine update
    /// publishes the **whole** set: an entry replaces its predecessor's list,
    /// it does not append to it.
    pub devices: Vec<DeviceCredential>,
    /// The revocations published so far. §4.4 refuses an entry that drops one.
    pub revocations: Vec<DeviceRevocation>,
    /// Where first contact is delivered (`WIRE.md` §12.2). The first one wins
    /// (`ARCHITECTURE.md` §13-G, `k = 1`).
    pub contact_endpoints: Vec<ContactEndpoint>,
    /// The verified, published entry this one follows — `None` for a handle's
    /// first entry.
    pub predecessor: Option<&'a DirectoryEntry>,
    /// The submitter's clock (§4.2: authenticated, not trusted).
    pub created_at_ms: u64,
}

/// A signed submission, ready for `POST /kt/v1/submit`.
#[derive(Clone, PartialEq, Eq)]
pub struct SignedSubmission {
    /// The entry, as signed.
    pub entry: DirectoryEntry,
    /// `H("free2z/kt/v1/value", tls_codec(entry))` — the `AkdValue` the
    /// binding commits to and the receipt's `entry_hash` must equal.
    pub entry_digest: Digest,
    /// `tls_codec(SubmissionEnvelope)`.
    pub envelope: Vec<u8>,
}

/// Hand-written: a derived `Debug` would print `envelope` as a decimal byte
/// dump (`f2z-codec`'s documented trap), and the entry already renders.
impl core::fmt::Debug for SignedSubmission {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("SignedSubmission")
            .field("entry", &self.entry)
            .field("entry_digest", &self.entry_digest)
            .field("envelope", &format_args!("<{} bytes>", self.envelope.len()))
            .finish()
    }
}

impl SignedSubmission {
    /// The entry's `entry_version`.
    #[must_use]
    pub const fn entry_version(&self) -> u32 {
        self.entry.entry.entry_version
    }
}

impl IdentitySigningKey {
    /// Sign an `AssertionBindingTBS` — `f2z-authority`'s proof that the
    /// identity key a handle assertion names is the key presenting it.
    ///
    /// A typed method rather than a byte signer, for the reason this crate's
    /// key table gives. The binding's first field is its own label
    /// (`free2z/kt/v1/assertion-binding`), so these bytes cannot be confused
    /// with a `DeviceCredentialTBS` or a `RotationProofTBS`, whose labels differ.
    ///
    /// # Errors
    ///
    /// [`IdentityError::MalformedCredential`] if the binding cannot be encoded.
    pub fn sign_assertion_binding(
        &self,
        binding: &AssertionBindingTBS,
    ) -> Result<f2z_codec::types::Signature, IdentityError> {
        let bytes = encode(binding).map_err(|_| IdentityError::MalformedCredential)?;
        Ok(f2z_codec::types::Signature::new(
            ed25519_dalek::Signer::sign(self.signing_key(), &bytes).to_bytes(),
        ))
    }
}

impl AccountKeys {
    /// Build, sign and envelope one directory submission.
    ///
    /// `assertion` is the canonical `tls_codec(HandleAssertion)` the handle
    /// authority issued, **required** for a first entry and **refused** for a
    /// routine one — the same boundary `f2z-authority` draws and the log
    /// enforces.
    ///
    /// # Errors
    ///
    /// [`IdentityError::MalformedCredential`] when:
    ///
    /// - a first entry carries no assertion, or a routine one carries one;
    /// - the assertion does not decode canonically;
    /// - the predecessor's `identity_pk` or `directory_auth_pk` is not this
    ///   account's (that change is a `key_change` or a `platform_reset`, and
    ///   neither is an enrollment);
    /// - the predecessor names another handle or another log, or its version
    ///   is already `u32::MAX`;
    /// - any structure fails `KT.md` §4.1's shape rules, or will not encode.
    pub fn sign_directory_submission(
        &self,
        draft: &SubmissionDraft<'_>,
        assertion: Option<&[u8]>,
    ) -> Result<SignedSubmission, IdentityError> {
        let identity_pk = self.identity.public();
        let directory_auth_pk = self.directory_auth.public();

        let (entry_version, prev_entry_hash) = match draft.predecessor {
            None => (1, Digest::zero()),
            Some(previous) => {
                let before = &previous.entry;
                if before.identity_pk != identity_pk
                    || before.directory_auth_pk != directory_auth_pk
                    || before.handle != draft.handle
                    || before.log_id != draft.log_id
                {
                    return Err(IdentityError::MalformedCredential);
                }
                let version = before
                    .entry_version
                    .checked_add(1)
                    .ok_or(IdentityError::MalformedCredential)?;
                let chain = previous
                    .chain_hash()
                    .map_err(|_| IdentityError::MalformedCredential)?;
                (version, chain)
            }
        };

        // The log's boundary, restated where a mistake is cheapest to catch.
        let decoded = match (entry_version == 1, assertion) {
            (true, Some(bytes)) => Some(
                decode_canonical::<HandleAssertion>(bytes)
                    .map_err(|_| IdentityError::MalformedCredential)?
                    .into_value(),
            ),
            (false, None) => None,
            _ => return Err(IdentityError::MalformedCredential),
        };

        let tbs = DirectoryEntryTBS {
            label: entry_label().map_err(|_| IdentityError::MalformedCredential)?,
            kt_version: KT_VERSION,
            log_id: draft.log_id,
            handle: draft.handle.clone(),
            entry_version,
            kind: EntryKind::SameKey,
            identity_pk,
            directory_auth_pk,
            devices: draft.devices.clone().into(),
            revocations: draft.revocations.clone().into(),
            contact_endpoints: draft.contact_endpoints.clone().into(),
            prev_entry_hash,
            no_reset: 0,
            created_at_ms: draft.created_at_ms,
        };
        tbs.validate()
            .map_err(|_| IdentityError::MalformedCredential)?;

        let auth_signature = self.directory_auth.sign_directory_entry(&tbs)?;
        let entry = DirectoryEntry {
            entry: tbs,
            authorization: EntryAuthorization::SameKey { auth_signature },
        };
        let entry_bytes = entry
            .encode_canonical()
            .map_err(|_| IdentityError::MalformedCredential)?;
        let entry_digest = entry_value(&entry_bytes);

        let assertion_digest = match &decoded {
            Some(assertion) => assertion
                .digest()
                .map_err(|_| IdentityError::MalformedCredential)?,
            None => Digest::zero(),
        };
        let binding = AssertionBindingTBS::for_assertion(
            AuthorityLogId::new(*draft.log_id.as_bytes()),
            AuthorityHandle::parse(draft.handle.as_slice())
                .map_err(|_| IdentityError::MalformedCredential)?,
            identity_pk,
            assertion_digest,
            entry_digest,
        )
        .map_err(|_| IdentityError::MalformedCredential)?;
        let identity_signature = self.identity.sign_assertion_binding(&binding)?;

        let envelope = SubmissionEnvelope::new(&entry_bytes, assertion, identity_signature)
            .and_then(|envelope| envelope.encode_canonical().map_err(Into::into))
            .map_err(|_| IdentityError::MalformedCredential)?;

        Ok(SignedSubmission {
            entry,
            entry_digest,
            envelope,
        })
    }
}

/// Whether `entry` already publishes `device_pk` — the check that makes a
/// repeated enrollment a no-op rather than a second entry.
#[must_use]
pub fn publishes_device(entry: &DirectoryEntry, device_pk: &PublicKey) -> bool {
    entry
        .entry
        .devices
        .as_slice()
        .iter()
        .any(|credential| credential.credential.device_pk == *device_pk)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credential::DeviceCredentialRequest;
    use alloc::vec;
    use f2z_authority::{AssertionNonce, HandleAssertionTBS, Intent, SigningKey};
    use f2z_codec::types::{QueueAddress, RelayId, ShortBytes};
    use f2z_kt_core::types::KemPublicKey;

    const SEED: [u8; 32] = [7; 32];

    fn account() -> AccountKeys {
        AccountKeys::from_seed(&SEED, 0).unwrap()
    }

    fn handle() -> Handle {
        Handle::new(b"alice".to_vec()).unwrap()
    }

    fn log_id() -> LogId {
        LogId::new([9; 32])
    }

    fn credential(account: &AccountKeys, device: u8) -> DeviceCredential {
        account
            .identity
            .issue_device_credential(&DeviceCredentialRequest {
                handle: handle(),
                device_pk: PublicKey::new([device; 32]),
                device_kem_pk: KemPublicKey::new(vec![1, 2, 3]).unwrap(),
                not_before_ms: 1,
                not_after_ms: 10_000,
            })
            .unwrap()
    }

    fn endpoint() -> ContactEndpoint {
        ContactEndpoint {
            relay_url: ShortBytes::new(b"wss://relay.example/relay/v1".to_vec()).unwrap(),
            relay_id: RelayId::new([3; 32]),
            contact_addr: QueueAddress::new([4; 32]),
        }
    }

    fn assertion(account: &AccountKeys) -> Vec<u8> {
        let authority = SigningKey::from_seed(&[0x22; 32]);
        HandleAssertionTBS::new(
            &authority.public_key(),
            AuthorityLogId::new(*log_id().as_bytes()),
            AuthorityHandle::parse(b"alice").unwrap(),
            account.identity.public(),
            Intent::Bind,
            0,
            1_000,
            61_000,
            AssertionNonce::new([5; 16]),
        )
        .unwrap()
        .sign(&authority)
        .unwrap()
        .encode_canonical()
        .unwrap()
    }

    fn draft<'a>(
        account: &AccountKeys,
        predecessor: Option<&'a DirectoryEntry>,
    ) -> SubmissionDraft<'a> {
        SubmissionDraft {
            log_id: log_id(),
            handle: handle(),
            devices: vec![credential(account, 0x10)],
            revocations: Vec::new(),
            contact_endpoints: vec![endpoint()],
            predecessor,
            created_at_ms: 2_000,
        }
    }

    fn decoded_envelope(signed: &SignedSubmission) -> SubmissionEnvelope {
        decode_canonical::<SubmissionEnvelope>(&signed.envelope)
            .unwrap()
            .into_value()
    }

    #[test]
    fn a_first_entry_is_version_one_signed_by_both_seed_keys() {
        let account = account();
        let bytes = assertion(&account);
        let signed = account
            .sign_directory_submission(&draft(&account, None), Some(&bytes))
            .unwrap();

        assert_eq!(signed.entry_version(), 1);
        assert!(signed.entry.entry.prev_entry_hash.is_zero());
        assert_eq!(signed.entry.entry.identity_pk, account.identity.public());
        assert_eq!(
            signed.entry.entry.directory_auth_pk,
            account.directory_auth.public()
        );

        // The DirectoryAuthKey signed the TBS …
        let tbs = signed.entry.entry.signing_bytes().unwrap();
        f2z_kt_core::sig::verify(
            &account.directory_auth.public(),
            &tbs,
            signed.entry.authorization.auth_signature(),
        )
        .unwrap();

        // … and the identity key signed a binding over *this* entry and *this*
        // assertion, which is exactly what the log recomputes.
        let envelope = decoded_envelope(&signed);
        assert_eq!(envelope.assertion_bytes(), Some(bytes.as_slice()));
        assert_eq!(entry_value(envelope.entry.as_slice()), signed.entry_digest);
        let assertion = decode_canonical::<HandleAssertion>(&bytes)
            .unwrap()
            .into_value();
        let binding = AssertionBindingTBS::for_assertion(
            AuthorityLogId::new(*log_id().as_bytes()),
            AuthorityHandle::parse(b"alice").unwrap(),
            account.identity.public(),
            assertion.digest().unwrap(),
            signed.entry_digest,
        )
        .unwrap();
        f2z_kt_core::sig::verify(
            &account.identity.public(),
            &binding.signing_bytes().unwrap(),
            &envelope.identity_signature,
        )
        .unwrap();
    }

    #[test]
    fn the_binding_commits_to_the_assertion_so_a_swapped_one_does_not_verify() {
        // Mutation guard for `assertion_digest`: were it zeroed or taken from
        // somewhere else, this binding would still verify over the zero digest.
        let account = account();
        let bytes = assertion(&account);
        let signed = account
            .sign_directory_submission(&draft(&account, None), Some(&bytes))
            .unwrap();
        let unbound = AssertionBindingTBS::unvouched(
            AuthorityLogId::new(*log_id().as_bytes()),
            AuthorityHandle::parse(b"alice").unwrap(),
            account.identity.public(),
            signed.entry_digest,
        )
        .unwrap();
        assert!(
            f2z_kt_core::sig::verify(
                &account.identity.public(),
                &unbound.signing_bytes().unwrap(),
                &decoded_envelope(&signed).identity_signature,
            )
            .is_err()
        );
    }

    #[test]
    fn a_first_entry_without_an_assertion_is_refused_before_signing() {
        let account = account();
        assert_eq!(
            account.sign_directory_submission(&draft(&account, None), None),
            Err(IdentityError::MalformedCredential)
        );
    }

    #[test]
    fn a_routine_update_chains_to_its_predecessor_and_carries_no_assertion() {
        let account = account();
        let first = account
            .sign_directory_submission(&draft(&account, None), Some(&assertion(&account)))
            .unwrap();

        let mut next = draft(&account, Some(&first.entry));
        next.devices.push(credential(&account, 0x11));
        assert_eq!(
            account.sign_directory_submission(&next, Some(&assertion(&account))),
            Err(IdentityError::MalformedCredential),
            "a platform assertion on a routine entry is a category error"
        );

        let second = account.sign_directory_submission(&next, None).unwrap();
        assert_eq!(second.entry_version(), 2);
        assert_eq!(
            second.entry.entry.prev_entry_hash,
            first.entry.chain_hash().unwrap()
        );
        assert_eq!(decoded_envelope(&second).assertion_bytes(), None);
        assert!(publishes_device(&second.entry, &PublicKey::new([0x11; 32])));
        assert!(!publishes_device(&first.entry, &PublicKey::new([0x11; 32])));
    }

    #[test]
    fn a_predecessor_under_another_identity_is_not_an_enrollment() {
        let account = account();
        let other = AccountKeys::from_seed(&[8; 32], 0).unwrap();
        let theirs = other
            .sign_directory_submission(&draft(&other, None), Some(&assertion(&other)))
            .unwrap();
        assert_eq!(
            account.sign_directory_submission(&draft(&account, Some(&theirs.entry)), None),
            Err(IdentityError::MalformedCredential)
        );
    }

    #[test]
    fn a_predecessor_for_another_handle_or_log_is_refused() {
        let account = account();
        let first = account
            .sign_directory_submission(&draft(&account, None), Some(&assertion(&account)))
            .unwrap();

        let mut other_log = draft(&account, Some(&first.entry));
        other_log.log_id = LogId::new([1; 32]);
        assert!(account.sign_directory_submission(&other_log, None).is_err());

        let mut other_handle = draft(&account, Some(&first.entry));
        other_handle.handle = Handle::new(b"bob".to_vec()).unwrap();
        assert!(
            account
                .sign_directory_submission(&other_handle, None)
                .is_err()
        );
    }

    #[test]
    fn a_non_canonical_assertion_is_refused() {
        let account = account();
        let mut bytes = assertion(&account);
        bytes.push(0);
        assert_eq!(
            account.sign_directory_submission(&draft(&account, None), Some(&bytes)),
            Err(IdentityError::MalformedCredential)
        );
    }
}
