//! **Enrollment's submission, end to end, against a real log and a real
//! witness** (ADR 0017).
//!
//! Every value that ZUULI would produce is produced here the way ZUULI produces
//! it: the account keys come from a seed through
//! `f2z_msg_identity::AccountKeys::from_seed`, the device credential is issued
//! by that account's identity key, the directory entry and the identity binding
//! are signed by `AccountKeys::sign_directory_submission`, and the bytes cross
//! `f2z_kt_client::submit` — the same function the app calls. The handle
//! assertion is issued by `f2z_authority::HandleAssertionTBS::sign`, which is
//! what the backend's issuer must match byte for byte (Contract C).
//!
//! The log is `f2z_kt::LogService` behind its real admission path, so every
//! refusal below is the refusal a deployed log gives.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::sync::Arc;

use f2z_authority::{AssertionNonce, HandleAssertionTBS, Intent, SigningKey};
use f2z_codec::Canonical as _;
use f2z_codec::types::{PublicKey, QueueAddress, RelayId, ShortBytes};
use f2z_kt::LogService;
use f2z_kt::testing::{Harness, Key};
use f2z_kt_client::{
    ClientConfig, ClientError, Expected, KtClient, SubmitTransport, Transport, submit,
};
use f2z_kt_core::entry::{ContactEndpoint, DirectoryEntry};
use f2z_kt_core::types::{Handle, KemPublicKey};
use f2z_kt_core::{ConfiguredWitness, ErrorCode, WitnessSet};
use f2z_msg_identity::{AccountKeys, DeviceCredentialRequest, SubmissionDraft};
use f2z_witness::witness::{Outcome, Settings, Witness};

const NOW: u64 = 1_700_000_100_000;
const WITNESS_SEED: u8 = 0xc3;
/// `f2z_kt::testing::Harness`'s configured authority.
const AUTHORITY_SEED: [u8; 32] = [0xa3; 32];

struct LogTransport {
    runtime: tokio::runtime::Runtime,
    log: Arc<LogService>,
}

impl LogTransport {
    fn bundle(&self, epoch: Option<u64>) -> f2z_kt_client::Result<Vec<u8>> {
        let bundle = match epoch {
            None => self.runtime.block_on(self.log.latest_bundle()),
            Some(epoch) => self.runtime.block_on(self.log.bundle_at(epoch)),
        }
        .map_err(|error| ClientError::Unreachable(error.to_string()))?;
        Ok(bundle.encode_canonical().unwrap())
    }
}

struct LogHandle(Arc<LogTransport>);

impl Transport for LogHandle {
    fn latest_sth(&self) -> f2z_kt_client::Result<Vec<u8>> {
        self.0.bundle(None)
    }

    fn sth_at(&self, epoch: u64) -> f2z_kt_client::Result<Vec<u8>> {
        self.0.bundle(Some(epoch))
    }

    fn lookup(&self, request: &[u8]) -> f2z_kt_client::Result<Vec<u8>> {
        let decoded =
            f2z_codec::decode_canonical::<f2z_kt_core::api::LookupRequest>(request)?.into_value();
        let response = self
            .0
            .runtime
            .block_on(self.0.log.lookup(&decoded.handle))
            .map_err(|error| ClientError::Unreachable(error.to_string()))?;
        Ok(response.encode_canonical().unwrap())
    }

    fn history(&self, _request: &[u8]) -> f2z_kt_client::Result<Vec<u8>> {
        Err(ClientError::Unreachable("not served here".to_owned()))
    }

    fn authority_policy(&self) -> f2z_kt_client::Result<Vec<u8>> {
        Err(ClientError::Unreachable("not served here".to_owned()))
    }

    fn descriptor(&self) -> f2z_kt_client::Result<Vec<u8>> {
        Err(ClientError::Unreachable("not served here".to_owned()))
    }
}

/// `POST /kt/v1/submit`, answered the way `f2z-kt`'s handler answers it: a
/// canonical receipt, or the §9.5 code of the refusal.
impl SubmitTransport for LogHandle {
    fn submit(&self, envelope: &[u8]) -> f2z_kt_client::Result<Vec<u8>> {
        self.0
            .runtime
            .block_on(self.0.log.submit(envelope, NOW))
            .map(|receipt| receipt.encode_canonical().unwrap())
            .map_err(|error| ClientError::Refused(error.wire_code()))
    }
}

struct WitnessTransport(Arc<LogTransport>);

