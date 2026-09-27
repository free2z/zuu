//! Where the refresh token lives between runs.
//!
//! `docs/sdk/spec/oidc.md` §8: in the OS keychain where one exists — macOS
//! Keychain, Windows Credential Manager, the iOS Keychain, Android
//! Keystore-backed storage, Secret Service on Linux — with an in-memory
//! fallback that the SDK **reports** ([`TokenStore::persistence`],
//! [`crate::Client::token_persistence`]). Access tokens are never written
//! anywhere; they live in the [`crate::Client`]'s memory for their five
//! minutes.
//!
//! What a store holds is an opaque blob per account name — the refresh token
//! and the granted scopes, serialized by the SDK — as a [`Secret`]. A store
//! never parses it.
//!
//! The methods are synchronous because every platform keychain API is; the
//! [`crate::Client`] calls them on tokio's blocking pool, so a keychain that
//! stops to ask the user for permission does not stall the runtime.

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

use crate::secret::Secret;

/// Whether a [`TokenStore`] survives the process.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Persistence {
    /// An OS keychain or equivalent: the user stays signed in across
    /// restarts.
    Persistent,
    /// Memory only: the user signs in again after a restart. An app should
    /// know this is what it got (the web, or a platform with no keychain).
    MemoryOnly,
}

/// A store failure, for [`crate::Error::Storage`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoreError(pub String);

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for StoreError {}

/// Durable storage for the session blob, keyed by an account name the SDK
/// derives from the issuer and the `client_id`.
///
/// Implement it for a platform the SDK does not cover; the Tauri plugin
/// supplies one per target.
pub trait TokenStore: Send + Sync {
    /// The blob stored under `account`, or `None` if there is none.
    ///
    /// # Errors
    ///
    /// The store could not be read (locked, access denied).
    fn load(&self, account: &str) -> Result<Option<Secret>, StoreError>;

    /// Store `value` under `account`, replacing what was there.
    ///
    /// # Errors
    ///
    /// The store could not be written.
    fn save(&self, account: &str, value: &Secret) -> Result<(), StoreError>;

    /// Remove what is stored under `account`. Removing nothing is not an
    /// error.
    ///
    /// # Errors
    ///
    /// The store could not be written.
    fn delete(&self, account: &str) -> Result<(), StoreError>;

    /// Whether what is saved survives the process.
    fn persistence(&self) -> Persistence;
}

/// A [`TokenStore`] in process memory: [`Persistence::MemoryOnly`].
#[derive(Default)]
pub struct MemoryStore {
    entries: Mutex<HashMap<String, Secret>>,
}

impl MemoryStore {
    /// An empty store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

impl fmt::Debug for MemoryStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("MemoryStore")
    }
}

fn poisoned<T>(_: T) -> StoreError {
    StoreError("memory store lock poisoned".into())
}

impl TokenStore for MemoryStore {
    fn load(&self, account: &str) -> Result<Option<Secret>, StoreError> {
        Ok(self.entries.lock().map_err(poisoned)?.get(account).cloned())
    }

    fn save(&self, account: &str, value: &Secret) -> Result<(), StoreError> {
        self.entries
            .lock()
            .map_err(poisoned)?
            .insert(account.to_owned(), value.clone());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), StoreError> {
        self.entries.lock().map_err(poisoned)?.remove(account);
        Ok(())
    }

    fn persistence(&self) -> Persistence {
        Persistence::MemoryOnly
    }
}

#[cfg(feature = "keyring")]
pub use keyring_store::KeyringStore;

#[cfg(feature = "keyring")]
mod keyring_store {
    use std::fmt;
    use std::sync::Arc;

    use keyring_core::{CredentialPersistence, CredentialStore, Error as KeyringError};

    use super::{Persistence, StoreError, TokenStore};
    use crate::secret::Secret;

    /// A [`TokenStore`] over any `keyring-core` credential store.
    ///
    /// The platform store is the caller's choice and is passed in — for
    /// example `apple-native-keyring-store` on macOS and iOS,
    /// `windows-native-keyring-store`, `android-native-keyring-store`, or a
    /// Secret Service store on Linux — so this crate links no platform
    /// library and never touches `keyring-core`'s process-global default
    /// store.
    pub struct KeyringStore {
        store: Arc<CredentialStore>,
        service: String,
    }

    impl KeyringStore {
        /// Entries go under `service` (for example your app's bundle id),
        /// one per account name.
        #[must_use]
        pub fn new(store: Arc<CredentialStore>, service: impl Into<String>) -> Self {
            Self {
                store,
                service: service.into(),
            }
        }
    }

