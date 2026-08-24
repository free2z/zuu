//! Deterministic builders for the crate's own tests.
//!
//! `#[cfg(test)]` only, and deliberately so: shipping a fixture builder would
//! ship a way to construct a plausible directory entry, and the whole design of
//! [`crate::submit`] is that the only route to a validated entry is through
//! validation. Nothing here is reachable from a release build.
//!
//! Every key is derived from a `u8` seed so the tests carry no randomness and no
//! clock. That matters more than convenience: a signature test that depends on
//! entropy is a test whose failures cannot be reproduced from the failure
//! message.

use ed25519_dalek::{Signer as _, SigningKey};
use f2z_codec::types::{Digest, PublicKey, QueueAddress, RelayId, ShortBytes, Signature};
use f2z_codec::vec::{VecU8, VecU16};

use crate::KT_VERSION;
use crate::cosign::{WitnessCosignature, WitnessCosignatureTBS};
use crate::descriptor::{CONFIGURATION_WHATSAPP_V1, LogDescriptor, SignedLogDescriptor};
use crate::entry::{
    ContactEndpoint, DeviceCredential, DeviceCredentialTBS, DirectoryEntry, DirectoryEntryTBS,
    EntryAuthorization, EntryKind, ResetAuthorization, ResetAuthorizationTBS, RotationProof,
    RotationProofTBS,
};
use crate::labels;
use crate::receipt::{SubmissionReceipt, SubmissionReceiptTBS};
use crate::sth::{SignedTreeHead, SignedTreeHeadTBS};
use crate::submit::LogPolicy;
use crate::types::{Handle, KemPublicKey, LogId};

/// A deterministic Ed25519 key from a one-byte seed.
pub(crate) fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

/// The public half.
pub(crate) fn public_key_of(key: &SigningKey) -> PublicKey {
    PublicKey::new(key.verifying_key().to_bytes())
}

/// Sign a message.
pub(crate) fn sign(key: &SigningKey, message: &[u8]) -> Signature {
    Signature::new(key.sign(message).to_bytes())
}

fn short(bytes: &[u8]) -> ShortBytes {
    ShortBytes::new(bytes.to_vec()).expect("a test constant shorter than 256 bytes")
}

/// ADR 0014's proposed cooldown: seven days.
pub(crate) const RESET_COOLDOWN_SECONDS: u32 = 7 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// A log: tree heads, cosignatures, receipts, a descriptor.
// ---------------------------------------------------------------------------

/// A test log with one signing key, a fixed VRF key and a chain of tree heads.
pub(crate) struct TestLog {
    log_key: SigningKey,
    reset_authority: SigningKey,
    log_id: LogId,
    log_pk: PublicKey,
    vrf_public_key: PublicKey,
    reset_authority_pk: PublicKey,
}

impl TestLog {
    pub(crate) fn new() -> Self {
        let log_key = signing_key(0x10);
        let reset_authority = signing_key(0x20);
        let log_pk = public_key_of(&log_key);
        Self {
            log_id: labels::log_id(&log_pk),
            log_pk,
            vrf_public_key: PublicKey::new([0x33; 32]),
            reset_authority_pk: public_key_of(&reset_authority),
            log_key,
            reset_authority,
        }
    }

    pub(crate) const fn log_id(&self) -> &LogId {
        &self.log_id
    }

    pub(crate) const fn log_pk(&self) -> &PublicKey {
        &self.log_pk
    }

    pub(crate) const fn reset_authority_pk(&self) -> &PublicKey {
        &self.reset_authority_pk
    }

    /// The witness key for a seed.
    pub(crate) fn witness_pk(&self, seed: u8) -> PublicKey {
        public_key_of(&signing_key(seed))
    }

    fn head_tbs(&self, epoch: u64) -> SignedTreeHeadTBS {
        let prev_sth_hash = match epoch.checked_sub(1) {
            None => Digest::zero(),
            Some(previous) => self
                .head_tbs(previous)
                .chain_hash()
                .expect("a test tree head encodes"),
        };
        SignedTreeHeadTBS {
            label: short(labels::LABEL_STH),
            kt_version: KT_VERSION,
            log_id: self.log_id,
            epoch,
            tree_size: epoch.saturating_mul(10),
            root_hash: Digest::new([u8::try_from(epoch % 251).unwrap_or(0); 32]),
            prev_sth_hash,
            vrf_public_key: self.vrf_public_key,
            published_at_ms: 1_700_000_000_000u64.saturating_add(epoch.saturating_mul(600_000)),
            reset_count: 0,
            epoch_interval_seconds: 600,
            max_merge_delay_seconds: 3_600,
            successor_log_pk: PublicKey::zero(),
        }
    }

