//! The engine: group creation, key packages, `Welcome`, commits, `Update`, and
//! the §5.4 exporters — every state change inside one atomic store transaction.
//!
//! # The shape of every mutating method
//!
//! ```text
//!   let tx = self.provider.store().begin()?;
//!   … OpenMLS does its many writes …
//!   … the application's durable record goes in the same journal …
//!   tx.commit()?;
//! ```
//!
//! That is not defensive programming. OpenMLS has no transaction API, and a
//! `process_message` + `merge_staged_commit` run is seven or more separate
//! storage calls; a crash in the middle leaves a group whose tree is from one
//! epoch and whose secrets are from another. Under delete-on-ack
//! ([`ARCHITECTURE.md` §6.4][s64]) the relay deleted its copy when this device
//! acknowledged, so that is data loss.
//!
//! **The transaction rolls back on drop**, so an early `?` return anywhere in a
//! method below abandons the whole operation. The message is then still on the
//! relay, un-acknowledged, and is redelivered — which is recoverable, and a
//! half-applied epoch change is not.
//!
//! # Delete-on-ack, and what `record_key` is for
//!
//! [`MlsEngine::receive`] takes a `record_key`: the caller's identifier for
//! this delivery (`CLIENT-CONTRACT.md` §7 makes `msgId` the dedup key). The
//! engine writes a durable record under it **inside the same transaction as the
//! decryption**, and refuses a `record_key` it has already seen. Two properties
//! follow, and both are the point:
//!
//! - **A duplicate is dropped, not failed.** A device may publish queue
//!   addresses on *k* relays and senders send to all *k*
//!   ([`ARCHITECTURE.md` §9.4][s94]), so duplicates are routine.
//! - **A crash before the commit leaves no trace of the message.** The record
//!   and the epoch change land together or not at all, so "this device has
//!   handled it" and "this device can decrypt what came after it" can never
//!   disagree. A caller may `ACK` if, and only if, [`MlsEngine::receive`]
//!   returned — and only when the store's [`Durability`] permits it at all.
//!
//! # Credential validation
//!
//! Every point at which a credential enters the group validates it:
//! [`MlsEngine::add_member`] before proposing an Add,
//! [`MlsEngine::join_from_welcome`] on every member of the tree it joined, and
//! [`MlsEngine::receive`] on the sender of anything it processes. The check is
//! [`DeviceCredential::validate_for_leaf`], so a credential that is internally
//! valid but describes a different device is rejected — which is the
//! substitution the identity→device binding of §4.2 exists to stop.
//!
//! [s64]: https://github.com/free2z/zuu/blob/main/docs/e2ee/ARCHITECTURE.md#64-delete-on-ack-and-lost-acknowledgements
//! [s94]: https://github.com/free2z/zuu/blob/main/docs/e2ee/ARCHITECTURE.md#94-relay-trust-model
//! [`Durability`]: f2z_msg_store::Durability

use f2z_msg_store::{Durability, StorageBackend};
use openmls::prelude::*;
use tls_codec::{Deserialize as _, Serialize as _};

use crate::credential::DeviceCredential;
use crate::error::{CredentialError, EngineError, Result};
use crate::exporter::ExportLabel;
use crate::provider::F2zProvider;
use crate::signer::DeviceSigner;
use crate::version::ProtocolVersion;

/// RFC 9420's own protocol version, aliased because this crate has a
/// [`ProtocolVersion`] of its own and the two are different things — see
/// [`crate::version`].
use openmls::prelude::ProtocolVersion as MlsProtocolVersion;

