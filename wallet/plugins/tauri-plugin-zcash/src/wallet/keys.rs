use bip0039::{Count, Mnemonic};
use secrecy::SecretVec;
use zcash_keys::keys::UnifiedSpendingKey;
use zcash_protocol::consensus::Network;

use crate::error::{Error, Result};

/// Generate a new BIP39 mnemonic seed phrase.
pub fn generate_mnemonic(word_count: u32) -> Result<Mnemonic> {
    let count = match word_count {
        12 => Count::Words12,
        15 => Count::Words15,
        18 => Count::Words18,
        21 => Count::Words21,
        24 => Count::Words24,
        _ => return Err(Error::InvalidMnemonic(
            format!("unsupported word count: {word_count}; use 12, 15, 18, 21, or 24"),
        )),
    };
    Ok(Mnemonic::generate(count))
}

/// Parse an existing mnemonic phrase.
pub fn parse_mnemonic(phrase: &str) -> Result<Mnemonic> {
    Mnemonic::from_phrase(phrase)
        .map_err(|e| Error::InvalidMnemonic(e.to_string()))
}

/// Derive a seed from a mnemonic.
pub fn mnemonic_to_seed(mnemonic: &Mnemonic) -> SecretVec<u8> {
    let seed_bytes = mnemonic.to_seed("");
    SecretVec::new(seed_bytes.to_vec())
}

/// Derive a unified spending key for a given account index.
pub fn derive_usk(
    seed: &[u8],
    network: &Network,
    account_index: u32,
) -> Result<UnifiedSpendingKey> {
    let account = zip32::AccountId::try_from(account_index)
        .map_err(|e| Error::KeyError(format!("invalid account index: {e}")))?;
    UnifiedSpendingKey::from_seed(network, seed, account)
        .map_err(|e| Error::KeyError(format!("key derivation failed: {e}")))
}
