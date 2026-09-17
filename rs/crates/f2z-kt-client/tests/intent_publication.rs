//! **A device that cannot publish itself is published by the wallet, and
//! another person then finds it** — ADR 0017 §4.1, end to end.
//!
//! This is the `issue-device-credential-v2` round trip with nothing simulated
//! on the parts that decide anything:
//!
//! | Piece | What it really is |
//! |---|---|
//! | The request | `f2z_intent::encode_request` of a real `IssueDeviceCredentialRequestV2`, admitted by `IntentGate::admit` — every guard, one call. |
//! | The endpoint | A **real** `CREATE_CONTACT_QUEUE` against `FakeRelay` over a `ws://127.0.0.1:0` socket. The `contact_addr` is the one the relay issued, which is the reason this request exists at all. |
//! | The credential | Signed by `AccountKeys`' seed-derived `IdentitySigningKey`, exactly as ZUULI signs one. |
//! | The entry | `SubmissionDraft::adding_device` — the same drafting rule ZUULI's own enrollment uses — signed by the seed-derived `DirectoryAuthKey`, with the handle authority's `HandleAssertion` beside it. |
//! | The log | `f2z_kt::LogService`: real `akd` trees, a real VRF, real admission. |
//! | The witness | `f2z_witness::Witness`, cosigning what it audited. |
//! | The lookup | `KtClient::resolve`, the shipping client, applying §8.3's threshold and the inclusion proof. |
//!
//! # What the assertions are about
//!
//! 1. The published entry carries **the address the relay issued to the
//!    requesting device**, so a stranger who resolves the handle reaches that
//!    device and not the wallet.
//! 2. The requesting device learns it merged the way ADR 0017 §6 says it must —
//!    its own verified lookup showing its own `device_pk` — and not because the
//!    wallet said so.
//! 3. A stranger claims a key package at the published address and it
//!    authenticates against the entry the log proved: the device is genuinely
//!    reachable, by somebody who knew only a handle.
//! 4. Every refusal is the log's own: an assertion from an authority the log
//!    was not configured with, and a second first entry for a handle that
//!    already has one.
//!
//! What it does not carry is ZUULI's confirmation dialog and its session slot;
//! those are `wallet/zuuli/src-tauri/src/intent.rs`'s own tests, because they
//! need a Tauri app and a window.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::sync::Arc;

use f2z_authority::{AssertionNonce, HandleAssertionTBS, Intent as AssertionIntent, SigningKey};
use f2z_codec::Canonical as _;
use f2z_codec::types::{Body, PublicKey, QueueAddress, RelayId, ShortBytes};
use f2z_intent::{
    CallerAttestation, CallerRegistry, IntentBody, IntentClock, IntentGate, IntentRequestV1,
    IssueDeviceCredentialRequestV2, RegisteredCaller, RequestId, VisibleText, encode_request,
};
use f2z_kt::LogService;
use f2z_kt::testing::{Harness, Key};
use f2z_kt_client::{
    ClientConfig, ClientError, Expected, KtClient, SubmitTransport, Transport, submit,
};
use f2z_kt_core::entry::{ContactEndpoint, DirectoryEntry};
use f2z_kt_core::types::{Handle, KemPublicKey};
use f2z_kt_core::{ConfiguredWitness, ErrorCode, WitnessSet};
use f2z_msg_identity::{AccountKeys, DeviceCredentialRequest, SubmissionDraft};
use f2z_msg_mls::{DeviceSigner, MlsEngine};
use f2z_msg_store::MemoryBackend;
use f2z_relay_proto::key::SigningKey as QueueKey;
use f2z_relay_testkit::client::Client;
use f2z_relay_testkit::fake::FakeRelay;
use f2z_witness::witness::{Outcome, Settings, Witness};

