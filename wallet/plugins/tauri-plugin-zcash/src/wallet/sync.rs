use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::{Mutex, RwLock};
use tonic::transport::Channel;

use zcash_client_backend::data_api::{TransactionDataRequest, TransactionStatus, WalletRead, WalletWrite};
use zcash_client_backend::data_api::wallet::decrypt_and_store_transaction;
use zcash_client_backend::proto::service::compact_tx_streamer_client::CompactTxStreamerClient;
use zcash_client_backend::proto::service::TxFilter;
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::{BranchId, BlockHeight, Network};

use crate::error::{Error, Result};
use crate::models::SyncStatus;
use crate::wallet::cache::MemBlockCache;
use crate::wallet::client::connect_to_lightwalletd;
use crate::wallet::WalletDatabase;
use crate::wallet::WalletState;

/// Interval between sync re-checks after catching up (30 seconds).
const SYNC_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

/// Start the background sync task.
pub async fn start_sync<R: Runtime>(
    app: AppHandle<R>,
    state: &WalletState,
) -> Result<()> {
    if !state.is_initialized().await {
        return Err(Error::WalletNotInitialized);
    }

    let mut syncing = state.syncing.write().await;
    if *syncing {
        return Ok(()); // Already syncing
    }
    *syncing = true;
    drop(syncing);

    let lightwalletd_url = state.lightwalletd_url.read().await.clone();
    let syncing_flag = Arc::clone(&state.syncing);
    let db = Arc::clone(&state.db);
    let read_db = Arc::clone(&state.read_db);
    let network = state.network;
    let last_known_chain_tip = Arc::clone(&state.last_known_chain_tip);

    let handle = tokio::spawn(sync_task(
        app,
        lightwalletd_url,
        syncing_flag,
        db,
        read_db,
        network,
        last_known_chain_tip,
    ));

    *state.sync_handle.lock().await = Some(handle);
    Ok(())
}

/// Read the max scanned block height from the read-only DB.
/// Uses `block_max_scanned()` which queries `MAX(height) FROM blocks` —
/// the actual highest scanned block, NOT the chain tip.
async fn read_scanned_height(read_db: &Mutex<Option<WalletDatabase>>) -> u64 {
    let db_guard = read_db.lock().await;
    if let Some(db) = db_guard.as_ref() {
        db.block_max_scanned()
            .ok()
            .flatten()
            .map(|meta| u64::from(u32::from(meta.block_height())))
            .unwrap_or(0)
    } else {
        0
    }
}

/// Read the birthday height from the read-only DB.
async fn read_birthday_height(read_db: &Mutex<Option<WalletDatabase>>) -> u64 {
    let db_guard = read_db.lock().await;
    if let Some(db) = db_guard.as_ref() {
        db.get_wallet_birthday()
            .ok()
            .flatten()
            .map(|h| u64::from(u32::from(h)))
            .unwrap_or(419200)
    } else {
        419200
    }
}

/// Calculate sync progress percentage.
fn calc_progress(synced_height: u64, chain_tip: u64, birthday_height: u64) -> f32 {
    if chain_tip > 0 && birthday_height < chain_tip {
        let total_range = chain_tip.saturating_sub(birthday_height);
        let synced_range = synced_height.saturating_sub(birthday_height);
        ((synced_range as f32 / total_range as f32) * 100.0).min(100.0)
    } else if chain_tip > 0 {
        100.0
    } else {
        0.0
    }
}

