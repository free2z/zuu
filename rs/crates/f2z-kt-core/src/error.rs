//! `KT.md` §9.5's wire error codes, and this crate's failure type.

use core::fmt;

use f2z_codec::CodecError;

/// A key-transparency wire error code (`KT.md` §9.5).
///
/// `uint16`, and **stable forever**: a code's meaning is never changed and a
/// retired code is never reused — `WIRE.md` §10's rule, for `WIRE.md` §10's
/// reason. `0` is success and is therefore not a variant.
///
/// **There is no "unknown handle" code**, deliberately: an unregistered handle
/// is answered with a proof of non-membership (§8.1), because handles are meant
/// to be public and "there is no such user" is a claim the log must prove
/// rather than assert. That is the opposite of `WIRE.md` §10's existence-oracle
/// rule, for the opposite reason, and the contrast is in §8.1.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[non_exhaustive]
pub enum ErrorCode {
    /// Decode failure, re-encode mismatch, oversize body.
    Malformed,
    /// Unknown `kt_version`, or a `log_id` this server does not serve.
    UnsupportedVersion,
    /// An `auth_signature`, `RotationProof`, reset or cosignature failed
    /// verification.
    BadSignature,
    /// Structurally valid but §4.4's rules unmet — e.g. a key change with one
    /// signature.
    BadAuthorization,
    /// `entry_version` not `previous + 1`, `prev_entry_hash` mismatch, or a
    /// second entry for this handle in this epoch (§4.3).
    VersionConflict,
    /// A `platform_reset` whose `effective_at_ms` has not arrived.
    Cooldown,
    /// The requested epoch or audit range is outside the served horizon (§9.3).
    EpochUnavailable,
    /// An audit range above the published maximum.
    RangeTooWide,
    /// Retry later.
    RateLimited,
    /// `/kt/v1/cosign` from a key the log does not recognise. Advisory only —
    /// the log's opinion of who is a witness has **no bearing** on a client's
    /// configured set (§8.3).
    NotAWitness,
    /// Log fault. Carries no detail, ever.
    Internal,
}

impl ErrorCode {
    /// Every code, in wire order. Used by the exhaustiveness test.
    pub const ALL: [Self; 11] = [
        Self::Malformed,
        Self::UnsupportedVersion,
        Self::BadSignature,
        Self::BadAuthorization,
        Self::VersionConflict,
        Self::Cooldown,
        Self::EpochUnavailable,
        Self::RangeTooWide,
        Self::RateLimited,
        Self::NotAWitness,
        Self::Internal,
    ];

    /// The wire code.
    #[must_use]
    pub const fn code(self) -> u16 {
        match self {
            Self::Malformed => 1,
            Self::UnsupportedVersion => 2,
            Self::BadSignature => 3,
            Self::BadAuthorization => 4,
            Self::VersionConflict => 5,
            Self::Cooldown => 6,
            Self::EpochUnavailable => 7,
            Self::RangeTooWide => 8,
            Self::RateLimited => 9,
            Self::NotAWitness => 10,
            Self::Internal => 11,
        }
    }

    /// The code this build knows by that number, if any.
    ///
    /// `None` is not an error: §9.5 keeps codes stable so an old client can
    /// still log a code it does not recognize.
    #[must_use]
    pub const fn from_code(code: u16) -> Option<Self> {
        Some(match code {
            1 => Self::Malformed,
            2 => Self::UnsupportedVersion,
            3 => Self::BadSignature,
            4 => Self::BadAuthorization,
            5 => Self::VersionConflict,
            6 => Self::Cooldown,
            7 => Self::EpochUnavailable,
            8 => Self::RangeTooWide,
            9 => Self::RateLimited,
            10 => Self::NotAWitness,
            11 => Self::Internal,
            _ => return None,
        })
    }

