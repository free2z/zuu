//! Kill a real process mid-commit, reopen the file, and check what survived.
//!
//! # Why this test is shaped the way it is
//!
//! Under delete-on-ack the relay's copy of a message is, for a window, the only
//! copy in the system ([`ARCHITECTURE.md` §6.4][s64]). Two invariants therefore
//! have to hold across an unplanned stop, and neither is observable from inside
//! a healthy process:
//!
//! - **Nothing accepted-but-lost.** Every append whose [`Committed`] receipt the
//!   caller actually received — the only appends for which a relay is permitted
//!   to have answered `accepted` — is still there afterwards.
//! - **Nothing acked-but-undeleted.** No message at or below the persisted
//!   acknowledgement watermark is still stored. The watermark advance and the
//!   range delete are one transaction, so a crash cannot land between them.
//!
//! **A caught panic does not test this.** An in-process `catch_unwind` leaves
//! the SQLite connection alive, runs `Drop` on the open transaction — rolling
//! back the very write whose fate is the question — and flushes on the way out.
//! It exercises the error path, not the durability one. So each case below runs
//! in a **child process** that calls `abort()` at a chosen instant inside the
//! library, and the parent asserts on the file the child left behind, from a
//! fresh connection, after the child is confirmed dead.
//!
//! The parent also asserts *how* the child died: killed by a signal, not exited.
//! A child that returned an exit code did not crash, it finished, and a test
//! that accepted that would pass even if the injection point had been deleted.
//!
//! Run with `cargo test -p f2z-relay-store --features crash-injection`.
//!
//! [s64]: https://github.com/free2z/zuu/blob/main/docs/e2ee/ARCHITECTURE.md#64-delete-on-ack-and-lost-acknowledgements
//! [`Committed`]: f2z_relay_store::Committed

// Only compiled when the injection point exists. Without the feature there is
// nothing to fire and the file is empty on purpose: a silently-passing crash
// test is worse than no crash test.
#![cfg(feature = "crash-injection")]
// Test code, run on the host by a person reading the failure. The workspace
// denies these because a panic in the relay's request path is a remote denial
// of service; neither hazard exists in a test harness.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::path::{Path, PathBuf};
use std::process::Command;

use f2z_codec::types::{Payload, PublicKey, QueueAddress};
use f2z_relay_proto::queue::{AppendQuota, QueueKind};
use f2z_relay_store::crash::{CRASH_POINT_ENV, arm_from_env};
use f2z_relay_store::{
    Append, QueueSpec, ReadWindow, RelayStore, SendAuth, SqliteStore, StoreError,
};

const RECV_ADDR: QueueAddress = QueueAddress::new([0x11; 32]);
const SEND_ADDR: QueueAddress = QueueAddress::new([0x22; 32]);
const RECV_KEY: PublicKey = PublicKey::new([0x33; 32]);
const SEND_KEY: PublicKey = PublicKey::new([0x44; 32]);

/// Which side of the crash the child is meant to be on. Set by the parent, read
/// by the child worker below.
const SCENARIO_ENV: &str = "F2Z_RELAY_STORE_CRASH_SCENARIO";
const DB_ENV: &str = "F2Z_RELAY_STORE_CRASH_DB";

fn payload(byte: u8, len: usize) -> Payload {
    Payload::new(vec![byte; len]).unwrap()
}

fn open(path: &Path) -> SqliteStore {
    SqliteStore::open(path).unwrap()
}

fn seed(store: &SqliteStore) {
    let _ = store
        .create_queue(&QueueSpec {
            kind: QueueKind::Standard,
            recv_addr: RECV_ADDR,
            send_addr: SEND_ADDR,
            recv_key: RECV_KEY,
            message_ttl_seconds: 604_800,
            idle_ttl_seconds: 7_776_000,
            quota: AppendQuota {
                max_messages: 1_000,
                max_bytes: 1 << 20,
            },
            created_at_ms: 1_000,
        })
        .unwrap();
    let _ = store.bind_send(&SEND_ADDR, &SEND_KEY, 1_000).unwrap();
}

