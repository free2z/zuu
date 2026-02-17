use tauri::{command, AppHandle, Runtime};

use zcash_client_backend::data_api::{AccountBirthday, BirthdayError, WalletRead, WalletWrite};
use zcash_client_backend::data_api::wallet::ConfirmationsPolicy;
use zcash_client_backend::proto::service::BlockId;
use zcash_keys::keys::UnifiedAddressRequest;

use crate::error::Error;
use crate::models::*;
use crate::wallet::client::connect_to_lightwalletd;
use crate::wallet::keys;
use crate::wallet::storage::init_wallet_db;
use crate::{Result, ZcashExt};

fn format_birthday_error(e: BirthdayError) -> String {
    match e {
        BirthdayError::HeightInvalid(e) => format!("invalid height: {e}"),
        BirthdayError::Decode(e) => format!("decode error: {e}"),
    }
}

#[command]
pub(crate) async fn create_wallet<R: Runtime>(
    app: AppHandle<R>,
    args: CreateWalletArgs,
) -> Result<WalletCreated> {
    let zcash = app.zcash();
    let word_count = args.mnemonic_word_count.unwrap_or(24);

    let mnemonic = keys::generate_mnemonic(word_count)?;
    let seed = keys::mnemonic_to_seed(&mnemonic);

    // Connect to lightwalletd and get current chain tip
    let url = zcash.state.lightwalletd_url.read().await.clone();
    let mut client = connect_to_lightwalletd(&url).await?;

    let tip = client
        .get_latest_block(zcash_client_backend::proto::service::ChainSpec::default())
        .await
        .map_err(|e| Error::NetworkError(format!("failed to get chain tip: {e}")))?
        .into_inner();
    let tip_height = tip.height as u64;

    // Get tree state at tip for birthday
    let tree_state = client
        .get_tree_state(BlockId {
            height: tip_height,
            hash: vec![],
        })
        .await
        .map_err(|e| Error::NetworkError(format!("failed to get tree state: {e}")))?
        .into_inner();

    let birthday = AccountBirthday::from_treestate(tree_state, None)
        .map_err(|e| Error::DatabaseError(format!("failed to create birthday: {}", format_birthday_error(e))))?;

    // Initialize database
    let db = init_wallet_db(&zcash.state.db_path, zcash.state.network)?;

    // Store DB in state
    *zcash.state.db.lock().await = Some(db);

    // Import the first account
    {
        let mut db_guard = zcash.state.db.lock().await;
        let db = db_guard
            .as_mut()
            .ok_or(Error::WalletNotInitialized)?;
        let (_account_id, _usk) = db
            .create_account("Default", &seed, &birthday, None)
            .map_err(|e| Error::DatabaseError(format!("failed to create account: {e}")))?;
    }

    // Store seed in memory for the session
    *zcash.state.seed.lock().await = Some(seed);

    // Auto-start sync
    let _ = crate::wallet::sync::start_sync(app.clone(), &zcash.state).await;

    Ok(WalletCreated {
        seed_phrase: mnemonic.phrase().to_string(),
        birthday_height: tip_height,
    })
}

