//! The relay itself: one frame in, zero or more frames out.
//!
//! This is the whole of `WIRE.md` that is not storage and not a socket, and it
//! is the *only* implementation in this crate. The in-process transport and the
//! real `ws://` listener both call [`Relay::handle_binary`]; if they did not,
//! the fake would be two fakes and the in-process one would be lying about the
//! other.
//!
//! # What is reused rather than rewritten
//!
//! Almost everything. `f2z-codec` owns re-encode equality (§3.3) and the
//! framing (§4); `f2z-relay-proto` owns the verification order of §5.1, the
//! anti-replay of §5.5, the queue rules of §7 and §8, and the capability
//! document of §11. A relay that re-derived any of those would be a second
//! opinion about the protocol, and the point of a conformance fake is that
//! there is only one.
//!
//! What is genuinely decided here is the part those crates deliberately leave
//! to a server: the order of the connection lifecycle (§2.5), the in-flight
//! window (§4.3), which code answers which refusal, when a push is emitted, and
//! the anti-abuse layering of §13.1.
//!
//! # The refusal codes, and the one rule behind most of them
//!
//! §6.3: **every send-side refusal that would distinguish queue state collapses
//! to `ERR_UNAVAILABLE`.** Absent, deleted, expired, full-by-messages,
//! full-by-bytes, unbound, wrong key, relay backpressure — one code. If they
//! differed, a bound sender could learn the queue's depth by filling it, which
//! is the escalation the two-address split exists to prevent. §10's table
//! assigns "absent" to code 10 and therefore contradicts §6.3; [#586] tracks
//! it, #583 resolved it in §6.3's favour, and this engine does the same.
//!
//! On the receive side the mirror rule is §10's existence-oracle rule: "no such
//! queue" and "exists, but your key does not authorize it" return the same code
//! 10, and the absent path performs a dummy Ed25519 verification first so the
//! dominant CPU cost is present in both. That narrowing is exactly what §10
//! says it is — a narrowing, not a closure.
//!
//! [#586]: https://github.com/free2z/zuu/issues/586

use std::collections::BTreeSet;
use std::sync::Mutex;

use f2z_codec::canonical::{Canonical, decode_canonical};
use f2z_codec::commands::{
    AckRequest, AckResponse, AppendRequest, CLAIM_KEY_PACKAGE_CHALLENGE_PURPOSE, Capabilities,
    ChallengePurpose, ChallengeRequest, ChallengeResponse, ClaimKeyPackageChallengeRequest,
    ClaimKeyPackageRequest, ClaimKeyPackageResponse, Command, ContactAppendRequest,
    CreateContactQueueRequest, CreateContactQueueResponse, CreateQueueRequest, CreateQueueResponse,
    HelloRequest, HelloResponse, PublishKeyPackagesRequest, PublishKeyPackagesResponse, PushEvent,
    ReadRequest, ReadResponse, SubscribeResponse,
};
use f2z_codec::frame::{FramePayload, RelayFrame, Request, Response};
use f2z_codec::padding::PaddingBuckets;
use f2z_codec::pow::{PowParams, PowStamp};
use f2z_codec::transcript::TranscriptBuilder;
use f2z_codec::types::{Digest, QueueAddress, RelayId};
use f2z_codec::{ErrorCode, PROTOCOL_VERSION};
use f2z_relay_proto::capabilities::{
    self, ChannelBindingMode, QueueCreationMode, TransportSecurity,
};
use f2z_relay_proto::command::{CommandVerifier, Empty, RelayCommand, Verified, ops};
use f2z_relay_proto::hello::{RelayAnnouncement, hello_response};
use f2z_relay_proto::key::{SigningKey, dummy_verify};
use f2z_relay_proto::queue::{AppendQuota, QueueKind, TtlPolicy};
use f2z_relay_proto::replay::{SeenSet, TimestampWindow};
use f2z_relay_proto::{ProtoError, capabilities::AntiReplayPersistence};
use tokio::sync::mpsc::UnboundedSender;

use crate::clock::Clock;
use crate::config::{ChannelBindingSource, RelayConfig};
use crate::error::{Result, TestkitError};
use crate::faults::{Effect, FaultInjector, PolicyFaults};
use crate::outbound::{
    CLOSE_PROTOCOL_ERROR, CLOSE_UNSUPPORTED_DATA, OutKind, Outbound, push as push_frame,
};
use crate::state::{NOTICE_CAPABILITIES_CHANGED, RelayState};

/// The default `antireplay_seen_max` of §5.5.
///
/// `WIRE.md` publishes the field but no default. 65 536 entries is about 3 MiB
/// of `(key, nonce)` pairs, which is a bound a test process will never reach by
/// accident and a fault can shrink deliberately.
pub const DEFAULT_SEEN_MAX: usize = 65_536;

/// One relay, shared by every connection it serves.
pub struct Relay {
    config: RelayConfig,
    identity: SigningKey,
    relay_id: RelayId,
    clock: Clock,
    faults: FaultInjector,
    padding: PaddingBuckets,
    ttl: TtlPolicy,
    state: Mutex<RelayState>,
}

impl std::fmt::Debug for Relay {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Relay")
            .field("relay_id", &self.relay_id)
            .field("armed_faults", &self.faults.armed())
            .finish_non_exhaustive()
    }
}

/// One connection's state.
///
/// §6.2: "a subscription is scoped to the connection and dies with it", and
/// §4.3's in-flight window is per connection too. Everything else a relay knows
/// is shared.
#[derive(Debug)]
pub struct Connection {
    /// Identifier, so a subscription can be found and dropped.
    pub id: u64,
    /// Whether `HELLO` has completed (§2.5 step 2).
    pub hello_done: bool,
    /// §4.3's outstanding `request_id`s.
    pub inflight: BTreeSet<u32>,
    /// The receive addresses this connection is subscribed to.
    pub subscriptions: BTreeSet<QueueAddress>,
    /// Where pushes go.
    pub pushes: UnboundedSender<Outbound>,
    /// The transcript builder for this connection: the relay's own `relay_id`
    /// and its own `channel_binding`, never the frame's (§5.2, §5.3).
    pub transcripts: TranscriptBuilder,
}