/// The ciphersuite, and there is only one.
///
/// `ARCHITECTURE.md` §5.2: hybrid post-quantum from day one — X25519 +
/// ML-KEM-768 via X-Wing, ChaCha20-Poly1305, SHA-256, Ed25519. Not negotiable
/// and not configurable: a client that could be talked down to a classical
/// suite is a client an active attacker can downgrade, and
/// harvest-now-decrypt-later is the threat this whole choice answers.
///
/// The codepoint is not IANA-assigned. See [`crate::version`] and §13-B: the
/// *bytes* are stable, the label may move, and that is why a
/// [`ProtocolVersion`] is stored beside every group.
pub const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_256_XWING_CHACHA20POLY1305_SHA256_Ed25519;

/// The application-record key under which a group's [`ProtocolVersion`] is
/// stored. Prefixed so it cannot collide with a caller's `record_key`.
const VERSION_RECORD_PREFIX: &[u8] = b"f2z/version/";
/// The prefix for the "this delivery was handled" records.
const HANDLED_RECORD_PREFIX: &[u8] = b"f2z/handled/";

/// What [`MlsEngine::receive`] decided a message was.
///
/// `Debug` is hand-written. `Application::payload` is the **decrypted
/// plaintext of a user's message**, and a derived `Debug` would render it as a
/// decimal byte list — which contains no hex, so a leak check that greps for
/// hex would pass over it. `f2z-codec`'s `workspace_debug_scan` is what caught
/// this, and it is the sharpest instance of the trap in this tree: everything
/// else that could leak here is a key, and this is the message itself.
#[derive(PartialEq, Eq)]
#[non_exhaustive]
pub enum Received {
    /// An application payload, decrypted.
    ///
    /// `sender` is the leaf index, which with `epoch` and the caller's message
    /// id forms `CLIENT-CONTRACT.md` §7's total order —
    /// `(epoch, senderLeafIndex, msgId)`. All three are protocol-authenticated;
    /// the sender's wall clock is not, and must never order anything.
    Application {
        /// The plaintext.
        payload: Vec<u8>,
        /// The sender's leaf index.
        sender: u32,
        /// The epoch the message was sent in.
        epoch: u64,
    },
    /// A commit was processed and merged; the group advanced.
    EpochChanged {
        /// The epoch the group is now in.
        epoch: u64,
    },
    /// A proposal was queued. It changes nothing until a commit covers it.
    ProposalQueued,
}

impl core::fmt::Debug for Received {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Application {
                payload,
                sender,
                epoch,
            } => f
                .debug_struct("Application")
                // The two fields that order the transcript
                // (`CLIENT-CONTRACT.md` §7) are protocol-authenticated and are
                // exactly what a diagnostic needs; the plaintext is not.
                .field("sender", sender)
                .field("epoch", epoch)
                .field(
                    "payload",
                    &format_args!("<redacted; {} bytes>", payload.len()),
                )
                .finish(),
            Self::EpochChanged { epoch } => f
                .debug_struct("EpochChanged")
                .field("epoch", epoch)
                .finish(),
            Self::ProposalQueued => f.write_str("ProposalQueued"),
        }
    }
}

impl Received {
    /// The payload, if this was an application message.
    #[must_use]
    pub fn payload(&self) -> Option<&[u8]> {
        match self {
            Self::Application { payload, .. } => Some(payload),
            _ => None,
        }
    }
}

/// The MLS engine for one device.
///
/// One instance is one device's whole MLS state: its signing key, its device
/// credential, its crypto core and its store. Two instances that share nothing
/// are two devices — which is how `tests/two_instances.rs` proves an exchange
/// rather than proving that one process can talk to itself.
pub struct MlsEngine<B: StorageBackend> {
    provider: F2zProvider<B>,
    signer: DeviceSigner,
    credential: DeviceCredential,
    credential_bytes: Vec<u8>,
}

impl<B: StorageBackend> core::fmt::Debug for MlsEngine<B> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("MlsEngine")
            .field(
                "handle",
                &String::from_utf8_lossy(self.credential.tbs().handle()),
            )
            .field("durability", &self.durability())
            .finish_non_exhaustive()
    }
}

