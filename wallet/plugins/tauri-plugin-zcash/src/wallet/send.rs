use std::str::FromStr;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::{fs::OpenOptions, io::Write, path::Path};

use secrecy::ExposeSecret;
use zcash_client_backend::data_api::wallet::{
    create_proposed_transactions,
    input_selection::{GreedyInputSelector, SpendPolicy},
    propose_transfer,
    ConfirmationsPolicy, SpendingKeys,
};
use zcash_client_backend::data_api::WalletRead;
use zcash_client_backend::fees::zip317::SingleOutputChangeStrategy;
use zcash_client_backend::fees::DustOutputPolicy;
use zcash_client_backend::proto::service::{RawTransaction, TxFilter};
use zcash_client_backend::wallet::OvkPolicy;
use zcash_keys::address::Address;
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::PoolType;
use zcash_protocol::memo::{Memo, MemoBytes};
use zcash_protocol::value::Zatoshis;
use zcash_protocol::{ShieldedPool, TxId};

use crate::error::{Error, Result};
use crate::models::{
    AddressValidation, BroadcastStatus, ExecuteSendResult, PendingSendStatus, SaplingParamsStatus,
    SendProposal,
};
use crate::wallet::client::connect_to_lightwalletd;
use crate::wallet::keys;
use crate::wallet::WalletState;

/// A transaction that has already been created in the wallet database.
/// Retrying this record always rebroadcasts `raw_transaction`; it never signs
/// or creates another transaction for the same proposal.
#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct PendingBroadcast {
    wallet_id: String,
    pub(super) proposal_id: u32,
    txid: String,
    txid_bytes: Vec<u8>,
    raw_transaction: Vec<u8>,
    status: BroadcastStatus,
    message: Option<String>,
    attempts: u32,
    #[serde(default)]
    had_ambiguous_attempt: bool,
    #[serde(default)]
    recovery_error: Option<String>,
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const RPC_TIMEOUT: Duration = Duration::from_secs(30);

fn pending_broadcast_path(data_dir: &Path, wallet_id: &str) -> Result<std::path::PathBuf> {
    if wallet_id.is_empty()
        || !wallet_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(Error::DatabaseError("invalid wallet identifier".into()));
    }
    Ok(data_dir.join(format!("pending-send-{wallet_id}.json")))
}

pub(crate) fn load_pending_broadcast(
    data_dir: &Path,
    wallet_id: &str,
) -> Option<PendingBroadcast> {
    let corrupt = |message: String| PendingBroadcast {
        wallet_id: wallet_id.to_string(),
        proposal_id: 0,
        txid: "unavailable".into(),
        txid_bytes: vec![],
        raw_transaction: vec![],
        status: BroadcastStatus::Unknown,
        message: Some(message.clone()),
        attempts: 1,
        had_ambiguous_attempt: true,
        recovery_error: Some(message),
    };
    let path = pending_broadcast_path(data_dir, wallet_id).ok()?;
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        #[cfg(windows)]
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let backup = path.with_extension("json.bak");
            match std::fs::read(backup) {
                Ok(bytes) => bytes,
                Err(backup_error)
                    if backup_error.kind() == std::io::ErrorKind::NotFound =>
                {
                    return None;
                }
                Err(backup_error) => {
                    let message = format!(
                        "pending send recovery backup could not be read: {backup_error}"
                    );
                    tracing::error!("{message}");
                    return Some(corrupt(message));
                }
            }
        }
        #[cfg(not(windows))]
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            let message = format!("pending send recovery state could not be read: {error}");
            tracing::error!("{message}");
            return Some(corrupt(message));
        }
    };
    let record: PendingBroadcast = match serde_json::from_slice(&bytes) {
        Ok(record) => record,
        Err(error) => {
            let message = format!("pending send recovery state is invalid: {error}");
            tracing::error!("{message}");
            return Some(corrupt(message));
        }
    };
    let is_creation_intent = record.status == BroadcastStatus::Unknown
        && record.txid == "unavailable"
        && record.txid_bytes.is_empty()
        && record.raw_transaction.is_empty()
        && record.recovery_error.is_some();
    if record.wallet_id != wallet_id
        || (!is_creation_intent
            && (record.txid_bytes.len() != 32 || record.raw_transaction.is_empty()))
    {
        tracing::error!("pending send recovery state failed structural validation");
        return Some(corrupt(
            "pending send recovery state failed structural validation".into(),
        ));
    }
    Some(record)
}

fn persist_pending_broadcast(data_dir: &Path, record: &PendingBroadcast) -> Result<()> {
    let path = pending_broadcast_path(data_dir, &record.wallet_id)?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(record)
        .map_err(|error| Error::DatabaseError(format!("failed to encode pending send: {error}")))?;
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(|error| {
        Error::DatabaseError(format!("failed to create pending send recovery state: {error}"))
    })?;
    file.write_all(&bytes).map_err(|error| {
        Error::DatabaseError(format!("failed to write pending send recovery state: {error}"))
    })?;
    file.sync_all().map_err(|error| {
        Error::DatabaseError(format!("failed to sync pending send recovery state: {error}"))
    })?;
    #[cfg(windows)]
    {
        // Windows rename does not replace an existing file. Preserve the old
        // record as a recovery fallback so there is never a crash window with
        // no durable evidence that a send may have happened.
        let backup = path.with_extension("json.bak");
        if path.exists() {
            match std::fs::remove_file(&backup) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(Error::DatabaseError(format!(
                        "failed to prepare pending send recovery backup: {error}"
                    )));
                }
            }
            std::fs::rename(&path, &backup).map_err(|error| {
                Error::DatabaseError(format!(
                    "failed to preserve pending send recovery backup: {error}"
                ))
            })?;
            if let Err(error) = std::fs::rename(&temporary, &path) {
                let _ = std::fs::rename(&backup, &path);
                return Err(Error::DatabaseError(format!(
                    "failed to commit pending send recovery state: {error}"
                )));
            }
            if let Err(error) = std::fs::remove_file(&backup) {
                tracing::warn!("pending send recovery backup remains after commit: {error}");
            }
        } else {
            std::fs::rename(&temporary, &path).map_err(|error| {
                Error::DatabaseError(format!(
                    "failed to commit pending send recovery state: {error}"
                ))
            })?;
        }
    }
    #[cfg(not(windows))]
    std::fs::rename(&temporary, &path).map_err(|error| {
        Error::DatabaseError(format!("failed to commit pending send recovery state: {error}"))
    })?;
    // On Unix, fsync the directory as well as the file. Without this, a crash
    // after lightwalletd accepts the transaction can lose the directory entry
    // and make the next launch incorrectly believe no send is pending.
    #[cfg(unix)]
    OpenOptions::new()
        .read(true)
        .open(data_dir)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            Error::DatabaseError(format!(
                "failed to sync pending send recovery directory: {error}"
            ))
        })?;
    Ok(())
}

