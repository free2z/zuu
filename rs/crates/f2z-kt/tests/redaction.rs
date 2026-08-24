//! **The log is public by construction — so log it normally, but never a
//! signing key, never an unpublished submission, and never a queried handle.**
//!
//! The first half is deliberate: a `DirectoryEntry` is a public record, and a
//! server that refused to name a handle in its own operator log would be
//! unoperable for no privacy gain. `f2z-codec`'s redaction rules are about
//! *confidentiality*; this file is about the two things in this process that
//! genuinely are not public:
//!
//! 1. **Key material.** Every type here that holds a secret has a hand-written
//!    `Debug` rendering `<redacted>`. The decimal case is the one that matters
//!    and it is not hypothetical: `Debug` for `[u8; 32]` prints a list of
//!    decimal integers containing no hex at all, so a hex-only assertion would
//!    pass over a complete key dump. Every assertion below checks base16 in
//!    both cases **and** a decimal byte list.
//! 2. **A submission that has not been published yet.** Between
//!    `/kt/v1/submit` and the epoch that carries it, the entry exists only
//!    between the submitter and the log. Rendering it turns the operator's log
//!    into a preview of directory changes — including, for a `platform_reset`,
//!    advance notice that a named handle is about to change hands, which is the
//!    window ADR 0014's cooldown exists to make visible **to the user** rather
//!    than to whoever reads the server's logs.

// Test code, run on the host by a person reading the failure.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::sync::{Arc, Mutex, Once};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use f2z_codec::Canonical as _;
use f2z_kt::api::AppState;
use f2z_kt::ratelimit::RateLimiter;
use f2z_kt::testing::{EntryBuilder, Harness, Identity, Key};
use f2z_kt::wire::{HistoryRequest, LookupRequest};
use f2z_kt::{FileSigner, LogSigner as _};
use tower::ServiceExt as _;

const NOW: u64 = 1_700_000_100_000;

struct Capture {
    records: Mutex<Vec<String>>,
}

impl log::Log for Capture {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Trace
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            self.records.lock().unwrap().push(record.args().to_string());
        }
    }

    fn flush(&self) {}
}

static CAPTURE: Capture = Capture {
    records: Mutex::new(Vec::new()),
};
static INSTALL_CAPTURE: Once = Once::new();

fn captured() -> String {
    CAPTURE.records.lock().unwrap().join("\n")
}

fn clear_capture() {
    CAPTURE.records.lock().unwrap().clear();
}

fn install_capture() {
    INSTALL_CAPTURE.call_once(|| {
        log::set_logger(&CAPTURE).unwrap();
        log::set_max_level(log::LevelFilter::Trace);
    });
    clear_capture();
}

/// Assert that `rendered` contains `bytes` in none of the forms a `Debug`
/// implementation can leak them in.
fn assert_absent(rendered: &str, bytes: &[u8], what: &str) {
    let lower: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let upper: String = bytes.iter().map(|b| format!("{b:02X}")).collect();
    let decimal: String = bytes
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    let base64url: String = {
        // Not the real encoder — just enough to catch a `Debug` that helpfully
        // base64s a key for readability.
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let mut triple = 0u32;
            for (index, byte) in chunk.iter().enumerate() {
                triple |= u32::from(*byte) << (16 - 8 * index);
            }
            for shift in [18, 12, 6, 0].iter().take(chunk.len() + 1) {
                let position = ((triple >> shift) & 0x3f) as usize;
                out.push(char::from(ALPHABET[position]));
            }
        }
        out
    };

    for (form, needle) in [
        ("base16 lowercase", &lower),
        ("base16 uppercase", &upper),
        ("decimal byte list", &decimal),
        ("base64url", &base64url),
    ] {
        assert!(
            !rendered.contains(needle.as_str()),
            "{what} leaked as {form} in: {rendered}"
        );
    }

    if let Ok(utf8) = std::str::from_utf8(bytes) {
        assert!(
            !rendered.contains(utf8),
            "{what} leaked as UTF-8 in: {rendered}"
        );
    }
}

async fn request(state: Arc<AppState>, path: &'static str, body: Vec<u8>) -> StatusCode {
    f2z_kt::api::router(state)
        .oneshot(Request::post(path).body(Body::from(body)).unwrap())
        .await
        .unwrap()
        .status()
}

async fn app_state(harness: &Harness) -> Arc<AppState> {
    let signer = FileSigner::from_seed(&[0xa1; 32]);
    Arc::new(AppState {
        descriptor: f2z_kt::descriptor::sign_descriptor(
            harness.log.settings(),
            harness.log_id,
            *harness.log.vrf_public_key(),
            &signer,
            NOW,
        )
        .unwrap(),
        policy: f2z_kt::sign_policy(harness.log.authority(), harness.log_id, &signer, NOW).unwrap(),
        log: Arc::clone(&harness.log),
        limits: RateLimiter::defaults(),
        clock: Arc::new(|| NOW),
    })
}

#[test]
fn a_signer_never_renders_its_key_in_any_encoding() {
    let seed = [0x9e_u8; 32];
    let signer = FileSigner::from_seed(&seed);
    let rendered = format!("{signer:?}");
    assert_absent(&rendered, &seed, "the log signing key");
    assert!(rendered.contains("<redacted>"));
    // The public half is fine, and is there so an operator can identify the log
    // from a log line.
    assert!(rendered.contains(&format!("{:?}", signer.public_key())));
}

