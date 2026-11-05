//! What a lookup produced — and the two things the type system is used to stop
//! a caller from claiming.
//!
//! # 1. Absence is not proved, and there is no boolean that says otherwise
//!
//! `CLIENT-CONTRACT.md` §3.10 once shipped
//!
//! ```text
//! found: boolean;   // false is a PROVED non-membership, not an error
//! ```
//!
//! and the correction of 2026-08-24 struck the word *proved*: `akd` 0.13 has no
//! API that produces a non-membership proof for a label that was never
//! registered, so what a log serves is an **assertion it must label as
//! unproved on the wire**.
//!
//! There is therefore no `found: bool` here, and no `proved: bool` either. The
//! answer is [`Resolution`], whose absent variant is spelled
//! **[`Resolution::AbsentUnproved`]** — a caller cannot pattern-match it without
//! reading the word. §3.10's correction is explicit that no field is added for
//! this in v1: *"a flag that is a constant `false` in every response this
//! protocol can produce is a reserved field with extra steps"*.
//!
//! # 2. A first entry carries checkable authorization evidence
//!
//! The proposed #649 `InitialBind` case commits its assertion, identity
//! binding, and directory-auth signature into the tree value. This client
//! checks those bytes. The authority key is taken from the log-signed policy;
//! that policy does not make the key a trust root, so callers that need that
//! assurance must pin it out of band.

use f2z_codec::types::PublicKey;
use f2z_kt_core::entry::{DeviceCredential, DirectoryEntry, EntryKind};
use f2z_kt_core::types::Handle;

use crate::standing::WitnessStanding;

/// What §8.1 step 6 established about an entry's own authorization.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum Authorization {
    /// `entry_version == 1`; the directory-auth signature, the identity
    /// binding, and (when present) the authority assertion were checked from
    /// bytes committed in `DirectoryEntry`. The authority key is still only
    /// as trustworthy as the client's out-of-band pin; a log-signed policy
    /// alone does not make that key a trust root.
    InitialBindChecked,
    /// `entry_version > 1`, and §4.4's rules were re-run against the previous
    /// entry this client holds — by [`f2z_kt_core::submit::validate_submission`],
    /// which is the same function the log runs. There is not a second
    /// implementation to disagree with the first.
    CheckedAgainstPredecessor,
    /// `entry_version > 1`, and this client holds no predecessor, so §4.4 could
    /// not be applied. The inclusion proof still holds; the authorization is
    /// simply unexamined, and saying so is the whole point of the variant.
    NoPredecessorHeld,
}

/// What §4.6's signed policy says about who may claim a handle on this log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum Vouching {
    /// The log publishes a signed policy saying an authority must sign a
    /// `HandleAssertion` before a handle's first entry.
    ///
    /// **This is not a trust root or an admission receipt.** A client checks a
    /// proposed committed `InitialBind` artifact against this current policy,
    /// but cannot prove which historical policy was active or that the log
    /// applied every admission-time rule (including nonce single-use). A cold
    /// client can fail closed on old entries after authority-policy changes.
    /// See `KT.md` §§4.7 and 8.5.
    Claimed,
    /// The log's signed policy says it does **not** vouch. Every handle on it
    /// means "whoever got there first", and §8.1 step 7 requires a client to
    /// surface that.
    Unvouched,
    /// The client has not fetched the policy, or the log did not serve one.
    ///
    /// Treated as at least as loud as [`Vouching::Unvouched`] by every caller
    /// in this crate: an unanswered question about who may claim a handle is
    /// not a reassuring answer.
    Unknown,
}

impl Vouching {
    /// Whether this state permits any language implying that somebody attested
    /// to the handle's ownership.
    #[must_use]
    pub const fn permits_attested_language(self) -> bool {
        matches!(self, Self::Claimed)
    }
}

/// A handle whose entry's **inclusion** was proved against a witnessed root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedHandle {
    pub(crate) handle: Handle,
    pub(crate) entry: DirectoryEntry,
    pub(crate) epoch: u64,
    pub(crate) standing: WitnessStanding,
    pub(crate) authorization: Authorization,
    pub(crate) vouching: Vouching,
    pub(crate) pin: PinOutcome,
}

impl ResolvedHandle {
    /// The handle that was asked about — and, checked by
    /// [`f2z_kt_core::verify::decode_entry`], the handle the log answered
    /// about. A proof for `@mallory` verifies perfectly; it just does not
    /// answer the question that was asked.
    #[must_use]
    pub const fn handle(&self) -> &Handle {
        &self.handle
    }

    /// The published entry: devices, revocations, contact endpoints, keys.
    #[must_use]
    pub const fn entry(&self) -> &DirectoryEntry {
        &self.entry
    }

    /// The identity key in force — what a safety number is computed over.
    #[must_use]
    pub const fn identity_pk(&self) -> &PublicKey {
        &self.entry.entry.identity_pk
    }

