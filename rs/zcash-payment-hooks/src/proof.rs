//! Read-only event provenance for an application committing an external effect.
use crate::{Event, PaymentRecord, chain::Chain, config::Config, journal::Journal, now};
use anyhow::{Result, ensure};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Serialize)]
pub struct EventProof {
    pub schema_version: u32,
    pub event: Event,
    pub confirmations: u32,
    pub ufvk_sha256: String,
    pub verified_at: i64,
    pub valid_until: i64,
}

pub async fn verify(
    chain: &dyn Chain,
    journal: &Journal,
    c: &Config,
    ufvk: &str,
    event_id: &str,
) -> Result<EventProof> {
    let started = std::time::Instant::now();
    let event = journal.proof_event(c, ufvk, event_id)?;
    let (confirmations, observed_at, valid_until, tip_height, tip_hash) = inclusion(
        chain,
        c,
        event.block_height,
        &event.block_hash,
        event.kind == "payment.revoked",
        event.kind == "payment.confirmed",
    )
    .await?;
    // Historical revocations are authenticated by journal lineage, not by
    // requiring an orphan to remain absent after its transaction re-mines.
    ensure!(
        chain.hash(tip_height).await? == tip_hash,
        "chain changed during event proof"
    );
    ensure!(
        journal.proof_event(c, ufvk, event_id)? == event,
        "journal changed during proof"
    );
    let verified_at = now();
    ensure!(
        verified_at >= observed_at
            && verified_at <= valid_until
            && started.elapsed() <= std::time::Duration::from_secs(20),
        "node freshness or overall proof deadline expired"
    );
    Ok(EventProof {
        schema_version: 1,
        event,
        confirmations,
        ufvk_sha256: hex::encode(Sha256::digest(ufvk)),
        verified_at,
        valid_until,
    })
}

#[derive(Serialize)]
pub struct PaymentProof {
    pub schema_version: u32,
    pub record: PaymentRecord,
    pub confirmations: u32,
    pub ufvk_sha256: String,
    pub verified_at: i64,
    pub valid_until: i64,
}
/// Shared node gate for lifecycle and historical proofs. The node validates
/// consensus; the private journal binds fully decrypted notes to these blocks.
async fn inclusion(
    chain: &dyn Chain,
    c: &Config,
    height: u32,
    hash: &str,
    revoked: bool,
    require_confirmed: bool,
) -> Result<(u32, i64, i64, u32, String)> {
    let tip = chain.tip().await?;
    let observed_at = now();
    let valid_until = tip.timestamp.min(observed_at) + c.max_tip_age_seconds as i64;
    let tip_hash = chain.hash(tip.height).await?;
    let confirmations = if revoked {
        0
    } else {
        tip.height.checked_sub(height).map_or(0, |n| n + 1)
    };
    if !revoked {
        ensure!(
            tip.height >= height && chain.hash(height).await? == hash,
            "payment inclusion is no longer canonical"
        );
        ensure!(
            !require_confirmed || confirmations >= c.confirmations,
            "payment lost required confirmation depth"
        );
    }
    Ok((
        confirmations,
        observed_at,
        valid_until,
        tip.height,
        tip_hash,
    ))
}
pub async fn verify_payment(
    chain: &dyn Chain,
    journal: &Journal,
    c: &Config,
    ufvk: &str,
    payment_id: &str,
) -> Result<PaymentProof> {
    let started = std::time::Instant::now();
    let record = journal.proof_payment(c, ufvk, payment_id)?;
    let (confirmations, observed_at, valid_until, tip_height, tip_hash) = inclusion(
        chain,
        c,
        record.block_height,
        &record.block_hash,
        false,
        record.confirmed,
    )
    .await?;
    ensure!(
        chain.hash(tip_height).await? == tip_hash,
        "chain changed during payment proof"
    );
    ensure!(
        journal.proof_payment(c, ufvk, payment_id)? == record,
        "journal changed during proof"
    );
    let verified_at = now();
    ensure!(
        verified_at >= observed_at
            && verified_at <= valid_until
            && started.elapsed() <= std::time::Duration::from_secs(20),
        "node freshness or overall proof deadline expired"
    );
    Ok(PaymentProof {
        schema_version: 1,
        record,
        confirmations,
        ufvk_sha256: hex::encode(Sha256::digest(ufvk)),
        verified_at,
        valid_until,
    })
}
