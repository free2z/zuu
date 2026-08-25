//! The relay client — `WIRE.md` v1 over a real WebSocket.
//!
//! # Why this is here and not a crate, and what has to happen to it
//!
//! There is exactly one other relay client in this repository,
//! `f2z-relay-testkit::Client`, and its own module documentation says why this
//! file exists: *"This is not the client. ZUULI's engine and the WASM web
//! client are the clients, and neither of them will link this."* The testkit
//! carries a relay **server** and a fault injector, and linking it into a
//! shipping wallet would put a deliberately-breakable relay inside the binary.
//!
//! So this is ZUULI's client. It is **not** the right long-term home: ADR 0001
//! wants one Rust core shared by ZUULI and the browser, and a client living
//! inside a Tauri plugin cannot reach `wasm32-unknown-unknown`. The seam is
//! drawn accordingly — everything protocol-shaped is `f2z-relay-proto`'s and
//! `f2z-codec`'s, and what is decided here is only *transport and sequencing*:
//! how bytes reach a socket, how a response is correlated to a request, and how
//! a refusal becomes a `CLIENT-CONTRACT.md` §8 code. Lifting this into
//! `rs/crates/f2z-relay-client` is a move, not a rewrite, and the transport
//! trait below is where the WASM implementation would attach.
//!
//! # The client-side MUSTs it keeps, and where each one actually lives
//!
//! * **`relay_proof` is verified before any signed command exists** (§2.5,
//!   §5.2). Not code here: [`f2z_relay_proto::hello::verify_hello_response`],
//!   called during [`RelayConnection::connect`], and a [`RelaySession`] is
//!   unobtainable any other way.
//! * **Correlation is by `request_id`, never by arrival order** (§4.3), through
//!   `f2z-relay-proto`'s typed [`InFlight`] ticket.
//! * **Re-encode equality applies in both directions** (§3.3). Every inbound
//!   frame goes through `decode_canonical`, so a permissive decode is not
//!   reachable from here.
//! * **Padding to a published bucket before sending** (§9), rather than letting
//!   the relay tell us the size was wrong.
//! * **The relay's clock is learned and applied as an offset** (§5.5). This
//!   client never sets a system clock, and §8's `device-clock-skew` row says
//!   why: a relay that could move this device's clock could move the
//!   anti-replay window with it.
//! * **`ACK` is never called from here.** It is a method, but the *decision* is
//!   the engine's, taken only after the durable local write commits (§9 rule
//!   1). See [`RelayConnection::ack`]'s documentation.

use std::time::{Duration, Instant};

use f2z_codec::canonical::{Canonical as _, decode_canonical};
use f2z_codec::commands::{
    AckRequest, AckResponse, AppendRequest, BindSendRequest, ChallengePurpose, ChallengeRequest,
    ContactAppendRequest, CreateContactQueueRequest, CreateContactQueueResponse, CreateQueueRequest,
    CreateQueueResponse, HelloRequest, PushEvent, ReadRequest, ReadResponse, SignedCapabilities,
    SubscribeResponse,
};
use f2z_codec::frame::{FramePayload, Push, RelayFrame, Response};
use f2z_codec::padding::PaddingBuckets;
use f2z_codec::pow::{PowParams, PowStamp};
use f2z_codec::types::{ChannelBinding, Nonce, Payload, QueueAddress, RelayId, Salt};
use f2z_codec::{Challenge, PROTOCOL_VERSION};
use f2z_relay_proto::capabilities::ClientPolicy;
use f2z_relay_proto::command::{Empty, RelayCommand, SignedCommand, ops, unsigned_request};
use f2z_relay_proto::hello::{RelaySession, verify_hello_response};
use f2z_relay_proto::inflight::InFlight;
use f2z_relay_proto::key::SigningKey;
use futures_util::{SinkExt as _, StreamExt as _};
use rand::RngCore as _;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;

use crate::error::{Error, Result};
use crate::models::ErrorCode;
use crate::wire_codes::{BindAttempt, CommandSide, from_proto};

/// `WIRE.md` §2.1's path.
pub const RELAY_PATH: &str = "/relay/v1";
/// §2.1's mandatory subprotocol, in both directions. A relay that does not echo
/// it MUST be treated as not speaking this protocol, and the client MUST close
/// rather than guess.
pub const SUBPROTOCOL: &str = "free2z-relay.v1";

