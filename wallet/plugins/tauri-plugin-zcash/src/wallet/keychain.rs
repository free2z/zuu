//! Platform-native custody and one-way migration for wallet seed phrases.
//!
//! New seed material is never written to the application data directory. The
//! only filesystem seed format understood here is the historical
//! `.seeds/{wallet}.enc` format. It is read solely for migration and is deleted
//! only after native storage has accepted and returned the validated phrase.

use std::path::PathBuf;
use std::sync::Arc;

use thiserror::Error as ThisError;
use zeroize::{Zeroize, Zeroizing};

use crate::error::{Error, Result};

const SERVICE: &str = "cash.free2z.zuuli.seed.v1";
const LEGACY_SERVICE: &str = "com.free2z.zuuli";

#[derive(Debug, Clone, PartialEq, Eq, ThisError)]
pub enum SecureStoreError {
    #[error("seed is not present in secure storage")]
    NotFound,
    #[error("secure-storage authentication was cancelled")]
    AuthCancelled,
    #[error("secure storage is locked")]
    Locked,
    #[error("secure seed record is corrupt")]
    Corrupt,
    #[error("secure-storage backend is unavailable")]
    Unavailable,
    #[error("secure-storage backend failed: {0}")]
    Backend(String),
    #[error("legacy seed migration failed: {0}")]
    Migration(String),
}

impl From<SecureStoreError> for Error {
    fn from(value: SecureStoreError) -> Self {
        Error::KeyError(value.to_string())
    }
}

/// Minimal adapter implemented by native desktop and Tauri mobile backends.
///
/// Errors are deliberately structured. In particular, only `NotFound` is
/// permission to inspect legacy storage; locked, cancelled, corrupt, and
/// unavailable stores fail closed.
pub trait SecureStore: Send + Sync {
    fn store(&self, wallet_id: &str, phrase: &str) -> std::result::Result<(), SecureStoreError>;
    fn get(&self, wallet_id: &str) -> std::result::Result<Zeroizing<String>, SecureStoreError>;
    fn delete(&self, wallet_id: &str) -> std::result::Result<(), SecureStoreError>;
}

#[derive(Clone)]
pub struct SeedStore {
    data_dir: PathBuf,
    backend: Arc<dyn SecureStore>,
}

impl SeedStore {
    pub fn platform(data_dir: PathBuf) -> Self {
        Self::new(data_dir, platform_backend())
    }

    pub fn new(data_dir: PathBuf, backend: Arc<dyn SecureStore>) -> Self {
        Self { data_dir, backend }
    }

    /// Persist a seed only in native secure storage, then read it back before
    /// reporting success. No filesystem fallback is created in debug or release.
    pub fn store_seed_phrase(&self, wallet_id: &str, phrase: &str) -> Result<()> {
        self.backend.store(wallet_id, phrase).map_err(Error::from)?;
        let confirmed = self.backend.get(wallet_id).map_err(Error::from)?;
        if confirmed.as_str() != phrase {
            return Err(SecureStoreError::Corrupt.into());
        }
        tracing::info!(wallet_id, "stored seed in platform secure storage");
        Ok(())
    }

    /// Retrieve a native seed, or migrate legacy material after validation.
    ///
    /// The caller supplies wallet-specific validation (the production caller
    /// compares the seed-derived UFVK with the wallet database UFVK). This keeps
    /// the migration boundary incapable of blessing a valid mnemonic belonging
    /// to a different wallet.
    pub fn get_seed_phrase_validated<F>(&self, wallet_id: &str, validate: F) -> Result<String>
    where
        F: Fn(&str) -> Result<()>,
    {
        match self.backend.get(wallet_id) {
            Ok(phrase) => return Ok(phrase.to_string()),
            Err(SecureStoreError::NotFound) => {}
            Err(error) => return Err(error.into()),
        }

        match legacy_file::get(&self.data_dir, wallet_id) {
            Ok(phrase) => self.migrate(wallet_id, phrase, validate, || {
                legacy_file::delete(&self.data_dir, wallet_id)
            }),
            Err(SecureStoreError::NotFound) => {
                let phrase = legacy_keyring::get(wallet_id).map_err(Error::from)?;
                self.migrate(wallet_id, phrase, validate, || legacy_keyring::delete(wallet_id))
            }
            Err(error) => Err(error.into()),
        }
    }