    impl fmt::Debug for KeyringStore {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.debug_struct("KeyringStore")
                .field("service", &self.service)
                .finish_non_exhaustive()
        }
    }

    fn err(e: KeyringError) -> StoreError {
        StoreError(e.to_string())
    }

    impl TokenStore for KeyringStore {
        fn load(&self, account: &str) -> Result<Option<Secret>, StoreError> {
            let entry = self
                .store
                .build(&self.service, account, None)
                .map_err(err)?;
            match entry.get_password() {
                Ok(v) => Ok(Some(Secret::new(v))),
                Err(KeyringError::NoEntry) => Ok(None),
                Err(e) => Err(err(e)),
            }
        }

        fn save(&self, account: &str, value: &Secret) -> Result<(), StoreError> {
            let entry = self
                .store
                .build(&self.service, account, None)
                .map_err(err)?;
            entry.set_password(value.expose()).map_err(err)
        }

        fn delete(&self, account: &str) -> Result<(), StoreError> {
            let entry = self
                .store
                .build(&self.service, account, None)
                .map_err(err)?;
            match entry.delete_credential() {
                Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
                Err(e) => Err(err(e)),
            }
        }

        fn persistence(&self) -> Persistence {
            // Only a store that outlives the process counts; anything else,
            // including a kind newer than this crate, is reported as memory.
            match self.store.persistence() {
                CredentialPersistence::UntilDelete
                | CredentialPersistence::UntilLogout
                | CredentialPersistence::UntilReboot => Persistence::Persistent,
                _ => Persistence::MemoryOnly,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_round_trips_and_reports_memory_only() {
        let s = MemoryStore::new();
        assert_eq!(s.load("a").unwrap(), None);
        s.save("a", &Secret::new("x")).unwrap();
        assert_eq!(s.load("a").unwrap().unwrap().expose(), "x");
        s.delete("a").unwrap();
        s.delete("a").unwrap();
        assert_eq!(s.load("a").unwrap(), None);
        assert_eq!(s.persistence(), Persistence::MemoryOnly);
    }

    #[cfg(feature = "keyring")]
    mod keyring {
        use std::any::Any;
        use std::collections::HashMap;
        use std::sync::{Arc, Mutex};

        use keyring_core::api::{CredentialApi, CredentialStoreApi};
        use keyring_core::{CredentialPersistence, Entry, Error, Result};

        use super::super::{KeyringStore, Persistence, TokenStore};
        use crate::secret::Secret;

        type Map = Arc<Mutex<HashMap<(String, String), Vec<u8>>>>;

        /// A `keyring-core` store that persists across entries, like a real
        /// keychain (the crate's mock does not).
        struct MapStore(Map);
        struct MapCred(Map, (String, String));

        impl CredentialApi for MapCred {
            fn set_secret(&self, secret: &[u8]) -> Result<()> {
                self.0
                    .lock()
                    .unwrap()
                    .insert(self.1.clone(), secret.to_vec());
                Ok(())
            }
            fn get_secret(&self) -> Result<Vec<u8>> {
                self.0
                    .lock()
                    .unwrap()
                    .get(&self.1)
                    .cloned()
                    .ok_or(Error::NoEntry)
            }
            fn delete_credential(&self) -> Result<()> {
                self.0
                    .lock()
                    .unwrap()
                    .remove(&self.1)
                    .map(|_| ())
                    .ok_or(Error::NoEntry)
            }
            fn get_credential(&self) -> Result<Option<Arc<keyring_core::Credential>>> {
                Ok(None)
            }
            fn get_specifiers(&self) -> Option<(String, String)> {
                Some(self.1.clone())
            }
            fn as_any(&self) -> &dyn Any {
                self
            }
        }

        impl CredentialStoreApi for MapStore {
            fn vendor(&self) -> String {
                "test".into()
            }
            fn id(&self) -> String {
                "test".into()
            }
            fn build(
                &self,
                service: &str,
                user: &str,
                _: Option<&HashMap<&str, &str>>,
            ) -> Result<Entry> {
                Ok(Entry::new_with_credential(Arc::new(MapCred(
                    Arc::clone(&self.0),
                    (service.into(), user.into()),
                ))))
            }
            fn as_any(&self) -> &dyn Any {
                self
            }
            fn persistence(&self) -> CredentialPersistence {
                CredentialPersistence::UntilDelete
            }
        }

        #[test]
        fn keyring_store_round_trips_through_a_credential_store() {
            let map = Map::default();
            let store = KeyringStore::new(Arc::new(MapStore(Arc::clone(&map))), "cash.example.app");
            assert_eq!(store.persistence(), Persistence::Persistent);
            assert_eq!(store.load("acct").unwrap(), None);
            store.save("acct", &Secret::new("blob")).unwrap();
            assert_eq!(store.load("acct").unwrap().unwrap().expose(), "blob");
            assert!(
                map.lock()
                    .unwrap()
                    .contains_key(&("cash.example.app".into(), "acct".into()))
            );
            store.delete("acct").unwrap();
            store.delete("acct").unwrap();
            assert_eq!(store.load("acct").unwrap(), None);
        }

        #[test]
        fn the_crates_mock_store_is_reported_as_memory_only() {
            let store = KeyringStore::new(keyring_core::mock::Store::new().unwrap(), "s");
            assert_eq!(store.persistence(), Persistence::MemoryOnly);
        }
    }
}