pub(crate) fn clear_pending_broadcast(data_dir: &Path, wallet_id: &str) -> Result<()> {
    let path = pending_broadcast_path(data_dir, wallet_id)?;
    #[cfg(windows)]
    {
        let backup = path.with_extension("json.bak");
        match std::fs::remove_file(backup) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(Error::DatabaseError(format!(
                    "failed to clear pending send recovery backup: {error}"
                )));
            }
        }
    }
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(Error::DatabaseError(format!(
            "failed to clear pending send recovery state: {error}"
        ))),
    }
}

pub(crate) fn ensure_wallet_has_no_unknown_send(data_dir: &Path, wallet_id: &str) -> Result<()> {
    if load_pending_broadcast(data_dir, wallet_id)
        .is_some_and(|pending| pending.status == BroadcastStatus::Unknown)
    {
        Err(Error::SendError(
            "this wallet has a transaction with unknown broadcast status; retry it before deleting the wallet"
                .into(),
        ))
    } else {
        Ok(())
    }
}

impl PendingBroadcast {
    fn public_status(&self) -> PendingSendStatus {
        PendingSendStatus {
            proposal_id: self.proposal_id,
            txid: self.txid.clone(),
            status: self.status,
            message: self.message.clone(),
            recovery_required: self.recovery_error.is_some(),
        }
    }
}

fn invalid_recipient(error: impl Into<String>) -> AddressValidation {
    AddressValidation {
        valid: false,
        address_type: None,
        can_receive_memo: false,
        error: Some(error.into()),
    }
}

fn parse_recipient(
    network: &zcash_protocol::consensus::Network,
    encoded: &str,
) -> Result<(zcash_address::ZcashAddress, AddressValidation)> {
    let parsed = zcash_address::ZcashAddress::try_from_encoded(encoded)
        .map_err(|_| Error::AddressError("invalid Zcash address".into()))?;
    let typed = Address::try_from_zcash_address(network, parsed.clone()).map_err(|error| {
        let message = match error {
            zcash_address::ConversionError::IncorrectNetwork { .. } => {
                "address belongs to a different Zcash network".to_string()
            }
            _ => format!("unsupported recipient address: {error}"),
        };
        Error::AddressError(message)
    })?;

    let (address_type, can_receive_memo) = match &typed {
        Address::Sapling(_) => ("sapling", true),
        Address::Unified(_) => (
            "unified",
            typed.can_receive_as(PoolType::Shielded(ShieldedPool::Sapling))
                || typed.can_receive_as(PoolType::Shielded(ShieldedPool::Orchard))
                || typed.can_receive_as(PoolType::Shielded(ShieldedPool::Ironwood)),
        ),
        Address::Transparent(_) => ("transparent", false),
        // ZIP 320 TEX payments are two-transaction proposals when funded from
        // shielded value. This plugin does not yet have a durable ordered-batch
        // broadcaster, so accepting one would broadcast only half the payment.
        Address::Tex(_) => {
            return Err(Error::AddressError(
                "TEX recipients are not supported until ordered multi-transaction recovery is available"
                    .into(),
            ));
        }
    };

    Ok((
        parsed,
        AddressValidation {
            valid: true,
            address_type: Some(address_type.to_string()),
            can_receive_memo,
            error: None,
        },
    ))
}

/// Validate both the address encoding and the wallet's configured network.
/// A syntactically valid testnet address must never be presented as valid by a
/// mainnet wallet (or vice versa).
pub fn validate_recipient_address(
    network: &zcash_protocol::consensus::Network,
    encoded: &str,
) -> AddressValidation {
    match parse_recipient(network, encoded) {
        Ok((_, validation)) => validation,
        Err(Error::AddressError(message)) => invalid_recipient(message),
        Err(_) => invalid_recipient("invalid Zcash address"),
    }
}

fn require_prover(prover: Option<&LocalTxProver>) -> Result<&LocalTxProver> {
    prover.ok_or_else(|| {
        Error::SendError(
            "Sapling proving parameters are not ready; prepare them before confirming the payment"
                .into(),
        )
    })
}

fn ensure_no_unresolved_broadcast(pending: Option<&PendingBroadcast>) -> Result<()> {
    if pending.is_some_and(|record| record.status == BroadcastStatus::Unknown) {
        Err(Error::SendError(
            "a previously created transaction is not confirmed as broadcast; retry that exact transaction before creating another payment"
                .into(),
        ))
    } else {
        Ok(())
    }
}

/// Commit proposal state only when proposal construction succeeded. Keeping
/// this transition small and deterministic makes it impossible for a rejected
/// proposal to become executable.
fn install_accepted_proposal<T, O, E>(
    slot: &mut Option<T>,
    candidate: std::result::Result<(T, O), E>,
) -> std::result::Result<O, E> {
    match candidate {
        Ok((proposal, output)) => {
            *slot = Some(proposal);
            Ok(output)
        }
        Err(error) => {
            // A previously-reviewed proposal must not remain executable after
            // a newer proposal attempt was rejected.
            *slot = None;
            Err(error)
        }
    }
}

