//! The cross-app intent bridge, version 1 — `docs/intent-bridge/PROTOCOL.md`.
//!
//! A versioned request/response protocol carrying **authority delegation**
//! from `cash.free2z.zuuli`, which holds the Zcash seed, to applications that
//! hold none. `docs/architecture` context is [#904]; this crate is [#905].
//!
//! ```text
//!   caller app                     ZUULI (this crate)
//!   ──────────                     ──────────────────
//!   build IntentRequestV1   ─────► IntentGate::admit
//!                                    parse (canonical, versioned)
//!                                    authorize caller (registry + OS attestation)
//!                                    check window (dual clock)
//!                                    spend request_id (one-use ledger)
//!                                  ▼
//!                                  render ZUULI's OWN confirmation
//!                                  ▼ user approves
//!                                  ConfirmationAuthorization::issue
//!                                  ▼
//!                                  ConfirmationAuthorization::consume
//!                                    dual-clock deadline
//!                                    re-derived request + review binding
//!                                  ▼
//!   IntentResponseV1        ◄───── act, exactly once
//! ```
//!
//! # The three properties this crate exists to hold
//!
//! 1. **The seed never appears in a message.** Nothing in [`wire`] can carry
//!    one: `sign-challenge` carries bytes to sign, `issue-device-credential`
//!    carries device *public* keys, `execute-payment` carries a proposal. The
//!    private halves stay where they were generated.
//! 2. **Nothing here is a continuous grant.** Every intent is one-shot
//!    ([`ledger`]), expiring on two clocks ([`clock`]), and bound to one
//!    approval of one rendering ([`confirmation`]).
//! 3. **The native confirmation is the authority.** The user approves inside
//!    ZUULI, seeing ZUULI's rendering — never the caller's. [`caller`] is why
//!    the confirmation can name the caller at all, and
//!    `docs/intent-bridge/CALLER-AUTHENTICATION.md` is honest about how much
//!    that naming is worth on each platform.
//!
//! # What this crate is NOT, and must not become
//!
//! It performs **no cryptography beyond hashing**: no signing, no
//! verification, no key derivation, no randomness. The `sign-challenge`
//! signature is produced by the wallet's key hierarchy
//! (`f2z-msg-identity`), the `DeviceCredential` is minted by `f2z-kt-core`,
//! and the payment is built by `tauri-plugin-zcash`. This crate says which
//! bytes those layers are allowed to act on, and when. Moving a key operation
//! in here would put key material in a crate whose whole input surface is
//! attacker-controlled.
//!
//! It also holds **no transport**. There is no deep-link parsing, no URL, no
//! intent filter. That is deliberate and it is the reason this crate could
//! land while [#461] — verified App Links / Universal Links — is still
//! blocked: everything here is correct regardless of how the bytes arrive, and
//! nothing here is *sufficient* without a transport that authenticates the
//! response destination. `docs/intent-bridge/PROTOCOL.md` §7 states exactly
//! what remains blocked.
//!
//! # `no_std`
//!
//! `no_std` + `alloc`, no I/O, no clocks, no randomness — every one of which
//! is passed in. The immediate benefit is testability: suspend, clock
//! rollback and the exact expiry instant are all pure-function inputs, so the
//! conformance suite never sleeps. The standing benefit is that the same crate
//! can reach `wasm32-unknown-unknown` if a browser surface ever needs to
//! validate an intent, without a second implementation appearing to serve it.
//!
//! [#904]: https://github.com/free2z/zuu/issues/904
//! [#905]: https://github.com/free2z/zuu/issues/905
//! [#461]: https://github.com/free2z/zuu/issues/461

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

pub mod caller;
pub mod clock;
pub mod confirmation;
pub mod error;
pub mod gate;
pub mod ledger;
pub mod session;
pub mod text;
pub mod wire;

#[cfg(test)]
mod test_support;

pub use caller::{
    AuthorizedCaller, CallerAttestation, CallerRegistry, CallerTrust, RegisteredCaller,
    SigningCertDigest,
};
pub use clock::{DEFAULT_CLOCK_SKEW_MS, Deadline, IntentClock, check_request_window};
pub use confirmation::{
    CONFIRMATION_TTL_MS, ConfirmationAuthorization, ConfirmationToken, LABEL_INTENT_CONFIRMATION,
};
pub use error::IntentError;
pub use gate::{AdmittedIntent, IntentGate};
pub use ledger::IntentLedger;
pub use session::{AcceptedResponse, IntentSession};
pub use text::{MAX_TEXT_BYTES, VisibleText, escape_layout_controls, is_forbidden};
pub use wire::{
    ExecutePaymentRequestV1, ExecutePaymentResultV1, Intent, IntentBody, IntentRequest,
    IntentRequestEnvelope, IntentRequestV1, IntentResponseEnvelope, IntentResponseV1,
    IssueDeviceCredentialRequestV1, IssueDeviceCredentialResultV1, LABEL_INTENT_REQUEST,
    MAX_CHALLENGE_BYTES, MAX_INTENT_LIFETIME_MS, RequestId, SignChallengeRequestV1,
    SignChallengeResultV1, TxId, decode_response, encode_request, encode_response,
};

/// The protocol version this crate implements.
///
/// **An envelope naming any other version is refused, not best-guessed.** The
/// check is [`wire::IntentRequest::parse`]'s first act and it happens before
/// the body is interpreted, which is what makes the refusal structural rather
/// than a convention a future field could erode. `#905`'s acceptance criteria
/// name this specifically.
pub const PROTOCOL_VERSION: u16 = 1;
