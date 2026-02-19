use rusqlite::OpenFlags;

use crate::error::{Error, Result};
use crate::models::TransactionEntry;
use crate::wallet::WalletState;

/// Get transaction history for a given account.
pub async fn get_transaction_history(
    state: &WalletState,
    account_index: u32,
    offset: u32,
    limit: u32,
) -> Result<Vec<TransactionEntry>> {
    if !state.is_initialized().await {
        return Err(Error::WalletNotInitialized);
    }

    let db_path = state.active_db_path().await;
    let limit = limit.min(500);

    // Open a separate read-only connection (WAL mode allows concurrent readers)
    let conn = rusqlite::Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| Error::DatabaseError(format!("failed to open db for history: {e}")))?;

    // Get the account UUID for the given account index
    let account_uuid: Vec<u8> = conn
        .query_row(
            "SELECT uuid FROM accounts ORDER BY id LIMIT 1 OFFSET ?1",
            [account_index],
            |row| row.get(0),
        )
        .map_err(|e| Error::DatabaseError(format!("account not found: {e}")))?;

    // Query v_transactions view which aggregates all note data per account per tx
    let mut stmt = conn
        .prepare(
            "WITH tx_list AS (
                SELECT
                    vt.txid            AS txid,
                    vt.mined_height    AS mined_height,
                    vt.block_time      AS block_time,
                    vt.account_balance_delta AS balance_delta,
                    vt.sent_note_count AS sent_note_count,
                    vt.received_note_count AS received_note_count
                FROM v_transactions vt
                WHERE vt.account_uuid = ?1
                  AND COALESCE(vt.expired_unmined, 0) = 0
                ORDER BY vt.mined_height DESC NULLS FIRST
                LIMIT ?2 OFFSET ?3
            )
            SELECT
                tx_list.txid,
                tx_list.mined_height,
                tx_list.block_time,
                tx_list.balance_delta,
                tx_list.sent_note_count,
                tx_list.received_note_count,
                (
                    SELECT memo FROM (
                        SELECT srn.memo FROM sapling_received_notes srn
                        JOIN transactions t ON t.id_tx = srn.transaction_id
                        WHERE t.txid = tx_list.txid
                          AND srn.memo IS NOT NULL AND srn.memo != X'F6'
                          AND srn.is_change = 0
                        UNION ALL
                        SELECT orn.memo FROM orchard_received_notes orn
                        JOIN transactions t ON t.id_tx = orn.transaction_id
                        WHERE t.txid = tx_list.txid
                          AND orn.memo IS NOT NULL AND orn.memo != X'F6'
                          AND orn.is_change = 0
                        UNION ALL
                        SELECT sn.memo FROM sent_notes sn
                        JOIN transactions t ON t.id_tx = sn.transaction_id
                        WHERE t.txid = tx_list.txid
                          AND sn.memo IS NOT NULL AND sn.memo != X'F6'
                    )
                    LIMIT 1
                ) AS memo
            FROM tx_list",
        )
        .map_err(|e| Error::DatabaseError(format!("failed to prepare history query: {e}")))?;

    let rows = stmt
        .query_map(
            rusqlite::params![account_uuid, limit, offset],
            |row| {
                let txid_blob: Vec<u8> = row.get(0)?;
                let mined_height: Option<u64> = row.get(1)?;
                let block_time: Option<i64> = row.get(2)?;
                let balance_delta: Option<i64> = row.get(3)?;
                let sent_note_count: i64 = row.get(4)?;
                let _received_note_count: i64 = row.get(5)?;
                let memo_blob: Option<Vec<u8>> = row.get(6)?;

                // Reverse txid bytes for display (Zcash convention)
                let mut txid_reversed = txid_blob;
                txid_reversed.reverse();
                let txid_hex = txid_reversed
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>();

                // Decode memo: strip trailing null bytes, attempt UTF-8
                let memo = memo_blob.and_then(|bytes| {
                    let trimmed: Vec<u8> = bytes
                        .into_iter()
                        .rev()
                        .skip_while(|&b| b == 0)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect();
                    if trimmed.is_empty() {
                        None
                    } else {
                        String::from_utf8(trimmed).ok()
                    }
                });

                let delta = balance_delta.unwrap_or(0);
                let incoming = sent_note_count == 0 && delta > 0;

                Ok(TransactionEntry {
                    txid: txid_hex,
                    block_height: mined_height,
                    timestamp: block_time,
                    value: delta,
                    memo,
                    incoming,
                })
            },
        )
        .map_err(|e| Error::DatabaseError(format!("failed to query history: {e}")))?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(
            row.map_err(|e| Error::DatabaseError(format!("failed to read row: {e}")))?,
        );
    }

    Ok(entries)
}