impl<B: StorageBackend> MlsEngine<B> {
    /// Build an engine from a backend, a device signing key and a device
    /// credential.
    ///
    /// The credential is validated against the signer immediately, because a
    /// device whose credential describes a different key produces a group
    /// nobody else will accept — and the failure would otherwise surface on the
    /// peer's machine rather than on this one.
    ///
    /// # Errors
    ///
    /// [`EngineError::Credential`] if the credential does not bind this
    /// signer's public key or does not validate at `now_ms`;
    /// [`EngineError::Mls`] if the crypto provider could not be built.
    pub fn new(
        backend: B,
        signer: DeviceSigner,
        credential: DeviceCredential,
        now_ms: u64,
    ) -> Result<Self> {
        credential.validate_for_leaf(signer.public_key(), now_ms)?;
        let credential_bytes = credential.to_bytes()?;
        Ok(Self {
            provider: F2zProvider::new(backend)?,
            signer,
            credential,
            credential_bytes,
        })
    }

    /// This device's credential.
    #[must_use]
    pub const fn credential(&self) -> &DeviceCredential {
        &self.credential
    }

    /// The provider, for callers that need the store or the crypto directly.
    #[must_use]
    pub const fn provider(&self) -> &F2zProvider<B> {
        &self.provider
    }

    /// What surviving a crash means for this engine's store.
    ///
    /// `CLIENT-CONTRACT.md` §11.2: a client whose store is not durable enters
    /// **no-ACK mode**, because acknowledging destroys the relay's copy.
    #[must_use]
    pub fn durability(&self) -> Durability {
        self.provider.store().durability()
    }

    /// The credential and key this device presents in a leaf.
    fn credential_with_key(&self) -> CredentialWithKey {
        CredentialWithKey {
            // RFC 9420's `BasicCredential` carries an opaque, application-defined
            // identity string. See `crate::credential` on why that, and not a
            // private-use `CredentialType`.
            credential: BasicCredential::new(self.credential_bytes.clone()).into(),
            signature_key: self.signer.public_key().as_slice().into(),
        }
    }

    /// Generate and publish a `KeyPackage`.
    ///
    /// The private init and encryption keys are stored — atomically, with the
    /// key package itself — so that a `Welcome` addressed to this package can
    /// be opened after a restart. #385 measured this at 0.20 ms on API-29
    /// arm64 and 2647 bytes on the wire.
    ///
    /// # Errors
    ///
    /// [`EngineError::Mls`] if OpenMLS refused, [`EngineError::Storage`] if the
    /// store did.
    pub fn generate_key_package(&self) -> Result<Vec<u8>> {
        let transaction = self.provider.store().begin()?;
        let bundle = KeyPackage::builder()
            .build(
                CIPHERSUITE,
                &self.provider,
                &self.signer,
                self.credential_with_key(),
            )
            .map_err(|_| EngineError::Mls("key package generation"))?;
        // Wrapped in an `MlsMessage`, not serialised bare. RFC 9420 §6 frames
        // every wire object the same way, and a bare `KeyPackage` on the wire is
        // one the recipient has to be told the type of out of band.
        let wire = serialize(&MlsMessageOut::from(bundle.key_package().clone()))?;
        transaction.commit()?;
        Ok(wire)
    }

    /// Create a new group.
    ///
    /// # Errors
    ///
    /// [`EngineError::Mls`] if OpenMLS refused, [`EngineError::Storage`] if the
    /// store did.
    pub fn create_group(&self, group_id: &[u8]) -> Result<MlsGroup> {
        let transaction = self.provider.store().begin()?;
        let group = MlsGroup::builder()
            .ciphersuite(CIPHERSUITE)
            .with_group_id(GroupId::from_slice(group_id))
            // The ratchet tree travels in the `Welcome` rather than out of
            // band. `WIRE.md` gives the relay no way to carry a second blob
            // beside a `Welcome`, and an out-of-band tree is one more thing a
            // hostile relay can withhold to make a join fail in a way the user
            // cannot distinguish from a network problem.
            .use_ratchet_tree_extension(true)
            .build(&self.provider, &self.signer, self.credential_with_key())
            .map_err(|_| EngineError::Mls("group creation"))?;
        self.write_protocol_version(group.group_id().as_slice())?;
        transaction.commit()?;
        Ok(group)
    }