    /// The stable screaming-snake name from §9.5's table, for logs.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Malformed => "ERR_MALFORMED",
            Self::UnsupportedVersion => "ERR_UNSUPPORTED_VERSION",
            Self::BadSignature => "ERR_BAD_SIGNATURE",
            Self::BadAuthorization => "ERR_BAD_AUTHORIZATION",
            Self::VersionConflict => "ERR_VERSION_CONFLICT",
            Self::Cooldown => "ERR_COOLDOWN",
            Self::EpochUnavailable => "ERR_EPOCH_UNAVAILABLE",
            Self::RangeTooWide => "ERR_RANGE_TOO_WIDE",
            Self::RateLimited => "ERR_RATE_LIMITED",
            Self::NotAWitness => "ERR_NOT_A_WITNESS",
            Self::Internal => "ERR_INTERNAL",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.name(), self.code())
    }
}

impl core::error::Error for ErrorCode {}

/// Everything this crate can refuse to do.
///
/// Each variant carries the [`ErrorCode`] a log would put on the wire, so a
/// caller never has to re-derive one and never has to invent one.
///
/// The variants are finer-grained than the wire codes on purpose: several of
/// them are also [`FaultKind`]s, and the difference between "this tree head
/// rolled back" and "this tree head forked" is the difference between two
/// pieces of evidence a witness publishes, even though neither ever reaches a
/// client as a wire code.
///
/// [`FaultKind`]: crate::witness::FaultKind
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum KtError {
    /// The bytes did not decode, re-encoded to something else (`WIRE.md` §3.3),
    /// or a field value is not one version 1 may hold.
    Malformed,
    /// A structure's first field was not the exact §6.2 constant for its type.
    ///
    /// Checked **before anything else**, per §6.2: a verifier that accepts a
    /// signature "from the log" over bytes it did not type-check is one
    /// field-alignment coincidence away from accepting a receipt as a tree head.
    WrongLabel,
    /// A `kt_version` this build does not implement.
    UnsupportedVersion,
    /// A `log_id` other than the one this verifier is pinned to.
    WrongLog,
    /// A handle outside `[a-z0-9_]{1,30}` (§1.3).
    BadHandle,
    /// An Ed25519 signature did not verify.
    BadSignature,
    /// Structurally valid, and §4.4's authorization rules are not satisfied.
    BadAuthorization,
    /// `entry_version` is not `previous + 1`, or `prev_entry_hash` does not
    /// match the published previous entry (§4.2).
    VersionConflict,
    /// A second entry for this handle in this epoch (§4.3).
    ///
    /// Separate from [`KtError::VersionConflict`] although §9.5 gives them the
    /// same wire code, because this one is the NCC Group finding — `publish()`
    /// with duplicate labels in one batch — and a log that hits it should be
    /// able to say so in its own logs.
    DuplicateInEpoch,
    /// A `platform_reset` whose `effective_at_ms` has not arrived, or whose
    /// cooldown is shorter than the published one (§4.4 rule 7).
    Cooldown,
    /// §6.3: `epoch`, `tree_size` or `published_at_ms` moved backwards.
    Rollback,
    /// §6.3: the same epoch with any difference in the complete signed head.
    /// Fatal, and it is fork evidence.
    Fork,
    /// §7.2: **one witness signed two contradictory statements** about one
    /// `(log_id, epoch)`.
    ///
    /// Distinct from [`KtError::Fork`] on purpose, and the distinction is the
    /// whole of §7.2's accountability claim. `Fork` is evidence against the
    /// **log** — it is what the log returns when a cosignature endorses a root
    /// the log did not publish, and what a client returns when two *different*
    /// witnesses disagree. This is a fault of the **witness**, it needs no third
    /// document to establish, and it stands even if the log is honest. Reporting
    /// it as `Fork` would file evidence against the wrong party.
    ///
    /// The pair itself is [`crate::cosign::WitnessEquivocation`]; this is the
    /// verdict that accompanies it.
    WitnessEquivocation,
    /// §6.3 rule 7: `prev_sth_hash` does not connect to the last accepted head.
    ChainBreak,
    /// §6.3 rule 7: the new head skips epochs. The verifier MUST fetch every
    /// intervening head and check the chain link by link; **it MUST NOT skip.**
    /// A gap accepted on trust is a branch accepted on trust.
    EpochGap,
    /// §6.1: `vrf_public_key` changed within a `log_id`. Treat as a fork, never
    /// as an update — it determines every label in the tree, so changing it
    /// silently invalidates every prior proof while producing proofs that still
    /// verify under the new key.
    VrfKeyChange,
    /// Fewer than *t* valid cosignatures from **distinct witnesses in the
    /// caller's own configured set** (§8.3). The client fails closed.
    ThresholdUnmet,
    /// §6.4: a log signing-key transition that does not satisfy all four
    /// conditions. A witness MUST halt and report, not fall back to trusting
    /// the new key.
    BadKeyTransition,
    /// `akd`'s verifier rejected an inclusion or history proof.
    ProofInvalid,
    /// The entry served alongside a proof does not hash to the value the proof
    /// commits to (§8.1 step 4). Never use a value the log asserts.
    ValueMismatch,
    /// `akd`'s auditor rejected the append-only proof (§7.1 step 4). The only
    /// check that catches a value rewritten under a proof that still verifies.
    AppendOnlyFailure,
    /// A history response is not an unbroken `entry_version` sequence, or its
    /// `prev_entry_hash` chain does not connect (§8.2 step 4). A log that omits
    /// a version from a history response is otherwise serving a truthful subset.
    HistoryIncomplete,
}

