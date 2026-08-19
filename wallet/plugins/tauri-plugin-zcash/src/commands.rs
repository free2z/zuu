use std::future::Future;
use std::sync::Arc;

use tauri::{AppHandle, Runtime, command};

use secrecy::ExposeSecret;
use zcash_client_backend::data_api::wallet::ConfirmationsPolicy;
use zcash_client_backend::data_api::{
    Account, AccountBirthday, BirthdayError, WalletRead, WalletWrite,
};
use zcash_client_backend::proto::service::BlockId;
use zcash_keys::keys::UnifiedAddressRequest;
use zeroize::Zeroizing;

use crate::error::Error;
use crate::models::*;
use crate::wallet::client::connect_to_lightwalletd;
use crate::wallet::{keys, send, storage};
use crate::{Result, ZcashExt};

fn format_birthday_error(e: BirthdayError) -> String {
    match e {
        BirthdayError::HeightInvalid(e) => format!("invalid height: {e}"),
        BirthdayError::Decode(e) => format!("decode error: {e}"),
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PreviousSyncContext {
    wallet_id: Option<String>,
    was_syncing: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SyncRecoveryObligation {
    previous: PreviousSyncContext,
    armed: bool,
}

impl SyncRecoveryObligation {
    fn new(previous: PreviousSyncContext) -> Self {
        Self {
            armed: previous.was_syncing,
            previous,
        }
    }

    fn commit(&mut self) {
        self.armed = false;
    }

    fn should_restart(&self, active_wallet_id: Option<&str>, shutting_down: bool) -> bool {
        self.armed
            && self
                .previous
                .should_restart(active_wallet_id, shutting_down)
    }
}

impl PreviousSyncContext {
    fn should_restart(&self, active_wallet_id: Option<&str>, shutting_down: bool) -> bool {
        self.was_syncing
            && !shutting_down
            && self
                .wallet_id
                .as_deref()
                .is_some_and(|wallet_id| Some(wallet_id) == active_wallet_id)
    }
}

/// Owns the obligation to restore a sync task stopped for an uncommitted wallet
/// transition. Normal errors restore synchronously through `restore_now`; Drop
/// covers cancellation, timeout, and panic-unwind boundaries by scheduling the
/// same identity-checked recovery after the transition lock is released.
struct StoppedSyncRecovery<R: Runtime> {
    app: AppHandle<R>,
    obligation: SyncRecoveryObligation,
}

impl<R: Runtime> StoppedSyncRecovery<R> {
    async fn stop(app: AppHandle<R>) -> Self {
        let state = &app.zcash().state;
        let previous = PreviousSyncContext {
            wallet_id: state.active_wallet_id().await,
            was_syncing: *state.syncing.read().await,
        };
        // Construct the guard before the first cancellation point involved in
        // stopping the task. If this future is dropped while joining, Drop will
        // still restore the exact context that was active at entry.
        let recovery = Self {
            app,
            obligation: SyncRecoveryObligation::new(previous),
        };
        crate::wallet::sync::stop_sync(&recovery.app.zcash().state)
            .await
            .expect("stopping sync is infallible");
        recovery
    }

    fn commit(&mut self) {
        self.obligation.commit();
    }

    async fn restore_now(&mut self) {
        if !self.obligation.armed {
            return;
        }
        restart_previous_sync(&self.app, &self.obligation).await;
        self.obligation.commit();
    }
}

impl<R: Runtime> Drop for StoppedSyncRecovery<R> {
    fn drop(&mut self) {
        if !self.obligation.armed || self.app.zcash().state.sync_supervisor.is_shutting_down() {
            return;
        }
        let app = self.app.clone();
        let obligation = self.obligation.clone();
        let transition = Arc::clone(&app.zcash().state.wallet_transition);
        // The command's owned transition guard is declared before this recovery
        // guard, so it drops immediately after us. Reacquiring it here makes the
        // cancelled transition and its recovery one serialized identity unit.
        spawn_recovery_after_transition(transition, async move {
            restart_previous_sync(&app, &obligation).await;
        });
    }
}

fn spawn_recovery_after_transition<F>(transition: Arc<tokio::sync::Mutex<()>>, recovery: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let _transition = transition.lock_owned().await;
        recovery.await;
    });
}

async fn restart_previous_sync<R: Runtime>(
    app: &AppHandle<R>,
    obligation: &SyncRecoveryObligation,
) {
    let state = &app.zcash().state;
    let shutting_down = state.sync_supervisor.is_shutting_down();
    let active_wallet_id = state.active_wallet_id().await;
    if !obligation.should_restart(active_wallet_id.as_deref(), shutting_down) {
        if obligation.previous.was_syncing && !shutting_down {
            tracing::warn!(
                expected_wallet_id = ?obligation.previous.wallet_id,
                active_wallet_id = ?active_wallet_id,
                "not restoring sync because the wallet context changed"
            );
        }
        return;
    }
    if let Err(error) = crate::wallet::sync::start_sync(app.clone(), state).await {
        tracing::error!(
            wallet_id = ?obligation.previous.wallet_id,
            "failed to restore sync after aborted wallet transition: {error}"
        );
    }
}

struct CommittedWalletDeletion {
    was_active: bool,
}

/// Validate and remove a wallet from the manifest/DB deletion path.
///
/// Returning this token proves the manifest replacement became visible; its
/// cleanup flag separately proves crash durability before seed destruction.
/// Rejected or durability-uncertain deletions cannot erase recovery data.
fn commit_wallet_deletion(
    manifest: &mut crate::wallet::manifest::WalletManifest,
    data_dir: &std::path::Path,
    wallet_id: &str,
) -> Result<CommittedWalletDeletion> {
    let was_active = manifest.active_wallet_id.as_deref() == Some(wallet_id);
    manifest
        .delete_wallet_durable(data_dir, wallet_id)
        .map_err(|e| match e {
            crate::wallet::manifest::DeleteWalletError::LastWallet => {
                Error::Other("cannot delete the last wallet".into())
            }
            crate::wallet::manifest::DeleteWalletError::NotFound => {
                Error::Other("wallet not found".into())
            }
            crate::wallet::manifest::DeleteWalletError::Persistence(e) => {
                Error::DatabaseError(format!("failed to persist wallet deletion: {e}"))
            }
        })?;

    Ok(CommittedWalletDeletion { was_active })
}

pub(crate) async fn run_wallet_cleanup_retry(
    state: &crate::wallet::WalletState,
    mode: crate::wallet::cleanup::RetryMode,
) -> WalletCleanupStatus {
    let manifest = state.manifest.lock().await.clone();
    let data_dir = state.data_dir.clone();
    let seed_store = state.seed_store.clone();
    let status = match tokio::task::spawn_blocking(move || {
        crate::wallet::cleanup::retry_pending(&data_dir, &manifest, &seed_store, mode)
    })
    .await
    {
        Ok(Ok(report)) => WalletCleanupStatus::from(report),
        Ok(Err(error)) => {
            tracing::error!("wallet cleanup retry could not update its journal: {error}");
            WalletCleanupStatus::from(crate::wallet::cleanup::CleanupReport::journal_error(error))
        }
        Err(error) => {
            tracing::error!("wallet cleanup retry task failed: {error}");
            WalletCleanupStatus::from(crate::wallet::cleanup::CleanupReport::journal_error(
                format!("cleanup task failed: {error}"),
            ))
        }
    };
    *state.cleanup_status.lock().await = status.clone();
    status
}

/// Finish startup custody cleanup after plugin setup has returned, keeping
/// synchronous/potentially prompting native APIs off the application init
/// thread. The startup filesystem pass already resolved manifest uncertainty,
/// so runtime mode is sufficient and cannot reinterpret an in-memory manifest.
pub(crate) async fn resume_wallet_cleanup_after_setup<R: Runtime>(app: AppHandle<R>) {
    let zcash = app.zcash();
    let _transition_guard = zcash.state.lock_wallet_transition().await;
    let status =
        run_wallet_cleanup_retry(&zcash.state, crate::wallet::cleanup::RetryMode::Runtime).await;
    if status.pending_operations > 0 || status.blocked_operations > 0 {
        tracing::warn!(
            pending = status.pending_operations,
            blocked = status.blocked_operations,
            diagnostics = ?status.diagnostics,
            "post-setup wallet cleanup remains pending"
        );
    }
}

async fn retry_staged_wallet_cleanup(state: &crate::wallet::WalletState, context: &str) {
    let status = run_wallet_cleanup_retry(state, crate::wallet::cleanup::RetryMode::Runtime).await;
    if status.pending_operations > 0 {
        tracing::warn!(
            pending = status.pending_operations,
            diagnostics = ?status.diagnostics,
            "{context}; orphan cleanup remains durably scheduled"
        );
    }
}

fn open_wallet_context(
    data_dir: &std::path::Path,
    wallet: &crate::wallet::manifest::WalletEntry,
    network: zcash_protocol::consensus::Network,
) -> Result<(crate::wallet::WalletDatabase, crate::wallet::WalletDatabase)> {
    let db_path = data_dir.join(&wallet.db_filename);
    let db = storage::init_wallet_db(&db_path, network)?;
    let read_db = storage::open_read_db(&db_path, network)?;
    Ok((db, read_db))
}

/// Lazily authenticate and install spending authority for the active wallet.
/// The transition token proves that active-ID lookup, UFVK validation in native
/// custody, and the in-memory seed installation all refer to one wallet.
async fn ensure_active_seed_loaded(
    state: &crate::wallet::WalletState,
    transition: &crate::wallet::WalletTransitionGuard<'_>,
) -> Result<()> {
    if state.seed.lock().await.is_some() {
        return Ok(());
    }
    let wallet_id = state
        .active_wallet_id()
        .await
        .ok_or(Error::WalletNotInitialized)?;
    let phrase = state.get_seed_phrase(transition, &wallet_id).await?;
    let mnemonic = keys::parse_mnemonic(&phrase)?;
    *state.seed.lock().await = Some(keys::mnemonic_to_seed(&mnemonic));
    Ok(())
}

fn ensure_challenge_signing_allowed(
    manifest: &crate::wallet::manifest::WalletManifest,
) -> Result<()> {
    if manifest.active_backup_required() {
        Err(Error::BackupRequired)
    } else {
        Ok(())
    }
}

#[command]
pub(crate) async fn create_wallet<R: Runtime>(
    app: AppHandle<R>,
    args: CreateWalletArgs,
) -> Result<WalletCreated> {
    let zcash = app.zcash();
    let transition_guard = Arc::clone(&zcash.state.wallet_transition)
        .lock_owned()
        .await;
    let _send_guard = Arc::clone(&zcash.state.send_operation).lock_owned().await;
    let word_count = args.mnemonic_word_count.unwrap_or(24);
    let wallet_name = args.name.unwrap_or_else(|| "Default".to_string());

    // Stop any running sync and retain an identity-bound recovery obligation
    // until the new wallet context has committed.
    let mut sync_recovery = StoppedSyncRecovery::stop(app.clone()).await;

    let result = async {
    let mnemonic = keys::generate_mnemonic(word_count)?;
    let seed = keys::mnemonic_to_seed(&mnemonic);

    // Connect to lightwalletd and get current chain tip
    let url = zcash.state.lightwalletd_url.read().await.clone();
    let mut client = connect_to_lightwalletd(&url).await?;

    let tip = client
        .get_latest_block(zcash_client_backend::proto::service::ChainSpec::default())
        .await
        .map_err(|e| Error::NetworkError(format!("failed to get chain tip: {e}")))?
        .into_inner();
    let tip_height = tip.height as u64;

    // Get tree state at tip for birthday
    let tree_state = client
        .get_tree_state(BlockId {
            height: tip_height,
            hash: vec![],
        })
        .await
        .map_err(|e| Error::NetworkError(format!("failed to get tree state: {e}")))?
        .into_inner();

    let birthday = AccountBirthday::from_treestate(tree_state, None)
        .map_err(|e| Error::DatabaseError(format!("failed to create birthday: {}", format_birthday_error(e))))?;

    // Allocate an identity, but keep it out of the durable manifest until its
    // database and native seed custody have both committed.
    let mut wallet_entry = crate::wallet::manifest::WalletManifest::prepare_wallet(
        wallet_name,
        Some(tip_height),
    );
    crate::wallet::manifest::WalletManifest::require_backup(&mut wallet_entry);
    let cleanup_authorization =
        crate::wallet::cleanup::schedule_staged_wallet_rollback(
            &zcash.state.data_dir,
            &wallet_entry,
        )
        .map_err(|error| {
            Error::DatabaseError(format!(
                "failed to schedule rollback before wallet creation: {error}"
            ))
        })?;

    // Initialize database at new path — local variable, no mutex needed yet
    let db_path = zcash.state.data_dir.join(&wallet_entry.db_filename);
    let mut db = match storage::init_wallet_db(&db_path, zcash.state.network) {
        Ok(db) => db,
        Err(error) => {
            retry_staged_wallet_cleanup(
                &zcash.state,
                "wallet database initialization failed",
            )
            .await;
            return Err(error);
        }
    };

    // Create account on the local db (no mutex contention)
    if let Err(error) = db.create_account(&wallet_entry.name, &seed, &birthday, None) {
        drop(db);
        retry_staged_wallet_cleanup(&zcash.state, "wallet account creation failed").await;
        return Err(Error::DatabaseError(format!(
            "failed to create account: {error}"
        )));
    }

    let read_db = match storage::open_read_db(&db_path, zcash.state.network) {
        Ok(db) => db,
        Err(error) => {
            drop(db);
            retry_staged_wallet_cleanup(&zcash.state, "wallet read database open failed").await;
            return Err(error);
        }
    };

    // Platform-native custody is mandatory; there is no filesystem fallback.
    let phrase = Zeroizing::new(mnemonic.phrase().to_string());
    if let Err(error) = zcash
        .state
        .store_seed_phrase(&wallet_entry.id, phrase.as_str())
        .await
    {
        drop(read_db);
        drop(db);
        retry_staged_wallet_cleanup(&zcash.state, "native seed commit failed").await;
        return Err(error);
    }

    // Narrow destructive authority before publication. If manifest directory
    // durability is later inconclusive, the wallet can be exposed without any
    // crash path retaining authority to destroy its recovery custody.
    if let Err(error) = crate::wallet::cleanup::protect_staged_wallet_custody(
        &zcash.state.data_dir,
        &cleanup_authorization,
    ) {
        drop(read_db);
        drop(db);
        retry_staged_wallet_cleanup(&zcash.state, "recovery custody protection failed").await;
        return Err(Error::DatabaseError(format!(
            "failed to protect recovery custody before wallet publication: {error}"
        )));
    }

    // Acquire every live context slot before publication. Once the manifest
    // commit returns successfully, installing the matching in-memory context
    // contains no cancellation point.
    let mut db_guard = zcash.state.db.lock().await;
    let mut read_db_guard = zcash.state.read_db.lock().await;
    let mut seed_guard = zcash.state.seed.lock().await;
    let mut pending_proposal_guard = zcash.state.pending_proposal.lock().await;
    let mut pending_broadcast_guard = zcash.state.pending_broadcast.lock().await;
    let manifest_commit = {
        let mut manifest = zcash.state.manifest.lock().await;
        manifest.commit_wallet(&zcash.state.data_dir, wallet_entry.clone())
    };
    let manifest_commit_durable = match manifest_commit {
        Ok(true) => true,
        Ok(false) => {
            tracing::warn!(
                wallet_id = wallet_entry.id,
                "new wallet manifest is visible but directory durability was not confirmed"
            );
            false
        }
        Err(error) => {
            drop(pending_broadcast_guard);
            drop(pending_proposal_guard);
            drop(seed_guard);
            drop(read_db_guard);
            drop(db_guard);
            drop(read_db);
            drop(db);
            if let Err(cleanup_error) =
                crate::wallet::cleanup::rearm_staged_wallet_custody_cleanup(
                    &zcash.state.data_dir,
                    &cleanup_authorization,
                )
            {
                tracing::warn!(
                    wallet_id = wallet_entry.id,
                    "wallet publication failed and custody cleanup could not be re-armed; recovery material is intentionally preserved: {cleanup_error}"
                );
            }
            retry_staged_wallet_cleanup(&zcash.state, "wallet manifest commit failed").await;
            return Err(Error::DatabaseError(format!(
                "failed to commit wallet manifest: {error}"
            )));
        }
    };
    if manifest_commit_durable
        && let Err(error) = crate::wallet::cleanup::confirm_staged_wallet_commit(
            &zcash.state.data_dir,
            &cleanup_authorization,
        )
    {
        tracing::warn!(
            wallet_id = wallet_entry.id,
            "wallet committed but rollback tombstone finalization failed; startup will resolve it: {error}"
        );
    }

    *pending_proposal_guard = None;
    *pending_broadcast_guard =
        send::load_pending_broadcast(&zcash.state.data_dir, &wallet_entry.id);
    *db_guard = Some(db);
    *read_db_guard = Some(read_db);
    *seed_guard = Some(seed);
    sync_recovery.commit();
    drop(pending_broadcast_guard);
    drop(pending_proposal_guard);
    drop(seed_guard);
    drop(read_db_guard);
    drop(db_guard);

    // The exact generation is now active. A cancellation failure is safe
    // because every future retry recognizes and preserves this manifest
    // generation.
    retry_staged_wallet_cleanup(&zcash.state, "wallet rollback cancellation deferred").await;

    Ok(WalletCreated {
        wallet_id: wallet_entry.id.clone(),
        seed_phrase: mnemonic.phrase().to_string(),
        birthday_height: tip_height,
    })
    }
    .await;

    match result {
        Ok(created) => {
            sync_recovery.commit();
            // Keep the transition lock through task registration so another
            // switch/delete cannot replace the just-installed context between
            // publication and its automatic sync start.
            let _ = crate::wallet::sync::start_sync(app.clone(), &zcash.state).await;
            drop(transition_guard);
            Ok(created)
        }
        Err(error) => {
            sync_recovery.restore_now().await;
            drop(transition_guard);
            Err(error)
        }
    }
}

#[command]
pub(crate) async fn restore_wallet<R: Runtime>(
    app: AppHandle<R>,
    args: RestoreWalletArgs,
) -> Result<serde_json::Value> {
    let zcash = app.zcash();
    let transition_guard = Arc::clone(&zcash.state.wallet_transition)
        .lock_owned()
        .await;
    let _send_guard = Arc::clone(&zcash.state.send_operation).lock_owned().await;
    let mnemonic = keys::parse_mnemonic(&args.seed_phrase)?;
    let seed = keys::mnemonic_to_seed(&mnemonic);
    let birthday_height = args.birthday_height.unwrap_or(419200); // sapling activation
    let wallet_name = args.name.unwrap_or_else(|| "Restored".to_string());

    // Stop any running sync and retain an identity-bound recovery obligation
    // until the restored wallet context has committed.
    let mut sync_recovery = StoppedSyncRecovery::stop(app.clone()).await;

    let result = async {
    // Connect to lightwalletd
    let url = zcash.state.lightwalletd_url.read().await.clone();
    let mut client = connect_to_lightwalletd(&url).await?;

    // Get chain tip for recover_until
    let tip = client
        .get_latest_block(zcash_client_backend::proto::service::ChainSpec::default())
        .await
        .map_err(|e| Error::NetworkError(format!("failed to get chain tip: {e}")))?
        .into_inner();
    let chain_tip = tip.height as u64;

    // Get tree state at birthday height for the birthday
    let tree_height = if birthday_height > 0 {
        birthday_height
    } else {
        419200 // sapling activation on mainnet
    };

    let tree_state = client
        .get_tree_state(BlockId {
            height: tree_height,
            hash: vec![],
        })
        .await
        .map_err(|e| Error::NetworkError(format!("failed to get tree state: {e}")))?
        .into_inner();

    let recover_until = zcash_protocol::consensus::BlockHeight::from_u32(chain_tip as u32);
    let birthday = AccountBirthday::from_treestate(tree_state, Some(recover_until))
        .map_err(|e| Error::DatabaseError(format!("failed to create birthday: {}", format_birthday_error(e))))?;

    // Allocate an identity, but keep it out of the durable manifest until its
    // database and native seed custody have both committed.
    let wallet_entry = crate::wallet::manifest::WalletManifest::prepare_wallet(
        wallet_name,
        Some(birthday_height),
    );
    let cleanup_authorization =
        crate::wallet::cleanup::schedule_staged_wallet_rollback(
            &zcash.state.data_dir,
            &wallet_entry,
        )
        .map_err(|error| {
            Error::DatabaseError(format!(
                "failed to schedule rollback before wallet restoration: {error}"
            ))
        })?;

    // Initialize database — local variable, no mutex needed yet
    let db_path = zcash.state.data_dir.join(&wallet_entry.db_filename);
    let mut db = match storage::init_wallet_db(&db_path, zcash.state.network) {
        Ok(db) => db,
        Err(error) => {
            retry_staged_wallet_cleanup(
                &zcash.state,
                "restored database initialization failed",
            )
            .await;
            return Err(error);
        }
    };

    // Create account on the local db (no mutex contention)
    if let Err(error) = db.create_account(&wallet_entry.name, &seed, &birthday, None) {
        drop(db);
        retry_staged_wallet_cleanup(&zcash.state, "restored account creation failed").await;
        return Err(Error::DatabaseError(format!(
            "failed to create account: {error}"
        )));
    }

    let read_db = match storage::open_read_db(&db_path, zcash.state.network) {
        Ok(db) => db,
        Err(error) => {
            drop(db);
            retry_staged_wallet_cleanup(
                &zcash.state,
                "restored wallet read database open failed",
            )
            .await;
            return Err(error);
        }
    };

    // Platform-native custody is mandatory; there is no filesystem fallback.
    let phrase_str = Zeroizing::new(mnemonic.phrase().to_string());
    if let Err(error) = zcash
        .state
        .store_seed_phrase(&wallet_entry.id, phrase_str.as_str())
        .await
    {
        drop(read_db);
        drop(db);
        retry_staged_wallet_cleanup(&zcash.state, "restored native seed commit failed").await;
        return Err(error);
    }

    if let Err(error) = crate::wallet::cleanup::protect_staged_wallet_custody(
        &zcash.state.data_dir,
        &cleanup_authorization,
    ) {
        drop(read_db);
        drop(db);
        retry_staged_wallet_cleanup(
            &zcash.state,
            "restored recovery custody protection failed",
        )
        .await;
        return Err(Error::DatabaseError(format!(
            "failed to protect restored recovery custody before wallet publication: {error}"
        )));
    }

    let mut db_guard = zcash.state.db.lock().await;
    let mut read_db_guard = zcash.state.read_db.lock().await;
    let mut seed_guard = zcash.state.seed.lock().await;
    let mut pending_proposal_guard = zcash.state.pending_proposal.lock().await;
    let mut pending_broadcast_guard = zcash.state.pending_broadcast.lock().await;
    let manifest_commit = {
        let mut manifest = zcash.state.manifest.lock().await;
        manifest.commit_wallet(&zcash.state.data_dir, wallet_entry.clone())
    };
    let manifest_commit_durable = match manifest_commit {
        Ok(true) => true,
        Ok(false) => {
            tracing::warn!(
                wallet_id = wallet_entry.id,
                "restored wallet manifest is visible but directory durability was not confirmed"
            );
            false
        }
        Err(error) => {
            drop(pending_broadcast_guard);
            drop(pending_proposal_guard);
            drop(seed_guard);
            drop(read_db_guard);
            drop(db_guard);
            drop(read_db);
            drop(db);
            if let Err(cleanup_error) =
                crate::wallet::cleanup::rearm_staged_wallet_custody_cleanup(
                    &zcash.state.data_dir,
                    &cleanup_authorization,
                )
            {
                tracing::warn!(
                    wallet_id = wallet_entry.id,
                    "restored wallet publication failed and custody cleanup could not be re-armed; recovery material is intentionally preserved: {cleanup_error}"
                );
            }
            retry_staged_wallet_cleanup(
                &zcash.state,
                "restored wallet manifest commit failed",
            )
            .await;
            return Err(Error::DatabaseError(format!(
                "failed to commit wallet manifest: {error}"
            )));
        }
    };
    if manifest_commit_durable
        && let Err(error) = crate::wallet::cleanup::confirm_staged_wallet_commit(
            &zcash.state.data_dir,
            &cleanup_authorization,
        )
    {
        tracing::warn!(
            wallet_id = wallet_entry.id,
            "restored wallet committed but rollback tombstone finalization failed; startup will resolve it: {error}"
        );
    }

    *pending_proposal_guard = None;
    *pending_broadcast_guard =
        send::load_pending_broadcast(&zcash.state.data_dir, &wallet_entry.id);
    *db_guard = Some(db);
    *read_db_guard = Some(read_db);
    *seed_guard = Some(seed);
    sync_recovery.commit();
    drop(pending_broadcast_guard);
    drop(pending_proposal_guard);
    drop(seed_guard);
    drop(read_db_guard);
    drop(db_guard);

    retry_staged_wallet_cleanup(
        &zcash.state,
        "restored wallet rollback cancellation deferred",
    )
    .await;

    Ok(serde_json::json!({ "success": true }))
    }
    .await;

    match result {
        Ok(value) => {
            sync_recovery.commit();
            // Keep the transition lock through task registration so another
            // switch/delete cannot replace the just-installed context between
            // publication and its automatic sync start.
            let _ = crate::wallet::sync::start_sync(app.clone(), &zcash.state).await;
            drop(transition_guard);
            Ok(value)
        }
        Err(error) => {
            sync_recovery.restore_now().await;
            drop(transition_guard);
            Err(error)
        }
    }
}

#[command]
pub(crate) async fn get_wallet_status<R: Runtime>(app: AppHandle<R>) -> Result<WalletStatus> {
    let zcash = app.zcash();
    let _transition_guard = zcash.state.lock_wallet_transition().await;
    let initialized = zcash.state.is_initialized().await;
    let has_seed = zcash.state.seed.lock().await.is_some();

    let manifest = zcash.state.manifest.lock().await;
    let active_wallet_id = manifest.active_wallet_id.clone();
    let active_wallet_name = manifest.get_active().map(|w| w.name.clone());
    let backup_required = manifest.active_backup_required();
    let wallet_count = manifest.wallets.len() as u32;
    drop(manifest);
    let cleanup = zcash.state.cleanup_status.lock().await.clone();

    let (synced_height, chain_tip) = if initialized {
        let db_guard = zcash.state.read_db.lock().await;
        if let Some(db) = db_guard.as_ref() {
            let height = db
                .chain_height()
                .ok()
                .flatten()
                .map(|h| u64::from(u32::from(h)));
            (height, None)
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };

    Ok(WalletStatus {
        initialized,
        has_seed,
        synced_height,
        chain_tip,
        active_wallet_id,
        active_wallet_name,
        wallet_count,
        backup_required,
        cleanup,
        legacy_app_data: zcash.legacy_app_data.clone(),
    })
}

/// Explicitly retry every authorized orphan cleanup operation. Stage failures
/// are returned as diagnostics rather than command errors so callers never
/// confuse a cleanup backend failure with an ambiguous wallet transition.
#[command]
pub(crate) async fn retry_wallet_cleanup<R: Runtime>(
    app: AppHandle<R>,
) -> Result<WalletCleanupStatus> {
    let zcash = app.zcash();
    let _transition_guard = Arc::clone(&zcash.state.wallet_transition)
        .lock_owned()
        .await;
    Ok(run_wallet_cleanup_retry(&zcash.state, crate::wallet::cleanup::RetryMode::Runtime).await)
}

#[command]
pub(crate) async fn get_seed_phrase<R: Runtime>(app: AppHandle<R>) -> Result<String> {
    let zcash = app.zcash();
    let transition_guard = zcash.state.lock_wallet_transition().await;
    let wallet_id = zcash
        .state
        .active_wallet_id()
        .await
        .ok_or(Error::WalletNotInitialized)?;
    zcash
        .state
        .get_seed_phrase(&transition_guard, &wallet_id)
        .await
        .map(|phrase| phrase.to_string())
}

/// Retrieve the recovery phrase only for the exact active wallet whose backup
/// acknowledgement is still pending. The transition lock binds the manifest
/// check and custody read so a concurrent wallet switch cannot disclose a
/// different wallet's phrase to a stale backup screen.
#[command]
pub(crate) async fn get_backup_seed_phrase<R: Runtime>(
    app: AppHandle<R>,
    args: ConfirmWalletBackupArgs,
) -> Result<String> {
    let zcash = app.zcash();
    let transition_guard = zcash.state.lock_wallet_transition().await;
    {
        let manifest = zcash.state.manifest.lock().await;
        if !manifest.is_exact_active_backup_pending(&args.wallet_id) {
            return Err(Error::BackupRequired);
        }
    }
    zcash
        .state
        .get_seed_phrase(&transition_guard, &args.wallet_id)
        .await
        .map(|phrase| phrase.to_string())
}

#[command]
pub(crate) async fn confirm_wallet_backup<R: Runtime>(
    app: AppHandle<R>,
    args: ConfirmWalletBackupArgs,
) -> Result<()> {
    let zcash = app.zcash();
    let _transition_guard = zcash.state.lock_wallet_transition().await;
    let mut manifest = zcash.state.manifest.lock().await;
    match manifest.confirm_backup(&zcash.state.data_dir, &args.wallet_id) {
        Ok(true) => Ok(()),
        Ok(false) => Err(Error::Other(
            "backup confirmation does not match the active wallet".into(),
        )),
        Err(error) => Err(Error::Io(error)),
    }
}

#[command]
pub(crate) async fn unlock_wallet<R: Runtime>(
    app: AppHandle<R>,
    args: UnlockWalletArgs,
) -> Result<()> {
    let zcash = app.zcash();
    let _transition_guard = zcash.state.lock_wallet_transition().await;
    let _send_guard = zcash.state.send_operation.lock().await;

    // Parse and validate the mnemonic
    let mnemonic = keys::parse_mnemonic(&args.seed_phrase)?;
    let seed = keys::mnemonic_to_seed(&mnemonic);

    // The open read DB belongs to the active wallet. Never validate against it
    // and then write the phrase under a different wallet's custody slot.
    let active_wallet_id = zcash
        .state
        .active_wallet_id()
        .await
        .ok_or(Error::WalletNotInitialized)?;
    if args
        .wallet_id
        .as_deref()
        .is_some_and(|requested| requested != active_wallet_id.as_str())
    {
        return Err(Error::KeyError(
            "cannot unlock a non-active wallet; switch wallets first".into(),
        ));
    }
    let wallet_id = active_wallet_id;

    // Verify the seed matches the wallet's UFVK:
    // 1. Derive USK from the provided seed
    // 2. Get UFVK from the USK
    // 3. Compare with the UFVK stored in the wallet DB
    let usk = keys::derive_usk(seed.expose_secret(), &zcash.state.network, 0)?;
    let derived_ufvk = usk.to_unified_full_viewing_key();

    let db_guard = zcash.state.read_db.lock().await;
    let db = db_guard.as_ref().ok_or(Error::WalletNotInitialized)?;
    let account_ids = db
        .get_account_ids()
        .map_err(|e| Error::DatabaseError(format!("{e}")))?;
    let account_id = account_ids
        .first()
        .copied()
        .ok_or(Error::AddressError("no accounts in wallet".into()))?;
    let account = db
        .get_account(account_id)
        .map_err(|e| Error::DatabaseError(format!("{e}")))?
        .ok_or(Error::AddressError("account not found".into()))?;
    let stored_ufvk = account
        .ufvk()
        .ok_or(Error::KeyError("wallet has no viewing key".into()))?;
    drop(db_guard);

    // Compare encoded UFVKs
    let derived_encoded = derived_ufvk.encode(&zcash.state.network);
    let stored_encoded = stored_ufvk.encode(&zcash.state.network);
    if derived_encoded != stored_encoded {
        let derived_prefix = &derived_encoded[..derived_encoded.len().min(20)];
        let stored_prefix = &stored_encoded[..stored_encoded.len().min(20)];
        return Err(Error::KeyError(format!(
            "seed phrase does not match this wallet. \
                 Derived UFVK starts with: {derived_prefix}... \
                 Stored UFVK starts with: {stored_prefix}..."
        )));
    }

    // Store in platform-native custody only.
    let phrase = Zeroizing::new(mnemonic.phrase().to_string());
    zcash
        .state
        .store_seed_phrase(&wallet_id, phrase.as_str())
        .await?;

    // Set seed in memory
    *zcash.state.seed.lock().await = Some(seed);

    tracing::info!("wallet {wallet_id} unlocked successfully");
    Ok(())
}

#[command]
pub(crate) async fn get_viewing_key<R: Runtime>(
    app: AppHandle<R>,
    args: AccountIdArgs,
) -> Result<String> {
    let zcash = app.zcash();
    let _transition_guard = zcash.state.lock_wallet_transition().await;

    if !zcash.state.is_initialized().await {
        return Err(Error::WalletNotInitialized);
    }

    let db_guard = zcash.state.read_db.lock().await;
    let db = db_guard.as_ref().ok_or(Error::WalletNotInitialized)?;

    let account_ids = db
        .get_account_ids()
        .map_err(|e| Error::DatabaseError(format!("failed to get account ids: {e}")))?;

    let account_id = account_ids
        .get(args.account_index as usize)
        .copied()
        .ok_or(Error::AddressError("account not found".into()))?;

    let account = db
        .get_account(account_id)
        .map_err(|e| Error::DatabaseError(format!("failed to get account: {e}")))?
        .ok_or(Error::AddressError("account not found".into()))?;

    let ufvk = account
        .ufvk()
        .ok_or(Error::KeyError("no unified full viewing key".into()))?;

    Ok(ufvk.encode(&zcash.state.network))
}

#[command]
pub(crate) async fn get_spending_key<R: Runtime>(
    app: AppHandle<R>,
    args: AccountIdArgs,
) -> Result<SpendingKeyStatus> {
    let zcash = app.zcash();
    let transition_guard = zcash.state.lock_wallet_transition().await;

    ensure_active_seed_loaded(&zcash.state, &transition_guard).await?;

    // Now try to use the seed
    let seed_guard = zcash.state.seed.lock().await;
    let seed = seed_guard.as_ref().ok_or(Error::KeyError(
        "seed not available — re-enter your recovery phrase in Settings".into(),
    ))?;

    // Verify we can derive a spending key (proves spending authority)
    let _usk = keys::derive_usk(
        seed.expose_secret(),
        &zcash.state.network,
        args.account_index,
    )?;

    // Return status — we intentionally don't expose raw spending key bytes.
    // The seed phrase IS the spending authority. Anyone with the seed can spend.
    Ok(SpendingKeyStatus {
        account_index: args.account_index,
        available: true,
        message: "Spending authority verified. Your seed phrase grants full spending access."
            .into(),
    })
}

// --- Multi-wallet commands ---

#[command]
pub(crate) async fn list_wallets<R: Runtime>(app: AppHandle<R>) -> Result<Vec<WalletInfo>> {
    let zcash = app.zcash();
    let _transition_guard = zcash.state.lock_wallet_transition().await;
    let manifest = zcash.state.manifest.lock().await;
    let active_id = manifest.active_wallet_id.clone();

    Ok(manifest
        .wallets
        .iter()
        .map(|w| WalletInfo {
            id: w.id.clone(),
            name: w.name.clone(),
            is_active: active_id.as_deref() == Some(&w.id),
            birthday_height: w.birthday_height,
            created_at: w.created_at.clone(),
        })
        .collect())
}

#[command]
pub(crate) async fn switch_wallet<R: Runtime>(
    app: AppHandle<R>,
    args: SwitchWalletArgs,
) -> Result<()> {
    let zcash = app.zcash();
    let _transition_guard = Arc::clone(&zcash.state.wallet_transition)
        .lock_owned()
        .await;
    let _send_operation = zcash.state.send_operation.lock().await;

    // Resolve and open the complete target context before changing any current
    // wallet state. A corrupt/unopenable target therefore leaves the active
    // manifest, DB handles, seed, sync, and proposal untouched.
    let wallet_entry = {
        let manifest = zcash.state.manifest.lock().await;
        manifest
            .wallets
            .iter()
            .find(|wallet| wallet.id == args.wallet_id)
            .cloned()
            .ok_or_else(|| Error::Other("wallet not found".into()))?
    };
    let (new_db, new_read_db) =
        open_wallet_context(&zcash.state.data_dir, &wallet_entry, zcash.state.network)?;

    // Stop and join sync so it cannot retain or mutate the previous write DB
    // while the new context is installed. Until the manifest commits, every
    // exit path retains an obligation to restore this exact wallet context.
    let mut sync_recovery = StoppedSyncRecovery::stop(app.clone()).await;

    let result = async {
        // Hold every context slot while committing the active selection. There is
        // no await between the durable manifest mutation and the in-memory swap.
        let mut db_guard = zcash.state.db.lock().await;
        let mut read_db_guard = zcash.state.read_db.lock().await;
        let mut seed_guard = zcash.state.seed.lock().await;
        let mut pending_proposal_guard = zcash.state.pending_proposal.lock().await;
        let mut pending_broadcast_guard = zcash.state.pending_broadcast.lock().await;
        let activation = {
            let mut manifest = zcash.state.manifest.lock().await;
            manifest.set_active(&zcash.state.data_dir, &args.wallet_id)
        };
        let activated = match activation {
            Ok(activated) => activated,
            Err(error) => {
                drop(pending_broadcast_guard);
                drop(pending_proposal_guard);
                drop(seed_guard);
                drop(read_db_guard);
                drop(db_guard);
                return Err(Error::DatabaseError(format!(
                    "failed to persist active wallet: {error}"
                )));
            }
        };
        if !activated {
            drop(pending_broadcast_guard);
            drop(pending_proposal_guard);
            drop(seed_guard);
            drop(read_db_guard);
            drop(db_guard);
            return Err(Error::Other("wallet not found".into()));
        }
        *db_guard = Some(new_db);
        *read_db_guard = Some(new_read_db);
        *seed_guard = None;
        // From here forward the manifest and all live context slots refer to
        // the target. Cancellation must not restart the predecessor.
        sync_recovery.commit();
        drop(seed_guard);
        drop(read_db_guard);
        drop(db_guard);

        // Only committed transitions invalidate the previous wallet's proposal.
        *pending_proposal_guard = None;
        *pending_broadcast_guard =
            send::load_pending_broadcast(&zcash.state.data_dir, &wallet_entry.id);
        drop(pending_broadcast_guard);
        drop(pending_proposal_guard);

        // Reset chain tip cache
        zcash
            .state
            .last_known_chain_tip
            .store(0, std::sync::atomic::Ordering::Relaxed);

        Ok(())
    }
    .await;

    match result {
        Ok(()) => {
            sync_recovery.commit();
            Ok(())
        }
        Err(error) => {
            sync_recovery.restore_now().await;
            Err(error)
        }
    }
}

#[command]
pub(crate) async fn rename_wallet<R: Runtime>(
    app: AppHandle<R>,
    args: RenameWalletArgs,
) -> Result<()> {
    let zcash = app.zcash();
    let _transition_guard = zcash.state.lock_wallet_transition().await;
    let mut manifest = zcash.state.manifest.lock().await;
    if !manifest.rename_wallet(&zcash.state.data_dir, &args.wallet_id, args.name) {
        return Err(Error::Other("wallet not found".into()));
    }
    Ok(())
}

#[command]
pub(crate) async fn delete_wallet<R: Runtime>(
    app: AppHandle<R>,
    args: DeleteWalletArgs,
) -> Result<()> {
    let zcash = app.zcash();
    let _transition_guard = Arc::clone(&zcash.state.wallet_transition)
        .lock_owned()
        .await;
    let _send_guard = Arc::clone(&zcash.state.send_operation).lock_owned().await;

    send::ensure_wallet_has_no_unknown_send(&zcash.state.data_dir, &args.wallet_id)?;

    let deleting_active = {
        let manifest = zcash.state.manifest.lock().await;
        manifest.active_wallet_id.as_deref() == Some(&args.wallet_id)
    };
    let mut sync_recovery = if deleting_active {
        Some(StoppedSyncRecovery::stop(app.clone()).await)
    } else {
        None
    };

    let result = async {
        // Prepare the replacement wallet before committing an active-wallet
        // deletion. Once the deletion is durable, no later failure may turn the
        // command into an ambiguous error that invites a destructive retry.
        let (
            deletion,
            prepared_active,
            mut db_guard,
            mut read_db_guard,
            mut seed_guard,
            mut pending_proposal_guard,
            mut pending_broadcast_guard,
        ) = {
            let mut manifest = zcash.state.manifest.lock().await;
            let prepared = if manifest.active_wallet_id.as_deref() == Some(&args.wallet_id) {
                let deletion_pos =
                    manifest
                        .validate_wallet_deletion(&args.wallet_id)
                        .map_err(|e| match e {
                            crate::wallet::manifest::DeleteWalletError::LastWallet => {
                                Error::Other("cannot delete the last wallet".into())
                            }
                            crate::wallet::manifest::DeleteWalletError::NotFound => {
                                Error::Other("wallet not found".into())
                            }
                            crate::wallet::manifest::DeleteWalletError::Persistence(e) => {
                                Error::DatabaseError(e)
                            }
                        })?;
                let entry = manifest
                    .wallets
                    .iter()
                    .enumerate()
                    .find(|(index, _)| *index != deletion_pos)
                    .map(|(_, entry)| entry)
                    .ok_or_else(|| {
                        Error::Other("wallet manifest has no replacement wallet".into())
                    })?
                    .clone();
                let db_path = zcash.state.data_dir.join(&entry.db_filename);
                let db = storage::init_wallet_db(&db_path, zcash.state.network)?;
                let read_db = storage::open_read_db(&db_path, zcash.state.network)?;
                Some((entry, db, read_db))
            } else {
                None
            };
            let db_guard = if prepared.is_some() {
                Some(zcash.state.db.lock().await)
            } else {
                None
            };
            let read_db_guard = if prepared.is_some() {
                Some(zcash.state.read_db.lock().await)
            } else {
                None
            };
            let seed_guard = if prepared.is_some() {
                Some(zcash.state.seed.lock().await)
            } else {
                None
            };
            let pending_proposal_guard = if prepared.is_some() {
                Some(zcash.state.pending_proposal.lock().await)
            } else {
                None
            };
            let pending_broadcast_guard = if prepared.is_some() {
                Some(zcash.state.pending_broadcast.lock().await)
            } else {
                None
            };
            let deletion =
                commit_wallet_deletion(&mut manifest, &zcash.state.data_dir, &args.wallet_id)?;
            (
                deletion,
                prepared,
                db_guard,
                read_db_guard,
                seed_guard,
                pending_proposal_guard,
                pending_broadcast_guard,
            )
        };

        // If we deleted the active wallet, switch to the new active
        if deletion.was_active
            && let Some((entry, db, read_db)) = prepared_active
        {
            **db_guard
                .as_mut()
                .expect("active deletion holds the write context") = Some(db);
            **read_db_guard
                .as_mut()
                .expect("active deletion holds the read context") = Some(read_db);
            // Do not prompt while finalizing a destructive transition. The next
            // explicit spend/reveal action authenticates against native custody.
            **seed_guard
                .as_mut()
                .expect("active deletion holds the seed context") = None;
            **pending_proposal_guard
                .as_mut()
                .expect("active deletion holds the proposal context") = None;
            **pending_broadcast_guard
                .as_mut()
                .expect("active deletion holds the broadcast context") =
                send::load_pending_broadcast(&zcash.state.data_dir, &entry.id);
            zcash
                .state
                .last_known_chain_tip
                .store(0, std::sync::atomic::Ordering::Relaxed);
            if let Some(recovery) = sync_recovery.as_mut() {
                recovery.commit();
            }
            drop(pending_broadcast_guard.take());
            drop(pending_proposal_guard.take());
            drop(seed_guard.take());
            drop(read_db_guard.take());
            drop(db_guard.take());

            let status =
                run_wallet_cleanup_retry(&zcash.state, crate::wallet::cleanup::RetryMode::Runtime)
                    .await;
            if status.pending_operations > 0 {
                tracing::warn!(
                    pending = status.pending_operations,
                    diagnostics = ?status.diagnostics,
                    "wallet deletion committed; cleanup remains durably scheduled"
                );
            }
            return Ok(());
        }

        // Previously the seed was deleted before the manifest check, so rejecting
        // deletion of the last wallet destroyed its recovery data. Cleanup now
        // requires a confirmed-durable manifest replacement and happens only after
        // active DB handles have been swapped. It is best-effort because returning
        // an error after commit would invite an ambiguous destructive retry.
        let status =
            run_wallet_cleanup_retry(&zcash.state, crate::wallet::cleanup::RetryMode::Runtime)
                .await;
        if status.pending_operations > 0 {
            tracing::warn!(
                pending = status.pending_operations,
                diagnostics = ?status.diagnostics,
                "wallet deletion committed; cleanup remains durably scheduled"
            );
        }

        Ok(())
    }
    .await;

    if result.is_err()
        && let Some(recovery) = sync_recovery.as_mut()
    {
        recovery.restore_now().await;
    }
    result
}

#[cfg(test)]
mod sync_recovery_tests {
    use super::*;

    fn active_obligation() -> SyncRecoveryObligation {
        SyncRecoveryObligation::new(PreviousSyncContext {
            wallet_id: Some("wallet-before-transition".into()),
            was_syncing: true,
        })
    }

    #[test]
    fn stopped_or_identityless_context_never_starts_sync() {
        let stopped = SyncRecoveryObligation::new(PreviousSyncContext {
            wallet_id: Some("wallet-before-transition".into()),
            was_syncing: false,
        });
        assert!(!stopped.should_restart(Some("wallet-before-transition"), false));

        let identityless = SyncRecoveryObligation::new(PreviousSyncContext {
            wallet_id: None,
            was_syncing: true,
        });
        assert!(!identityless.should_restart(None, false));
    }

    #[test]
    fn commit_and_shutdown_are_irreversible_no_restart_boundaries() {
        let mut committed = active_obligation();
        committed.commit();
        assert!(!committed.should_restart(Some("wallet-before-transition"), false));

        let shutting_down = active_obligation();
        assert!(!shutting_down.should_restart(Some("wallet-before-transition"), true));
    }

    struct RecoveryOnDrop {
        transition: Arc<tokio::sync::Mutex<()>>,
        completed: Option<tokio::sync::oneshot::Sender<()>>,
    }

    impl Drop for RecoveryOnDrop {
        fn drop(&mut self) {
            let transition = Arc::clone(&self.transition);
            let completed = self.completed.take().expect("drop runs once");
            spawn_recovery_after_transition(transition, async move {
                let _ = completed.send(());
            });
        }
    }

    #[tokio::test]
    async fn drop_recovery_waits_for_the_transition_lock() {
        let transition = Arc::new(tokio::sync::Mutex::new(()));
        let transition_guard = Arc::clone(&transition).lock_owned().await;
        let (completed_tx, mut completed_rx) = tokio::sync::oneshot::channel();
        drop(RecoveryOnDrop {
            transition,
            completed: Some(completed_tx),
        });

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(25), &mut completed_rx,)
                .await
                .is_err(),
            "drop recovery must not pass the live transition"
        );
        drop(transition_guard);
        tokio::time::timeout(std::time::Duration::from_secs(1), completed_rx)
            .await
            .expect("recovery runs after transition release")
            .expect("recovery completion sender remains live");
    }
}