    /// The honest tree head at `epoch`, correctly chained to its predecessor.
    pub(crate) fn head(&self, epoch: u64) -> SignedTreeHead {
        self.sign_head(self.head_tbs(epoch))
    }

    fn sign_head(&self, sth: SignedTreeHeadTBS) -> SignedTreeHead {
        let signature = sign(
            &self.log_key,
            &sth.signing_bytes().expect("a test tree head encodes"),
        );
        SignedTreeHead { sth, signature }
    }

    /// Re-sign a head whose contents a test has edited, so the test is about the
    /// edit rather than about a broken signature.
    pub(crate) fn resign(&self, head: SignedTreeHead) -> SignedTreeHead {
        self.sign_head(head.sth)
    }

    /// A cosignature over `head` by the witness with this seed.
    pub(crate) fn cosign(
        &self,
        head: &SignedTreeHead,
        witness_seed: u8,
        observed_at_ms: u64,
    ) -> WitnessCosignature {
        let key = signing_key(witness_seed);
        let statement = WitnessCosignatureTBS {
            label: short(labels::LABEL_COSIG),
            kt_version: KT_VERSION,
            log_id: head.sth.log_id,
            epoch: head.sth.epoch,
            tree_size: head.sth.tree_size,
            root_hash: head.sth.root_hash,
            witness_pk: public_key_of(&key),
            observed_at_ms,
        };
        let signature = sign(
            &key,
            &statement.signing_bytes().expect("a cosignature encodes"),
        );
        WitnessCosignature {
            statement,
            signature,
        }
    }

    /// A submission receipt.
    pub(crate) fn receipt(
        &self,
        entry_hash: Digest,
        entry_version: u32,
        received_at_ms: u64,
        merge_by_ms: u64,
    ) -> SubmissionReceipt {
        let receipt = SubmissionReceiptTBS {
            label: short(labels::LABEL_RECEIPT),
            kt_version: KT_VERSION,
            log_id: self.log_id,
            handle: Handle::new(b"alice".to_vec()).expect("a valid handle"),
            entry_version,
            entry_hash,
            received_at_ms,
            merge_by_ms,
        };
        let signature = sign(
            &self.log_key,
            &receipt.signing_bytes().expect("a receipt encodes"),
        );
        SubmissionReceipt { receipt, signature }
    }

    /// A signed log descriptor.
    pub(crate) fn descriptor(&self) -> SignedLogDescriptor {
        let descriptor = LogDescriptor {
            kt_versions: VecU8::new(vec![KT_VERSION]),
            log_id: self.log_id,
            log_signing_pk: self.log_pk,
            genesis_log_pk: self.log_pk,
            vrf_public_key: self.vrf_public_key,
            configuration: CONFIGURATION_WHATSAPP_V1,
            epoch_interval_seconds: 600,
            max_merge_delay_seconds: 3_600,
            reset_cooldown_seconds: RESET_COOLDOWN_SECONDS,
            reset_authority_pk: self.reset_authority_pk,
            operator_name: short(b"free2z"),
            operator_contact: short(b"kt@free2z.example"),
            operator_jurisdiction: short(b"nowhere"),
            operator_policy_url: short(b"https://free2z.example/kt"),
            source_repo_url: short(b"https://github.com/free2z/zuu"),
            source_commit: short(b"0000000000000000000000000000000000000000"),
            build_digest: short(b"sha256:0"),
            published_at_ms: 1_700_000_000_000,
        };
        let signature = sign(
            &self.log_key,
            &descriptor.signing_bytes().expect("a descriptor encodes"),
        );
        SignedLogDescriptor {
            descriptor,
            signature,
        }
    }

    /// The reset authority's signing key, for the directory builder.
    pub(crate) const fn reset_authority(&self) -> &SigningKey {
        &self.reset_authority
    }
}

// ---------------------------------------------------------------------------
// A directory: entries for one handle, in every authorization shape.
// ---------------------------------------------------------------------------

