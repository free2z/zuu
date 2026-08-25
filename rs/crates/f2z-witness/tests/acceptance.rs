//! The acceptance test: a **real** log, a **real** witness, and a log that
//! equivocates.
//!
//! # Why the log here is real
//!
//! `KT.md` §7.4's structural argument is that the log and the witness link the
//! same `audit_verify`, at the same pinned version, so *"a divergence between
//! what the log believes it published and what a witness accepts cannot come
//! from two implementations disagreeing, because there are not two."* A witness
//! tested against a mock of a log is a witness tested against a second
//! implementation — the exact thing that argument rules out. So [`f2z_kt`] is a
//! dev-dependency here and these tests drive the actual server: real `akd`
//! trees, real signatures, real protobuf proofs.
//!
//! The only thing standing in for the network is [`Transport`], which is the
//! same trait the shipped `ureq` client implements. The equivocating log is not
//! a fake either: it is **two real logs sharing one signing key**, which is
//! precisely what an equivocating log is.
//!
//! # These are `#[test]`, not `#[tokio::test]`, on purpose
//!
//! `Witness::poll_once` is synchronous and drives `audit_verify` on a runtime
//! it owns, because `akd::auditor::audit_verify` reaches `tokio::task::spawn`
//! (`KT.md` §11.3). Calling it from inside another runtime would be a nested
//! `block_on`. That is a real property of the daemon's shape, not a test
//! artefact: the witness is a blocking poll loop with one runtime for one call.

// Test code, run on the host by a person reading the failure. The workspace
// denies these because a panic in a parser is a remote denial of service, and
// neither hazard exists here: a fixture that indexes past the end of a fixture
// is a failing test, which is what a test is for.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::sync::{Arc, Mutex};

use f2z_codec::Canonical as _;
use f2z_kt::LogService;
use f2z_kt::testing::{EntryBuilder, Harness, Identity, Key};
use f2z_kt_core::api::TreeHeadBundle;
use f2z_kt_core::types::Handle;
use f2z_kt_core::{ConfiguredWitness, FaultKind, WitnessSet, verify_threshold};
use f2z_witness::witness::{Outcome, Settings, Witness};
use f2z_witness::{Transport, WitnessError};

const NOW: u64 = 1_700_000_100_000;

/// The seed every witness in this file is built from.
///
/// Named rather than repeated because the **log** has to be configured with the
/// matching public key: a log with no `witness_pk` accepts no cosignatures at
/// all (zuu#669), so a fixture that stood up a log without naming its witness
/// would be testing the refusal path and calling it a happy path.
const WITNESS_SEED: u8 = 0xc1;

/// A log that recognises this file's witness.
fn log_for(name: &str) -> impl std::future::Future<Output = Harness> + use<'_> {
    Harness::vouched_with_witnesses(name, vec![Key::from_byte(WITNESS_SEED).public])
}

/// A transport that reaches a real [`LogService`] in this process.
///
/// It encodes exactly what `f2z-kt`'s HTTP handlers encode, because it calls
/// exactly what they call.
struct DirectTransport {
    runtime: tokio::runtime::Runtime,
    /// Which log answers. Swapping this is how the equivocation is staged: one
    /// key, two histories, the witness shown first one and then the other.
    log: Mutex<Arc<LogService>>,
    /// When set, `audit` serves this log's proof bytes with the *other* log's
    /// tree heads — a log that answers with a proof that does not describe the
    /// roots it is claiming.
    proof_from: Mutex<Option<Arc<LogService>>>,
}

impl DirectTransport {
    fn new(log: Arc<LogService>) -> Self {
        Self {
            runtime: tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .unwrap(),
            log: Mutex::new(log),
            proof_from: Mutex::new(None),
        }
    }

    fn serve(&self, log: &Arc<LogService>) {
        *self.log.lock().unwrap() = Arc::clone(log);
    }

    fn serve_proof_from(&self, log: Option<&Arc<LogService>>) {
        *self.proof_from.lock().unwrap() = log.map(Arc::clone);
    }

    fn current(&self) -> Arc<LogService> {
        Arc::clone(&self.log.lock().unwrap())
    }
}

impl Transport for DirectTransport {
    fn latest_sth(&self) -> f2z_witness::Result<Vec<u8>> {
        let log = self.current();
        let bundle = self
            .runtime
            .block_on(log.latest_bundle())
            .map_err(|error| WitnessError::Transport(error.to_string()))?;
        Ok(bundle.encode_canonical().unwrap())
    }

    fn audit(&self, from: u64, to: u64) -> f2z_witness::Result<Vec<u8>> {
        let log = self.current();
        let mut response = self
            .runtime
            .block_on(log.audit(from, to))
            .map_err(|error| WitnessError::Transport(error.to_string()))?;
        if let Some(other) = self.proof_from.lock().unwrap().as_ref() {
            let theirs = self
                .runtime
                .block_on(other.audit(from, to))
                .map_err(|error| WitnessError::Transport(error.to_string()))?;
            response.proof = theirs.proof;
        }
        Ok(response.encode_canonical().unwrap())
    }

