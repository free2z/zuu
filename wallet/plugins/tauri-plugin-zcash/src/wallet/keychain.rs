//! Platform-native custody and one-way migration for wallet seed phrases.
//!
//! New seed material is never written to the application data directory. The
//! only filesystem seed format understood here is the historical
//! `.seeds/{wallet}.enc` format. It is read solely for migration and is deleted
//! only after native storage has accepted and returned the validated phrase.

use std::path::PathBuf;
use std::sync::Arc;

use thiserror::Error as ThisError;
use zeroize::Zeroizing;

use crate::error::{Error, Result};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
const SERVICE: &str = "cash.free2z.zuuli.seed.v1";
#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "linux",
    target_os = "windows"
))]
const LEGACY_SERVICE: &str = "com.free2z.zuuli";

#[derive(Debug, Clone, PartialEq, Eq, ThisError)]
pub enum SecureStoreError {
    #[error("seed is not present in secure storage")]
    NotFound,
    #[error("secure-storage authentication was cancelled")]
    AuthCancelled,
    #[error("secure-storage authentication failed")]
    AuthenticationFailed,
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
        validate_wallet_id(wallet_id)?;
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
    pub fn get_seed_phrase_validated<F>(
        &self,
        wallet_id: &str,
        validate: F,
    ) -> Result<Zeroizing<String>>
    where
        F: Fn(&str) -> Result<()>,
    {
        validate_wallet_id(wallet_id)?;
        match self.backend.get(wallet_id) {
            Ok(phrase) => {
                validate(phrase.as_str()).map_err(|error| {
                    SecureStoreError::Migration(format!(
                        "wallet identity validation rejected the native seed: {error}"
                    ))
                })?;
                self.cleanup_legacy_duplicate(wallet_id, phrase.as_str());
                return Ok(phrase);
            }
            Err(SecureStoreError::NotFound) => {}
            Err(error) => return Err(error.into()),
        }

        match legacy_file::get(&self.data_dir, wallet_id) {
            Ok(phrase) => self.migrate(wallet_id, phrase, &validate, || {
                legacy_file::delete(&self.data_dir, wallet_id)
            }),
            Err(SecureStoreError::NotFound) => {
                let phrase = legacy_keyring::get(wallet_id).map_err(Error::from)?;
                self.migrate(wallet_id, phrase, &validate, || {
                    legacy_keyring::delete(wallet_id)
                })
            }
            Err(error) => Err(error.into()),
        }
    }

    fn migrate<F, D>(
        &self,
        wallet_id: &str,
        phrase: Zeroizing<String>,
        validate: &F,
        delete_legacy: D,
    ) -> Result<Zeroizing<String>>
    where
        F: Fn(&str) -> Result<()>,
        D: FnOnce() -> std::result::Result<(), SecureStoreError>,
    {
        validate(phrase.as_str()).map_err(|error| {
            SecureStoreError::Migration(format!(
                "wallet identity validation rejected the seed: {error}"
            ))
        })?;

        self.backend
            .store(wallet_id, phrase.as_str())
            .map_err(Error::from)?;
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
        tracing::info!(
            wallet_id,
            "migrated legacy seed into platform secure storage"
        );
        Ok(phrase)
    }

    /// Finish cleanup after an earlier migration reached native readback but
    /// failed deleting its legacy source. This makes retries idempotent without
    /// ever preferring legacy material over a validated native record.
    fn cleanup_legacy_duplicate(&self, wallet_id: &str, native: &str) {
        match legacy_file::get(&self.data_dir, wallet_id) {
            Ok(legacy) => {
                if legacy.as_str() != native {
                    tracing::warn!(
                        wallet_id,
                        "native and legacy seed records disagree; preserving both and using validated native custody"
                    );
                } else if let Err(error) = legacy_file::delete(&self.data_dir, wallet_id) {
                    tracing::warn!(wallet_id, "could not remove duplicate legacy seed: {error}");
                }
            }
            Err(SecureStoreError::NotFound) => {}
            Err(error) => tracing::warn!(
                wallet_id,
                "could not inspect duplicate legacy seed; validated native custody remains authoritative: {error}"
            ),
        }

        match legacy_keyring::get(wallet_id) {
            Ok(legacy) => {
                if legacy.as_str() != native {
                    tracing::warn!(
                        wallet_id,
                        "native and legacy keyring records disagree; preserving both and using validated native custody"
                    );
                } else if let Err(error) = legacy_keyring::delete(wallet_id) {
                    tracing::warn!(
                        wallet_id,
                        "could not remove duplicate legacy keyring seed: {error}"
                    );
                }
            }
            Err(SecureStoreError::NotFound) => {}
            Err(error) => tracing::warn!(
                wallet_id,
                "could not inspect duplicate legacy keyring seed; validated native custody remains authoritative: {error}"
            ),
        }
    }