impl KtError {
    /// The wire code a log sends for this failure (§9.5).
    #[must_use]
    pub const fn error_code(self) -> ErrorCode {
        match self {
            Self::Malformed | Self::WrongLabel | Self::BadHandle => ErrorCode::Malformed,
            Self::UnsupportedVersion | Self::WrongLog => ErrorCode::UnsupportedVersion,
            Self::BadSignature => ErrorCode::BadSignature,
            Self::BadAuthorization | Self::BadKeyTransition => ErrorCode::BadAuthorization,
            Self::VersionConflict | Self::DuplicateInEpoch => ErrorCode::VersionConflict,
            Self::Cooldown => ErrorCode::Cooldown,
            // Everything below is a *client- or witness-side* verdict about the
            // log. None of them is a reply a log sends to a submitter, and
            // collapsing them onto ERR_INTERNAL states that plainly rather than
            // inventing a code §9.5 does not have.
            Self::Rollback
            | Self::Fork
            | Self::WitnessEquivocation
            | Self::ChainBreak
            | Self::EpochGap
            | Self::VrfKeyChange
            | Self::ThresholdUnmet
            | Self::ProofInvalid
            | Self::ValueMismatch
            | Self::AppendOnlyFailure
            | Self::HistoryIncomplete => ErrorCode::Internal,
        }
    }
}

impl fmt::Display for KtError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            Self::Malformed => "bytes did not decode canonically (WIRE.md §3.3)",
            Self::WrongLabel => "domain-separation label is not this structure's (KT.md §6.2)",
            Self::UnsupportedVersion => "unsupported kt_version",
            Self::WrongLog => "log_id is not the pinned one",
            Self::BadHandle => "handle is not [a-z0-9_]{1,30} (KT.md §1.3)",
            Self::BadSignature => "signature did not verify",
            Self::BadAuthorization => "entry authorization rules unmet (KT.md §4.4)",
            Self::VersionConflict => "entry_version or prev_entry_hash does not chain (KT.md §4.2)",
            Self::DuplicateInEpoch => "a second entry for this handle in this epoch (KT.md §4.3)",
            Self::Cooldown => "platform_reset before effective_at_ms (KT.md §4.4)",
            Self::Rollback => "tree head moved backwards (KT.md §6.3)",
            Self::Fork => "two different complete tree heads for one epoch (KT.md §6.3)",
            Self::WitnessEquivocation => {
                "one witness signed two contradictory statements for one epoch (KT.md §7.2)"
            }
            Self::ChainBreak => "prev_sth_hash does not connect (KT.md §6.3 rule 7)",
            Self::EpochGap => "tree head skips epochs; fetch every intervening head (KT.md §6.3)",
            Self::VrfKeyChange => "vrf_public_key changed within a log_id (KT.md §6.1)",
            Self::ThresholdUnmet => {
                "fewer than t cosignatures from the configured set (KT.md §8.3)"
            }
            Self::BadKeyTransition => "log signing-key transition unverifiable (KT.md §6.4)",
            Self::ProofInvalid => "akd rejected the proof",
            Self::ValueMismatch => "the served entry does not hash to the committed value",
            Self::AppendOnlyFailure => "the append-only proof did not verify (KT.md §7.1)",
            Self::HistoryIncomplete => "key history is not an unbroken chain (KT.md §8.2)",
        };
        write!(f, "{text}: {}", self.error_code())
    }
}