/// A test directory for one handle, holding its identity, directory-auth and
/// device keys.
pub(crate) struct TestDirectory {
    log: TestLog,
    handle: Handle,
    identity_key: SigningKey,
    auth_key: SigningKey,
    device_key: SigningKey,
}

impl TestDirectory {
    pub(crate) fn new() -> Self {
        Self::for_handle(b"alice")
    }

    pub(crate) fn for_handle(handle: &[u8]) -> Self {
        Self {
            log: TestLog::new(),
            handle: Handle::new(handle.to_vec()).expect("a valid test handle"),
            identity_key: signing_key(0x41),
            auth_key: signing_key(0x42),
            device_key: signing_key(0x43),
        }
    }

    pub(crate) fn identity_key(&self) -> SigningKey {
        self.identity_key.clone()
    }

    /// The policy `validate_submission` judges against.
    pub(crate) fn policy(&self) -> LogPolicy {
        LogPolicy::new(
            *self.log.log_id(),
            *self.log.reset_authority_pk(),
            RESET_COOLDOWN_SECONDS,
        )
    }

    fn credential(&self, identity: &SigningKey, signer: &SigningKey) -> DeviceCredential {
        let credential = DeviceCredentialTBS {
            label: short(labels::LABEL_DEVICE_CREDENTIAL),
            identity_pk: public_key_of(identity),
            handle: self.handle.clone(),
            device_pk: public_key_of(&self.device_key),
            device_kem_pk: KemPublicKey::new(vec![0x55; 1216]).expect("a non-empty KEM key"),
            not_before_ms: 1_600_000_000_000,
            not_after_ms: 1_900_000_000_000,
        };
        let signature = sign(
            signer,
            &credential.signing_bytes().expect("a credential encodes"),
        );
        DeviceCredential {
            credential,
            signature,
        }
    }

    fn contents(
        &self,
        version: u32,
        kind: EntryKind,
        identity: &SigningKey,
        auth: &SigningKey,
        prev_entry_hash: Digest,
        no_reset: u8,
    ) -> DirectoryEntryTBS {
        DirectoryEntryTBS {
            label: short(labels::LABEL_ENTRY),
            kt_version: KT_VERSION,
            log_id: *self.log.log_id(),
            handle: self.handle.clone(),
            entry_version: version,
            kind,
            identity_pk: public_key_of(identity),
            directory_auth_pk: public_key_of(auth),
            devices: VecU16::new(vec![self.credential(identity, identity)]),
            revocations: VecU16::new(Vec::new()),
            contact_endpoints: VecU16::new(vec![ContactEndpoint {
                relay_url: short(b"wss://relay.example/relay/v1"),
                relay_id: RelayId::new([0x61; 32]),
                contact_addr: QueueAddress::new([0x62; 32]),
            }]),
            prev_entry_hash,
            no_reset,
            created_at_ms: 1_700_000_000_000,
        }
    }

    fn authorize_same_key(&self, entry: DirectoryEntryTBS, auth: &SigningKey) -> DirectoryEntry {
        let auth_signature = sign(auth, &entry.signing_bytes().expect("an entry encodes"));
        DirectoryEntry {
            entry,
            authorization: EntryAuthorization::SameKey { auth_signature },
        }
    }

    /// A version-1 registration.
    pub(crate) fn genesis(&self) -> DirectoryEntry {
        let entry = self.contents(
            1,
            EntryKind::SameKey,
            &self.identity_key,
            &self.auth_key,
            Digest::zero(),
            0,
        );
        self.authorize_same_key(entry, &self.auth_key)
    }

    /// A version-1 registration that forecloses the reset path (ADR 0014).
    pub(crate) fn genesis_no_reset(&self) -> DirectoryEntry {
        let entry = self.contents(
            1,
            EntryKind::SameKey,
            &self.identity_key,
            &self.auth_key,
            Digest::zero(),
            1,
        );
        self.authorize_same_key(entry, &self.auth_key)
    }

    /// A registration whose device credential is signed by a key that is not the
    /// identity key it names.
    pub(crate) fn wrong_signer_credential(&self) -> DirectoryEntry {
        let mut entry = self.contents(
            1,
            EntryKind::SameKey,
            &self.identity_key,
            &self.auth_key,
            Digest::zero(),
            0,
        );
        entry.devices = VecU16::new(vec![
            self.credential(&self.identity_key, &signing_key(0x77)),
        ]);
        self.authorize_same_key(entry, &self.auth_key)
    }

