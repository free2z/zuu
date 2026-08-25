//! **Two independent instances exchange a message over a real relay.**
//!
//! This is the acceptance criterion for the plugin, and it is written to be
//! hard to satisfy accidentally:
//!
//! * **Two processes.** `f2zmsg-peer` is spawned twice. The two engines share
//!   no allocator, no runtime, no clock and no store — each has its own SQLite
//!   file and its own CSPRNG-generated device keys. Two engines in one process
//!   would pass this test while a store or a group registry was accidentally
//!   shared, and nothing would notice.
//! * **A real relay over a real socket.** `FakeRelay::listen_loopback` serves
//!   `ws://127.0.0.1:0` through the same `connection::drive` and `engine::Relay`
//!   its in-process transport uses, so framing, ordering and reconnection are
//!   exercised rather than assumed. The peers reach it over TCP from outside
//!   this process.
//! * **The shipping path.** `start_conversation` and `accept_contact_request`
//!   are the plugin's own, unchanged. `CREATE_CONTACT_QUEUE`, `CONTACT_APPEND`
//!   with a proof-of-work stamp, `CREATE_QUEUE`, `SUBSCRIBE`, `BIND_SEND`,
//!   `APPEND`, `READ` and `ACK` all really happen, and the ciphertext is a real
//!   MLS `PrivateMessage` under `MLS_256_XWING_CHACHA20POLY1305_SHA256_Ed25519`.
//!
//! One thing is substituted and it is named in the peer binary's header: the
//! **directory resolution**. `CLIENT-CONTRACT.md` §6.4 refuses to resolve a new
//! handle without a witness-cosigned root, and §9 rule 5 forbids proceeding
//! silently — so the shipping build refuses, and the harness supplies the answer
//! from a shared file instead of teaching the plugin to invent one.
//!
//! # The assertion that makes this more than "both processes exited zero"
//!
//! Each peer reports the `msg_id` it **sent** and the `msg_id` it **received**.
//! `msg_id` is BLAKE2b-256 over the canonical §7 envelope and is computed
//! independently on both sides — the receiver recomputes it rather than trusting
//! a field. So `alice.sent == bob.received` is a statement that the bytes that
//! left one process are the bytes that arrived in the other, through MLS
//! encryption, a padded relay payload, a WebSocket, and a durable write.

#![cfg(feature = "relay-harness")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::process::Command;
use std::time::Duration;

use f2z_relay_testkit::fake::FakeRelay;

/// Generous, because the peers pay a real proof-of-work stamp for first contact
/// and CI hardware is not a workstation. A failure here should read as "it did
/// not happen", not as "it was slow".
const PEER_TIMEOUT_SECONDS: u64 = 180;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    handle: String,
    conversation_id: String,
    sent_msg_id: String,
    received_msg_id: String,
    received_epoch: u64,
    received_sender_leaf_index: u32,
    received_parents: Vec<String>,
    events: Vec<String>,
}