const NOW: u64 = 1_700_000_100_000;
const WITNESS_SEED: u8 = 0xc4;
/// `f2z_kt::testing::Harness`'s configured authority.
const AUTHORITY_SEED: [u8; 32] = [0xa3; 32];
/// The caller e2e2z claims to be. A lookup key in ZUULI's registry, never a
/// credential (`CALLER-AUTHENTICATION.md` §2).
const CALLER: &str = "cash.free2z.e2e2z";

// ---------------------------------------------------------------------------
// The socket to the log, as `tests/seed_submission.rs` builds it.
// ---------------------------------------------------------------------------

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

/// ADR 0017's disposable internal deployment: one log, one dependent witness,
/// `t = 1`, one handle authority.
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

// ---------------------------------------------------------------------------
// e2e2z: a device with no seed, which opens its queue before it asks.
// ---------------------------------------------------------------------------

/// What `e2e2z_device_credential_keys` returns, produced the same way: a fresh
/// device key set, and a contact queue the relay really issued.
struct RequestingDevice {
    signer: DeviceSigner,
    recv_key: QueueKey,
    recv_addr: QueueAddress,
    contact_addr: QueueAddress,
}

impl RequestingDevice {
    async fn prepare(relay: &FakeRelay, seed: u8) -> Self {
        let signer = DeviceSigner::from_private_key([seed; 32]).unwrap();
        let recv_key = QueueKey::from_seed(&[seed.wrapping_add(0x10); 32]);
        let mut client = relay.client().await.unwrap();
        let created = client
            .create_contact_queue(&recv_key, 0, 0, None)
            .await
            .unwrap();
        Self {
            signer,
            recv_key,
            recv_addr: created.recv_addr,
            contact_addr: created.contact_addr,
        }
    }

    /// The request this device sends, byte for byte the shipping client's.
    fn request(&self, handle: &str, request_id: u8) -> Vec<u8> {
        let payload = IssueDeviceCredentialRequestV2 {
            handle: ShortBytes::new(handle.as_bytes().to_vec()).unwrap(),
            device_pk: PublicKey::new(*self.signer.public_key()),
            device_kem_pk: Body::new(vec![0x5a; 1216]).unwrap(),
            not_before_ms: NOW - 3_600_000,
            not_after_ms: NOW + 31_536_000_000,
            // A loopback relay speaks `ws://`; the wire format refuses that, and
            // rightly — a published endpoint is a promise to strangers. The
            // *published* URL is therefore the `wss://` one this deployment
            // would really serve, while the socket under it is the test's.
            contact_relay_url: ShortBytes::new(b"wss://relay.internal.example/relay/v1".to_vec())
                .unwrap(),
            contact_relay_id: RelayId::new([0x77; 32]),
            contact_addr: self.contact_addr,
        }
        .encode_canonical()
        .unwrap();
        encode_request(&IntentRequestV1 {
            intent: f2z_intent::Intent::IssueDeviceCredentialV2.code(),
            request_id: RequestId::new([request_id; 32]),
            caller: ShortBytes::new(CALLER.as_bytes().to_vec()).unwrap(),
            purpose: ShortBytes::new(b"Issue this device a messaging credential".to_vec()).unwrap(),
            issued_at_ms: NOW,
            expires_at_ms: NOW + 60_000,
            payload: Body::new(payload).unwrap(),
        })
        .unwrap()
    }
}

/// ZUULI's caller registry, holding exactly the surface that may ask.
fn gate() -> IntentGate {
    let mut registry = CallerRegistry::new();
    registry
        .register(RegisteredCaller {
            identifier: VisibleText::new(CALLER.as_bytes()).unwrap(),
            display_name: VisibleText::new(b"free2z Chat").unwrap(),
            signing_certs: Vec::new(),
        })
        .unwrap();
    IntentGate::new(registry)
}