#[test]
fn the_vrf_key_renders_nothing_at_all() {
    // The VRF key is the one value in this process whose disclosure makes the
    // whole directory enumerable: it determines every label in the tree, so the
    // zero-knowledge property `akd` was adopted for (ADR 0013) is exactly as
    // strong as this key is secret.
    let seed = [0x3d_u8; 32];
    let vrf = f2z_kt::vrf::FileVrf::from_seed(seed).unwrap();
    let rendered = format!("{vrf:?}");
    assert_absent(&rendered, &seed, "the VRF private key");
    assert!(rendered.contains("<redacted>"));
}

#[tokio::test]
async fn the_log_service_never_renders_a_pending_submission_or_a_key() {
    let harness = Harness::vouched("redaction-service").await;
    harness.log.publish_epoch(NOW).await.unwrap();

    let alice = Identity::from_byte(0x5b);
    let device = Key::from_byte(0x77);
    let entry = EntryBuilder::first(harness.log_id, "alice", &alice)
        .device(0x77, &alice.isk)
        .endpoint(0x88)
        .same_key(&alice.dak);
    harness
        .log
        .submit(&harness.envelope(&entry, &alice, NOW), NOW)
        .await
        .unwrap();
    assert_eq!(harness.log.pending_count().await, 1);

    // A `--log-level debug` operator, or a panic handler, formatting the whole
    // service while a submission is in flight.
    let rendered = format!("{:?}", harness.log);

    assert_absent(&rendered, &[0x5b; 32], "alice's identity seed");
    assert_absent(&rendered, device.public.as_bytes(), "a pending device key");
    assert_absent(
        &rendered,
        &f2z_kt::testing::entry_bytes(&entry),
        "a pending directory entry",
    );
    assert!(rendered.contains("<redacted>"));

    // And the identifiers an operator actually needs are still there.
    assert!(rendered.contains("log_id"));
    assert!(rendered.contains("vrf_public_key"));
}

#[tokio::test]
async fn lookup_and_history_never_put_the_queried_handle_in_the_operator_log() {
    install_capture();
    log::trace!("query-log-privacy trace capture control");
    assert!(
        captured().contains("query-log-privacy trace capture control"),
        "the capturing logger did not observe its trace-level control"
    );
    clear_capture();

    let harness = Harness::vouched("redaction-query-handle").await;
    harness.log.publish_epoch(NOW).await.unwrap();

    let alice = Identity::from_byte(0x5d);
    let handle = f2z_kt_core::types::Handle::new(b"queryhandleprivacy".to_vec()).unwrap();
    let entry =
        EntryBuilder::first(harness.log_id, "queryhandleprivacy", &alice).same_key(&alice.dak);
    harness
        .log
        .submit(&harness.envelope(&entry, &alice, NOW), NOW)
        .await
        .unwrap();

    let positive = captured();
    assert!(
        positive.contains("queryhandleprivacy"),
        "the capturing logger did not observe the production submission log: {positive}"
    );

    harness.log.publish_epoch(NOW + 1).await.unwrap();
    let state = app_state(&harness).await;
    clear_capture();

    let lookup = LookupRequest::new(handle.clone())
        .unwrap()
        .encode_canonical()
        .unwrap();
    assert_eq!(
        request(Arc::clone(&state), "/kt/v1/lookup", lookup).await,
        StatusCode::OK
    );
    assert_absent(&captured(), handle.as_slice(), "the queried lookup handle");

    let history = HistoryRequest::complete(handle.clone())
        .unwrap()
        .encode_canonical()
        .unwrap();
    assert_eq!(
        request(Arc::clone(&state), "/kt/v1/history", history.clone()).await,
        StatusCode::OK
    );
    assert_absent(&captured(), handle.as_slice(), "the queried history handle");

    harness.log.forget_entry_bytes_for_test(&handle, 1).await;
    clear_capture();
    assert_eq!(
        request(state, "/kt/v1/history", history).await,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    let fault = captured();
    assert!(
        fault.contains("history: no stored entry for version 1"),
        "the test did not drive the production storage fault into the operator logger: {fault}"
    );
    assert_absent(
        &fault,
        handle.as_slice(),
        "the history handle on the storage-fault path",
    );
}

#[test]
fn a_submission_envelope_never_renders_the_assertion_or_the_entry_bytes() {
    // One log line per submission, each carrying a full assertion naming a
    // handle and an identity key, is a directory reconstructed out of a trace
    // log. `f2z-authority`'s `Submission` documents exactly this case; the
    // envelope that carries it must not undo the work.
    let entry = vec![0xd4_u8; 48];
    let assertion = vec![0xe7_u8; 32];
    let envelope = f2z_kt::SubmissionEnvelope::new(
        &entry,
        Some(&assertion),
        f2z_codec::types::Signature::new([0x11; 64]),
    )
    .unwrap();

    let rendered = format!("{envelope:?}");
    assert_absent(&rendered, &entry, "the submitted entry bytes");
    assert_absent(&rendered, &assertion, "the handle assertion");
}
