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
        }
    };
}