impl Relay {
    /// Build a relay from a configuration.
    ///
    /// # Errors
    ///
    /// [`TestkitError::Config`] if the configured capability document is not a
    /// valid one, if its padding set is malformed, or if it selects
    /// `queue_creation_mode: token`, which this crate does not implement — a
    /// bearer token is an operator-issued credential with no protocol shape in
    /// v1, and faking one would be inventing protocol rather than testing it.
    pub fn new(config: RelayConfig) -> Result<Self> {
        capabilities::validate(&config.capabilities)
            .map_err(|_| TestkitError::Config("the configured capability document is invalid"))?;
        config
            .key_package_policy
            .validate()
            .map_err(|_| TestkitError::Config("the configured key-package policy is invalid"))?;
        if config.key_package_policy.enabled != 0 && config.capabilities.contact_queues_enabled == 0
        {
            return Err(TestkitError::Config(
                "key packages require contact queues to provide their published address",
            ));
        }
        if config.capabilities.queue_creation_mode == QueueCreationMode::Token.code() {
            return Err(TestkitError::Config(
                "queue_creation_mode: token is not implemented; \
                 a bearer token has no protocol shape in WIRE.md v1",
            ));
        }
        // §2.3 obligations 1 and 2 are a pair. A document that claims TLS while
        // the process serves ws:// would be the one thing a client cannot
        // defend against.
        if config.capabilities.transport_security == TransportSecurity::Tls.code() {
            return Err(TestkitError::Config(
                "a FakeRelay serves ws://, so transport_security must be none (WIRE.md §2.3)",
            ));
        }
        if config.capabilities.channel_binding_mode != config.channel_binding.mode().code() {
            return Err(TestkitError::Config(
                "channel_binding_mode disagrees with the configured binding source",
            ));
        }

        let padding = config.padding()?;
        let identity = config.identity();
        let relay_id = f2z_codec::hash::relay_id(&identity.public_key());
        let ttl = capabilities::ttl_policy(&config.capabilities);
        let faults = FaultInjector::new();
        faults.set_policy(config.policy_faults);
        let clock = config.clock.clone();
        let seen = Self::seen_set(&config, config.policy_faults);
        let state = Mutex::new(RelayState::new(config.rng_seed, seen));
        Ok(Self {
            config,
            identity,
            relay_id,
            clock,
            faults,
            padding,
            ttl,
            state,
        })
    }

    fn seen_set(config: &RelayConfig, faults: PolicyFaults) -> SeenSet {
        let published = config.published_capabilities(faults);
        SeenSet::new(
            u64::from(published.antireplay_window_ms),
            faults.seen_set_max.unwrap_or(DEFAULT_SEEN_MAX),
        )
    }

    /// The relay's identity binding (§5.2).
    #[must_use]
    pub const fn relay_id(&self) -> RelayId {
        self.relay_id
    }

    /// The relay's long-term public key.
    #[must_use]
    pub fn identity_key(&self) -> f2z_codec::types::PublicKey {
        self.identity.public_key()
    }

    /// The relay's clock.
    #[must_use]
    pub const fn clock(&self) -> &Clock {
        &self.clock
    }

    /// The live fault handle.
    #[must_use]
    pub const fn faults(&self) -> &FaultInjector {
        &self.faults
    }

    /// The configuration this relay was built from.
    #[must_use]
    pub const fn config(&self) -> &RelayConfig {
        &self.config
    }

    /// The channel binding both ends use (§5.3).
    #[must_use]
    pub const fn channel_binding(&self) -> f2z_codec::types::ChannelBinding {
        self.config.channel_binding.value()
    }

    /// The document as it stands right now, with every policy fault applied.
    ///
    /// Recomputed rather than cached because a fault armed mid-connection is a
    /// policy change, and §6.4's `NOTICE(3)` exists precisely so a client can
    /// find out about one without polling.
    #[must_use]
    pub fn published_capabilities(&self) -> Capabilities {
        self.config.published_capabilities(self.faults.policy())
    }

    /// The signed document (§11.1).
    ///
    /// # Errors
    ///
    /// [`TestkitError::Config`] if the document cannot be signed, which needs
    /// an operator string longer than its length prefix.
    pub fn signed_capabilities(&self) -> Result<f2z_codec::commands::SignedCapabilities> {
        capabilities::sign(&self.identity, self.published_capabilities())
            .map_err(|_| TestkitError::Config("could not sign the capability document"))
    }

    /// `capabilities_digest` for `HELLO` (§6.1).
    ///
    /// # Errors
    ///
    /// As [`Relay::signed_capabilities`].
    pub fn capabilities_digest(&self) -> Result<Digest> {
        capabilities::digest(&self.published_capabilities())
            .map_err(|_| TestkitError::Config("could not digest the capability document"))
    }

    /// Announce a capability change to every subscribed connection — §6.4's
    /// `NOTICE(3)`.
    ///
    /// Arming a policy fault changes the document; calling this afterwards is
    /// what makes a client's re-fetch path reachable.
    pub fn announce_capability_change(&self) {
        let now = self.clock.now_ms();
        if let Ok(state) = self.state.lock() {
            state.notify_all(NOTICE_CAPABILITIES_CHANGED, now);
        }
    }

    /// Open a connection.
    pub fn open_connection(&self, pushes: UnboundedSender<Outbound>) -> Connection {
        let id = self
            .state
            .lock()
            .map_or(0, |mut state| state.next_connection_id());
        Connection {
            id,
            hello_done: false,
            inflight: BTreeSet::new(),
            subscriptions: BTreeSet::new(),
            pushes,
            transcripts: TranscriptBuilder::new(
                PROTOCOL_VERSION,
                self.relay_id,
                self.channel_binding(),
            ),
        }
    }

    /// Release a connection's subscriptions (§6.2).
    pub fn close_connection(&self, connection: &Connection) {
        if let Ok(mut state) = self.state.lock() {
            state.drop_connection(connection.id, &connection.subscriptions);
        }
    }

    /// Whether §13.1 layer 4's global backpressure is on.
    fn backpressured(&self) -> bool {
        self.faults.policy().global_backpressure
    }

    // ---------------------------------------------------------------------
    // The frame path.
    // ---------------------------------------------------------------------

