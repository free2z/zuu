//! Kill a real process mid-commit, reopen the file, and check what survived.
//!
//! # Why this test is shaped the way it is
//!
//! Under delete-on-ack the relay deletes its copy of a message the instant the
//! client acknowledges ([`ARCHITECTURE.md` §6.4][s64]). So the client's store
//! is, for a window, the only copy — and the question that decides whether a
//! client may `ACK` at all is *what is on the disk after the machine stops*.
//! Two invariants, and neither is observable from inside a healthy process:
//!
//! - **Nothing half-applied.** A crash before the commit leaves **no trace** of
//!   the operation: not the group state, not the application's "handled"
//!   record, not one key of the several a logical operation writes. The message
//!   is still on the relay, un-acknowledged, and will be redelivered.
//! - **Nothing lost after the commit.** A crash *after* the commit's fsync
//!   returned — but before the caller was told — leaves the operation
//!   **complete**. The caller never acknowledged, so the message is redelivered
//!   and dropped as a duplicate. That is correct; a half-applied group is not.
//!
//! **A caught panic does not test this.** An in-process `catch_unwind` leaves
//! the SQLite connection alive and runs `Drop` on the open transaction — which
//! in this crate *rolls it back*, i.e. produces the very outcome under test
//! regardless of whether the durability works. So each case below runs in a
//! **child process** that calls `abort()` at a chosen instant inside the
//! library, and the parent asserts on the file the child left behind, from a
//! fresh connection, after the child is confirmed dead.
//!
//! The parent also asserts *how* the child died: killed by a signal, not
//! exited. A child that returned an exit code did not crash, it finished, and a
//! test that accepted that would pass even if the injection point had been
//! deleted.
//!
//! Run with `cargo test -p f2z-msg-store --features crash-injection --test crash_safety`.
//!
//! [s64]: https://github.com/free2z/zuu/blob/main/docs/e2ee/ARCHITECTURE.md#64-delete-on-ack-and-lost-acknowledgements

// Only compiled when the injection point exists. Without the feature there is
// nothing to fire and the file is empty on purpose: a silently-passing crash
// test is worse than no crash test.
#![cfg(all(feature = "crash-injection", feature = "sqlite"))]
// Test code, run on the host by a person reading the failure.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::path::{Path, PathBuf};
use std::process::Command;

use f2z_msg_store::crash::{CRASH_POINT_ENV, arm_from_env};
use f2z_msg_store::{F2zStorageProvider, SqliteBackend, StorageBackend as _};

/// Which side of the crash the child is meant to be on.
const SCENARIO_ENV: &str = "F2Z_MSG_STORE_CRASH_SCENARIO";
const DB_ENV: &str = "F2Z_MSG_STORE_CRASH_DB";

/// The keys one logical operation writes. Several, on purpose: a store that
/// committed them one at a time would leave a subset behind, and a subset is
/// what "half-applied" means.
const KEYS: &[&[u8]] = &[b"group-state", b"epoch-secrets", b"tree", b"handled/msg-1"];

fn open(path: &Path) -> F2zStorageProvider<SqliteBackend> {
    F2zStorageProvider::new(SqliteBackend::open(path).expect("open"))
}

/// One logical operation: several writes, one transaction.
fn one_operation(store: &F2zStorageProvider<SqliteBackend>) {
    let transaction = store.begin().expect("begin");
    for key in KEYS {
        store.put_app(key, b"value").expect("put");
    }
    transaction.commit().expect("commit");
}

/// The child. Arms the injection point named by the environment, then performs
/// exactly one operation and dies inside it.
fn child() -> ! {
    let path = PathBuf::from(std::env::var(DB_ENV).expect("db path"));
    arm_from_env();
    let store = open(&path);
    one_operation(&store);
    // Reached only if nothing fired. The parent checks for a signal death, so
    // this exit code is what a *deleted injection point* looks like.
    std::process::exit(97);
}

/// Re-exec this test binary as the child, with the crash point armed.
fn run_child(crash_point: &str, db: &Path) -> std::process::Output {
    let exe = std::env::current_exe().expect("current exe");
    Command::new(exe)
        .arg("--exact")
        .arg("the_child_worker")
        .arg("--nocapture")
        .env(SCENARIO_ENV, "1")
        .env(CRASH_POINT_ENV, crash_point)
        .env(DB_ENV, db)
        .output()
        .expect("spawn child")
}

/// The entry point the parent re-execs into. It is a `#[test]` because that is
/// the only way to be selectable by name in a test binary; it does nothing at
/// all unless the parent set [`SCENARIO_ENV`].
#[test]
fn the_child_worker() {
    if std::env::var(SCENARIO_ENV).is_ok() {
        child();
    }
}

fn died_by_signal(output: &std::process::Output) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt as _;
        output.status.signal().is_some()
    }
    #[cfg(not(unix))]
    {
        !output.status.success()
    }
}

/// A crash with the write set staged and the backend not yet told must leave
/// **nothing** — not a subset, not one key.
#[test]
fn a_crash_before_the_commit_leaves_no_trace_of_the_operation() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("mls.sqlite");
    // Create the file first, so the child is not also testing schema creation.
    drop(open(&db));

    let output = run_child("before-commit", &db);
    assert!(
        died_by_signal(&output),
        "the child must have been killed, not have exited: {:?}",
        output.status
    );

    let store = open(&db);
    for key in KEYS {
        assert_eq!(
            store.get_app(key).expect("get"),
            None,
            "key {} survived a pre-commit crash",
            String::from_utf8_lossy(key)
        );
    }
    assert!(
        store.backend().is_empty().expect("is_empty"),
        "the store must be empty after a pre-commit crash"
    );
}

/// A crash after the commit's fsync returned, before the caller was told, must
/// leave the operation **complete** — every key, not some of them.
#[test]
fn a_crash_after_the_commit_leaves_the_whole_operation() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("mls.sqlite");
    drop(open(&db));

    let output = run_child("after-commit", &db);
    assert!(
        died_by_signal(&output),
        "the child must have been killed, not have exited: {:?}",
        output.status
    );

    let store = open(&db);
    for key in KEYS {
        assert_eq!(
            store.get_app(key).expect("get"),
            Some(b"value".to_vec()),
            "key {} did not survive a post-commit crash",
            String::from_utf8_lossy(key)
        );
    }
}

/// The negative control. With nothing armed the child must run to completion
/// and exit 97 — so a run in which the injection point had been deleted would
/// fail the two tests above rather than pass them for the wrong reason.
#[test]
fn an_unarmed_child_finishes_instead_of_crashing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("mls.sqlite");
    drop(open(&db));

    let output = run_child("never", &db);
    assert!(
        !died_by_signal(&output),
        "an unarmed child must not be killed"
    );
    assert_eq!(output.status.code(), Some(97));

    let store = open(&db);
    for key in KEYS {
        assert_eq!(store.get_app(key).expect("get"), Some(b"value".to_vec()));
    }
}
