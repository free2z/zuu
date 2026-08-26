//! A client, so the fake has something to be exercised by.
//!
//! This is not the client. ZUULI's engine and the WASM web client are the
//! clients, and neither of them will link this. What this is: the smallest
//! thing that can drive every command of §6 correctly, so that a conformance
//! vector is a statement about the *relay* rather than about a test's ability
//! to build a frame.
//!
//! It does obey the client-side MUSTs, though, and deliberately:
//!
//! - It verifies `relay_proof` before sending any signed command, and compares
//!   `relay_id` against an expected value when it has one (§2.5, §5.2). Those
//!   are `f2z-relay-proto::hello::verify_hello_response`, not code here.
//! - It correlates strictly by `request_id` and never by arrival order, through
//!   `f2z-relay-proto::inflight`'s typed ticket (§4.3).
//! - It pads to a bucket before sending (§9) rather than relying on the relay
//!   to tell it the size was wrong.
//! - It re-reads the relay's clock rather than assuming its own (§5.5), and
//!   never sets a system clock from it — there is no system clock here to set.
//!
//! Everything a vector needs to *break* on purpose is also here — a raw frame,
//! a text frame, a chosen timestamp, a reused nonce — because a conformance
//! suite that can only send valid frames tests half a protocol.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use f2z_codec::canonical::{Canonical, decode_canonical};
use f2z_codec::commands::{
    AckRequest, AckResponse, AppendRequest, BindSendRequest, ChallengePurpose, ChallengeRequest,
    ChallengeResponse, ClaimKeyPackageRequest, ClaimKeyPackageResponse, ContactAppendRequest,
    CreateContactQueueRequest, CreateContactQueueResponse, CreateQueueRequest, CreateQueueResponse,
    HelloRequest, PublishKeyPackagesRequest, PublishKeyPackagesResponse, PushEvent, ReadRequest,
    ReadResponse, SignedCapabilities, SubscribeResponse,
};
use f2z_codec::frame::Push;
use f2z_codec::frame::{FramePayload, RelayFrame, Response};
use f2z_codec::padding::PaddingBuckets;
use f2z_codec::pow::{PowParams, PowStamp};
use f2z_codec::types::{
    Challenge, ChannelBinding, KeyPackage, Nonce, Payload, QueueAddress, RelayId, ShortBytes,
};
use f2z_codec::{ErrorCode, PROTOCOL_VERSION};
use f2z_relay_proto::ProtoError;
use f2z_relay_proto::capabilities::ClientPolicy;
use f2z_relay_proto::command::{Empty, RelayCommand, SignedCommand, ops, unsigned_request};
use f2z_relay_proto::hello::{RelaySession, verify_hello_response};
use f2z_relay_proto::inflight::InFlight;
use f2z_relay_proto::key::SigningKey;

use crate::error::{Result, TestkitError};
use crate::rng::Csprng;
use crate::transport::{Transport, TransportSink, TransportStream, WireMessage};

/// How a client is set up before it says `HELLO`.
#[derive(Clone)]
pub struct ClientConfig {
    /// §11.3's checklist, as a policy. Defaults here allow the insecure
    /// transport a `FakeRelay` publishes, because refusing it is the *correct*
    /// default and a harness that could not opt in could not test anything.
    pub policy: ClientPolicy,
    /// The `relay_id` an in-band advert named (§7.2), when there is one. A
    /// mismatch is fatal and is reported as a substitution.
    pub expected_relay_id: Option<RelayId>,
    /// The value this client computed from its own TLS state — zeros when the
    /// relay published `channel_binding_mode: none` (§5.3).
    pub channel_binding: ChannelBinding,
    /// The nonce stream. Deterministic, so a failing vector replays.
    pub nonce_seed: [u8; 32],
    /// How long any single read waits before giving up. Not a protocol value:
    /// a timeout is a decision about a test, and §2.5's "unknown status" is
    /// what a real client is left with.
    pub read_timeout: Duration,
    /// The sizes this client pads to (§9). The relay's published set MUST be a
    /// superset.
    pub padding: PaddingBuckets,
}