    /// §4.2: a text frame is a fatal `ERR_FRAME_TYPE`, closed with status 1003.
    ///
    /// The relay MUST NOT attempt to decode it, MUST NOT attempt UTF-8
    /// validation beyond what the WebSocket layer already did, and MUST NOT
    /// treat it as an accidental binary frame. All three are the absence of
    /// code here.
    #[must_use]
    pub fn handle_text(&self) -> Vec<Outbound> {
        // A text frame carries no recoverable `request_id`, so there is no
        // response frame a conforming relay could build: §4.3 requires a
        // response's id to be nonzero. The connection closes with 1003, which
        // is what §4.2 actually names.
        vec![Outbound {
            bytes: Vec::new(),
            kind: OutKind::Response { effect: None },
            close_after: Some(CLOSE_UNSUPPORTED_DATA),
        }]
    }

    /// Handle one binary frame (§4.1).
    #[must_use]
    pub fn handle_binary(&self, connection: &mut Connection, bytes: &[u8]) -> Vec<Outbound> {
        let now = self.clock.now_ms();
        let published = self.published_capabilities();

        // §4.1: a frame exceeding `max_frame_bytes` is `ERR_MALFORMED`, fatal,
        // and the relay MUST NOT buffer the remainder to produce a tidy error.
        if bytes.len() > published.max_frame_bytes as usize {
            return self.fatal(recover_request_id(bytes), ErrorCode::Malformed);
        }

        // §3.3 on the frame. Decode, re-encode, byte-compare — and the
        // *re-encoded* bytes are what any signature covers.
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

        // §2.5 step 2: `HELLO` MUST be the first frame; a relay that receives
        // any other frame first responds `ERR_UNSUPPORTED_VERSION` and closes.
        let command = request.command();
        if !connection.hello_done && command != Some(Command::Hello) {
            return self.fatal(request_id, ErrorCode::UnsupportedVersion);
        }
        if connection.hello_done
            && command == Some(Command::Hello)
            && !self.config.relaxations.accept_repeated_hello
        {
            // §3.5: "version negotiation happens once, in HELLO, and applies to
            // the whole connection." A second HELLO is a renegotiation attempt
            // and gets the same code a version failure does. Listed as an
            // ambiguity call: §10 does not name this case.
            return self.fatal(request_id, ErrorCode::UnsupportedVersion);
        }

        // §4.3. A duplicate in-flight id is a fatal `ERR_MALFORMED`; exceeding
        // the window is a fatal `ERR_TOO_MANY_INFLIGHT`. Both bounds exist so a
        // single connection cannot make the relay allocate unbounded
        // per-request state before any quota check has run.
        if connection.inflight.contains(&request_id) {
            return self.fatal(request_id, ErrorCode::Malformed);
        }
        if connection.inflight.len() >= usize::from(published.max_inflight) {
            return self.fatal(request_id, ErrorCode::TooManyInflight);
        }
        connection.inflight.insert(request_id);

        // A fault may refuse the command outright. Consulted here, before any
        // state changes, so a refused APPEND really did not append.
        let outcome = match self.faults.take_refusal(command) {
            Some(code) => Err(ProtoError::Wire(code)),
            None => match command {
                Some(command) => self.dispatch(connection, now, request_id, command, request),
                // §3.5: an unknown command code is a *non-fatal*
                // `ERR_UNKNOWN_COMMAND`. The frame was well-formed framing, so
                // the connection survives.
                None => Err(ProtoError::Wire(ErrorCode::UnknownCommand)),
            },
        };

        let (response, fatal) = match outcome {
            Ok(body) => (
                Response::ok(body).unwrap_or_else(|_| Response::error(ErrorCode::Internal)),
                false,
            ),
            Err(error) => {
                let code = error.wire_code().unwrap_or(ErrorCode::Internal);
                (Response::error(code), code.is_fatal())
            }
        };

        // §4.3's window is released when the relay answers. A stalled response
        // is never answered, so its id stays outstanding — which is the whole
        // point of the fault: a client that never times out will fill the
        // window and earn a fatal `ERR_TOO_MANY_INFLIGHT`.
        let effect = self.faults.take_response_effect(command);
        if matches!(effect, Some(Effect::Stall)) {
            return Vec::new();
        }
        connection.inflight.remove(&request_id);

        let close = if fatal {
            Some(CLOSE_PROTOCOL_ERROR)
        } else {
            None
        };
        match Outbound::response(request_id, response, effect) {
            Some(mut outbound) => {
                outbound.close_after = close;
                vec![outbound]
            }
            None => self.fatal(request_id, ErrorCode::Internal),
        }
    }

    fn fatal(&self, request_id: u32, code: ErrorCode) -> Vec<Outbound> {
        // A frame whose `request_id` could not be recovered has no response a
        // conforming relay can build (§4.3 forbids a zero id on a response), so
        // the connection simply closes. Listed as an ambiguity call: §4.1 says
        // "send the error and close" and does not say what to send when the id
        // is unreadable.
        if request_id == 0 {
            return vec![Outbound {
                bytes: Vec::new(),
                kind: OutKind::Response { effect: None },
                close_after: Some(CLOSE_PROTOCOL_ERROR),
            }];
        }
        Outbound::fatal(request_id, code, CLOSE_PROTOCOL_ERROR)
            .map_or_else(Vec::new, |outbound| vec![outbound])
    }

    // ---------------------------------------------------------------------
    // Command dispatch.
    // ---------------------------------------------------------------------

    fn dispatch(
        &self,
        connection: &mut Connection,
        now: u64,
        request_id: u32,
        command: Command,
        request: &Request,
    ) -> std::result::Result<Vec<u8>, ProtoError> {
        match command {
            Command::Hello => self.hello(connection, request),
            Command::GetCapabilities => self.get_capabilities(request),
            Command::GetChallenge => self.get_challenge(now, request),
            Command::GetKeyPackagePolicy => self.get_key_package_policy(request),
            Command::GetClaimKeyPackageChallenge => {
                self.get_claim_key_package_challenge(now, request)
            }
            Command::Ping => self.ping(request),
            Command::CreateQueue => self.create_queue(connection, now, request_id, request),
            Command::CreateContactQueue => {
                self.create_contact_queue(connection, now, request_id, request)
            }
            Command::Subscribe => self.subscribe(connection, now, request_id, request),
            Command::Unsubscribe => self.unsubscribe(connection, now, request_id, request),
            Command::Read => self.read(connection, now, request_id, request),
            Command::Ack => self.ack(connection, now, request_id, request),
            Command::DeleteQueue => self.delete_queue(connection, now, request_id, request),
            Command::BindSend => self.bind_send(connection, now, request_id, request),
            Command::Append => self.append(connection, now, request_id, request),
            Command::ContactAppend => self.contact_append(now, request),
            Command::PublishKeyPackages => {
                self.publish_key_packages(connection, now, request_id, request)
            }
            Command::ClaimKeyPackage => self.claim_key_package(now, request),
            // `Command` is `#[non_exhaustive]`: a code added to f2z-codec but
            // not handled here is a hole in this relay, not in the client that
            // sent it. §3.5's non-fatal `ERR_UNKNOWN_COMMAND` is the honest
            // answer — this build genuinely does not implement it.
            _ => Err(ProtoError::Wire(ErrorCode::UnknownCommand)),
        }
    }

