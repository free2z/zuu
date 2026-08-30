//! The engine: everything `CLIENT-CONTRACT.md` §3 asks the plugin to do.
//!
//! # It is Tauri-free on purpose
//!
//! Nothing here names `AppHandle`, `Runtime` or `invoke`. `commands.rs` is the
//! thin layer that does, and it does nothing but deserialize arguments, call one
//! method here, and serialize the answer. Two reasons, both practical:
//!
//! * The two-process relay harness that proves messages cross a real relay runs
//!   this engine with no webview at all. An engine that could only be reached
//!   through Tauri could not be tested that way, and §5's event path — which
//!   this app has never proven, because `zcash://sync-progress` has zero
//!   listeners — would go untested precisely where it matters.
//! * The parts that are protocol are `f2z-msg-mls`'s, `f2z-relay-proto`'s and
//!   `f2z-codec`'s. What is decided here is orchestration: when to encrypt, when
//!   to write, when it is safe to ACK, and what the frontend is told.
//!
//! # The ordering rule that governs the whole inbound path
//!
//! §9 rule 1, restated because every other decision in this file bends around
//! it: **the relay deletes on ACK**, so an ACK before the durable local write
//! plus a crash is permanent message loss — not from the relay, not from the
//! peer, not from the mnemonic. So [`Engine::pump_inbound`] runs, per message,
//! in exactly this order:
//!
//! 1. `MlsEngine::receive` — decrypts and commits MLS's own state.
//! 2. The plugin's record commits: the message, the transcript index, the DAG
//!    heads, any gap, and the queue's advanced read index, in **one**
//!    transaction.
//! 3. Only then, and only if `Durability::may_acknowledge()` (§11.2), `ACK`.
//! 4. Only then `f2zmsg://message-received`, which is the frontend's half of
//!    the same rule: if the UI has the event, the message is on disk.
//!
//! There is one window this ordering cannot close, and it is recorded rather
//! than hidden: a crash **between** steps 1 and 2 leaves MLS believing the
//! message is handled while the plugin has no record of it, and the ratchet has
//! moved on, so the plaintext is genuinely unrecoverable. It is not ACKed, so
//! nothing is deleted at the relay — but nothing can decrypt it either. The
//! engine detects exactly that case on the next pass (`Received` is `Duplicate`
//! and no record exists) and writes §3.4's `{ kind: "unrecoverable" }` marker
//! into the transcript. **It is never rendered as nothing**, which is §9 rule 7.
//! Closing the window for real needs a single transaction spanning MLS state
//! and application records; `f2z-msg-store` can express that and `f2z-msg-mls`
//! does not expose it.

use std::collections::HashMap;
use std::sync::Arc;

use chacha20poly1305::aead::{Aead as _, KeyInit as _};
use f2z_codec::hash::{hash, hash2};
use f2z_codec::types::RelayId;
use f2z_msg_mls::{EngineError, MlsEngine, Received, VerifiedKeyPackage};
use f2z_msg_store::{F2zStorageProvider, StorageBackend};
use f2z_relay_proto::key::SigningKey;
use openmls::prelude::{GroupId, MlsGroup};
use openmls_traits::OpenMlsProvider as _;
use rand::RngCore as _;

use crate::directory::{Directory, NoDirectory};
use crate::envelope::{
    self, AppMessage, DagEntry, GapRequest, GapResponse, Insertion, MessageDag, MessageType, MsgId,
    RepairEntry, RepairRefusal, RetentionClass,
};
use crate::error::{Error, Result};
use crate::events::EventSink;
use crate::handle;
use crate::models::*;
use crate::relay::{ConnectionPolicy, RelayConnection};
use crate::store::{
    DeviceSecrets, InboundQueue, OutboundQueue, RecordStore, SealedSecrets, SharedBackend,
    StoredContactRequest, StoredConversation, StoredDelivery, StoredIdentity, StoredMessage,
    StoredQueues, StoredRelay, StoredWitnessSet, UnrecoverableCause,
};

/// Domain-separated derivation of a conversation's receive-side queue key.
///
/// Prefix-free against every other `free2z/` label in the tree, which
/// `scripts/check-hash-domain-labels.mjs` holds for the whole repository.
const LABEL_QUEUE_RECV: &[u8] = b"free2z/msg/v1/queue-recv";
/// The same, for the send-side key this device binds on a peer's queue.
const LABEL_QUEUE_SEND: &[u8] = b"free2z/msg/v1/queue-send";

/// How many single-use key packages this device tries to keep published
/// (`WIRE.md` §12.6), clamped down to whatever the relay's
/// key-package policy `max_pool_size` allows.
///
/// **A placeholder, like §12.3's caps.** Nothing has measured how many first
/// contacts a device receives between two sessions; 32 is chosen to be more
/// than a person is plausibly contacted by while offline for a day and small
/// enough that a full pool is around 85 KiB on the relay at #385's measured
/// 2 647 bytes a package.
const KEY_PACKAGE_POOL_TARGET: u32 = 32;

/// Refill when the relay's reported pool drops to this (§12.6).
///
/// Not zero, deliberately. A device that waited for exhaustion would fall back
/// to the reusable package of last resort — trading forward secrecy for
/// availability, `THREAT-MODEL.md` §4.12 — every time it was slightly late,
/// and the whole point of the pool is that the fallback is rare.
const KEY_PACKAGE_LOW_WATER: u32 = 8;

/// The lifetime this device asks for on its package of last resort, in seconds:
/// thirty days.
///
/// **Deliberately shorter than a device credential's**, which enrollment issues
/// for a year. A last-resort package is reusable, so the only mitigation
/// available against its reuse is that it stops being usable; a long-lived one
/// would make the trade of `THREAT-MODEL.md` §4.12 permanent instead of
/// bounded. The cost is stated with it: a device offline for longer than this
/// becomes unreachable to *new* contacts until it comes back.
const LAST_RESORT_LIFETIME_SECONDS: u64 = 2_592_000;
/// Rotate one day before expiry. The receive pump runs every five seconds, so
/// an online owner has a full day of retries without ever publishing a package
/// whose validity has already ended.
const LAST_RESORT_ROTATE_BEFORE_MS: i64 = 86_400_000;
const LABEL_ROUTING_ADVERT: &[u8] = b"free2z/msg/v1/first-routing-advert";
const LABEL_ROUTING_FIELDS: &[u8] = b"free2z/msg/v1/first-routing-fields";
const LABEL_ROUTING_WELCOME: &[u8] = b"free2z/msg/v1/first-routing-welcome";

/// `WIRE.md` §7.7's default message TTL: seven days.
const MESSAGE_TTL_SECONDS: u32 = 604_800;
/// §7.7's default idle TTL: ninety days.
const IDLE_TTL_SECONDS: u32 = 7_776_000;
/// How many messages one `READ` asks for. Bounded so a queue that filled while
/// this device was away is drained in steps, each of which commits and ACKs.
const READ_BATCH: u16 = 32;
/// And how many bytes. The relay caps this too; asking for less than it allows
/// is always safe.
const READ_MAX_BYTES: u32 = 1 << 20;

/// Single-device v1 (ADR 0002). The field exists so the delivery UI does not
/// have to be rebuilt when it stops being 1 — do not collapse the states.
const DEVICES_EXPECTED: u32 = 1;

/// The engine.
///
/// One `tokio::sync::Mutex` around everything, deliberately. The alternative —
/// fine-grained locks over the store, the groups and the connections — buys
/// concurrency this workload does not have (a webview issues one command at a
/// time) and costs the property that matters: a message is decrypted, written,
/// ACKed and announced without anything else touching the same group.
pub struct Engine<B: StorageBackend> {
    inner: tokio::sync::Mutex<Inner<B>>,
    sink: Arc<dyn EventSink>,
    directory: Arc<dyn Directory>,
}

struct Inner<B: StorageBackend> {
    records: F2zStorageProvider<SharedBackend<B>>,
    backend: SharedBackend<B>,
    /// Present once the device is enrolled **and** unlocked.
    mls: Option<MlsEngine<SharedBackend<B>>>,
    /// Loaded on `start_engine`, keyed by conversation id.
    groups: HashMap<String, MlsGroup>,
    /// One per relay URL. `WIRE.md` §2.5's session is per connection.
    connections: HashMap<String, RelayConnection>,
    /// Policy for a relay learned from a verified directory entry rather than
    /// the user's configured relay list. Shipping is strict. The relay harness
    /// alone relaxes transport and channel binding for loopback `ws://` relays.
    directory_connection_policy: ConnectionPolicy,
    state: EngineState,
    last_error: Option<ErrorCode>,
    platform: Platform,
    /// Generated by `prepare_device`, consumed by `install_identity`. Held in
    /// memory only, and only for the duration of one enrollment.
    pending_device: Option<DeviceSecrets>,
    /// One `MessageDag` per conversation, rebuilt from the store on first use.
    ///
    /// `f2z-msg-dag` is `no_std` and persists nothing — deliberately, so the
    /// browser client can hold the same structure over IndexedDB. The durable
    /// record layer is the source of truth here and this is the derived view:
    /// heads for the next `parents`, the causal linearisation `list_messages`
    /// pages over, and which hashes are missing.
    dags: HashMap<String, MessageDag>,
    /// The device's queue-key seed, unsealed. Present exactly when the engine
    /// is unlocked, which is what makes §6.1's `locked` a real state rather
    /// than a label: without it no queue key can be derived, so nothing can be
    /// read from or written to a relay.
    queue_seed: Option<[u8; 32]>,
}

/// What the app crate hands back after issuing a credential from the seed.
///
/// The seed itself never appears in this type, in any argument to this module,
/// or in any IPC payload — that is the whole reason enrollment lives in the app
/// crate (§2.2).
#[derive(Clone, Debug)]
pub struct IdentityInstall {
    pub handle: String,
    /// `ISK.public`, the account identity key, hex.
    pub identity_pk: String,
    /// The `DeviceCredential`, canonically encoded.
    pub credential: Vec<u8>,
    /// The seed-derived `BackupWrapKey` (`ARCHITECTURE.md` §4.2), under which
    /// the device secrets are sealed. §6.1's `locked` is the state this device
    /// is in whenever it does not have it.
    pub wrap_key: [u8; 32],
    pub submitted_at: i64,
}

/// What the app crate needs from the plugin before it can issue a credential.
///
/// The device keys are generated **here**, from the OS CSPRNG, and are
/// deliberately not seed-derivable (`ARCHITECTURE.md` §4.2). Restoring the
/// mnemonic restores the *identity*; it does not resurrect a device.
#[derive(Clone, Debug)]
pub struct DevicePublicKeys {
    /// `DSK.public` — the MLS leaf signature key.
    pub device_pk: [u8; 32],
    /// The X-Wing hybrid KEM public key the credential binds.
    ///
    /// **A placeholder, and it is worth knowing exactly why.** `KT.md` §4.1
    /// requires only that it is non-empty, and nothing in this build reads it:
    /// the HPKE init key MLS actually uses is the one OpenMLS generates inside
    /// each `KeyPackage`, and neither `f2z-msg-mls` nor `f2z-msg-identity`
    /// offers a way to bind the two — the engine needs the credential before it
    /// exists, and the credential needs the key. `f2z-msg-mls`'s own tests use
    /// a fixed stand-in for the same reason. Until that circularity is broken
    /// upstream, a credential does not attest the key a peer will actually
    /// encrypt to.
    pub device_kem_pk: Vec<u8>,
}

impl<B: StorageBackend> Engine<B> {
    /// Build an engine over a backend, before anything is known about
    /// enrollment.
    ///
    /// # Errors
    ///
    /// `internal` if the store cannot be read.
    pub fn new(backend: B, sink: Arc<dyn EventSink>, platform: Platform) -> Result<Self> {
        let shared = SharedBackend::new(Arc::new(backend));
        let records = F2zStorageProvider::new(shared.clone());
        let engine = Self {
            inner: tokio::sync::Mutex::new(Inner {
                records,
                backend: shared,
                mls: None,
                groups: HashMap::new(),
                connections: HashMap::new(),
                directory_connection_policy: ConnectionPolicy::default(),
                state: EngineState::Uninitialized,
                last_error: None,
                platform,
                pending_device: None,
                dags: HashMap::new(),
                queue_seed: None,
            }),
            sink,
            directory: Arc::new(NoDirectory),
        };
        Ok(engine)
    }

    /// Replace the directory client. The only caller today is a test; the
    /// shipping build gets [`NoDirectory`], which fails closed (see
    /// `crate::directory`).
    #[must_use]
    pub fn with_directory(mut self, directory: Arc<dyn Directory>) -> Self {
        self.directory = directory;
        self
    }

    /// Permit the loopback relay harness to exercise on-demand federated
    /// connections over `ws://`. Shipping callers cannot compile this method.
    #[cfg(feature = "relay-harness")]
    #[must_use]
    pub fn with_insecure_directory_relays_for_harness(mut self) -> Self {
        let policy = &mut self.inner.get_mut().directory_connection_policy.policy;
        policy.allow_insecure_transport = true;
        policy.require_channel_binding = false;
        self
    }

    // ------------------------------------------------------------------
    // §3.1 — engine lifecycle
    // ------------------------------------------------------------------

    /// §3.1 `get_engine_status`.
    ///
    /// # Errors
    ///
    /// `internal` if the store cannot be read.
    pub async fn status(&self) -> Result<EngineStatus> {
        let inner = self.inner.lock().await;
        inner.status(&*self.directory)
    }

    /// §3.1 `start_engine`. Idempotent.
    ///
    /// # Errors
    ///
    /// `not-enrolled` before enrollment, `engine-locked` when the seed-derived
    /// wrap key has not been supplied this session.
    pub async fn start(&self) -> Result<EngineStatus> {
        let mut inner = self.inner.lock().await;
        if inner.state == EngineState::Running || inner.state == EngineState::Degraded {
            return inner.status(&*self.directory);
        }
        let Some(_) = inner.records().identity()? else {
            inner.state = EngineState::NotEnrolled;
            let status = inner.status(&*self.directory)?;
            self.sink.engine_state(&status);
            return Err(Error::not_enrolled("start_engine"));
        };
        if inner.mls.is_none() {
            inner.state = EngineState::Locked;
            let status = inner.status(&*self.directory)?;
            self.sink.engine_state(&status);
            return Err(Error::new(
                ErrorCode::EngineLocked,
                "the seed-derived wrap key has not been supplied this session",
            ));
        }

        inner.state = EngineState::Starting;
        let status = inner.status(&*self.directory)?;
        self.sink.engine_state(&status);

        inner.load_groups()?;
        let relays = inner.records().relays()?;
        for relay in &relays {
            let outcome = inner.connect(relay).await;
            let config = inner.relay_config(relay);
            self.sink.relay_state(&config);
            if let Err(error) = outcome {
                tracing::info!(url = %relay.relay_url, code = %error.code(), "relay did not connect");
                inner.last_error = Some(error.code());
            }
        }
        inner.subscribe_all().await;
        if let Err(error) = inner.ensure_contact_queue().await {
            tracing::info!(code = %error.code(), "contact queue not opened");
            inner.last_error = Some(error.code());
        }
        // §12.6. Not fatal, and not silent: a device with no published pool is
        // one nobody can start a conversation with, which is a state to report
        // rather than a state to crash on. Everything else about this engine —
        // every established conversation — is unaffected.
        if let Err(error) = inner.ensure_key_packages().await {
            tracing::info!(code = %error.code(), "key packages not published");
            inner.last_error = Some(error.code());
        }

        inner.state = if inner.connections.len() < relays.len() || !self.directory.threshold_met() {
            // §6.1: `degraded` is a **running** state. An established
            // conversation keeps sending and receiving; what it refuses is
            // resolving a new handle and accepting a key change (§6.4).
            EngineState::Degraded
        } else {
            EngineState::Running
        };
        let status = inner.status(&*self.directory)?;
        self.sink.engine_state(&status);
        Ok(status)
    }

    /// §3.1 `stop_engine`. Closes relays and stops emitting; does **not**
    /// unenroll and does **not** discard local history.
    ///
    /// # Errors
    ///
    /// `internal` if the store cannot be read.
    pub async fn stop(&self) -> Result<EngineStatus> {
        let mut inner = self.inner.lock().await;
        for (_, mut connection) in inner.connections.drain() {
            connection.close().await;
        }
        inner.groups.clear();
        // The DAG is a derived view of the store and is rebuilt on next use.
        // Holding it across a stop would survive an `unenroll` that emptied the
        // store underneath it, and the engine would then answer `list_messages`
        // from a graph describing messages that no longer exist.
        inner.dags.clear();
        inner.state = EngineState::Stopped;
        let status = inner.status(&*self.directory)?;
        self.sink.engine_state(&status);
        Ok(status)
    }

    /// Tear down without emitting: the process is going away.
    ///
    /// Called from the plugin's `on_event` for `Exit` and `ExitRequested`
    /// **only**. §9 rule 6: never on window blur. Desktop windows lose focus
    /// constantly, and an engine that dropped its relay connections on every
    /// alt-tab would stop acknowledging inbound messages and leave ciphertext
    /// sitting on relays every time the user looked at another window.
    pub async fn shutdown(&self) {
        let mut inner = self.inner.lock().await;
        for (_, mut connection) in inner.connections.drain() {
            connection.close().await;
        }
        inner.groups.clear();
        inner.dags.clear();
        inner.mls = None;
        inner.pending_device = None;
        inner.queue_seed = None;
        inner.state = EngineState::Locked;
    }

    /// §3.1 `get_device_info`.
    ///
    /// # Errors
    ///
    /// `not-enrolled` before enrollment.
    pub async fn device_info(&self) -> Result<DeviceInfo> {
        let inner = self.inner.lock().await;
        let identity = inner
            .records()
            .identity()?
            .ok_or_else(|| Error::not_enrolled("get_device_info"))?;
        Ok(DeviceInfo {
            device_id: identity.device_id,
            device_fingerprint: fingerprint(&identity.device_pk),
            identity_fingerprint: fingerprint(&identity.identity_pk),
            created_at: identity.created_at,
            platform: inner.platform,
            durability: match inner.records().durability() {
                f2z_msg_store::Durability::Durable => DurabilityMode::Durable,
                f2z_msg_store::Durability::None => DurabilityMode::None,
            },
        })
    }

    // ------------------------------------------------------------------
    // Enrollment — the Rust API the app crate calls (§2.2). Not IPC.
    // ------------------------------------------------------------------

    /// Generate this device's keys and return only their public halves.
    ///
    /// The app crate calls this, issues a `DeviceCredential` over the result
    /// with the seed-derived `IdentitySigningKey`, and calls
    /// [`Engine::install_identity`]. The secrets stay in this process and are
    /// sealed to the store by that second call.
    ///
    /// # Errors
    ///
    /// Never today; the signature is fallible so a future CSPRNG failure has
    /// somewhere to go rather than a panic in a crypto core.
    pub async fn prepare_device(&self) -> Result<DevicePublicKeys> {
        let mut inner = self.inner.lock().await;
        let mut signing = [0u8; 32];
        rand::rng().fill_bytes(&mut signing);
        let mut queue_seed = [0u8; 32];
        rand::rng().fill_bytes(&mut queue_seed);
        let mut kem = vec![0u8; 1216];
        rand::rng().fill_bytes(&mut kem);

        let signer = f2z_msg_mls::DeviceSigner::from_private_key(signing);
        let device_pk = *signer.public_key();
        inner.pending_device = Some(DeviceSecrets {
            device_signing_key: hex::encode(signing),
            queue_seed: hex::encode(queue_seed),
        });
        Ok(DevicePublicKeys {
            device_pk,
            device_kem_pk: kem,
        })
    }

    /// Seal the prepared device secrets, record the identity, and build the MLS
    /// engine.
    ///
    /// # Errors
    ///
    /// `handle-ineligible` if the handle is not §11.3's charset, `internal` if
    /// [`Engine::prepare_device`] was not called first or the credential does
    /// not bind the prepared device key.
    pub async fn install_identity(&self, install: IdentityInstall) -> Result<EnrollmentStatus> {
        let mut inner = self.inner.lock().await;
        if !handle::is_handle(&install.handle) {
            return Err(Error::new(
                ErrorCode::HandleIneligible,
                format!("{:?} is not a messaging handle", install.handle),
            ));
        }
        let secrets = inner
            .pending_device
            .take()
            .ok_or_else(|| Error::internal("install_identity without prepare_device"))?;

        let signing = decode_key(&secrets.device_signing_key)?;
        let signer = f2z_msg_mls::DeviceSigner::from_private_key(signing);
        let device_pk = hex::encode(signer.public_key());

        let credential = f2z_msg_mls::credential::parse(&install.credential).map_err(|error| {
            Error::internal(format!("the issued credential does not parse: {error}"))
        })?;

        let now = now_ms();
        let mls = MlsEngine::new(
            inner.backend.clone(),
            signer,
            credential,
            u64::try_from(now).unwrap_or_default(),
        )
        .map_err(|error| Error::internal(format!("building the MLS engine: {error}")))?;

        let identity = StoredIdentity {
            device_id: hex::encode(&device_pk.as_bytes()[..16]),
            handle: install.handle.clone(),
            identity_pk: install.identity_pk.clone(),
            device_pk,
            credential: hex::encode(&install.credential),
            created_at: now,
            directory_entry_version: None,
            submitted_at: Some(install.submitted_at),
            // §3.2: a directory submission does not take effect instantly. The
            // log merges entries at an epoch boundary, so this stays `None`
            // and the UI shows "submitted", not "active".
            merged_at_epoch: None,
        };
        let sealed = seal(&secrets, &install.wrap_key)?;
        inner.queue_seed = Some(decode_key(&secrets.queue_seed)?);

        inner.records().commit(|records| {
            records.put_identity(&identity)?;
            records.put_sealed_secrets(&sealed)
        })?;

        inner.mls = Some(mls);
        inner.state = EngineState::Enrolling;
        let status = inner.status(&*self.directory)?;
        self.sink.engine_state(&status);
        inner.enrollment_status()
    }

