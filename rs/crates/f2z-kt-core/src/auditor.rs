//! The witness-side append-only path — `KT.md` §7.1 step 4 and §7.4.
//!
//! # A witness that does not verify the append-only proof is worthless
//!
//! Restated here so it cannot be skipped by an implementer optimising a poll
//! loop:
//!
//! - A witness that verifies the **signature** and cosigns is attesting that the
//!   log signed something. **The log's own signature already proved that.** Such
//!   a cosignature adds exactly zero information.
//! - A witness that verifies **monotonicity** and cosigns detects a log that
//!   contradicts itself *in the stream that witness was shown*. Much weaker than
//!   it sounds: a log that maintains two internally-consistent branches and
//!   shows each witness only one passes every monotonicity check every time.
//! - Only the **append-only proof** establishes that the new root extends the old
//!   one rather than replacing part of it. It is the only check that catches
//!   [facebook/akd#495](https://github.com/facebook/akd/pull/495) — a value
//!   rewritten under a proof that still verifies — and it is the check no client
//!   can run for itself, because the proof is O(entries added): 3.9 MB and
//!   1–3 seconds for five epochs.
//!
//! There is no way for a client to tell a lazy witness from a diligent one by
//! inspecting cosignatures. §7.4's mitigation is structural rather than
//! cryptographic, and this module is where the structure lives:
//!
//! - **The log and the witness link the same verifier.** `audit_verify` is
//!   `akd`'s, used by both, at the same pinned version. "Cosign without
//!   verifying" is then not a state a conforming implementation can drift into
//!   by omission — it takes deleting a call, not forgetting one.
//! - [`WitnessState::advance`] **takes an [`AppendOnlyVerified`]**, and
//!   [`verify_append_only`] is the only thing that produces one. A witness built
//!   on this crate cannot reach the point of emitting a cosignature without
//!   having run the check, because the token is the argument the next step
//!   needs.
//!
//! A witness that is actively malicious simply removes the check, and we will
//! not know. The mitigation for that is the independence of the witness set, not
//! code.
//!
//! # This does not reach the browser, on purpose
//!
//! `akd::auditor::audit_verify` compiles for `wasm32-unknown-unknown` and then
//! traps at runtime, because `verify_append_only_hash` hardcodes
//! `AzksParallelismConfig::default()` — `AvailableOr(32)` — reaching
//! `tokio::task::spawn`, and that target has no runtime and no threads (§11.3).
//! It fails on a 33 KB proof as readily as on a 3.9 MB one, so it is not a size
//! or stack problem. The witness is a native outbound-polling daemon (§9.3), so
//! this costs us nothing; the `auditor` feature exists so the wasm build cannot
//! pull it in by accident.

use akd::AppendOnlyProof;
use akd::auditor::audit_verify;
use akd_core::configuration::WhatsAppV1Configuration;
use f2z_codec::types::Digest;
use protobuf::Message as _;

use crate::error::KtError;
use crate::sth::{LogView, SignedTreeHead};

/// Proof that `audit_verify` ran and accepted, for the epochs it names.
///
/// No public constructor. [`verify_append_only`] is the only thing that builds
/// one, and [`WitnessState::advance`] is the only thing that consumes one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppendOnlyVerified {
    from_epoch: u64,
    to_epoch: u64,
    to_root: Digest,
}

impl AppendOnlyVerified {
    /// The epoch the verified range starts at — the last root the witness had
    /// already accepted.
    #[must_use]
    pub const fn from_epoch(&self) -> u64 {
        self.from_epoch
    }

    /// The epoch the verified range ends at.
    #[must_use]
    pub const fn to_epoch(&self) -> u64 {
        self.to_epoch
    }

    /// The root at [`AppendOnlyVerified::to_epoch`].
    #[must_use]
    pub const fn to_root(&self) -> &Digest {
        &self.to_root
    }
}