impl f2z_witness::Transport for WitnessTransport {
    fn latest_sth(&self) -> f2z_witness::Result<Vec<u8>> {
        self.0
            .bundle(None)
            .map_err(|error| f2z_witness::WitnessError::Transport(error.to_string()))
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

/// The disposable internal deployment: one log, one witness free2z also runs,
/// `t = 1`, and one handle authority.
struct Internal {
    harness: Harness,
    transport: Arc<LogTransport>,
    witness: Witness,
}

impl Internal {
    fn new(name: &str) -> Self {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let harness = runtime.block_on(Harness::vouched_with_witnesses(
            name,
            vec![Key::from_byte(WITNESS_SEED).public],
        ));
        runtime.block_on(harness.log.publish_epoch(NOW)).unwrap();
        let transport = Arc::new(LogTransport {
            runtime,
            log: Arc::clone(&harness.log),
        });
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
            harness,
            transport,
            witness,
        }
    }

    fn handle(&self) -> LogHandle {
        LogHandle(Arc::clone(&self.transport))
    }

    fn expected<'a>(
        &'a self,
        handle: &'a Handle,
        signed: &'a f2z_msg_identity::SignedSubmission,
        log_pk: &'a PublicKey,
    ) -> Expected<'a> {
        Expected {
            log_id: &self.harness.log_id,
            log_pk,
            handle,
            entry_version: signed.entry_version(),
            entry_digest: &signed.entry_digest,
        }
    }

    fn publish_and_cosign(&mut self) {
        self.transport
            .runtime
            .block_on(self.harness.log.publish_epoch(NOW))
            .unwrap();
        match self.witness.poll_once(NOW).unwrap() {
            Outcome::Pinned { .. } | Outcome::Cosigned { .. } | Outcome::UpToDate { .. } => {}
            other => panic!("the witness refused an honest log: {other:?}"),
        }
    }

    /// A client configured exactly as ADR 0017's bundled file configures one:
    /// the one witness is **dependent**, and `t = 1`.
    fn client(&self) -> KtClient<LogHandle> {
        KtClient::bootstrap(
            self.handle(),
            ClientConfig {
                log_id: self.harness.log_id,
                accepted_log_pk: self.harness.log.log_public_key(),
                witnesses: WitnessSet::new(
                    vec![ConfiguredWitness::dependent(self.witness.public_key())],
                    1,
                )
                .unwrap(),
                reset_authority_pk: self.harness.reset_authority.public,
                reset_cooldown_seconds: 60,
            },
        )
        .unwrap()
    }
}

fn account() -> AccountKeys {
    AccountKeys::from_seed(&[0x42; 64], 0).unwrap()
}

fn alice() -> Handle {
    Handle::new(b"alice".to_vec()).unwrap()
}

fn draft<'a>(
    internal: &Internal,
    account: &AccountKeys,
    devices: &[u8],
    predecessor: Option<&'a DirectoryEntry>,
) -> SubmissionDraft<'a> {
    SubmissionDraft {
        log_id: internal.harness.log_id,
        handle: alice(),
        devices: devices
            .iter()
            .map(|seed| {
                account
                    .identity
                    .issue_device_credential(&DeviceCredentialRequest {
                        handle: alice(),
                        device_pk: PublicKey::new([*seed; 32]),
                        device_kem_pk: KemPublicKey::new(vec![0x5a; 16]).unwrap(),
                        not_before_ms: NOW - 3_600_000,
                        not_after_ms: NOW + 31_536_000_000,
                    })
                    .unwrap()
            })
            .collect(),
        revocations: Vec::new(),
        contact_endpoints: vec![ContactEndpoint {
            relay_url: ShortBytes::new(b"wss://relay.internal.example/relay/v1".to_vec()).unwrap(),
            relay_id: RelayId::new([0x77; 32]),
            contact_addr: QueueAddress::new([devices[0]; 32]),
        }],
        predecessor,
        created_at_ms: NOW,
    }
}

/// What the backend issues (Contract C), signed by `authority`.
fn assertion(internal: &Internal, account: &AccountKeys, authority: &SigningKey) -> Vec<u8> {
    HandleAssertionTBS::new(
        &authority.public_key(),
        f2z_authority::LogId::new(*internal.harness.log_id.as_bytes()),
        f2z_authority::Handle::parse(b"alice").unwrap(),
        account.identity.public(),
        Intent::Bind,
        0,
        NOW,
        NOW + 60_000,
        AssertionNonce::new([0x19; 16]),
    )
    .unwrap()
    .sign(authority)
    .unwrap()
    .encode_canonical()
    .unwrap()
}