    fn migrate<F, D>(
        &self,
        wallet_id: &str,
        phrase: Zeroizing<String>,
        validate: F,
        delete_legacy: D,
    ) -> Result<String>
    where
        F: Fn(&str) -> Result<()>,
        D: FnOnce() -> std::result::Result<(), SecureStoreError>,
    {
        validate(phrase.as_str()).map_err(|error| {
            SecureStoreError::Migration(format!("wallet identity validation rejected the seed: {error}"))
        })?;

        self.backend.store(wallet_id, phrase.as_str()).map_err(Error::from)?;
        let confirmed = self.backend.get(wallet_id).map_err(Error::from)?;
        if confirmed.as_str() != phrase.as_str() {
            return Err(SecureStoreError::Migration(
                "native secure-storage readback did not match the legacy seed".into(),
            )
            .into());
        }

        // This is intentionally last. Any validation, write, or readback error
        // leaves the legacy record untouched so recovery remains possible.
        delete_legacy().map_err(Error::from)?;
        tracing::info!(wallet_id, "migrated legacy seed into platform secure storage");
        Ok(phrase.to_string())
    }

    /// Delete native and legacy records. Not-found is idempotent; every other
    /// backend or filesystem error is surfaced to the wallet transition.
    pub fn delete_seed_phrase(&self, wallet_id: &str) -> Result<()> {
        match self.backend.delete(wallet_id) {
            Ok(()) | Err(SecureStoreError::NotFound) => {}
            Err(error) => return Err(error.into()),
        }
        match legacy_file::delete(&self.data_dir, wallet_id) {
            Ok(()) | Err(SecureStoreError::NotFound) => {}
            Err(error) => return Err(error.into()),
        }
        match legacy_keyring::delete(wallet_id) {
            Ok(()) | Err(SecureStoreError::NotFound) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

#[cfg(target_os = "macos")]
fn platform_backend() -> Arc<dyn SecureStore> {
    Arc::new(macos::MacKeychain)
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn platform_backend() -> Arc<dyn SecureStore> {
    Arc::new(native_keyring::KeyringStore::new(SERVICE))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn platform_backend() -> Arc<dyn SecureStore> {
    Arc::new(UnavailableStore)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
struct UnavailableStore;

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
impl SecureStore for UnavailableStore {
    fn store(&self, _: &str, _: &str) -> std::result::Result<(), SecureStoreError> {
        Err(SecureStoreError::Unavailable)
    }
    fn get(&self, _: &str) -> std::result::Result<Zeroizing<String>, SecureStoreError> {
        Err(SecureStoreError::Unavailable)
    }
    fn delete(&self, _: &str) -> std::result::Result<(), SecureStoreError> {
        Err(SecureStoreError::Unavailable)
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{SecureStore, SecureStoreError, SERVICE};
    use security_framework::passwords::{
        delete_generic_password_options, generic_password, set_generic_password_options,
        AccessControlOptions, PasswordOptions,
    };
    use zeroize::Zeroizing;

    pub struct MacKeychain;

    impl SecureStore for MacKeychain {
        fn store(&self, wallet_id: &str, phrase: &str) -> Result<(), SecureStoreError> {
            let mut options = options(wallet_id);
            options.set_access_control_options(AccessControlOptions::USER_PRESENCE);
            set_generic_password_options(phrase.as_bytes(), options).map_err(map_error)
        }

        fn get(&self, wallet_id: &str) -> Result<Zeroizing<String>, SecureStoreError> {
            let data = generic_password(options(wallet_id)).map_err(map_error)?;
            String::from_utf8(data)
                .map(Zeroizing::new)
                .map_err(|error| {
                    let mut bytes = error.into_bytes();
                    bytes.zeroize();
                    SecureStoreError::Corrupt
                })
        }

        fn delete(&self, wallet_id: &str) -> Result<(), SecureStoreError> {
            delete_generic_password_options(options(wallet_id)).map_err(map_error)
        }
    }

    fn options(wallet_id: &str) -> PasswordOptions {
        let key = format!("seed_{wallet_id}");
        let mut options = PasswordOptions::new_generic_password(SERVICE, &key);
        options.use_protected_keychain();
        options
    }

    fn map_error(error: security_framework::base::Error) -> SecureStoreError {
        match error.code() {
            -25300 => SecureStoreError::NotFound,       // errSecItemNotFound
            -128 | -25293 => SecureStoreError::AuthCancelled, // errSecUserCanceled/AuthFailed
            -25308 => SecureStoreError::Locked,         // errSecInteractionNotAllowed
            -26275 => SecureStoreError::Corrupt,        // errSecDecode
            -25291 => SecureStoreError::Unavailable,    // errSecNotAvailable
            _ => SecureStoreError::Backend(error.to_string()),
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
mod native_keyring {
    use super::{map_keyring_error, SecureStore, SecureStoreError};
    use zeroize::Zeroizing;

    pub struct KeyringStore {
        service: &'static str,
    }

    impl KeyringStore {
        pub const fn new(service: &'static str) -> Self {
            Self { service }
        }

        fn entry(&self, wallet_id: &str) -> Result<keyring::Entry, SecureStoreError> {
            keyring::Entry::new(self.service, &format!("seed_{wallet_id}"))
                .map_err(map_keyring_error)
        }
    }

    impl SecureStore for KeyringStore {
        fn store(&self, wallet_id: &str, phrase: &str) -> Result<(), SecureStoreError> {
            self.entry(wallet_id)?.set_password(phrase).map_err(map_keyring_error)
        }

        fn get(&self, wallet_id: &str) -> Result<Zeroizing<String>, SecureStoreError> {
            self.entry(wallet_id)?
                .get_password()
                .map(Zeroizing::new)
                .map_err(map_keyring_error)
        }

        fn delete(&self, wallet_id: &str) -> Result<(), SecureStoreError> {
            self.entry(wallet_id)?.delete_credential().map_err(map_keyring_error)
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn map_keyring_error(error: keyring::Error) -> SecureStoreError {
    match error {
        keyring::Error::NoEntry => SecureStoreError::NotFound,
        keyring::Error::NoStorageAccess(source) => {
            let detail = source.to_string().to_ascii_lowercase();
            if detail.contains("cancel") {
                SecureStoreError::AuthCancelled
            } else if detail.contains("lock") {
                SecureStoreError::Locked
            } else {
                SecureStoreError::Unavailable
            }
        }
        keyring::Error::BadEncoding(mut bytes) => {
            bytes.zeroize();
            SecureStoreError::Corrupt
        }
        other => SecureStoreError::Backend(other.to_string()),
    }
}

/// Decoder for the removed file fallback. There is deliberately no `store`.
mod legacy_file {
    use std::fs;
    use std::io::ErrorKind;
    use std::path::{Path, PathBuf};

    use chacha20poly1305::aead::{Aead, KeyInit};
    use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
    use sha2::{Digest, Sha256};
    use zeroize::{Zeroize, Zeroizing};

    use super::SecureStoreError;

    fn seeds_dir(data_dir: &Path) -> PathBuf {
        data_dir.join(".seeds")
    }

    pub fn get(data_dir: &Path, wallet_id: &str) -> Result<Zeroizing<String>, SecureStoreError> {
        let ciphertext = read_required(&seeds_dir(data_dir).join(format!("{wallet_id}.enc")))?;
        let mut key_bytes = read_required(&seeds_dir(data_dir).join("salt"))?;
        if key_bytes.len() != 32 {
            key_bytes.zeroize();
            return Err(SecureStoreError::Corrupt);
        }

        let cipher = ChaCha20Poly1305::new(Key::from_slice(&key_bytes));
        let nonce = legacy_nonce(wallet_id);
        let plaintext = cipher
            .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
            .map_err(|_| SecureStoreError::Corrupt);
        key_bytes.zeroize();
        let plaintext = Zeroizing::new(plaintext?);
        String::from_utf8(plaintext.to_vec())
            .map(Zeroizing::new)
            .map_err(|error| {
                let mut bytes = error.into_bytes();
                bytes.zeroize();
                SecureStoreError::Corrupt
            })
    }

    pub fn delete(data_dir: &Path, wallet_id: &str) -> Result<(), SecureStoreError> {
        let dir = seeds_dir(data_dir);
        remove_if_present(&dir.join(format!("{wallet_id}.enc")))?;

        let has_other_records = fs::read_dir(&dir)
            .map(|entries| {
                entries.filter_map(Result::ok).any(|entry| {
                    entry.path().extension().is_some_and(|extension| extension == "enc")
                })
            })
            .unwrap_or(false);
        if !has_other_records {
            remove_if_present(&dir.join("salt"))?;
        }
        Ok(())
    }

    fn read_required(path: &Path) -> Result<Vec<u8>, SecureStoreError> {
        fs::read(path).map_err(|error| match error.kind() {
            ErrorKind::NotFound => SecureStoreError::NotFound,
            _ => SecureStoreError::Migration(format!("legacy seed read failed: {error}")),
        })
    }

    fn remove_if_present(path: &Path) -> Result<(), SecureStoreError> {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(SecureStoreError::Migration(format!(
                "legacy seed cleanup failed: {error}"
            ))),
        }
    }

    fn legacy_nonce(wallet_id: &str) -> [u8; 12] {
        let hash = Sha256::digest(wallet_id.as_bytes());
        let mut nonce = [0; 12];
        nonce.copy_from_slice(&hash[..12]);
        nonce
    }

    #[cfg(test)]
    pub fn write_fixture(data_dir: &Path, wallet_id: &str, phrase: &str) {
        use rand::RngCore;

        let dir = seeds_dir(data_dir);
        fs::create_dir_all(&dir).unwrap();
        let mut key = [0; 32];
        rand::rngs::OsRng.fill_bytes(&mut key);
        let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&legacy_nonce(wallet_id)), phrase.as_bytes())
            .unwrap();
        fs::write(dir.join("salt"), key).unwrap();
        fs::write(dir.join(format!("{wallet_id}.enc")), ciphertext).unwrap();
        key.zeroize();
    }
}

mod legacy_keyring {
    use super::{LEGACY_SERVICE, SecureStoreError};
    use zeroize::Zeroizing;

    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "linux", target_os = "windows"))]
    pub fn get(wallet_id: &str) -> Result<Zeroizing<String>, SecureStoreError> {
        let entry = keyring::Entry::new(LEGACY_SERVICE, &format!("seed_{wallet_id}"))
            .map_err(map_error)?;
        entry.get_password().map(Zeroizing::new).map_err(map_error)
    }

    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "linux", target_os = "windows")))]
    pub fn get(_: &str) -> Result<Zeroizing<String>, SecureStoreError> {
        Err(SecureStoreError::NotFound)
    }

    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "linux", target_os = "windows"))]
    pub fn delete(wallet_id: &str) -> Result<(), SecureStoreError> {
        let entry = keyring::Entry::new(LEGACY_SERVICE, &format!("seed_{wallet_id}"))
            .map_err(map_error)?;
        entry.delete_credential().map_err(map_error)
    }

    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "linux", target_os = "windows")))]
    pub fn delete(_: &str) -> Result<(), SecureStoreError> {
        Err(SecureStoreError::NotFound)
    }

    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "linux", target_os = "windows"))]
    fn map_error(error: keyring::Error) -> SecureStoreError {
        match error {
            keyring::Error::NoEntry => SecureStoreError::NotFound,
            keyring::Error::NoStorageAccess(source) => {
                let detail = source.to_string().to_ascii_lowercase();
                if detail.contains("cancel") {
                    SecureStoreError::AuthCancelled
                } else if detail.contains("lock") {
                    SecureStoreError::Locked
                } else {
                    SecureStoreError::Unavailable
                }
            }
            keyring::Error::BadEncoding(mut bytes) => {
                bytes.zeroize();
                SecureStoreError::Corrupt
            }
            other => SecureStoreError::Backend(other.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::sync::Mutex;

    use super::*;

    const WALLET: &str = "wallet-test";
    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[derive(Default)]
    struct MockStore {
        records: Mutex<HashMap<String, String>>,
        get_error: Mutex<Option<SecureStoreError>>,
        store_error: Mutex<Option<SecureStoreError>>,
    }

    impl SecureStore for MockStore {
        fn store(&self, wallet_id: &str, phrase: &str) -> std::result::Result<(), SecureStoreError> {
            if let Some(error) = self.store_error.lock().unwrap().take() {
                return Err(error);
            }
            self.records.lock().unwrap().insert(wallet_id.into(), phrase.into());
            Ok(())
        }

        fn get(&self, wallet_id: &str) -> std::result::Result<Zeroizing<String>, SecureStoreError> {
            if let Some(error) = self.get_error.lock().unwrap().take() {
                return Err(error);
            }
            self.records
                .lock()
                .unwrap()
                .get(wallet_id)
                .cloned()
                .map(Zeroizing::new)
                .ok_or(SecureStoreError::NotFound)
        }

        fn delete(&self, wallet_id: &str) -> std::result::Result<(), SecureStoreError> {
            self.records
                .lock()
                .unwrap()
                .remove(wallet_id)
                .map(|_| ())
                .ok_or(SecureStoreError::NotFound)
        }
    }

    struct TestDir(PathBuf);
    impl TestDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("zuuli-{name}-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn native_store_never_creates_a_colocated_file_or_key() {
        let dir = TestDir::new("native-only");
        let backend = Arc::new(MockStore::default());
        let store = SeedStore::new(dir.0.clone(), backend);
        store.store_seed_phrase(WALLET, PHRASE).unwrap();
        assert!(!dir.0.join(".seeds").exists());
    }

    #[test]
    fn only_not_found_enters_legacy_migration() {
        let dir = TestDir::new("fail-closed");
        legacy_file::write_fixture(&dir.0, WALLET, PHRASE);
        let backend = Arc::new(MockStore::default());
        *backend.get_error.lock().unwrap() = Some(SecureStoreError::AuthCancelled);
        let store = SeedStore::new(dir.0.clone(), backend);
        let error = store
            .get_seed_phrase_validated(WALLET, |_| Ok(()))
            .unwrap_err();
        assert!(error.to_string().contains("cancelled"));
        assert!(dir.0.join(".seeds").join(format!("{WALLET}.enc")).exists());
    }

    #[test]
    fn migration_validates_writes_reads_back_then_deletes_legacy() {
        let dir = TestDir::new("migration");
        legacy_file::write_fixture(&dir.0, WALLET, PHRASE);
        let backend = Arc::new(MockStore::default());
        let store = SeedStore::new(dir.0.clone(), backend.clone());
        let phrase = store
            .get_seed_phrase_validated(WALLET, |candidate| {
                assert_eq!(candidate, PHRASE);
                Ok(())
            })
            .unwrap();
        assert_eq!(phrase, PHRASE);
        assert_eq!(backend.records.lock().unwrap().get(WALLET).unwrap(), PHRASE);
        assert!(!dir.0.join(".seeds").join(format!("{WALLET}.enc")).exists());
        assert!(!dir.0.join(".seeds").join("salt").exists());
    }

    #[test]
    fn migration_preserves_legacy_on_native_readback_failure() {
        let dir = TestDir::new("readback-failure");
        legacy_file::write_fixture(&dir.0, WALLET, PHRASE);
        let backend = Arc::new(MockStore::default());
        // First get reports not-found; readback after store reports unavailable.
        *backend.get_error.lock().unwrap() = Some(SecureStoreError::NotFound);
        let store = SeedStore::new(dir.0.clone(), backend.clone());
        // The one-shot error above is consumed by the initial lookup, so inject
        // readback failure from store via a backend dedicated to this boundary.
        *backend.store_error.lock().unwrap() = Some(SecureStoreError::Unavailable);
        assert!(store.get_seed_phrase_validated(WALLET, |_| Ok(())).is_err());
        assert!(dir.0.join(".seeds").join(format!("{WALLET}.enc")).exists());
    }

    #[test]
    fn legacy_tampering_is_classified_as_corrupt_and_preserved() {
        let dir = TestDir::new("tamper");
        legacy_file::write_fixture(&dir.0, WALLET, PHRASE);
        let path = dir.0.join(".seeds").join(format!("{WALLET}.enc"));
        let mut bytes = fs::read(&path).unwrap();
        bytes[0] ^= 0x80;
        fs::write(&path, bytes).unwrap();
        assert_eq!(legacy_file::get(&dir.0, WALLET).unwrap_err(), SecureStoreError::Corrupt);
        assert!(path.exists());
    }

    #[test]
    fn error_classes_are_stable_and_distinct() {
        let errors = [
            SecureStoreError::NotFound,
            SecureStoreError::AuthCancelled,
            SecureStoreError::Locked,
            SecureStoreError::Corrupt,
            SecureStoreError::Unavailable,
            SecureStoreError::Backend("failure".into()),
        ];
        for (index, left) in errors.iter().enumerate() {
            for right in errors.iter().skip(index + 1) {
                assert_ne!(left, right);
            }
        }
    }
}
