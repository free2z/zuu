//! The free2z relay daemon — the server that runs in production.
//!
//! This crate implements [`docs/e2ee/WIRE.md`] v1 §2 through §13 on top of three
//! crates that already own the parts a relay and a client must agree on
//! exactly:
//!
//! | Crate | What it owns |
//! |---|---|
//! | [`f2z_codec`] | Canonical encoding, the framing of §4, re-encode equality (§3.3), the redaction newtypes |
//! | [`f2z_relay_proto`] | §5.1's verification order, §5.5's anti-replay, §7/§8's queue and ACK rules, §11's document |
//! | [`f2z_relay_store`] | Authorization inside the transaction, quota admission, the acknowledgement watermark, durability |
//!
//! **Nothing in those three is reimplemented here.** A relay that held a second
//! opinion about the protocol would be a relay that deletes ciphertext before it
//! is read. What this crate decides is the part they deliberately leave to a
//! server: the socket, the connection lifecycle, the group-commit schedule, the
//! anti-abuse layering, and which refusal answers which failure.
//!
//! # Licence
//!
//! **AGPL-3.0**, per the owner decision recorded on
//! [#305](https://github.com/free2z/zuu/issues/305). The crates above stay
//! permissive so that the ZUULI client, the WASM web client and third-party
//! implementations can link them; the boundary starts at this binary.
//! `rs/deny.toml` makes it mechanical — this crate is named in `exceptions`, and
//! adding `AGPL-3.0` to the shared `allow` list instead would permit it for
//! every crate in the tree.
//!
//! # The four properties this crate is responsible for
//!
//! 1. **`accepted` is never written to the socket before the commit is
//!    durable.** [`commit`] is the only path to the disk, and the value that
//!    lets a caller answer `accepted` does not exist until the transaction has
//!    returned. Not a convention — a type.
//! 2. **Group commit, because `synchronous = FULL` makes the fsync rate the
//!    ceiling.** N appends inside a few milliseconds cost one fsync, and
//!    `tests/group_commit.rs` proves the amortization against the store's own
//!    commit counter rather than asserting it.
//! 3. **No payload, queue address, key or peer address in any log line at any
//!    level.** [`log`] has no parameter through which one could travel, and
//!    `tests/redaction.rs` checks base16, base64url **and** the decimal byte-list
//!    form that a hex-only test would sail past.
//! 4. **Refusing rather than deleting.** §13.2: under no circumstance does the
//!    relay delete an unacknowledged message to make room. Backpressure refuses
//!    creation, then appends, then new connections, and never refuses `READ`,
//!    `ACK` or `DELETE_QUEUE`.
//!
//! # Running one
//!
//! ```no_run
//! # async fn example() -> Result<(), Box<dyn std::error::Error>> {
//! use f2z_relay::{config::Config, server::Server};
//!
//! let mut config = Config::default();
//! config.store.backend = "memory".to_owned();
//! config.listen.address = "127.0.0.1:0".to_owned();
//!
//! let server = Server::start(config).await?;
//! println!("{}", server.url());
//! server.shutdown().await;
//! # Ok(())
//! # }
//! ```
//!
//! [`docs/e2ee/WIRE.md`]: https://github.com/free2z/zuu/blob/main/docs/e2ee/WIRE.md

#![forbid(unsafe_code)]
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing,
        clippy::arithmetic_side_effects
    )
)]

pub mod abuse;
pub mod admin;
pub mod caps;
pub mod challenge;
pub mod cli;
pub mod commit;
pub mod config;
pub mod connection;
pub mod engine;
pub mod expiry;
pub mod identity;
pub mod listener;
pub mod log;
pub mod metrics;
pub mod outbound;
pub mod rng;
pub mod server;
pub mod subscriptions;
pub mod tls;
pub mod transport;

pub use config::Config;
pub use engine::Relay;
pub use server::{Server, StartError};

/// The relay's clock, in milliseconds since the Unix epoch.
///
/// `f2z-relay-proto` is deliberately clock-free — every rule that needs the time
/// takes it as an argument, because the same code runs in a browser — which
/// leaves somebody holding the clock, and in a server that somebody is here.
///
/// §5.5's timestamp window is `±clock_skew_ms` of *this* value, so an operator
/// whose clock is wrong will refuse correct clients. Running NTP is not
/// optional; the relay does not attempt to detect it, because a relay that
/// second-guessed its own clock would have two.
#[must_use]
pub fn now_ms() -> u64 {
    u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.as_millis()),
    )
    .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_clock_is_milliseconds_since_the_epoch() {
        // Any time after 2020 and before 2200, which is the only thing worth
        // asserting about a wall clock.
        let now = super::now_ms();
        assert!(now > 1_577_836_800_000);
        assert!(now < 7_258_118_400_000);
    }
}
