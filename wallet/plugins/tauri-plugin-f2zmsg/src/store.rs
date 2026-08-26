//! The durable local record layer.
//!
//! Everything the engine has to still know after a restart lives here:
//! conversations, the transcript, delivery state, gaps, alarms, relays,
//! witnesses, retention. It sits on `f2z-msg-store`'s **application** namespace
//! — `put_app` / `get_app` / `has_app` / `delete_app`, the twentieth label
//! beside OpenMLS's nineteen — which is deliberate on that crate's part: its
//! `provider.rs` says a schema there "would be a second place for
//! `ARCHITECTURE.md` §7's framing to be defined". This module is that schema,
//! and it is the plugin's, not the store's.
//!
//! # The one property this module exists to provide
//!
//! **A write is durable before anything observable happens.** `CLIENT-CONTRACT.md`
//! §9 rule 1: the relay deletes on ACK, so an ACK before the local write plus a
//! crash is permanent message loss — not recoverable from the relay, the peer,
//! or the mnemonic. Every inbound path here goes through
//! [`RecordStore::commit`], which is `f2z-msg-store`'s explicit transaction: a
//! `Transaction` that is dropped without `commit` rolls back, and a failed
//! commit rolls back rather than half-applying.
//!
//! `f2z-msg-store` has no `Committed<T>` proof type — that lives in
//! `f2z-relay-store` and is *relay*-side, gating the relay's own ACK response.
//! The client-side equivalent is this pair: `commit()` returning `Ok(())`, and
//! [`Durability::may_acknowledge`] being true. Both are checked at the one ACK
//! site in `engine`, and neither is checked anywhere else.
//!
//! # A stated limitation, not an oversight
//!
//! `f2z-msg-store` deliberately offers **no iteration, prefix scan, or key
//! enumeration**. So every collection here is an explicit index blob — a JSON
//! array of ids under one key, rewritten on change — rather than a range scan.
//! That is correct and slow in the same way: a conversation with fifty thousand
//! messages rewrites a fifty-thousand-entry index on each arrival. It is fine
//! for v1 and it is the first thing to change when the store grows an iterator;
//! the read paths below are already written against an ordered index so that
//! change is local to this file.
//!
//! # And one that is a security gap
//!
//! `EngineState::locked` (§6.1) exists because "local history is wrapped under
//! `BackupWrapKey` and cannot be decrypted". This module implements the
//! **state machine** and seals the device secret key under that wrap key
//! ([`SealedSecrets`]), so an unenrolled-from-the-seed device cannot sign as
//! this identity. It does **not** encrypt the SQLite database `f2z-msg-store`
//! writes, because that crate does not offer at-rest encryption and a plugin
//! cannot add it from outside. MLS group state and message plaintext are
//! therefore at rest in the clear, protected by the OS's file permissions and
//! nothing else. That is a real gap, it belongs to `f2z-msg-store`, and it is
//! recorded here rather than in a commit message so the next reader finds it.

use f2z_msg_store::{Durability, F2zStorageProvider, StorageBackend};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::models::{
    Alarm, EphemeralHintState, ErrorCode, Gap, PurgeRequestStatus, ReceiptPolicy, RelayWarning,
    RetentionMode, RetentionPolicy, RetentionScope, VerificationState, WitnessConfig,
};

/// One backend, two providers.
///
/// `f2z-msg-store`'s providers take a backend **by value**, and `MlsEngine::new`
/// does too. But the plugin needs the store before an `MlsEngine` can exist —
/// "is this device enrolled" is a question asked of the store, and the answer is
/// what decides whether an engine can be built at all — and it needs it again
/// afterwards, for the records in this module.
///
/// So the backend is shared. `Arc<B>` cannot implement `StorageBackend`
/// directly: neither the trait nor `Arc` is local to this crate, and the orphan
/// rule refuses it. A local newtype can, and does.
///
/// Sharing is sound because `StorageBackend::apply` is the atomic unit and each
/// provider stages its own write set: two providers over one backend interleave
/// whole transactions, never halves of one. Nothing here needs a transaction to
/// span both — MLS commits its own state, this module commits its records — and
/// if anything ever did, that would be the moment to stop sharing rather than
/// to reach for a lock.
#[derive(Debug)]
pub struct SharedBackend<B: StorageBackend>(std::sync::Arc<B>);

