//! Every fault mode, fired on demand, in one place.
//!
//! The conformance suite exercises these as *rules*; this file exercises them
//! as *controls*, so a client developer can see what each one does before
//! reaching for it. Under delete-on-ack the failure paths are where data loss
//! lives, and a client that has never seen a dropped `ACK` response has never
//! been tested on the case that costs a user their messages.

// An integration test is its own crate, so the workspace's `panic`/`unwrap`/
// `expect` denials — written for a relay's unauthenticated request path — apply
// here too. A test that cannot assert is not a test, so they are lifted for
// this file and nowhere else.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]
use std::time::Duration;

use f2z_codec::ErrorCode;
use f2z_codec::commands::Command;
use f2z_relay_proto::capabilities::ClientPolicy;
use f2z_relay_proto::key::SigningKey;
use f2z_relay_testkit::client::Client;
use f2z_relay_testkit::error::TestkitError;
use f2z_relay_testkit::fake::FakeRelay;
use f2z_relay_testkit::faults::{Effect, Fault, PolicyFaults, Trigger};

async fn queue(
    relay: &FakeRelay,
    seed: u8,
) -> (
    Client,
    SigningKey,
    Client,
    SigningKey,
    f2z_codec::commands::CreateQueueResponse,
) {
    let mut recv = relay.client().await.expect("connects");
    let recv_key = SigningKey::from_seed(&[seed; 32]);
    let created = recv
        .create_queue(&recv_key, 0, 0, None)
        .await
        .expect("CREATE_QUEUE");
    let mut send = relay.client().await.expect("connects");
    let send_key = SigningKey::from_seed(&[seed.wrapping_add(1); 32]);
    send.bind_send(&send_key, created.send_addr)
        .await
        .expect("BIND_SEND");
    (recv, recv_key, send, send_key, created)
}

