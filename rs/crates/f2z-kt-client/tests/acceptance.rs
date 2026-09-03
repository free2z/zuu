//! The acceptance suite: a **real** log, a **real** witness, and a client that
//! refuses a bad answer.
//!
//! # Why nothing here is a mock
//!
//! `KT.md` §7.4 argues that the log and the witness cannot disagree because
//! there is only one implementation of the verification. The same argument
//! applies to the client with the same force, and it cuts the other way too: a
//! client tested against a *fixture* of a log is a client tested against a
//! second implementation of the thing it exists to catch lying, and a fixture
//! will happily produce a proof that verifies for entries nobody authorized —
//! because a fixture author writes whatever makes the test pass.
//!
//! So `f2z-kt`'s `LogService` is a dev-dependency here and these tests drive
//! the actual server: real `akd` trees over a real VRF, real Ed25519, real
//! protobuf proofs, real epochs. `f2z-witness` is a dev-dependency for the same
//! reason: the cosignatures the threshold is applied to are produced by the
//! daemon that would produce them in production, after it has verified the
//! append-only proof.
//!
//! The only thing standing in for the network is [`Transport`], which is the
//! trait the shipped `ureq` client implements. It is not a fake of the client's
//! loop; it is the socket.
//!
//! # What each test establishes
//!
//! | Test | §  |
//! |---|---|
//! | a valid lookup verifies against a witness-cosigned root | §8.1 |
//! | a tampered inclusion proof is refused | §8.1 steps 4–5 |
//! | an entry swapped for another handle's is refused | §8.1 step 4 |
//! | an unproved absence is surfaced as unproved | §8.1's correction |
//! | a root with too few cosignatures is refused, and the pin survives | §8.3 |
//! | a key change the user did not initiate raises the alarm | §8.2 step 5 |
//! | a pinned handle asserted absent fails closed and alarms | §8.1's correction |
//! | self-audit continues, and reports, under an unwitnessed root | §8.3's table |
//! | a history with a version omitted is refused | §8.2 step 4 |
//! | a history whose `prev_entry_hash` chain does not link is refused | §8.2 step 4 |
//! | a history that chains by hash and renumbers a version is refused | §8.2 step 4 |

// Test code, run on the host by a person reading the failure. The workspace
// denies these because a panic in a parser is a remote denial of service, and
// neither hazard exists here.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::sync::{Arc, Mutex};

use f2z_codec::Canonical as _;
use f2z_codec::types::{Digest, PublicKey};
use f2z_kt::LogService;
use f2z_kt::testing::{EntryBuilder, Harness, Identity, Key};
use f2z_kt_client::{
    AlarmKind, ClientConfig, ClientError, KtClient, PinOutcome, Resolution, Transport,
};
use f2z_kt_core::entry::{DirectoryEntry, EntryKind};
use f2z_kt_core::types::Handle;
use f2z_kt_core::{ConfiguredWitness, KtError, WitnessSet, labels};
use f2z_witness::witness::{Outcome, Settings, Witness};

const NOW: u64 = 1_700_000_100_000;

/// The seed the witness in this file is built from.
///
/// The **log** must be configured with the matching public key: a log with no
/// `witness_pk` accepts no cosignatures at all (zuu#669), so a fixture that
/// stood up a log without naming its witness would be exercising the refusal
/// path and calling it a happy path.
const WITNESS_SEED: u8 = 0xc1;

// ---------------------------------------------------------------------------
// The socket.
// ---------------------------------------------------------------------------

/// A [`Transport`] that reaches a real [`LogService`] in this process, encoding
/// exactly what `f2z-kt`'s HTTP handlers encode because it calls exactly what
/// they call.
///
/// The two `Mutex`es are how a dishonest log is staged. Neither invents bytes:
/// `tamper` flips a byte of a **real** proof, and `entry_from` serves one real
/// entry's bytes in another's response.
struct DirectTransport {
    runtime: tokio::runtime::Runtime,
    log: Arc<LogService>,
    tamper_proof: Mutex<bool>,
    entry_override: Mutex<Option<Vec<u8>>>,
    drop_cosignatures: Mutex<bool>,
    claim_absent: Mutex<bool>,
    claim_absent_with_proof: Mutex<bool>,
    /// Serve a history with the entry at this index removed — the **truthful
    /// subset** of `KT.md` §8.2. Everything still served is real.
    omit_history_entry: Mutex<Option<usize>>,
    /// Serve these bytes in place of the history entry at this index.
    swap_history_entry: Mutex<Option<(usize, Vec<u8>)>>,
}

impl DirectTransport {
    fn new(log: Arc<LogService>) -> Self {
        Self {
            runtime: tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .unwrap(),
            log,
            tamper_proof: Mutex::new(false),
            entry_override: Mutex::new(None),
            drop_cosignatures: Mutex::new(false),
            claim_absent: Mutex::new(false),
            claim_absent_with_proof: Mutex::new(false),
            omit_history_entry: Mutex::new(None),
            swap_history_entry: Mutex::new(None),
        }
    }

    /// Drop one entry from every history response — the omission §8.2 step 4
    /// exists to catch. The index is into the response's own order, which is
    /// `akd`'s decreasing version order.
    fn omit_history_entry(&self, index: Option<usize>) {
        *self.omit_history_entry.lock().unwrap() = index;
    }

    /// Serve `bytes` in place of the history entry at `index`.
    fn swap_history_entry(&self, swap: Option<(usize, Vec<u8>)>) {
        *self.swap_history_entry.lock().unwrap() = swap;
    }

    fn tamper_next_proof(&self) {
        *self.tamper_proof.lock().unwrap() = true;
    }

    fn serve_entry(&self, bytes: Option<Vec<u8>>) {
        *self.entry_override.lock().unwrap() = bytes;
    }

    /// The withholding a log can always perform: §7.5's conflict of interest,
    /// where the party under audit distributes the evidence used to audit it
    /// and can simply appear to have fewer witnesses this epoch.
    fn withhold_cosignatures(&self, value: bool) {
        *self.drop_cosignatures.lock().unwrap() = value;
    }

    fn assert_absent(&self, value: bool) {
        *self.claim_absent.lock().unwrap() = value;
    }

    fn assert_absent_but_retain_proof(&self) {
        *self.claim_absent_with_proof.lock().unwrap() = true;
    }

