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
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
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
    #[must_use]
    pub const fn is_healthy(&self) -> bool {
        matches!(self, Self::Following { .. })
    }

    /// The process exit code.
    #[must_use]
    pub const fn exit_code(&self) -> u8 {
        if self.is_healthy() { 0 } else { 1 }
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
        let health = probe(&path, 1_000 + DEFAULT_STALE_AFTER_MS + 1, DEFAULT_STALE_AFTER_MS)
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

        let health = probe(&path, 1_000 + DEFAULT_STALE_AFTER_MS * 10, DEFAULT_STALE_AFTER_MS)
            .unwrap();
        assert!(matches!(health, Health::Halted { .. }));
    }

    #[test]
    fn an_unreadable_state_file_is_an_error_rather_than_unpinned() {
        let path = temp("corrupt").join("state.bin");
        std::fs::write(&path, b"junk").unwrap();
        assert!(probe(&path, 1_000, DEFAULT_STALE_AFTER_MS).is_err());
    }
}