impl core::error::Error for KtError {}

impl From<CodecError> for KtError {
    fn from(error: CodecError) -> Self {
        match error {
            // `f2z-codec` distinguishes these because a relay answers them with
            // different wire codes. Here they are all the same verdict: the
            // bytes are not a structure this protocol may act on.
            CodecError::Decode
            | CodecError::NotCanonical
            | CodecError::InvalidValue
            | CodecError::BadSize
            | CodecError::Overflow => Self::Malformed,
            // `CodecError` is #[non_exhaustive]; a variant added upstream must
            // fail closed rather than compile into an accept.
            _ => Self::Malformed,
        }
    }
}

impl From<tls_codec::Error> for KtError {
    fn from(_: tls_codec::Error) -> Self {
        Self::Malformed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_the_table_in_kt_md_section_9_5() {
        for (index, code) in ErrorCode::ALL.iter().enumerate() {
            let expected = u16::try_from(index).map(|value| value + 1);
            assert_eq!(Ok(code.code()), expected);
            assert_eq!(ErrorCode::from_code(code.code()), Some(*code));
        }
        assert_eq!(
            ErrorCode::from_code(0),
            None,
            "0 is success, never an error"
        );
        assert_eq!(ErrorCode::from_code(12), None);
    }

    #[test]
    fn there_is_no_unknown_handle_code() {
        // §9.5 states this deliberately: an unregistered handle is answered
        // with a non-membership proof, not an error. If someone adds one, this
        // test is where they are told why they must not.
        for code in ErrorCode::ALL {
            assert!(
                !code.name().contains("HANDLE"),
                "an unknown-handle code would let the log assert what it must prove"
            );
        }
    }

    #[test]
    fn every_failure_has_a_wire_code_and_a_message() {
        // Not exhaustive over KtError by construction — it is #[non_exhaustive]
        // — but every variant this build knows is checked to render.
        let all = [
            KtError::Malformed,
            KtError::WrongLabel,
            KtError::UnsupportedVersion,
            KtError::WrongLog,
            KtError::BadHandle,
            KtError::BadSignature,
            KtError::BadAuthorization,
            KtError::VersionConflict,
            KtError::DuplicateInEpoch,
            KtError::Cooldown,
            KtError::Rollback,
            KtError::Fork,
            KtError::WitnessEquivocation,
            KtError::ChainBreak,
            KtError::EpochGap,
            KtError::VrfKeyChange,
            KtError::ThresholdUnmet,
            KtError::BadKeyTransition,
            KtError::ProofInvalid,
            KtError::ValueMismatch,
            KtError::AppendOnlyFailure,
            KtError::HistoryIncomplete,
        ];
        for error in all {
            let rendered = format!("{error}");
            assert!(
                rendered.contains("ERR_"),
                "{error:?} rendered as {rendered}"
            );
        }
        assert_eq!(
            KtError::BadAuthorization.error_code(),
            ErrorCode::BadAuthorization
        );
        assert_eq!(
            KtError::DuplicateInEpoch.error_code(),
            ErrorCode::VersionConflict,
            "§4.3's rule is answered with ERR_VERSION_CONFLICT",
        );
    }
}
