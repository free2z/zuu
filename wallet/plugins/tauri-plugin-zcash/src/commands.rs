use std::sync::Arc;

use tauri::{command, AppHandle, Runtime};

use secrecy::ExposeSecret;
use zcash_client_backend::data_api::{Account, AccountBirthday, BirthdayError, WalletRead, WalletWrite};
use zcash_client_backend::data_api::wallet::ConfirmationsPolicy;
use zcash_client_backend::proto::service::BlockId;
use zcash_keys::keys::UnifiedAddressRequest;

use crate::error::Error;
use crate::models::*;
use crate::wallet::client::connect_to_lightwalletd;
use crate::wallet::{keychain, keys, storage};
use crate::{Result, ZcashExt};

fn format_birthday_error(e: BirthdayError) -> String {
    match e {
        BirthdayError::HeightInvalid(e) => format!("invalid height: {e}"),
        BirthdayError::Decode(e) => format!("decode error: {e}"),
    }
}

#[command]
pub(crate) async fn create_wallet<R: Runtime>(
    app: AppHandle<R>,
    args: CreateWalletArgs,
) -> Result<WalletCreated> {
    let zcash = app.zcash();
    let word_count = args.mnemonic_word_count.unwrap_or(24);
    let wallet_name = args.name.unwrap_or_else(|| "Default".to_string());

    // Stop any running sync (fire-and-forget)
    *zcash.state.syncing.write().await = false;
    if let Some(h) = zcash.state.sync_handle.lock().await.take() {
        h.abort();
    }

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

    // Create new wallet entry in manifest
    let wallet_entry = {
        let mut manifest = zcash.state.manifest.lock().await;
        manifest.add_wallet(&zcash.state.data_dir, wallet_name, Some(tip_height))
    };

    // Initialize database at new path — local variable, no mutex needed yet
    let db_path = zcash.state.data_dir.join(&wallet_entry.db_filename);
    let mut db = storage::init_wallet_db(&db_path, zcash.state.network)?;

    // Create account on the local db (no mutex contention)
    let (_account_id, _usk) = db
        .create_account(&wallet_entry.name, &seed, &birthday, None)
        .map_err(|e| Error::DatabaseError(format!("failed to create account: {e}")))?;

    // Swap read_db immediately (instant — UI reads from this)
    let read_db = storage::open_read_db(&db_path, zcash.state.network)?;
    *zcash.state.read_db.lock().await = Some(read_db);

    // Store seed in keychain + encrypted file (hard error if both fail)
    let data_dir = zcash.state.data_dir.clone();
    let wid = wallet_entry.id.clone();
    let phrase = mnemonic.phrase().to_string();
    tokio::task::spawn_blocking(move || {
        keychain::store_seed_phrase(&data_dir, &wid, &phrase)
    })
    .await
    .map_err(|e| Error::KeyError(format!("keychain task panicked: {e}")))??;

    // Store seed in memory for the session
    *zcash.state.seed.lock().await = Some(seed);

    // Swap write db in background (waits for old sync to release lock)
    let db_arc = Arc::clone(&zcash.state.db);
    let app2 = app.clone();
    tokio::spawn(async move {
        *db_arc.lock().await = Some(db);
        tracing::info!("write db ready for new wallet");
        // Auto-start sync once write db is available
        let zcash2 = app2.zcash();
        let _ = crate::wallet::sync::start_sync(app2.clone(), &zcash2.state).await;
    });

    Ok(WalletCreated {
        seed_phrase: mnemonic.phrase().to_string(),
        birthday_height: tip_height,
    })
}

