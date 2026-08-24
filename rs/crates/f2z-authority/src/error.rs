//! Every way an assertion can be refused, and the `KT.md` §9.5 code each one
//! travels as.
//!
//! The variants are finer-grained than the wire codes on purpose. §9.5 has one
//! code — `ERR_BAD_AUTHORIZATION` — for the whole of §4.4, which is the right
//! answer *on the wire* (a submitter learns that its submission was not
//! authorized, and nothing about which of a dozen rules caught it) and the
//! wrong answer *in a log*, where an operator debugging a real user's failed
//! submission needs to know whether the clock, the charset or the nonce was the
//! problem. Keeping both is what [`AuthorityError::kt_error_code`] is for: the
//! detail stays local, the code goes out.

use core::fmt;

use f2z_codec::CodecError;

/// `ERR_MALFORMED` — `KT.md` §9.5 code 1.
pub const ERR_MALFORMED: u16 = 1;
/// `ERR_UNSUPPORTED_VERSION` — `KT.md` §9.5 code 2. Also "a `log_id` this
/// server does not serve", which is what a wrong-log assertion is.
pub const ERR_UNSUPPORTED_VERSION: u16 = 2;
/// `ERR_BAD_SIGNATURE` — `KT.md` §9.5 code 3.
pub const ERR_BAD_SIGNATURE: u16 = 3;
/// `ERR_BAD_AUTHORIZATION` — `KT.md` §9.5 code 4.
pub const ERR_BAD_AUTHORIZATION: u16 = 4;
/// `ERR_RATE_LIMITED` — `KT.md` §9.5 code 9.
pub const ERR_RATE_LIMITED: u16 = 9;
/// `ERR_INTERNAL` — `KT.md` §9.5 code 11. Carries no detail, ever.
pub const ERR_INTERNAL: u16 = 11;

/// Anything this crate refuses to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum AuthorityError {
    /// The bytes did not decode, re-encoded to something else (`WIRE.md`
    /// §3.3), or were the wrong length for a fixed-width field.
    Malformed,
    /// The `label` field is not [`LABEL_ASSERTION_TBS`].
    ///
    /// [`LABEL_ASSERTION_TBS`]: crate::labels::LABEL_ASSERTION_TBS
    WrongLabel,
    /// The bytes are not `[a-z0-9_]{1,30}` (`WIRE.md` §14.1).
    HandleCharset,
    /// `handle_id` is not the digest of `handle`. The assertion contradicts
    /// itself.
    HandleIdMismatch,
    /// The assertion's `handle` is not the handle of the submission it was
    /// presented with.
    HandleMismatch,
    /// The assertion's `identity_pk` is not the submission's `identity_pk`.
    IdentityMismatch,
    /// `log_id` names a different log.
    WrongLog,
    /// No configured authority has the assertion's `authority_id`. Either the
    /// issuer is not one of ours, or a rotation removed it.
    UnknownAuthority,
    /// The authority's signature over the assertion did not verify.
    BadAuthoritySignature,
    /// The identity key's signature over the binding did not verify — or, for a
    /// key that is not a curve point, could never have.
    ///
    /// **This is the refusal that makes a stolen assertion worthless.** See
    /// [`crate::authority`].
    BadIdentitySignature,
    /// `expires_ms` is not strictly after `issued_ms`.
    EmptyValidity,
    /// `expires_ms - issued_ms` is longer than the log's own cap.
    ///
    /// Checked by the log against its *own* policy, never against a number the
    /// assertion carries: a compromised issuer that could choose its own
    /// validity would mint one assertion good for a decade.
    ValidityTooLong,
    /// `issued_ms` is further in the future than the clock skew allows.
    NotYetIssued,
    /// `now_ms` has reached `expires_ms`.
    Expired,
    /// This `(authority_id, nonce)` pair has been admitted before.
    ReplayedNonce,
    /// The nonce ledger is full of unexpired entries. A refusal, never an
    /// eviction — see [`crate::nonce`].
    LedgerFull,
    /// An assertion's `intent` does not match the declared entry kind:
    /// `bind` is for the initial claim and `reset` is for `platform_reset`.
    IntentMismatch,
    /// The declared entry kind disagrees with its sequence position or with
    /// whether it retains or changes the published identity key.
    EntryKindMismatch,
    /// A non-initial entry did not carry the predecessor's vouching state.
    MissingPriorVouch,
    /// An initial entry claimed a predecessor vouching state it cannot have.
    UnexpectedPriorVouch,
    /// A non-initial entry did not carry its predecessor's `account_epoch`.
    MissingPriorAccountEpoch,
    /// An initial entry claimed a predecessor `account_epoch` it cannot have.
    UnexpectedPriorAccountEpoch,
    /// A `reset` assertion was presented for a submission that keeps the
    /// identity key it is replacing.
    ///
    /// The same refusal also covers a `key_change` entry that keeps its key:
    /// both exceptional cases claim a key transition and therefore have to
    /// replace the predecessor.
    IdentityUnchanged,
    /// `account_epoch` did not advance past the last admitted assertion for
    /// this handle.
    AccountEpochRegression,
    /// `account_epoch` is too large to be a count of account-ownership events,
    /// so it is a clock rather than the counter `KT.md` §4.5.4 requires.
    ///
    /// See [`ACCOUNT_EPOCH_CEILING`]. This is a *necessary* condition, not a
    /// sufficient one: it refuses the specific non-conformance §4.5.4 names —
    /// Unix time in a `uint32` — and cannot prove that a value below the
    /// ceiling came from a durable counter.
    ///
    /// [`ACCOUNT_EPOCH_CEILING`]: crate::authority::ACCOUNT_EPOCH_CEILING
    AccountEpochNotACounter,
    /// `account_epoch` advanced past the predecessor's by more than one
    /// assertion can account for.
    ///
    /// A counter increments once per account-ownership event, so the gap
    /// between two admitted assertions for one handle is small. A clock's gap
    /// is however much time passed. See [`MAX_ACCOUNT_EPOCH_STEP`].
    ///
    /// [`MAX_ACCOUNT_EPOCH_STEP`]: crate::authority::MAX_ACCOUNT_EPOCH_STEP
    AccountEpochStepTooLarge,
    /// An initial bind or platform reset on a vouched log arrived without its
    /// platform assertion.
    MissingAssertion,
    /// An assertion appeared where none can be judged: either the log has no
    /// authority, or a routine user-authorized entry carried a platform
    /// assertion. Refused rather than ignored.
    UnexpectedAssertion,
    /// An [`AuthoritySet`] was built with no entries. Not the same thing as
    /// having no authority, which has to be spelled — see [`AuthoritySet`].
    ///
    /// [`AuthoritySet`]: crate::authority::AuthoritySet
    EmptyAuthoritySet,
    /// Two entries in an [`AuthoritySet`] share an `authority_id`.
    ///
    /// [`AuthoritySet`]: crate::authority::AuthoritySet
    DuplicateAuthority,
    /// An [`AuthorityKey`] was built whose id is not the digest of its key.
    ///
    /// [`AuthorityKey`]: crate::authority::AuthorityKey
    AuthorityIdNotDerived,
    /// A policy was built with a zero or absurd validity cap.
    InvalidPolicy,
}

