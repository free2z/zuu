//! Group commit, measured against the disk rather than asserted.
//!
//! # The claim
//!
//! `f2z-relay-store` runs `synchronous = FULL` over WAL, so **a transaction is
//! an fsync**, and `SqliteStore::commits` counts them. Its documentation names
//! the check this file performs:
//!
//! > *a batch of a hundred appends must move it by one, not by a hundred.*
//!
//! That is the whole of why [`f2z_relay::commit`] exists. A cheap VPS's disk
//! does on the order of 50-200 fsyncs a second; one transaction per `APPEND`
//! would cap the relay there, and
//! [ADR 0005](https://github.com/free2z/zuu/blob/main/docs/e2ee/decisions/0005-federation.md)'s
//! economics do not survive that ceiling.
//!
//! # And the claim it must not weaken
//!
//! §11.1's `durability_mode` has three values and this relay publishes
//! `fsync-per-append`. §8.4 draws the line:
//!
//! > *deferring the fsync past the response is `batched`; amortizing one fsync
//! > across many responses that all wait for it is still `fsync-per-append`.*
//!
//! So the amortization test is paired with a loss test: after N concurrent
//! appends every one of them must be readable, with a distinct index, and the
//! relay must have answered none of them before its commit.

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

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use f2z_codec::types::{Payload, PublicKey, QueueAddress};
use f2z_relay::commit::CommitWriter;
use f2z_relay::config::Config;
use f2z_relay::metrics::Metrics;
use f2z_relay::server::Server;
use f2z_relay_proto::key::SigningKey;
use f2z_relay_proto::queue::{AppendQuota, QueueKind};
use f2z_relay_store::{Durability, QueueSpec, RelayStore, SendAuth, SqliteStore};
use f2z_relay_testkit::client::{Client, ClientConfig};
use f2z_relay_testkit::websocket;

