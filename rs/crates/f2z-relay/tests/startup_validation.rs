//! External-crate regressions for the public production constructor.
//!
//! `Config::check` is already unit-tested from inside the crate (see
//! `config.rs`'s `token_mode_is_refused_because_it_has_no_wire_shape`), but a
//! unit test calling a method directly cannot prove anything about whether
//! the method is actually reached from the one place an operator can start a
//! relay from. This test deliberately cannot reach the engine's
//! crate-private assembly function: the only public route from an operator
//! [`Config`] to a running relay is [`Server::start`], and that route must
//! apply the full shared configuration validation — including the
//! permanently-reserved `token` queue-creation mode (§13.1) — before it ever
//! creates an identity, opens a store, or binds a listener.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_relay::config::{Config, ConfigError};
use f2z_relay::server::{Server, StartError};

#[tokio::test]
async fn public_startup_refuses_the_reserved_token_creation_mode() {
    let mut config = Config::default();
    config.antiabuse.queue_creation_mode = "token".to_owned();
    // Keep the negative control independent of the filesystem and of any
    // other startup step: if validation were ever bypassed, startup would
    // reach real identity/store/capability construction rather than failing
    // incidentally on a missing key file or a disk-backed store path.
    config.identity.seed = "11".repeat(32);
    config.store.backend = "memory".to_owned();
    config.listen.address = "127.0.0.1:0".to_owned();

    match Server::start(config).await {
        Err(StartError::Config(ConfigError::Invalid(field, reason))) => {
            assert_eq!(field, "antiabuse.queue_creation_mode");
            assert!(reason.contains("no wire representation"));
        }
        Err(other) => panic!("reserved mode escaped public startup validation: {other}"),
        Ok(server) => {
            server.shutdown().await;
            panic!("a protocol-v1 relay started with the reserved token creation mode");
        }
    }
}
