use serde::de::DeserializeOwned;
use tauri::{AppHandle, Manager, Runtime, plugin::PluginApi};

use crate::wallet::WalletState;
use crate::wallet::keychain::SeedStore;
use zcash_protocol::consensus::Network;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Zcash<R>> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| crate::error::Error::Io(std::io::Error::other(e.to_string())))?;
    let migration = crate::app_data_migration::prepare(&data_dir, &app.config().identifier)
        .map_err(|error| crate::error::Error::Other(error.to_string()))?;
    tracing::info!(?migration, "ZUULI app-data directory prepared");

    // Linux and Windows place WebView state (including localStorage) under
    // app_local_data_dir. It is the same path as app_data_dir on Linux/macOS,
    // but a distinct LocalAppData sibling on Windows. Prepare it before Tauri
    // creates the WebView so the identifier cutover cannot orphan that tree.
    if crate::app_data_migration::is_zuuli_identifier(&app.config().identifier) {
        let local_data_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|e| crate::error::Error::Io(std::io::Error::other(e.to_string())))?;
        if local_data_dir != data_dir {
            let local_migration =
                crate::app_data_migration::prepare(&local_data_dir, &app.config().identifier)
                    .map_err(|error| crate::error::Error::Other(error.to_string()))?;
            tracing::info!(?local_migration, "ZUULI local app-data directory prepared");
        }
    }

    let seed_store = SeedStore::platform(data_dir.clone());
    let state = WalletState::new(data_dir, Network::MainNetwork, seed_store);

    Ok(Zcash {
        _app: app.clone(),
        state,
    })
}

pub struct Zcash<R: Runtime> {
    pub _app: AppHandle<R>,
    pub state: WalletState,
}
