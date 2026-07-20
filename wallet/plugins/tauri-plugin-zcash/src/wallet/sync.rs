use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::{Mutex, RwLock};
use tonic::transport::Channel;

use zcash_client_backend::data_api::chain::{
    BlockCache, ChainState, CommitmentTreeRoot, error::Error as ChainError, scan_cached_blocks,
};
use zcash_client_backend::data_api::scanning::ScanRange;
use zcash_client_backend::data_api::wallet::ConfirmationsPolicy;
use zcash_client_backend::data_api::wallet::decrypt_and_store_transaction;
use zcash_client_backend::data_api::{
    TransactionDataRequest, TransactionStatus, WalletCommitmentTrees, WalletRead, WalletWrite,
};
use zcash_client_backend::proto::service::compact_tx_streamer_client::CompactTxStreamerClient;
use zcash_client_backend::proto::service::{
    BlockId, BlockRange, ChainSpec, GetSubtreeRootsArg, ShieldedProtocol, TxFilter,
};
use zcash_client_sqlite::error::SqliteClientError;
use zcash_primitives::merkle_tree::HashSer;
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::{BlockHeight, BranchId, Network};

use crate::error::{Error, Result};
use crate::models::SyncStatus;
use crate::wallet::WalletDatabase;
use crate::wallet::WalletState;
use crate::wallet::cache::MemBlockCache;
use crate::wallet::client::connect_to_lightwalletd;

/// Longest interval between sync re-checks once the wallet is caught up (30s).
///
/// Zcash targets ~75s blocks, so a caught-up wallet learns about a new block
/// within ~30s in the worst case. See [`next_poll_interval`] — we only reach
/// this ceiling after several consecutive no-work passes.
const SYNC_POLL_INTERVAL_MAX: Duration = Duration::from_secs(30);

/// Shortest interval between sync re-checks. Used immediately after a pass that
/// actually scanned blocks: when we are behind, the next range is usually ready
/// right away, so backing off a full 30s between batches is pure added latency.
const SYNC_POLL_INTERVAL_MIN: Duration = Duration::from_secs(2);

/// Number of blocks downloaded + scanned per batch.
///
/// `zcash-devtool` uses 10_000, but it caches blocks on disk. We cache in memory
/// (see [`MemBlockCache`] and the note on persistence below), so the batch size
/// directly bounds peak RSS: ~2_500 mainnet compact blocks is single-digit MB,
/// while 10_000 can be tens of MB. A smaller batch also means finer-grained
/// `zcash://sync-progress` events during a long initial scan.
const BATCH_SIZE: u32 = 2_500;

/// When a reorg is detected, rewind this many blocks below the reorg point
/// before re-scanning, to give a margin for re-crossing the actual fork height.
/// Matches `zcash-devtool`.
const REORG_REWIND_MARGIN: u32 = 10;

/// Maximum wall-clock age of the wallet's note commitment subtree roots before
/// we refresh them, when the wallet is otherwise idle.
///
/// ## Why this is safe — and why the old code was pathological
///
/// `zcash_client_backend::sync::run()` calls `update_subtree_roots()` as its
/// unconditional first action, and that helper always requests `start_index: 0`.
/// Because we called `sync::run()` from a 30s poll loop, a fully caught-up
/// wallet re-streamed **every** subtree root — measured at 1129 Sapling + 767
/// Orchard = 1896 roots — and re-inserted all of them into the shardtree twice a
/// minute, forever. That is why "catch up 2 blocks" took minutes. Upstream's own
/// docs call `sync::run` a reference implementation; neither Zashi nor Zingo nor
/// `zcash-devtool` drives a wallet with it.
///
/// The fix is *not* to fetch roots once at startup: shards keep completing as the
/// chain grows, and a wallet whose shardtree lacks the roots covering the tip
/// cannot build witnesses for recently received notes, so spends would fail.
/// Instead we do two things:
///
/// 1. **Fetch incrementally.** `WalletSummary::next_{sapling,orchard,ironwood}_subtree_index()`
///    reports exactly the first subtree index the wallet still needs, and
///    `GetSubtreeRootsArg::start_index` lets us ask lightwalletd for only that
///    suffix. A caught-up wallet therefore transfers *zero* roots per refresh
///    instead of 1896 — the request is a single empty gRPC stream per pool.
/// 2. **Refresh on a cadence tied to how fast shards actually complete.** A
///    shard is 2^16 note commitments; on mainnet a new Orchard/Sapling shard
///    completes on the order of days, never minutes. Refreshing every
///    [`SUBTREE_ROOT_REFRESH_INTERVAL`] is therefore ~2 orders of magnitude
///    tighter than required, and we additionally force a refresh whenever there
///    is real scanning work queued (so a wallet that is behind always has the
///    roots covering the range it is about to scan) and on demand via
///    [`refresh_subtree_roots_if_stale`] before witness-dependent operations.
const SUBTREE_ROOT_REFRESH_INTERVAL: Duration = Duration::from_secs(15 * 60);

/// Known-good MAINNET lightwalletd endpoints used as an ordered fallback list
/// when the configured endpoint repeatedly fails to stream blocks. All are
/// `*.zec.rocks`, so they satisfy the app CSP (`connect-src https://*.zec.rocks`)
/// and match the regional endpoints already offered in the wallet Settings UI —
/// no invented / unreachable hosts. The configured endpoint is always tried
/// first; these only extend the rotation.
const FALLBACK_LIGHTWALLETD_URLS: &[&str] = &[
    "https://zec.rocks:443",
    "https://na.zec.rocks:443",
    "https://eu.zec.rocks:443",
    "https://ap.zec.rocks:443",
];