    /// Supply the seed-derived wrap key and leave §6.1's `locked`.
    ///
    /// # Errors
    ///
    /// `not-enrolled` before enrollment, `engine-locked` when the key does not
    /// open the seal — which is the honest answer: a wrong key is
    /// indistinguishable from an absent one, and neither can decrypt history.
    pub async fn unlock(&self, wrap_key: &[u8; 32]) -> Result<EngineStatus> {
        let mut inner = self.inner.lock().await;
        let identity = inner
            .records()
            .identity()?
            .ok_or_else(|| Error::not_enrolled("unlock"))?;
        let sealed = inner
            .records()
            .sealed_secrets()?
            .ok_or_else(|| Error::internal("an identity with no sealed secrets"))?;
        let secrets = open(&sealed, wrap_key)?;

        let signer =
            f2z_msg_mls::DeviceSigner::from_private_key(decode_key(&secrets.device_signing_key)?);
        let credential_bytes = hex::decode(&identity.credential)
            .map_err(|_| Error::internal("the stored credential is not hex"))?;
        let credential = f2z_msg_mls::credential::parse(&credential_bytes)
            .map_err(|error| Error::internal(format!("the stored credential: {error}")))?;
        let mls = MlsEngine::new(
            inner.backend.clone(),
            signer,
            credential,
            u64::try_from(now_ms()).unwrap_or_default(),
        )
        .map_err(|error| Error::internal(format!("building the MLS engine: {error}")))?;

        inner.queue_seed = Some(decode_key(&secrets.queue_seed)?);
        inner.mls = Some(mls);
        inner.state = EngineState::Stopped;
        let status = inner.status(&*self.directory)?;
        self.sink.engine_state(&status);
        Ok(status)
    }

    /// §3.2 `f2zmsg_enrollment_status`, as the app crate serves it.
    ///
    /// # Errors
    ///
    /// `internal` if the store cannot be read.
    pub async fn enrollment_status(&self) -> Result<EnrollmentStatus> {
        let inner = self.inner.lock().await;
        inner.enrollment_status()
    }

    /// §3.2 `f2zmsg_unenroll`. Destructive and irreversible from the user's
    /// point of view, which is why it takes a typed confirmation.
    ///
    /// # Errors
    ///
    /// `internal` when the confirmation is empty. The engine owns the phrase,
    /// so no test pins one.
    pub async fn unenroll(&self, confirmation: &str) -> Result<EnrollmentStatus> {
        if confirmation.trim().is_empty() {
            return Err(Error::internal("unenroll requires a typed confirmation"));
        }
        let mut inner = self.inner.lock().await;
        for (_, mut connection) in inner.connections.drain() {
            connection.close().await;
        }
        inner.groups.clear();
        inner.dags.clear();
        inner.mls = None;
        inner.queue_seed = None;
        let ids = inner.records().conversation_ids()?;
        inner.records().commit(|records| {
            for id in &ids {
                records.remove_conversation(id)?;
            }
            records.clear_identity()
        })?;
        inner.state = EngineState::NotEnrolled;
        let status = inner.status(&*self.directory)?;
        self.sink.engine_state(&status);
        inner.enrollment_status()
    }

    // ------------------------------------------------------------------
    // §3.3 — conversations and first contact
    // ------------------------------------------------------------------

    /// §3.3 `list_conversations`.
    ///
    /// # Errors
    ///
    /// `internal` if the store cannot be read.
    pub async fn list_conversations(
        &self,
        limit: Option<u32>,
        cursor: Option<String>,
    ) -> Result<ConversationPage> {
        let inner = self.inner.lock().await;
        let mut ids = inner.records().conversation_ids()?;
        ids.sort();
        let start = cursor
            .as_deref()
            .and_then(|cursor| ids.iter().position(|id| id.as_str() > cursor))
            .unwrap_or(0);
        let limit = usize::try_from(limit.unwrap_or(50)).unwrap_or(50).max(1);
        let window: Vec<String> = ids.iter().skip(start).take(limit).cloned().collect();
        let next = if start.saturating_add(window.len()) < ids.len() {
            window.last().cloned()
        } else {
            None
        };
        let mut conversations = Vec::with_capacity(window.len());
        for id in window {
            if let Some(stored) = inner.records().conversation(&id)? {
                conversations.push(inner.view(&stored)?);
            }
        }
        Ok(ConversationPage {
            conversations,
            cursor: next,
        })
    }

    /// §3.3 `get_conversation`.
    ///
    /// # Errors
    ///
    /// `internal` when no such conversation exists.
    pub async fn get_conversation(&self, conversation_id: &str) -> Result<Conversation> {
        let inner = self.inner.lock().await;
        let stored = inner.conversation(conversation_id)?;
        inner.view(&stored)
    }

    /// §3.3 `start_conversation` — the whole first-contact handshake.
    ///
    /// `WIRE.md` §12.5, in the order that section states it, with §12.6's two
    /// steps between 1 and 2:
    ///
    /// 1. Resolve the handle against a witness-cosigned root, yielding the
    ///    **verified `DirectoryEntryTBS`** and the published contact endpoint.
    /// 2. `CLAIM_KEY_PACKAGE` from the relay that endpoint names, behind a
    ///    proof-of-work stamp.
    /// 3. **Authenticate the claimed package against the entry from step 1.**
    ///    The relay is not trusted with it; a package that does not verify is a
    ///    refusal, and the type system will not let one through — `add_member`
    ///    takes a `VerifiedKeyPackage`.
    /// 4. Build the group, produce the `Welcome`, and `CONTACT_APPEND` it with
    ///    a second stamp.
    ///
    /// # Errors
    ///
    /// On the default `NoDirectory`: `witness-threshold-unmet`. Zero
    /// independent witnesses have cosigned any root, and §6.4's matrix says
    /// resolving a **new** handle is **refused**, not degraded. This is the
    /// #133 moment — an unverified key here *is* the MITM — and §9 rule 5
    /// forbids proceeding silently.
    ///
    /// `relay-unavailable` when the peer's pool is exhausted and they published
    /// no package of last resort (§12.6). `internal` — carrying the credential
    /// failure — when the claimed package does not belong to the identity the
    /// directory vouched for, which is the substitution §12.6 exists to catch
    /// and is **never** retried.
    pub async fn start_conversation(&self, peer_handle: &str) -> Result<Conversation> {
        if !handle::is_handle(peer_handle) {
            // §11.3: a homograph does not match the charset, so the directory
            // refuses to resolve it at all, turning a silent impersonation into
            // a lookup failure. That is the whole of the charset's mitigation,
            // and it is why this check is before the lookup rather than after.
            return Err(Error::new(
                ErrorCode::HandleIneligible,
                format!("{peer_handle:?} is not a messaging handle"),
            ));
        }
        // §6.4's first row, and everything below it is §12.5's handshake.
        let peer = self.directory.resolve_peer(peer_handle)?;

        let mut inner = self.inner.lock().await;
        inner.require_running("start_conversation")?;
        let relay_url = inner.first_relay_url()?;
        let key_package = inner.claim_key_package(&peer, peer_handle).await?;
        let introduction = inner
            .create_conversation(peer_handle, &peer.identity_pk, &key_package, &relay_url)
            .await?;

        // The `Welcome`, this device's queue advert and who is calling, on the
        // peer's published contact queue. Unsigned at the relay and gated by a
        // proof-of-work stamp: §12.2's whole design is that a stranger can
        // reach you exactly once, expensively.
        inner
            .contact_append(&peer, &introduction, peer_handle)
            .await?;

        let stored = inner.conversation(&introduction.conversation_id)?;
        let view = inner.view(&stored)?;
        self.sink.conversation_updated(&view);
        Ok(view)
    }

    /// §3.3 `list_contact_requests`.
    ///
    /// # Errors
    ///
    /// `internal` if the store cannot be read.
    pub async fn list_contact_requests(&self) -> Result<Vec<ContactRequest>> {
        let inner = self.inner.lock().await;
        Ok(inner
            .records()
            .contact_requests()?
            .into_iter()
            .map(|stored| ContactRequest {
                request_id: stored.request_id,
                peer_handle: stored.peer_handle,
                peer_identity_fingerprint: stored.peer_identity_fingerprint,
                received_at: stored.received_at,
                body_preview: stored.body_preview,
            })
            .collect())
    }

    /// §3.3 `accept_contact_request`.
    ///
    /// # Errors
    ///
    /// `witness-threshold-unmet` — §6.4's matrix puts accepting a first-contact
    /// `Welcome` from a new handle in the same row as resolving one, for the
    /// same reason.
    pub async fn accept_contact_request(&self, request_id: &str) -> Result<Conversation> {
        let request = {
            let inner = self.inner.lock().await;
            inner
                .records()
                .contact_requests()?
                .into_iter()
                .find(|request| request.request_id == request_id)
                .ok_or_else(|| Error::internal("no such contact request"))?
        };
        // §6.4 again: accepting a first-contact `Welcome` from a handle this
        // device has never pinned is the same row as resolving one. The
        // `Welcome` is authenticated by MLS, but nothing in it says the sender
        // is who the handle says — that is exactly what the directory answers.
        //
        // `resolve_identity` and not `resolve_peer`: this path needs the
        // identity key and nothing else. The `Welcome` and the peer's queue
        // advert arrived inside the contact request, so no MLS `KeyPackage` is
        // required — which is what makes this the one first-contact path a
        // verified directory can complete today (`KT.md` §4.1 publishes none).
        let peer = self.directory.resolve_identity(&request.peer_handle)?;

        let mut inner = self.inner.lock().await;
        inner.require_running("accept_contact_request")?;
        let relay_url = inner.first_relay_url()?;
        let welcome = hex::decode(&request.welcome)
            .map_err(|_| Error::internal("a stored Welcome is not hex"))?;
        let introduction = Introduction {
            conversation_id: request.conversation_id.clone(),
            welcome,
            advert: QueueAdvert {
                relay_url: request.peer_relay_url.clone(),
                relay_id: request.peer_relay_id.clone(),
                send_addr: request.peer_send_addr.clone(),
            },
            advert_device_pk: request.advert_device_pk.clone(),
            advert_signature: request.advert_signature.clone(),
        };
        inner.authenticate_introduction(&peer.entry, &introduction, now_ms())?;
        inner
            .join_conversation(
                &request.peer_handle,
                &peer.identity_pk,
                &introduction,
                &relay_url,
            )
            .await?;

        let remaining: Vec<StoredContactRequest> = inner
            .records()
            .contact_requests()?
            .into_iter()
            .filter(|existing| existing.request_id != request_id)
            .collect();
        inner
            .records()
            .commit(|records| records.put_contact_requests(&remaining))?;

        let stored = inner.conversation(&introduction.conversation_id)?;
        let view = inner.view(&stored)?;
        self.sink.conversation_updated(&view);
        Ok(view)
    }

    /// §3.3 `reject_contact_request`. `block` is **local only**: no server knows
    /// who talks to whom, so the UI says "blocked on this device".
    ///
    /// # Errors
    ///
    /// `internal` if the store cannot be written.
    pub async fn reject_contact_request(&self, request_id: &str, block: bool) -> Result<()> {
        let inner = self.inner.lock().await;
        let requests = inner.records().contact_requests()?;
        let rejected = requests
            .iter()
            .find(|request| request.request_id == request_id)
            .cloned();
        let remaining: Vec<StoredContactRequest> = requests
            .into_iter()
            .filter(|request| request.request_id != request_id)
            .collect();
        let mut blocked = inner.records().blocked()?;
        if let Some(rejected) = rejected
            .as_ref()
            .filter(|rejected| block && !blocked.contains(&rejected.peer_handle))
        {
            blocked.push(rejected.peer_handle.clone());
        }
        inner.records().commit(|records| {
            records.put_contact_requests(&remaining)?;
            records.put_blocked(&blocked)
        })
    }

    /// §3.3 `leave_conversation`.
    ///
    /// # Errors
    ///
    /// `internal` when no such conversation exists.
    pub async fn leave_conversation(&self, conversation_id: &str) -> Result<()> {
        let mut inner = self.inner.lock().await;
        let _ = inner.conversation(conversation_id)?;
        inner.groups.remove(conversation_id);
        // The DAG is derived from the records being removed here. Leaving it
        // behind would let a re-created conversation with the same id inherit a
        // graph describing messages that no longer exist — and `msg_id` being a
        // content hash means a stale vertex looks exactly like a real one.
        inner.dags.remove(conversation_id);
        inner
            .records()
            .commit(|records| records.remove_conversation(conversation_id))
    }

    // ------------------------------------------------------------------
    // §3.4 — sending and listing
    // ------------------------------------------------------------------

    /// §3.4 `send_message`.
    ///
    /// The durable write happens **before** the relay call, so a failure at any
    /// point after it leaves a message that `retry_send` can pick up. §8's
    /// `send-unavailable` row is explicit that an unknown outcome is not a
    /// negative one.
    ///
    /// # Errors
    ///
    /// `engine-not-running`, `send-unavailable` and the rest of §8's relay
    /// group.
    pub async fn send_message(
        &self,
        conversation_id: &str,
        body: &str,
        client_ref: &str,
    ) -> Result<SendAccepted> {
        let mut inner = self.inner.lock().await;
        inner.require_running("send_message")?;
        let stored = inner.conversation(conversation_id)?;

        let parents = inner.dag(conversation_id)?.heads();
        let heads: Vec<String> = parents.iter().copied().map(envelope::to_hex).collect();

        let now = now_ms();
        // The group is taken out of the map for the duration, because
        // `MlsEngine` and the group live in the same struct and the borrow
        // checker cannot see that `send` touches neither. It goes back on every
        // path, including the failing ones.
        let mut group = inner
            .groups
            .remove(conversation_id)
            .ok_or_else(|| Error::engine_not_running("send_message"))?;
        let sealed: Result<(AppMessage, Vec<u8>, u64, u32)> = (|| {
            let mls = inner.mls_ref("send_message")?;
            let epoch = group.epoch().as_u64();
            let leaf = group.own_leaf_index().u32();
            let framed = envelope::seal(
                MessageType::CHAT,
                &parents,
                epoch,
                leaf,
                now,
                RetentionClass::Chat,
                body.as_bytes(),
            )?;
            let wire = framed.encode().map_err(envelope::dag_error)?;
            let ciphertext = mls
                .send(&mut group, &wire)
                .map_err(|error| Error::internal(format!("encrypting: {error}")))?;
            Ok((framed, ciphertext, epoch, leaf))
        })();
        inner.groups.insert(conversation_id.to_owned(), group);
        let (framed, ciphertext, epoch, leaf) = sealed?;

        let msg_id = envelope::to_hex(framed.msg_id());
        let relays_configured = u32::try_from(inner.records().relays()?.len()).unwrap_or(0);
        let message = StoredMessage {
            msg_id: msg_id.clone(),
            conversation_id: conversation_id.to_owned(),
            outbound: true,
            epoch,
            sender_leaf_index: leaf,
            parents: heads.clone(),
            sent_at: now,
            received_at: None,
            envelope: hex::encode(framed.encode().map_err(envelope::dag_error)?),
            retry_ciphertext: Some(hex::encode(&ciphertext)),
            text: Some(body.to_owned()),
            client_ref: Some(client_ref.to_owned()),
            unrecoverable: None,
            type_tag: None,
            ceremony: false,
            expires_at: expiry_for(&stored, now, inner.records().global_retention()?),
            delivery: StoredDelivery {
                state: "pending".into(),
                accepted_by_relays: 0,
                configured_relays: relays_configured,
                devices_receipted: 0,
                devices_expected: DEVICES_EXPECTED,
                failure: None,
                updated_at: now,
            },
        };

        // Durable first. A crash after this and before the APPEND leaves a
        // `pending` message the user can retry; a crash the other way round
        // would leave the peer holding a message this device does not know it
        // sent.
        inner.records().commit(|records| {
            records.put_message(&message)?;
            records.remember_message(conversation_id, &msg_id)
        })?;
        // The DAG advances: this message covers every head it referenced, and
        // becomes the only head until something references it.
        inner
            .dag(conversation_id)?
            .insert(DagEntry::from_delivered(&framed, epoch, leaf).map_err(envelope::dag_error)?);

        let delivery = inner.deliver(&stored, &msg_id, &ciphertext, now).await?;
        self.sink.message_state(&delivery);
        Ok(SendAccepted {
            msg_id,
            client_ref: client_ref.to_owned(),
            state: delivery.state,
        })
    }

    /// §3.4 `retry_send`. Safe after any failure, including one whose outcome is
    /// unknown: a retried `APPEND` produces a duplicate at the relay, and
    /// duplicates are removed end to end by `msg_id`.
    ///
    /// # Errors
    ///
    /// `engine-not-running`, or §8's relay group.
    pub async fn retry_send(&self, msg_id: &str) -> Result<SendAccepted> {
        let mut inner = self.inner.lock().await;
        inner.require_running("retry_send")?;
        let message = inner
            .records()
            .message(msg_id)?
            .ok_or_else(|| Error::internal("no such message"))?;
        let stored = inner.conversation(&message.conversation_id)?;
        let Some(ciphertext) = message
            .retry_ciphertext
            .as_deref()
            .map(hex::decode)
            .transpose()
            .map_err(|_| Error::internal("stored ciphertext is not hex"))?
        else {
            // Nothing retained means the relay already returned status 0 for
            // it, and §3.4 says a retry is safe after any failure — including
            // one whose outcome is unknown — so answering with the state it
            // actually reached is the useful thing. Refusing would make the
            // affordance the UI shows for a message stuck at `accepted` — which
            // is evidence of nothing about the recipient (§6.2) — look like a
            // defect rather than a no-op.
            return Ok(SendAccepted {
                msg_id: msg_id.to_owned(),
                client_ref: message.client_ref.clone().unwrap_or_default(),
                state: delivery_view(&message).state,
            });
        };
        let delivery = inner
            .deliver(&stored, msg_id, &ciphertext, now_ms())
            .await?;
        self.sink.message_state(&delivery);
        Ok(SendAccepted {
            msg_id: msg_id.to_owned(),
            // The one the original `send_message` was given. `retry_send` takes
            // only a `msgId`, so without retaining it this would answer with a
            // key the frontend never issued and the optimistic row it is meant
            // to reconcile would be stranded.
            client_ref: message.client_ref.clone().unwrap_or_default(),
            state: delivery.state,
        })
    }

    /// §3.4 `cancel_send`.
    ///
    /// # Errors
    ///
    /// `internal` when no such message exists.
    pub async fn cancel_send(&self, msg_id: &str) -> Result<()> {
        let inner = self.inner.lock().await;
        let mut message = inner
            .records()
            .message(msg_id)?
            .ok_or_else(|| Error::internal("no such message"))?;
        message.delivery.state = "failed".into();
        message.delivery.updated_at = now_ms();
        message.retry_ciphertext = None;
        inner
            .records()
            .commit(|records| records.put_message(&message))?;
        self.sink.message_state(&delivery_view(&message));
        Ok(())
    }

    /// §3.4 `list_messages`, in §7's order, oldest first.
    ///
    /// **The causal order, not the sort key.** §7's rule has two halves and the
    /// partial order is the primary one; `(epoch, senderLeafIndex, msgId)`
    /// breaks ties between messages the DAG leaves *incomparable*. Paging is
    /// therefore over `f2z_msg_dag::MessageDag::display_order` — Kahn's
    /// algorithm with a min-heap on the sort key, deterministic over the graph
    /// and the keys and nothing else — and the cursor is a position in it
    /// rather than an encoding of the key.
    ///
    /// An earlier version of this plugin keyed a `BTreeMap` by the sort key and
    /// ranged over it, which is the defect `f2z_msg_dag::order` documents:
    /// a reply from the lower leaf index sorts above the message it answers, in
    /// half of all one-to-one conversations.
    ///
    /// # Errors
    ///
    /// `internal` when no such conversation exists, or when the stored graph
    /// contains a cycle — which `msg_id` being a hash of the parents makes
    /// impossible without a preimage attack, and which is therefore reported
    /// rather than sorted around.
    pub async fn list_messages(
        &self,
        conversation_id: &str,
        limit: u32,
        before: Option<String>,
        after: Option<String>,
    ) -> Result<MessagePage> {
        let mut inner = self.inner.lock().await;
        let _ = inner.conversation(conversation_id)?;
        let order: Vec<String> = inner
            .dag(conversation_id)?
            .display_order()
            .map_err(envelope::dag_error)?
            .into_iter()
            .map(envelope::to_hex)
            .collect();
        let limit = usize::try_from(limit).unwrap_or(50).clamp(1, 500);

        let position = |cursor: &String| order.iter().position(|id| id == cursor);
        let (start, end) = match (&before, &after) {
            // Walking backwards from a cursor still returns the page oldest
            // first: the direction is which end of the transcript to take, not
            // which order to hand it back in.
            (Some(before), _) => {
                let end = position(before).unwrap_or(order.len());
                (end.saturating_sub(limit), end)
            }
            (None, Some(after)) => {
                let start = position(after).map_or(0, |index| index.saturating_add(1));
                (start, start.saturating_add(limit).min(order.len()))
            }
            // The tail, which is what a transcript opens on.
            (None, None) => (order.len().saturating_sub(limit), order.len()),
        };
        let selected = order.get(start..end).unwrap_or_default();

        let mut messages = Vec::with_capacity(selected.len());
        for msg_id in selected {
            if let Some(stored) = inner.records().message(msg_id)? {
                messages.push(message_view(&stored));
            }
        }

        // §3.5: a hole, not an absence — and this errs toward saying there is
        // one.
        //
        // A detected gap is a `parents` hash this device does not hold, and a
        // hash it does not hold cannot be placed in the order: §7 is explicit
        // that a hole in the sort order is not a hole in the conversation and
        // vice versa. So "is that gap before *this* window" is not answerable,
        // and the honest approximation is the conservative one — any detected
        // gap, plus content earlier than the window it could sit in.
        //
        // The direction is the part that matters. `false` here must never mean
        // "nothing is missing": hash links do not detect tail truncation at
        // all, so that claim is unavailable to any implementation, and §9 rule
        // 7 forbids rendering a hole as nothing. Over-reporting shows a marker
        // where the transcript is whole; under-reporting hides a message that
        // is gone.
        let has_gap_before = start > 0 && !inner.records().gaps(conversation_id)?.is_empty();

        Ok(MessagePage {
            messages,
            cursor: selected.first().cloned(),
            has_gap_before,
        })
    }

    /// §3.4 `get_message`.
    ///
    /// # Errors
    ///
    /// `internal` when no such message exists.
    pub async fn get_message(&self, msg_id: &str) -> Result<Message> {
        let inner = self.inner.lock().await;
        inner
            .records()
            .message(msg_id)?
            .map(|stored| message_view(&stored))
            .ok_or_else(|| Error::internal("no such message"))
    }

    // ------------------------------------------------------------------
    // §3.6 — delivery state and receipts
    // ------------------------------------------------------------------

    /// §3.6 `get_delivery_state`.
    ///
    /// # Errors
    ///
    /// `internal` when no such message exists.
    pub async fn delivery_state(&self, msg_id: &str) -> Result<DeliveryStatus> {
        let inner = self.inner.lock().await;
        inner
            .records()
            .message(msg_id)?
            .map(|stored| delivery_view(&stored))
            .ok_or_else(|| Error::internal("no such message"))
    }

