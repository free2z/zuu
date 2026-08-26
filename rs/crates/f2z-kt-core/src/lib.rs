//! Key transparency for the free2z directory, version 1 — the implementation of
//! [`docs/e2ee/KT.md`].
//!
//! **One crate, three consumers** (`KT.md` §11.4). The log server, the witness
//! and the client all link this crate, native and WASM. That is not tidiness: a
//! witness that verified with a different implementation than the log builds
//! with would produce cosignatures that mean nothing, and §7.4's only structural
//! defence against a lazy witness is that there are not two implementations to
//! disagree.
//!
//! # What this crate is for, in one paragraph
//!
//! [ADR 0013] adopts [`akd`](https://github.com/facebook/akd) for the
//! append-only zero-knowledge set — the sparse Patricia tree over VRF-derived
//! labels, the commitments, and the membership, non-membership and append-only
//! proofs. That is the entire cryptographic core, and it is the part we do not
//! write. It is also **all** we get: `akd` ships no signed tree heads, no
//! cosigning, no gossip, no receipts and only an in-memory database. Everything
//! between that library and a key-transparency deployment is here.
//!
//! # The single most important thing in this crate
//!
//! > **`akd` enforces none of our authorization rules.** The library will
//! > happily commit any bytes to any label. Every rule in `KT.md` §4.4 lives in
//! > our submission path, and a log that skips them produces inclusion, history
//! > and append-only proofs that verify **perfectly** for entries nobody
//! > authorized. The transparency machinery proves that the log did not *change
//! > its mind*; §4.4 is the only thing that proves the log did not *make it up*.
//!
//! So the crate is built around choke points rather than helpers, and the type
//! system carries the rules:
//!
//! | To get | You must first | Which requires |
//! |---|---|---|
//! | [`submit::AcceptedSubmission`] — the only carrier of an `AkdLabel`/`AkdValue` pair | [`submit::validate_submission`] | every rule in §4.4, in order |
//! | [`witness::AcceptedRoot`] — the only root a proof may be verified against | [`witness::verify_threshold`] | ≥ *t* cosignatures from the caller's **own** witness set (§8.3) |
//! | an advanced [`sth::LogView`] | [`sth::LogView::accept`] | all eight of §6.3's monotonicity rules, with no skipping over an epoch gap |
//! | an advanced [`auditor::WitnessState`] | [`auditor::verify_append_only`] | `akd`'s auditor actually having run (§7.4) |
//! | a successor log signing key | [`sth::LogView::accept_log_key_transition`] | a **cosigned** announcement plus both signatures (§6.4) |
//!
//! None of these has a public constructor and none of them has a bypass flag.
//! Forgetting a rule is not a state a caller can reach by omission; it takes
//! deleting a call, not failing to write one.
//!
//! # Features
//!
//! - `verifier` — the client half (§8.1, §8.2), wrapping `akd_core`. **Reaches
//!   `wasm32-unknown-unknown`**, and the CI wasm job builds exactly this.
//! - `auditor` — the witness half (§7.1 step 4), wrapping the server crate
//!   `akd`. **Does not work on wasm**: `audit_verify` hardcodes
//!   `AzksParallelismConfig::default()` and reaches `tokio::task::spawn`, so it
//!   compiles for that target and traps at runtime (§11.3). The witness is a
//!   native outbound-polling daemon (§9.3), so this costs nothing.
//!
//! Both are on by default, because the log server wants both and because
//! `cargo deny` judges the default graph — a floor that is only in an optional
//! feature is a floor nothing checks. The browser build is
//! `--no-default-features --features verifier`.
//!
//! # The version floor is not in this manifest
//!
//! `akd >= 0.13.0` is a **hard floor**, and it is held by a `[[bans.deny]]`
//! entry in `rs/deny.toml` rather than by the version requirement in
//! `Cargo.toml`. [facebook/akd#495] — the auditor append-only bypass that sets
//! the floor, where a malicious log could rewrite a label's value while still
//! producing a **valid** append-only proof — has **no RustSec or OSV advisory**
//! and never will, so `cargo audit` and `cargo deny advisories` pass on a stale
//! `0.12.0` pin silently and forever. A manifest requirement is not a floor
//! either: a `[patch.crates-io]`, a path dependency, a workspace inheritance
//! change or a vendored copy all walk under it without comment. **A reviewer who
//! removes that entry has removed the floor; there is no second line of
//! defence.**
//!
//! # What this crate deliberately does not do
//!
//! No signing, no key generation, no randomness, no clocks, no sockets, no
//! storage, no HTTP and no policy numbers. It verifies, it validates, and it
//! builds the exact byte strings that the layers above sign and send. `KT.md`
//! §12's open questions — the epoch cadence, the default *t*, the shipped
//! witness list, the gossip protocol, reset-authority pinning — are open here
//! too, and are left as caller-supplied values rather than answered by
//! invention.
//!
//! [`docs/e2ee/KT.md`]: https://github.com/free2z/zuu/blob/main/docs/e2ee/KT.md
//! [ADR 0013]: https://github.com/free2z/zuu/blob/main/docs/e2ee/decisions/0013-key-transparency-log.md
//! [facebook/akd#495]: https://github.com/facebook/akd/pull/495

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
// The builders in `testing` are `#[cfg(test)]` and are held to the same lints
// as the tests that use them.
#![cfg_attr(test, allow(clippy::missing_panics_doc, clippy::missing_errors_doc))]

