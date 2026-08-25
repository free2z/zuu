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

pub use models::*;

mod app_data_migration;
#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
pub mod error;
mod legacy_import_preview;
pub mod models;
pub mod wallet;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::Zcash;
#[cfg(mobile)]
use mobile::Zcash;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the Zcash APIs.
pub trait ZcashExt<R: Runtime> {
    fn zcash(&self) -> &Zcash<R>;
}

impl<R: Runtime, T: Manager<R>> ZcashExt<R> for T {
    fn zcash(&self) -> &Zcash<R> {
        self.state::<Zcash<R>>().inner()
    }
}

/// Builds the command handler shared by the shipping plugin and IPC probe.
fn command_builder<R: Runtime>() -> Builder<R> {
    Builder::new("zcash").invoke_handler(with_zcash_commands!(command_handler))
}

/// Builds the exact production command router without platform setup hooks.
/// This exists for compiler-bound IPC probes in the consuming Tauri apps.
#[doc(hidden)]
pub fn command_router<R: Runtime>() -> TauriPlugin<R> {
    command_builder().build()
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    // Install the rustls crypto provider before any TLS connections
    let _ = rustls::crypto::ring::default_provider().install_default();

    command_builder()
        .setup(|app, api| {
            #[cfg(mobile)]
            {
                let zcash = mobile::init(app, api)?;
                app.manage(zcash);
            }

            #[cfg(desktop)]
            {
                let zcash = desktop::init(app, api)?;
                app.manage(zcash);
            }

            let cleanup_app = app.clone();
            tauri::async_runtime::spawn(async move {
                commands::resume_wallet_cleanup_after_setup(cleanup_app).await;
            });

            Ok(())
        })
        .on_event(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                app.zcash().state.sync_supervisor.begin_shutdown();
            }
            let must_lock = matches!(
                event,
                tauri::RunEvent::Exit
                    | tauri::RunEvent::ExitRequested { .. }
                    | tauri::RunEvent::WindowEvent {
                        event: tauri::WindowEvent::Focused(false),
                        ..
                    }
            );
            if must_lock {
                let seed = app.zcash().state.seed.clone();
                tauri::async_runtime::spawn(async move {
                    *seed.lock().await = None;
                    tracing::debug!("cleared in-memory wallet seed on lifecycle lock");
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

    #[test]
    fn sensitive_entry_is_in_the_runtime_and_permission_registry() {
        let commands: &[&str] = with_zcash_commands!(command_names);
        assert_eq!(commands.len(), 39, "command registry population changed");
        assert_eq!(
            commands
                .iter()
                .filter(|command| **command == "begin_sensitive_entry")
                .count(),
            1,
            "sensitive entry must have exactly one shared registration",
        );
    }

    #[test]
    fn build_script_uses_the_shared_command_population() {
        let commands: &[&str] = with_zcash_commands!(command_names);
        assert_eq!(env!("ZCASH_BUILD_COMMANDS"), commands.join(","));
    }
}
