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
use tokio::sync::{Mutex, MutexGuard, RwLock};
use zeroize::Zeroizing;
use zcash_client_backend::data_api::{Account, WalletRead};
use zcash_protocol::consensus::Network;

/// Type alias for a cached transaction proposal.
pub type WalletProposal = zcash_client_backend::proposal::Proposal<
    zcash_primitives::transaction::fees::zip317::FeeRule,
    zcash_client_sqlite::ReceivedNoteId,
>;

/// Type alias for our concrete WalletDb.
pub type WalletDatabase =
    zcash_client_sqlite::WalletDb<rusqlite::Connection, Network, zcash_client_sqlite::util::SystemClock, rand::rngs::OsRng>;

/// Proof that an identity-sensitive operation owns the wallet transition.
/// Custody retrieval requires this token so a future caller cannot accidentally
/// split active-ID lookup, DB validation, native fetch, and seed installation
/// across a concurrent switch or deletion.
pub struct WalletTransitionGuard<'a> {
    _guard: MutexGuard<'a, ()>,
}

pub struct WalletState {
    pub network: Network,
    pub data_dir: PathBuf,
    pub db: Arc<Mutex<Option<WalletDatabase>>>,
    /// Read-only DB connection for non-blocking reads during sync.
    pub read_db: Arc<Mutex<Option<WalletDatabase>>>,
    pub seed: Arc<Mutex<Option<SecretVec<u8>>>>,
    pub seed_store: keychain::SeedStore,
    pub lightwalletd_url: RwLock<String>,
    pub sync_handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub syncing: Arc<RwLock<bool>>,
    pub last_known_chain_tip: Arc<AtomicU64>,
    /// Most recent sync error, shared between the background sync task (writer)
    /// and the `get_sync_status` command (reader). `None` once a pass succeeds.
    /// Zuuli polls `get_sync_status`, so the error MUST live here — not only in
    /// the emitted event — for the UI to see it.
    pub last_sync_error: Arc<RwLock<Option<String>>>,
    /// Serializes create/restore/switch/delete through the final write-DB swap.
    pub wallet_transition: Arc<Mutex<()>>,
    pub manifest: Arc<Mutex<manifest::WalletManifest>>,
    pub prover: Arc<Mutex<Option<zcash_proofs::prover::LocalTxProver>>>,
    pub pending_proposal: Arc<Mutex<Option<(u32, WalletProposal)>>>,
    pub proposal_counter: Arc<AtomicU32>,
}

impl WalletState {
    pub fn new(data_dir: PathBuf, network: Network, seed_store: keychain::SeedStore) -> Self {
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

        Self {
            network,
            data_dir,
            db: Arc::new(Mutex::new(db)),
            read_db: Arc::new(Mutex::new(read_db)),
            // Native custody may require user presence. Never prompt during
            // application setup and never keep spending authority across a
            // restart; commands load it lazily after an explicit user action.
            seed: Arc::new(Mutex::new(None)),
            seed_store,
            lightwalletd_url: RwLock::new(
                "https://zec.rocks:443".to_string(),
            ),
            sync_handle: Mutex::new(None),
            syncing: Arc::new(RwLock::new(false)),
            last_known_chain_tip: Arc::new(AtomicU64::new(0)),
            last_sync_error: Arc::new(RwLock::new(None)),
            wallet_transition: Arc::new(Mutex::new(())),
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

    pub async fn lock_wallet_transition(&self) -> WalletTransitionGuard<'_> {
        WalletTransitionGuard {
            _guard: self.wallet_transition.lock().await,
        }
    }

    pub async fn store_seed_phrase(&self, wallet_id: &str, phrase: &str) -> crate::Result<()> {
        let store = self.seed_store.clone();
        let wallet_id = wallet_id.to_owned();
        let phrase = Zeroizing::new(phrase.to_owned());
        tokio::task::spawn_blocking(move || store.store_seed_phrase(&wallet_id, phrase.as_str()))
            .await
            .map_err(|error| crate::error::Error::KeyError(format!("secure-storage task panicked: {error}")))?
    }

    /// Retrieve and, when necessary, migrate a seed only after proving that its
    /// derived UFVK is the one recorded in the active wallet database.
    pub async fn get_seed_phrase(
        &self,
        _transition: &WalletTransitionGuard<'_>,
        wallet_id: &str,
    ) -> crate::Result<Zeroizing<String>> {
        let active_wallet_id = self
            .active_wallet_id()
            .await
            .ok_or(crate::error::Error::WalletNotInitialized)?;
        if active_wallet_id != wallet_id {
            return Err(crate::error::Error::KeyError(
                "refusing to retrieve custody for a non-active wallet".into(),
            ));
        }

        let expected_ufvk = {
            let db_guard = self.read_db.lock().await;
            match db_guard.as_ref() {
                Some(db) => {
                    let account_id = db
                        .get_account_ids()
                        .map_err(|error| crate::error::Error::DatabaseError(error.to_string()))?
                        .first()
                        .copied()
                        .ok_or_else(|| crate::error::Error::KeyError("wallet has no account to validate seed migration".into()))?;
                    Some(
                        db.get_account(account_id)
                            .map_err(|error| crate::error::Error::DatabaseError(error.to_string()))?
                            .and_then(|account| account.ufvk().cloned())
                            .ok_or_else(|| crate::error::Error::KeyError("wallet has no viewing key to validate seed migration".into()))?
                            .encode(&self.network),
                    )
                }
                None => None,
            }
        };

        let store = self.seed_store.clone();
        let wallet_id = wallet_id.to_owned();
        let network = self.network;
        tokio::task::spawn_blocking(move || {
            if let Some(expected_ufvk) = expected_ufvk {
                store.get_seed_phrase_validated(&wallet_id, |phrase| {
                    let mnemonic = keys::parse_mnemonic(phrase)?;
                    let seed = keys::mnemonic_to_seed(&mnemonic);
                    let derived = keys::derive_usk(
                        secrecy::ExposeSecret::expose_secret(&seed),
                        &network,
                        0,
                    )?
                    .to_unified_full_viewing_key()
                    .encode(&network);
                    if derived == expected_ufvk {
                        Ok(())
                    } else {
                        Err(crate::error::Error::KeyError(
                            "seed phrase does not match this wallet".into(),
                        ))
                    }
                })
            } else {
                tracing::warn!(
                    wallet_id,
                    "wallet database unavailable; revealing native seed without legacy migration"
                );
                store.get_native_seed_phrase(&wallet_id)
            }
        })
        .await
        .map_err(|error| crate::error::Error::KeyError(format!("secure-storage task panicked: {error}")))?
    }

    pub async fn delete_seed_phrase(&self, wallet_id: &str) -> crate::Result<()> {
        let store = self.seed_store.clone();
        let wallet_id = wallet_id.to_owned();
        tokio::task::spawn_blocking(move || store.delete_seed_phrase(&wallet_id))
            .await
            .map_err(|error| crate::error::Error::KeyError(format!("secure-storage task panicked: {error}")))?
    }
}
