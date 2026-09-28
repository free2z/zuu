//! `f2z-ai` — the Free2Z AI gateway metered preview.
//!
//! [`meter`] joins authenticated admission, signed catalogue pricing, provider
//! streams, and the durable [`ledger`] function ABI. [`call`] separates provider
//! reads from bounded client delivery and keeps detached settlement ownership.
//! See the crate README for supported routes and explicit preview limitations.
//!
//! # The rule about logs
//!
//! **A prompt or a completion never reaches a log line, a span, or an error
//! message.** Not at `trace`, not in a decode error, not in a panic message.
//! `ChatRequest` is never formatted; a decode failure is reported by category
//! and position, because `serde_json`'s own message quotes the offending value
//! (`invalid type: string "…", expected u64`). `tests/redaction.rs` and
//! `tests/otel.rs` hold that line with a canary at the most verbose level an
//! operator can configure.

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

pub mod admission;
pub mod auth;
pub mod call;
pub mod catalog;
pub mod chat;
pub mod config;
pub mod error;
pub mod ledger;
pub mod meter;
pub mod metrics;
mod nonstream;
pub mod provider;
pub mod serve;
pub mod server;
pub mod settle;
pub mod shutdown;
pub mod telemetry;

pub use config::Config;
pub use error::ApiFailure;
pub use server::{Deps, DrainReport, Gateway, Stopped};
