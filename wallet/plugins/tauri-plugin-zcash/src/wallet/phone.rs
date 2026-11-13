//! Phone replacement uses the existing native seed custody and ZIP32 APIs.
//! No capsule, network transport, device-key export, or erase authority lives here.
use serde::{Deserialize, Serialize};
use zcash_client_backend::data_api::{Account, WalletRead};
use zcash_keys::keys::UnifiedAddressRequest;
use zcash_protocol::consensus::Network;

use super::WalletState;
use crate::{Error, Result};

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryAccount {
    pub index: u32,
    pub birthday: u64,
    pub address: String,
}

/// Nonsecret, user-compared discovery instructions. NOT an authenticated backup.
/// Never infer possession of recovery material from possession of this plan.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryPlan {
    pub version: u32,
    pub network: String,
    pub accounts: Vec<RecoveryAccount>,
    pub history: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneSnapshot {
    pub wallet_id: String,
    pub wallet_count: usize,
    pub plan: RecoveryPlan,
    pub fully_scanned: Option<u64>,
    pub chain_tip: u64,
    pub sync_current: bool,
    pub pending_payment: bool,
    // This can only be set by an explicit native custody read on this invocation.
    pub recovery_usable: bool,
}

fn failed() -> Error {
    Error::Other(
        "phone recovery metadata could not be verified; preserve both installations".into(),
    )
}

pub fn network_name(network: Network) -> &'static str {
    match network {
        Network::MainNetwork => "mainnet",
        Network::TestNetwork => "testnet",
    }
}

impl RecoveryPlan {
    pub fn validate(&self, network: Network) -> Result<()> {
        if self.version != 1
            || self.network != network_name(network)
            || self.accounts.is_empty()
            || self.accounts.len() > 100
            || self.history.len() > 5000
        {
            return Err(failed());
        }
        let mut indices = std::collections::HashSet::new();
        let mut history = std::collections::HashSet::new();
        for account in &self.accounts {
            if account.index >= (1 << 31)
                || !indices.insert(account.index)
                || account.birthday > u32::MAX as u64
                || account.address.len() > 1024
                || account.address.is_empty()
            {
                return Err(failed());
            }
        }
        // Shipping custody/send callers use account zero as the primary
        // account. Do not attest a shape those reviewed callers cannot use.
        if !indices.contains(&0) {
            return Err(failed());
        }
        for tx in &self.history {
            if tx.len() != 64 || !tx.bytes().all(|b| b.is_ascii_hexdigit()) || !history.insert(tx) {
                return Err(failed());
            }
        }
        Ok(())
    }

    pub fn validate_seed(&self, seed: &[u8], network: Network) -> Result<()> {
        self.validate(network)?;
        for account in &self.accounts {
            let key = super::keys::derive_usk(seed, &network, account.index)?;
            let (address, _) = key
                .to_unified_full_viewing_key()
                .default_address(UnifiedAddressRequest::AllAvailableKeys)
                .map_err(|_| failed())?;
            if address.encode(&network) != account.address {
                return Err(failed());
            }
        }
        Ok(())
    }

    pub fn matches(&self, other: &Self) -> bool {
        self.version == other.version
            && self.network == other.network
            && self.accounts.len() == other.accounts.len()
            && self.accounts.iter().all(|a| other.accounts.contains(a))
            && self.history.iter().all(|tx| other.history.contains(tx))
    }
}

