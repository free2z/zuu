//! The relay: one frame in, zero or more frames out.
//!
//! # What is reused rather than rewritten
//!
//! Almost everything. `f2z-codec` owns re-encode equality (§3.3) and the framing
//! (§4); `f2z-relay-proto` owns §5.1's verification order, §5.5's anti-replay,
//! §7 and §8's queue and acknowledgement rules and §11's capability document;
//! `f2z-relay-store` owns authorization-inside-the-transaction, quota admission
//! and the acknowledgement watermark. A relay that re-derived any of those would
//! be a second opinion about the protocol, and a second opinion is how ciphertext
//! gets deleted before it is read.
//!
//! What is genuinely decided here is the part those crates leave to a server:
//! the connection lifecycle of §2.5, the in-flight window of §4.3, which code
//! answers which refusal, when a push is emitted, and §13.1's layering.
//!
//! # The refusal codes, and the one rule behind most of them
//!
//! §6.3: **every send-side refusal that would distinguish queue state collapses
//! to `ERR_UNAVAILABLE`.** Absent, deleted, expired, full-by-messages,
//! full-by-bytes, unbound, wrong key, backpressure — one code. §10's table
//! assigns "absent" to code 10 and therefore contradicts §6.3;
//! [#586](https://github.com/free2z/zuu/issues/586) tracks it, #583 resolved it
//! in §6.3's favour, `f2z-relay-testkit` did the same, and so does this.
//!
//! On the receive side the mirror rule is §10's existence-oracle rule: "no such
//! queue" and "exists, but your key does not authorize it" are one code, and the
//! absent path performs a dummy Ed25519 verification first so the dominant CPU
//! cost is present in both. §10 is explicit that this narrows the timing channel
//! rather than closing it, and so is this implementation.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use f2z_codec::canonical::{Canonical, decode_canonical};
use f2z_codec::commands::{
    AckRequest, AckResponse, AppendRequest, ChallengePurpose, ChallengeRequest, ChallengeResponse,
    ClaimKeyPackageRequest, ClaimKeyPackageResponse, Command, ContactAppendRequest,
    CreateContactQueueRequest, CreateContactQueueResponse, CreateQueueRequest, CreateQueueResponse,
    HelloRequest, HelloResponse, PublishKeyPackagesRequest, PublishKeyPackagesResponse,
    QueuedMessage, ReadRequest, ReadResponse, SubscribeResponse,
};
use f2z_codec::frame::{FramePayload, RelayFrame, Request, Response};
use f2z_codec::padding::PaddingBuckets;
use f2z_codec::pow::{PowParams, PowStamp};
use f2z_codec::transcript::TranscriptBuilder;
use f2z_codec::types::{ChannelBinding, Payload, QueueAddress, RelayId};
use f2z_codec::{ErrorCode, PROTOCOL_VERSION};
use f2z_relay_proto::capabilities::{ChannelBindingMode, TransportSecurity};
use f2z_relay_proto::command::{CommandVerifier, Empty, RelayCommand, Verified, ops};
use f2z_relay_proto::hello::{RelayAnnouncement, hello_response};
use f2z_relay_proto::key::{SigningKey, dummy_verify};
use f2z_relay_proto::queue::{AppendQuota, QueueKind, TtlPolicy};
use f2z_relay_proto::replay::{SeenSet, TimestampWindow};
use f2z_relay_proto::{ProtoError, capabilities};
use f2z_relay_store::{QueueSpec, RelayStore, SendAuth, StoreError};

use crate::abuse::{AbuseGuard, CommandRate, SourceKey};
use crate::caps::Published;
use crate::challenge::Challenges;
use crate::commit::CommitWriter;
use crate::config::{Config, CreationMode};
use crate::metrics::Metrics;
use crate::outbound::Outbound;
use crate::subscriptions::{QUEUE_EVENT_DELETED, QUEUE_EVENT_QUOTA, Subscriptions};
use crate::transport::{CLOSE_PROTOCOL_ERROR, CLOSE_UNSUPPORTED_DATA};

/// How many times §7.1's "draw again on collision" is attempted before the
/// relay gives up and answers `ERR_INTERNAL`.
///
/// §7.1 says a relay "can simply retry on collision, which it will never have to
/// do at 32 bytes". A bound is still needed, because the *other* thing this loop
/// catches is a broken CSPRNG handing out a constant — and an unbounded retry
/// against one is a hang rather than an alert.
const ADDRESS_DRAWS: usize = 8;

/// Room reserved inside `max_frame_bytes` for a `READ` response's own framing:
/// the frame header, the response header, the vector prefixes and one
/// `QueuedMessage` header per message.
const READ_FRAME_OVERHEAD: u32 = 4096;

/// One relay, shared by every connection it serves.
pub struct Relay {
    config: Config,
    identity: SigningKey,
    relay_id: RelayId,
    published: Published,
    padding: PaddingBuckets,
    ttl: TtlPolicy,
    quota: AppendQuota,
    contact_quota: AppendQuota,
    creation_mode: CreationMode,
    store: Arc<dyn RelayStore + Send + Sync>,
    writer: CommitWriter,
    seen: Mutex<SeenSet>,
    challenges: Mutex<Challenges>,
    subscriptions: Arc<Subscriptions>,
    abuse: Arc<AbuseGuard>,
    metrics: Arc<Metrics>,
    next_connection: std::sync::atomic::AtomicU64,
}

impl std::fmt::Debug for Relay {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Relay")
            .field("relay_id", &self.relay_id)
            .field("durability", &self.writer.durability())
            .finish_non_exhaustive()
    }
}

/// One connection's state.
///
/// §6.2: *"a subscription is scoped to the connection and dies with it"*, and
/// §4.3's in-flight window is per connection too. Everything else a relay knows
/// is shared.
#[derive(Debug)]
pub struct Connection {
    /// Identifier, so a subscription can be found and dropped.
    pub id: u64,
    /// Whether `HELLO` has completed (§2.5 step 2).
    pub hello_done: bool,
    /// §4.3's outstanding `request_id`s.
    ///
    /// Shared, because an `APPEND` is answered from a spawned task: §4.3
    /// requires a client to be able to fetch, acknowledge and append
    /// concurrently on one connection "without head-of-line blocking", and a
    /// read loop that awaited each commit before reading the next frame would
    /// deny exactly that.
    pub inflight: Arc<Mutex<BTreeSet<u32>>>,
    /// Where responses and pushes go.
    pub pushes: tokio::sync::mpsc::Sender<Outbound>,
    /// This connection's transcript builder: the relay's own `relay_id` and
    /// **this session's** channel binding, never the frame's (§5.2, §5.3).
    pub transcripts: TranscriptBuilder,
    /// §13.1 layer 1's counter key. Not an address — see [`SourceKey`].
    pub source: SourceKey,
    /// §13.1 layer 1's per-connection command rate.
    pub rate: CommandRate,
}

