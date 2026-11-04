//! Receive-only Zcash observation and durable automation delivery.
//! Spending and application accounting deliberately live outside this crate.
pub mod chain;
pub mod config;
pub mod delivery;
pub mod journal;
pub mod proof;
pub mod receiver;
pub mod scanner;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Payment {
    pub id: String,
    pub txid: String,
    pub pool: String,
    pub output_index: usize,
    pub value_zatoshis: u64,
    /// Full 512-byte shielded memo, encoded as hex. Empty is a ZIP-302 value,
    /// never an absent or not-yet-fetched memo.
    pub memo_hex: String,
    /// Exact 43-byte pool receiver, encoded as hex, for memo-independent routing.
    pub recipient_hex: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Event {
    pub schema_version: u32,
    pub journal_sequence: u64,
    pub event_id: String,
    pub kind: String,
    pub network: String,
    pub payment: Payment,
    pub block_height: u32,
    pub block_hash: String,
    pub revision: u32,
}

/// A canonical receipt, including historical notes suppressed by the automation floor.
/// This is not a forged lifecycle event and cannot be sent through event replay.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PaymentRecord {
    pub network: String,
    pub payment: Payment,
    pub block_height: u32,
    pub block_hash: String,
    pub revision: u32,
    pub confirmed: bool,
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock before UNIX epoch")
        .as_secs() as i64
}