/// How long any single read waits.
///
/// Not a protocol value. §2.5 leaves a client with "unknown status" when a relay
/// stops answering, and this is how long we wait before deciding that is where
/// we are. Deliberately generous relative to the testkit's two seconds: a phone
/// on a bad network is not a misbehaving relay.
const READ_TIMEOUT: Duration = Duration::from_secs(20);

/// Per-relay connection settings.
#[derive(Clone)]
pub struct ConnectionPolicy {
    /// §11.3's checklist. The default **refuses** an insecure transport; a
    /// developer relay is reached only through `set_relay_trust` (§3.11), which
    /// is the one command whose grant is a security downgrade.
    pub policy: ClientPolicy,
    /// The `relay_id` an in-band advert named (§7.2), when there is one. A
    /// mismatch is fatal and is reported as a substitution, not a retry.
    pub expected_relay_id: Option<RelayId>,
    /// The TLS exporter value, or zeros under `channel_binding_mode: none`
    /// (§5.3).
    pub channel_binding: ChannelBinding,
    /// The sizes this client emits (§9). The relay's published set must be a
    /// superset.
    pub padding: PaddingBuckets,
}

// `ClientPolicy` and the channel binding both describe how much this client
// will tolerate, which is a thing worth reading in a log; the padding set is a
// public policy value. Nothing here is secret, but `PaddingBuckets` has no
// `Debug` obligation to us, so the derive is written out rather than assumed.
impl core::fmt::Debug for ConnectionPolicy {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("ConnectionPolicy")
            .field("expected_relay_id", &self.expected_relay_id)
            .field("channel_binding", &self.channel_binding)
            .finish_non_exhaustive()
    }
}

impl Default for ConnectionPolicy {
    fn default() -> Self {
        Self {
            // Every field at its strict default. §2.3 obligation 3 requires an
            // explicit per-relay opt-in for an insecure transport, and a
            // permissive default here would be that opt-in granted silently to
            // every relay at once.
            policy: ClientPolicy::default(),
            expected_relay_id: None,
            channel_binding: ChannelBinding::zero(),
            padding: PaddingBuckets::default(),
        }
    }
}

/// One open relay session.
///
/// Single-owner and `&mut`-driven on purpose. §4.3 lets responses arrive out of
/// order, and the correct way to handle that is one reader that correlates by
/// `request_id` — not several tasks racing on a socket. The engine drives this
/// from one place; see `engine::inbound` for why the receive path polls `READ`
/// rather than depending on `MSG` pushes arriving.
pub struct RelayConnection {
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    session: RelaySession,
    inflight: InFlight,
    next_request_id: u32,
    pushes: std::collections::VecDeque<Push>,
    padding: PaddingBuckets,
    relay_time_ms: u64,
    relay_time_taken: Instant,
    /// Set once the peer closes, so a caller stops trying.
    closed: bool,
}

impl core::fmt::Debug for RelayConnection {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("RelayConnection")
            .field("relay_id", &self.session.relay_id())
            .field("inflight", &self.inflight.len())
            .field("queued_pushes", &self.pushes.len())
            .field("closed", &self.closed)
            .finish_non_exhaustive()
    }
}

impl RelayConnection {
    /// Open a WebSocket, complete §2.5's steps 2 and 3, and verify the relay's
    /// proof of possession before any signed command can exist.
    ///
    /// # Errors
    ///
    /// `relay-unreachable` when the socket does not open;
    /// `relay-protocol-violation` when the relay does not echo the subprotocol;
    /// and whatever §11.3 or §5.2 refuses the relay with, notably
    /// `relay-identity-mismatch` and `relay-refused-insecure`.
    pub async fn connect(url: &str, policy: &ConnectionPolicy) -> Result<Self> {
        let mut request = url
            .into_client_request()
            .map_err(|error| Error::new(ErrorCode::RelayUnreachable, error.to_string()))?;
        request.headers_mut().insert(
            "sec-websocket-protocol",
            SUBPROTOCOL
                .parse()
                .map_err(|_| Error::internal("the subprotocol constant is not a header value"))?,
        );

        let (mut socket, response) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|error| Error::new(ErrorCode::RelayUnreachable, error.to_string()))?;

        // §2.1: a relay that does not echo `free2z-relay.v1` is not speaking
        // this protocol and the client MUST close rather than guess.
        let echoed = response
            .headers()
            .get("sec-websocket-protocol")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if echoed != SUBPROTOCOL {
            return Err(Error::new(
                ErrorCode::RelayProtocolViolation,
                format!("relay echoed subprotocol {echoed:?}, not {SUBPROTOCOL:?}"),
            ));
        }