impl Relay {
    /// Assemble a relay.
    #[expect(
        clippy::too_many_arguments,
        reason = "every collaborator is shared with a task outside this type; \
                  hiding them in a builder would hide what the relay owns"
    )]
    #[must_use]
    pub fn new(
        config: Config,
        identity: SigningKey,
        published: Published,
        padding: PaddingBuckets,
        store: Arc<dyn RelayStore + Send + Sync>,
        writer: CommitWriter,
        subscriptions: Arc<Subscriptions>,
        abuse: Arc<AbuseGuard>,
        metrics: Arc<Metrics>,
    ) -> Self {
        let relay_id = f2z_codec::hash::relay_id(&identity.public_key());
        let ttl = capabilities::ttl_policy(published.capabilities());
        let quota = AppendQuota {
            max_messages: u64::from(config.limits.max_queue_messages),
            max_bytes: config.limits.max_queue_bytes,
        };
        let contact_quota = AppendQuota {
            max_messages: u64::from(config.antiabuse.contact_max_pending),
            max_bytes: config.antiabuse.contact_max_bytes,
        };
        let creation_mode = config.creation_mode().unwrap_or(CreationMode::Pow);
        let seen = SeenSet::new(
            u64::from(config.limits.antireplay_window_ms),
            usize::try_from(config.limits.antireplay_seen_max).unwrap_or(usize::MAX),
        );
        let challenges =
            Challenges::new(usize::try_from(config.antiabuse.max_challenges).unwrap_or(usize::MAX));
        Self {
            config,
            identity,
            relay_id,
            published,
            padding,
            ttl,
            quota,
            contact_quota,
            creation_mode,
            store,
            writer,
            seen: Mutex::new(seen),
            challenges: Mutex::new(challenges),
            subscriptions,
            abuse,
            metrics,
            next_connection: std::sync::atomic::AtomicU64::new(1),
        }
    }

    /// §5.2's identity binding.
    #[must_use]
    pub const fn relay_id(&self) -> RelayId {
        self.relay_id
    }

    /// The published policy, signed.
    #[must_use]
    pub const fn published(&self) -> &Published {
        &self.published
    }

    /// The relay's configuration.
    #[must_use]
    pub const fn config(&self) -> &Config {
        &self.config
    }

    /// The subscription table.
    #[must_use]
    pub fn subscriptions(&self) -> &Arc<Subscriptions> {
        &self.subscriptions
    }

    /// The store, for the expiry tick and the admin listener.
    #[must_use]
    pub fn store(&self) -> &Arc<dyn RelayStore + Send + Sync> {
        &self.store
    }

    /// The counters.
    #[must_use]
    pub fn metrics(&self) -> &Arc<Metrics> {
        &self.metrics
    }

    /// The anti-abuse state.
    #[must_use]
    pub fn abuse(&self) -> &Arc<AbuseGuard> {
        &self.abuse
    }

    /// Age out anti-replay entries and expired challenges. Called by the tick.
    ///
    /// Returns `(seen_set_entries, challenges_outstanding)`.
    pub fn sweep_memory(&self, now_ms: u64) -> (usize, usize) {
        let entries = {
            let mut seen = self.lock_seen();
            seen.expire(now_ms);
            seen.len()
        };
        let outstanding = {
            let mut challenges = self.lock_challenges();
            challenges.expire(now_ms);
            challenges.len()
        };
        (entries, outstanding)
    }

    /// Open a connection.
    pub fn open_connection(
        &self,
        pushes: tokio::sync::mpsc::Sender<Outbound>,
        binding: ChannelBinding,
        source: SourceKey,
    ) -> Connection {
        let id = self
            .next_connection
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Connection {
            id,
            hello_done: false,
            inflight: Arc::new(Mutex::new(BTreeSet::new())),
            pushes,
            transcripts: TranscriptBuilder::new(PROTOCOL_VERSION, self.relay_id, binding),
            source,
            rate: CommandRate::new(self.config.limits.commands_per_connection_per_second),
        }
    }

    /// Release a connection's subscriptions (§6.2).
    pub fn close_connection(&self, connection: &Connection) {
        self.subscriptions.drop_connection(connection.id);
    }

    // ---------------------------------------------------------------------
    // The frame path.
    // ---------------------------------------------------------------------

    /// §4.2: a text frame is a fatal `ERR_FRAME_TYPE`, closed with status 1003.
    ///
    /// The relay MUST NOT attempt to decode it, MUST NOT attempt UTF-8
    /// validation beyond what the WebSocket layer already did, and MUST NOT
    /// treat it as an accidental binary frame. All three are the absence of code
    /// here — `WireMessage::Text` does not even carry the bytes.
    #[must_use]
    pub fn handle_text() -> Vec<Outbound> {
        vec![Outbound::close(CLOSE_UNSUPPORTED_DATA)]
    }

    /// Handle one binary frame (§4.1).
    ///
    /// Returns the frames to write **now**. An `APPEND` returns nothing here
    /// and answers from a spawned task once its commit is durable, which is
    /// what makes §4.3's out-of-order, non-blocking pipeline real rather than
    /// stated.
    pub async fn handle_binary(
        self: &Arc<Self>,
        connection: &mut Connection,
        now_ms: u64,
        bytes: &[u8],
    ) -> Vec<Outbound> {
        Metrics::inc(&self.metrics.frames_received);
        let caps = self.published.capabilities();

        // §4.1: a frame over `max_frame_bytes` is a fatal `ERR_MALFORMED`, and
        // the relay MUST NOT buffer the remainder to produce a tidy error.
        if bytes.len() > caps.max_frame_bytes as usize {
            return self.fatal(recover_request_id(bytes), ErrorCode::Malformed);
        }

        // §3.3 on the frame: decode, re-encode, byte-compare — and the
        // re-encoded bytes are what any signature covers.
        let Ok(frame) = decode_canonical::<RelayFrame>(bytes) else {
            return self.fatal(recover_request_id(bytes), ErrorCode::Malformed);
        };
        let frame = frame.into_value();
        if frame.validate().is_err() {
            return self.fatal(recover_request_id(bytes), ErrorCode::Malformed);
        }
        let request_id = frame.request_id;
        let FramePayload::Request(request) = &frame.payload else {
            // A client that sends a response or a push is speaking the wrong
            // half of the protocol. §10 has no code for it; `ERR_MALFORMED` is
            // the reading, and it is fatal, which is right for a frame no
            // conforming client emits.
            return self.fatal(request_id, ErrorCode::Malformed);
        };

        let command = request.command();

        // §2.5 step 2: `HELLO` MUST be the first frame.
        if !connection.hello_done && command != Some(Command::Hello) {
            return self.fatal(request_id, ErrorCode::UnsupportedVersion);
        }
        // §3.5: "version negotiation happens once, in HELLO, and applies to the
        // whole connection." A second HELLO is a renegotiation attempt and gets
        // the same code a version failure does. An ambiguity call: §10 does not
        // name this case, and this is the reading `f2z-relay-testkit` takes.
        if connection.hello_done && command == Some(Command::Hello) {
            return self.fatal(request_id, ErrorCode::UnsupportedVersion);
        }

        // §4.3. A duplicate in-flight id is a fatal `ERR_MALFORMED`; exceeding
        // the window is a fatal `ERR_TOO_MANY_INFLIGHT`. Both bounds exist so a
        // single connection cannot make the relay allocate unbounded
        // per-request state before any quota check has run.
        {
            let mut inflight = lock_inflight(&connection.inflight);
            if inflight.contains(&request_id) {
                drop(inflight);
                return self.fatal(request_id, ErrorCode::Malformed);
            }
            if inflight.len() >= usize::from(caps.max_inflight) {
                drop(inflight);
                return self.fatal(request_id, ErrorCode::TooManyInflight);
            }
            inflight.insert(request_id);
        }

        // §13.1 layer 1's per-connection command rate. Taken once, before the
        // fork below, so a deferred append pays for itself exactly like an
        // inline command does.
        let allowed = connection.rate.take(now_ms);

        // The two commands that reach the disk are answered off the read loop.
        // Everything else is a lookup or an in-memory update and is answered
        // inline, where it needs no task and no clone.
        if allowed
            && let Some(deferred) =
                command.filter(|code| matches!(code, Command::Append | Command::ContactAppend))
        {
            self.defer(connection, now_ms, request_id, deferred, request.clone());
            return Vec::new();
        }

        let outcome = if allowed {
            match command {
                Some(command) => {
                    self.dispatch(connection, now_ms, request_id, command, request)
                        .await
                }
                // §3.5: an unknown command code is a *non-fatal*
                // `ERR_UNKNOWN_COMMAND`. The framing was well-formed, so the
                // connection survives.
                None => Err(ProtoError::Wire(ErrorCode::UnknownCommand)),
            }
        } else {
            // Non-fatal: a client that slows down is welcome back.
            Err(ProtoError::Wire(ErrorCode::RateLimited))
        };

        lock_inflight(&connection.inflight).remove(&request_id);

        let (response, fatal) = match outcome {
            Ok(body) => {
                Metrics::inc(&self.metrics.commands_ok);
                (
                    Response::ok(body).unwrap_or_else(|_| Response::error(ErrorCode::Internal)),
                    false,
                )
            }
            Err(error) => {
                Metrics::inc(&self.metrics.commands_refused);
                let code = error.wire_code().unwrap_or(ErrorCode::Internal);
                (Response::error(code), code.is_fatal())
            }
        };

        let close = if fatal {
            Some(CLOSE_PROTOCOL_ERROR)
        } else {
            None
        };
        match Outbound::response(request_id, response) {
            Some(mut outbound) => {
                outbound.close_after = close;
                vec![outbound]
            }
            None => self.fatal(request_id, ErrorCode::Internal),
        }
    }

    fn fatal(&self, request_id: u32, code: ErrorCode) -> Vec<Outbound> {
        Metrics::inc(&self.metrics.commands_refused);
        // A frame whose `request_id` could not be recovered has no response a
        // conforming relay can build — §4.3 forbids a zero id on a response —
        // so the connection simply closes. §1.3 says "send the response, then
        // close" and does not say what to send when the id is unreadable; this
        // is the ambiguity call, and it matches `f2z-relay-testkit`'s.
        if request_id == 0 {
            return vec![Outbound::close(CLOSE_PROTOCOL_ERROR)];
        }
        Outbound::fatal(request_id, code, CLOSE_PROTOCOL_ERROR)
            .map_or_else(Vec::new, |outbound| vec![outbound])
    }

    // ---------------------------------------------------------------------
    // Command dispatch.
    // ---------------------------------------------------------------------

    async fn dispatch(
        &self,
        connection: &mut Connection,
        now_ms: u64,
        request_id: u32,
        command: Command,
        request: &Request,
    ) -> Result<Vec<u8>, ProtoError> {
        match command {
            Command::Hello => self.hello(connection, now_ms, request),
            Command::GetCapabilities => self.get_capabilities(request),
            Command::GetChallenge => self.get_challenge(connection, now_ms, request),
            Command::Ping => Self::ping(request),
            Command::CreateQueue => self.create_queue(connection, now_ms, request_id, request),
            Command::CreateContactQueue => {
                self.create_contact_queue(connection, now_ms, request_id, request)
            }
            Command::Subscribe => self.subscribe(connection, now_ms, request_id, request),
            Command::Unsubscribe => self.unsubscribe(connection, now_ms, request_id, request),
            Command::Read => self.read(connection, now_ms, request_id, request),
            Command::Ack => self.ack(connection, now_ms, request_id, request),
            Command::DeleteQueue => self.delete_queue(connection, now_ms, request_id, request),
            Command::BindSend => self.bind_send(connection, now_ms, request_id, request),
            Command::Append => {
                self.append(&connection.transcripts, now_ms, request_id, request)
                    .await
            }
            Command::ContactAppend => self.contact_append(now_ms, request).await,
            Command::PublishKeyPackages => {
                self.publish_key_packages(connection, now_ms, request_id, request)
            }
            Command::ClaimKeyPackage => self.claim_key_package(now_ms, request),
            // `Command` is `#[non_exhaustive]`: a code added to `f2z-codec` but
            // not handled here is a hole in this relay, not in the client that
            // sent it, and §3.5's non-fatal `ERR_UNKNOWN_COMMAND` is the honest
            // answer — this build genuinely does not implement it.
            _ => Err(ProtoError::Wire(ErrorCode::UnknownCommand)),
        }
    }

    // -- §6.1, unsigned ----------------------------------------------------

    fn hello(
        &self,
        connection: &mut Connection,
        now_ms: u64,
        request: &Request,
    ) -> Result<Vec<u8>, ProtoError> {
        let offer: HelloRequest = self.accept_unsigned::<ops::Hello>(request)?.into_body();
        if offer.min_version > offer.max_version
            || PROTOCOL_VERSION < offer.min_version
            || PROTOCOL_VERSION > offer.max_version
        {
            return Err(ProtoError::Wire(ErrorCode::UnsupportedVersion));
        }
        let caps = self.published.capabilities();
        let announcement = RelayAnnouncement {
            protocol_version: PROTOCOL_VERSION,
            relay_time_ms: now_ms,
            channel_binding_mode: if caps.channel_binding_mode
                == ChannelBindingMode::TlsExporter.code()
            {
                ChannelBindingMode::TlsExporter
            } else {
                ChannelBindingMode::None
            },
            transport_security: if caps.transport_security == TransportSecurity::Tls.code() {
                TransportSecurity::Tls
            } else {
                TransportSecurity::None
            },
            capabilities_digest: self.published.digest,
        };
        // The proof is over **this connection's** binding, which is what makes
        // §5.2's possession check a statement about this TLS session and not a
        // value an intermediary can forward.
        let response: HelloResponse = hello_response(
            &self.identity,
            &announcement,
            &connection.transcripts.channel_binding(),
            &offer.client_nonce,
        );
        connection.hello_done = true;
        Ok(response.encode_canonical()?)
    }

    fn get_capabilities(&self, request: &Request) -> Result<Vec<u8>, ProtoError> {
        let _: Empty = self
            .accept_unsigned::<ops::GetCapabilities>(request)?
            .into_body();
        // Encoded once at startup and handed out unchanged, so the bytes a
        // client verifies are byte-identical to the ones the digest in `HELLO`
        // was taken over.
        Ok(self.published.signed.encode_canonical()?)
    }

    fn ping(request: &Request) -> Result<Vec<u8>, ProtoError> {
        // `PING` needs no relay state at all, which is the point of it: §6.1
        // calls it an application-level liveness probe, distinct from §2.4's
        // WebSocket Ping that a browser cannot send.
        let verifier = CommandVerifier::new(
            TranscriptBuilder::new(PROTOCOL_VERSION, RelayId::zero(), ChannelBinding::zero()),
            TimestampWindow::new(0),
            SeenSet::new(0, 0),
            PaddingBuckets::default(),
        );
        let _: Empty = verifier.accept_unsigned::<ops::Ping>(request)?.into_body();
        Ok(Vec::new())
    }

    fn get_challenge(
        &self,
        connection: &Connection,
        now_ms: u64,
        request: &Request,
    ) -> Result<Vec<u8>, ProtoError> {
        let body: ChallengeRequest = self
            .accept_unsigned::<ops::GetChallenge>(request)?
            .into_body();
        // §6.1: "Challenge issuance is itself rate-limited per source, or it
        // becomes the cheapest way to make the relay do work."
        if !self.abuse.take_challenge(connection.source, now_ms) {
            return Err(ProtoError::Wire(ErrorCode::RateLimited));
        }
        // `purpose` is a raw byte so an unknown value round-trips through §3.3
        // rather than failing to decode. §10 has no code for "an enum value in
        // a body that this build does not know"; `ERR_MALFORMED` is the reading
        // here, it is fatal, and it is listed as an ambiguity call — the same
        // one `f2z-relay-testkit` flagged, and the weakest in the set.
        let purpose = body
            .purpose()
            .map_err(|_| ProtoError::Wire(ErrorCode::Malformed))?;
        let params = self.pow_params_for(purpose);
        let ttl = if params.challenge_ttl_ms == 0 {
            self.config.antiabuse.challenge_ttl_ms
        } else {
            params.challenge_ttl_ms
        };
        let expires_at_ms = now_ms.saturating_add(u64::from(ttl));

        let challenge =
            crate::rng::challenge().map_err(|_| ProtoError::Wire(ErrorCode::Internal))?;
        self.lock_challenges().issue(
            challenge,
            purpose.code(),
            body.scope.as_slice(),
            expires_at_ms,
            now_ms,
        )?;
        Metrics::inc(&self.metrics.challenges_issued);

        let response = ChallengeResponse {
            relay_time_ms: now_ms,
            challenge,
            expires_at_ms,
            pow: params,
        };
        Ok(response.encode_canonical()?)
    }

    fn pow_params_for(&self, purpose: ChallengePurpose) -> PowParams {
        let caps = self.published.capabilities();
        match purpose {
            // §6.1: the field is zeroed when no PoW is required, and a clock
            // read never requires one.
            ChallengePurpose::Clock => PowParams::none(),
            ChallengePurpose::QueueCreate => caps.queue_creation_pow,
            ChallengePurpose::ContactAppend => caps.contact_append_pow,
            ChallengePurpose::ClaimKeyPackage => caps.claim_key_package_pow,
        }
    }

    // -- §6.2, signed by the receive key -----------------------------------

    fn create_queue(
        &self,
        connection: &Connection,
        now_ms: u64,
        request_id: u32,
        request: &Request,
    ) -> Result<Vec<u8>, ProtoError> {
        let verified = self.verify_with::<ops::CreateQueue>(
            &connection.transcripts,
            now_ms,
            request_id,
            request,
            |_| Ok(()),
        )?;
        let body: CreateQueueRequest = verified.into_body();
        body.validate()?;

        // §13.1 layer 4, in the order the section states it: creation is the
        // first thing refused.
        if self.abuse.backpressured() {
            return Err(ProtoError::Wire(ErrorCode::Backpressure));
        }
        self.check_creation_stamp(now_ms, &body.stamp)?;
        self.check_queue_ceiling()?;

        let message_ttl = self.ttl.grant_message_ttl(body.req_message_ttl_seconds);
        let idle_ttl = self.ttl.grant_idle_ttl(body.req_idle_ttl_seconds);
        let record = self.create(
            QueueKind::Standard,
            body.recv_key,
            message_ttl,
            idle_ttl,
            self.quota,
            now_ms,
        )?;

        let response = CreateQueueResponse {
            recv_addr: record.0,
            send_addr: record.1,
            message_ttl_seconds: message_ttl,
            idle_ttl_seconds: idle_ttl,
            created_at_ms: now_ms,
        };
        Ok(response.encode_canonical()?)
    }

    fn create_contact_queue(
        &self,
        connection: &Connection,
        now_ms: u64,
        request_id: u32,
        request: &Request,
    ) -> Result<Vec<u8>, ProtoError> {
        let verified = self.verify_with::<ops::CreateContactQueue>(
            &connection.transcripts,
            now_ms,
            request_id,
            request,
            |_| Ok(()),
        )?;
        let body: CreateContactQueueRequest = verified.into_body();

        let caps = self.published.capabilities();
        if caps.contact_queues_enabled == 0 {
            return Err(ProtoError::Wire(ErrorCode::NotPermitted));
        }
        if self.abuse.backpressured() {
            return Err(ProtoError::Wire(ErrorCode::Backpressure));
        }
        self.check_creation_stamp(now_ms, &body.stamp)?;
        self.check_queue_ceiling()?;

        let message_ttl = self.ttl.grant_message_ttl(body.req_message_ttl_seconds);
        let idle_ttl = self.ttl.grant_idle_ttl(body.req_idle_ttl_seconds);
        // §12.3: a contact queue is hard-capped, because §12.2 point 2 means the
        // whole internet may write to it.
        let record = self.create(
            QueueKind::Contact,
            body.recv_key,
            message_ttl,
            idle_ttl,
            self.contact_quota,
            now_ms,
        )?;

        let response = CreateContactQueueResponse {
            recv_addr: record.0,
            contact_addr: record.1,
            message_ttl_seconds: message_ttl,
            idle_ttl_seconds: idle_ttl,
            max_pending: caps.contact_max_pending,
            max_bytes: caps.contact_max_bytes,
        };
        Ok(response.encode_canonical()?)
    }

    /// §7.1: both addresses from the relay's own CSPRNG, redrawn on collision.
    fn create(
        &self,
        kind: QueueKind,
        recv_key: f2z_codec::types::PublicKey,
        message_ttl_seconds: u32,
        idle_ttl_seconds: u32,
        quota: AppendQuota,
        now_ms: u64,
    ) -> Result<(QueueAddress, QueueAddress), ProtoError> {
        for _ in 0..ADDRESS_DRAWS {
            let recv_addr =
                crate::rng::queue_address().map_err(|_| ProtoError::Wire(ErrorCode::Internal))?;
            let send_addr =
                crate::rng::queue_address().map_err(|_| ProtoError::Wire(ErrorCode::Internal))?;
            match self.store.create_queue(&QueueSpec {
                kind,
                recv_addr,
                send_addr,
                recv_key,
                message_ttl_seconds,
                idle_ttl_seconds,
                quota,
                created_at_ms: now_ms,
            }) {
                Ok(_committed) => return Ok((recv_addr, send_addr)),
                Err(StoreError::AddressCollision) => {}
                Err(error) => return Err(store_error(&error)),
            }
        }
        // Eight consecutive collisions at 32 bytes does not happen; a CSPRNG
        // returning a constant does. §10's code 21 carries no detail, so the
        // operator's log is where this is said.
        crate::log_error!("queue address generator produced repeated collisions");
        Err(ProtoError::Wire(ErrorCode::Internal))
    }

    fn subscribe(
        &self,
        connection: &mut Connection,
        now_ms: u64,
        request_id: u32,
        request: &Request,
    ) -> Result<Vec<u8>, ProtoError> {
        let verified = self.verify_with::<ops::Subscribe>(
            &connection.transcripts,
            now_ms,
            request_id,
            request,
            |candidate| self.preauthorize_recv(candidate),
        )?;
        let recv_addr = verified.address();
        let signer = verified.signer_key();

        let record = self
            .store
            .queue_by_recv(&recv_addr, &signer)
            .map_err(|error| self.recv_error(&error))?;
        // §7.7: the idle TTL resets on SUBSCRIBE too, and this is the one
        // command for which that is the only durable consequence — hence
        // `touch`, which is best-effort on purpose.
        let _ = self.store.touch(&recv_addr, &signer, now_ms);

        self.subscriptions
            .subscribe(recv_addr, connection.id, connection.pushes.clone());

        let response = SubscribeResponse {
            next_index: record.state.next_index(),
            // §6.2: `pending` is disclosed to the **reader** only. There is no
            // equivalent anywhere on the send side.
            pending: record.state.pending(),
        };
        Ok(response.encode_canonical()?)
    }

    fn unsubscribe(
        &self,
        connection: &mut Connection,
        now_ms: u64,
        request_id: u32,
        request: &Request,
    ) -> Result<Vec<u8>, ProtoError> {
        let verified = self.verify_with::<ops::Unsubscribe>(
            &connection.transcripts,
            now_ms,
            request_id,
            request,
            |candidate| self.preauthorize_recv(candidate),
        )?;
        let recv_addr = verified.address();
        let signer = verified.signer_key();
        self.store
            .queue_by_recv(&recv_addr, &signer)
            .map_err(|error| self.recv_error(&error))?;
        self.subscriptions.unsubscribe(&recv_addr, connection.id);
        Ok(Vec::new())
    }

    fn read(
        &self,
        connection: &Connection,
        now_ms: u64,
        request_id: u32,
        request: &Request,
    ) -> Result<Vec<u8>, ProtoError> {
        let verified = self.verify_with::<ops::Read>(
            &connection.transcripts,
            now_ms,
            request_id,
            request,
            |candidate| self.preauthorize_recv(candidate),
        )?;
        let recv_addr = verified.address();
        let signer = verified.signer_key();
        let body: ReadRequest = verified.into_body();

        // §6.2 gives no meaning to a zero limit. The reading that keeps a queue
        // drainable is "no client-side limit" — a zero that meant "return
        // nothing" would make a client that forgot to set the field loop forever
        // against a queue it can never empty. Unstated in the specification, and
        // this is the same call `f2z-relay-testkit` made.
        let max_messages = if body.max_messages == 0 {
            u16::MAX
        } else {
            body.max_messages
        };
        // The byte limit is additionally clamped to what a response frame can
        // carry: a relay that honoured `max_bytes = u32::MAX` would build a
        // frame its own §4.1 cap forbids and answer `ERR_INTERNAL` instead of
        // the page the client asked for.
        let ceiling = self
            .published
            .capabilities()
            .max_frame_bytes
            .saturating_sub(READ_FRAME_OVERHEAD)
            .max(1);
        let max_bytes = if body.max_bytes == 0 {
            ceiling
        } else {
            body.max_bytes.min(ceiling)
        };

        // §13.1 layer 4: `READ` is never refused for backpressure. It is one of
        // the operations that make the relay smaller, and refusing it under load
        // is a deadlock.
        let page = self
            .store
            .read(
                &recv_addr,
                &signer,
                f2z_relay_store::ReadWindow {
                    from_index: body.from_index,
                    max_messages,
                    max_bytes,
                },
                now_ms,
            )
            .map_err(|error| self.recv_error(&error))?;

        let messages: Vec<QueuedMessage> = page
            .messages
            .into_iter()
            .map(|stored| QueuedMessage {
                index: stored.index,
                received_at_ms: stored.received_at_ms,
                payload: stored.payload,
            })
            .collect();
        let response = ReadResponse {
            messages: messages.into(),
            has_more: u8::from(page.has_more),
        };
        Ok(response.encode_canonical()?)
    }

    fn ack(
        &self,
        connection: &Connection,
        now_ms: u64,
        request_id: u32,
        request: &Request,
    ) -> Result<Vec<u8>, ProtoError> {
        let verified = self.verify_with::<ops::Ack>(
            &connection.transcripts,
            now_ms,
            request_id,
            request,
            |candidate| self.preauthorize_recv(candidate),
        )?;
        let recv_addr = verified.address();
        let signer = verified.signer_key();
        let body: AckRequest = verified.into_body();

        // The watermark advance and the range delete are one transaction inside
        // the store. That is the crash-safety invariant `f2z-relay-store` is
        // tested against, and it is why this is not two calls.
        let committed = self
            .store
            .ack(&recv_addr, &signer, body.up_to_index, now_ms)
            .map_err(|error| self.recv_error(&error))?;
        let outcome = committed.into_inner();
        Metrics::add(&self.metrics.messages_acked, outcome.acknowledged);

        let response = AckResponse {
            next_index: outcome.next_index,
            pending: outcome.pending,
        };
        Ok(response.encode_canonical()?)
    }

    fn delete_queue(
        &self,
        connection: &mut Connection,
        now_ms: u64,
        request_id: u32,
        request: &Request,
    ) -> Result<Vec<u8>, ProtoError> {
        let verified = self.verify_with::<ops::DeleteQueue>(
            &connection.transcripts,
            now_ms,
            request_id,
            request,
            |candidate| self.preauthorize_recv(candidate),
        )?;
        let recv_addr = verified.address();
        let signer = verified.signer_key();

        // The `Committed` receipt is taken and named rather than dropped: the
        // deletion is durable before the empty response is built, which is the
        // same ordering `commit_append` keeps for `accepted`.
        let _deleted = self
            .store
            .delete_queue(&recv_addr, &signer)
            .map_err(|error| self.recv_error(&error))?
            .into_inner();

        // §6.4: `QUEUE_EVENT` reason 1. Pushed **before** the subscription is
        // torn down, so the connection that asked for the deletion is told about
        // it like any other reader.
        self.subscriptions
            .notify_queue_event(recv_addr, QUEUE_EVENT_DELETED, &self.metrics);
        self.subscriptions.unsubscribe(&recv_addr, connection.id);
        Ok(Vec::new())
    }

    // -- §6.3, signed by the send key --------------------------------------

    fn bind_send(
        &self,
        connection: &Connection,
        now_ms: u64,
        request_id: u32,
        request: &Request,
    ) -> Result<Vec<u8>, ProtoError> {
        let verified = self.verify_with::<ops::BindSend>(
            &connection.transcripts,
            now_ms,
            request_id,
            request,
            |_| Ok(()),
        )?;
        let send_addr = verified.address();
        // `ops::BindSend::check` has already required `signer_key == send_key`:
        // §5.1 step 5 has nothing to compare against on an unbound address, so
        // possession of the key in the body is the only thing the signature can
        // prove, and without that requirement §7.4's bind-once theft protection
        // costs an attacker nothing.
        let signer = verified.signer_key();

        // §7.3, and §7.4's consequence: a second bind with **any** key,
        // including the same key, is `ERR_ALREADY_BOUND`. To a client that just
        // received a fresh advert this is a loud, non-dismissible failure, not a
        // retry — the relay operator may have read `send_addr` out of its own
        // database and bound first.
        // Taken rather than dropped: §7.3's bind is irreversible, so the empty
        // response must not precede the write that makes it so.
        // The `Committed` receipt is consumed here rather than dropped: §7.3's
        // bind is irreversible, so the empty response must not precede the
        // write that makes it so.
        let _receipt = self
            .store
            .bind_send(&send_addr, &signer, now_ms)
            .map_err(|error| send_error(&error))?;
        Ok(Vec::new())
    }

    async fn append(
        &self,
        transcripts: &TranscriptBuilder,
        now_ms: u64,
        request_id: u32,
        request: &Request,
    ) -> Result<Vec<u8>, ProtoError> {
        let verified = self.verify_with::<ops::Append>(
            transcripts,
            now_ms,
            request_id,
            request,
            |candidate| self.preauthorize_send(candidate),
        )?;
        let send_addr = verified.address();
        let signer = verified.signer_key();
        let body: AppendRequest = verified.into_body();

        // §13.1 layer 4 step 2: an append under backpressure is
        // `ERR_UNAVAILABLE`, never a code that says why.
        if self.abuse.backpressured() {
            return Err(ProtoError::Wire(ErrorCode::Unavailable));
        }

        self.commit_append(send_addr, SendAuth::Signed(signer), body.payload, now_ms)
            .await
    }

    // -- §12.2, contact queues ---------------------------------------------

    async fn contact_append(&self, now_ms: u64, request: &Request) -> Result<Vec<u8>, ProtoError> {
        let verified = self.accept_unsigned::<ops::ContactAppend>(request)?;
        let body: ContactAppendRequest = verified.into_body();

        if self.abuse.backpressured() {
            return Err(ProtoError::Wire(ErrorCode::Unavailable));
        }

        // The lookup comes first so that a stamp is only demanded for an address
        // that could take one — and it is `queue_by_send` with `ContactStamp`,
        // so an ordinary send address answers the same `ERR_UNAVAILABLE` a
        // nonexistent one does. A stranger probing addresses learns nothing
        // about which is which.
        self.store
            .queue_by_send(&body.contact_addr, &SendAuth::ContactStamp)
            .map_err(|error| send_error(&error))?;

        // §12.3: the stamp is over a relay-issued, single-use, expiring
        // challenge **scoped to this contact address**, so stamps cannot be
        // precomputed in bulk, cannot be reused, and cannot be computed for one
        // victim and spent on another.
        let params = self.published.capabilities().contact_append_pow;
        self.check_stamp(
            now_ms,
            &body.stamp,
            &params,
            ChallengePurpose::ContactAppend,
            body.contact_addr.as_bytes(),
        )?;

        self.commit_append(
            body.contact_addr,
            SendAuth::ContactStamp,
            body.payload,
            now_ms,
        )
        .await
    }

    // -- §12.6, key packages -----------------------------------------------

    fn publish_key_packages(
        &self,
        connection: &Connection,
        now_ms: u64,
        request_id: u32,
        request: &Request,
    ) -> Result<Vec<u8>, ProtoError> {
        // Ordinary receive-side authorization. §12.6's whole addressing
        // argument is that this is enough: the capability that already means
        // "I own this contact queue" is the capability that means "I own this
        // pool", so the relay learns no identifier it did not already hold.
        let verified = self.verify_with::<ops::PublishKeyPackages>(
            &connection.transcripts,
            now_ms,
            request_id,
            request,
            |candidate| self.preauthorize_recv(candidate),
        )?;
        let recv_addr = verified.address();
        let signer = verified.signer_key();
        let body: PublishKeyPackagesRequest = verified.into_body();

        let caps = self.published.capabilities();
        if caps.key_packages_enabled == 0 {
            return Err(ProtoError::Wire(ErrorCode::NotPermitted));
        }

        let packages = body.packages.as_slice();
        let last_resort = body.last_resort.as_slice().first();
        let pool = self
            .store
            .publish_key_packages(
                &recv_addr,
                &signer,
                packages,
                last_resort,
                caps.contact_max_key_packages,
                now_ms,
            )
            .map_err(|error| self.recv_error(&error))?
            .into_inner();

        let response = PublishKeyPackagesResponse {
            pool_size: pool.pool_size,
            max_pool_size: caps.contact_max_key_packages,
            has_last_resort: u8::from(pool.has_last_resort),
        };
        Ok(response.encode_canonical()?)
    }

    fn claim_key_package(&self, now_ms: u64, request: &Request) -> Result<Vec<u8>, ProtoError> {
        let verified = self.accept_unsigned::<ops::ClaimKeyPackage>(request)?;
        let body: ClaimKeyPackageRequest = verified.into_body();

        if self.abuse.backpressured() {
            return Err(ProtoError::Wire(ErrorCode::Unavailable));
        }

        let caps = self.published.capabilities();
        if caps.key_packages_enabled == 0 {
            return Err(ProtoError::Wire(ErrorCode::NotPermitted));
        }

        // The stamp is demanded before the pool is consulted. A claim that
        // answered "nothing here" cheaply and "here you are" expensively would
        // be a free existence oracle over the published address space, which is
        // the one part of the address space an attacker can enumerate from a
        // directory.
        let params = caps.claim_key_package_pow;
        self.check_stamp(
            now_ms,
            &body.stamp,
            &params,
            ChallengePurpose::ClaimKeyPackage,
            body.contact_addr.as_bytes(),
        )?;

        // Absent, not-a-contact-queue, and exhausted are one code
        // (`ERR_UNAVAILABLE`), decided in the store inside the transaction that
        // consumes. **Exhaustion is a refusal and never a panic or an empty
        // success** — §12.6.
        let claimed = self
            .store
            .claim_key_package(&body.contact_addr)
            .map_err(|error| send_error(&error))?
            .into_inner();

        let response = ClaimKeyPackageResponse {
            key_package: claimed.key_package,
            last_resort: u8::from(claimed.last_resort),
        };
        Ok(response.encode_canonical()?)
    }

    /// The one path by which anything reaches the disk, and the one place
    /// `accepted` is decided.
    ///
    /// §6.3: the response body is empty. No index, no depth, no timestamp, no
    /// queue state of any kind — an index would tell the sender how many
    /// messages the queue has ever held, and a timestamp would give it a clock
    /// to correlate against.
    async fn commit_append(
        &self,
        send_addr: QueueAddress,
        auth: SendAuth,
        payload: Payload,
        now_ms: u64,
    ) -> Result<Vec<u8>, ProtoError> {
        let payload_bytes = u64::try_from(payload.len()).unwrap_or(u64::MAX);
        let accepted = match self
            .writer
            .append(send_addr, auth, payload.clone(), now_ms)
            .await
            .map_err(|_| ProtoError::Wire(ErrorCode::Unavailable))?
        {
            Ok(accepted) => accepted,
            Err(error) => {
                // §6.4's `QUEUE_EVENT` reason 4. The *writer* is told nothing
                // but `ERR_UNAVAILABLE` — §6.3 collapses every send-side
                // refusal so a bound sender cannot learn the queue's state by
                // filling it — but the **reader** is the party that can act,
                // and §6.4 gives it a push saying so.
                self.announce_quota(send_addr, auth, payload_bytes);
                return Err(send_error(&error));
            }
        };

        // Only now. The `Accepted` above exists only downstream of the store's
        // `Committed`, which the commit thread unwrapped after its transaction —
        // so this line is unreachable before the write is durable, and not
        // because anyone remembered to put it here.
        if self.subscriptions.has_subscriber(&accepted.recv_addr) {
            let message = QueuedMessage {
                index: accepted.index,
                received_at_ms: accepted.received_at_ms,
                payload,
            };
            self.subscriptions
                .notify_message(accepted.recv_addr, &message, &self.metrics);
        }
        Ok(Vec::new())
    }

    /// Answer an `APPEND` or `CONTACT_APPEND` from its own task.
    ///
    /// The task holds only what it needs: the relay, this connection's
    /// transcript builder (§5.2, §5.3 — never a shared one), the outbound
    /// channel and the in-flight set. It cannot touch subscriptions or the
    /// `HELLO` flag, so the read loop remains the only writer of those.
    fn defer(
        self: &Arc<Self>,
        connection: &Connection,
        now_ms: u64,
        request_id: u32,
        command: Command,
        request: Request,
    ) {
        let relay = Arc::clone(self);
        let transcripts = connection.transcripts.clone();
        let inflight = Arc::clone(&connection.inflight);
        let pushes = connection.pushes.clone();
        tokio::spawn(async move {
            let outcome = match command {
                Command::Append => {
                    relay
                        .append(&transcripts, now_ms, request_id, &request)
                        .await
                }
                Command::ContactAppend => relay.contact_append(now_ms, &request).await,
                // `defer` is called with exactly the two codes above.
                _ => Err(ProtoError::Wire(ErrorCode::Internal)),
            };
            // §4.3: the window is released when the relay answers.
            lock_inflight(&inflight).remove(&request_id);

            let (response, fatal) = match outcome {
                Ok(body) => {
                    Metrics::inc(&relay.metrics.commands_ok);
                    (
                        Response::ok(body).unwrap_or_else(|_| Response::error(ErrorCode::Internal)),
                        false,
                    )
                }
                Err(error) => {
                    Metrics::inc(&relay.metrics.commands_refused);
                    let code = error.wire_code().unwrap_or(ErrorCode::Internal);
                    (Response::error(code), code.is_fatal())
                }
            };
            if let Some(mut outbound) = Outbound::response(request_id, response) {
                if fatal {
                    outbound.close_after = Some(CLOSE_PROTOCOL_ERROR);
                }
                // The client hung up. §2.5: an in-flight command whose response
                // was not received has *unknown* status, and the append stays —
                // §8.3 is explicit that APPEND is not idempotent at the relay.
                let _ = pushes.send(outbound).await;
            }
        });
    }

    /// Tell a subscribed reader that its queue is at a cap (§6.4, reason 4).
    ///
    /// Called only on a refusal, so the hot path never pays for it, and only
    /// when somebody is actually listening. The authoritative admission test is
    /// the one `f2z-relay-store` runs **inside** the append transaction; this
    /// re-runs the same arithmetic afterwards purely to decide whether the
    /// refusal was a quota refusal rather than an absent or unbound address.
    /// Being occasionally wrong about that race costs a hint, not a message:
    /// §13.2's rule is about ciphertext, and a push is not ciphertext.
    fn announce_quota(&self, send_addr: QueueAddress, auth: SendAuth, payload_bytes: u64) {
        let Ok(record) = self.store.queue_by_send(&send_addr, &auth) else {
            // Absent, unbound, wrong key, or the wrong kind of queue. All of
            // them are `ERR_UNAVAILABLE` to the writer and none of them is a
            // reader's business.
            return;
        };
        if record
            .quota
            .admit(record.stored_messages, record.stored_bytes, payload_bytes)
            .is_ok()
        {
            return;
        }
        if !self.subscriptions.has_subscriber(&record.recv_addr) {
            return;
        }
        self.subscriptions
            .notify_queue_event(record.recv_addr, QUEUE_EVENT_QUOTA, &self.metrics);
    }

    // ---------------------------------------------------------------------
    // Shared helpers.
    // ---------------------------------------------------------------------

    /// §13.1 layer 3's ceiling on how many queues may exist.
    ///
    /// Distinguishable (`ERR_QUOTA`, code 14) on purpose: unlike the send side,
    /// the party being refused here is the one that owns the queues, so telling
    /// it discloses nothing it does not already know.
    fn check_queue_ceiling(&self) -> Result<(), ProtoError> {
        let stats = self
            .store
            .stats()
            .map_err(|error| ProtoError::Wire(error.error_code()))?;
        let total = stats.queues.saturating_add(stats.contact_queues);
        if total >= self.config.limits.max_queues {
            return Err(ProtoError::Wire(ErrorCode::Quota));
        }
        Ok(())
    }

    fn check_creation_stamp(&self, now_ms: u64, stamp: &PowStamp) -> Result<(), ProtoError> {
        if !matches!(self.creation_mode, CreationMode::Pow) {
            return Ok(());
        }
        let params = self.published.capabilities().queue_creation_pow;
        self.check_stamp(now_ms, stamp, &params, ChallengePurpose::QueueCreate, &[])
    }

    fn check_stamp(
        &self,
        now_ms: u64,
        stamp: &PowStamp,
        params: &PowParams,
        purpose: ChallengePurpose,
        scope: &[u8],
    ) -> Result<(), ProtoError> {
        if !params.is_required() {
            return Ok(());
        }
        if stamp.is_empty() {
            Metrics::inc(&self.metrics.stamps_refused);
            return Err(ProtoError::Wire(ErrorCode::PowRequired));
        }
        // Verification is one hash, and §12.3 chose the function for exactly
        // that: the relay's own cost under flood is what must stay near zero.
        // Checked **before** the challenge is consumed, so a garbage flood
        // cannot burn the challenge table.
        if !stamp.meets_difficulty(params.difficulty_bits) {
            Metrics::inc(&self.metrics.stamps_refused);
            return Err(ProtoError::Wire(ErrorCode::PowInvalid));
        }
        let result =
            self.lock_challenges()
                .consume(&stamp.challenge, purpose.code(), scope, now_ms);
        if result.is_err() {
            Metrics::inc(&self.metrics.stamps_refused);
        }
        result
    }

    /// §5.1's verification, against **this connection's** transcript builder.
    ///
    /// There is deliberately no `verify(&Connection, …)` convenience wrapper
    /// beside this. A second function whose name begins with `verify` would be
    /// a second thing the workspace's strict-verification scan has to be told
    /// about (#612), for the sake of saving one field access at five call
    /// sites — and the field it saves is exactly the one that must not be
    /// wrong: a transcript builder from anywhere but this connection would bind
    /// the signature to another session's channel binding.
    fn verify_with<C: RelayCommand>(
        &self,
        transcripts: &TranscriptBuilder,
        now_ms: u64,
        request_id: u32,
        request: &Request,
        authorize: impl FnOnce(&Verified<C>) -> Result<(), ProtoError>,
    ) -> Result<Verified<C>, ProtoError> {
        // §5.5's seen-set is relay-wide, so it is taken out of the shared slot
        // for the duration of one verification and put back. A per-connection
        // seen-set would let a replay succeed simply by opening a second
        // connection.
        let mut seen = self.take_seen();
        let mut verifier = CommandVerifier::new(
            transcripts.clone(),
            TimestampWindow::new(u64::from(self.config.limits.clock_skew_ms)),
            seen,
            self.padding.clone(),
        );
        let outcome = verifier.verify_authorized::<C, _>(now_ms, request_id, request, authorize);
        seen = std::mem::replace(
            verifier.seen_set_mut(),
            SeenSet::new(
                u64::from(self.config.limits.antireplay_window_ms),
                usize::try_from(self.config.limits.antireplay_seen_max).unwrap_or(usize::MAX),
            ),
        );
        self.put_seen(seen);
        outcome
    }

    fn preauthorize_recv<C: RelayCommand>(
        &self,
        candidate: &Verified<C>,
    ) -> Result<(), ProtoError> {
        self.store
            .queue_by_recv(&candidate.address(), &candidate.signer_key())
            .map(|_| ())
            .map_err(|error| self.recv_error(&error))
    }

    fn preauthorize_send<C: RelayCommand>(
        &self,
        candidate: &Verified<C>,
    ) -> Result<(), ProtoError> {
        self.store
            .queue_by_send(
                &candidate.address(),
                &SendAuth::Signed(candidate.signer_key()),
            )
            .map(|_| ())
            .map_err(|error| send_error(&error))
    }

    fn accept_unsigned<C: RelayCommand>(
        &self,
        request: &Request,
    ) -> Result<Verified<C>, ProtoError> {
        // The seen-set is untouched by an unsigned command — there is no
        // `(signer_key, nonce)` to record — so a throwaway one is honest here
        // rather than a shortcut.
        let verifier = CommandVerifier::new(
            TranscriptBuilder::new(PROTOCOL_VERSION, self.relay_id, ChannelBinding::zero()),
            TimestampWindow::new(u64::from(self.config.limits.clock_skew_ms)),
            SeenSet::new(0, 0),
            self.padding.clone(),
        );
        verifier.accept_unsigned::<C>(request)
    }

    /// §10's existence-oracle rule, receive side.
    fn recv_error(&self, error: &StoreError) -> ProtoError {
        if matches!(error.error_code(), ErrorCode::NoAccess) {
            // "On the absent path, perform a dummy Ed25519 verification against
            // a fixed key so that the dominant CPU cost is present in both
            // paths", and do not short-circuit before it. The return value is
            // consumed so the call cannot be optimized away. §10 is explicit
            // that what remains — cache residency, page faults, index depth —
            // is a real residual timing channel, and this narrows it rather
            // than claiming to close it.
            if dummy_verify() {
                return ProtoError::Wire(ErrorCode::Internal);
            }
        }
        store_error(error)
    }

    fn take_seen(&self) -> SeenSet {
        let mut slot = self.lock_seen();
        std::mem::replace(
            &mut slot,
            SeenSet::new(
                u64::from(self.config.limits.antireplay_window_ms),
                usize::try_from(self.config.limits.antireplay_seen_max).unwrap_or(usize::MAX),
            ),
        )
    }

    fn put_seen(&self, seen: SeenSet) {
        *self.lock_seen() = seen;
    }

    fn lock_seen(&self) -> std::sync::MutexGuard<'_, SeenSet> {
        // A poisoned lock is not a reason to stop serving: the guarded value is
        // a bounded set whose worst case after a panic is a missing entry, and
        // refusing every later command would turn one fault into an outage of
        // `READ` and `ACK`, which §13.1 says must never be refused.
        self.seen
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn lock_challenges(&self) -> std::sync::MutexGuard<'_, Challenges> {
        self.challenges
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// A poisoned in-flight set is not a reason to drop a connection: the guarded
/// value is a set of `u32`, and the worst case after a panic is one stale id
/// occupying a slot in §4.3's window until the connection ends.
fn lock_inflight(inflight: &Mutex<BTreeSet<u32>>) -> std::sync::MutexGuard<'_, BTreeSet<u32>> {
    inflight
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// §6.3's collapse, send side, for a store refusal.
fn send_error(error: &StoreError) -> ProtoError {
    // The store already answers `ERR_UNAVAILABLE` for every send-side refusal
    // and `ERR_NOT_PERMITTED` for `BIND_SEND` on a contact address, which §12.2
    // deliberately does *not* collapse: a contact address is published in a
    // directory entry, so refusing it distinctly leaks no queue state its finder
    // did not already have.
    store_error(error)
}