async fn sync_task<R: Runtime>(
    app: AppHandle<R>,
    lightwalletd_url: String,
    syncing: Arc<RwLock<bool>>,
    db: Arc<Mutex<Option<WalletDatabase>>>,
    read_db: Arc<Mutex<Option<WalletDatabase>>>,
    network: Network,
    last_known_chain_tip: Arc<AtomicU64>,
) {
    tracing::info!("sync started with endpoint: {}", lightwalletd_url);

    // Connect to lightwalletd
    let mut client = match connect_to_lightwalletd(&lightwalletd_url).await {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("failed to connect to lightwalletd: {e}");
            *syncing.write().await = false;
            let _ = app.emit("zcash://sync-progress", &SyncStatus {
                syncing: false,
                synced_height: 0,
                chain_tip: 0,
                progress_percent: 0.0,
            });
            return;
        }
    };

    let birthday_height = read_birthday_height(&read_db).await;
    let block_cache = MemBlockCache::default();

    // Outer loop: sync to tip, sleep, re-check for new blocks, repeat.
    // Only exits on cancellation or fatal error.
    loop {
        // Check cancellation
        if !*syncing.read().await {
            tracing::info!("sync cancelled");
            break;
        }

        // Get current chain tip
        let chain_tip = match client
            .get_latest_block(zcash_client_backend::proto::service::ChainSpec::default())
            .await
        {
            Ok(resp) => resp.into_inner().height as u64,
            Err(e) => {
                tracing::error!("failed to get chain tip: {e}");
                // On transient network error, sleep and retry instead of dying
                tokio::select! {
                    _ = tokio::time::sleep(SYNC_POLL_INTERVAL) => continue,
                    _ = wait_for_cancel(&syncing) => break,
                }
            }
        };

        // Cache the chain tip
        last_known_chain_tip.store(chain_tip, Ordering::Relaxed);

        // Inner loop: process sync batches until caught up
        loop {
            // Check cancellation
            if !*syncing.read().await {
                tracing::info!("sync cancelled");
                // Signal final status and exit
                let synced_height = read_scanned_height(&read_db).await;
                let progress = calc_progress(synced_height, chain_tip, birthday_height);
                *syncing.write().await = false;
                let _ = app.emit("zcash://sync-progress", &SyncStatus {
                    syncing: false,
                    synced_height,
                    chain_tip,
                    progress_percent: progress,
                });
                return;
            }

            // Run one sync batch
            let result = {
                let mut db_guard = db.lock().await;
                if let Some(db) = db_guard.as_mut() {
                    zcash_client_backend::sync::run(
                        &mut client,
                        &network,
                        &block_cache,
                        db,
                        10_000,
                    )
                    .await
                } else {
                    tracing::error!("database not available during sync");
                    *syncing.write().await = false;
                    return;
                }
            };

            match result {
                Ok(()) => {
                    // Check progress using block_max_scanned (actual scanned height)
                    let synced_height = read_scanned_height(&read_db).await;

                    // Keep chain tip fresh: if we've scanned past the cached tip,
                    // those blocks are real — update the cached value so the
                    // frontend never sees synced > tip.
                    let effective_tip = chain_tip.max(synced_height);
                    last_known_chain_tip.store(effective_tip, Ordering::Relaxed);

                    let progress = calc_progress(synced_height, effective_tip, birthday_height);

                    let status = SyncStatus {
                        syncing: true,
                        synced_height,
                        chain_tip: effective_tip,
                        progress_percent: progress,
                    };
                    let _ = app.emit("zcash://sync-progress", &status);

                    tracing::info!(
                        "sync progress: {:.1}% ({}/{})",
                        progress,
                        synced_height,
                        effective_tip
                    );

                    // Enhance transactions to retrieve full data (including memos)
                    enhance_transactions(&mut client, &db, &network).await;

                    // If fully synced, break out of inner loop to sleep & re-check
                    if synced_height >= chain_tip {
                        tracing::info!("sync caught up to chain tip {}", chain_tip);
                        break;
                    }
                }
                Err(e) => {
                    tracing::error!("sync error: {e:?}");
                    // On sync error, break inner loop to retry after sleep
                    break;
                }
            }
        }

        // Emit "idle" status (synced, but still watching for new blocks)
        let synced_height = read_scanned_height(&read_db).await;
        let effective_tip = chain_tip.max(synced_height);
        last_known_chain_tip.store(effective_tip, Ordering::Relaxed);
        let progress = calc_progress(synced_height, effective_tip, birthday_height);
        let _ = app.emit("zcash://sync-progress", &SyncStatus {
            syncing: true,
            synced_height,
            chain_tip: effective_tip,
            progress_percent: progress,
        });

        // Sleep before re-checking for new blocks, with cancellation support
        tokio::select! {
            _ = tokio::time::sleep(SYNC_POLL_INTERVAL) => {
                tracing::debug!("re-checking for new blocks...");
            }
            _ = wait_for_cancel(&syncing) => {
                tracing::info!("sync cancelled during sleep");
                break;
            }
        }
    }

    // Final status
    let synced_height = read_scanned_height(&read_db).await;
    let chain_tip = last_known_chain_tip.load(Ordering::Relaxed);
    let progress = calc_progress(synced_height, chain_tip, birthday_height);

    *syncing.write().await = false;

    let _ = app.emit("zcash://sync-progress", &SyncStatus {
        syncing: false,
        synced_height,
        chain_tip,
        progress_percent: progress,
    });
}

