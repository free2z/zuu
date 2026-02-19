use std::str::FromStr;
use std::sync::atomic::Ordering;

use secrecy::ExposeSecret;
use zcash_client_backend::data_api::wallet::{
    create_proposed_transactions,
    input_selection::GreedyInputSelector,
    propose_transfer,
    ConfirmationsPolicy, SpendingKeys,
};
use zcash_client_backend::data_api::WalletRead;
use zcash_client_backend::fees::zip317::SingleOutputChangeStrategy;
use zcash_client_backend::fees::DustOutputPolicy;
use zcash_client_backend::proto::service::RawTransaction;
use zcash_client_backend::wallet::OvkPolicy;
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::memo::{Memo, MemoBytes};
use zcash_protocol::value::Zatoshis;
use zcash_protocol::ShieldedProtocol;

use crate::error::{Error, Result};
use crate::models::{SaplingParamsStatus, SendProposal};
use crate::wallet::client::connect_to_lightwalletd;
use crate::wallet::keys;
use crate::wallet::WalletState;

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
    if !state.is_initialized().await {
        return Err(Error::WalletNotInitialized);
    }

    // Parse the recipient address
    let recipient = zcash_address::ZcashAddress::try_from_encoded(to)
        .map_err(|e| Error::AddressError(format!("invalid address: {e}")))?;

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
    .ok_or(Error::SendError("failed to create payment".into()))?;

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
        ShieldedProtocol::Orchard,
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
    )
    .map_err(|e| Error::SendError(format!("failed to propose transfer: {e:?}")))?;

    drop(db_guard);

    // Extract fee from proposal
    let fee: u64 = proposal
        .steps()
        .iter()
        .map(|s| u64::from(s.balance().fee_required()))
        .sum();

    // Store proposal
    let id = state.proposal_counter.fetch_add(1, Ordering::Relaxed);
    *state.pending_proposal.lock().await = Some((id, proposal));

    Ok(SendProposal {
        proposal_id: id,
        amount,
        fee,
        total: amount + fee,
    })
}

/// Propose a "send all" transaction — finds the maximum amount after ZIP-317 fee.
pub async fn propose_send_all(
    state: &WalletState,
    to: &str,
    memo: Option<&str>,
) -> Result<SendProposal> {
    if !state.is_initialized().await {
        return Err(Error::WalletNotInitialized);
    }

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
        u64::from(sapling.spendable_value()) + u64::from(orchard.spendable_value())
    };

    if spendable <= 10000 {
        return Err(Error::SendError("insufficient spendable balance".into()));
    }

    // Parse recipient once
    let recipient = zcash_address::ZcashAddress::try_from_encoded(to)
        .map_err(|e| Error::AddressError(format!("invalid address: {e}")))?;

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
        .ok_or(Error::SendError("failed to create payment".into()))?;

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
            ShieldedProtocol::Orchard,
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
                    *state.pending_proposal.lock().await = Some((id, proposal));
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
) -> Result<String> {
    if !state.is_initialized().await {
        return Err(Error::WalletNotInitialized);
    }

    // Get prover
    let prover_guard = state.prover.lock().await;
    let prover = prover_guard
        .as_ref()
        .ok_or(Error::SendError("sapling parameters not loaded — call ensure_sapling_params first".into()))?;

    // Take proposal
    let mut prop_guard = state.pending_proposal.lock().await;
    let (stored_id, proposal) = prop_guard
        .take()
        .ok_or(Error::SendError("no pending proposal — call propose_send first".into()))?;
    drop(prop_guard);

    if stored_id != proposal_id {
        // Put it back
        *state.pending_proposal.lock().await = Some((stored_id, proposal));
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
        &proposal,
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

    // Drop locks before network call
    drop(db_guard);
    drop(prover_guard);

    // Connect to lightwalletd and broadcast
    let url = state.lightwalletd_url.read().await.clone();
    let mut client = connect_to_lightwalletd(&url).await?;

    let response = client
        .send_transaction(RawTransaction {
            data: raw_tx,
            height: 0,
        })
        .await
        .map_err(|e| Error::SendError(format!("broadcast failed: {e}")))?
        .into_inner();

    if response.error_code != 0 {
        return Err(Error::SendError(format!(
            "broadcast rejected (code {}): {}",
            response.error_code, response.error_message
        )));
    }

    let txid_hex = format!("{}", txid);
    Ok(txid_hex)
}
