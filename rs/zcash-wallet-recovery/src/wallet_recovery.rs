//! Explicit full-transaction recovery, independent of enhancement queue state.
use anyhow::{Result, ensure};
use rand::{rand_core::UnwrapErr, rngs::SysRng};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use zcash_client_backend::{
    data_api::{
        WalletRead,
        wallet::{ConfirmationsPolicy, TargetHeight, decrypt_and_store_transaction},
    },
    proto::service::RawTransaction,
};
use zcash_client_sqlite::{WalletDb, util::SystemClock, wallet::init::init_wallet_db};
use zcash_primitives::transaction::{Transaction, TxId};
use zcash_protocol::consensus::{BlockHeight, BranchId, Network};

pub type RecoveryWallet = WalletDb<rusqlite::Connection, Network, SystemClock, UnwrapErr<SysRng>>;

#[cfg(unix)]
fn check_wallet_path_ancestors(parent: &Path, euid: u32) -> Result<()> {
    use std::os::unix::fs::MetadataExt;

    let mut current_path = PathBuf::from("/");
    let mut current = fs::metadata(&current_path)?;
    for component in parent.components().skip(1) {
        current_path.push(component);
        let next = fs::metadata(&current_path)?;
        ensure!(
            next.is_dir(),
            "wallet path contains a non-directory component"
        );

        let mode = current.mode() & 0o7777;
        let trusted_owner = current.uid() == 0 || current.uid() == euid;
        let writable_by_untrusted = mode & 0o022 != 0 || (!trusted_owner && mode & 0o200 != 0);
        if writable_by_untrusted {
            ensure!(
                mode & 0o1000 != 0 && trusted_owner && (next.uid() == 0 || next.uid() == euid),
                "wallet path contains a directory writable by less-trusted users"
            );
        }
        current = next;
    }
    Ok(())
}

/// The upstream wallet graph still bundles SQLite < 3.54. Only open an
/// operator-owned wallet in a directory that less-trusted users cannot write
/// or replace through a writable ancestor. This is the security boundary for
/// RUSTSEC-2026-0459's crafted DB/WAL case.
#[cfg(unix)]
fn private_wallet_path(path: &Path) -> Result<PathBuf> {
    use std::os::unix::fs::MetadataExt;

    let supplied = fs::symlink_metadata(path)?;
    ensure!(
        !supplied.file_type().is_symlink(),
        "wallet symlink is not allowed"
    );

    let path = path.canonicalize()?;
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("wallet parent is required"))?;
    let directory = fs::metadata(parent)?;
    let euid = rustc_u32_euid();
    ensure!(directory.is_dir(), "wallet parent is not a directory");
    ensure!(
        directory.uid() == euid,
        "wallet directory must be owned by the recovery process"
    );
    ensure!(
        directory.mode() & 0o7777 == 0o700,
        "wallet directory must be private (0700), found {:o}",
        directory.mode() & 0o7777
    );
    check_wallet_path_ancestors(parent, euid)?;
    check_private_wallet_file(&path)?;
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut companion = path.as_os_str().to_os_string();
        companion.push(suffix);
        let companion = PathBuf::from(companion);
        match fs::symlink_metadata(&companion) {
            Ok(_) => check_private_wallet_file(&companion)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(path)
}

#[cfg(unix)]
fn rustc_u32_euid() -> u32 {
    nix::unistd::geteuid().as_raw()
}

#[cfg(unix)]
fn check_private_wallet_file(path: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;

    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.file_type().is_file()
            && metadata.uid() == rustc_u32_euid()
            && metadata.mode() & 0o7777 == 0o600
            && metadata.nlink() == 1,
        "wallet database and companions must be owned private regular files with one link"
    );
    Ok(())
}

#[cfg(not(unix))]
fn private_wallet_path(_path: &Path) -> Result<PathBuf> {
    anyhow::bail!("wallet recovery requires private Unix file ownership")
}

