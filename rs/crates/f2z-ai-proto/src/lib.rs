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
//! * `docs/sdk/spec/chat-api.md` — `/v1/chat`, the SSE event grammar and the
//!   error codes ([`chat`], [`event`], [`error`]);
//! * `docs/sdk/spec/metering.md` — the catalogue, the pricing formula and the
//!   rounding rule ([`catalog`], [`canonical`], [`pricing`]).
//!
//! The prose spec (zuu #1048) and this crate (zuu #1049) were written in
//! parallel and are to be reconciled; until they are, where the two disagree
//! the disagreement is a bug in one of them, not a choice.
//!
//! # What is here
//!
//! | Module | Contents |
//! |---|---|
//! | [`chat`] | `POST /v1/chat` request and non-streaming response, [`chat::Usage`] |
//! | [`event`] | The SSE [`event::Event`] enum: `meta`, `delta`, `tool_call`, `usage`, `done`, `error` |
//! | [`error`] | [`error::ErrorCode`] and its HTTP status mapping |
//! | [`catalog`] | The signed model catalogue and [`catalog::verify_catalog`] |
//! | [`canonical`] | The canonical JSON the catalogue signature covers |
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
//! use f2z_ai_proto::pricing::{Bps, price_nusd};
//!
//! // $0.021 (21 000 000 nano-USD) of provider cost at 0 % margin and no
//! // developer markup is 2.1 2Z, rounded once, up, to 3 2Z.
//! let charge = price_nusd(21_000_000, Bps(0), Bps(0), 1)?;
//! assert_eq!(charge.total_2z(), 3);
//! assert_eq!(charge.provider_milli, 2_100);
//! assert_eq!(charge.platform_milli, 900);
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

pub mod canonical;
pub mod catalog;
pub mod chat;
pub mod error;
pub mod event;
pub mod pricing;

pub use chat::{ChatRequest, ChatResponse, Usage};
pub use error::ErrorCode;
pub use event::Event;
pub use pricing::{Bps, Charge, ModelPrices, metered_cost_nusd, price_2z, price_nusd};
