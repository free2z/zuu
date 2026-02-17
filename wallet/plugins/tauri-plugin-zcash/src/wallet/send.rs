use std::str::FromStr;

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
use zcash_client_backend::wallet::OvkPolicy;
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::memo::{Memo, MemoBytes};
use zcash_protocol::value::Zatoshis;
use zcash_protocol::ShieldedProtocol;

use crate::error::{Error, Result};
use crate::wallet::keys;
use crate::wallet::WalletState;

/// Send a transaction to the specified address.
pub async fn send_transaction(
    state: &WalletState,
    to: &str,
    amount: u64,
    memo: Option<&str>,
) -> Result<String> {
    if !state.is_initialized().await {
        return Err(Error::WalletNotInitialized);
    }

    // Get seed for signing
    let seed_guard = state.seed.lock().await;
    let seed = seed_guard
        .as_ref()
        .ok_or(Error::Other("seed not available - please restart the wallet".into()))?;

    // Derive USK for account 0
    let usk = keys::derive_usk(seed.expose_secret(), &state.network, 0)?;

    // Parse the recipient address
    let recipient = zcash_address::ZcashAddress::try_from_encoded(to)
        .map_err(|e| Error::AddressError(format!("invalid address: {e}")))?;

    // Build the payment request
    let zatoshis = Zatoshis::from_u64(amount)
        .map_err(|_| Error::SendError("invalid amount".into()))?;

    let memo_bytes = memo.map(|m| {
        MemoBytes::from(
            Memo::from_str(m).unwrap_or(Memo::Empty)
        )
    });

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

    // Propose the transfer
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

    // Create the transaction
    let prover = LocalTxProver::with_default_location()
        .ok_or(Error::SendError("sapling parameters not found - please download them first".into()))?;

    let spending_keys = SpendingKeys::from_unified_spending_key(usk);

    let txids = create_proposed_transactions::<_, _, std::convert::Infallible, _, std::convert::Infallible, _>(
        db,
        &state.network,
        &prover,
        &prover,
        &spending_keys,
        OvkPolicy::Sender,
        &proposal,
    )
    .map_err(|e| Error::SendError(format!("failed to create transaction: {e:?}")))?;

    // Get the txid
    let txid = txids.first();

    // TODO: Broadcast the transaction via lightwalletd
    // For now, just return the txid - the transaction is stored locally
    let txid_hex = format!("{}", txid);

    Ok(txid_hex)
}
