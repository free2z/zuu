//! Bounded, resumable `KT.md` §6.3 catch-up over the exact-epoch transport.
//!
//! These fixtures do not imitate a tree or an append-only proof. They generate
//! real Ed25519-signed `SignedTreeHead`s and witness cosignatures, then stand in
//! only for the socket so failures can be placed at exact page boundaries. The
//! real-log acceptance suite separately proves that `Transport::sth_at` serves
//! the production log's bundles.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use f2z_authority::SigningKey;
use f2z_codec::Canonical as _;
use f2z_codec::types::{Digest, PublicKey};
use f2z_kt_client::{AlarmLog, PinStore};
use f2z_kt_client::{ClientConfig, ClientError, KtClient, MAX_EPOCH_CATCHUP, Transport};
use f2z_kt_core::api::TreeHeadBundle;
use f2z_kt_core::cosign::{WitnessCosignature, WitnessCosignatureTBS};
use f2z_kt_core::sth::{SignedTreeHead, SignedTreeHeadTBS};
use f2z_kt_core::{ConfiguredWitness, ErrorCode, KT_VERSION, KtError, WitnessSet, labels};

const TARGET: u64 = 600;

#[derive(Clone)]
enum Reply {
    Bytes(Vec<u8>),
    Error(ClientError),
}

struct State {
    bundles: Vec<Vec<u8>>,
    latest_epoch: u64,
    latest_override: Option<Reply>,
    exact_overrides: BTreeMap<u64, Reply>,
    requested: Vec<u64>,
}

#[derive(Clone)]
struct FixtureTransport(Arc<Mutex<State>>);

impl FixtureTransport {
    fn set_latest(&self, epoch: u64) {
        self.0.lock().unwrap().latest_epoch = epoch;
    }

    fn override_latest(&self, reply: Reply) {
        self.0.lock().unwrap().latest_override = Some(reply);
    }

    fn clear_latest_override(&self) {
        self.0.lock().unwrap().latest_override = None;
    }

    fn override_epoch(&self, epoch: u64, reply: Reply) {
        self.0.lock().unwrap().exact_overrides.insert(epoch, reply);
    }

    fn clear_epoch_override(&self, epoch: u64) {
        self.0.lock().unwrap().exact_overrides.remove(&epoch);
    }

    fn requested(&self) -> Vec<u64> {
        self.0.lock().unwrap().requested.clone()
    }

    fn clear_requests(&self) {
        self.0.lock().unwrap().requested.clear();
    }

    fn bytes_at(&self, epoch: u64) -> Vec<u8> {
        self.0.lock().unwrap().bundles[usize::try_from(epoch).unwrap()].clone()
    }
}

impl Transport for FixtureTransport {
    fn latest_sth(&self) -> f2z_kt_client::Result<Vec<u8>> {
        let state = self.0.lock().unwrap();
        match state.latest_override.as_ref() {
            Some(Reply::Bytes(bytes)) => Ok(bytes.clone()),
            Some(Reply::Error(error)) => Err(error.clone()),
            None => Ok(state.bundles[usize::try_from(state.latest_epoch).unwrap()].clone()),
        }
    }

    fn sth_at(&self, epoch: u64) -> f2z_kt_client::Result<Vec<u8>> {
        let mut state = self.0.lock().unwrap();
        state.requested.push(epoch);
        match state.exact_overrides.get(&epoch) {
            Some(Reply::Bytes(bytes)) => Ok(bytes.clone()),
            Some(Reply::Error(error)) => Err(error.clone()),
            None => Ok(state.bundles[usize::try_from(epoch).unwrap()].clone()),
        }
    }

    fn lookup(&self, _request: &[u8]) -> f2z_kt_client::Result<Vec<u8>> {
        Err(ClientError::Unreachable("fixture has no lookup".into()))
    }

    fn history(&self, _request: &[u8]) -> f2z_kt_client::Result<Vec<u8>> {
        Err(ClientError::Unreachable("fixture has no history".into()))
    }

    fn authority_policy(&self) -> f2z_kt_client::Result<Vec<u8>> {
        Err(ClientError::Unreachable("fixture has no policy".into()))
    }

    fn descriptor(&self) -> f2z_kt_client::Result<Vec<u8>> {
        Err(ClientError::Unreachable("fixture has no descriptor".into()))
    }
}

struct Fixture {
    transport: FixtureTransport,
    config: ClientConfig,
    heads: Vec<SignedTreeHead>,
    log_key: SigningKey,
}

