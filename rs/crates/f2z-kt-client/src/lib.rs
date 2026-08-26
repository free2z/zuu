//! The key-transparency **client** — `docs/e2ee/KT.md` v1 §8 and §9.2.
//!
//! `f2z-kt-core` is the verification. This crate is everything between that
//! verification and a running client: the §9.2 endpoints, the state that makes
//! §6.3's monotonicity rules mean anything, §8.3's threshold applied and failed
//! closed on, §8.2's self-audit, and the pins and alarms `CLIENT-CONTRACT.md`
//! §9 rules 4 and 9 require.
//!
//! It reimplements no rule. Every verdict about the protocol comes from
//! `f2z-kt-core`, which is what `KT.md` §11.4's *one crate, three consumers*
//! requires — a client that verified with a different implementation than the
//! log builds with would accept and refuse different things than the witness
//! that audits it.
//!
//! # THE FOUR THINGS THIS CRATE REFUSES TO OVERCLAIM
//!
//! They are the point of the design, not caveats appended to it, so they are at
//! the top rather than at the bottom.
//!
//! **1. Absence is not proved.** `akd` 0.13 has no API that produces a
//! non-membership proof for a label that was never registered — `Directory::
//! lookup` errors with `StorageError::NotFound` and produces no proof of
//! anything. So "no such handle" is an **assertion the log labels as unproved
//! on the wire**, and this crate's answer for it is spelled
//! [`Resolution::AbsentUnproved`]. There is no `found: bool`. `CLIENT-CONTRACT.md`
//! §3.10 previously shipped `found: boolean // false is a PROVED
//! non-membership`, which told a UI that a downgrade attack was impossible; it
//! was corrected and this crate does not reintroduce it.
//! [#634](https://github.com/free2z/zuu/issues/634).
//!
//! **2. A contradiction is not provable to a third party.** The log signs tree
//! heads, **not lookup responses**. So when the log tells this client that a
//! handle it has already pinned does not exist, the client fails closed, keeps
//! the pin and alarms — and [`AlarmKind::is_provable_to_a_third_party`] returns
//! `false` for that alarm, because the answer is not a signed statement, is not
//! non-repudiable, and cannot be published as evidence the way §7.3's
//! `rollback`, `fork` or `chain_break` reports can. Only
//! [`AlarmKind::DirectoryForkEvidence`] returns `true`, and it earns it: two
//! signed tree heads are the complete evidence (§8.4).
//!
//! **3. A client cannot substitute its own consistency check for a witness's.**
//! `akd`'s `AppendOnlyProof` is O(entries added), not O(log n) — 3.9 MB and 1–3
//! seconds for five epochs (§10). There is therefore **no `audit` method on
//! [`Transport`] and none on [`KtClient`]**, and no fallback when the witness
//! set is absent, unreachable or not independent. §8.5 says this makes the
//! witness set more load-bearing than §9.3's prose implies, not less, and the
//! absent method is this crate agreeing.
//!
//! **4. Witness independence is a social fact, not a cryptographic one.**
//! free2z currently operates the log **and** the only witness, which provides
//! **zero** independent anti-equivocation. §8.3: *"whatever *t* is configured,
//! the cryptographic value of meeting it is zero until at least two witnesses
//! are run by parties outside free2z. A client that displays '3 of 3 witnesses'
//! in that state is displaying a reassuring number for a property it does not
//! have."* So [`WitnessStanding::independent`] is the short name and
//! [`WitnessStanding::counted_including_dependent`] is the long one, and
//! [`WitnessStanding::is_independently_witnessed`] returns `false` in the
//! shipped configuration on purpose.
//!
//! # And one more, which is about the *first* entry
//!
//! §8.1 step 6: at `entry_version == 1` **there is nothing to verify**. §4.5
//! says what authorizes a first entry and the log checks it at submission, but
//! it is not committed to the tree, so a client is served no artefact to check
//! ([#649](https://github.com/free2z/zuu/issues/649)). Resolving a stranger for
//! the first time therefore establishes inclusion and **not** entitlement, and
//! [`Authorization::FirstEntryUnverifiable`] is what this crate returns rather
//! than a check that quietly passes.
//!
//! # Shape
//!
//! ```text
//!   caller ──► KtClient ──► Transport  (a socket; yours on wasm32)
//!                  │
//!                  ├──► wire      encode/decode, no state, no clock
//!                  ├──► f2z-kt-core  every protocol verdict
//!                  ├──► PinStore  §8.1 step 8; nothing overwrites
//!                  └──► AlarmLog  non-dismissible; nothing removes
//! ```
//!
//! [`Transport`] is **synchronous**, and [`crate::transport`] justifies that at
//! length: the `Send` bound on an `async fn` in a trait splits by target — a
//! browser's `JsFuture` is `!Send` — and neither real consumer is async-shaped.
//! A browser drives `fetch` itself and hands the bytes in; the verification
//! that follows is the same code on both targets, which is the property
//! [ADR 0001](https://github.com/free2z/zuu/blob/main/docs/e2ee/decisions/0001-platform-priority.md)
//! is about.
//!
//! # Example
//!
//! ```no_run
//! use core::time::Duration;
//!
//! use f2z_kt_client::{ClientConfig, HttpTransport, KtClient, Resolution};
//! use f2z_kt_core::types::{Handle, LogId};
//! use f2z_kt_core::{ConfiguredWitness, WitnessSet};
//! use f2z_codec::types::PublicKey;
//!
//! # fn main() -> Result<(), Box<dyn core::error::Error>> {
//! let witnesses = WitnessSet::new(
//!     // Independence is the caller's assertion and nothing infers it.
//!     vec![ConfiguredWitness::dependent(PublicKey::new([0u8; 32]))],
//!     1,
//! )?;
//! let config = ClientConfig {
//!     log_id: LogId::new([0u8; 32]),
//!     accepted_log_pk: PublicKey::new([0u8; 32]),
//!     witnesses,
//!     reset_authority_pk: PublicKey::new([0u8; 32]),
//!     reset_cooldown_seconds: 604_800,
//! };
//!
//! let transport = HttpTransport::new("https://kt.free2z.cash", Duration::from_secs(20))?;
//! let mut client = KtClient::bootstrap(transport, config)?;
//! client.refresh_authority_policy()?;
//!
//! match client.resolve(&Handle::new(b"alice".to_vec())?, 1_700_000_000_000)? {
//!     Resolution::Resolved(handle) => {
//!         // `handle.standing().independent()` is the number to display.
//!         let _ = handle.identity_pk();
//!     }
//!     Resolution::AbsentUnproved(_) => {
//!         // The log SAYS there is no such handle. It did not prove it.
//!     }
//!     // `Resolution` is `#[non_exhaustive]`: if `akd` ever gains the
//!     // non-membership proof §11.5 describes, the variant that carries it
//!     // arrives here and this arm is where a caller notices.
//!     _ => {}
//! }
//! # Ok(()) }
//! ```
//!
//! [`AlarmKind::is_provable_to_a_third_party`]: crate::AlarmKind::is_provable_to_a_third_party
//! [`WitnessStanding::independent`]: crate::WitnessStanding::independent

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