// `nonce_seed` decides every nonce this client will ever present, and a nonce
// is half of §5.5's replay key. A derived `Debug` would print it as a decimal
// byte dump.
impl std::fmt::Debug for ClientConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClientConfig")
            .field("expected_relay_id", &self.expected_relay_id)
            .field("channel_binding", &self.channel_binding)
            .field("nonce_seed", &"<redacted>")
            .field("read_timeout", &self.read_timeout)
            .field("padding", &self.padding)
            .finish_non_exhaustive()
    }
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            policy: ClientPolicy {
                // §2.3 obligation 3: an explicit, per-relay opt-in. A test
                // harness pointing at a `ws://` fake is exactly the case the
                // obligation contemplates, and saying so here is the opt-in.
                allow_insecure_transport: true,
                ..ClientPolicy::default()
            },
            expected_relay_id: None,
            channel_binding: ChannelBinding::zero(),
            nonce_seed: *b"f2z-relay-testkit/client-nonces!",
            read_timeout: Duration::from_secs(2),
            padding: PaddingBuckets::default(),
        }
    }
}

/// A connected client.
pub struct Client {
    sink: Box<dyn TransportSink>,
    stream: Box<dyn TransportStream>,
    session: RelaySession,
    inflight: InFlight,
    rng: Csprng,
    next_request_id: u32,
    pushes: VecDeque<Push>,
    read_timeout: Duration,
    padding: PaddingBuckets,
    opened: Instant,
    /// Relay time at the last synchronisation, and the local instant it was
    /// taken. §5.5: a client with an unreliable clock learns the relay's time
    /// and applies the offset locally — it MUST NOT set its system clock.
    relay_time_ms: u64,
    relay_time_taken: Instant,
    /// A deliberate override, for the vectors that need a stale timestamp.
    timestamp_override: Option<u64>,
    closed: bool,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client")
            .field("relay_id", &self.session.relay_id())
            .field("inflight", &self.inflight.len())
            .field("queued_pushes", &self.pushes.len())
            .finish_non_exhaustive()
    }
}

impl Client {
    /// Complete §2.5's steps 2 and 3 and open a session.
    ///
    /// # Errors
    ///
    /// [`TestkitError::Protocol`] carrying a `Refusal` when the relay fails one
    /// of §2.5's or §11.3's checks; [`TestkitError::Transport`] or
    /// [`TestkitError::Timeout`] when it does not answer.
    pub async fn connect(transport: Transport, config: ClientConfig) -> Result<Self> {
        let (mut sink, mut stream) = transport.split();
        let mut rng = Csprng::from_seed(config.nonce_seed);
        let client_nonce = rng.next_challenge();
        let offer = HelloRequest {
            min_version: PROTOCOL_VERSION,
            max_version: PROTOCOL_VERSION,
            client_nonce,
        };

        // `HELLO` is exchanged before a `Client` exists, so there is no moment
        // at which this type holds a session the relay has not proved. A
        // placeholder would have been a hole in exactly the property
        // `f2z-relay-proto` exists to give: a `RelaySession` is obtainable only
        // by verifying `relay_proof`.
        let mut inflight = InFlight::default();
        let ticket = inflight.issue::<ops::Hello>(1)?;
        let frame = unsigned_request::<ops::Hello>(1, &offer)?;
        sink.send(WireMessage::Binary(frame.encode_canonical()?))
            .await?;
        let (request_id, response) =
            await_hello(&mut sink, &mut stream, config.read_timeout).await?;
        let hello = inflight.complete::<ops::Hello>(ticket, request_id, &response)?;

        // The MUST that everything else rests on: verify the proof of
        // possession, recompute `relay_id`, and compare it against the advert
        // *before* any signed command exists.
        let session = verify_hello_response(
            &hello,
            &offer,
            &config.channel_binding,
            config.expected_relay_id.as_ref(),
            &config.policy,
        )?;

        let relay_time_ms = session.relay_time_ms();
        Ok(Self {
            sink,
            stream,
            session,
            inflight,
            rng,
            next_request_id: 2,
            pushes: VecDeque::new(),
            read_timeout: config.read_timeout,
            padding: config.padding.clone(),
            opened: Instant::now(),
            relay_time_ms,
            relay_time_taken: Instant::now(),
            timestamp_override: None,
            closed: false,
        })
    }

    /// The session opened by `HELLO`.
    #[must_use]
    pub const fn session(&self) -> &RelaySession {
        &self.session
    }

    /// The relay's identity binding, as proved in `HELLO`.
    #[must_use]
    pub const fn relay_id(&self) -> RelayId {
        self.session.relay_id()
    }