#[command]
pub(crate) async fn restore_wallet<R: Runtime>(
    app: AppHandle<R>,
    args: RestoreWalletArgs,
) -> Result<serde_json::Value> {
    let zcash = app.zcash();
    let mnemonic = keys::parse_mnemonic(&args.seed_phrase)?;
    let seed = keys::mnemonic_to_seed(&mnemonic);
    let birthday_height = args.birthday_height.unwrap_or(419200); // sapling activation
    let wallet_name = args.name.unwrap_or_else(|| "Restored".to_string());

    // Stop any running sync (fire-and-forget)
    *zcash.state.syncing.write().await = false;
    if let Some(h) = zcash.state.sync_handle.lock().await.take() {
        h.abort();
    }

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

    // Create new wallet entry in manifest
    let wallet_entry = {
        let mut manifest = zcash.state.manifest.lock().await;
        manifest.add_wallet(&zcash.state.data_dir, wallet_name, Some(birthday_height))
    };

    // Initialize database — local variable, no mutex needed yet
    let db_path = zcash.state.data_dir.join(&wallet_entry.db_filename);
    let mut db = storage::init_wallet_db(&db_path, zcash.state.network)?;

    // Create account on the local db (no mutex contention)
    let (_account_id, _usk) = db
        .create_account(&wallet_entry.name, &seed, &birthday, None)
        .map_err(|e| Error::DatabaseError(format!("failed to create account: {e}")))?;

    // Swap read_db immediately (instant — UI reads from this)
    let read_db = storage::open_read_db(&db_path, zcash.state.network)?;
    *zcash.state.read_db.lock().await = Some(read_db);

    // Store seed in keychain + encrypted file (hard error if both fail)
    let data_dir = zcash.state.data_dir.clone();
    let wid = wallet_entry.id.clone();
    let phrase_str = mnemonic.phrase().to_string();
    tokio::task::spawn_blocking(move || {
        keychain::store_seed_phrase(&data_dir, &wid, &phrase_str)
    })
    .await
    .map_err(|e| Error::KeyError(format!("keychain task panicked: {e}")))??;

    // Store seed in memory
    *zcash.state.seed.lock().await = Some(seed);

    // Swap write db in background (waits for old sync to release lock)
    let db_arc = Arc::clone(&zcash.state.db);
    let app2 = app.clone();
    tokio::spawn(async move {
        *db_arc.lock().await = Some(db);
        tracing::info!("write db ready for restored wallet");
        // Auto-start sync once write db is available
        let zcash2 = app2.zcash();
        let _ = crate::wallet::sync::start_sync(app2.clone(), &zcash2.state).await;
    });

    Ok(serde_json::json!({ "success": true }))
}

#[command]
pub(crate) async fn get_wallet_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<WalletStatus> {
    let zcash = app.zcash();
    let initialized = zcash.state.is_initialized().await;
    let has_seed = zcash.state.seed.lock().await.is_some();

    let manifest = zcash.state.manifest.lock().await;
    let active_wallet_id = manifest.active_wallet_id.clone();
    let active_wallet_name = manifest.get_active().map(|w| w.name.clone());
    let wallet_count = manifest.wallets.len() as u32;
    drop(manifest);

    let (synced_height, chain_tip) = if initialized {
        let db_guard = zcash.state.read_db.lock().await;
        if let Some(db) = db_guard.as_ref() {
            let height = db.chain_height().ok().flatten().map(|h| u64::from(u32::from(h)));
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
    })
}

#[command]
pub(crate) async fn get_seed_phrase<R: Runtime>(
    app: AppHandle<R>,
) -> Result<String> {
    let zcash = app.zcash();
    let wallet_id = zcash.state.active_wallet_id().await
        .ok_or(Error::WalletNotInitialized)?;
    let data_dir = zcash.state.data_dir.clone();
    tokio::task::spawn_blocking(move || {
        keychain::get_seed_phrase(&data_dir, &wallet_id)
    })
    .await
    .map_err(|e| Error::KeyError(format!("keychain task panicked: {e}")))?
}