    /// Add a member from their published `KeyPackage`, returning the commit and
    /// the `Welcome`, both ready for the wire.
    ///
    /// The key package's credential is validated **before** it is proposed. A
    /// device that added a peer and then discovered the credential did not bind
    /// would have to remove them in a second epoch, and every other member
    /// would have seen the bad credential in between.
    ///
    /// # Errors
    ///
    /// [`EngineError::Credential`] if the key package's credential does not
    /// validate, [`EngineError::Mls`] if OpenMLS refused,
    /// [`EngineError::Storage`] if the store did.
    pub fn add_member(
        &self,
        group: &mut MlsGroup,
        key_package_wire: &[u8],
        now_ms: u64,
    ) -> Result<(Vec<u8>, Vec<u8>)> {
        let key_package = parse_key_package(key_package_wire, self.provider.crypto())?;
        validate_credential(key_package.leaf_node(), now_ms)?;

        let transaction = self.provider.store().begin()?;
        let (commit, welcome, _group_info) = group
            .add_members(
                &self.provider,
                &self.signer,
                core::slice::from_ref(&key_package),
            )
            .map_err(|_| EngineError::Mls("add member"))?;
        group
            .merge_pending_commit(&self.provider)
            .map_err(|_| EngineError::Mls("merge pending commit"))?;
        transaction.commit()?;

        Ok((serialize(&commit)?, serialize(&welcome)?))
    }

    /// Join a group from a `Welcome`.
    ///
    /// Every member of the tree that arrives is validated, not just the sender:
    /// a `Welcome` names the whole membership, and a device that joined a group
    /// containing one unvalidated credential has already given that member the
    /// epoch secrets.
    ///
    /// # Errors
    ///
    /// [`EngineError::Credential`] if any member's credential does not
    /// validate, [`EngineError::Mls`] if OpenMLS refused,
    /// [`EngineError::Storage`] if the store did.
    pub fn join_from_welcome(&self, welcome_wire: &[u8], now_ms: u64) -> Result<MlsGroup> {
        let welcome = parse_welcome(welcome_wire)?;

        let transaction = self.provider.store().begin()?;
        let staged = StagedWelcome::new_from_welcome(
            &self.provider,
            &MlsGroupJoinConfig::builder()
                .use_ratchet_tree_extension(true)
                .build(),
            welcome,
            None,
        )
        .map_err(|_| EngineError::Mls("welcome processing"))?;

        let group = staged
            .into_group(&self.provider)
            .map_err(|_| EngineError::Mls("welcome into group"))?;

        self.validate_members(&group, now_ms)?;
        self.write_protocol_version(group.group_id().as_slice())?;
        transaction.commit()?;
        Ok(group)
    }

    /// Encrypt an application payload as an MLS `PrivateMessage`.
    ///
    /// `ARCHITECTURE.md` §5.3: **all** application payloads travel this way.
    /// `PrivateMessage` encrypts the content, the sender's leaf index and the
    /// content type under the epoch's `encryption_secret` and
    /// `sender_data_secret`, so the relay sees an opaque blob and a queue
    /// address and nothing else. There is no public-message path in this engine
    /// and there must not be one.
    ///
    /// # Errors
    ///
    /// [`EngineError::Mls`] if OpenMLS refused, [`EngineError::Storage`] if the
    /// store did.
    pub fn send(&self, group: &mut MlsGroup, payload: &[u8]) -> Result<Vec<u8>> {
        let transaction = self.provider.store().begin()?;
        let message = group
            .create_message(&self.provider, &self.signer, payload)
            .map_err(|_| EngineError::Mls("create message"))?;
        transaction.commit()?;
        serialize(&message)
    }

