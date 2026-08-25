//! `f2z-witness healthz` — the liveness contract with the deployment.
//!
//! # Why this is a subcommand and not an endpoint
//!
//! `KT.md` §9.3 promises that a witness needs **no inbound port, no TLS
//! certificate and no domain**. Honouring that means there is nothing for a
//! probe to dial. The deployment image is distroless, so there is also no
//! shell, no `wget` and no `curl` to script one with. An `exec` probe running
//! this binary is the only shape left, and the manifests depend on it:
//!
//! ```yaml
//! livenessProbe:
//!   exec:
//!     command: ["/f2z-witness", "healthz", "--state", "/var/lib/f2z-witness/state.bin"]
//! ```
//!
//! # What "healthy" means here, precisely
//!
//! A witness is healthy when it is **following a log and has not halted**. That
//! is three checks, and each of the three failure modes is a different
//! operational event:
//!
//! | Verdict | Exit | What it means |
//! |---|---|---|
//! | [`Health::Following`] | 0 | Polling, and the last poll was recent. |
//! | [`Health::Stale`] | 1 | The state file has not been updated within the staleness bound: the daemon is wedged, or the log is unreachable. Restarting may help. |
//! | [`Health::Halted`] | 1 | **A fault was found.** Restarting will not help and must not be attempted blindly — §7.1: *"Once halted it stays halted until a human looks at the evidence. An automatic resync is an automatic way to erase the only record of the thing the witness exists to find."* |
//! | [`Health::Unpinned`] | 1 | No state file. The witness has never successfully polled. |
//!
//! **`Halted` deliberately fails the probe.** A halted witness is not doing its
//! job and an operator must find out. The reason it is reported as a *distinct*
//! verdict, with its own message naming the fault kind and the evidence
//! directory, is so that whoever reads the probe output does not respond to a
//! detected equivocation by deleting the state file and starting again — which
//! is precisely the reflex that destroys the evidence.

use std::path::Path;

use f2z_kt_core::FaultKind;

use crate::state;

/// The default staleness bound: a witness polling a log on `KT.md` §5.1's
/// proposed 600 s cadence should touch its state file well inside an hour.
///
/// A **placeholder**, like the cadence it is derived from. It is generous on
/// purpose: a probe that fires because one poll was slow restarts a healthy
/// witness, and a restarted witness is a witness that is not polling.
pub const DEFAULT_STALE_AFTER_MS: u64 = 3_600_000;

/// What a probe found.
///
/// Deliberately **not** `#[non_exhaustive]` (zuu#666), for the reason
/// `f2z_relay::server::Stopped` is not: the binary is a separate crate from
/// this library, so that attribute would force a wildcard arm on every match
/// in `main`, and a wildcard arm is how a future verdict silently inherits
/// somebody else's exit code. A new variant here should break every caller
/// until each has decided what it means.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Health {
    /// Following a log, last updated recently.
    Following {
        /// The epoch held.
        epoch: u64,
        /// How long ago the state file was written.
        age_ms: u64,
    },
    /// The state file has not moved within the bound.
    Stale {
        /// The epoch held.
        epoch: u64,
        /// How long ago the state file was written.
        age_ms: u64,
    },
    /// A fault was found and the witness has stopped. **Do not restart
    /// blindly** — read the evidence.
    Halted {
        /// What was found.
        kind: FaultKind,
        /// The epoch it was holding when it halted.
        epoch: u64,
    },
    /// No state file: this witness has never completed a poll.
    Unpinned,
}

impl Health {
    /// Whether the probe should pass.
    ///
    /// Exhaustive rather than `matches!`, for [`Self::is_alive`]'s reason
    /// (zuu#666). This one happens to be fail-*closed* today — anything new is
    /// not `Following`, so it would fail readiness — but two predicates over
    /// one enum written in two different styles is how the asymmetry arose in
    /// the first place, and the fail-closed one is the cheap half to fix.
    #[must_use]
    pub const fn is_healthy(&self) -> bool {
        match self {
            Self::Following { .. } => true,
            Self::Stale { .. } | Self::Halted { .. } | Self::Unpinned => false,
        }
    }

