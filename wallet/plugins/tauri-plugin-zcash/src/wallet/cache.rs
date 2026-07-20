use std::collections::BTreeMap;
use std::convert::Infallible;
use std::sync::RwLock;

use async_trait::async_trait;
use zcash_client_backend::data_api::chain::{BlockCache, BlockSource, error};
use zcash_client_backend::data_api::scanning::ScanRange;
use zcash_client_backend::proto::compact_formats::CompactBlock;
use zcash_protocol::consensus::BlockHeight;

/// In-memory block cache for the sync driver.
///
/// ## Why in-memory, and how memory stays bounded
///
/// `zcash_client_sqlite::FsBlockDb` (the on-disk cache `zcash-devtool` uses) is
/// gated behind librustzcash's `unstable` cargo feature, and its own docs warn
/// that the API assumes linear scan order and will change. We are not willing to
/// take an `unstable` dependency in the shipping wallet, and `BlockDb` (the
/// ungated sqlite block source) is read-only — it has no write/insert API — so
/// an in-memory cache remains the right choice for now.
///
/// Memory is bounded by the *driver*, not by this type: `wallet/sync.rs`
/// downloads at most `BATCH_SIZE` blocks, scans them, and immediately calls
/// [`BlockCache::delete`] on that range, so the map holds one batch at a time
/// (~single-digit MB at 2500 mainnet compact blocks) rather than growing without
/// limit.
///
/// The one `CompactBlock` clone in [`BlockSource::with_blocks`] is forced by the
/// trait: the callback takes a `CompactBlock` **by value** while `with_blocks`
/// only has `&self`, so the block cannot be moved out. We therefore avoid every
/// *avoidable* copy instead — the driver never calls [`BlockCache::read`] (which
/// would clone a whole batch into a `Vec` just to hand it back), and blocks are
/// inserted by move.
#[derive(Default)]
pub struct MemBlockCache(RwLock<BTreeMap<BlockHeight, CompactBlock>>);

impl BlockSource for MemBlockCache {
    type Error = Infallible;

    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), error::Error<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), error::Error<WalletErrT, Self::Error>>,
    {
        let inner = self.0.read().unwrap();
        let iter = match from_height {
            Some(h) => inner.range(h..),
            None => inner.range(..),
        };
        for (i, (_, block)) in iter.enumerate() {
            if let Some(limit) = limit {
                if i >= limit {
                    break;
                }
            }
            with_block(block.clone())?;
        }
        Ok(())
    }
}

#[async_trait]
impl BlockCache for MemBlockCache {
    fn get_tip_height(
        &self,
        range: Option<&ScanRange>,
    ) -> Result<Option<BlockHeight>, <Self as BlockSource>::Error> {
        let inner = self.0.read().unwrap();
        Ok(match range {
            Some(range) => inner
                .range(range.block_range().start..range.block_range().end)
                .next_back()
                .map(|(h, _)| *h),
            None => inner.keys().next_back().copied(),
        })
    }

    async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, <Self as BlockSource>::Error> {
        let inner = self.0.read().unwrap();
        Ok(inner
            .range(range.block_range().start..range.block_range().end)
            .map(|(_, b)| b.clone())
            .collect())
    }

    async fn insert(&self, compact_blocks: Vec<CompactBlock>) -> Result<(), <Self as BlockSource>::Error> {
        let mut inner = self.0.write().unwrap();
        for block in compact_blocks {
            let height = block.height();
            inner.insert(height, block);
        }
        Ok(())
    }

    async fn delete(&self, range: ScanRange) -> Result<(), <Self as BlockSource>::Error> {
        let mut inner = self.0.write().unwrap();
        let keys: Vec<_> = inner
            .range(range.block_range().start..range.block_range().end)
            .map(|(h, _)| *h)
            .collect();
        for key in keys {
            inner.remove(&key);
        }
        Ok(())
    }
}