impl<B: StorageBackend> SharedBackend<B> {
    #[must_use]
    pub fn new(backend: std::sync::Arc<B>) -> Self {
        Self(backend)
    }
}

impl<B: StorageBackend> Clone for SharedBackend<B> {
    fn clone(&self) -> Self {
        Self(std::sync::Arc::clone(&self.0))
    }
}

impl<B: StorageBackend> StorageBackend for SharedBackend<B> {
    fn get(&self, key: &[u8]) -> f2z_msg_store::Result<Option<Vec<u8>>> {
        self.0.get(key)
    }

    fn apply(&self, ops: &[f2z_msg_store::Op]) -> f2z_msg_store::Result<()> {
        self.0.apply(ops)
    }

    fn durability(&self) -> Durability {
        self.0.durability()
    }
}

/// Every key this module writes, in one place.
///
/// A module rather than scattered literals so the namespace is auditable: the
/// application half of the store is shared with nothing, and a key colliding
/// with OpenMLS's would be a silent corruption rather than an error.
mod keys {
    pub const PREFIX: &str = "f2zmsg/";

    pub fn identity() -> Vec<u8> {
        format!("{PREFIX}identity").into_bytes()
    }
    pub fn secrets() -> Vec<u8> {
        format!("{PREFIX}secrets").into_bytes()
    }
    pub fn conversation_index() -> Vec<u8> {
        format!("{PREFIX}conv/index").into_bytes()
    }
    pub fn conversation(id: &str) -> Vec<u8> {
        format!("{PREFIX}conv/{id}").into_bytes()
    }
    pub fn transcript(conversation_id: &str) -> Vec<u8> {
        format!("{PREFIX}transcript/{conversation_id}").into_bytes()
    }
    pub fn message(msg_id: &str) -> Vec<u8> {
        format!("{PREFIX}msg/{msg_id}").into_bytes()
    }
    pub fn gaps(conversation_id: &str) -> Vec<u8> {
        format!("{PREFIX}gaps/{conversation_id}").into_bytes()
    }
    pub fn purges(conversation_id: &str) -> Vec<u8> {
        format!("{PREFIX}purges/{conversation_id}").into_bytes()
    }
    pub fn contact_requests() -> Vec<u8> {
        format!("{PREFIX}contact-requests").into_bytes()
    }
    pub fn contact_queue() -> Vec<u8> {
        format!("{PREFIX}contact-queue").into_bytes()
    }
    pub fn alarms() -> Vec<u8> {
        format!("{PREFIX}alarms").into_bytes()
    }
    pub fn relays() -> Vec<u8> {
        format!("{PREFIX}relays").into_bytes()
    }
    pub fn witnesses() -> Vec<u8> {
        format!("{PREFIX}witnesses").into_bytes()
    }
    pub fn global_retention() -> Vec<u8> {
        format!("{PREFIX}retention/global").into_bytes()
    }
    pub fn blocked() -> Vec<u8> {
        format!("{PREFIX}blocked").into_bytes()
    }
}

/// The public half of this device's messaging identity.
///
/// Written once by the app crate's enrollment command (§2.2) and read on every
/// start. It carries no secret: the signing keys are in [`SealedSecrets`].
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredIdentity {
    /// Local, stable, opaque.
    pub device_id: String,
    pub handle: String,
    /// `ISK.public`, hex.
    pub identity_pk: String,
    /// `DSK.public`, hex. The MLS leaf signature key.
    pub device_pk: String,
    /// The `DeviceCredential`, canonically encoded, hex.
    pub credential: String,
    pub created_at: i64,
    /// Directory state, as far as this device knows it (§3.2).
    pub directory_entry_version: Option<i64>,
    pub submitted_at: Option<i64>,
    pub merged_at_epoch: Option<i64>,
}