fn append_one(store: &SqliteStore, byte: u8, at_ms: u64) -> u64 {
    let body = payload(byte, 1024);
    store
        .append(&Append {
            send_addr: SEND_ADDR,
            auth: SendAuth::Signed(SEND_KEY),
            payload: &body,
            received_at_ms: at_ms,
        })
        .unwrap()
        .into_inner()
        .index
}

/// Everything currently stored, read straight back out.
fn stored(store: &SqliteStore) -> Vec<(u64, u8)> {
    let page = store
        .read(
            &RECV_ADDR,
            &RECV_KEY,
            ReadWindow {
                from_index: 0,
                max_messages: u16::MAX,
                max_bytes: u32::MAX,
            },
            10_000,
        )
        .unwrap();
    page.messages
        .into_iter()
        .map(|message| (message.index, message.payload.as_slice()[0]))
        .collect()
}

// ---------------------------------------------------------------------------
// The child.
//
// `#[ignore]` so an ordinary `cargo test` never runs it; the parent invokes it
// explicitly with `--ignored --exact`. This is how an integration test gets a
// child process at all — the harness owns `main`, so the entry point has to be
// a test the parent can name.
// ---------------------------------------------------------------------------

#[test]
#[ignore = "spawned by the parent cases below; not a test on its own"]
fn crash_child_worker() {
    let Ok(scenario) = std::env::var(SCENARIO_ENV) else {
        // Someone ran the whole ignored set by hand. Do nothing rather than
        // abort an unsuspecting test run.
        return;
    };
    let path = PathBuf::from(std::env::var(DB_ENV).expect("the parent sets the database path"));

    match scenario.as_str() {
        // Two appends whose receipts the caller received — the relay would have
        // answered `accepted` for both — and then a third that dies mid-commit.
        "append" => {
            let store = open(&path);
            seed(&store);
            append_one(&store, 0xa1, 2_000);
            append_one(&store, 0xa2, 3_000);
            // Armed here rather than at open, so the two appends above complete
            // and hand back their receipts — those are the ones a relay would
            // have answered `accepted` for — and only the third dies.
            arm_from_env();
            let body = payload(0xa3, 1024);
            let _ = store.append(&Append {
                send_addr: SEND_ADDR,
                auth: SendAuth::Signed(SEND_KEY),
                payload: &body,
                received_at_ms: 4_000,
            });
            panic!("the store returned from an append that was supposed to abort");
        }
        // Three appends, then an ACK of the first two that dies mid-commit.
        "ack" => {
            let store = open(&path);
            seed(&store);
            append_one(&store, 0xa1, 2_000);
            append_one(&store, 0xa2, 3_000);
            append_one(&store, 0xa3, 4_000);
            arm_from_env();
            let _ = store.ack(&RECV_ADDR, &RECV_KEY, 1, 5_000);
            panic!("the store returned from an ack that was supposed to abort");
        }
        other => panic!("unknown crash scenario {other}"),
    }
}

/// Run the child, and insist it died the way a crash dies.
fn crash_child(path: &Path, scenario: &str, point: &str) {
    let exe = std::env::current_exe().expect("the test binary knows its own path");
    let status = Command::new(exe)
        .args(["--exact", "crash_child_worker", "--ignored", "--nocapture"])
        .env(SCENARIO_ENV, scenario)
        .env(DB_ENV, path)
        .env(CRASH_POINT_ENV, point)
        .status()
        .expect("the child test binary starts");

    assert!(
        !status.success(),
        "the child at {point} exited successfully; the injection point did not fire"
    );
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(
            status.signal(),
            Some(libc_sigabrt()),
            "the child at {point} must be killed by SIGABRT, not exit with a code — \
             an exit code means it unwound, which is not what a crash does"
        );
    }
}

/// `SIGABRT`, without a libc dependency for one constant.
#[cfg(unix)]
const fn libc_sigabrt() -> i32 {
    6
}

fn database(directory: &tempfile::TempDir) -> PathBuf {
    directory.path().join("relay.sqlite3")
}

// ---------------------------------------------------------------------------
// The cases.
// ---------------------------------------------------------------------------

