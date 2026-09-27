//! Test harness for the free2z AI gateway (zuu #1053, epic #1047).
//!
//! Three things, so the gateway (`f2z-ai`) can be built and load-tested
//! without a provider account, a network, or Postgres:
//!
//! | Module | What it is |
//! |---|---|
//! | [`mock`] | A **mock provider** HTTP server that streams OpenAI Responses, OpenAI-style Chat Completions (with the xAI usage variant) and Anthropic Messages SSE, shaped like the real published formats, with tunable pacing, token counts and fault injection |
//! | [`ledger`] | The **ledger contract** — inquire / hold / extend / settle / release — as a trait, and [`ledger::InMemoryLedger`], a fake that implements it in memory and prices with [`f2z_ai_proto::pricing`] |
//! | [`fixtures`] | Typed loaders for `f2z-ai-proto`'s shared pricing fixtures, so the gateway's own tests are driven by the same numbers the ledger is |
//!
//! A `goose` load-scenario skeleton that runs against the mock lives in
//! `examples/goose_mock_provider.rs`.
//!
//! # Example
//!
//! ```
//! # async fn example() -> Result<(), Box<dyn std::error::Error>> {
//! use f2z_ai_testkit::mock::{MockProvider, Scenario};
//!
//! let mock = MockProvider::start(Scenario::default().with_output_tokens(8)).await?;
//! // Point the gateway's provider base URL at the mock:
//! let _openai = format!("{}/v1/responses", mock.base_url());
//! let _anthropic = format!("{}/v1/messages", mock.base_url());
//! mock.shutdown().await;
//! # Ok(())
//! # }
//! ```
//!
//! # Provisional
//!
//! The ledger contract follows `docs/sdk/spec/metering.md` §3 as proposed in
//! zuu #1051, which was still in review when this crate was written. That is
//! why the operations are a trait ([`ledger::LedgerContract`]) and the fake
//! only one implementation of it: when the contract moves, the trait moves
//! with it and every test written against the fake keeps its meaning.

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

pub mod fixtures;
pub mod ledger;
pub mod mock;