/// The device's signing material, sealed under the seed-derived `BackupWrapKey`.
///
/// The seal is ChaCha20-Poly1305 with a random 96-bit nonce. What it buys is
/// exactly one thing and it is worth stating narrowly: a copy of the store
/// taken without the mnemonic cannot sign as this identity. It does **not**
/// protect the message plaintext beside it — see this module's header.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SealedSecrets {
    /// Hex, 12 bytes.
    pub nonce: String,
    /// Hex. ChaCha20-Poly1305 over the JSON of [`DeviceSecrets`].
    pub ciphertext: String,
}

/// What [`SealedSecrets`] seals. Never serialized anywhere but inside the seal.
#[derive(Clone, Debug, Serialize, Deserialize, zeroize::Zeroize, zeroize::ZeroizeOnDrop)]
pub struct DeviceSecrets {
    /// The MLS leaf signing key, hex. `DeviceSigner::from_private_key` takes
    /// these 32 bytes; `f2z-msg-identity`'s `DeviceSignatureKey` deliberately
    /// offers no byte accessor, so the plugin generates them and feeds both
    /// sides.
    pub device_signing_key: String,
    /// The seed for this device's queue keys, hex. Per-conversation queue keys
    /// are derived from it so a restart can re-derive them without a second
    /// secret to protect.
    pub queue_seed: String,
}

/// Where a conversation's traffic goes and comes from.
///
/// Two queues, not one, and that asymmetry is `WIRE.md` §7: a device creates
/// its **own** receive queue and advertises the matching send address; a peer
/// binds that send address once and appends to it. Neither end can read the
/// other's queue and neither can tell whether the other's exists.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredQueues {
    /// Where **we** read. Created by us on `relay_url`.
    pub inbound: Option<InboundQueue>,
    /// Where **we** write. Advertised to us by the peer.
    pub outbound: Option<OutboundQueue>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InboundQueue {
    pub relay_url: String,
    /// Hex, 32 bytes.
    pub recv_addr: String,
    /// The address we advertise to the peer, hex. We never write to it.
    pub send_addr: String,
    /// The seed the receive-side signing key is derived from, hex.
    pub recv_key_seed: String,
    /// The next index to `READ` from. Advances only after a durable write.
    pub next_index: u64,
    /// The highest index this device has ACKed — and therefore the highest the
    /// relay has deleted. Never advanced ahead of a committed write.
    pub acked_through: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OutboundQueue {
    pub relay_url: String,
    /// The peer's advertised send address, hex.
    pub send_addr: String,
    /// The seed for the send-side key we bind with, hex.
    pub send_key_seed: String,
    /// Whether `BIND_SEND` has succeeded. Once-only and irreversible (§6.3), so
    /// a second attempt is a client bug rather than a retry.
    pub bound: bool,
}

/// A conversation, as it survives a restart.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredConversation {
    pub conversation_id: String,
    pub peer_handle: String,
    pub peer_identity_fingerprint: String,
    /// The MLS group id, hex.
    pub group_id: String,
    pub verification: VerificationState,
    pub created_at: i64,
    pub last_message_at: Option<i64>,
    pub unread_count: u32,
    /// `None` means the global policy applies; §3.7's `scope` on a read says
    /// which of the two produced the answer.
    pub retention: Option<RetentionPolicy>,
    pub ephemeral_hint: Option<EphemeralHintState>,
    pub receipt_policy: ReceiptPolicy,
    pub queues: StoredQueues,
    /// Set when `WIRE.md` §7.4's `ERR_ALREADY_BOUND` on a first bind proves a
    /// relay operator took the write capability. Sticky: it is evidence, not a
    /// transient connection state.
    pub send_address_stolen: bool,
    /// The last read message, so `unreadCount` survives a restart.
    pub read_through: Option<String>,
}

/// Every `msg_id` a conversation holds, in the order this device first wrote
/// them.
///
/// **Not the display order**, and the distinction is §7's: the display order is
/// the causal DAG linearised, with `(epoch, senderLeafIndex, msgId)` breaking
/// ties between *concurrent* messages only. `f2z-msg-dag` computes that from
/// the graph, and this list is just the population it is computed over. An
/// earlier version of this file keyed the index by the sort key and paged over
/// it directly, which is the same defect `f2z_msg_dag::order` documents: a
/// reply from the lower leaf index sorts above the message it answers.
pub type Transcript = Vec<String>;

