//! The free2z AI gateway's code-level contract.
//!
//! This crate is what the gateway (`f2z-ai`) and every client — the Rust SDK
//! (`f2z-sdk`), the Tauri plugin, third-party integrators — share, so that an
//! estimate computed on a device and the charge settled by the platform come
//! from the same types and the same arithmetic.
//!
//! # The prose specification
//!
//! The normative prose lives in the repository at
//!
//! * `docs/free2z/sdk/spec/chat-api.md` — `/v1/chat`, the SSE event grammar and the
//!   settlement states ([`chat`], [`event`], [`settlement`]);
//! * `docs/free2z/sdk/spec/errors.md` — the error codes, their statuses and
//!   retryability ([`error`]; `tests/spec_conformance.rs` parses its tables);
//! * `docs/free2z/sdk/spec/metering.md` — the catalogue, the pricing formula and the
//!   rounding rule ([`catalog`], [`canonical`], [`pricing`], [`amount`]);
//! * `docs/free2z/sdk/spec/purchase.md` §1.1 — the balance ([`balance`]).
//!
//! The prose spec (zuu #1048) and this crate (zuu #1049, #1052) are
//! reconciled; where the two disagree the disagreement is a bug in one of
//! them, not a choice.
//!
//! # What is here
//!
//! | Module | Contents |
//! |---|---|
//! | [`chat`] | `POST /v1/chat` request and non-streaming response, [`chat::Usage`], `/v1/chat/estimate` |
//! | [`event`] | The SSE [`event::Event`] enum: `meta`, `delta`, `tool_call`, `usage`, `done`, `error` |
//! | [`settlement`] | [`settlement::Settlement`] (`settled` / `pending` / `released`) and its per-state rules |
//! | [`error`] | [`error::ErrorCode`], its HTTP status and retryability, the error envelope, the ledger-refusal mapping |
//! | [`amount`] | [`amount::Nusd`], [`amount::Milli2z`], [`amount::Whole2z`]: one type per unit |
//! | [`balance`] | [`balance::Balance`], the account balance including debt |
//! | [`catalog`] | The signed model catalogue and [`catalog::verify_catalog`] |
//! | [`canonical`] | The canonical JSON the catalogue signature covers |
//! | [`json`] | [`json::OrderedJson`]: caller-supplied JSON (tool parameters, response schemas) that keeps its member order |
//! | [`pricing`] | [`pricing::price_2z`]: meter to nano-USD, price to milli-2Z, integers only, one rounding of the 2Z total |
//!
//! # What is not
//!
//! No I/O, no clock, no randomness and no async runtime. `no_std` + `alloc`.
//! Transport, SSE stream splitting, retries and the ledger belong to the
//! crates that link this one.
//!
//! # Example: the worked pricing example
//!
//! ```
//! use f2z_ai_proto::amount::{Milli2z, Nusd, Whole2z};
//! use f2z_ai_proto::pricing::{Bps, price_nusd};
//!
//! // $0.021 (21 000 000 nano-USD) of provider cost at 0 % margin and no
//! // developer markup is 2.1 2Z, rounded once, up, to 3 2Z.
//! let charge = price_nusd(Nusd::new(21_000_000), Bps(0), Bps(0), Whole2z::new(1))?;
//! assert_eq!(charge.total_2z(), Whole2z::new(3));
//! assert_eq!(charge.provider_milli, Milli2z::new(2_100));
//! assert_eq!(charge.platform_milli, Milli2z::new(900));
//! # Ok::<(), f2z_ai_proto::pricing::PricingError>(())
//! ```

#![no_std]
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

extern crate alloc;

pub mod amount;
pub mod balance;
pub mod canonical;
pub mod catalog;
pub mod catalog_v2;
pub mod chat;
pub mod error;
pub mod event;
pub mod grant;
pub mod json;
pub mod pricing;
pub mod settlement;

pub use amount::{Milli2z, Nusd, Whole2z};
pub use chat::{ChatRequest, ChatResponse, ReasoningEffort, ResponseFormat, ToolChoice, Usage};
pub use error::ErrorCode;
pub use event::Event;
pub use json::OrderedJson;
pub use pricing::{Bps, Charge, ModelPrices, metered_cost_nusd, price_2z, price_nusd};
pub use settlement::Settlement;
