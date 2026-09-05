//! `tauri-plugin-f2zmsg` — free2z end-to-end encrypted messaging, as
//! `docs/e2ee/CLIENT-CONTRACT.md` §3 describes it.
//!
//! The TypeScript half of this contract already exists and is merged:
//! `wallet/e2e2z/src/lib/messaging/` carries `types.ts`, `bridge.ts`,
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
//! | [`custody`] | Where this device's `DeviceWrapKey` lives, per platform, and the refusal where it cannot. |
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

macro_rules! command_names {
    ($($command:ident),* $(,)?) => {
        &[$(stringify!($command)),*]
    };
}

/// §3's plugin command surface as data.
///
/// The same `with_f2zmsg_commands!` expansion that generates the invoke handler
/// and `build.rs`'s permission manifest, so a command cannot be registered and
/// left out of this list. It is public because the *app* crate needs it: ZUULI's
/// census test for #753 drives every command through IPC against a deliberately
/// unopenable store, and a hand-written list there would go stale the first time
/// §3 grows.
pub const COMMANDS: &[&str] = with_f2zmsg_commands!(command_names);

pub mod custody;
#[cfg(mobile)]
mod custody_mobile;
pub mod directory;
pub mod engine;
pub mod envelope;
pub mod error;
pub mod events;
pub mod handle;
pub mod models;
pub mod relay;
pub mod state;
pub mod store;
pub mod wire_codes;

mod commands;

pub use custody::{WrapKeyCustody, WrapKeyNamespace};
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

/// Where the durable store lives.
enum StoreLocation {
    /// The app's data directory — what a shipping build uses.
    AppData,
    /// An explicit directory. The only reason this exists is that #753 is a
    /// defect about what happens when the store will *not* open, and a test
    /// cannot make the app data directory unopenable without wrecking the
    /// developer's machine.
    Fixed(std::path::PathBuf),
}

/// Open the durable store and build the engine over it.
///
/// Every failure on this path is a §8 code rather than an opaque io error,
/// because the code is what the frontend will be told for the rest of the
/// process's life (#753).
fn open_engine<R: Runtime>(
    app: &tauri::AppHandle<R>,
    location: &StoreLocation,
    custody: custody::WrapKeyCustody,
) -> Result<Arc<engine::Engine<state::Backend>>> {
    let data_dir = match location {
        StoreLocation::AppData => app.path().app_data_dir().map_err(|error| {
            Error::internal(format!("resolving the app data directory: {error}"))
        })?,
        StoreLocation::Fixed(dir) => dir.clone(),
    };
    // `From<std::io::Error>` is what turns a full or quota-exceeded volume into
    // §8's `storage-full` here.
    std::fs::create_dir_all(&data_dir)?;
    let backend = f2z_msg_store::SqliteBackend::open(&data_dir.join(STORE_FILE))
        .map_err(|error| Error::store_did_not_open(&error))?;

    let platform = if cfg!(any(target_os = "android", target_os = "ios")) {
        models::Platform::ZuuliMobile
    } else {
        models::Platform::ZuuliDesktop
    };
    let sink = Arc::new(events::TauriSink::new(app.clone()));
    Ok(Arc::new(
        engine::Engine::new(backend, sink, platform)?.with_wrap_key_custody(custody),
    ))
}

/// Build device wrap-key custody for the host application (#937).
///
/// Never fails: a namespace this application does not own, or a native plugin
/// that will not register, becomes [`custody::WrapKeyCustody::unavailable`] and
/// a loud log line. `setup` must not return `Err` (#753), and "there is no
/// store" is a state this design already answers — enrollment refuses, per
/// [`custody`]'s module header §3 — rather than one that has to abort a launch.
fn open_custody<R: Runtime, C: serde::de::DeserializeOwned>(
    app: &tauri::AppHandle<R>,
    api: tauri::plugin::PluginApi<R, C>,
    namespace: &str,
) -> custody::WrapKeyCustody {
    // The mobile bridge is the only consumer of `api`; a desktop build has no
    // native plugin to register.
    #[cfg(desktop)]
    let _ = api;

    let identifier = &app.config().identifier;
    let namespace = match custody::WrapKeyNamespace::for_app(namespace, identifier) {
        Ok(namespace) => namespace,
        Err(error) => {
            // A namespace copied between the two apps is the one mistake the
            // per-application rule exists to catch, and it is invisible without
            // this line: on a shared Secret Service both apps would open one
            // wrap key and nothing would look wrong (ADR 0016 §3).
            tracing::error!(%error, "device wrap-key custody is unavailable");
            return custody::WrapKeyCustody::unavailable(error.to_string());
        }
    };

    #[cfg(mobile)]
    {
        custody_mobile::custody(app, api, namespace)
    }
    #[cfg(desktop)]
    {
        custody::WrapKeyCustody::desktop(namespace)
    }
}