/// A message, as it survives a restart.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredMessage {
    pub msg_id: String,
    pub conversation_id: String,
    pub outbound: bool,
    pub epoch: u64,
    pub sender_leaf_index: u32,
    pub parents: Vec<String>,
    /// The sender's claim. **Advisory only** (§7).
    pub sent_at: i64,
    /// Local clock at durable write. This device's opinion, inbound only.
    pub received_at: Option<i64>,
    /// The §7 envelope, hex.
    ///
    /// Kept rather than only the decoded text, because §7's gap repair
    /// re-encrypts *the original plaintext* under the current epoch — replaying
    /// old ciphertext would undermine forward secrecy — and the envelope is
    /// that plaintext. This is `ARCHITECTURE.md` §8.4's bounded-window
    /// plaintext outbox, and its window is the local retention policy, which is
    /// why shortening retention shortens the gap-repair window (§3.7).
    pub envelope: String,
    /// Retained only until the send is accepted, so a `retry_send` after an
    /// unknown outcome re-appends the identical bytes rather than a new
    /// encryption. Hex.
    pub retry_ciphertext: Option<String>,
    /// `None` for a message whose body this build does not understand.
    pub text: Option<String>,
    /// The frontend's own idempotency key for its optimistic row (§3.4).
    ///
    /// Retained so `retry_send` can echo the same one back. It is the client's
    /// dedup key and not the protocol's — `msg_id` is that — and a retry that
    /// answered with a different `clientRef` would leave the optimistic row it
    /// was supposed to reconcile stranded.
    pub client_ref: Option<String>,
    /// Set when the plaintext is gone — a repair that could not be made, or a
    /// retention sweep. The transcript renders the §3.4 marker, never nothing.
    pub unrecoverable: Option<UnrecoverableCause>,
    pub type_tag: Option<String>,
    pub ceremony: bool,
    pub expires_at: Option<i64>,
    pub delivery: StoredDelivery,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum UnrecoverableCause {
    /// §3.5: the sender no longer holds the plaintext, or this device lost it
    /// in the window between the MLS ratchet advancing and its own record
    /// committing. Either way the bytes are gone and the marker says so.
    GapUnrecoverable,
    /// §3.7: this device's own retention policy expired it.
    RetentionExpired,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredDelivery {
    /// One of §6.2's seven, as its kebab wire name.
    pub state: String,
    pub accepted_by_relays: u32,
    pub configured_relays: u32,
    pub devices_receipted: u32,
    pub devices_expected: u32,
    pub failure: Option<ErrorCode>,
    pub updated_at: i64,
}

/// A relay, as configured.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredRelay {
    pub relay_id: String,
    pub relay_url: String,
    /// The user's explicit per-relay opt-in (§2.3 obligation 3, §3.11).
    pub allow_insecure_transport: bool,
    pub allow_no_channel_binding: bool,
    pub warnings: Vec<RelayWarning>,
    pub operator: crate::models::RelayOperator,
    /// The capability digest at the time it was added, hex. §11.3 requires a
    /// re-check on first use of a session and on `NOTICE(3)`; a divergence is
    /// `relay-capability-mismatch` and moves the relay to `refused`, never to a
    /// warning banner.
    pub capabilities_digest: String,
}

/// The witness set, and the threshold it is measured against.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct StoredWitnessSet {
    pub witnesses: Vec<WitnessConfig>,
    pub threshold: u32,
}

/// The typed façade over `f2z-msg-store`'s application namespace.
pub struct RecordStore<'a, B: StorageBackend> {
    provider: &'a F2zStorageProvider<B>,
}

impl<'a, B: StorageBackend> RecordStore<'a, B> {
    #[must_use]
    pub const fn new(provider: &'a F2zStorageProvider<B>) -> Self {
        Self { provider }
    }