    fn cosign(&self, cosignature: &[u8]) -> f2z_witness::Result<()> {
        let log = self.current();
        let decoded = f2z_codec::decode_canonical::<f2z_kt_core::WitnessCosignature>(cosignature)
            .map_err(|error| WitnessError::Transport(error.to_string()))?
            .into_value();
        self.runtime
            .block_on(log.accept_cosignature(&decoded))
            .map_err(|error| WitnessError::Transport(error.to_string()))
    }
}

fn witness_for(harness: &Harness, transport: Box<dyn Transport>, name: &str) -> Witness {
    let dir = f2z_kt::testing::temp_dir(name);
    Witness::new(
        Settings {
            log_id: harness.log_id,
            accepted_log_pk: harness.log.log_public_key(),
            state_path: dir.join("state.bin"),
            evidence_dir: dir.join("evidence"),
            max_audit_span: 64,
        },
        &[WITNESS_SEED; 32],
        transport,
    )
    .unwrap()
}

/// Register a handle and publish the epoch that carries it.
fn register(runtime: &tokio::runtime::Runtime, harness: &Harness, handle: &str, seed: u8) {
    runtime.block_on(async {
        let identity = Identity::from_byte(seed);
        let entry = EntryBuilder::first(harness.log_id, handle, &identity)
            .device(seed.wrapping_add(0x40), &identity.isk)
            .endpoint(seed)
            .same_key(&identity.dak);
        harness
            .log
            .submit(&harness.envelope(&entry, &identity, NOW), NOW)
            .await
            .unwrap();
        harness.log.publish_epoch(NOW).await.unwrap();
    });
}

// ---------------------------------------------------------------------------
// The happy path, end to end.
// ---------------------------------------------------------------------------

#[test]
fn a_witness_verifies_real_proofs_and_the_log_serves_its_cosignature() {
    let setup = tokio::runtime::Runtime::new().unwrap();
    let harness = setup.block_on(log_for("accept-happy"));
    setup.block_on(harness.log.publish_epoch(NOW)).unwrap();

    let transport = Arc::new(DirectTransport::new(Arc::clone(&harness.log)));
    let mut witness = witness_for(
        &harness,
        Box::new(TransportHandle(Arc::clone(&transport))),
        "accept-happy-w",
    );

    // Trust on first use at the genesis epoch.
    assert_eq!(
        witness.poll_once(NOW).unwrap(),
        Outcome::Pinned { epoch: 1 }
    );

    // The log grows: two handles, two epochs.
    register(&setup, &harness, "alice", 1);
    register(&setup, &harness, "bob", 2);

    // One poll, verifying the append-only proof over both transitions.
    assert_eq!(
        witness.poll_once(NOW + 1).unwrap(),
        Outcome::Cosigned {
            epoch: 3,
            advanced: 2
        }
    );

    // Polling again with nothing new is a no-op, not a second cosignature.
    assert_eq!(
        witness.poll_once(NOW + 2).unwrap(),
        Outcome::UpToDate { epoch: 3 }
    );

    // ---- What a CLIENT can now do, which is the point of all of it. --------
    //
    // The log serves the cosignature it collected, a client applies the §8.3
    // threshold against **its own** witness set, and only then verifies a
    // lookup proof against the root that survived.
    let bundle: TreeHeadBundle = setup.block_on(harness.log.latest_bundle()).unwrap();
    assert_eq!(
        bundle.cosignatures.len(),
        1,
        "the log served the witness's cosignature"
    );

    let set = WitnessSet::new(
        vec![ConfiguredWitness::independent(witness.public_key())],
        1,
    )
    .unwrap();
    let root = verify_threshold(
        &bundle.head,
        bundle.cosignatures.as_slice(),
        &set,
        &harness.log_id,
    )
    .unwrap();
    assert_eq!(root.epoch(), 3);
    assert_eq!(root.independent_cosignature_count(), 1);

    let handle = Handle::new(b"alice".to_vec()).unwrap();
    let response = setup.block_on(harness.log.lookup(&handle)).unwrap();
    response.validate().unwrap();
    let verified = f2z_kt_core::verify::verify_lookup(
        &root,
        &handle,
        response.entry.as_slice(),
        response.proof.as_slice(),
    )
    .unwrap();
    assert_eq!(verified.entry().entry.handle.as_slice(), b"alice");
    assert_eq!(verified.version(), 1);

    // And the witness kept its own copy of what it attested to (§7.5), so the
    // party under audit is not the only distributor of the evidence.
    let history = witness.evidence().directory().join("cosignatures.log");
    assert!(history.exists());
    assert!(std::fs::metadata(&history).unwrap().len() > 0);
}

