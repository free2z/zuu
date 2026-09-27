//! `f2z-ai` — the free2z AI gateway (`ai.free2z.cash`), skeleton.
//!
//! This is Wave 1 of epic zuu#1047 (issue zuu#1054): the service shape the
//! provider adapters, authentication and metering of Wave 2 are built inside.
//! It calls no provider, verifies no token and moves no 2Z. What it does do is
//! everything an operator and a client can observe about a gateway *before*
//! those exist, so that those properties are settled — and tested — first:
//!
//! | Module | What it owns |
//! |---|---|
//! | [`config`] | Typed configuration: a TOML file plus `F2Z_AI_*` environment overrides, secrets as [`secrecy::SecretString`] and never inline |
//! | [`server`] | Two listeners (public `/v1/*`, admin `/healthz` `/readyz` `/metrics`), the layer stack, and the drain sequence |
//! | [`auth`] | Chat-api.md §2.2 steps 1–2: the ES256 access token against the issuer's JWKS, revocation by `aep`/`agen` (Redis, then the IdP's internal endpoint — **fails closed**), the `ai:invoke` scope, the per-user concurrency lease and the rate limits |
//! | [`admission`] | The tower layer that refuses work while draining, bounds concurrent calls (503 + `Retry-After`), and holds each call's slot **until it is settled** |
//! | [`call`] | A started call: the upstream read at provider speed on a detached task, and delivery through a bounded per-stream buffer — client backpressure never reaches the provider |
//! | [`settle`] | The [`settle::Settler`] hook every started call is handed to exactly once, from a detached task; stubbed |
//! | [`catalog`] | Readiness gated on a verified, unexpired catalogue; the source is a trait, stubbed |
//! | [`chat`] | `POST /v1/chat`: body limits, strict decoding with `f2z-ai-proto`, the spec's structural rules, then the [`chat::ChatBackend`] — which answers `501 not_implemented` in this build |
//! | [`provider`] | The provider adapters (OpenAI Responses, Anthropic Messages, Chat Completions for xAI): request translation, stream and usage parsing, provider deadlines, retries and the circuit breaker. Not wired into the binary until authentication and metering are |
//! | [`metrics`] | Prometheus text exposition, hand-rolled, bounded labels only |
//! | [`telemetry`] | Structured JSON logs and OpenTelemetry tracing (OTLP, off unless configured) |
//! | [`serve`] | The hyper accept loop: header-read timeout and a bounded graceful close |
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
pub mod metrics;
pub mod provider;
pub mod serve;
pub mod server;
pub mod settle;
pub mod shutdown;
pub mod telemetry;

pub use config::Config;
pub use error::ApiFailure;
pub use server::{Deps, DrainReport, Gateway, Stopped};