    /// Whether this store may acknowledge at all (§11.2).
    ///
    /// A client that cannot promise durability **must not ACK**, because the
    /// relay deletes the instant it receives one. This is the client-side
    /// equivalent of `f2z-relay-store`'s `Committed<T>` proof, and it is
    /// consulted at the single ACK site and nowhere else.
    #[must_use]
    pub fn may_acknowledge(&self) -> bool {
        self.durability().may_acknowledge()
    }

    #[must_use]
    pub fn durability(&self) -> Durability {
        self.provider.durability()
    }

    /// Run a set of writes as one atomic transaction.
    ///
    /// The closure stages writes with [`RecordStore::put`] and
    /// [`RecordStore::delete`]; nothing it stages is visible, or durable, until
    /// this returns `Ok(())`. A closure that returns `Err` rolls the whole set
    /// back — as does a panic, because `Transaction`'s `Drop` rolls back.
    ///
    /// # Errors
    ///
    /// `internal` when the store refuses the transaction, `storage-full` when
    /// the backing device is out of space — which §8 says stops inbound being
    /// acknowledged, and that is correct: an un-ACKed message is still on the
    /// relay.
    pub fn commit<T>(&self, writes: impl FnOnce(&Self) -> Result<T>) -> Result<T> {
        let transaction = self
            .provider
            .begin()
            .map_err(|error| store_error("opening a transaction", &error))?;
        let value = writes(self)?;
        transaction
            .commit()
            .map_err(|error| store_error("committing", &error))?;
        Ok(value)
    }

    fn put<T: Serialize>(&self, key: &[u8], value: &T) -> Result<()> {
        let bytes = serde_json::to_vec(value)
            .map_err(|error| Error::internal(format!("encoding a record: {error}")))?;
        self.provider
            .put_app(key, &bytes)
            .map_err(|error| store_error("writing a record", &error))
    }