    /// §3.6 `mark_read`.
    ///
    /// # Errors
    ///
    /// `internal` when no such conversation exists.
    pub async fn mark_read(&self, conversation_id: &str, up_to_msg_id: &str) -> Result<()> {
        let mut inner = self.inner.lock().await;
        let mut stored = inner.conversation(conversation_id)?;

        // Recomputed against §7's order rather than zeroed. `upToMsgId` is a
        // position in the transcript and not a promise about the whole of it:
        // marking read up to a message the user scrolled back to must leave
        // everything after it unread, and zeroing the counter would tell them
        // there is nothing further down when there is.
        let order = inner
            .dag(conversation_id)?
            .display_order()
            .map_err(envelope::dag_error)?;
        let read_through = order
            .iter()
            .position(|id| envelope::to_hex(*id) == up_to_msg_id);
        let mut unread = 0u32;
        for (position, msg_id) in order.iter().enumerate() {
            if read_through.is_some_and(|through| position <= through) {
                continue;
            }
            let hex_id = envelope::to_hex(*msg_id);
            if inner
                .records()
                .message(&hex_id)?
                .is_some_and(|message| !message.outbound)
            {
                unread = unread.saturating_add(1);
            }
        }

        stored.read_through = Some(up_to_msg_id.to_owned());
        stored.unread_count = unread;
        inner
            .records()
            .commit(|records| records.put_conversation(&stored))?;
        let view = inner.view(&stored)?;
        self.sink.conversation_updated(&view);
        Ok(())
    }

    /// §3.6 `get_receipt_policy`.
    ///
    /// # Errors
    ///
    /// `internal` when no such conversation exists.
    pub async fn receipt_policy(&self, conversation_id: &str) -> Result<ReceiptPolicy> {
        let inner = self.inner.lock().await;
        Ok(inner.conversation(conversation_id)?.receipt_policy)
    }

    /// §3.6 `set_receipt_policy`.
    ///
    /// # Errors
    ///
    /// `internal` when no such conversation exists.
    pub async fn set_receipt_policy(
        &self,
        conversation_id: &str,
        delivery_receipts: bool,
        read_receipts: bool,
    ) -> Result<ReceiptPolicy> {
        let inner = self.inner.lock().await;
        let mut stored = inner.conversation(conversation_id)?;
        stored.receipt_policy = ReceiptPolicy {
            delivery_receipts,
            read_receipts,
        };
        inner
            .records()
            .commit(|records| records.put_conversation(&stored))?;
        let view = inner.view(&stored)?;
        self.sink.conversation_updated(&view);
        Ok(stored.receipt_policy)
    }

    // ------------------------------------------------------------------
    // §3.5 — gaps
    // ------------------------------------------------------------------

    /// §3.5 `list_gaps`.
    ///
    /// # Errors
    ///
    /// `internal` when no such conversation exists.
    pub async fn list_gaps(&self, conversation_id: &str) -> Result<Vec<Gap>> {
        let inner = self.inner.lock().await;
        let _ = inner.conversation(conversation_id)?;
        inner.records().gaps(conversation_id)
    }

    /// §3.5 `request_gap_repair`.
    ///
    /// Sends §7's `gap_request` inside the MLS group. The sender answers by
    /// re-encrypting **the original plaintext under the current epoch** — never
    /// by replaying old ciphertext, which would undermine forward secrecy — so
    /// a repair succeeds only while the sender still holds it. That window is
    /// the sender's own retention policy, which is why shortening retention
    /// shortens the gap-repair window (§3.7, `ARCHITECTURE.md` §8.4).
    ///
    /// # Errors
    ///
    /// `engine-not-running`, or §8's relay group.
    pub async fn request_gap_repair(
        &self,
        conversation_id: &str,
        gap_ids: &[String],
    ) -> Result<Vec<GapRepairStatus>> {
        let mut inner = self.inner.lock().await;
        inner.require_running("request_gap_repair")?;
        let stored = inner.conversation(conversation_id)?;
        let mut gaps = inner.records().gaps(conversation_id)?;

        let mut wanted: Vec<MsgId> = Vec::new();
        for gap in &mut gaps {
            if gap_ids.iter().any(|id| id == &gap.gap_id) {
                gap.state = GapState::RepairRequested;
                for missing in &gap.missing_msg_ids {
                    if let Ok(id) = envelope::from_hex(missing) {
                        wanted.push(id);
                    }
                }
            }
        }
        // Drains the DAG's own `Detected` set into `RepairRequested`, so a
        // second call does not ask twice for the same hash — "one gap, one
        // signal", which is what stops a repair loop between two clients that
        // both keep noticing the same hole.
        inner.dag(conversation_id)?.take_gap_request();
        inner
            .records()
            .commit(|records| records.put_gaps(conversation_id, &gaps))?;

        let request = GapRequest::new(wanted).map_err(envelope::dag_error)?;
        let body = request.to_body().map_err(envelope::dag_error)?;
        let statuses: Vec<GapRepairStatus> = gaps
            .iter()
            .filter(|gap| gap_ids.iter().any(|id| id == &gap.gap_id))
            .map(|gap| GapRepairStatus {
                gap_id: gap.gap_id.clone(),
                state: gap.state,
                reason: None,
            })
            .collect();

        inner
            .send_control(&stored, MessageType::GAP_REQUEST, body.as_slice())
            .await?;
        for gap in gaps
            .iter()
            .filter(|gap| gap.state == GapState::RepairRequested)
        {
            self.sink.gap_detected(gap);
        }
        Ok(statuses)
    }

    // ------------------------------------------------------------------
    // §3.7 — local retention
    // ------------------------------------------------------------------

    /// §3.7 `get_retention_policy`. No `conversationId` returns the global
    /// policy; with one, the **effective** policy, and `scope` says which of the
    /// two produced the answer.
    ///
    /// # Errors
    ///
    /// `internal` when a named conversation does not exist.
    pub async fn retention_policy(&self, conversation_id: Option<&str>) -> Result<RetentionPolicy> {
        let inner = self.inner.lock().await;
        let global = inner.records().global_retention()?;
        let Some(conversation_id) = conversation_id else {
            return Ok(global);
        };
        Ok(inner
            .conversation(conversation_id)?
            .retention
            .unwrap_or(global))
    }

    /// §3.7 `set_retention_policy`.
    ///
    /// # Errors
    ///
    /// `internal` when `scope: "global"` is given a `conversationId`, or
    /// `scope: "conversation"` is not — both are client bugs and are rejected
    /// rather than guessed at.
    pub async fn set_retention_policy(
        &self,
        scope: RetentionScope,
        mode: RetentionMode,
        ttl_seconds: Option<u64>,
        conversation_id: Option<&str>,
    ) -> Result<RetentionPolicy> {
        let inner = self.inner.lock().await;
        let policy = RetentionPolicy {
            scope,
            mode,
            ttl_seconds: if mode == RetentionMode::Expire {
                ttl_seconds
            } else {
                None
            },
            // Forward only. Nothing here is retroactive in either direction:
            // retaining → ephemeral cannot reach backwards across other
            // people's devices, and ephemeral → retaining cannot recover data
            // that is gone.
            effective_from: now_ms(),
        };
        match (scope, conversation_id) {
            (RetentionScope::Global, None) => {
                inner
                    .records()
                    .commit(|records| records.put_global_retention(&policy))?;
            }
            (RetentionScope::Conversation, Some(id)) => {
                let mut stored = inner.conversation(id)?;
                stored.retention = Some(policy.clone());
                inner
                    .records()
                    .commit(|records| records.put_conversation(&stored))?;
                let view = inner.view(&stored)?;
                self.sink.conversation_updated(&view);
            }
            (RetentionScope::Global, Some(_)) => {
                return Err(Error::internal(
                    "a global retention policy takes no conversationId",
                ));
            }
            (RetentionScope::Conversation, None) => {
                return Err(Error::internal(
                    "a per-conversation retention policy requires a conversationId",
                ));
            }
        }
        Ok(policy)
    }

    // ------------------------------------------------------------------
    // §3.8 — ephemeral hints
    // ------------------------------------------------------------------

    /// §3.8 `send_ephemeral_hint`.
    ///
    /// A **courtesy signal, never enforcement.** What is real cryptography is
    /// that it travels inside MLS, so it is confidential, authenticated and
    /// attributable — nobody can forge who asked. What is not real is
    /// enforcement: a non-conforming client ignores it and no mechanism exists,
    /// or can exist, to detect that.
    ///
    /// # Errors
    ///
    /// `engine-not-running`, or §8's relay group.
    pub async fn send_ephemeral_hint(
        &self,
        conversation_id: &str,
        mode: EphemeralMode,
        ttl_seconds: Option<u64>,
    ) -> Result<EphemeralHintState> {
        let mut inner = self.inner.lock().await;
        inner.require_running("send_ephemeral_hint")?;
        let mut stored = inner.conversation(conversation_id)?;
        let handle = inner
            .records()
            .identity()?
            .map(|identity| identity.handle)
            .unwrap_or_default();
        let epoch = inner
            .groups
            .get(conversation_id)
            .map_or(0, |group| group.epoch().as_u64());
        let hint = EphemeralHintState {
            mode,
            ttl_seconds,
            requested_by: handle,
            requested_in_epoch: epoch,
            // This device honors its own hint; what any other device does is
            // undetectable, and the UI must not imply otherwise.
            honored_locally: true,
        };
        let body = serde_json::to_vec(&hint)
            .map_err(|error| Error::internal(format!("framing a hint: {error}")))?;
        stored.ephemeral_hint = Some(hint.clone());
        inner
            .records()
            .commit(|records| records.put_conversation(&stored))?;
        inner
            .send_control(&stored, envelope::EPHEMERAL_HINT, &body)
            .await?;
        let view = inner.view(&stored)?;
        self.sink.conversation_updated(&view);
        Ok(hint)
    }

    /// §3.8 `get_ephemeral_hint`.
    ///
    /// # Errors
    ///
    /// `internal` when no such conversation exists.
    pub async fn ephemeral_hint(
        &self,
        conversation_id: &str,
    ) -> Result<Option<EphemeralHintState>> {
        let inner = self.inner.lock().await;
        Ok(inner.conversation(conversation_id)?.ephemeral_hint)
    }

    // ------------------------------------------------------------------
    // §3.9 — purge requests
    // ------------------------------------------------------------------

    /// §3.9 `send_purge_request`.
    ///
    /// A **request, not a deletion**. Both counts are in the answer so the UI
    /// can say *"asked N participants to delete; M confirmed"* and never
    /// *"deleted"*.
    ///
    /// # Errors
    ///
    /// `engine-not-running`, or §8's relay group.
    pub async fn send_purge_request(
        &self,
        conversation_id: &str,
        before_epoch: u64,
    ) -> Result<PurgeRequestStatus> {
        let mut inner = self.inner.lock().await;
        inner.require_running("send_purge_request")?;
        let stored = inner.conversation(conversation_id)?;
        let now = now_ms();
        let status = PurgeRequestStatus {
            purge_id: format!("purge-{now}"),
            conversation_id: conversation_id.to_owned(),
            before_epoch,
            direction: Direction::Outbound,
            // 1:1 in v1 (§10), so one participant is asked. `Conversation`
            // carries `peerHandle` rather than a member list for the same
            // reason, and both change together when groups > 2 arrive.
            asked_participants: 1,
            confirmed_participants: 0,
            requested_at: now,
        };
        let body = serde_json::to_vec(&before_epoch)
            .map_err(|error| Error::internal(format!("framing a purge request: {error}")))?;
        let mut purges = inner.records().purges(conversation_id)?;
        purges.push(status.clone());
        inner
            .records()
            .commit(|records| records.put_purges(conversation_id, &purges))?;
        inner
            .send_control(&stored, envelope::PURGE_REQUEST, &body)
            .await?;
        self.sink.purge_progress(&status);
        Ok(status)
    }

