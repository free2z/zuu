//! **A task the relay cannot serve without must take the process with it** —
//! zuu#671.
//!
//! `Server::start` spawns the protocol listener, the health listener and the
//! expiry tick as detached tasks. Nothing observed their join handles, so a
//! **panic** in one of them ended that task silently and left the rest of the
//! process running. For the protocol listener that is the worst shape
//! available:
//!
//! * `/healthz` answers from process state only — deliberately, because a probe
//!   that queried the store would fail during exactly the backpressure it exists
//!   to survive — so the startup, readiness and liveness probes all pass;
//! * the GCE health check passes too, so the load balancer keeps the NEG
//!   endpoint in rotation;
//! * and no new client can be served — see the measurement below for the exact
//!   shape of that, which is sharper than the issue's description.
//!
//! Every availability signal is green over a relay that cannot serve a single
//! client, at `replicas: 1`, with no second pod to compare against. Under
//! delete-on-ack that is not a degraded service: a sender that was told
//! `accepted` and a relay that then loses the message have between them
//! destroyed it.
//!
//! # Measured while writing these tests, and worth recording
//!
//! The issue describes the surviving process as one that *"accepts TCP and
//! completes nothing"*. What was measured is sharper: ending the protocol task
//! drops the future that owns the `TcpListener`, so the protocol port stops
//! accepting immediately. **The health listener is the part that keeps lying.**
//! With supervision removed, `/healthz` still answers `HTTP/1.1 200 OK` after
//! the protocol task is gone — so the pod stays `Ready`, the NEG endpoint stays
//! in rotation, and the load balancer goes on sending clients to a process whose
//! only client-facing port is refusing connections. Connections accepted before
//! the failure are handled by their own spawned tasks and do carry on, which is
//! the "completes nothing" observation from the other side.
//!
//! That is why the assertion each test below turns on is that **the health
//! surface is gone**, not merely that the protocol port is: the second is true
//! with or without the fix, and a test that only checked it would pass on the
//! defect.
//!
//! # These tests drive real listeners on purpose
//!
//! An in-process assertion that a flag flipped would prove nothing about the
//! thing that actually failed — a probe surface that was still answering `200`.
//! So each test connects to the bound protocol and health addresses **before**
//! killing a task, and then asserts that connecting to them is refused
//! afterwards. That is the property the kubelet, the load balancer and a client
//! all observe, and it is the one a flag cannot stand in for.
//!
//! The failure is injected with [`Server::abort_task`] because the real cause is
//! a panic, which comes from a bug rather than from an input: there is no
//! request that makes `listener::serve` panic on demand, and a fault-injection
//! hook inside the shipped listener would be a worse thing to carry. An aborted
//! task and a panicked one are the same shape to the supervisor — the handle
//! completes and nothing else in the process notices.

// An integration test is its own crate, so the workspace's denials of the
// panicking families do not reach it. A `.unwrap()` here is a failing test.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::net::SocketAddr;
use std::time::Duration;

use f2z_relay::config::Config;
use f2z_relay::server::{COMMIT_TASK, EXPIRY_TASK, HEALTH_TASK, PROTOCOL_TASK, Server, Stopped};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

/// A relay that binds everything on loopback, with nothing durable behind it.
fn base() -> Config {
    let mut config = Config::default();
    config.listen.address = "127.0.0.1:0".to_owned();
    config.admin.address = "127.0.0.1:0".to_owned();
    config.health.enabled = true;
    config.health.address = "127.0.0.1:0".to_owned();
    config.store.backend = "memory".to_owned();
    config.identity.seed = "5e".repeat(32);
    config.antiabuse.per_source_limits = false;
    config.queues.expiry_tick_seconds = 3_600;
    config
}

/// Assert that a TCP connection is accepted right now.
async fn accepts(addr: SocketAddr, what: &str) {
    tokio::net::TcpStream::connect(addr)
        .await
        .unwrap_or_else(|error| panic!("the {what} accepts before the failure: {error}"));
}