#[cfg(test)]
mod deletion_tests {
    use super::*;
    use crate::wallet::manifest::{WalletEntry, WalletManifest};

    fn wallet(id: &str) -> WalletEntry {
        WalletEntry {
            id: id.to_string(),
            name: id.to_string(),
            db_filename: format!("wallet_{id}.sqlite"),
            birthday_height: Some(1),
            created_at: "2026-08-06T00:00:00Z".to_string(),
            backup_required: false,
        }
    }

    #[test]
    fn challenge_signing_fails_closed_until_backup_is_confirmed() {
        let mut required = wallet("new-wallet");
        required.backup_required = true;
        let mut manifest = WalletManifest {
            wallets: vec![required.clone()],
            active_wallet_id: Some(required.id.clone()),
        };

        assert!(matches!(
            ensure_challenge_signing_allowed(&manifest),
            Err(Error::BackupRequired)
        ));
        manifest.wallets[0].backup_required = false;
        assert!(ensure_challenge_signing_allowed(&manifest).is_ok());
    }

    // These tests prove authorization ordering, not custody cryptography. A
    // sentinel file makes attempted cleanup observable without invoking an OS
    // keychain or introducing a product fallback path.
    fn seed_sentinel(data_dir: &std::path::Path, wallet_id: &str) -> std::path::PathBuf {
        data_dir.join(format!("test-seed-{wallet_id}"))
    }