    /// Recover an authoritative native record when the wallet database cannot
    /// be opened. This path deliberately never probes or migrates legacy data,
    /// because migration cannot be UFVK-validated without the database.
    pub fn get_native_seed_phrase(&self, wallet_id: &str) -> Result<Zeroizing<String>> {
        validate_wallet_id(wallet_id)?;
        self.backend.get(wallet_id).map_err(Error::from)
    }

    /// Delete native and legacy records. Not-found is idempotent; every other
    /// backend or filesystem error is surfaced to the wallet transition.
    pub fn delete_seed_phrase(&self, wallet_id: &str) -> Result<()> {
        self.delete_native_record(wallet_id)?;
        self.delete_legacy_file_record(wallet_id)?;
        self.delete_legacy_keyring_record(wallet_id)
    }

    /// Delete only the platform-native custody record. Cleanup journal stages
    /// call these components separately so each successful boundary is durable
    /// and independently retryable.
    pub(crate) fn delete_native_record(&self, wallet_id: &str) -> Result<()> {
        validate_wallet_id(wallet_id)?;
        match self.backend.delete(wallet_id) {
            Ok(()) | Err(SecureStoreError::NotFound) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    pub(crate) fn delete_legacy_file_record(&self, wallet_id: &str) -> Result<()> {
        validate_wallet_id(wallet_id)?;
        match legacy_file::delete(&self.data_dir, wallet_id) {
            Ok(()) | Err(SecureStoreError::NotFound) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    pub(crate) fn delete_legacy_keyring_record(&self, wallet_id: &str) -> Result<()> {
        validate_wallet_id(wallet_id)?;
        match legacy_keyring::delete(wallet_id) {
            Ok(()) | Err(SecureStoreError::NotFound) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

fn validate_wallet_id(wallet_id: &str) -> Result<()> {
    let parsed = uuid::Uuid::parse_str(wallet_id)
        .map_err(|_| Error::KeyError("invalid wallet identifier for secure storage".into()))?;
    if parsed.hyphenated().to_string() != wallet_id {
        return Err(Error::KeyError(
            "wallet identifier must use canonical lowercase UUID form".into(),
        ));
    }
    Ok(())
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
    use super::{SERVICE, SecureStore, SecureStoreError};
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework::passwords::{
        AccessControlOptions, PasswordOptions, delete_generic_password_options, generic_password,
        set_generic_password_options,
    };
    use zeroize::{Zeroize, Zeroizing};

    pub struct MacKeychain;

    impl SecureStore for MacKeychain {
        fn store(&self, wallet_id: &str, phrase: &str) -> Result<(), SecureStoreError> {
            match store_protected(wallet_id, phrase) {
                Ok(()) => Ok(()),
                // Ad-hoc development signatures cannot always use the data-
                // protection keychain. The login keychain remains OS-native
                // custody; cancellation/lock never falls through.
                Err(SecureStoreError::Unavailable) => {
                    tracing::warn!(
                        wallet_id,
                        "data-protection Keychain unavailable; using the native login Keychain"
                    );
                    set_generic_password_options(phrase.as_bytes(), options(wallet_id, false))
                        .map_err(map_error)
                }
                Err(error) => Err(error),
            }
        }

        fn get(&self, wallet_id: &str) -> Result<Zeroizing<String>, SecureStoreError> {
            let data = match generic_password(options(wallet_id, true)).map_err(map_error) {
                Ok(data) => data,
                Err(SecureStoreError::NotFound | SecureStoreError::Unavailable) => {
                    generic_password(options(wallet_id, false)).map_err(map_error)?
                }
                Err(error) => return Err(error),
            };
            String::from_utf8(data)
                .map(Zeroizing::new)
                .map_err(|error| {
                    let mut bytes = error.into_bytes();
                    bytes.zeroize();
                    SecureStoreError::Corrupt
                })
        }

        fn delete(&self, wallet_id: &str) -> Result<(), SecureStoreError> {
            let protected =
                delete_generic_password_options(options(wallet_id, true)).map_err(map_error);
            if let Err(error) = &protected
                && !matches!(
                    error,
                    SecureStoreError::NotFound | SecureStoreError::Unavailable
                )
            {
                return protected;
            }
            match delete_generic_password_options(options(wallet_id, false)).map_err(map_error) {
                Ok(()) => Ok(()),
                Err(SecureStoreError::NotFound) if protected.is_ok() => Ok(()),
                other => other,
            }
        }
    }

    fn store_protected(wallet_id: &str, phrase: &str) -> Result<(), SecureStoreError> {
        // Updating an existing access-controlled item with the ACL in the
        // SecItemUpdate search query yields errSecParam. Authenticate/read it
        // first, then update by service/account while preserving its ACL.
        match generic_password(options(wallet_id, true)).map_err(map_error) {
            Ok(mut old) => {
                old.zeroize();
                set_generic_password_options(phrase.as_bytes(), options(wallet_id, true))
                    .map_err(map_error)
            }
            Err(SecureStoreError::NotFound) => {
                let access = SecAccessControl::create_with_protection(
                    Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
                    AccessControlOptions::USER_PRESENCE.bits(),
                )
                .map_err(map_error)?;
                let mut protected = options(wallet_id, true);
                protected.set_access_control(access);
                set_generic_password_options(phrase.as_bytes(), protected).map_err(map_error)
            }
            Err(error) => Err(error),
        }
    }

    fn options(wallet_id: &str, protected: bool) -> PasswordOptions {
        let key = format!("seed_{wallet_id}");
        let mut options = PasswordOptions::new_generic_password(SERVICE, &key);
        if protected {
            options.use_protected_keychain();
        }
        options
    }

    pub(super) fn map_error(error: security_framework::base::Error) -> SecureStoreError {
        match error.code() {
            -25300 => SecureStoreError::NotFound,    // errSecItemNotFound
            -128 => SecureStoreError::AuthCancelled, // errSecUserCanceled
            -25293 => SecureStoreError::AuthenticationFailed, // errSecAuthFailed
            -25308 => SecureStoreError::Locked,      // errSecInteractionNotAllowed
            -26275 => SecureStoreError::Corrupt,     // errSecDecode
            -25291 => SecureStoreError::Unavailable, // errSecNotAvailable
            -2070 | -34018 => SecureStoreError::Unavailable, // internal/missing entitlement
            _ => SecureStoreError::Backend(error.to_string()),
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
mod native_keyring {
    use super::{SecureStore, SecureStoreError, map_keyring_error};
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
            self.entry(wallet_id)?
                .set_password(phrase)
                .map_err(map_keyring_error)
        }

        fn get(&self, wallet_id: &str) -> Result<Zeroizing<String>, SecureStoreError> {
            self.entry(wallet_id)?
                .get_password()
                .map(Zeroizing::new)
                .map_err(map_keyring_error)
        }

        fn delete(&self, wallet_id: &str) -> Result<(), SecureStoreError> {
            self.entry(wallet_id)?
                .delete_credential()
                .map_err(map_keyring_error)
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
            zeroize::Zeroize::zeroize(&mut bytes);
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
        // Once the ciphertext exists, a missing key is corruption rather than
        // absence. Classifying an incomplete legacy record as `NotFound` would
        // incorrectly authorize probing a different migration source.
        let mut key_bytes = match read_required(&seeds_dir(data_dir).join("salt")) {
            Ok(key) => key,
            Err(SecureStoreError::NotFound) => return Err(SecureStoreError::Corrupt),
            Err(error) => return Err(error),
        };
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
                    entry
                        .path()
                        .extension()
                        .is_some_and(|extension| extension == "enc")
                })
            })
            // A shared legacy key must survive any uncertainty: deleting it
            // while sibling ciphertext may remain would destroy recovery data.
            .unwrap_or(true);
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
            .encrypt(
                Nonce::from_slice(&legacy_nonce(wallet_id)),
                phrase.as_bytes(),
            )
            .unwrap();
        fs::write(dir.join("salt"), key).unwrap();
        fs::write(dir.join(format!("{wallet_id}.enc")), ciphertext).unwrap();
        key.zeroize();
    }
}

mod legacy_keyring {
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "linux",
        target_os = "windows"
    ))]
    use super::LEGACY_SERVICE;
    use super::SecureStoreError;
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "linux",
        target_os = "windows"
    ))]
    use zeroize::Zeroize;
    use zeroize::Zeroizing;

    #[cfg(target_os = "macos")]
    pub fn get(wallet_id: &str) -> Result<Zeroizing<String>, SecureStoreError> {
        use security_framework::passwords::{PasswordOptions, generic_password};

        let key = format!("seed_{wallet_id}");
        let mut protected = PasswordOptions::new_generic_password(LEGACY_SERVICE, &key);
        protected.use_protected_keychain();
        match generic_password(protected).map_err(super::macos::map_error) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Zeroizing::new)
                .map_err(|error| {
                    let mut bytes = error.into_bytes();
                    bytes.zeroize();
                    SecureStoreError::Corrupt
                }),
            Err(SecureStoreError::NotFound | SecureStoreError::Unavailable) => {
                get_default(wallet_id)
            }
            Err(error) => Err(error),
        }
    }

    #[cfg(any(target_os = "ios", target_os = "linux", target_os = "windows"))]
    pub fn get(wallet_id: &str) -> Result<Zeroizing<String>, SecureStoreError> {
        get_default(wallet_id)
    }

    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "linux",
        target_os = "windows"
    ))]
    fn get_default(wallet_id: &str) -> Result<Zeroizing<String>, SecureStoreError> {
        let entry =
            keyring::Entry::new(LEGACY_SERVICE, &format!("seed_{wallet_id}")).map_err(map_error)?;
        entry.get_password().map(Zeroizing::new).map_err(map_error)
    }

    #[cfg(not(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "linux",
        target_os = "windows"
    )))]
    pub fn get(_: &str) -> Result<Zeroizing<String>, SecureStoreError> {
        Err(SecureStoreError::NotFound)
    }

    #[cfg(target_os = "macos")]
    pub fn delete(wallet_id: &str) -> Result<(), SecureStoreError> {
        use security_framework::passwords::{PasswordOptions, delete_generic_password_options};

        let key = format!("seed_{wallet_id}");
        let mut protected = PasswordOptions::new_generic_password(LEGACY_SERVICE, &key);
        protected.use_protected_keychain();
        let protected_result =
            delete_generic_password_options(protected).map_err(super::macos::map_error);
        if let Err(error) = &protected_result
            && !matches!(
                error,
                SecureStoreError::NotFound | SecureStoreError::Unavailable
            )
        {
            return protected_result;
        }
        match delete_default(wallet_id) {
            Ok(()) => Ok(()),
            Err(SecureStoreError::NotFound) if protected_result.is_ok() => Ok(()),
            other => other,
        }
    }

    #[cfg(any(target_os = "ios", target_os = "linux", target_os = "windows"))]
    pub fn delete(wallet_id: &str) -> Result<(), SecureStoreError> {
        delete_default(wallet_id)
    }

    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "linux",
        target_os = "windows"
    ))]
    fn delete_default(wallet_id: &str) -> Result<(), SecureStoreError> {
        let entry =
            keyring::Entry::new(LEGACY_SERVICE, &format!("seed_{wallet_id}")).map_err(map_error)?;
        entry.delete_credential().map_err(map_error)
    }

    #[cfg(not(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "linux",
        target_os = "windows"
    )))]
    pub fn delete(_: &str) -> Result<(), SecureStoreError> {
        Err(SecureStoreError::NotFound)
    }

    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "linux",
        target_os = "windows"
    ))]
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
    use std::collections::VecDeque;
    use std::fs;
    use std::sync::Mutex;

    use super::*;

    const WALLET: &str = "00000000-0000-4000-8000-000000000001";
    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[derive(Default)]
    struct MockStore {
        records: Mutex<HashMap<String, String>>,
        get_errors: Mutex<VecDeque<SecureStoreError>>,
        get_values: Mutex<VecDeque<String>>,
        store_error: Mutex<Option<SecureStoreError>>,
    }

    impl SecureStore for MockStore {
        fn store(
            &self,
            wallet_id: &str,
            phrase: &str,
        ) -> std::result::Result<(), SecureStoreError> {
            if let Some(error) = self.store_error.lock().unwrap().take() {
                return Err(error);
            }
            self.records
                .lock()
                .unwrap()
                .insert(wallet_id.into(), phrase.into());
            Ok(())
        }

        fn get(&self, wallet_id: &str) -> std::result::Result<Zeroizing<String>, SecureStoreError> {
            if let Some(error) = self.get_errors.lock().unwrap().pop_front() {
                return Err(error);
            }
            if let Some(value) = self.get_values.lock().unwrap().pop_front() {
                return Ok(Zeroizing::new(value));
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
    fn noncanonical_wallet_id_cannot_reach_legacy_paths() {
        let dir = TestDir::new("wallet-id");
        let backend = Arc::new(MockStore::default());
        let store = SeedStore::new(dir.0.clone(), backend.clone());
        assert!(store.store_seed_phrase("../../escape", PHRASE).is_err());
        let error = store
            .get_seed_phrase_validated("../../escape", |_| Ok(()))
            .unwrap_err();
        assert!(error.to_string().contains("invalid wallet identifier"));
        assert!(store.delete_seed_phrase("../../escape").is_err());
        assert!(backend.records.lock().unwrap().is_empty());
        assert!(!dir.0.join(".seeds").exists());
    }

    #[test]
    fn only_not_found_enters_legacy_migration() {
        for error in [
            SecureStoreError::AuthCancelled,
            SecureStoreError::AuthenticationFailed,
            SecureStoreError::Locked,
            SecureStoreError::Corrupt,
            SecureStoreError::Unavailable,
            SecureStoreError::Backend("injected".into()),
        ] {
            let dir = TestDir::new("fail-closed");
            legacy_file::write_fixture(&dir.0, WALLET, PHRASE);
            let backend = Arc::new(MockStore::default());
            backend.get_errors.lock().unwrap().push_back(error);
            let store = SeedStore::new(dir.0.clone(), backend);
            assert!(store.get_seed_phrase_validated(WALLET, |_| Ok(())).is_err());
            assert!(dir.0.join(".seeds").join(format!("{WALLET}.enc")).exists());
        }
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
        assert_eq!(phrase.as_str(), PHRASE);
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
        backend
            .get_errors
            .lock()
            .unwrap()
            .extend([SecureStoreError::NotFound, SecureStoreError::Unavailable]);
        let store = SeedStore::new(dir.0.clone(), backend.clone());
        assert!(store.get_seed_phrase_validated(WALLET, |_| Ok(())).is_err());
        assert!(dir.0.join(".seeds").join(format!("{WALLET}.enc")).exists());
    }

    #[test]
    fn incomplete_legacy_record_is_corrupt_not_absent() {
        let dir = TestDir::new("missing-legacy-key");
        legacy_file::write_fixture(&dir.0, WALLET, PHRASE);
        fs::remove_file(dir.0.join(".seeds").join("salt")).unwrap();
        assert_eq!(
            legacy_file::get(&dir.0, WALLET).unwrap_err(),
            SecureStoreError::Corrupt
        );
        assert!(dir.0.join(".seeds").join(format!("{WALLET}.enc")).exists());
    }

    #[test]
    fn validated_native_seed_wins_even_when_duplicate_cleanup_is_corrupt() {
        let dir = TestDir::new("native-with-corrupt-duplicate");
        legacy_file::write_fixture(&dir.0, WALLET, PHRASE);
        fs::remove_file(dir.0.join(".seeds").join("salt")).unwrap();
        let backend = Arc::new(MockStore::default());
        backend
            .records
            .lock()
            .unwrap()
            .insert(WALLET.into(), PHRASE.into());
        let store = SeedStore::new(dir.0.clone(), backend);

        let phrase = store
            .get_seed_phrase_validated(WALLET, |candidate| {
                assert_eq!(candidate, PHRASE);
                Ok(())
            })
            .unwrap();

        assert_eq!(phrase.as_str(), PHRASE);
        assert!(dir.0.join(".seeds").join(format!("{WALLET}.enc")).exists());
    }

    #[test]
    fn native_seed_still_requires_wallet_identity_validation() {
        let dir = TestDir::new("native-identity");
        let backend = Arc::new(MockStore::default());
        backend
            .records
            .lock()
            .unwrap()
            .insert(WALLET.into(), PHRASE.into());
        let store = SeedStore::new(dir.0.clone(), backend);

        let error = store
            .get_seed_phrase_validated(WALLET, |_| Err(Error::KeyError("foreign UFVK".into())))
            .unwrap_err();
        assert!(error.to_string().contains("identity validation rejected"));
    }

    #[test]
    fn database_recovery_path_never_migrates_legacy_data() {
        let dir = TestDir::new("native-recovery-only");
        legacy_file::write_fixture(&dir.0, WALLET, PHRASE);
        let store = SeedStore::new(dir.0.clone(), Arc::new(MockStore::default()));

        assert!(matches!(
            store.get_native_seed_phrase(WALLET).unwrap_err(),
            Error::KeyError(_)
        ));
        assert!(dir.0.join(".seeds").join(format!("{WALLET}.enc")).exists());
    }

    #[test]
    fn migration_preserves_legacy_at_validation_store_readback_and_cleanup_boundaries() {
        // Validation rejection.
        let validation_dir = TestDir::new("validation-failure");
        legacy_file::write_fixture(&validation_dir.0, WALLET, PHRASE);
        let validation_backend = Arc::new(MockStore::default());
        let validation_store = SeedStore::new(validation_dir.0.clone(), validation_backend.clone());
        assert!(
            validation_store
                .get_seed_phrase_validated(WALLET, |_| {
                    Err(Error::KeyError("injected identity mismatch".into()))
                })
                .is_err()
        );
        assert!(validation_backend.records.lock().unwrap().is_empty());
        assert!(
            validation_dir
                .0
                .join(".seeds")
                .join(format!("{WALLET}.enc"))
                .exists()
        );

        // Native write rejection.
        let write_dir = TestDir::new("write-failure");
        legacy_file::write_fixture(&write_dir.0, WALLET, PHRASE);
        let write_backend = Arc::new(MockStore::default());
        *write_backend.store_error.lock().unwrap() = Some(SecureStoreError::Unavailable);
        let write_store = SeedStore::new(write_dir.0.clone(), write_backend);
        assert!(
            write_store
                .get_seed_phrase_validated(WALLET, |_| Ok(()))
                .is_err()
        );
        assert!(
            write_dir
                .0
                .join(".seeds")
                .join(format!("{WALLET}.enc"))
                .exists()
        );

        // Native readback mismatch.
        let mismatch_dir = TestDir::new("readback-mismatch");
        legacy_file::write_fixture(&mismatch_dir.0, WALLET, PHRASE);
        let mismatch_backend = Arc::new(MockStore::default());
        mismatch_backend
            .get_errors
            .lock()
            .unwrap()
            .push_back(SecureStoreError::NotFound);
        mismatch_backend
            .get_values
            .lock()
            .unwrap()
            .push_back("different native phrase".into());
        let mismatch_store = SeedStore::new(mismatch_dir.0.clone(), mismatch_backend);
        assert!(
            mismatch_store
                .get_seed_phrase_validated(WALLET, |_| Ok(()))
                .is_err()
        );
        assert!(
            mismatch_dir
                .0
                .join(".seeds")
                .join(format!("{WALLET}.enc"))
                .exists()
        );

        // Legacy cleanup rejection after successful native write/readback.
        let cleanup_dir = TestDir::new("cleanup-failure");
        legacy_file::write_fixture(&cleanup_dir.0, WALLET, PHRASE);
        let cleanup_backend = Arc::new(MockStore::default());
        let cleanup_store = SeedStore::new(cleanup_dir.0.clone(), cleanup_backend.clone());
        let phrase = legacy_file::get(&cleanup_dir.0, WALLET).unwrap();
        assert!(
            cleanup_store
                .migrate(WALLET, phrase, &|_| Ok(()), || {
                    Err(SecureStoreError::Migration(
                        "injected cleanup failure".into(),
                    ))
                })
                .is_err()
        );
        assert_eq!(
            cleanup_backend.records.lock().unwrap().get(WALLET).unwrap(),
            PHRASE
        );
        assert!(
            cleanup_dir
                .0
                .join(".seeds")
                .join(format!("{WALLET}.enc"))
                .exists()
        );
    }

    #[test]
    fn legacy_tampering_is_classified_as_corrupt_and_preserved() {
        let dir = TestDir::new("tamper");
        legacy_file::write_fixture(&dir.0, WALLET, PHRASE);
        let path = dir.0.join(".seeds").join(format!("{WALLET}.enc"));
        let mut bytes = fs::read(&path).unwrap();
        bytes[0] ^= 0x80;
        fs::write(&path, bytes).unwrap();
        assert_eq!(
            legacy_file::get(&dir.0, WALLET).unwrap_err(),
            SecureStoreError::Corrupt
        );
        assert!(path.exists());
    }

    #[test]
    fn error_classes_are_stable_and_distinct() {
        let errors = [
            SecureStoreError::NotFound,
            SecureStoreError::AuthCancelled,
            SecureStoreError::AuthenticationFailed,
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