    /// Process one inbound message, durably recording that it was handled, in
    /// one atomic write.
    ///
    /// `record_key` is the caller's identifier for this delivery — see the
    /// module note. A `record_key` this engine has already committed returns
    /// [`EngineError::Duplicate`] and changes nothing.
    ///
    /// # Errors
    ///
    /// [`EngineError::Duplicate`] for a `record_key` already handled;
    /// [`EngineError::OutOfOrder`] for a message from an epoch this group is
    /// not in; [`EngineError::Credential`] if the sender's credential does not
    /// validate; [`EngineError::Mls`] if OpenMLS refused;
    /// [`EngineError::Storage`] if the store did.
    pub fn receive(
        &self,
        group: &mut MlsGroup,
        wire: &[u8],
        record_key: &[u8],
        now_ms: u64,
    ) -> Result<Received> {
        // Checked before the transaction opens, so a duplicate costs one lookup
        // rather than a decryption attempt that MLS would refuse anyway with a
        // less specific error.
        if self.provider.store().has_app(&handled_key(record_key))? {
            return Err(EngineError::Duplicate);
        }

        let protocol_message = parse_protocol_message(wire)?;

        let transaction = self.provider.store().begin()?;

        let processed = group
            .process_message(&self.provider, protocol_message)
            .map_err(map_process_error)?;

        // The credential the *sender* presented, validated against the leaf it
        // came from. `ProcessedMessage::credential` is the leaf's credential and
        // OpenMLS has already checked the framing signature under that leaf's
        // signature key, so binding the credential to that key is the remaining
        // half of §4.2's identity→device binding.
        let sender_index = match processed.sender() {
            Sender::Member(index) => Some(*index),
            _ => None,
        };
        let epoch = processed.epoch().as_u64();
        validate_credential_bytes(
            basic_credential_identity(processed.credential())?,
            group_signature_key(group, sender_index)?.as_slice(),
            now_ms,
        )?;

        let outcome = match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(message) => Received::Application {
                payload: message.into_bytes(),
                sender: sender_index.map_or(0, |index| index.u32()),
                epoch,
            },
            ProcessedMessageContent::ProposalMessage(proposal) => {
                group
                    .store_pending_proposal(self.provider.store(), *proposal)
                    .map_err(|_| EngineError::Mls("store pending proposal"))?;
                Received::ProposalQueued
            }
            ProcessedMessageContent::ExternalJoinProposalMessage(proposal) => {
                group
                    .store_pending_proposal(self.provider.store(), *proposal)
                    .map_err(|_| EngineError::Mls("store external join proposal"))?;
                Received::ProposalQueued
            }
            ProcessedMessageContent::StagedCommitMessage(staged) => {
                group
                    .merge_staged_commit(&self.provider, *staged)
                    .map_err(|_| EngineError::Mls("merge staged commit"))?;
                // Re-validated after the merge, because the commit may have
                // *added* members whose credentials nobody has looked at.
                self.validate_members(group, now_ms)?;
                Received::EpochChanged {
                    epoch: group.epoch().as_u64(),
                }
            }
        };

        // The durable "handled" record, in the same journal as everything
        // above. This is the line that makes an `ACK` safe.
        self.provider
            .store()
            .put_app(&handled_key(record_key), &[1])?;