fn store_error(error: &StoreError) -> ProtoError {
    ProtoError::Wire(error.error_code())
}

/// Recover a `request_id` from a frame whose body did not decode.
///
/// The frame header is fixed-width — one kind byte, then a big-endian `u32` —
/// so almost every malformed frame still carries a readable id and §1.3's "send
/// the response, then close" is satisfiable. `0` means it was not recoverable,
/// which [`Relay::fatal`] turns into a bare close.
fn recover_request_id(bytes: &[u8]) -> u32 {
    let Some(kind) = bytes.first() else {
        return 0;
    };
    // Only a request frame has a client-chosen id to answer on.
    if *kind != 1 {
        return 0;
    }
    bytes
        .get(1..5)
        .and_then(|slice| <[u8; 4]>::try_from(slice).ok())
        .map_or(0, u32::from_be_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_id_survives_a_body_that_does_not_decode() {
        let mut bytes = vec![1u8, 0, 0, 0, 9];
        bytes.extend_from_slice(&[0xff; 3]);
        assert_eq!(recover_request_id(&bytes), 9);
        assert_eq!(recover_request_id(&[]), 0);
        assert_eq!(recover_request_id(&[2, 0, 0, 0, 9]), 0);
        assert_eq!(recover_request_id(&[1, 0, 0]), 0);
    }

    #[test]
    fn a_text_frame_closes_with_the_status_section_4_2_names() {
        let outbound = Relay::handle_text();
        assert_eq!(outbound.len(), 1);
        assert!(
            outbound
                .first()
                .is_some_and(|frame| frame.message.is_none())
        );
        assert_eq!(
            outbound.first().and_then(|frame| frame.close_after),
            Some(CLOSE_UNSUPPORTED_DATA)
        );
    }
}