/// What the handle authority issues (Contract C).
fn assertion(internal: &Internal, account: &AccountKeys, authority: &SigningKey) -> Vec<u8> {
    HandleAssertionTBS::new(
        &authority.public_key(),
        f2z_authority::LogId::new(*internal.harness.log_id.as_bytes()),
        f2z_authority::Handle::parse(b"alice").unwrap(),
        account.identity.public(),
        AssertionIntent::Bind,
        0,
        NOW,
        NOW + 60_000,
        AssertionNonce::new([0x21; 16]),
    )
    .unwrap()
    .sign(authority)
    .unwrap()
    .encode_canonical()
    .unwrap()
}

/// **ZUULI's half**, from admitted bytes to a signed submission: the steps
/// `wallet/zuuli/src-tauri/src/intent.rs` performs after the user approves.
fn wallet_signs(
    internal: &Internal,
    account: &AccountKeys,
    request_bytes: &[u8],
    predecessor: Option<&DirectoryEntry>,
    assertion_bytes: Option<&[u8]>,
) -> (
    f2z_msg_identity::SignedSubmission,
    f2z_kt_core::entry::DeviceCredential,
) {
    let mut gate = gate();
    let admitted = gate
        .admit(
            request_bytes,
            CallerAttestation::None,
            IntentClock::new(42_000, NOW),
        )
        .expect("a registered caller inside its window");
    let IntentBody::IssueDeviceCredentialV2(request) = admitted.body() else {
        panic!("family 4 must resolve to the version-2 body");
    };
    let handle = Handle::new(request.handle.as_slice().to_vec()).unwrap();
    let credential = account
        .identity
        .issue_device_credential(&DeviceCredentialRequest {
            handle: handle.clone(),
            device_pk: request.device_pk,
            device_kem_pk: KemPublicKey::new(request.device_kem_pk.as_slice().to_vec()).unwrap(),
            // The wallet's own lifetime policy, not the caller's request.
            not_before_ms: NOW - 3_600_000,
            not_after_ms: NOW + 31_536_000_000,
        })
        .unwrap();
    let endpoint = ContactEndpoint {
        relay_url: ShortBytes::new(request.contact_relay_url.as_slice().to_vec()).unwrap(),
        relay_id: request.contact_relay_id,
        contact_addr: request.contact_addr,
    };
    let draft = SubmissionDraft::adding_device(
        internal.harness.log_id,
        handle,
        credential.clone(),
        endpoint,
        predecessor,
        NOW,
    );
    let signed = account
        .sign_directory_submission(&draft, assertion_bytes)
        .expect("the seed signs the entry and the binding");
    (signed, credential)
}

fn submit_signed(
    internal: &Internal,
    signed: &f2z_msg_identity::SignedSubmission,
) -> f2z_kt_client::Result<f2z_kt_core::receipt::SubmissionReceipt> {
    let handle = Handle::new(b"alice".to_vec()).unwrap();
    let log_pk = internal.harness.log.log_public_key();
    submit(
        &internal.handle(),
        &signed.envelope,
        &Expected {
            log_id: &internal.harness.log_id,
            log_pk: &log_pk,
            handle: &handle,
            entry_version: signed.entry_version(),
            entry_digest: &signed.entry_digest,
        },
    )
}

// ---------------------------------------------------------------------------
// The round trip.
// ---------------------------------------------------------------------------

