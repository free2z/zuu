//! The acceptance test: `f2z-relay-testkit`'s conformance suite, run against the
//! real relay and against the FakeRelay, with the verdicts compared.
//!
//! # Why the comparison is the test and the pass count is not
//!
//! `f2z-relay-testkit` was written before this crate for exactly this moment.
//! Its 52 vectors are `(input, expected output)` cases driven through the
//! ordinary client API against an [`Endpoint`], and its README says what the
//! third implementation of that trait is for:
//!
//! > *`f2z-relay`, once it exists, is a `WebSocketEndpoint` with a URL and no
//! > fault handle. The suite then reports the fault vectors as skipped rather
//! > than failing them, so the same file is a real check of both relays instead
//! > of two files that drift.*
//!
//! So this file runs the **same unmodified suite** twice and asserts that every
//! vector both targets can run reaches the same verdict. A vector that passes
//! against the FakeRelay and fails here is a defect in this relay; one that
//! fails there and passes here is a defect in the FakeRelay. Either way the
//! disagreement is the finding, and a suite that only counted passes would
//! report neither.
//!
//! # A `Skipped` is never a pass
//!
//! Thirteen vectors declare [`Needs::Faults`] or [`Needs::Clock`] — they need to
//! make the relay misbehave, or to move its clock. A real relay has neither
//! handle and must not: a fault-injection hook compiled into a production binary
//! is a fault-injection hook an attacker can reach. Those vectors report
//! `Skipped` here, this file asserts that they are *skipped and not failed*, and
//! `configured_equivalents.rs` covers the subset that is reachable by
//! **configuration** instead — which is the honest way for a real relay to
//! satisfy a rule it cannot be told to break.

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

use f2z_relay::config::Config;
use f2z_relay::server::Server;
use f2z_relay_testkit::config::{RelayConfig, TESTKIT_POW_DIFFICULTY_BITS};
use f2z_relay_testkit::fake::{FakeRelay, WebSocketEndpoint};
use f2z_relay_testkit::vectors::{self, Needs, Report, Status};

// Reviewed literals, not values derived from `vectors::suite()`. Changing a
// vector's `Needs` or deleting a vector must stop this test and require an
// explicit coverage review instead of shrinking the real-relay run invisibly.
const REVIEWED_SUITE_VECTOR_COUNT: usize = 52;
const REVIEWED_REAL_RELAY_VECTOR_COUNT: usize = 39;

/// A configuration that matches the FakeRelay's published policy wherever the
/// policy is what a vector observes.
///
/// Two values differ from this crate's own defaults, and both are *published
/// policy* rather than a relaxation:
///
/// - `queue_creation_mode = open`. §13.1 permits it "for a private relay on a
///   closed network", which a loopback test relay is, and the FakeRelay
///   defaults to it for the same reason. The shipped default stays `pow`.
/// - `contact_append_pow_bits = 8`. §12.3 requires proof of work whenever
///   contact queues are offered; the difficulty is a policy number, and 8 bits
///   is what the testkit picked so a suite does not spend a minute hashing. The
///   shipped default stays 20.
///
/// Nothing else is loosened. In particular the padding set, the TTL bands, the
/// frame cap, the in-flight window and the anti-replay window are this crate's
/// own defaults.
pub fn conformance_config() -> Config {
    let mut config = Config::default();
    config.listen.address = "127.0.0.1:0".to_owned();
    config.admin.enabled = false;
    config.store.backend = "memory".to_owned();
    // A fixed seed rather than a key file: a test must not write one into
    // whatever directory it happens to run in.
    config.identity.seed = "5a".repeat(32);
    config.antiabuse.queue_creation_mode = "open".to_owned();
    config.antiabuse.contact_append_pow_bits = TESTKIT_POW_DIFFICULTY_BITS;
    // The suite opens a connection per vector from one address, and several
    // vectors open a second. §13.1's per-source caps are real and tested in
    // their own file; here they would only throttle the harness.
    config.antiabuse.per_source_limits = false;
    // A short window, because the suite's appends are sequential and every one
    // of them would otherwise wait the full gather.
    config.commit.window_ms = 1;
    // Long enough that no sweep runs during a suite. §7.7's timers get their
    // own test, where the wait is the point.
    config.queues.expiry_tick_seconds = 3_600;
    config
}

/// The FakeRelay on its own defaults, over its own `ws://` listener.
///
/// The socket path rather than the in-process one, so both reports are of a
/// relay reached the same way and a difference cannot be a transport artefact.
async fn fake_report() -> Report {
    let relay = FakeRelay::new(RelayConfig::default().with_system_clock())
        .expect("the FakeRelay's default configuration is valid");
    let server = relay
        .listen_loopback()
        .await
        .expect("a loopback listener binds");
    let report = vectors::run(Arc::new(relay.websocket_endpoint(&server))).await;
    server.shutdown().await;
    report
}