    fn bundle_bytes(&self, mut bundle: f2z_kt_core::api::TreeHeadBundle) -> Vec<u8> {
        if *self.drop_cosignatures.lock().unwrap() {
            bundle = f2z_kt_core::api::TreeHeadBundle::new(bundle.head, Vec::new()).unwrap();
        }
        bundle.encode_canonical().unwrap()
    }
}

impl Transport for DirectTransport {
    fn latest_sth(&self) -> f2z_kt_client::Result<Vec<u8>> {
        let bundle = self
            .runtime
            .block_on(self.log.latest_bundle())
            .map_err(|error| ClientError::Unreachable(error.to_string()))?;
        Ok(self.bundle_bytes(bundle))
    }

    fn sth_at(&self, epoch: u64) -> f2z_kt_client::Result<Vec<u8>> {
        let bundle = self
            .runtime
            .block_on(self.log.bundle_at(epoch))
            .map_err(|error| ClientError::Unreachable(error.to_string()))?;
        Ok(self.bundle_bytes(bundle))
    }

    fn lookup(&self, request: &[u8]) -> f2z_kt_client::Result<Vec<u8>> {
        let decoded =
            f2z_codec::decode_canonical::<f2z_kt_core::api::LookupRequest>(request)?.into_value();
        decoded.validate()?;
        let mut response = self
            .runtime
            .block_on(self.log.lookup(&decoded.handle))
            .map_err(|error| ClientError::Unreachable(error.to_string()))?;

        if *self.claim_absent.lock().unwrap() {
            response.presence = f2z_kt_core::api::Presence::AbsentUnproved.code();
            response.entry = f2z_codec::types::Payload::new(Vec::new()).unwrap();
            response.proof = f2z_codec::types::Payload::new(Vec::new()).unwrap();
        }
        if *self.claim_absent_with_proof.lock().unwrap() {
            response.presence = f2z_kt_core::api::Presence::AbsentUnproved.code();
            response.entry = f2z_codec::types::Payload::new(Vec::new()).unwrap();
        }
        if *self.tamper_proof.lock().unwrap() {
            // One byte of a real `akd` `LookupProof`. Not a garbage buffer: the
            // interesting failure is a proof that is structurally a proof and
            // does not verify, because a buffer of zeroes would be caught by
            // the protobuf decoder before `lookup_verify` ever ran.
            let mut proof = response.proof.as_slice().to_vec();
            let last = proof.len() - 1;
            proof[last] ^= 0x01;
            response.proof = f2z_codec::types::Payload::new(proof).unwrap();
        }
        if let Some(bytes) = self.entry_override.lock().unwrap().as_ref() {
            response.entry = f2z_codec::types::Payload::new(bytes.clone()).unwrap();
        }
        if *self.drop_cosignatures.lock().unwrap() {
            response.bundle =
                f2z_kt_core::api::TreeHeadBundle::new(response.bundle.head, Vec::new()).unwrap();
        }
        Ok(response.encode_canonical().unwrap())
    }

    fn history(&self, request: &[u8]) -> f2z_kt_client::Result<Vec<u8>> {
        let decoded =
            f2z_codec::decode_canonical::<f2z_kt_core::api::HistoryRequest>(request)?.into_value();
        decoded.validate()?;
        let mut response = self
            .runtime
            .block_on(self.log.history(
                &decoded.handle,
                f2z_kt_core::verify::HistoryParams::Complete,
            ))
            .map_err(|error| ClientError::Unreachable(error.to_string()))?;
        if *self.drop_cosignatures.lock().unwrap() {
            response.bundle =
                f2z_kt_core::api::TreeHeadBundle::new(response.bundle.head, Vec::new()).unwrap();
        }
        if let Some((index, bytes)) = self.swap_history_entry.lock().unwrap().as_ref() {
            let mut entries = response.entries.as_slice().to_vec();
            entries[*index] = f2z_codec::types::Payload::new(bytes.clone()).unwrap();
            response.entries = f2z_codec::vec::VecU24::new(entries);
        }
        if let Some(index) = *self.omit_history_entry.lock().unwrap() {
            let mut entries = response.entries.as_slice().to_vec();
            entries.remove(index);
            response.entries = f2z_codec::vec::VecU24::new(entries);
        }
        Ok(response.encode_canonical().unwrap())
    }

    fn authority_policy(&self) -> f2z_kt_client::Result<Vec<u8>> {
        // The `LogService` does not sign the policy; `f2z-kt`'s binary does, at
        // startup. Reported as unreachable rather than faked, which is exactly
        // what a client must do with an unanswered §8.1 step 7 — see
        // `a_policy_that_cannot_be_fetched_leaves_vouching_unknown`.
        Err(ClientError::Unreachable(
            "this fixture serves no policy".to_owned(),
        ))
    }

    fn descriptor(&self) -> f2z_kt_client::Result<Vec<u8>> {
        Err(ClientError::Unreachable(
            "this fixture serves no descriptor".to_owned(),
        ))
    }
}

/// A handle to the transport, so the tests can keep poking the log while the
/// client owns its socket.
struct TransportHandle(Arc<DirectTransport>);

impl Transport for TransportHandle {
    fn latest_sth(&self) -> f2z_kt_client::Result<Vec<u8>> {
        self.0.latest_sth()
    }
    fn sth_at(&self, epoch: u64) -> f2z_kt_client::Result<Vec<u8>> {
        self.0.sth_at(epoch)
    }
    fn lookup(&self, request: &[u8]) -> f2z_kt_client::Result<Vec<u8>> {
        self.0.lookup(request)
    }
    fn history(&self, request: &[u8]) -> f2z_kt_client::Result<Vec<u8>> {
        self.0.history(request)
    }
    fn authority_policy(&self) -> f2z_kt_client::Result<Vec<u8>> {
        self.0.authority_policy()
    }
    fn descriptor(&self) -> f2z_kt_client::Result<Vec<u8>> {
        self.0.descriptor()
    }
}

/// The witness's own transport. It is `f2z-witness`'s trait, not the client's.
struct WitnessTransport(Arc<DirectTransport>);