impl Fixture {
    fn new(last_epoch: u64) -> Self {
        let log_key = SigningKey::from_seed(&[0x31; 32]);
        let witness_key = SigningKey::from_seed(&[0x32; 32]);
        let log_id = labels::log_id(&log_key.public_key());
        let vrf_public_key = SigningKey::from_seed(&[0x33; 32]).public_key();
        let mut heads = Vec::new();
        let mut bundles = Vec::new();
        let mut previous_hash = Digest::zero();

        for epoch in 0..=last_epoch {
            let mut root = [0u8; 32];
            root[..8].copy_from_slice(&epoch.to_be_bytes());
            root[8..].fill(0x44);
            let sth = SignedTreeHeadTBS {
                label: SignedTreeHeadTBS::label_bytes().unwrap(),
                kt_version: KT_VERSION,
                log_id,
                epoch,
                tree_size: epoch,
                root_hash: Digest::new(root),
                prev_sth_hash: previous_hash,
                vrf_public_key,
                published_at_ms: 1_700_000_000_000 + epoch,
                reset_count: 0,
                epoch_interval_seconds: 600,
                max_merge_delay_seconds: 3_600,
                successor_log_pk: PublicKey::zero(),
            };
            let head = SignedTreeHead {
                signature: log_key.sign(&sth.signing_bytes().unwrap()),
                sth,
            };
            previous_hash = head.sth.chain_hash().unwrap();
            let statement = WitnessCosignatureTBS {
                label: WitnessCosignatureTBS::label_bytes().unwrap(),
                kt_version: KT_VERSION,
                log_id,
                epoch,
                tree_size: epoch,
                root_hash: head.sth.root_hash,
                witness_pk: witness_key.public_key(),
                observed_at_ms: 1_700_000_000_500 + epoch,
            };
            let cosignature = WitnessCosignature {
                signature: witness_key.sign(&statement.signing_bytes().unwrap()),
                statement,
            };
            bundles.push(
                TreeHeadBundle::new(head.clone(), vec![cosignature])
                    .unwrap()
                    .encode_canonical()
                    .unwrap(),
            );
            heads.push(head);
        }

        let transport = FixtureTransport(Arc::new(Mutex::new(State {
            bundles,
            latest_epoch: 0,
            latest_override: None,
            exact_overrides: BTreeMap::new(),
            requested: Vec::new(),
        })));
        let config = ClientConfig {
            log_id,
            accepted_log_pk: log_key.public_key(),
            witnesses: WitnessSet::new(
                vec![ConfiguredWitness::independent(witness_key.public_key())],
                1,
            )
            .unwrap(),
            reset_authority_pk: SigningKey::from_seed(&[0x34; 32]).public_key(),
            reset_cooldown_seconds: 86_400,
        };
        Self {
            transport,
            config,
            heads,
            log_key,
        }
    }

    fn bootstrap(&self) -> KtClient<FixtureTransport> {
        KtClient::bootstrap(self.transport.clone(), self.config.clone()).unwrap()
    }

    fn resume(&self, client: &KtClient<FixtureTransport>) -> KtClient<FixtureTransport> {
        // This byte boundary is the persistence seam: the new client gets no
        // clone of the old private `LogView`, only a canonical protocol object
        // decoded as a process after restart would decode it.
        let bytes = client.checkpoint_bytes().unwrap();
        KtClient::resume(
            self.transport.clone(),
            self.config.clone(),
            &bytes,
            PinStore::new(),
            AlarmLog::new(),
        )
        .unwrap()
    }

    fn resign(&self, mut head: SignedTreeHead) -> Vec<u8> {
        head.signature = self.log_key.sign(&head.sth.signing_bytes().unwrap());
        TreeHeadBundle::new(head, Vec::new())
            .unwrap()
            .encode_canonical()
            .unwrap()
    }
}

fn assert_checkpoint(error: ClientError, accepted_epoch: u64, target_epoch: u64) {
    assert_eq!(
        error,
        ClientError::CatchUpIncomplete {
            accepted_epoch,
            target_epoch,
        }
    );
    assert!(error.is_transient());
    assert!(!error.is_fork_evidence());
}