    /// How long this connection has been open. Only useful for diagnostics.
    #[must_use]
    pub fn age(&self) -> Duration {
        self.opened.elapsed()
    }

    /// The client's current estimate of the relay's clock (§5.5).
    #[must_use]
    pub fn relay_time_ms(&self) -> u64 {
        if let Some(override_ms) = self.timestamp_override {
            return override_ms;
        }
        let elapsed = u64::try_from(self.relay_time_taken.elapsed().as_millis()).unwrap_or(0);
        self.relay_time_ms.saturating_add(elapsed)
    }

    /// Force every subsequent signed command to carry this `timestamp_ms`.
    ///
    /// The only way to reach `ERR_STALE_TIMESTAMP` deliberately, and the only
    /// way to build the two frames a replay test needs.
    pub const fn set_timestamp(&mut self, timestamp_ms: Option<u64>) {
        self.timestamp_override = timestamp_ms;
    }

    /// Re-read the relay's clock (§5.5's `GET_CHALLENGE(clock)`).
    ///
    /// A test that moves a frozen relay clock must call this, exactly as a
    /// client whose device slept must.
    ///
    /// # Errors
    ///
    /// As [`Client::challenge`].
    pub async fn resync_clock(&mut self) -> Result<()> {
        let response = self.challenge(ChallengePurpose::Clock, &[]).await?;
        self.relay_time_ms = response.relay_time_ms;
        self.relay_time_taken = Instant::now();
        Ok(())
    }

    /// The padding buckets this client emits to (§9).
    #[must_use]
    pub const fn padding(&self) -> &PaddingBuckets {
        &self.padding
    }

    /// How long a single read waits. A vector that expects *nothing* to arrive
    /// shortens this: waiting the full default to prove a negative is how a
    /// suite becomes too slow to run.
    pub const fn set_read_timeout(&mut self, timeout: Duration) {
        self.read_timeout = timeout;
    }

    /// A fresh nonce from this client's deterministic stream.
    pub fn nonce(&mut self) -> Nonce {
        Nonce::new(self.rng.next_bytes::<16>())
    }

    // -- the command surface ----------------------------------------------

    /// `GET_CAPABILITIES` (§6.1).
    ///
    /// # Errors
    ///
    /// As [`Client::call_unsigned`].
    pub async fn capabilities(&mut self) -> Result<SignedCapabilities> {
        self.call_unsigned::<ops::GetCapabilities>(&Empty).await
    }

    /// `GET_CHALLENGE` (§6.1).
    ///
    /// # Errors
    ///
    /// As [`Client::call_unsigned`].
    pub async fn challenge(
        &mut self,
        purpose: ChallengePurpose,
        scope: &[u8],
    ) -> Result<ChallengeResponse> {
        let body = ChallengeRequest {
            purpose: purpose.code(),
            scope: ShortBytes::new(scope.to_vec())?,
        };
        self.call_unsigned::<ops::GetChallenge>(&body).await
    }

    /// `PING` (§6.1) — the application-level probe, distinct from §2.4's
    /// WebSocket Ping, which a browser cannot send.
    ///
    /// # Errors
    ///
    /// As [`Client::call_unsigned`].
    pub async fn ping(&mut self) -> Result<()> {
        self.call_unsigned::<ops::Ping>(&Empty).await.map(|_| ())
    }