    // -- §6.1, unsigned ----------------------------------------------------

    fn hello(
        &self,
        connection: &mut Connection,
        request: &Request,
    ) -> std::result::Result<Vec<u8>, ProtoError> {
        let offer: HelloRequest = self.accept_unsigned::<ops::Hello>(request)?.into_body();
        if offer.min_version > offer.max_version
            || PROTOCOL_VERSION < offer.min_version
            || PROTOCOL_VERSION > offer.max_version
        {
            return Err(ProtoError::Wire(ErrorCode::UnsupportedVersion));
        }
        let digest = self
            .capabilities_digest()
            .map_err(|_| ProtoError::Wire(ErrorCode::Internal))?;
        let announcement = RelayAnnouncement {
            protocol_version: PROTOCOL_VERSION,
            relay_time_ms: self.clock.now_ms(),
            channel_binding_mode: match self.config.channel_binding {
                ChannelBindingSource::None => ChannelBindingMode::None,
                ChannelBindingSource::Simulated(_) => ChannelBindingMode::TlsExporter,
            },
            transport_security: TransportSecurity::None,
            capabilities_digest: digest,
        };
        let response: HelloResponse = hello_response(
            &self.identity,
            &announcement,
            &self.channel_binding(),
            &offer.client_nonce,
        );
        connection.hello_done = true;
        Ok(response.encode_canonical()?)
    }

    fn get_capabilities(&self, request: &Request) -> std::result::Result<Vec<u8>, ProtoError> {
        let _: Empty = self
            .accept_unsigned::<ops::GetCapabilities>(request)?
            .into_body();
        let signed = self
            .signed_capabilities()
            .map_err(|_| ProtoError::Wire(ErrorCode::Internal))?;
        Ok(signed.encode_canonical()?)
    }

    fn get_key_package_policy(
        &self,
        request: &Request,
    ) -> std::result::Result<Vec<u8>, ProtoError> {
        let _: Empty = self
            .accept_unsigned::<ops::GetKeyPackagePolicy>(request)?
            .into_body();
        let policy = self.config.key_package_policy;
        policy
            .validate()
            .map_err(|_| ProtoError::Wire(ErrorCode::Internal))?;
        Ok(policy.encode_canonical()?)
    }

    fn get_claim_key_package_challenge(
        &self,
        now: u64,
        request: &Request,
    ) -> std::result::Result<Vec<u8>, ProtoError> {
        let body: ClaimKeyPackageChallengeRequest = self
            .accept_unsigned::<ops::GetClaimKeyPackageChallenge>(request)?
            .into_body();
        let policy = self.config.key_package_policy;
        if policy.enabled == 0 {
            return Err(ProtoError::Wire(ErrorCode::NotPermitted));
        }
        let expires_at_ms = now.saturating_add(u64::from(policy.claim_pow.challenge_ttl_ms));
        let challenge = {
            let mut state = self.state()?;
            state.expire_challenges(now);
            state.issue_challenge(
                CLAIM_KEY_PACKAGE_CHALLENGE_PURPOSE,
                body.contact_addr.as_bytes(),
                expires_at_ms,
            )
        };
        Ok(ChallengeResponse {
            relay_time_ms: now,
            challenge,
            expires_at_ms,
            pow: policy.claim_pow,
        }
        .encode_canonical()?)
    }

    fn ping(&self, request: &Request) -> std::result::Result<Vec<u8>, ProtoError> {
        let _: Empty = self.accept_unsigned::<ops::Ping>(request)?.into_body();
        Ok(Vec::new())
    }

    fn get_challenge(
        &self,
        now: u64,
        request: &Request,
    ) -> std::result::Result<Vec<u8>, ProtoError> {
        let body: ChallengeRequest = self
            .accept_unsigned::<ops::GetChallenge>(request)?
            .into_body();
        // `purpose` is a raw byte so an unknown value round-trips through §3.3
        // rather than failing to decode. §10 has no code for "an enum value in
        // a body that this build does not know", so `ERR_MALFORMED` is the
        // reading here and it is listed as an ambiguity call.
        let purpose = body
            .purpose()
            .map_err(|_| ProtoError::Wire(ErrorCode::Malformed))?;
        let params = self.pow_params_for(purpose);
        let ttl = if params.challenge_ttl_ms == 0 {
            60_000
        } else {
            params.challenge_ttl_ms
        };
        let expires_at_ms = now.saturating_add(u64::from(ttl));

        let challenge = {
            let mut state = self.state()?;
            state.expire_challenges(now);
            state.issue_challenge(purpose.code(), body.scope.as_slice(), expires_at_ms)
        };

        let response = ChallengeResponse {
            relay_time_ms: now,
            challenge,
            expires_at_ms,
            pow: params,
        };
        Ok(response.encode_canonical()?)
    }

    fn pow_params_for(&self, purpose: ChallengePurpose) -> PowParams {
        let published = self.published_capabilities();
        match purpose {
            // §6.1: the field is zeroed when no PoW is required, and a clock
            // read never requires one.
            ChallengePurpose::Clock => PowParams::none(),
            ChallengePurpose::QueueCreate => published.queue_creation_pow,
            ChallengePurpose::ContactAppend => published.contact_append_pow,
        }
    }

    // -- §6.2, signed by the receive key -----------------------------------