    /// §3.9 `list_purge_requests`.
    ///
    /// # Errors
    ///
    /// `internal` when no such conversation exists.
    pub async fn list_purge_requests(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<PurgeRequestStatus>> {
        let inner = self.inner.lock().await;
        let _ = inner.conversation(conversation_id)?;
        inner.records().purges(conversation_id)
    }

    // ------------------------------------------------------------------
    // §3.10 — directory, safety numbers, self-audit and alarms
    // ------------------------------------------------------------------

    /// §3.10 `resolve_handle`.
    ///
    /// An unregistered handle is an **answer**, not a failure, and there is no
    /// unknown-handle error code in either direction. What this build cannot do
    /// is ask: see `crate::directory`.
    ///
    /// # Errors
    ///
    /// `handle-ineligible` for a string that cannot be a handle at all — a
    /// different thing entirely, because no lookup is made — and
    /// `witness-threshold-unmet` for everything else in this build.
    pub async fn resolve_handle(&self, peer_handle: &str) -> Result<DirectoryResolution> {
        if !handle::is_handle(peer_handle) {
            return Err(Error::new(
                ErrorCode::HandleIneligible,
                format!("{peer_handle:?} is not a messaging handle"),
            ));
        }
        self.directory.resolve(peer_handle)
    }

    /// §3.10 `get_safety_number`.
    ///
    /// **Always available**, and the strongest check in the system regardless of
    /// the directory's state. It is never gated behind engine health, relay
    /// health or witness health — which is what makes it the thing §8 tells the
    /// UI to offer when `witness-threshold-unmet` closes every other door.
    ///
    /// # Errors
    ///
    /// `internal` when no such conversation exists.
    pub async fn safety_number(&self, conversation_id: &str) -> Result<SafetyNumber> {
        let inner = self.inner.lock().await;
        let stored = inner.conversation(conversation_id)?;
        let identity = inner
            .records()
            .identity()?
            .ok_or_else(|| Error::not_enrolled("get_safety_number"))?;

        // Symmetric by construction: both devices sort the two identity keys
        // before hashing, so both compute the same number without agreeing on
        // who is "first".
        let mut keys = [
            identity.identity_pk.clone(),
            stored.peer_identity_fingerprint.clone(),
        ];
        keys.sort();
        let digest = hex::encode(
            hash2(
                b"free2z/msg/v1/safety-number",
                keys[0].as_bytes(),
                keys[1].as_bytes(),
            )
            .as_bytes(),
        );
        Ok(SafetyNumber {
            conversation_id: conversation_id.to_owned(),
            display_groups: digest
                .as_bytes()
                .chunks(5)
                .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
                .collect(),
            qr_payload: format!("free2z-safety:{digest}"),
            digest,
            // ADR 0006's shielded-memo verification has no specified payload
            // format yet (§12.1), so this is `None` rather than a guess.
            zcash_memo_payload: None,
        })
    }

    /// §3.10 `set_verification`.
    ///
    /// # Errors
    ///
    /// `internal` when the digest does not match the current safety number —
    /// which means the user compared a stale one, and re-pinning on it would be
    /// the "trust anyway" button §6.3 forbids.
    pub async fn set_verification(
        &self,
        conversation_id: &str,
        safety_number_digest: &str,
        verified: bool,
    ) -> Result<VerificationState> {
        let expected = self.safety_number(conversation_id).await?;
        if expected.digest != safety_number_digest {
            return Err(Error::internal(
                "the safety number compared is not the current one",
            ));
        }
        let inner = self.inner.lock().await;
        let mut stored = inner.conversation(conversation_id)?;
        stored.verification = if verified {
            VerificationState::Verified {
                verified_at: now_ms(),
                digest: safety_number_digest.to_owned(),
            }
        } else {
            VerificationState::Unverified
        };
        inner
            .records()
            .commit(|records| records.put_conversation(&stored))?;
        let view = inner.view(&stored)?;
        self.sink.conversation_updated(&view);
        Ok(stored.verification)
    }

    /// §3.10 `get_self_audit_state`.
    ///
    /// `running: false` in this build, truthfully: self-audit needs the
    /// directory client that does not exist. It is reported as not running
    /// rather than as running-and-finding-nothing, because "chain intact,
    /// nothing unexpected" from a monitor that never looked is the single most
    /// misleading thing this command could say.
    ///
    /// # Errors
    ///
    /// `internal` if the store cannot be read.
    pub async fn self_audit_state(&self) -> Result<SelfAuditState> {
        Ok(SelfAuditState {
            last_checked_epoch: None,
            last_checked_at: None,
            chain_intact: false,
            unexpected_entries: 0,
            running: false,
        })
    }

    /// §3.10 `list_alarms`.
    ///
    /// # Errors
    ///
    /// `internal` if the store cannot be read.
    pub async fn list_alarms(&self) -> Result<Vec<Alarm>> {
        let inner = self.inner.lock().await;
        inner.records().alarms()
    }

    /// §3.10 `acknowledge_alarm`.
    ///
    /// **Acknowledging is not dismissing.** The alarm stays in `list_alarms`
    /// with `acknowledgedAt` set and remains visible; `dismissible` is
    /// structurally `false` so no component can be written that hides it.
    ///
    /// # Errors
    ///
    /// `internal` when the confirmation is empty or no such alarm exists.
    pub async fn acknowledge_alarm(&self, alarm_id: &str, confirmation: &str) -> Result<Alarm> {
        if confirmation.trim().is_empty() {
            return Err(Error::internal(
                "acknowledging an alarm requires a typed confirmation",
            ));
        }
        let inner = self.inner.lock().await;
        let mut alarms = inner.records().alarms()?;
        let alarm = alarms
            .iter_mut()
            .find(|alarm| alarm.alarm_id == alarm_id)
            .ok_or_else(|| Error::internal("no such alarm"))?;
        alarm.acknowledged_at = Some(now_ms());
        let acknowledged = alarm.clone();
        inner
            .records()
            .commit(|records| records.put_alarms(&alarms))?;
        self.sink.alarm(&acknowledged);
        Ok(acknowledged)
    }

    // ------------------------------------------------------------------
    // §3.11 — relays and witnesses
    // ------------------------------------------------------------------

    /// §3.11 `list_relays`.
    ///
    /// # Errors
    ///
    /// `internal` if the store cannot be read.
    pub async fn list_relays(&self) -> Result<Vec<RelayConfig>> {
        let inner = self.inner.lock().await;
        Ok(inner
            .records()
            .relays()?
            .iter()
            .map(|relay| inner.relay_config(relay))
            .collect())
    }

    /// §3.11 `add_relay`.
    ///
    /// Fetches and verifies the signed capability document, and **refuses**
    /// rather than warns on: a digest mismatch, a padding set that is not a
    /// superset of what this client emits or is implausibly fine-grained, and
    /// the reserved `queue_creation_mode: token` — for which there is
    /// deliberately **no override**, because v1's `CREATE_QUEUE` has no field a
    /// token can go in and there is nothing a user could consent to that would
    /// make one presentable.
    ///
    /// # Errors
    ///
    /// `relay-capability-mismatch`, `relay-refused-insecure`,
    /// `relay-identity-mismatch`, `relay-unreachable`.
    pub async fn add_relay(&self, relay_url: &str) -> Result<RelayConfig> {
        let mut inner = self.inner.lock().await;

        // The inspection connection, and it is worth saying why it is not the
        // strict one. §11.3's checklist is applied to a *document*, and the
        // document has to be fetched before it can be judged; §8's
        // `relay-refused-insecure` row then tells the UI to "offer the opt-in
        // with copy stating that ciphertext is protected by MLS but connection
        // metadata, queue addresses and commands travel in the clear" — which
        // is a sentence nobody can write without having read the document. So
        // this connection tolerates the two conditions a user is *allowed* to
        // consent to, and nothing else: every other check below is strict, and
        // a relay that fails one of those is never stored at all.
        let mut policy = ConnectionPolicy::default();
        policy.policy.allow_insecure_transport = true;
        policy.policy.require_channel_binding = false;

        let mut connection = RelayConnection::connect(relay_url, &policy).await?;
        let signed = connection.capabilities().await?;
        let capabilities = signed.capabilities.clone();
        f2z_relay_proto::capabilities::verify(&signed, &connection.session().relay_identity_pk())
            .map_err(|error| {
            Error::new(
                ErrorCode::RelayCapabilityMismatch,
                format!("the capability document does not verify: {error:?}"),
            )
        })?;

        // 2026-08-24's correction, and there is deliberately no override for it:
        // v1's `CREATE_QUEUE` has no field a token can go in, so a relay
        // advertising the reserved mode gates creation behind a credential no
        // conforming client can present. There is nothing a user could consent
        // to that would make a token presentable.
        if capabilities.queue_creation_mode == 2 {
            return Err(Error::new(
                ErrorCode::RelayCapabilityMismatch,
                "queue_creation_mode: token is reserved (#630); no client can present one",
            ));
        }

        // This client's strict policy, not the crate's: see `ConnectionPolicy`'s
        // `Default` for the one place they differ and why.
        let strict = ConnectionPolicy::default().policy;
        let consentable = match strict.accept(&capabilities) {
            Ok(()) => None,
            Err(f2z_relay_proto::ProtoError::Refused(
                refusal @ (f2z_relay_proto::Refusal::InsecureTransport
                | f2z_relay_proto::Refusal::NoChannelBinding),
            )) => Some(refusal),
            // A padding set that is not a superset of what we emit, or is
            // implausibly fine-grained, or a document that contradicts itself.
            // §3.11: those refusals are `ErrorCode`s, not warnings, and the
            // relay is never added.
            Err(error) => {
                return Err(Error::new(
                    crate::wire_codes::from_proto(
                        error,
                        crate::wire_codes::CommandSide::Receive,
                        crate::wire_codes::BindAttempt::Later,
                    ),
                    format!("the relay's published capabilities are refused: {error:?}"),
                ));
            }
        };

        let relay = StoredRelay {
            relay_id: hex::encode(connection.relay_id().as_bytes()),
            relay_url: relay_url.to_owned(),
            allow_insecure_transport: false,
            allow_no_channel_binding: false,
            warnings: warnings_for(&capabilities),
            operator: operator_of(&capabilities),
            capabilities_digest: hex::encode(
                f2z_relay_proto::capabilities::digest(&capabilities)
                    .map_err(|error| {
                        Error::new(
                            ErrorCode::RelayCapabilityMismatch,
                            format!("capability digest: {error:?}"),
                        )
                    })?
                    .as_bytes(),
            ),
        };

        let mut relays = inner.records().relays()?;
        relays.retain(|existing| existing.relay_url != relay.relay_url);
        relays.push(relay.clone());
        inner
            .records()
            .commit(|records| records.put_relays(&relays))?;

        if let Some(refusal) = consentable {
            // Stored, but not connected: §3.11's `connection: "refused"`. The
            // record exists so `set_relay_trust` has a `relayId` to address —
            // without it the opt-in §2.3 requires would have nothing to attach
            // to and an insecure relay could never be used at all, which is not
            // what the specification says.
            connection.close().await;
            let config = inner.relay_config(&relay);
            self.sink.relay_state(&config);
            return Err(Error::new(
                crate::wire_codes::from_refusal(refusal),
                format!("{relay_url} requires an explicit per-relay opt-in: {refusal:?}"),
            ));
        }

        inner
            .connections
            .insert(relay.relay_url.clone(), connection);
        let config = inner.relay_config(&relay);
        self.sink.relay_state(&config);
        Ok(config)
    }

    /// §3.11 `remove_relay`.
    ///
    /// # Errors
    ///
    /// `internal` if the store cannot be written.
    pub async fn remove_relay(&self, relay_id: &str) -> Result<()> {
        let mut inner = self.inner.lock().await;
        let relays = inner.records().relays()?;
        let removed = relays
            .iter()
            .find(|relay| relay.relay_id == relay_id)
            .cloned();
        let remaining: Vec<StoredRelay> = relays
            .into_iter()
            .filter(|relay| relay.relay_id != relay_id)
            .collect();
        inner
            .records()
            .commit(|records| records.put_relays(&remaining))?;
        if let Some(mut connection) =
            removed.and_then(|removed| inner.connections.remove(&removed.relay_url))
        {
            connection.close().await;
        }
        Ok(())
    }

    /// §3.11 `get_relay_capabilities`.
    ///
    /// # Errors
    ///
    /// `internal` when no such relay is configured, or §8's relay group.
    pub async fn relay_capabilities(&self, relay_id: &str) -> Result<RelayCapabilities> {
        let mut inner = self.inner.lock().await;
        let relay = inner
            .records()
            .relays()?
            .into_iter()
            .find(|relay| relay.relay_id == relay_id)
            .ok_or_else(|| Error::internal("no such relay"))?;
        let connection = inner
            .connections
            .get_mut(&relay.relay_url)
            .ok_or_else(|| Error::new(ErrorCode::RelayUnreachable, "relay not connected"))?;
        let signed = connection.capabilities().await?;
        Ok(capabilities_view(&signed.capabilities))
    }

    /// §3.11 `set_relay_trust` — **the one command whose grant is a security
    /// downgrade.**
    ///
    /// It is how a user opts in to a relay with `transport_security: "none"` or
    /// `channel_binding_mode: "none"`, and the UI must gate it behind an
    /// explicit per-relay confirmation that states what travels in the clear:
    /// the ciphertext is protected by MLS, but connection metadata, queue
    /// addresses and commands are not.
    ///
    /// # Errors
    ///
    /// `internal` when no such relay is configured.
    pub async fn set_relay_trust(
        &self,
        relay_id: &str,
        allow_insecure_transport: bool,
        allow_no_channel_binding: bool,
    ) -> Result<RelayConfig> {
        let inner = self.inner.lock().await;
        let mut relays = inner.records().relays()?;
        let relay = relays
            .iter_mut()
            .find(|relay| relay.relay_id == relay_id)
            .ok_or_else(|| Error::internal("no such relay"))?;
        relay.allow_insecure_transport = allow_insecure_transport;
        relay.allow_no_channel_binding = allow_no_channel_binding;
        let updated = relay.clone();
        inner
            .records()
            .commit(|records| records.put_relays(&relays))?;
        let config = inner.relay_config(&updated);
        self.sink.relay_state(&config);
        Ok(config)
    }

    /// §3.11 `list_witnesses`.
    ///
    /// # Errors
    ///
    /// `internal` if the store cannot be read.
    pub async fn list_witnesses(&self) -> Result<Vec<WitnessConfig>> {
        let inner = self.inner.lock().await;
        Ok(inner.records().witnesses()?.witnesses)
    }

    /// §3.11 `set_witness_set`. Replaces the **whole** set — a set operation,
    /// not an append.
    ///
    /// # Errors
    ///
    /// `internal` if the store cannot be written.
    pub async fn set_witness_set(
        &self,
        witnesses: &[WitnessInput],
        threshold: u32,
    ) -> Result<WitnessSetState> {
        let inner = self.inner.lock().await;
        let set = StoredWitnessSet {
            witnesses: witnesses
                .iter()
                .map(|input| WitnessConfig {
                    witness_id: input.witness_id().to_owned(),
                    name: input.name().to_owned(),
                    // **PROVISIONAL** (§12.1). Independence is not something a
                    // witness or a user asserts; it is computed by a rule that
                    // does not exist yet (§13-Q). `false` is the only value
                    // this build can honestly write, and it is what keeps
                    // `bootstrapDisclaimer` true.
                    independent: false,
                    last_cosigned_epoch: None,
                })
                .collect(),
            threshold,
        };
        inner
            .records()
            .commit(|records| records.put_witnesses(&set))?;
        Ok(witness_state(&set))
    }

    /// §3.11 `get_witness_set_state`.
    ///
    /// # Errors
    ///
    /// `internal` if the store cannot be read.
    pub async fn witness_set_state(&self) -> Result<WitnessSetState> {
        let inner = self.inner.lock().await;
        Ok(witness_state(&inner.records().witnesses()?))
    }

    // ------------------------------------------------------------------
    // The inbound path — §9 rule 1 lives here
    // ------------------------------------------------------------------

    /// Read, decrypt, write, ACK, announce — in that order, for every
    /// conversation with an inbound queue.
    ///
    /// Called on a timer by the plugin's receive task, and directly by the
    /// harness. It polls `READ` rather than depending on `MSG` pushes: a push
    /// is a hint that a queue moved, and a client that treated it as the
    /// delivery mechanism would lose everything that arrived while it was
    /// disconnected. Pushes are still drained, and shorten the wait.
    ///
    /// # Errors
    ///
    /// Never propagates a per-conversation failure: one unreachable relay must
    /// not stop the others. Failures are logged and surfaced through
    /// `EngineStatus::lastError`.
    pub async fn pump_inbound(&self) -> Result<usize> {
        let mut inner = self.inner.lock().await;
        if inner.mls.is_none() {
            return Ok(0);
        }
        // Rotation cannot depend on a contact arrival: an unused reusable
        // package still expires. Failure is reported but does not stop
        // established conversations, and the old persisted deadline remains
        // so the next timer tick retries.
        if inner.last_resort_rotation_due(now_ms())?
            && let Err(error) = inner.ensure_key_packages().await
        {
            tracing::info!(code = %error.code(), "last-resort key package not rotated");
            inner.last_error = Some(error.code());
        }
        let mut delivered = match inner.pump_contact_queue().await {
            Ok(events) => events,
            Err(error) => {
                tracing::info!(code = %error.code(), "contact-queue pump");
                inner.last_error = Some(error.code());
                Vec::new()
            }
        };
        let ids = inner.records().conversation_ids()?;
        for id in ids {
            match inner.pump_conversation(&id).await {
                Ok(mut events) => delivered.append(&mut events),
                Err(error) => {
                    tracing::info!(conversation = %id, code = %error.code(), "inbound pump");
                    inner.last_error = Some(error.code());
                }
            }
        }
        let count = delivered.len();
        drop(inner);
        for event in delivered {
            match event {
                Inbound::Message(event) => self.sink.message_received(&event),
                Inbound::ContactRequest(request) => self.sink.contact_request(&request),
                Inbound::Gap(gap) => self.sink.gap_detected(&gap),
                Inbound::GapRepaired(gap) => self.sink.gap_repaired(&gap),
                Inbound::Conversation(conversation) => {
                    self.sink.conversation_updated(&conversation)
                }
                Inbound::Purge(status) => self.sink.purge_progress(&status),
                Inbound::Delivery(status) => self.sink.message_state(&status),
            }
        }
        Ok(count)
    }

    // ------------------------------------------------------------------
    // What a directory publishes — exposed for the two-process harness
    // ------------------------------------------------------------------
    //
    // **Not commands, and not compiled into a shipping build.** These are the
    // two values enrollment would put in the directory, and the harness in
    // `tests/` carries them between processes in a shared file so that the
    // shipping `start_conversation` / `accept_contact_request` path — the whole
    // of `WIRE.md` §12.5, proof of work included — runs unchanged with only the
    // *resolution* substituted. Nothing else about the handshake is faked, and
    // faking the resolution inside the shipping binary is precisely what §6.4
    // and §9 rule 5 forbid.

    /// An MLS `KeyPackage` this device offers, for a peer to add it to a group.
    ///
    /// # Errors
    ///
    /// `engine-locked` before unlock.
    #[cfg(any(test, feature = "relay-harness"))]
    pub async fn key_package(&self) -> Result<Vec<u8>> {
        let inner = self.inner.lock().await;
        inner
            .mls_ref("key_package")?
            .generate_key_package()
            .map_err(|error| Error::internal(format!("key package: {error}")))
    }

    /// The `DeviceCredential` this device installed at enrollment, canonically
    /// encoded.
    ///
    /// Harness only. The app crate issues the credential and therefore already
    /// has it; this exists so the two-process harness can assemble the
    /// `DirectoryEntryTBS` a log would commit, which is what §12.6's key-package
    /// authentication is checked against.
    ///
    /// # Errors
    ///
    /// `not-enrolled` if this device has no identity.
    #[cfg(any(test, feature = "relay-harness"))]
    pub async fn installed_credential(&self) -> Result<Vec<u8>> {
        let inner = self.inner.lock().await;
        let identity = inner
            .records()
            .identity()?
            .ok_or_else(|| Error::not_enrolled("installed_credential"))?;
        hex::decode(&identity.credential)
            .map_err(|_| Error::internal("a stored credential is not hex"))
    }

    /// This device's published contact address (§12.2), once `start_engine` has
    /// opened one.
    ///
    /// # Errors
    ///
    /// `internal` if the store cannot be read.
    #[cfg(any(test, feature = "relay-harness"))]
    pub async fn contact_advert(&self) -> Result<Option<(String, RelayId, String)>> {
        let inner = self.inner.lock().await;
        let Some(queue) = inner.records().contact_queue()? else {
            return Ok(None);
        };
        let relay_id = inner
            .connections
            .get(&queue.relay_url)
            .ok_or_else(|| Error::new(ErrorCode::RelayUnreachable, "contact relay not connected"))?
            .relay_id();
        Ok(Some((queue.relay_url, relay_id, queue.contact_addr)))
    }

    /// Run the key-package maintenance pass at an explicit time.
    ///
    /// Harness only: production reaches the same method from `start_engine`
    /// and the online receive timer, both with the wall clock.
    #[cfg(feature = "relay-harness")]
    pub async fn refresh_key_packages_at_for_harness(&self, now_ms: i64) -> Result<()> {
        self.inner.lock().await.ensure_key_packages_at(now_ms).await
    }

    /// The persisted expiry that drives last-resort rotation.
    #[cfg(feature = "relay-harness")]
    pub async fn last_resort_expiry_for_harness(&self) -> Result<Option<i64>> {
        let inner = self.inner.lock().await;
        Ok(inner
            .records()
            .contact_queue()?
            .and_then(|queue| queue.last_resort_expires_at_ms))
    }

    /// Move the persisted rotation deadline without changing relay state.
    /// Harness only, so a thirty-day lifecycle is testable without sleeping.
    #[cfg(feature = "relay-harness")]
    pub async fn set_last_resort_expiry_for_harness(&self, expiry_ms: i64) -> Result<()> {
        let inner = self.inner.lock().await;
        let Some(mut queue) = inner.records().contact_queue()? else {
            return Err(Error::internal("contact queue not opened"));
        };
        queue.last_resort_expires_at_ms = Some(expiry_ms);
        inner
            .records()
            .commit(|records| records.put_contact_queue(&queue))
    }

    /// Apply the shipping key-package verifier at an explicit time.
    #[cfg(feature = "relay-harness")]
    pub async fn verify_key_package_for_harness(
        &self,
        wire: &[u8],
        entry: &f2z_kt_core::entry::DirectoryEntryTBS,
        at_ms: u64,
    ) -> Result<()> {
        self.inner
            .lock()
            .await
            .mls_ref("verify_key_package_for_harness")?
            .verify_key_package(wire, entry, u64::try_from(now_ms()).unwrap_or(0))
            .and_then(|verified| verified.lifetime_valid_at(at_ms / 1000))
            .map_err(|error| Error::internal(format!("key-package verification: {error}")))
    }

    /// Exercise the exact managed endpoint identity check without requiring a
    /// complete first-contact exchange.
    #[cfg(feature = "relay-harness")]
    pub async fn connect_endpoint_for_harness(
        &self,
        relay_url: &str,
        expected_relay_id: RelayId,
    ) -> Result<()> {
        self.inner
            .lock()
            .await
            .endpoint_connection(relay_url, expected_relay_id)
            .await
            .map(|_| ())
    }
}

/// Where a peer writes to reach this device: `WIRE.md` §12.2's queue advert,
/// reduced to what a 1:1 conversation on one relay needs.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct QueueAdvert {
    pub relay_url: String,
    /// Hex relay identity supplied beside the URL and checked during every
    /// on-demand connection. Subsequent adverts travel in authenticated MLS
    /// messages; the first travels beside the `Welcome` it is needed to join.
    pub relay_id: String,
    /// The **send** address of this device's receive queue, hex. Never the
    /// receive address: §7.3's asymmetry is the whole point, and a peer that
    /// held the receive address could read the queue.
    pub send_addr: String,
}

/// The first-contact payload, on the peer's contact queue (`WIRE.md` §12.2).
///
/// JSON rather than a `tls_codec` structure, and that is a deliberate narrowing
/// rather than laziness: this is the one payload a *stranger* can put in front
/// of this client, and it is parsed before anything about the sender is known.
/// A parser for it should be the smallest, most-audited thing available, and
/// `serde_json` refusing everything it does not recognise is exactly that. It
/// is also the shape most likely to move when the directory lands, since the
/// advert it carries is what a published queue advert will replace.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct ContactEnvelope {
    handle: String,
    identity_pk: String,
    conversation_id: String,
    /// The MLS `Welcome`, hex.
    welcome: String,
    advert: QueueAdvert,
    advert_device_pk: String,
    advert_signature: String,
}

/// What the initiator hands the joiner out of band.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Introduction {
    pub conversation_id: String,
    /// The MLS `Welcome`.
    pub welcome: Vec<u8>,
    /// The initiator's own advert.
    pub advert: QueueAdvert,
    /// Active DSK and its signature over conversation id + complete advert.
    pub advert_device_pk: String,
    pub advert_signature: String,
}

/// What one pass of the inbound pump produced, so the events are emitted after
/// the engine lock is released.
enum Inbound {
    Message(MessageReceivedEvent),
    ContactRequest(ContactRequest),
    Gap(Gap),
    GapRepaired(Gap),
    Conversation(Conversation),
    Purge(PurgeRequestStatus),
    Delivery(DeliveryStatus),
}

