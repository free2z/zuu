use std::path::Path;

use rand::rngs::OsRng;
use zcash_client_sqlite::util::SystemClock;
use zcash_protocol::consensus::Network;

use crate::error::{Error, Result};
use crate::wallet::WalletDatabase;

/// Initialize or open the SQLite wallet database.
pub fn init_wallet_db(
    db_path: &Path,
    network: Network,
) -> Result<WalletDatabase> {
    let mut db = zcash_client_sqlite::WalletDb::for_path(db_path, network, SystemClock, OsRng)
        .map_err(|e| Error::DatabaseError(format!("failed to initialize wallet db: {e}")))?;

    // Run migrations
    zcash_client_sqlite::wallet::init::init_wallet_db(&mut db, None)
        .map_err(|e| Error::DatabaseError(format!("migration failed: {e}")))?;

    Ok(db)
}
