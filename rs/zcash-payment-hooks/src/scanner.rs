use crate::{chain::Chain, config::Config, journal::Journal};
use anyhow::{Result, ensure};

/// Keep live polling/backoff after failures or no forward progress. Historical
/// batches yield briefly only when they actually advance a still-behind cursor.
pub fn poll_delay(
    journal: &Journal,
    c: &Config,
    previous_height: Option<u32>,
) -> Result<std::time::Duration> {
    let advanced = journal
        .cursor()?
        .is_some_and(|(h, _)| previous_height.is_none_or(|old| h > old));
    Ok(if advanced && !journal.ready(c)? {
        std::time::Duration::from_millis(250)
    } else {
        std::time::Duration::from_secs(c.poll_seconds)
    })
}

/// Scan canonical blocks and reconcile confirmation depth. The node is the
/// consensus validator; this observer validates parsing, hashes and chain linkage.
pub async fn scan(chain: &dyn Chain, journal: &mut Journal, c: &Config) -> Result<usize> {
    journal.scanner_health(None, false, false, None)?;
    let tip = chain.tip().await?.height;
    let tip_hash = chain.hash(tip).await?;
    let early = journal.scans_unconfirmed()?;
    let scan_target = if early {
        tip
    } else {
        tip.saturating_sub(c.confirmations - 1)
    };
    let mut changes = 0;
    // Reorganizations preserve receipts and produce revocations, including tip shrink.
    while let Some((height, hash)) = journal.cursor()? {
        if height <= scan_target && chain.hash(height).await? == hash {
            break;
        }
        journal.rollback_one()?;
    }
    let start = journal.cursor()?.map_or(c.birthday_height, |(h, _)| h + 1);
    for height in start..=scan_target.min(start.saturating_add(99)) {
        let hash = chain.hash(height).await?;
        let block = chain.block(height, &hash).await?;
        ensure!(
            block.height == height && block.hash == hash,
            "chain provider returned the wrong block"
        );
        if journal.cursor()?.is_none() && height > 0 {
            ensure!(
                chain.hash(height - 1).await? == block.previous_hash,
                "birthday block does not link to canonical predecessor"
            );
        }
        // Detect a fork during retrieval before publishing this block's receipts.
        ensure!(
            chain.hash(tip).await? == tip_hash && chain.hash(height).await? == hash,
            "chain changed during scan; retry"
        );
        changes += if early {
            journal.observe(&block)?
        } else {
            journal.append(&block)?
        };
    }
    ensure!(
        chain.hash(tip).await? == tip_hash,
        "chain changed before readiness publication; retry"
    );
    if let Some((height, hash)) = journal.cursor()? {
        ensure!(
            chain.hash(height).await? == hash,
            "cursor changed before readiness publication; retry"
        );
    }
    // Refresh node timestamp/lag/upgrade evidence after potentially long catchup.
    let verified = chain.tip().await?;
    let fresh_until = verified.timestamp.min(crate::now()) + c.max_tip_age_seconds as i64;
    ensure!(
        chain.hash(tip).await? == tip_hash,
        "chain changed during freshness recheck; retry"
    );
    let safe_now = verified.height.saturating_sub(c.confirmations - 1);
    changes += journal.reconcile_confirmations(safe_now)?;
    journal.scanner_health(
        Some(verified.height),
        true,
        journal
            .cursor()?
            .is_some_and(|c| c.0 == if early { verified.height } else { safe_now }),
        Some(fresh_until),
    )?;
    Ok(changes)
}
