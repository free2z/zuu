//! What a directory lookup can fail with, and which failures are evidence.
//!
//! The distinction that matters here is not severity. It is **whether a failure
//! says something about the log**. A timeout says nothing; a tree head that
//! contradicts one this client already accepted says the log published two
//! histories, and `KT.md` §8.1 step 2 calls that *"fatal, and fork evidence"*.
//! [`ClientError::is_fork_evidence`] is the one place that line is drawn, so a
//! caller does not draw it again and draw it differently.

use core::fmt;

use f2z_kt_core::KtError;

/// A directory operation that did not complete.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum ClientError {
    /// The log could not be reached, or did not answer with a usable body.
    ///
    /// Carries the transport's own message, which is a URL and a network
    /// error. It never carries a handle: `KT.md` §9.2 puts the handle in the
    /// **body** precisely so it does not end up in logs, and an error string
    /// that named it would put it back.
    Unreachable(String),

    /// The log answered with a `KT.md` §9.5 error body.
    Refused(f2z_kt_core::ErrorCode),

    /// A protocol rule failed. Every one of these comes from `f2z-kt-core`;
    /// this crate implements none of them a second time.
    Protocol(KtError),

    /// A verified catch-up prefix reached `accepted_epoch`, but the latest
    /// head observed for this operation is still `target_epoch`.
    ///
    /// This is an expected, retryable checkpoint rather than a protocol
    /// failure. Persist [`crate::KtClient::checkpoint_bytes`] before retrying:
    /// the next call resumes at `accepted_epoch + 1` and never trusts the
    /// target across the unverified gap (`KT.md` §6.3).
    CatchUpIncomplete {
        /// The last consecutively verified epoch, now held by the client.
        accepted_epoch: u64,
        /// The target epoch the operation has not accepted yet.
        target_epoch: u64,
    },

    /// §8.3, and it is **the fail-closed path**.
    ///
    /// Fewer than *t* distinct witnesses from the client's **own** configured
    /// set produced a valid cosignature over exactly this
    /// `(log_id, epoch, tree_size, root_hash)`. Per the owner decision on
    /// [#311](https://github.com/free2z/zuu/issues/311), *"proceeding silently
    /// would overclaim and must not be the default"*.
    ///
    /// It is a variant of its own rather than a [`ClientError::Protocol`]
    /// wrapping [`KtError::ThresholdUnmet`] because it is the failure a UI has
    /// a specific screen for — §8.3's table, and `CLIENT-CONTRACT.md` §6.4's
    /// matrix — and because it is the *expected* answer in the shipped
    /// configuration rather than a fault.
    WitnessThresholdUnmet,

    /// §8.1's correction: the log asserts a handle this client **holds a pin
    /// for** is not registered.
    ///
    /// The client fails closed and alarms, and it keeps the pin. What it must
    /// also be told, and what [`ClientError::PinContradiction`] exists to name,
    /// is that this is a contradiction it **cannot prove to anyone**: the log
    /// signs tree heads, not lookup responses, so an absent answer is not a
    /// signed statement, is not non-repudiable, and cannot be published as
    /// evidence the way §7.3's `rollback`, `fork` or `chain_break` reports can.
    PinContradiction,

    /// A pinned handle's entry chain moved in a way the client cannot accept
    /// without an explicit decision — an identity key change, or a version
    /// that does not chain to the pin.
    ///
    /// Never resolved by overwriting the pin. `CLIENT-CONTRACT.md` §9 rule 9:
    /// *"silently dropping the pin would complete the attack."*
    PinConflict,

    /// The caller asked for something this build cannot do without a feature
    /// it was compiled without, or gave a configuration that cannot be used —
    /// a cleartext log URL, a threshold larger than the configured set.
    Configuration(String),
}

impl ClientError {
    /// Whether this failure is **evidence about the log** rather than about the
    /// network or about this client's own state.
    ///
    /// True for §6.3's monotonicity failures and for a proof that did not
    /// verify. `KT.md` §8.1 step 2: *"any failure is fatal and is fork
    /// evidence — a client can and MUST make these checks itself."*
    ///
    /// **It is deliberately false for [`ClientError::PinContradiction`]**, and
    /// that asymmetry is the honest part. A fork is provable to a third party
    /// from two signed tree heads (§8.4); an absent answer is not signed at
    /// all, so a client that filed it as evidence would be claiming a
    /// non-repudiability it does not have.
    #[must_use]
    pub const fn is_fork_evidence(&self) -> bool {
        matches!(
            self,
            Self::Protocol(
                KtError::Fork
                    | KtError::Rollback
                    | KtError::ChainBreak
                    | KtError::VrfKeyChange
                    | KtError::ProofInvalid
                    | KtError::ValueMismatch
                    | KtError::HistoryIncomplete
            )
        )
    }

    /// Whether retrying later could plausibly succeed with nothing else
    /// changing.
    ///
    /// The transport, or a bounded catch-up checkpoint. A threshold that is
    /// unmet because the client configured witnesses that are not cosigning is
    /// not transient in any sense a retry loop should act on, and a UI that
    /// spun on it would turn a deliberate refusal into a hang.
    #[must_use]
    pub const fn is_transient(&self) -> bool {
        matches!(self, Self::Unreachable(_) | Self::CatchUpIncomplete { .. })
    }
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreachable(detail) => write!(f, "the log could not be reached: {detail}"),
            Self::Refused(code) => write!(f, "the log refused: {code}"),
            Self::Protocol(error) => write!(f, "{error}"),
            Self::CatchUpIncomplete {
                accepted_epoch,
                target_epoch,
            } => write!(
                f,
                "verified catch-up checkpoint {accepted_epoch} of {target_epoch}; persist the \
                 signed-head checkpoint and retry (KT.md §6.3)"
            ),
            Self::WitnessThresholdUnmet => f.write_str(
                "fewer than t of this client's own configured witnesses cosigned this root \
                 (KT.md §8.3); refusing rather than proceeding on an unwitnessed answer",
            ),
            Self::PinContradiction => f.write_str(
                "the log asserts a handle this client has already resolved does not exist \
                 (KT.md §8.1); the pin stands, and this contradiction is NOT provable to \
                 anyone because the log signs tree heads and not lookup responses",
            ),
            Self::PinConflict => f.write_str(
                "the directory shows a key change or a break in the entry chain for a pinned \
                 handle; a pin is never overwritten silently (CLIENT-CONTRACT.md §9 rule 9)",
            ),
            Self::Configuration(detail) => write!(f, "misconfigured client: {detail}"),
        }
    }
}

impl core::error::Error for ClientError {}

impl From<KtError> for ClientError {
    fn from(error: KtError) -> Self {
        // §8.3's refusal has its own variant, and the conversion is where that
        // is decided once. A caller that matched on `Protocol(ThresholdUnmet)`
        // as well would be a second spelling of the same state.
        match error {
            KtError::ThresholdUnmet => Self::WitnessThresholdUnmet,
            other => Self::Protocol(other),
        }
    }
}

impl From<f2z_codec::CodecError> for ClientError {
    fn from(error: f2z_codec::CodecError) -> Self {
        Self::Protocol(KtError::from(error))
    }
}

/// This crate's result type.
pub type Result<T> = core::result::Result<T, ClientError>;
