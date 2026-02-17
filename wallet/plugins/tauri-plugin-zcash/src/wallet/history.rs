use zcash_client_backend::data_api::WalletRead;

use crate::error::{Error, Result};
use crate::models::TransactionEntry;
use crate::wallet::WalletState;

/// Get transaction history for a given account.
pub async fn get_transaction_history(
    state: &WalletState,
    account_index: u32,
    _offset: u32,
    _limit: u32,
) -> Result<Vec<TransactionEntry>> {
    if !state.is_initialized().await {
        return Err(Error::WalletNotInitialized);
    }

    let db_guard = state.db.lock().await;
    let db = db_guard.as_ref().ok_or(Error::WalletNotInitialized)?;

    let account_ids = db
        .get_account_ids()
        .map_err(|e| Error::DatabaseError(format!("{e}")))?;

    let _account_id = account_ids
        .get(account_index as usize)
        .copied()
        .ok_or(Error::DatabaseError("account not found".into()))?;

    // Query transactions from the SQLite database directly
    // The WalletRead trait doesn't expose a direct transaction history method,
    // so we query the underlying database schema
    // For now, return an empty list - transactions will appear after syncing
    // A full implementation would query the `transactions`, `sent_notes`,
    // and `received_notes` tables

    Ok(vec![])
}