        // The handshake runs on the bare socket, before this type exists, so
        // there is no moment at which a `RelayConnection` holds a session the
        // relay has not proved.
        let session = hello(&mut socket, policy).await?;
        let relay_time_ms = session.relay_time_ms();
        Ok(Self {
            socket,
            session,
            inflight: InFlight::default(),
            // 1 was `HELLO`'s. §4.3 only requires uniqueness among the
            // currently in-flight requests, but never reusing it keeps a
            // capture readable.
            next_request_id: 2,
            pushes: std::collections::VecDeque::new(),
            padding: policy.padding.clone(),
            relay_time_ms,
            relay_time_taken: Instant::now(),
            closed: false,
        })
    }

    /// The session opened by `HELLO`, and therefore the relay's proved identity.
    #[must_use]
    pub const fn session(&self) -> &RelaySession {
        &self.session
    }

    /// `relay_id = H("free2z/relay/v1/relay-id", relay_identity_pk)`, as proved.
    #[must_use]
    pub const fn relay_id(&self) -> RelayId {
        self.session.relay_id()
    }

    /// This client's estimate of the relay's clock (§5.5).
    ///
    /// An offset applied locally. The system clock is never written from it.
    #[must_use]
    pub fn relay_time_ms(&self) -> u64 {
        let elapsed = u64::try_from(self.relay_time_taken.elapsed().as_millis()).unwrap_or(0);
        self.relay_time_ms.saturating_add(elapsed)
    }

    /// Whether the peer has closed.
    #[must_use]
    pub const fn is_closed(&self) -> bool {
        self.closed
    }

    /// `GET_CAPABILITIES` (§6.1).
    ///
    /// # Errors
    ///
    /// As [`RelayConnection::call_unsigned`].
    pub async fn capabilities(&mut self) -> Result<SignedCapabilities> {
        self.call_unsigned::<ops::GetCapabilities>(&Empty).await
    }

    /// `CREATE_QUEUE` (§6.2), solving a stamp first when the relay demands one.
    ///
    /// # Errors
    ///
    /// As [`RelayConnection::call_signed`], plus anything `GET_CHALLENGE`
    /// returns.
    pub async fn create_queue(
        &mut self,
        recv_key: &SigningKey,
        message_ttl_seconds: u32,
        idle_ttl_seconds: u32,
        pow: Option<PowParams>,
    ) -> Result<CreateQueueResponse> {
        let stamp = self
            .stamp_for(ChallengePurpose::QueueCreate, &[], pow)
            .await?;
        let body = CreateQueueRequest {
            recv_key: recv_key.public_key(),
            req_message_ttl_seconds: message_ttl_seconds,
            req_idle_ttl_seconds: idle_ttl_seconds,
            flags: 0,
            stamp,
        };
        self.call_signed::<ops::CreateQueue>(recv_key, QueueAddress::zero(), &body, CommandSide::Receive, BindAttempt::Later)
            .await
    }

    /// `CREATE_CONTACT_QUEUE` (§12.2) — the queue a first-contact `Welcome`
    /// arrives on.
    ///
    /// # Errors
    ///
    /// As [`RelayConnection::create_queue`].
    pub async fn create_contact_queue(
        &mut self,
        recv_key: &SigningKey,
        message_ttl_seconds: u32,
        idle_ttl_seconds: u32,
        pow: Option<PowParams>,
    ) -> Result<CreateContactQueueResponse> {
        let stamp = self
            .stamp_for(ChallengePurpose::QueueCreate, &[], pow)
            .await?;
        let body = CreateContactQueueRequest {
            recv_key: recv_key.public_key(),
            req_message_ttl_seconds: message_ttl_seconds,
            req_idle_ttl_seconds: idle_ttl_seconds,
            stamp,
        };
        self.call_signed::<ops::CreateContactQueue>(recv_key, QueueAddress::zero(), &body, CommandSide::Receive, BindAttempt::Later)
            .await
    }

    /// `SUBSCRIBE` (§6.2).
    ///
    /// # Errors
    ///
    /// As [`RelayConnection::call_signed`].
    pub async fn subscribe(
        &mut self,
        recv_key: &SigningKey,
        recv_addr: QueueAddress,
    ) -> Result<SubscribeResponse> {
        self.call_signed::<ops::Subscribe>(recv_key, recv_addr, &Empty, CommandSide::Receive, BindAttempt::Later)
            .await
    }

    /// `READ` (§6.2). Never mutates: reading does not delete, and that
    /// asymmetry is the whole of §8.4.
    ///
    /// # Errors
    ///
    /// As [`RelayConnection::call_signed`].
    pub async fn read(
        &mut self,
        recv_key: &SigningKey,
        recv_addr: QueueAddress,
        from_index: u64,
        max_messages: u16,
        max_bytes: u32,
    ) -> Result<ReadResponse> {
        let body = ReadRequest {
            from_index,
            max_messages,
            max_bytes,
        };
        self.call_signed::<ops::Read>(recv_key, recv_addr, &body, CommandSide::Receive, BindAttempt::Later)
            .await
    }

    /// `ACK` (§6.2) — **the relay deletes its copy at this instant.**
    ///
    /// This function does not decide when to call it and must never be reached
    /// from a receive path directly. `CLIENT-CONTRACT.md` §9 rule 1: the
    /// durable local write completes first, or an ACK plus a crash is permanent
    /// message loss with no recovery from the relay, from the peer, or from the
    /// mnemonic. The wire protocol cannot enforce that and neither can this
    /// signature; `engine::inbound` is the one caller, and it calls this only
    /// after `f2z_msg_store`'s transaction has committed **and** the store
    /// reports `Durability::may_acknowledge()`.
    ///
    /// # Errors
    ///
    /// As [`RelayConnection::call_signed`].
    pub async fn ack(
        &mut self,
        recv_key: &SigningKey,
        recv_addr: QueueAddress,
        up_to_index: u64,
    ) -> Result<AckResponse> {
        let body = AckRequest { up_to_index };
        self.call_signed::<ops::Ack>(recv_key, recv_addr, &body, CommandSide::Receive, BindAttempt::Later)
            .await
    }

    /// `BIND_SEND` (§6.3). Once-only and irreversible.
    ///
    /// `attempt` is what turns `ERR_ALREADY_BOUND` into either
    /// `send-address-stolen` — a relay operator took the write capability, and
    /// that is fatal, loud and non-dismissible (§7.4) — or
    /// `relay-protocol-violation`, meaning we should not have tried. Pass
    /// [`BindAttempt::FirstForFreshAdvert`] only when the address really did
    /// come from an advert this client has not bound before.
    ///
    /// # Errors
    ///
    /// As [`RelayConnection::call_signed`].
    pub async fn bind_send(
        &mut self,
        send_key: &SigningKey,
        send_addr: QueueAddress,
        attempt: BindAttempt,
    ) -> Result<()> {
        let body = BindSendRequest {
            send_key: send_key.public_key(),
        };
        self.call_signed::<ops::BindSend>(send_key, send_addr, &body, CommandSide::Send, attempt)
            .await
            .map(|_: Empty| ())
    }

    /// `APPEND` (§6.3), padded to a published bucket first (§9).
    ///
    /// # Errors
    ///
    /// `relay-capability-mismatch` if the ciphertext is larger than the largest
    /// bucket — §9 says chunk it client-side, and chunking is the application's
    /// job. Otherwise as [`RelayConnection::call_signed`].
    pub async fn append(
        &mut self,
        send_key: &SigningKey,
        send_addr: QueueAddress,
        ciphertext: &[u8],
    ) -> Result<()> {
        let payload = self.pad(ciphertext)?;
        let body = AppendRequest { payload };
        self.call_signed::<ops::Append>(send_key, send_addr, &body, CommandSide::Send, BindAttempt::Later)
            .await
            .map(|_: Empty| ())
    }

    /// `CONTACT_APPEND` (§12.2), with a stamp scoped to `contact_addr`.
    ///
    /// This is the proof-of-work first contact pays. §12.4 is honest that it
    /// taxes phones far more than rented hardware and that no tuning fixes
    /// that; the UI's job is to show it as work rather than as a network wait.
    ///
    /// # Errors
    ///
    /// As [`RelayConnection::call_unsigned`], plus anything `GET_CHALLENGE`
    /// returns.
    pub async fn contact_append(
        &mut self,
        contact_addr: QueueAddress,
        ciphertext: &[u8],
        pow: Option<PowParams>,
    ) -> Result<()> {
        let payload = self.pad(ciphertext)?;
        let stamp = self
            .stamp_for(ChallengePurpose::ContactAppend, contact_addr.as_bytes(), pow)
            .await?;
        let body = ContactAppendRequest {
            contact_addr,
            payload,
            stamp,
        };
        self.call_unsigned::<ops::ContactAppend>(&body)
            .await
            .map(|_: Empty| ())
    }

    /// Any `MSG` push already queued, without waiting.
    ///
    /// Pushes are a *hint* that a queue moved, never the message path: §4.3
    /// lets them interleave with responses, and a client that treated them as
    /// the delivery mechanism would lose everything that arrived while it was
    /// disconnected. `engine::inbound` reads from an index either way.
    pub fn drain_pushes(&mut self) -> Vec<Push> {
        self.pushes.drain(..).collect()
    }

    /// Whether any queued push is a `MSG`, so the engine can read immediately
    /// rather than waiting for its next poll.
    #[must_use]
    pub fn has_message_push(&self) -> bool {
        self.pushes
            .iter()
            .any(|push| push.event() == Some(PushEvent::Msg))
    }

    /// Close the socket politely.
    pub async fn close(&mut self) {
        self.closed = true;
        let _ = self.socket.close(None).await;
    }

    /// Pad a ciphertext to the smallest published bucket that fits (§9).
    ///
    /// # Errors
    ///
    /// `relay-capability-mismatch` when nothing fits.
    fn pad(&self, ciphertext: &[u8]) -> Result<Payload> {
        let bucket = self.padding.bucket_for(ciphertext.len()).ok_or_else(|| {
            Error::new(
                ErrorCode::RelayCapabilityMismatch,
                format!(
                    "{} bytes exceeds the largest published padding bucket",
                    ciphertext.len()
                ),
            )
        })?;
        let mut bytes = ciphertext.to_vec();
        bytes.resize(usize::try_from(bucket).unwrap_or(ciphertext.len()), 0);
        Payload::new(bytes).map_err(|error| Error::internal(format!("padding: {error:?}")))
    }

    /// Issue a signed command and wait for its answer.
    ///
    /// # Errors
    ///
    /// The relay's §10 code translated through
    /// [`crate::wire_codes::from_relay`], or `relay-unreachable` when the
    /// transport fails.
    async fn call_signed<C: RelayCommand>(
        &mut self,
        key: &SigningKey,
        address: QueueAddress,
        body: &C::Request,
        side: CommandSide,
        attempt: BindAttempt,
    ) -> Result<C::Response> {
        let request_id = self.take_request_id();
        let ticket = self
            .inflight
            .issue::<C>(request_id)
            .map_err(|error| proto(error, side, attempt))?;
        // Both are taken before the `&self.session` borrow the builder needs.
        let timestamp = self.relay_time_ms();
        let nonce = self.nonce();
        let signed = SignedCommand::<C>::create(
            self.session.transcripts(),
            request_id,
            address,
            timestamp,
            nonce,
            key,
            body,
        )
        .map_err(|error| Error::internal(format!("building a signed command: {error:?}")))?;
        let frame = signed
            .frame()
            .map_err(|error| Error::internal(format!("framing a signed command: {error:?}")))?;
        self.send_frame(&frame).await?;
        let (frame_id, response) = self.await_response().await?;
        self.inflight
            .complete::<C>(ticket, frame_id, &response)
            .map_err(|error| proto(error, side, attempt))
    }

    /// Issue an unsigned command and wait for its answer.
    ///
    /// # Errors
    ///
    /// As [`RelayConnection::call_signed`].
    async fn call_unsigned<C: RelayCommand>(&mut self, body: &C::Request) -> Result<C::Response> {
        let request_id = self.take_request_id();
        let ticket = self
            .inflight
            .issue::<C>(request_id)
            .map_err(|error| proto(error, CommandSide::Receive, BindAttempt::Later))?;
        let frame = unsigned_request::<C>(request_id, body)
            .map_err(|error| Error::internal(format!("framing a command: {error:?}")))?;
        self.send_frame(&frame).await?;
        let (frame_id, response) = self.await_response().await?;
        self.inflight
            .complete::<C>(ticket, frame_id, &response)
            .map_err(|error| proto(error, CommandSide::Receive, BindAttempt::Later))
    }

    /// Obtain a challenge and solve a stamp, when and only when the relay's
    /// published parameters require one (§13.1).
    async fn stamp_for(
        &mut self,
        purpose: ChallengePurpose,
        scope: &[u8],
        pow: Option<PowParams>,
    ) -> Result<PowStamp> {
        let Some(params) = pow.filter(PowParams::is_required) else {
            return Ok(PowStamp::empty());
        };
        let body = ChallengeRequest {
            purpose: purpose.code(),
            scope: f2z_codec::types::ShortBytes::new(scope.to_vec())
                .map_err(|error| Error::internal(format!("challenge scope: {error:?}")))?,
        };
        let issued = self.call_unsigned::<ops::GetChallenge>(&body).await?;
        Ok(solve(issued.challenge, params.difficulty_bits))
    }

    fn take_request_id(&mut self) -> u32 {
        let id = self.next_request_id;
        // §4.3: nonzero, and unique among the currently in-flight requests.
        // Zero is the one value it may never take.
        self.next_request_id = self.next_request_id.checked_add(1).unwrap_or(1);
        id
    }

    fn nonce(&mut self) -> Nonce {
        let mut bytes = [0u8; 16];
        rand::rng().fill_bytes(&mut bytes);
        Nonce::from(bytes)
    }

    async fn send_frame(&mut self, frame: &RelayFrame) -> Result<()> {
        let bytes = frame
            .encode_canonical()
            .map_err(|error| Error::internal(format!("encoding a frame: {error:?}")))?;
        self.socket
            .send(Message::Binary(bytes.into()))
            .await
            .map_err(|error| {
                self.closed = true;
                Error::new(ErrorCode::RelayUnreachable, error.to_string())
            })
    }

    async fn await_response(&mut self) -> Result<(u32, Response)> {
        loop {
            let (request_id, payload) = self.read_frame().await?;
            match payload {
                FramePayload::Response(response) => return Ok((request_id, response)),
                // §4.3: a push may arrive between responses. Queue it rather
                // than treating it as the answer.
                FramePayload::Push(push) => self.pushes.push_back(push),
                FramePayload::Request(_) => {
                    return Err(Error::new(
                        ErrorCode::RelayProtocolViolation,
                        "a relay sent a request frame, which no relay may do",
                    ));
                }
            }
        }
    }

    async fn read_frame(&mut self) -> Result<(u32, FramePayload)> {
        loop {
            let message = match tokio::time::timeout(READ_TIMEOUT, self.socket.next()).await {
                Ok(Some(Ok(message))) => message,
                Ok(Some(Err(error))) => {
                    self.closed = true;
                    return Err(Error::new(ErrorCode::RelayUnreachable, error.to_string()));
                }
                Ok(None) => {
                    self.closed = true;
                    return Err(Error::new(ErrorCode::RelayUnreachable, "relay closed"));
                }
                Err(_) => {
                    return Err(Error::new(
                        ErrorCode::RelayUnreachable,
                        "the relay did not answer within the read timeout",
                    ));
                }
            };
            match message {
                Message::Binary(bytes) => {
                    // §3.3 applies in both directions. Skipping it here would
                    // make this the permissive decoder the rule exists to kill.
                    let frame = decode_canonical::<RelayFrame>(&bytes)
                        .map_err(|error| {
                            Error::new(
                                ErrorCode::RelayProtocolViolation,
                                format!("non-canonical frame from the relay: {error:?}"),
                            )
                        })?
                        .into_value();
                    frame.validate().map_err(|error| {
                        Error::new(
                            ErrorCode::RelayProtocolViolation,
                            format!("invalid frame from the relay: {error:?}"),
                        )
                    })?;
                    return Ok((frame.request_id, frame.payload));
                }
                // §2.4: the relay drives the keepalive because a browser cannot
                // send a Ping. tokio-tungstenite answers automatically, but
                // being explicit costs nothing and documents the rule.
                Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
                Message::Close(_) => {
                    self.closed = true;
                    return Err(Error::new(ErrorCode::RelayUnreachable, "relay closed"));
                }
                Message::Text(_) => {
                    return Err(Error::new(
                        ErrorCode::RelayProtocolViolation,
                        "the relay sent a text frame, which no relay may do",
                    ));
                }
            }
        }
    }
}