fn plugin<R: Runtime>(location: StoreLocation, wrap_key_namespace: &'static str) -> TauriPlugin<R> {
    command_builder()
        .setup(move |app, api| {
            let custody = open_custody(app, api, wrap_key_namespace);
            tracing::info!(
                custody = ?custody.kind(),
                namespace = custody.namespace().unwrap_or("none"),
                "device wrap-key custody"
            );
            // **This hook must not return `Err`, ever** (#753). A plugin whose
            // `setup` fails makes `tauri::Builder::build()` fail, and ZUULI's
            // `run()` ends in `.expect("error while running tauri
            // application")` — so an unopenable messaging store used to take
            // the entire wallet down at launch. WAL is unavailable on some
            // filesystems, a data directory can be full or read-only, and a
            // half-written `f2zmsg.sqlite` is a state a real device reaches.
            //
            // Failing soft is *not* skipping `app.manage(..)`: `f2zmsg()` is
            // `state::<F2zMsg<R>>().inner()`, which panics on an unmanaged
            // type, so every engine-dependent command would panic instead of
            // refusing. The state is registered either way and answers either
            // way; pure handle eligibility does not need to consult it (#762).
            match open_engine(app, &location, custody) {
                Ok(engine) => {
                    app.manage(state::F2zMsg::new(app.clone(), Arc::clone(&engine)));

                    // The receive loop. It runs for the life of the process and
                    // does nothing at all until the engine is unlocked and
                    // started, which is why it is spawned here rather than from
                    // `start_engine`: a task started and stopped by a command is
                    // a task that can be left stopped by a command that failed
                    // halfway. There is nothing to poll without an engine, so
                    // the faulted arm spawns no task at all.
                    tauri::async_runtime::spawn(async move {
                        loop {
                            tokio::time::sleep(POLL_INTERVAL).await;
                            if let Err(error) = engine.pump_inbound().await {
                                tracing::debug!(code = %error.code(), "inbound poll");
                            }
                        }
                    });
                }
                Err(fault) => {
                    // The one place this is recorded. `Error`'s `Serialize`
                    // logs each refusal that crosses IPC, but the *cause* is
                    // here and nowhere else, and it is what a support log needs
                    // to tell a network mount apart from a full disk.
                    tracing::error!(
                        code = %fault.code(),
                        context = %fault.context(),
                        "messaging is unavailable: the durable store did not open"
                    );
                    app.manage(state::F2zMsg::faulted(app.clone(), fault));
                }
            }

            Ok(())
        })
        .on_event(|app, event| {
            // §9 rule 6, and the whole reason this handler is not a copy of
            // `tauri-plugin-zcash`'s: NOT `WindowEvent::Focused(false)`.
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                // A faulted plugin never built an engine, so there is nothing
                // to shut down and nothing to wait for (#753).
                if let Ok(engine) = app.f2zmsg().engine_handle() {
                    tauri::async_runtime::spawn(async move {
                        engine.shutdown().await;
                    });
                }
            }
        })
        .build()
}

/// Initialize the plugin.
///
/// `wrap_key_namespace` is the OS-secret-store service name this application's
/// `DeviceWrapKey` lives under — `cash.free2z.zuuli.f2zmsg.wrap.v1` or
/// `cash.free2z.e2e2z.f2zmsg.wrap.v1`.
///
/// **It is an argument and not a constant in this crate, and that is a
/// decision** (ADR 0016 §3, and [`custody`]'s module header §1). This plugin is
/// linked into both apps; a plugin-level constant would give them the same item
/// name, and on the freedesktop Secret Service — which has no per-application
/// isolation — that is mutual overwrite, or one app opening the other's key.
/// The precedent is `tauri-plugin-zcash`'s
/// `const SERVICE = "cash.free2z.zuuli.seed.v1"`: one app, one purpose, one
/// version.
///
/// The value must begin with the host's own bundle identifier; one that does
/// not is refused at setup and leaves custody unavailable, so a namespace
/// copied from the other application cannot enroll.
pub fn init<R: Runtime>(wrap_key_namespace: &'static str) -> TauriPlugin<R> {
    plugin(StoreLocation::AppData, wrap_key_namespace)
}

/// The shipping plugin with its store forced to `store_dir`.
///
/// A test seam, and specifically #753's: it is the only way to build the real
/// `setup` hook over a store that cannot be opened.
#[doc(hidden)]
pub fn init_with_store_dir<R: Runtime>(
    store_dir: std::path::PathBuf,
    wrap_key_namespace: &'static str,
) -> TauriPlugin<R> {
    plugin(StoreLocation::Fixed(store_dir), wrap_key_namespace)
}

#[cfg(test)]
mod command_registry_tests {
    use super::COMMANDS;

    /// `CLIENT-CONTRACT.md` §3's plugin command surface: 46 bridge methods
    /// minus the enrollment trio, which is the app crate's (§2.2).
    const EXPECTED: usize = 43;

    #[test]
    fn the_registry_is_the_contracts_plugin_surface() {
        let commands: &[&str] = COMMANDS;
        assert_eq!(
            commands.len(),
            EXPECTED,
            "command registry population changed"
        );

        let mut sorted = commands.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            commands.len(),
            "a command is registered twice"
        );

        for forbidden in [
            "f2zmsg_enroll",
            "f2zmsg_enrollment_status",
            "f2zmsg_unenroll",
        ] {
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
        assert_eq!(env!("F2ZMSG_BUILD_COMMANDS"), COMMANDS.join(","));
    }
}