    /// `CREATE_QUEUE` (§6.2), solving a stamp first if the relay demands one.
    ///
    /// # Errors
    ///
    /// As [`Client::call_signed`], plus anything `GET_CHALLENGE` returns.
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
        self.call_signed::<ops::CreateQueue>(recv_key, QueueAddress::zero(), &body)
            .await
    }

    /// `CREATE_CONTACT_QUEUE` (§12.2).
    ///
    /// # Errors
    ///
    /// As [`Client::create_queue`].
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
        self.call_signed::<ops::CreateContactQueue>(recv_key, QueueAddress::zero(), &body)
            .await
    }

    /// `SUBSCRIBE` (§6.2).
    ///
    /// # Errors
    ///
    /// As [`Client::call_signed`].
    pub async fn subscribe(
        &mut self,
        recv_key: &SigningKey,
        recv_addr: QueueAddress,
    ) -> Result<SubscribeResponse> {
        self.call_signed::<ops::Subscribe>(recv_key, recv_addr, &Empty)
            .await
    }

    /// `UNSUBSCRIBE` (§6.2).
    ///
    /// # Errors
    ///
    /// As [`Client::call_signed`].
    pub async fn unsubscribe(
        &mut self,
        recv_key: &SigningKey,
        recv_addr: QueueAddress,
    ) -> Result<()> {
        self.call_signed::<ops::Unsubscribe>(recv_key, recv_addr, &Empty)
            .await
            .map(|_| ())
    }

    /// `READ` (§6.2). Never mutates.
    ///
    /// # Errors
    ///
    /// As [`Client::call_signed`].
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
        self.call_signed::<ops::Read>(recv_key, recv_addr, &body)
            .await
    }

    /// `ACK` (§6.2).
    ///
    /// **A real client MUST NOT call this before its durable local write has
    /// completed.** ACK-on-read plus a crash is permanent message loss, because
    /// the relay has already deleted the only copy (§8.4, `CLIENT-CONTRACT.md`
    /// §9 rule 1). The wire protocol cannot enforce it and neither can this
    /// function; it is restated here because this is where an implementer's
    /// cursor will be.
    ///
    /// # Errors
    ///
    /// As [`Client::call_signed`].
    pub async fn ack(
        &mut self,
        recv_key: &SigningKey,
        recv_addr: QueueAddress,
        up_to_index: u64,
    ) -> Result<AckResponse> {
        let body = AckRequest { up_to_index };
        self.call_signed::<ops::Ack>(recv_key, recv_addr, &body)
            .await
    }

    /// `DELETE_QUEUE` (§6.2). Irreversible.
    ///
    /// # Errors
    ///
    /// As [`Client::call_signed`].
    pub async fn delete_queue(
        &mut self,
        recv_key: &SigningKey,
        recv_addr: QueueAddress,
    ) -> Result<()> {
        self.call_signed::<ops::DeleteQueue>(recv_key, recv_addr, &Empty)
            .await
            .map(|_| ())
    }

    /// `BIND_SEND` (§6.3). Once-only and irreversible.
    ///
    /// `ERR_ALREADY_BOUND` on a first attempt for an address from a fresh
    /// advert is a loud, non-dismissible failure (§7.4), not a retry.
    ///
    /// # Errors
    ///
    /// As [`Client::call_signed`].
    pub async fn bind_send(
        &mut self,
        send_key: &SigningKey,
        send_addr: QueueAddress,
    ) -> Result<()> {
        let body = BindSendRequest {
            send_key: send_key.public_key(),
        };
        self.call_signed::<ops::BindSend>(send_key, send_addr, &body)
            .await
            .map(|_| ())
    }

    /// `APPEND` (§6.3), padded to a bucket first.
    ///
    /// # Errors
    ///
    /// [`TestkitError::Config`] if the plaintext is larger than the largest
    /// bucket — §9 says chunk it client-side, and chunking is the application's
    /// job, not this one's. Otherwise as [`Client::call_signed`].
    pub async fn append(
        &mut self,
        send_key: &SigningKey,
        send_addr: QueueAddress,
        plaintext: &[u8],
    ) -> Result<()> {
        let payload = self.pad(plaintext)?;
        let body = AppendRequest { payload };
        self.call_signed::<ops::Append>(send_key, send_addr, &body)
            .await
            .map(|_| ())
    }

    /// `APPEND` with a payload of exactly this length, bucket or not.
    ///
    /// # Errors
    ///
    /// As [`Client::call_signed`]. `ERR_BAD_SIZE` when the length is not a
    /// published bucket, which is the point.
    pub async fn append_raw_size(
        &mut self,
        send_key: &SigningKey,
        send_addr: QueueAddress,
        len: usize,
    ) -> Result<()> {
        let body = AppendRequest {
            payload: Payload::new(vec![0u8; len])?,
        };
        self.call_signed::<ops::Append>(send_key, send_addr, &body)
            .await
            .map(|_| ())
    }

    /// `CONTACT_APPEND` (§12.2), solving a stamp scoped to `contact_addr`.
    ///
    /// # Errors
    ///
    /// As [`Client::call_unsigned`], plus anything `GET_CHALLENGE` returns.
    pub async fn contact_append(
        &mut self,
        contact_addr: QueueAddress,
        plaintext: &[u8],
        pow: Option<PowParams>,
    ) -> Result<()> {
        let payload = self.pad(plaintext)?;
        let stamp = self
            .stamp_for(
                ChallengePurpose::ContactAppend,
                contact_addr.as_bytes(),
                pow,
            )
            .await?;
        let body = ContactAppendRequest {
            contact_addr,
            payload,
            stamp,
        };
        self.call_unsigned::<ops::ContactAppend>(&body)
            .await
            .map(|_| ())
    }

    /// `PUBLISH_KEY_PACKAGES` — §12.6. Signed by the contact queue's recv key.
    ///
    /// # Errors
    ///
    /// The relay's §10 code, or a transport failure.
    pub async fn publish_key_packages(
        &mut self,
        recv_key: &SigningKey,
        recv_addr: QueueAddress,
        packages: &[Vec<u8>],
        last_resort: Option<Vec<u8>>,
    ) -> Result<PublishKeyPackagesResponse> {
        let packages = packages
            .iter()
            .map(|bytes| KeyPackage::new(bytes.clone()))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let last_resort = match last_resort {
            Some(bytes) => vec![KeyPackage::new(bytes)?],
            None => Vec::new(),
        };
        let body = PublishKeyPackagesRequest {
            packages: packages.into(),
            last_resort: last_resort.into(),
        };
        self.call_signed::<ops::PublishKeyPackages>(recv_key, recv_addr, &body)
            .await
    }

    /// `CLAIM_KEY_PACKAGE` — §12.6. Unsigned, behind a proof-of-work stamp.
    ///
    /// # Errors
    ///
    /// The relay's §10 code — [`f2z_codec::ErrorCode::Unavailable`] when the
    /// pool is empty and no last-resort package is stored — or a transport
    /// failure.
    pub async fn claim_key_package(
        &mut self,
        contact_addr: QueueAddress,
        pow: Option<PowParams>,
    ) -> Result<ClaimKeyPackageResponse> {
        let stamp = self
            .stamp_for(
                ChallengePurpose::ClaimKeyPackage,
                contact_addr.as_bytes(),
                pow,
            )
            .await?;
        let body = ClaimKeyPackageRequest {
            contact_addr,
            stamp,
        };
        self.call_unsigned::<ops::ClaimKeyPackage>(&body).await
    }

    // -- the machinery ----------------------------------------------------

    /// Pad to the smallest bucket that fits (§9).
    ///
    /// # Errors
    ///
    /// [`TestkitError::Config`] when the plaintext exceeds the largest bucket.
    pub fn pad(&self, plaintext: &[u8]) -> Result<Payload> {
        let Some(bucket) = self.padding.bucket_for(plaintext.len()) else {
            return Err(TestkitError::Config(
                "payload exceeds the largest padding bucket; chunk it client-side (WIRE.md §9)",
            ));
        };
        let mut bytes = plaintext.to_vec();
        bytes.resize(usize::try_from(bucket).unwrap_or(plaintext.len()), 0);
        Ok(Payload::new(bytes)?)
    }

    /// Issue a signed command and wait for its answer.
    ///
    /// # Errors
    ///
    /// The relay's §10 code, or a transport failure.
    pub async fn call_signed<C: RelayCommand>(
        &mut self,
        key: &SigningKey,
        address: QueueAddress,
        body: &C::Request,
    ) -> Result<C::Response> {
        let request_id = self.take_request_id();
        let ticket = self.inflight.issue::<C>(request_id)?;
        let nonce = self.nonce();
        let timestamp = self.relay_time_ms();
        let signed = SignedCommand::<C>::create(
            self.session.transcripts(),
            request_id,
            address,
            timestamp,
            nonce,
            key,
            body,
        )?;
        self.send_frame(&signed.frame()?).await?;
        let (frame_id, response) = self.await_response().await?;
        Ok(self.inflight.complete::<C>(ticket, frame_id, &response)?)
    }

    /// Issue an unsigned command and wait for its answer.
    ///
    /// # Errors
    ///
    /// As [`Client::call_signed`].
    pub async fn call_unsigned<C: RelayCommand>(
        &mut self,
        body: &C::Request,
    ) -> Result<C::Response> {
        let request_id = self.take_request_id();
        let ticket = self.inflight.issue::<C>(request_id)?;
        let frame = unsigned_request::<C>(request_id, body)?;
        self.send_frame(&frame).await?;
        let (frame_id, response) = self.await_response().await?;
        Ok(self.inflight.complete::<C>(ticket, frame_id, &response)?)
    }

    /// Send a signed command and return without waiting, so a caller can fill
    /// §4.3's in-flight window or interleave two commands.
    ///
    /// # Errors
    ///
    /// As [`Client::call_signed`], minus the response.
    pub async fn send_signed<C: RelayCommand>(
        &mut self,
        key: &SigningKey,
        address: QueueAddress,
        body: &C::Request,
    ) -> Result<u32> {
        let request_id = self.take_request_id();
        let nonce = self.nonce();
        let timestamp = self.relay_time_ms();
        let signed = SignedCommand::<C>::create(
            self.session.transcripts(),
            request_id,
            address,
            timestamp,
            nonce,
            key,
            body,
        )?;
        self.send_frame(&signed.frame()?).await?;
        Ok(request_id)
    }

    /// Send an unsigned command without waiting, so a caller can fill §4.3's
    /// in-flight window.
    ///
    /// # Errors
    ///
    /// As [`Client::call_unsigned`], minus the response.
    pub async fn send_unsigned<C: RelayCommand>(&mut self, body: &C::Request) -> Result<u32> {
        let request_id = self.take_request_id();
        let frame = unsigned_request::<C>(request_id, body)?;
        self.send_frame(&frame).await?;
        Ok(request_id)
    }

    /// The next response frame, whatever it answers.
    ///
    /// §4.3: responses may arrive out of order, so a caller that issued several
    /// requests must be able to take them as they come and correlate itself.
    /// Pushes are queued rather than returned.
    ///
    /// # Errors
    ///
    /// [`TestkitError::Closed`] or [`TestkitError::Timeout`].
    pub async fn next_response(&mut self) -> Result<(u32, Response)> {
        self.await_response().await
    }

    /// The bytes of a signed command, without sending it. For the vectors that
    /// replay a frame verbatim (§5.5, §5.6).
    ///
    /// # Errors
    ///
    /// [`TestkitError::Protocol`] if the command cannot be built.
    pub fn encode_signed<C: RelayCommand>(
        &mut self,
        key: &SigningKey,
        address: QueueAddress,
        body: &C::Request,
    ) -> Result<Vec<u8>> {
        let request_id = self.take_request_id();
        let nonce = self.nonce();
        let timestamp = self.relay_time_ms();
        let signed = SignedCommand::<C>::create(
            self.session.transcripts(),
            request_id,
            address,
            timestamp,
            nonce,
            key,
            body,
        )?;
        Ok(signed.encode()?)
    }

    /// Write arbitrary bytes as a binary frame.
    ///
    /// # Errors
    ///
    /// [`TestkitError::Transport`] if the write fails.
    pub async fn send_raw(&mut self, bytes: Vec<u8>) -> Result<()> {
        self.sink.send(WireMessage::Binary(bytes)).await?;
        Ok(())
    }

    /// Write a text frame. §4.2: the relay must answer with a fatal
    /// `ERR_FRAME_TYPE` and close with status 1003.
    ///
    /// # Errors
    ///
    /// [`TestkitError::Transport`] if the write fails.
    pub async fn send_text(&mut self, text: &str) -> Result<()> {
        self.sink
            .send(WireMessage::Text(text.as_bytes().to_vec()))
            .await?;
        Ok(())
    }

    /// The next push, waiting up to the configured read timeout.
    ///
    /// # Errors
    ///
    /// [`TestkitError::Timeout`] if none arrives, [`TestkitError::Closed`] if
    /// the connection ends first.
    pub async fn next_push(&mut self) -> Result<Push> {
        if let Some(push) = self.pushes.pop_front() {
            return Ok(push);
        }
        loop {
            match self.read_frame().await?.1 {
                FramePayload::Push(push) => return Ok(push),
                // A response nobody is waiting for. Keep reading rather than
                // failing: a delayed or reordered response can legitimately
                // arrive here after its caller gave up.
                FramePayload::Request(_) | FramePayload::Response(_) => {}
            }
        }
    }

    /// The next push, decoded as a `QUEUE_EVENT` body.
    ///
    /// # Errors
    ///
    /// As [`Client::next_push`], plus [`TestkitError::Expectation`] if the push
    /// was a different event.
    pub async fn next_queue_event(&mut self) -> Result<f2z_codec::commands::QueueEventPush> {
        let push = self.next_push().await?;
        if push.event() != Some(PushEvent::QueueEvent) {
            return Err(TestkitError::Expectation(format!(
                "expected QUEUE_EVENT, got event {:#06x}",
                push.event
            )));
        }
        Ok(decode_canonical::<f2z_codec::commands::QueueEventPush>(push.body())?.into_value())
    }

    /// The next push, decoded as a `MSG` body.
    ///
    /// # Errors
    ///
    /// As [`Client::next_push`], plus [`TestkitError::Expectation`] if the push
    /// was a different event.
    pub async fn next_message(&mut self) -> Result<f2z_codec::commands::MsgPush> {
        let push = self.next_push().await?;
        if push.event() != Some(PushEvent::Msg) {
            return Err(TestkitError::Expectation(format!(
                "expected MSG, got event {:#06x}",
                push.event
            )));
        }
        Ok(decode_canonical::<f2z_codec::commands::MsgPush>(push.body())?.into_value())
    }

    /// Wait for the relay to close, which is what §1.3's fatal errors require
    /// after the response.
    ///
    /// # Errors
    ///
    /// [`TestkitError::Expectation`] if a frame arrives instead, or
    /// [`TestkitError::Timeout`].
    pub async fn expect_closed(&mut self) -> Result<()> {
        loop {
            let message = self.read_message().await?;
            match message {
                None | Some(WireMessage::Close(_)) => {
                    self.closed = true;
                    return Ok(());
                }
                Some(WireMessage::Ping(payload)) => {
                    let _ = self.sink.send(WireMessage::Pong(payload)).await;
                }
                Some(WireMessage::Pong(_)) => {}
                Some(WireMessage::Binary(bytes)) => {
                    return Err(TestkitError::Expectation(format!(
                        "expected the relay to close; it sent {} bytes instead",
                        bytes.len()
                    )));
                }
                Some(WireMessage::Text(_)) => {
                    return Err(TestkitError::Expectation(
                        "the relay sent a text frame, which no relay may do".to_owned(),
                    ));
                }
            }
        }
    }

    /// Whether the peer has closed.
    #[must_use]
    pub const fn is_closed(&self) -> bool {
        self.closed
    }

    /// Close from this side.
    ///
    /// # Errors
    ///
    /// [`TestkitError::Transport`] if the close cannot be written.
    pub async fn close(&mut self) -> Result<()> {
        self.closed = true;
        self.sink.close(crate::outbound::CLOSE_NORMAL).await?;
        Ok(())
    }

    /// Solve a stamp, or return the empty one when no work is required.
    ///
    /// # Errors
    ///
    /// Anything `GET_CHALLENGE` returns.
    pub async fn stamp_for(
        &mut self,
        purpose: ChallengePurpose,
        scope: &[u8],
        pow: Option<PowParams>,
    ) -> Result<PowStamp> {
        let params = match pow {
            Some(params) if params.is_required() => params,
            Some(_) => return Ok(PowStamp::empty()),
            None => return Ok(PowStamp::empty()),
        };
        let issued = self.challenge(purpose, scope).await?;
        Ok(solve(
            issued.challenge,
            &mut self.rng,
            params.difficulty_bits,
        ))
    }

    fn take_request_id(&mut self) -> u32 {
        let id = self.next_request_id;
        // §4.3: nonzero, and unique among the *currently in-flight* requests.
        // Wrapping past zero is the one value it may never take.
        self.next_request_id = self.next_request_id.checked_add(1).unwrap_or(1);
        id
    }

    async fn send_frame(&mut self, frame: &RelayFrame) -> Result<()> {
        let bytes = frame.encode_canonical()?;
        self.sink.send(WireMessage::Binary(bytes)).await?;
        Ok(())
    }

    async fn await_response(&mut self) -> Result<(u32, Response)> {
        loop {
            let (request_id, payload) = self.read_frame().await?;
            match payload {
                FramePayload::Response(response) => return Ok((request_id, response)),
                // §4.3: responses may arrive out of order and a push may arrive
                // between them. Queue it rather than treating it as the answer.
                FramePayload::Push(push) => self.pushes.push_back(push),
                FramePayload::Request(_) => {
                    return Err(TestkitError::Expectation(
                        "a relay sent a request frame, which no relay may do".to_owned(),
                    ));
                }
            }
        }
    }

    async fn read_frame(&mut self) -> Result<(u32, FramePayload)> {
        loop {
            let Some(message) = self.read_message().await? else {
                self.closed = true;
                return Err(TestkitError::Closed);
            };
            match message {
                WireMessage::Binary(bytes) => {
                    // §3.3 applies in both directions: a client that skipped it
                    // would be the permissive decoder the rule exists to kill.
                    let frame = decode_canonical::<RelayFrame>(&bytes)?.into_value();
                    frame.validate()?;
                    return Ok((frame.request_id, frame.payload));
                }
                WireMessage::Ping(payload) => {
                    // §2.4: clients MUST respond to Ping with Pong. The browser
                    // runtime does this without asking; a native client has to.
                    let _ = self.sink.send(WireMessage::Pong(payload)).await;
                }
                WireMessage::Pong(_) => {}
                WireMessage::Close(_) => {
                    self.closed = true;
                    return Err(TestkitError::Closed);
                }
                WireMessage::Text(_) => {
                    return Err(TestkitError::Expectation(
                        "the relay sent a text frame, which no relay may do".to_owned(),
                    ));
                }
            }
        }
    }

    async fn read_message(&mut self) -> Result<Option<WireMessage>> {
        match tokio::time::timeout(self.read_timeout, self.stream.recv()).await {
            Ok(Ok(message)) => Ok(message),
            Ok(Err(error)) => Err(TestkitError::from(error)),
            Err(_) => Err(TestkitError::Timeout),
        }
    }
}