    fn create_queue(
        &self,
        connection: &Connection,
        now: u64,
        request_id: u32,
        request: &Request,
    ) -> std::result::Result<Vec<u8>, ProtoError> {
        let verified =
            self.verify::<ops::CreateQueue>(connection, now, request_id, request, |_, _| Ok(()))?;
        let body: CreateQueueRequest = verified.into_body();

        // §13.1 layer 4, in the order the section states it: creation is the
        // first thing refused.
        if self.backpressured() {
            return Err(ProtoError::Wire(ErrorCode::Backpressure));
        }
        self.check_creation_stamp(now, &body.stamp)?;

        let published = self.published_capabilities();
        let message_ttl = self.ttl.grant_message_ttl(body.req_message_ttl_seconds);
        let idle_ttl = self.ttl.grant_idle_ttl(body.req_idle_ttl_seconds);
        let quota = AppendQuota {
            max_messages: u64::from(published.max_queue_messages),
            max_bytes: published.max_queue_bytes,
        };

        let mut state = self.state()?;
        if let Some(max) = self.faults.policy().max_queues
            && state.queue_count() >= max
        {
            // §10 code 14: a recv-side quota. Unlike the send side, the receive
            // side is allowed a distinguishable code — the party being refused
            // is the one that owns the queues.
            return Err(ProtoError::Wire(ErrorCode::Quota));
        }
        let (recv_addr, send_addr) = state.create_queue(
            QueueKind::Standard,
            body.recv_key,
            message_ttl,
            idle_ttl,
            quota,
            now,
        );
        drop(state);

        let response = CreateQueueResponse {
            recv_addr,
            send_addr,
            message_ttl_seconds: message_ttl,
            idle_ttl_seconds: idle_ttl,
            created_at_ms: now,
        };
        Ok(response.encode_canonical()?)
    }

    fn create_contact_queue(
        &self,
        connection: &Connection,
        now: u64,
        request_id: u32,
        request: &Request,
    ) -> std::result::Result<Vec<u8>, ProtoError> {
        let verified = self.verify::<ops::CreateContactQueue>(
            connection,
            now,
            request_id,
            request,
            |_, _| Ok(()),
        )?;
        let body: CreateContactQueueRequest = verified.into_body();

        let published = self.published_capabilities();
        if published.contact_queues_enabled == 0 {
            return Err(ProtoError::Wire(ErrorCode::NotPermitted));
        }
        if self.backpressured() {
            return Err(ProtoError::Wire(ErrorCode::Backpressure));
        }
        self.check_creation_stamp(now, &body.stamp)?;

        let message_ttl = self.ttl.grant_message_ttl(body.req_message_ttl_seconds);
        let idle_ttl = self.ttl.grant_idle_ttl(body.req_idle_ttl_seconds);
        // §12.3: a contact queue is hard-capped, because point 2 of §12.2 means
        // the whole internet may write to it.
        let quota = AppendQuota {
            max_messages: u64::from(published.contact_max_pending),
            max_bytes: published.contact_max_bytes,
        };

        let mut state = self.state()?;
        if let Some(max) = self.faults.policy().max_queues
            && state.queue_count() >= max
        {
            return Err(ProtoError::Wire(ErrorCode::Quota));
        }
        let (recv_addr, contact_addr) = state.create_queue(
            QueueKind::Contact,
            body.recv_key,
            message_ttl,
            idle_ttl,
            quota,
            now,
        );
        drop(state);

        let response = CreateContactQueueResponse {
            recv_addr,
            contact_addr,
            message_ttl_seconds: message_ttl,
            idle_ttl_seconds: idle_ttl,
            max_pending: published.contact_max_pending,
            max_bytes: published.contact_max_bytes,
        };
        Ok(response.encode_canonical()?)
    }

    fn subscribe(
        &self,
        connection: &mut Connection,
        now: u64,
        request_id: u32,
        request: &Request,
    ) -> std::result::Result<Vec<u8>, ProtoError> {
        let verified = self.verify::<ops::Subscribe>(
            connection,
            now,
            request_id,
            request,
            |state, candidate| self.preauthorize_recv(state, candidate),
        )?;
        let recv_addr = verified.address();
        let signer = verified.signer_key();

        let mut state = self.state()?;
        let Some(queue) = state.queue_by_recv(&recv_addr) else {
            return Err(self.absent_recv());
        };
        queue.state.authorize_recv(&signer)?;
        queue.touch(now);
        let next_index = queue.state.next_index();
        let pending = queue.pending();
        state.subscribe(recv_addr, connection.id, connection.pushes.clone());
        drop(state);
        connection.subscriptions.insert(recv_addr);

        let response = SubscribeResponse {
            next_index,
            pending,
        };
        Ok(response.encode_canonical()?)
    }

    fn unsubscribe(
        &self,
        connection: &mut Connection,
        now: u64,
        request_id: u32,
        request: &Request,
    ) -> std::result::Result<Vec<u8>, ProtoError> {
        let verified = self.verify::<ops::Unsubscribe>(
            connection,
            now,
            request_id,
            request,
            |state, candidate| self.preauthorize_recv(state, candidate),
        )?;
        let recv_addr = verified.address();
        let signer = verified.signer_key();

        let mut state = self.state()?;
        let Some(queue) = state.queue_by_recv(&recv_addr) else {
            return Err(self.absent_recv());
        };
        queue.state.authorize_recv(&signer)?;
        state.unsubscribe(&recv_addr, connection.id);
        drop(state);
        connection.subscriptions.remove(&recv_addr);
        Ok(Vec::new())
    }

    fn read(
        &self,
        connection: &Connection,
        now: u64,
        request_id: u32,
        request: &Request,
    ) -> std::result::Result<Vec<u8>, ProtoError> {
        let verified =
            self.verify::<ops::Read>(connection, now, request_id, request, |state, candidate| {
                self.preauthorize_recv(state, candidate)
            })?;
        let recv_addr = verified.address();
        let signer = verified.signer_key();
        let body: ReadRequest = verified.into_body();

        let mut state = self.state()?;
        let Some(queue) = state.queue_by_recv(&recv_addr) else {
            return Err(self.absent_recv());
        };
        queue.state.authorize_recv(&signer)?;
        // §13.1 layer 4: READ is never refused for backpressure. It is one of
        // the operations that make the relay smaller, and refusing it under
        // load is a deadlock.
        let Some((messages, has_more)) = state.read(
            &recv_addr,
            body.from_index,
            body.max_messages,
            body.max_bytes,
            now,
        ) else {
            return Err(self.absent_recv());
        };
        drop(state);

        let response = ReadResponse {
            messages: messages.into(),
            has_more: u8::from(has_more),
        };
        Ok(response.encode_canonical()?)
    }