#[command]
pub(crate) async fn unlock_wallet<R: Runtime>(
    app: AppHandle<R>,
    args: UnlockWalletArgs,
) -> Result<()> {
    let zcash = app.zcash();

    // Parse and validate the mnemonic
    let mnemonic = keys::parse_mnemonic(&args.seed_phrase)?;
    let seed = keys::mnemonic_to_seed(&mnemonic);

    // Determine which wallet to unlock (active or specified)
    let wallet_id = match args.wallet_id {
        Some(id) => id,
        None => zcash.state.active_wallet_id().await
            .ok_or(Error::WalletNotInitialized)?,
    };

    // Verify the seed matches the wallet's UFVK:
    // 1. Derive USK from the provided seed
    // 2. Get UFVK from the USK
    // 3. Compare with the UFVK stored in the wallet DB
    let usk = keys::derive_usk(seed.expose_secret(), &zcash.state.network, 0)?;
    let derived_ufvk = usk.to_unified_full_viewing_key();

    let db_guard = zcash.state.read_db.lock().await;
    let db = db_guard.as_ref().ok_or(Error::WalletNotInitialized)?;
    let account_ids = db.get_account_ids()
        .map_err(|e| Error::DatabaseError(format!("{e}")))?;
    let account_id = account_ids.first().copied()
        .ok_or(Error::AddressError("no accounts in wallet".into()))?;
    let account = db.get_account(account_id)
        .map_err(|e| Error::DatabaseError(format!("{e}")))?
        .ok_or(Error::AddressError("account not found".into()))?;
    let stored_ufvk = account.ufvk()
        .ok_or(Error::KeyError("wallet has no viewing key".into()))?;
    drop(db_guard);

    // Compare encoded UFVKs
    let derived_encoded = derived_ufvk.encode(&zcash.state.network);
    let stored_encoded = stored_ufvk.encode(&zcash.state.network);
    if derived_encoded != stored_encoded {
        let derived_prefix = &derived_encoded[..derived_encoded.len().min(20)];
        let stored_prefix = &stored_encoded[..stored_encoded.len().min(20)];
        return Err(Error::KeyError(
            format!(
                "seed phrase does not match this wallet. \
                 Derived UFVK starts with: {derived_prefix}... \
                 Stored UFVK starts with: {stored_prefix}..."
            ),
        ));
    }

    // Store in new secure system (encrypted file + keychain)
    let data_dir = zcash.state.data_dir.clone();
    let wid = wallet_id.clone();
    let phrase = args.seed_phrase.clone();
    tokio::task::spawn_blocking(move || {
        keychain::store_seed_phrase(&data_dir, &wid, &phrase)
    })
    .await
    .map_err(|e| Error::KeyError(format!("storage task panicked: {e}")))??;

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

    let ufvk = account.ufvk()
        .ok_or(Error::KeyError("no unified full viewing key".into()))?;

    Ok(ufvk.encode(&zcash.state.network))
}

#[command]
pub(crate) async fn get_spending_key<R: Runtime>(
    app: AppHandle<R>,
    args: AccountIdArgs,
) -> Result<SpendingKeyStatus> {
    let zcash = app.zcash();

    // If seed is not in memory, try to reload from keychain
    {
        let seed_guard = zcash.state.seed.lock().await;
        if seed_guard.is_none() {
            drop(seed_guard);
            let wallet_id = zcash.state.active_wallet_id().await
                .ok_or(Error::WalletNotInitialized)?;
            let data_dir = zcash.state.data_dir.clone();
            let wid = wallet_id.clone();
            if let Ok(phrase) = tokio::task::spawn_blocking(move || {
                keychain::get_seed_phrase(&data_dir, &wid)
            }).await.map_err(|e| Error::KeyError(format!("keychain task panicked: {e}")))? {
                if let Ok(mnemonic) = keys::parse_mnemonic(&phrase) {
                    *zcash.state.seed.lock().await = Some(keys::mnemonic_to_seed(&mnemonic));
                }
            }
        }
    }

    // Now try to use the seed
    let seed_guard = zcash.state.seed.lock().await;
    let seed = seed_guard.as_ref()
        .ok_or(Error::KeyError("seed not available — re-enter your recovery phrase in Settings".into()))?;

    // Verify we can derive a spending key (proves spending authority)
    let _usk = keys::derive_usk(seed.expose_secret(), &zcash.state.network, args.account_index)?;

    // Return status — we intentionally don't expose raw spending key bytes.
    // The seed phrase IS the spending authority. Anyone with the seed can spend.
    Ok(SpendingKeyStatus {
        account_index: args.account_index,
        available: true,
        message: "Spending authority verified. Your seed phrase grants full spending access.".into(),
    })
}

// --- Multi-wallet commands ---

#[command]
pub(crate) async fn list_wallets<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<WalletInfo>> {
    let zcash = app.zcash();
    let manifest = zcash.state.manifest.lock().await;
    let active_id = manifest.active_wallet_id.clone();

    Ok(manifest.wallets.iter().map(|w| WalletInfo {
        id: w.id.clone(),
        name: w.name.clone(),
        is_active: active_id.as_deref() == Some(&w.id),
        birthday_height: w.birthday_height,
        created_at: w.created_at.clone(),
    }).collect())
}