    /// Credentials eligible for lookup-driven first contact at the verifier's
    /// local time: published, inside the common skew-aware interval, and not
    /// present in the entry's cumulative revocation history.
    pub fn active_devices_at(
        &self,
        verifier_time_ms: u64,
    ) -> impl Iterator<Item = &DeviceCredential> {
        self.entry.entry.active_devices_at(verifier_time_ms)
    }

    /// Select one published device only if it is currently eligible for first
    /// contact under the same rule.
    #[must_use]
    pub fn active_device_at(
        &self,
        device_pk: &PublicKey,
        verifier_time_ms: u64,
    ) -> Option<&DeviceCredential> {
        self.entry
            .entry
            .active_device_at(device_pk, verifier_time_ms)
    }

    /// `entry_version` (§4.2).
    #[must_use]
    pub const fn entry_version(&self) -> u32 {
        self.entry.entry.entry_version
    }

    /// The epoch of the root the proof was verified against.
    #[must_use]
    pub const fn epoch(&self) -> u64 {
        self.epoch
    }

    /// What the client's own witness set established (§8.3).
    #[must_use]
    pub const fn standing(&self) -> WitnessStanding {
        self.standing
    }

    /// What §8.1 step 6 established, including the committed first-entry bind.
    #[must_use]
    pub const fn authorization(&self) -> Authorization {
        self.authorization
    }

    /// What §4.6's signed policy claims about handle vouching on this log.
    #[must_use]
    pub const fn vouching(&self) -> Vouching {
        self.vouching
    }

    /// What happened to the client's pin for this handle.
    #[must_use]
    pub const fn pin(&self) -> PinOutcome {
        self.pin
    }

    /// Whether the entry that was resolved is a platform reset — a key change
    /// made **without the user's old key** (ADR 0014 case 3).
    #[must_use]
    pub const fn is_platform_reset(&self) -> bool {
        matches!(self.entry.entry.kind, EntryKind::PlatformReset)
    }
}

/// An answer that a handle is not registered. **Unproved.**
///
/// There is no accessor here that reports a proof, because there is no proof.
/// What the type carries is the epoch and the standing of the root the log was
/// *standing on* when it made the assertion, which is what forcing the answer
/// in-band buys over an error code: the assertion arrives bundled with a
/// cosigned tree head rather than in a channel that looks like an outage.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AbsentAnswer {
    pub(crate) handle: Handle,
    pub(crate) epoch: u64,
    pub(crate) standing: WitnessStanding,
}

impl AbsentAnswer {
    /// The handle the log says it does not hold.
    #[must_use]
    pub const fn handle(&self) -> &Handle {
        &self.handle
    }

    /// The epoch of the tree head the log answered against.
    #[must_use]
    pub const fn epoch(&self) -> u64 {
        self.epoch
    }

    /// The standing of that root.
    #[must_use]
    pub const fn standing(&self) -> WitnessStanding {
        self.standing
    }
}

/// The outcome of a lookup.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum Resolution {
    /// The handle is registered, and the entry's inclusion at a witnessed root
    /// was proved.
    Resolved(Box<ResolvedHandle>),
    /// The log **asserts** the handle is not registered, and that assertion is
    /// not a proof.
    ///
    /// A caller MAY show the user "no such handle". It MUST NOT record it as an
    /// established fact about the directory, MUST NOT conclude from it that a
    /// handle it has previously resolved has been removed, and MUST NOT let it
    /// weaken or discard a pin it already holds — which this crate enforces by
    /// refusing to produce this variant at all for a pinned handle. See
    /// [`crate::ClientError::PinContradiction`].
    AbsentUnproved(AbsentAnswer),
}

impl Resolution {
    /// The resolved handle, or `None` for an absent answer.
    #[must_use]
    pub const fn resolved(&self) -> Option<&ResolvedHandle> {
        match self {
            Self::Resolved(handle) => Some(handle),
            Self::AbsentUnproved(_) => None,
        }
    }

    /// What the witness set established, either way.
    #[must_use]
    pub const fn standing(&self) -> WitnessStanding {
        match self {
            Self::Resolved(handle) => handle.standing,
            Self::AbsentUnproved(answer) => answer.standing,
        }
    }
}

/// What a lookup did to the client's pin for the handle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum PinOutcome {
    /// No pin was held; this resolution established one. Trust on first use,
    /// and nothing more — §8.1 step 6 is why that is worth saying out loud.
    Established,
    /// The pin was already at this entry. Nothing changed.
    Unchanged,
    /// The pin moved forward by one entry under the same identity key, with
    /// §4.4's `same_key` authorization re-checked.
    Advanced,
    /// The directory is ahead of the pin by more than one entry, under a
    /// **matching identity key**, so the client could not chain it and left the
    /// pin where it was.
    ///
    /// Not an error and not an alarm: two updates between two lookups is
    /// ordinary. A caller that needs the pin current runs
    /// [`crate::KtClient::self_audit`]-style history for the handle. What it
    /// must not do is take this resolution's entry as pinned, and the variant
    /// exists so it cannot do that by accident.
    AheadOfPin,
}
