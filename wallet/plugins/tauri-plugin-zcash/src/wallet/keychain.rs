use std::path::Path;

use crate::error::{Error, Result};

const SERVICE: &str = "com.free2z.zuuli";

/// Store a seed phrase securely.
///
/// Uses OS keychain (with biometric on macOS when code-signed) plus an
/// encrypted file backup that survives binary rebuilds in dev mode.
pub fn store_seed_phrase(data_dir: &Path, wallet_id: &str, phrase: &str) -> Result<()> {
    // Try OS keychain first (biometric on macOS, credential manager elsewhere)
    if let Err(e) = os_keychain::store(wallet_id, phrase) {
        tracing::warn!("OS keychain store failed (encrypted file backup will be used): {e}");
    }

    // Always write encrypted file as backup
    encrypted_file::store(data_dir, wallet_id, phrase)
        .map_err(|e| Error::KeyError(format!("failed to store encrypted seed: {e}")))?;

    tracing::info!("stored seed for wallet {wallet_id}");
    Ok(())
}

/// Retrieve a seed phrase.
///
/// Tries: OS keychain -> encrypted file -> legacy keyring.
pub fn get_seed_phrase(data_dir: &Path, wallet_id: &str) -> Result<String> {
    // 1. Try OS keychain
    if let Ok(phrase) = os_keychain::get(wallet_id) {
        tracing::debug!("seed retrieved from OS keychain for wallet {wallet_id}");
        return Ok(phrase);
    }

    // 2. Try encrypted file
    if let Ok(phrase) = encrypted_file::get(data_dir, wallet_id) {
        tracing::debug!("seed retrieved from encrypted file for wallet {wallet_id}");
        return Ok(phrase);
    }

    // 3. Try legacy keyring (migration from old code)
    if let Ok(phrase) = legacy_keyring::get(wallet_id) {
        tracing::info!("migrating seed from legacy keyring for wallet {wallet_id}");
        // Re-store in new system for future access
        let _ = store_seed_phrase(data_dir, wallet_id, &phrase);
        return Ok(phrase);
    }

    Err(Error::KeyError(
        "seed not found in keychain, encrypted file, or legacy storage".into(),
    ))
}

/// Delete a seed phrase from all storage locations.
pub fn delete_seed_phrase(data_dir: &Path, wallet_id: &str) -> Result<()> {
    let _ = os_keychain::delete(wallet_id);
    let _ = encrypted_file::delete(data_dir, wallet_id);
    let _ = legacy_keyring::delete(wallet_id);
    Ok(())
}