    /// A registration whose device credential names — and is signed by — a
    /// different identity key entirely.
    pub(crate) fn foreign_identity_credential(&self) -> DirectoryEntry {
        let foreign = signing_key(0x78);
        let mut entry = self.contents(
            1,
            EntryKind::SameKey,
            &self.identity_key,
            &self.auth_key,
            Digest::zero(),
            0,
        );
        entry.devices = VecU16::new(vec![self.credential(&foreign, &foreign)]);
        self.authorize_same_key(entry, &self.auth_key)
    }

    /// A `same_key` successor to `previous`.
    pub(crate) fn same_key_update(&self, previous: &DirectoryEntry) -> DirectoryEntry {
        let mut entry = self.contents(
            previous.entry.entry_version.saturating_add(1),
            EntryKind::SameKey,
            &self.identity_key,
            &self.auth_key,
            previous.chain_hash().expect("an entry encodes"),
            previous.entry.no_reset,
        );
        // Something has to differ, or the update is a re-publication. A second
        // contact endpoint is the most boring change §4.1 permits.
        entry.contact_endpoints = VecU16::new(vec![
            ContactEndpoint {
                relay_url: short(b"wss://relay.example/relay/v1"),
                relay_id: RelayId::new([0x61; 32]),
                contact_addr: QueueAddress::new([0x62; 32]),
            },
            ContactEndpoint {
                relay_url: short(b"wss://second.example/relay/v1"),
                relay_id: RelayId::new([0x63; 32]),
                contact_addr: QueueAddress::new([0x64; 32]),
            },
        ]);
        self.authorize_same_key(entry, &self.auth_key)
    }

    /// Re-sign a `same_key` entry a test has edited, under the previous
    /// directory-auth key.
    pub(crate) fn reauthorize_same_key(
        &self,
        entry: DirectoryEntry,
        _previous: &DirectoryEntry,
    ) -> DirectoryEntry {
        self.authorize_same_key(entry.entry, &self.auth_key)
    }

    /// Re-sign a genesis entry a test has edited.
    pub(crate) fn reauthorize_genesis(&self, entry: DirectoryEntry) -> DirectoryEntry {
        self.authorize_same_key(entry.entry, &self.auth_key)
    }

    /// Sign a rotation proof.
    pub(crate) fn sign_rotation(
        &self,
        proof: RotationProofTBS,
        outgoing: &SigningKey,
    ) -> RotationProof {
        let signature = sign(
            outgoing,
            &proof.signing_bytes().expect("a rotation proof encodes"),
        );
        RotationProof { proof, signature }
    }

    /// Sign a reset authorization under the pinned authority key.
    pub(crate) fn sign_reset(&self, reset: ResetAuthorizationTBS) -> ResetAuthorization {
        let reset_signature = sign(
            self.log.reset_authority(),
            &reset
                .signing_bytes()
                .expect("a reset authorization encodes"),
        );
        ResetAuthorization {
            reset,
            reset_signature,
        }
    }

    /// A `key_change` successor to `previous`, rotating to `new_identity` and
    /// `new_auth`.
    pub(crate) fn key_change(
        &self,
        previous: &DirectoryEntry,
        new_identity: &SigningKey,
        new_auth: &SigningKey,
    ) -> DirectoryEntry {
        let version = previous.entry.entry_version.saturating_add(1);
        let prev_entry_hash = previous.chain_hash().expect("an entry encodes");
        let entry = self.contents(
            version,
            EntryKind::KeyChange,
            new_identity,
            new_auth,
            prev_entry_hash,
            previous.entry.no_reset,
        );
        let rotation = self.sign_rotation(
            RotationProofTBS {
                label: short(labels::LABEL_ROTATION),
                log_id: *self.log.log_id(),
                handle: self.handle.clone(),
                entry_version: version,
                old_identity_pk: previous.entry.identity_pk,
                new_identity_pk: public_key_of(new_identity),
                prev_entry_hash,
                created_at_ms: 1_700_000_000_000,
            },
            &self.identity_key,
        );
        let auth_signature = sign(new_auth, &entry.signing_bytes().expect("an entry encodes"));
        DirectoryEntry {
            entry,
            authorization: EntryAuthorization::KeyChange {
                rotation,
                auth_signature,
            },
        }
    }