#[command]
pub(crate) async fn restore_wallet<R: Runtime>(
    app: AppHandle<R>,
    args: RestoreWalletArgs,
) -> Result<serde_json::Value> {
    let zcash = app.zcash();
    let mnemonic = keys::parse_mnemonic(&args.seed_phrase)?;
    let seed = keys::mnemonic_to_seed(&mnemonic);
    let birthday_height = args.birthday_height.unwrap_or(419200); // sapling activation

    // Connect to lightwalletd
    let url = zcash.state.lightwalletd_url.read().await.clone();
    let mut client = connect_to_lightwalletd(&url).await?;

    // Get chain tip for recover_until
    let tip = client
        .get_latest_block(zcash_client_backend::proto::service::ChainSpec::default())
        .await
        .map_err(|e| Error::NetworkError(format!("failed to get chain tip: {e}")))?
        .into_inner();
    let chain_tip = tip.height as u64;

    // Get tree state at birthday height for the birthday
    let tree_height = if birthday_height > 0 {
        birthday_height
    } else {
        419200 // sapling activation on mainnet
    };

    let tree_state = client
        .get_tree_state(BlockId {
            height: tree_height,
            hash: vec![],
        })
        .await
        .map_err(|e| Error::NetworkError(format!("failed to get tree state: {e}")))?
        .into_inner();

    let recover_until = zcash_protocol::consensus::BlockHeight::from_u32(chain_tip as u32);
    let birthday = AccountBirthday::from_treestate(tree_state, Some(recover_until))
        .map_err(|e| Error::DatabaseError(format!("failed to create birthday: {}", format_birthday_error(e))))?;

    // Initialize database
    let db = init_wallet_db(&zcash.state.db_path, zcash.state.network)?;
    *zcash.state.db.lock().await = Some(db);

    // Import account with recovery
    {
        let mut db_guard = zcash.state.db.lock().await;
        let db = db_guard
            .as_mut()
            .ok_or(Error::WalletNotInitialized)?;
        let (_account_id, _usk) = db
            .create_account("Default", &seed, &birthday, None)
            .map_err(|e| Error::DatabaseError(format!("failed to create account: {e}")))?;
    }

    // Store seed in memory
    *zcash.state.seed.lock().await = Some(seed);

    // Auto-start sync
    let _ = crate::wallet::sync::start_sync(app.clone(), &zcash.state).await;

    Ok(serde_json::json!({ "success": true }))
}

