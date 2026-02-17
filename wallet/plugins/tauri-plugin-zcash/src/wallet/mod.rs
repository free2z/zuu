pub mod accounts;
pub mod cache;
pub mod client;
pub mod history;
pub mod keys;
pub mod send;
pub mod storage;
pub mod sync;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use secrecy::SecretVec;
use tokio::sync::{Mutex, RwLock};
use zcash_protocol::consensus::Network;

/// Type alias for our concrete WalletDb.
pub type WalletDatabase =
    zcash_client_sqlite::WalletDb<rusqlite::Connection, Network, zcash_client_sqlite::util::SystemClock, rand::rngs::OsRng>;

pub struct WalletState {
    pub network: Network,
    pub db_path: PathBuf,
    pub db: Arc<Mutex<Option<WalletDatabase>>>,
    pub seed: Arc<Mutex<Option<SecretVec<u8>>>>,
    pub lightwalletd_url: RwLock<String>,
    pub sync_handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub syncing: Arc<RwLock<bool>>,
    pub last_known_chain_tip: Arc<AtomicU64>,
}

impl WalletState {
    pub fn new(data_dir: PathBuf, network: Network) -> Self {
        let db_path = data_dir.join("wallet.sqlite");
        Self {
            network,
            db_path,
            db: Arc::new(Mutex::new(None)),
            seed: Arc::new(Mutex::new(None)),
            lightwalletd_url: RwLock::new(
                "https://zec.rocks:443".to_string(),
            ),
            sync_handle: Mutex::new(None),
            syncing: Arc::new(RwLock::new(false)),
            last_known_chain_tip: Arc::new(AtomicU64::new(0)),
        }
    }

    pub async fn is_initialized(&self) -> bool {
        self.db.lock().await.is_some()
    }
}