// ---------------------------------------------------------------------------
// The equivocating log. THIS is the test the role exists for.
// ---------------------------------------------------------------------------

/// Two real logs, one signing key, two histories.
///
/// This is what an equivocating log actually is: not a mock that returns bad
/// bytes, but a server that has committed to two different roots for one epoch
/// and shows each party one of them, with a perfectly valid signature on both.
fn equivocating_pair(setup: &tokio::runtime::Runtime, name: &str) -> (Harness, Harness) {
    let left = setup.block_on(log_for(&format!("{name}-left")));
    let right = setup.block_on(log_for(&format!("{name}-right")));
    // `Harness` derives both logs from the same fixed seeds, so they share a
    // `log_id`, a signing key and a VRF key — and differ only in what they
    // published.
    assert_eq!(left.log_id, right.log_id);
    assert_eq!(left.log.log_public_key(), right.log.log_public_key());

    setup.block_on(left.log.publish_epoch(NOW)).unwrap();
    setup.block_on(right.log.publish_epoch(NOW)).unwrap();
    (left, right)
}

#[test]
fn a_witness_refuses_a_fork_and_records_self_authenticating_evidence() {
    let setup = tokio::runtime::Runtime::new().unwrap();
    let (left, right) = equivocating_pair(&setup, "accept-fork");

    let transport = Arc::new(DirectTransport::new(Arc::clone(&left.log)));
    let mut witness = witness_for(
        &left,
        Box::new(TransportHandle(Arc::clone(&transport))),
        "accept-fork-w",
    );
    assert_eq!(
        witness.poll_once(NOW).unwrap(),
        Outcome::Pinned { epoch: 1 }
    );

    // Each branch publishes a *different* epoch 2: one registers alice, the
    // other bob. Same key, same epoch number, different root.
    register(&setup, &left, "alice", 1);
    register(&setup, &right, "bob", 2);

    // The witness is shown the left branch and cosigns it.
    assert_eq!(
        witness.poll_once(NOW + 1).unwrap(),
        Outcome::Cosigned {
            epoch: 2,
            advanced: 1
        }
    );

    // Now the log shows it the other branch for the epoch it already signed.
    // §6.3 rule 8: same epoch, different root, and that is fatal.
    transport.serve(&right.log);
    assert_eq!(
        witness.poll_once(NOW + 2).unwrap(),
        Outcome::Halted {
            kind: FaultKind::Fork
        }
    );

    // Evidence, and the right kind of it.
    let reports = witness.evidence().reports().unwrap();
    assert_eq!(reports.len(), 1, "exactly one fault report");
    let bytes = std::fs::read(&reports[0]).unwrap();
    let report = f2z_codec::decode_canonical::<f2z_kt_core::FaultReport>(&bytes)
        .unwrap()
        .into_value();

    // The witness signed its own accusation: §7.3, "a witness that cries wolf
    // is on the record too."
    report.verify().unwrap();
    assert_eq!(report.report.kind, FaultKind::Fork);
    assert_eq!(report.report.witness_pk, witness.public_key());
    assert!(report.report.kind.is_self_authenticating());

    // And it is genuinely self-authenticating: two tree heads for one epoch,
    // both signed by the log's own key, with different roots. Anyone with that
    // public key can check this in milliseconds and needs to trust nobody.
    let held = report.report.a.as_slice();
    let served = report.report.b.as_slice();
    assert_eq!(held.len(), 1);
    assert_eq!(served.len(), 1);
    let log_pk = left.log.log_public_key();
    held[0].verify(&left.log_id, &log_pk).unwrap();
    served[0].verify(&left.log_id, &log_pk).unwrap();
    assert_eq!(held[0].sth.epoch, served[0].sth.epoch);
    assert_ne!(held[0].sth.root_hash, served[0].sth.root_hash);
}