    fn get<T: for<'de> Deserialize<'de>>(&self, key: &[u8]) -> Result<Option<T>> {
        let Some(bytes) = self
            .provider
            .get_app(key)
            .map_err(|error| store_error("reading a record", &error))?
        else {
            return Ok(None);
        };
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| Error::internal(format!("decoding a record: {error}")))
    }

    fn delete(&self, key: &[u8]) -> Result<()> {
        self.provider
            .delete_app(key)
            .map_err(|error| store_error("deleting a record", &error))
    }

    // -- identity ----------------------------------------------------------

    pub fn identity(&self) -> Result<Option<StoredIdentity>> {
        self.get(&keys::identity())
    }

    pub fn put_identity(&self, identity: &StoredIdentity) -> Result<()> {
        self.put(&keys::identity(), identity)
    }

    pub fn sealed_secrets(&self) -> Result<Option<SealedSecrets>> {
        self.get(&keys::secrets())
    }

    pub fn put_sealed_secrets(&self, sealed: &SealedSecrets) -> Result<()> {
        self.put(&keys::secrets(), sealed)
    }

    /// Remove the identity and its secrets. `f2zmsg_unenroll` (§3.2).
    pub fn clear_identity(&self) -> Result<()> {
        self.delete(&keys::identity())?;
        self.delete(&keys::secrets())
    }

    // -- conversations -----------------------------------------------------

    pub fn conversation_ids(&self) -> Result<Vec<String>> {
        Ok(self.get(&keys::conversation_index())?.unwrap_or_default())
    }

    pub fn conversation(&self, id: &str) -> Result<Option<StoredConversation>> {
        self.get(&keys::conversation(id))
    }

    pub fn put_conversation(&self, conversation: &StoredConversation) -> Result<()> {
        let mut ids = self.conversation_ids()?;
        if !ids.iter().any(|id| id == &conversation.conversation_id) {
            ids.push(conversation.conversation_id.clone());
            self.put(&keys::conversation_index(), &ids)?;
        }
        self.put(
            &keys::conversation(&conversation.conversation_id),
            conversation,
        )
    }

    pub fn remove_conversation(&self, id: &str) -> Result<()> {
        let ids: Vec<String> = self
            .conversation_ids()?
            .into_iter()
            .filter(|existing| existing != id)
            .collect();
        self.put(&keys::conversation_index(), &ids)?;
        self.delete(&keys::conversation(id))?;
        self.delete(&keys::transcript(id))?;
        self.delete(&keys::gaps(id))?;
        self.delete(&keys::purges(id))
    }

    // -- transcript and messages -------------------------------------------

    pub fn transcript(&self, conversation_id: &str) -> Result<Transcript> {
        Ok(self
            .get(&keys::transcript(conversation_id))?
            .unwrap_or_default())
    }

    pub fn put_transcript(&self, conversation_id: &str, transcript: &Transcript) -> Result<()> {
        self.put(&keys::transcript(conversation_id), transcript)
    }

    /// Append one `msg_id`, if the conversation does not already hold it.
    ///
    /// Idempotent because duplicates are the normal case, not an error: §9.4's
    /// *k*-relay fan-out means a device may publish queue addresses on several
    /// relays and a sender sends to all of them.
    pub fn remember_message(&self, conversation_id: &str, msg_id: &str) -> Result<()> {
        let mut transcript = self.transcript(conversation_id)?;
        if transcript.iter().any(|known| known == msg_id) {
            return Ok(());
        }
        transcript.push(msg_id.to_owned());
        self.put_transcript(conversation_id, &transcript)
    }

    pub fn message(&self, msg_id: &str) -> Result<Option<StoredMessage>> {
        self.get(&keys::message(msg_id))
    }

    pub fn put_message(&self, message: &StoredMessage) -> Result<()> {
        self.put(&keys::message(&message.msg_id), message)
    }

    pub fn has_message(&self, msg_id: &str) -> Result<bool> {
        self.provider
            .has_app(&keys::message(msg_id))
            .map_err(|error| store_error("probing a record", &error))
    }

    // -- gaps, purges, contact requests, alarms ----------------------------

    pub fn gaps(&self, conversation_id: &str) -> Result<Vec<Gap>> {
        Ok(self.get(&keys::gaps(conversation_id))?.unwrap_or_default())
    }

    pub fn put_gaps(&self, conversation_id: &str, gaps: &[Gap]) -> Result<()> {
        self.put(&keys::gaps(conversation_id), &gaps.to_vec())
    }

    pub fn purges(&self, conversation_id: &str) -> Result<Vec<PurgeRequestStatus>> {
        Ok(self
            .get(&keys::purges(conversation_id))?
            .unwrap_or_default())
    }

    pub fn put_purges(&self, conversation_id: &str, purges: &[PurgeRequestStatus]) -> Result<()> {
        self.put(&keys::purges(conversation_id), &purges.to_vec())
    }

    /// This device's own contact queue (§12.2) — where a stranger's `Welcome`
    /// arrives. One per device, not one per conversation: its address is what
    /// enrollment publishes in the directory, and it is deliberately not
    /// bindable, so nobody can take the write side of it the way §7.4 warns
    /// about for ordinary queues.
    pub fn contact_queue(&self) -> Result<Option<ContactQueue>> {
        self.get(&keys::contact_queue())
    }

    pub fn put_contact_queue(&self, queue: &ContactQueue) -> Result<()> {
        self.put(&keys::contact_queue(), queue)
    }

    pub fn contact_requests(&self) -> Result<Vec<StoredContactRequest>> {
        Ok(self.get(&keys::contact_requests())?.unwrap_or_default())
    }

    pub fn put_contact_requests(&self, requests: &[StoredContactRequest]) -> Result<()> {
        self.put(&keys::contact_requests(), &requests.to_vec())
    }

    pub fn alarms(&self) -> Result<Vec<Alarm>> {
        Ok(self.get(&keys::alarms())?.unwrap_or_default())
    }

    pub fn put_alarms(&self, alarms: &[Alarm]) -> Result<()> {
        self.put(&keys::alarms(), &alarms.to_vec())
    }

    /// Handles blocked on **this device**. §3.3: there is no server that can
    /// enforce a block, because there is no server that knows who is talking to
    /// whom, so the UI says "blocked on this device".
    pub fn blocked(&self) -> Result<Vec<String>> {
        Ok(self.get(&keys::blocked())?.unwrap_or_default())
    }

    pub fn put_blocked(&self, blocked: &[String]) -> Result<()> {
        self.put(&keys::blocked(), &blocked.to_vec())
    }

    // -- relays, witnesses, retention --------------------------------------

    pub fn relays(&self) -> Result<Vec<StoredRelay>> {
        Ok(self.get(&keys::relays())?.unwrap_or_default())
    }

    pub fn put_relays(&self, relays: &[StoredRelay]) -> Result<()> {
        self.put(&keys::relays(), &relays.to_vec())
    }

    pub fn witnesses(&self) -> Result<StoredWitnessSet> {
        Ok(self.get(&keys::witnesses())?.unwrap_or_default())
    }

    pub fn put_witnesses(&self, set: &StoredWitnessSet) -> Result<()> {
        self.put(&keys::witnesses(), set)
    }

    /// §3.7's global policy. The default is `keep`, because a messenger that
    /// silently discarded history would be making a retention decision on the
    /// user's behalf in the direction that loses data.
    pub fn global_retention(&self) -> Result<RetentionPolicy> {
        Ok(self
            .get(&keys::global_retention())?
            .unwrap_or(RetentionPolicy {
                scope: RetentionScope::Global,
                mode: RetentionMode::Keep,
                ttl_seconds: None,
                effective_from: 0,
            }))
    }

    pub fn put_global_retention(&self, policy: &RetentionPolicy) -> Result<()> {
        self.put(&keys::global_retention(), policy)
    }
}

