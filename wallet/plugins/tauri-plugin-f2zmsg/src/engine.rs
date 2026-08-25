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
use f2z_codec::hash::hash2;
use f2z_msg_mls::{EngineError, MlsEngine, Received};
use f2z_msg_store::{F2zStorageProvider, StorageBackend};
use f2z_relay_proto::key::SigningKey;
use openmls::prelude::{GroupId, MlsGroup};
use openmls_traits::OpenMlsProvider as _;
use rand::RngCore as _;

use crate::directory::{Directory, NoDirectory};
use crate::error::{Error, Result};
use crate::events::EventSink;
use crate::framing::{AppKind, AppMessage, MsgId, RetentionClass, SortKey};
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
    state: EngineState,
    last_error: Option<ErrorCode>,
    platform: Platform,
    /// Generated by `prepare_device`, consumed by `install_identity`. Held in
    /// memory only, and only for the duration of one enrollment.
    pending_device: Option<DeviceSecrets>,
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
                state: EngineState::Uninitialized,
                last_error: None,
                platform,
                pending_device: None,
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
    /// # Errors
    ///
    /// `witness-threshold-unmet` in this build, always. See `crate::directory`:
    /// no key-transparency client exists yet, so zero independent witnesses have
    /// cosigned any root, and §6.4's matrix says resolving a **new** handle is
    /// **refused**, not degraded. This is the #133 moment — an unverified key
    /// here *is* the MITM — and §9 rule 5 forbids proceeding silently.
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
        // §6.4's first row. Everything below this line is `WIRE.md` §12.5's
        // handshake and is the same code the harness drives; the only step this
        // build cannot take is this one.
        let peer = self.directory.resolve_peer(peer_handle)?;

        let mut inner = self.inner.lock().await;
        inner.require_running("start_conversation")?;
        let relay_url = inner.first_relay_url()?;
        let introduction = inner
            .create_conversation(
                peer_handle,
                &peer.identity_pk,
                &peer.key_package,
                &relay_url,
            )
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
        let peer = self.directory.resolve_peer(&request.peer_handle)?;

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
                send_addr: request.peer_send_addr.clone(),
            },
        };
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

        let heads = inner.records().heads(conversation_id)?;
        let parents: Vec<MsgId> = heads
            .iter()
            .filter_map(|head| MsgId::from_hex(head).ok())
            .collect();

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
            let envelope = AppMessage::new(
                AppKind::Chat,
                &parents,
                epoch,
                u64::try_from(now).unwrap_or_default(),
                RetentionClass::Chat,
                body.as_bytes(),
            )
            .map_err(|error| Error::internal(format!("framing a message: {error}")))?;
            let ciphertext = mls
                .send(&mut group, envelope.as_bytes())
                .map_err(|error| Error::internal(format!("encrypting: {error}")))?;
            Ok((envelope, ciphertext, epoch, leaf))
        })();
        inner.groups.insert(conversation_id.to_owned(), group);
        let (envelope, ciphertext, epoch, leaf) = sealed?;

        let msg_id = envelope.msg_id().to_hex();
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
            envelope: hex::encode(envelope.as_bytes()),
            retry_ciphertext: Some(hex::encode(&ciphertext)),
            text: Some(body.to_owned()),
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
        let key = SortKey::new(epoch, leaf, envelope.msg_id());
        inner.records().commit(|records| {
            records.put_message(&message)?;
            let mut transcript = records.transcript(conversation_id)?;
            transcript.insert(key.to_cursor(), msg_id.clone());
            records.put_transcript(conversation_id, &transcript)?;
            // The DAG advances: this message now covers every previous head.
            records.put_heads(conversation_id, std::slice::from_ref(&msg_id))
        })?;

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
        let ciphertext = message
            .retry_ciphertext
            .as_deref()
            .map(hex::decode)
            .transpose()
            .map_err(|_| Error::internal("stored ciphertext is not hex"))?
            .ok_or_else(|| {
                Error::internal("this message has no retained ciphertext to re-append")
            })?;
        let delivery = inner
            .deliver(&stored, msg_id, &ciphertext, now_ms())
            .await?;
        self.sink.message_state(&delivery);
        Ok(SendAccepted {
            msg_id: msg_id.to_owned(),
            client_ref: String::new(),
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

    /// §3.4 `list_messages`, in §7's total order, oldest first.
    ///
    /// # Errors
    ///
    /// `internal` when no such conversation exists.
    pub async fn list_messages(
        &self,
        conversation_id: &str,
        limit: u32,
        before: Option<String>,
        after: Option<String>,
    ) -> Result<MessagePage> {
        let inner = self.inner.lock().await;
        let _ = inner.conversation(conversation_id)?;
        let transcript = inner.records().transcript(conversation_id)?;
        let limit = usize::try_from(limit).unwrap_or(50).clamp(1, 500);

        let selected: Vec<(String, String)> = match (&before, &after) {
            // `before` walks backwards and then re-orders, because the page is
            // always returned oldest first even when it was collected newest
            // first.
            (Some(before), _) => {
                let mut window: Vec<(String, String)> = transcript
                    .range::<String, _>(..before.clone())
                    .rev()
                    .take(limit)
                    .map(|(cursor, id)| (cursor.clone(), id.clone()))
                    .collect();
                window.reverse();
                window
            }
            (None, Some(after)) => transcript
                .range::<String, _>(after.clone()..)
                .skip(1)
                .take(limit)
                .map(|(cursor, id)| (cursor.clone(), id.clone()))
                .collect(),
            (None, None) => {
                let mut window: Vec<(String, String)> = transcript
                    .iter()
                    .rev()
                    .take(limit)
                    .map(|(cursor, id)| (cursor.clone(), id.clone()))
                    .collect();
                window.reverse();
                window
            }
        };

        let mut messages = Vec::with_capacity(selected.len());
        for (_, msg_id) in &selected {
            if let Some(stored) = inner.records().message(msg_id)? {
                messages.push(message_view(&stored));
            }
        }

        // §3.5: a hole, not an absence. `false` here means "no detected gap"
        // and never "nothing is missing" — hash links do not detect tail
        // truncation, and no string may imply they do.
        let first_cursor = selected.first().map(|(cursor, _)| cursor.clone());
        let has_gap_before = first_cursor.as_ref().is_some_and(|cursor| {
            transcript
                .range::<String, _>(..cursor.clone())
                .next()
                .is_some()
        }) && !inner.records().gaps(conversation_id)?.is_empty();

        Ok(MessagePage {
            messages,
            cursor: selected.first().map(|(cursor, _)| cursor.clone()),
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
        let inner = self.inner.lock().await;
        let mut stored = inner.conversation(conversation_id)?;
        stored.read_through = Some(up_to_msg_id.to_owned());
        stored.unread_count = 0;
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

        let mut wanted: Vec<String> = Vec::new();
        for gap in &mut gaps {
            if gap_ids.iter().any(|id| id == &gap.gap_id) {
                gap.state = GapState::RepairRequested;
                wanted.extend(gap.missing_msg_ids.iter().cloned());
            }
        }
        inner
            .records()
            .commit(|records| records.put_gaps(conversation_id, &gaps))?;

        let body = serde_json::to_vec(&wanted)
            .map_err(|error| Error::internal(format!("framing a gap request: {error}")))?;
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
            .send_control(&stored, AppKind::GapRequest, &body)
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
            .send_control(&stored, AppKind::EphemeralHint, &body)
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
            .send_control(&stored, AppKind::PurgeRequest, &body)
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

    /// §3.10 `check_handle_eligibility`. Pure, callable before enrollment and
    /// before the engine runs, so the UI can decide what to render without
    /// provoking a failure.
    #[must_use]
    pub fn check_handle_eligibility(&self, username: &str) -> HandleEligibility {
        handle::eligibility(username)
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

    /// This device's published contact address (§12.2), once `start_engine` has
    /// opened one.
    ///
    /// # Errors
    ///
    /// `internal` if the store cannot be read.
    #[cfg(any(test, feature = "relay-harness"))]
    pub async fn contact_advert(&self) -> Result<Option<(String, String)>> {
        let inner = self.inner.lock().await;
        Ok(inner
            .records()
            .contact_queue()?
            .map(|queue| (queue.relay_url, queue.contact_addr)))
    }
}

/// Where a peer writes to reach this device: `WIRE.md` §12.2's queue advert,
/// reduced to what a 1:1 conversation on one relay needs.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct QueueAdvert {
    pub relay_url: String,
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
}

/// What the initiator hands the joiner out of band.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Introduction {
    pub conversation_id: String,
    /// The MLS `Welcome`.
    pub welcome: Vec<u8>,
    /// The initiator's own advert.
    pub advert: QueueAdvert,
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

        if !self.connections.contains_key(&outbound.relay_url) {
            // §8: keep the message `pending` and retry with backoff. Do not
            // mark anything failed — an unreachable relay is not a delivery
            // failure, it is an absence of evidence either way.
            return self.mark_delivery(msg_id, "pending", Some(ErrorCode::RelayUnreachable), now);
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
    /// request or response. Not recorded in the transcript — none of these is a
    /// message — but it does advance the DAG, because a receiver must be able to
    /// see that it holds every parent.
    async fn send_control(
        &mut self,
        stored: &StoredConversation,
        kind: AppKind,
        body: &[u8],
    ) -> Result<()> {
        let heads = self.records().heads(&stored.conversation_id)?;
        let parents: Vec<MsgId> = heads
            .iter()
            .filter_map(|head| MsgId::from_hex(head).ok())
            .collect();
        let now = now_ms();
        let mut group = self
            .groups
            .remove(&stored.conversation_id)
            .ok_or_else(|| Error::engine_not_running("send_control"))?;
        let sealed: Result<Vec<u8>> = (|| {
            let mls = self.mls_ref("send_control")?;
            let envelope = AppMessage::new(
                kind,
                &parents,
                group.epoch().as_u64(),
                u64::try_from(now).unwrap_or_default(),
                RetentionClass::Chat,
                body,
            )
            .map_err(|error| Error::internal(format!("framing: {error}")))?;
            mls.send(&mut group, envelope.as_bytes())
                .map_err(|error| Error::internal(format!("encrypting: {error}")))
        })();
        self.groups.insert(stored.conversation_id.clone(), group);
        let ciphertext = sealed?;

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
        peer_key_package: &[u8],
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
        let sealed: Result<()> = (|| {
            let mls = self.mls_ref("join_conversation")?;
            let group = mls
                .join_from_welcome(
                    &introduction.welcome,
                    u64::try_from(now).unwrap_or_default(),
                )
                .map_err(|error| Error::internal(format!("joining: {error}")))?;
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
        self.send_control(&stored, AppKind::QueueAdvert, &body)
            .await?;
        Ok(advert)
    }

    /// Record where this device writes to reach the peer.
    fn set_peer_advert(&self, conversation_id: &str, advert: &QueueAdvert) -> Result<()> {
        let mut stored = self.conversation(conversation_id)?;
        stored.queues.outbound = Some(OutboundQueue {
            relay_url: advert.relay_url.clone(),
            send_addr: advert.send_addr.clone(),
            send_key_seed: hex::encode(self.queue_key(conversation_id, LABEL_QUEUE_SEND)?),
            bound: false,
        });
        self.records()
            .commit(|records| records.put_conversation(&stored))
    }

    /// `CONTACT_APPEND` the introduction to the peer's published contact queue
    /// (§12.2).
    ///
    /// Unsigned at the relay and gated by a proof-of-work stamp: that is the
    /// whole design — a stranger can reach you exactly once, expensively — and
    /// §12.4 is honest that the cost lands far harder on a phone than on rented
    /// hardware. The solve runs on a blocking task so a slow one does not stall
    /// the runtime; §3.3 tells the UI to show it as work, not as a network wait.
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
        };
        let body = serde_json::to_vec(&envelope)
            .map_err(|error| Error::internal(format!("framing first contact: {error}")))?;
        let contact_addr = queue_address(&peer.contact_addr)?;
        let connection = self
            .connections
            .get_mut(&peer.contact_relay_url)
            .ok_or_else(|| Error::new(ErrorCode::RelayUnreachable, "relay not connected"))?;
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
        };
        self.records()
            .commit(|records| records.put_contact_queue(&queue))
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
            let Ok(envelope) = serde_json::from_slice::<ContactEnvelope>(&bytes) else {
                // A stranger can put anything in a contact queue. A payload
                // that does not parse is discarded silently: it is not evidence
                // of anything, and surfacing it would make the queue an abuse
                // channel with a UI.
                continue;
            };
            // §3.3: `block` is entirely local, because there is no server that
            // knows who is talking to whom.
            if blocked.contains(&envelope.handle) {
                continue;
            }
            if requests
                .iter()
                .any(|existing| existing.conversation_id == envelope.conversation_id)
            {
                continue;
            }
            let request = StoredContactRequest {
                request_id: format!("req-{}", envelope.conversation_id),
                peer_handle: envelope.handle.clone(),
                peer_identity_fingerprint: envelope.identity_pk.clone(),
                conversation_id: envelope.conversation_id.clone(),
                received_at: now_ms(),
                // **PROVISIONAL** (§12.1), and `None` deliberately: showing any
                // part of an unsolicited, unauthenticated-at-the-relay payload
                // is a moderation and safety question nobody has answered, and
                // shipping a preview would be answering it by accident.
                body_preview: None,
                welcome: envelope.welcome.clone(),
                peer_send_addr: envelope.advert.send_addr.clone(),
                peer_relay_url: envelope.advert.relay_url.clone(),
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
        let mut highest: Option<u64> = None;
        for queued in response.messages.as_slice() {
            let index = queued.index;
            let outcome = match crate::relay::unpad(queued.payload.as_slice()) {
                Ok(ciphertext) => self.apply_inbound(&mut stored, index, &ciphertext).await,
                Err(error) => Err(error),
            };
            match outcome {
                Ok(mut produced) => events.append(&mut produced),
                Err(error) => {
                    tracing::info!(conversation = %conversation_id, index, code = %error.code(), "inbound");
                }
            }
            highest = Some(index);
        }

        // Only now, and only if this store can promise durability. §11.2: a
        // client that cannot must never ACK, because the relay deletes the
        // instant it receives one and IndexedDB — or a store opened in memory —
        // can be discarded as a unit.
        if let Some(highest) = highest {
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

        let envelope = AppMessage::decode(&payload)
            .map_err(|error| Error::internal(format!("application envelope: {error}")))?;
        let msg_id = envelope.msg_id().to_hex();
        let mut events = Vec::new();

        // §3.5's gap detection, and it needs no server assistance: a `parents`
        // hash this device does not hold means a message is missing, with
        // certainty.
        let mut missing = Vec::new();
        for parent in envelope.parents() {
            let parent_hex = parent.to_hex();
            if !self.records().has_message(&parent_hex)? {
                missing.push(parent_hex);
            }
        }
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

        match envelope.kind() {
            AppKind::Chat | AppKind::Unknown(_) => {
                let text = if envelope.kind() == AppKind::Chat {
                    Some(String::from_utf8_lossy(envelope.body()).into_owned())
                } else {
                    None
                };
                let message = StoredMessage {
                    msg_id: msg_id.clone(),
                    conversation_id: conversation_id.clone(),
                    outbound: false,
                    epoch,
                    sender_leaf_index: sender,
                    parents: envelope.parents().iter().map(MsgId::to_hex).collect(),
                    sent_at: i64::try_from(envelope.advisory_sent_at()).unwrap_or_default(),
                    received_at: Some(now),
                    envelope: hex::encode(envelope.as_bytes()),
                    retry_ciphertext: None,
                    text,
                    unrecoverable: None,
                    type_tag: match envelope.kind() {
                        AppKind::Chat => None,
                        other => Some(other.type_tag()),
                    },
                    ceremony: envelope.retention_class() == Some(RetentionClass::Ceremony),
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
                let key = SortKey::new(epoch, sender, envelope.msg_id());

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
                    let mut transcript = records.transcript(&conversation_id)?;
                    transcript.insert(key.to_cursor(), msg_id.clone());
                    records.put_transcript(&conversation_id, &transcript)?;
                    records.put_heads(&conversation_id, std::slice::from_ref(&msg_id))?;
                    records.put_conversation(&stored_snapshot)
                })?;

                events.push(Inbound::Message(MessageReceivedEvent {
                    conversation_id: conversation_id.clone(),
                    message: message_view(&message),
                }));
                events.push(Inbound::Conversation(self.view(stored)?));
            }
            AppKind::QueueAdvert => {
                self.advance(stored, index)?;
                if let Ok(advert) = serde_json::from_slice::<QueueAdvert>(envelope.body()) {
                    self.set_peer_advert(&conversation_id, &advert)?;
                    *stored = self.conversation(&conversation_id)?;
                    events.push(Inbound::Conversation(self.view(stored)?));
                }
            }
            AppKind::EphemeralHint => {
                self.advance(stored, index)?;
                if let Ok(hint) = serde_json::from_slice::<EphemeralHintState>(envelope.body()) {
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
            AppKind::GapRequest => {
                self.advance(stored, index)?;
                let wanted: Vec<String> =
                    serde_json::from_slice(envelope.body()).unwrap_or_default();
                let mut held = Vec::new();
                for id in wanted {
                    if let Some(message) = self
                        .records()
                        .message(&id)?
                        .filter(|message| message.unrecoverable.is_none())
                    {
                        held.push(message.envelope);
                    }
                }
                // §7's repair: the ORIGINAL envelope, re-encrypted under the
                // current epoch. Never a replay of the old ciphertext, which
                // would undermine forward secrecy.
                let body = serde_json::to_vec(&held)
                    .map_err(|error| Error::internal(format!("gap response: {error}")))?;
                let snapshot = stored.clone();
                self.send_control(&snapshot, AppKind::GapResponse, &body)
                    .await?;
            }
            AppKind::GapResponse => {
                self.advance(stored, index)?;
                let repaired: Vec<String> =
                    serde_json::from_slice(envelope.body()).unwrap_or_default();
                let mut gaps = self.records().gaps(&conversation_id)?;
                for hex_envelope in repaired {
                    let Ok(bytes) = hex::decode(&hex_envelope) else {
                        continue;
                    };
                    let Ok(recovered) = AppMessage::decode(&bytes) else {
                        continue;
                    };
                    let recovered_id = recovered.msg_id().to_hex();
                    if self.records().has_message(&recovered_id)? {
                        continue;
                    }
                    let message = StoredMessage {
                        msg_id: recovered_id.clone(),
                        conversation_id: conversation_id.clone(),
                        outbound: false,
                        epoch: recovered.epoch(),
                        // The repair carries the envelope, not the MLS framing,
                        // so the leaf index is not re-provable here. Zero keeps
                        // the total order deterministic and is honest about
                        // what was recovered.
                        sender_leaf_index: 0,
                        parents: recovered.parents().iter().map(MsgId::to_hex).collect(),
                        sent_at: i64::try_from(recovered.advisory_sent_at()).unwrap_or_default(),
                        received_at: Some(now),
                        envelope: hex_envelope.clone(),
                        retry_ciphertext: None,
                        text: Some(String::from_utf8_lossy(recovered.body()).into_owned()),
                        unrecoverable: None,
                        type_tag: None,
                        ceremony: false,
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
                    let key = SortKey::new(recovered.epoch(), 0, recovered.msg_id());
                    self.records().commit(|records| {
                        records.put_message(&message)?;
                        let mut transcript = records.transcript(&conversation_id)?;
                        transcript.insert(key.to_cursor(), recovered_id.clone());
                        records.put_transcript(&conversation_id, &transcript)
                    })?;
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
                        // The sender answered and did not hold them. §3.5's
                        // `unrecoverable`: the plaintext is gone, and the
                        // transcript says so rather than showing a hole.
                        gap.state = GapState::Unrecoverable;
                    }
                    events.push(Inbound::GapRepaired(gap.clone()));
                }
                gaps.retain(|gap| gap.state != GapState::Repaired);
                self.records()
                    .commit(|records| records.put_gaps(&conversation_id, &gaps))?;
            }
            AppKind::PurgeRequest => {
                self.advance(stored, index)?;
                let before_epoch: u64 = serde_json::from_slice(envelope.body()).unwrap_or(0);
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
                self.send_control(&snapshot, AppKind::PurgeAck, &body)
                    .await?;
            }
            AppKind::PurgeAck => {
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
            AppKind::Receipt => {
                self.advance(stored, index)?;
                let acknowledged: String =
                    serde_json::from_slice(envelope.body()).unwrap_or_default();
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
        let key = SortKey::new(0, 0, MsgId::from_hex(&msg_id)?);
        self.records().commit(|records| {
            records.put_message(&message)?;
            let mut transcript = records.transcript(conversation_id)?;
            transcript.insert(key.to_cursor(), msg_id.clone());
            records.put_transcript(conversation_id, &transcript)
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