/// `GET /healthz`, which is what every probe and the load balancer do.
async fn healthz(addr: SocketAddr) -> String {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    stream
        .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .await
        .unwrap();
    let mut response = String::new();
    let _ =
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_string(&mut response)).await;
    response
}

/// Assert that connecting is refused, allowing a moment for the socket to close.
///
/// A closed listener answers with a reset rather than a timeout, so this
/// converges immediately in practice; the loop is here so that a slow runner
/// reports the real failure rather than a scheduling artefact.
async fn refuses(addr: SocketAddr, what: &str) {
    for _ in 0..100u32 {
        match tokio::time::timeout(
            Duration::from_millis(200),
            tokio::net::TcpStream::connect(addr),
        )
        .await
        {
            Ok(Err(_)) => return,
            _ => tokio::time::sleep(Duration::from_millis(20)).await,
        }
    }
    panic!("the {what} at {addr} is still accepting connections");
}

/// **zuu#671.** A dead protocol task takes the whole process down — including
/// the health listener that would otherwise keep the pod `Ready`.
#[tokio::test(flavor = "multi_thread")]
async fn a_dead_protocol_task_stops_the_process_instead_of_staying_ready() {
    let mut server = Server::start(base()).await.expect("the relay starts");
    let protocol = server.protocol_addr();
    let health = server.health_addr().expect("the health listener is bound");

    accepts(protocol, "protocol listener").await;
    assert!(
        healthz(health).await.starts_with("HTTP/1.1 200"),
        "the probe surface is green before the failure"
    );

    assert!(server.abort_task(PROTOCOL_TASK), "the task is supervised");

    // The signal never fires: this is the case where nobody asked the relay to
    // stop and it must stop anyway.
    let stopped = tokio::time::timeout(
        Duration::from_secs(10),
        server.run_until_stopped(std::future::pending()),
    )
    .await
    .expect("supervision notices a dead task without waiting for a signal");
    assert_eq!(stopped, Stopped::TaskEnded(PROTOCOL_TASK));

    // The properties an operator, a kubelet and a client actually observe.
    // The health surface is the load-bearing one: without the fix it answers
    // `200` here, which is the whole defect — a `Ready` pod in the load
    // balancer's rotation over a relay that cannot serve.
    refuses(health, "health listener").await;
    refuses(protocol, "protocol listener").await;
}

/// The expiry tick is supervised for a **correctness** reason, not an
/// availability one: §7.7's TTLs stop being enforced the moment it is gone, and
/// nothing a client can see says so.
#[tokio::test(flavor = "multi_thread")]
async fn a_dead_expiry_tick_stops_the_process_too() {
    let mut server = Server::start(base()).await.expect("the relay starts");
    let protocol = server.protocol_addr();
    let health = server.health_addr().expect("the health listener is bound");
    accepts(protocol, "protocol listener").await;

    assert!(server.abort_task(EXPIRY_TASK), "the tick is supervised");

    let stopped = tokio::time::timeout(
        Duration::from_secs(10),
        server.run_until_stopped(std::future::pending()),
    )
    .await
    .expect("supervision notices the tick");
    assert_eq!(stopped, Stopped::TaskEnded(EXPIRY_TASK));

    refuses(protocol, "protocol listener").await;
    refuses(health, "health listener").await;
}

/// The listener a probe reaches is supervised as well: a relay whose health
/// surface has died is unreachable to the kubelet, which would restart it — the
/// process should not wait to be killed to stop serving.
#[tokio::test(flavor = "multi_thread")]
async fn a_dead_health_listener_stops_the_process() {
    let mut server = Server::start(base()).await.expect("the relay starts");
    let protocol = server.protocol_addr();

    assert!(server.abort_task(HEALTH_TASK), "the listener is supervised");

    let stopped = tokio::time::timeout(
        Duration::from_secs(10),
        server.run_until_stopped(std::future::pending()),
    )
    .await
    .expect("supervision notices the health listener");
    assert_eq!(stopped, Stopped::TaskEnded(HEALTH_TASK));
    refuses(protocol, "protocol listener").await;
}