impl<B: StorageBackend> Inner<B> {
    fn records(&self) -> RecordStore<'_, SharedBackend<B>> {
        RecordStore::new(&self.records)
    }

    /// The conversation's causal DAG, rebuilt from the store on first use.
    ///
    /// `f2z-msg-dag` persists nothing, deliberately: it is `no_std` and the
    /// browser client holds the same structure over IndexedDB. Rebuilding here
    /// means one decode per stored message on the first access after a restart,
    /// which is the same O(n) the transcript index already costs and is the
    /// first thing to change when the store grows an iterator.
    fn dag(&mut self, conversation_id: &str) -> Result<&mut MessageDag> {
        if !self.dags.contains_key(conversation_id) {
            let mut dag = MessageDag::new();
            for msg_id in self.records().transcript(conversation_id)? {
                let Some(stored) = self.records().message(&msg_id)? else {
                    continue;
                };
                // A `{ kind: "unrecoverable" }` marker is a transcript entry
                // and not a §7 message: it has no envelope to decode, and
                // inserting a fabricated one would put a hash nobody can
                // produce into somebody's `parents`.
                if stored.envelope.is_empty() {
                    continue;
                }
                let Ok(bytes) = hex::decode(&stored.envelope) else {
                    continue;
                };
                let Ok(framed) = AppMessage::decode(&bytes) else {
                    continue;
                };
                match DagEntry::from_delivered(&framed, stored.epoch, stored.sender_leaf_index) {
                    Ok(entry) => {
                        dag.insert(entry);
                    }
                    // A repaired message's framing epoch is the original's and
                    // its leaf index is the repairer's, so it cannot satisfy
                    // `from_delivered`'s equality check. That is the crate's
                    // rule, not a defect here.
                    Err(_) => {
                        dag.insert(DagEntry::from_repair(&framed));
                    }
                }
            }
            self.dags.insert(conversation_id.to_owned(), dag);
        }
        self.dags
            .get_mut(conversation_id)
            .ok_or_else(|| Error::internal("a DAG that was just inserted is missing"))
    }

    fn mls_ref(&self, what: &str) -> Result<&MlsEngine<SharedBackend<B>>> {
        self.mls.as_ref().ok_or_else(|| {
            Error::new(
                ErrorCode::EngineLocked,
                format!("{what} requires an unlocked engine"),
            )
        })
    }

    fn require_running(&self, what: &str) -> Result<()> {
        match self.state {
            // §6.1: `degraded` is a running state. Sending and receiving in an
            // already-established conversation continues, because the keys were
            // verified when they were pinned and nothing about a witness outage
            // retroactively unverifies them.
            EngineState::Running | EngineState::Degraded => Ok(()),
            EngineState::Locked => Err(Error::new(
                ErrorCode::EngineLocked,
                format!("{what} requires an unlocked engine"),
            )),
            _ => Err(Error::engine_not_running(what)),
        }
    }

    fn conversation(&self, conversation_id: &str) -> Result<StoredConversation> {
        self.records()
            .conversation(conversation_id)?
            .ok_or_else(|| Error::internal("no such conversation"))
    }

    fn status(&self, directory: &dyn Directory) -> Result<EngineStatus> {
        let identity = self.records().identity()?;
        let relays = self.records().relays()?;
        let alarms = self.records().alarms()?;
        Ok(EngineStatus {
            state: self.state,
            enrolled: identity.is_some(),
            handle: identity.map(|identity| identity.handle),
            relays_connected: u32::try_from(self.connections.len()).unwrap_or(0),
            relays_configured: u32::try_from(relays.len()).unwrap_or(0),
            witness_threshold_met: directory.threshold_met(),
            independent_witnesses: directory.independent_witnesses(),
            // Zero by construction rather than by omission: every durable
            // inbound write emits `f2zmsg://message-received` before this
            // function could next be called, so nothing is ever written and
            // unsurfaced. It stops being a constant the day a batch write
            // lands between the store commit and the emit.
            pending_inbound: 0,
            unacknowledged_alarms: u32::try_from(
                alarms
                    .iter()
                    .filter(|alarm| alarm.acknowledged_at.is_none())
                    .count(),
            )
            .unwrap_or(0),
            last_error: self.last_error,
        })
    }

    fn enrollment_status(&self) -> Result<EnrollmentStatus> {
        let identity = self.records().identity()?;
        Ok(match identity {
            None => EnrollmentStatus {
                enrolled: false,
                handle: None,
                eligibility: handle::not_signed_in(),
                directory_entry_version: None,
                submitted_at: None,
                merged_at_epoch: None,
                blocked: None,
            },
            Some(identity) => EnrollmentStatus {
                enrolled: true,
                eligibility: handle::eligibility(&identity.handle),
                handle: Some(identity.handle),
                directory_entry_version: identity.directory_entry_version,
                submitted_at: identity.submitted_at,
                merged_at_epoch: identity.merged_at_epoch,
                // The submission cannot reach a log this build cannot talk to,
                // so it stays unmerged and the reason is reported rather than
                // left as an unexplained "submitted" that never lands.
                blocked: Some(ErrorCode::DirectoryUnreachable),
            },
        })
    }

    fn view(&self, stored: &StoredConversation) -> Result<Conversation> {
        let epoch = self
            .groups
            .get(&stored.conversation_id)
            .map_or(0, |group| group.epoch().as_u64());
        let connected = stored
            .queues
            .inbound
            .as_ref()
            .is_some_and(|queue| self.connections.contains_key(&queue.relay_url));
        Ok(Conversation {
            conversation_id: stored.conversation_id.clone(),
            peer_handle: stored.peer_handle.clone(),
            peer_identity_fingerprint: fingerprint(&stored.peer_identity_fingerprint),
            verification: stored.verification.clone(),
            epoch,
            created_at: stored.created_at,
            last_message_at: stored.last_message_at,
            unread_count: stored.unread_count,
            retention: stored
                .retention
                .clone()
                .map_or_else(|| self.records().global_retention(), Ok)?,
            ephemeral_hint: stored.ephemeral_hint.clone(),
            receipt_policy: stored.receipt_policy,
            has_gaps: !self.records().gaps(&stored.conversation_id)?.is_empty(),
            // A conversation needs **both** queues: one this device reads and
            // one it writes to. Reporting `ok` on the strength of the read side
            // alone would tell the UI a message can be sent when there is no
            // address to send it to — and §3.3's transport health is the field
            // a send affordance is supposed to be gated on.
            transport_health: if stored.send_address_stolen {
                // §7.4: the send side of a queue this conversation depends on
                // was bound by somebody else. Loud and non-dismissible — never
                // a toast, never a retry.
                TransportHealth::Compromised
            } else if stored.queues.inbound.is_none() {
                TransportHealth::Unavailable
            } else if connected && stored.queues.outbound.is_some() {
                TransportHealth::Ok
            } else {
                // Either the relay is unreachable, or the peer has not yet said
                // where to write. Both are "receiving works, sending does not
                // yet", which is what `degraded` means.
                TransportHealth::Degraded
            },
        })
    }

    fn relay_config(&self, relay: &StoredRelay) -> RelayConfig {
        RelayConfig {
            relay_id: relay.relay_id.clone(),
            relay_url: relay.relay_url.clone(),
            connection: if self.connections.contains_key(&relay.relay_url) {
                RelayConnectionState::Connected
            } else {
                RelayConnectionState::Disconnected
            },
            trusted: relay.allow_insecure_transport || relay.allow_no_channel_binding,
            operator: relay.operator.clone(),
            warnings: relay.warnings.clone(),
        }
    }

    async fn connect(&mut self, relay: &StoredRelay) -> Result<()> {
        let mut policy = ConnectionPolicy::default();
        policy.policy.allow_insecure_transport = relay.allow_insecure_transport;
        policy.policy.require_channel_binding = !relay.allow_no_channel_binding;
        let connection = RelayConnection::connect(&relay.relay_url, &policy).await?;
        self.connections.insert(relay.relay_url.clone(), connection);
        Ok(())
    }

    fn load_groups(&mut self) -> Result<()> {
        let ids = self.records().conversation_ids()?;
        let mut groups = HashMap::new();
        for id in ids {
            let Some(stored) = self.records().conversation(&id)? else {
                continue;
            };
            let Ok(group_id) = hex::decode(&stored.group_id) else {
                continue;
            };
            let mls = self.mls_ref("load_groups")?;
            match MlsGroup::load(mls.provider().storage(), &GroupId::from_slice(&group_id)) {
                Ok(Some(group)) => {
                    groups.insert(id, group);
                }
                Ok(None) => tracing::warn!(conversation = %id, "no MLS group in the store"),
                Err(error) => tracing::warn!(conversation = %id, ?error, "loading an MLS group"),
            }
        }
        self.groups = groups;
        Ok(())
    }

    async fn subscribe_all(&mut self) {
        let Ok(ids) = self.records().conversation_ids() else {
            return;
        };
        for id in ids {
            let Ok(Some(stored)) = self.records().conversation(&id) else {
                continue;
            };
            let Some(queue) = stored.queues.inbound.clone() else {
                continue;
            };
            let Ok(recv_key) = signing_key(&queue.recv_key_seed) else {
                continue;
            };
            let Ok(recv_addr) = queue_address(&queue.recv_addr) else {
                continue;
            };
            let Some(connection) = self.connections.get_mut(&queue.relay_url) else {
                continue;
            };
            if let Err(error) = connection.subscribe(&recv_key, recv_addr).await {
                tracing::info!(conversation = %id, code = %error.code(), "subscribe");
            }
        }
    }

    /// `APPEND` one ciphertext, binding the send side first if this is the first
    /// use of the peer's advertised address.
    async fn deliver(
        &mut self,
        stored: &StoredConversation,
        msg_id: &str,
        ciphertext: &[u8],
        now: i64,
    ) -> Result<DeliveryStatus> {
        let Some(outbound) = stored.queues.outbound.clone() else {
            // The peer has not said where to write yet. `pending`, not
            // `failed`: §8's `failed` means the engine gave up after its retry
            // budget, and nothing has been tried.
            return self.mark_delivery(msg_id, "pending", Some(ErrorCode::SendUnavailable), now);
        };
        let send_key = signing_key(&outbound.send_key_seed)?;
        let send_addr = queue_address(&outbound.send_addr)?;

        if let Err(error) = self.ensure_outbound_connection(&outbound).await {
            // §8: keep the message `pending` and retry with backoff. Do not
            // mark anything failed — an unreachable relay is not a delivery
            // failure, it is an absence of evidence either way.
            return self.mark_delivery(msg_id, "pending", Some(error.code()), now);
        }

        self.ensure_bound(stored).await?;

        let outcome = {
            let Some(connection) = self.connections.get_mut(&outbound.relay_url) else {
                return self.mark_delivery(
                    msg_id,
                    "pending",
                    Some(ErrorCode::RelayUnreachable),
                    now,
                );
            };
            connection.append(&send_key, send_addr, ciphertext).await
        };
        match outcome {
            // §6.2: `accepted` is evidence that an `APPEND` returned status 0 at
            // ≥1 relay, and evidence of **nothing about the recipient**. The
            // relay is forbidden from telling the sender queue state at all.
            Ok(()) => self.mark_delivery(msg_id, "accepted", None, now),
            Err(error) => {
                let state = if error.code().retryable() {
                    "pending"
                } else {
                    "failed"
                };
                self.mark_delivery(msg_id, state, Some(error.code()), now)
            }
        }
    }

    /// `BIND_SEND` on the peer's advertised address, once (§6.3).
    ///
    /// Shared by every send path, because binding is not a property of one of
    /// them: the first thing this device writes to a conversation might be a
    /// `queue_advert` or a `gap_response` rather than a chat message, and an
    /// `APPEND` to an unbound address is refused with the same collapsed
    /// `ERR_UNAVAILABLE` as an absent queue — which would look like the peer
    /// having vanished rather than like our own missing step.
    async fn ensure_bound(&mut self, stored: &StoredConversation) -> Result<()> {
        let Some(outbound) = stored.queues.outbound.clone() else {
            return Err(Error::new(
                ErrorCode::SendUnavailable,
                "no advertised send address for this conversation",
            ));
        };
        self.ensure_outbound_connection(&outbound).await?;
        if outbound.bound {
            return Ok(());
        }
        let send_key = signing_key(&outbound.send_key_seed)?;
        let send_addr = queue_address(&outbound.send_addr)?;
        let connection = self
            .connections
            .get_mut(&outbound.relay_url)
            .ok_or_else(|| Error::new(ErrorCode::RelayUnreachable, "relay not connected"))?;

        // `FirstForFreshAdvert` is the truth here and it is what makes
        // `ERR_ALREADY_BOUND` mean `send-address-stolen` rather than a client
        // bug: this address came from an advert this device has not bound
        // before, so somebody else holding the write capability is theft.
        let attempt = crate::wire_codes::BindAttempt::FirstForFreshAdvert;
        match connection.bind_send(&send_key, send_addr, attempt).await {
            Ok(()) => {
                let mut updated = stored.clone();
                if let Some(queue) = updated.queues.outbound.as_mut() {
                    queue.bound = true;
                }
                self.records()
                    .commit(|records| records.put_conversation(&updated))
            }
            Err(error) if error.code() == ErrorCode::SendAddressStolen => {
                // §7.4 and §9: fatal, loud, non-dismissible. Mark the
                // conversation compromised, raise an alarm, abandon the queue.
                // Not a warning toast and not a log line.
                let mut updated = stored.clone();
                updated.send_address_stolen = true;
                self.records()
                    .commit(|records| records.put_conversation(&updated))?;
                self.raise_alarm(AlarmKind::QueueSendAddressStolen, &stored.peer_handle)?;
                Err(error)
            }
            Err(error) => Err(error),
        }
    }

    /// Ensure a peer-advertised conversation relay has a managed connection.
    /// New adverts carry the relay identity inside the authenticated MLS
    /// payload. Old persisted adverts can use an already-configured connection
    /// but are never allowed to invent the missing identity for a new one.
    async fn ensure_outbound_connection(&mut self, outbound: &OutboundQueue) -> Result<()> {
        if self.connections.contains_key(&outbound.relay_url) && outbound.relay_id.is_empty() {
            return Ok(());
        }
        let bytes = hex::decode(&outbound.relay_id)
            .map_err(|_| Error::internal("an advertised relay identity is not hex"))?;
        let relay_id = RelayId::from_slice(&bytes)
            .map_err(|_| Error::internal("an advertised relay identity is the wrong length"))?;
        self.endpoint_connection(&outbound.relay_url, relay_id)
            .await
            .map(|_| ())
    }

    fn mark_delivery(
        &self,
        msg_id: &str,
        state: &str,
        failure: Option<ErrorCode>,
        now: i64,
    ) -> Result<DeliveryStatus> {
        let mut message = self
            .records()
            .message(msg_id)?
            .ok_or_else(|| Error::internal("no such message"))?;
        message.delivery.state = state.to_owned();
        message.delivery.failure = failure;
        message.delivery.updated_at = now;
        if state == "accepted" {
            message.delivery.accepted_by_relays = 1;
            // The retry copy is only needed until the relay has it.
            message.retry_ciphertext = None;
        }
        self.records()
            .commit(|records| records.put_message(&message))?;
        Ok(delivery_view(&message))
    }

    fn raise_alarm(&self, kind: AlarmKind, peer_handle: &str) -> Result<Alarm> {
        let now = now_ms();
        let alarm = Alarm {
            alarm_id: format!("{}-{now}", kind_slug(kind)),
            kind,
            severity: AlarmSeverity::Critical,
            raised_at: now,
            dismissible: NeverDismissible,
            handle: Some(peer_handle.to_owned()),
            old_fingerprint: None,
            new_fingerprint: None,
            platform_assisted: false,
            cooldown_ends_at: None,
            acknowledged_at: None,
        };
        let mut alarms = self.records().alarms()?;
        alarms.push(alarm.clone());
        self.records()
            .commit(|records| records.put_alarms(&alarms))?;
        Ok(alarm)
    }

    /// Encrypt and append a non-chat §7 payload: a hint, a purge request, a gap
    /// request or response.
    ///
    /// **These are full §7 vertices**, and that is `f2z-msg-dag`'s model rather
    /// than a choice made here: `MessageType` names `RECEIPT`, `GAP_REQUEST`,
    /// `GAP_RESPONSE`, `QUEUE_ADVERT`, `CEREMONY` and `WEBRTC_OFFER` alongside
    /// `CHAT`, and every one of them is an `AppMessage` carrying `parents`.
    ///
    /// So a control payload is inserted into the sender's DAG exactly as a chat
    /// message is. The alternative — carrying `parents` without becoming one —
    /// looks tidier and is incoherent: the peer inserts what it receives, so
    /// its next `parents` would name a vertex the sender never recorded, and
    /// the sender would detect a gap for its own message. That is not a
    /// hypothetical; it is what this function did until the two-process harness
    /// caught it.
    ///
    /// The cost is real and worth stating: a peer that misses a `queue_advert`
    /// sees a genuine gap for it, and repairing it is a repair of something the
    /// UI will never render. §3.5's marker covers that honestly — the hole was
    /// real — but if the contract ever decides control payloads should be
    /// invisible to the DAG, this is the one function that changes.
    async fn send_control(
        &mut self,
        stored: &StoredConversation,
        message_type: MessageType,
        body: &[u8],
    ) -> Result<()> {
        let parents = self.dag(&stored.conversation_id)?.heads();
        let now = now_ms();
        let mut group = self
            .groups
            .remove(&stored.conversation_id)
            .ok_or_else(|| Error::engine_not_running("send_control"))?;
        let sealed: Result<(AppMessage, Vec<u8>, u64, u32)> = (|| {
            let mls = self.mls_ref("send_control")?;
            let epoch = group.epoch().as_u64();
            let leaf = group.own_leaf_index().u32();
            let framed = envelope::seal(
                message_type,
                &parents,
                epoch,
                leaf,
                now,
                RetentionClass::Chat,
                body,
            )?;
            let wire = framed.encode().map_err(envelope::dag_error)?;
            let ciphertext = mls
                .send(&mut group, &wire)
                .map_err(|error| Error::internal(format!("encrypting: {error}")))?;
            Ok((framed, ciphertext, epoch, leaf))
        })();
        self.groups.insert(stored.conversation_id.clone(), group);
        let (_framed, ciphertext, _epoch, _leaf) = sealed?;

        self.ensure_bound(stored).await?;
        let outbound =
            stored.queues.outbound.clone().ok_or_else(|| {
                Error::new(ErrorCode::SendUnavailable, "no advertised send address")
            })?;
        let send_key = signing_key(&outbound.send_key_seed)?;
        let send_addr = queue_address(&outbound.send_addr)?;
        let connection = self
            .connections
            .get_mut(&outbound.relay_url)
            .ok_or_else(|| Error::new(ErrorCode::RelayUnreachable, "relay not connected"))?;
        connection.append(&send_key, send_addr, &ciphertext).await
    }
}

/// The highest queue index that may be acknowledged, given each message's
/// outcome in index order.
///
/// **`ACK` is cumulative** (`WIRE.md` §8.2): acknowledging index 5 deletes 3 as
/// well. So one failure has to stop the acknowledgement *there*, not merely
/// exclude itself — otherwise a message this device could not write is deleted
/// at the relay by the `ACK` for a later one, which is §9 rule 1's failure mode
/// reached by the back door and is exactly as permanent.
///
/// This is a free function taking outcomes rather than a `bool` threaded
/// through the read loop, because the property is worth a test and a flag
/// inside an async loop over a socket is not testable. `pump_conversation`'s
/// local read cursor still advances past a failure, so the next pass does not
/// spin on it; what does not advance is the deletion.
fn acknowledgeable(outcomes: &[(u64, bool)]) -> Option<u64> {
    let mut highest = None;
    for (index, committed) in outcomes {
        if !committed {
            break;
        }
        highest = Some(*index);
    }
    highest
}

// ----------------------------------------------------------------------
// Views and small helpers
// ----------------------------------------------------------------------

fn message_view(stored: &StoredMessage) -> Message {
    Message {
        msg_id: stored.msg_id.clone(),
        conversation_id: stored.conversation_id.clone(),
        direction: if stored.outbound {
            Direction::Outbound
        } else {
            Direction::Inbound
        },
        epoch: stored.epoch,
        sender_leaf_index: stored.sender_leaf_index,
        parents: stored.parents.clone(),
        sent_at: stored.sent_at,
        received_at: stored.received_at,
        body: match (&stored.unrecoverable, &stored.text, &stored.type_tag) {
            // §3.4: never rendered as nothing.
            (Some(UnrecoverableCause::GapUnrecoverable), _, _) => MessageBody::Unrecoverable {
                reason: UnrecoverableReason::GapUnrecoverable,
            },
            (Some(UnrecoverableCause::RetentionExpired), _, _) => MessageBody::Unrecoverable {
                reason: UnrecoverableReason::RetentionExpired,
            },
            (None, Some(text), _) => MessageBody::Text { text: text.clone() },
            (None, None, Some(tag)) => MessageBody::Unsupported {
                type_tag: tag.clone(),
            },
            (None, None, None) => MessageBody::Unsupported {
                type_tag: "unknown".into(),
            },
        },
        delivery: delivery_view(stored),
        retention_class: if stored.ceremony {
            RetentionClass2::Ceremony
        } else {
            RetentionClass2::Chat
        },
        expires_at: stored.expires_at,
    }
}

use crate::models::RelayConnection as RelayConnectionState;
/// The models' retention class, distinct from the wire one in `framing`.
use crate::models::RetentionClass as RetentionClass2;

fn delivery_view(stored: &StoredMessage) -> DeliveryStatus {
    DeliveryStatus {
        msg_id: stored.msg_id.clone(),
        state: match stored.delivery.state.as_str() {
            "accepted" => DeliveryState::Accepted,
            "queue-delivered" => DeliveryState::QueueDelivered,
            "device-delivered" => DeliveryState::DeviceDelivered,
            "delivered" => DeliveryState::Delivered,
            "failed" => DeliveryState::Failed,
            "expired" => DeliveryState::Expired,
            _ => DeliveryState::Pending,
        },
        accepted_by_relays: stored.delivery.accepted_by_relays,
        configured_relays: stored.delivery.configured_relays,
        devices_receipted: stored.delivery.devices_receipted,
        devices_expected: stored.delivery.devices_expected,
        failure: stored.delivery.failure,
        updated_at: stored.delivery.updated_at,
    }
}

fn witness_state(set: &StoredWitnessSet) -> WitnessSetState {
    let independent = u32::try_from(
        set.witnesses
            .iter()
            .filter(|witness| witness.independent)
            .count(),
    )
    .unwrap_or(0);
    WitnessSetState {
        configured: u32::try_from(set.witnesses.len()).unwrap_or(0),
        independent,
        threshold: set.threshold,
        threshold_met: independent >= set.threshold && set.threshold > 0,
        // True while `independent == 0`, and while it is true the UI must state
        // plainly that no independent witness exists rather than render a count.
        // At launch every witness is operated by one party, and whatever *t* is
        // configured, the cryptographic value of meeting it is zero.
        bootstrap_disclaimer: independent == 0,
    }
}

fn kind_slug(kind: AlarmKind) -> &'static str {
    match kind {
        AlarmKind::IdentityKeyChanged => "identity-key-changed",
        AlarmKind::PlatformReset => "platform-reset",
        AlarmKind::SelfAuditUnexpectedEntry => "self-audit-unexpected-entry",
        AlarmKind::QueueSendAddressStolen => "queue-send-address-stolen",
        AlarmKind::RelayIdentityMismatch => "relay-identity-mismatch",
        AlarmKind::WitnessThresholdUnmet => "witness-threshold-unmet",
        AlarmKind::DirectoryForkEvidence => "directory-fork-evidence",
    }
}

fn expiry_for(stored: &StoredConversation, now: i64, global: RetentionPolicy) -> Option<i64> {
    let policy = stored.retention.clone().unwrap_or(global);
    match (policy.mode, policy.ttl_seconds) {
        (RetentionMode::Expire, Some(ttl)) => {
            Some(now.saturating_add(i64::try_from(ttl).unwrap_or(0).saturating_mul(1000)))
        }
        _ => None,
    }
}

/// Group a hex key for human reading, the way §3.1 asks a fingerprint to be
/// rendered. Five-character groups, because that is short enough to read back
/// over a phone call without losing your place.
fn fingerprint(hex_key: &str) -> String {
    hex_key
        .as_bytes()
        .chunks(5)
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect::<Vec<_>>()
        .join(" ")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn routing_advert_digest(
    conversation_id: &str,
    welcome: &[u8],
    advert: &QueueAdvert,
) -> Result<f2z_codec::types::Digest> {
    let advert = serde_json::to_vec(advert)
        .map_err(|error| Error::internal(format!("encoding routing advert: {error}")))?;
    let fields = hash2(LABEL_ROUTING_FIELDS, conversation_id.as_bytes(), &advert);
    let welcome = hash(LABEL_ROUTING_WELCOME, welcome);
    Ok(hash2(
        LABEL_ROUTING_ADVERT,
        fields.as_bytes(),
        welcome.as_bytes(),
    ))
}

fn decode_key(hex_key: &str) -> Result<[u8; 32]> {
    let bytes = hex::decode(hex_key).map_err(|_| Error::internal("a stored key is not hex"))?;
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| Error::internal("a stored key is the wrong length"))
}

fn signing_key(seed_hex: &str) -> Result<SigningKey> {
    Ok(SigningKey::from_seed(&decode_key(seed_hex)?))
}

fn queue_address(hex_addr: &str) -> Result<f2z_codec::types::QueueAddress> {
    let bytes = hex::decode(hex_addr).map_err(|_| Error::internal("a queue address is not hex"))?;
    f2z_codec::types::QueueAddress::from_slice(&bytes)
        .map_err(|_| Error::internal("a queue address is the wrong length"))
}

/// Seal the device secrets under the seed-derived `BackupWrapKey`.
fn seal(secrets: &DeviceSecrets, wrap_key: &[u8; 32]) -> Result<SealedSecrets> {
    let cipher = chacha20poly1305::ChaCha20Poly1305::new(wrap_key.into());
    let mut nonce = [0u8; 12];
    rand::rng().fill_bytes(&mut nonce);
    let plaintext = serde_json::to_vec(secrets)
        .map_err(|error| Error::internal(format!("encoding device secrets: {error}")))?;
    let ciphertext = cipher
        .encrypt((&nonce).into(), plaintext.as_slice())
        .map_err(|_| Error::internal("sealing device secrets"))?;
    Ok(SealedSecrets {
        nonce: hex::encode(nonce),
        ciphertext: hex::encode(ciphertext),
    })
}

fn open(sealed: &SealedSecrets, wrap_key: &[u8; 32]) -> Result<DeviceSecrets> {
    let cipher = chacha20poly1305::ChaCha20Poly1305::new(wrap_key.into());
    let nonce_bytes: [u8; 12] = hex::decode(&sealed.nonce)
        .ok()
        .and_then(|bytes| bytes.as_slice().try_into().ok())
        .ok_or_else(|| Error::internal("a sealed nonce is malformed"))?;
    let ciphertext =
        hex::decode(&sealed.ciphertext).map_err(|_| Error::internal("sealed bytes are not hex"))?;
    let plaintext = cipher
        .decrypt((&nonce_bytes).into(), ciphertext.as_slice())
        .map_err(|_| {
            // A wrong key and an absent one are the same thing to a user: local
            // history cannot be decrypted. §6.1's `locked`.
            Error::new(
                ErrorCode::EngineLocked,
                "the supplied wrap key does not open this device's secrets",
            )
        })?;
    serde_json::from_slice(&plaintext)
        .map_err(|error| Error::internal(format!("decoding device secrets: {error}")))
}

// ----------------------------------------------------------------------
// The inbound path, and the queue plumbing under it.
// ----------------------------------------------------------------------

impl<B: StorageBackend> Inner<B> {
    /// The relay a new conversation's queue is created on.
    ///
    /// The first configured one. `ARCHITECTURE.md` §9.4 wants a device to
    /// publish queue addresses on *k* relays and senders to send to all *k*, so
    /// that a single hostile relay cannot silently drop a conversation; *k* is
    /// [§13-G](../../../docs/e2ee/ARCHITECTURE.md), still open, and this build
    /// is `k = 1`. The `msg_id` dedup that makes *k* > 1 safe is already in
    /// place — see `framing` — so raising it is a change here and nowhere else.
    fn first_relay_url(&self) -> Result<String> {
        self.records()
            .relays()?
            .first()
            .map(|relay| relay.relay_url.clone())
            .ok_or_else(|| {
                Error::new(
                    ErrorCode::RelayUnreachable,
                    "no relay is configured; add one before starting a conversation",
                )
            })
    }

    /// Create the group, add the peer from its `KeyPackage`, and open this
    /// device's receive queue for the conversation.
    ///
    /// The shared half of `start_conversation` and the harness wrapper. It does
    /// **not** deliver the `Welcome` — that is `contact_append`'s job and it
    /// needs the peer's published contact address, which only a resolution has.
    async fn create_conversation(
        &mut self,
        peer_handle: &str,
        peer_identity_pk: &str,
        peer_key_package: &VerifiedKeyPackage,
        relay_url: &str,
    ) -> Result<Introduction> {
        let now = now_ms();
        let mut group_id = [0u8; 32];
        rand::rng().fill_bytes(&mut group_id);
        let conversation_id = hex::encode(group_id);

        let sealed: Result<Vec<u8>> = (|| {
            let mls = self.mls_ref("create_conversation")?;
            let mut group = mls
                .create_group(&group_id)
                .map_err(|error| Error::internal(format!("creating a group: {error}")))?;
            let (_commit, welcome) = mls
                .add_member(
                    &mut group,
                    peer_key_package,
                    u64::try_from(now).unwrap_or_default(),
                )
                .map_err(|error| Error::internal(format!("adding a member: {error}")))?;
            self.groups.insert(conversation_id.clone(), group);
            Ok(welcome)
        })();
        let welcome = sealed?;

        let (advert, inbound) = self.open_inbound_queue(&conversation_id, relay_url).await?;
        let digest = routing_advert_digest(&conversation_id, &welcome, &advert)?;
        let (advert_device_pk, advert_signature) = {
            let mls = self.mls_ref("sign_routing_advert")?;
            (
                hex::encode(mls.credential().credential.device_pk.as_bytes()),
                hex::encode(
                    mls.sign_routing_advert(digest.as_bytes())
                        .map_err(|error| {
                            Error::internal(format!("signing routing advert: {error}"))
                        })?,
                ),
            )
        };
        let stored = StoredConversation {
            conversation_id: conversation_id.clone(),
            peer_handle: peer_handle.to_owned(),
            peer_identity_fingerprint: peer_identity_pk.to_owned(),
            group_id: conversation_id.clone(),
            verification: VerificationState::Unverified,
            created_at: now,
            last_message_at: None,
            unread_count: 0,
            retention: None,
            ephemeral_hint: None,
            receipt_policy: ReceiptPolicy::default(),
            queues: StoredQueues {
                inbound: Some(inbound),
                // Filled in when the peer answers with its own advert. Until
                // then this conversation can receive and cannot send, which is
                // the honest state rather than a guess at an address.
                outbound: None,
            },
            send_address_stolen: false,
            read_through: None,
        };
        self.records()
            .commit(|records| records.put_conversation(&stored))?;
        Ok(Introduction {
            conversation_id,
            welcome,
            advert,
            advert_device_pk,
            advert_signature,
        })
    }