    fn ack(
        &self,
        connection: &Connection,
        now: u64,
        request_id: u32,
        request: &Request,
    ) -> std::result::Result<Vec<u8>, ProtoError> {
        let verified =
            self.verify::<ops::Ack>(connection, now, request_id, request, |state, candidate| {
                self.preauthorize_recv(state, candidate)
            })?;
        let recv_addr = verified.address();
        let signer = verified.signer_key();
        let body: AckRequest = verified.into_body();

        let mut state = self.state()?;
        let Some(queue) = state.queue_by_recv(&recv_addr) else {
            return Err(self.absent_recv());
        };
        queue.state.authorize_recv(&signer)?;
        let (outcome, pending) = state.ack(&recv_addr, body.up_to_index, now)?;
        drop(state);

        let response = AckResponse {
            next_index: outcome.next_index,
            pending,
        };
        Ok(response.encode_canonical()?)
    }

    fn delete_queue(
        &self,
        connection: &mut Connection,
        now: u64,
        request_id: u32,
        request: &Request,
    ) -> std::result::Result<Vec<u8>, ProtoError> {
        let verified = self.verify::<ops::DeleteQueue>(
            connection,
            now,
            request_id,
            request,
            |state, candidate| self.preauthorize_recv(state, candidate),
        )?;
        let recv_addr = verified.address();
        let signer = verified.signer_key();

        let mut state = self.state()?;
        let Some(queue) = state.queue_by_recv(&recv_addr) else {
            return Err(self.absent_recv());
        };
        queue.state.authorize_recv(&signer)?;
        state.delete_queue(&recv_addr);
        drop(state);
        connection.subscriptions.remove(&recv_addr);
        Ok(Vec::new())
    }

    // -- §6.3, signed by the send key --------------------------------------

    fn bind_send(
        &self,
        connection: &Connection,
        now: u64,
        request_id: u32,
        request: &Request,
    ) -> std::result::Result<Vec<u8>, ProtoError> {
        let verified =
            self.verify::<ops::BindSend>(connection, now, request_id, request, |_, _| Ok(()))?;
        let send_addr = verified.address();
        let signer = verified.signer_key();

        let mut state = self.state()?;
        let Some(queue) = state.queue_by_second(&send_addr) else {
            return Err(self.absent_send());
        };
        // §7.3, and §7.4's consequence: the second bind is `ERR_ALREADY_BOUND`
        // with any key, including the same key. A client that gets this on a
        // first bind attempt for an address from a fresh advert must treat it
        // as a loud, non-dismissible failure — the relay operator may have read
        // `send_addr` out of its own database and bound first.
        queue.state.bind_send(&signer)?;
        queue.touch(now);
        Ok(Vec::new())
    }

    fn append(
        &self,
        connection: &Connection,
        now: u64,
        request_id: u32,
        request: &Request,
    ) -> std::result::Result<Vec<u8>, ProtoError> {
        let verified = self.verify::<ops::Append>(
            connection,
            now,
            request_id,
            request,
            |state, candidate| self.preauthorize_send(state, candidate),
        )?;
        let send_addr = verified.address();
        let signer = verified.signer_key();
        let body: AppendRequest = verified.into_body();

        // §13.1 layer 4 step 2: an append under backpressure is
        // `ERR_UNAVAILABLE`, never a code that says why.
        if self.backpressured() {
            return Err(ProtoError::Wire(ErrorCode::Unavailable));
        }

        let payload_len = u64::try_from(body.payload.len()).unwrap_or(u64::MAX);
        let mut state = self.state()?;
        let Some(queue) = state.queue_by_second(&send_addr) else {
            return Err(self.absent_send());
        };
        // A contact queue's second address takes `CONTACT_APPEND`, not
        // `APPEND`: its send side is never bound, so `authorize_send` refuses
        // it with the same `ERR_UNAVAILABLE` everything else on this side gets.
        queue.state.authorize_send(&signer)?;
        let recv_addr = queue.recv_addr;
        state.admit(&recv_addr, payload_len, self.faults.policy())?;
        state.append(&recv_addr, body.payload, now)?;
        drop(state);

        // §6.3: the response body is empty. No index, no depth, no timestamp,
        // no queue state of any kind.
        Ok(Vec::new())
    }

    // -- §12.2, contact queues ---------------------------------------------

    fn contact_append(
        &self,
        now: u64,
        request: &Request,
    ) -> std::result::Result<Vec<u8>, ProtoError> {
        let verified = self.accept_unsigned::<ops::ContactAppend>(request)?;
        let body: ContactAppendRequest = verified.into_body();

        if self.backpressured() {
            return Err(ProtoError::Wire(ErrorCode::Unavailable));
        }

        let published = self.published_capabilities();
        let params = published.contact_append_pow;
        let payload_len = u64::try_from(body.payload.len()).unwrap_or(u64::MAX);

        let mut state = self.state()?;
        let Some(queue) = state.queue_by_second(&body.contact_addr) else {
            return Err(self.absent_send());
        };
        if !matches!(queue.kind, QueueKind::Contact) {
            // An ordinary send address is not a contact address. Same collapse:
            // a stranger probing addresses learns nothing about which is which.
            return Err(ProtoError::Wire(ErrorCode::Unavailable));
        }
        let recv_addr = queue.recv_addr;

        // §12.3: the stamp is over a relay-issued, single-use, expiring
        // challenge **scoped to this contact address**, so stamps cannot be
        // precomputed in bulk, cannot be reused, and cannot be computed for one
        // victim and spent on another.
        self.check_stamp(
            &mut state,
            now,
            &body.stamp,
            &params,
            ChallengePurpose::ContactAppend.code(),
            body.contact_addr.as_bytes(),
        )?;

        state.admit(&recv_addr, payload_len, self.faults.policy())?;
        state.append(&recv_addr, body.payload, now)?;
        drop(state);
        Ok(Vec::new())
    }

    // -- §12.6, key packages -----------------------------------------------