/// This device's contact queue (`WIRE.md` §12.2).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ContactQueue {
    pub relay_url: String,
    /// Where this device reads, hex. Signed by `recv_key`, like any queue.
    pub recv_addr: String,
    /// The **published** address, hex. Never bindable: `BIND_SEND` on it is
    /// `ERR_NOT_PERMITTED`, always, for everyone.
    pub contact_addr: String,
    pub recv_key_seed: String,
    pub next_index: u64,
    pub acked_through: Option<u64>,
    /// Single-use key packages the relay held at the last publish (§12.6).
    ///
    /// The relay's own count, not this device's guess at one. It is the only
    /// way to know how many were claimed while this device was away, and it is
    /// what the low-water rule is applied to. `serde(default)` so a store
    /// written before §12.6 opens as a pool of zero — which is the truth, and
    /// which makes the next `start_engine` publish one.
    #[serde(default)]
    pub key_package_pool: u32,
    /// Whether the relay holds a package of last resort for this device.
    #[serde(default)]
    pub has_last_resort: bool,
}

/// A pending first-contact request (§3.3), before it becomes a conversation.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredContactRequest {
    pub request_id: String,
    pub peer_handle: String,
    pub peer_identity_fingerprint: String,
    /// The group the sender created, so accepting joins the same one.
    pub conversation_id: String,
    pub received_at: i64,
    /// **PROVISIONAL** (§12.1). Showing any part of an unsolicited,
    /// unauthenticated-at-the-relay first-contact payload is a moderation and
    /// safety question that has not been answered, so this build keeps it
    /// `None` rather than shipping a decision nobody made.
    pub body_preview: Option<String>,
    /// The `Welcome` bytes, hex, so accepting is a local operation.
    pub welcome: String,
    /// The peer's advertised send address and relay, hex/url.
    pub peer_send_addr: String,
    pub peer_relay_url: String,
}