impl f2z_witness::Transport for WitnessTransport {
    fn latest_sth(&self) -> f2z_witness::Result<Vec<u8>> {
        let bundle = self
            .0
            .runtime
            .block_on(self.0.log.latest_bundle())
            .map_err(|error| f2z_witness::WitnessError::Transport(error.to_string()))?;
        Ok(bundle.encode_canonical().unwrap())
    }

    fn audit(&self, from: u64, to: u64) -> f2z_witness::Result<Vec<u8>> {
        let response = self
            .0
            .runtime
            .block_on(self.0.log.audit(from, to))
            .map_err(|error| f2z_witness::WitnessError::Transport(error.to_string()))?;
        Ok(response.encode_canonical().unwrap())
    }

    fn cosign(&self, cosignature: &[u8]) -> f2z_witness::Result<()> {
        let decoded = f2z_codec::decode_canonical::<f2z_kt_core::WitnessCosignature>(cosignature)
            .map_err(|error| f2z_witness::WitnessError::Transport(error.to_string()))?
            .into_value();
        self.0
            .runtime
            .block_on(self.0.log.accept_cosignature(&decoded))
            .map_err(|error| f2z_witness::WitnessError::Transport(error.to_string()))
    }
}

// ---------------------------------------------------------------------------
// The fixture.
// ---------------------------------------------------------------------------

/// A whole deployment: a log, a witness that cosigns it, a client configured
/// with that witness, and the socket between them.
struct Deployment {
    setup: tokio::runtime::Runtime,
    harness: Harness,
    transport: Arc<DirectTransport>,
    witness: Witness,
}

impl Deployment {
    fn new(name: &str) -> Self {
        let setup = tokio::runtime::Runtime::new().unwrap();
        let harness = setup.block_on(Harness::vouched_with_witnesses(
            name,
            vec![Key::from_byte(WITNESS_SEED).public],
        ));
        setup.block_on(harness.log.publish_epoch(NOW)).unwrap();

        let transport = Arc::new(DirectTransport::new(Arc::clone(&harness.log)));
        let dir = f2z_kt::testing::temp_dir(&format!("{name}-w"));
        let witness = Witness::new(
            Settings {
                log_id: harness.log_id,
                accepted_log_pk: harness.log.log_public_key(),
                state_path: dir.join("state.bin"),
                evidence_dir: dir.join("evidence"),
                max_audit_span: 64,
            },
            &[WITNESS_SEED; 32],
            Box::new(WitnessTransport(Arc::clone(&transport))),
        )
        .unwrap();

        Self {
            setup,
            harness,
            transport,
            witness,
        }
    }

    /// Register a handle at a fresh identity and publish the epoch carrying it.
    fn register(&self, handle: &str, seed: u8) -> DirectoryEntry {
        let identity = Identity::from_byte(seed);
        let entry = EntryBuilder::first(self.harness.log_id, handle, &identity)
            .device(seed.wrapping_add(0x40), &identity.isk)
            .endpoint(seed)
            .same_key(&identity.dak);
        self.setup.block_on(async {
            self.harness
                .log
                .submit(&self.harness.envelope(&entry, &identity, NOW), NOW)
                .await
                .unwrap();
            self.harness.log.publish_epoch(NOW).await.unwrap();
        });
        entry
    }

    /// Rotate a handle to a new identity key — ADR 0014 case 2, a `key_change`
    /// authorized by both the outgoing and incoming identity keys.
    ///
    /// This is what an attacker who has compromised the log **cannot** do
    /// without the old key, and what a user who rotates legitimately does. From
    /// the victim's client the two are indistinguishable, which is precisely
    /// why §8.2 requires the alarm rather than a silent update.
    fn rotate(
        &self,
        handle: &str,
        old_seed: u8,
        new_seed: u8,
        previous: &DirectoryEntry,
    ) -> DirectoryEntry {
        let old = Identity::from_byte(old_seed);
        let new = Identity::from_byte(new_seed);
        let prev_hash = labels::prev_entry_hash(&previous.encode_canonical().unwrap());
        let entry = EntryBuilder::first(self.harness.log_id, handle, &new)
            .version(previous.entry.entry_version + 1)
            .kind(EntryKind::KeyChange)
            .identity_pk(new.isk.public)
            .directory_auth_pk(new.dak.public)
            .prev_entry_hash(prev_hash)
            .device(new_seed.wrapping_add(0x40), &new.isk)
            .endpoint(new_seed)
            .key_change(&old.isk, old.isk.public, &new.dak);
        self.setup.block_on(async {
            self.harness
                .log
                .submit(&self.harness.envelope(&entry, &new, NOW), NOW)
                .await
                .unwrap();
            self.harness.log.publish_epoch(NOW).await.unwrap();
        });
        entry
    }

    /// Bring the witness up to the log's head, so the client has a cosigned
    /// root to stand on.
    fn cosign(&mut self, now_ms: u64) {
        match self.witness.poll_once(now_ms).unwrap() {
            Outcome::Pinned { .. } | Outcome::Cosigned { .. } | Outcome::UpToDate { .. } => {}
            other => panic!("the witness refused to cosign an honest log: {other:?}"),
        }
    }

    fn witness_pk(&self) -> PublicKey {
        self.witness.public_key()
    }

    /// A client that counts this deployment's witness, with `t = 1`.
    ///
    /// [`ConfiguredWitness::dependent`], not `independent`: free2z operates the
    /// log **and** this witness, and §8.3 is explicit that a set with no
    /// outside members carries **zero** anti-equivocation value however many
    /// members it has. Asserting independence here would make every test in
    /// this file a test of a property the deployment does not have.
    fn client(&self, threshold: usize) -> KtClient<TransportHandle> {
        let witnesses = WitnessSet::new(
            vec![ConfiguredWitness::dependent(self.witness_pk())],
            threshold,
        )
        .unwrap();
        KtClient::bootstrap(
            TransportHandle(Arc::clone(&self.transport)),
            ClientConfig {
                log_id: self.harness.log_id,
                accepted_log_pk: self.harness.log.log_public_key(),
                witnesses,
                reset_authority_pk: self.harness.reset_authority.public,
                reset_cooldown_seconds: 60,
            },
        )
        .unwrap()
    }
}

fn handle(name: &str) -> Handle {
    Handle::new(name.as_bytes().to_vec()).unwrap()
}

// ---------------------------------------------------------------------------
// 1. The happy path — and it is the whole product.
// ---------------------------------------------------------------------------

