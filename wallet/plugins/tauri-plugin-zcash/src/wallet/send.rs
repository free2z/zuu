use std::str::FromStr;
use std::sync::atomic::Ordering;

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
use zcash_client_backend::proto::service::RawTransaction;
use zcash_client_backend::wallet::OvkPolicy;
use zcash_keys::address::Address;
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::PoolType;
use zcash_protocol::memo::{Memo, MemoBytes};
use zcash_protocol::value::Zatoshis;
use zcash_protocol::ShieldedPool;

use crate::error::{Error, Result};
use crate::models::{
    AddressValidation, BroadcastStatus, ExecuteSendResult, SaplingParamsStatus, SendProposal,
};
use crate::wallet::client::connect_to_lightwalletd;
use crate::wallet::keys;
use crate::wallet::WalletState;

/// A transaction that has already been created in the wallet database.
/// Retrying this record always rebroadcasts `raw_transaction`; it never signs
/// or creates another transaction for the same proposal.
pub struct PendingBroadcast {
    proposal_id: u32,
    txid: String,
    raw_transaction: Vec<u8>,
    status: BroadcastStatus,
    message: Option<String>,
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
        Address::Tex(_) => ("tex", false),
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
    response: Option<(i32, String)>,
) -> ExecuteSendResult {
    match response {
        Some((0, _)) => ExecuteSendResult {
            txid,
            status: BroadcastStatus::Accepted,
            message: None,
        },
        Some((code, _)) => ExecuteSendResult {
            txid,
            status: BroadcastStatus::Rejected,
            // The remote error string is intentionally not echoed. It is
            // untrusted server text and may contain endpoint-specific detail.
            message: Some(format!("lightwalletd rejected the transaction (code {code})")),
        },
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
    // Fast path: already cached
    {
        let guard = state.prover.lock().await;
        if guard.is_some() {
            return Ok(SaplingParamsStatus { ready: true });
        }
    }

    // Remove corrupt/truncated files before attempting to load (prevents panics)
    clean_corrupt_sapling_params();

    // Try loading from default location
    if let Some(prover) = LocalTxProver::with_default_location() {
        *state.prover.lock().await = Some(prover);
        return Ok(SaplingParamsStatus { ready: true });
    }

    // Download parameters (blocking I/O — run on blocking thread pool)
    tokio::task::spawn_blocking(|| {
        zcash_proofs::download_sapling_parameters(Some(300))
    })
    .await
    .map_err(|e| Error::SendError(format!("parameter download task panicked: {e}")))?
    .map_err(|e| Error::SendError(format!("failed to download sapling parameters: {e}")))?;

    // Load after download
    let prover = LocalTxProver::with_default_location()
        .ok_or(Error::SendError("sapling parameters not found after download".into()))?;
    *state.prover.lock().await = Some(prover);

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

    let candidate = proposal.map(|proposal| {
        let fee: u64 = proposal
            .steps()
            .iter()
            .map(|s| u64::from(s.balance().fee_required()))
            .sum();
        let id = state.proposal_counter.fetch_add(1, Ordering::Relaxed);
        (
            (id, proposal),
            SendProposal {
                proposal_id: id,
                amount,
                fee,
                total: amount + fee,
            },
        )
    });
    let mut pending_broadcast = state.pending_broadcast.lock().await;
    ensure_no_unresolved_broadcast(pending_broadcast.as_ref())?;
    let mut proposal_guard = state.pending_proposal.lock().await;
    let result = install_accepted_proposal(&mut *proposal_guard, candidate);
    if result.is_ok() {
        // A successfully reviewed replacement retires any accepted or
        // definitively-rejected retry record. Its old proposal ID can no
        // longer rebroadcast after this point.
        *pending_broadcast = None;
    }
    result
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

    // Serialize execution and retries. This is intentionally held across the
    // broadcast call: two taps may resend the same bytes, but they must never
    // race into two transaction creations or concurrent RPCs.
    let mut broadcast_guard = state.pending_broadcast.lock().await;

    if let Some(record) = broadcast_guard.as_mut() {
        if record.proposal_id == proposal_id {
            if record.status == BroadcastStatus::Accepted {
                return Ok(ExecuteSendResult {
                    txid: record.txid.clone(),
                    status: record.status,
                    message: record.message.clone(),
                });
            }

            return broadcast_record(state, record).await;
        }

        ensure_no_unresolved_broadcast(Some(record))?;
        // An accepted older record no longer needs to occupy the retry slot.
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

    // Create the transaction
    let mut db_guard = state.db.lock().await;
    let db = db_guard.as_mut().ok_or(Error::WalletNotInitialized)?;

    let spending_keys = SpendingKeys::from_unified_spending_key(usk);

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

    // Get the txid
    let txid = *txids.first();

    // Fetch the raw transaction from the wallet DB
    let tx = db
        .get_transaction(txid)
        .map_err(|e| Error::SendError(format!("failed to read transaction: {e}")))?
        .ok_or_else(|| Error::SendError("transaction not found in wallet DB after creation".into()))?;

    // Serialize the transaction to raw bytes
    let mut raw_tx = Vec::new();
    tx.write(&mut raw_tx)
        .map_err(|e| Error::SendError(format!("failed to serialize transaction: {e}")))?;

    let txid_hex = format!("{txid}");
    *broadcast_guard = Some(PendingBroadcast {
        proposal_id,
        txid: txid_hex,
        raw_transaction: raw_tx,
        // Until a complete lightwalletd response arrives, delivery is unknown.
        status: BroadcastStatus::Unknown,
        message: None,
    });
    // Only now is the proposal consumed. From this point on every retry uses
    // the exact serialized transaction stored above.
    *prop_guard = None;

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

async fn broadcast_record(
    state: &WalletState,
    record: &mut PendingBroadcast,
) -> Result<ExecuteSendResult> {
    let url = state.lightwalletd_url.read().await.clone();
    let response = match connect_to_lightwalletd(&url).await {
        Ok(mut client) => client
            .send_transaction(RawTransaction {
                data: record.raw_transaction.clone(),
                height: 0,
            })
            .await
            .ok()
            .map(|response| {
                let response = response.into_inner();
                (response.error_code, response.error_message)
            }),
        Err(_) => None,
    };

    let result = classify_broadcast_response(record.txid.clone(), response);
    record.status = result.status;
    record.message.clone_from(&result.message);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zcash_protocol::consensus::Network;

    const MAINNET_TADDR: &str = "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs";
    const TESTNET_TADDR: &str = "tm9iMLAuYMzJ6jtFLcA7rzUmfreGuKvr7Ma";

    fn pending(status: BroadcastStatus) -> PendingBroadcast {
        PendingBroadcast {
            proposal_id: 7,
            txid: "00".repeat(32),
            raw_transaction: vec![1, 2, 3, 4],
            status,
            message: None,
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
        let result = classify_broadcast_response("txid".into(), Some((0, String::new())));
        assert_eq!(result.status, BroadcastStatus::Accepted);
        assert_eq!(result.txid, "txid");
        assert_eq!(result.message, None);
    }

    #[test]
    fn broadcast_rejection_is_explicit_and_remote_text_is_not_echoed() {
        let result = classify_broadcast_response(
            "txid".into(),
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

        let result = classify_broadcast_response(record.txid.clone(), None);
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
}