        transaction.commit()?;
        Ok(outcome)
    }

    /// Issue an `Update` commit: fresh leaf key, new epoch.
    ///
    /// `ARCHITECTURE.md` §5.1's post-compromise security. A member who updates
    /// their leaf key heals the group's secrets against an adversary who
    /// previously extracted that member's state, provided the adversary is
    /// passive afterwards. Clients issue one on a schedule and on every app
    /// foreground; this is that operation.
    ///
    /// The commit is merged locally before it is returned, so this device is in
    /// the new epoch the moment the caller has bytes to send.
    ///
    /// # Errors
    ///
    /// [`EngineError::Mls`] if OpenMLS refused, [`EngineError::Storage`] if the
    /// store did.
    pub fn update(&self, group: &mut MlsGroup) -> Result<Vec<u8>> {
        let transaction = self.provider.store().begin()?;
        let bundle = group
            .self_update(&self.provider, &self.signer, LeafNodeParameters::default())
            .map_err(|_| EngineError::Mls("self update"))?;
        let commit = serialize(bundle.commit())?;
        group
            .merge_pending_commit(&self.provider)
            .map_err(|_| EngineError::Mls("merge pending commit"))?;
        transaction.commit()?;
        Ok(commit)
    }

    /// Derive `length` bytes for one of the §5.4 consumers.
    ///
    /// RFC 9420 §8.5's exporter: forward-secret, epoch-bound, and bound to the
    /// exact membership of the epoch. The label is a closed enum for the reason
    /// [`ExportLabel`] gives — a caller who could pass a string could pass
    /// another component's label, and separation is the whole value.
    ///
    /// # Errors
    ///
    /// [`EngineError::Mls`] if the group is not active or the length is
    /// refused.
    pub fn export_secret(
        &self,
        group: &MlsGroup,
        label: ExportLabel,
        context: &[u8],
        length: usize,
    ) -> Result<Vec<u8>> {
        group
            .export_secret(self.provider.crypto(), label.as_str(), context, length)
            .map_err(|_| EngineError::Mls("export secret"))
    }

    /// The [`ProtocolVersion`] a group's stored state was produced by.
    ///
    /// `None` for a group this engine did not create or join. See
    /// [`crate::version`] on why this is stored rather than inferred from the
    /// ciphersuite id.
    ///
    /// # Errors
    ///
    /// [`EngineError::Storage`] if the store refused.
    pub fn protocol_version(&self, group_id: &[u8]) -> Result<Option<ProtocolVersion>> {
        let Some(bytes) = self.provider.store().get_app(&version_key(group_id))? else {
            return Ok(None);
        };
        match bytes.first() {
            Some(1) => Ok(Some(ProtocolVersion::V1Draft)),
            // A version this build does not know is not a corrupt store; it is a
            // store written by a *newer* build. Refusing to guess is the whole
            // reason the field exists.
            _ => Err(EngineError::Mls("unknown stored protocol version")),
        }
    }

    /// Validate every member's credential against the leaf it sits in.
    ///
    /// # Errors
    ///
    /// [`EngineError::Credential`] naming the first check that failed.
    pub fn validate_members(&self, group: &MlsGroup, now_ms: u64) -> Result<()> {
        for member in group.members() {
            validate_credential_bytes(
                basic_credential_identity(&member.credential)?,
                member.signature_key.as_slice(),
                now_ms,
            )?;
        }
        Ok(())
    }

    fn write_protocol_version(&self, group_id: &[u8]) -> Result<()> {
        self.provider.store().put_app(
            &version_key(group_id),
            &[ProtocolVersion::CURRENT as u16 as u8],
        )?;
        Ok(())
    }
}

// --- free helpers -----------------------------------------------------------

fn version_key(group_id: &[u8]) -> Vec<u8> {
    let mut key = VERSION_RECORD_PREFIX.to_vec();
    key.extend_from_slice(group_id);
    key
}

fn handled_key(record_key: &[u8]) -> Vec<u8> {
    let mut key = HANDLED_RECORD_PREFIX.to_vec();
    key.extend_from_slice(record_key);
    key
}

fn serialize(message: &MlsMessageOut) -> Result<Vec<u8>> {
    message
        .tls_serialize_detached()
        .map_err(|_| EngineError::Mls("message serialisation"))
}