/// Rotate to the next lightwalletd endpoint after this many consecutive scan
/// failures on the current one. Conservative on purpose: we only switch after
/// repeated failures so a single transient blip never causes endpoint churn.
const MAX_CONSECUTIVE_FAILURES: u32 = 3;

/// Safety valve: if `suggest_scan_ranges()` keeps handing us the same range and
/// scanning it makes no progress this many times in a row, something is wrong
/// (server serving a stale/short range, corrupt cache, …). Bail out of the pass
/// and surface an error rather than spinning the CPU forever.
const MAX_STALLED_BATCHES: u32 = 5;

/// Shorthand for the shared write-side wallet database handle.
type SharedDb = Arc<Mutex<Option<WalletDatabase>>>;

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
    let last_sync_error = Arc::clone(&state.last_sync_error);

    let handle = tokio::spawn(sync_task(
        app,
        lightwalletd_url,
        syncing_flag,
        db,
        read_db,
        network,
        last_known_chain_tip,
        last_sync_error,
    ));

    *state.sync_handle.lock().await = Some(handle);
    Ok(())
}

/// Read the max scanned block height from the read-only DB, floored at the
/// wallet birthday.
///
/// `block_max_scanned()` queries `MAX(height) FROM blocks` — the actual highest
/// scanned block, NOT the chain tip. It returns `None` for a wallet that has not
/// yet written any scanned block: a freshly created wallet whose birthday is the
/// chain tip has essentially nothing to scan, so `block_max_scanned()` stays
/// `None`. Reporting `0` in that case makes a caught-up wallet look like it must
/// scan the entire chain from Sapling, and the sync loop's `synced >= tip` check
/// never fires so it spins forever (issue #180). Everything below the birthday is
/// not the wallet's to scan, so we floor the scanned height at the birthday.
async fn read_scanned_height(
    read_db: &Mutex<Option<WalletDatabase>>,
    birthday_height: u64,
) -> u64 {
    let db_guard = read_db.lock().await;
    let scanned = if let Some(db) = db_guard.as_ref() {
        db.block_max_scanned()
            .ok()
            .flatten()
            .map(|meta| u64::from(u32::from(meta.block_height())))
            .unwrap_or(0)
    } else {
        0
    };
    scanned.max(birthday_height)
}

