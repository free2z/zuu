//! `tauri-plugin-f2zmsg` — free2z end-to-end encrypted messaging, as
//! `docs/e2ee/CLIENT-CONTRACT.md` §3 describes it.
//!
//! The TypeScript half of this contract already exists and is merged:
//! `wallet/zuuli/src/lib/messaging/` carries `types.ts`, `bridge.ts`,
//! `events.ts`, `mock.ts` and a mechanical parity test, written against the
//! same document. This crate is what makes its non-mock path real.
//!
//! # The two rules a reader should have in mind before anything else
//!
//! **1. Never ACK before the durable local write completes.** The relay deletes
//! on ACK, so an ACK plus a crash is permanent message loss — not recoverable
//! from the relay, from the peer, or from the mnemonic. `engine::Engine`'s
//! module header spells out the exact order, and `relay::RelayConnection::ack`
//! restates it where an implementer's cursor will be.
//!
//! **2. This plugin's `on_event` handler is deliberately not
//! `tauri-plugin-zcash`'s.** That plugin clears its in-memory seed on
//! `WindowEvent::Focused(false)`. Desktop windows lose focus constantly — every
//! alt-tab, every notification, every spotlight search — and a messaging engine
//! that tore its state down on blur would drop relay connections, stop
//! acknowledging inbound messages, and leave ciphertext sitting on relays every
//! time the user looked at another window. §9 rule 6 says so in as many words.
//! `Exit` and `ExitRequested` only.
//!
//! # Where the pieces are
//!
//! | Module | What it owns |
//! |---|---|
//! | [`models`] | Every wire shape, mirroring `types.ts`. |
//! | [`error`] | A refusal reaches the webview as one §8 code and nothing else. |
//! | [`framing`] | §7's envelope, `msg_id` and total order — the `f2z-msg-dag` seam. |
//! | [`store`] | The durable record layer over `f2z-msg-store`'s app namespace. |
//! | [`relay`] | ZUULI's `WIRE.md` v1 client. |
//! | [`directory`] | The key-transparency seam. Fails closed, by design. |
//! | [`engine`] | Everything §3 asks for, with no Tauri in it. |
//! | [`events`] | §5's eleven events, behind a sink the harness can substitute. |
//! | [`commands`] | The IPC layer, and the only file that names `AppHandle`. |
//!
//! # Enrollment is not here
//!
//! `f2zmsg_enroll`, `f2zmsg_enrollment_status` and `f2zmsg_unenroll` live in
//! `wallet/zuuli/src-tauri/src/messaging.rs` and are invoked with **no**
//! `plugin:` prefix. Enrollment needs the wallet seed; routing it through a
//! plugin would mean the mnemonic crossing IPC into a garbage-collected
//! JavaScript heap that nothing can zeroize (§2.2). The app crate reads the
//! seed in process, derives the §4.2 keys, and calls this crate's Rust API —
//! [`engine::Engine::prepare_device`] and [`engine::Engine::install_identity`]
//! — which never sees the seed either.

use std::sync::Arc;

use tauri::{
    Manager, Runtime,
    plugin::{Builder, TauriPlugin},
};

include!("../command_registry.rs");

macro_rules! command_handler {
    ($($command:ident),* $(,)?) => {
        tauri::generate_handler![$(commands::$command),*]
    };
}

pub mod directory;
pub mod engine;
pub mod error;
pub mod events;
pub mod framing;
pub mod handle;
pub mod models;
pub mod relay;
pub mod state;
pub mod store;
pub mod wire_codes;

mod commands;

pub use error::{Error, Result};
pub use models::*;
pub use state::{F2zMsg, F2zMsgExt};

/// How often the receive task polls each conversation's queue.
///
/// A poll and not a push, deliberately: `WIRE.md` §4.3 lets a `MSG` push
/// interleave with responses, and a client that treated a push as the delivery
/// path would lose everything that arrived while it was disconnected. Pushes
/// are still drained and shorten the wait; this is the floor.
const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

/// The plugin's SQLite file, under the app's data directory.
const STORE_FILE: &str = "f2zmsg.sqlite";

/// Builds the command handler shared by the shipping plugin and IPC probes.
fn command_builder<R: Runtime>() -> Builder<R> {
    Builder::new("f2zmsg").invoke_handler(with_f2zmsg_commands!(command_handler))
}

/// The exact production command router without platform setup hooks, for
/// compiler-bound IPC probes in the consuming app.
#[doc(hidden)]
pub fn command_router<R: Runtime>() -> TauriPlugin<R> {
    command_builder().build()
}

/// Initialize the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    command_builder()
        .setup(|app, _api| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let backend = f2z_msg_store::SqliteBackend::open(&data_dir.join(STORE_FILE))
                .map_err(|error| std::io::Error::other(error.to_string()))?;

            let platform = if cfg!(any(target_os = "android", target_os = "ios")) {
                models::Platform::ZuuliMobile
            } else {
                models::Platform::ZuuliDesktop
            };
            let sink = Arc::new(events::TauriSink::new(app.clone()));
            let engine = Arc::new(engine::Engine::new(backend, sink, platform).map_err(
                |error| std::io::Error::other(format!("messaging engine: {}", error.context())),
            )?);

            app.manage(state::F2zMsg::new(app.clone(), Arc::clone(&engine)));

            // The receive loop. It runs for the life of the process and does
            // nothing at all until the engine is unlocked and started, which is
            // why it is spawned here rather than from `start_engine`: a task
            // started and stopped by a command is a task that can be left
            // stopped by a command that failed halfway.
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(POLL_INTERVAL).await;
                    if let Err(error) = engine.pump_inbound().await {
                        tracing::debug!(code = %error.code(), "inbound poll");
                    }
                }
            });

            Ok(())
        })
        .on_event(|app, event| {
            // §9 rule 6, and the whole reason this handler is not a copy of
            // `tauri-plugin-zcash`'s: NOT `WindowEvent::Focused(false)`.
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                let engine = app.f2zmsg().engine_handle();
                tauri::async_runtime::spawn(async move {
                    engine.shutdown().await;
                });
            }
        })
        .build()
}

#[cfg(test)]
mod command_registry_tests {
    macro_rules! command_names {
        ($($command:ident),* $(,)?) => {
            &[$(stringify!($command)),*]
        };
    }

    /// `CLIENT-CONTRACT.md` §3's plugin command surface: 46 bridge methods
    /// minus the enrollment trio, which is the app crate's (§2.2).
    const EXPECTED: usize = 43;

    #[test]
    fn the_registry_is_the_contracts_plugin_surface() {
        let commands: &[&str] = with_f2zmsg_commands!(command_names);
        assert_eq!(commands.len(), EXPECTED, "command registry population changed");

        let mut sorted = commands.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), commands.len(), "a command is registered twice");

        for forbidden in ["f2zmsg_enroll", "f2zmsg_enrollment_status", "f2zmsg_unenroll"] {
            assert!(
                !commands.contains(&forbidden),
                "{forbidden} needs the wallet seed and belongs in the app crate (§2.2)"
            );
        }
    }

    #[test]
    fn the_build_script_saw_the_same_population() {
        // `build.rs` writes the list it generated permissions from into the
        // environment. If the two ever disagree, a command exists at runtime
        // with no permission, or a permission exists for no command.
        let commands: &[&str] = with_f2zmsg_commands!(command_names);
        assert_eq!(env!("F2ZMSG_BUILD_COMMANDS"), commands.join(","));
    }
}