/// §7.1 step 4 — verify that every root in `heads` extends the one before it.
///
/// `heads` is the run of tree heads covering `(last.epoch, new.epoch]`
/// **inclusive of the last accepted head at position 0**, so `heads.len()` is
/// one more than the number of epoch transitions — the shape
/// `akd::auditor::audit_verify` wants, and the shape §6.3 rule 7 already forces
/// a witness to hold anyway.
///
/// The heads' signatures and monotonicity are **not** re-checked here; that is
/// [`LogView::accept_chain`], and a witness runs it first (step 3 before step
/// 4). What this adds is the only thing those checks cannot give: that the tree
/// grew rather than changed.
///
/// # Errors
///
/// - [`KtError::Malformed`] if `heads` has fewer than two entries, if the proof
///   is not decodable protobuf, or if the proof's epoch list does not line up
///   with the heads.
/// - [`KtError::AppendOnlyFailure`] if `audit_verify` rejected. **Halt and
///   report** (§7.3); a witness MUST NOT catch up past a fault, because an
///   automatic resync is an automatic way to erase the only record of the thing
///   the witness exists to find.
pub async fn verify_append_only(
    heads: &[SignedTreeHead],
    append_only_proof: &[u8],
) -> Result<AppendOnlyVerified, KtError> {
    let (Some(first), Some(last)) = (heads.first(), heads.last()) else {
        return Err(KtError::Malformed);
    };
    if heads.len() < 2 {
        return Err(KtError::Malformed);
    }

    let proto = akd_core::proto::specs::types::AppendOnlyProof::parse_from_bytes(append_only_proof)
        .map_err(|_| KtError::Malformed)?;
    let proof = AppendOnlyProof::try_from(&proto).map_err(|_| KtError::Malformed)?;

    // `audit_verify` checks `proof.epochs.len() + 1 == hashes.len()` itself, but
    // not that the epochs are *ours*. Without this, a log could serve a
    // perfectly valid proof for a different, earlier range and it would verify
    // against root hashes it happens to match.
    if proof.epochs.len().saturating_add(1) != heads.len() {
        return Err(KtError::Malformed);
    }
    for (proof_epoch, head) in proof.epochs.iter().zip(heads.iter()) {
        if *proof_epoch != head.sth.epoch {
            return Err(KtError::Malformed);
        }
    }

    let hashes = heads
        .iter()
        .map(|head| *head.sth.root_hash.as_bytes())
        .collect();
    audit_verify::<WhatsAppV1Configuration>(hashes, proof)
        .await
        .map_err(|_| KtError::AppendOnlyFailure)?;

    Ok(AppendOnlyVerified {
        from_epoch: first.sth.epoch,
        to_epoch: last.sth.epoch,
        to_root: last.sth.root_hash,
    })
}

/// The durable state of a witness (§7.1, §7.5) — a few hundred bytes in a file,
/// per §9.3's promise that a witness needs no database.
///
/// # Persist before you emit, and the order is a correctness requirement
///
/// §7.1 puts step 5 (persist, `fsync` plus atomic rename) before step 6 (emit
/// the cosignature) and the reason is not hygiene. A witness that emits first
/// and crashes before persisting comes back believing it is still at the old
/// epoch. It will then happily cosign whatever it is served for that epoch next
/// — and if the log serves it a *different* root, the witness has signed two
/// contradictory statements for one epoch. That is exactly the non-repudiable
/// evidence §7.2 is designed to produce, and the witness manufactured it against
/// itself for a fault that was its own crash. Persist first and the worst case is
/// a missed cosignature, which is invisible and harmless.
///
/// This type therefore does not emit anything. [`WitnessState::advance`] returns
/// the statement a witness should cosign **after** it has durably written the
/// new state, and the caller owns both the storage and the key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WitnessState {
    view: LogView,
    halted: Option<crate::witness::FaultKind>,
}

impl WitnessState {
    /// Start following a log from a tree head, with the key currently accepted
    /// for it.
    #[must_use]
    pub const fn new(view: LogView) -> Self {
        Self { view, halted: None }
    }

    /// The pinned view — `(log_id, accepted_log_pk, epoch, tree_size,
    /// root_hash, sth_hash)`.
    #[must_use]
    pub const fn view(&self) -> &LogView {
        &self.view
    }