/// Read the wallet birthday height from the read-only DB.
///
/// Returns `None` when the birthday cannot be read (no wallet open, or the query
/// fails). Callers substitute the chain tip in that case — a wallet whose
/// birthday is unknown must NEVER be treated as needing a scan from Sapling
/// activation (that silent `419200` fallback is what produced the
/// "0 / 3.4M full-chain scan" symptom in issue #180). For any real wallet
/// `get_wallet_birthday()` returns `MIN(birthday_height)` across accounts, which
/// for a freshly created wallet is the chain tip.
async fn read_birthday_height(read_db: &Mutex<Option<WalletDatabase>>) -> Option<u64> {
    let db_guard = read_db.lock().await;
    let db = db_guard.as_ref()?;
    match db.get_wallet_birthday() {
        Ok(Some(h)) => Some(u64::from(u32::from(h))),
        Ok(None) => None,
        Err(e) => {
            tracing::warn!("failed to read wallet birthday: {e}");
            None
        }
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

/// Adaptive poll interval: fast while we still have work, backing off toward
/// [`SYNC_POLL_INTERVAL_MAX`] once caught up.
///
/// A caught-up wallet must not be polled aggressively (it costs the operator
/// bandwidth and us battery), but a wallet that is behind should not wait 30s
/// between batches. We double from [`SYNC_POLL_INTERVAL_MIN`] on each pass that
/// found nothing to do, and snap straight back to the minimum as soon as a pass
/// scans anything.
fn next_poll_interval(current: Duration, scanned_blocks: u64) -> Duration {
    if scanned_blocks > 0 {
        SYNC_POLL_INTERVAL_MIN
    } else {
        (current * 2).min(SYNC_POLL_INTERVAL_MAX)
    }
}

/// Consecutive Ironwood root-fetch failures tolerated before we *temporarily*
/// suspend asking for that pool. Deliberately mirrors
/// [`MAX_CONSECUTIVE_FAILURES`]: one blip must never change behaviour.
const IRONWOOD_MAX_CONSECUTIVE_FAILURES: u32 = 3;

/// How long Ironwood root fetches stay suspended after repeated failures. This
/// is a *backoff*, never a latch: once it elapses we try again, so a session can
/// always recover without an app restart. See [`SubtreeRootState`].
const IRONWOOD_RETRY_BACKOFF: Duration = Duration::from_secs(30 * 60);

/// Tracks when the note commitment subtree roots were last refreshed, plus the
/// Ironwood-specific health state.
///
/// ## Why Ironwood is tracked separately, and why nothing here latches forever
///
/// Sapling/Orchard fetch errors fail the whole pass, which surfaces to the user
/// and drives endpoint rotation. Ironwood cannot do that: a lightwalletd that
/// predates Ironwood activation may legitimately reject `ShieldedProtocol::Ironwood`,
/// and that must not wedge sync. So Ironwood errors are swallowed — which makes
/// it the one place where a *transient* network blip could silently degrade the
/// session. It therefore gets an explicit, recoverable policy:
///
/// - a network/stream error is **never** permanent: it takes
///   [`IRONWOOD_MAX_CONSECUTIVE_FAILURES`] consecutive failures to suspend the
///   pool, the suspension expires after [`IRONWOOD_RETRY_BACKOFF`], any success
///   resets the counter, and rotating to a different lightwalletd clears it
///   outright (the new endpoint deserves a clean slate);
/// - only [`Self::ironwood_backend_tracks`] is a true latch, and it is set from
///   a purely *local*, deterministic observation — we handed the wallet Ironwood
///   roots and its `next_ironwood_subtree_index()` did not advance, i.e. the
///   backend is using `WalletCommitmentTrees`' no-op default impl. No network
///   condition can trip it. (`zcash_client_sqlite` does override
///   `put_ironwood_subtree_roots`, so for our backend this branch is inert
///   belt-and-braces.)
pub(crate) struct SubtreeRootState {
    last_refresh: Option<Instant>,
    /// `false` once we have proven the wallet backend discards Ironwood roots.
    ironwood_backend_tracks: bool,
    /// Consecutive Ironwood fetch failures against the current endpoint.
    ironwood_failures: u32,
    /// When set, Ironwood fetches are suspended until this instant.
    ironwood_suspended_until: Option<Instant>,
}

impl Default for SubtreeRootState {
    fn default() -> Self {
        Self {
            last_refresh: None,
            ironwood_backend_tracks: true,
            ironwood_failures: 0,
            ironwood_suspended_until: None,
        }
    }
}

impl SubtreeRootState {
    fn is_stale(&self) -> bool {
        match self.last_refresh {
            None => true,
            Some(t) => t.elapsed() >= SUBTREE_ROOT_REFRESH_INTERVAL,
        }
    }

    /// Whether to ask for Ironwood roots on this refresh.
    fn should_fetch_ironwood(&self) -> bool {
        self.ironwood_backend_tracks
            && self
                .ironwood_suspended_until
                .is_none_or(|until| Instant::now() >= until)
    }

    /// Record a failed Ironwood fetch, suspending the pool only after repeated
    /// consecutive failures — and then only temporarily.
    fn note_ironwood_failure(&mut self, err: &str) {
        self.ironwood_failures += 1;
        tracing::warn!(
            "ironwood subtree root fetch failed ({}/{IRONWOOD_MAX_CONSECUTIVE_FAILURES}): {err}",
            self.ironwood_failures,
        );
        if self.ironwood_failures >= IRONWOOD_MAX_CONSECUTIVE_FAILURES {
            tracing::warn!(
                "suspending ironwood subtree root fetches for {IRONWOOD_RETRY_BACKOFF:?} after \
                 {IRONWOOD_MAX_CONSECUTIVE_FAILURES} consecutive failures; will retry automatically"
            );
            self.ironwood_suspended_until = Some(Instant::now() + IRONWOOD_RETRY_BACKOFF);
            self.ironwood_failures = 0;
        }
    }

    /// A different lightwalletd is now in use: give Ironwood a clean slate, since
    /// the previous endpoint's failures say nothing about this one.
    fn note_endpoint_rotated(&mut self) {
        self.ironwood_failures = 0;
        self.ironwood_suspended_until = None;
    }
}

/// Stream the subtree roots for one shielded pool, starting at `start_index`.
///
/// Generic over the Merkle hash type so the caller can feed the result straight
/// into `put_sapling_subtree_roots` / `put_orchard_subtree_roots` /
/// `put_ironwood_subtree_roots` — `H` is inferred from that call site, which is
/// what keeps this pool-agnostic without naming `sapling::Node` or
/// `MerkleHashOrchard` (neither crate is a direct dependency of this plugin).
/// Adding a fourth pool is one more three-line call.
async fn fetch_subtree_roots<H: HashSer>(
    client: &mut CompactTxStreamerClient<Channel>,
    protocol: ShieldedProtocol,
    start_index: u64,
) -> std::result::Result<Vec<CommitmentTreeRoot<H>>, String> {
    let mut request = GetSubtreeRootsArg {
        start_index: start_index.min(u64::from(u32::MAX)) as u32,
        ..Default::default()
    };
    request.set_shielded_protocol(protocol);

    let mut stream = client
        .get_subtree_roots(request)
        .await
        .map_err(|e| format!("get_subtree_roots({protocol:?}) failed: {e}"))?
        .into_inner();

    let mut roots = Vec::new();
    while let Some(root) = stream
        .message()
        .await
        .map_err(|e| format!("get_subtree_roots({protocol:?}) stream failed: {e}"))?
    {
        let root_hash = H::read(&root.root_hash[..])
            .map_err(|e| format!("invalid {protocol:?} subtree root hash: {e}"))?;
        roots.push(CommitmentTreeRoot::from_parts(
            BlockHeight::from_u32(root.completing_block_height as u32),
            root_hash,
        ));
    }

    Ok(roots)
}

/// Read the per-pool "next subtree index the wallet needs" from the wallet
/// summary. Returns `None` when there is no summary yet (no accounts).
async fn next_subtree_indices(read_db: &SharedDb) -> Option<(u64, u64, u64)> {
    let guard = read_db.lock().await;
    let db = guard.as_ref()?;
    let summary = db
        .get_wallet_summary(ConfirmationsPolicy::default())
        .map_err(|e| tracing::warn!("failed to read wallet summary: {e}"))
        .ok()
        .flatten()?;
    Some((
        summary.next_sapling_subtree_index(),
        summary.next_orchard_subtree_index(),
        summary.next_ironwood_subtree_index(),
    ))
}

/// Incrementally refresh the wallet's note commitment subtree roots.
///
/// Network I/O happens with **no** database lock held; the write lock is taken
/// only for the (fast, local) shardtree inserts. See
/// [`SUBTREE_ROOT_REFRESH_INTERVAL`] for why this is both necessary and cheap.
async fn refresh_subtree_roots(
    client: &mut CompactTxStreamerClient<Channel>,
    db: &SharedDb,
    read_db: &SharedDb,
    state: &mut SubtreeRootState,
) -> std::result::Result<(), String> {
    // No wallet summary yet (e.g. no accounts): nothing to anchor an incremental
    // fetch to, so start from the beginning.
    let (next_sapling, next_orchard, next_ironwood) =
        next_subtree_indices(read_db).await.unwrap_or((0, 0, 0));

    let sapling_roots = fetch_subtree_roots(client, ShieldedProtocol::Sapling, next_sapling).await?;
    let orchard_roots = fetch_subtree_roots(client, ShieldedProtocol::Orchard, next_orchard).await?;
    // Ironwood note commitments are Orchard-shaped, so the same hash type is
    // used. Servers predating Ironwood activation simply stream nothing; an
    // outright error means the server does not know the pool, which is not fatal.
    let ironwood_roots = if state.should_fetch_ironwood() {
        match fetch_subtree_roots(client, ShieldedProtocol::Ironwood, next_ironwood).await {
            Ok(roots) => {
                state.ironwood_failures = 0;
                state.ironwood_suspended_until = None;
                roots
            }
            Err(e) => {
                // NOT fatal and NOT a permanent latch: pre-activation servers may
                // legitimately reject this pool, and a transient blip must never
                // silently disable Ironwood for the rest of the session.
                state.note_ironwood_failure(&e);
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };

    tracing::info!(
        "subtree roots refresh: sapling +{} (from {}), orchard +{} (from {}), ironwood +{} (from {})",
        sapling_roots.len(),
        next_sapling,
        orchard_roots.len(),
        next_orchard,
        ironwood_roots.len(),
        next_ironwood,
    );

    let ironwood_offered = !ironwood_roots.is_empty();
    {
        let mut guard = db.lock().await;
        let Some(db) = guard.as_mut() else {
            return Err("database not available while updating subtree roots".to_string());
        };
        if !sapling_roots.is_empty() {
            db.put_sapling_subtree_roots(next_sapling, &sapling_roots)
                .map_err(|e| format!("put_sapling_subtree_roots failed: {e:?}"))?;
        }
        if !orchard_roots.is_empty() {
            db.put_orchard_subtree_roots(next_orchard, &orchard_roots)
                .map_err(|e| format!("put_orchard_subtree_roots failed: {e:?}"))?;
        }
        if ironwood_offered {
            db.put_ironwood_subtree_roots(next_ironwood, &ironwood_roots)
                .map_err(|e| format!("put_ironwood_subtree_roots failed: {e:?}"))?;
        }
    }

    // If we handed the backend Ironwood roots and it did not advance its
    // "next Ironwood index", it is using the no-op default impl. Stop fetching.
    if ironwood_offered {
        if let Some((_, _, after)) = next_subtree_indices(read_db).await {
            if after == next_ironwood {
                tracing::warn!(
                    "wallet backend accepted {} Ironwood subtree roots without advancing its next \
                     Ironwood index ({next_ironwood}); it is using the no-op default \
                     `put_ironwood_subtree_roots`. Disabling Ironwood root fetches for this session.",
                    ironwood_roots.len(),
                );
                state.ironwood_backend_tracks = false;
            }
        }
    }

    state.last_refresh = Some(Instant::now());
    Ok(())
}

/// Refresh subtree roots only if they are stale.
///
/// Exposed for witness-dependent operations (sends): a spend needs a witness
/// anchored in a shard the wallet actually holds, so callers that are about to
/// build a transaction can cheaply make sure the roots are not stale.
#[allow(dead_code)]
pub(crate) async fn refresh_subtree_roots_if_stale(
    client: &mut CompactTxStreamerClient<Channel>,
    db: &SharedDb,
    read_db: &SharedDb,
    state: &mut SubtreeRootState,
) -> std::result::Result<(), String> {
    if state.is_stale() {
        refresh_subtree_roots(client, db, read_db, state).await
    } else {
        Ok(())
    }
}

/// Push the current chain tip into the wallet, returning the tip height/hash.
async fn update_chain_tip(
    client: &mut CompactTxStreamerClient<Channel>,
    db: &SharedDb,
) -> std::result::Result<(BlockHeight, Vec<u8>), String> {
    let latest = client
        .get_latest_block(ChainSpec::default())
        .await
        .map_err(|e| format!("failed to get chain tip: {e}"))?
        .into_inner();

    let tip_height = BlockHeight::from_u32(latest.height as u32);
    let tip_hash = latest.hash.clone();

    {
        let mut guard = db.lock().await;
        let Some(db) = guard.as_mut() else {
            return Err("database not available while updating chain tip".to_string());
        };
        db.update_chain_tip(tip_height)
            .map_err(|e| format!("update_chain_tip failed: {e}"))?;
    }

    Ok((tip_height, tip_hash))
}

/// Download the compact blocks for `range` into the in-memory cache.
///
/// No database lock is held for the duration of this streaming download.
/// Returns `false` if sync was cancelled mid-stream.
async fn download_blocks(
    client: &mut CompactTxStreamerClient<Channel>,
    cache: &MemBlockCache,
    range: &ScanRange,
    syncing: &RwLock<bool>,
) -> std::result::Result<bool, String> {
    let start = BlockId {
        height: u64::from(u32::from(range.block_range().start)),
        hash: vec![],
    };
    let end = BlockId {
        height: u64::from(u32::from(range.block_range().end - 1)),
        hash: vec![],
    };

    let mut stream = client
        .get_block_range(BlockRange {
            start: Some(start),
            end: Some(end),
            pool_types: Default::default(),
        })
        .await
        .map_err(|e| format!("get_block_range failed: {e}"))?
        .into_inner();

    let mut blocks = Vec::with_capacity(range.len());
    let mut since_check = 0u32;
    while let Some(block) = stream
        .message()
        .await
        .map_err(|e| format!("block stream failed: {e}"))?
    {
        blocks.push(block);
        since_check += 1;
        // Cheap cancellation check: an initial sync streams thousands of blocks
        // per batch, and `stop_sync` must not have to wait for the whole batch.
        if since_check >= 256 {
            since_check = 0;
            if !*syncing.read().await {
                return Ok(false);
            }
        }
    }

    // `MemBlockCache::insert` is infallible.
    let _ = cache.insert(blocks).await;
    Ok(true)
}

/// Fetch the note commitment tree state as of `block_height` (the block *before*
/// the range being scanned).
async fn download_chain_state(
    client: &mut CompactTxStreamerClient<Channel>,
    block_height: BlockHeight,
) -> std::result::Result<ChainState, String> {
    let tree_state = client
        .get_tree_state(BlockId {
            height: u64::from(u32::from(block_height)),
            hash: vec![],
        })
        .await
        .map_err(|e| format!("get_tree_state({block_height}) failed: {e}"))?
        .into_inner();

    tree_state
        .to_chain_state()
        .map_err(|e| format!("invalid tree state at {block_height}: {e}"))
}

/// Recover from a chain reorg detected at `at_height` by rewinding the wallet
/// and dropping the now-invalid cached blocks.
///
/// `truncate_to_height` can only rewind to a height carrying a note commitment
/// tree checkpoint, so if `requested` has none we retry at `at_height - 2`
/// (strictly below the stale block, which also guarantees forward progress). If
/// even that has no checkpoint, the reorg is deeper than our rewindable history
/// and we surface an actionable error instead of wedging. This mirrors the
/// audited `zcash-devtool` implementation.
async fn rewind(
    db: &SharedDb,
    cache: &MemBlockCache,
    at_height: BlockHeight,
    requested: BlockHeight,
    chain_tip: BlockHeight,
) -> std::result::Result<(), String> {
    let rewind_height = {
        let mut guard = db.lock().await;
        let Some(db) = guard.as_mut() else {
            return Err("database not available during reorg rewind".to_string());
        };

        let rewind_height = match db.truncate_to_height(requested) {
            Ok(h) => h,
            Err(SqliteClientError::RequestedRewindInvalid { .. }) => {
                let bound = at_height.saturating_sub(2);
                match db.truncate_to_height(bound) {
                    Ok(h) => {
                        tracing::info!(
                            "requested rewind to {requested} had no checkpoint; rewound to {h}"
                        );
                        h
                    }
                    Err(SqliteClientError::RequestedRewindInvalid { .. }) => {
                        return Err(format!(
                            "unrecoverable reorg at {at_height}: no note-commitment-tree \
                             checkpoint with a scanned block exists below the conflict \
                             (requested rewind to {requested}); reset the wallet to resync \
                             from its birthday"
                        ));
                    }
                    Err(e) => return Err(format!("truncate_to_height({bound}) failed: {e}")),
                }
            }
            Err(e) => return Err(format!("truncate_to_height({requested}) failed: {e}")),
        };

        // `truncate_to_height` trims the scan queue down to the rewound height,
        // so without re-applying the tip the wallet would believe it has nothing
        // left to scan and would stop at the rewind height instead of re-scanning
        // the replacement chain.
        db.update_chain_tip(chain_tip)
            .map_err(|e| format!("update_chain_tip after rewind failed: {e}"))?;

        rewind_height
    };

    // Drop every cached block above the rewind height: they may belong to the
    // orphaned fork.
    let _ = cache
        .delete(ScanRange::from_parts(
            (rewind_height + 1)..(chain_tip + 1),
            zcash_client_backend::data_api::scanning::ScanPriority::Historic,
        ))
        .await;

    Ok(())
}

/// Outcome of a single download+scan batch.
enum BatchOutcome {
    /// `n` blocks were scanned.
    Scanned(u64),
    /// A reorg was detected and the wallet was rewound; ranges are now invalid.
    Rewound,
    /// Sync was cancelled mid-batch.
    Cancelled,
}

/// Download + scan one batch, handling reorg-driven rewinds.
#[allow(clippy::too_many_arguments)]
async fn process_batch(
    client: &mut CompactTxStreamerClient<Channel>,
    network: &Network,
    cache: &MemBlockCache,
    db: &SharedDb,
    syncing: &RwLock<bool>,
    range: &ScanRange,
    chain_tip: BlockHeight,
) -> std::result::Result<BatchOutcome, String> {
    tracing::debug!("sync batch: fetching {range}");

    // --- network I/O, no DB lock held ---
    if !download_blocks(client, cache, range, syncing).await? {
        return Ok(BatchOutcome::Cancelled);
    }
    let chain_state = download_chain_state(client, range.block_range().start - 1).await?;

    // --- local scan, write lock held only for the scan itself ---
    let scan_result = {
        let mut guard = db.lock().await;
        let Some(db) = guard.as_mut() else {
            return Err("database not available during scan".to_string());
        };
        scan_cached_blocks(
            network,
            cache,
            db,
            range.block_range().start,
            &chain_state,
            range.len(),
        )
    };

    // Whatever happened, these blocks have served their purpose — keeping them
    // would grow the in-memory cache without bound.
    let _ = cache.delete(range.clone()).await;

    match scan_result {
        Ok(summary) => {
            let scanned_range = summary.scanned_range();
            let scanned = u64::from(u32::from(scanned_range.end))
                .saturating_sub(u64::from(u32::from(scanned_range.start)));
            Ok(BatchOutcome::Scanned(scanned))
        }
        Err(ChainError::Scan(err)) if err.is_continuity_error() => {
            let rewind_height = err.at_height().saturating_sub(REORG_REWIND_MARGIN);
            tracing::info!(
                "chain reorg detected at {}, rewinding to {} (scan error: {err:?})",
                err.at_height(),
                rewind_height,
            );
            rewind(db, cache, err.at_height(), rewind_height, chain_tip).await?;
            Ok(BatchOutcome::Rewound)
        }
        Err(e) => Err(format!("scan_cached_blocks failed: {e:?}")),
    }
}

/// Read the highest-priority suggested scan range, clamped to [`BATCH_SIZE`].
///
/// `suggest_scan_ranges()` returns ranges in priority order, `Verify` first. We
/// re-request it after every batch rather than iterating a snapshot: scanning can
/// insert a higher-priority range (or a rewind can invalidate the whole list),
/// and re-querying is a cheap local SQL read that keeps the driver obviously
/// correct. Reads go through `read_db` so we never contend on the write lock.
async fn next_scan_range(read_db: &SharedDb) -> std::result::Result<Option<ScanRange>, String> {
    let guard = read_db.lock().await;
    let Some(db) = guard.as_ref() else {
        return Err("database not available while suggesting scan ranges".to_string());
    };
    let ranges = db
        .suggest_scan_ranges()
        .map_err(|e| format!("suggest_scan_ranges failed: {e}"))?;

    Ok(ranges.into_iter().find(|r| !r.is_empty()).map(|range| {
        // Limit the number of blocks we download and hold in memory at once.
        match range.split_at(range.block_range().start + BATCH_SIZE) {
            Some((head, _)) => head,
            None => range,
        }
    }))
}

#[allow(clippy::too_many_arguments)]
async fn sync_task<R: Runtime>(
    app: AppHandle<R>,
    lightwalletd_url: String,
    syncing: Arc<RwLock<bool>>,
    db: Arc<Mutex<Option<WalletDatabase>>>,
    read_db: Arc<Mutex<Option<WalletDatabase>>>,
    network: Network,
    last_known_chain_tip: Arc<AtomicU64>,
    last_sync_error: Arc<RwLock<Option<String>>>,
) {
    tracing::info!("sync started with endpoint: {}", lightwalletd_url);

    // Ordered endpoint rotation: the configured endpoint first, then any
    // known-good fallbacks not already equal to it. On repeated scan failures we
    // cycle through this list (see `MAX_CONSECUTIVE_FAILURES`) so one endpoint
    // being unreachable, or accepting the connection but refusing to stream
    // compact blocks / subtree roots, can no longer wedge sync at 0.0% forever.
    let mut endpoints: Vec<String> = vec![lightwalletd_url.clone()];
    for &fb in FALLBACK_LIGHTWALLETD_URLS {
        if !endpoints.iter().any(|e| e == fb) {
            endpoints.push(fb.to_string());
        }
    }
    let mut endpoint_idx = 0usize;
    let mut consecutive_failures = 0u32;

    // Connect to lightwalletd
    let mut client = match connect_to_lightwalletd(&lightwalletd_url).await {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("Can't reach the Zcash network: {e}");
            tracing::error!("failed to connect to lightwalletd: {e}");
            // Surface the failure instead of dying silently — store it so the
            // polled `get_sync_status` returns it, and emit for event listeners.
            *last_sync_error.write().await = Some(msg.clone());
            *syncing.write().await = false;
            let _ = app.emit("zcash://sync-progress", &SyncStatus {
                syncing: false,
                synced_height: 0,
                chain_tip: 0,
                progress_percent: 0.0,
                last_error: Some(msg),
            });
            return;
        }
    };

    // Read once. `None` means "unknown" — resolved against the chain tip below so
    // an unreadable birthday can never imply a scan from Sapling activation.
    let birthday_opt = read_birthday_height(&read_db).await;
    let block_cache = MemBlockCache::default();
    let mut root_state = SubtreeRootState::default();
    let mut poll_interval = SYNC_POLL_INTERVAL_MIN;

    // Outer loop: sync to tip, sleep, re-check for new blocks, repeat.
    // Only exits on cancellation or fatal error.
    loop {
        // Check cancellation
        if !*syncing.read().await {
            tracing::info!("sync cancelled");
            break;
        }

        let pass = run_pass(
            &app,
            &mut client,
            &network,
            &block_cache,
            &db,
            &read_db,
            &syncing,
            &last_known_chain_tip,
            &mut root_state,
            birthday_opt,
        )
        .await;

        let scanned_blocks = match pass {
            Ok(PassOutcome::Cancelled) => {
                tracing::info!("sync cancelled");
                // Signal final status and exit
                let chain_tip = last_known_chain_tip.load(Ordering::Relaxed);
                let birthday_height = birthday_opt.unwrap_or(chain_tip);
                let synced_height = read_scanned_height(&read_db, birthday_height).await;
                let progress = calc_progress(synced_height, chain_tip, birthday_height);
                *syncing.write().await = false;
                let _ = app.emit("zcash://sync-progress", &SyncStatus {
                    syncing: false,
                    synced_height,
                    chain_tip,
                    progress_percent: progress,
                    last_error: None,
                });
                return;
            }
            Ok(PassOutcome::Completed { scanned_blocks }) => {
                // A pass committed cleanly: reset the failure counter and clear
                // any previously surfaced error so the UI leaves the error state.
                consecutive_failures = 0;
                *last_sync_error.write().await = None;

                // Enhance transactions to retrieve full data (including memos).
                enhance_transactions(&mut client, &db, &network).await;

                scanned_blocks
            }
            Err(e) => {
                // The error that used to be swallowed here (logged, then a
                // silent 30s retry) is the reason a wedged endpoint shows an
                // eternal "Syncing 0.0%". Surface it and, after repeated
                // failures, rotate to a fallback endpoint to try to recover.
                consecutive_failures += 1;
                tracing::error!("sync error (attempt {consecutive_failures}): {e}");

                let mut surfaced = format!("Sync trouble — retrying. ({e})");
                if consecutive_failures >= MAX_CONSECUTIVE_FAILURES && endpoints.len() > 1 {
                    endpoint_idx = (endpoint_idx + 1) % endpoints.len();
                    let next = endpoints[endpoint_idx].clone();
                    tracing::warn!(
                        "rotating lightwalletd endpoint after {consecutive_failures} consecutive failures -> {next}"
                    );
                    match connect_to_lightwalletd(&next).await {
                        Ok(c) => {
                            client = c;
                            // A different server deserves a clean slate: whatever
                            // the previous endpoint did to our Ironwood health
                            // says nothing about this one.
                            root_state.note_endpoint_rotated();
                            surfaced = format!("Sync trouble — retrying via {next}");
                        }
                        Err(ce) => {
                            tracing::error!(
                                "failed to connect to fallback endpoint {next}: {ce}"
                            );
                            surfaced =
                                format!("Can't reach the Zcash network — retrying via {next}");
                        }
                    }
                    // Give the new endpoint a fresh streak before rotating again.
                    consecutive_failures = 0;
                }

                // Store for the polled `get_sync_status`, and emit for
                // event listeners. Keep progress fields as-is (still `true`
                // syncing — we WILL retry) so the UI shows an error banner
                // without losing the caught-up/height context.
                *last_sync_error.write().await = Some(surfaced.clone());
                let chain_tip = last_known_chain_tip.load(Ordering::Relaxed);
                let birthday_height = birthday_opt.unwrap_or(chain_tip);
                let synced_height = read_scanned_height(&read_db, birthday_height).await;
                let progress = calc_progress(synced_height, chain_tip, birthday_height);
                let _ = app.emit("zcash://sync-progress", &SyncStatus {
                    syncing: true,
                    synced_height,
                    chain_tip,
                    progress_percent: progress,
                    last_error: Some(surfaced),
                });

                0
            }
        };

        // Emit "idle" status. NOTE: a pass ends here on BOTH a clean catch-up
        // AND an error, so carry whatever error is currently stored (the error
        // arm may have just set it) rather than clearing it — a successful pass
        // is the only thing that clears `last_sync_error`.
        let chain_tip = last_known_chain_tip.load(Ordering::Relaxed);
        let birthday_height = birthday_opt.unwrap_or(chain_tip);
        let synced_height = read_scanned_height(&read_db, birthday_height).await;
        let effective_tip = chain_tip.max(synced_height);
        last_known_chain_tip.store(effective_tip, Ordering::Relaxed);
        let progress = calc_progress(synced_height, effective_tip, birthday_height);
        let last_error = last_sync_error.read().await.clone();
        let _ = app.emit("zcash://sync-progress", &SyncStatus {
            syncing: true,
            synced_height,
            chain_tip: effective_tip,
            progress_percent: progress,
            last_error,
        });

        // Adaptive backoff: snap to the minimum while we still have work to do,
        // back off toward 30s once caught up.
        poll_interval = next_poll_interval(poll_interval, scanned_blocks);
        tokio::select! {
            _ = tokio::time::sleep(poll_interval) => {
                tracing::debug!("re-checking for new blocks (interval {poll_interval:?})...");
            }
            _ = wait_for_cancel(&syncing) => {
                tracing::info!("sync cancelled during sleep");
                break;
            }
        }
    }

    // Final status
    let chain_tip = last_known_chain_tip.load(Ordering::Relaxed);
    let birthday_height = birthday_opt.unwrap_or(chain_tip);
    let synced_height = read_scanned_height(&read_db, birthday_height).await;
    let progress = calc_progress(synced_height, chain_tip, birthday_height);

    *syncing.write().await = false;

    let last_error = last_sync_error.read().await.clone();
    let _ = app.emit("zcash://sync-progress", &SyncStatus {
        syncing: false,
        synced_height,
        chain_tip,
        progress_percent: progress,
        last_error,
    });
}

/// Outcome of one full "catch up to the chain tip" pass.
enum PassOutcome {
    Completed { scanned_blocks: u64 },
    Cancelled,
}

/// One full pass: refresh the chain tip, refresh subtree roots when warranted,
/// then download+scan batches until there is nothing left to scan.
#[allow(clippy::too_many_arguments)]
async fn run_pass<R: Runtime>(
    app: &AppHandle<R>,
    client: &mut CompactTxStreamerClient<Channel>,
    network: &Network,
    cache: &MemBlockCache,
    db: &SharedDb,
    read_db: &SharedDb,
    syncing: &Arc<RwLock<bool>>,
    last_known_chain_tip: &AtomicU64,
    root_state: &mut SubtreeRootState,
    birthday_opt: Option<u64>,
) -> std::result::Result<PassOutcome, String> {
    // 1) Chain tip → wallet.
    let (chain_tip, tip_hash) = update_chain_tip(client, db).await?;
    let chain_tip_u64 = u64::from(u32::from(chain_tip));
    last_known_chain_tip.store(chain_tip_u64, Ordering::Relaxed);

    // Resolve the birthday: if it couldn't be read, assume the tip (nothing to
    // scan) rather than Sapling activation, so we never full-scan the chain.
    let birthday_height = birthday_opt.unwrap_or(chain_tip_u64);

    // 2) Reorg-while-idle detection.
    //
    // `update_chain_tip` intentionally does nothing when the reported tip is
    // below our maximum scanned height: it leaves reorg detection to the
    // scanner's block-continuity check. But a fully synced wallet has no ranges
    // left to scan, so a reorg that shortens the chain below our scanned height
    // would go unnoticed until the chain grew back past it. Detect it here — but
    // only for a *genuine* reorg: a tip below our scanned height is either a real
    // rollback or merely a lagging server (common when a light client rotates
    // endpoints). Compare the server's tip hash against our stored hash at that
    // height; a bare height comparison would ratchet the wallet backwards every
    // time we hit a slow node.
    {
        let diverged = {
            let guard = read_db.lock().await;
            match guard.as_ref() {
                Some(rdb) => {
                    let max_scanned = rdb
                        .block_max_scanned()
                        .map_err(|e| format!("block_max_scanned failed: {e}"))?
                        .map(|b| b.block_height());
                    match max_scanned {
                        Some(max_scanned) if chain_tip < max_scanned => {
                            let ours = rdb
                                .block_metadata(chain_tip)
                                .map_err(|e| format!("block_metadata failed: {e}"))?
                                .map(|m| m.block_hash().0.to_vec());
                            ours.as_deref() != Some(tip_hash.as_slice())
                        }
                        _ => false,
                    }
                }
                None => false,
            }
        };
        if diverged {
            let rewind_height = chain_tip.saturating_sub(REORG_REWIND_MARGIN);
            tracing::warn!(
                "chain tip {chain_tip} diverges from our history; reorg detected, rewinding to {rewind_height}"
            );
            rewind(db, cache, chain_tip, rewind_height, chain_tip).await?;
        }
    }

    // 3) Subtree roots. Refresh when stale, and always before doing real scanning
    //    work so the shards covering the range we are about to scan are present.
    //    See `SUBTREE_ROOT_REFRESH_INTERVAL` for the full rationale.
    let has_work = next_scan_range(read_db).await?.is_some();
    if root_state.is_stale() || has_work {
        refresh_subtree_roots(client, db, read_db, root_state).await?;
    }

    // 4) Download + scan batches until nothing is left to scan.
    let mut scanned_total = 0u64;
    let mut last_range: Option<(BlockHeight, BlockHeight)> = None;
    let mut stalled = 0u32;

    loop {
        if !*syncing.read().await {
            return Ok(PassOutcome::Cancelled);
        }

        let Some(range) = next_scan_range(read_db).await? else {
            break;
        };

        let key = (range.block_range().start, range.block_range().end);
        if last_range == Some(key) {
            stalled += 1;
            if stalled >= MAX_STALLED_BATCHES {
                return Err(format!(
                    "sync stalled: range {range} was re-suggested {stalled} times without progress"
                ));
            }
        } else {
            stalled = 0;
            last_range = Some(key);
        }

        match process_batch(client, network, cache, db, syncing, &range, chain_tip).await? {
            BatchOutcome::Cancelled => return Ok(PassOutcome::Cancelled),
            BatchOutcome::Rewound => {
                // Suggested ranges are invalid now; re-request on the next turn.
                last_range = None;
                stalled = 0;
                continue;
            }
            BatchOutcome::Scanned(n) => {
                scanned_total += n;
                if n > 0 {
                    stalled = 0;
                }
            }
        }

        // 5) Emit real progress *during* the scan, not just between passes. With
        //    `BATCH_SIZE` blocks per batch this fires many times during an
        //    initial sync instead of once at the very end.
        let synced_height = read_scanned_height(read_db, birthday_height).await;
        let effective_tip = chain_tip_u64.max(synced_height);
        last_known_chain_tip.store(effective_tip, Ordering::Relaxed);
        let progress = calc_progress(synced_height, effective_tip, birthday_height);
        let _ = app.emit("zcash://sync-progress", &SyncStatus {
            syncing: true,
            synced_height,
            chain_tip: effective_tip,
            progress_percent: progress,
            last_error: None,
        });
        tracing::info!("sync progress: {progress:.1}% ({synced_height}/{effective_tip})");

        // Retrieve memos for anything we just detected. This early-returns when
        // the request queue is empty, so it is nearly free between batches.
        enhance_transactions(client, db, network).await;
    }

    tracing::info!("sync pass complete; caught up to chain tip {chain_tip}");
    Ok(PassOutcome::Completed {
        scanned_blocks: scanned_total,
    })
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
            last_error: state.last_sync_error.read().await.clone(),
        });
    }

    // Read cached chain tip — avoid opening a new gRPC connection on every poll.
    // The sync task updates this atomically; before the first sync, return 0
    // and let the frontend show "connecting..." instead of hammering lightwalletd.
    let chain_tip = state.last_known_chain_tip.load(Ordering::Relaxed);

    // An unreadable birthday resolves to the chain tip (nothing to scan), never
    // Sapling activation — so a caught-up wallet never reports a full-chain scan.
    let birthday_height = read_birthday_height(&state.read_db)
        .await
        .unwrap_or(chain_tip);

    // Use block_max_scanned (floored at the birthday) for actual scan progress.
    let synced_height = read_scanned_height(&state.read_db, birthday_height).await;

    let progress = calc_progress(synced_height, chain_tip, birthday_height);

    Ok(SyncStatus {
        syncing,
        synced_height,
        chain_tip,
        progress_percent: progress,
        last_error: state.last_sync_error.read().await.clone(),
    })
}
