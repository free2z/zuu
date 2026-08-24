//! The worked example: two clients, one real socket, and the delete observed.
//!
//! This is the flow a client developer has to get right before anything else
//! works, driven end to end over `ws://127.0.0.1:0` — a real TCP accept, a real
//! RFC 6455 upgrade with the mandatory subprotocol, real binary frames:
//!
//! ```text
//!   Bob   CREATE_QUEUE                       → (recv_addr, send_addr)
//!   Bob   SUBSCRIBE   recv_addr
//!   Alice BIND_SEND   send_addr  (fresh key) → empty, once and forever
//!   Alice APPEND      send_addr              → empty; no index, no depth
//!   Bob   ← MSG push
//!   Bob   READ        recv_addr              → the ciphertext, unchanged
//!   Bob   (durable write)                    ← the §8.4 MUST happens here
//!   Bob   ACK         recv_addr, index
//!   Bob   READ        recv_addr              → empty: the relay deleted it
//!   Bob   DELETE_QUEUE
//!   Alice APPEND                             → ERR_UNAVAILABLE
//! ```
//!
//! Run it with `cargo test -p f2z-relay-testkit --test worked_example -- --nocapture`
//! to watch it narrate.

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
use f2z_codec::ErrorCode;
use f2z_relay_proto::key::SigningKey;
use f2z_relay_testkit::client::Client;
use f2z_relay_testkit::config::RelayConfig;
use f2z_relay_testkit::fake::FakeRelay;
use f2z_relay_testkit::websocket;

