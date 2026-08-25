// One inventory drives both Tauri's runtime invoke handler and its generated
// permission manifest. Keeping those two registrations structurally identical
// prevents a command from compiling while being unreachable or unauthorized.
macro_rules! with_zcash_commands {
    ($callback:ident) => {
        $callback! {
            create_wallet,
            restore_wallet,
            get_wallet_status,
            preview_legacy_wallet_import,
            retry_wallet_cleanup,
            get_seed_phrase,
            get_backup_seed_phrase,
            confirm_wallet_backup,
            begin_sensitive_display,
            begin_sensitive_entry,
            end_sensitive_display,
            get_viewing_key,
            get_spending_key,
            list_wallets,
            switch_wallet,
            rename_wallet,
            delete_wallet,
            unlock_wallet,
            create_account,
            list_accounts,
            get_account_balance,
            get_unified_address,
            start_sync,
            stop_sync,
            get_sync_status,
            ensure_sapling_params,
            propose_send,
            propose_send_all,
            confirm_send,
            execute_send,
            discard_send_proposal,
            get_pending_send,
            retry_pending_send,
            discard_unrecoverable_send,
            get_transaction_history,
            set_lightwalletd_url,
            parse_payment_uri,
            validate_address,
            sign_challenge,
        }
    };
}