#[test]
fn a_six_hundred_epoch_gap_converges_in_three_persisted_batches() {
    let fixture = Fixture::new(TARGET);
    let mut client = fixture.bootstrap();
    fixture.transport.set_latest(TARGET);

    let error = client.sync(1).unwrap_err();
    assert_checkpoint(error, MAX_EPOCH_CATCHUP, TARGET);
    assert_eq!(client.view().epoch(), 256);
    assert_eq!(fixture.transport.requested(), (1..=256).collect::<Vec<_>>());

    // A process restart: only the documented durable state crosses this seam.
    let mut client = fixture.resume(&client);
    fixture.transport.clear_requests();
    let error = client.sync(2).unwrap_err();
    assert_checkpoint(error, 512, TARGET);
    assert_eq!(client.view().epoch(), 512);
    assert_eq!(
        fixture.transport.requested(),
        (257..=512).collect::<Vec<_>>()
    );

    let mut client = fixture.resume(&client);
    fixture.transport.clear_requests();
    let accepted = client.sync(3).unwrap();
    assert_eq!(accepted.epoch(), TARGET);
    assert_eq!(client.view().epoch(), TARGET);
    assert_eq!(
        fixture.transport.requested(),
        (513..=TARGET).collect::<Vec<_>>()
    );
}

#[test]
fn latest_head_trust_mutation_cannot_satisfy_a_catch_up_page() {
    // Mutation control: replacing `advance_to`'s EpochGap branch with a fresh
    // `LogView::pin(..., target)` turns the expected incomplete result below
    // into `Ok(AcceptedRoot { epoch: 300, .. })` and makes this test fail. That
    // is the tempting shortcut §6.3 specifically forbids.
    let fixture = Fixture::new(300);
    let mut client = fixture.bootstrap();
    fixture.transport.set_latest(300);

    let error = client.sync(1).unwrap_err();
    assert_checkpoint(error, 256, 300);
    assert_eq!(
        client.view().epoch(),
        256,
        "the target must remain untrusted"
    );
    assert_eq!(
        fixture.transport.requested(),
        (1..=256).collect::<Vec<_>>(),
        "every epoch in the bounded contiguous prefix must be requested"
    );
}

#[test]
fn an_interrupted_page_persists_only_its_verified_prefix_and_resumes() {
    let fixture = Fixture::new(300);
    let mut client = fixture.bootstrap();
    fixture.transport.set_latest(300);
    fixture.transport.override_epoch(
        100,
        Reply::Error(ClientError::Unreachable("server stalled".into())),
    );

    assert!(matches!(client.sync(1), Err(ClientError::Unreachable(_))));
    assert_eq!(client.view().epoch(), 99);

    let mut client = fixture.resume(&client);
    fixture.transport.clear_epoch_override(100);
    fixture.transport.clear_requests();
    let accepted = client.sync(2).unwrap();
    assert_eq!(accepted.epoch(), 300);
    assert_eq!(client.view().epoch(), 300);
    assert_eq!(
        fixture.transport.requested(),
        (100..=300).collect::<Vec<_>>()
    );
}

#[test]
fn catch_up_target_uses_complete_repeat_equality_and_persists_the_exact_epoch_head() {
    let fixture = Fixture::new(8);
    let mut client = fixture.bootstrap();

    // The exact-epoch page serves the canonical epoch-8 head. The latest
    // response keeps the old subset (epoch/root/size/time) identical but changes
    // a different signed TBS field. Before #898, subset equality accepted this
    // as an idempotent repeat after catch-up; complete protocol equality must
    // instead report fork evidence.
    let mut alternative = fixture.heads[8].clone();
    alternative.sth.reset_count = alternative.sth.reset_count.saturating_add(1);
    fixture
        .transport
        .override_latest(Reply::Bytes(fixture.resign(alternative)));

    let error = client.sync(1).unwrap_err();
    assert_eq!(error, ClientError::Protocol(KtError::Fork));
    assert!(error.is_fork_evidence());
    assert_eq!(client.view().epoch(), 8);
    assert_eq!(client.checkpoint(), &fixture.heads[8]);
    assert_eq!(fixture.transport.requested(), (1..=8).collect::<Vec<_>>());

    // Persisting after that error retains the consecutively verified canonical
    // exact-epoch head, never the conflicting latest response. On restart, the
    // same complete canonical head is an idempotent no-op and needs no page.
    let checkpoint = client.checkpoint_bytes().unwrap();
    let mut client = fixture.resume(&client);
    fixture.transport.clear_latest_override();
    fixture.transport.set_latest(8);
    fixture.transport.clear_requests();
    let accepted = client.sync(2).unwrap();
    assert_eq!(accepted.epoch(), 8);
    assert_eq!(client.checkpoint_bytes().unwrap(), checkpoint);
    assert!(fixture.transport.requested().is_empty());
}

