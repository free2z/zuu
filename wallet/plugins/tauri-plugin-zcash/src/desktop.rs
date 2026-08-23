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

    // Tauri resolves WebView state (including localStorage) through
    // app_local_data_dir. It is the same path as app_data_dir on Linux/macOS,
    // but a distinct LocalAppData sibling on Windows. Prepare it before Tauri
    // creates the WebView so the identifier cutover cannot orphan that tree.
    if crate::app_data_migration::is_zuuli_identifier(&app.config().identifier) {
        let local_data_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|e| crate::error::Error::Io(std::io::Error::other(e.to_string())))?;
        if local_data_dir != data_dir {
            match crate::app_data_migration::prepare(&local_data_dir, &app.config().identifier) {
                Ok(local_migration) => {
                    tracing::info!(?local_migration, "ZUULI local app-data directory prepared");
                }
                Err(error) => {
                    // This tree contains WebView/session state, never wallet
                    // identity. Preserve both trees and let the WebView start
                    // signed out rather than making its migration block access
                    // to a successfully prepared wallet.
                    tracing::warn!(
                        %error,
                        "could not migrate ZUULI local WebView data; preserving it and continuing"
                    );
                }
            }
        }
    }

    let seed_store = SeedStore::platform(data_dir.clone());
    let state = WalletState::new(data_dir, Network::MainNetwork, seed_store)?;

    Ok(Zcash {
        _app: app.clone(),
        state,
        legacy_app_data: migration.into(),
        sensitive_display: tokio::sync::Mutex::new(None),
    })
}

pub struct Zcash<R: Runtime> {
    pub _app: AppHandle<R>,
    pub state: WalletState,
    pub legacy_app_data: crate::models::LegacyAppDataStatus,
    pub sensitive_display: tokio::sync::Mutex<Option<String>>,
}

impl<R: Runtime> Zcash<R> {
    /// Desktop platforms do not expose a uniform screenshot-prevention API.
    /// Renderer lifecycle clearing still applies; mobile has native capture
    /// protection in addition to that boundary.
    pub fn set_sensitive_display(&self, _active: bool, _token: &str) -> crate::Result<()> {
        Ok(())
    }
}