/// Maximum number of transactions to enhance per sync batch to avoid delaying scanning.
const ENHANCE_BATCH_SIZE: usize = 10;

/// Fetch full transaction data for queued enhancement requests and decrypt/store them.
///
/// The sync engine (`zcash_client_backend::sync::run()`) only processes compact blocks, which
/// contain truncated ciphertexts — enough for note detection but **not** 512-byte memos.
/// After scanning, detected transactions are queued via `queue_tx_retrieval()`. This function
/// polls that queue, fetches the full transaction from lightwalletd, and calls
/// `decrypt_and_store_transaction()` which decrypts and stores the complete data including memos.
async fn enhance_transactions(
    client: &mut CompactTxStreamerClient<Channel>,
    db: &Arc<Mutex<Option<WalletDatabase>>>,
    network: &Network,
) {
    // 1. Read all data requests from the DB
    let requests = {
        let db_guard = db.lock().await;
        let db = match db_guard.as_ref() {
            Some(db) => db,
            None => return,
        };
        match db.transaction_data_requests() {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("enhance: failed to get tx data requests: {e}");
                return;
            }
        }
    };

    if requests.is_empty() {
        return;
    }

    // 2. Separate Enhancement and GetStatus requests
    let mut enhancement_txids = Vec::new();
    let mut status_txids = Vec::new();
    for r in requests {
        match r {
            TransactionDataRequest::Enhancement(txid) => enhancement_txids.push(txid),
            TransactionDataRequest::GetStatus(txid) => status_txids.push(txid),
            _ => {}
        }
    }

    tracing::info!(
        "enhance: {} enhancement + {} status requests queued",
        enhancement_txids.len(),
        status_txids.len()
    );

    // 3. Process Enhancement requests (fetch full tx, decrypt, store with memos)
    for txid in enhancement_txids.into_iter().take(ENHANCE_BATCH_SIZE) {
        let filter = TxFilter {
            block: None,
            index: 0,
            hash: txid.as_ref().to_vec(),
        };

        tracing::info!("enhance: fetching full tx {txid} from lightwalletd");

        let raw_tx = match client.get_transaction(filter).await {
            Ok(resp) => resp.into_inner(),
            Err(e) => {
                tracing::warn!("enhance: failed to fetch tx {txid}: {e}");
                // Mark as not found so we don't retry forever
                let mut db_guard = db.lock().await;
                if let Some(db) = db_guard.as_mut() {
                    let _ = db.set_transaction_status(txid, TransactionStatus::TxidNotRecognized);
                }
                continue;
            }
        };

        tracing::info!(
            "enhance: fetched tx {txid}, height={}, data_len={}",
            raw_tx.height,
            raw_tx.data.len()
        );

        // Determine mined height: 0 means mempool, u64::MAX means reorged fork
        let mined_height = if raw_tx.height > 0 && raw_tx.height != u64::MAX {
            Some(BlockHeight::from_u32(raw_tx.height as u32))
        } else {
            None
        };

        // Parse the raw transaction bytes
        let branch_id = mined_height
            .map(|h| BranchId::for_height(network, h))
            .unwrap_or_else(|| BranchId::for_height(network, BlockHeight::from_u32(u32::MAX)));

        let tx = match Transaction::read(&raw_tx.data[..], branch_id) {
            Ok(tx) => tx,
            Err(e) => {
                tracing::warn!("enhance: failed to parse tx {txid}: {e}");
                continue;
            }
        };

        // Decrypt and store — this writes memos to the DB
        let mut db_guard = db.lock().await;
        if let Some(db) = db_guard.as_mut() {
            match decrypt_and_store_transaction(network, db, &tx, mined_height) {
                Ok(()) => {
                    tracing::info!("enhance: successfully enhanced tx {txid}");
                }
                Err(e) => {
                    tracing::warn!("enhance: decrypt_and_store_transaction failed for {txid}: {e}");
                }
            }
        }
    }

    // 4. Process GetStatus requests (update mined height / expiry status)
    for txid in status_txids.into_iter().take(ENHANCE_BATCH_SIZE) {
        let filter = TxFilter {
            block: None,
            index: 0,
            hash: txid.as_ref().to_vec(),
        };

        match client.get_transaction(filter).await {
            Ok(resp) => {
                let raw_tx = resp.into_inner();
                let status = if raw_tx.height > 0 && raw_tx.height != u64::MAX {
                    TransactionStatus::Mined(BlockHeight::from_u32(raw_tx.height as u32))
                } else if raw_tx.height == u64::MAX {
                    // Mined on a fork, treat as not in main chain
                    TransactionStatus::NotInMainChain
                } else {
                    // height == 0 means mempool, skip status update
                    continue;
                };
                let mut db_guard = db.lock().await;
                if let Some(db) = db_guard.as_mut() {
                    let _ = db.set_transaction_status(txid, status);
                }
            }
            Err(_) => {
                let mut db_guard = db.lock().await;
                if let Some(db) = db_guard.as_mut() {
                    let _ = db.set_transaction_status(txid, TransactionStatus::TxidNotRecognized);
                }
            }
        }
    }
}