#[test]
fn a_corrupted_persisted_checkpoint_is_refused_before_resume() {
    let fixture = Fixture::new(300);
    let mut client = fixture.bootstrap();
    fixture.transport.set_latest(300);
    assert!(matches!(
        client.sync(1),
        Err(ClientError::CatchUpIncomplete { .. })
    ));

    let mut checkpoint = client.checkpoint_bytes().unwrap();
    *checkpoint.last_mut().unwrap() ^= 0x01;
    assert!(matches!(
        KtClient::resume(
            fixture.transport.clone(),
            fixture.config.clone(),
            &checkpoint,
            PinStore::new(),
            AlarmLog::new(),
        ),
        Err(ClientError::Protocol(KtError::BadSignature))
    ));
}

#[test]
fn missing_duplicate_reordered_truncated_and_stalled_pages_never_skip() {
    let cases = [
        (
            "missing",
            Reply::Error(ClientError::Refused(ErrorCode::EpochUnavailable)),
            ClientError::Refused(ErrorCode::EpochUnavailable),
        ),
        (
            "duplicate",
            Reply::Bytes(Fixture::new(8).transport.bytes_at(4)),
            ClientError::Protocol(KtError::EpochGap),
        ),
        (
            "reordered",
            Reply::Bytes(Fixture::new(8).transport.bytes_at(6)),
            ClientError::Protocol(KtError::EpochGap),
        ),
        (
            "truncated",
            Reply::Bytes({
                let fixture = Fixture::new(8);
                let mut bytes = fixture.transport.bytes_at(5);
                bytes.pop();
                bytes
            }),
            ClientError::Protocol(KtError::Malformed),
        ),
        (
            "stalled",
            Reply::Error(ClientError::Unreachable("server stalled".into())),
            ClientError::Unreachable("server stalled".into()),
        ),
    ];

    for (name, reply, expected) in cases {
        let fixture = Fixture::new(8);
        let mut client = fixture.bootstrap();
        fixture.transport.set_latest(8);
        fixture.transport.override_epoch(5, reply);
        assert_eq!(client.sync(1), Err(expected), "{name} response must fail");
        assert_eq!(client.view().epoch(), 4, "{name} response skipped an epoch");
        assert_eq!(fixture.transport.requested(), (1..=5).collect::<Vec<_>>());
    }
}

#[test]
fn fork_rollback_and_broken_chain_fail_at_the_last_verified_checkpoint() {
    let fixture = Fixture::new(12);
    fixture.transport.set_latest(10);
    let mut client = fixture.bootstrap();

    fixture
        .transport
        .override_latest(Reply::Bytes(fixture.transport.bytes_at(9)));
    assert_eq!(
        client.sync(1),
        Err(ClientError::Protocol(KtError::Rollback))
    );
    assert_eq!(client.view().epoch(), 10);

    let mut fork = fixture.heads[10].clone();
    fork.sth.root_hash = Digest::new([0xf0; 32]);
    fixture
        .transport
        .override_latest(Reply::Bytes(fixture.resign(fork)));
    let fork_error = client.sync(2).unwrap_err();
    assert_eq!(fork_error, ClientError::Protocol(KtError::Fork));
    assert!(fork_error.is_fork_evidence());
    assert_eq!(client.view().epoch(), 10);

    let fixture = Fixture::new(12);
    let mut client = fixture.bootstrap();
    fixture.transport.set_latest(12);
    let mut broken = fixture.heads[5].clone();
    broken.sth.prev_sth_hash = Digest::new([0xb0; 32]);
    fixture
        .transport
        .override_epoch(5, Reply::Bytes(fixture.resign(broken)));
    assert_eq!(
        client.sync(3),
        Err(ClientError::Protocol(KtError::ChainBreak))
    );
    assert_eq!(client.view().epoch(), 4);
}

#[test]
fn documented_one_head_wire_costs_are_executable_constants() {
    let fixture = Fixture::new(0);
    let with_one_cosignature = fixture.transport.bytes_at(0).len();
    let without_cosignatures = TreeHeadBundle::new(fixture.heads[0].clone(), Vec::new())
        .unwrap()
        .encode_canonical()
        .unwrap()
        .len();

    assert_eq!(without_cosignatures, 314);
    assert_eq!(with_one_cosignature - without_cosignatures, 205);
}
