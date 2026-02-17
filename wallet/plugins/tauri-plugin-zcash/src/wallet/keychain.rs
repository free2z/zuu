use crate::error::{Error, Result};

const SERVICE: &str = "com.free2z.zuuli";

/// Store a seed phrase in the OS keychain.
pub fn store_seed_phrase(wallet_id: &str, phrase: &str) -> Result<()> {
    let key = format!("seed_{wallet_id}");
    let entry = keyring::Entry::new(SERVICE, &key)
        .map_err(|e| Error::KeyError(format!("keychain access failed: {e}")))?;
    entry
        .set_password(phrase)
        .map_err(|e| Error::KeyError(format!("keychain store failed: {e}")))?;
    tracing::info!("stored seed in keychain for wallet {wallet_id}");
    Ok(())
}

/// Retrieve a seed phrase from the OS keychain.
/// On macOS, this triggers the system authentication prompt (password/Touch ID).
pub fn get_seed_phrase(wallet_id: &str) -> Result<String> {
    let key = format!("seed_{wallet_id}");
    let entry = keyring::Entry::new(SERVICE, &key)
        .map_err(|e| Error::KeyError(format!("keychain access failed: {e}")))?;
    entry
        .get_password()
        .map_err(|e| Error::KeyError(format!("keychain retrieve failed: {e}")))
}

/// Delete a seed phrase from the OS keychain.
pub fn delete_seed_phrase(wallet_id: &str) -> Result<()> {
    let key = format!("seed_{wallet_id}");
    let entry = keyring::Entry::new(SERVICE, &key)
        .map_err(|e| Error::KeyError(format!("keychain access failed: {e}")))?;
    entry
        .delete_credential()
        .map_err(|e| Error::KeyError(format!("keychain delete failed: {e}")))?;
    Ok(())
}
