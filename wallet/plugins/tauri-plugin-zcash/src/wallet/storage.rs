use std::path::Path;

use rand::rngs::OsRng;
use rusqlite::{Connection, OpenFlags};
use zcash_client_sqlite::util::SystemClock;
use zcash_protocol::consensus::Network;

use crate::error::{Error, Result};
use crate::wallet::WalletDatabase;

/// Initialize or open the SQLite wallet database.
pub fn init_wallet_db(db_path: &Path, network: Network) -> Result<WalletDatabase> {
    let conn = Connection::open(db_path)
        .map_err(|e| Error::DatabaseError(format!("failed to open wallet db: {e}")))?;
    prepare_wallet_connection(conn, network)
}

/// Open a manifest-owned database without silently creating a replacement if
/// the recorded file is missing.
pub fn open_existing_wallet_db(db_path: &Path, network: Network) -> Result<WalletDatabase> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| Error::DatabaseError(format!("failed to reopen wallet db: {e}")))?;
    prepare_wallet_connection(conn, network)
}

fn prepare_wallet_connection(conn: Connection, network: Network) -> Result<WalletDatabase> {
    // Enable WAL mode for concurrent read access
    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| Error::DatabaseError(format!("failed to enable WAL mode: {e}")))?;

    // Load the array virtual table module (required by WalletDb queries)
    rusqlite::vtab::array::load_module(&conn)
        .map_err(|e| Error::DatabaseError(format!("failed to load array module: {e}")))?;

    let mut db = zcash_client_sqlite::WalletDb::from_connection(conn, network, SystemClock, OsRng);

    // Run migrations
    zcash_client_sqlite::wallet::init::init_wallet_db(&mut db, None)
        .map_err(|e| Error::DatabaseError(format!("migration failed: {e}")))?;

    Ok(db)
}

/// Open a read-only connection to an existing wallet database.
/// Uses SQLite WAL mode to allow concurrent reads while the writer is active.
pub fn open_read_db(db_path: &Path, network: Network) -> Result<WalletDatabase> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| Error::DatabaseError(format!("failed to open read-only db: {e}")))?;

    // Load the array virtual table module (required by WalletDb queries)
    rusqlite::vtab::array::load_module(&conn)
        .map_err(|e| Error::DatabaseError(format!("failed to load array module: {e}")))?;

    Ok(zcash_client_sqlite::WalletDb::from_connection(
        conn,
        network,
        SystemClock,
        OsRng,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reopening_missing_manifest_database_does_not_create_replacement() {
        let data_dir =
            std::env::temp_dir().join(format!("zuuli-open-existing-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&data_dir).expect("create test directory");
        let db_path = data_dir.join("missing.sqlite");

        assert!(open_existing_wallet_db(&db_path, Network::MainNetwork).is_err());
        assert!(!db_path.exists());
        std::fs::remove_dir_all(data_dir).expect("remove test directory");
    }
}
