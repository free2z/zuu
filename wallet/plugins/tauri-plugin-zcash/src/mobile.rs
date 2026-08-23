use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, Runtime,
    plugin::{PluginApi, PluginHandle, mobile::PluginInvokeError},
};
use zeroize::Zeroizing;

use crate::wallet::WalletState;
use crate::wallet::keychain::{SecureStore, SecureStoreError, SeedStore};
use zcash_protocol::consensus::Network;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "cash.free2z.zuuli.zcash";

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_zcash);

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Zcash<R>> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| crate::error::Error::Io(std::io::Error::other(e.to_string())))?;
    let migration = crate::app_data_migration::prepare(&data_dir, &app.config().identifier)
        .map_err(|error| crate::error::Error::Other(error.to_string()))?;
    tracing::info!(?migration, "ZUULI app-data directory prepared");

    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "ZcashPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_zcash)?;

    #[cfg(target_os = "ios")]
    {
        let path = data_dir.to_str().ok_or_else(|| {
            crate::error::Error::Other(
                "iOS wallet data path is not valid UTF-8; refusing to open it".into(),
            )
        })?;
        handle
            .run_mobile_plugin::<()>("excludeDataFromBackup", DataPathArgs { path })
            .map_err(|error| {
                crate::error::Error::Other(format!(
                    "could not exclude the iOS wallet data directory from backup: {error}"
                ))
            })?;
    }

    let native_store: Arc<dyn SecureStore> = Arc::new(MobileSecretStore(handle.clone()));
    let seed_store = SeedStore::new(data_dir.clone(), native_store);
    let state = WalletState::new(data_dir, Network::MainNetwork, seed_store)?;

    Ok(Zcash {
        _app: app.clone(),
        state,
        legacy_app_data: migration.into(),
        mobile_plugin: handle,
        sensitive_display: tokio::sync::Mutex::new(None),
    })
}

pub struct Zcash<R: Runtime> {
    pub _app: AppHandle<R>,
    pub state: WalletState,
    pub legacy_app_data: crate::models::LegacyAppDataStatus,
    mobile_plugin: PluginHandle<R>,
    pub sensitive_display: tokio::sync::Mutex<Option<String>>,
}

impl<R: Runtime> Zcash<R> {
    pub fn set_sensitive_display(&self, active: bool, token: &str) -> crate::Result<()> {
        self.mobile_plugin
            .run_mobile_plugin::<()>(
                "setSensitiveDisplay",
                SensitiveDisplayArgs { active, token },
            )
            .map_err(|error| {
                crate::error::Error::Other(format!(
                    "native sensitive-display protection failed: {error}"
                ))
            })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SensitiveDisplayArgs<'a> {
    active: bool,
    token: &'a str,
}

struct MobileSecretStore<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> SecureStore for MobileSecretStore<R> {
    fn store(&self, wallet_id: &str, phrase: &str) -> Result<(), SecureStoreError> {
        self.0
            .run_mobile_plugin("storeSeed", StoreSeedArgs { wallet_id, phrase })
            .map_err(map_mobile_error)
    }

    fn get(&self, wallet_id: &str) -> Result<Zeroizing<String>, SecureStoreError> {
        self.0
            .run_mobile_plugin::<SeedValue>("getSeed", SeedKeyArgs { wallet_id })
            .map(|value| Zeroizing::new(value.phrase))
            .map_err(map_mobile_error)
    }

    fn delete(&self, wallet_id: &str) -> Result<(), SecureStoreError> {
        self.0
            .run_mobile_plugin("deleteSeed", SeedKeyArgs { wallet_id })
            .map_err(map_mobile_error)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SeedKeyArgs<'a> {
    wallet_id: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoreSeedArgs<'a> {
    wallet_id: &'a str,
    phrase: &'a str,
}

#[cfg(target_os = "ios")]
#[derive(Serialize)]
struct DataPathArgs<'a> {
    path: &'a str,
}

#[derive(Deserialize)]
struct SeedValue {
    phrase: String,
}

fn map_mobile_error(error: PluginInvokeError) -> SecureStoreError {
    match error {
        PluginInvokeError::InvokeRejected(response) => match response.code.as_deref() {
            Some("not_found") => SecureStoreError::NotFound,
            Some("auth_cancelled") => SecureStoreError::AuthCancelled,
            Some("auth_failed") => SecureStoreError::AuthenticationFailed,
            Some("locked") => SecureStoreError::Locked,
            Some("corrupt") => SecureStoreError::Corrupt,
            Some("unavailable") => SecureStoreError::Unavailable,
            _ => SecureStoreError::Backend(
                response
                    .message
                    .unwrap_or_else(|| "native plugin rejected the request".into()),
            ),
        },
        PluginInvokeError::CannotDeserializeResponse(_) => SecureStoreError::Corrupt,
        PluginInvokeError::UnreachableWebview => SecureStoreError::Unavailable,
        #[cfg(target_os = "android")]
        PluginInvokeError::Jni(_) => SecureStoreError::Unavailable,
        other => SecureStoreError::Backend(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::plugin::mobile::ErrorResponse;

    fn rejected(code: &str) -> PluginInvokeError {
        PluginInvokeError::InvokeRejected(ErrorResponse {
            code: Some(code.into()),
            message: None,
            data: (),
        })
    }

    #[test]
    fn native_error_codes_remain_distinct() {
        assert_eq!(
            map_mobile_error(rejected("not_found")),
            SecureStoreError::NotFound
        );
        assert_eq!(
            map_mobile_error(rejected("auth_cancelled")),
            SecureStoreError::AuthCancelled
        );
        assert_eq!(
            map_mobile_error(rejected("auth_failed")),
            SecureStoreError::AuthenticationFailed
        );
        assert_eq!(
            map_mobile_error(rejected("locked")),
            SecureStoreError::Locked
        );
        assert_eq!(
            map_mobile_error(rejected("corrupt")),
            SecureStoreError::Corrupt
        );
        assert_eq!(
            map_mobile_error(rejected("unavailable")),
            SecureStoreError::Unavailable
        );
    }
}
