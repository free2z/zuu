//! Explicit test-only preparation for Python's isolated two-profile controller.
//! Real Journal APIs create lifecycle state; no SQL eligibility implementation,
//! hooks, spending, external chain or production custody proof is supplied here.
use anyhow::{Result, ensure};
use serde::Deserialize;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
};
use zcash_keys::keys::UnifiedSpendingKey;
use zcash_paymentd::{
    Payment,
    chain::ObservedBlock,
    config::Config,
    journal::{Journal, StateLock},
    now,
};
use zcash_protocol::consensus::MAIN_NETWORK;
use zip32::AccountId;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Profile {
    config: PathBuf,
    payments: Vec<Payment>,
    revoke_first: bool,
    second_unconfirmed: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    profiles: Vec<Profile>,
    completed: PathBuf,
}

#[test]
#[ignore = "requires explicitly supplied isolated production-controller case"]
fn prepare_two_observation_journals() -> Result<()> {
    let path = std::env::var("PAYMENTD_PRODUCTION_HANDOFF_CASE")?;
    let bytes = fs::read(path)?;
    ensure!(bytes.len() <= 64 * 1024, "fixture input exceeds bound");
    let case: Case = serde_json::from_slice(&bytes)?;
    ensure!(
        case.profiles.len() == 2,
        "exactly two private profiles required"
    );
    ensure!(
        case.completed.is_absolute(),
        "absolute completion path required"
    );
    for (index, profile) in case.profiles.iter().enumerate() {
        ensure!(
            profile.config.is_absolute(),
            "absolute fixture config required"
        );
        ensure!(
            profile.payments.len() == 2,
            "two actual journal facts required"
        );
        let mut config = Config::load(&profile.config)?;
        ensure!(config.network == "main" && config.confirmations == 3);
        ensure!(
            config.consumers.len() == 2,
            "capture and settlement contract required"
        );
        ensure!(
            !config.state_dir.exists(),
            "fixture never overwrites journal state"
        );
        let key = UnifiedSpendingKey::from_seed(
            &MAIN_NETWORK,
            &[41 + u8::try_from(index)?; 32],
            AccountId::ZERO,
        )?
        .to_unified_full_viewing_key()
        .encode(&MAIN_NETWORK);
        let mut secret = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&config.ufvk_file)?;
        secret.write_all(key.as_bytes())?;
        secret.sync_all()?;
        config.consumers.clear();
        let _lock = StateLock::acquire(&config.state_dir)?;
        let mut journal = Journal::open(&config, &key)?;
        let first_hash = "1".repeat(64);
        journal.append(&ObservedBlock {
            height: config.birthday_height,
            hash: first_hash.clone(),
            previous_hash: "0".repeat(64),
            payments: vec![profile.payments[0].clone()],
        })?;
        if profile.revoke_first {
            journal.rollback_one()?;
        }
        let second_height = config.birthday_height + u32::from(!profile.revoke_first);
        let block = ObservedBlock {
            height: second_height,
            hash: "2".repeat(64),
            previous_hash: if profile.revoke_first {
                "0".repeat(64)
            } else {
                first_hash
            },
            payments: vec![profile.payments[1].clone()],
        };
        if profile.second_unconfirmed {
            journal.observe(&block)?;
        } else {
            journal.append(&block)?;
        }
        journal.scanner_health(Some(second_height), true, true, Some(now() + 900))?;
    }
    let mut done = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(case.completed)?;
    done.write_all(b"two consumer-empty journals prepared by actual Journal APIs\n")?;
    done.sync_all()?;
    Ok(())
}

#[test]
#[ignore = "requires explicitly supplied existing isolated controller journals"]
fn retain_ack_and_failed_delivery() -> Result<()> {
    let path = std::env::var("PAYMENTD_PRODUCTION_HANDOFF_CASE")?;
    let bytes = fs::read(path)?;
    ensure!(bytes.len() <= 64 * 1024, "fixture input exceeds bound");
    let case: Case = serde_json::from_slice(&bytes)?;
    ensure!(
        case.profiles.len() == 2,
        "exactly two private profiles required"
    );
    for profile in case.profiles {
        let config = Config::load(&profile.config)?;
        ensure!(
            config.consumers.len() == 2,
            "two configured consumers required"
        );
        let _lock = StateLock::acquire(&config.state_dir)?;
        let key = zcash_paymentd::config::private_file(&config.ufvk_file)?;
        let journal = Journal::open(&config, &key)?;
        let capture = &config.consumers[0].id;
        let settle = &config.consumers[1].id;
        let delivery = journal
            .next(capture, now())?
            .expect("existing capture fact");
        journal.acknowledge(capture, &delivery.event.event_id)?;
        let delivery = journal
            .next(settle, now())?
            .expect("existing settlement fact");
        journal.failed(settle, &delivery, "controlled retained retry")?;
    }
    Ok(())
}

// Exact persistence calls used by native startup/shutdown; no scanner SQL copy.
fn change_scanner_readiness(ready: bool) -> Result<()> {
    let path = std::env::var("PAYMENTD_PRODUCTION_HANDOFF_CASE")?;
    let bytes = fs::read(path)?;
    ensure!(bytes.len() <= 64 * 1024, "fixture input exceeds bound");
    let case: Case = serde_json::from_slice(&bytes)?;
    ensure!(case.profiles.len() == 2, "exactly two profiles required");
    for profile in case.profiles {
        let mut config = Config::load(&profile.config)?;
        config.consumers.clear(); // Observation never registers financial hooks.
        let _lock = StateLock::acquire(&config.state_dir)?;
        let key = zcash_paymentd::config::private_file(&config.ufvk_file)?;
        let journal = Journal::open(&config, &key)?;
        if ready {
            journal.scanner_health(
                Some(config.birthday_height + 1),
                true,
                true,
                Some(now() + 900),
            )?;
        } else {
            journal.scanner_health(None, false, false, None)?;
        }
    }
    Ok(())
}

#[test]
#[ignore = "requires explicitly supplied existing isolated controller journals"]
fn native_scanner_shutdown() -> Result<()> {
    change_scanner_readiness(false)
}

#[test]
#[ignore = "requires explicitly supplied existing isolated controller journals"]
fn observation_scanner_refreshed() -> Result<()> {
    change_scanner_readiness(true)
}
