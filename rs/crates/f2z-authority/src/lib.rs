//! Handle-ownership assertions for the free2z key-transparency log.
//!
//! # Why this is a crate and not a module
//!
//! Everything else in the directory is cryptographic. `akd` proves the tree is
//! append-only; `KT.md` §4.4 proves an entry was authorized by the key that
//! held the handle before; the witnesses prove the log did not equivocate. None
//! of it answers the first question a user actually asks, which is *"is this
//! `@alice` the `@alice` I know?"* — because a key-transparency log will
//! faithfully, verifiably and permanently publish a key for a handle **whoever
//! got there first**.
//!
//! Something has to say who owns a handle, and no amount of cryptography can
//! derive it. That something is a **non-cryptographic trust root**, and this
//! crate is the whole of it. It is separate so that a self-hoster deciding
//! whether to trust our directory, or swapping our authority for their own, or
//! running with none at all, reads **one short crate** — not a server, not a
//! grep through a submission path, not a policy spread over three layers.
//!
//! ```text
//!   the platform (or whoever runs the user directory)
//!         │  signs a HandleAssertion: "@alice is this identity key"
//!         ▼
//!   ┌──────────────┐   the assertion, plus the identity key's own
//!   │ f2z-authority│   signature over the submission it accompanies
//!   └──────────────┘
//!         │  AdmittedHandle — or a refusal with a KT.md §9.5 code
//!         ▼
//!   the log's §4.4 submission path, then akd, then the witnesses
//! ```
//!
//! # The rule that makes it sound
//!
//! An assertion is a **bearer document**. Whoever holds a copy holds everything
//! the authority said, so if holding it were enough to submit under the handle
//! it names, intercepting one would be a takeover.
//!
//! `KT.md` requires that the submission carrying an assertion **also** be signed
//! by the identity private key the assertion is *about*. That is what makes a
//! stolen assertion worthless: producing the second signature needs the very
//! key the thief was trying to replace.
//!
//! This crate makes it impossible to skip rather than important to remember.
//! [`AuthorityConfig::admit`] is the only public verification path; it takes
//! [`Submission::identity_signature`] on every branch, including the branch for
//! a log with no authority at all; and there is no `verify_assertion` beside it
//! to reach a half-checked result through. The negative is tested
//! (`tests/adversarial.rs`).
//!
//! # What it enforces
//!
//! Authority membership and signature, `log_id`, timestamps, **a validity cap
//! the log holds rather than the issuer**, nonce freshness, `handle_id`
//! agreement, the `[a-z0-9_]{1,30}` charset, intent against the entry sequence,
//! and `account_epoch` monotonicity. [`AuthorityConfig::admit`]'s documentation
//! lists all seventeen rules in the order they run.
//!
//! # What it deliberately does not do
//!
//! No clocks, no randomness, no I/O, no storage and no `std`: `now_ms` is an
//! argument and the nonce ledger is a trait, because this crate compiles for
//! `wasm32-unknown-unknown` and clients verify assertions too. It does not
//! parse a `DirectoryEntry`, apply `KT.md` §4.4's own rules, or touch the tree —
//! that is the log's crate. And it has **no username-to-handle mapping**: see
//! [`Handle`] for why that function would be a security decision this crate
//! must not make on anyone's behalf.
//!
//! # Issuing by hand
//!
//! `f2z-assert`, the binary in this package, signs an assertion from a key
//! file, so a self-hoster running a log with no web application can issue one
//! without writing code.
//!
//! ```
//! use f2z_authority::{
//!     AssertionNonce, AuthorityConfig, AuthoritySet, Handle, HandleAssertionTBS, Intent,
//!     LogId, NonceLedger, SigningKey, Submission, Vouch,
//! };
//! use f2z_codec::types::Digest;
//!
//! # fn main() -> Result<(), Box<dyn core::error::Error>> {
//! let log_id = LogId::new([0x11; 32]);
//! let authority = SigningKey::from_seed(&[0x22; 32]);   // the directory's key
//! let identity = SigningKey::from_seed(&[0x33; 32]);    // @alice's ISK
//! let handle = Handle::parse(b"alice")?;
//! let entry_digest = Digest::new([0x44; 32]);           // the submission's AkdValue
//!
//! let config = AuthorityConfig::with_defaults(
//!     log_id,
//!     AuthoritySet::single(authority.public_key())?,
//! )?;
//!
//! // The authority vouches…
//! let assertion = HandleAssertionTBS::new(
//!     &authority.public_key(),
//!     log_id,
//!     handle.clone(),
//!     identity.public_key(),
//!     Intent::Bind,
//!     0,
//!     1_000,
//!     61_000,
//!     AssertionNonce::new([0x55; 16]),
//! )?
//! .sign(&authority)?;
//!
//! // …and @alice answers for herself. Both, or neither.
//! let binding = config.binding(&handle, &identity.public_key(), Some(&assertion), &entry_digest)?;
//! let identity_signature = binding.sign(&identity)?;
//!
//! let mut ledger = NonceLedger::new(4096, config.clock_skew_ms());
//! let admitted = config.admit(
//!     &Submission {
//!         assertion: Some(&f2z_codec::canonical::encode(&assertion)?),
//!         handle: &handle,
//!         identity_pk: &identity.public_key(),
//!         entry_version: 1,
//!         entry_digest: &entry_digest,
//!         identity_signature: &identity_signature,
//!         previous_identity_pk: None,
//!         previous_account_epoch: None,
//!     },
//!     2_000,
//!     &mut ledger,
//! )?;
//!
//! assert!(admitted.vouch().is_vouched());
//! assert_ne!(admitted.vouch(), Vouch::Unvouched);
//! # Ok(())
//! # }
//! ```
//!
//! [`Handle`]: crate::types::Handle
//! [`Submission::identity_signature`]: crate::authority::Submission::identity_signature

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

pub mod assertion;
pub mod authority;
pub mod error;
pub mod key;
pub mod labels;
pub mod nonce;
pub mod types;

pub use assertion::{AssertionBindingTBS, HandleAssertion, HandleAssertionTBS};
pub use authority::{
    AdmittedHandle, AuthorityConfig, AuthorityKey, AuthoritySet, DEFAULT_CLOCK_SKEW_MS,
    DEFAULT_MAX_VALIDITY_MS, Submission, Vouch, VouchingStatus,
};
pub use error::{AuthorityError, Result};
pub use key::{SigningKey, VerifyingKey};
pub use nonce::{NonceLedger, NonceSeen};
pub use types::{
    AssertionNonce, AuthorityId, HANDLE_MAX_LEN, Handle, HandleId, Intent, LogId, authority_id,
};

/// The key-transparency protocol version this crate's structures belong to.
///
/// `KT.md` §4.1 carries a `kt_version` field inside `DirectoryEntryTBS`; a
/// [`HandleAssertionTBS`] does not, because its `label` already spells `/v1/`
/// and a second version marker inside one structure is a second thing to
/// disagree with the first. Stated here so the version is written down
/// somewhere a caller can read it.
pub const KT_VERSION: u16 = 0x0001;