#[test]
fn a_seed_signed_enrollment_is_admitted_merged_and_resolvable() {
    let mut internal = Internal::new("seed-submit-happy");
    let account = account();
    let handle = alice();
    let log_pk = internal.harness.log.log_public_key();

    let first = account
        .sign_directory_submission(
            &draft(&internal, &account, &[0x10], None),
            Some(&assertion(
                &internal,
                &account,
                &SigningKey::from_seed(&AUTHORITY_SEED),
            )),
        )
        .unwrap();
    let receipt = submit(
        &internal.handle(),
        &first.envelope,
        &internal.expected(&handle, &first, &log_pk),
    )
    .expect("the log admits a seed-signed first entry carrying a valid assertion");
    assert_eq!(receipt.receipt.entry_version, 1);

    internal.publish_and_cosign();
    let mut client = internal.client();
    let resolution = client.resolve(&handle, NOW).unwrap();
    let resolved = resolution.resolved().expect("merged and proved");
    assert_eq!(resolved.identity_pk(), &account.identity.public());
    assert_eq!(resolved.entry(), &first.entry);
    // ADR 0017's posture, observed: the threshold is met by a witness the log's
    // own operator runs, and the independent count stays zero.
    assert!(resolution.standing().threshold_met());
    assert_eq!(resolution.standing().independent(), 0);
    assert!(!resolution.standing().is_independently_witnessed());

    // A second device is a routine update: no assertion, chained to the first.
    let second = account
        .sign_directory_submission(
            &draft(&internal, &account, &[0x11, 0x10], Some(resolved.entry())),
            None,
        )
        .unwrap();
    submit(
        &internal.handle(),
        &second.envelope,
        &internal.expected(&handle, &second, &log_pk),
    )
    .expect("a routine update authorized by the published DirectoryAuthKey");
    internal.publish_and_cosign();
    let again = internal.client().resolve(&handle, NOW).unwrap();
    let merged = again.resolved().unwrap();
    assert_eq!(merged.entry_version(), 2);
    assert!(f2z_msg_identity::publishes_device(
        merged.entry(),
        &PublicKey::new([0x11; 32])
    ));
}

#[test]
fn an_assertion_from_an_unconfigured_authority_is_refused_by_the_log() {
    // Contract C's core rule: the log accepts a first entry only under the
    // authority key it was configured with. A perfectly formed assertion signed
    // by anybody else is not one.
    let internal = Internal::new("seed-submit-wrong-authority");
    let account = account();
    let handle = alice();
    let log_pk = internal.harness.log.log_public_key();

    let forged = account
        .sign_directory_submission(
            &draft(&internal, &account, &[0x10], None),
            Some(&assertion(
                &internal,
                &account,
                &SigningKey::from_seed(&[0x5e; 32]),
            )),
        )
        .unwrap();
    let refusal = submit(
        &internal.handle(),
        &forged.envelope,
        &internal.expected(&handle, &forged, &log_pk),
    )
    .unwrap_err();
    assert_eq!(
        refusal.to_string(),
        ClientError::Refused(ErrorCode::BadAuthorization).to_string()
    );
    assert_eq!(
        internal
            .transport
            .runtime
            .block_on(internal.harness.log.pending_count()),
        0,
        "a refused submission never reaches the pending batch"
    );
}

#[test]
fn an_assertion_for_another_identity_key_is_refused_by_the_log() {
    // The backend binds the handle to `identity_pk`; an assertion issued for a
    // different key cannot authorize this one, even under the right authority.
    let internal = Internal::new("seed-submit-other-identity");
    let account = account();
    let other = AccountKeys::from_seed(&[0x43; 64], 0).unwrap();
    let handle = alice();
    let log_pk = internal.harness.log.log_public_key();

    let signed = account
        .sign_directory_submission(
            &draft(&internal, &account, &[0x10], None),
            Some(&assertion(
                &internal,
                &other,
                &SigningKey::from_seed(&AUTHORITY_SEED),
            )),
        )
        .unwrap();
    assert_eq!(
        submit(
            &internal.handle(),
            &signed.envelope,
            &internal.expected(&handle, &signed, &log_pk),
        )
        .unwrap_err()
        .to_string(),
        ClientError::Refused(ErrorCode::BadAuthorization).to_string()
    );
}

// ---------------------------------------------------------------------------
// ADR 0017 §8: the disposable log is wiped. A client that restarts must not
// quietly accept the new history as the old one.
// ---------------------------------------------------------------------------

fn client_config(internal: &Internal) -> ClientConfig {
    ClientConfig {
        log_id: internal.harness.log_id,
        accepted_log_pk: internal.harness.log.log_public_key(),
        witnesses: WitnessSet::new(
            vec![ConfiguredWitness::dependent(internal.witness.public_key())],
            1,
        )
        .unwrap(),
        reset_authority_pk: internal.harness.reset_authority.public,
        reset_cooldown_seconds: 60,
    }
}