#[test]
fn a_valid_lookup_verifies_against_a_witness_cosigned_root_and_pins() {
    let mut deployment = Deployment::new("client-happy");
    deployment.cosign(NOW);
    deployment.register("alice", 1);
    deployment.cosign(NOW + 1);

    let mut client = deployment.client(1);
    let resolution = client.resolve(&handle("alice"), NOW + 2).unwrap();

    let resolved = resolution.resolved().expect("alice is registered");
    assert_eq!(resolved.handle().as_slice(), b"alice");
    assert_eq!(resolved.entry_version(), 1);
    assert_eq!(resolved.pin(), PinOutcome::Established);

    // §8.3's threshold was met over the client's OWN set...
    assert!(resolved.standing().threshold_met());
    assert_eq!(resolved.standing().counted_including_dependent(), 1);
    // ...and the number a UI is allowed to show is still zero, because free2z
    // operates the log and this witness both. That is the deployment's honest
    // state and the type refuses to dress it up.
    assert_eq!(resolved.standing().independent(), 0);
    assert!(!resolved.standing().is_independently_witnessed());

    // §8.1 step 6, told the truth: a first entry establishes inclusion and not
    // entitlement, because §4.5's assertion is not committed to the tree.
    assert_eq!(
        resolved.authorization(),
        f2z_kt_client::Authorization::FirstEntryUnverifiable
    );

    // Step 8: the pin is held, and it is the key the peer published.
    let pin = client.pins().get(&handle("alice")).unwrap();
    assert_eq!(pin.entry_version(), 1);
    assert_eq!(pin.identity_pk(), resolved.identity_pk());

    // A second lookup of the same entry is idempotent and does not re-pin.
    let again = client.resolve(&handle("alice"), NOW + 3).unwrap();
    assert_eq!(again.resolved().unwrap().pin(), PinOutcome::Unchanged);
    assert!(!client.alarms().has_outstanding_critical());
}

#[test]
fn two_handle_lookups_accept_the_same_complete_head_as_a_no_op() {
    let mut deployment = Deployment::new("client-same-head-two-handles");
    deployment.cosign(NOW);
    deployment.register("alice", 1);
    deployment.register("bob", 2);
    deployment.cosign(NOW + 1);

    let mut client = deployment.client(1);
    let epoch = client.view().epoch();
    let alice = client.resolve(&handle("alice"), NOW + 2).unwrap();
    assert_eq!(alice.resolved().unwrap().handle().as_slice(), b"alice");
    assert_eq!(client.view().epoch(), epoch);

    // The real log serves the same latest SignedTreeHead with this other
    // handle's proof. The repeat is a no-op at the log view while the proof and
    // per-handle pin remain independently verified.
    let bob = client.resolve(&handle("bob"), NOW + 3).unwrap();
    assert_eq!(bob.resolved().unwrap().handle().as_slice(), b"bob");
    assert_eq!(client.view().epoch(), epoch);
    assert!(client.pins().get(&handle("alice")).is_some());
    assert!(client.pins().get(&handle("bob")).is_some());
}

#[test]
fn lookup_selects_only_unrevoked_credentials_inside_the_shared_window() {
    let mut deployment = Deployment::new("client-active-devices");
    let identity = Identity::from_byte(1);
    let skew = f2z_kt_core::entry::DEVICE_CREDENTIAL_CLOCK_SKEW_MS;
    let active = Key::from_byte(0x20).public;
    let future = Key::from_byte(0x21).public;
    let expired = Key::from_byte(0x22).public;
    let revoked = Key::from_byte(0x23).public;
    let entry = EntryBuilder::first(deployment.harness.log_id, "alice", &identity)
        .device_window(0x20, &identity.isk, NOW - 1, NOW + 1)
        .device_window(0x21, &identity.isk, NOW + skew + 1, NOW + skew + 2)
        .device_window(0x22, &identity.isk, NOW - skew - 2, NOW - skew - 1)
        .device_window(0x23, &identity.isk, NOW - 1, NOW + 1)
        .revocation(revoked, NOW, b"lost")
        .same_key(&identity.dak);
    deployment.setup.block_on(async {
        deployment
            .harness
            .log
            .submit(&deployment.harness.envelope(&entry, &identity, NOW), NOW)
            .await
            .unwrap();
        deployment.harness.log.publish_epoch(NOW).await.unwrap();
    });
    deployment.cosign(NOW + 1);

    let mut client = deployment.client(1);
    let resolution = client.resolve(&handle("alice"), NOW).unwrap();
    let resolved = resolution.resolved().unwrap();
    let selected: Vec<_> = resolved
        .active_devices_at(NOW)
        .map(|credential| credential.credential.device_pk)
        .collect();
    assert_eq!(selected, vec![active]);
    assert!(resolved.active_device_at(&active, NOW).is_some());
    assert!(resolved.active_device_at(&future, NOW).is_none());
    assert!(resolved.active_device_at(&expired, NOW).is_none());
    assert!(resolved.active_device_at(&revoked, NOW).is_none());
}

// ---------------------------------------------------------------------------
// 2. A tampered proof.
// ---------------------------------------------------------------------------

#[test]
fn a_tampered_inclusion_proof_is_refused_and_nothing_is_pinned() {
    let mut deployment = Deployment::new("client-tamper");
    deployment.cosign(NOW);
    deployment.register("alice", 1);
    deployment.cosign(NOW + 1);

    let mut client = deployment.client(1);
    deployment.transport.tamper_next_proof();

    let error = client.resolve(&handle("alice"), NOW + 2).unwrap_err();
    assert!(
        matches!(
            error,
            ClientError::Protocol(f2z_kt_core::KtError::ProofInvalid)
                | ClientError::Protocol(f2z_kt_core::KtError::Malformed)
        ),
        "got {error:?}"
    );
    assert!(
        client.pins().get(&handle("alice")).is_none(),
        "a refused lookup must not leave a pin behind"
    );
}