/// Uses the real wallet adapter and the same history view as the history UI.
/// A bounded inventory refuses rather than silently dropping accounts/history.
pub fn read_plan<D: WalletRead>(
    db: &D,
    path: &std::path::Path,
    network: Network,
) -> Result<RecoveryPlan> {
    let mut accounts = Vec::new();
    for id in super::accounts::ordered_account_ids(db)? {
        let account = db
            .get_account(id)
            .map_err(|_| failed())?
            .ok_or_else(failed)?;
        let derivation = account.source().key_derivation().ok_or_else(failed)?;
        if accounts.is_empty() && u32::from(derivation.account_index()) != 0 {
            return Err(failed());
        }
        let ufvk = account.ufvk().ok_or_else(failed)?;
        let (address, _) = ufvk
            .default_address(UnifiedAddressRequest::AllAvailableKeys)
            .map_err(|_| failed())?;
        accounts.push(RecoveryAccount {
            index: u32::from(derivation.account_index()),
            birthday: u64::from(u32::from(account.birthday_height())),
            address: address.encode(&network),
        });
    }
    accounts.sort_by_key(|a| a.index);
    let conn =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| failed())?;
    let mut query = conn.prepare("SELECT DISTINCT lower(hex(txid)) FROM v_transactions WHERE COALESCE(expired_unmined, 0) = 0 ORDER BY 1 LIMIT 5001").map_err(|_| failed())?;
    let history = query
        .query_map([], |row| row.get(0))
        .map_err(|_| failed())?
        .collect::<std::result::Result<Vec<String>, _>>()
        .map_err(|_| failed())?;
    let plan = RecoveryPlan {
        version: 1,
        network: network_name(network).into(),
        accounts,
        history,
    };
    plan.validate(network)?;
    Ok(plan)
}

pub async fn snapshot(state: &WalletState, recovery_usable: bool) -> Result<PhoneSnapshot> {
    // Caller owns the transition guard throughout snapshot/custody reads.
    let (wallet_id, wallet_count) = {
        let manifest = state.manifest.lock().await;
        (
            manifest
                .active_wallet_id
                .clone()
                .ok_or(Error::WalletNotInitialized)?,
            manifest.wallets.len(),
        )
    };
    let path = state.active_db_path().await;
    let (plan, fully_scanned, db_complete) = {
        let _writer = state.db.lock().await;
        let guard = state.read_db.lock().await;
        let db = guard.as_ref().ok_or(Error::WalletNotInitialized)?;
        let plan = read_plan(db, &path, state.network)?;
        let fully_scanned = db
            .block_fully_scanned()
            .map_err(|_| failed())?
            .map(|b| u64::from(u32::from(b.block_height())));
        let complete = db
            .get_wallet_summary(
                zcash_client_backend::data_api::wallet::ConfirmationsPolicy::default(),
            )
            .map_err(|_| failed())?
            .is_some_and(|summary| summary.is_synced())
            && db.suggest_scan_ranges().map_err(|_| failed())?.is_empty()
            && db
                .transaction_data_requests()
                .map_err(|_| failed())?
                .is_empty();
        (plan, fully_scanned, complete)
    };
    let chain_tip = state
        .last_known_chain_tip
        .load(std::sync::atomic::Ordering::Relaxed);
    let sync_current = chain_tip > 0
        && fully_scanned.is_some_and(|h| h >= chain_tip)
        && state.last_sync_error.read().await.is_none()
        && db_complete;
    // Both persisted unknown outcomes and in-memory proposals block retirement.
    let pending_payment = state.pending_broadcast.lock().await.is_some()
        || state.pending_proposal.lock().await.is_some();
    Ok(PhoneSnapshot {
        wallet_id,
        wallet_count,
        plan,
        fully_scanned,
        chain_tip,
        sync_current,
        pending_payment,
        recovery_usable,
    })
}

/// Compiler-bound production account import seam, shared by native recovery and
/// controlled restore tests. The DB is staged and unpublished until ALL imports succeed.
pub fn import_accounts<D: zcash_client_backend::data_api::WalletWrite>(
    db: &mut D,
    seed: &secrecy::SecretVec<u8>,
    accounts: &[(u32, zcash_client_backend::data_api::AccountBirthday)],
) -> Result<()> {
    // Preserve the shipping primary-account invariant even if a user reorders
    // the nonsecret comparison record. Never remap the ZIP32 indices.
    let mut accounts = accounts.iter().collect::<Vec<_>>();
    accounts.sort_by_key(|(index, _)| *index);
    for (index, birthday) in accounts {
        let index = zip32::AccountId::try_from(*index).map_err(|_| failed())?;
        db.import_account_hd(
            &format!("Account {}", u32::from(index)),
            seed,
            index,
            birthday,
            None,
        )
        .map_err(|_| failed())?;
    }
    Ok(())
}
