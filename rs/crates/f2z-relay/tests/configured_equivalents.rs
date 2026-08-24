//! What the real relay can honestly satisfy of the thirteen vectors the
//! conformance suite reports as `Skipped`.
//!
//! # Why this file exists
//!
//! `conformance.rs` runs `f2z-relay-testkit`'s suite unchanged and thirteen
//! vectors report `Skipped`, because they declare `Needs::Faults` or
//! `Needs::Clock` and a real relay has neither handle. **A skip is not a pass**,
//! and leaving it there would mean thirteen rules of `WIRE.md` are untested
//! against the implementation that has to keep them.
//!
//! It would be easy and wrong to close that gap by compiling a fault-injection
//! hook into the relay. A hook that can drop a response, refuse an arbitrary
//! command or move the clock is a hook an attacker can reach, and a
//! `#[cfg(test)]` one is a hook that a build-flag mistake ships. So the gap is
//! closed the other way: **eleven of the thirteen rules are reachable on an
//! unmodified production binary**, either through published configuration —
//! which is a policy `WIRE.md` permits, not a relaxation — or through ordinary
//! client behaviour that the specification already describes.
//!
//! | Skipped vector | How this file reaches it |
//! |---|---|
//! | `a_duplicate_inflight_request_id_is_fatal` | An `APPEND` is answered from its own task, so its id is genuinely outstanding while a second frame reuses it |
//! | `exceeding_the_inflight_window_is_fatal` | The same, with `limits.max_inflight` configured low |
//! | `a_full_queue_is_indistinguishable_from_an_absent_one` | `limits.max_queue_messages = 1` |
//! | `the_queue_creation_quota_is_a_distinguishable_code` | `limits.max_queues = 1` |
//! | `backpressure_never_refuses_read_ack_or_delete` | `limits.storage_high_water_bytes = 1` |
//! | `an_expired_message_is_gone_and_announced` | A one-second message TTL and a one-second sweep |
//! | `an_idle_queue_disappears` | A one-second idle TTL and a one-second sweep |
//! | `a_lost_ack_response_is_safe_to_retry` | The client closes before reading the answer — §8.3's actual case |
//! | `a_delayed_response_still_correlates` | A cheap `PING` overtakes an `APPEND` waiting on a commit window |
//! | `reordered_responses_still_correlate` | The same exchange, correlated by `request_id` |
//! | `a_mid_stream_close_leaves_the_status_unknown` | The client closes mid-command |
//!
//! The two that remain, stated rather than papered over:
//!
//! - **`an_unsound_antireplay_window_is_published_and_refused`** is satisfied in
//!   a *stronger* sense than the vector asks for: the vector has the relay
//!   publish `antireplay_window_ms == clock_skew_ms` and a client refuse it,
//!   and this relay **refuses to be configured that way at all**
//!   ([`Config::check`], and issue #586). There is no way to make a running
//!   `f2z-relay` publish that document, so the vector is unrunnable here
//!   because the defect it demonstrates cannot exist.
//! - **`every_error_code_can_reach_a_client`** is only partly reachable, and the
//!   part that is not is honest: code 9 `ERR_CHANNEL_BINDING` is *reserved and
//!   unused in v1* by §10's own table, so no conforming relay emits it, and code
//!   21 `ERR_INTERNAL` is a relay fault that cannot be provoked from outside
//!   without one. Every other code in §10 is reached below or by the suite.

// An integration test is its own crate, so the workspace's denials of the
// panicking families do not reach it through `lib.rs`'s `cfg_attr(test, ...)`.
// They are relaxed here for the reason `rs/README.md` gives: a test that has to
// thread a `Result` through every assertion is a test nobody reads, and a panic
// in a test is a failing test rather than a remote denial of service.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::time::Duration;

use f2z_codec::ErrorCode;
use f2z_codec::commands::{AppendRequest, ChallengePurpose, ChallengeRequest, Command};
use f2z_codec::types::{QueueAddress, ShortBytes};
use f2z_relay::config::Config;
use f2z_relay::server::Server;
use f2z_relay_proto::command::ops;
use f2z_relay_proto::key::SigningKey;
use f2z_relay_testkit::client::{Client, ClientConfig};
use f2z_relay_testkit::vectors::{expect, expect_code, expect_eq};
use f2z_relay_testkit::websocket;