#[test]
fn a_halted_witness_stays_halted_and_never_cosigns_again() {
    // §7.1: "A witness MUST NOT 'catch up' past a fault. Once halted it stays
    // halted until a human looks at the evidence. An automatic resync is an
    // automatic way to erase the only record of the thing the witness exists to
    // find."
    let setup = tokio::runtime::Runtime::new().unwrap();
    let (left, right) = equivocating_pair(&setup, "accept-stay-halted");

    let transport = Arc::new(DirectTransport::new(Arc::clone(&left.log)));
    let dir = f2z_kt::testing::temp_dir("accept-stay-halted-w");
    let settings = Settings {
        log_id: left.log_id,
        accepted_log_pk: left.log.log_public_key(),
        state_path: dir.join("state.bin"),
        evidence_dir: dir.join("evidence"),
        max_audit_span: 64,
    };
    let mut witness = Witness::new(
        settings.clone(),
        &[0xc2; 32],
        Box::new(TransportHandle(Arc::clone(&transport))),
    )
    .unwrap();

    witness.poll_once(NOW).unwrap();
    register(&setup, &left, "alice", 1);
    register(&setup, &right, "bob", 2);
    witness.poll_once(NOW + 1).unwrap();
    transport.serve(&right.log);
    assert!(matches!(
        witness.poll_once(NOW + 2).unwrap(),
        Outcome::Halted { .. }
    ));

    // Put the honest branch back. A witness that "recovered" here would have
    // erased the only record of what it saw.
    transport.serve(&left.log);
    assert!(matches!(
        witness.poll_once(NOW + 3).unwrap(),
        Outcome::Halted { .. }
    ));

    // And the halt survives a restart, because it is in the state file rather
    // than in memory.
    let mut restarted = Witness::new(
        settings,
        &[0xc2; 32],
        Box::new(TransportHandle(Arc::clone(&transport))),
    )
    .unwrap();
    assert!(matches!(
        restarted.poll_once(NOW + 4).unwrap(),
        Outcome::Halted { .. }
    ));

    // The probe agrees, and tells the operator not to clear the state file.
    let health = f2z_witness::health::probe(
        &dir.join("state.bin"),
        NOW + 5,
        f2z_witness::health::DEFAULT_STALE_AFTER_MS,
    )
    .unwrap();
    assert!(!health.is_healthy());
    assert_eq!(health.exit_code(), 1);
    assert!(
        health
            .message(&dir.join("evidence"))
            .contains("Do NOT clear the state file")
    );
}

#[test]
fn a_witness_refuses_an_append_only_proof_that_does_not_verify() {
    // §7.4: the check the whole role exists for. A log that serves a proof
    // which does not describe the roots it is claiming has failed the only test
    // a client cannot run for itself.
    let setup = tokio::runtime::Runtime::new().unwrap();
    let (left, right) = equivocating_pair(&setup, "accept-append-only");

    let transport = Arc::new(DirectTransport::new(Arc::clone(&left.log)));
    let mut witness = witness_for(
        &left,
        Box::new(TransportHandle(Arc::clone(&transport))),
        "accept-append-only-w",
    );
    assert_eq!(
        witness.poll_once(NOW).unwrap(),
        Outcome::Pinned { epoch: 1 }
    );

    register(&setup, &left, "alice", 1);
    register(&setup, &right, "bob", 2);

    // The left log's tree heads, the right log's proof. Every signature is
    // valid; the proof simply is not a proof about these roots.
    transport.serve_proof_from(Some(&right.log));
    assert_eq!(
        witness.poll_once(NOW + 1).unwrap(),
        Outcome::Halted {
            kind: FaultKind::AppendOnlyFailure
        }
    );

    let reports = witness.evidence().reports().unwrap();
    assert_eq!(reports.len(), 1);
    let bytes = std::fs::read(&reports[0]).unwrap();
    let report = f2z_codec::decode_canonical::<f2z_kt_core::FaultReport>(&bytes)
        .unwrap()
        .into_value();
    report.verify().unwrap();
    assert_eq!(report.report.kind, FaultKind::AppendOnlyFailure);

    // §7.3's table: this is the ONE kind that is not self-authenticating. The
    // claim is "this proof does not verify", and a third party must re-run
    // `audit_verify` on the bytes to see it — so the bytes must be there.
    assert!(!report.report.kind.is_self_authenticating());
    assert!(
        !report.report.detail.as_slice().is_empty(),
        "an append_only_failure report without the proof bytes is an accusation nobody can check"
    );
}

#[test]
fn a_witness_that_never_polled_is_unpinned_rather_than_healthy() {
    let dir = f2z_kt::testing::temp_dir("accept-unpinned");
    let health = f2z_witness::health::probe(
        &dir.join("state.bin"),
        NOW,
        f2z_witness::health::DEFAULT_STALE_AFTER_MS,
    )
    .unwrap();
    assert_eq!(health, f2z_witness::health::Health::Unpinned);
    assert_eq!(health.exit_code(), 1);
}

/// `Transport` for an `Arc<DirectTransport>`, so one transport can be held by
/// the test and by the witness at the same time.
struct TransportHandle(Arc<DirectTransport>);

impl Transport for TransportHandle {
    fn latest_sth(&self) -> f2z_witness::Result<Vec<u8>> {
        self.0.latest_sth()
    }
    fn audit(&self, from: u64, to: u64) -> f2z_witness::Result<Vec<u8>> {
        self.0.audit(from, to)
    }
    fn cosign(&self, cosignature: &[u8]) -> f2z_witness::Result<()> {
        self.0.cosign(cosignature)
    }
}
