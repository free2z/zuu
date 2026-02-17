use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::{Mutex, RwLock};

use zcash_client_backend::data_api::WalletRead;
use zcash_protocol::consensus::Network;

use crate::error::{Error, Result};
use crate::models::SyncStatus;
use crate::wallet::cache::MemBlockCache;
use crate::wallet::client::connect_to_lightwalletd;
use crate::wallet::WalletDatabase;
use crate::wallet::WalletState;

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
    let network = state.network;
    let last_known_chain_tip = Arc::clone(&state.last_known_chain_tip);

    let handle = tokio::spawn(sync_task(
        app,
        lightwalletd_url,
        syncing_flag,
        db,
        network,
        last_known_chain_tip,
    ));

    *state.sync_handle.lock().await = Some(handle);
    Ok(())
}

async fn sync_task<R: Runtime>(
    app: AppHandle<R>,
    lightwalletd_url: String,
    syncing: Arc<RwLock<bool>>,
    db: Arc<Mutex<Option<WalletDatabase>>>,
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

    // Get chain tip for progress calculation
    let chain_tip = match client
        .get_latest_block(zcash_client_backend::proto::service::ChainSpec::default())
        .await
    {
        Ok(resp) => resp.into_inner().height as u64,
        Err(e) => {
            tracing::error!("failed to get chain tip: {e}");
            *syncing.write().await = false;
            return;
        }
    };

    // Cache the chain tip
    last_known_chain_tip.store(chain_tip, Ordering::Relaxed);

    // Get birthday height for progress calculation
    let birthday_height = {
        let db_guard = db.lock().await;
        if let Some(db) = db_guard.as_ref() {
            db.get_wallet_birthday()
                .ok()
                .flatten()
                .map(|h| u64::from(u32::from(h)))
                .unwrap_or(419200)
        } else {
            419200
        }
    };

    let block_cache = MemBlockCache::default();

    // Sync loop - run() processes batches and returns
    loop {
        // Check cancellation
        if !*syncing.read().await {
            tracing::info!("sync cancelled");
            break;
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
                break;
            }
        };

        match result {
            Ok(()) => {
                // Sync batch completed - check progress
                let synced_height = {
                    let db_guard = db.lock().await;
                    if let Some(db) = db_guard.as_ref() {
                        db.chain_height()
                            .ok()
                            .flatten()
                            .map(|h| u64::from(u32::from(h)))
                            .unwrap_or(0)
                    } else {
                        0
                    }
                };

                let total_range = chain_tip.saturating_sub(birthday_height);
                let synced_range = synced_height.saturating_sub(birthday_height);
                let progress = if total_range > 0 {
                    (synced_range as f32 / total_range as f32) * 100.0
                } else {
                    100.0
                };

                let status = SyncStatus {
                    syncing: true,
                    synced_height,
                    chain_tip,
                    progress_percent: progress.min(100.0),
                };
                let _ = app.emit("zcash://sync-progress", &status);

                tracing::info!(
                    "sync progress: {:.1}% ({}/{})",
                    progress,
                    synced_height,
                    chain_tip
                );

                // If fully synced, break
                if synced_height >= chain_tip {
                    tracing::info!("sync complete");
                    break;
                }
            }
            Err(e) => {
                tracing::error!("sync error: {e:?}");
                break;
            }
        }
    }

    // Final status
    let synced_height = {
        let db_guard = db.lock().await;
        if let Some(db) = db_guard.as_ref() {
            db.chain_height()
                .ok()
                .flatten()
                .map(|h| u64::from(u32::from(h)))
                .unwrap_or(0)
        } else {
            0
        }
    };

    let total_range = chain_tip.saturating_sub(birthday_height);
    let synced_range = synced_height.saturating_sub(birthday_height);
    let progress = if total_range > 0 {
        (synced_range as f32 / total_range as f32) * 100.0
    } else {
        100.0
    };

    *syncing.write().await = false;

    let _ = app.emit("zcash://sync-progress", &SyncStatus {
        syncing: false,
        synced_height,
        chain_tip,
        progress_percent: progress.min(100.0),
    });
}

/// Stop the background sync task.
pub async fn stop_sync(state: &WalletState) -> Result<()> {
    // Signal sync to stop
    *state.syncing.write().await = false;

    // Also abort the task handle as a fallback
    let mut handle = state.sync_handle.lock().await;
    if let Some(h) = handle.take() {
        h.abort();
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

    // Read cached chain tip
    let mut chain_tip = state.last_known_chain_tip.load(Ordering::Relaxed);

    // If chain tip is unknown and wallet is initialized, query lightwalletd
    if chain_tip == 0 {
        let url = state.lightwalletd_url.read().await.clone();
        if let Ok(mut client) = connect_to_lightwalletd(&url).await {
            if let Ok(resp) = client
                .get_latest_block(zcash_client_backend::proto::service::ChainSpec::default())
                .await
            {
                chain_tip = resp.into_inner().height as u64;
                state.last_known_chain_tip.store(chain_tip, Ordering::Relaxed);
            }
        }
    }

    let db_guard = state.db.lock().await;
    let db = db_guard.as_ref();

    let synced_height = if let Some(db) = db {
        db.chain_height()
            .ok()
            .flatten()
            .map(|h| u64::from(u32::from(h)))
            .unwrap_or(0)
    } else {
        0
    };

    let birthday_height = if let Some(db) = db {
        db.get_wallet_birthday()
            .ok()
            .flatten()
            .map(|h| u64::from(u32::from(h)))
            .unwrap_or(0)
    } else {
        0
    };

    let progress = if chain_tip > 0 && birthday_height < chain_tip {
        let total_range = chain_tip.saturating_sub(birthday_height);
        let synced_range = synced_height.saturating_sub(birthday_height);
        ((synced_range as f32 / total_range as f32) * 100.0).min(100.0)
    } else if chain_tip > 0 {
        // birthday >= chain_tip means new wallet at tip
        100.0
    } else {
        0.0
    };

    Ok(SyncStatus {
        syncing,
        synced_height,
        chain_tip,
        progress_percent: progress,
    })
}