// ---------------------------------------------------------------------------
// macOS: security-framework (SecItem API) with biometric + basic fallback
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod os_keychain {
    use super::SERVICE;
    use security_framework::passwords::{
        delete_generic_password, delete_generic_password_options, get_generic_password,
        generic_password, set_generic_password, set_generic_password_options,
        AccessControlOptions, PasswordOptions,
    };

    pub fn store(wallet_id: &str, phrase: &str) -> std::result::Result<(), String> {
        let key = format!("seed_{wallet_id}");

        // 1. Try protected keychain with biometric (requires code-signed build)
        match store_protected_biometric(&key, phrase) {
            Ok(()) => return Ok(()),
            Err(e) => tracing::debug!("protected keychain store failed: {e}"),
        }

        // 2. Try login keychain with biometric access control (Touch ID without code signing)
        //    Delete existing item first — can't change access control on an existing item
        let _ = delete_generic_password(SERVICE, &key);
        match store_login_biometric(&key, phrase) {
            Ok(()) => return Ok(()),
            Err(e) => tracing::debug!("login keychain biometric store failed: {e}"),
        }

        // 3. Fall back to basic login keychain (password prompt only)
        store_basic(&key, phrase)
    }

    pub fn get(wallet_id: &str) -> std::result::Result<String, String> {
        let key = format!("seed_{wallet_id}");

        // Try protected keychain first
        if let Ok(data) = get_protected(&key) {
            return String::from_utf8(data).map_err(|e| format!("{e}"));
        }

        // Try login keychain — will prompt Touch ID if item has USER_PRESENCE access control
        let data = get_generic_password(SERVICE, &key).map_err(|e| format!("{e}"))?;
        String::from_utf8(data).map_err(|e| format!("{e}"))
    }

    pub fn delete(wallet_id: &str) -> std::result::Result<(), String> {
        let key = format!("seed_{wallet_id}");

        // Try deleting from protected keychain
        let mut opts = PasswordOptions::new_generic_password(SERVICE, &key);
        opts.use_protected_keychain();
        let _ = delete_generic_password_options(opts);

        // Also try deleting from login keychain
        let _ = delete_generic_password(SERVICE, &key);

        Ok(())
    }

    /// Protected keychain + USER_PRESENCE (best security, requires code signing)
    fn store_protected_biometric(key: &str, phrase: &str) -> std::result::Result<(), String> {
        let mut opts = PasswordOptions::new_generic_password(SERVICE, key);
        opts.set_access_control_options(AccessControlOptions::USER_PRESENCE);
        opts.use_protected_keychain();
        set_generic_password_options(phrase.as_bytes(), opts).map_err(|e| format!("{e}"))
    }

    /// Login keychain + USER_PRESENCE (Touch ID without code signing)
    fn store_login_biometric(key: &str, phrase: &str) -> std::result::Result<(), String> {
        let mut opts = PasswordOptions::new_generic_password(SERVICE, key);
        opts.set_access_control_options(AccessControlOptions::USER_PRESENCE);
        set_generic_password_options(phrase.as_bytes(), opts).map_err(|e| format!("{e}"))
    }

    fn get_protected(key: &str) -> std::result::Result<Vec<u8>, String> {
        let mut opts = PasswordOptions::new_generic_password(SERVICE, key);
        opts.use_protected_keychain();
        generic_password(opts).map_err(|e| format!("{e}"))
    }

    fn store_basic(key: &str, phrase: &str) -> std::result::Result<(), String> {
        set_generic_password(SERVICE, key, phrase.as_bytes()).map_err(|e| format!("{e}"))
    }
}

// ---------------------------------------------------------------------------
// Linux/Windows: keyring crate (Secret Service / Credential Manager)
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "macos"))]
mod os_keychain {
    use super::SERVICE;

    pub fn store(wallet_id: &str, phrase: &str) -> std::result::Result<(), String> {
        let key = format!("seed_{wallet_id}");
        let entry =
            keyring::Entry::new(SERVICE, &key).map_err(|e| format!("keyring error: {e}"))?;
        entry
            .set_password(phrase)
            .map_err(|e| format!("keyring store failed: {e}"))
    }

    pub fn get(wallet_id: &str) -> std::result::Result<String, String> {
        let key = format!("seed_{wallet_id}");
        let entry =
            keyring::Entry::new(SERVICE, &key).map_err(|e| format!("keyring error: {e}"))?;
        entry
            .get_password()
            .map_err(|e| format!("keyring retrieve failed: {e}"))
    }

