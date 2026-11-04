//! Offline external shielded receiver ownership; never opens a journal or node.
use anyhow::{Result, ensure};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use zcash_keys::{address::Address, keys::UnifiedFullViewingKey};
use zip32::Scope;

use crate::config::Config;

pub const MAX_ADDRESS_BYTES: usize = 4096;

#[derive(Debug, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiverCoverage {
    pub pool: &'static str,
    pub receiver_sha256: String,
    /// True only for an external incoming receiver, never internal change.
    pub key_match: bool,
}

#[derive(Debug, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AddressCoverage {
    pub schema_version: u32,
    pub network: String,
    pub ufvk_sha256: String,
    pub address_sha256: String,
    pub transparent_present: bool,
    pub unknown_receiver_count: usize,
    pub shielded_receivers: Vec<ReceiverCoverage>,
    /// All supported shielded receivers match, none are unknown, and at least one exists.
    /// Transparent receivers are reported, but cannot carry payment memos.
    pub fully_covered: bool,
}

fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Read exactly one address, with optional surrounding ASCII whitespace.
/// The raw input including whitespace must fit the bound. Never echo rejected input.
pub fn read_address(reader: impl Read) -> Result<String> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_ADDRESS_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_ADDRESS_BYTES,
        "address input exceeds bound"
    );
    let input =
        std::str::from_utf8(&bytes).map_err(|_| anyhow::anyhow!("invalid address input"))?;
    let address = input.trim_matches(|c: char| c.is_ascii_whitespace());
    ensure!(
        !address.is_empty() && !address.chars().any(char::is_whitespace),
        "one address is required"
    );
    Ok(address.to_owned())
}

/// Cryptographically compare each receiver against this profile's external UFVK components.
/// A successful parse can still return `fully_covered=false`: callers must inspect the proof.
pub fn verify_address(c: &Config, ufvk: &str, address: &str) -> Result<AddressCoverage> {
    ensure!(
        address.len() <= MAX_ADDRESS_BYTES,
        "address input exceeds bound"
    );
    let params = c.params()?;
    let ufvk = ufvk.trim();
    let key = UnifiedFullViewingKey::decode(&params, ufvk)
        .map_err(|_| anyhow::anyhow!("invalid viewing key for configured network"))?;
    let decoded = Address::decode(&params, address)
        .ok_or_else(|| anyhow::anyhow!("invalid address for configured network"))?;
    let (sapling, orchard, transparent_present, unknown_receiver_count) = match &decoded {
        Address::Sapling(receiver) => (Some(receiver), None, false, 0),
        Address::Unified(ua) => (
            ua.sapling(),
            ua.orchard(),
            ua.has_transparent(),
            ua.unknown().len(),
        ),
        Address::Transparent(_) | Address::Tex(_) => (None, None, true, 0),
    };
    let mut shielded_receivers = Vec::new();
    if let Some(receiver) = sapling {
        let key_match = key
            .sapling()
            .and_then(|fvk| fvk.diversified_address(*receiver.diversifier()))
            .is_some_and(|derived| derived == *receiver);
        shielded_receivers.push(ReceiverCoverage {
            pool: "sapling",
            receiver_sha256: hash(&receiver.to_bytes()),
            key_match,
        });
    }
    if let Some(receiver) = orchard {
        let key_match = key
            .orchard()
            .and_then(|fvk| fvk.scope_for_address(receiver))
            == Some(Scope::External);
        // Ironwood uses the same Orchard address/FVK; the scanner decrypts both pools.
        for pool in ["orchard", "ironwood"] {
            shielded_receivers.push(ReceiverCoverage {
                pool,
                receiver_sha256: hash(&receiver.to_raw_address_bytes()),
                key_match,
            });
        }
    }
    let fully_covered = unknown_receiver_count == 0
        && !shielded_receivers.is_empty()
        && shielded_receivers.iter().all(|r| r.key_match);
    Ok(AddressCoverage {
        schema_version: 1,
        network: c.network.clone(),
        ufvk_sha256: hash(ufvk.as_bytes()),
        address_sha256: hash(address.as_bytes()),
        transparent_present,
        unknown_receiver_count,
        shielded_receivers,
        fully_covered,
    })
}