#[tokio::test(flavor = "multi_thread")]
async fn two_instances_exchange_a_message_over_a_real_relay() {
    let relay = FakeRelay::with_defaults().expect("fake relay");
    let server = relay.listen_loopback().await.expect("listener");
    let url = server.url();

    let root = tempfile::tempdir().expect("tempdir");
    let shared = root.path().join("shared");
    std::fs::create_dir_all(&shared).expect("shared dir");

    let alice = spawn(
        &url,
        &shared,
        &root.path().join("alice"),
        "alice",
        "bob",
        "initiator",
        1,
        "hello, bob",
        "hello, alice",
    );
    let bob = spawn(
        &url,
        &shared,
        &root.path().join("bob"),
        "bob",
        "alice",
        "responder",
        2,
        "hello, alice",
        "hello, bob",
    );

    // Both are collected before either is judged: a failure in one peer is
    // almost always explained by the other's log, and asserting on the first to
    // finish would throw that away.
    let (alice, bob) = tokio::join!(collect(alice, "alice"), collect(bob, "bob"));
    let alice = report(&alice, &bob);
    let bob = report(&bob, &alice_raw(&alice));

    assert_eq!(alice.handle, "alice");
    assert_eq!(bob.handle, "bob");

    // Both sides joined the same MLS group.
    assert_eq!(
        alice.conversation_id, bob.conversation_id,
        "the two engines are not in the same conversation"
    );

    // The bytes that left one process are the bytes that arrived in the other.
    // `msg_id` is recomputed by the receiver from the canonical envelope, never
    // carried, so this is a statement about content and not about a label.
    assert_eq!(
        alice.sent_msg_id, bob.received_msg_id,
        "bob did not receive the message alice sent"
    );
    assert_eq!(
        bob.sent_msg_id, alice.received_msg_id,
        "alice did not receive the message bob sent"
    );

    // §7's ordering keys are protocol-authenticated, so a received message
    // carries a real MLS epoch and a real leaf index rather than defaults.
    // The two sides sit at different leaves — the creator at 0, the joiner at 1
    // — so `senderLeafIndex` differing across the pair is what proves the value
    // came from the MLS framing rather than from a zero somebody forgot to fill
    // in.
    assert_ne!(
        alice.received_sender_leaf_index, bob.received_sender_leaf_index,
        "both sides read the same leaf index; §7's second ordering key is not real"
    );
    for report in [&alice, &bob] {
        assert!(
            report.received_epoch > 0,
            "{}: an inbound message should carry the group's epoch",
            report.handle
        );
        assert!(
            report.events.iter().any(|event| event == "f2zmsg://message-received"),
            "{}: the durable-write event never fired",
            report.handle
        );
        assert!(
            report.events.iter().any(|event| event == "f2zmsg://engine-state"),
            "{}: no engine-state transition was announced",
            report.handle
        );
    }

    // Bob answered alice, so his reply references hers: the DAG is real and not
    // an empty parent set on both sides.
    assert!(
        alice.received_parents.contains(&alice.sent_msg_id)
            || bob.received_parents.contains(&bob.sent_msg_id),
        "neither reply referenced the message it answered; the DAG is not being carried"
    );

    // Printed rather than only asserted, because this transcript is the
    // evidence the pull request quotes and a reviewer should be able to
    // reproduce it with `cargo test --features relay-harness`.
    println!("alice: {alice:?}");
    println!("bob:   {bob:?}");

    server.shutdown().await;
}

#[expect(clippy::too_many_arguments, reason = "a spawn helper for one test")]
fn spawn(
    url: &str,
    shared: &std::path::Path,
    state: &std::path::Path,
    handle: &str,
    peer: &str,
    role: &str,
    seed: u8,
    send: &str,
    expect: &str,
) -> std::process::Child {
    Command::new(env!("CARGO_BIN_EXE_f2zmsg-peer"))
        .args(["--handle", handle])
        .args(["--peer", peer])
        .args(["--role", role])
        .args(["--relay", url])
        .args(["--state", &state.to_string_lossy()])
        .args(["--shared", &shared.to_string_lossy()])
        .args(["--send", send])
        .args(["--expect", expect])
        .args(["--seed", &seed.to_string()])
        .args(["--timeout-seconds", &PEER_TIMEOUT_SECONDS.to_string()])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawning a peer")
}

/// One peer's whole output, whether it succeeded or not.
struct Transcript {
    name: &'static str,
    ok: bool,
    stdout: String,
    stderr: String,
}

impl std::fmt::Display for Transcript {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "--- {} (ok = {}) ---\nstdout:\n{}\nstderr:\n{}",
            self.name, self.ok, self.stdout, self.stderr
        )
    }
}

async fn collect(child: std::process::Child, name: &'static str) -> Transcript {
    let output = tokio::time::timeout(
        Duration::from_secs(PEER_TIMEOUT_SECONDS + 30),
        tokio::task::spawn_blocking(move || child.wait_with_output()),
    )
    .await
    .unwrap_or_else(|_| panic!("{name} did not finish"))
    .expect("join")
    .expect("wait");

    Transcript {
        name,
        ok: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

fn report(subject: &Transcript, other: &Transcript) -> Report {
    assert!(
        subject.ok,
        "{} failed. Both transcripts:\n{subject}\n{other}",
        subject.name
    );
    let line = subject
        .stdout
        .lines()
        .next_back()
        .unwrap_or_else(|| panic!("{} printed nothing:\n{subject}\n{other}", subject.name));
    serde_json::from_str(line).unwrap_or_else(|error| {
        panic!("{}: report is not the expected JSON: {error}\n{line}", subject.name)
    })
}

/// A placeholder so the second `report` call still has something to print.
fn alice_raw(alice: &Report) -> Transcript {
    Transcript {
        name: "alice",
        ok: true,
        stdout: format!("{alice:?}"),
        stderr: String::new(),
    }
}