#[test]
fn an_entry_swapped_for_another_handles_is_refused() {
    // The substitution attack in its purest form: a real, valid, in-tree entry
    // for `@mallory` served as the answer to a question about `@alice`. The
    // proof is untouched and the entry is genuine; the only thing wrong is that
    // it does not answer the question that was asked.
    let mut deployment = Deployment::new("client-swap");
    deployment.cosign(NOW);
    deployment.register("alice", 1);
    let mallory = deployment.register("mallory", 2);
    deployment.cosign(NOW + 1);

    let mut client = deployment.client(1);
    deployment
        .transport
        .serve_entry(Some(mallory.encode_canonical().unwrap()));

    let error = client.resolve(&handle("alice"), NOW + 2).unwrap_err();
    assert_eq!(
        error,
        ClientError::Protocol(f2z_kt_core::KtError::BadHandle),
        "got {error:?}"
    );
    assert!(client.pins().get(&handle("alice")).is_none());
}

// ---------------------------------------------------------------------------
// 3. Absence, unproved.
// ---------------------------------------------------------------------------

#[test]
fn an_unregistered_handle_is_an_answer_and_it_is_labelled_unproved() {
    let mut deployment = Deployment::new("client-absent");
    deployment.cosign(NOW);
    deployment.register("alice", 1);
    deployment.cosign(NOW + 1);

    let mut client = deployment.client(1);
    let resolution = client.resolve(&handle("nobody"), NOW + 2).unwrap();

    // It is an answer, not an error: §9.5 has no unknown-handle code, and
    // routing this into an error path would hide which of the two answers the
    // log gave.
    let Resolution::AbsentUnproved(answer) = resolution else {
        panic!("an unregistered handle must not resolve");
    };
    assert_eq!(answer.handle().as_slice(), b"nobody");
    // And there is no accessor here that reports a proof, because `akd` 0.13
    // cannot produce one. The variant's name is the whole disclosure.
    assert!(answer.standing().threshold_met());
    assert!(client.pins().get(&handle("nobody")).is_none());
}

#[test]
fn an_absent_discriminant_cannot_smuggle_a_populated_proof_to_the_client() {
    let mut deployment = Deployment::new("client-absent-with-proof");
    deployment.cosign(NOW);
    deployment.register("alice", 1);
    deployment.cosign(NOW + 1);

    // Start from f2z-kt's real present response, then make only the two edits a
    // dishonest server needs for §9.2's malformed shape: claim absence and
    // hide the entry while retaining the genuine populated proof.
    deployment.transport.assert_absent_but_retain_proof();
    let mut client = deployment.client(1);
    let error = client.resolve(&handle("alice"), NOW + 2).unwrap_err();
    assert_eq!(
        error,
        ClientError::Protocol(f2z_kt_core::KtError::Malformed)
    );
    assert!(
        client.pins().get(&handle("alice")).is_none(),
        "a malformed absent response must not establish or weaken a pin"
    );
}

#[test]
fn a_pinned_handle_asserted_absent_fails_closed_keeps_the_pin_and_alarms() {
    let mut deployment = Deployment::new("client-absent-pinned");
    deployment.cosign(NOW);
    deployment.register("alice", 1);
    deployment.cosign(NOW + 1);

    let mut client = deployment.client(1);
    let pinned_key = *client
        .resolve(&handle("alice"), NOW + 2)
        .unwrap()
        .resolved()
        .unwrap()
        .identity_pk();

    // Now the log denies that `@alice` exists at all — the downgrade against
    // discovery that §8.1's correction is about.
    deployment.transport.assert_absent(true);
    let error = client.resolve(&handle("alice"), NOW + 3).unwrap_err();
    assert_eq!(error, ClientError::PinContradiction);

    // The pin stands. Silently dropping it would complete the attack.
    let pin = client.pins().get(&handle("alice")).unwrap();
    assert_eq!(pin.identity_pk(), &pinned_key);

    // The alarm is raised, is critical, is non-dismissible — and says plainly
    // that it is NOT evidence anyone can be shown, because the log signs tree
    // heads and not lookup responses.
    let alarm = client
        .alarms()
        .alarms()
        .iter()
        .find(|alarm| alarm.kind() == AlarmKind::HandleAbsentContradictsPin)
        .expect("a contradicted pin must alarm");
    assert!(!alarm.dismissible());
    assert!(!alarm.is_provable_to_a_third_party());
    assert!(!error.is_fork_evidence());
    assert!(client.alarms().has_outstanding_critical());
}

// ---------------------------------------------------------------------------
// 4. The threshold, and failing closed.
// ---------------------------------------------------------------------------

#[test]
fn a_root_with_too_few_cosignatures_is_refused() {
    let mut deployment = Deployment::new("client-threshold");
    deployment.cosign(NOW);
    deployment.register("alice", 1);
    deployment.cosign(NOW + 1);

    // The log withholds the cosignature it holds — §7.5's conflict of interest,
    // where the party under audit distributes the evidence used to audit it and
    // can simply appear to have fewer witnesses this epoch.
    let mut client = deployment.client(1);
    deployment.transport.withhold_cosignatures(true);

    let error = client.resolve(&handle("alice"), NOW + 2).unwrap_err();
    assert_eq!(error, ClientError::WitnessThresholdUnmet);
    assert!(!error.is_transient(), "this is a refusal, not a retry");
    assert!(client.pins().get(&handle("alice")).is_none());

    // The refusal is surfaced rather than swallowed.
    assert!(
        client
            .alarms()
            .alarms()
            .iter()
            .any(|alarm| alarm.kind() == AlarmKind::WitnessThresholdUnmet)
    );

    // The cosignature comes back and the same lookup now succeeds, which is
    // what proves the refusal was about the threshold and not about the proof.
    deployment.transport.withhold_cosignatures(false);
    assert!(
        client
            .resolve(&handle("alice"), NOW + 3)
            .unwrap()
            .resolved()
            .is_some()
    );
}

#[test]
fn a_threshold_larger_than_the_cosignatures_available_is_refused() {
    // The other half: the log is honest and serves everything it has, and the
    // client's own `t` is simply higher than one witness can meet. §8.3 counts
    // over the client's OWN set, so this must refuse exactly as hard.
    let mut deployment = Deployment::new("client-threshold-two");
    deployment.cosign(NOW);
    deployment.register("alice", 1);
    deployment.cosign(NOW + 1);

    let witnesses = WitnessSet::new(
        vec![
            ConfiguredWitness::dependent(deployment.witness_pk()),
            // A second witness the client configured and that is not running.
            ConfiguredWitness::independent(PublicKey::new([0x5e; 32])),
        ],
        2,
    )
    .unwrap();
    let mut client = KtClient::bootstrap(
        TransportHandle(Arc::clone(&deployment.transport)),
        ClientConfig {
            log_id: deployment.harness.log_id,
            accepted_log_pk: deployment.harness.log.log_public_key(),
            witnesses,
            reset_authority_pk: deployment.harness.reset_authority.public,
            reset_cooldown_seconds: 60,
        },
    )
    .unwrap();

    assert_eq!(
        client.resolve(&handle("alice"), NOW + 2).unwrap_err(),
        ClientError::WitnessThresholdUnmet
    );
}

