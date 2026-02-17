use zcash_client_backend::data_api::{Account, BirthdayError, WalletRead, WalletWrite};
use zcash_keys::keys::UnifiedAddressRequest;

use crate::error::{Error, Result};
use crate::models::AccountInfo;
use crate::wallet::WalletState;

fn format_birthday_error(e: BirthdayError) -> String {
    match e {
        BirthdayError::HeightInvalid(e) => format!("invalid height: {e}"),
        BirthdayError::Decode(e) => format!("decode error: {e}"),
    }
}

/// Create a new account in the wallet.
pub async fn create_account(state: &WalletState) -> Result<AccountInfo> {
    if !state.is_initialized().await {
        return Err(Error::WalletNotInitialized);
    }

    let seed_guard = state.seed.lock().await;
    let _seed = seed_guard
        .as_ref()
        .ok_or(Error::Other("seed not available in session".into()))?;

    let mut db_guard = state.db.lock().await;
    let db = db_guard
        .as_mut()
        .ok_or(Error::WalletNotInitialized)?;

    // We need a birthday for the new account - use the existing wallet birthday
    let _birthday_height = db
        .get_wallet_birthday()
        .map_err(|e| Error::DatabaseError(format!("failed to get wallet birthday: {e}")))?
        .ok_or(Error::DatabaseError("no wallet birthday found".into()))?;

    // Get the tree state for the birthday
    // For simplicity, use the same birthday as the first account
    // In production, you'd want to get the current chain state
    let account_ids = db
        .get_account_ids()
        .map_err(|e| Error::DatabaseError(format!("failed to get account ids: {e}")))?;
    let first_account = account_ids
        .first()
        .ok_or(Error::DatabaseError("no accounts found".into()))?;
    let existing_birthday = db
        .get_account_birthday(*first_account)
        .map_err(|e| Error::DatabaseError(format!("failed to get account birthday: {e}")))?;

    // Get a birthday for the new account using the first account's birthday
    // This is a simplified approach
    let url = state.lightwalletd_url.read().await.clone();
    drop(db_guard);
    drop(seed_guard);

    let mut client = crate::wallet::client::connect_to_lightwalletd(&url).await?;
    let tree_state = client
        .get_tree_state(zcash_client_backend::proto::service::BlockId {
            height: u64::from(u32::from(existing_birthday)),
            hash: vec![],
        })
        .await
        .map_err(|e| Error::NetworkError(format!("failed to get tree state: {e}")))?
        .into_inner();

    let birthday = zcash_client_backend::data_api::AccountBirthday::from_treestate(tree_state, None)
        .map_err(|e| Error::DatabaseError(format!("failed to create birthday: {}", format_birthday_error(e))))?;

    let seed_guard = state.seed.lock().await;
    let seed = seed_guard
        .as_ref()
        .ok_or(Error::Other("seed not available in session".into()))?;

    let mut db_guard = state.db.lock().await;
    let db = db_guard
        .as_mut()
        .ok_or(Error::WalletNotInitialized)?;

    let account_count = db
        .get_account_ids()
        .map_err(|e| Error::DatabaseError(format!("{e}")))?
        .len();

    let (account_id, _usk) = db
        .create_account(&format!("Account {}", account_count), seed, &birthday, None)
        .map_err(|e| Error::DatabaseError(format!("failed to create account: {e:?}")))?;

    let ua_request = UnifiedAddressRequest::AllAvailableKeys;
    let addr = db
        .get_last_generated_address_matching(account_id, ua_request)
        .map_err(|e| Error::AddressError(format!("{e}")))?
        .ok_or(Error::AddressError("no address available".into()))?;

    let encoded = addr.encode(&state.network);

    Ok(AccountInfo {
        account_index: account_count as u32,
        name: Some(format!("Account {}", account_count)),
        unified_address: encoded,
    })
}

/// List all accounts in the wallet.
pub async fn list_accounts(state: &WalletState) -> Result<Vec<AccountInfo>> {
    if !state.is_initialized().await {
        return Err(Error::WalletNotInitialized);
    }

    let db_guard = state.read_db.lock().await;
    let db = db_guard
        .as_ref()
        .ok_or(Error::WalletNotInitialized)?;

    let account_ids = db
        .get_account_ids()
        .map_err(|e| Error::DatabaseError(format!("failed to get account ids: {e}")))?;

    let mut accounts = Vec::new();
    for (idx, account_id) in account_ids.iter().enumerate() {
        let account = db
            .get_account(*account_id)
            .map_err(|e| Error::DatabaseError(format!("{e}")))?;

        let name = account.as_ref().and_then(|a| a.name().map(|n| n.to_string()));

        let ua_request = UnifiedAddressRequest::AllAvailableKeys;
        let addr = db
            .get_last_generated_address_matching(*account_id, ua_request)
            .map_err(|e| Error::AddressError(format!("{e}")))?;

        let unified_address = match addr {
            Some(ua) => ua.encode(&state.network),
            None => String::new(),
        };

        accounts.push(AccountInfo {
            account_index: idx as u32,
            name,
            unified_address,
        });
    }

    Ok(accounts)
}