#[test]
fn a_device_that_cannot_publish_itself_is_published_and_then_found_by_a_stranger() {
    let mut internal = Internal::new("intent-publication");
    let account = AccountKeys::from_seed(&[0x42; 64], 0).unwrap();

    let relay_runtime = tokio::runtime::Runtime::new().unwrap();
    // The socket is loopback `ws://`; what the entry *publishes* is the
    // `wss://` URL this deployment would really serve. `RequestingDevice`'s
    // comment says why.
    let (relay, _server) = relay_runtime.block_on(async {
        let relay = FakeRelay::with_defaults().unwrap();
        let server = relay.listen_loopback().await.unwrap();
        (relay, server)
    });

    // --- e2e2z: the queue exists before the credential does -----------------
    let device = relay_runtime.block_on(RequestingDevice::prepare(&relay, 0xe1));
    let request = device.request("alice", 0x51);

    // --- ZUULI: admit, issue, draft, sign, submit ---------------------------
    let (signed, credential) = wallet_signs(
        &internal,
        &account,
        &request,
        None,
        Some(&assertion(
            &internal,
            &account,
            &SigningKey::from_seed(&AUTHORITY_SEED),
        )),
    );
    let receipt = submit_signed(&internal, &signed)
        .expect("the log admits a seed-signed first entry for another app's device");
    assert_eq!(receipt.receipt.entry_version, 1);
    internal.publish_and_cosign();

    // --- e2e2z: its own verified lookup, which is what a merge means --------
    let mut device_kt = internal.client();
    let resolution = device_kt
        .resolve(&Handle::new(b"alice".to_vec()).unwrap(), NOW + 1)
        .expect("a cosigned root and a registered handle");
    let resolved = resolution.resolved().expect("merged and proved");
    assert!(
        f2z_msg_identity::publishes_device(
            resolved.entry(),
            &PublicKey::new(*device.signer.public_key())
        ),
        "the requesting device learns it merged by seeing its own key published",
    );
    assert_eq!(resolution.standing().independent(), 0, "ADR 0017's posture");
    let published = &resolved.entry().entry.contact_endpoints.as_slice()[0];
    assert_eq!(
        published.contact_addr, device.contact_addr,
        "the entry publishes the address the relay issued to the device",
    );

    // --- the device publishes a pool at the address the log now advertises --
    let mls = MlsEngine::new(
        MemoryBackend::new(),
        DeviceSigner::from_private_key([0xe1; 32]).unwrap(),
        credential.clone(),
        NOW,
    )
    .unwrap();
    relay_runtime.block_on(async {
        let packages = mls.generate_key_packages(2, None).unwrap();
        let last_resort = mls
            .generate_last_resort_key_package(Some(2_592_000))
            .unwrap();
        let mut client: Client = relay.client().await.unwrap();
        let published = client
            .publish_key_packages(
                &device.recv_key,
                device.recv_addr,
                &packages,
                Some(last_resort),
            )
            .await
            .unwrap();
        assert_eq!(published.pool_size, 2);
    });

    // --- a stranger, who knows only the handle, reaches the device ----------
    let mut stranger_kt = internal.client();
    let entry = stranger_kt
        .resolve(&Handle::new(b"alice".to_vec()).unwrap(), NOW + 2)
        .unwrap()
        .resolved()
        .expect("the stranger resolves it too")
        .entry()
        .clone();
    let stranger_addr = QueueAddress::from_slice(
        entry.entry.contact_endpoints.as_slice()[0]
            .contact_addr
            .as_bytes(),
    )
    .unwrap();
    let claimed = relay_runtime.block_on(async {
        let mut client: Client = relay.client().await.unwrap();
        client.claim_key_package(stranger_addr).await.unwrap()
    });
    // The stranger's own engine authenticates it against the entry the log
    // proved, which is the property that makes a published endpoint usable. It
    // is a genuinely separate identity: its own account keys, its own device
    // key, its own credential — nothing of alice's but the proved entry.
    let stranger_account = AccountKeys::from_seed(&[0xbb; 64], 0).unwrap();
    let stranger_signer = DeviceSigner::from_private_key([0xbc; 32]).unwrap();
    let stranger_credential = stranger_account
        .identity
        .issue_device_credential(&DeviceCredentialRequest {
            handle: Handle::new(b"bob".to_vec()).unwrap(),
            device_pk: PublicKey::new(*stranger_signer.public_key()),
            device_kem_pk: KemPublicKey::new(vec![0x5a; 1216]).unwrap(),
            not_before_ms: NOW - 3_600_000,
            not_after_ms: NOW + 31_536_000_000,
        })
        .unwrap();
    let stranger_mls = MlsEngine::new(
        MemoryBackend::new(),
        stranger_signer,
        stranger_credential,
        NOW,
    )
    .unwrap();
    let verified = stranger_mls
        .verify_key_package(claimed.key_package.as_slice(), &entry.entry, NOW + 2)
        .expect("the claimed package authenticates against the entry the log proved");
    assert_eq!(
        verified.device_pk(),
        device.signer.public_key(),
        "a stranger who knew only a handle reached this device's own key",
    );

    // --- a second device chains, keeps the first, and goes first ------------
    let second = relay_runtime.block_on(RequestingDevice::prepare(&relay, 0xe2));
    let (chained, _) = wallet_signs(
        &internal,
        &account,
        &second.request("alice", 0x52),
        Some(resolved.entry()),
        None,
    );
    submit_signed(&internal, &chained).expect("a routine update, authorized by the seed");
    internal.publish_and_cosign();
    let merged = internal
        .client()
        .resolve(&Handle::new(b"alice".to_vec()).unwrap(), NOW + 3)
        .unwrap()
        .resolved()
        .unwrap()
        .entry()
        .clone();
    assert_eq!(merged.entry.entry_version, 2);
    assert_eq!(merged.entry.devices.as_slice().len(), 2);
    assert_eq!(
        merged.entry.contact_endpoints.as_slice()[0].contact_addr,
        second.contact_addr,
        "the enrolling device's endpoint goes first (ARCHITECTURE.md §13-G)",
    );
    assert!(f2z_msg_identity::publishes_device(
        &merged,
        &PublicKey::new(*device.signer.public_key())
    ));
}