    /// Whether a **liveness** probe should pass: `healthz --liveness yes`.
    ///
    /// # Why this is a different question
    ///
    /// [`Self::is_healthy`] folds in two verdicts that are statements about the
    /// **upstream log**, not about this process. [`Health::Stale`] means the log
    /// is unreachable or has stopped publishing; [`Health::Unpinned`] means it
    /// has not been reachable yet. Wiring either to a Kubernetes
    /// `livenessProbe` couples this pod's lifetime to somebody else's
    /// availability: DNS, TLS, egress or the log itself goes down, the probe
    /// fails on a schedule, and the kubelet restarts the witness — during
    /// exactly the incident in which its state file is the evidence a human
    /// needs. The startup probe then cannot pass either, because it asks the
    /// same stale-sensitive question, so the pod cycles for as long as the
    /// dependency is down. A longer `--stale-after` delays that; it cannot
    /// remove it, because any finite window expires.
    ///
    /// So a liveness probe asks only what a restart could possibly repair, and
    /// the answer is: nothing here. **Staleness is an alert, not a restart** —
    /// killing the observer does not fix the observed. Whether the witness is
    /// actually cosigning is a monitoring signal over its metrics, and it must
    /// stay one.
    ///
    /// [`Health::Halted`] still fails. Not so that the pod is restarted — §7.1
    /// is emphatic that a halted witness must not be restarted blindly, and the
    /// daemon already exits non-zero on its own when it halts — but so that a
    /// halted witness is never reported as fine by the one check an operator
    /// looks at first. A `0/1` pod with `HALTED` in its probe output is the
    /// correct thing for a human to find.
    ///
    /// # Why this is a `match` and not `!matches!(self, Self::Halted { .. })`
    ///
    /// zuu#666. Written as a negation, this predicate **defaults a variant that
    /// does not exist yet to "alive"**: a fifth local fault — a state file that
    /// exists but cannot be read, a signature that does not verify, a second
    /// halt-like condition — is not `Halted`, so the liveness probe passes and
    /// the pod shows `1/1` while the witness sits in a fault it cannot leave.
    /// The compiler said nothing, because the only exhaustive match on this
    /// enum was [`Self::message`] — so adding a variant asked the author for a
    /// **display string** and never for a verdict.
    ///
    /// An exhaustive match moves that question to the one place it belongs:
    /// a new variant is a compile error *here*, where the author has to answer
    /// "could a restart repair this?" — which the doc comment above frames
    /// better than any test could, and which no test can ask on behalf of a
    /// variant nobody has written yet.
    #[must_use]
    pub const fn is_alive(&self) -> bool {
        match self {
            // Statements about the upstream LOG. A restart cannot repair
            // either, and restarting on a schedule during someone else's
            // outage destroys the state file that is the evidence a human
            // needs.
            Self::Following { .. } | Self::Stale { .. } | Self::Unpinned => true,
            // Local and permanent. Visible as `0/1` with HALTED in the output.
            Self::Halted { .. } => false,
        }
    }

    /// The process exit code for a readiness/startup probe.
    #[must_use]
    pub const fn exit_code(&self) -> u8 {
        if self.is_healthy() { 0 } else { 1 }
    }

    /// The process exit code for a liveness probe. See [`Self::is_alive`].
    #[must_use]
    pub const fn liveness_exit_code(&self) -> u8 {
        if self.is_alive() { 0 } else { 1 }
    }

    /// One line for the probe's output.
    #[must_use]
    pub fn message(&self, evidence_dir: &Path) -> String {
        match self {
            Self::Following { epoch, age_ms } => {
                format!("ok: following at epoch {epoch}, state {age_ms}ms old")
            }
            Self::Stale { epoch, age_ms } => format!(
                "STALE: at epoch {epoch}, state {age_ms}ms old; the daemon is wedged or the log \
                 is unreachable"
            ),
            Self::Halted { kind, epoch } => format!(
                "HALTED: {kind:?} at epoch {epoch}. Evidence is in {}. Do NOT clear the state \
                 file: a witness that resyncs past a fault erases the only record of it.",
                evidence_dir.display()
            ),
            Self::Unpinned => {
                "UNPINNED: no state file; this witness has never completed a poll".to_owned()
            }
        }
    }
}