impl AuthorityError {
    /// The `KT.md` §9.5 code a log answers a submission with.
    ///
    /// | This crate | §9.5 |
    /// |---|---|
    /// | decode / charset / length | `ERR_MALFORMED` (1) |
    /// | wrong `log_id` | `ERR_UNSUPPORTED_VERSION` (2) |
    /// | either signature | `ERR_BAD_SIGNATURE` (3) |
    /// | every other rule | `ERR_BAD_AUTHORIZATION` (4) |
    /// | ledger full | `ERR_RATE_LIMITED` (9) |
    /// | configuration fault | `ERR_INTERNAL` (11) |
    ///
    /// The last row is the one to notice: a misconfigured authority set is the
    /// log's fault, not the submitter's, and §9.5 is explicit that
    /// `ERR_INTERNAL` carries no detail. A log that answered
    /// `ERR_BAD_AUTHORIZATION` there would blame a user for an operator error
    /// and hide the operator error.
    #[must_use]
    pub const fn kt_error_code(self) -> u16 {
        match self {
            Self::Malformed | Self::HandleCharset => ERR_MALFORMED,
            Self::WrongLog => ERR_UNSUPPORTED_VERSION,
            Self::BadAuthoritySignature | Self::BadIdentitySignature => ERR_BAD_SIGNATURE,
            Self::LedgerFull => ERR_RATE_LIMITED,
            Self::EmptyAuthoritySet
            | Self::DuplicateAuthority
            | Self::AuthorityIdNotDerived
            | Self::InvalidPolicy => ERR_INTERNAL,
            Self::WrongLabel
            | Self::HandleIdMismatch
            | Self::HandleMismatch
            | Self::IdentityMismatch
            | Self::UnknownAuthority
            | Self::EmptyValidity
            | Self::ValidityTooLong
            | Self::NotYetIssued
            | Self::Expired
            | Self::ReplayedNonce
            | Self::IntentMismatch
            | Self::EntryKindMismatch
            | Self::MissingPriorVouch
            | Self::UnexpectedPriorVouch
            | Self::MissingPriorAccountEpoch
            | Self::UnexpectedPriorAccountEpoch
            | Self::IdentityUnchanged
            | Self::AccountEpochRegression
            | Self::AccountEpochNotACounter
            | Self::AccountEpochStepTooLarge
            | Self::MissingAssertion
            | Self::UnexpectedAssertion => ERR_BAD_AUTHORIZATION,
        }
    }

    /// Whether this is the log's own misconfiguration rather than a verdict on
    /// a submission.
    #[must_use]
    pub const fn is_configuration_fault(self) -> bool {
        self.kt_error_code() == ERR_INTERNAL
    }

