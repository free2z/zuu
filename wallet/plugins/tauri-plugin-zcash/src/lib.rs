use tauri::{
    Manager, Runtime,
    plugin::{Builder, TauriPlugin},
};

pub use models::*;

mod app_data_migration;
#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
pub mod error;
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

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    // Install the rustls crypto provider before any TLS connections
    let _ = rustls::crypto::ring::default_provider().install_default();

    Builder::new("zcash")
        .invoke_handler(tauri::generate_handler![
            commands::create_wallet,
            commands::restore_wallet,
            commands::get_wallet_status,
            commands::retry_wallet_cleanup,
            commands::get_seed_phrase,
            commands::get_backup_seed_phrase,
            commands::confirm_wallet_backup,
            commands::begin_sensitive_display,
            commands::end_sensitive_display,
            commands::get_viewing_key,
            commands::get_spending_key,
            commands::list_wallets,
            commands::switch_wallet,
            commands::rename_wallet,
            commands::delete_wallet,
            commands::unlock_wallet,
            commands::create_account,
            commands::list_accounts,
            commands::get_account_balance,
            commands::get_unified_address,
            commands::start_sync,
            commands::stop_sync,
            commands::get_sync_status,
            commands::ensure_sapling_params,
            commands::propose_send,
            commands::propose_send_all,
            commands::execute_send,
            commands::discard_send_proposal,
            commands::get_pending_send,
            commands::retry_pending_send,
            commands::discard_unrecoverable_send,
            commands::get_transaction_history,
            commands::set_lightwalletd_url,
            commands::parse_payment_uri,
            commands::validate_address,
            commands::sign_challenge,
        ])
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
