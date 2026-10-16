macro_rules! with_commands {
    ($callback:ident) => {
        $callback! {
            session,
            sign_in,
            sign_out,
            balance,
            grant,
            models,
            estimate,
            create_purchase,
            purchase,
            wait_for_purchase,
            open_checkout,
            start_chat,
            next_chat,
            cancel_chat,
            call,
            wait_for_call,
            manage_account_url,
            delete_account_url,
            open_manage_account,
            open_delete_account,
            billing_url,
            open_billing,
            report_call,
        }
    };
}
