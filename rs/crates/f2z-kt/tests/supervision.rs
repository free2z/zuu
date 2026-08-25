//! **A dead epoch scheduler must take the process with it** — zuu#684.
//!
//! `server::serve` spawned the scheduler as a detached task and then awaited
//! the listener. Nothing observed the scheduler's join handle, so a **panic**
//! in it ended that task and left the rest of the process running: `/healthz`
//! answering `200`, the pod `Ready`, §9.2's endpoints all correct — over a
//! directory that had stopped moving.
//!
//! # Why this is worse than the relay case it is copied from
//!
//! zuu#671 fixed this shape in `f2z-relay`, where the failure is at least
//! *loud*: a relay that has stopped accepting fails its senders immediately.
//! **A key-transparency log that has stopped publishing epochs errors on
//! nothing.** Clients keep verifying against the last signed tree head, which
//! stays valid. Lookups keep succeeding. Submissions are still accepted into
//! the pending journal. Nothing in the protocol distinguishes "no directory
//! changes happened this hour" from "the log stopped incorporating them".
//!
//! `KT.md` §5.1's heartbeat epochs exist precisely so that silence is
//! detectable — an epoch on cadence even with nothing to add, so that a client
//! seeing none knows. A dead scheduler does not *trip* that mechanism, it
//! **removes** it: there are no heartbeats to miss, because there is nothing
//! left to emit them.
//!
//! # These tests drive a real listener on purpose
//!
//! zuu#683 measured the correction that applies directly here: ending a task
//! drops the future that owns **its own** listener, so the port that task was
//! serving stops accepting immediately with or without supervision. The part
//! that keeps lying is the **health surface**, which belongs to a different
//! task and goes on answering `200`. In `f2z-kt` the health surface and the
//! protocol surface are the same axum router, so the scheduler owns neither —
//! which makes the point sharper, not softer: killing the scheduler changes
//! *nothing* an outside observer can see, and the assertion below is that after
//! the fix it changes everything, because the process stops.
//!
//! So each test dials the bound address, reads `/healthz` before the failure,
//! and asserts the socket is refused afterwards. That is the property the
//! kubelet, the load balancer and a client all observe, and no in-process flag
//! can stand in for it.
//!
//! The failure is injected with `Server::abort_task` because the real cause is
//! a panic, which comes from a bug rather than from an input: there is no
//! request that makes the scheduler panic on demand, and a fault-injection hook
//! inside the shipped scheduler would be a far worse thing to carry. An aborted
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
use std::sync::Arc;
use std::time::Duration;

use f2z_authority::authority::{AuthorityConfig, AuthoritySet};
use f2z_kt::api::AppState;
use f2z_kt::config::LogSettings;
use f2z_kt::log::LogService;
use f2z_kt::ratelimit::RateLimiter;
use f2z_kt::server::{EPOCH_TASK, HTTP_TASK, Server, Stopped};
use f2z_kt::signer::FileSigner;
use f2z_kt::testing::{Key, temp_dir};
use f2z_kt::vrf::FileVrf;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

const NOW: u64 = 1_700_000_100_000;

/// A whole log, in a temporary directory, publishing on `interval` seconds.
///
/// Built here rather than from `testing::Harness` because the cadence is the
/// thing under test in [`the_scheduler_really_is_what_publishes_epochs`], and a
/// fixture that hard-coded §5.1's proposed 600 s would make that test take ten
/// minutes or, worse, quietly become a test of nothing.
async fn log_serving_every(name: &str, interval: u32) -> Arc<AppState> {
    let dir = temp_dir(name);
    let log_key = Key::from_byte(0xa1);
    let reset_authority = Key::from_byte(0xa2);
    let issuer = f2z_authority::key::SigningKey::from_seed(&[0xa3; 32]);

    let log_id = f2z_kt_core::labels::log_id(&log_key.public);
    let mut settings = LogSettings::defaults(log_key.public, reset_authority.public).unwrap();
    settings.epoch_interval_seconds = interval;

    let authority = AuthorityConfig::with_defaults(
        f2z_authority::types::LogId::new(*log_id.as_bytes()),
        AuthoritySet::single(issuer.public_key()).unwrap(),
    )
    .unwrap();

    let signer = Arc::new(FileSigner::from_seed(&[0xa1; 32]));
    let vrf = FileVrf::from_seed([0xb0; 32]).unwrap();
    let log = LogService::open(
        &dir,
        settings.clone(),
        Arc::clone(&signer) as Arc<dyn f2z_kt::signer::LogSigner>,
        vrf,
        authority.clone(),
        Vec::new(),
    )
    .await
    .unwrap();
    // §6.3's chain has to start somewhere, exactly as `server::build` does it.
    if log.current_epoch().await == 0 {
        log.publish_epoch(NOW).await.unwrap();
    }
    let vrf_public_key = *log.vrf_public_key();
    let log = Arc::new(log);

    Arc::new(AppState {
        descriptor: f2z_kt::descriptor::sign_descriptor(
            &settings,
            log_id,
            vrf_public_key,
            signer.as_ref(),
            NOW,
        )
        .unwrap(),
        policy: f2z_kt::sign_policy(&authority, log_id, signer.as_ref(), NOW).unwrap(),
        log,
        limits: RateLimiter::defaults(),
        clock: Arc::new(f2z_kt::now_ms),
    })
}