/// §13.1's stamp search: leading zero bits over BLAKE2b, chosen so verification
/// is a single hash.
///
/// Synchronous and unbounded on purpose. It is the reason `start_conversation`
/// can take seconds, and §3.3 tells the UI to show that as *work on this
/// device* rather than as a network wait. The caller runs it on a blocking task.
#[must_use]
pub fn solve(challenge: Challenge, difficulty_bits: u8) -> PowStamp {
    let mut salt_bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut salt_bytes);
    let mut stamp = PowStamp {
        challenge,
        salt: Salt::from(salt_bytes),
        counter: 0,
    };
    loop {
        if stamp.meets_difficulty(difficulty_bits) {
            return stamp;
        }
        stamp.counter = stamp.counter.wrapping_add(1);
    }
}

fn proto(error: f2z_relay_proto::ProtoError, side: CommandSide, attempt: BindAttempt) -> Error {
    Error::new(from_proto(error, side, attempt), format!("{error:?}"))
}

/// `HELLO` (§2.5 steps 2 and 3), run before a [`RelayConnection`] exists.
///
/// Written as a free function so there is no moment at which the connection
/// type holds a session the relay has not proved. A placeholder would be a hole
/// in exactly the property `f2z-relay-proto` exists to give: a [`RelaySession`]
/// is obtainable only by verifying `relay_proof`.
async fn hello(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    policy: &ConnectionPolicy,
) -> Result<RelaySession> {
    let mut client_nonce_bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut client_nonce_bytes);
    let offer = HelloRequest {
        min_version: PROTOCOL_VERSION,
        max_version: PROTOCOL_VERSION,
        client_nonce: Challenge::from(client_nonce_bytes),
    };

    let mut inflight = InFlight::default();
    let ticket = inflight
        .issue::<ops::Hello>(1)
        .map_err(|error| Error::internal(format!("issuing the HELLO ticket: {error:?}")))?;
    let frame = unsigned_request::<ops::Hello>(1, &offer)
        .map_err(|error| Error::internal(format!("framing HELLO: {error:?}")))?;
    let bytes = frame
        .encode_canonical()
        .map_err(|error| Error::internal(format!("encoding HELLO: {error:?}")))?;
    socket
        .send(Message::Binary(bytes.into()))
        .await
        .map_err(|error| Error::new(ErrorCode::RelayUnreachable, error.to_string()))?;

    let (request_id, response) = loop {
        let message = match tokio::time::timeout(READ_TIMEOUT, socket.next()).await {
            Ok(Some(Ok(message))) => message,
            Ok(Some(Err(error))) => {
                return Err(Error::new(ErrorCode::RelayUnreachable, error.to_string()));
            }
            Ok(None) => return Err(Error::new(ErrorCode::RelayUnreachable, "relay closed")),
            Err(_) => {
                return Err(Error::new(
                    ErrorCode::RelayUnreachable,
                    "the relay did not answer HELLO",
                ));
            }
        };
        match message {
            Message::Binary(bytes) => {
                let frame = decode_canonical::<RelayFrame>(&bytes)
                    .map_err(|error| {
                        Error::new(
                            ErrorCode::RelayProtocolViolation,
                            format!("non-canonical HELLO answer: {error:?}"),
                        )
                    })?
                    .into_value();
                frame.validate().map_err(|error| {
                    Error::new(
                        ErrorCode::RelayProtocolViolation,
                        format!("invalid HELLO answer: {error:?}"),
                    )
                })?;
                match frame.payload {
                    FramePayload::Response(response) => break (frame.request_id, response),
                    FramePayload::Push(_) | FramePayload::Request(_) => {
                        return Err(Error::new(
                            ErrorCode::RelayProtocolViolation,
                            "the relay answered HELLO with something that is not a response",
                        ));
                    }
                }
            }
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
            Message::Close(_) => return Err(Error::new(ErrorCode::RelayUnreachable, "relay closed")),
            Message::Text(_) => {
                return Err(Error::new(
                    ErrorCode::RelayProtocolViolation,
                    "the relay sent a text frame, which no relay may do",
                ));
            }
        }
    };

    let hello = inflight
        .complete::<ops::Hello>(ticket, request_id, &response)
        .map_err(|error| proto(error, CommandSide::Receive, BindAttempt::Later))?;

    // The MUST that everything else rests on.
    verify_hello_response(
        &hello,
        &offer,
        &policy.channel_binding,
        policy.expected_relay_id.as_ref(),
        &policy.policy,
    )
    .map_err(|error| proto(error, CommandSide::Receive, BindAttempt::Later))
}