fn store_error(what: &str, error: &f2z_msg_store::StoreError) -> Error {
    // `storage-full` is the one store failure with a contract member of its
    // own, and §8 tells the UI to do something specific about it: inbound stops
    // being acknowledged, which is correct, because an un-ACKed message is
    // still on the relay. Everything else is an engine fault.
    let text = error.to_string();
    let code = if text.contains("full") || text.contains("no space") || text.contains("disk") {
        ErrorCode::StorageFull
    } else {
        ErrorCode::Internal
    };
    Error::new(code, format!("{what}: {text}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use f2z_msg_store::MemoryBackend;

    fn store() -> F2zStorageProvider<MemoryBackend> {
        F2zStorageProvider::new(MemoryBackend::new())
    }

    fn conversation(id: &str) -> StoredConversation {
        StoredConversation {
            conversation_id: id.to_owned(),
            peer_handle: "peer".into(),
            peer_identity_fingerprint: "ff".into(),
            group_id: "00".into(),
            verification: VerificationState::Unverified,
            created_at: 1,
            last_message_at: None,
            unread_count: 0,
            retention: None,
            ephemeral_hint: None,
            receipt_policy: ReceiptPolicy::default(),
            queues: StoredQueues {
                inbound: None,
                outbound: None,
            },
            send_address_stolen: false,
            read_through: None,
        }
    }

    #[test]
    fn an_in_memory_store_may_not_acknowledge() {
        // §11.2's hard rule, expressed as a property of the store rather than
        // as a rule someone has to remember at the ACK site.
        let provider = store();
        let records = RecordStore::new(&provider);
        assert_eq!(records.durability(), Durability::None);
        assert!(!records.may_acknowledge());
    }

    #[test]
    fn a_committed_transaction_is_visible_and_an_abandoned_one_is_not() {
        let provider = store();
        let records = RecordStore::new(&provider);

        records
            .commit(|records| records.put_conversation(&conversation("a")))
            .expect("commit");
        assert_eq!(records.conversation_ids().expect("ids"), vec!["a"]);

        let aborted: Result<()> = records.commit(|records| {
            records.put_conversation(&conversation("b"))?;
            Err(Error::internal("deliberate"))
        });
        assert!(aborted.is_err());
        assert_eq!(
            records.conversation_ids().expect("ids"),
            vec!["a"],
            "a transaction that returned Err must roll back entirely"
        );
    }

    #[test]
    fn the_conversation_index_does_not_duplicate_on_rewrite() {
        let provider = store();
        let records = RecordStore::new(&provider);
        for _ in 0..3 {
            records
                .commit(|records| records.put_conversation(&conversation("a")))
                .expect("commit");
        }
        assert_eq!(records.conversation_ids().expect("ids"), vec!["a"]);
    }

    #[test]
    fn removing_a_conversation_removes_everything_hanging_off_it() {
        let provider = store();
        let records = RecordStore::new(&provider);
        records
            .commit(|records| {
                records.put_conversation(&conversation("a"))?;
                records.remember_message("a", "deadbeef")?;
                records.put_gaps(
                    "a",
                    &[Gap {
                        gap_id: "g".into(),
                        conversation_id: "a".into(),
                        missing_msg_ids: vec![],
                        detected_at: 0,
                        after_msg_id: None,
                        state: crate::models::GapState::Detected,
                    }],
                )
            })
            .expect("commit");

        records
            .commit(|records| records.remove_conversation("a"))
            .expect("commit");

        assert!(records.conversation_ids().expect("ids").is_empty());
        assert!(records.conversation("a").expect("read").is_none());
        assert!(records.transcript("a").expect("transcript").is_empty());
        assert!(records.gaps("a").expect("gaps").is_empty());
    }

    #[test]
    fn the_default_global_retention_keeps_rather_than_expires() {
        let provider = store();
        let records = RecordStore::new(&provider);
        let policy = records.global_retention().expect("policy");
        assert_eq!(policy.scope, RetentionScope::Global);
        assert_eq!(policy.mode, RetentionMode::Keep);
        assert_eq!(policy.ttl_seconds, None);
    }

    #[test]
    fn every_key_this_module_writes_is_inside_its_own_namespace() {
        // OpenMLS owns nineteen labels in the same backend; a key of ours
        // landing outside this prefix would be a silent corruption rather than
        // an error.
        for key in [
            keys::identity(),
            keys::secrets(),
            keys::conversation_index(),
            keys::conversation("x"),
            keys::transcript("x"),
            keys::message("x"),
            keys::gaps("x"),
            keys::purges("x"),
            keys::contact_requests(),
            keys::contact_queue(),
            keys::alarms(),
            keys::relays(),
            keys::witnesses(),
            keys::global_retention(),
            keys::blocked(),
        ] {
            let text = String::from_utf8(key).expect("ascii key");
            assert!(text.starts_with(keys::PREFIX), "{text}");
        }
    }
}
