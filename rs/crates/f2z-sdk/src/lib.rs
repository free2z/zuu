//! The Free2Z Rust SDK core.
//!
//! An app built on this crate can:
//!
//! 1. **sign a user in to Free2Z** — OAuth 2.0 / OpenID Connect with PKCE
//!    `S256` ([`oauth`], [`Client::sign_in`]);
//! 2. **show and sell 2Z** — the balance ([`Client::balance`]) and card
//!    purchases ([`purchase`]);
//! 3. **call AI** through the metered streaming gateway ([`ai`]).
//!
//! 2Z are platform credits: 1 2Z corresponds to $0.01 of usage. They are not
//! money.
//!
//! # The contract
//!
//! This crate implements the published v1 contract in the repository's
//! `docs/free2z/sdk/` — `spec/oidc.md`, `spec/chat-api.md`, `spec/metering.md`,
//! `spec/purchase.md` and `spec/errors.md` — and speaks the gateway's wire
//! types from [`f2z_ai_proto`] (re-exported as [`proto`]).
//!
//! # Built to be wrapped
//!
//! The Tauri plugin (desktop, iOS and Android as equals) and the TypeScript
//! SDK wrap this crate, so the platform-specific parts are seams, not code:
//!
//! * **the browser** is an [`oauth::AuthSession`]: [`oauth::LoopbackSession`]
//!   on desktop (RFC 8252 loopback plus the system browser through an
//!   [`oauth::UrlOpener`]); the plugin supplies `ASWebAuthenticationSession`
//!   and Custom Tabs on mobile;
//! * **the keychain** is a [`TokenStore`]: [`MemoryStore`], and
//!   [`KeyringStore`] (feature `keyring`, on by default) over any
//!   `keyring-core` platform store the caller constructs;
//! * **no global state**: every session lives in a [`Client`];
//! * tokio for async, reqwest over rustls for HTTP.
//!
//! # Example
//!
//! ```no_run
//! use std::sync::Arc;
//! use f2z_sdk::{Client, Config, MemoryStore};
//! use f2z_sdk::oauth::LoopbackSession;
//!
//! # async fn run() -> Result<(), f2z_sdk::Error> {
//! let client = Client::new(Config::new("app_7f3c2e"), Arc::new(MemoryStore::new()))?;
//! let session = LoopbackSession::bind(|url: &str| -> Result<(), String> {
//!     // Hand the URL to the system browser.
//!     println!("{url}");
//!     Ok(())
//! })
//! .await?;
//! client.sign_in(&session, Default::default()).await?;
//! let balance = client.balance().await?;
//! println!("{} available", balance.available_milli_2z);
//! # Ok(()) }
//! ```

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

pub mod ai;
mod balance;
mod client;
mod config;
mod error;
mod http;
pub mod keychain;
pub mod oauth;
pub mod purchase;
mod random;
mod secret;

pub use client::Client;
pub use config::{Config, DEFAULT_AI_BASE, DEFAULT_API_BASE, DEFAULT_ISSUER, DEFAULT_SCOPES};
pub use error::{ApiError, Error, OAuthError, SignedOutReason, StepUp, TransportError};
#[cfg(feature = "keyring")]
pub use keychain::KeyringStore;
pub use keychain::{MemoryStore, Persistence, StoreError, TokenStore};
pub use oauth::{CapPeriod, SignInOptions, SignedIn, SpendCapHint};
pub use secret::Secret;

/// The gateway's wire types, re-exported so an app depends on one crate.
pub use f2z_ai_proto as proto;