    /// A stable, one-line explanation. No user data ever appears in it.
    #[must_use]
    pub const fn detail(self) -> &'static str {
        match self {
            Self::Malformed => "the bytes are not a canonical assertion",
            Self::WrongLabel => "the label field is not free2z/kt/v1/handle-assertion",
            Self::HandleCharset => "the handle is not [a-z0-9_]{1,30} (WIRE.md §14.1)",
            Self::HandleIdMismatch => "handle_id is not the digest of handle",
            Self::HandleMismatch => "the assertion is for a different handle",
            Self::IdentityMismatch => "the assertion is about a different identity key",
            Self::WrongLog => "the assertion names a different log",
            Self::UnknownAuthority => "no configured authority has that authority_id",
            Self::BadAuthoritySignature => "the authority signature did not verify",
            Self::BadIdentitySignature => "the identity self-signature did not verify",
            Self::EmptyValidity => "expires_ms is not after issued_ms",
            Self::ValidityTooLong => "the validity window exceeds this log's cap",
            Self::NotYetIssued => "issued_ms is in the future",
            Self::Expired => "the assertion has expired",
            Self::ReplayedNonce => "this (authority_id, nonce) has been admitted before",
            Self::LedgerFull => "the nonce ledger is full of unexpired entries",
            Self::IntentMismatch => "intent does not match the entry sequence position",
            Self::EntryKindMismatch => {
                "the entry kind does not match its version or predecessor identity key"
            }
            Self::MissingPriorVouch => "a non-initial entry is missing its prior vouching state",
            Self::UnexpectedPriorVouch => "an initial entry cannot have a prior vouching state",
            Self::MissingPriorAccountEpoch => {
                "a non-initial entry is missing its prior account_epoch"
            }
            Self::UnexpectedPriorAccountEpoch => {
                "an initial entry cannot have a prior account_epoch"
            }
            Self::IdentityUnchanged => "a reset assertion was spent on an unchanged identity key",
            Self::AccountEpochRegression => "account_epoch did not advance",
            Self::AccountEpochNotACounter => "account_epoch is a clock, not a counter",
            Self::AccountEpochStepTooLarge => "account_epoch advanced by more than a counter can",
            Self::MissingAssertion => "this log requires an assertion and none was presented",
            Self::UnexpectedAssertion => "this entry kind must not carry a platform assertion",
            Self::EmptyAuthoritySet => "an authority set needs at least one key",
            Self::DuplicateAuthority => "two authority keys share an authority_id",
            Self::AuthorityIdNotDerived => "authority_id is not the digest of the key",
            Self::InvalidPolicy => "the validity cap is zero or unrepresentable",
        }
    }
}

impl fmt::Display for AuthorityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} (KT.md §9.5 code {})",
            self.detail(),
            self.kt_error_code()
        )
    }
}

impl core::error::Error for AuthorityError {}

impl From<CodecError> for AuthorityError {
    /// Every codec failure here is the same event — the bytes are not a
    /// canonical assertion — and flattening them is deliberate. `f2z-codec`
    /// distinguishes `Decode` from `NotCanonical` because a relay's §10 table
    /// does; §9.5 does not, and carrying a distinction nothing can report is
    /// how a caller ends up inventing a code for it.
    fn from(_: CodecError) -> Self {
        Self::Malformed
    }
}

/// The result of everything in this crate.
pub type Result<T> = core::result::Result<T, AuthorityError>;

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::format;

    #[test]
    fn signature_failures_are_code_three_and_nothing_else_is() {
        assert_eq!(
            AuthorityError::BadAuthoritySignature.kt_error_code(),
            ERR_BAD_SIGNATURE
        );
        assert_eq!(
            AuthorityError::BadIdentitySignature.kt_error_code(),
            ERR_BAD_SIGNATURE
        );
        assert_eq!(
            AuthorityError::Expired.kt_error_code(),
            ERR_BAD_AUTHORIZATION
        );
    }

    #[test]
    fn configuration_faults_never_blame_the_submitter() {
        for error in [
            AuthorityError::EmptyAuthoritySet,
            AuthorityError::DuplicateAuthority,
            AuthorityError::AuthorityIdNotDerived,
            AuthorityError::InvalidPolicy,
        ] {
            assert!(error.is_configuration_fault(), "{error}");
            assert_eq!(error.kt_error_code(), ERR_INTERNAL);
        }
        assert!(!AuthorityError::Expired.is_configuration_fault());
    }

    #[test]
    fn a_codec_failure_is_malformed() {
        assert_eq!(
            AuthorityError::from(CodecError::NotCanonical),
            AuthorityError::Malformed
        );
        assert_eq!(
            AuthorityError::from(CodecError::Decode).kt_error_code(),
            ERR_MALFORMED
        );
    }

    #[test]
    fn display_carries_the_code() {
        assert!(format!("{}", AuthorityError::Expired).contains("code 4"));
    }
}