    fn store_seed_sentinel(data_dir: &std::path::Path, wallet_id: &str) {
        std::fs::write(seed_sentinel(data_dir, wallet_id), b"present").unwrap();
    }

    #[test]
    fn last_wallet_rejection_never_authorizes_seed_cleanup() {
        let data_dir =
            std::env::temp_dir().join(format!("zuuli-delete-command-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&data_dir).expect("create test data dir");

        let wallet = wallet(&uuid::Uuid::new_v4().to_string());
        let db_path = data_dir.join(&wallet.db_filename);
        std::fs::write(&db_path, b"wallet database").expect("write test database");
        store_seed_sentinel(&data_dir, &wallet.id);

        let mut manifest = WalletManifest {
            wallets: vec![wallet.clone()],
            active_wallet_id: Some(wallet.id.clone()),
        };
        manifest.save(&data_dir);
        let manifest_before = std::fs::read(data_dir.join("wallets.json"))
            .expect("read manifest before deletion attempt");

        let deletion = commit_wallet_deletion(&mut manifest, &data_dir, &wallet.id);
        assert!(deletion.is_err(), "last wallet deletion must be rejected");

        // Seed cleanup requires the token returned by commit_wallet_deletion;
        // the rejected operation produced no token and cannot reach that phase.
        assert_eq!(manifest.wallets.len(), 1);
        assert_eq!(manifest.active_wallet_id, Some(wallet.id.clone()));
        assert!(db_path.exists(), "wallet database must not be deleted");
        assert!(seed_sentinel(&data_dir, &wallet.id).exists());
        assert_eq!(
            std::fs::read(data_dir.join("wallets.json")).expect("read manifest after attempt"),
            manifest_before,
            "manifest file must not change"
        );

        std::fs::remove_dir_all(data_dir).expect("remove test data dir");
    }

    #[test]
    fn persistence_failure_never_authorizes_seed_cleanup_and_rolls_back() {
        let data_dir =
            std::env::temp_dir().join(format!("zuuli-delete-persistence-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&data_dir).expect("create test data dir");

        let first = wallet(&uuid::Uuid::new_v4().to_string());
        let second = wallet(&uuid::Uuid::new_v4().to_string());
        let first_db = data_dir.join(&first.db_filename);
        std::fs::write(&first_db, b"wallet database").expect("write test database");
        store_seed_sentinel(&data_dir, &first.id);

        // Force atomic manifest replacement to fail deterministically.
        std::fs::create_dir(data_dir.join("wallets.json")).expect("create manifest-path blocker");
        let mut manifest = WalletManifest {
            wallets: vec![first.clone(), second],
            active_wallet_id: Some(first.id.clone()),
        };

        let deletion = commit_wallet_deletion(&mut manifest, &data_dir, &first.id);
        assert!(
            deletion.is_err(),
            "persistence failure must reject deletion"
        );
        assert_eq!(
            manifest.wallets.len(),
            2,
            "in-memory removal must roll back"
        );
        assert_eq!(manifest.active_wallet_id, Some(first.id.clone()));
        assert!(first_db.exists(), "wallet database must not be deleted");
        assert!(seed_sentinel(&data_dir, &first.id).exists());

        std::fs::remove_dir_all(data_dir).expect("remove test data dir");
    }

    #[test]
    fn successful_commit_is_durable_before_journal_cleanup_is_authorized() {
        let data_dir =
            std::env::temp_dir().join(format!("zuuli-delete-success-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&data_dir).expect("create test data dir");

        let first = wallet(&uuid::Uuid::new_v4().to_string());
        let second = wallet(&uuid::Uuid::new_v4().to_string());
        let first_db = data_dir.join(&first.db_filename);
        let first_wal = data_dir.join(format!("{}-wal", first.db_filename));
        let first_shm = data_dir.join(format!("{}-shm", first.db_filename));
        std::fs::write(&first_db, b"wallet database").expect("write test database");
        std::fs::write(&first_wal, b"wallet WAL").expect("write test WAL");
        std::fs::write(&first_shm, b"wallet SHM").expect("write test SHM");
        store_seed_sentinel(&data_dir, &first.id);

        let mut manifest = WalletManifest {
            wallets: vec![first.clone(), second.clone()],
            active_wallet_id: Some(first.id.clone()),
        };
        manifest.save(&data_dir);

        let deletion = commit_wallet_deletion(&mut manifest, &data_dir, &first.id)
            .expect("deletion should commit");
        assert!(deletion.was_active);
        assert_eq!(manifest.active_wallet_id, Some(second.id.clone()));
        assert!(
            first_db.exists(),
            "commit must not consume database cleanup"
        );
        assert!(first_wal.exists(), "commit must not consume WAL cleanup");
        assert!(first_shm.exists(), "commit must not consume SHM cleanup");
        assert!(seed_sentinel(&data_dir, &first.id).exists());

        let persisted = WalletManifest::load(&data_dir).expect("load committed manifest");
        assert_eq!(persisted.wallets.len(), 1);
        assert_eq!(persisted.active_wallet_id, Some(second.id));
        let cleanup_journal = std::fs::read_to_string(data_dir.join("wallet-cleanup.json"))
            .expect("read cleanup journal");
        assert!(cleanup_journal.contains(&first.id));
        assert!(cleanup_journal.contains("\"transition_confirmed\": true"));
        std::fs::remove_dir_all(data_dir).expect("remove test data dir");
    }

    #[test]
    fn failed_switch_preparation_preserves_active_manifest() {
        let data_dir =
            std::env::temp_dir().join(format!("zuuli-switch-command-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&data_dir).expect("create test data dir");

        let active = wallet(&uuid::Uuid::new_v4().to_string());
        let target = wallet(&uuid::Uuid::new_v4().to_string());
        let manifest = WalletManifest {
            wallets: vec![active.clone(), target.clone()],
            active_wallet_id: Some(active.id.clone()),
        };
        manifest.save(&data_dir);

        // A directory at the SQLite path deterministically makes target
        // preparation fail before the active selection can be committed.
        std::fs::create_dir(data_dir.join(&target.db_filename))
            .expect("create invalid target database path");
        assert!(
            open_wallet_context(
                &data_dir,
                &target,
                zcash_protocol::consensus::Network::MainNetwork,
            )
            .is_err()
        );

        assert_eq!(
            manifest.active_wallet_id.as_deref(),
            Some(active.id.as_str())
        );
        let persisted = WalletManifest::load(&data_dir).expect("load active manifest");
        assert_eq!(
            persisted.active_wallet_id.as_deref(),
            Some(active.id.as_str())
        );
        std::fs::remove_dir_all(data_dir).expect("remove test data dir");
    }

    #[tokio::test]
    async fn transition_lock_keeps_wallet_identity_stable_during_custody_window() {
        let transition = Arc::new(tokio::sync::Mutex::new(()));
        let manifest = Arc::new(tokio::sync::Mutex::new(WalletManifest {
            wallets: vec![wallet("wallet-a"), wallet("wallet-b")],
            active_wallet_id: Some("wallet-a".into()),
        }));
        let custody_guard = Arc::clone(&transition).lock_owned().await;
        let (attempted_tx, attempted_rx) = tokio::sync::oneshot::channel();
        let switch_transition = Arc::clone(&transition);
        let switch_manifest = Arc::clone(&manifest);

        let switch = tokio::spawn(async move {
            attempted_tx.send(()).expect("signal attempted switch");
            let _switch_guard = switch_transition.lock_owned().await;
            switch_manifest.lock().await.active_wallet_id = Some("wallet-b".into());
        });
        attempted_rx.await.expect("switch task started");
        tokio::task::yield_now().await;

        assert_eq!(
            manifest.lock().await.active_wallet_id.as_deref(),
            Some("wallet-a"),
            "a custody operation holding the transition keeps its DB identity stable",
        );
        drop(custody_guard);
        switch.await.expect("switch completes after custody window");
        assert_eq!(
            manifest.lock().await.active_wallet_id.as_deref(),
            Some("wallet-b")
        );
    }
}

// --- Existing commands ---

#[command]
pub(crate) async fn create_account<R: Runtime>(app: AppHandle<R>) -> Result<AccountInfo> {
    let zcash = app.zcash();
    let _transition_guard = zcash.state.lock_wallet_transition().await;
    crate::wallet::accounts::create_account(&zcash.state).await
}

#[command]
pub(crate) async fn list_accounts<R: Runtime>(app: AppHandle<R>) -> Result<Vec<AccountInfo>> {
    let zcash = app.zcash();
    let _transition_guard = zcash.state.lock_wallet_transition().await;
    crate::wallet::accounts::list_accounts(&zcash.state).await
}

#[command]
pub(crate) async fn get_account_balance<R: Runtime>(
    app: AppHandle<R>,
    args: AccountIdArgs,
) -> Result<AccountBalance> {
    let zcash = app.zcash();
    let _transition_guard = zcash.state.lock_wallet_transition().await;

    if !zcash.state.is_initialized().await {
        return Ok(AccountBalance {
            account_index: args.account_index,
            total_shielded: 0,
            spendable: 0,
            change_pending: 0,
            value_pending: 0,
        });
    }

    let db_guard = zcash.state.read_db.lock().await;
    let db = db_guard.as_ref().ok_or(Error::WalletNotInitialized)?;

    let policy = ConfirmationsPolicy::default();

    let summary = db
        .get_wallet_summary(policy)
        .map_err(|e| Error::DatabaseError(format!("failed to get wallet summary: {e}")))?;

    if let Some(summary) = summary {
        let account_ids = db
            .get_account_ids()
            .map_err(|e| Error::DatabaseError(format!("failed to get account ids: {e}")))?;

        if let Some(account_id) = account_ids.get(args.account_index as usize)
            && let Some(balance) = summary.account_balances().get(account_id)
        {
            let sapling = balance.sapling_balance();
            let orchard = balance.orchard_balance();
            // Ironwood is the third shielded pool introduced by NU6.3; after
            // activation Orchard is spend-only and new shielded value accrues
            // to Ironwood, so it must be included in every shielded total.
            let ironwood = balance.ironwood_balance();

            let total = u64::from(sapling.total())
                + u64::from(orchard.total())
                + u64::from(ironwood.total());
            let spendable = u64::from(sapling.spendable_value())
                + u64::from(orchard.spendable_value())
                + u64::from(ironwood.spendable_value());
            let change_pending = u64::from(sapling.change_pending_confirmation())
                + u64::from(orchard.change_pending_confirmation())
                + u64::from(ironwood.change_pending_confirmation());
            let value_pending = u64::from(sapling.value_pending_spendability())
                + u64::from(orchard.value_pending_spendability())
                + u64::from(ironwood.value_pending_spendability());

            return Ok(AccountBalance {
                account_index: args.account_index,
                total_shielded: total,
                spendable,
                change_pending,
                value_pending,
            });
        }
    }

    Ok(AccountBalance {
        account_index: args.account_index,
        total_shielded: 0,
        spendable: 0,
        change_pending: 0,
        value_pending: 0,
    })
}

#[command]
pub(crate) async fn get_unified_address<R: Runtime>(
    app: AppHandle<R>,
    args: AccountIdArgs,
) -> Result<String> {
    let zcash = app.zcash();
    let _transition_guard = zcash.state.lock_wallet_transition().await;

    if !zcash.state.is_initialized().await {
        return Err(Error::WalletNotInitialized);
    }

    let db_guard = zcash.state.read_db.lock().await;
    let db = db_guard.as_ref().ok_or(Error::WalletNotInitialized)?;

    let account_ids = db
        .get_account_ids()
        .map_err(|e| Error::DatabaseError(format!("failed to get account ids: {e}")))?;

    let account_id = account_ids
        .get(args.account_index as usize)
        .copied()
        .ok_or(Error::AddressError("account not found".into()))?;

    let ua_request = UnifiedAddressRequest::AllAvailableKeys;
    let addr = db
        .get_last_generated_address_matching(account_id, ua_request)
        .map_err(|e| Error::AddressError(format!("failed to get address: {e}")))?
        .ok_or(Error::AddressError("no address available".into()))?;

    let encoded = addr.encode(&zcash.state.network);
    Ok(encoded)
}

#[command]
pub(crate) async fn start_sync<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    let zcash = app.zcash();
    let _transition_guard = zcash.state.lock_wallet_transition().await;
    crate::wallet::sync::start_sync(app.clone(), &zcash.state).await
}

#[command]
pub(crate) async fn stop_sync<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    let zcash = app.zcash();
    let _transition_guard = zcash.state.lock_wallet_transition().await;
    crate::wallet::sync::stop_sync(&zcash.state).await
}

#[command]
pub(crate) async fn get_sync_status<R: Runtime>(app: AppHandle<R>) -> Result<SyncStatus> {
    let zcash = app.zcash();
    crate::wallet::sync::get_sync_status(&zcash.state).await
}

#[command]
pub(crate) async fn ensure_sapling_params<R: Runtime>(
    app: AppHandle<R>,
) -> Result<SaplingParamsStatus> {
    let zcash = app.zcash();
    crate::wallet::send::ensure_sapling_params(&zcash.state).await
}

#[command]
pub(crate) async fn propose_send<R: Runtime>(
    app: AppHandle<R>,
    args: ProposeSendArgs,
) -> Result<SendProposal> {
    let zcash = app.zcash();
    let _transition_guard = zcash.state.lock_wallet_transition().await;
    crate::wallet::send::propose_send(&zcash.state, &args.to, args.amount, args.memo.as_deref())
        .await
}

#[command]
pub(crate) async fn propose_send_all<R: Runtime>(
    app: AppHandle<R>,
    args: ProposeSendAllArgs,
) -> Result<SendProposal> {
    let zcash = app.zcash();
    let _transition_guard = zcash.state.lock_wallet_transition().await;
    crate::wallet::send::propose_send_all(&zcash.state, &args.to, args.memo.as_deref()).await
}

#[command]
pub(crate) async fn execute_send<R: Runtime>(
    app: AppHandle<R>,
    args: ExecuteSendArgs,
) -> Result<ExecuteSendResult> {
    let zcash = app.zcash();
    let transition_guard = zcash.state.lock_wallet_transition().await;
    ensure_active_seed_loaded(&zcash.state, &transition_guard).await?;
    crate::wallet::send::execute_send(&zcash.state, args.proposal_id).await
}

#[command]
pub(crate) async fn get_pending_send<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<PendingSendStatus>> {
    let zcash = app.zcash();
    let _transition_guard = zcash.state.lock_wallet_transition().await;
    crate::wallet::send::get_pending_send(&zcash.state).await
}

#[command]
pub(crate) async fn retry_pending_send<R: Runtime>(app: AppHandle<R>) -> Result<ExecuteSendResult> {
    let zcash = app.zcash();
    let _transition_guard = zcash.state.lock_wallet_transition().await;
    crate::wallet::send::retry_pending_send(&zcash.state).await
}

#[command]
pub(crate) async fn discard_unrecoverable_send<R: Runtime>(
    app: AppHandle<R>,
    args: DiscardUnrecoverableSendArgs,
) -> Result<()> {
    let zcash = app.zcash();
    let _transition_guard = zcash.state.lock_wallet_transition().await;
    crate::wallet::send::discard_unrecoverable_send(
        &zcash.state,
        args.proposal_id,
        &args.confirmation,
    )
    .await
}

#[command]
pub(crate) async fn get_transaction_history<R: Runtime>(
    app: AppHandle<R>,
    args: TransactionHistoryArgs,
) -> Result<Vec<TransactionEntry>> {
    let zcash = app.zcash();
    let _transition_guard = zcash.state.lock_wallet_transition().await;
    crate::wallet::history::get_transaction_history(
        &zcash.state,
        args.account_index,
        args.offset.unwrap_or(0),
        args.limit.unwrap_or(50),
    )
    .await
}

#[command]
pub(crate) async fn set_lightwalletd_url<R: Runtime>(
    app: AppHandle<R>,
    args: SetLightwalletdUrlArgs,
) -> Result<()> {
    let zcash = app.zcash();
    *zcash.state.lightwalletd_url.write().await = args.url;
    Ok(())
}

#[command]
pub(crate) async fn validate_address<R: Runtime>(
    app: AppHandle<R>,
    args: ValidateAddressArgs,
) -> Result<AddressValidation> {
    let zcash = app.zcash();
    Ok(crate::wallet::send::validate_recipient_address(
        &zcash.state.network,
        &args.address,
    ))
}

#[command]
pub(crate) async fn parse_payment_uri<R: Runtime>(
    _app: AppHandle<R>,
    args: ParsePaymentUriArgs,
) -> Result<PaymentRequest> {
    let request = zip321::TransactionRequest::from_uri(&args.uri)
        .map_err(|e| Error::Other(format!("invalid payment URI: {e:?}")))?;

    let payments = request.payments();
    if payments.is_empty() {
        return Err(Error::Other("payment URI contains no payments".into()));
    }

    let (_, payment) = payments.iter().next().unwrap();
    let address = payment.recipient_address().encode();
    let amount = payment.amount().map(u64::from);
    let memo = payment.memo().map(|m| format!("{:?}", m));
    let label = payment.label().map(|s| s.to_string());

    Ok(PaymentRequest {
        address,
        amount,
        memo,
        label,
    })
}

/// Sign a "Login with Zcash" challenge for a given account.
///
/// Produces a real, server-verifiable Zcash transparent-address message
/// signature ("ZUULI Zcash Login v1") — exactly what `zcashd signmessage`
/// emits, so the backend verifies it with `zcashd verifymessage(address,
/// signature, challenge)`. Returns the derived transparent P2PKH `address`, the
/// original `challenge`, the base64 `signature`, and the hex compressed
/// `pubkey`. See [`keys::sign_challenge`] for the exact scheme.
#[command]
pub(crate) async fn sign_challenge<R: Runtime>(
    app: AppHandle<R>,
    args: SignChallengeArgs,
) -> Result<SignedChallenge> {
    let zcash = app.zcash();
    let transition_guard = zcash.state.lock_wallet_transition().await;

    if !zcash.state.is_initialized().await {
        return Err(Error::WalletNotInitialized);
    }

    // Fail closed before loading seed custody or producing any signature. The
    // exact active wallet remains stable under the transition lock.
    {
        let manifest = zcash.state.manifest.lock().await;
        ensure_challenge_signing_allowed(&manifest)?;
    }

    ensure_active_seed_loaded(&zcash.state, &transition_guard).await?;

    // Sign the challenge with the account's transparent P2PKH key. The returned
    // address is the mainnet t-address the backend passes to `verifymessage`.
    let seed_guard = zcash.state.seed.lock().await;
    let seed = seed_guard.as_ref().ok_or(Error::KeyError(
        "seed not available — re-enter your recovery phrase in Settings".into(),
    ))?;

    let signed = keys::sign_challenge(seed.expose_secret(), args.account_index, &args.challenge)?;
    drop(seed_guard);

    Ok(SignedChallenge {
        address: signed.address,
        challenge: args.challenge,
        signature: signed.signature,
        pubkey: signed.pubkey,
    })
}
