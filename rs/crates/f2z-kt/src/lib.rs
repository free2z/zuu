//! **The free2z key-transparency log server** — the implementation of
//! [`docs/e2ee/KT.md`] §5, §6 and §9 that `f2z-kt-core` deliberately leaves to
//! a server: storage, clocks, keys, sockets and policy numbers.
//!
//! # What this binary is for, in one paragraph
//!
//! `f2z-kt-core` verifies and validates; it has no I/O, no clock, no keys and
//! no `publish()`. This crate is everything between that and a running
//! directory: the durable journals ([`store`]), the submission choke point
//! ([`admit`]), the `akd` tree and the epoch scheduler ([`log`]), the signing
//! key behind a trait ([`signer`]), and `KT.md` §9.2's endpoints ([`api`]).
//!
//! # The single most important thing in this crate
//!
//! > `KT.md` §4.4: **`akd` enforces none of it.** The library will happily
//! > commit any bytes to any label. A log that skips §4.4's rules produces
//! > inclusion, history and append-only proofs that verify **perfectly** for
//! > entries nobody authorized. The transparency machinery proves that the log
//! > did not *change its mind*; §4.4 is the only thing that proves the log did
//! > not *make it up*.
//!
//! So the architecture is one door and no windows:
//!
//! | To reach | You must hold | Which requires |
//! |---|---|---|
//! | `akd::Directory::publish` | an [`admit::AdmittedSubmission`] | [`admit::admit_submission`] |
//! | [`admit::AdmittedSubmission`] | an [`f2z_kt_core::AcceptedSubmission`] **and** a handle authorization | [`f2z_kt_core::validate_submission`] **and** [`f2z_authority::AuthorityConfig::admit`] |
//!
//! Neither carrier has a public constructor. `tests/adversarial.rs` is the test
//! that watches it hold, against a first entry with no assertion, a rotation
//! signed by one key, a reset inside its cooldown, a device credential signed
//! by the wrong identity key, and a wrong `prev_entry_hash`.
//!
//! # zuu#594 — and what this log does about it
//!
//! `KT.md` §4.4 does not say what authorizes a handle's **first** entry, so a
//! literal implementation hands `@alice` to whoever asks first. This log
//! **requires a `HandleAssertion`** for `entry_version == 1`, verified by
//! [`f2z_authority`], and offers that as the crate proposal against [zuu#594]
//! rather than as ratified specification. Operators with no authority run the
//! explicit no-authority mode — and it is **reported**, in the signed document
//! [`policy`] serves at `/.well-known/free2z-kt/v1/authority`, so a client can
//! see that handles on such a log are unvouched.
//!
//! # Deviations, all of them, in one place
//!
//! Each is argued where it is implemented and each is in the pull request:
//!
//! - **Heartbeat epochs** ([`log`]). §5.1 requires an epoch every interval with
//!   *"an append-only proof over zero insertions"*, and `akd` cannot produce
//!   one — `publish` with an empty batch does not advance the epoch. One
//!   heartbeat record per epoch is inserted instead.
//! - **Unproved absence** ([`wire::Presence`]). §8.1 requires a **proof** of
//!   non-membership for an unregistered handle and `akd` 0.13 has no API that
//!   produces one. The answer is labelled unproved rather than dressed up.
//! - **The submission envelope** ([`wire::SubmissionEnvelope`]). §9.2 says
//!   `/kt/v1/submit` carries a `DirectoryEntry`; it carries the entry plus the
//!   two fields zuu#594 needs.
//! - **The authority policy document** ([`policy`]). A new signed structure and
//!   a new label, added to §6.2's otherwise closed set.
//! - **TLS terminates ahead of the process** ([`api`]).
//!
//! [`docs/e2ee/KT.md`]: https://github.com/free2z/zuu/blob/main/docs/e2ee/KT.md
//! [zuu#594]: https://github.com/free2z/zuu/issues/594

#![forbid(unsafe_code)]

pub mod admit;
pub mod api;
pub mod config;
pub mod descriptor;
pub mod error;
pub mod hexbytes;
pub mod json;
pub mod log;
pub mod logging;
pub mod policy;
pub mod ratelimit;
pub mod server;
pub mod signer;
pub mod store;
pub mod vrf;
pub mod wire;

#[cfg(any(test, feature = "testing"))]
pub mod testing;

pub use admit::{AdmissionContext, AdmittedSubmission, admit_submission};
pub use config::{Config, LogSettings};
pub use error::{LogError, Result};
pub use log::LogService;
pub use policy::{SignedAuthorityPolicy, sign_policy};
pub use signer::{FileSigner, LogSigner};
pub use wire::{Presence, SubmissionEnvelope, TreeHeadBundle};

/// The wall clock, in milliseconds since the Unix epoch.
///
/// The one place this process reads a clock. Everything below takes `now_ms` as
/// an argument, which is why `f2z-kt-core` has no clock at all and why every
/// timing rule in `KT.md` §4.4 and §5 is testable at an instant.
///
/// A clock before the Unix epoch yields 0 rather than panicking. That is not a
/// state a log can operate in — every `published_at_ms` would fail §6.3 rule 5
/// — but it is a state to *report*, not to crash on.
#[must_use]
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}
