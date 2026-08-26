//! The conformance suite: `(input, expected output)` for every rule of
//! `WIRE.md` this crate can reach.
//!
//! # Why this file is the deliverable
//!
//! A fake relay that nobody checks is an untested claim about the protocol,
//! and a client built against an untested claim inherits every mistake in it.
//! So the rules are not asserted in the engine's own unit tests, where they
//! would only ever prove that the engine agrees with itself. They are stated
//! here, as inputs and expected outputs, driven through the ordinary client
//! API, over a transport — which is exactly how `f2z-relay` will be driven when
//! it exists.
//!
//! [`run`] takes an [`Endpoint`]. `FakeRelay` provides two, and the real relay
//! will be a third:
//!
//! ```text
//!   run(InProcessEndpoint)  ─┐
//!   run(WebSocketEndpoint)  ─┼─→ the same Vec<Vector>, the same verdicts
//!   run(WebSocketEndpoint::new("wss://relay.example/relay/v1"))
//! ```
//!
//! A vector that needs to *break* the relay — drop a response, expire a TTL,
//! publish the [#586] capability document — declares [`Needs::Faults`] or
//! [`Needs::Clock`]. Against a relay with no such handle it is reported
//! **skipped**, never passed. A suite that silently counted an unrunnable
//! vector as green would be worse than not having it.
//!
//! # What a vector may assume
//!
//! Only what `WIRE.md` guarantees. In particular no vector asserts a queue
//! address, an index origin beyond what §8.2 forces, or a message ordering the
//! relay never promised — a test that pinned one of those would fail a
//! conforming relay, which is the failure mode that makes conformance suites
//! get deleted.
//!
//! [#586]: https://github.com/free2z/zuu/issues/586

use std::sync::Arc;
use std::time::Duration;

use f2z_codec::ErrorCode;
use f2z_codec::canonical::Canonical;
use f2z_codec::commands::{AckRequest, ChallengePurpose, Command, PushEvent};
use f2z_codec::types::QueueAddress;
use f2z_relay_proto::capabilities::{self, ClientPolicy};
use f2z_relay_proto::command::ops;
use f2z_relay_proto::key::SigningKey;
use futures_util::future::BoxFuture;

use crate::client::{Client, solve};
use crate::clock::Clock;
use crate::error::{Result, TestkitError};
use crate::fake::Endpoint;
use crate::faults::{Effect, Fault, FaultInjector, PolicyFaults, Trigger};
use crate::rng::Csprng;
use crate::state::{QUEUE_EVENT_DELETED, QUEUE_EVENT_MESSAGES_EXPIRED};
use crate::transport::Transport;

/// What a vector needs from the target before it can mean anything.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Needs {
    /// Nothing but a conforming relay. Every one of these runs against
    /// `f2z-relay` unchanged.
    Nothing,
    /// A fault handle. Skipped against a relay that cannot be told to
    /// misbehave.
    Faults,
    /// A steerable clock. Skipped against a relay whose clock is the world's.
    Clock,
}

/// One `(input, expected output)` case.
pub struct Vector {
    /// The case's name, stable so a failure can be searched for.
    pub name: &'static str,
    /// The `WIRE.md` section it pins.
    pub section: &'static str,
    /// What the target must provide.
    pub needs: Needs,
    /// The case itself.
    pub run: VectorFn,
}

/// A vector body.
pub type VectorFn = for<'a> fn(&'a mut Context) -> BoxFuture<'a, Result<()>>;

/// What a vector is handed.
pub struct Context {
    endpoint: Arc<dyn Endpoint>,
    /// A connection with `HELLO` already completed.
    pub client: Client,
    /// The target's fault handle, when it has one.
    pub faults: Option<FaultInjector>,
    /// The target's clock, when it can be steered.
    pub clock: Option<Clock>,
    keys: Csprng,
    nonces: Csprng,
}

impl Context {
    /// Open a second connection, `HELLO` completed.
    ///
    /// # Errors
    ///
    /// As [`Client::connect`].
    pub async fn open(&mut self) -> Result<Client> {
        let transport = self.endpoint.connect().await?;
        Client::connect(transport, self.client_config()).await
    }

    /// A client configuration whose nonce stream has never been used.
    ///
    /// §5.5's seen-set is relay-wide and, on a frozen clock, nothing in it ever
    /// ages out. Two connections drawing from one nonce stream would therefore
    /// collide on `(signer_key, nonce)` and the second would be refused as a
    /// replay — a harness bug that would look exactly like a relay bug. Each
    /// connection gets its own stream, and each vector's streams are derived
    /// from its own name, so a vector is reproducible in isolation and cannot
    /// collide with any other.
    fn client_config(&mut self) -> crate::client::ClientConfig {
        let mut config = self.endpoint.client_config();
        config.nonce_seed = self.nonces.next_block();
        config
    }

    /// Open a raw transport with **no** `HELLO`, for the vectors that test what
    /// happens before one.
    ///
    /// # Errors
    ///
    /// As [`Endpoint::connect`].
    pub async fn raw(&mut self) -> Result<Transport> {
        self.endpoint.connect().await
    }

    /// A fresh queue key. Deterministic, so a failing vector replays.
    pub fn key(&mut self) -> SigningKey {
        SigningKey::from_seed(&self.keys.next_block())
    }

    /// The fault handle, or a skip.
    ///
    /// # Errors
    ///
    /// [`TestkitError::Config`] when the target has none.
    pub fn require_faults(&self) -> Result<FaultInjector> {
        self.faults
            .clone()
            .ok_or(TestkitError::Config("this target has no fault handle"))
    }

    /// The clock, or a skip.
    ///
    /// # Errors
    ///
    /// [`TestkitError::Config`] when the target has none.
    pub fn require_clock(&self) -> Result<Clock> {
        self.clock
            .clone()
            .ok_or(TestkitError::Config("this target has no steerable clock"))
    }
}

/// How a vector ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    /// The expected output was observed.
    Passed,
    /// The target could not provide what the vector needs. Never a pass.
    Skipped(String),
    /// The expected output was not observed.
    Failed(String),
}

/// One vector's result.
#[derive(Clone, Debug)]
pub struct Outcome {
    /// The vector's name.
    pub name: &'static str,
    /// The section it pins.
    pub section: &'static str,
    /// What happened.
    pub status: Status,
}

/// A whole run.
#[derive(Clone, Debug)]
pub struct Report {
    /// How the target was reached.
    pub target: String,
    /// Every vector, in suite order.
    pub outcomes: Vec<Outcome>,
}

impl Report {
    /// How many passed.
    #[must_use]
    pub fn passed(&self) -> usize {
        self.count(|status| matches!(status, Status::Passed))
    }

    /// How many were skipped for want of a handle.
    #[must_use]
    pub fn skipped(&self) -> usize {
        self.count(|status| matches!(status, Status::Skipped(_)))
    }

    /// How many failed.
    #[must_use]
    pub fn failed(&self) -> usize {
        self.count(|status| matches!(status, Status::Failed(_)))
    }

    fn count(&self, predicate: impl Fn(&Status) -> bool) -> usize {
        self.outcomes
            .iter()
            .filter(|outcome| predicate(&outcome.status))
            .count()
    }

    /// The names and reasons of every failure.
    #[must_use]
    pub fn failures(&self) -> Vec<String> {
        self.outcomes
            .iter()
            .filter_map(|outcome| match &outcome.status {
                Status::Failed(reason) => {
                    Some(format!("{} ({}): {reason}", outcome.name, outcome.section))
                }
                Status::Passed | Status::Skipped(_) => None,
            })
            .collect()
    }

    /// A one-line summary.
    #[must_use]
    pub fn summary(&self) -> String {
        format!(
            "{}: {} passed, {} skipped, {} failed, of {}",
            self.target,
            self.passed(),
            self.skipped(),
            self.failed(),
            self.outcomes.len()
        )
    }

    /// The pass/skip/fail verdict of each vector, by name, for comparing two
    /// runs of the same suite against two targets.
    #[must_use]
    pub fn verdicts(&self) -> Vec<(&'static str, Status)> {
        self.outcomes
            .iter()
            .map(|outcome| (outcome.name, outcome.status.clone()))
            .collect()
    }
}

/// Run the whole suite against a target.
///
/// Each vector gets its own connection, and any fault it armed is disarmed
/// afterwards — a vector that leaked a fault into the next one would produce a
/// failure nobody could reproduce in isolation.
pub async fn run(endpoint: Arc<dyn Endpoint>) -> Report {
    run_selected(endpoint, &suite()).await
}

/// Run a chosen subset.
pub async fn run_selected(endpoint: Arc<dyn Endpoint>, vectors: &[Vector]) -> Report {
    let target = endpoint.describe();
    let mut outcomes = Vec::with_capacity(vectors.len());

    for vector in vectors {
        let faults = endpoint.faults();
        let clock = endpoint.clock();
        let status = match (vector.needs, faults.is_some(), clock.is_some()) {
            (Needs::Faults, false, _) => {
                Status::Skipped("the target has no fault handle".to_owned())
            }
            (Needs::Clock, _, false) => {
                Status::Skipped("the target has no steerable clock".to_owned())
            }
            _ => run_one(&endpoint, vector, faults.clone(), clock).await,
        };

        if let Some(faults) = faults {
            faults.disarm();
            faults.set_policy(PolicyFaults::default());
        }
        outcomes.push(Outcome {
            name: vector.name,
            section: vector.section,
            status,
        });
    }

    Report { target, outcomes }
}