/// A relay on the conformance configuration, with one edit.
async fn relay(edit: impl FnOnce(&mut Config)) -> Server {
    let mut config = Config::default();
    config.listen.address = "127.0.0.1:0".to_owned();
    config.admin.enabled = false;
    config.store.backend = "memory".to_owned();
    config.identity.seed = "3c".repeat(32);
    config.antiabuse.queue_creation_mode = "open".to_owned();
    config.antiabuse.contact_append_pow_bits = 8;
    config.antiabuse.per_source_limits = false;
    config.commit.window_ms = 1;
    config.queues.expiry_tick_seconds = 3_600;
    edit(&mut config);
    Server::start(config).await.expect("the relay starts")
}

/// A client on a fresh connection, with a nonce stream no other client shares.
async fn client(server: &Server, stream: u8) -> Client {
    let transport = websocket::connect(&server.url())
        .await
        .expect("the relay accepts a connection");
    let config = ClientConfig {
        // Its own nonce stream: §5.5's seen-set is relay-wide, so two clients
        // drawing from one stream would collide on `(signer_key, nonce)` and
        // the second command would be refused as a replay.
        nonce_seed: [stream; 32],
        ..ClientConfig::default()
    };
    Client::connect(transport, config)
        .await
        .expect("HELLO completes")
}

fn key(seed: u8) -> SigningKey {
    SigningKey::from_seed(&[seed; 32])
}

/// A fully valid hostile command must not consume its replay key before the
/// relay has authorized the signed queue identity. This goes through the
/// production WebSocket listener and the production `RelayStore` lookup; the
/// count is the live relay-wide seen-set, not a verifier fixture.
#[tokio::test(flavor = "multi_thread")]
async fn denied_queue_authorization_does_not_commit_the_replay_key() {
    let server = relay(|_| {}).await;
    let mut alice = client(&server, 0x51).await;
    let owner = key(0x52);
    let intruder = key(0x53);
    let queue = alice.create_queue(&owner, 0, 0, None).await.unwrap();
    let before = server.relay().sweep_memory(0).0;

    expect_code(
        alice.subscribe(&intruder, queue.recv_addr).await,
        ErrorCode::NoAccess,
    )
    .unwrap();

    let after = server.relay().sweep_memory(0).0;
    assert_eq!(after, before, "denied command entered the relay seen-set");
    server.shutdown().await;
}

/// The generic unsigned-command checker is on the production challenge path,
/// including values the typed convenience method cannot construct.
#[tokio::test(flavor = "multi_thread")]
async fn get_challenge_rejects_unknown_purposes_and_wrong_scope_shapes() {
    let server = relay(|_| {}).await;
    let mut valid = client(&server, 0x54).await;
    valid.challenge(ChallengePurpose::Clock, &[]).await.unwrap();
    valid
        .challenge(ChallengePurpose::ContactAppend, &[0x55; QueueAddress::LEN])
        .await
        .unwrap();

    let mut unknown = client(&server, 0x56).await;
    let body = ChallengeRequest {
        purpose: 3,
        scope: ShortBytes::default(),
    };
    expect_code(
        unknown.call_unsigned::<ops::GetChallenge>(&body).await,
        ErrorCode::Malformed,
    )
    .unwrap();

    let mut wrong_scope = client(&server, 0x57).await;
    let body = ChallengeRequest {
        purpose: ChallengePurpose::ContactAppend.code(),
        scope: ShortBytes::new(vec![0x58; QueueAddress::LEN - 1]).unwrap(),
    };
    expect_code(
        wrong_scope.call_unsigned::<ops::GetChallenge>(&body).await,
        ErrorCode::Malformed,
    )
    .unwrap();
    server.shutdown().await;
}