    fn authenticate_introduction(
        &self,
        entry: &f2z_kt_core::entry::DirectoryEntryTBS,
        introduction: &Introduction,
        now: i64,
    ) -> Result<()> {
        let digest = routing_advert_digest(
            &introduction.conversation_id,
            &introduction.welcome,
            &introduction.advert,
        )?;
        let device_pk = hex::decode(&introduction.advert_device_pk).map_err(|_| {
            Error::new(
                ErrorCode::RelayIdentityMismatch,
                "routing device key is not hex",
            )
        })?;
        let signature = hex::decode(&introduction.advert_signature).map_err(|_| {
            Error::new(
                ErrorCode::RelayIdentityMismatch,
                "routing signature is not hex",
            )
        })?;
        MlsEngine::<B>::authenticate_routing_advert(
            entry,
            &device_pk,
            digest.as_bytes(),
            &signature,
            u64::try_from(now).unwrap_or(0),
        )
        .map_err(|_| {
            Error::new(
                ErrorCode::RelayIdentityMismatch,
                "the first routing advert is not signed by an active directory device",
            )
        })
    }

    /// Join from a `Welcome`, open this device's receive queue, and record the
    /// peer's advertised send address.
    async fn join_conversation(
        &mut self,
        peer_handle: &str,
        peer_identity_pk: &str,
        introduction: &Introduction,
        relay_url: &str,
    ) -> Result<QueueAdvert> {
        let now = now_ms();
        let conversation_id = introduction.conversation_id.clone();
        let expected_group_id = hex::decode(&conversation_id).map_err(|_| {
            Error::new(
                ErrorCode::RelayIdentityMismatch,
                "the signed conversation id is not a canonical MLS group id",
            )
        })?;
        if expected_group_id.len() != 32 {
            return Err(Error::new(
                ErrorCode::RelayIdentityMismatch,
                "the signed conversation id is not a 32-byte MLS group id",
            ));
        }
        let sealed: Result<()> = (|| {
            let mls = self.mls_ref("join_conversation")?;
            let group = mls
                .join_from_welcome_for_group_id(
                    &introduction.welcome,
                    u64::try_from(now).unwrap_or_default(),
                    &expected_group_id,
                )
                .map_err(|error| match error {
                    f2z_msg_mls::EngineError::GroupIdMismatch => Error::new(
                        ErrorCode::RelayIdentityMismatch,
                        "the signed conversation id does not match the Welcome's MLS group id",
                    ),
                    other => Error::internal(format!("joining: {other}")),
                })?;
            self.groups.insert(conversation_id.clone(), group);
            Ok(())
        })();
        sealed?;

        let (advert, inbound) = self.open_inbound_queue(&conversation_id, relay_url).await?;
        let send_key_seed = hex::encode(self.queue_key(&conversation_id, LABEL_QUEUE_SEND)?);
        let stored = StoredConversation {
            conversation_id: conversation_id.clone(),
            peer_handle: peer_handle.to_owned(),
            peer_identity_fingerprint: peer_identity_pk.to_owned(),
            group_id: conversation_id.clone(),
            verification: VerificationState::Unverified,
            created_at: now,
            last_message_at: None,
            unread_count: 0,
            retention: None,
            ephemeral_hint: None,
            receipt_policy: ReceiptPolicy::default(),
            queues: StoredQueues {
                inbound: Some(inbound),
                outbound: Some(OutboundQueue {
                    relay_url: introduction.advert.relay_url.clone(),
                    relay_id: introduction.advert.relay_id.clone(),
                    send_addr: introduction.advert.send_addr.clone(),
                    send_key_seed,
                    bound: false,
                }),
            },
            send_address_stolen: false,
            read_through: None,
        };
        self.records()
            .commit(|records| records.put_conversation(&stored))?;

        // Tell the initiator where to write. Until this lands it holds a
        // conversation it can receive on and cannot send to, which is the
        // honest state — `transportHealth` says `degraded`, not `ok`.
        let body = serde_json::to_vec(&advert)
            .map_err(|error| Error::internal(format!("framing an advert: {error}")))?;
        self.send_control(&stored, MessageType::QUEUE_ADVERT, &body)
            .await?;
        Ok(advert)
    }

    /// Record where this device writes to reach the peer.
    fn set_peer_advert(&self, conversation_id: &str, advert: &QueueAdvert) -> Result<()> {
        let mut stored = self.conversation(conversation_id)?;
        stored.queues.outbound = Some(OutboundQueue {
            relay_url: advert.relay_url.clone(),
            relay_id: advert.relay_id.clone(),
            send_addr: advert.send_addr.clone(),
            send_key_seed: hex::encode(self.queue_key(conversation_id, LABEL_QUEUE_SEND)?),
            bound: false,
        });
        self.records()
            .commit(|records| records.put_conversation(&stored))
    }

    /// `CLAIM_KEY_PACKAGE` from the peer's relay, then authenticate what came
    /// back against the entry the directory proved (`WIRE.md` §12.6).
    ///
    /// **The two halves are inseparable and are one function for that reason.**
    /// A claim is bytes from a relay the threat model assumes is hostile; the
    /// verification is the only thing that makes them safe to encrypt a
    /// `Welcome` to. Returning the raw bytes from here and verifying at the
    /// call site would put a `?` between them that somebody could later delete.
    ///
    /// # Errors
    ///
    /// `relay-unreachable` if the peer's relay is not connected,
    /// `relay-unavailable` if the pool is exhausted and there is no package of
    /// last resort — §12.6's exhaustion behaviour, and the same code an address
    /// that does not exist returns — and `internal` naming the credential
    /// failure if the package does not belong to the identity the directory
    /// vouched for.
    async fn claim_key_package(
        &mut self,
        peer: &crate::directory::ResolvedPeer,
        peer_handle: &str,
    ) -> Result<VerifiedKeyPackage> {
        let contact_addr = queue_address(&peer.contact_addr)?;
        let connection = self
            .endpoint_connection(&peer.contact_relay_url, peer.contact_relay_id)
            .await?;
        let policy = connection.key_package_policy().await?;
        if policy.enabled == 0 {
            return Err(Error::new(
                ErrorCode::RelayCapabilityMismatch,
                format!(
                    "{peer_handle:?} publishes a contact endpoint on a relay that stores no key \
                     packages (WIRE.md §12.6), so there is nothing to address a Welcome to"
                ),
            ));
        }
        tracing::info!(peer = %peer_handle, "first contact: claiming a key package");
        let claimed = connection.claim_key_package(contact_addr).await?;
        let last_resort = claimed.last_resort != 0;

        let mls = self.mls_ref("start_conversation")?;
        let verified = mls
            .verify_key_package(
                claimed.key_package.as_slice(),
                &peer.entry,
                u64::try_from(now_ms()).unwrap_or_default(),
            )
            .map_err(|error| {
                // Not a network error and never retried. A package that does not
                // authenticate against the entry the log proved is either a
                // broken relay or an attempted MITM, and the two are
                // indistinguishable from here — §9 rule 5 forbids proceeding
                // either way.
                tracing::warn!(
                    peer = %peer_handle,
                    "a claimed key package does not belong to the identity the directory \
                     vouched for; refusing to start a conversation (WIRE.md §12.6)"
                );
                Error::internal(format!(
                    "the key package served for {peer_handle:?} does not match the directory \
                     entry the log proved: {error}"
                ))
            })?;
        if verified.last_resort() || last_resort {
            // §12.6, and `THREAT-MODEL.md` §4.12: the peer's pool was empty, so
            // this `Welcome` goes to a key that may be reused. Reported, not
            // refused — refusing would convert a documented trade into a
            // failure to reach somebody.
            tracing::info!(
                peer = %peer_handle,
                "first contact is using the peer's package of last resort: their pool is \
                 exhausted, and this Welcome's init key may be reused"
            );
        }
        Ok(verified)
    }

    /// `CONTACT_APPEND` the introduction to the peer's published contact queue
    /// (§12.2).
    ///
    /// Unsigned at the relay and gated by a proof-of-work stamp: that is the
    /// whole design — a stranger can reach you exactly once, expensively — and
    /// §12.4 is honest that the cost lands far harder on a phone than on rented
    /// hardware. The search runs on a blocking thread — see
    /// `RelayConnection::stamp_for`, which is where that is arranged and where
    /// the residual it does *not* close is written down — and §3.3 tells the UI
    /// to show it as work, not as a network wait.
    async fn contact_append(
        &mut self,
        peer: &crate::directory::ResolvedPeer,
        introduction: &Introduction,
        peer_handle: &str,
    ) -> Result<()> {
        let identity = self
            .records()
            .identity()?
            .ok_or_else(|| Error::not_enrolled("start_conversation"))?;
        let envelope = ContactEnvelope {
            handle: identity.handle,
            identity_pk: identity.identity_pk,
            conversation_id: introduction.conversation_id.clone(),
            welcome: hex::encode(&introduction.welcome),
            advert: introduction.advert.clone(),
            advert_device_pk: introduction.advert_device_pk.clone(),
            advert_signature: introduction.advert_signature.clone(),
        };
        let body = serde_json::to_vec(&envelope)
            .map_err(|error| Error::internal(format!("framing first contact: {error}")))?;
        let contact_addr = queue_address(&peer.contact_addr)?;
        let connection = self
            .endpoint_connection(&peer.contact_relay_url, peer.contact_relay_id)
            .await?;
        let pow = Some(
            connection
                .capabilities()
                .await?
                .capabilities
                .contact_append_pow,
        );
        tracing::info!(peer = %peer_handle, "first contact: solving a proof-of-work stamp");
        connection.contact_append(contact_addr, &body, pow).await
    }

    /// Open this device's contact queue if it has none.
    ///
    /// Called from `start_engine`. Its `contact_addr` is what enrollment
    /// publishes in the directory, and it is the only address a stranger can
    /// reach — an ordinary queue's send address is handed out per conversation.
    async fn ensure_contact_queue(&mut self) -> Result<()> {
        if self.records().contact_queue()?.is_some() {
            return Ok(());
        }
        let Ok(relay_url) = self.first_relay_url() else {
            return Ok(());
        };
        let recv_seed = self.queue_key("contact", LABEL_QUEUE_RECV)?;
        let recv_key = SigningKey::from_seed(&recv_seed);
        let connection = self
            .connections
            .get_mut(&relay_url)
            .ok_or_else(|| Error::new(ErrorCode::RelayUnreachable, "relay not connected"))?;
        let pow = Some(
            connection
                .capabilities()
                .await?
                .capabilities
                .queue_creation_pow,
        );
        let created = connection
            .create_contact_queue(&recv_key, MESSAGE_TTL_SECONDS, IDLE_TTL_SECONDS, pow)
            .await?;
        connection.subscribe(&recv_key, created.recv_addr).await?;
        let queue = crate::store::ContactQueue {
            relay_url,
            recv_addr: hex::encode(created.recv_addr.as_bytes()),
            contact_addr: hex::encode(created.contact_addr.as_bytes()),
            recv_key_seed: hex::encode(recv_seed),
            next_index: 0,
            acked_through: None,
            key_package_pool: 0,
            has_last_resort: false,
            last_resort_expires_at_ms: None,
        };
        self.records()
            .commit(|records| records.put_contact_queue(&queue))
    }

    /// Return a managed connection to a directory-published endpoint, opening
    /// it on demand when the peer federates through a relay this device did not
    /// preconfigure. The signed `relay_id` is checked both for a new session and
    /// for a connection already present under the same URL.
    async fn endpoint_connection(
        &mut self,
        relay_url: &str,
        expected_relay_id: RelayId,
    ) -> Result<&mut RelayConnection> {
        if !self.connections.contains_key(relay_url) {
            let mut policy = self.directory_connection_policy.clone();
            if let Some(configured) = self
                .records()
                .relays()?
                .into_iter()
                .find(|relay| relay.relay_url == relay_url)
            {
                policy.policy.allow_insecure_transport = configured.allow_insecure_transport;
                policy.policy.require_channel_binding = !configured.allow_no_channel_binding;
            }
            policy.expected_relay_id = Some(expected_relay_id);
            let connection = RelayConnection::connect(relay_url, &policy).await?;
            self.connections.insert(relay_url.to_owned(), connection);
        }

        let connection = self
            .connections
            .get_mut(relay_url)
            .ok_or_else(|| Error::new(ErrorCode::RelayUnreachable, "relay not connected"))?;
        if connection.relay_id() != expected_relay_id {
            return Err(Error::new(
                ErrorCode::RelayIdentityMismatch,
                "the relay at the directory-published URL does not have the signed relay_id",
            ));
        }
        Ok(connection)
    }

    /// Publish or top up this device's key-package pool (`WIRE.md` §12.6).
    ///
    /// Called from `start_engine`, and again whenever something arrives on the
    /// contact queue — a `Welcome` is proof that a package was claimed, and it
    /// is the only proof this device gets without asking.
    ///
    /// # What it does when the relay does not offer §12.6
    ///
    /// Nothing, loudly. A relay whose key-package policy has `enabled = 0` is a
    /// relay first contact cannot complete against, and the honest report is a
    /// log line plus `last_error` — not a silent success, and not a refusal to
    /// start: everything else about the relay still works, and an established
    /// conversation is unaffected.
    ///
    /// # Errors
    ///
    /// `relay-unreachable` if the relay is not connected, `internal` if MLS
    /// could not generate the packages or the store could not record the count.
    async fn ensure_key_packages(&mut self) -> Result<()> {
        self.ensure_key_packages_at(now_ms()).await
    }

    async fn ensure_key_packages_at(&mut self, now: i64) -> Result<()> {
        let Some(mut queue) = self.records().contact_queue()? else {
            return Ok(());
        };
        let connection = self
            .connections
            .get_mut(&queue.relay_url)
            .ok_or_else(|| Error::new(ErrorCode::RelayUnreachable, "relay not connected"))?;
        let policy = connection.key_package_policy().await?;
        if policy.enabled == 0 {
            tracing::warn!(
                url = %queue.relay_url,
                "this relay stores no MLS key packages (WIRE.md §12.6), so nobody can start a \
                 conversation with this device through it"
            );
            return Err(Error::new(
                ErrorCode::RelayCapabilityMismatch,
                "the relay's key-package policy is disabled, so first contact cannot complete",
            ));
        }

        let target = KEY_PACKAGE_POOL_TARGET.min(policy.max_pool_size);
        let low_water = KEY_PACKAGE_LOW_WATER.min(target);

        // **Ask the relay how many are left; never trust the stored count.**
        //
        // A publish with an empty batch changes nothing and returns the truth,
        // and it is the only way to learn it: claims are invisible to this
        // device — most never produce a `Welcome` — so a device that decided
        // from its own last-recorded number would drain to zero, fall back to
        // its reusable package of last resort (`THREAT-MODEL.md` §4.12) and
        // never notice. The stored fields below are a *report*, not an input.
        //
        // The probe is owner-authenticated, so it is no oracle: §6.3's rule
        // about responses carrying queue state is about a *sender* escalating
        // into a reader, and this is the queue's owner asking about its own
        // pool (§12.6.3).
        let recv_key = signing_key(&queue.recv_key_seed)?;
        let recv_addr = queue_address(&queue.recv_addr)?;
        let held = connection
            .publish_key_packages(&recv_key, recv_addr, &[], None)
            .await?;
        queue.key_package_pool = held.pool_size;
        queue.has_last_resort = held.has_last_resort != 0;
        if !queue.has_last_resort {
            queue.last_resort_expires_at_ms = None;
        }

        // Replace only when missing or nearing expiry. Replacing on every
        // top-up would retire a package a `Welcome` may already be in flight
        // against; never replacing would make strict lifetime verification
        // permanently reject fallback after thirty days.
        let needs_last_resort = Self::last_resort_rotation_due_for(&queue, now);
        if held.pool_size > low_water && !needs_last_resort {
            // Record what the relay reported even when nothing is added, so the
            // stored number is never staler than the last time anything looked.
            let snapshot = queue.clone();
            return self
                .records()
                .commit(|records| records.put_contact_queue(&snapshot));
        }

        let wanted = usize::try_from(target.saturating_sub(held.pool_size)).unwrap_or(0);
        let (packages, last_resort, next_last_resort_expiry) = {
            let mls = self.mls_ref("ensure_key_packages")?;
            let packages = mls
                .generate_key_packages(wanted, None)
                .map_err(|error| Error::internal(format!("key packages: {error}")))?;
            let last_resort = if needs_last_resort {
                let not_before = u64::try_from(now.max(0)).unwrap_or(0) / 1000;
                let not_after = not_before.saturating_add(LAST_RESORT_LIFETIME_SECONDS);
                Some(
                    mls.generate_last_resort_key_package_for_window(not_before, not_after)
                        .map_err(|error| {
                            Error::internal(format!("last-resort key package: {error}"))
                        })?,
                )
            } else {
                None
            };
            let expiry = needs_last_resort.then(|| {
                now.saturating_add(
                    i64::try_from(LAST_RESORT_LIFETIME_SECONDS)
                        .unwrap_or(i64::MAX)
                        .saturating_mul(1000),
                )
            });
            (packages, last_resort, expiry)
        };

        let connection = self
            .connections
            .get_mut(&queue.relay_url)
            .ok_or_else(|| Error::new(ErrorCode::RelayUnreachable, "relay not connected"))?;
        let published = connection
            .publish_key_packages(&recv_key, recv_addr, &packages, last_resort.as_deref())
            .await?;

        tracing::info!(
            pool = published.pool_size,
            max = published.max_pool_size,
            "published MLS key packages (WIRE.md §12.6)"
        );
        // The relay's count, never this device's arithmetic: the relay clamps,
        // skips duplicates, and has been serving claims since the last publish.
        queue.key_package_pool = published.pool_size;
        queue.has_last_resort = published.has_last_resort != 0;
        if last_resort.is_some() && queue.has_last_resort {
            // Advance this only after the relay confirms publication. On a
            // transport/refusal failure, the prior persisted expiry survives
            // and the online pump retries without losing the existing fallback.
            queue.last_resort_expires_at_ms = next_last_resort_expiry;
        } else if !queue.has_last_resort {
            queue.last_resort_expires_at_ms = None;
        }
        self.records()
            .commit(|records| records.put_contact_queue(&queue))
    }

    fn last_resort_rotation_due(&self, now: i64) -> Result<bool> {
        Ok(self
            .records()
            .contact_queue()?
            .is_some_and(|queue| Self::last_resort_rotation_due_for(&queue, now)))
    }

    fn last_resort_rotation_due_for(queue: &crate::store::ContactQueue, now: i64) -> bool {
        !queue.has_last_resort
            || queue
                .last_resort_expires_at_ms
                .is_none_or(|expiry| now >= expiry.saturating_sub(LAST_RESORT_ROTATE_BEFORE_MS))
    }

    /// Read this device's contact queue and turn each arrival into a pending
    /// [`ContactRequest`].
    ///
    /// Nothing here joins a group: §6.4 puts accepting a first-contact
    /// `Welcome` in the same row as resolving a new handle, so the decision
    /// waits for `accept_contact_request` and, behind it, a directory answer.
    /// What this does is durably record the `Welcome` so the decision can be
    /// made later without the relay having to still hold it.
    async fn pump_contact_queue(&mut self) -> Result<Vec<Inbound>> {
        let Some(queue) = self.records().contact_queue()? else {
            return Ok(Vec::new());
        };
        let recv_key = signing_key(&queue.recv_key_seed)?;
        let recv_addr = queue_address(&queue.recv_addr)?;
        let response = {
            let Some(connection) = self.connections.get_mut(&queue.relay_url) else {
                return Ok(Vec::new());
            };
            connection
                .read(
                    &recv_key,
                    recv_addr,
                    queue.next_index,
                    READ_BATCH,
                    READ_MAX_BYTES,
                )
                .await?
        };

        let blocked = self.records().blocked()?;
        let mut requests = self.records().contact_requests()?;
        let mut events = Vec::new();
        // Same cumulative-ACK discipline as `pump_conversation`: a payload this
        // device could not record must not be deleted at the relay by an `ACK`
        // for a later one. Here every failure is a *discard* — a stranger can
        // put anything in a contact queue — so the acknowledgement follows the
        // read cursor, and the one thing that would stop it is the durable
        // write below failing.
        let mut highest = None;
        let mut queue = queue;
        for queued in response.messages.as_slice() {
            highest = Some(queued.index);
            queue.next_index = queued.index.saturating_add(1);
            // The payload is padded to a bucket (§9); `unpad` recovers the
            // real length from the framing this client wrote.
            let Ok(bytes) = crate::relay::unpad(queued.payload.as_slice()) else {
                continue;
            };
            let Ok(contact) = serde_json::from_slice::<ContactEnvelope>(&bytes) else {
                // A stranger can put anything in a contact queue. A payload
                // that does not parse is discarded silently: it is not evidence
                // of anything, and surfacing it would make the queue an abuse
                // channel with a UI.
                continue;
            };
            // §3.3: `block` is entirely local, because there is no server that
            // knows who is talking to whom.
            if blocked.contains(&contact.handle) {
                continue;
            }
            if requests
                .iter()
                .any(|existing| existing.conversation_id == contact.conversation_id)
            {
                continue;
            }
            let request = StoredContactRequest {
                request_id: format!("req-{}", contact.conversation_id),
                peer_handle: contact.handle.clone(),
                peer_identity_fingerprint: contact.identity_pk.clone(),
                conversation_id: contact.conversation_id.clone(),
                received_at: now_ms(),
                // **PROVISIONAL** (§12.1), and `None` deliberately: showing any
                // part of an unsolicited, unauthenticated-at-the-relay payload
                // is a moderation and safety question nobody has answered, and
                // shipping a preview would be answering it by accident.
                body_preview: None,
                welcome: contact.welcome.clone(),
                peer_send_addr: contact.advert.send_addr.clone(),
                peer_relay_url: contact.advert.relay_url.clone(),
                peer_relay_id: contact.advert.relay_id.clone(),
                advert_device_pk: contact.advert_device_pk.clone(),
                advert_signature: contact.advert_signature.clone(),
            };
            requests.push(request.clone());
            events.push(Inbound::ContactRequest(ContactRequest {
                request_id: request.request_id,
                peer_handle: request.peer_handle,
                peer_identity_fingerprint: request.peer_identity_fingerprint,
                received_at: request.received_at,
                body_preview: None,
            }));
        }

        if highest.is_some() {
            let snapshot = queue.clone();
            // If this fails, `?` leaves the function before the ACK below and
            // the relay keeps every one of them.
            self.records().commit(|records| {
                records.put_contact_requests(&requests)?;
                records.put_contact_queue(&snapshot)
            })?;
        }
        // Same rule as every other queue: the durable write is above this line.
        let acknowledgeable = highest.filter(|_| self.records().may_acknowledge());
        if let (Some(highest), Some(connection)) =
            (acknowledgeable, self.connections.get_mut(&queue.relay_url))
            && let Err(error) = connection.ack(&recv_key, recv_addr, highest).await
        {
            tracing::info!(code = %error.code(), "contact-queue ACK not delivered");
        }

        // §12.6's refill. An arrival on the contact queue is the only evidence
        // this device gets, without asking, that somebody claimed a package —
        // so it is the moment to check the pool. A claim that never produced a
        // `Welcome` is invisible here and is caught by the next `start_engine`,
        // which is the honest bound on how stale the count can be.
        if highest.is_some()
            && let Err(error) = self.ensure_key_packages().await
        {
            tracing::info!(code = %error.code(), "key packages not topped up");
        }
        Ok(events)
    }