// ---------------------------------------------------------------------------
// 5. A key change the user did not initiate.
// ---------------------------------------------------------------------------

#[test]
fn a_key_change_the_user_did_not_initiate_raises_the_alarm_in_self_audit() {
    let mut deployment = Deployment::new("client-selfaudit");
    deployment.cosign(NOW);
    let first = deployment.register("alice", 1);
    deployment.cosign(NOW + 1);

    let mut client = deployment.client(1);
    client.resolve(&handle("alice"), NOW + 2).unwrap();

    // What this device submitted: exactly the first entry.
    let submitted = vec![labels::prev_entry_hash(&first.encode_canonical().unwrap())];

    // A clean audit finds nothing.
    let clean = client
        .self_audit(&handle("alice"), &submitted, NOW + 3)
        .unwrap();
    assert!(clean.is_clean());
    assert!(clean.root_witnessed());
    assert!(clean.chain_intact());
    assert_eq!(clean.versions_seen(), 1);

    // Now somebody rotates `@alice`'s identity key. From this device's seat it
    // is an entry it never submitted, which is exactly the substitution §8.2
    // exists to make visible to its victim.
    deployment.rotate("alice", 1, 9, &first);
    deployment.cosign(NOW + 4);

    let dirty = client
        .self_audit(&handle("alice"), &submitted, NOW + 5)
        .unwrap();
    assert!(!dirty.is_clean());
    assert!(dirty.root_witnessed());
    // The chain is intact — the log did not lie about the chain, it published a
    // real rotation. The finding is the *unexpected entry*, and conflating the
    // two would report a fork where there is a key change.
    assert!(dirty.chain_intact());
    assert_eq!(dirty.versions_seen(), 2);
    assert_eq!(dirty.unexpected().len(), 1);
    assert_eq!(dirty.unexpected()[0].entry_version(), 2);

    let alarm = &dirty.alarms()[0];
    assert_eq!(alarm.kind(), AlarmKind::SelfAuditUnexpectedEntry);
    assert!(!alarm.dismissible());
    // §8.2 step 5: both fingerprints are named.
    assert!(alarm.old_fingerprint().is_some());
    assert!(alarm.new_fingerprint().is_some());
    assert_ne!(alarm.old_fingerprint(), alarm.new_fingerprint());
    assert!(client.alarms().has_outstanding_critical());
}

#[test]
fn a_key_change_seen_through_a_lookup_does_not_move_the_pin() {
    let mut deployment = Deployment::new("client-keychange-lookup");
    deployment.cosign(NOW);
    let first = deployment.register("alice", 1);
    deployment.cosign(NOW + 1);

    let mut client = deployment.client(1);
    let original = *client
        .resolve(&handle("alice"), NOW + 2)
        .unwrap()
        .resolved()
        .unwrap()
        .identity_pk();

    deployment.rotate("alice", 1, 9, &first);
    deployment.cosign(NOW + 3);

    let error = client.resolve(&handle("alice"), NOW + 4).unwrap_err();
    assert_eq!(error, ClientError::PinConflict);
    assert_eq!(
        client.pins().get(&handle("alice")).unwrap().identity_pk(),
        &original,
        "the old pin stays in force until the change is accepted deliberately"
    );
    assert!(
        client
            .alarms()
            .alarms()
            .iter()
            .any(|alarm| alarm.kind() == AlarmKind::IdentityKeyChanged)
    );

    // Accepting it is a separate, explicit call — and it verifies the whole
    // history from the pin, re-running §4.4 on the rotation.
    let advanced = client.accept_key_change(&handle("alice"), NOW + 5).unwrap();
    assert_eq!(advanced.entry_version(), 2);
    assert_ne!(advanced.identity_pk(), &original);
    assert_eq!(
        client.pins().get(&handle("alice")).unwrap().identity_pk(),
        advanced.identity_pk()
    );

    // And the lookup that failed now succeeds against the moved pin.
    let resolution = client.resolve(&handle("alice"), NOW + 6).unwrap();
    assert_eq!(resolution.resolved().unwrap().pin(), PinOutcome::Unchanged);
}

#[test]
fn a_key_change_is_refused_when_the_threshold_is_unmet() {
    // §8.3's table, second row: "Accepting a key change ... Refused, and
    // surfaced. The old pin stays in force."
    let mut deployment = Deployment::new("client-keychange-threshold");
    deployment.cosign(NOW);
    let first = deployment.register("alice", 1);
    deployment.cosign(NOW + 1);

    let mut client = deployment.client(1);
    let original = *client
        .resolve(&handle("alice"), NOW + 2)
        .unwrap()
        .resolved()
        .unwrap()
        .identity_pk();

    deployment.rotate("alice", 1, 9, &first);
    deployment.cosign(NOW + 3);
    deployment.transport.withhold_cosignatures(true);

    assert_eq!(
        client
            .accept_key_change(&handle("alice"), NOW + 4)
            .unwrap_err(),
        ClientError::WitnessThresholdUnmet
    );
    assert_eq!(
        client.pins().get(&handle("alice")).unwrap().identity_pk(),
        &original
    );
}

// ---------------------------------------------------------------------------
// 6. Self-audit continues when the root cannot be established.
// ---------------------------------------------------------------------------