/// Search for a stamp meeting `difficulty_bits` (§13.1).
///
/// A leading-zero-bit search over BLAKE2b, chosen so verification is a single
/// hash. §12.4 is honest that this taxes phones far more than rented GPUs and
/// that no tuning fixes it; at the testkit's difficulty the point is the shape
/// of the exchange, not the cost.
#[must_use]
pub fn solve(challenge: Challenge, rng: &mut Csprng, difficulty_bits: u8) -> PowStamp {
    let salt = f2z_codec::types::Salt::new(rng.next_bytes::<16>());
    let mut stamp = PowStamp {
        challenge,
        salt,
        counter: 0,
    };
    loop {
        if stamp.meets_difficulty(difficulty_bits) {
            return stamp;
        }
        stamp.counter = stamp.counter.wrapping_add(1);
    }
}

/// Read the `HELLO` response before a `Client` exists.
///
/// Answers §2.4's Ping while it waits, because a relay whose keepalive fires
/// during a slow handshake is not misbehaving.
async fn await_hello(
    sink: &mut Box<dyn TransportSink>,
    stream: &mut Box<dyn TransportStream>,
    read_timeout: Duration,
) -> Result<(u32, Response)> {
    loop {
        let message = match tokio::time::timeout(read_timeout, stream.recv()).await {
            Ok(Ok(Some(message))) => message,
            Ok(Ok(None)) => return Err(TestkitError::Closed),
            Ok(Err(error)) => return Err(TestkitError::from(error)),
            Err(_) => return Err(TestkitError::Timeout),
        };
        match message {
            WireMessage::Binary(bytes) => {
                let frame = decode_canonical::<RelayFrame>(&bytes)?.into_value();
                frame.validate()?;
                match frame.payload {
                    FramePayload::Response(response) => return Ok((frame.request_id, response)),
                    FramePayload::Push(_) | FramePayload::Request(_) => {
                        return Err(TestkitError::Expectation(
                            "the relay answered HELLO with something that is not a response"
                                .to_owned(),
                        ));
                    }
                }
            }
            WireMessage::Ping(payload) => {
                let _ = sink.send(WireMessage::Pong(payload)).await;
            }
            WireMessage::Pong(_) => {}
            WireMessage::Close(_) => return Err(TestkitError::Closed),
            WireMessage::Text(_) => {
                return Err(TestkitError::Expectation(
                    "the relay sent a text frame, which no relay may do".to_owned(),
                ));
            }
        }
    }
}

/// Convenience: the error code a call returned, if it returned one.
#[must_use]
pub fn code_of<T>(result: &Result<T>) -> Option<ErrorCode> {
    match result {
        Err(error) => error.wire_code(),
        Ok(_) => None,
    }
}

/// Convenience: whether a call was refused by the client rather than by the
/// relay (§11.3).
#[must_use]
pub fn refusal_of<T>(result: &Result<T>) -> Option<f2z_relay_proto::Refusal> {
    match result {
        Err(TestkitError::Protocol(ProtoError::Refused(refusal))) => Some(*refusal),
        _ => None,
    }
}

/// The command marker types, re-exported so a vector needs one import.
pub use f2z_relay_proto::command::ops as commands;