fn seed_for(name: &str, purpose: &[u8]) -> [u8; 32] {
    let mut input = Vec::with_capacity(name.len().saturating_add(purpose.len()).saturating_add(1));
    input.extend_from_slice(purpose);
    input.push(b'/');
    input.extend_from_slice(name.as_bytes());
    *f2z_codec::hash::hash(b"f2z-relay-testkit/vector-seed/v1", &input).as_bytes()
}

async fn run_one(
    endpoint: &Arc<dyn Endpoint>,
    vector: &Vector,
    faults: Option<FaultInjector>,
    clock: Option<Clock>,
) -> Status {
    let transport = match endpoint.connect().await {
        Ok(transport) => transport,
        Err(error) => return Status::Failed(format!("could not connect: {error}")),
    };
    // Both streams are derived from the vector's own name rather than from its
    // position in the suite, so running one vector alone produces exactly the
    // keys and nonces it produces in a full run.
    let mut nonces = Csprng::from_seed(seed_for(vector.name, b"nonces"));
    let mut config = endpoint.client_config();
    config.nonce_seed = nonces.next_block();
    let client = match Client::connect(transport, config).await {
        Ok(client) => client,
        Err(error) => return Status::Failed(format!("HELLO failed: {error}")),
    };
    let mut context = Context {
        endpoint: Arc::clone(endpoint),
        client,
        faults,
        clock,
        keys: Csprng::from_seed(seed_for(vector.name, b"keys")),
        nonces,
    };
    match (vector.run)(&mut context).await {
        Ok(()) => Status::Passed,
        Err(error) => Status::Failed(error.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Assertions.
// ---------------------------------------------------------------------------

/// Assert that a call was refused with exactly this §10 code.
///
/// # Errors
///
/// [`TestkitError::Expectation`] when it was not.
pub fn expect_code<T>(result: Result<T>, expected: ErrorCode) -> Result<()> {
    match result {
        Ok(_) => Err(TestkitError::Expectation(format!(
            "expected {} and the relay accepted the command",
            expected.name()
        ))),
        Err(error) => match error.wire_code() {
            Some(code) if code == expected => Ok(()),
            Some(code) => Err(TestkitError::Expectation(format!(
                "expected {}, got {}",
                expected.name(),
                code.name()
            ))),
            None => Err(TestkitError::Expectation(format!(
                "expected {}, got {error}",
                expected.name()
            ))),
        },
    }
}

/// Assert a boolean, with a reason.
///
/// # Errors
///
/// [`TestkitError::Expectation`] when it does not hold.
pub fn expect(condition: bool, reason: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(TestkitError::Expectation(reason.to_owned()))
    }
}

/// Assert equality of two values that can be shown.
///
/// # Errors
///
/// [`TestkitError::Expectation`] when they differ.
pub fn expect_eq<T: PartialEq + std::fmt::Debug>(left: T, right: T, reason: &str) -> Result<()> {
    if left == right {
        Ok(())
    } else {
        Err(TestkitError::Expectation(format!(
            "{reason}: {left:?} != {right:?}"
        )))
    }
}

// ---------------------------------------------------------------------------
// The suite.
// ---------------------------------------------------------------------------

macro_rules! suite {
    ($( $needs:ident, $section:literal, $name:ident );* $(;)?) => {
        /// Every vector, in the order `WIRE.md` states the rules.
        #[must_use]
        pub fn suite() -> Vec<Vector> {
            vec![$(
                Vector {
                    name: stringify!($name),
                    section: $section,
                    needs: Needs::$needs,
                    run: |context| Box::pin($name(context)),
                }
            ),*]
        }
    };
}

suite! {
    // §2 — transport and lifecycle
    Nothing, "§2.5", hello_must_be_the_first_frame;
    Nothing, "§2.5", a_second_hello_is_refused;
    Nothing, "§3.5", an_unofferable_version_is_refused;
    Nothing, "§5.2", relay_id_is_the_digest_of_the_proven_key;

    // §3, §4 — serialization and framing
    Nothing, "§3.3", trailing_bytes_in_a_frame_are_fatally_malformed;
    Nothing, "§3.3", a_non_canonical_body_is_fatally_malformed;
    Nothing, "§4.1", an_oversize_frame_is_fatally_malformed;
    Nothing, "§4.2", a_text_frame_closes_the_connection;
    Nothing, "§3.5", an_unknown_command_is_not_fatal;
    Faults,  "§4.3", a_duplicate_inflight_request_id_is_fatal;
    Faults,  "§4.3", exceeding_the_inflight_window_is_fatal;

    // §5 — the signing transcript
    Nothing, "§5.1", a_tampered_signature_is_refused;
    Nothing, "§5.1", the_transcript_binds_the_request_id;
    Nothing, "§5.5", a_stale_timestamp_is_refused;
    Nothing, "§5.5", a_replayed_frame_is_refused;
    Nothing, "§5.1", a_key_that_does_not_authorize_the_address_is_refused;

    // §6, §7 — queue lifecycle
    Nothing, "§7.1", create_queue_returns_two_distinct_addresses;
    Nothing, "§7.7", requested_ttls_are_clamped_and_reported;
    Nothing, "§7.3", bind_send_is_once_only;
    Nothing, "§6.3", append_requires_the_bound_key;
    Nothing, "§6.3", append_before_bind_is_unavailable;
    Nothing, "§6.3", an_append_response_carries_no_queue_state;
    Nothing, "§10",  an_absent_recv_address_is_no_access;
    Nothing, "§6.3", an_absent_send_address_is_unavailable;
    Nothing, "§7.6", a_deleted_queue_looks_like_one_that_never_existed;
    Nothing, "§6.2", read_never_mutates;
    Nothing, "§6.2", reading_below_the_watermark_starts_at_the_watermark;

    // §8 — acknowledgement
    Nothing, "§8.1", ack_is_cumulative_monotone_and_idempotent;
    Nothing, "§8.2", acking_beyond_the_highest_index_is_refused;
    Nothing, "§8.1", acking_deletes_the_ciphertext;

    // §6.4 — pushes
    Nothing, "§6.4", a_subscriber_is_pushed_the_message;
    Nothing, "§6.4", unsubscribing_stops_the_pushes;
    Nothing, "§6.4", deleting_a_queue_pushes_queue_event_one;

    // §9 — padding
    Nothing, "§9",   a_payload_outside_the_buckets_is_bad_size;

    // §11 — the capability document
    Nothing, "§11.1", the_capability_document_verifies_and_is_valid;
    Nothing, "§6.1",  the_hello_digest_matches_the_document;
    Faults,  "§5.5",  an_unsound_antireplay_window_is_published_and_refused;

    // §12 — first contact
    Nothing, "§12.2", bind_send_on_a_contact_address_is_not_permitted;
    Nothing, "§12.3", contact_append_requires_a_stamp;
    Nothing, "§12.3", a_contact_stamp_is_single_use;
    Nothing, "§12.3", a_contact_stamp_is_scoped_to_its_target;
    Nothing, "§12.5", first_contact_reaches_the_recipient;

    // §12.6 — key-package publication
    Nothing, "§12.6", a_published_pool_is_claimed_once_per_package;
    Nothing, "§12.6", an_exhausted_pool_falls_back_to_the_last_resort_package;
    Nothing, "§12.6", an_exhausted_pool_with_no_last_resort_is_unavailable;
    Nothing, "§12.6", a_claim_requires_a_stamp_of_its_own_purpose;
    Nothing, "§12.6", publishing_is_idempotent_under_retry;
    Nothing, "§12.6", an_empty_publish_reports_the_pool_without_changing_it;
    Nothing, "§12.6", a_pool_is_clamped_to_the_published_maximum;
    Nothing, "§12.6", a_standard_queue_holds_no_pool;

    // §13 — anti-abuse
    Faults,  "§13.1", a_full_queue_is_indistinguishable_from_an_absent_one;
    Faults,  "§13.1", backpressure_never_refuses_read_ack_or_delete;
    Faults,  "§13.1", the_queue_creation_quota_is_a_distinguishable_code;
    Faults,  "§10",   every_error_code_can_reach_a_client;

    // §7.7 — TTLs
    Faults,  "§7.7",  an_expired_message_is_gone_and_announced;
    Clock,   "§7.7",  an_idle_queue_disappears;

    // Failure paths — the ones delete-on-ack makes expensive to get wrong
    Faults,  "§8.3",  a_lost_ack_response_is_safe_to_retry;
    Faults,  "§4.3",  a_delayed_response_still_correlates;
    Faults,  "§4.3",  reordered_responses_still_correlate;
    Faults,  "§2.5",  a_mid_stream_close_leaves_the_status_unknown;
}

// ---------------------------------------------------------------------------
// §2, §3, §4.
// ---------------------------------------------------------------------------

async fn hello_must_be_the_first_frame(context: &mut Context) -> Result<()> {
    // A fresh transport with no HELLO. §2.5: "A relay that receives any other
    // frame first responds ERR_UNSUPPORTED_VERSION and closes."
    let transport = context.raw().await?;
    let (mut sink, mut stream) = transport.split();
    let frame = f2z_relay_proto::command::unsigned_request::<ops::Ping>(1, &Default::default())?;
    sink.send(crate::transport::WireMessage::Binary(
        frame.encode_canonical()?,
    ))
    .await?;
    let code = read_response_code(&mut stream).await?;
    expect_eq(
        code,
        Some(ErrorCode::UnsupportedVersion),
        "a frame before HELLO must be ERR_UNSUPPORTED_VERSION",
    )
}

async fn a_second_hello_is_refused(context: &mut Context) -> Result<()> {
    let result = context
        .client
        .call_unsigned::<ops::Hello>(&f2z_codec::commands::HelloRequest {
            min_version: f2z_codec::PROTOCOL_VERSION,
            max_version: f2z_codec::PROTOCOL_VERSION,
            client_nonce: f2z_codec::types::Challenge::new([9u8; 32]),
        })
        .await;
    // §3.5: negotiation happens once and applies to the whole connection.
    expect_code(result, ErrorCode::UnsupportedVersion)
}

async fn an_unofferable_version_is_refused(context: &mut Context) -> Result<()> {
    let transport = context.raw().await?;
    let (mut sink, mut stream) = transport.split();
    let offer = f2z_codec::commands::HelloRequest {
        // A range this build cannot be inside.
        min_version: 2,
        max_version: 3,
        client_nonce: f2z_codec::types::Challenge::new([1u8; 32]),
    };
    let frame = f2z_relay_proto::command::unsigned_request::<ops::Hello>(1, &offer)?;
    sink.send(crate::transport::WireMessage::Binary(
        frame.encode_canonical()?,
    ))
    .await?;
    let code = read_response_code(&mut stream).await?;
    expect_eq(
        code,
        Some(ErrorCode::UnsupportedVersion),
        "no common version must be ERR_UNSUPPORTED_VERSION",
    )
}

async fn relay_id_is_the_digest_of_the_proven_key(context: &mut Context) -> Result<()> {
    // The client already refused to open a session unless this held; asserting
    // it here makes the property a vector rather than an implementation detail
    // of the harness.
    let session = context.client.session();
    expect_eq(
        session.relay_id(),
        f2z_codec::hash::relay_id(&session.relay_identity_pk()),
        "relay_id must be H(\"free2z/relay/v1/relay-id\", relay_identity_pk)",
    )
}

async fn trailing_bytes_in_a_frame_are_fatally_malformed(context: &mut Context) -> Result<()> {
    let mut client = context.open().await?;
    let key = context.key();
    let mut bytes = client.encode_signed::<ops::Ack>(
        &key,
        QueueAddress::new([1u8; 32]),
        &AckRequest { up_to_index: 0 },
    )?;
    bytes.push(0);
    client.send_raw(bytes).await?;
    let (_, response) = client.next_response().await?;
    expect_eq(
        response.error_code(),
        Some(ErrorCode::Malformed),
        "a trailing byte must fail re-encode equality",
    )?;
    // §1.3: fatal means send the response, then close.
    client.expect_closed().await
}

async fn a_non_canonical_body_is_fatally_malformed(context: &mut Context) -> Result<()> {
    let mut client = context.open().await?;
    let key = context.key();
    // A frame that is canonical at the framing layer and carries one trailing
    // byte inside its opaque body. §3.3 has to be applied twice, and a relay
    // that applies it once accepts this.
    let timestamp = client.relay_time_ms();
    let nonce = client.nonce();
    let signed = f2z_relay_proto::command::SignedCommand::<ops::Ack>::create(
        client.session().transcripts(),
        4_242,
        QueueAddress::new([2u8; 32]),
        timestamp,
        nonce,
        &key,
        &AckRequest { up_to_index: 0 },
    )?;
    let mut body = signed.body().to_vec();
    body.push(0);
    let request = f2z_codec::frame::Request::new(
        Command::Ack.code(),
        f2z_codec::frame::CommandAuth::Signed(signed.auth().clone()),
        body,
    )?;
    let frame = f2z_codec::frame::RelayFrame::request(4_242, request);
    client.send_raw(frame.encode_canonical()?).await?;
    let (_, response) = client.next_response().await?;
    expect_eq(
        response.error_code(),
        Some(ErrorCode::Malformed),
        "a non-canonical body inside a canonical frame must still be refused",
    )
}

async fn an_oversize_frame_is_fatally_malformed(context: &mut Context) -> Result<()> {
    let mut client = context.open().await?;
    let capabilities = client.capabilities().await?.capabilities;
    let size = usize::try_from(capabilities.max_frame_bytes)
        .unwrap_or(usize::MAX)
        .saturating_add(1);
    let mut probe = context.open().await?;
    probe.send_raw(vec![0u8; size]).await?;
    // §4.1: `ERR_MALFORMED`, and the relay MUST NOT buffer the remainder to
    // produce a tidy error. The bytes are not a decodable frame, so the id is
    // unrecoverable and the connection simply closes.
    probe.expect_closed().await
}

async fn a_text_frame_closes_the_connection(context: &mut Context) -> Result<()> {
    let mut client = context.open().await?;
    client.send_text("this is not protocol").await?;
    // §4.2: fatal ERR_FRAME_TYPE, WebSocket status 1003. A text frame carries
    // no `request_id`, so what a client observes is the close.
    client.expect_closed().await
}

async fn an_unknown_command_is_not_fatal(context: &mut Context) -> Result<()> {
    let request = f2z_codec::frame::Request::new(
        0xbeef,
        f2z_codec::frame::CommandAuth::Unsigned,
        Vec::new(),
    )?;
    let frame = f2z_codec::frame::RelayFrame::request(7, request);
    context.client.send_raw(frame.encode_canonical()?).await?;
    let (_, response) = context.client.next_response().await?;
    expect_eq(
        response.error_code(),
        Some(ErrorCode::UnknownCommand),
        "an unknown command code must be ERR_UNKNOWN_COMMAND",
    )?;
    // Non-fatal: the connection still works.
    context.client.ping().await
}

async fn a_duplicate_inflight_request_id_is_fatal(context: &mut Context) -> Result<()> {
    // §4.3's duplicate rule is about ids that are *currently* in flight, and a
    // relay releases an id the moment it answers. So the rule is only
    // observable while a response is being held — which is why this vector
    // needs a fault handle and is reported as skipped against a relay that has
    // none, rather than being made into a race that passes by luck.
    let faults = context.require_faults()?;
    let mut client = context.open().await?;
    faults.arm(Fault::once(Trigger::Command(Command::Ping), Effect::Stall));

    let ping = f2z_relay_proto::command::unsigned_request::<ops::Ping>(9_000, &Default::default())?;
    let bytes = ping.encode_canonical()?;
    client.send_raw(bytes.clone()).await?;
    client.send_raw(bytes).await?;

    let (_, response) = client.next_response().await?;
    expect_eq(
        response.error_code(),
        Some(ErrorCode::Malformed),
        "a duplicate in-flight request_id must be ERR_MALFORMED",
    )?;
    // §1.3: fatal means send the response, then close.
    client.expect_closed().await
}

async fn exceeding_the_inflight_window_is_fatal(context: &mut Context) -> Result<()> {
    let faults = context.require_faults()?;
    let mut client = context.open().await?;
    let capabilities = client.capabilities().await?.capabilities;
    let window = usize::from(capabilities.max_inflight);

    // Stall every PING so nothing is ever released.
    faults.arm(Fault::always(
        Trigger::Command(Command::Ping),
        Effect::Stall,
    ));
    for _ in 0..window {
        client
            .send_unsigned::<ops::Ping>(&Default::default())
            .await?;
    }
    client
        .send_unsigned::<ops::Ping>(&Default::default())
        .await?;
    let (_, response) = client.next_response().await?;
    expect_eq(
        response.error_code(),
        Some(ErrorCode::TooManyInflight),
        "the in-flight window must be enforced with ERR_TOO_MANY_INFLIGHT",
    )
}

// ---------------------------------------------------------------------------
// §5.
// ---------------------------------------------------------------------------

async fn a_tampered_signature_is_refused(context: &mut Context) -> Result<()> {
    let key = context.key();
    let created = context.client.create_queue(&key, 0, 0, None).await?;
    let mut client = context.open().await?;
    let timestamp = client.relay_time_ms();
    let nonce = client.nonce();
    let signed = f2z_relay_proto::command::SignedCommand::<ops::Ack>::create(
        client.session().transcripts(),
        11,
        created.recv_addr,
        timestamp,
        nonce,
        &key,
        &AckRequest { up_to_index: 0 },
    )?;
    let mut auth = signed.auth().clone();
    let mut signature = *auth.signature.as_bytes();
    signature[0] ^= 0xff;
    auth.signature = f2z_codec::types::Signature::new(signature);
    let request = f2z_codec::frame::Request::new(
        Command::Ack.code(),
        f2z_codec::frame::CommandAuth::Signed(auth),
        signed.body().to_vec(),
    )?;
    client
        .send_raw(f2z_codec::frame::RelayFrame::request(11, request).encode_canonical()?)
        .await?;
    let (_, response) = client.next_response().await?;
    expect_eq(
        response.error_code(),
        Some(ErrorCode::BadSignature),
        "a tampered signature must be ERR_BAD_SIGNATURE",
    )
}

async fn the_transcript_binds_the_request_id(context: &mut Context) -> Result<()> {
    let key = context.key();
    let created = context.client.create_queue(&key, 0, 0, None).await?;
    let mut client = context.open().await?;
    // Sign for one `request_id`, then present the frame under another. §5.1
    // puts `request_id` in the transcript, so this cannot verify — and it is a
    // *fresh* nonce, so the refusal is the signature check and not the replay
    // check.
    let mut bytes = client.encode_signed::<ops::Ack>(
        &key,
        created.recv_addr,
        &AckRequest { up_to_index: 0 },
    )?;
    let original = bytes
        .get(1..5)
        .and_then(|slice| <[u8; 4]>::try_from(slice).ok())
        .map_or(0, u32::from_be_bytes);
    let replacement = original.wrapping_add(1).max(1).to_be_bytes();
    if let Some(slot) = bytes.get_mut(1..5) {
        slot.copy_from_slice(&replacement);
    }
    client.send_raw(bytes).await?;
    let (_, response) = client.next_response().await?;
    expect_eq(
        response.error_code(),
        Some(ErrorCode::BadSignature),
        "the transcript covers request_id, so moving it must break the signature",
    )
}

async fn a_stale_timestamp_is_refused(context: &mut Context) -> Result<()> {
    let key = context.key();
    let created = context.client.create_queue(&key, 0, 0, None).await?;
    let capabilities = context.client.capabilities().await?.capabilities;
    let mut client = context.open().await?;
    let now = client.relay_time_ms();
    // Outside ±clock_skew_ms in the past. §5.5 gives the same code for the
    // future half, deliberately: splitting them would tell a caller which way
    // its clock is wrong, which fingerprints the caller.
    client.set_timestamp(Some(now.saturating_sub(
        u64::from(capabilities.clock_skew_ms).saturating_add(60_000),
    )));
    let result = client.ack(&key, created.recv_addr, 0).await;
    expect_code(result, ErrorCode::StaleTimestamp)
}

async fn a_replayed_frame_is_refused(context: &mut Context) -> Result<()> {
    let key = context.key();
    let created = context.client.create_queue(&key, 0, 0, None).await?;
    let mut client = context.open().await?;
    // A queue with nothing appended: ACK 0 is ERR_ACK_TOO_HIGH, which proves
    // the frame was *verified* the first time. The second presentation must
    // stop earlier, at the seen-set.
    let bytes = client.encode_signed::<ops::Ack>(
        &key,
        created.recv_addr,
        &AckRequest { up_to_index: 0 },
    )?;
    client.send_raw(bytes.clone()).await?;
    let (_, first) = client.next_response().await?;
    expect_eq(
        first.error_code(),
        Some(ErrorCode::AckTooHigh),
        "the first presentation must be verified and then refused on its merits",
    )?;
    client.send_raw(bytes).await?;
    let (_, second) = client.next_response().await?;
    expect_eq(
        second.error_code(),
        Some(ErrorCode::Replay),
        "the same (signer_key, nonce) twice must be ERR_REPLAY",
    )
}

async fn a_key_that_does_not_authorize_the_address_is_refused(context: &mut Context) -> Result<()> {
    let owner = context.key();
    let stranger = context.key();
    let created = context.client.create_queue(&owner, 0, 0, None).await?;
    let mut client = context.open().await?;
    let result = client.read(&stranger, created.recv_addr, 0, 0, 0).await;
    // §10's existence-oracle rule: the same code an address that never existed
    // gets.
    expect_code(result, ErrorCode::NoAccess)
}

// ---------------------------------------------------------------------------
// §6, §7.
// ---------------------------------------------------------------------------

async fn create_queue_returns_two_distinct_addresses(context: &mut Context) -> Result<()> {
    let key = context.key();
    let created = context.client.create_queue(&key, 0, 0, None).await?;
    expect(!created.recv_addr.is_zero(), "recv_addr must not be zero")?;
    expect(!created.send_addr.is_zero(), "send_addr must not be zero")?;
    expect(
        created.recv_addr != created.send_addr,
        "the two addresses must differ; they are two capabilities",
    )
}

async fn requested_ttls_are_clamped_and_reported(context: &mut Context) -> Result<()> {
    let key = context.key();
    // A century. §7.7 caps the message TTL at 30 days and a relay MUST NOT
    // grant more, whatever its own configured maximum says.
    let created = context
        .client
        .create_queue(&key, u32::MAX, u32::MAX, None)
        .await?;
    expect(
        created.message_ttl_seconds <= f2z_codec::MAX_MESSAGE_TTL_SECONDS,
        "message_ttl_seconds must be clamped to the 30-day ceiling",
    )?;
    expect(
        created.idle_ttl_seconds <= f2z_relay_proto::queue::MAX_IDLE_TTL_SECONDS,
        "idle_ttl_seconds must be clamped to the published ceiling",
    )
}

async fn bind_send_is_once_only(context: &mut Context) -> Result<()> {
    let recv_key = context.key();
    let send_key = context.key();
    let other_key = context.key();
    let created = context.client.create_queue(&recv_key, 0, 0, None).await?;
    let mut sender = context.open().await?;
    sender.bind_send(&send_key, created.send_addr).await?;
    // §7.3: with any key, including the same key.
    let again = sender.bind_send(&send_key, created.send_addr).await;
    expect_code(again, ErrorCode::AlreadyBound)?;
    let stolen = sender.bind_send(&other_key, created.send_addr).await;
    expect_code(stolen, ErrorCode::AlreadyBound)
}

async fn append_requires_the_bound_key(context: &mut Context) -> Result<()> {
    let recv_key = context.key();
    let send_key = context.key();
    let impostor = context.key();
    let created = context.client.create_queue(&recv_key, 0, 0, None).await?;
    let mut sender = context.open().await?;
    sender.bind_send(&send_key, created.send_addr).await?;
    let result = sender
        .append(&impostor, created.send_addr, b"not yours")
        .await;
    // §6.3: never a distinguishable code.
    expect_code(result, ErrorCode::Unavailable)
}

async fn append_before_bind_is_unavailable(context: &mut Context) -> Result<()> {
    let recv_key = context.key();
    let send_key = context.key();
    let created = context.client.create_queue(&recv_key, 0, 0, None).await?;
    let mut sender = context.open().await?;
    let result = sender.append(&send_key, created.send_addr, b"early").await;
    expect_code(result, ErrorCode::Unavailable)
}

async fn an_append_response_carries_no_queue_state(context: &mut Context) -> Result<()> {
    let recv_key = context.key();
    let send_key = context.key();
    let created = context.client.create_queue(&recv_key, 0, 0, None).await?;
    let mut sender = context.open().await?;
    sender.bind_send(&send_key, created.send_addr).await?;
    let request_id = sender
        .send_signed::<ops::Append>(
            &send_key,
            created.send_addr,
            &f2z_codec::commands::AppendRequest {
                payload: sender.pad(b"one")?,
            },
        )
        .await?;
    let (id, response) = sender.next_response().await?;
    expect_eq(id, request_id, "the response must answer the request")?;
    expect(response.is_ok(), "the append must be accepted")?;
    // The requirement, literally: no index, no depth, no timestamp, no queue
    // state of any kind. Each of those would convert the send capability into a
    // weak read capability.
    expect_eq(
        response.body().len(),
        0,
        "an APPEND response body must be empty",
    )
}

async fn an_absent_recv_address_is_no_access(context: &mut Context) -> Result<()> {
    let key = context.key();
    let result = context
        .client
        .read(&key, QueueAddress::new([0x5a; 32]), 0, 0, 0)
        .await;
    expect_code(result, ErrorCode::NoAccess)
}

async fn an_absent_send_address_is_unavailable(context: &mut Context) -> Result<()> {
    let key = context.key();
    let result = context
        .client
        .append(&key, QueueAddress::new([0x5b; 32]), b"nowhere")
        .await;
    expect_code(result, ErrorCode::Unavailable)
}

async fn a_deleted_queue_looks_like_one_that_never_existed(context: &mut Context) -> Result<()> {
    let recv_key = context.key();
    let send_key = context.key();
    let created = context.client.create_queue(&recv_key, 0, 0, None).await?;
    let mut sender = context.open().await?;
    sender.bind_send(&send_key, created.send_addr).await?;
    context
        .client
        .delete_queue(&recv_key, created.recv_addr)
        .await?;

    // §7.6: no tombstone distinguishable from outside. The recv side gets the
    // same code an address that never existed gets…
    let read = context
        .client
        .read(&recv_key, created.recv_addr, 0, 0, 0)
        .await;
    expect_code(read, ErrorCode::NoAccess)?;
    // …and the sender learns nothing except that its next APPEND fails.
    let append = sender.append(&send_key, created.send_addr, b"gone").await;
    expect_code(append, ErrorCode::Unavailable)
}

async fn read_never_mutates(context: &mut Context) -> Result<()> {
    let recv_key = context.key();
    let send_key = context.key();
    let created = context.client.create_queue(&recv_key, 0, 0, None).await?;
    let mut sender = context.open().await?;
    sender.bind_send(&send_key, created.send_addr).await?;
    sender.append(&send_key, created.send_addr, b"once").await?;

    let first = context
        .client
        .read(&recv_key, created.recv_addr, 0, 0, 0)
        .await?;
    let second = context
        .client
        .read(&recv_key, created.recv_addr, 0, 0, 0)
        .await?;
    expect_eq(
        first.messages.len(),
        second.messages.len(),
        "READ must not consume",
    )?;
    expect_eq(
        first.messages.len(),
        1,
        "the appended message must be there",
    )
}

async fn reading_below_the_watermark_starts_at_the_watermark(context: &mut Context) -> Result<()> {
    let recv_key = context.key();
    let send_key = context.key();
    let created = context.client.create_queue(&recv_key, 0, 0, None).await?;
    let mut sender = context.open().await?;
    sender.bind_send(&send_key, created.send_addr).await?;
    for _ in 0..3 {
        sender.append(&send_key, created.send_addr, b"m").await?;
    }
    let all = context
        .client
        .read(&recv_key, created.recv_addr, 0, 0, 0)
        .await?;
    expect_eq(all.messages.len(), 3, "three appends, three messages")?;
    let first_index = all.messages.as_slice().first().map_or(0, |m| m.index);
    context
        .client
        .ack(&recv_key, created.recv_addr, first_index)
        .await?;

    // §6.2: below the watermark returns from the watermark, does not error, and
    // does not resurrect. A client recovering from a crash simply asks for
    // everything it might have missed.
    let again = context
        .client
        .read(&recv_key, created.recv_addr, 0, 0, 0)
        .await?;
    expect_eq(
        again.messages.len(),
        2,
        "the acked message must not come back",
    )
}

// ---------------------------------------------------------------------------
// §8.
// ---------------------------------------------------------------------------

async fn ack_is_cumulative_monotone_and_idempotent(context: &mut Context) -> Result<()> {
    let recv_key = context.key();
    let send_key = context.key();
    let created = context.client.create_queue(&recv_key, 0, 0, None).await?;
    let mut sender = context.open().await?;
    sender.bind_send(&send_key, created.send_addr).await?;
    for _ in 0..3 {
        sender.append(&send_key, created.send_addr, b"m").await?;
    }
    let read = context
        .client
        .read(&recv_key, created.recv_addr, 0, 0, 0)
        .await?;
    let last = read.messages.as_slice().last().map_or(0, |m| m.index);

    let first = context
        .client
        .ack(&recv_key, created.recv_addr, last)
        .await?;
    expect_eq(
        first.pending,
        0,
        "a cumulative ACK clears everything below it",
    )?;
    // Idempotent: the retry after a lost response is safe, which is what makes
    // the connection-loss case tractable at all (§8.3).
    let repeat = context
        .client
        .ack(&recv_key, created.recv_addr, last)
        .await?;
    expect_eq(repeat.pending, 0, "a repeated ACK is a no-op")?;
    // Monotone: below the watermark is accepted and does nothing.
    let below = context.client.ack(&recv_key, created.recv_addr, 0).await?;
    expect_eq(
        below.pending,
        0,
        "an ACK below the watermark must not move it",
    )?;
    expect_eq(
        below.next_index,
        first.next_index,
        "next_index must not move backwards",
    )
}

async fn acking_beyond_the_highest_index_is_refused(context: &mut Context) -> Result<()> {
    let recv_key = context.key();
    let send_key = context.key();
    let created = context.client.create_queue(&recv_key, 0, 0, None).await?;
    let mut sender = context.open().await?;
    sender.bind_send(&send_key, created.send_addr).await?;
    sender.append(&send_key, created.send_addr, b"m").await?;

    // §8.2 exists to stop a reader pre-acking: with the watermark set high,
    // every future APPEND would be deleted the instant it landed while the
    // sender kept receiving successful, empty responses.
    let result = context
        .client
        .ack(&recv_key, created.recv_addr, u64::MAX)
        .await;
    expect_code(result, ErrorCode::AckTooHigh)?;
    // …and the watermark did not move.
    let read = context
        .client
        .read(&recv_key, created.recv_addr, 0, 0, 0)
        .await?;
    expect_eq(read.messages.len(), 1, "a refused ACK must not delete")
}

async fn acking_deletes_the_ciphertext(context: &mut Context) -> Result<()> {
    let recv_key = context.key();
    let send_key = context.key();
    let created = context.client.create_queue(&recv_key, 0, 0, None).await?;
    let mut sender = context.open().await?;
    sender.bind_send(&send_key, created.send_addr).await?;
    sender.append(&send_key, created.send_addr, b"m").await?;
    let read = context
        .client
        .read(&recv_key, created.recv_addr, 0, 0, 0)
        .await?;
    let index = read.messages.as_slice().first().map_or(0, |m| m.index);
    context
        .client
        .ack(&recv_key, created.recv_addr, index)
        .await?;
    let after = context
        .client
        .read(&recv_key, created.recv_addr, 0, 0, 0)
        .await?;
    expect_eq(
        after.messages.len(),
        0,
        "ACK is queue-delivered: the relay deletes at that instant",
    )
}

// ---------------------------------------------------------------------------
// §6.4.
// ---------------------------------------------------------------------------

async fn a_subscriber_is_pushed_the_message(context: &mut Context) -> Result<()> {
    let recv_key = context.key();
    let send_key = context.key();
    let created = context.client.create_queue(&recv_key, 0, 0, None).await?;
    let subscribed = context
        .client
        .subscribe(&recv_key, created.recv_addr)
        .await?;
    expect_eq(subscribed.pending, 0, "a fresh queue holds nothing")?;

    let mut sender = context.open().await?;
    sender.bind_send(&send_key, created.send_addr).await?;
    sender
        .append(&send_key, created.send_addr, b"push me")
        .await?;

    let push = context.client.next_message().await?;
    expect_eq(
        push.recv_addr,
        created.recv_addr,
        "a MSG push names the subscribed receive address",
    )
}

async fn unsubscribing_stops_the_pushes(context: &mut Context) -> Result<()> {
    let recv_key = context.key();
    let send_key = context.key();
    let created = context.client.create_queue(&recv_key, 0, 0, None).await?;
    context
        .client
        .subscribe(&recv_key, created.recv_addr)
        .await?;
    context
        .client
        .unsubscribe(&recv_key, created.recv_addr)
        .await?;

    let mut sender = context.open().await?;
    sender.bind_send(&send_key, created.send_addr).await?;
    sender
        .append(&send_key, created.send_addr, b"silent")
        .await?;

    // A PING round-trips after the append, so the absence of a push is an
    // observation rather than a race, and the wait is short because what is
    // being proved is a negative.
    context.client.ping().await?;
    context.client.set_read_timeout(Duration::from_millis(250));
    match context.client.next_push().await {
        Err(TestkitError::Timeout) => Ok(()),
        Ok(_) => Err(TestkitError::Expectation(
            "a push arrived after UNSUBSCRIBE".to_owned(),
        )),
        Err(error) => Err(error),
    }
}

async fn deleting_a_queue_pushes_queue_event_one(context: &mut Context) -> Result<()> {
    let recv_key = context.key();
    let created = context.client.create_queue(&recv_key, 0, 0, None).await?;
    context
        .client
        .subscribe(&recv_key, created.recv_addr)
        .await?;
    context
        .client
        .delete_queue(&recv_key, created.recv_addr)
        .await?;
    let event = context.client.next_queue_event().await?;
    expect_eq(event.reason, QUEUE_EVENT_DELETED, "reason 1 is 'deleted'")
}

// ---------------------------------------------------------------------------
// §9.
// ---------------------------------------------------------------------------

async fn a_payload_outside_the_buckets_is_bad_size(context: &mut Context) -> Result<()> {
    let recv_key = context.key();
    let send_key = context.key();
    let created = context.client.create_queue(&recv_key, 0, 0, None).await?;
    let mut sender = context.open().await?;
    sender.bind_send(&send_key, created.send_addr).await?;
    let bucket = sender.padding().sizes().first().copied().unwrap_or(1024);
    let odd = usize::try_from(bucket).unwrap_or(1024).saturating_sub(1);
    let result = sender
        .append_raw_size(&send_key, created.send_addr, odd)
        .await;
    expect_code(result, ErrorCode::BadSize)
}

// ---------------------------------------------------------------------------
// §11.
// ---------------------------------------------------------------------------

async fn the_capability_document_verifies_and_is_valid(context: &mut Context) -> Result<()> {
    let signed = context.client.capabilities().await?;
    let proven = context.client.session().relay_identity_pk();
    // §11.3 step 1: verify against the key proved in HELLO, not against the
    // key the document names — a document is self-signed, so verifying it
    // against its own embedded key proves only that one hand wrote both.
    capabilities::verify(&signed, &proven)?;
    capabilities::validate(&signed.capabilities)?;
    // §11.3's checklist, under a policy that has opted into the insecure
    // transport a ws:// relay publishes.
    let policy = ClientPolicy {
        allow_insecure_transport: true,
        ..ClientPolicy::default()
    };
    policy.accept(&signed.capabilities)?;
    Ok(())
}

async fn the_hello_digest_matches_the_document(context: &mut Context) -> Result<()> {
    let signed = context.client.capabilities().await?;
    let expected = context.client.session().capabilities_digest();
    capabilities::check_digest(&signed.capabilities, &expected)?;
    Ok(())
}

async fn an_unsound_antireplay_window_is_published_and_refused(
    context: &mut Context,
) -> Result<()> {
    let faults = context.require_faults()?;
    faults.set_policy(PolicyFaults {
        unsound_antireplay_window: true,
        ..PolicyFaults::default()
    });

    let mut client = context.open().await?;
    let signed = client.capabilities().await?;
    let published = &signed.capabilities;
    expect(
        u64::from(published.antireplay_window_ms)
            < u64::from(published.clock_skew_ms).saturating_mul(2),
        "the fault must actually publish a window below 2 x clock_skew_ms",
    )?;
    // The finding of #586, in two halves. First: the document is *valid*. The
    // specification as written permits it, which is exactly why the defect is
    // a defect and not an implementation bug.
    capabilities::validate(published)?;
    // Second: a client that checks the relation refuses it, and the check is
    // on by default in `f2z-relay-proto`.
    let policy = ClientPolicy {
        allow_insecure_transport: true,
        ..ClientPolicy::default()
    };
    match policy.accept(published) {
        Err(f2z_relay_proto::ProtoError::Refused(
            f2z_relay_proto::Refusal::AntiReplayWindowTooShort,
        )) => Ok(()),
        Err(other) => Err(TestkitError::Expectation(format!(
            "expected AntiReplayWindowTooShort, got {other}"
        ))),
        Ok(()) => Err(TestkitError::Expectation(
            "a client must refuse a relay whose seen-set ages out inside the timestamp window"
                .to_owned(),
        )),
    }
}

// ---------------------------------------------------------------------------
// §12.
// ---------------------------------------------------------------------------

async fn bind_send_on_a_contact_address_is_not_permitted(context: &mut Context) -> Result<()> {
    let recv_key = context.key();
    let binder = context.key();
    let created = context
        .client
        .create_contact_queue(&recv_key, 0, 0, None)
        .await?;
    let mut client = context.open().await?;
    let result = client.bind_send(&binder, created.contact_addr).await;
    // §12.2 point 1: always, for everyone. There is no key that authorizes
    // writing to it, which means there is no key that can be stolen.
    expect_code(result, ErrorCode::NotPermitted)
}

async fn contact_append_requires_a_stamp(context: &mut Context) -> Result<()> {
    let recv_key = context.key();
    let created = context
        .client
        .create_contact_queue(&recv_key, 0, 0, None)
        .await?;
    let mut stranger = context.open().await?;
    let body = f2z_codec::commands::ContactAppendRequest {
        contact_addr: created.contact_addr,
        payload: stranger.pad(b"hello bob")?,
        stamp: f2z_codec::pow::PowStamp::empty(),
    };
    let result = stranger
        .call_unsigned::<ops::ContactAppend>(&body)
        .await
        .map(|_| ());
    expect_code(result, ErrorCode::PowRequired)
}

async fn a_contact_stamp_is_single_use(context: &mut Context) -> Result<()> {
    let recv_key = context.key();
    let created = context
        .client
        .create_contact_queue(&recv_key, 0, 0, None)
        .await?;
    let mut stranger = context.open().await?;
    let capabilities = stranger.capabilities().await?.capabilities;
    let params = capabilities.contact_append_pow;
    let issued = stranger
        .challenge(
            ChallengePurpose::ContactAppend,
            created.contact_addr.as_bytes(),
        )
        .await?;
    let mut rng = Csprng::from_seed([0x33; 32]);
    let stamp = solve(issued.challenge, &mut rng, params.difficulty_bits);
    let body = f2z_codec::commands::ContactAppendRequest {
        contact_addr: created.contact_addr,
        payload: stranger.pad(b"hello bob")?,
        stamp,
    };
    stranger.call_unsigned::<ops::ContactAppend>(&body).await?;
    // §12.3: the challenge is consumed on use, so stamps cannot be replayed.
    let again = stranger
        .call_unsigned::<ops::ContactAppend>(&body)
        .await
        .map(|_| ());
    expect_code(again, ErrorCode::PowInvalid)
}

async fn a_contact_stamp_is_scoped_to_its_target(context: &mut Context) -> Result<()> {
    let first_key = context.key();
    let second_key = context.key();
    let victim = context
        .client
        .create_contact_queue(&first_key, 0, 0, None)
        .await?;
    let other = context
        .client
        .create_contact_queue(&second_key, 0, 0, None)
        .await?;

    let mut stranger = context.open().await?;
    let capabilities = stranger.capabilities().await?.capabilities;
    let params = capabilities.contact_append_pow;
    let issued = stranger
        .challenge(
            ChallengePurpose::ContactAppend,
            victim.contact_addr.as_bytes(),
        )
        .await?;
    let mut rng = Csprng::from_seed([0x44; 32]);
    let stamp = solve(issued.challenge, &mut rng, params.difficulty_bits);
    // Computed for one victim, spent on another. §12.3 binds the challenge to
    // the target address precisely so this cannot work.
    let body = f2z_codec::commands::ContactAppendRequest {
        contact_addr: other.contact_addr,
        payload: stranger.pad(b"misdirected")?,
        stamp,
    };
    let result = stranger
        .call_unsigned::<ops::ContactAppend>(&body)
        .await
        .map(|_| ());
    expect_code(result, ErrorCode::PowInvalid)
}

async fn first_contact_reaches_the_recipient(context: &mut Context) -> Result<()> {
    // §12.5, steps 1 to 8, minus the directory: Alice writes to Bob's published
    // contact address with a stamp, Bob reads it from the ordinary receive side
    // of the same queue and acknowledges.
    let bob = context.key();
    let created = context
        .client
        .create_contact_queue(&bob, 0, 0, None)
        .await?;
    let capabilities = context.client.capabilities().await?.capabilities;

    let mut alice = context.open().await?;
    alice
        .contact_append(
            created.contact_addr,
            b"welcome",
            Some(capabilities.contact_append_pow),
        )
        .await?;

    let read = context
        .client
        .read(&bob, created.recv_addr, 0, 0, 0)
        .await?;
    expect_eq(read.messages.len(), 1, "the contact message must arrive")?;
    let index = read.messages.as_slice().first().map_or(0, |m| m.index);
    // The §8.4 MUST is Bob's: durable write *first*, then ACK. Here the "write"
    // is the assertion above.
    let acked = context.client.ack(&bob, created.recv_addr, index).await?;
    expect_eq(acked.pending, 0, "the contact queue drains like any other")
}

// ---------------------------------------------------------------------------
// §12.6 — key-package publication.
//
// Every vector here uses opaque byte strings where a real client uses an MLS
// `KeyPackage`. That is the point: the relay never parses one, cannot check
// one, and is not trusted to. Authenticating the package against the
// directory's identity key is the *fetcher's* obligation (§12.6), and it is
// asserted where it lives — in `f2z-msg-mls` and in the plugin — not here.
// ---------------------------------------------------------------------------

/// A contact queue with a pool, for the vectors below.
async fn with_pool(
    context: &mut Context,
    packages: &[Vec<u8>],
    last_resort: Option<Vec<u8>>,
) -> Result<(SigningKey, f2z_codec::commands::CreateContactQueueResponse)> {
    let owner = context.key();
    let created = context
        .client
        .create_contact_queue(&owner, 0, 0, None)
        .await?;
    context
        .client
        .publish_key_packages(&owner, created.recv_addr, packages, last_resort)
        .await?;
    Ok((owner, created))
}

async fn a_published_pool_is_claimed_once_per_package(context: &mut Context) -> Result<()> {
    let first_package = b"package-one".to_vec();
    let second_package = b"package-two".to_vec();
    let packages = vec![first_package.clone(), second_package.clone()];
    let (_owner, created) = with_pool(context, &packages, None).await?;
    let pow = context
        .client
        .capabilities()
        .await?
        .capabilities
        .claim_key_package_pow;

    let mut alice = context.open().await?;
    let first = alice
        .claim_key_package(created.contact_addr, Some(pow))
        .await?;
    expect_eq(
        first.key_package.as_slice().to_vec(),
        first_package,
        "the oldest package is served first",
    )?;
    expect_eq(first.last_resort, 0, "a pooled package is not last-resort")?;

    let mut bob = context.open().await?;
    let second = bob
        .claim_key_package(created.contact_addr, Some(pow))
        .await?;
    // Consumed. This is the property an append-only log cannot express, which
    // is why §12.6 puts the pool at the relay and not in the directory.
    expect_eq(
        second.key_package.as_slice().to_vec(),
        second_package,
        "a claimed package is never served twice",
    )
}

async fn an_exhausted_pool_falls_back_to_the_last_resort_package(
    context: &mut Context,
) -> Result<()> {
    let (_owner, created) = with_pool(
        context,
        &[b"the only one".to_vec()],
        Some(b"last resort".to_vec()),
    )
    .await?;
    let pow = context
        .client
        .capabilities()
        .await?
        .capabilities
        .claim_key_package_pow;

    let mut alice = context.open().await?;
    alice
        .claim_key_package(created.contact_addr, Some(pow))
        .await?;

    // Twice more, and both get the same reusable package. §12.6's exhaustion
    // behaviour: availability is preserved and the forward secrecy of first
    // contact is what pays for it (`THREAT-MODEL.md` §4.12).
    for _ in 0..2 {
        let mut stranger = context.open().await?;
        let claimed = stranger
            .claim_key_package(created.contact_addr, Some(pow))
            .await?;
        expect_eq(
            claimed.key_package.as_slice().to_vec(),
            b"last resort".to_vec(),
            "an empty pool serves the package of last resort",
        )?;
        expect_eq(claimed.last_resort, 1, "and says so")?;
    }
    Ok(())
}

async fn an_exhausted_pool_with_no_last_resort_is_unavailable(context: &mut Context) -> Result<()> {
    let (_owner, created) = with_pool(context, &[b"the only one".to_vec()], None).await?;
    let pow = context
        .client
        .capabilities()
        .await?
        .capabilities
        .claim_key_package_pow;

    let mut alice = context.open().await?;
    alice
        .claim_key_package(created.contact_addr, Some(pow))
        .await?;

    let mut stranger = context.open().await?;
    let result = stranger
        .claim_key_package(created.contact_addr, Some(pow))
        .await
        .map(|_| ());
    // §10's existence-oracle rule holds here too: exhausted and absent are the
    // same code, so sweeping published addresses learns nothing about which
    // devices are reachable.
    expect_code(result, ErrorCode::Unavailable)?;

    let mut prober = context.open().await?;
    let absent = prober
        .claim_key_package(QueueAddress::new([0x5c; 32]), Some(pow))
        .await
        .map(|_| ());
    expect_code(absent, ErrorCode::Unavailable)
}

async fn a_claim_requires_a_stamp_of_its_own_purpose(context: &mut Context) -> Result<()> {
    let (_owner, created) = with_pool(context, &[b"package".to_vec()], None).await?;
    let mut stranger = context.open().await?;

    // No stamp at all.
    let body = f2z_codec::commands::ClaimKeyPackageRequest {
        contact_addr: created.contact_addr,
        stamp: f2z_codec::pow::PowStamp::empty(),
    };
    let result = stranger
        .call_unsigned::<ops::ClaimKeyPackage>(&body)
        .await
        .map(|_| ());
    expect_code(result, ErrorCode::PowRequired)?;

    // A perfectly good `contact_append` stamp, for the right address, spent on
    // a claim. §12.6 gives the claim its own challenge purpose precisely so one
    // stamp cannot buy both.
    let capabilities = stranger.capabilities().await?.capabilities;
    let issued = stranger
        .challenge(
            ChallengePurpose::ContactAppend,
            created.contact_addr.as_bytes(),
        )
        .await?;
    let mut rng = Csprng::from_seed([0x5b; 32]);
    let stamp = solve(
        issued.challenge,
        &mut rng,
        capabilities.contact_append_pow.difficulty_bits,
    );
    let crossed = f2z_codec::commands::ClaimKeyPackageRequest {
        contact_addr: created.contact_addr,
        stamp,
    };
    let result = stranger
        .call_unsigned::<ops::ClaimKeyPackage>(&crossed)
        .await
        .map(|_| ());
    expect_code(result, ErrorCode::PowInvalid)
}

async fn publishing_is_idempotent_under_retry(context: &mut Context) -> Result<()> {
    let packages = vec![b"one".to_vec(), b"two".to_vec()];
    let (owner, created) = with_pool(context, &packages, None).await?;
    // The same batch again — the shape of a client whose response was lost.
    let again = context
        .client
        .publish_key_packages(&owner, created.recv_addr, &packages, None)
        .await?;
    expect_eq(
        again.pool_size,
        2,
        "a retried publish must not double the pool: two Welcomes to one init key",
    )
}

async fn an_empty_publish_reports_the_pool_without_changing_it(
    context: &mut Context,
) -> Result<()> {
    // §12.6.6's refill rule depends on this and it is easy to get wrong. Claims
    // are invisible to the owner — most never produce a `Welcome` — so a device
    // that decided when to refill from its own last-recorded number would drain
    // to zero and fall back to its reusable package of last resort without ever
    // noticing. An empty publish is how it asks, and it must not be a mutation.
    let packages = vec![b"one".to_vec(), b"two".to_vec(), b"three".to_vec()];
    let (owner, created) = with_pool(context, &packages, Some(b"last".to_vec())).await?;
    let pow = context
        .client
        .capabilities()
        .await?
        .capabilities
        .claim_key_package_pow;

    let mut stranger = context.open().await?;
    stranger
        .claim_key_package(created.contact_addr, Some(pow))
        .await?;

    let held = context
        .client
        .publish_key_packages(&owner, created.recv_addr, &[], None)
        .await?;
    expect_eq(
        held.pool_size,
        2,
        "the owner is told what the relay really holds",
    )?;
    expect_eq(
        held.has_last_resort,
        1,
        "and whether a package of last resort is stored",
    )?;

    // Asking twice does not consume, publish or replace anything.
    let again = context
        .client
        .publish_key_packages(&owner, created.recv_addr, &[], None)
        .await?;
    expect_eq(again.pool_size, 2, "an empty publish is not a mutation")
}

async fn a_pool_is_clamped_to_the_published_maximum(context: &mut Context) -> Result<()> {
    let max = context
        .client
        .capabilities()
        .await?
        .capabilities
        .contact_max_key_packages;
    let over = usize::try_from(max).unwrap_or(usize::MAX).saturating_add(8);
    let packages: Vec<Vec<u8>> = (0..over)
        .map(|index| format!("package-{index}").into_bytes())
        .collect();
    let owner = context.key();
    let created = context
        .client
        .create_contact_queue(&owner, 0, 0, None)
        .await?;
    let published = context
        .client
        .publish_key_packages(&owner, created.recv_addr, &packages, None)
        .await?;
    expect_eq(published.pool_size, max, "the pool is clamped, not refused")?;
    expect_eq(
        published.max_pool_size,
        max,
        "and the cap is reported so a client can compute its own low-water mark",
    )
}

async fn a_standard_queue_holds_no_pool(context: &mut Context) -> Result<()> {
    // §12.6 keys a pool by the *published* address. A standard queue has none,
    // so there is nothing to key one by — and the refusal is `ERR_NOT_PERMITTED`
    // rather than `ERR_NO_ACCESS`, because the caller proved it owns the queue
    // and nothing here is an oracle.
    let owner = context.key();
    let created = context.client.create_queue(&owner, 0, 0, None).await?;
    let result = context
        .client
        .publish_key_packages(&owner, created.recv_addr, &[b"package".to_vec()], None)
        .await
        .map(|_| ());
    expect_code(result, ErrorCode::NotPermitted)
}

// ---------------------------------------------------------------------------
// §13.
// ---------------------------------------------------------------------------

async fn a_full_queue_is_indistinguishable_from_an_absent_one(context: &mut Context) -> Result<()> {
    let faults = context.require_faults()?;
    let recv_key = context.key();
    let send_key = context.key();
    let created = context.client.create_queue(&recv_key, 0, 0, None).await?;
    let mut sender = context.open().await?;
    sender.bind_send(&send_key, created.send_addr).await?;

    faults.set_policy(PolicyFaults {
        max_queue_messages: Some(1),
        ..PolicyFaults::default()
    });
    sender
        .append(&send_key, created.send_addr, b"first")
        .await?;
    let full = sender.append(&send_key, created.send_addr, b"second").await;
    expect_code(full, ErrorCode::Unavailable)?;

    // The same code an absent address gets. If they differed, a bound sender
    // could learn the queue's depth by filling it.
    let absent = sender
        .append(&send_key, QueueAddress::new([0x77; 32]), b"nowhere")
        .await;
    expect_code(absent, ErrorCode::Unavailable)
}

async fn backpressure_never_refuses_read_ack_or_delete(context: &mut Context) -> Result<()> {
    let faults = context.require_faults()?;
    let recv_key = context.key();
    let send_key = context.key();
    let created = context.client.create_queue(&recv_key, 0, 0, None).await?;
    let mut sender = context.open().await?;
    sender.bind_send(&send_key, created.send_addr).await?;
    sender
        .append(&send_key, created.send_addr, b"stored")
        .await?;

    faults.set_policy(PolicyFaults {
        global_backpressure: true,
        ..PolicyFaults::default()
    });

    // §13.1 layer 4, in order: creation refuses with ERR_BACKPRESSURE…
    let creation = context.client.create_queue(&recv_key, 0, 0, None).await;
    expect_code(creation, ErrorCode::Backpressure)?;
    // …appends refuse with ERR_UNAVAILABLE…
    let append = sender.append(&send_key, created.send_addr, b"more").await;
    expect_code(append, ErrorCode::Unavailable)?;
    // …and READ, ACK and DELETE_QUEUE are never refused, because they are the
    // operations that make the relay smaller and refusing them is a deadlock.
    let read = context
        .client
        .read(&recv_key, created.recv_addr, 0, 0, 0)
        .await?;
    let index = read.messages.as_slice().first().map_or(0, |m| m.index);
    context
        .client
        .ack(&recv_key, created.recv_addr, index)
        .await?;
    context
        .client
        .delete_queue(&recv_key, created.recv_addr)
        .await
}

async fn the_queue_creation_quota_is_a_distinguishable_code(context: &mut Context) -> Result<()> {
    let faults = context.require_faults()?;
    let key = context.key();
    faults.set_policy(PolicyFaults {
        max_queues: Some(0),
        ..PolicyFaults::default()
    });
    let result = context.client.create_queue(&key, 0, 0, None).await;
    // §10 code 14. The receive side is allowed a code that says what happened:
    // the party being refused is the one that owns the queues, so there is no
    // state to leak to a stranger.
    expect_code(result, ErrorCode::Quota)
}

async fn every_error_code_can_reach_a_client(context: &mut Context) -> Result<()> {
    let faults = context.require_faults()?;
    // §10's codes are stable forever and a client has to handle all of them,
    // including the ones a healthy relay never emits. A client that panics on
    // an unexpected code finds out here rather than in production.
    for code in ErrorCode::ALL {
        if code.is_fatal() {
            // A fatal code closes the connection, so each one needs its own.
            let mut client = context.open().await?;
            faults.arm(Fault::once(
                Trigger::Command(Command::Ping),
                Effect::Refuse(code),
            ));
            let result = client.ping().await;
            expect_code(result, code)?;
            client.expect_closed().await?;
        } else {
            faults.arm(Fault::once(
                Trigger::Command(Command::Ping),
                Effect::Refuse(code),
            ));
            let result = context.client.ping().await;
            expect_code(result, code)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// §7.7.
// ---------------------------------------------------------------------------

async fn an_expired_message_is_gone_and_announced(context: &mut Context) -> Result<()> {
    let faults = context.require_faults()?;
    let recv_key = context.key();
    let send_key = context.key();
    let created = context.client.create_queue(&recv_key, 0, 0, None).await?;
    context
        .client
        .subscribe(&recv_key, created.recv_addr)
        .await?;
    let mut sender = context.open().await?;
    sender.bind_send(&send_key, created.send_addr).await?;
    sender
        .append(&send_key, created.send_addr, b"perishable")
        .await?;
    let _ = context.client.next_message().await?;

    faults.set_policy(PolicyFaults {
        expire_messages_after: Some(Duration::ZERO),
        ..PolicyFaults::default()
    });
    // Any command re-runs the sweep.
    let read = context
        .client
        .read(&recv_key, created.recv_addr, 0, 0, 0)
        .await?;
    expect_eq(read.messages.len(), 0, "an expired message must be gone")?;
    let event = context.client.next_queue_event().await?;
    expect_eq(
        event.reason,
        QUEUE_EVENT_MESSAGES_EXPIRED,
        "reason 3 is 'messages TTL-expired'",
    )?;
    // §8.2 still holds afterwards: expiry does not move the watermark, so the
    // reader still cannot pre-ack.
    let ack = context
        .client
        .ack(&recv_key, created.recv_addr, u64::MAX)
        .await;
    expect_code(ack, ErrorCode::AckTooHigh)
}

async fn an_idle_queue_disappears(context: &mut Context) -> Result<()> {
    let clock = context.require_clock()?;
    let key = context.key();
    let created = context.client.create_queue(&key, 0, 60, None).await?;
    // Past the granted idle TTL. §7.7 is explicit about the cost: a user whose
    // device is offline longer than this loses their queues, and their peers'
    // adverts become dead addresses.
    clock.advance(
        u64::from(created.idle_ttl_seconds)
            .saturating_mul(1_000)
            .saturating_add(1_000),
    );
    context.client.resync_clock().await?;
    let result = context.client.read(&key, created.recv_addr, 0, 0, 0).await;
    expect_code(result, ErrorCode::NoAccess)
}

// ---------------------------------------------------------------------------
// The failure paths.
// ---------------------------------------------------------------------------

async fn a_lost_ack_response_is_safe_to_retry(context: &mut Context) -> Result<()> {
    let faults = context.require_faults()?;
    let recv_key = context.key();
    let send_key = context.key();
    let created = context.client.create_queue(&recv_key, 0, 0, None).await?;
    let mut sender = context.open().await?;
    sender.bind_send(&send_key, created.send_addr).await?;
    sender.append(&send_key, created.send_addr, b"m").await?;
    let read = context
        .client
        .read(&recv_key, created.recv_addr, 0, 0, 0)
        .await?;
    let index = read.messages.as_slice().first().map_or(0, |m| m.index);

    // Drop exactly one ACK response. The command *ran*; the answer never
    // arrived. §2.5: the status is unknown. §8.3: the retry is safe, and a
    // client must not try to find out by reading — the messages may
    // legitimately be gone.
    faults.arm(Fault::once(Trigger::Command(Command::Ack), Effect::Drop));
    context.client.set_read_timeout(Duration::from_millis(250));
    let lost = context
        .client
        .ack(&recv_key, created.recv_addr, index)
        .await;
    expect(
        matches!(lost, Err(TestkitError::Timeout | TestkitError::Closed)),
        "a dropped response must present as an unknown outcome, not as a refusal",
    )?;

    let mut retry = context.open().await?;
    let outcome = retry.ack(&recv_key, created.recv_addr, index).await?;
    expect_eq(
        outcome.pending,
        0,
        "the retry must be a no-op that reports the same state",
    )
}

async fn a_delayed_response_still_correlates(context: &mut Context) -> Result<()> {
    let faults = context.require_faults()?;
    let mut client = context.open().await?;
    faults.arm(Fault::once(
        Trigger::Command(Command::GetCapabilities),
        Effect::Delay(Duration::from_millis(120)),
    ));
    let slow = client
        .send_unsigned::<ops::GetCapabilities>(&Default::default())
        .await?;
    let quick = client
        .send_unsigned::<ops::Ping>(&Default::default())
        .await?;

    // §4.3: "A relay MAY complete a cheap PING before an expensive READ issued
    // earlier, and will." A client that assumed order would mis-decode here.
    let (first_id, _) = client.next_response().await?;
    let (second_id, _) = client.next_response().await?;
    expect_eq(first_id, quick, "the cheap command answered first")?;
    expect_eq(second_id, slow, "the delayed command answered second")
}

async fn reordered_responses_still_correlate(context: &mut Context) -> Result<()> {
    let faults = context.require_faults()?;
    let mut client = context.open().await?;
    faults.arm(Fault::once(
        Trigger::Command(Command::GetCapabilities),
        Effect::Reorder,
    ));
    let held = client
        .send_unsigned::<ops::GetCapabilities>(&Default::default())
        .await?;
    let overtaking = client
        .send_unsigned::<ops::Ping>(&Default::default())
        .await?;

    let (first_id, first) = client.next_response().await?;
    let (second_id, second) = client.next_response().await?;
    expect_eq(first_id, overtaking, "the second request answered first")?;
    expect_eq(second_id, held, "the held response arrived after it")?;
    expect(
        first.is_ok() && second.is_ok(),
        "both answers are successes",
    )
}

async fn a_mid_stream_close_leaves_the_status_unknown(context: &mut Context) -> Result<()> {
    let faults = context.require_faults()?;
    let recv_key = context.key();
    let send_key = context.key();
    let created = context.client.create_queue(&recv_key, 0, 0, None).await?;
    let mut sender = context.open().await?;
    sender.bind_send(&send_key, created.send_addr).await?;

    // Close before the APPEND's answer is written. The append *happened*; the
    // sender cannot know that. §8.3: APPEND is not idempotent at the relay, so
    // a retry produces a duplicate — which is why deduplication lives
    // end-to-end at `msg_id` and not here.
    faults.arm(Fault::once(
        Trigger::Command(Command::Append),
        Effect::CloseBefore,
    ));
    sender.set_read_timeout(Duration::from_millis(250));
    let outcome = sender
        .append(&send_key, created.send_addr, b"unknown")
        .await;
    expect(
        matches!(outcome, Err(TestkitError::Closed | TestkitError::Timeout)),
        "a mid-stream close must present as an unknown outcome",
    )?;

    let read = context
        .client
        .read(&recv_key, created.recv_addr, 0, 0, 0)
        .await?;
    expect_eq(
        read.messages.len(),
        1,
        "the command applied even though its answer was never delivered",
    )?;

    let mut retry = context.open().await?;
    retry
        .append(&send_key, created.send_addr, b"unknown")
        .await?;
    let after = context
        .client
        .read(&recv_key, created.recv_addr, 0, 0, 0)
        .await?;
    expect_eq(
        after.messages.len(),
        2,
        "retrying an APPEND duplicates, by design",
    )
}

// ---------------------------------------------------------------------------
// Shared plumbing.
// ---------------------------------------------------------------------------

async fn read_response_code(
    stream: &mut Box<dyn crate::transport::TransportStream>,
) -> Result<Option<ErrorCode>> {
    loop {
        let message = match tokio::time::timeout(Duration::from_secs(5), stream.recv()).await {
            Ok(Ok(Some(message))) => message,
            Ok(Ok(None)) => return Err(TestkitError::Closed),
            Ok(Err(error)) => return Err(TestkitError::from(error)),
            Err(_) => return Err(TestkitError::Timeout),
        };
        match message {
            crate::transport::WireMessage::Binary(bytes) => {
                let frame =
                    f2z_codec::canonical::decode_canonical::<f2z_codec::frame::RelayFrame>(&bytes)?
                        .into_value();
                if let f2z_codec::frame::FramePayload::Response(response) = frame.payload {
                    return Ok(response.error_code());
                }
            }
            crate::transport::WireMessage::Close(_) => return Err(TestkitError::Closed),
            _ => {}
        }
    }
}

/// Every push event this suite knows how to name, so a reader can see the set
/// without opening `f2z-codec`.
pub const OBSERVED_PUSH_EVENTS: [PushEvent; 3] =
    [PushEvent::Msg, PushEvent::QueueEvent, PushEvent::Notice];