    /// The fault this witness halted on, if it has.
    #[must_use]
    pub const fn halted(&self) -> Option<crate::witness::FaultKind> {
        self.halted
    }

    /// Advance past a verified append-only range.
    ///
    /// The `heads` are the same run handed to [`verify_append_only`], including
    /// the already-accepted head at position 0. §6.3's rules are applied to
    /// every head after that one; the token proves the append-only check ran
    /// over the same range.
    ///
    /// **A witness MUST NOT "catch up" past a fault.** Once this returns an
    /// error the witness is halted, [`WitnessState::halted`] reports what it
    /// found, and every later call returns the same fault until a human looks at
    /// the evidence.
    ///
    /// # Errors
    ///
    /// - [`KtError::Malformed`] if the token does not describe this run of
    ///   heads, or the run does not start at the currently pinned epoch.
    /// - Whatever [`LogView::accept`] returns — and the witness halts on it.
    pub fn advance(
        &mut self,
        heads: &[SignedTreeHead],
        verified: &AppendOnlyVerified,
    ) -> Result<&LogView, KtError> {
        if let Some(kind) = self.halted {
            return Err(fault_to_error(kind));
        }
        let (Some(first), Some(last)) = (heads.first(), heads.last()) else {
            return Err(KtError::Malformed);
        };
        // The token must be about *this* range, starting where we actually are.
        if first.sth.epoch != self.view.epoch()
            || first.sth.root_hash != *self.view.root_hash()
            || verified.from_epoch() != first.sth.epoch
            || verified.to_epoch() != last.sth.epoch
            || verified.to_root() != &last.sth.root_hash
        {
            return Err(KtError::Malformed);
        }

        let Some(rest) = heads.get(1..) else {
            return Err(KtError::Malformed);
        };
        if let Err(error) = self.view.accept_chain(rest) {
            self.halted = Some(error_to_fault(error));
            return Err(error);
        }
        Ok(&self.view)
    }

    /// Record a fault found outside [`WitnessState::advance`] — a bad signature
    /// on a key transition, or a receipt whose `merge_by_ms` passed unmet — and
    /// halt.
    pub fn halt(&mut self, kind: crate::witness::FaultKind) {
        if self.halted.is_none() {
            self.halted = Some(kind);
        }
    }
}

/// The `FaultKind` a §6.3 verdict corresponds to (§7.3).
const fn error_to_fault(error: KtError) -> crate::witness::FaultKind {
    use crate::witness::FaultKind;
    match error {
        KtError::Fork => FaultKind::Fork,
        KtError::ChainBreak | KtError::EpochGap => FaultKind::ChainBreak,
        KtError::VrfKeyChange => FaultKind::VrfKeyChange,
        KtError::AppendOnlyFailure => FaultKind::AppendOnlyFailure,
        KtError::BadSignature
        | KtError::WrongLabel
        | KtError::WrongLog
        | KtError::UnsupportedVersion
        | KtError::BadKeyTransition => FaultKind::BadSignature,
        // Rollback is the residual verdict, and every remaining variant reaching
        // here would be a bug rather than a fault of the log — reporting it as a
        // rollback keeps the witness halted, which is the safe direction.
        _ => FaultKind::Rollback,
    }
}