/// `KT.md` §9.2's request and response envelopes — see the module note for why
/// they live in the shared crate rather than in the server.
pub mod api;
pub mod cosign;
pub mod descriptor;
pub mod entry;
pub mod error;
pub mod labels;
pub mod policy;
pub mod receipt;
pub mod sig;
pub mod sth;
pub mod submit;
pub mod types;
pub mod witness;

#[cfg(feature = "auditor")]
pub mod auditor;
#[cfg(feature = "verifier")]
pub mod verify;

#[cfg(test)]
mod testing;

pub use api::{
    AuditResponse, ErrorBody, HistoryRequest, HistoryResponse, LookupRequest, LookupResponse,
    Presence, SubmissionEnvelope, TreeHeadBundle,
};
pub use cosign::{WitnessCosignature, WitnessCosignatureTBS};
pub use descriptor::{LogDescriptor, SignedLogDescriptor};
pub use entry::{
    ContactEndpoint, DeviceCredential, DeviceCredentialTBS, DeviceRevocation, DirectoryEntry,
    DirectoryEntryTBS, EntryAuthorization, EntryKind, ResetAuthorization, ResetAuthorizationTBS,
    RotationProof, RotationProofTBS,
};
pub use error::{ErrorCode, KtError};
pub use receipt::{SubmissionReceipt, SubmissionReceiptTBS};
pub use sth::{LogKeyTransition, LogKeyTransitionTBS, LogView, SignedTreeHead, SignedTreeHeadTBS};
pub use submit::{
    AcceptedSubmission, LogPolicy, PublishedEntry, SubmissionContext, validate_submission,
};
pub use types::{Handle, KemPublicKey, LogId};
pub use witness::{
    AcceptedRoot, ConfiguredWitness, FaultKind, FaultReport, FaultReportTBS, WitnessSet,
    verify_threshold,
};

/// The key-transparency protocol version this crate implements.
///
/// `KT.md` §4.1 and §6.1: `kt_version` is `0x0001`, and it appears inside every
/// signed structure that carries one so that a verifier checks it before acting
/// on the bytes.
pub const KT_VERSION: u16 = 0x0001;

/// `KT.md` §5.1's proposed epoch cadence, in seconds.
///
/// **A placeholder, and stated as one.** §5.1 and §12 are explicit that the
/// value needs measurement
/// ([§13-P](https://github.com/free2z/zuu/issues/311)); what matters is the
/// *structure* of the rule — the log publishes an epoch whether or not there is
/// anything to publish, so that silence becomes a **detectable fault with a
/// timestamp** rather than an ambiguity between "nobody changed a key", "the log
/// has stopped" and "the log is serving me a stale branch."
///
/// It is a constant here only so a log's configuration has something to default
/// from, and nothing in this crate reads it.
pub const PROPOSED_EPOCH_INTERVAL_SECONDS: u32 = 600;

/// `KT.md` §5.2's proposed maximum merge delay, in seconds — six epochs.
///
/// The same placeholder caveat as [`PROPOSED_EPOCH_INTERVAL_SECONDS`]. The
/// property that matters is that a published MMD turns "the log accepted my
/// entry and then never published it" from a complaint into a **breach of a
/// signed promise with a deadline**, provable from two documents anyone can
/// check.
pub const PROPOSED_MAX_MERGE_DELAY_SECONDS: u32 = 3_600;