/// A scratch directory that removes itself.
struct Scratch(std::path::PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "f2z-relay-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("a scratch directory");
        Self(path)
    }

    fn join(&self, name: &str) -> std::path::PathBuf {
        self.0.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn sqlite_with_queue(path: &std::path::Path) -> (Arc<SqliteStore>, QueueAddress, PublicKey) {
    let store = SqliteStore::open(path).expect("the store opens");
    let recv_addr = QueueAddress::new([1u8; 32]);
    let send_addr = QueueAddress::new([2u8; 32]);
    let send_key = PublicKey::new([4u8; 32]);
    let _created = store
        .create_queue(&QueueSpec {
            kind: QueueKind::Standard,
            recv_addr,
            send_addr,
            recv_key: PublicKey::new([3u8; 32]),
            message_ttl_seconds: 600,
            idle_ttl_seconds: 600_000,
            quota: AppendQuota {
                max_messages: 100_000,
                max_bytes: 1 << 30,
            },
            created_at_ms: 0,
        })
        .expect("a queue is created");
    let _bound = store
        .bind_send(&send_addr, &send_key, 0)
        .expect("the send side binds");
    (Arc::new(store), send_addr, send_key)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hundred_concurrent_appends_do_not_cost_a_hundred_fsyncs() {
    let scratch = Scratch::new("group-commit");
    let (store, send_addr, send_key) = sqlite_with_queue(&scratch.join("relay.sqlite"));
    assert_eq!(store.durability(), Durability::FsyncPerAppend);

    let baseline = store.commits();
    let metrics = Arc::new(Metrics::new());
    // `_stopped` is the writer's liveness signal (zuu#685); `server.rs`
    // supervises it, and this test only needs the handle.
    let (writer, _stopped) = CommitWriter::start(
        Arc::clone(&store) as Arc<dyn RelayStore + Send + Sync>,
        Arc::clone(&metrics),
        Duration::from_millis(25),
        256,
    )
    .expect("the writer thread starts");

    const APPENDS: usize = 100;
    let mut tasks = Vec::with_capacity(APPENDS);
    for _ in 0..APPENDS {
        let writer = writer.clone();
        tasks.push(tokio::spawn(async move {
            let payload = Payload::new(vec![0u8; 1024]).expect("a payload");
            writer
                .append(send_addr, SendAuth::Signed(send_key), payload, 1_000)
                .await
                .expect("the writer is alive")
                .expect("the append is admitted")
        }));
    }
    let mut indices = Vec::with_capacity(APPENDS);
    for task in tasks {
        let accepted = task.await.expect("the task completes");
        // Every reply carries the store's own durability, and it exists only
        // downstream of a `Committed` the transaction minted.
        assert_eq!(accepted.durability, Durability::FsyncPerAppend);
        indices.push(accepted.index);
    }

    let fsyncs = store.commits().saturating_sub(baseline);
    assert!(
        fsyncs < APPENDS as u64,
        "{APPENDS} concurrent appends cost {fsyncs} fsyncs; group commit did nothing"
    );
    // Not merely "fewer": the point is an order of magnitude. A window of 25 ms
    // against appends submitted as fast as tasks can be spawned should gather
    // them into a handful of transactions.
    assert!(
        fsyncs <= 20,
        "{APPENDS} appends took {fsyncs} transactions; the window is not gathering"
    );
    println!("group commit: {APPENDS} appends in {fsyncs} durable transactions");

    // And nothing was lost or duplicated: §13.2 forbids the relay from
    // discarding an accepted message, and the indices §8 hands out are dense.
    indices.sort_unstable();
    assert_eq!(indices, (0..APPENDS as u64).collect::<Vec<_>>());
    assert_eq!(
        metrics.appends_committed.load(Ordering::Relaxed),
        APPENDS as u64
    );
    assert!(metrics.commit_transactions.load(Ordering::Relaxed) < APPENDS as u64);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lone_append_still_costs_its_own_fsync() {
    // The other half: batching must not make a single append wait for company
    // that never comes, and it must still be durable when it returns.
    let scratch = Scratch::new("lone-append");
    let (store, send_addr, send_key) = sqlite_with_queue(&scratch.join("relay.sqlite"));
    let baseline = store.commits();
    let (writer, _stopped) = CommitWriter::start(
        Arc::clone(&store) as Arc<dyn RelayStore + Send + Sync>,
        Arc::new(Metrics::new()),
        Duration::from_millis(10),
        256,
    )
    .expect("the writer thread starts");

    let started = std::time::Instant::now();
    let accepted = writer
        .append(
            send_addr,
            SendAuth::Signed(send_key),
            Payload::new(vec![0u8; 1024]).expect("a payload"),
            1_000,
        )
        .await
        .expect("the writer is alive")
        .expect("the append is admitted");
    assert_eq!(accepted.index, 0);
    assert_eq!(store.commits().saturating_sub(baseline), 1);
    // The gather window bounds the wait; it does not become the wait.
    assert!(
        started.elapsed() < Duration::from_millis(2_000),
        "a lone append waited {:?}",
        started.elapsed()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_relay_publishes_fsync_per_append_over_a_real_file() {
    let scratch = Scratch::new("published-durability");
    let mut config = Config::default();
    config.listen.address = "127.0.0.1:0".to_owned();
    config.admin.enabled = false;
    config.identity.seed = "7e".repeat(32);
    config.antiabuse.queue_creation_mode = "open".to_owned();
    config.antiabuse.per_source_limits = false;
    config.store.backend = "sqlite".to_owned();
    config.store.path = scratch.join("relay.sqlite").display().to_string();
    config.queues.expiry_tick_seconds = 3_600;

    let server = Server::start(config).await.expect("the relay starts");
    let transport = websocket::connect(&server.url()).await.expect("connects");
    let mut alice = Client::connect(transport, ClientConfig::default())
        .await
        .expect("HELLO completes");

    // §11.1's field, as the relay actually publishes it. Group commit does not
    // weaken it — every append in a batch waits for the same fsync.
    let signed = alice.capabilities().await.expect("GET_CAPABILITIES");
    assert_eq!(
        signed.capabilities.durability_mode,
        f2z_relay_proto::capabilities::DurabilityMode::FsyncPerAppend.code()
    );

    // Fifty appends across five connections, all readable afterwards.
    let recv = SigningKey::from_seed(&[0xc1; 32]);
    let send = SigningKey::from_seed(&[0xc2; 32]);
    let queue = alice
        .create_queue(&recv, 0, 0, None)
        .await
        .expect("CREATE_QUEUE");
    alice
        .bind_send(&send, queue.send_addr)
        .await
        .expect("BIND_SEND");

    let mut senders = Vec::new();
    for stream in 0..5u8 {
        let transport = websocket::connect(&server.url()).await.expect("connects");
        let config = ClientConfig {
            nonce_seed: [0xd0 | stream; 32],
            ..ClientConfig::default()
        };
        senders.push(
            Client::connect(transport, config)
                .await
                .expect("HELLO completes"),
        );
    }
    let mut tasks = Vec::new();
    for mut sender in senders {
        let send = SigningKey::from_seed(&[0xc2; 32]);
        let address = queue.send_addr;
        tasks.push(tokio::spawn(async move {
            for _ in 0..10u8 {
                sender
                    .append(&send, address, b"ciphertext")
                    .await
                    .expect("APPEND is accepted");
            }
        }));
    }
    for task in tasks {
        task.await.expect("the task completes");
    }

    let page = alice
        .read(&recv, queue.recv_addr, 0, 0, 0)
        .await
        .expect("READ");
    assert_eq!(
        page.messages.len(),
        50,
        "an accepted append did not survive to the read"
    );
    let mut indices: Vec<u64> = page.messages.as_slice().iter().map(|m| m.index).collect();
    indices.sort_unstable();
    assert_eq!(indices, (0..50u64).collect::<Vec<_>>());

    server.shutdown().await;
}