#[tokio::test(flavor = "multi_thread")]
async fn drop_a_response() {
    let relay = FakeRelay::with_defaults().expect("configurable");
    let (mut recv, recv_key, mut send, send_key, created) = queue(&relay, 0x10).await;
    send.append(&send_key, created.send_addr, b"m")
        .await
        .expect("APPEND");

    relay
        .faults()
        .arm(Fault::once(Trigger::Command(Command::Ack), Effect::Drop));
    recv.set_read_timeout(Duration::from_millis(200));
    let lost = recv.ack(&recv_key, created.recv_addr, 0).await;
    assert!(
        matches!(lost, Err(TestkitError::Timeout)),
        "a dropped response is an unknown outcome (§2.5), not a refusal"
    );

    // The command ran. §8.3: the retry is a safe no-op, which is what makes the
    // connection-loss case tractable at all.
    let mut again = relay.client().await.expect("connects");
    let outcome = again
        .ack(&recv_key, created.recv_addr, 0)
        .await
        .expect("the retry is safe");
    assert_eq!(outcome.pending, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn delay_a_response_without_blocking_the_ones_behind_it() {
    let relay = FakeRelay::with_defaults().expect("configurable");
    let mut client = relay.client().await.expect("connects");
    relay.faults().arm(Fault::once(
        Trigger::Command(Command::GetCapabilities),
        Effect::Delay(Duration::from_millis(150)),
    ));
    let slow = client
        .send_unsigned::<f2z_relay_proto::command::ops::GetCapabilities>(&Default::default())
        .await
        .expect("send");
    let quick = client
        .send_unsigned::<f2z_relay_proto::command::ops::Ping>(&Default::default())
        .await
        .expect("send");

    let (first, _) = client.next_response().await.expect("a response");
    let (second, _) = client.next_response().await.expect("a response");
    assert_eq!(first, quick, "§4.3: a cheap command may overtake, and will");
    assert_eq!(second, slow);
}

#[tokio::test(flavor = "multi_thread")]
async fn reorder_two_responses() {
    let relay = FakeRelay::with_defaults().expect("configurable");
    let mut client = relay.client().await.expect("connects");
    relay.faults().arm(Fault::once(
        Trigger::Command(Command::GetCapabilities),
        Effect::Reorder,
    ));
    let held = client
        .send_unsigned::<f2z_relay_proto::command::ops::GetCapabilities>(&Default::default())
        .await
        .expect("send");
    let overtaking = client
        .send_unsigned::<f2z_relay_proto::command::ops::Ping>(&Default::default())
        .await
        .expect("send");
    let (first, _) = client.next_response().await.expect("a response");
    let (second, _) = client.next_response().await.expect("a response");
    assert_eq!(first, overtaking);
    assert_eq!(second, held);
}

#[tokio::test(flavor = "multi_thread")]
async fn close_the_connection_mid_stream() {
    let relay = FakeRelay::with_defaults().expect("configurable");
    let (recv, recv_key, mut send, send_key, created) = queue(&relay, 0x20).await;
    drop(recv);

    relay.faults().arm(Fault::once(
        Trigger::Command(Command::Append),
        Effect::CloseBefore,
    ));
    send.set_read_timeout(Duration::from_millis(250));
    let outcome = send.append(&send_key, created.send_addr, b"m").await;
    assert!(matches!(
        outcome,
        Err(TestkitError::Closed | TestkitError::Timeout)
    ));

    // The append applied even though its answer was never delivered. §8.3:
    // APPEND is not idempotent at the relay, which is why deduplication lives
    // end-to-end at `msg_id`.
    let mut reader = relay.client().await.expect("connects");
    let read = reader
        .read(&recv_key, created.recv_addr, 0, 0, 0)
        .await
        .expect("READ");
    assert_eq!(read.messages.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn stall_an_ack_forever() {
    let relay = FakeRelay::with_defaults().expect("configurable");
    let (mut recv, recv_key, mut send, send_key, created) = queue(&relay, 0x30).await;
    send.append(&send_key, created.send_addr, b"m")
        .await
        .expect("APPEND");

    relay
        .faults()
        .arm(Fault::always(Trigger::Command(Command::Ack), Effect::Stall));
    recv.set_read_timeout(Duration::from_millis(200));
    let stalled = recv.ack(&recv_key, created.recv_addr, 0).await;
    assert!(matches!(stalled, Err(TestkitError::Timeout)));

    // A stalled response keeps its `request_id` outstanding, so a client that
    // never gives up fills §4.3's window and earns a fatal
    // ERR_TOO_MANY_INFLIGHT rather than hanging forever.
    let capabilities = relay.published_capabilities();
    for _ in 0..capabilities.max_inflight {
        let _ = recv.ack(&recv_key, created.recv_addr, 0).await;
    }
    let overflow = recv.ack(&recv_key, created.recv_addr, 0).await;
    assert!(
        overflow.is_err(),
        "the in-flight window must eventually refuse"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn refuse_an_append_with_every_error_code() {
    // §10's codes are stable forever and a client has to handle all of them,
    // including the ones a healthy relay never emits on this command.
    let relay = FakeRelay::with_defaults().expect("configurable");
    for code in ErrorCode::ALL {
        let (_recv, _recv_key, mut send, send_key, created) = queue(&relay, 0x40).await;
        relay.faults().arm(Fault::once(
            Trigger::Command(Command::Append),
            Effect::Refuse(code),
        ));
        let refused = send.append(&send_key, created.send_addr, b"m").await;
        assert_eq!(
            refused.as_ref().err().and_then(TestkitError::wire_code),
            Some(code),
            "the injector must be able to produce {}",
            code.name()
        );
        if code.is_fatal() {
            send.expect_closed().await.expect("§1.3: then close");
        }
        relay.faults().disarm();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_append_did_not_append() {
    // The refusal is applied before the command runs, which is the only reading
    // that makes `Effect::Refuse` usable: a fake that refused *after* mutating
    // would teach a client that ERR_UNAVAILABLE means "not stored" when it did
    // not.
    let relay = FakeRelay::with_defaults().expect("configurable");
    let (mut recv, recv_key, mut send, send_key, created) = queue(&relay, 0x50).await;
    relay.faults().arm(Fault::once(
        Trigger::Command(Command::Append),
        Effect::Refuse(ErrorCode::Unavailable),
    ));
    let _ = send.append(&send_key, created.send_addr, b"m").await;
    let read = recv
        .read(&recv_key, created.recv_addr, 0, 0, 0)
        .await
        .expect("READ");
    assert_eq!(read.messages.len(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn expire_a_ttl_early() {
    let relay = FakeRelay::with_defaults().expect("configurable");
    let (mut recv, recv_key, mut send, send_key, created) = queue(&relay, 0x60).await;
    recv.subscribe(&recv_key, created.recv_addr)
        .await
        .expect("SUBSCRIBE");
    send.append(&send_key, created.send_addr, b"perishable")
        .await
        .expect("APPEND");
    let _ = recv.next_message().await.expect("MSG push");

    relay.faults().set_policy(PolicyFaults {
        expire_messages_after: Some(Duration::ZERO),
        max_queue_messages: Some(1),
        ..PolicyFaults::default()
    });
    let read = recv
        .read(&recv_key, created.recv_addr, 0, 0, 0)
        .await
        .expect("READ");
    assert_eq!(read.messages.len(), 0, "§7.7: the message TTL fired");
    let event = recv.next_queue_event().await.expect("QUEUE_EVENT push");
    assert_eq!(event.reason, 3, "reason 3 is 'messages TTL-expired'");

    // Expiry removed storage, not queue history. A fresh subscription sees the
    // next assigned index and the unacknowledged index span, exactly as the
    // production relay does; neither value is derived from the now-empty read.
    let mut again = relay.client().await.expect("reconnects");
    let state = again
        .subscribe(&recv_key, created.recv_addr)
        .await
        .expect("re-SUBSCRIBE");
    assert_eq!(state.next_index, 1);
    assert_eq!(state.pending, 1);

    // The wire backlog is an index span, but storage quota is not. Expiring
    // the only stored ciphertext frees the one-message cap even though the
    // unacknowledged historical index remains pending.
    send.append(&send_key, created.send_addr, b"replacement")
        .await
        .expect("TTL expiry frees stored-message quota");
}

#[tokio::test(flavor = "multi_thread")]
async fn expire_a_queue_by_moving_the_clock() {
    let relay = FakeRelay::with_defaults().expect("configurable");
    let mut client = relay.client().await.expect("connects");
    let key = SigningKey::from_seed(&[0x70; 32]);
    let created = client
        .create_queue(&key, 0, 3_600, None)
        .await
        .expect("CREATE_QUEUE");

    // §7.7's honest cost: a device offline longer than the idle TTL loses its
    // queues, and its peers' adverts become dead addresses.
    relay
        .clock()
        .advance(u64::from(created.idle_ttl_seconds).saturating_mul(1_000) + 1_000);
    client.resync_clock().await.expect("§5.5's clock read");
    let gone = client.read(&key, created.recv_addr, 0, 0, 0).await;
    assert_eq!(
        gone.err().and_then(|error| error.wire_code()),
        Some(ErrorCode::NoAccess)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn hit_a_quota() {
    let relay = FakeRelay::with_defaults().expect("configurable");

    // The send-side cap collapses to ERR_UNAVAILABLE (§6.3): if a full queue
    // and an absent one differed, a bound sender could learn the depth by
    // filling it.
    let (_recv, _recv_key, mut send, send_key, created) = queue(&relay, 0x80).await;
    relay.faults().set_policy(PolicyFaults {
        max_queue_messages: Some(1),
        ..PolicyFaults::default()
    });
    send.append(&send_key, created.send_addr, b"first")
        .await
        .expect("the first fits");
    let full = send.append(&send_key, created.send_addr, b"second").await;
    assert_eq!(
        full.err().and_then(|error| error.wire_code()),
        Some(ErrorCode::Unavailable)
    );

    // The recv-side creation quota is allowed to say what happened: the party
    // refused is the one that owns the queues.
    relay.faults().set_policy(PolicyFaults {
        max_queues: Some(0),
        ..PolicyFaults::default()
    });
    let mut creator = relay.client().await.expect("connects");
    let key = SigningKey::from_seed(&[0x81; 32]);
    let refused = creator.create_queue(&key, 0, 0, None).await;
    assert_eq!(
        refused.err().and_then(|error| error.wire_code()),
        Some(ErrorCode::Quota)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn force_the_capability_document_violation_from_586() {
    // https://github.com/free2z/zuu/issues/586 §1: `WIRE.md` §11.1 publishes
    // `antireplay_window_ms` and `clock_skew_ms` as independent fields and
    // relates them nowhere, so a relay may publish a seen-set retention shorter
    // than the replay window its own timestamp policy creates — and be fully
    // conforming while it does.
    let relay = FakeRelay::with_defaults().expect("configurable");
    relay.faults().set_policy(PolicyFaults {
        unsound_antireplay_window: true,
        ..PolicyFaults::default()
    });

    let mut client = relay.client().await.expect("connects");
    let signed = client.capabilities().await.expect("GET_CAPABILITIES");
    let published = &signed.capabilities;
    assert!(
        u64::from(published.antireplay_window_ms)
            < u64::from(published.clock_skew_ms).saturating_mul(2),
        "the fault must publish the violating relation, not just behave badly"
    );

    // Half one: the document is *valid*. That is the defect.
    f2z_relay_proto::capabilities::validate(published).expect("the spec permits this document");

    // Half two: a client that checks the relation refuses, and the check is on
    // by default.
    let policy = ClientPolicy {
        allow_insecure_transport: true,
        ..ClientPolicy::default()
    };
    let refusal = policy.accept(published).expect_err("a client must refuse");
    assert!(
        matches!(
            refusal,
            f2z_relay_proto::ProtoError::Refused(
                f2z_relay_proto::Refusal::AntiReplayWindowTooShort
            )
        ),
        "expected AntiReplayWindowTooShort, got {refusal}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_fault_can_be_armed_mid_conversation_and_disarmed_again() {
    let relay = FakeRelay::with_defaults().expect("configurable");
    let mut client = relay.client().await.expect("connects");
    client.ping().await.expect("healthy");

    relay.faults().arm(Fault::times(
        Trigger::Command(Command::Ping),
        Effect::Refuse(ErrorCode::RateLimited),
        2,
    ));
    for _ in 0..2 {
        let refused = client.ping().await;
        assert_eq!(
            refused.err().and_then(|error| error.wire_code()),
            Some(ErrorCode::RateLimited)
        );
    }
    // The rule retired itself after its two firings.
    client.ping().await.expect("healthy again");
    assert_eq!(relay.faults().armed(), 0);
}