    /// A `key_change` at version 1 — a rotation of a handle that has never been
    /// registered, which §4.4 rule 6 cannot be satisfied for.
    pub(crate) fn key_change_at_version_one(&self) -> DirectoryEntry {
        let new_identity = signing_key(0x60);
        let new_auth = signing_key(0x61);
        let entry = self.contents(
            1,
            EntryKind::KeyChange,
            &new_identity,
            &new_auth,
            Digest::zero(),
            0,
        );
        let rotation = self.sign_rotation(
            RotationProofTBS {
                label: short(labels::LABEL_ROTATION),
                log_id: *self.log.log_id(),
                handle: self.handle.clone(),
                entry_version: 1,
                old_identity_pk: public_key_of(&self.identity_key),
                new_identity_pk: public_key_of(&new_identity),
                prev_entry_hash: Digest::zero(),
                created_at_ms: 1_700_000_000_000,
            },
            &self.identity_key,
        );
        let auth_signature = sign(&new_auth, &entry.signing_bytes().expect("an entry encodes"));
        DirectoryEntry {
            entry,
            authorization: EntryAuthorization::KeyChange {
                rotation,
                auth_signature,
            },
        }
    }

    /// A `platform_reset` at version 1 — a reset of a handle that has never been
    /// registered.
    pub(crate) fn platform_reset_at_version_one(&self) -> DirectoryEntry {
        let new_identity = signing_key(0x80);
        let new_auth = signing_key(0x81);
        let entry = self.contents(
            1,
            EntryKind::PlatformReset,
            &new_identity,
            &new_auth,
            Digest::zero(),
            0,
        );
        let reset = self.sign_reset(ResetAuthorizationTBS {
            label: short(labels::LABEL_RESET),
            log_id: *self.log.log_id(),
            handle: self.handle.clone(),
            entry_version: 1,
            old_identity_pk: public_key_of(&self.identity_key),
            new_identity_pk: public_key_of(&new_identity),
            created_at_ms: 0,
            effective_at_ms: u64::from(RESET_COOLDOWN_SECONDS).saturating_mul(1_000),
        });
        let auth_signature = sign(&new_auth, &entry.signing_bytes().expect("an entry encodes"));
        DirectoryEntry {
            entry,
            authorization: EntryAuthorization::PlatformReset {
                reset,
                auth_signature,
            },
        }
    }

    /// A `platform_reset` successor to `previous`.
    pub(crate) fn platform_reset(
        &self,
        previous: &DirectoryEntry,
        new_identity: &SigningKey,
        new_auth: &SigningKey,
        created_at_ms: u64,
    ) -> DirectoryEntry {
        let version = previous.entry.entry_version.saturating_add(1);
        let entry = self.contents(
            version,
            EntryKind::PlatformReset,
            new_identity,
            new_auth,
            previous.chain_hash().expect("an entry encodes"),
            previous.entry.no_reset,
        );
        let reset = self.sign_reset(ResetAuthorizationTBS {
            label: short(labels::LABEL_RESET),
            log_id: *self.log.log_id(),
            handle: self.handle.clone(),
            entry_version: version,
            old_identity_pk: previous.entry.identity_pk,
            new_identity_pk: public_key_of(new_identity),
            created_at_ms,
            effective_at_ms: created_at_ms
                .saturating_add(u64::from(RESET_COOLDOWN_SECONDS).saturating_mul(1_000)),
        });
        let auth_signature = sign(new_auth, &entry.signing_bytes().expect("an entry encodes"));
        DirectoryEntry {
            entry,
            authorization: EntryAuthorization::PlatformReset {
                reset,
                auth_signature,
            },
        }
    }

    /// Re-sign a `platform_reset` entry a test has edited, under `new_auth`.
    pub(crate) fn reauthorize_reset(
        &self,
        entry: DirectoryEntry,
        new_auth: &SigningKey,
    ) -> DirectoryEntry {
        let auth_signature = sign(
            new_auth,
            &entry.entry.signing_bytes().expect("an entry encodes"),
        );
        let authorization = match entry.authorization {
            EntryAuthorization::PlatformReset { reset, .. } => EntryAuthorization::PlatformReset {
                reset,
                auth_signature,
            },
            other => other,
        };
        DirectoryEntry {
            entry: entry.entry,
            authorization,
        }
    }
}