#[test]
fn a_log_wiped_under_the_same_key_is_refused_after_a_restart() {
    // Three epochs of history, persisted the way the plugin persists them.
    let mut before = Internal::new("wipe-same-key-before");
    before.publish_and_cosign();
    before.publish_and_cosign();
    let mut client = before.client();
    client.sync(NOW).unwrap();
    let checkpoint = client.checkpoint_bytes().unwrap();
    let pinned_epoch = client.view().epoch();
    assert!(pinned_epoch >= 2);

    // The operator wipes the log but keeps its signing key: same log id, new
    // history starting again from genesis.
    let mut after = Internal::new("wipe-same-key-after");
    after.publish_and_cosign();
    assert_eq!(after.harness.log_id, before.harness.log_id);

    let (mut resumed, opened) =
        KtClient::open(after.handle(), client_config(&after), Some(&checkpoint)).unwrap();
    assert_eq!(opened, f2z_kt_client::Opened::Resumed);
    let refusal = resumed
        .sync(NOW)
        .expect_err("a shorter history under the same log id is a rollback, not an update");
    assert!(
        matches!(refusal, ClientError::Protocol(_)),
        "must be evidence about the log, not a network error: {refusal:?}"
    );
    assert_eq!(resumed.view().epoch(), pinned_epoch, "the pin did not move");

    // The same bytes, not persisted — which is what the plugin did before ADR
    // 0017 — accept the wiped log without a murmur. This is the property the
    // checkpoint buys.
    let (mut fresh, opened) = KtClient::open(after.handle(), client_config(&after), None).unwrap();
    assert_eq!(opened, f2z_kt_client::Opened::Bootstrapped);
    fresh.sync(NOW).unwrap();
}

#[test]
fn a_checkpoint_for_another_log_is_set_aside_and_anything_else_wrong_is_refused() {
    let mut old = Internal::new("wipe-new-key-old");
    old.publish_and_cosign();
    let mut client = old.client();
    client.sync(NOW).unwrap();
    let checkpoint = client.checkpoint_bytes().unwrap();

    // The wipe procedure ADR 0017 prescribes: a new genesis key, so a new log
    // id, shipped in a reviewed build.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let new_key = Key::from_byte(0xb1);
    let reset = Key::from_byte(0xa2);
    let dir = f2z_kt::testing::temp_dir("wipe-new-key-new");
    let new_log_id = f2z_kt_core::labels::log_id(&new_key.public);
    let log = runtime
        .block_on(LogService::open(
            &dir,
            f2z_kt::LogSettings::defaults(new_key.public, reset.public).unwrap(),
            Arc::new(f2z_kt::FileSigner::from_seed(&[0xb1; 32])),
            f2z_kt::vrf::FileVrf::from_seed([0xb2; 32]).unwrap(),
            f2z_authority::AuthorityConfig::with_defaults(
                f2z_authority::LogId::new(*new_log_id.as_bytes()),
                f2z_authority::AuthoritySet::single(
                    SigningKey::from_seed(&AUTHORITY_SEED).public_key(),
                )
                .unwrap(),
            )
            .unwrap(),
            Vec::new(),
        ))
        .unwrap();
    runtime.block_on(log.publish_epoch(NOW)).unwrap();
    let transport = Arc::new(LogTransport {
        runtime,
        log: Arc::new(log),
    });
    let new_config = || ClientConfig {
        log_id: new_log_id,
        accepted_log_pk: new_key.public,
        witnesses: WitnessSet::new(
            vec![ConfiguredWitness::dependent(PublicKey::new([0x01; 32]))],
            1,
        )
        .unwrap(),
        reset_authority_pk: reset.public,
        reset_cooldown_seconds: 60,
    };

    let (_, opened) = KtClient::open(
        LogHandle(Arc::clone(&transport)),
        new_config(),
        Some(&checkpoint),
    )
    .unwrap();
    assert_eq!(opened, f2z_kt_client::Opened::ReplacedAnotherLogsCheckpoint);

    // A checkpoint that does not decode is not "no checkpoint".
    let mut corrupt = checkpoint.clone();
    corrupt.push(0);
    assert!(
        KtClient::open(
            LogHandle(Arc::clone(&transport)),
            new_config(),
            Some(&corrupt)
        )
        .is_err()
    );

    // Nor is this log's head with a signature that does not verify — the
    // one case where "bootstrap instead" would succeed and silently discard
    // the history.
    let mut forged = checkpoint.clone();
    *forged.last_mut().unwrap() ^= 0x01;
    assert!(KtClient::open(old.handle(), client_config(&old), Some(&forged)).is_err());
    assert!(KtClient::open(old.handle(), client_config(&old), None).is_ok());

    // Nor is this log's id under a key that did not sign it.
    let mut wrong_key = client_config(&old);
    wrong_key.accepted_log_pk = PublicKey::new([0x02; 32]);
    assert!(KtClient::open(old.handle(), wrong_key, Some(&checkpoint)).is_err());
}