#[test]
fn a_crash_after_the_append_commit_loses_nothing_that_was_accepted() {
    let directory = tempfile::tempdir().unwrap();
    let path = database(&directory);
    crash_child(&path, "append", "after-append-commit");

    let store = open(&path);
    // The third append's receipt never reached its caller, so the relay never
    // said `accepted` for it — but the commit had already returned, so the row
    // must be there and the queue must be consistent with it. A store that lost
    // it would be a store whose fsync did not mean what it said.
    assert_eq!(
        stored(&store),
        vec![(0, 0xa1), (1, 0xa2), (2, 0xa3)],
        "everything committed before the abort must survive it"
    );
    let record = store.queue_by_recv(&RECV_ADDR, &RECV_KEY).unwrap();
    assert_eq!(record.state.next_index(), 3);
    assert_eq!(record.stored_messages, 3);
    assert_eq!(record.state.acked_through(), None);
}

#[test]
fn a_crash_before_the_append_commit_leaves_no_trace_of_it() {
    let directory = tempfile::tempdir().unwrap();
    let path = database(&directory);
    crash_child(&path, "append", "before-append-commit");

    let store = open(&path);
    assert_eq!(
        stored(&store),
        vec![(0, 0xa1), (1, 0xa2)],
        "an uncommitted append must leave no row"
    );
    let record = store.queue_by_recv(&RECV_ADDR, &RECV_KEY).unwrap();
    assert_eq!(
        record.state.next_index(),
        2,
        "an uncommitted append must not have consumed an index either — a torn \
         state where the counter moved but the row did not would silently \
         create a permanent gap in the reader's index space"
    );
    assert_eq!(record.stored_messages, 2);
}

#[test]
fn a_crash_after_the_ack_commit_leaves_nothing_acked_but_undeleted() {
    let directory = tempfile::tempdir().unwrap();
    let path = database(&directory);
    crash_child(&path, "ack", "after-ack-commit");

    let store = open(&path);
    let record = store.queue_by_recv(&RECV_ADDR, &RECV_KEY).unwrap();
    assert_eq!(record.state.acked_through(), Some(1));
    assert_eq!(
        stored(&store),
        vec![(2, 0xa3)],
        "every index at or below the persisted watermark must be gone"
    );
    assert_eq!(record.stored_messages, 1);
    assert_eq!(record.stored_bytes, 1024);
}

#[test]
fn a_crash_before_the_ack_commit_deletes_nothing() {
    let directory = tempfile::tempdir().unwrap();
    let path = database(&directory);
    crash_child(&path, "ack", "before-ack-commit");

    let store = open(&path);
    let record = store.queue_by_recv(&RECV_ADDR, &RECV_KEY).unwrap();
    assert_eq!(
        record.state.acked_through(),
        None,
        "an uncommitted ack must not have moved the watermark"
    );
    assert_eq!(
        stored(&store),
        vec![(0, 0xa1), (1, 0xa2), (2, 0xa3)],
        "an uncommitted ack must not have deleted anything; §8.3 makes the \
         client's retry safe precisely because this is true"
    );
    // And the retry §8.3 promises is safe actually is.
    let outcome = store.ack(&RECV_ADDR, &RECV_KEY, 1, 6_000).unwrap();
    assert_eq!(outcome.into_inner().acknowledged, 2);
    assert_eq!(stored(&store), vec![(2, 0xa3)]);
}

#[test]
fn the_reopened_store_still_refuses_a_pre_ack() {
    // §8.2 is a property of the queue, not of the process that created it: a
    // reader that could pre-ack after a restart could black-hole its queue just
    // as silently as one that could pre-ack before.
    let directory = tempfile::tempdir().unwrap();
    let path = database(&directory);
    crash_child(&path, "append", "after-append-commit");

    let store = open(&path);
    let error = store
        .ack(&RECV_ADDR, &RECV_KEY, 3, 6_000)
        .expect_err("acking beyond the highest appended index is ERR_ACK_TOO_HIGH");
    assert_eq!(error.error_code(), f2z_codec::ErrorCode::AckTooHigh);
    assert_eq!(stored(&store).len(), 3, "and the watermark did not move");

    // Bind-once survives the restart too (§7.3).
    let error = store
        .bind_send(&SEND_ADDR, &SEND_KEY, 7_000)
        .expect_err("a second BIND_SEND is ERR_ALREADY_BOUND, with any key");
    assert_eq!(error.error_code(), f2z_codec::ErrorCode::AlreadyBound);
    assert!(matches!(error, StoreError::Protocol(_)));
}