#[test]
fn self_audit_continues_and_reports_under_an_unwitnessed_root() {
    // §8.3's table gives self-audit its own row — "continues, and reports" —
    // because "a substitution it can see is worth more than one it cannot".
    let mut deployment = Deployment::new("client-selfaudit-unwitnessed");
    deployment.cosign(NOW);
    let first = deployment.register("alice", 1);
    deployment.cosign(NOW + 1);

    let mut client = deployment.client(1);
    client.resolve(&handle("alice"), NOW + 2).unwrap();
    let submitted = vec![labels::prev_entry_hash(&first.encode_canonical().unwrap())];

    deployment.rotate("alice", 1, 9, &first);
    deployment.cosign(NOW + 3);
    deployment.transport.withhold_cosignatures(true);

    let report = client
        .self_audit(&handle("alice"), &submitted, NOW + 4)
        .unwrap();

    // It ran. It found the substitution. And it says which of the two checks it
    // was able to make, so nobody reports "history verified" on this.
    assert!(!report.root_witnessed());
    assert_eq!(report.standing().counted_including_dependent(), 0);
    assert!(report.chain_intact());
    assert_eq!(report.unexpected().len(), 1);
    assert_eq!(
        report.alarms()[0].kind(),
        AlarmKind::SelfAuditUnexpectedEntry
    );
}

// ---------------------------------------------------------------------------
// 6b. §8.2 step 4 — the truthful subset, and the chain that catches it.
//
// zuu#708. `key_history_verify` proves the versions it was shown are in the
// tree; it does not prove the client was shown **all** of them, and it does not
// look at `prev_entry_hash` at all. Step 4 is the only thing that does, and
// under §8.3's self-audit row — *continues, and reports* — it is the only check
// the client has left.
// ---------------------------------------------------------------------------

/// A history with one version omitted is refused, not audited.
///
/// The log serves nothing false here. Every entry it returns is real, signed
/// and published; it simply does not return one of them. That is the whole
/// truthful-subset attack: omit the entry that added the attacker's device and
/// the entry that removed it, and what remains is a history in which nothing is
/// wrong.
#[test]
fn a_history_with_a_version_omitted_is_refused_under_an_unwitnessed_root() {
    let mut deployment = Deployment::new("client-history-omission");
    deployment.cosign(NOW);
    let first = deployment.register("alice", 1);
    let second = deployment.rotate("alice", 1, 9, &first);
    let third = deployment.rotate("alice", 9, 10, &second);
    deployment.cosign(NOW + 1);

    let submitted: Vec<Digest> = [&first, &second, &third]
        .iter()
        .map(|entry| labels::prev_entry_hash(&entry.encode_canonical().unwrap()))
        .collect();

    let mut client = deployment.client(1);
    // §8.3's table: the threshold is unmet, so self-audit is reduced to step 4
    // alone. `key_history_verify` does not run, which is exactly the state this
    // check has to hold up in.
    deployment.transport.withhold_cosignatures(true);

    // The positive control, first: three versions, chain intact, nothing
    // unexpected. Without it the refusal below would prove only that this
    // deployment refuses everything.
    let clean = client
        .self_audit(&handle("alice"), &submitted, NOW + 2)
        .unwrap();
    assert!(!clean.root_witnessed());
    assert!(clean.chain_intact());
    assert_eq!(clean.versions_seen(), 3);
    assert_eq!(clean.unexpected().len(), 0);

    // Now the log drops the middle version from the response. Index 1 in
    // `akd`'s decreasing order is version 2.
    deployment.transport.omit_history_entry(Some(1));
    assert_eq!(
        client
            .self_audit(&handle("alice"), &submitted, NOW + 3)
            .unwrap_err(),
        ClientError::Protocol(KtError::HistoryIncomplete),
        "a version omitted from a history response is a truthful subset, and \
         the entry_version sequence is what makes it visible",
    );
}

/// A history whose `prev_entry_hash` chain does not link is refused — and the
/// version sequence alone would not have noticed.
///
/// This is the half of step 4 that nothing else in the system covers.
/// `key_history_verify` proves inclusion and, under `HistoryParams::Complete`,
/// version contiguity; **it never reads `prev_entry_hash`.** A log that answers
/// with contiguous versions whose contents do not chain has substituted one of
/// them, and only the hash walk says so.
#[test]
fn a_history_whose_prev_entry_hash_chain_does_not_link_is_refused() {
    let mut deployment = Deployment::new("client-history-chainbreak");
    deployment.cosign(NOW);
    let first = deployment.register("alice", 1);
    let second = deployment.rotate("alice", 1, 9, &first);
    let third = deployment.rotate("alice", 9, 10, &second);
    deployment.cosign(NOW + 1);

    let submitted: Vec<Digest> = [&first, &second, &third]
        .iter()
        .map(|entry| labels::prev_entry_hash(&entry.encode_canonical().unwrap()))
        .collect();

    // A substituted version 2. Well-formed in every way a decoder can see: the
    // right log, the right handle, version 2, a non-zero `prev_entry_hash` (§4.2
    // requires exactly that of a non-genesis entry), a valid self-signature. The
    // only thing wrong with it is that its predecessor hash is not version 1's.
    let impostor = Identity::from_byte(0x71);
    let substituted = EntryBuilder::first(deployment.harness.log_id, "alice", &impostor)
        .version(2)
        .prev_entry_hash(Digest::new([0x5a; 32]))
        .device(0x72, &impostor.isk)
        .endpoint(0x73)
        .same_key(&impostor.dak);
    let substituted = substituted.encode_canonical().unwrap();

    let mut client = deployment.client(1);
    deployment
        .transport
        .swap_history_entry(Some((1, substituted.clone())));

    // Under a **witnessed** root the substitution never reaches step 4: the
    // value the proof commits to is recomputed from the served bytes, so these
    // bytes are not the ones the tree holds. Asserted so the test below cannot
    // be mistaken for the only thing standing here.
    assert_eq!(
        client
            .self_audit(&handle("alice"), &submitted, NOW + 2)
            .unwrap_err(),
        ClientError::Protocol(KtError::ValueMismatch),
    );

    // Under an unwitnessed root there is no proof and no commitment to compare
    // against. §8.3 says the client keeps auditing anyway, and step 4 is what it
    // has: contiguous versions, a chain that does not link.
    deployment.transport.withhold_cosignatures(true);
    assert_eq!(
        client
            .self_audit(&handle("alice"), &submitted, NOW + 3)
            .unwrap_err(),
        ClientError::Protocol(KtError::HistoryIncomplete),
        "version contiguity holds here; only the prev_entry_hash walk catches it",
    );

    // And the control on the same client and the same log: served honestly, the
    // very same audit passes.
    deployment.transport.swap_history_entry(None);
    let clean = client
        .self_audit(&handle("alice"), &submitted, NOW + 4)
        .unwrap();
    assert!(clean.chain_intact());
    assert_eq!(clean.versions_seen(), 3);
}