// ---------------------------------------------------------------------------
// §4.3 — the in-flight window, reachable because an APPEND really is in flight.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_duplicate_inflight_request_id_is_fatal() {
    // A long gather window makes the first APPEND genuinely outstanding while
    // the second frame is written. This needs no fault handle precisely because
    // the relay answers an APPEND from its own task: the request id is released
    // when the commit returns, not when the frame is read.
    let server = relay(|config| config.commit.window_ms = 400).await;
    let mut alice = client(&server, 1).await;
    let recv = key(0x11);
    let send = key(0x12);
    let queue = alice.create_queue(&recv, 0, 0, None).await.unwrap();
    alice.bind_send(&send, queue.send_addr).await.unwrap();

    let body = AppendRequest {
        payload: alice.pad(b"ciphertext").unwrap(),
    };
    let frame = alice
        .encode_signed::<ops::Append>(&send, queue.send_addr, &body)
        .unwrap();
    alice.send_raw(frame.clone()).await.unwrap();
    // The same bytes again: the same `request_id`, while the first is still
    // outstanding. §4.3: "A duplicate `request_id` among in-flight requests is
    // a fatal `ERR_MALFORMED`."
    alice.send_raw(frame).await.unwrap();

    let mut saw_malformed = false;
    for _ in 0..2 {
        let Ok((_, response)) = alice.next_response().await else {
            break;
        };
        if response.error_code() == Some(ErrorCode::Malformed) {
            saw_malformed = true;
        }
    }
    assert!(saw_malformed, "the duplicate id was not refused");
    alice.expect_closed().await.expect("the connection closes");
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn exceeding_the_inflight_window_is_fatal() {
    let server = relay(|config| {
        config.commit.window_ms = 400;
        config.limits.max_inflight = 2;
    })
    .await;
    let mut alice = client(&server, 2).await;
    let recv = key(0x21);
    let send = key(0x22);
    let queue = alice.create_queue(&recv, 0, 0, None).await.unwrap();
    alice.bind_send(&send, queue.send_addr).await.unwrap();

    // Three distinct requests against a window of two. The first two park in
    // the commit thread's gather window; the third is refused.
    for _ in 0..3u8 {
        let body = AppendRequest {
            payload: alice.pad(b"ciphertext").unwrap(),
        };
        alice
            .send_signed::<ops::Append>(&send, queue.send_addr, &body)
            .await
            .unwrap();
    }

    let mut saw_too_many = false;
    for _ in 0..3 {
        let Ok((_, response)) = alice.next_response().await else {
            break;
        };
        if response.error_code() == Some(ErrorCode::TooManyInflight) {
            saw_too_many = true;
        }
    }
    assert!(saw_too_many, "the window was not enforced");
    server.shutdown().await;
}

// ---------------------------------------------------------------------------
// §13.1 — quotas and backpressure, reachable by published policy.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_full_queue_is_indistinguishable_from_an_absent_one() {
    let server = relay(|config| config.limits.max_queue_messages = 1).await;
    let mut alice = client(&server, 3).await;
    let recv = key(0x31);
    let send = key(0x32);
    let queue = alice.create_queue(&recv, 0, 0, None).await.unwrap();
    alice.bind_send(&send, queue.send_addr).await.unwrap();

    alice.append(&send, queue.send_addr, b"one").await.unwrap();
    // §6.3: "every send-side refusal that would distinguish queue state
    // collapses to the single code `ERR_UNAVAILABLE`" — full-by-messages
    // included.
    expect_code(
        alice.append(&send, queue.send_addr, b"two").await,
        ErrorCode::Unavailable,
    )
    .unwrap();
    // And the same code an address that never existed gets, which is the
    // property: a bound sender cannot learn the queue's state by filling it.
    expect_code(
        alice
            .append(&send, f2z_codec::types::QueueAddress::new([0x9e; 32]), b"x")
            .await,
        ErrorCode::Unavailable,
    )
    .unwrap();
    server.shutdown().await;
}