#[tokio::test(flavor = "multi_thread")]
async fn create_bind_append_read_ack_delete_over_a_real_socket() {
    // A wall-clock relay, as `f2z-fakerelay` runs, so nothing about this
    // example depends on a frozen clock.
    let relay = FakeRelay::new(RelayConfig::default().with_system_clock())
        .expect("a default relay is configurable");
    let server = relay.listen_loopback().await.expect("binds 127.0.0.1:0");
    let url = server.url();
    println!("relay listening at {url}");
    println!("  relay_id      {:?}", relay.relay_id());
    println!(
        "  transport     ws:// — transport_security: none, channel_binding_mode: none (WIRE.md §2.3)"
    );

    // -- Bob creates the queue. §7.1: the recipient creates it, and the relay
    //    generates both addresses from its own CSPRNG.
    let mut bob = connect(&url, &relay).await;
    let bob_key = SigningKey::from_seed(&[0xb0; 32]);
    let queue = bob
        .create_queue(&bob_key, 0, 0, None)
        .await
        .expect("CREATE_QUEUE");
    println!(
        "CREATE_QUEUE  → message_ttl {}s, idle_ttl {}s (granted after clamping, §7.7)",
        queue.message_ttl_seconds, queue.idle_ttl_seconds
    );
    assert_ne!(queue.recv_addr, queue.send_addr);

    let subscribed = bob
        .subscribe(&bob_key, queue.recv_addr)
        .await
        .expect("SUBSCRIBE");
    println!(
        "SUBSCRIBE     → next_index {}, pending {}",
        subscribed.next_index, subscribed.pending
    );

    // -- Alice binds the send side. §7.2 has `send_addr` reach her in-band,
    //    inside the MLS group; the relay never sees that advert.
    let mut alice = connect(&url, &relay).await;
    let alice_key = SigningKey::from_seed(&[0xa1; 32]);
    alice
        .bind_send(&alice_key, queue.send_addr)
        .await
        .expect("BIND_SEND");
    println!("BIND_SEND     → empty response, once and forever (§7.3)");

    // §7.4: a second bind is ERR_ALREADY_BOUND, and on a *first* attempt for a
    // fresh advert that is a loud, non-dismissible failure — the relay operator
    // may have read `send_addr` out of its own database and bound first.
    let stolen = alice.bind_send(&alice_key, queue.send_addr).await;
    assert_eq!(
        stolen.err().and_then(|e| e.wire_code()),
        Some(ErrorCode::AlreadyBound)
    );
    println!("BIND_SEND #2  → ERR_ALREADY_BOUND (§7.4: noisy, not prevented)");

    // -- Alice appends. §6.3: the response carries no index, no depth, no
    //    timestamp and no queue state of any kind.
    alice
        .append(&alice_key, queue.send_addr, b"ciphertext")
        .await
        .expect("APPEND");
    println!("APPEND        → empty response: no index, no depth, no timestamp (§6.3)");

    // -- Bob gets the push, then reads.
    let push = bob.next_message().await.expect("MSG push");
    assert_eq!(push.recv_addr, queue.recv_addr);
    println!(
        "← MSG push    → index {} (§6.4, receive side only)",
        push.msg.index
    );

    let read = bob
        .read(&bob_key, queue.recv_addr, 0, 0, 0)
        .await
        .expect("READ");
    assert_eq!(read.messages.len(), 1);
    let index = read.messages.as_slice().first().expect("one message").index;
    println!(
        "READ          → 1 message at index {index}, has_more {}",
        read.has_more
    );

    // READ never mutates: the same read twice returns the same thing.
    let again = bob
        .read(&bob_key, queue.recv_addr, 0, 0, 0)
        .await
        .expect("READ again");
    assert_eq!(again.messages.len(), 1, "READ must not consume (§6.2)");

    // -- The durable write goes HERE. §8.4 and CLIENT-CONTRACT.md §9 rule 1: a
    //    device MUST NOT send ACK before its durable local write has completed,
    //    because the relay deletes on ACK and ACK-on-read plus a crash is
    //    permanent message loss.
    let durably_written = read.messages.as_slice().first().map(|m| m.payload.len());
    assert_eq!(durably_written, Some(1024), "padded to a bucket (§9)");
    println!("(durable write completes — the §8.4 MUST)");

    let acked = bob
        .ack(&bob_key, queue.recv_addr, index)
        .await
        .expect("ACK");
    println!(
        "ACK           → next_index {}, pending {}",
        acked.next_index, acked.pending
    );
    assert_eq!(acked.pending, 0);

    // -- The delete, observed.
    let after = bob
        .read(&bob_key, queue.recv_addr, 0, 0, 0)
        .await
        .expect("READ after ACK");
    assert_eq!(
        after.messages.len(),
        0,
        "the relay deletes at the instant of ACK (§8.1, §8.4 queue-delivered)"
    );
    println!("READ          → 0 messages: the ciphertext is gone (§8.1)");

    // §8.2: and the reader still cannot pre-ack the queue it just drained.
    let preack = bob.ack(&bob_key, queue.recv_addr, u64::MAX).await;
    assert_eq!(
        preack.err().and_then(|e| e.wire_code()),
        Some(ErrorCode::AckTooHigh)
    );
    println!("ACK u64::MAX  → ERR_ACK_TOO_HIGH (§8.2: no pre-acking)");

    // -- Bob retires the queue. §7.6: no observable tombstone.
    bob.delete_queue(&bob_key, queue.recv_addr)
        .await
        .expect("DELETE_QUEUE");
    println!("DELETE_QUEUE  → empty response, irreversible (§7.6)");

    let event = bob.next_queue_event().await.expect("QUEUE_EVENT push");
    assert_eq!(event.reason, 1, "reason 1 is 'deleted' (§6.4)");
    println!("← QUEUE_EVENT → reason 1 (deleted)");

    // The sender learns nothing except that its next APPEND fails.
    let orphaned = alice.append(&alice_key, queue.send_addr, b"too late").await;
    assert_eq!(
        orphaned.err().and_then(|e| e.wire_code()),
        Some(ErrorCode::Unavailable)
    );
    println!("APPEND        → ERR_UNAVAILABLE (§6.3: the collapse, so no state leaks)");

    // And the receive side is indistinguishable from an address that never was.
    let gone = bob.read(&bob_key, queue.recv_addr, 0, 0, 0).await;
    assert_eq!(
        gone.err().and_then(|e| e.wire_code()),
        Some(ErrorCode::NoAccess)
    );
    println!("READ          → ERR_NO_ACCESS, same as an address that never existed (§10)");

    server.shutdown().await;
}

async fn connect(url: &str, relay: &FakeRelay) -> Client {
    let transport = websocket::connect(url)
        .await
        .expect("the WebSocket upgrade");
    Client::connect(transport, relay.client_config())
        .await
        .expect("HELLO, relay_proof, and the relay_id comparison")
}