const fn fault_to_error(kind: crate::witness::FaultKind) -> KtError {
    use crate::witness::FaultKind;
    match kind {
        FaultKind::Fork => KtError::Fork,
        FaultKind::ChainBreak => KtError::ChainBreak,
        FaultKind::VrfKeyChange => KtError::VrfKeyChange,
        FaultKind::AppendOnlyFailure => KtError::AppendOnlyFailure,
        FaultKind::BadSignature => KtError::BadSignature,
        FaultKind::MergeDelayExceeded | FaultKind::Rollback => KtError::Rollback,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TestLog;
    use crate::witness::FaultKind;
    use f2z_codec::types::Digest;

    /// A witness cannot advance without the token, and the token cannot be
    /// forged: there is no constructor. This test states the property the type
    /// system already enforces, so that a future refactor that adds a
    /// constructor fails review with a reason attached.
    #[test]
    fn advancing_requires_a_token_for_exactly_this_range() {
        let log = TestLog::new();
        let view = LogView::pin(*log.log_id(), *log.log_pk(), &log.head(0)).unwrap();
        let mut state = WitnessState::new(view);
        let heads = [log.head(0), log.head(1), log.head(2)];

        // A token for a different range must not advance this one. Built by
        // hand here precisely because no caller can build one.
        let wrong = AppendOnlyVerified {
            from_epoch: 0,
            to_epoch: 9,
            to_root: Digest::new([0u8; 32]),
        };
        assert_eq!(state.advance(&heads, &wrong), Err(KtError::Malformed));
        assert_eq!(state.view().epoch(), 0);

        let right = AppendOnlyVerified {
            from_epoch: 0,
            to_epoch: 2,
            to_root: log.head(2).sth.root_hash,
        };
        assert!(state.advance(&heads, &right).is_ok());
        assert_eq!(state.view().epoch(), 2);
    }

    #[test]
    fn a_halted_witness_stays_halted() {
        let log = TestLog::new();
        let view = LogView::pin(*log.log_id(), *log.log_pk(), &log.head(0)).unwrap();
        let mut state = WitnessState::new(view);

        // §6.3 rule 7: epoch 2 chains to epoch 1, which this witness has never
        // seen. The append-only proof could be perfect and the head correctly
        // signed; a gap is still refused, because a gap accepted on trust is a
        // branch accepted on trust.
        let heads = [log.head(0), log.head(2)];
        let token = AppendOnlyVerified {
            from_epoch: 0,
            to_epoch: 2,
            to_root: log.head(2).sth.root_hash,
        };
        assert_eq!(state.advance(&heads, &token), Err(KtError::EpochGap));
        assert_eq!(state.halted(), Some(FaultKind::ChainBreak));

        // §7.1: "A witness MUST NOT catch up past a fault." Once halted it stays
        // halted until a human looks at the evidence — an automatic resync is an
        // automatic way to erase the only record of the thing the witness exists
        // to find.
        let honest = [log.head(0), log.head(1)];
        let token = AppendOnlyVerified {
            from_epoch: 0,
            to_epoch: 1,
            to_root: log.head(1).sth.root_hash,
        };
        assert_eq!(state.advance(&honest, &token), Err(KtError::ChainBreak));
        assert_eq!(state.view().epoch(), 0);
    }

    #[test]
    fn halting_is_recorded_once() {
        let log = TestLog::new();
        let view = LogView::pin(*log.log_id(), *log.log_pk(), &log.head(0)).unwrap();
        let mut state = WitnessState::new(view);
        state.halt(FaultKind::MergeDelayExceeded);
        state.halt(FaultKind::Fork);
        assert_eq!(state.halted(), Some(FaultKind::MergeDelayExceeded));
    }

    #[test]
    fn a_proof_whose_epochs_are_not_ours_is_refused() {
        // Not a cryptographic check — `audit_verify` would run happily — but a
        // proof for another range that happens to match root hashes would
        // otherwise pass. Empty proof bytes stand in for "any proof at all"
        // because the epoch check runs before verification.
        let log = TestLog::new();
        let heads = [log.head(0), log.head(1)];
        let result = futures_block_on(verify_append_only(&heads, &[]));
        assert_eq!(result, Err(KtError::Malformed));
    }

    /// A one-poll executor.
    ///
    /// `audit_verify` is `async` only because `akd`'s storage trait is; the
    /// auditor itself awaits nothing that can pend, so a test does not need a
    /// runtime and this crate does not depend on one. `Waker::noop` is the safe
    /// constructor, which matters because the crate forbids unsafe code.
    fn futures_block_on<F: core::future::Future>(future: F) -> F::Output {
        use core::task::{Context, Poll, Waker};
        let mut context = Context::from_waker(Waker::noop());
        let mut pinned = core::pin::pin!(future);
        match pinned.as_mut().poll(&mut context) {
            Poll::Ready(value) => value,
            Poll::Pending => unreachable!("akd's auditor awaits nothing that can pend"),
        }
    }
}
