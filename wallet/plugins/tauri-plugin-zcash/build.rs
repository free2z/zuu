const COMMANDS: &[&str] = &[
    "create_wallet",
    "restore_wallet",
    "get_wallet_status",
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
