//! `KT.md` §7.1 — the loop.
//!
//! ```text
//! 1. Poll                GET /kt/v1/sth
//! 2. Verify the signature under the accepted log key, and the constants
//! 3. Check §6.3's monotonicity and chain, fetching every intervening head
//! 4. Fetch the append-only proof and VERIFY it
//! 5. Persist, durably, BEFORE emitting anything
//! 6. Emit the cosignature
//! ```
//!
//! # Step 4 is the entire reason the role exists
//!
//! §7.4 restates it so that an implementer optimising a poll loop cannot skip
//! it, and it is worth having in front of the code that runs it:
//!
//! - A witness that verifies the **signature** and cosigns is attesting that
//!   the log signed something. **The log's own signature already proved that.**
//!   Such a cosignature adds exactly zero information.
//! - A witness that verifies **monotonicity** and cosigns detects a log that
//!   contradicts itself *in the stream that witness was shown*. A log that
//!   maintains two internally-consistent branches and shows each witness only
//!   one passes every monotonicity check every time.
//! - Only the **append-only proof** establishes that the new root extends the
//!   old one rather than replacing part of it.
//!
//! There is no way to tell a lazy witness from a diligent one by inspecting
//! cosignatures. What this implementation does about that is structural: the
//! only path from a polled tree head to a signed cosignature runs through
//! [`f2z_kt_core::auditor::verify_append_only`] and then through
//! [`f2z_kt_core::auditor::WitnessState::advance`], which **will not advance
//! without the token the first one returns.** Skipping the check is not
//! something this loop can do by omission; it takes deleting a call.
//!
//! # Step 5 before step 6
//!
//! A witness that emits first and crashes before persisting comes back
//! believing it is still at the old epoch, and will then cosign whatever it is
//! served for that epoch next — manufacturing two contradictory statements
//! against itself for a fault that was its own crash. [`Witness::poll_once`]
//! writes the state file, atomically, and only then signs.

use std::path::PathBuf;

use ed25519_dalek::{Signer as _, SigningKey};
use f2z_codec::Canonical as _;
use f2z_codec::decode_canonical;
use f2z_codec::types::{PublicKey, Signature};
use f2z_kt_core::api::{AuditResponse, TreeHeadBundle};
use f2z_kt_core::auditor::{WitnessState as AuditorState, verify_append_only};
use f2z_kt_core::sth::{LogView, SignedTreeHead};
use f2z_kt_core::types::{LogId, label_field};
use f2z_kt_core::{
    FaultKind, KT_VERSION, KtError, WitnessCosignature, WitnessCosignatureTBS, labels,
};

use crate::error::{Result, WitnessError};
use crate::evidence::Evidence;
use crate::state::{self, WitnessState};
use crate::transport::Transport;

/// What one poll did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum Outcome {
    /// The log was pinned for the first time and its head cosigned.
    Pinned {
        /// The epoch pinned.
        epoch: u64,
    },
    /// New epochs were verified and cosigned.
    Cosigned {
        /// The epoch now held.
        epoch: u64,
        /// How many epoch transitions the append-only proof covered.
        advanced: u64,
    },
    /// The log has not moved. Nothing to do, and nothing wrong.
    UpToDate {
        /// The epoch held.
        epoch: u64,
    },
    /// A fault was found, evidence written, and the witness halted.
    Halted {
        /// What was found.
        kind: FaultKind,
    },
}

/// The daemon's configuration.
#[derive(Clone, Debug)]
pub struct Settings {
    /// The `log_id` this witness follows. **Pinned by the operator**, never
    /// learned from the log: a log that could tell a witness its own identifier
    /// could rename itself out of its own history.
    pub log_id: LogId,
    /// The log signing key this witness accepts. Also pinned. §6.4's rotation
    /// path replaces it, and only against a **cosigned** announcement.
    pub accepted_log_pk: PublicKey,
    /// The state file.
    pub state_path: PathBuf,
    /// Where fault reports and the cosignature history go.
    pub evidence_dir: PathBuf,
    /// How far back the witness will fetch in one audit request. A log with a
    /// published maximum (`KT.md` §9.3) will refuse a wider one anyway; this
    /// keeps the witness from asking.
    pub max_audit_span: u64,
}

/// The cosigning daemon.
pub struct Witness {
    settings: Settings,
    key: SigningKey,
    witness_pk: PublicKey,
    transport: Box<dyn Transport>,
    evidence: Evidence,
    runtime: tokio::runtime::Runtime,
}