    fn publish_key_packages(
        &self,
        connection: &Connection,
        now: u64,
        request_id: u32,
        request: &Request,
    ) -> std::result::Result<Vec<u8>, ProtoError> {
        // Ordinary receive-side authorization, and that is the whole design:
        // the capability that already means "I own this contact queue" is the
        // capability that means "I own this pool". No new key, no new address.
        let verified = self.verify::<ops::PublishKeyPackages>(
            connection,
            now,
            request_id,
            request,
            |state, candidate| self.preauthorize_recv(state, candidate),
        )?;
        let recv_addr = verified.address();
        let signer = verified.signer_key();
        let body: PublishKeyPackagesRequest = verified.into_body();
        body.validate()
            .map_err(|_| ProtoError::Wire(ErrorCode::Malformed))?;

        let policy = self.config.key_package_policy;
        if policy.enabled == 0 {
            return Err(ProtoError::Wire(ErrorCode::NotPermitted));
        }

        let mut state = self.state()?;
        let Some(queue) = state.queue_by_recv(&recv_addr) else {
            return Err(self.absent_recv());
        };
        queue.state.authorize_recv(&signer)?;
        if !matches!(queue.kind, QueueKind::Contact) {
            // §12.6 hangs the pool off the *published* address. A standard
            // queue has no published address, so there is nothing to key one
            // by. `ERR_NOT_PERMITTED` and not `ERR_NO_ACCESS`: the caller
            // proved it owns this queue, so nothing here is an oracle — this is
            // §10 code 20, "not valid for this queue kind", exactly as
            // `BIND_SEND` on a contact queue is.
            return Err(ProtoError::Wire(ErrorCode::NotPermitted));
        }

        let packages = body.packages.as_slice().to_vec();
        let last_resort = body.last_resort.as_slice().first().cloned();
        let (pool_size, has_last_resort) = state
            .publish_key_packages(&recv_addr, packages, last_resort, policy.max_pool_size, now)
            .ok_or(ProtoError::Wire(ErrorCode::Internal))?;
        drop(state);

        let response = PublishKeyPackagesResponse {
            pool_size,
            max_pool_size: policy.max_pool_size,
            has_last_resort: u8::from(has_last_resort),
        };
        Ok(response.encode_canonical()?)
    }

    fn claim_key_package(
        &self,
        now: u64,
        request: &Request,
    ) -> std::result::Result<Vec<u8>, ProtoError> {
        let verified = self.accept_unsigned::<ops::ClaimKeyPackage>(request)?;
        let body: ClaimKeyPackageRequest = verified.into_body();

        if self.backpressured() {
            return Err(ProtoError::Wire(ErrorCode::Unavailable));
        }

        let policy = self.config.key_package_policy;
        if policy.enabled == 0 {
            return Err(ProtoError::Wire(ErrorCode::NotPermitted));
        }
        let params = policy.claim_pow;

        let mut state = self.state()?;
        // The stamp is checked *before* the pool is consulted, so that the cost
        // of probing an address is paid whether or not anything is there. The
        // ordering is the same one §12.3 imposes on `CONTACT_APPEND` and it
        // matters more here: a claim that answered "no such address" cheaply
        // and "here you are" expensively would be a free existence oracle over
        // the published address space.
        self.check_stamp(
            &mut state,
            now,
            &body.stamp,
            &params,
            CLAIM_KEY_PACKAGE_CHALLENGE_PURPOSE,
            body.contact_addr.as_bytes(),
        )?;

        // Exhaustion, an absent address, and an address that is not a contact
        // address are one code — §10's existence-oracle rule, and §12.6's
        // exhaustion behaviour. **Not a panic, not an empty success**: a client
        // that received a zero-length package would have to decide what that
        // meant, and there is exactly one honest answer here.
        let Some((package, last_resort)) = state.claim_key_package(&body.contact_addr) else {
            return Err(ProtoError::Wire(ErrorCode::Unavailable));
        };
        drop(state);

        let response = ClaimKeyPackageResponse {
            key_package: package,
            last_resort: u8::from(last_resort),
        };
        Ok(response.encode_canonical()?)
    }

    // ---------------------------------------------------------------------
    // Shared helpers.
    // ---------------------------------------------------------------------