/// The real relay, reached exactly as a third-party client would reach it.
async fn real_report() -> (Report, Server) {
    let server = Server::start(conformance_config())
        .await
        .expect("the relay starts");
    // `WebSocketEndpoint::new` is the constructor the testkit's README names as
    // the one `f2z-relay` will be run through: a URL, no fault handle, no
    // steerable clock.
    let report = vectors::run(Arc::new(WebSocketEndpoint::new(server.url()))).await;
    (report, server)
}

fn needs_of(name: &str) -> Needs {
    vectors::suite()
        .into_iter()
        .find(|vector| vector.name == name)
        .map_or(Needs::Nothing, |vector| vector.needs)
}

#[tokio::test(flavor = "multi_thread")]
async fn the_real_relay_and_the_fakerelay_agree_on_every_vector_both_can_run() {
    let fake = fake_report().await;
    let (real, server) = real_report().await;

    println!("\n=== f2z-relay-testkit conformance suite ===");
    println!("FakeRelay   {}", fake.summary());
    println!("f2z-relay   {}", real.summary());
    for (name, status) in real.verdicts() {
        let fake_status = fake
            .verdicts()
            .into_iter()
            .find(|(other, _)| *other == name)
            .map(|(_, status)| status);
        println!(
            "  {name:<58} fake={:<9} real={}",
            render(fake_status.as_ref()),
            render(Some(&status))
        );
    }
    println!();

    let mut disagreements = Vec::new();
    let mut wrongly_skipped = Vec::new();
    for (name, real_status) in real.verdicts() {
        let Some((_, fake_status)) = fake
            .verdicts()
            .into_iter()
            .find(|(other, _)| *other == name)
        else {
            disagreements.push(format!("{name}: absent from the FakeRelay's report"));
            continue;
        };
        match needs_of(name) {
            // Both targets can run it, so both must reach the same verdict.
            // This is the comparison the suite exists for.
            Needs::Nothing => {
                if real_status != fake_status {
                    disagreements.push(format!(
                        "{name}: FakeRelay {}, f2z-relay {}",
                        render(Some(&fake_status)),
                        render(Some(&real_status))
                    ));
                }
            }
            // The real relay has no handle, so it must report *skipped* — never
            // failed, and never a pass it did not earn.
            Needs::Faults | Needs::Clock => {
                if !matches!(real_status, Status::Skipped(_)) {
                    wrongly_skipped.push(format!(
                        "{name}: expected Skipped against a relay with no handle, got {}",
                        render(Some(&real_status))
                    ));
                }
            }
        }
    }

    server.shutdown().await;

    assert!(
        disagreements.is_empty(),
        "the two relays disagree, which is a defect in one of them:\n  {}",
        disagreements.join("\n  ")
    );
    assert!(
        wrongly_skipped.is_empty(),
        "a fault-driven vector did not report Skipped:\n  {}",
        wrongly_skipped.join("\n  ")
    );
    assert_eq!(
        real.failed(),
        0,
        "the real relay failed vectors:\n  {}",
        real.failures().join("\n  ")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn every_vector_that_needs_no_handle_passes_against_the_real_relay() {
    let (real, server) = real_report().await;
    let suite = vectors::suite();
    let runnable = suite
        .iter()
        .filter(|vector| matches!(vector.needs, Needs::Nothing))
        .count();
    server.shutdown().await;

    assert_eq!(
        suite.len(),
        REVIEWED_SUITE_VECTOR_COUNT,
        "the reviewed conformance-suite population changed; adding or removing \
         a vector requires an explicit coverage review"
    );
    assert_eq!(
        runnable, REVIEWED_REAL_RELAY_VECTOR_COUNT,
        "the reviewed handle-free vector population changed; changing a vector's \
         `Needs` silently changes what the real relay is asked to prove"
    );
    assert_eq!(
        real.outcomes.len(),
        REVIEWED_SUITE_VECTOR_COUNT,
        "the real-relay report did not retain the whole reviewed suite"
    );
    assert_eq!(
        real.passed(),
        REVIEWED_REAL_RELAY_VECTOR_COUNT,
        "{} of {} reviewed handle-free vectors passed; failures:\n  {}",
        real.passed(),
        REVIEWED_REAL_RELAY_VECTOR_COUNT,
        real.failures().join("\n  ")
    );
    assert_eq!(
        real.skipped(),
        REVIEWED_SUITE_VECTOR_COUNT - REVIEWED_REAL_RELAY_VECTOR_COUNT
    );
}

fn render(status: Option<&Status>) -> String {
    match status {
        Some(Status::Passed) => "passed".to_owned(),
        Some(Status::Skipped(_)) => "skipped".to_owned(),
        Some(Status::Failed(reason)) => format!("FAILED({reason})"),
        None => "absent".to_owned(),
    }
}