#[command]
pub(crate) async fn switch_wallet<R: Runtime>(
    app: AppHandle<R>,
    args: SwitchWalletArgs,
) -> Result<()> {
    let zcash = app.zcash();

    // Signal sync to stop (non-blocking — don't wait for the batch to finish)
    *zcash.state.syncing.write().await = false;
    {
        let handle = zcash.state.sync_handle.lock().await.take();
        if let Some(h) = handle {
            h.abort();
            // Don't await — the sync batch may take seconds to hit a yield point.
            // The write db swap below runs in the background and will wait.
        }
    }

    // Clear any pending proposal from the previous wallet
    *zcash.state.pending_proposal.lock().await = None;

    // Update manifest
    let wallet_entry = {
        let mut manifest = zcash.state.manifest.lock().await;
        if !manifest.set_active(&zcash.state.data_dir, &args.wallet_id) {
            return Err(Error::Other("wallet not found".into()));
        }
        manifest.get_active().unwrap().clone()
    };

    // Open new connections
    let db_path = zcash.state.data_dir.join(&wallet_entry.db_filename);
    let new_db = storage::init_wallet_db(&db_path, zcash.state.network)?;
    let new_read_db = storage::open_read_db(&db_path, zcash.state.network)?;

    // Swap read_db immediately (instant — all UI reads use this)
    *zcash.state.read_db.lock().await = Some(new_read_db);

    // Reset chain tip cache
    zcash.state.last_known_chain_tip.store(0, std::sync::atomic::Ordering::Relaxed);

    // Load seed from keychain
    let data_dir = zcash.state.data_dir.clone();
    let wid = wallet_entry.id.clone();
    let seed = match tokio::task::spawn_blocking(move || {
        keychain::get_seed_phrase(&data_dir, &wid)
    }).await {
        Ok(Ok(phrase)) => {
            keys::parse_mnemonic(&phrase).ok().map(|m| keys::mnemonic_to_seed(&m))
        }
        _ => None,
    };
    *zcash.state.seed.lock().await = seed;

    // Swap write db in background — waits for aborted sync to release the lock
    let db_arc = Arc::clone(&zcash.state.db);
    tokio::spawn(async move {
        *db_arc.lock().await = Some(new_db);
        tracing::info!("write db swapped for switched wallet");
    });

    Ok(())
}

#[command]
pub(crate) async fn rename_wallet<R: Runtime>(
    app: AppHandle<R>,
    args: RenameWalletArgs,
) -> Result<()> {
    let zcash = app.zcash();
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
    let was_active = {
        let manifest = zcash.state.manifest.lock().await;
        manifest.active_wallet_id.as_deref() == Some(&args.wallet_id)
    };

    // Delete from keychain + encrypted file
    let data_dir = zcash.state.data_dir.clone();
    let wid = args.wallet_id.clone();
    let _ = tokio::task::spawn_blocking(move || {
        keychain::delete_seed_phrase(&data_dir, &wid)
    }).await;

    // Delete from manifest (also deletes DB file)
    let deleted = {
        let mut manifest = zcash.state.manifest.lock().await;
        manifest.delete_wallet(&zcash.state.data_dir, &args.wallet_id)
    };

    if deleted.is_none() {
        return Err(Error::Other("cannot delete the last wallet".into()));
    }

    // If we deleted the active wallet, switch to the new active
    if was_active {
        let new_active = {
            let manifest = zcash.state.manifest.lock().await;
            manifest.get_active().cloned()
        };

        if let Some(entry) = new_active {
            let db_path = zcash.state.data_dir.join(&entry.db_filename);
            let db = storage::init_wallet_db(&db_path, zcash.state.network)?;
            let read_db = storage::open_read_db(&db_path, zcash.state.network)?;
            *zcash.state.db.lock().await = Some(db);
            *zcash.state.read_db.lock().await = Some(read_db);

            let data_dir = zcash.state.data_dir.clone();
            let wid = entry.id.clone();
            let seed = match tokio::task::spawn_blocking(move || {
                keychain::get_seed_phrase(&data_dir, &wid)
            }).await {
                Ok(Ok(phrase)) => keys::parse_mnemonic(&phrase).ok().map(|m| keys::mnemonic_to_seed(&m)),
                _ => None,
            };
            *zcash.state.seed.lock().await = seed;
        }
    }

    Ok(())
}