fn classify_broadcast_response(
    txid: String,
    had_ambiguous_attempt: bool,
    response: Option<(i32, String)>,
) -> ExecuteSendResult {
    match response {
        Some((0, _)) => ExecuteSendResult {
            txid,
            status: BroadcastStatus::Accepted,
            message: None,
        },
        Some((code, message)) => {
            let normalized = message.to_ascii_lowercase();
            let already_known = [
                "already known",
                "already in mempool",
                "already in the mempool",
                "already in block chain",
                "already in blockchain",
            ]
            .iter()
            .any(|needle| normalized.contains(needle));
            if already_known {
                ExecuteSendResult {
                    txid,
                    status: BroadcastStatus::Accepted,
                    message: None,
                }
            } else if had_ambiguous_attempt {
                // A completed rejection after an earlier ambiguous attempt
                // cannot prove the earlier attempt was rejected. Never
                // downgrade Unknown to Rejected and invite a replacement send.
                ExecuteSendResult {
                    txid,
                    status: BroadcastStatus::Unknown,
                    message: Some(format!(
                        "The rebroadcast was not accepted (code {code}), but the earlier broadcast may have succeeded. Retry this exact transaction only."
                    )),
                }
            } else {
                ExecuteSendResult {
                    txid,
                    status: BroadcastStatus::Rejected,
                    message: Some(format!("lightwalletd rejected the transaction (code {code})")),
                }
            }
        }
        None => ExecuteSendResult {
            txid,
            status: BroadcastStatus::Unknown,
            message: Some(
                "The transaction was created, but its broadcast status is unknown. Retry this exact transaction; do not create another payment."
                    .into(),
            ),
        },
    }
}