    /// Derive a per-conversation queue key from this device's queue seed.
    ///
    /// Derived rather than stored so a restart re-derives them from the one
    /// secret the seal already protects, and domain-separated so the receive
    /// key and the send key of the same conversation are unrelated — a peer
    /// that learned one must not be able to compute the other.
    fn queue_key(&self, conversation_id: &str, label: &[u8]) -> Result<[u8; 32]> {
        let seed = self
            .queue_seed
            .as_ref()
            .ok_or_else(|| Error::new(ErrorCode::EngineLocked, "the queue seed is sealed"))?;
        Ok(*hash2(label, seed, conversation_id.as_bytes()).as_bytes())
    }

    /// `CREATE_QUEUE` on the relay, and the advert that names its send side.
    async fn open_inbound_queue(
        &mut self,
        conversation_id: &str,
        relay_url: &str,
    ) -> Result<(QueueAdvert, InboundQueue)> {
        let recv_seed = self.queue_key(conversation_id, LABEL_QUEUE_RECV)?;
        let recv_key = SigningKey::from_seed(&recv_seed);
        let connection = self
            .connections
            .get_mut(relay_url)
            .ok_or_else(|| Error::new(ErrorCode::RelayUnreachable, "relay not connected"))?;
        // The relay's published `queue_creation_pow` decides whether a stamp is
        // needed; `create_queue` obtains and solves one only when it is.
        let pow = Some(
            connection
                .capabilities()
                .await?
                .capabilities
                .queue_creation_pow,
        );
        let created = connection
            .create_queue(&recv_key, MESSAGE_TTL_SECONDS, IDLE_TTL_SECONDS, pow)
            .await?;
        connection.subscribe(&recv_key, created.recv_addr).await?;

        let queue = InboundQueue {
            relay_url: relay_url.to_owned(),
            recv_addr: hex::encode(created.recv_addr.as_bytes()),
            send_addr: hex::encode(created.send_addr.as_bytes()),
            recv_key_seed: hex::encode(recv_seed),
            next_index: 0,
            acked_through: None,
        };
        Ok((
            QueueAdvert {
                relay_url: relay_url.to_owned(),
                relay_id: hex::encode(connection.relay_id().as_bytes()),
                send_addr: queue.send_addr.clone(),
            },
            queue,
        ))
    }

    /// One pass over one conversation's inbound queue.
    ///
    /// The order here **is** `CLIENT-CONTRACT.md` §9 rule 1. Read the module
    /// header before changing anything in it.
    async fn pump_conversation(&mut self, conversation_id: &str) -> Result<Vec<Inbound>> {
        let mut stored = self.conversation(conversation_id)?;
        let Some(queue) = stored.queues.inbound.clone() else {
            return Ok(Vec::new());
        };
        let recv_key = signing_key(&queue.recv_key_seed)?;
        let recv_addr = queue_address(&queue.recv_addr)?;

        let response = {
            let Some(connection) = self.connections.get_mut(&queue.relay_url) else {
                return Ok(Vec::new());
            };
            // Pushes are drained and discarded: a `MSG` push says a queue moved,
            // which this `READ` is about to discover anyway. Treating a push as
            // the delivery path would lose everything that arrived while this
            // device was disconnected.
            let _ = connection.drain_pushes();
            connection
                .read(
                    &recv_key,
                    recv_addr,
                    queue.next_index,
                    READ_BATCH,
                    READ_MAX_BYTES,
                )
                .await?
        };

        let mut events = Vec::new();
        // The highest index every message up to and including it was durably
        // handled at. **Not** "the last index seen".
        //
        // `ACK` is cumulative: acknowledging 5 deletes 3 as well. So a single
        // failure has to stop the acknowledgement there, or a message this
        // device could not write is deleted at the relay by an `ACK` for a
        // later one — §9 rule 1's failure mode reached by the back door. The
        // local read cursor still advances past the failure, so the next pass
        // does not spin on it; what does not advance is the deletion.
        //
        // The consequence is the correct one and §8's `storage-full` row says
        // so in as many words: an un-ACKed message stays on the relay until its
        // TTL, and any device that can write it still receives it.
        let mut outcomes: Vec<(u64, bool)> = Vec::with_capacity(response.messages.as_slice().len());
        for queued in response.messages.as_slice() {
            let index = queued.index;
            let outcome = match crate::relay::unpad(queued.payload.as_slice()) {
                Ok(ciphertext) => self.apply_inbound(&mut stored, index, &ciphertext).await,
                Err(error) => Err(error),
            };
            match outcome {
                Ok(mut produced) => {
                    events.append(&mut produced);
                    outcomes.push((index, true));
                }
                Err(error) => {
                    outcomes.push((index, false));
                    tracing::info!(conversation = %conversation_id, index, code = %error.code(), "inbound");
                }
            }
        }
        let acknowledged = acknowledgeable(&outcomes);

        // Only now, and only if this store can promise durability. §11.2: a
        // client that cannot must never ACK, because the relay deletes the
        // instant it receives one and IndexedDB — or a store opened in memory —
        // can be discarded as a unit.
        if let Some(highest) = acknowledged {
            if self.records().may_acknowledge() {
                let Some(connection) = self.connections.get_mut(&queue.relay_url) else {
                    return Ok(events);
                };
                match connection.ack(&recv_key, recv_addr, highest).await {
                    Ok(_) => {
                        if let Some(inbound) = stored.queues.inbound.as_mut() {
                            inbound.acked_through = Some(highest);
                        }
                        self.records()
                            .commit(|records| records.put_conversation(&stored))?;
                    }
                    Err(error) => {
                        // A lost ACK is safe in the direction that matters: the
                        // relay keeps its copy and this device already has the
                        // message. The next pass re-reads from `next_index`,
                        // which is past it, and the relay's own idle/TTL rules
                        // eventually reclaim it.
                        tracing::info!(code = %error.code(), "ACK not delivered");
                    }
                }
            } else {
                // §11.2's no-ACK mode is a first-class operating mode, not an
                // error path: messages stay on the relay until their TTL, and
                // any device that later achieves durability receives them.
                tracing::info!("no-ACK mode: this store cannot promise durability");
            }
        }
        Ok(events)
    }

    /// Decrypt one queued ciphertext, commit everything it implies, and say
    /// what the frontend should be told.
    async fn apply_inbound(
        &mut self,
        stored: &mut StoredConversation,
        index: u64,
        ciphertext: &[u8],
    ) -> Result<Vec<Inbound>> {
        let conversation_id = stored.conversation_id.clone();
        let now = now_ms();
        // The MLS dedup key. Derived from the queue coordinates so a re-read
        // after a crash lands on the same record and is refused as a duplicate
        // rather than double-applied.
        let record_key = format!("{conversation_id}:{index}").into_bytes();

        let Some(mut group) = self.groups.remove(&conversation_id) else {
            return Ok(Vec::new());
        };
        let received: Result<core::result::Result<Received, EngineError>> = (|| {
            let mls = self.mls_ref("apply_inbound")?;
            Ok(mls.receive(
                &mut group,
                ciphertext,
                &record_key,
                u64::try_from(now).unwrap_or_default(),
            ))
        })();
        self.groups.insert(conversation_id.clone(), group);
        let received = received?;

        let (payload, sender, epoch) = match received {
            Ok(Received::Application {
                payload,
                sender,
                epoch,
            }) => (payload, sender, epoch),
            // A commit, a proposal or this device's own message handed back by
            // the relay. Nothing to record; the queue index still advances.
            Ok(_) => {
                self.advance(stored, index)?;
                return Ok(Vec::new());
            }
            Err(EngineError::Duplicate) => {
                // The crash window this module's header describes. MLS believes
                // it handled this and the ratchet has moved on, so the
                // plaintext is genuinely gone — but §9 rule 7 forbids rendering
                // it as nothing, so the transcript gets §3.4's marker instead.
                self.advance(stored, index)?;
                return self.record_unrecoverable(&conversation_id, index, now);
            }
            Err(error) => {
                self.advance(stored, index)?;
                return Err(Error::internal(format!("decrypting: {error}")));
            }
        };

        let framed = AppMessage::decode(&payload).map_err(envelope::dag_error)?;
        let msg_id = envelope::to_hex(framed.msg_id());
        let message_type = framed.tbs().message_type;
        let mut events = Vec::new();

        // §3.5's gap detection, and it needs no server assistance: a `parents`
        // hash this device does not hold means a message is missing, with
        // certainty. `MessageDag::insert` is where that is decided, and it
        // reports only what became missing *now* — a hole already known does
        // not produce a second gap record or a second event.
        //
        // The MLS framing supplies `epoch` and the leaf index, and
        // `DagEntry::from_delivered` refuses a message whose claimed epoch
        // disagrees with the framing's — which is the one place a sender could
        // otherwise choose its own position in the total order.
        let missing: Vec<String> = if envelope::is_transcript_vertex(message_type) {
            let entry =
                DagEntry::from_delivered(&framed, epoch, sender).map_err(envelope::dag_error)?;
            match self.dag(&conversation_id)?.insert(entry) {
                Insertion::Accepted { newly_missing } => {
                    newly_missing.into_iter().map(envelope::to_hex).collect()
                }
                // §9.4's *k*-relay fan-out makes receiving one message *k* times
                // the normal case, not an error.
                Insertion::Duplicate => Vec::new(),
                _ => Vec::new(),
            }
        } else {
            // A control payload is not history. It still carried `parents`, and
            // a hole among them is real — but it is a hole in the *chat*
            // transcript, and the chat message that eventually references the
            // same heads reports it. See `envelope::is_transcript_vertex`.
            Vec::new()
        };
        if !missing.is_empty() {
            let gap = Gap {
                gap_id: format!("gap-{msg_id}"),
                conversation_id: conversation_id.clone(),
                missing_msg_ids: missing,
                detected_at: now,
                after_msg_id: None,
                state: GapState::Detected,
            };
            let mut gaps = self.records().gaps(&conversation_id)?;
            if !gaps.iter().any(|existing| existing.gap_id == gap.gap_id) {
                gaps.push(gap.clone());
                self.records()
                    .commit(|records| records.put_gaps(&conversation_id, &gaps))?;
                events.push(Inbound::Gap(gap));
            }
        }

        match message_type {
            MessageType::CHAT => {
                let text = Some(String::from_utf8_lossy(framed.tbs().body.as_slice()).into_owned());
                let message = StoredMessage {
                    msg_id: msg_id.clone(),
                    conversation_id: conversation_id.clone(),
                    outbound: false,
                    epoch,
                    sender_leaf_index: sender,
                    parents: framed
                        .tbs()
                        .parents
                        .as_slice()
                        .iter()
                        .copied()
                        .map(envelope::to_hex)
                        .collect(),
                    // The sender's claim, carried for display and used for
                    // nothing. `SentAt` has no `Ord`, so it cannot order even
                    // by accident (§7, §9 rule 2).
                    sent_at: i64::try_from(framed.tbs().sent_at.claimed_millis())
                        .unwrap_or_default(),
                    received_at: Some(now),
                    envelope: hex::encode(framed.encode().map_err(envelope::dag_error)?),
                    retry_ciphertext: None,
                    text,
                    // Inbound. `clientRef` is the *sender's* optimistic-row key
                    // and never crosses the wire.
                    client_ref: None,
                    unrecoverable: None,
                    type_tag: None,
                    ceremony: framed.tbs().retention_class == RetentionClass::Ceremony,
                    expires_at: expiry_for(stored, now, self.records().global_retention()?),
                    delivery: StoredDelivery {
                        state: "delivered".into(),
                        accepted_by_relays: 0,
                        configured_relays: 0,
                        devices_receipted: 0,
                        devices_expected: DEVICES_EXPECTED,
                        failure: None,
                        updated_at: now,
                    },
                };
                // THE durable write. Everything the frontend will be told about
                // this message is in this one transaction, and the ACK that
                // deletes the relay's copy happens only after it returns.
                stored.last_message_at = Some(now);
                stored.unread_count = stored.unread_count.saturating_add(1);
                if let Some(inbound) = stored.queues.inbound.as_mut() {
                    inbound.next_index = index.saturating_add(1);
                }
                let stored_snapshot = stored.clone();
                self.records().commit(|records| {
                    records.put_message(&message)?;
                    records.remember_message(&conversation_id, &msg_id)?;
                    records.put_conversation(&stored_snapshot)
                })?;

                events.push(Inbound::Message(MessageReceivedEvent {
                    conversation_id: conversation_id.clone(),
                    message: message_view(&message),
                }));
                events.push(Inbound::Conversation(self.view(stored)?));
            }
            MessageType::QUEUE_ADVERT => {
                self.advance(stored, index)?;
                if let Ok(advert) =
                    serde_json::from_slice::<QueueAdvert>(framed.tbs().body.as_slice())
                {
                    self.set_peer_advert(&conversation_id, &advert)?;
                    *stored = self.conversation(&conversation_id)?;
                    events.push(Inbound::Conversation(self.view(stored)?));
                }
            }
            envelope::EPHEMERAL_HINT => {
                self.advance(stored, index)?;
                if let Ok(hint) =
                    serde_json::from_slice::<EphemeralHintState>(framed.tbs().body.as_slice())
                {
                    stored.ephemeral_hint = Some(EphemeralHintState {
                        // Attributable, and this device says what *it* is doing
                        // rather than what the sender asked for.
                        honored_locally: true,
                        ..hint
                    });
                    let snapshot = stored.clone();
                    self.records()
                        .commit(|records| records.put_conversation(&snapshot))?;
                    events.push(Inbound::Conversation(self.view(stored)?));
                }
            }
            MessageType::GAP_REQUEST => {
                self.advance(stored, index)?;
                let request =
                    GapRequest::from_body(&framed.tbs().body).map_err(envelope::dag_error)?;

                // §7's repair, and the shape of it is the whole point: the
                // **original plaintext envelope**, which `send_control` then
                // re-encrypts under the *current* epoch. Replaying the stored
                // ciphertext would hand back bytes sealed under a key the
                // forward-secrecy argument says is gone, so nothing here ever
                // touches one.
                //
                // The bounded-window plaintext outbox §8.4 requires is this
                // device's own transcript, which is exactly why §3.7 says
                // shortening retention shortens the gap-repair window: a
                // message this device has expired is one it can no longer
                // repair, and it says so rather than staying silent.
                let mut entries = Vec::with_capacity(request.hashes().len());
                for wanted in request.hashes() {
                    let hex_id = envelope::to_hex(*wanted);
                    let held = self
                        .records()
                        .message(&hex_id)?
                        .filter(|message| message.unrecoverable.is_none())
                        .and_then(|message| hex::decode(&message.envelope).ok())
                        .and_then(|bytes| AppMessage::decode(&bytes).ok());
                    let entry = match held {
                        Some(message) => RepairEntry::supplied(&message),
                        None => RepairEntry::unrecoverable(*wanted, RepairRefusal::NoLongerHeld),
                    }
                    .map_err(envelope::dag_error)?;
                    entries.push(entry);
                }
                let body = GapResponse::new(entries)
                    .to_body()
                    .map_err(envelope::dag_error)?;
                let snapshot = stored.clone();
                self.send_control(&snapshot, MessageType::GAP_RESPONSE, body.as_slice())
                    .await?;
            }
            MessageType::GAP_RESPONSE => {
                self.advance(stored, index)?;
                let response =
                    GapResponse::from_body(&framed.tbs().body).map_err(envelope::dag_error)?;
                let mut gaps = self.records().gaps(&conversation_id)?;

                for entry in response.entries() {
                    let recovered_id = envelope::to_hex(entry.msg_id());
                    if entry.refusal().is_some() {
                        // The responder answered and does not hold it. §3.5's
                        // `unrecoverable` is a statement about the *sender*, and
                        // it is the only honest one available: nobody else has
                        // the plaintext either.
                        self.dag(&conversation_id)?
                            .mark_unrecoverable(&entry.msg_id());
                        continue;
                    }
                    if self.records().has_message(&recovered_id)? {
                        continue;
                    }
                    // `accept` re-verifies that the supplied bytes hash to the
                    // hash that was asked for. A responder cannot answer a
                    // repair request with different content than the one the
                    // requester's dangling parent named.
                    let Ok(recovered) = entry.accept(&entry.msg_id()) else {
                        continue;
                    };
                    let message = StoredMessage {
                        msg_id: recovered_id.clone(),
                        conversation_id: conversation_id.clone(),
                        outbound: false,
                        epoch: recovered.tbs().epoch,
                        // The *author's* leaf, read out of the envelope rather
                        // than off the delivery — which is what #734 changed
                        // and why a repaired transcript now matches one that
                        // never lost anything.
                        sender_leaf_index: recovered.tbs().sender_leaf_index,
                        parents: recovered
                            .tbs()
                            .parents
                            .as_slice()
                            .iter()
                            .copied()
                            .map(envelope::to_hex)
                            .collect(),
                        sent_at: i64::try_from(recovered.tbs().sent_at.claimed_millis())
                            .unwrap_or_default(),
                        received_at: Some(now),
                        envelope: hex::encode(recovered.encode().map_err(envelope::dag_error)?),
                        retry_ciphertext: None,
                        text: Some(
                            String::from_utf8_lossy(recovered.tbs().body.as_slice()).into_owned(),
                        ),
                        client_ref: None,
                        unrecoverable: None,
                        type_tag: None,
                        ceremony: recovered.tbs().retention_class == RetentionClass::Ceremony,
                        expires_at: None,
                        delivery: StoredDelivery {
                            state: "delivered".into(),
                            accepted_by_relays: 0,
                            configured_relays: 0,
                            devices_receipted: 0,
                            devices_expected: DEVICES_EXPECTED,
                            failure: None,
                            updated_at: now,
                        },
                    };
                    self.records().commit(|records| {
                        records.put_message(&message)?;
                        records.remember_message(&conversation_id, &recovered_id)
                    })?;
                    // No leaf index parameter: it is a hashed field of the
                    // envelope now (#734), so a third-party repair produces a
                    // byte-identical entry to a first-party one and two
                    // receivers who learned this message by different routes
                    // render the same transcript.
                    self.dag(&conversation_id)?
                        .insert(DagEntry::from_repair(&recovered));
                    for gap in &mut gaps {
                        gap.missing_msg_ids.retain(|id| id != &recovered_id);
                    }
                    events.push(Inbound::Message(MessageReceivedEvent {
                        conversation_id: conversation_id.clone(),
                        message: message_view(&message),
                    }));
                }

                for gap in &mut gaps {
                    if gap.missing_msg_ids.is_empty() {
                        gap.state = GapState::Repaired;
                    } else if gap.state == GapState::RepairRequested {
                        gap.state = GapState::Unrecoverable;
                    }
                    events.push(Inbound::GapRepaired(gap.clone()));
                }
                gaps.retain(|gap| gap.state != GapState::Repaired);
                self.records()
                    .commit(|records| records.put_gaps(&conversation_id, &gaps))?;
            }
            envelope::PURGE_REQUEST => {
                self.advance(stored, index)?;
                let before_epoch: u64 =
                    serde_json::from_slice(framed.tbs().body.as_slice()).unwrap_or(0);
                let status = PurgeRequestStatus {
                    purge_id: format!("purge-in-{now}"),
                    conversation_id: conversation_id.clone(),
                    before_epoch,
                    direction: Direction::Inbound,
                    asked_participants: 1,
                    confirmed_participants: 0,
                    requested_at: now,
                };
                let mut purges = self.records().purges(&conversation_id)?;
                purges.push(status.clone());
                self.records()
                    .commit(|records| records.put_purges(&conversation_id, &purges))?;
                events.push(Inbound::Purge(status));
                let snapshot = stored.clone();
                let body = serde_json::to_vec(&before_epoch)
                    .map_err(|error| Error::internal(format!("purge ack: {error}")))?;
                self.send_control(&snapshot, envelope::PURGE_ACK, &body)
                    .await?;
            }
            envelope::PURGE_ACK => {
                self.advance(stored, index)?;
                let mut purges = self.records().purges(&conversation_id)?;
                if let Some(status) = purges
                    .iter_mut()
                    .rfind(|status| status.direction == Direction::Outbound)
                {
                    status.confirmed_participants = status.confirmed_participants.saturating_add(1);
                    events.push(Inbound::Purge(status.clone()));
                }
                self.records()
                    .commit(|records| records.put_purges(&conversation_id, &purges))?;
            }
            MessageType::RECEIPT => {
                self.advance(stored, index)?;
                let acknowledged: String =
                    serde_json::from_slice(framed.tbs().body.as_slice()).unwrap_or_default();
                if let Some(mut message) = self.records().message(&acknowledged)? {
                    // §6.2: one recipient device emitted an authenticated
                    // receipt naming this `msg_id`. That is evidence of exactly
                    // that, and of nothing about reading. `delivered` is the
                    // sender-side computation across the device set as of the
                    // send epoch, which single-device v1 makes equal to one —
                    // and that coincidence is why the states must not collapse.
                    message.delivery.devices_receipted =
                        message.delivery.devices_receipted.saturating_add(1);
                    message.delivery.state = if message.delivery.devices_receipted
                        >= message.delivery.devices_expected
                    {
                        "delivered".into()
                    } else {
                        "device-delivered".into()
                    };
                    message.delivery.updated_at = now;
                    self.records()
                        .commit(|records| records.put_message(&message))?;
                    events.push(Inbound::Delivery(delivery_view(&message)));
                }
            }
            // §3.4's `{ kind: "unsupported"; typeTag }`. A codepoint this build
            // does not render is still a DAG vertex — it was inserted above —
            // so a peer that missed it can still notice. It is recorded so the
            // transcript shows *something* rather than a silent hole (§9 rule
            // 7), which is the same reason `unrecoverable` exists.
            other => {
                let message = StoredMessage {
                    msg_id: msg_id.clone(),
                    conversation_id: conversation_id.clone(),
                    outbound: false,
                    epoch,
                    sender_leaf_index: sender,
                    parents: framed
                        .tbs()
                        .parents
                        .as_slice()
                        .iter()
                        .copied()
                        .map(envelope::to_hex)
                        .collect(),
                    sent_at: i64::try_from(framed.tbs().sent_at.claimed_millis())
                        .unwrap_or_default(),
                    received_at: Some(now),
                    envelope: hex::encode(framed.encode().map_err(envelope::dag_error)?),
                    retry_ciphertext: None,
                    text: None,
                    client_ref: None,
                    unrecoverable: None,
                    type_tag: Some(envelope::type_tag(other)),
                    ceremony: framed.tbs().retention_class == RetentionClass::Ceremony,
                    expires_at: None,
                    delivery: StoredDelivery {
                        state: "delivered".into(),
                        accepted_by_relays: 0,
                        configured_relays: 0,
                        devices_receipted: 0,
                        devices_expected: DEVICES_EXPECTED,
                        failure: None,
                        updated_at: now,
                    },
                };
                if let Some(inbound) = stored.queues.inbound.as_mut() {
                    inbound.next_index = index.saturating_add(1);
                }
                let snapshot = stored.clone();
                self.records().commit(|records| {
                    records.put_message(&message)?;
                    records.remember_message(&conversation_id, &msg_id)?;
                    records.put_conversation(&snapshot)
                })?;
                events.push(Inbound::Message(MessageReceivedEvent {
                    conversation_id: conversation_id.clone(),
                    message: message_view(&message),
                }));
            }
        }
        Ok(events)
    }