// --- Existing commands ---

#[command]
pub(crate) async fn create_account<R: Runtime>(
    app: AppHandle<R>,
) -> Result<AccountInfo> {
    let zcash = app.zcash();
    crate::wallet::accounts::create_account(&zcash.state).await
}

#[command]
pub(crate) async fn list_accounts<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<AccountInfo>> {
    let zcash = app.zcash();
    crate::wallet::accounts::list_accounts(&zcash.state).await
}

#[command]
pub(crate) async fn get_account_balance<R: Runtime>(
    app: AppHandle<R>,
    args: AccountIdArgs,
) -> Result<AccountBalance> {
    let zcash = app.zcash();

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

        if let Some(account_id) = account_ids.get(args.account_index as usize) {
            if let Some(balance) = summary.account_balances().get(account_id) {
                let sapling = balance.sapling_balance();
                let orchard = balance.orchard_balance();

                let total = u64::from(sapling.total()) + u64::from(orchard.total());
                let spendable = u64::from(sapling.spendable_value()) + u64::from(orchard.spendable_value());
                let change_pending = u64::from(sapling.change_pending_confirmation()) + u64::from(orchard.change_pending_confirmation());
                let value_pending = u64::from(sapling.value_pending_spendability()) + u64::from(orchard.value_pending_spendability());

                return Ok(AccountBalance {
                    account_index: args.account_index,
                    total_shielded: total,
                    spendable,
                    change_pending,
                    value_pending,
                });
            }
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
pub(crate) async fn start_sync<R: Runtime>(
    app: AppHandle<R>,
) -> Result<()> {
    let zcash = app.zcash();
    crate::wallet::sync::start_sync(app.clone(), &zcash.state).await
}

#[command]
pub(crate) async fn stop_sync<R: Runtime>(
    app: AppHandle<R>,
) -> Result<()> {
    let zcash = app.zcash();
    crate::wallet::sync::stop_sync(&zcash.state).await
}

#[command]
pub(crate) async fn get_sync_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<SyncStatus> {
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
    crate::wallet::send::propose_send(
        &zcash.state,
        &args.to,
        args.amount,
        args.memo.as_deref(),
    )
    .await
}

#[command]
pub(crate) async fn propose_send_all<R: Runtime>(
    app: AppHandle<R>,
    args: ProposeSendAllArgs,
) -> Result<SendProposal> {
    let zcash = app.zcash();
    crate::wallet::send::propose_send_all(
        &zcash.state,
        &args.to,
        args.memo.as_deref(),
    )
    .await
}

#[command]
pub(crate) async fn execute_send<R: Runtime>(
    app: AppHandle<R>,
    args: ExecuteSendArgs,
) -> Result<String> {
    let zcash = app.zcash();
    crate::wallet::send::execute_send(&zcash.state, args.proposal_id).await
}

#[command]
pub(crate) async fn get_transaction_history<R: Runtime>(
    app: AppHandle<R>,
    args: TransactionHistoryArgs,
) -> Result<Vec<TransactionEntry>> {
    let zcash = app.zcash();
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
    _app: AppHandle<R>,
    args: ValidateAddressArgs,
) -> Result<AddressValidation> {
    match zcash_address::ZcashAddress::try_from_encoded(&args.address) {
        Ok(_) => {
            let addr = &args.address;
            let (address_type, can_receive_memo) = if addr.starts_with("u1") {
                ("unified", true)
            } else if addr.starts_with("zs") {
                ("sapling", true)
            } else if addr.starts_with("t1") || addr.starts_with("t3") {
                ("transparent", false)
            } else if addr.starts_with("tex") {
                ("tex", false)
            } else {
                ("unknown", false)
            };
            Ok(AddressValidation {
                valid: true,
                address_type: Some(address_type.to_string()),
                can_receive_memo,
            })
        }
        Err(_) => Ok(AddressValidation {
            valid: false,
            address_type: None,
            can_receive_memo: false,
        }),
    }
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
    let amount = payment.amount().map(|a| u64::from(a));
    let memo = payment.memo().map(|m| format!("{:?}", m));
    let label = payment.label().map(|s| s.to_string());

    Ok(PaymentRequest {
        address,
        amount,
        memo,
        label,
    })
}
