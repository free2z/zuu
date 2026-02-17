use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use models::*;

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
            commands::create_account,
            commands::list_accounts,
            commands::get_account_balance,
            commands::get_unified_address,
            commands::start_sync,
            commands::stop_sync,
            commands::get_sync_status,
            commands::send_transaction,
            commands::get_transaction_history,
            commands::set_lightwalletd_url,
            commands::parse_payment_uri,
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

            Ok(())
        })
        .build()
}