    /// Advance the queue's read cursor for a message that produced no record.
    fn advance(&self, stored: &mut StoredConversation, index: u64) -> Result<()> {
        if let Some(inbound) = stored.queues.inbound.as_mut() {
            inbound.next_index = index.saturating_add(1);
        }
        let snapshot = stored.clone();
        self.records()
            .commit(|records| records.put_conversation(&snapshot))
    }

    /// Write §3.4's `{ kind: "unrecoverable" }` marker for a message whose
    /// plaintext is gone. **Never rendered as nothing** (§9 rule 7).
    fn record_unrecoverable(
        &self,
        conversation_id: &str,
        index: u64,
        now: i64,
    ) -> Result<Vec<Inbound>> {
        let msg_id = hex::encode(
            hash2(
                b"free2z/msg/v1/lost",
                conversation_id.as_bytes(),
                &index.to_be_bytes(),
            )
            .as_bytes(),
        );
        if self.records().has_message(&msg_id)? {
            return Ok(Vec::new());
        }
        let message = StoredMessage {
            msg_id: msg_id.clone(),
            conversation_id: conversation_id.to_owned(),
            outbound: false,
            epoch: 0,
            sender_leaf_index: 0,
            parents: Vec::new(),
            sent_at: now,
            received_at: Some(now),
            envelope: String::new(),
            retry_ciphertext: None,
            text: None,
            client_ref: None,
            unrecoverable: Some(UnrecoverableCause::GapUnrecoverable),
            type_tag: None,
            ceremony: false,
            expires_at: None,
            delivery: StoredDelivery {
                state: "expired".into(),
                accepted_by_relays: 0,
                configured_relays: 0,
                devices_receipted: 0,
                devices_expected: DEVICES_EXPECTED,
                failure: Some(ErrorCode::GapUnrecoverable),
                updated_at: now,
            },
        };
        self.records().commit(|records| {
            records.put_message(&message)?;
            records.remember_message(conversation_id, &msg_id)
        })?;
        Ok(vec![Inbound::Message(MessageReceivedEvent {
            conversation_id: conversation_id.to_owned(),
            message: message_view(&message),
        })])
    }
}

/// `WIRE.md` §11's published document → the warnings §3.11 shows.
///
/// A capability **digest** mismatch is deliberately not among them: §11.2 says
/// a client that detects the divergence MUST refuse, so there is no configured,
/// usable relay to carry such a warning. Encoding it both ways would give an
/// implementer a warning state the protocol forbids reaching.
fn warnings_for(capabilities: &f2z_codec::commands::Capabilities) -> Vec<RelayWarning> {
    let mut warnings = Vec::new();
    if capabilities.transport_security == 0 {
        warnings.push(RelayWarning::NoTransportSecurity);
    }
    if capabilities.channel_binding_mode == 0 {
        warnings.push(RelayWarning::NoChannelBinding);
    }
    if capabilities.antireplay_persistence == 0 {
        warnings.push(RelayWarning::VolatileAntireplay);
    }
    if capabilities.queue_creation_mode == 2 {
        warnings.push(RelayWarning::TokenGated);
    }
    if capabilities.durability_mode == 0 {
        warnings.push(RelayWarning::NonDurable);
    }
    warnings
}

fn operator_of(capabilities: &f2z_codec::commands::Capabilities) -> RelayOperator {
    let text = |bytes: &f2z_codec::types::ShortBytes| {
        String::from_utf8_lossy(bytes.as_slice()).into_owned()
    };
    RelayOperator {
        name: text(&capabilities.operator_name),
        contact: text(&capabilities.operator_contact),
        abuse_contact: text(&capabilities.operator_abuse_contact),
        jurisdiction: text(&capabilities.operator_jurisdiction),
        policy_url: text(&capabilities.operator_policy_url),
        source_repo_url: text(&capabilities.source_repo_url),
        source_commit: text(&capabilities.source_commit),
        build_digest: text(&capabilities.build_digest),
    }
}

fn capabilities_view(capabilities: &f2z_codec::commands::Capabilities) -> RelayCapabilities {
    RelayCapabilities {
        padding_sizes: capabilities.padding_sizes.as_slice().to_vec(),
        max_message_ttl_seconds: u64::from(capabilities.max_message_ttl_seconds),
        idle_ttl_seconds: u64::from(capabilities.max_idle_ttl_seconds),
        queue_creation_mode: match capabilities.queue_creation_mode {
            0 => QueueCreationMode::Open,
            2 => QueueCreationMode::Token,
            _ => QueueCreationMode::Pow,
        },
        durability_mode: match capabilities.durability_mode {
            0 => RelayDurabilityMode::Memory,
            2 => RelayDurabilityMode::FsyncPerAppend,
            _ => RelayDurabilityMode::Batched,
        },
        per_source_limits: capabilities.per_source_limits != 0,
        operator: operator_of(capabilities),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use f2z_codec::types::{Digest, PublicKey, RelayId, ShortBytes};
    use f2z_kt_core::entry::{DeviceCredential, DirectoryEntryTBS, EntryKind};
    use f2z_kt_core::types::{Handle, KemPublicKey, LogId};
    use f2z_msg_identity::{AccountKeys, DeviceCredentialRequest};
    use f2z_msg_mls::{DeviceSigner, MlsEngine};
    use f2z_msg_store::MemoryBackend;
    use openmls::prelude::{GroupId, MlsGroup};
    use openmls_traits::OpenMlsProvider as _;

    use super::{Engine, Introduction, QueueAdvert, acknowledgeable, routing_advert_digest};
    use crate::directory::{Directory, ResolvedIdentity, ResolvedPeer};
    use crate::error::{Error, Result};
    use crate::events::{EventSink, NullSink};
    use crate::models::{DirectoryResolution, EngineState, ErrorCode, Platform, RelayOperator};
    use crate::store::{StoredContactRequest, StoredRelay};

    struct AcceptDirectory(ResolvedIdentity);

    impl Directory for AcceptDirectory {
        fn resolve(&self, _handle: &str) -> Result<DirectoryResolution> {
            Ok(self.0.resolution.clone())
        }

        fn resolve_identity(&self, _handle: &str) -> Result<ResolvedIdentity> {
            Ok(self.0.clone())
        }

        fn resolve_peer(&self, _handle: &str) -> Result<ResolvedPeer> {
            Err(Error::internal("acceptance must not resolve a key package"))
        }

        fn independent_witnesses(&self) -> u32 {
            1
        }

        fn threshold_met(&self) -> bool {
            true
        }
    }

    fn issued_device(
        handle: &str,
        account_seed: u8,
        device_seed: u8,
    ) -> (DeviceSigner, DeviceCredential, DirectoryEntryTBS) {
        let account = AccountKeys::from_seed(&[account_seed; 64], 0).unwrap();
        let signer = DeviceSigner::from_private_key([device_seed; 32]);
        let credential = account
            .identity
            .issue_device_credential(&DeviceCredentialRequest {
                handle: Handle::new(handle.as_bytes().to_vec()).unwrap(),
                device_pk: PublicKey::new(*signer.public_key()),
                device_kem_pk: KemPublicKey::new(vec![device_seed; 1216]).unwrap(),
                not_before_ms: 0,
                not_after_ms: u64::MAX / 2,
            })
            .unwrap();
        let entry = DirectoryEntryTBS {
            label: ShortBytes::new(f2z_kt_core::labels::LABEL_ENTRY.to_vec()).unwrap(),
            kt_version: 1,
            log_id: LogId::new([account_seed; 32]),
            handle: credential.credential.handle.clone(),
            entry_version: 1,
            kind: EntryKind::SameKey,
            identity_pk: credential.credential.identity_pk,
            directory_auth_pk: PublicKey::new([0x22; 32]),
            devices: vec![credential.clone()].into(),
            revocations: Vec::new().into(),
            contact_endpoints: Vec::new().into(),
            prev_entry_hash: Digest::new([0; 32]),
            no_reset: 0,
            created_at_ms: 0,
        };
        (signer, credential, entry)
    }

    fn authenticated_request(
        recipient_package: &[u8],
        recipient_entry: &DirectoryEntryTBS,
    ) -> (ResolvedIdentity, StoredContactRequest) {
        let (signer, credential, entry) = issued_device("alice", 7, 9);
        let signer_pk = credential.credential.device_pk;
        let mls = MlsEngine::new(MemoryBackend::new(), signer, credential, 0).unwrap();
        let verified = mls
            .verify_key_package(recipient_package, recipient_entry, 0)
            .expect("recipient package is directory-bound");
        let group_id = [0x31; 32];
        let mut group = mls.create_group(&group_id).expect("sender group");
        let (_commit, welcome) = mls
            .add_member(&mut group, &verified, 0)
            .expect("authentic Welcome");
        let conversation_id = hex::encode(group_id);
        let advert = QueueAdvert {
            relay_url: "wss://alice-relay.example/relay/v1".to_owned(),
            relay_id: "11".repeat(32),
            send_addr: "22".repeat(32),
        };
        let digest = routing_advert_digest(&conversation_id, &welcome, &advert).unwrap();
        let signature = mls.sign_routing_advert(digest.as_bytes()).unwrap();
        let identity_pk = hex::encode(entry.identity_pk.as_bytes());
        let resolution = DirectoryResolution {
            handle: "alice".to_owned(),
            found: true,
            identity_fingerprint: Some(identity_pk.clone()),
            device_count: 1,
            entry_version: Some(1),
            epoch: 1,
            witness_cosignatures: 1,
            independent_witnesses: 1,
            threshold_met: true,
        };
        let identity = ResolvedIdentity {
            resolution,
            identity_pk: identity_pk.clone(),
            entry,
            contact_relay_url: "wss://alice-relay.example/relay/v1".to_owned(),
            contact_relay_id: RelayId::new([0x11; 32]),
            contact_addr: "44".repeat(32),
        };
        let request = StoredContactRequest {
            request_id: "req-conversation".to_owned(),
            peer_handle: "alice".to_owned(),
            peer_identity_fingerprint: identity_pk,
            conversation_id,
            received_at: 0,
            body_preview: None,
            welcome: hex::encode(welcome),
            peer_send_addr: advert.send_addr,
            peer_relay_url: advert.relay_url,
            peer_relay_id: advert.relay_id,
            advert_device_pk: hex::encode(signer_pk.as_bytes()),
            advert_signature: hex::encode(signature),
        };
        (identity, request)
    }

    async fn assert_acceptance_refuses(mut mutate: impl FnMut(&mut StoredContactRequest)) {
        let engine = Engine::new(
            MemoryBackend::new(),
            Arc::new(NullSink) as Arc<dyn EventSink>,
            Platform::ZuuliDesktop,
        )
        .unwrap();
        let (bob_signer, bob_credential, bob_entry) = issued_device("bob", 0x22, 0xb2);
        let bob_package = {
            let mut inner = engine.inner.lock().await;
            let backend = inner.backend.clone();
            inner.mls = Some(
                MlsEngine::new(backend, bob_signer, bob_credential, 0).expect("bob MLS engine"),
            );
            inner
                .mls_ref("test")
                .unwrap()
                .generate_key_package()
                .expect("bob package")
        };
        let (identity, mut request) = authenticated_request(&bob_package, &bob_entry);
        mutate(&mut request);
        let conversation_id = request.conversation_id.clone();
        let group_id = hex::decode(&conversation_id).expect("canonical conversation id");
        assert_eq!(
            group_id.len(),
            32,
            "the fixture must reach MLS join if authentication is bypassed"
        );
        let engine = engine.with_directory(Arc::new(AcceptDirectory(identity)));
        {
            let mut inner = engine.inner.lock().await;
            inner.state = EngineState::Running;
            inner
                .records()
                .commit(|records| {
                    records.put_relays(&[StoredRelay {
                        relay_id: "55".repeat(32),
                        relay_url: "wss://bob-relay.example/relay/v1".to_owned(),
                        allow_insecure_transport: false,
                        allow_no_channel_binding: false,
                        warnings: Vec::new(),
                        operator: RelayOperator {
                            name: String::new(),
                            contact: String::new(),
                            abuse_contact: String::new(),
                            jurisdiction: String::new(),
                            policy_url: String::new(),
                            source_repo_url: String::new(),
                            source_commit: String::new(),
                            build_digest: String::new(),
                        },
                        capabilities_digest: String::new(),
                    }])?;
                    records.put_contact_requests(&[request])
                })
                .unwrap();
        }

        let error = engine
            .accept_contact_request("req-conversation")
            .await
            .expect_err("the mutated first-contact transcript must be refused");
        assert_eq!(
            error.code(),
            ErrorCode::RelayIdentityMismatch,
            "this must fail in the shipping authentication call, before MLS join or relay I/O"
        );
        let inner = engine.inner.lock().await;
        assert!(
            inner.groups.is_empty(),
            "authentication refusal must precede the in-memory MLS join"
        );
        assert!(
            MlsGroup::load(
                inner.mls_ref("test").unwrap().provider().storage(),
                &GroupId::from_slice(&group_id),
            )
            .expect("load after authentication refusal")
            .is_none(),
            "authentication refusal must precede the persisted MLS join"
        );
        assert!(
            inner
                .records()
                .conversation(&conversation_id)
                .unwrap()
                .is_none(),
            "authentication refusal must not persist a conversation"
        );
        let requests = inner.records().contact_requests().unwrap();
        assert_eq!(requests.len(), 1, "the refused request must remain pending");
        assert_eq!(requests[0].request_id, "req-conversation");
        assert!(
            inner.connections.is_empty(),
            "authentication refusal must precede every relay connection or request"
        );
    }

    #[test]
    fn relay_identity_is_inside_the_device_authenticated_routing_digest() {
        let first = QueueAdvert {
            relay_url: "wss://relay.example/relay/v1".to_owned(),
            relay_id: "11".repeat(32),
            send_addr: "22".repeat(32),
        };
        let mut substituted = first.clone();
        substituted.relay_id = "33".repeat(32);
        assert_ne!(
            routing_advert_digest("conversation", b"welcome", &first).unwrap(),
            routing_advert_digest("conversation", b"welcome", &substituted).unwrap(),
            "deleting relay-id coverage makes the substitution mutation survive"
        );
    }

    #[test]
    fn welcome_is_inside_the_device_authenticated_routing_digest() {
        let advert = QueueAdvert {
            relay_url: "wss://relay.example/relay/v1".to_owned(),
            relay_id: "11".repeat(32),
            send_addr: "22".repeat(32),
        };
        assert_ne!(
            routing_advert_digest("conversation", b"alice welcome", &advert).unwrap(),
            routing_advert_digest("conversation", b"attacker welcome", &advert).unwrap(),
            "deleting Welcome coverage makes the substitution mutation survive"
        );
    }

    #[tokio::test]
    async fn accept_contact_request_refuses_a_swapped_welcome() {
        assert_acceptance_refuses(|request| {
            request.welcome = hex::encode(b"attacker Welcome");
        })
        .await;
    }

    #[tokio::test]
    async fn accept_contact_request_refuses_a_substituted_route() {
        assert_acceptance_refuses(|request| {
            request.peer_relay_id = "33".repeat(32);
        })
        .await;
    }

    #[tokio::test]
    async fn accept_contact_request_refuses_a_substituted_signature() {
        assert_acceptance_refuses(|request| {
            let mut signature = hex::decode(&request.advert_signature).unwrap();
            signature[0] ^= 1;
            request.advert_signature = hex::encode(signature);
        })
        .await;
    }

    #[tokio::test]
    async fn a_signed_group_id_mismatch_fails_before_conversation_or_group_persistence() {
        let engine = Engine::new(
            MemoryBackend::new(),
            Arc::new(NullSink) as Arc<dyn EventSink>,
            Platform::ZuuliDesktop,
        )
        .unwrap();
        let (bob_signer, bob_credential, bob_entry) = issued_device("bob", 0x22, 0xb2);
        {
            let mut inner = engine.inner.lock().await;
            let backend = inner.backend.clone();
            inner.mls = Some(
                MlsEngine::new(backend, bob_signer, bob_credential, 0).expect("bob MLS engine"),
            );
        }
        let bob_package = {
            let inner = engine.inner.lock().await;
            inner
                .mls_ref("test")
                .unwrap()
                .generate_key_package()
                .expect("bob package")
        };

        let (alice_signer, alice_credential, alice_entry) = issued_device("alice", 0x11, 0xa1);
        let alice = MlsEngine::new(MemoryBackend::new(), alice_signer, alice_credential, 0)
            .expect("alice MLS engine");
        let verified = alice
            .verify_key_package(&bob_package, &bob_entry, 0)
            .expect("directory-bound package");
        let actual_group_id = [0x31; 32];
        let outer_group_id = [0x32; 32];
        let mut alice_group = alice.create_group(&actual_group_id).expect("group");
        let (_commit, welcome) = alice
            .add_member(&mut alice_group, &verified, 0)
            .expect("Welcome");
        let advert = QueueAdvert {
            relay_url: "wss://alice-relay.example/relay/v1".to_owned(),
            relay_id: "11".repeat(32),
            send_addr: "22".repeat(32),
        };
        let outer = hex::encode(outer_group_id);
        let digest = routing_advert_digest(&outer, &welcome, &advert).unwrap();
        let introduction = Introduction {
            conversation_id: outer.clone(),
            welcome,
            advert,
            advert_device_pk: hex::encode(alice.credential().credential.device_pk.as_bytes()),
            advert_signature: hex::encode(alice.sign_routing_advert(digest.as_bytes()).unwrap()),
        };

        let mut inner = engine.inner.lock().await;
        inner
            .authenticate_introduction(&alice_entry, &introduction, 0)
            .expect("the peer really signed the contradictory envelope");
        let error = inner
            .join_conversation(
                "alice",
                &hex::encode(alice_entry.identity_pk.as_bytes()),
                &introduction,
                "wss://unused.example/relay/v1",
            )
            .await
            .expect_err("the envelope and Welcome must name the same group");
        assert_eq!(error.code(), ErrorCode::RelayIdentityMismatch);
        assert!(!inner.groups.contains_key(&outer));
        assert!(inner.records().conversation(&outer).unwrap().is_none());
        let mls = inner.mls_ref("test").unwrap();
        assert!(
            MlsGroup::load(
                mls.provider().storage(),
                &GroupId::from_slice(&actual_group_id)
            )
            .expect("load after refused join")
            .is_none(),
            "the checked join must roll the OpenMLS transaction back"
        );
    }

    #[test]
    fn a_clean_batch_is_acknowledged_to_its_end() {
        assert_eq!(acknowledgeable(&[(0, true), (1, true), (2, true)]), Some(2));
    }

    #[test]
    fn nothing_read_is_nothing_acknowledged() {
        assert_eq!(acknowledgeable(&[]), None);
    }

    #[test]
    fn a_failure_stops_the_acknowledgement_at_the_message_before_it() {
        // The whole point. `ACK` is cumulative, so acknowledging 2 would delete
        // 1 — the one this device could not write — from the relay, and there
        // is no second copy anywhere. §9 rule 1.
        assert_eq!(
            acknowledgeable(&[(0, true), (1, false), (2, true)]),
            Some(0)
        );
    }

    #[test]
    fn a_failure_on_the_first_message_acknowledges_nothing() {
        assert_eq!(acknowledgeable(&[(0, false), (1, true)]), None);
    }

    #[test]
    fn later_successes_never_resume_the_acknowledgement() {
        // A `max()` over the committed indices would answer 4 here and delete
        // three messages this device does not hold. The fold has to stop.
        assert_eq!(
            acknowledgeable(&[(0, true), (1, false), (2, true), (3, true), (4, true)]),
            Some(0)
        );
    }

    #[test]
    fn a_batch_that_does_not_start_at_zero_is_still_bounded_by_its_first_failure() {
        // A queue read resumes from `next_index`, so a batch's first index is
        // whatever the last pass reached.
        assert_eq!(
            acknowledgeable(&[(97, true), (98, true), (99, false)]),
            Some(98)
        );
    }
}
