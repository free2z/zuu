pub mod accounts;
pub mod cache;
pub mod client;
pub mod history;
pub mod keychain;
pub mod keys;
pub mod manifest;
pub mod send;
pub mod storage;
pub mod sync;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64};
use secrecy::SecretVec;
use tokio::sync::{Mutex, RwLock};
use zcash_protocol::consensus::Network;

/// Type alias for a cached transaction proposal.
pub type WalletProposal = zcash_client_backend::proposal::Proposal<
    zcash_primitives::transaction::fees::zip317::FeeRule,
    zcash_client_sqlite::ReceivedNoteId,
>;

/// Type alias for our concrete WalletDb.
pub type WalletDatabase =
    zcash_client_sqlite::WalletDb<rusqlite::Connection, Network, zcash_client_sqlite::util::SystemClock, rand::rngs::OsRng>;

pub struct WalletState {
    pub network: Network,
    pub data_dir: PathBuf,
    pub db: Arc<Mutex<Option<WalletDatabase>>>,
    /// Read-only DB connection for non-blocking reads during sync.
    pub read_db: Arc<Mutex<Option<WalletDatabase>>>,
    pub seed: Arc<Mutex<Option<SecretVec<u8>>>>,
    pub lightwalletd_url: RwLock<String>,
    pub sync_handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub syncing: Arc<RwLock<bool>>,
    pub last_known_chain_tip: Arc<AtomicU64>,
    pub manifest: Arc<Mutex<manifest::WalletManifest>>,
    pub prover: Arc<Mutex<Option<zcash_proofs::prover::LocalTxProver>>>,
    pub pending_proposal: Arc<Mutex<Option<(u32, WalletProposal)>>>,
    pub proposal_counter: Arc<AtomicU32>,
}

impl WalletState {
    pub fn new(data_dir: PathBuf, network: Network) -> Self {
        // Load or create the manifest, migrating legacy wallet.sqlite if needed
        let mut manifest = manifest::WalletManifest::load(&data_dir);
        manifest.migrate_legacy(&data_dir);

        // If there's an active wallet, try to open its DB and load seed from keychain
        let (db, read_db) = if let Some(active) = manifest.get_active() {
            let db_path = data_dir.join(&active.db_filename);
            match storage::init_wallet_db(&db_path, network) {
                Ok(db) => {
                    tracing::info!("reopened existing wallet: {} ({})", active.name, active.id);
                    let rdb = match storage::open_read_db(&db_path, network) {
                        Ok(rdb) => Some(rdb),
                        Err(e) => {
                            tracing::warn!("failed to open read-only db: {e}");
                            None
                        }
                    };
                    (Some(db), rdb)
                }
                Err(e) => {
                    tracing::error!("failed to reopen wallet {}: {e}", active.id);
                    (None, None)
                }
            }
        } else {
            (None, None)
        };

        // Try to load seed from keychain / encrypted file for active wallet
        let seed = if let Some(active) = manifest.get_active() {
            match keychain::get_seed_phrase(&data_dir, &active.id) {
                Ok(phrase) => {
                    match keys::parse_mnemonic(&phrase) {
                        Ok(mnemonic) => {
                            tracing::info!("loaded seed from secure storage for wallet {}", active.id);
                            Some(keys::mnemonic_to_seed(&mnemonic))
                        }
                        Err(e) => {
                            tracing::warn!("stored seed invalid for wallet {}: {e}", active.id);
                            None
                        }
                    }
                }
                Err(_) => {
                    tracing::info!("no seed in secure storage for wallet {}", active.id);
                    None
                }
            }
        } else {
            None
        };

        Self {
            network,
            data_dir,
            db: Arc::new(Mutex::new(db)),
            read_db: Arc::new(Mutex::new(read_db)),
            seed: Arc::new(Mutex::new(seed)),
            lightwalletd_url: RwLock::new(
                "https://zec.rocks:443".to_string(),
            ),
            sync_handle: Mutex::new(None),
            syncing: Arc::new(RwLock::new(false)),
            last_known_chain_tip: Arc::new(AtomicU64::new(0)),
            manifest: Arc::new(Mutex::new(manifest)),
            prover: Arc::new(Mutex::new(None)),
            pending_proposal: Arc::new(Mutex::new(None)),
            proposal_counter: Arc::new(AtomicU32::new(0)),
        }
    }

    pub async fn is_initialized(&self) -> bool {
        self.read_db.lock().await.is_some()
    }

    /// Get the DB path for the active wallet
    pub async fn active_db_path(&self) -> PathBuf {
        let manifest = self.manifest.lock().await;
        if let Some(active) = manifest.get_active() {
            self.data_dir.join(&active.db_filename)
        } else {
            self.data_dir.join("wallet.sqlite")
        }
    }

    /// Get the active wallet ID
    pub async fn active_wallet_id(&self) -> Option<String> {
        let manifest = self.manifest.lock().await;
        manifest.active_wallet_id.clone()
    }
}