pub mod alarm;
pub mod audit;
pub mod error;
pub mod pin;
pub mod resolve;
pub mod standing;
pub mod transport;
pub mod wire;

#[cfg(feature = "verifier")]
pub mod client;

#[cfg(test)]
mod testing;

pub use alarm::{Alarm, AlarmKind, AlarmLog, Severity};
pub use audit::{SelfAuditReport, UnexpectedEntry};
pub use error::{ClientError, Result};
pub use pin::{HandlePin, PinStore};
pub use resolve::{AbsentAnswer, Authorization, PinOutcome, Resolution, ResolvedHandle, Vouching};
pub use standing::WitnessStanding;
pub use transport::{Detached, Transport};
pub use wire::{
    CONTENT_TYPE, PATH_AUTHORITY, PATH_DESCRIPTOR, PATH_HISTORY, PATH_LOOKUP, PATH_STH,
};

#[cfg(feature = "verifier")]
pub use client::{ClientConfig, KtClient, MAX_EPOCH_CATCHUP};

#[cfg(feature = "http")]
pub use transport::HttpTransport;

/// The key-transparency protocol version this client speaks.
///
/// The same constant `f2z-kt-core` holds, re-exported rather than restated: a
/// client and the log it talks to disagreeing about the version is exactly the
/// failure §6.2's in-band version field exists to catch, and two copies of the
/// number would be a way to have that disagreement inside one process.
pub const KT_VERSION: u16 = f2z_kt_core::KT_VERSION;