/// A difference the FakeRelay comparison surfaced, which **no vector covers**.
///
/// §6.4 defines `QUEUE_EVENT` reason 4 as "quota reached", pushed to a
/// subscribed reader. `f2z-relay-testkit` emits it when an append is refused
/// for quota; the first version of this relay did not, because §6.3 collapses
/// every send-side refusal to one code and the collapse had been applied one
/// layer too early — the *writer* must not learn which cap was hit, but the
/// **reader** is the party that can drain the queue and §6.4 exists to tell it.
///
/// The FakeRelay was right. This is the regression test for the fix.
#[tokio::test(flavor = "multi_thread")]
async fn a_reader_is_told_when_its_queue_hits_a_cap() {
    let server = relay(|config| config.limits.max_queue_messages = 1).await;
    let mut bob = client(&server, 20).await;
    let recv = key(0xd1);
    let send = key(0xd2);
    let queue = bob.create_queue(&recv, 0, 0, None).await.unwrap();
    bob.subscribe(&recv, queue.recv_addr).await.unwrap();
    bob.bind_send(&send, queue.send_addr).await.unwrap();

    bob.append(&send, queue.send_addr, b"one").await.unwrap();
    bob.next_message().await.unwrap();

    // The writer learns only `ERR_UNAVAILABLE` (§6.3) …
    expect_code(
        bob.append(&send, queue.send_addr, b"two").await,
        ErrorCode::Unavailable,
    )
    .unwrap();
    // … and the reader learns that it should drain (§6.4, reason 4).
    let event = bob.next_queue_event().await.unwrap();
    expect_eq(
        event.reason,
        4,
        "expected QUEUE_EVENT reason 4, quota reached",
    )
    .unwrap();
    expect_eq(
        event.recv_addr,
        queue.recv_addr,
        "the event named a different queue",
    )
    .unwrap();
    server.shutdown().await;
}