// Exact released-library DDL fingerprint. Derive the reference in memory via
// the library's own migrator; never migrate an operator wallet. Reject unknown
// extensions and pre-release schemas rather than guessing write compatibility.
fn schema_digest(conn: &rusqlite::Connection) -> Result<[u8; 32]> {
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
        [],
        |r| r.get(0),
    )?;
    ensure!(count <= 512, "schema object budget exceeded");
    let mut stmt = conn.prepare("SELECT type,name,tbl_name,CASE WHEN length(sql)<=65536 THEN sql ELSE NULL END FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name")?;
    let mut rows = stmt.query([])?;
    let mut hash = Sha256::new();
    while let Some(row) = rows.next()? {
        for column in 0..4 {
            let value: String = row.get(column)?;
            ensure!(value.len() <= 65536, "schema value budget exceeded");
            hash.update((value.len() as u64).to_le_bytes());
            hash.update(value.as_bytes());
        }
    }
    Ok(hash.finalize().into())
}

/// Open only an existing wallet whose exact DDL matches the compiled release.
/// Network identity is checked by the supported UFVK decoding API before use.
pub fn open_recovery_wallet(path: &Path, params: Network) -> Result<RecoveryWallet> {
    let path = private_wallet_path(path)?;
    // WalletDb deliberately does not expose its connection. Construct the
    // reference with a borrowed connection to inspect it after migration.
    let mut reference_conn = rusqlite::Connection::open_in_memory()?;
    rusqlite::vtab::array::load_module(&reference_conn)?;
    {
        let mut reference =
            WalletDb::from_connection(&mut reference_conn, params, SystemClock, UnwrapErr(SysRng));
        init_wallet_db(&mut reference, None)?;
    }
    let conn =
        rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    conn.busy_timeout(Duration::from_secs(1))?;
    rusqlite::vtab::array::load_module(&conn)?;
    ensure!(
        schema_digest(&conn)? == schema_digest(&reference_conn)?,
        "incompatible wallet schema"
    );
    let db = WalletDb::from_connection(conn, params, SystemClock, UnwrapErr(SysRng));
    ensure!(
        !db.get_unified_full_viewing_keys()?.is_empty(),
        "verified network viewing key required"
    );
    Ok(db)
}

/// Verify the requested transaction is mined and has received shielded value.
/// These reads include spent notes; spending is never a recovery disposition.
pub fn validate_received(db: &RecoveryWallet, hash: &[u8], height: BlockHeight) -> Result<()> {
    let hash: [u8; 32] = hash.try_into()?;
    let txid = TxId::from_bytes(hash);
    let tip = db
        .chain_height()?
        .ok_or_else(|| anyhow::anyhow!("wallet tip unavailable"))?;
    ensure!(
        tip >= height && db.get_tx_height(txid)? == Some(height),
        "wallet mined height mismatch"
    );
    ensure!(
        !db.get_unified_full_viewing_keys()?.is_empty(),
        "verified network viewing key required"
    );
    let outputs = db.get_received_outputs(
        txid,
        TargetHeight::from(tip + 1),
        ConfirmationsPolicy::default(),
    )?;
    ensure!(
        outputs
            .iter()
            .any(|o| o.pool_type() != zcash_protocol::PoolType::Transparent
                && o.value() > zcash_protocol::value::Zatoshis::ZERO),
        "mined received shielded transaction required"
    );
    Ok(())
}

/// Apply one provider response. NotFound never changes wallet status or queues.
/// Validate identity and mined height before entering the supported wallet API.
pub fn apply_response(
    db: &mut WalletDb<rusqlite::Connection, Network, SystemClock, UnwrapErr<SysRng>>,
    params: Network,
    hash: &[u8],
    height: BlockHeight,
    response: Result<RawTransaction, tonic::Status>,
) -> Result<bool> {
    validate_received(db, hash, height)?;
    let response = match response {
        Ok(response) => response,
        Err(status) if status.code() == tonic::Code::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    ensure!(
        response.height == u64::from(height),
        "mined height mismatch"
    );
    let mut bytes = &response.data[..];
    let tx = Transaction::read(&mut bytes, BranchId::for_height(&params, height))?;
    ensure!(bytes.is_empty(), "trailing transaction bytes");
    ensure!(tx.txid().as_ref() == hash, "transaction identity mismatch");
    decrypt_and_store_transaction(&params, db, &tx, Some(height))?;
    Ok(true)
}
