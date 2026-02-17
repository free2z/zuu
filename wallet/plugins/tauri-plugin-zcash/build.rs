const COMMANDS: &[&str] = &[
    "create_wallet",
    "restore_wallet",
    "get_wallet_status",
    "get_seed_phrase",
    "get_viewing_key",
    "get_spending_key",
    "list_wallets",
    "switch_wallet",
    "rename_wallet",
    "delete_wallet",
    "unlock_wallet",
    "create_account",
    "list_accounts",
    "get_account_balance",
    "get_unified_address",
    "start_sync",
    "stop_sync",
    "get_sync_status",
    "send_transaction",
    "get_transaction_history",
    "set_lightwalletd_url",
    "parse_payment_uri",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
