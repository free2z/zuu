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
use zcash_client_backend::proto::service::RawTransaction;
use zcash_client_backend::wallet::OvkPolicy;
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::memo::{Memo, MemoBytes};
use zcash_protocol::value::Zatoshis;
use zcash_protocol::ShieldedProtocol;

use crate::error::{Error, Result};
use crate::wallet::client::connect_to_lightwalletd;
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

    // Derive USK from seed, then drop the seed lock immediately (M2)
    let usk = {
        let seed_guard = state.seed.lock().await;
        let seed = seed_guard
            .as_ref()
            .ok_or(Error::Other("seed not available - please restart the wallet".into()))?;
        keys::derive_usk(seed.expose_secret(), &state.network, 0)?
    };
    // seed_guard dropped here — seed mutex released

    // Parse the recipient address
    let recipient = zcash_address::ZcashAddress::try_from_encoded(to)
        .map_err(|e| Error::AddressError(format!("invalid address: {e}")))?;

    // Build the payment request
    let zatoshis = Zatoshis::from_u64(amount)
        .map_err(|_| Error::SendError("invalid amount".into()))?;

    // Parse memo with proper error propagation (M4)
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

    // Load prover before acquiring the DB lock — pure I/O, no DB dependency (M1)
    let prover = LocalTxProver::with_default_location()
        .ok_or(Error::SendError("sapling parameters not found - please download them first".into()))?;

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

    // Drop the DB lock before making the network call
    drop(db_guard);

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