#[test]
fn the_log_refuses_what_the_wallet_should_not_have_submitted() {
    let mut internal = Internal::new("intent-publication-refusals");
    let account = AccountKeys::from_seed(&[0x43; 64], 0).unwrap();
    let relay_runtime = tokio::runtime::Runtime::new().unwrap();
    // The socket is loopback `ws://`; what the entry *publishes* is the
    // `wss://` URL this deployment would really serve. `RequestingDevice`'s
    // comment says why.
    let (relay, _server) = relay_runtime.block_on(async {
        let relay = FakeRelay::with_defaults().unwrap();
        let server = relay.listen_loopback().await.unwrap();
        (relay, server)
    });
    let device = relay_runtime.block_on(RequestingDevice::prepare(&relay, 0xe3));

    // An assertion from an authority this log was not configured with. ZUULI's
    // own precheck refuses this before it leaves the process; the log is the
    // party that must refuse it regardless, and does.
    let (forged, _) = wallet_signs(
        &internal,
        &account,
        &device.request("alice", 0x61),
        None,
        Some(&assertion(
            &internal,
            &account,
            &SigningKey::from_seed(&[0x5e; 32]),
        )),
    );
    assert_eq!(
        submit_signed(&internal, &forged).unwrap_err().to_string(),
        ClientError::Refused(ErrorCode::BadAuthorization).to_string(),
    );

    // The honest one is admitted…
    let (signed, _) = wallet_signs(
        &internal,
        &account,
        &device.request("alice", 0x62),
        None,
        Some(&assertion(
            &internal,
            &account,
            &SigningKey::from_seed(&AUTHORITY_SEED),
        )),
    );
    submit_signed(&internal, &signed).expect("the positive control");
    internal.publish_and_cosign();

    // …and a second *first* entry for a handle that already has one is not a
    // publication the log will make, however well signed it is.
    let again = relay_runtime.block_on(RequestingDevice::prepare(&relay, 0xe4));
    let (replayed, _) = wallet_signs(
        &internal,
        &account,
        &again.request("alice", 0x63),
        None,
        Some(&assertion(
            &internal,
            &account,
            &SigningKey::from_seed(&AUTHORITY_SEED),
        )),
    );
    assert!(
        submit_signed(&internal, &replayed).is_err(),
        "a handle's first entry happens once",
    );
}
