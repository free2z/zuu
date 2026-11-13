macro_rules! with_notify_commands {
    ($callback:ident) => {
        $callback! {
            status,
            enable,
            disable,
            reconcile,
            test_wake,
        }
    };
}