    fn state(&self) -> std::result::Result<std::sync::MutexGuard<'_, RelayState>, ProtoError> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| ProtoError::Wire(ErrorCode::Internal))?;
        let now = self.clock.now_ms();
        // §7.7's two timers are applied on every command rather than on a
        // timer task, so a test that moves the clock sees the consequence on
        // its very next request and never has to race a sweep.
        guard.expire(now, self.faults.policy());
        Ok(guard)
    }

    /// §10's existence-oracle rule, receive side.
    fn absent_recv(&self) -> ProtoError {
        // "On the absent path, perform a dummy Ed25519 verification against a
        // fixed key so that the dominant CPU cost is present in both paths",
        // and do not short-circuit before it. The return value is consumed so
        // the call cannot be optimized away.
        if dummy_verify() {
            return ProtoError::Wire(ErrorCode::Internal);
        }
        ProtoError::Wire(ErrorCode::NoAccess)
    }

    /// §6.3's collapse, send side.
    fn absent_send(&self) -> ProtoError {
        if dummy_verify() {
            return ProtoError::Wire(ErrorCode::Internal);
        }
        ProtoError::Wire(ErrorCode::Unavailable)
    }

    fn check_creation_stamp(
        &self,
        now: u64,
        stamp: &PowStamp,
    ) -> std::result::Result<(), ProtoError> {
        let published = self.published_capabilities();
        if published.queue_creation_mode != QueueCreationMode::Pow.code() {
            return Ok(());
        }
        let params = published.queue_creation_pow;
        let mut state = self.state()?;
        self.check_stamp(
            &mut state,
            now,
            stamp,
            &params,
            ChallengePurpose::QueueCreate.code(),
            &[],
        )
    }

    fn check_stamp(
        &self,
        state: &mut RelayState,
        now: u64,
        stamp: &PowStamp,
        params: &PowParams,
        purpose: u8,
        scope: &[u8],
    ) -> std::result::Result<(), ProtoError> {
        if !params.is_required() || self.config.relaxations.accept_missing_pow {
            return Ok(());
        }
        if stamp.is_empty() {
            return Err(ProtoError::Wire(ErrorCode::PowRequired));
        }
        // Verification is one hash, and §12.3 chose the function for exactly
        // that: the relay's own cost under flood is what must stay near zero.
        // Checked before the challenge is consumed so a garbage flood does not
        // burn the challenge table.
        if !stamp.meets_difficulty(params.difficulty_bits) {
            return Err(ProtoError::Wire(ErrorCode::PowInvalid));
        }
        state.consume_challenge(&stamp.challenge, purpose, scope, now)
    }

    fn window(&self) -> TimestampWindow {
        if self.config.relaxations.accept_any_timestamp {
            // A window wide enough that no timestamp is outside it. The
            // seen-set still runs, so a replay is still a replay.
            TimestampWindow::new(u64::MAX)
        } else {
            TimestampWindow::new(u64::from(self.published_capabilities().clock_skew_ms))
        }
    }

    fn verify<C: RelayCommand>(
        &self,
        connection: &Connection,
        now: u64,
        request_id: u32,
        request: &Request,
        authorize: impl FnOnce(&mut RelayState, &Verified<C>) -> std::result::Result<(), ProtoError>,
    ) -> std::result::Result<Verified<C>, ProtoError> {
        let padding = self.verifier_padding::<C>(request);
        let mut state = self
            .state
            .lock()
            .map_err(|_| ProtoError::Wire(ErrorCode::Internal))?;
        let seen = state.take_seen();
        let mut verifier =
            CommandVerifier::new(connection.transcripts.clone(), self.window(), seen, padding);
        let outcome = verifier.verify_authorized::<C, _>(now, request_id, request, |candidate| {
            authorize(&mut state, candidate)
        });
        let retention = verifier.seen_set().retention_ms();
        let max_entries = verifier.seen_set().max_entries();
        let seen = core::mem::replace(
            verifier.seen_set_mut(),
            SeenSet::new(retention, max_entries),
        );
        state.put_seen(seen);
        drop(state);
        outcome
    }

    fn preauthorize_recv<C: RelayCommand>(
        &self,
        state: &mut RelayState,
        candidate: &Verified<C>,
    ) -> std::result::Result<(), ProtoError> {
        let Some(queue) = state.queue_by_recv(&candidate.address()) else {
            return Err(self.absent_recv());
        };
        queue.state.authorize_recv(&candidate.signer_key())
    }

    fn preauthorize_send<C: RelayCommand>(
        &self,
        state: &mut RelayState,
        candidate: &Verified<C>,
    ) -> std::result::Result<(), ProtoError> {
        let Some(queue) = state.queue_by_second(&candidate.address()) else {
            return Err(self.absent_send());
        };
        queue.state.authorize_send(&candidate.signer_key())
    }

    fn accept_unsigned<C: RelayCommand>(
        &self,
        request: &Request,
    ) -> std::result::Result<Verified<C>, ProtoError> {
        let padding = self.verifier_padding::<C>(request);
        // The seen-set is untouched by an unsigned command — there is no
        // `(signer_key, nonce)` to record — so a throwaway one is honest here
        // rather than a shortcut.
        let verifier = CommandVerifier::new(
            TranscriptBuilder::new(PROTOCOL_VERSION, self.relay_id, self.channel_binding()),
            self.window(),
            SeenSet::new(0, 0),
            padding,
        );
        verifier.accept_unsigned::<C>(request)
    }

    /// The padding set the verifier enforces (§9).
    ///
    /// Normally the published set, exactly. Under
    /// [`Relaxations::accept_any_payload_size`] the payload's own length is
    /// merged in, which is the only way to suspend a rule whose enforcement
    /// lives inside a shared crate — and the reason that relaxation is opt-in
    /// and off by default.
    ///
    /// [`Relaxations::accept_any_payload_size`]: crate::config::Relaxations::accept_any_payload_size
    fn verifier_padding<C: RelayCommand>(&self, request: &Request) -> PaddingBuckets {
        if !self.config.relaxations.accept_any_payload_size {
            return self.padding.clone();
        }
        let Ok(body) = decode_canonical::<C::Request>(request.body()) else {
            return self.padding.clone();
        };
        let Some(payload) = C::payload(body.value()) else {
            return self.padding.clone();
        };
        let Ok(len) = u32::try_from(payload.len()) else {
            return self.padding.clone();
        };
        let mut sizes = self.padding.sizes().to_vec();
        if len > 0 && !sizes.contains(&len) {
            sizes.push(len);
            sizes.sort_unstable();
        }
        PaddingBuckets::new(sizes).unwrap_or_else(|_| self.padding.clone())
    }

    /// A `NOTICE` push built for the tests that want one (§6.4).
    #[must_use]
    pub fn notice(kind: u8, at_ms: u64) -> Option<Outbound> {
        push_frame(
            PushEvent::Notice,
            &f2z_codec::commands::NoticePush { kind, at_ms },
        )
    }

    /// Whether the published document declares a durable seen-set (§5.5).
    #[must_use]
    pub fn antireplay_is_durable(&self) -> bool {
        self.published_capabilities().antireplay_persistence
            == AntiReplayPersistence::Durable.code()
    }
}

/// Recover a `request_id` from a frame whose body did not decode.
///
/// The frame header is fixed-width — one kind byte, then a big-endian `u32` —
/// so almost every malformed frame still carries a readable id, and §1.3's
/// "send the response, then close" is satisfiable. `0` means it was not
/// recoverable, which [`Relay::fatal`] turns into a bare close.
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
    fn token_mode_is_refused_at_construction_rather_than_faked() {
        let mut config = RelayConfig::default();
        config.capabilities.queue_creation_mode = QueueCreationMode::Token.code();
        assert!(Relay::new(config).is_err());
    }

    #[test]
    fn a_document_claiming_tls_is_refused() {
        let mut config = RelayConfig::default();
        config.capabilities.transport_security = TransportSecurity::Tls.code();
        assert!(Relay::new(config).is_err());
    }

    #[test]
    fn the_relay_id_is_the_digest_of_the_identity_key() {
        let relay = Relay::new(RelayConfig::default()).unwrap();
        assert_eq!(
            relay.relay_id(),
            f2z_codec::hash::relay_id(&relay.identity_key())
        );
        let published = relay.published_capabilities();
        assert_eq!(published.relay_id, relay.relay_id());
    }
}