/// `GET /healthz`, which is what every probe and the load balancer do.
///
/// `Connection: close` so the response ends at EOF and no keep-alive socket is
/// left for the graceful shutdown to wait on — the test is about whether the
/// listener is *there*, not about how long a spare connection lingers.
async fn healthz(addr: SocketAddr) -> String {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    stream
        .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut response = String::new();
    let _ =
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_string(&mut response)).await;
    response
}

/// Assert that connecting is refused, allowing a moment for the socket to
/// close. A closed listener answers with a reset rather than a timeout, so this
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

/// **zuu#684.** A dead epoch scheduler takes the whole process down, including
/// the surface that would otherwise keep the pod `Ready` over a frozen log.
#[tokio::test(flavor = "multi_thread")]
async fn a_dead_epoch_scheduler_stops_the_process_instead_of_staying_ready() {
    let state = log_serving_every("supervision-scheduler", 3_600).await;
    let mut server = Server::start(state, "127.0.0.1:0")
        .await
        .expect("it starts");
    let addr = server.addr();

    assert!(
        healthz(addr).await.starts_with("HTTP/1.1 200"),
        "the probe surface is green before the failure"
    );

    assert!(server.abort_task(EPOCH_TASK), "the scheduler is supervised");

    // The signal never fires: this is the case where nobody asked the log to
    // stop and it must stop anyway.
    let stopped = tokio::time::timeout(
        Duration::from_secs(10),
        server.run_until_stopped(std::future::pending()),
    )
    .await
    .expect("supervision notices a dead scheduler without waiting for a signal");
    assert_eq!(stopped, Stopped::TaskEnded(EPOCH_TASK));

    // The load-bearing assertion. Without the fix this address answers `200`
    // forever: the listener has no idea the scheduler is gone, `/healthz` reads
    // process state only, and every probe and the load balancer are satisfied
    // by a log that will never publish another epoch.
    refuses(addr, "http listener").await;
}

/// The listener is supervised too. A log whose HTTP surface has died is
/// unreachable to every probe, and the process should not sit there publishing
/// epochs nobody can fetch until something else kills it.
#[tokio::test(flavor = "multi_thread")]
async fn a_dead_http_listener_stops_the_process() {
    let state = log_serving_every("supervision-listener", 3_600).await;
    let mut server = Server::start(state, "127.0.0.1:0")
        .await
        .expect("it starts");
    let addr = server.addr();
    assert!(healthz(addr).await.starts_with("HTTP/1.1 200"));

    assert!(server.abort_task(HTTP_TASK), "the listener is supervised");

    let stopped = tokio::time::timeout(
        Duration::from_secs(10),
        server.run_until_stopped(std::future::pending()),
    )
    .await
    .expect("supervision notices the listener");
    assert_eq!(stopped, Stopped::TaskEnded(HTTP_TASK));
    refuses(addr, "http listener").await;
}

/// The control: an ordinary signal is still an ordinary, zero-exit shutdown,
/// and it is **not** reported as a task failure.
///
/// Without this, a supervisor that called every stop a failure would pass the
/// two tests above and crash-loop every deliberate restart. It is also the test
/// that catches the specific mistake this fix could make: the scheduler now
/// selects on the shutdown flag, so it *ends* on a requested shutdown, and a
/// supervisor that did not race the signal first would report that ending as
/// `TaskEnded(EPOCH_TASK)` and exit non-zero on every `SIGTERM`.
#[tokio::test(flavor = "multi_thread")]
async fn a_requested_shutdown_is_not_a_failure() {
    let state = log_serving_every("supervision-signal", 3_600).await;
    let server = Server::start(state, "127.0.0.1:0")
        .await
        .expect("it starts");
    let addr = server.addr();
    assert!(healthz(addr).await.starts_with("HTTP/1.1 200"));

    let stopped = tokio::time::timeout(
        Duration::from_secs(10),
        server.run_until_stopped(std::future::ready(())),
    )
    .await
    .expect("a signalled shutdown finishes");
    assert_eq!(stopped, Stopped::Requested);
    refuses(addr, "http listener").await;
}

/// The positive control, and the reason the three tests above mean anything: on
/// a one-second cadence the log really does publish §5.1's heartbeat epochs on
/// its own, with nothing submitted to it.
///
/// Supervision of a task that published nothing would be supervision of a
/// no-op, and every assertion above would still pass. This is the test that
/// says the thing being supervised is the thing the log exists to do.
#[tokio::test(flavor = "multi_thread")]
async fn the_scheduler_really_is_what_publishes_epochs() {
    let state = log_serving_every("supervision-cadence", 1).await;
    let before = state.log.current_epoch().await;
    let server = Server::start(Arc::clone(&state), "127.0.0.1:0")
        .await
        .expect("it starts");

    let mut after = before;
    for _ in 0..60u32 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        after = state.log.current_epoch().await;
        if after > before {
            break;
        }
    }
    assert!(
        after > before,
        "the scheduler published nothing in 15s at a 1s cadence: {before} -> {after}"
    );

    let stopped = tokio::time::timeout(
        Duration::from_secs(10),
        server.run_until_stopped(std::future::ready(())),
    )
    .await
    .expect("a signalled shutdown finishes");
    assert_eq!(stopped, Stopped::Requested);
}