/// Wait until the syncing flag becomes false.
async fn wait_for_cancel(syncing: &RwLock<bool>) {
    loop {
        if !*syncing.read().await {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

/// Stop the background sync task.
pub async fn stop_sync(state: &WalletState) -> Result<()> {
    // Signal sync to stop
    *state.syncing.write().await = false;

    // Abort and wait for the task to fully cancel (releases db mutex)
    let handle = {
        state.sync_handle.lock().await.take()
    };
    if let Some(h) = handle {
        h.abort();
        let _ = h.await; // wait for cancellation to complete
    }
    Ok(())
}

/// Get the current sync status.
pub async fn get_sync_status(state: &WalletState) -> Result<SyncStatus> {
    let syncing = *state.syncing.read().await;

    if !state.is_initialized().await {
        return Ok(SyncStatus {
            syncing,
            synced_height: 0,
            chain_tip: 0,
            progress_percent: 0.0,
        });
    }

    // Read cached chain tip — avoid opening a new gRPC connection on every poll.
    // The sync task updates this atomically; before the first sync, return 0
    // and let the frontend show "connecting..." instead of hammering lightwalletd.
    let chain_tip = state.last_known_chain_tip.load(Ordering::Relaxed);

    // Use block_max_scanned for actual scan progress
    let synced_height = read_scanned_height(&state.read_db).await;

    let birthday_height = read_birthday_height(&state.read_db).await;

    let progress = calc_progress(synced_height, chain_tip, birthday_height);

    Ok(SyncStatus {
        syncing,
        synced_height,
        chain_tip,
        progress_percent: progress,
    })
}