/// Remove corrupt/truncated sapling param files so that `with_default_location()`
/// and `download_sapling_parameters()` don't panic on size verification.
fn clean_corrupt_sapling_params() {
    const EXPECTED_SPEND_BYTES: u64 = 47_958_396;
    const EXPECTED_OUTPUT_BYTES: u64 = 3_592_860;

    let Some(params_dir) = zcash_proofs::default_params_folder() else {
        return;
    };

    for &(name, expected) in &[
        (zcash_proofs::SAPLING_SPEND_NAME, EXPECTED_SPEND_BYTES),
        (zcash_proofs::SAPLING_OUTPUT_NAME, EXPECTED_OUTPUT_BYTES),
    ] {
        let path = params_dir.join(name);
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() != expected {
                tracing::warn!(
                    "removing corrupt {name} ({} bytes, expected {expected})",
                    meta.len()
                );
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

/// Ensure Sapling proving parameters are available, downloading if needed.
pub async fn ensure_sapling_params(state: &WalletState) -> Result<SaplingParamsStatus> {
    // The same mutex also serializes preparation, preventing two UI requests
    // from racing downloads into the same parameter files.
    let mut prover_guard = state.prover.lock().await;
    if prover_guard.is_some() {
        return Ok(SaplingParamsStatus { ready: true });
    }

    // Parameter verification and LocalTxProver construction read and parse
    // roughly 50 MiB. Keep the entire load/download/load sequence off the
    // async runtime so mobile and desktop UI work cannot be starved.
    let prover = tokio::task::spawn_blocking(|| -> Result<LocalTxProver> {
        clean_corrupt_sapling_params();
        if let Some(prover) = LocalTxProver::with_default_location() {
            return Ok(prover);
        }
        zcash_proofs::download_sapling_parameters(Some(300)).map_err(|error| {
            Error::SendError(format!("failed to download Sapling proving parameters: {error}"))
        })?;
        LocalTxProver::with_default_location().ok_or_else(|| {
            Error::SendError("Sapling proving parameters were not found after download".into())
        })
    })
    .await
    .map_err(|error| Error::SendError(format!("parameter preparation task failed: {error}")))??;
    *prover_guard = Some(prover);

    Ok(SaplingParamsStatus { ready: true })
}

/// Propose a send transaction and return the actual ZIP-317 fee.
pub async fn propose_send(
    state: &WalletState,
    to: &str,
    amount: u64,
    memo: Option<&str>,
) -> Result<SendProposal> {
    let _send_operation = state.send_operation.lock().await;
    if !state.is_initialized().await {
        return Err(Error::WalletNotInitialized);
    }
    {
        let pending = state.pending_broadcast.lock().await;
        ensure_no_unresolved_broadcast(pending.as_ref())?;
    }
    *state.pending_proposal.lock().await = None;

    // Parse the recipient and require it to match this wallet's network.
    let (recipient, _) = parse_recipient(&state.network, to)?;

    // Build the payment request
    let zatoshis = Zatoshis::from_u64(amount)
        .map_err(|_| Error::SendError("invalid amount".into()))?;

    let memo_bytes = match memo {
        Some(m) => Some(MemoBytes::from(
            Memo::from_str(m)
                .map_err(|e| Error::SendError(format!("invalid memo: {e}")))?
        )),
        None => None,
    };

    let payment = zip321::Payment::new(
        recipient,
        Some(zatoshis),
        memo_bytes,
        None,
        None,
        vec![],
    )
    .map_err(|e| Error::SendError(format!("failed to create payment: {e:?}")))?;

    let request = zip321::TransactionRequest::new(vec![payment])
        .map_err(|e| Error::SendError(format!("failed to create transaction request: {e:?}")))?;

    // Propose the transfer (no prover needed)
    let mut db_guard = state.db.lock().await;
    let db = db_guard.as_mut().ok_or(Error::WalletNotInitialized)?;

    let account_ids = db
        .get_account_ids()
        .map_err(|e| Error::DatabaseError(format!("{e}")))?;
    let account_id = account_ids
        .first()
        .copied()
        .ok_or(Error::SendError("no accounts found".into()))?;

    let input_selector = GreedyInputSelector::new();
    let change_strategy = SingleOutputChangeStrategy::new(
        zcash_primitives::transaction::fees::zip317::FeeRule::standard(),
        None,
        ShieldedPool::Orchard,
        DustOutputPolicy::default(),
    );

    let policy = ConfirmationsPolicy::default();

    let proposal = propose_transfer::<_, _, _, _, zcash_client_sqlite::wallet::commitment_tree::Error>(
        db,
        &state.network,
        account_id,
        &input_selector,
        &change_strategy,
        request,
        policy,
        &SpendPolicy::default(),
        None,
    )
    .map_err(|e| Error::SendError(format!("failed to propose transfer: {e:?}")));

    drop(db_guard);

    let candidate = proposal.and_then(|proposal| {
        if proposal.steps().len() != 1 {
            return Err(Error::SendError(
                "multi-transaction send proposals are not supported safely".into(),
            ));
        }
        let fee: u64 = proposal
            .steps()
            .iter()
            .map(|s| u64::from(s.balance().fee_required()))
            .sum();
        let id = state.proposal_counter.fetch_add(1, Ordering::Relaxed);
        Ok((
            (id, proposal),
            SendProposal {
                proposal_id: id,
                amount,
                fee,
                total: amount + fee,
            },
        ))
    });
    let mut pending_broadcast = state.pending_broadcast.lock().await;
    ensure_no_unresolved_broadcast(pending_broadcast.as_ref())?;
    let mut proposal_guard = state.pending_proposal.lock().await;
    let result = install_accepted_proposal(&mut *proposal_guard, candidate);
    match result {
        Ok(output) => {
            if let Some(record) = pending_broadcast.as_ref() {
                if let Err(error) = clear_pending_broadcast(&state.data_dir, &record.wallet_id) {
                    *proposal_guard = None;
                    return Err(error);
                }
            }
            *pending_broadcast = None;
            Ok(output)
        }
        Err(error) => Err(error),
    }
}

/// Propose a "send all" transaction — finds the maximum amount after ZIP-317 fee.
pub async fn propose_send_all(
    state: &WalletState,
    to: &str,
    memo: Option<&str>,
) -> Result<SendProposal> {
    let _send_operation = state.send_operation.lock().await;
    if !state.is_initialized().await {
        return Err(Error::WalletNotInitialized);
    }
    {
        let pending = state.pending_broadcast.lock().await;
        ensure_no_unresolved_broadcast(pending.as_ref())?;
    }
    *state.pending_proposal.lock().await = None;

    // Get spendable balance
    let spendable = {
        let db_guard = state.read_db.lock().await;
        let db = db_guard.as_ref().ok_or(Error::WalletNotInitialized)?;
        let policy = ConfirmationsPolicy::default();
        let summary = db
            .get_wallet_summary(policy)
            .map_err(|e| Error::DatabaseError(format!("{e}")))?
            .ok_or(Error::SendError("no wallet summary available".into()))?;
        let account_ids = db
            .get_account_ids()
            .map_err(|e| Error::DatabaseError(format!("{e}")))?;
        let account_id = account_ids
            .first()
            .copied()
            .ok_or(Error::SendError("no accounts found".into()))?;
        let balance = summary
            .account_balances()
            .get(&account_id)
            .ok_or(Error::SendError("no balance for account".into()))?;
        let sapling = balance.sapling_balance();
        let orchard = balance.orchard_balance();
        // Ironwood is a third shielded pool (NU6.3); after activation, Orchard
        // becomes spend-only and new shielded value lands in Ironwood, so it must
        // be counted or the wallet will report a false "insufficient balance".
        let ironwood = balance.ironwood_balance();
        u64::from(sapling.spendable_value())
            + u64::from(orchard.spendable_value())
            + u64::from(ironwood.spendable_value())
    };

    if spendable <= 10000 {
        return Err(Error::SendError("insufficient spendable balance".into()));
    }

    // Parse recipient once and require it to match this wallet's network.
    let (recipient, _) = parse_recipient(&state.network, to)?;

    let memo_bytes = match memo {
        Some(m) => Some(MemoBytes::from(
            Memo::from_str(m)
                .map_err(|e| Error::SendError(format!("invalid memo: {e}")))?
        )),
        None => None,
    };

    // Start with optimistic estimate: spendable - minimum fee
    let mut amount = spendable - 10000;

    for _ in 0..3 {
        let zatoshis = Zatoshis::from_u64(amount)
            .map_err(|_| Error::SendError("invalid amount".into()))?;

        let payment = zip321::Payment::new(
            recipient.clone(),
            Some(zatoshis),
            memo_bytes.clone(),
            None,
            None,
            vec![],
        )
        .map_err(|e| Error::SendError(format!("failed to create payment: {e:?}")))?;

        let request = zip321::TransactionRequest::new(vec![payment])
            .map_err(|e| Error::SendError(format!("failed to create transaction request: {e:?}")))?;

        let mut db_guard = state.db.lock().await;
        let db = db_guard.as_mut().ok_or(Error::WalletNotInitialized)?;

        let account_ids = db
            .get_account_ids()
            .map_err(|e| Error::DatabaseError(format!("{e}")))?;
        let account_id = account_ids
            .first()
            .copied()
            .ok_or(Error::SendError("no accounts found".into()))?;

        let input_selector = GreedyInputSelector::new();
        let change_strategy = SingleOutputChangeStrategy::new(
            zcash_primitives::transaction::fees::zip317::FeeRule::standard(),
            None,
            ShieldedPool::Orchard,
            DustOutputPolicy::default(),
        );

        let policy = ConfirmationsPolicy::default();

        let result = propose_transfer::<_, _, _, _, zcash_client_sqlite::wallet::commitment_tree::Error>(
            db,
            &state.network,
            account_id,
            &input_selector,
            &change_strategy,
            request,
            policy,
            &SpendPolicy::default(),
            None,
        );

        drop(db_guard);

        match result {
            Ok(proposal) => {
                if proposal.steps().len() != 1 {
                    return Err(Error::SendError(
                        "multi-transaction send proposals are not supported safely".into(),
                    ));
                }
                let actual_fee: u64 = proposal
                    .steps()
                    .iter()
                    .map(|s| u64::from(s.balance().fee_required()))
                    .sum();

                if amount + actual_fee <= spendable {
                    // This proposal works — store it
                    let id = state.proposal_counter.fetch_add(1, Ordering::Relaxed);
                    let mut pending_broadcast = state.pending_broadcast.lock().await;
                    ensure_no_unresolved_broadcast(pending_broadcast.as_ref())?;
                    if let Some(record) = pending_broadcast.as_ref() {
                        clear_pending_broadcast(&state.data_dir, &record.wallet_id)?;
                    }
                    *state.pending_proposal.lock().await = Some((id, proposal));
                    *pending_broadcast = None;
                    return Ok(SendProposal {
                        proposal_id: id,
                        amount,
                        fee: actual_fee,
                        total: amount + actual_fee,
                    });
                }

                // Fee was higher than expected — adjust and retry
                amount = spendable - actual_fee;
            }
            Err(zcash_client_backend::data_api::error::Error::InsufficientFunds {
                required, ..
            }) => {
                let required_u64 = u64::from(required);
                let computed_fee = required_u64.saturating_sub(amount);
                if spendable > computed_fee {
                    amount = spendable - computed_fee;
                    continue;
                }
                return Err(Error::SendError(
                    "insufficient funds to cover fee".into(),
                ));
            }
            Err(e) => {
                return Err(Error::SendError(format!(
                    "failed to propose transfer: {e:?}"
                )));
            }
        }
    }

    Err(Error::SendError("could not converge on send-all amount after retries".into()))
}

/// Execute a previously-proposed send transaction.
pub async fn execute_send(
    state: &WalletState,
    proposal_id: u32,
) -> Result<ExecuteSendResult> {
    let _send_operation = state.send_operation.lock().await;
    if !state.is_initialized().await {
        return Err(Error::WalletNotInitialized);
    }
    let wallet_id = state
        .active_wallet_id()
        .await
        .ok_or(Error::WalletNotInitialized)?;

    // Serialize execution and retries. This is intentionally held across the
    // broadcast call: two taps may resend the same bytes, but they must never
    // race into two transaction creations or concurrent RPCs.
    let mut broadcast_guard = state.pending_broadcast.lock().await;

    if let Some(record) = broadcast_guard.as_mut() {
        if record.wallet_id != wallet_id {
            return Err(Error::SendError(
                "pending transaction belongs to a different wallet".into(),
            ));
        }
        if record.proposal_id == proposal_id {
            if record.status != BroadcastStatus::Unknown {
                return Ok(ExecuteSendResult {
                    txid: record.txid.clone(),
                    status: record.status,
                    message: record.message.clone(),
                });
            }

            return broadcast_record(state, record).await;
        }

        ensure_no_unresolved_broadcast(Some(record))?;
        clear_pending_broadcast(&state.data_dir, &record.wallet_id)?;
        *broadcast_guard = None;
    }

    // Fail before consuming the proposal when proving data is unavailable.
    let prover_guard = state.prover.lock().await;
    let prover = require_prover(prover_guard.as_ref())?;

    // Keep the proposal in the slot until transaction creation and local
    // serialization succeed. A rejected creation can therefore be retried;
    // it never advances into the broadcast state.
    let mut prop_guard = state.pending_proposal.lock().await;
    let (stored_id, proposal) = prop_guard
        .as_ref()
        .ok_or(Error::SendError("no pending proposal — call propose_send first".into()))?;

    if *stored_id != proposal_id {
        return Err(Error::SendError("proposal_id mismatch — stale proposal".into()));
    }

    // Derive USK from seed
    let usk = {
        let seed_guard = state.seed.lock().await;
        let seed = seed_guard
            .as_ref()
            .ok_or(Error::Other("seed not available - please restart the wallet".into()))?;
        keys::derive_usk(seed.expose_secret(), &state.network, 0)?
    };

    let mut db_guard = state.db.lock().await;
    let db = db_guard.as_mut().ok_or(Error::WalletNotInitialized)?;

    // Write a fail-closed intent before transaction creation mutates the wallet
    // database. If the process crashes while proving/signing, the next launch
    // must not silently permit a replacement payment.
    let intent = PendingBroadcast {
        wallet_id: wallet_id.clone(),
        proposal_id,
        txid: "unavailable".into(),
        txid_bytes: vec![],
        raw_transaction: vec![],
        status: BroadcastStatus::Unknown,
        message: Some(
            "Transaction creation was interrupted. Inspect wallet history before creating another payment."
                .into(),
        ),
        attempts: 0,
        had_ambiguous_attempt: false,
        recovery_error: Some(
            "Transaction creation was interrupted; automatic rebroadcast is unavailable. Inspect wallet history before creating another payment."
                .into(),
        ),
    };
    persist_pending_broadcast(&state.data_dir, &intent)?;
    *broadcast_guard = Some(intent);

    // Create the transaction
    let spending_keys = SpendingKeys::from_unified_spending_key(usk);

    let mut transaction_created = false;
    let created = (|| -> Result<PendingBroadcast> {
        let txids = create_proposed_transactions::<_, _, std::convert::Infallible, _, std::convert::Infallible, _>(
            db,
            &state.network,
            prover,
            prover,
            &spending_keys,
            OvkPolicy::Sender,
            proposal,
            // `expiry_height: None` keeps the builder-derived expiry for every step.
            None,
        )
        .map_err(|e| Error::SendError(format!("failed to create transaction: {e:?}")))?;
        transaction_created = true;

        // `create_proposed_transactions` returns `NonEmpty<TxId>`.
        let txid = *txids.first();
        let tx = db
            .get_transaction(txid)
            .map_err(|e| Error::SendError(format!("failed to read transaction: {e}")))?
            .ok_or_else(|| {
                Error::SendError("transaction not found in wallet DB after creation".into())
            })?;
        let mut raw_transaction = Vec::new();
        tx.write(&mut raw_transaction)
            .map_err(|e| Error::SendError(format!("failed to serialize transaction: {e}")))?;

        Ok(PendingBroadcast {
            wallet_id: wallet_id.clone(),
            proposal_id,
            txid: format!("{txid}"),
            txid_bytes: txid.as_ref().to_vec(),
            raw_transaction,
            // Until a complete lightwalletd response arrives, delivery is unknown.
            status: BroadcastStatus::Unknown,
            message: None,
            attempts: 0,
            had_ambiguous_attempt: false,
            recovery_error: None,
        })
    })();

    let record = match created {
        Ok(record) => record,
        Err(error) => {
            if transaction_created {
                tracing::error!(
                    "transaction was created but exact recovery bytes could not be prepared; leaving the fail-closed intent in place"
                );
            } else {
                match clear_pending_broadcast(&state.data_dir, &wallet_id) {
                    Ok(()) => *broadcast_guard = None,
                    Err(clear_error) => tracing::error!(
                        "transaction creation failed and its fail-closed intent could not be cleared: {clear_error}"
                    ),
                }
            }
            return Err(error);
        }
    };
    *broadcast_guard = Some(record);
    // Only now is the proposal consumed. From this point on every retry uses
    // the exact serialized transaction stored above.
    *prop_guard = None;

    // Replace the intent with complete retry bytes before any network I/O.
    // If this fails, the in-memory record remains retryable and the durable
    // intent remains fail-closed after restart.
    let record = broadcast_guard
        .as_ref()
        .ok_or_else(|| Error::SendError("internal broadcast state was lost".into()))?;
    persist_pending_broadcast(&state.data_dir, record)?;

    // Drop cryptographic and database locks before network I/O. The broadcast
    // state lock stays held to serialize retries.
    drop(prop_guard);
    drop(db_guard);
    drop(prover_guard);

    let record = broadcast_guard
        .as_mut()
        .ok_or_else(|| Error::SendError("internal broadcast state was lost".into()))?;
    broadcast_record(state, record).await
}

pub async fn get_pending_send(state: &WalletState) -> Result<Option<PendingSendStatus>> {
    let pending = state.pending_broadcast.lock().await;
    Ok(pending.as_ref().map(PendingBroadcast::public_status))
}

pub async fn retry_pending_send(state: &WalletState) -> Result<ExecuteSendResult> {
    let _send_operation = state.send_operation.lock().await;
    if !state.is_initialized().await {
        return Err(Error::WalletNotInitialized);
    }
    let wallet_id = state
        .active_wallet_id()
        .await
        .ok_or(Error::WalletNotInitialized)?;
    let mut pending = state.pending_broadcast.lock().await;
    let record = pending.as_mut().ok_or_else(|| {
        Error::SendError("there is no pending transaction to rebroadcast".into())
    })?;
    if record.wallet_id != wallet_id {
        return Err(Error::SendError(
            "pending transaction belongs to a different wallet".into(),
        ));
    }
    if let Some(error) = &record.recovery_error {
        return Err(Error::SendError(error.clone()));
    }
    if record.status != BroadcastStatus::Unknown {
        return Ok(ExecuteSendResult {
            txid: record.txid.clone(),
            status: record.status,
            message: record.message.clone(),
        });
    }
    broadcast_record(state, record).await
}

pub async fn discard_unrecoverable_send(
    state: &WalletState,
    proposal_id: u32,
    confirmation: &str,
) -> Result<()> {
    const REQUIRED_CONFIRMATION: &str = "I CHECKED WALLET HISTORY";
    let _send_operation = state.send_operation.lock().await;
    if confirmation != REQUIRED_CONFIRMATION {
        return Err(Error::SendError(
            "the unrecoverable-send confirmation phrase did not match".into(),
        ));
    }
    let wallet_id = state
        .active_wallet_id()
        .await
        .ok_or(Error::WalletNotInitialized)?;
    let mut pending = state.pending_broadcast.lock().await;
    let record = pending.as_ref().ok_or_else(|| {
        Error::SendError("there is no unrecoverable pending transaction".into())
    })?;
    if record.wallet_id != wallet_id || record.proposal_id != proposal_id {
        return Err(Error::SendError(
            "pending transaction does not match the active wallet".into(),
        ));
    }
    if record.status != BroadcastStatus::Unknown || record.recovery_error.is_none() {
        return Err(Error::SendError(
            "only an unrecoverable pending-send record can be discarded manually".into(),
        ));
    }
    clear_pending_broadcast(&state.data_dir, &wallet_id)?;
    tracing::warn!(
        wallet_id = %wallet_id,
        proposal_id,
        "operator acknowledged wallet-history review and discarded unrecoverable send state"
    );
    *pending = None;
    *state.pending_proposal.lock().await = None;
    Ok(())
}

fn safe_remote_message(message: &str) -> String {
    message
        .chars()
        .filter(|character| !character.is_control() || character.is_ascii_whitespace())
        .take(240)
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LocalPendingState {
    Pending,
    Mined,
    Expired,
}

async fn local_pending_state(
    state: &WalletState,
    record: &mut PendingBroadcast,
) -> Result<LocalPendingState> {
    let txid_bytes: [u8; 32] = record.txid_bytes.as_slice().try_into().map_err(|_| {
        Error::SendError("pending transaction recovery data has an invalid txid".into())
    })?;
    let txid = TxId::from_bytes(txid_bytes);
    let db_guard = state.read_db.lock().await;
    let db = db_guard.as_ref().ok_or(Error::WalletNotInitialized)?;
    if db
        .get_tx_height(txid)
        .map_err(|error| Error::DatabaseError(format!("failed to read transaction height: {error}")))?
        .is_some()
    {
        return Ok(LocalPendingState::Mined);
    }
    let transaction = db
        .get_transaction(txid)
        .map_err(|error| Error::DatabaseError(format!("failed to read pending transaction: {error}")))?
        .ok_or_else(|| Error::SendError("pending transaction is missing from the wallet database".into()));
    let transaction = match transaction {
        Ok(transaction) => transaction,
        Err(error) => {
            let message =
                "Pending transaction data is missing from the wallet database. Check wallet history before unlocking sends."
                    .to_string();
            record.message = Some(message.clone());
            record.recovery_error = Some(message);
            if let Err(persist_error) = persist_pending_broadcast(&state.data_dir, record) {
                tracing::error!(
                    "failed to persist missing-transaction recovery state: {persist_error}"
                );
            }
            return Err(error);
        }
    };
    let expiry_height = transaction.expiry_height();
    if expiry_height == zcash_protocol::consensus::BlockHeight::from_u32(0) {
        return Ok(LocalPendingState::Pending);
    }
    let fully_scanned = db
        .block_fully_scanned()
        .map_err(|error| Error::DatabaseError(format!("failed to read wallet scan height: {error}")))?
        .map(|metadata| metadata.block_height());
    Ok(if fully_scanned.is_some_and(|height| height >= expiry_height) {
        LocalPendingState::Expired
    } else {
        LocalPendingState::Pending
    })
}

fn apply_broadcast_result(
    state: &WalletState,
    record: &mut PendingBroadcast,
    result: ExecuteSendResult,
) -> ExecuteSendResult {
    record.status = result.status;
    record.message.clone_from(&result.message);
    let persistence = if result.status == BroadcastStatus::Accepted {
        clear_pending_broadcast(&state.data_dir, &record.wallet_id)
    } else {
        persist_pending_broadcast(&state.data_dir, record)
    };
    if let Err(error) = persistence {
        // The in-memory state remains fail-closed for this process. Never turn
        // a post-broadcast persistence problem into a retry that re-signs.
        tracing::error!("failed to update pending send recovery state: {error}");
    }
    result
}

async fn broadcast_record(
    state: &WalletState,
    record: &mut PendingBroadcast,
) -> Result<ExecuteSendResult> {
    if let Some(error) = &record.recovery_error {
        return Err(Error::SendError(error.clone()));
    }

    if local_pending_state(state, record).await? == LocalPendingState::Mined {
        return Ok(apply_broadcast_result(
            state,
            record,
            ExecuteSendResult {
                txid: record.txid.clone(),
                status: BroadcastStatus::Accepted,
                message: None,
            },
        ));
    }

    if let Err(error) = persist_pending_broadcast(&state.data_dir, record) {
        tracing::error!("refusing to broadcast without durable recovery state: {error}");
        let result = ExecuteSendResult {
            txid: record.txid.clone(),
            status: BroadcastStatus::Unknown,
            message: Some(
                "The transaction was created but recovery state could not be saved, so it was not broadcast. Keep the app open and retry this exact transaction."
                    .into(),
            ),
        };
        record.status = result.status;
        record.message.clone_from(&result.message);
        return Ok(result);
    }

    let url = state.lightwalletd_url.read().await.clone();
    let mut client = match tokio::time::timeout(CONNECT_TIMEOUT, connect_to_lightwalletd(&url)).await {
        Ok(Ok(client)) => client,
        Ok(Err(error)) => {
            tracing::warn!("pending send could not connect to lightwalletd: {error}");
            return Ok(apply_broadcast_result(
                state,
                record,
                classify_broadcast_response(
                    record.txid.clone(),
                    record.had_ambiguous_attempt,
                    None,
                ),
            ));
        }
        Err(_) => {
            tracing::warn!("pending send lightwalletd connection timed out");
            return Ok(apply_broadcast_result(
                state,
                record,
                classify_broadcast_response(
                    record.txid.clone(),
                    record.had_ambiguous_attempt,
                    None,
                ),
            ));
        }
    };

    if record.attempts > 0 {
        let lookup = tokio::time::timeout(
            RPC_TIMEOUT,
            client.get_transaction(TxFilter {
                block: None,
                index: 0,
                hash: record.txid_bytes.clone(),
            }),
        )
        .await;
        match lookup {
            Ok(Ok(_)) => {
                return Ok(apply_broadcast_result(
                    state,
                    record,
                    ExecuteSendResult {
                        txid: record.txid.clone(),
                        status: BroadcastStatus::Accepted,
                        message: None,
                    },
                ));
            }
            Ok(Err(status)) if status.code() == tonic::Code::NotFound => {
                if local_pending_state(state, record).await? == LocalPendingState::Expired {
                    return Ok(apply_broadcast_result(
                        state,
                        record,
                        ExecuteSendResult {
                            txid: record.txid.clone(),
                            status: BroadcastStatus::Rejected,
                            message: Some(
                                "The transaction was not found and the wallet has scanned beyond its expiry height. It is safe to create a new payment."
                                    .into(),
                            ),
                        },
                    ));
                }
            }
            Ok(Err(status)) => tracing::warn!(
                code = ?status.code(),
                "pending send txid lookup failed; rebroadcasting identical bytes"
            ),
            Err(_) => tracing::warn!(
                "pending send txid lookup timed out; rebroadcasting identical bytes"
            ),
        }
    }

    let ambiguity_before_attempt = record.had_ambiguous_attempt;
    // Persist pessimistically before entering the RPC. A process crash during
    // `send_transaction` is itself ambiguous and must survive restart.
    record.had_ambiguous_attempt = true;
    record.attempts = record.attempts.saturating_add(1);
    if let Err(error) = persist_pending_broadcast(&state.data_dir, record) {
        record.had_ambiguous_attempt = ambiguity_before_attempt;
        tracing::error!("refusing to broadcast without durable attempt state: {error}");
        return Ok(apply_broadcast_result(
            state,
            record,
            classify_broadcast_response(
                record.txid.clone(),
                record.had_ambiguous_attempt,
                None,
            ),
        ));
    }

    let response = match tokio::time::timeout(
        RPC_TIMEOUT,
        client.send_transaction(RawTransaction {
            data: record.raw_transaction.clone(),
            height: 0,
        }),
    )
    .await
    {
        Ok(Ok(response)) => {
            let response = response.into_inner();
            if response.error_code != 0 {
                tracing::warn!(
                    error_code = response.error_code,
                    error_message = %safe_remote_message(&response.error_message),
                    "lightwalletd rejected a transaction broadcast"
                );
            }
            Some((response.error_code, response.error_message))
        }
        Ok(Err(status)) => {
            tracing::warn!(code = ?status.code(), "transaction broadcast response was ambiguous");
            None
        }
        Err(_) => {
            tracing::warn!("transaction broadcast timed out with ambiguous status");
            None
        }
    };

    if response.is_some() {
        // A complete RPC response removes only the pessimism introduced for
        // this attempt; ambiguity from any earlier attempt remains sticky.
        record.had_ambiguous_attempt = ambiguity_before_attempt;
    }
    Ok(apply_broadcast_result(
        state,
        record,
        classify_broadcast_response(
            record.txid.clone(),
            record.had_ambiguous_attempt,
            response,
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use zcash_protocol::consensus::Network;

    const MAINNET_TADDR: &str = "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs";
    const TESTNET_TADDR: &str = "tm9iMLAuYMzJ6jtFLcA7rzUmfreGuKvr7Ma";
    const MAINNET_TEX: &str = "tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte";

    fn pending(status: BroadcastStatus) -> PendingBroadcast {
        PendingBroadcast {
            wallet_id: "wallet_test".into(),
            proposal_id: 7,
            txid: "00".repeat(32),
            txid_bytes: vec![0; 32],
            raw_transaction: vec![1, 2, 3, 4],
            status,
            message: None,
            attempts: 0,
            had_ambiguous_attempt: false,
            recovery_error: None,
        }
    }

    #[test]
    fn no_prover_fails_before_execution() {
        let error = match require_prover(None) {
            Ok(_) => panic!("missing prover must fail closed"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("proving parameters are not ready"));
    }

    #[test]
    fn wrong_network_address_is_rejected() {
        let validation = validate_recipient_address(&Network::MainNetwork, TESTNET_TADDR);
        assert!(!validation.valid);
        assert_eq!(
            validation.error.as_deref(),
            Some("address belongs to a different Zcash network")
        );

        let mainnet = validate_recipient_address(&Network::MainNetwork, MAINNET_TADDR);
        assert!(mainnet.valid);
        assert_eq!(mainnet.address_type.as_deref(), Some("transparent"));
    }

    #[test]
    fn tex_is_rejected_until_ordered_batch_recovery_exists() {
        let validation = validate_recipient_address(&Network::MainNetwork, MAINNET_TEX);
        assert!(!validation.valid);
        assert!(validation.error.as_deref().is_some_and(|message| {
            message.contains("ordered multi-transaction recovery")
        }));
    }

    #[test]
    fn rejected_proposal_never_replaces_executable_state() {
        let mut slot = Some("existing");
        let rejected: std::result::Result<(&str, ()), &str> = Err("rejected");
        assert_eq!(
            install_accepted_proposal(&mut slot, rejected),
            Err("rejected")
        );
        assert_eq!(slot, None);
    }

    #[test]
    fn broadcast_success_is_explicit() {
        let result =
            classify_broadcast_response("txid".into(), false, Some((0, String::new())));
        assert_eq!(result.status, BroadcastStatus::Accepted);
        assert_eq!(result.txid, "txid");
        assert_eq!(result.message, None);
    }

    #[test]
    fn broadcast_rejection_is_explicit_and_remote_text_is_not_echoed() {
        let result = classify_broadcast_response(
            "txid".into(),
            false,
            Some((16, "remote detail that must not reach logs or UI".into())),
        );
        assert_eq!(result.status, BroadcastStatus::Rejected);
        assert_eq!(
            result.message.as_deref(),
            Some("lightwalletd rejected the transaction (code 16)")
        );
    }

    #[test]
    fn ambiguous_broadcast_blocks_new_proposal_and_preserves_retry_bytes() {
        let record = pending(BroadcastStatus::Unknown);
        let original_bytes = record.raw_transaction.clone();
        assert!(ensure_no_unresolved_broadcast(Some(&record)).is_err());

        let result = classify_broadcast_response(record.txid.clone(), true, None);
        assert_eq!(result.status, BroadcastStatus::Unknown);
        assert_eq!(record.raw_transaction, original_bytes);
        assert!(result
            .message
            .as_deref()
            .is_some_and(|message| message.contains("exact transaction")));
    }

    #[test]
    fn accepted_broadcast_allows_next_proposal() {
        let record = pending(BroadcastStatus::Accepted);
        assert!(ensure_no_unresolved_broadcast(Some(&record)).is_ok());
    }

    #[test]
    fn definite_rejection_allows_a_new_proposal() {
        let record = pending(BroadcastStatus::Rejected);
        assert!(ensure_no_unresolved_broadcast(Some(&record)).is_ok());
    }

    #[test]
    fn ambiguous_retry_never_downgrades_to_rejected() {
        let result = classify_broadcast_response(
            "txid".into(),
            true,
            Some((-26, "txn-mempool-conflict".into())),
        );
        assert_eq!(result.status, BroadcastStatus::Unknown);
    }

    #[test]
    fn definite_rejection_does_not_become_ambiguous_on_retry() {
        let result = classify_broadcast_response(
            "txid".into(),
            false,
            Some((-26, "bad-txns-inputs-spent".into())),
        );
        assert_eq!(result.status, BroadcastStatus::Rejected);
    }

    #[test]
    fn already_known_retry_is_accepted() {
        let result = classify_broadcast_response(
            "txid".into(),
            true,
            Some((-27, "transaction already in block chain".into())),
        );
        assert_eq!(result.status, BroadcastStatus::Accepted);
    }

    #[test]
    fn pending_broadcast_survives_state_reconstruction() {
        let directory = std::env::temp_dir().join(format!(
            "zuuli-pending-send-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).expect("create test directory");
        let mut record = pending(BroadcastStatus::Unknown);
        record.attempts = 1;
        persist_pending_broadcast(&directory, &record).expect("persist recovery state");

        let loaded = load_pending_broadcast(&directory, &record.wallet_id)
            .expect("load recovery state");
        assert_eq!(loaded.status, BroadcastStatus::Unknown);
        assert_eq!(loaded.attempts, 1);
        assert_eq!(loaded.raw_transaction, record.raw_transaction);
        assert!(ensure_no_unresolved_broadcast(Some(&loaded)).is_err());

        clear_pending_broadcast(&directory, &record.wallet_id).expect("clear recovery state");
        std::fs::remove_dir(&directory).expect("remove test directory");
    }

    #[test]
    fn corrupt_recovery_state_fails_closed() {
        let directory = std::env::temp_dir().join(format!(
            "zuuli-pending-send-corrupt-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).expect("create test directory");
        let wallet_id = "wallet_test";
        std::fs::write(
            pending_broadcast_path(&directory, wallet_id).expect("recovery path"),
            b"not-json",
        )
        .expect("write corrupt recovery state");

        let loaded = load_pending_broadcast(&directory, wallet_id)
            .expect("corrupt state must remain represented");
        assert_eq!(loaded.status, BroadcastStatus::Unknown);
        assert!(loaded.recovery_error.is_some());
        assert!(ensure_no_unresolved_broadcast(Some(&loaded)).is_err());

        clear_pending_broadcast(&directory, wallet_id).expect("clear recovery state");
        std::fs::remove_dir(&directory).expect("remove test directory");
    }

    #[test]
    fn interrupted_creation_intent_fails_closed_after_restart() {
        let directory = std::env::temp_dir().join(format!(
            "zuuli-pending-send-intent-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).expect("create test directory");
        let mut intent = pending(BroadcastStatus::Unknown);
        intent.txid = "unavailable".into();
        intent.txid_bytes.clear();
        intent.raw_transaction.clear();
        intent.recovery_error = Some("transaction creation was interrupted".into());
        persist_pending_broadcast(&directory, &intent).expect("persist send intent");

        let loaded = load_pending_broadcast(&directory, &intent.wallet_id)
            .expect("intent must remain represented");
        assert_eq!(loaded.status, BroadcastStatus::Unknown);
        assert!(loaded.recovery_error.is_some());
        assert_eq!(loaded.proposal_id, intent.proposal_id);
        assert!(loaded.public_status().recovery_required);
        assert!(ensure_no_unresolved_broadcast(Some(&loaded)).is_err());

        clear_pending_broadcast(&directory, &intent.wallet_id).expect("clear send intent");
        std::fs::remove_dir(&directory).expect("remove test directory");
    }
}