    pub fn delete(wallet_id: &str) -> std::result::Result<(), String> {
        let key = format!("seed_{wallet_id}");
        if let Ok(entry) = keyring::Entry::new(SERVICE, &key) {
            let _ = entry.delete_credential();
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Encrypted file fallback (ChaCha20-Poly1305)
// ---------------------------------------------------------------------------

mod encrypted_file {
    use std::fs;
    use std::path::{Path, PathBuf};

    use chacha20poly1305::aead::{Aead, KeyInit};
    use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
    use sha2::{Digest, Sha256};

    fn seeds_dir(data_dir: &Path) -> PathBuf {
        data_dir.join(".seeds")
    }

    fn ensure_seeds_dir(data_dir: &Path) -> std::result::Result<PathBuf, String> {
        let dir = seeds_dir(data_dir);
        fs::create_dir_all(&dir)
            .map_err(|e| format!("failed to create seeds dir: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
        }
        Ok(dir)
    }

    fn get_or_create_salt(data_dir: &Path) -> std::result::Result<[u8; 32], String> {
        let dir = ensure_seeds_dir(data_dir)?;
        let salt_path = dir.join("salt");

        if salt_path.exists() {
            let data =
                fs::read(&salt_path).map_err(|e| format!("failed to read salt: {e}"))?;
            if data.len() == 32 {
                let mut salt = [0u8; 32];
                salt.copy_from_slice(&data);
                return Ok(salt);
            }
        }

        // Generate new random salt
        use rand::RngCore;
        let mut salt = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut salt);
        fs::write(&salt_path, &salt).map_err(|e| format!("failed to write salt: {e}"))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&salt_path, fs::Permissions::from_mode(0o600));
        }

        Ok(salt)
    }

    /// Derive a deterministic 12-byte nonce from the wallet ID.
    fn derive_nonce(wallet_id: &str) -> [u8; 12] {
        let hash = Sha256::digest(wallet_id.as_bytes());
        let mut nonce = [0u8; 12];
        nonce.copy_from_slice(&hash[..12]);
        nonce
    }

    pub fn store(
        data_dir: &Path,
        wallet_id: &str,
        phrase: &str,
    ) -> std::result::Result<(), String> {
        let salt = get_or_create_salt(data_dir)?;
        let nonce_bytes = derive_nonce(wallet_id);

        let cipher = ChaCha20Poly1305::new(Key::from_slice(&salt));
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, phrase.as_bytes())
            .map_err(|_| "seed encryption failed".to_string())?;

        let dir = ensure_seeds_dir(data_dir)?;
        let enc_path = dir.join(format!("{wallet_id}.enc"));
        fs::write(&enc_path, &ciphertext)
            .map_err(|e| format!("failed to write encrypted seed: {e}"))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&enc_path, fs::Permissions::from_mode(0o600));
        }

        Ok(())
    }

    pub fn get(data_dir: &Path, wallet_id: &str) -> std::result::Result<String, String> {
        let salt = get_or_create_salt(data_dir)?;
        let nonce_bytes = derive_nonce(wallet_id);

        let cipher = ChaCha20Poly1305::new(Key::from_slice(&salt));
        let nonce = Nonce::from_slice(&nonce_bytes);

        let enc_path = seeds_dir(data_dir).join(format!("{wallet_id}.enc"));
        let ciphertext =
            fs::read(&enc_path).map_err(|e| format!("failed to read encrypted seed: {e}"))?;

        let plaintext = cipher
            .decrypt(nonce, ciphertext.as_ref())
            .map_err(|_| "seed decryption failed (corrupted data or wrong key)".to_string())?;

        String::from_utf8(plaintext).map_err(|e| format!("invalid UTF-8 in decrypted seed: {e}"))
    }

    pub fn delete(data_dir: &Path, wallet_id: &str) -> std::result::Result<(), String> {
        let enc_path = seeds_dir(data_dir).join(format!("{wallet_id}.enc"));
        if enc_path.exists() {
            fs::remove_file(&enc_path)
                .map_err(|e| format!("failed to delete encrypted seed: {e}"))?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Legacy keyring fallback (migration from old keyring-based storage)
// ---------------------------------------------------------------------------

mod legacy_keyring {
    use super::SERVICE;

    pub fn get(wallet_id: &str) -> std::result::Result<String, String> {
        let key = format!("seed_{wallet_id}");
        let entry = keyring::Entry::new(SERVICE, &key)
            .map_err(|e| format!("legacy keyring access failed: {e}"))?;
        entry
            .get_password()
            .map_err(|e| format!("legacy keyring retrieve failed: {e}"))
    }

    pub fn delete(wallet_id: &str) -> std::result::Result<(), String> {
        let key = format!("seed_{wallet_id}");
        if let Ok(entry) = keyring::Entry::new(SERVICE, &key) {
            let _ = entry.delete_credential();
        }
        Ok(())
    }
}