impl Witness {
    /// Build a witness.
    ///
    /// # Errors
    ///
    /// [`WitnessError::Local`] if the evidence directory or the runtime cannot
    /// be created.
    pub fn new(settings: Settings, seed: &[u8; 32], transport: Box<dyn Transport>) -> Result<Self> {
        let key = SigningKey::from_bytes(seed);
        let witness_pk = PublicKey::new(key.verifying_key().to_bytes());
        let evidence = Evidence::new(&settings.evidence_dir)?;
        // `audit_verify` reaches `tokio::task::spawn` (KT.md §11.3), so it needs
        // a runtime. The witness is native, which is why that wart is harmless
        // here — but it is why this daemon owns a runtime it otherwise has no
        // use for, and why nothing in this crate may ever be built for wasm.
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|error| WitnessError::Local(format!("runtime: {error}")))?;
        Ok(Self {
            settings,
            key,
            witness_pk,
            transport,
            evidence,
            runtime,
        })
    }

    /// This witness's public key — what goes in a `WitnessCosignature` and what
    /// a client configures.
    #[must_use]
    pub const fn public_key(&self) -> PublicKey {
        self.witness_pk
    }

    /// Where evidence is written.
    #[must_use]
    pub const fn evidence(&self) -> &Evidence {
        &self.evidence
    }

    /// Run one iteration of §7.1.
    ///
    /// # Errors
    ///
    /// [`WitnessError::Transport`] if the log could not be reached — retry.
    /// [`WitnessError::Local`] for this daemon's own failures.
    /// A **fault** does not return an error: it returns
    /// [`Outcome::Halted`], because the fault has been handled — evidence
    /// written, halt persisted — and the caller's job is to stop, not to
    /// interpret.
    pub fn poll_once(&mut self, now_ms: u64) -> Result<Outcome> {
        let stored = state::load(&self.settings.state_path)?;

        if let Some(existing) = &stored
            && let Some(kind) = existing.halt_kind()
        {
            // §7.1: "A witness MUST NOT 'catch up' past a fault. Once halted it
            // stays halted until a human looks at the evidence."
            return Ok(Outcome::Halted { kind });
        }

        match self.step(stored, now_ms) {
            Ok(outcome) => Ok(outcome),
            Err(WitnessError::Fault(kind, error)) => {
                log::error!("refusing to cosign: {kind:?} ({error})");
                Ok(Outcome::Halted { kind })
            }
            Err(other) => Err(other),
        }
    }

    /// The body of one poll. Faults propagate as [`WitnessError::Fault`] and
    /// are turned into evidence at the point they are discovered, so that the
    /// tree heads that *are* the evidence are still in hand.
    fn step(&mut self, stored: Option<WitnessState>, now_ms: u64) -> Result<Outcome> {
        // ---- Step 1. Poll. --------------------------------------------------
        let bundle =
            decode_canonical::<TreeHeadBundle>(&self.transport.latest_sth()?)?.into_value();
        bundle
            .validate()
            .map_err(|error| WitnessError::Transport(format!("tree head bundle: {error}")))?;
        let served = bundle.head;

        let Some(mut stored) = stored else {
            return self.pin(&served, now_ms);
        };

        // ---- Step 2. Verify the stored position is still the log's. ---------
        //
        // `restore` re-derives the `LogView` from the head this witness itself
        // accepted, verifying its signature again under the pinned key. The
        // view has no public constructor; a restart cannot assert its way back
        // into one.
        let held = stored.head.clone();
        let mut view = match stored.restore() {
            Ok(view) => view,
            Err(error) => {
                return Err(self.record_and_halt(
                    &mut stored,
                    error,
                    vec![held],
                    Vec::new(),
                    &[],
                    now_ms,
                ));
            }
        };

        if served.sth.epoch <= stored.epoch {
            // §6.3 rules 3 and 8: a repeat of the epoch we hold is a no-op if it
            // is identical and a **fork** otherwise; anything earlier is a
            // rollback. `accept` names which, so the evidence carries the right
            // `FaultKind` rather than the nearest one.
            return match view.accept(&served) {
                Ok(()) => Ok(Outcome::UpToDate {
                    epoch: stored.epoch,
                }),
                Err(error) => Err(self.record_and_halt(
                    &mut stored,
                    WitnessError::Fault(fault_for(error), error),
                    vec![held],
                    vec![served],
                    &[],
                    now_ms,
                )),
            };
        }

        // ---- Steps 3 and 4. The run of heads, and the append-only proof. ----
        let span = served.sth.epoch.saturating_sub(stored.epoch);
        let target = if span > self.settings.max_audit_span {
            // Not a fault: the log may legitimately have moved further than one
            // request covers. Walk it in bounded steps instead of asking for
            // something a log with a §9.3 maximum would refuse.
            stored.epoch.saturating_add(self.settings.max_audit_span)
        } else {
            served.sth.epoch
        };
        self.advance_to(&mut stored, &mut view, target, now_ms)
    }

    /// Trust on first use: pin a log from the first head this witness sees.
    ///
    /// §6.3's rules are all relative, so the first head cannot be checked
    /// against anything except the operator's pinned `log_id` and signing key.
    /// What makes the pin worth having is every head after it.
    fn pin(&mut self, head: &SignedTreeHead, now_ms: u64) -> Result<Outcome> {
        let view = LogView::pin(self.settings.log_id, self.settings.accepted_log_pk, head)
            .map_err(|error| WitnessError::Fault(fault_for(error), error))?;
        let state = WitnessState::pin(&view, head, now_ms)?;
        // Step 5 before step 6, on the very first head too.
        state::store(&self.settings.state_path, &state)?;
        log::warn!(
            "pinned log {} at epoch {} (trust on first use; verify this root out of band)",
            crate::hex(self.settings.log_id.as_bytes()),
            head.sth.epoch
        );
        self.emit(head, now_ms)?;
        Ok(Outcome::Pinned {
            epoch: head.sth.epoch,
        })
    }

    /// Fetch `(stored.epoch, target]`, verify the append-only proof over it,
    /// verify §6.3 over it, persist, then cosign.
    fn advance_to(
        &mut self,
        stored: &mut WitnessState,
        view: &mut LogView,
        target: u64,
        now_ms: u64,
    ) -> Result<Outcome> {
        let from = stored.epoch;
        let response =
            decode_canonical::<AuditResponse>(&self.transport.audit(from, target)?)?.into_value();
        response
            .validate()
            .map_err(|error| WitnessError::Transport(format!("audit response: {error}")))?;

        let heads = response.heads.as_slice().to_vec();
        let proof = response.proof.as_slice().to_vec();

        // The run must start where this witness actually is. A log that
        // answered a different range — or the same range against a different
        // starting root — is not answering the question that was asked.
        let Some(first) = heads.first() else {
            return Err(WitnessError::Transport(
                "audit response carried no tree heads".to_owned(),
            ));
        };
        if first.sth.epoch != from || first.sth.root_hash != stored.root_hash {
            let held = stored.head.clone();
            let served = first.clone();
            return Err(self.record_and_halt(
                stored,
                WitnessError::Fault(FaultKind::Fork, KtError::Fork),
                vec![held],
                vec![served],
                &[],
                now_ms,
            ));
        }

        // ---- Step 4. THE check the role exists for (§7.4). ------------------
        let verified = match self.runtime.block_on(verify_append_only(&heads, &proof)) {
            Ok(verified) => verified,
            Err(error) => {
                // `append_only_failure` is the one kind that is NOT
                // self-authenticating (§7.3), so the proof bytes go in
                // `detail`: without them the report is an accusation nobody
                // can check.
                return Err(self.record_and_halt(
                    stored,
                    WitnessError::Fault(FaultKind::AppendOnlyFailure, error),
                    heads.clone(),
                    Vec::new(),
                    &proof,
                    now_ms,
                ));
            }
        };

        // ---- Step 3, enforced by the type: `advance` runs §6.3 over the run
        // and will not take a token that does not describe it. ---------------
        let mut auditor = AuditorState::new(view.clone());
        let advanced = match auditor.advance(&heads, &verified) {
            Ok(advanced) => advanced.clone(),
            Err(error) => {
                let kind = auditor.halted().unwrap_or_else(|| fault_for(error));
                let held = stored.head.clone();
                return Err(self.record_and_halt(
                    stored,
                    WitnessError::Fault(kind, error),
                    vec![held],
                    heads.clone(),
                    &[],
                    now_ms,
                ));
            }
        };
        *view = advanced;

        let Some(last) = heads.last() else {
            return Err(WitnessError::Transport(
                "audit response carried no tree heads".to_owned(),
            ));
        };

        // ---- Step 5. Persist, durably, BEFORE emitting anything. ------------
        stored.advance_to(view, last, now_ms);
        state::store(&self.settings.state_path, stored)?;

        // ---- Step 6. Emit. --------------------------------------------------
        self.emit(last, now_ms)?;
        Ok(Outcome::Cosigned {
            epoch: last.sth.epoch,
            advanced: last.sth.epoch.saturating_sub(from),
        })
    }

    /// Sign a cosignature, append it to this witness's own history, and push it
    /// to the log.
    ///
    /// The local append happens **before** the push. If the log is unreachable
    /// the witness has still recorded what it attested to, which is §7.5's
    /// whole point: the party under audit must not be the only distributor of
    /// the evidence used to audit it.
    fn emit(&self, head: &SignedTreeHead, now_ms: u64) -> Result<()> {
        let statement = WitnessCosignatureTBS {
            label: label_field(labels::LABEL_COSIG)
                .map_err(|error| WitnessError::Local(error.to_string()))?,
            kt_version: KT_VERSION,
            log_id: head.sth.log_id,
            epoch: head.sth.epoch,
            tree_size: head.sth.tree_size,
            root_hash: head.sth.root_hash,
            witness_pk: self.witness_pk,
            observed_at_ms: now_ms,
        };
        let signing_bytes = statement
            .signing_bytes()
            .map_err(|error| WitnessError::Local(error.to_string()))?;
        let cosignature = WitnessCosignature {
            statement,
            signature: Signature::new(self.key.sign(&signing_bytes).to_bytes()),
        };

        self.evidence.append_cosignature(&cosignature)?;

        let bytes = cosignature
            .encode_canonical()
            .map_err(|error| WitnessError::Local(error.to_string()))?;
        match self.transport.cosign(&bytes) {
            Ok(()) => log::info!("cosigned epoch {}", head.sth.epoch),
            // Not fatal, and not a fault. The witness has verified and
            // recorded; the log failing to collect its own cosignature is the
            // log's problem, and the next poll will try again.
            Err(error) => log::warn!(
                "cosignature for epoch {} not delivered: {error}",
                head.sth.epoch
            ),
        }
        Ok(())
    }

    /// Write evidence, persist the halt, and hand the fault back.
    ///
    /// Returns the error to return rather than a `Result`, so every call site
    /// reads `return Err(self.record_and_halt(..))` and the compiler enforces
    /// that nothing continues past a fault. If persisting the halt itself
    /// fails, **that** error is returned instead — a witness that could not
    /// record its halt must not report a clean stop.
    fn record_and_halt(
        &self,
        stored: &mut WitnessState,
        error: WitnessError,
        a: Vec<SignedTreeHead>,
        b: Vec<SignedTreeHead>,
        detail: &[u8],
        now_ms: u64,
    ) -> WitnessError {
        let kind = error.fault().unwrap_or(FaultKind::BadSignature);
        // Evidence first: it is the artefact, and a crash between the two just
        // means the next poll re-detects the same fault and rewrites it.
        if let Err(local) = self.evidence.record(
            &self.key,
            &crate::evidence::Finding {
                witness_pk: self.witness_pk,
                log_id: stored.log_id,
                kind,
                held: &a,
                served: &b,
                detail,
                observed_at_ms: now_ms,
            },
        ) {
            log::error!("fault report not written: {local}");
        }
        stored.halt(kind, now_ms);
        if let Err(local) = state::store(&self.settings.state_path, stored) {
            return local;
        }
        error
    }
}

/// The `FaultKind` a §6.3 verdict corresponds to.
///
/// `f2z-kt-core` has the same mapping internally and does not export it; it is
/// restated here rather than reached for, and the two are held together by
/// [`FaultKind::ALL`] being exhaustively matched.
const fn fault_for(error: KtError) -> FaultKind {
    match error {
        KtError::Rollback => FaultKind::Rollback,
        KtError::Fork => FaultKind::Fork,
        KtError::ChainBreak | KtError::EpochGap => FaultKind::ChainBreak,
        KtError::VrfKeyChange => FaultKind::VrfKeyChange,
        KtError::AppendOnlyFailure => FaultKind::AppendOnlyFailure,
        _ => FaultKind::BadSignature,
    }
}
