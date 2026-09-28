//! OS credentials initialized only inside the SDK's blocking storage worker.
use f2z_sdk::{KeyringStore, Persistence, Secret, StoreError, TokenStore};
use std::sync::{Arc, OnceLock};

pub struct PlatformStore {
    service: String,
    store: OnceLock<std::result::Result<KeyringStore, StoreError>>,
}
impl PlatformStore {
    pub fn new(service: String) -> Self {
        Self {
            service,
            store: OnceLock::new(),
        }
    }
    fn get(&self) -> std::result::Result<&KeyringStore, StoreError> {
        self.store
            .get_or_init(|| {
                let store = platform_store()
                    .map_err(|_| StoreError("OS credential store unavailable".into()))?;
                Ok(KeyringStore::new(store, &self.service))
            })
            .as_ref()
            .map_err(Clone::clone)
    }
}
impl TokenStore for PlatformStore {
    fn load(&self, account: &str) -> std::result::Result<Option<Secret>, StoreError> {
        self.get()?.load(account)
    }
    fn save(&self, account: &str, value: &Secret) -> std::result::Result<(), StoreError> {
        self.get()?.save(account, value)
    }
    fn delete(&self, account: &str) -> std::result::Result<(), StoreError> {
        self.get()?.delete(account)
    }
    fn persistence(&self) -> Persistence {
        Persistence::Persistent
    }
}
fn platform_store() -> keyring_core::Result<Arc<keyring_core::CredentialStore>> {
    #[cfg(target_os = "macos")]
    {
        Ok(apple_native_keyring_store::keychain::Store::new()?)
    }
    #[cfg(target_os = "ios")]
    {
        Ok(apple_native_keyring_store::protected::Store::new()?)
    }
    #[cfg(target_os = "windows")]
    {
        Ok(windows_native_keyring_store::Store::new()?)
    }
    #[cfg(target_os = "linux")]
    {
        Ok(zbus_secret_service_keyring_store::Store::new()?)
    }
    #[cfg(target_os = "android")]
    {
        Ok(android_native_keyring_store::Store::new()?)
    }
}
