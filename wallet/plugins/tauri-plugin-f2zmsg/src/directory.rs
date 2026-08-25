//! The key-transparency directory — **a declared seam, and a fail-closed one**.
//!
//! # What exists, and what does not
//!
//! `KT.md`'s log is real: `rs/crates/f2z-kt` is a running server, `f2z-kt-core`
//! is the client verifier and reaches wasm32 at ~1.11 ms per `lookup_verify`,
//! and `f2z-witness` cosigns. What does **not** exist anywhere in this
//! repository is an HTTP client that carries a `/kt/v1/lookup` request from a
//! client to that log and hands the answer to the verifier. So `resolve_handle`
//! and everything downstream of it — `start_conversation`, self-audit, key-change
//! alarms — have no source of truth to consult in this build.
//!
//! # Why the answer is a refusal and not a stub
//!
//! `CLIENT-CONTRACT.md` §6.4's matrix is unambiguous about what to do when the
//! directory cannot be trusted:
//!
//! > Resolving a **new** handle; creating a group with it; accepting a
//! > first-contact `Welcome` from it — **Refused.** This is the #133 moment: an
//! > unverified key here *is* the MITM.
//!
//! and §9 rule 5 forbids proceeding silently. A directory client that returned
//! a plausible-looking resolution from somewhere else would be the exact defect
//! those rules exist to prevent, and a `todo!()` would be a panic in a crypto
//! core. So [`NoDirectory`] answers every lookup with
//! `witness-threshold-unmet`, which is the truthful code: with no configured
//! witnesses, zero independent witnesses have cosigned, and zero is below every
//! threshold.
//!
//! The UI has somewhere correct to go with that. §8 says: never "proceed
//! anyway", never a silent degrade, and offer **manual safety-number
//! verification**, which is always available and is the strongest check in the
//! system regardless of directory state. That path works in this build.
//!
//! # What lands here next
//!
//! One implementation of [`Directory`] over HTTPS to `/kt/v1/lookup`, verifying
//! with `f2z_kt_core::verify`, counting cosignatures from the client's **own**
//! configured witness set (`KT.md` §8.3 — a cosignature from any witness not in
//! that set is "not weighed, not counted, not displayed as reassurance"), and
//! honouring §9 rule 9: `found: false` must never overwrite a pin, and a
//! contradiction with a held pin raises an alarm and fails closed.

use crate::error::Error;
use crate::models::{DirectoryResolution, ErrorCode};

/// Everything the engine needs about a peer before it can reach them.
///
/// `DirectoryResolution` is the *frontend's* view — what §3.10 shows a user
/// about a lookup. This is the engine's, and it carries the two things a
/// lookup has to produce for first contact to be possible at all: the peer's
/// current `KeyPackage`, and the `contact_addr` its `Welcome` is delivered to
/// (`WIRE.md` §12.2). Both are published by the peer through the directory;
/// neither is guessable.
#[derive(Clone, Debug)]
pub struct ResolvedPeer {
    /// What the UI is told (§3.10).
    pub resolution: DirectoryResolution,
    /// The peer's `identity_pk`, hex — the value a safety number is computed
    /// over and a key change is detected against.
    pub identity_pk: String,
    /// An MLS `KeyPackage` the peer published, to add them to a new group.
    pub key_package: Vec<u8>,
    /// The relay the peer's contact queue lives on.
    pub contact_relay_url: String,
    /// The published, never-bindable contact address, hex (§12.2).
    pub contact_addr: String,
}

/// What the engine needs from a key-transparency log.
///
/// Deliberately narrow. Submission is the app crate's (§2.2 — it needs the
/// seed-derived `DirectoryAuthKey`), and auditing is a witness's job, not a
/// phone's: append-only consistency proofs are O(entries added) and were
/// measured at 3.9 MB and 1–3 s for five epochs (`KT.md` §8.5).
pub trait Directory: Send + Sync + 'static {
    /// Resolve a handle against a witness-cosigned root.
    ///
    /// An unregistered handle is an **answer, not a failure**: this succeeds
    /// with `found: false`, and there is no unknown-handle error code in either
    /// direction (§3.10). Per the 2026-08-24 correction that answer is the
    /// log's *assertion* and not a proof — `akd` 0.13 produces no
    /// non-membership proof — so no caller may present it as verified.
    ///
    /// # Errors
    ///
    /// `witness-threshold-unmet` when fewer than *t* independent witnesses have
    /// cosigned the root, `directory-unreachable` when the log does not answer,
    /// and `directory-proof-invalid` — which is **fork evidence**, not a
    /// network glitch — when a proof fails.
    fn resolve(&self, handle: &str) -> crate::error::Result<DirectoryResolution>;

    /// The same lookup, plus the material first contact needs.
    ///
    /// Separate from [`Directory::resolve`] because `resolve_handle` is a
    /// *question a user asked* and answers `found: false` for a handle nobody
    /// has registered, while this is a step in a handshake that cannot proceed
    /// without a key. A `found: false` here is a refusal, not an answer.
    ///
    /// # Errors
    ///
    /// As [`Directory::resolve`], plus `witness-threshold-unmet` when §6.4's
    /// matrix refuses to resolve a **new** handle at all.
    fn resolve_peer(&self, handle: &str) -> crate::error::Result<ResolvedPeer>;

    /// How many of the client's own configured witnesses are independent
    /// (`KT.md` §8.3). The number the UI displays; the configured count is
    /// deliberately not the headline.
    fn independent_witnesses(&self) -> u32;

    /// Whether the threshold is met, which is what §6.4's matrix is keyed on.
    fn threshold_met(&self) -> bool;
}

/// The only implementation in this build. Fails closed, loudly, every time.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoDirectory;

impl Directory for NoDirectory {
    fn resolve(&self, handle: &str) -> crate::error::Result<DirectoryResolution> {
        Err(Error::new(
            ErrorCode::WitnessThresholdUnmet,
            format!(
                "no key-transparency client is configured, so zero independent witnesses \
                 have cosigned any root; refusing to resolve {handle:?} rather than \
                 returning an unverified key"
            ),
        ))
    }

    fn resolve_peer(&self, handle: &str) -> crate::error::Result<ResolvedPeer> {
        // Written as an explicit refusal rather than as `resolve(..)?` plus an
        // `unreachable!()`: a panic in a crypto core is a crash of the client,
        // and "this branch cannot be taken" is exactly the kind of claim that
        // stops being true when somebody edits the function above it.
        Err(Error::new(
            ErrorCode::WitnessThresholdUnmet,
            format!(
                "first contact with {handle:?} needs a witness-cosigned KeyPackage and \
                 contact address; no key-transparency client is configured"
            ),
        ))
    }

    fn independent_witnesses(&self) -> u32 {
        0
    }

    fn threshold_met(&self) -> bool {
        false
    }
}