/// The control: an ordinary signal is still an ordinary, zero-exit shutdown, and
/// it is **not** reported as a task failure.
///
/// Without this, a supervisor that reported every stop as a failure would pass
/// the three tests above and crash-loop every deliberate restart.
#[tokio::test(flavor = "multi_thread")]
async fn a_requested_shutdown_is_not_a_failure() {
    let server = Server::start(base()).await.expect("the relay starts");
    let protocol = server.protocol_addr();
    accepts(protocol, "protocol listener").await;

    let stopped = tokio::time::timeout(
        Duration::from_secs(10),
        server.run_until_stopped(std::future::ready(())),
    )
    .await
    .expect("a signalled shutdown finishes");
    assert_eq!(stopped, Stopped::Requested);
    refuses(protocol, "protocol listener").await;
}

/// **zuu#685.** The group-commit writer is an **OS thread**, so #683's
/// supervision — which holds `JoinHandle`s — could not reach it. A dead writer
/// left every listener open and every probe green over a relay that could not
/// store a single message: `CommitWriter::append` returned `WriterStopped`,
/// `engine.rs` collapsed that to a per-request `ERR_UNAVAILABLE`, and nothing
/// above it ever concluded that the relay was finished.
///
/// Under delete-on-ack that is the worst failure in the system. A sender is
/// told `accepted` by a relay whose write path is gone, deletes its only copy,
/// and the message never existed. `replicas: 1` on a ReadWriteOnce volume means
/// there is no second pod to take over from one that has quietly stopped
/// accepting.
///
/// The failure is injected by killing **the thread**, not by aborting the
/// watchdog task: aborting the watchdog would pass identically on a build where
/// nothing connected it to the writer, which is precisely the defect.
#[tokio::test(flavor = "multi_thread")]
async fn a_dead_commit_writer_stops_the_process_instead_of_answering_unavailable() {
    let server = Server::start(base()).await.expect("the relay starts");
    let protocol = server.protocol_addr();
    let health = server.health_addr().expect("the health listener is bound");

    accepts(protocol, "protocol listener").await;
    assert!(
        healthz(health).await.starts_with("HTTP/1.1 200"),
        "the probe surface is green before the failure"
    );

    assert!(
        server.stop_commit_writer(),
        "the commit writer is running and reachable"
    );

    let stopped = tokio::time::timeout(
        Duration::from_secs(10),
        server.run_until_stopped(std::future::pending()),
    )
    .await
    .expect("supervision notices a dead commit writer without waiting for a signal");
    assert_eq!(stopped, Stopped::TaskEnded(COMMIT_TASK));

    // The load-bearing assertion, for #683's measured reason: the writer thread
    // owns no socket at all, so *nothing* an outside observer can see changes
    // when it dies. Without the fix both of these keep answering forever.
    refuses(health, "health listener").await;
    refuses(protocol, "protocol listener").await;
}

/// The watchdog is not a way to fake the above: killing the **watchdog task**
/// is reported too, under the same name.
///
/// A supervisor that watched the write path from outside the supervised set
/// would move the fail-open rather than close it — the relay would then have a
/// process whose commit-writer watchdog had died and which nobody was watching.
/// This asserts the watchdog is in the same `Vec<Supervised>` as the four tokio
/// tasks and is covered by the same mechanism.
#[tokio::test(flavor = "multi_thread")]
async fn the_commit_watchdog_is_itself_supervised() {
    let mut server = Server::start(base()).await.expect("the relay starts");
    let protocol = server.protocol_addr();
    let health = server.health_addr().expect("the health listener is bound");
    accepts(protocol, "protocol listener").await;

    assert!(
        server.abort_task(COMMIT_TASK),
        "the commit watchdog is a supervised task like any other"
    );

    let stopped = tokio::time::timeout(
        Duration::from_secs(10),
        server.run_until_stopped(std::future::pending()),
    )
    .await
    .expect("supervision notices its own watchdog");
    assert_eq!(stopped, Stopped::TaskEnded(COMMIT_TASK));
    refuses(health, "health listener").await;
    refuses(protocol, "protocol listener").await;
}