fn parse_message(wire: &[u8]) -> Result<MlsMessageIn> {
    let mut reader = wire;
    let message = MlsMessageIn::tls_deserialize(&mut reader)
        .map_err(|_| EngineError::Mls("message deserialisation"))?;
    if !reader.is_empty() {
        // Exactly one encoding, or nothing — `WIRE.md` §3.3's rule, applied to
        // MLS framing so that a relay cannot append a byte and have two
        // implementations disagree about what it sent.
        return Err(EngineError::Mls("trailing bytes after message"));
    }
    Ok(message)
}

fn parse_key_package(wire: &[u8], crypto: &impl OpenMlsCrypto) -> Result<KeyPackage> {
    match parse_message(wire)?.extract() {
        // `validate` and not `into`: it checks the key package's own signature,
        // the leaf node's signature, the lifetime, the extensions and that the
        // init key differs from the encryption key. Skipping it would mean
        // proposing an Add for a key package this device never verified, and
        // every other member would then verify it and refuse the commit.
        MlsMessageBodyIn::KeyPackage(key_package) => key_package
            .validate(crypto, MlsProtocolVersion::Mls10)
            .map_err(|_| EngineError::Mls("key package validation")),
        _ => Err(EngineError::Mls("expected a key package")),
    }
}

fn parse_welcome(wire: &[u8]) -> Result<Welcome> {
    match parse_message(wire)?.extract() {
        MlsMessageBodyIn::Welcome(welcome) => Ok(welcome),
        _ => Err(EngineError::Mls("expected a welcome")),
    }
}

fn parse_protocol_message(wire: &[u8]) -> Result<ProtocolMessage> {
    parse_message(wire)?
        .try_into_protocol_message()
        .map_err(|_| EngineError::Mls("expected a protocol message"))
}

/// The identity bytes out of a `BasicCredential`.
fn basic_credential_identity(credential: &Credential) -> Result<&[u8]> {
    if credential.credential_type() != CredentialType::Basic {
        return Err(EngineError::Credential(CredentialError::WrongType));
    }
    Ok(credential.serialized_content())
}

fn validate_credential_bytes(bytes: &[u8], leaf_signature_key: &[u8], now_ms: u64) -> Result<()> {
    DeviceCredential::parse(bytes)?.validate_for_leaf(leaf_signature_key, now_ms)?;
    Ok(())
}

fn validate_credential(leaf: &LeafNode, now_ms: u64) -> Result<()> {
    validate_credential_bytes(
        basic_credential_identity(leaf.credential())?,
        leaf.signature_key().as_slice(),
        now_ms,
    )
}

fn group_signature_key(
    group: &MlsGroup,
    sender: Option<LeafNodeIndex>,
) -> Result<SignaturePublicKey> {
    let Some(index) = sender else {
        // An external sender has no leaf, so there is no device to bind a
        // credential to. This engine does not accept external commits or
        // external proposals in v1, so reaching here is a message shape the
        // configuration should already have refused.
        return Err(EngineError::Mls("message from a non-member sender"));
    };
    group
        .members()
        .find(|member| member.index == index)
        .map(|member| member.signature_key.into())
        .ok_or(EngineError::Mls("sender is not a member"))
}

/// Translate the MLS errors that are *expected* into the variants a client is
/// allowed to treat as transport events rather than defects.
fn map_process_error<E>(error: ProcessMessageError<E>) -> EngineError {
    match error {
        // `WIRE.md` §5.4: the relay may reorder freely, so a message for
        // another epoch is a transport event, not a protocol violation. This is
        // the distinction `CLIENT-CONTRACT.md` §8 draws between a retryable
        // condition and a defect, and collapsing it would turn ordinary relay
        // behaviour into a bug report.
        ProcessMessageError::ValidationError(ValidationError::WrongEpoch) => {
            EngineError::OutOfOrder
        }
        _ => EngineError::Mls("process message"),
    }
}