/// Probe a witness by reading its state file.
///
/// Reads only — it never writes, never polls, and never touches the network, so
/// a probe running every ten seconds costs one `read` and cannot interfere with
/// the daemon it is checking.
///
/// # Errors
///
/// [`crate::WitnessError::Local`] if the state file exists but cannot be read
/// or decoded. That is not [`Health::Unpinned`]: an unreadable state file is a
/// fault of its own, and reporting it as "never polled" would invite exactly
/// the wrong repair.
pub fn probe(state_path: &Path, now_ms: u64, stale_after_ms: u64) -> crate::Result<Health> {
    let Some(state) = state::load(state_path)? else {
        return Ok(Health::Unpinned);
    };

    if let Some(kind) = state.halt_kind() {
        return Ok(Health::Halted {
            kind,
            epoch: state.epoch,
        });
    }

    // A state file written in the future is a clock that moved backwards, not a
    // fresh file. Saturating to zero reports it as healthy-and-just-written
    // rather than as an enormous age; the clock is the thing to fix and this is
    // not the place that reports it.
    let age_ms = now_ms.saturating_sub(state.updated_at_ms);
    if age_ms > stale_after_ms {
        return Ok(Health::Stale {
            epoch: state.epoch,
            age_ms,
        });
    }
    Ok(Health::Following {
        epoch: state.epoch,
        age_ms,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::path::PathBuf;

    use f2z_codec::types::{Digest, PublicKey};
    use f2z_kt_core::FaultKind;
    use f2z_kt_core::sth::{SignedTreeHead, SignedTreeHeadTBS};
    use f2z_kt_core::types::{LogId, label_field};

    use super::{DEFAULT_STALE_AFTER_MS, Health, probe};
    use crate::state::{WitnessState, store};

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("f2z-health-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn state(updated_at_ms: u64) -> WitnessState {
        let sth = SignedTreeHeadTBS {
            label: label_field(f2z_kt_core::labels::LABEL_STH).unwrap(),
            kt_version: f2z_kt_core::KT_VERSION,
            log_id: LogId::new([1u8; 32]),
            epoch: 9,
            tree_size: 20,
            root_hash: Digest::new([2u8; 32]),
            prev_sth_hash: Digest::new([3u8; 32]),
            vrf_public_key: PublicKey::new([4u8; 32]),
            published_at_ms: 500,
            reset_count: 0,
            epoch_interval_seconds: 600,
            max_merge_delay_seconds: 3_600,
            successor_log_pk: PublicKey::zero(),
        };
        WitnessState {
            label: label_field(b"free2z/kt/v1/witness-state").unwrap(),
            kt_version: f2z_kt_core::KT_VERSION,
            log_id: LogId::new([1u8; 32]),
            accepted_log_pk: PublicKey::new([5u8; 32]),
            head: SignedTreeHead {
                sth,
                signature: f2z_codec::types::Signature::zero(),
            },
            epoch: 9,
            tree_size: 20,
            root_hash: Digest::new([2u8; 32]),
            sth_hash: Digest::new([6u8; 32]),
            vrf_public_key: PublicKey::new([4u8; 32]),
            published_at_ms: 500,
            halted: 0,
            updated_at_ms,
        }
    }

    #[test]
    fn no_state_file_is_unpinned_and_fails_the_probe() {
        let path = temp("unpinned").join("state.bin");
        let health = probe(&path, 1_000, DEFAULT_STALE_AFTER_MS).unwrap();
        assert_eq!(health, Health::Unpinned);
        assert_eq!(health.exit_code(), 1);
    }

    #[test]
    fn a_recently_updated_state_file_passes() {
        let path = temp("following").join("state.bin");
        store(&path, &state(1_000)).unwrap();
        let health = probe(&path, 2_000, DEFAULT_STALE_AFTER_MS).unwrap();
        assert!(health.is_healthy());
        assert_eq!(health.exit_code(), 0);
    }

    #[test]
    fn a_stale_state_file_fails() {
        let path = temp("stale").join("state.bin");
        store(&path, &state(1_000)).unwrap();
        let health = probe(
            &path,
            1_000 + DEFAULT_STALE_AFTER_MS + 1,
            DEFAULT_STALE_AFTER_MS,
        )
        .unwrap();
        assert!(matches!(health, Health::Stale { .. }));
        assert_eq!(health.exit_code(), 1);
    }

    #[test]
    fn a_halted_witness_fails_the_probe_and_says_not_to_clear_the_state() {
        // The message matters as much as the exit code: the reflex a halted
        // witness invites — delete the state file and restart — is the one
        // action that destroys the evidence it exists to produce.
        let path = temp("halted").join("state.bin");
        let mut halted = state(1_000);
        halted.halt(FaultKind::Fork, 1_000);
        store(&path, &halted).unwrap();

        let health = probe(&path, 1_100, DEFAULT_STALE_AFTER_MS).unwrap();
        assert_eq!(
            health,
            Health::Halted {
                kind: FaultKind::Fork,
                epoch: 9
            }
        );
        assert_eq!(health.exit_code(), 1);
        let message = health.message(std::path::Path::new("/var/lib/f2z-witness/evidence"));
        assert!(message.contains("Do NOT clear the state file"));
        assert!(message.contains("/var/lib/f2z-witness/evidence"));
    }

    #[test]
    fn a_halted_witness_is_reported_as_halted_even_when_it_is_also_stale() {
        // Order matters: "stale" invites a restart, "halted" forbids one.
        let path = temp("halted-stale").join("state.bin");
        let mut halted = state(1_000);
        halted.halt(FaultKind::Rollback, 1_000);
        store(&path, &halted).unwrap();

        let health = probe(
            &path,
            1_000 + DEFAULT_STALE_AFTER_MS * 10,
            DEFAULT_STALE_AFTER_MS,
        )
        .unwrap();
        assert!(matches!(health, Health::Halted { .. }));
    }

    #[test]
    fn a_liveness_probe_ignores_the_upstream_log_and_not_a_local_fault() {
        // The whole reason `--liveness yes` exists. STALE and UNPINNED are
        // statements about the LOG: it is unreachable, or has not been reached
        // yet. Restarting this pod cannot repair either, and doing it on a
        // schedule during a KT outage destroys the state file that is the
        // evidence somebody needs. HALTED is local and permanent, so it still
        // fails and stays visible as `0/1`.
        let dir = temp("liveness");

        let unpinned = probe(&dir.join("absent.bin"), 1_000, DEFAULT_STALE_AFTER_MS).unwrap();
        assert_eq!(unpinned, Health::Unpinned);
        assert_eq!(unpinned.exit_code(), 1);
        assert_eq!(unpinned.liveness_exit_code(), 0);

        let stale_path = dir.join("stale.bin");
        store(&stale_path, &state(1_000)).unwrap();
        let stale = probe(
            &stale_path,
            1_000 + DEFAULT_STALE_AFTER_MS + 1,
            DEFAULT_STALE_AFTER_MS,
        )
        .unwrap();
        assert!(matches!(stale, Health::Stale { .. }));
        assert_eq!(stale.exit_code(), 1);
        assert_eq!(stale.liveness_exit_code(), 0);

        let halted_path = dir.join("halted.bin");
        let mut halted_state = state(1_000);
        halted_state.halt(FaultKind::Fork, 1_000);
        store(&halted_path, &halted_state).unwrap();
        let halted = probe(&halted_path, 2_000, DEFAULT_STALE_AFTER_MS).unwrap();
        assert!(matches!(halted, Health::Halted { .. }));
        assert_eq!(halted.exit_code(), 1);
        assert_eq!(halted.liveness_exit_code(), 1);

        let following_path = dir.join("following.bin");
        store(&following_path, &state(1_000)).unwrap();
        let following = probe(&following_path, 2_000, DEFAULT_STALE_AFTER_MS).unwrap();
        assert_eq!(following.exit_code(), 0);
        assert_eq!(following.liveness_exit_code(), 0);
    }

    #[test]
    fn an_unreadable_state_file_is_an_error_rather_than_unpinned() {
        let path = temp("corrupt").join("state.bin");
        std::fs::write(&path, b"junk").unwrap();
        assert!(probe(&path, 1_000, DEFAULT_STALE_AFTER_MS).is_err());
    }
}