#[command]
pub(crate) async fn get_wallet_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<WalletStatus> {
    let zcash = app.zcash();
    let initialized = zcash.state.is_initialized().await;

    let (synced_height, chain_tip) = if initialized {
        let db_guard = zcash.state.db.lock().await;
        if let Some(db) = db_guard.as_ref() {
            let height = db.chain_height().ok().flatten().map(|h| u64::from(u32::from(h)));
            (height, None)
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };

    Ok(WalletStatus {
        initialized,
        synced_height,
        chain_tip,
    })
}

#[command]
pub(crate) async fn create_account<R: Runtime>(
    app: AppHandle<R>,
) -> Result<AccountInfo> {
    let zcash = app.zcash();
    crate::wallet::accounts::create_account(&zcash.state).await
}

#[command]
pub(crate) async fn list_accounts<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<AccountInfo>> {
    let zcash = app.zcash();
    crate::wallet::accounts::list_accounts(&zcash.state).await
}

#[command]
pub(crate) async fn get_account_balance<R: Runtime>(
    app: AppHandle<R>,
    args: AccountIdArgs,
) -> Result<AccountBalance> {
    let zcash = app.zcash();

    if !zcash.state.is_initialized().await {
        return Ok(AccountBalance {
            account_index: args.account_index,
            total_shielded: 0,
            spendable: 0,
            change_pending: 0,
            value_pending: 0,
        });
    }

    let db_guard = zcash.state.db.lock().await;
    let db = db_guard.as_ref().ok_or(Error::WalletNotInitialized)?;

    let policy = ConfirmationsPolicy::default();

    let summary = db
        .get_wallet_summary(policy)
        .map_err(|e| Error::DatabaseError(format!("failed to get wallet summary: {e}")))?;

    if let Some(summary) = summary {
        let account_ids = db
            .get_account_ids()
            .map_err(|e| Error::DatabaseError(format!("failed to get account ids: {e}")))?;

        if let Some(account_id) = account_ids.get(args.account_index as usize) {
            if let Some(balance) = summary.account_balances().get(account_id) {
                let sapling = balance.sapling_balance();
                let orchard = balance.orchard_balance();

                let total = u64::from(sapling.total()) + u64::from(orchard.total());
                let spendable = u64::from(sapling.spendable_value()) + u64::from(orchard.spendable_value());
                let change_pending = u64::from(sapling.change_pending_confirmation()) + u64::from(orchard.change_pending_confirmation());
                let value_pending = u64::from(sapling.value_pending_spendability()) + u64::from(orchard.value_pending_spendability());

                return Ok(AccountBalance {
                    account_index: args.account_index,
                    total_shielded: total,
                    spendable,
                    change_pending,
                    value_pending,
                });
            }
        }
    }

    Ok(AccountBalance {
        account_index: args.account_index,
        total_shielded: 0,
        spendable: 0,
        change_pending: 0,
        value_pending: 0,
    })
}

#[command]
pub(crate) async fn get_unified_address<R: Runtime>(
    app: AppHandle<R>,
    args: AccountIdArgs,
) -> Result<String> {
    let zcash = app.zcash();

    if !zcash.state.is_initialized().await {
        return Err(Error::WalletNotInitialized);
    }

    let db_guard = zcash.state.db.lock().await;
    let db = db_guard.as_ref().ok_or(Error::WalletNotInitialized)?;

    let account_ids = db
        .get_account_ids()
        .map_err(|e| Error::DatabaseError(format!("failed to get account ids: {e}")))?;

    let account_id = account_ids
        .get(args.account_index as usize)
        .copied()
        .ok_or(Error::AddressError("account not found".into()))?;

    let ua_request = UnifiedAddressRequest::AllAvailableKeys;
    let addr = db
        .get_last_generated_address_matching(account_id, ua_request)
        .map_err(|e| Error::AddressError(format!("failed to get address: {e}")))?
        .ok_or(Error::AddressError("no address available".into()))?;

    let encoded = addr.encode(&zcash.state.network);
    Ok(encoded)
}

#[command]
pub(crate) async fn start_sync<R: Runtime>(
    app: AppHandle<R>,
) -> Result<()> {
    let zcash = app.zcash();
    crate::wallet::sync::start_sync(app.clone(), &zcash.state).await
}

#[command]
pub(crate) async fn stop_sync<R: Runtime>(
    app: AppHandle<R>,
) -> Result<()> {
    let zcash = app.zcash();
    crate::wallet::sync::stop_sync(&zcash.state).await
}

#[command]
pub(crate) async fn get_sync_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<SyncStatus> {
    let zcash = app.zcash();
    crate::wallet::sync::get_sync_status(&zcash.state).await
}

#[command]
pub(crate) async fn send_transaction<R: Runtime>(
    app: AppHandle<R>,
    args: SendTransactionArgs,
) -> Result<String> {
    let zcash = app.zcash();
    crate::wallet::send::send_transaction(
        &zcash.state,
        &args.to,
        args.amount,
        args.memo.as_deref(),
    )
    .await
}

#[command]
pub(crate) async fn get_transaction_history<R: Runtime>(
    app: AppHandle<R>,
    args: TransactionHistoryArgs,
) -> Result<Vec<TransactionEntry>> {
    let zcash = app.zcash();
    crate::wallet::history::get_transaction_history(
        &zcash.state,
        args.account_index,
        args.offset.unwrap_or(0),
        args.limit.unwrap_or(50),
    )
    .await
}

#[command]
pub(crate) async fn set_lightwalletd_url<R: Runtime>(
    app: AppHandle<R>,
    args: SetLightwalletdUrlArgs,
) -> Result<()> {
    let zcash = app.zcash();
    *zcash.state.lightwalletd_url.write().await = args.url;
    Ok(())
}

#[command]
pub(crate) async fn parse_payment_uri<R: Runtime>(
    _app: AppHandle<R>,
    args: ParsePaymentUriArgs,
) -> Result<PaymentRequest> {
    let request = zip321::TransactionRequest::from_uri(&args.uri)
        .map_err(|e| Error::Other(format!("invalid payment URI: {e:?}")))?;

    let payments = request.payments();
    if payments.is_empty() {
        return Err(Error::Other("payment URI contains no payments".into()));
    }

    let (_, payment) = payments.iter().next().unwrap();
    let address = payment.recipient_address().encode();
    let amount = payment.amount().map(|a| u64::from(a));
    let memo = payment.memo().map(|m| format!("{:?}", m));
    let label = payment.label().map(|s| s.to_string());

    Ok(PaymentRequest {
        address,
        amount,
        memo,
        label,
    })
}
