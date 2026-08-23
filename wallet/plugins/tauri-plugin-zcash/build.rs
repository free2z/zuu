const COMMANDS: &[&str] = &[
    "create_wallet",
    "restore_wallet",
    "get_wallet_status",
    "preview_legacy_wallet_import",
    "retry_wallet_cleanup",
    "get_seed_phrase",
    "get_backup_seed_phrase",
    "confirm_wallet_backup",
    "begin_sensitive_display",
    "end_sensitive_display",
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
    "ensure_sapling_params",
    "propose_send",
    "propose_send_all",
    "confirm_send",
    "execute_send",
    "discard_send_proposal",
    "get_pending_send",
    "retry_pending_send",
    "discard_unrecoverable_send",
    "get_transaction_history",
    "set_lightwalletd_url",
    "parse_payment_uri",
    "validate_address",
    "sign_challenge",
];

fn main() {
    // CI changes this value for every attempt so a restored Cargo target cache
    // cannot skip permission and schema generation side effects.
    println!("cargo:rerun-if-env-changed=TAURI_PERMISSION_GENERATION_NONCE");
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