/// A history that chains by hash and skips a version is refused.
///
/// §8.2 step 4 is two checks — *"an unbroken `entry_version` sequence **and** an
/// unbroken `prev_entry_hash` chain"* — and this is the one case only the first
/// catches: the served entry really does chain to version 1, and calls itself
/// version 5. Without it the version half could be deleted and the hash half
/// would cover every other case in this file.
#[test]
fn a_history_that_chains_by_hash_but_renumbers_a_version_is_refused() {
    let mut deployment = Deployment::new("client-history-versionjump");
    deployment.cosign(NOW);
    let first = deployment.register("alice", 1);
    let second = deployment.rotate("alice", 1, 9, &first);
    deployment.cosign(NOW + 1);

    let submitted: Vec<Digest> = [&first, &second]
        .iter()
        .map(|entry| labels::prev_entry_hash(&entry.encode_canonical().unwrap()))
        .collect();

    let impostor = Identity::from_byte(0x74);
    let renumbered = EntryBuilder::first(deployment.harness.log_id, "alice", &impostor)
        .version(5)
        .prev_entry_hash(labels::prev_entry_hash(&first.encode_canonical().unwrap()))
        .device(0x75, &impostor.isk)
        .endpoint(0x76)
        .same_key(&impostor.dak);

    let mut client = deployment.client(1);
    deployment.transport.withhold_cosignatures(true);
    deployment
        .transport
        .swap_history_entry(Some((0, renumbered.encode_canonical().unwrap())));

    assert_eq!(
        client
            .self_audit(&handle("alice"), &submitted, NOW + 2)
            .unwrap_err(),
        ClientError::Protocol(KtError::HistoryIncomplete),
        "the prev_entry_hash walk is satisfied here; the version sequence is not",
    );

    deployment.transport.swap_history_entry(None);
    let clean = client
        .self_audit(&handle("alice"), &submitted, NOW + 3)
        .unwrap();
    assert_eq!(clean.versions_seen(), 2);
}

// ---------------------------------------------------------------------------
// 7. §8.1 step 7.
// ---------------------------------------------------------------------------

#[test]
fn a_policy_that_cannot_be_fetched_leaves_vouching_unknown() {
    let mut deployment = Deployment::new("client-policy");
    deployment.cosign(NOW);
    deployment.register("alice", 1);
    deployment.cosign(NOW + 1);

    let mut client = deployment.client(1);
    assert_eq!(client.vouching(), f2z_kt_client::Vouching::Unknown);
    assert!(client.refresh_authority_policy().is_err());
    assert_eq!(
        client.vouching(),
        f2z_kt_client::Vouching::Unknown,
        "an unanswered question about who may claim a handle is not a reassuring answer"
    );
    assert!(!client.vouching().permits_attested_language());

    // And the resolution carries that state rather than omitting it.
    let resolution = client.resolve(&handle("alice"), NOW + 2).unwrap();
    assert_eq!(
        resolution.resolved().unwrap().vouching(),
        f2z_kt_client::Vouching::Unknown
    );
}

// ---------------------------------------------------------------------------
// 8. A device added under the same key — the ordinary case that must NOT alarm.
// ---------------------------------------------------------------------------

#[test]
fn a_same_key_update_advances_the_pin_with_no_alarm() {
    // A check that cries wolf on correct behaviour gets silenced, and then it
    // protects nothing. This is the negative control for every alarm above.
    let mut deployment = Deployment::new("client-samekey");
    deployment.cosign(NOW);
    let first = deployment.register("alice", 1);
    deployment.cosign(NOW + 1);

    let mut client = deployment.client(1);
    client.resolve(&handle("alice"), NOW + 2).unwrap();

    // `@alice` adds a second device. Same identity key, `entry_version` 2,
    // chaining to the first entry, authorized under §4.4's `same_key` rule.
    let identity = Identity::from_byte(1);
    let prev_hash = labels::prev_entry_hash(&first.encode_canonical().unwrap());
    let second = EntryBuilder::first(deployment.harness.log_id, "alice", &identity)
        .version(2)
        .prev_entry_hash(prev_hash)
        .device(0x41, &identity.isk)
        .device(0x42, &identity.isk)
        .endpoint(1)
        .same_key(&identity.dak);
    deployment.setup.block_on(async {
        deployment
            .harness
            .log
            .submit(&deployment.harness.envelope(&second, &identity, NOW), NOW)
            .await
            .unwrap();
        deployment.harness.log.publish_epoch(NOW).await.unwrap();
    });
    deployment.cosign(NOW + 3);

    let resolution = client.resolve(&handle("alice"), NOW + 4).unwrap();
    let resolved = resolution.resolved().unwrap();
    assert_eq!(resolved.entry_version(), 2);
    assert_eq!(resolved.pin(), PinOutcome::Advanced);
    // §8.1 step 6 ran for real this time: the client held the predecessor, so
    // §4.4 was re-applied by the same function the log applies.
    assert_eq!(
        resolved.authorization(),
        f2z_kt_client::Authorization::CheckedAgainstPredecessor
    );
    assert_eq!(
        client.pins().get(&handle("alice")).unwrap().entry_version(),
        2
    );
    assert!(
        !client.alarms().has_outstanding_critical(),
        "an authorized same-key update must not alarm: {:?}",
        client.alarms().alarms()
    );
}

// ---------------------------------------------------------------------------
// 9. The handle never reaches a URL.
// ---------------------------------------------------------------------------

#[test]
fn no_handle_is_ever_placed_in_a_path() {
    // §9.2's reason for making these two endpoints POST. Asserted against the
    // shipped constants rather than against a comment.
    for path in [
        f2z_kt_client::PATH_LOOKUP,
        f2z_kt_client::PATH_HISTORY,
        f2z_kt_client::PATH_STH,
        f2z_kt_client::PATH_AUTHORITY,
        f2z_kt_client::PATH_DESCRIPTOR,
    ] {
        assert!(!path.contains('?'), "{path} carries a query string");
        assert!(!path.contains('{'), "{path} carries a path parameter");
    }
    assert_eq!(
        Digest::LEN,
        32,
        "a sanity anchor so this file's imports stay live"
    );
}
