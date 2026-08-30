//! #753 — a messaging store that will not open must make *messaging*
//! unavailable, not the wallet.
//!
//! A plugin whose `setup` returns `Err` makes `tauri::Builder::build()` fail,
//! and `wallet/zuuli/src-tauri/src/lib.rs` ends its `run()` in
//! `.expect("error while running tauri application")` — so until this landed,
//! an unopenable `f2zmsg.sqlite` took the whole ZUULI wallet down at launch.
//! WAL is unavailable on some filesystems, a data directory can be full or
//! read-only, and a half-written store from a killed process is a state a real
//! device reaches.
//!
//! This file proves the plugin half: the app builds, the managed state exists,
//! and it says why it has no engine. ZUULI's own
//! `an_unopenable_messaging_store_routes_only_engine_free_commands` proves the
//! other half — status and pure handle eligibility answer, while every
//! engine-dependent command and the enrollment trio refuse over IPC rather
//! than panic — because that needs the shipping capabilities, which only the
//! app crate has.
//!
//! **`SqliteBackend::open`'s strictness is not what changed.** It still
//! verifies every pragma and refuses otherwise, because §11.2 says a client
//! that cannot promise durability must not ACK. What changed is the blast
//! radius of that refusal.

#![cfg(not(target_os = "windows"))]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use tauri_plugin_f2zmsg::models::{EngineState, ErrorCode};
use tauri_plugin_f2zmsg::state::F2zMsgExt as _;

/// A data directory in which `f2zmsg.sqlite` cannot be opened.
///
/// The store path is occupied by a **directory**, so SQLite answers
/// `SQLITE_CANTOPEN` — the same result code a read-only or permission-denied
/// data directory produces, and the only way to produce it that needs neither
/// root nor a filesystem the test machine may not have.
fn unopenable_store() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temp data directory");
    std::fs::create_dir(dir.path().join("f2zmsg.sqlite")).expect("occupy the store path");
    dir
}

#[test]
fn a_store_that_will_not_open_still_lets_the_app_build() {
    let store = unopenable_store();
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_f2zmsg::init_with_store_dir(
            store.path().to_path_buf(),
        ))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("an unopenable messaging store must not stop the app from building");

    // The state is registered either way, and that is the whole design:
    // `F2zMsgExt::f2zmsg` is `state::<F2zMsg<R>>().inner()`, which *panics* on
    // an unmanaged type, so skipping `app.manage(..)` would turn every command
    // into a panic instead of a refusal.
    let state = app.f2zmsg();
    let fault = state
        .fault()
        .expect("the plugin must record why it has no engine");
    assert_eq!(
        fault.code(),
        ErrorCode::DurabilityUnavailable,
        "a store that cannot be opened for writing is not `internal`: {}",
        fault.context()
    );

    assert!(state.engine().is_err(), "there is no engine to hand out");
    assert!(state.engine_handle().is_err());

    // §6.1's `faulted`, so the UI can say *why* messaging is unavailable
    // instead of rendering an empty screen.
    let status = state.faulted_status().expect("a faulted status");
    assert_eq!(status.state, EngineState::Faulted);
    assert_eq!(status.last_error, Some(ErrorCode::DurabilityUnavailable));
}

/// The negative control. Without it the test above would still pass if
/// `init_with_store_dir` faulted unconditionally, and would prove nothing about
/// the store path at all.
#[test]
fn a_store_that_opens_is_not_faulted() {
    let store = tempfile::tempdir().expect("temp data directory");
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_f2zmsg::init_with_store_dir(
            store.path().to_path_buf(),
        ))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("an openable messaging store builds the app");

    let state = app.f2zmsg();
    assert!(
        state.fault().is_none(),
        "a writable directory must produce an engine, not a fault"
    );
    assert!(state.faulted_status().is_none());
    assert!(state.engine().is_ok());
}