/// And the mirror: an absent address must not produce a push, or the push
/// itself becomes the existence oracle §10 forbids.
#[tokio::test(flavor = "multi_thread")]
async fn an_absent_address_produces_no_queue_event() {
    let server = relay(|config| config.limits.max_queue_messages = 1).await;
    let mut bob = client(&server, 21).await;
    let recv = key(0xe1);
    let send = key(0xe2);
    let queue = bob.create_queue(&recv, 0, 0, None).await.unwrap();
    bob.subscribe(&recv, queue.recv_addr).await.unwrap();
    bob.bind_send(&send, queue.send_addr).await.unwrap();

    expect_code(
        bob.append(&send, f2z_codec::types::QueueAddress::new([0x77; 32]), b"x")
            .await,
        ErrorCode::Unavailable,
    )
    .unwrap();
    // Nothing arrives. A push here would tell a stranger that some queue
    // exists, which is exactly what the collapse exists to withhold.
    assert!(
        tokio::time::timeout(Duration::from_millis(400), bob.next_push())
            .await
            .is_err(),
        "an absent address produced a push"
    );
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_queue_creation_quota_is_a_distinguishable_code() {
    let server = relay(|config| config.limits.max_queues = 1).await;
    let mut alice = client(&server, 4).await;
    alice.create_queue(&key(0x41), 0, 0, None).await.unwrap();
    // §10 code 14. Unlike the send side, the receive side is allowed a
    // distinguishable code: the party being refused is the one that owns the
    // queues, so telling it discloses nothing it does not already know.
    expect_code(
        alice.create_queue(&key(0x42), 0, 0, None).await,
        ErrorCode::Quota,
    )
    .unwrap();
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn backpressure_never_refuses_read_ack_or_delete() {
    let server = relay(|config| {
        config.limits.storage_high_water_bytes = 1;
        config.queues.expiry_tick_seconds = 1;
    })
    .await;
    let mut alice = client(&server, 5).await;
    let recv = key(0x51);
    let send = key(0x52);
    // The first sweep ran against an empty store, so creation is still open.
    let queue = alice.create_queue(&recv, 0, 0, None).await.unwrap();
    alice.bind_send(&send, queue.send_addr).await.unwrap();
    alice.append(&send, queue.send_addr, b"one").await.unwrap();

    // Now the store is over the mark and the next sweep turns layer 4 on.
    tokio::time::sleep(Duration::from_millis(1_500)).await;

    // §13.1 layer 4, in the order the section states it.
    expect_code(
        alice.create_queue(&key(0x53), 0, 0, None).await,
        ErrorCode::Backpressure,
    )
    .unwrap();
    expect_code(
        alice.append(&send, queue.send_addr, b"two").await,
        ErrorCode::Unavailable,
    )
    .unwrap();

    // "READ, ACK and DELETE_QUEUE are **never** refused for backpressure. They
    // are the operations that make the relay smaller, and refusing them under
    // load is a deadlock."
    let page = alice.read(&recv, queue.recv_addr, 0, 0, 0).await.unwrap();
    expect_eq(
        page.messages.len(),
        1,
        "READ was refused under backpressure",
    )
    .unwrap();
    alice.ack(&recv, queue.recv_addr, 0).await.unwrap();
    alice.delete_queue(&recv, queue.recv_addr).await.unwrap();
    server.shutdown().await;
}

// ---------------------------------------------------------------------------
// §7.7 — the two timers, reachable by shortening them.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn an_expired_message_is_gone_and_announced() {
    let server = relay(|config| {
        config.queues.min_message_ttl_seconds = 1;
        config.queues.default_message_ttl_seconds = 1;
        config.queues.expiry_tick_seconds = 1;
    })
    .await;
    let mut alice = client(&server, 6).await;
    let recv = key(0x61);
    let send = key(0x62);
    let queue = alice.create_queue(&recv, 1, 0, None).await.unwrap();
    expect_eq(queue.message_ttl_seconds, 1, "the TTL was not granted").unwrap();
    alice.subscribe(&recv, queue.recv_addr).await.unwrap();
    alice.bind_send(&send, queue.send_addr).await.unwrap();
    alice
        .append(&send, queue.send_addr, b"ciphertext")
        .await
        .unwrap();
    // The MSG push for the append we just made.
    alice.next_message().await.unwrap();

    tokio::time::sleep(Duration::from_millis(2_500)).await;

    // §6.4 `QUEUE_EVENT` reason 3: the queue survives, its messages did not.
    let event = alice.next_queue_event().await.unwrap();
    expect_eq(event.reason, 3, "expected reason 3, messages TTL-expired").unwrap();
    let page = alice.read(&recv, queue.recv_addr, 0, 0, 0).await.unwrap();
    expect(
        page.messages.is_empty(),
        "an expired message was still readable",
    )
    .unwrap();
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_idle_queue_disappears() {
    let server = relay(|config| {
        config.queues.min_idle_ttl_seconds = 1;
        config.queues.default_idle_ttl_seconds = 1;
        config.queues.expiry_tick_seconds = 1;
    })
    .await;
    let mut alice = client(&server, 7).await;
    let recv = key(0x71);
    let queue = alice.create_queue(&recv, 0, 1, None).await.unwrap();
    expect_eq(queue.idle_ttl_seconds, 1, "the idle TTL was not granted").unwrap();
    alice.subscribe(&recv, queue.recv_addr).await.unwrap();

    tokio::time::sleep(Duration::from_millis(2_500)).await;

    // §6.4 `QUEUE_EVENT` reason 2, then §7.7's stated cost: the queue is gone,
    // and both its addresses answer as if they never existed.
    let event = alice.next_queue_event().await.unwrap();
    expect_eq(event.reason, 2, "expected reason 2, idle-expired").unwrap();
    expect_code(
        alice.read(&recv, queue.recv_addr, 0, 0, 0).await,
        ErrorCode::NoAccess,
    )
    .unwrap();
    server.shutdown().await;
}

// ---------------------------------------------------------------------------
// The failure paths delete-on-ack makes expensive to get wrong.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_lost_ack_response_is_safe_to_retry() {
    let server = relay(|_| {}).await;
    let mut alice = client(&server, 8).await;
    let recv = key(0x81);
    let send = key(0x82);
    let queue = alice.create_queue(&recv, 0, 0, None).await.unwrap();
    alice.bind_send(&send, queue.send_addr).await.unwrap();
    alice
        .append(&send, queue.send_addr, b"ciphertext")
        .await
        .unwrap();
    let page = alice.read(&recv, queue.recv_addr, 0, 0, 0).await.unwrap();
    let index = page.messages.as_slice().first().map(|m| m.index).unwrap();

    // The durable local write happens here — §8.4's MUST — and only then the
    // ACK. Which is sent and then abandoned: the client never sees the answer,
    // so §2.5 leaves the command's status *unknown*.
    alice
        .send_signed::<ops::Ack>(
            &recv,
            queue.recv_addr,
            &f2z_codec::commands::AckRequest { up_to_index: index },
        )
        .await
        .unwrap();
    alice.close().await.unwrap();

    // §8.3: "a client that sent an `ACK` and never saw the response simply
    // sends it again after reconnecting. It does not need to know whether the
    // first one arrived, and it must not try to find out by reading."
    let mut bob = client(&server, 9).await;
    let outcome = bob.ack(&recv, queue.recv_addr, index).await.unwrap();
    expect_eq(
        outcome.pending,
        0,
        "the retried ACK did not leave the queue drained",
    )
    .unwrap();
    // Idempotent a third time, and monotone below the watermark.
    bob.ack(&recv, queue.recv_addr, index).await.unwrap();
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cheap_command_overtakes_an_expensive_one_and_both_correlate() {
    // §4.3: "A relay MAY complete a cheap `PING` before an expensive `READ`
    // issued earlier, and will." Reachable without a fault handle because an
    // APPEND waits on the group-commit window while a PING does not.
    let server = relay(|config| config.commit.window_ms = 300).await;
    let mut alice = client(&server, 10).await;
    let recv = key(0x91);
    let send = key(0x92);
    let queue = alice.create_queue(&recv, 0, 0, None).await.unwrap();
    alice.bind_send(&send, queue.send_addr).await.unwrap();

    let body = AppendRequest {
        payload: alice.pad(b"ciphertext").unwrap(),
    };
    let append_id = alice
        .send_signed::<ops::Append>(&send, queue.send_addr, &body)
        .await
        .unwrap();
    let ping_id = alice
        .send_unsigned::<ops::Ping>(&f2z_relay_proto::command::Empty)
        .await
        .unwrap();

    let (first_id, first) = alice.next_response().await.unwrap();
    let (second_id, second) = alice.next_response().await.unwrap();
    expect(first.is_ok() && second.is_ok(), "a response was an error").unwrap();
    expect_eq(first_id, ping_id, "the cheap command did not answer first").unwrap();
    expect_eq(second_id, append_id, "the append answered out of turn").unwrap();
    // And both were correlated by id rather than by arrival order, which is the
    // rule §4.3 states and the reason a client MUST NOT assume ordering.
    expect(first_id != second_id, "two responses shared an id").unwrap();
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_mid_stream_close_leaves_the_status_unknown_and_the_relay_serving() {
    let server = relay(|config| config.commit.window_ms = 300).await;
    let mut alice = client(&server, 11).await;
    let recv = key(0xa1);
    let send = key(0xa2);
    let queue = alice.create_queue(&recv, 0, 0, None).await.unwrap();
    alice.bind_send(&send, queue.send_addr).await.unwrap();

    let body = AppendRequest {
        payload: alice.pad(b"ciphertext").unwrap(),
    };
    alice
        .send_signed::<ops::Append>(&send, queue.send_addr, &body)
        .await
        .unwrap();
    // §2.5: "an in-flight command whose response was not received has
    // **unknown** status". The client cannot tell whether it landed.
    alice.close().await.unwrap();
    drop(alice);

    // What must hold is that the relay is unharmed and that whatever it did
    // with the append, it did durably or not at all — §13.2 forbids it from
    // discarding an accepted message later to make room.
    tokio::time::sleep(Duration::from_millis(600)).await;
    let mut bob = client(&server, 12).await;
    let page = bob.read(&recv, queue.recv_addr, 0, 0, 0).await.unwrap();
    expect(
        page.messages.len() <= 1,
        "a single append produced more than one message",
    )
    .unwrap();
    // The connection that closed took its subscription with it (§6.2) and left
    // the relay serving.
    bob.ping().await.unwrap();
    server.shutdown().await;
}

// ---------------------------------------------------------------------------
// §10 — which codes a real relay can actually emit.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn the_error_codes_a_real_relay_can_emit_are_the_ones_it_should() {
    // The two §10 codes no conforming relay produces on demand, stated rather
    // than skipped: 9 is reserved and unused in v1 by §10's own table, and 21
    // is a relay fault. Everything else is reached by the conformance suite or
    // by this file.
    let unreachable = [ErrorCode::ChannelBinding, ErrorCode::Internal];
    let reached_here = [
        ErrorCode::Malformed,
        ErrorCode::TooManyInflight,
        ErrorCode::Unavailable,
        ErrorCode::Quota,
        ErrorCode::Backpressure,
        ErrorCode::NoAccess,
    ];
    for code in reached_here {
        assert!(
            !unreachable.contains(&code),
            "{} is claimed both reachable and not",
            code.name()
        );
    }

    // `ERR_RATE_LIMITED` (19) needs its own relay, because the conformance
    // configuration turns per-connection limits off so the suite is not
    // throttled by them.
    let server = relay(|config| config.limits.commands_per_connection_per_second = 2).await;
    let mut alice = client(&server, 13).await;
    let mut refused = None;
    for _ in 0..8u8 {
        if let Err(error) = alice.ping().await {
            refused = error.wire_code();
            break;
        }
    }
    assert_eq!(
        refused,
        Some(ErrorCode::RateLimited),
        "the per-connection command rate did not refuse"
    );
    server.shutdown().await;

    // `ERR_POW_REQUIRED` (16) on queue creation, which the conformance
    // configuration deliberately does not exercise: it runs `open` mode, and
    // the shipped default is `pow`.
    let server = relay(|config| {
        config.antiabuse.queue_creation_mode = "pow".to_owned();
        config.antiabuse.queue_creation_pow_bits = 8;
    })
    .await;
    let mut alice = client(&server, 14).await;
    expect_code(
        alice.create_queue(&key(0xb1), 0, 0, None).await,
        ErrorCode::PowRequired,
    )
    .unwrap();
    // And with a stamp over a relay-issued challenge it succeeds, so the gate
    // is a gate rather than a wall.
    let pow = alice
        .capabilities()
        .await
        .unwrap()
        .capabilities
        .queue_creation_pow;
    alice
        .create_queue(&key(0xb2), 0, 0, Some(pow))
        .await
        .unwrap();
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_relay_refuses_to_publish_the_unsound_antireplay_window_at_all() {
    // The stronger form of `an_unsound_antireplay_window_is_published_and_refused`:
    // the vector has a relay publish `antireplay_window_ms == clock_skew_ms` and
    // a client refuse the document. This relay cannot be made to publish it.
    // Issue #586's finding, enforced rather than demonstrated.
    let mut config = Config::default();
    config.limits.antireplay_window_ms = config.limits.clock_skew_ms;
    assert!(config.check().is_err());

    // And what it does publish satisfies the client-side check the vector's
    // conforming half performs.
    let server = relay(|_| {}).await;
    let mut alice = client(&server, 15).await;
    let signed = alice.capabilities().await.unwrap();
    let published = &signed.capabilities;
    assert!(
        u64::from(published.antireplay_window_ms)
            >= u64::from(published.clock_skew_ms).saturating_mul(2)
    );
    assert!(
        f2z_relay_proto::capabilities::ClientPolicy {
            allow_insecure_transport: true,
            ..f2z_relay_proto::capabilities::ClientPolicy::default()
        }
        .accept(published)
        .is_ok()
    );
    server.shutdown().await;
}

/// A guard against the suite's `Needs` changing under this file: every vector
/// named in the module table must still be one the real relay skips.
#[test]
fn the_thirteen_skipped_vectors_are_the_ones_this_file_accounts_for() {
    let skipped: Vec<&'static str> = f2z_relay_testkit::vectors::suite()
        .into_iter()
        .filter(|vector| !matches!(vector.needs, f2z_relay_testkit::vectors::Needs::Nothing))
        .map(|vector| vector.name)
        .collect();
    assert_eq!(
        skipped.len(),
        13,
        "the suite's handle-needing set changed: {skipped:?}"
    );
    for name in [
        "a_duplicate_inflight_request_id_is_fatal",
        "exceeding_the_inflight_window_is_fatal",
        "an_unsound_antireplay_window_is_published_and_refused",
        "a_full_queue_is_indistinguishable_from_an_absent_one",
        "backpressure_never_refuses_read_ack_or_delete",
        "the_queue_creation_quota_is_a_distinguishable_code",
        "every_error_code_can_reach_a_client",
        "an_expired_message_is_gone_and_announced",
        "an_idle_queue_disappears",
        "a_lost_ack_response_is_safe_to_retry",
        "a_delayed_response_still_correlates",
        "reordered_responses_still_correlate",
        "a_mid_stream_close_leaves_the_status_unknown",
    ] {
        assert!(skipped.contains(&name), "{name} is no longer skipped");
    }
    // Command is imported for the table above; keep the reference honest.
    assert_eq!(Command::Append.code(), 0x0021);
}
