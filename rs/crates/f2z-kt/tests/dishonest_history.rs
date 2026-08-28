//! **A log that publishes a chain its own §4.4 forbids** — `KT.md` §8.2 step 4,
//! zuu#708.
//!
//! # Why this file exists, when `f2z-kt-client`'s acceptance suite already runs
//!
//! That suite drives a real [`LogService`], and a real `LogService` cannot
//! produce the answer step 4 is for. `validate_submission` refuses an entry
//! whose `prev_entry_hash` does not chain, so every history it can serve chains
//! by construction — which means the chain walk inside
//! `f2z_kt_core::verify::verify_key_history` could be deleted with that suite
//! green. Measured: it was.
//!
//! But the threat model is a **dishonest log**, and a dishonest log runs
//! modified code. So this file builds one: a real `akd` tree, over a real ECVRF
//! key, publishing two genuinely-included versions of one handle whose entries
//! do not chain, and answering with a real `HistoryProof`. Nothing here is a
//! fixture of a proof — `akd::Directory::key_history` produces it, and
//! `akd_core`'s verifier accepts it, exactly as the issue predicted it would:
//!
//! > a log that omits a version from a history response is otherwise serving a
//! > truthful subset, and **every proof in it verifies**.
//!
//! This is `f2z-witness`'s "two real logs sharing one signing key" shape, one
//! layer down: real cryptography, adversarial content. The only thing that
//! catches it is §8.2 step 4, and this file is what fails if step 4 stops
//! running.
//!
//! # What is *not* being tested here
//!
//! Not `akd`. The control at the end of every test publishes the same handle
//! with a **correct** chain through the same tree and the same proof machinery,
//! and asserts it verifies. A refusal that fired on both would prove nothing.

// An integration test is its own crate, so the workspace's denials of the
// panicking families do not reach it. A `.unwrap()` here is a failing test.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use akd::storage::StorageManager;
use akd::storage::memory::AsyncInMemoryDatabase;
use akd::{AkdLabel, AkdValue, AzksParallelismConfig, Directory};
use f2z_codec::Canonical as _;
use f2z_codec::types::{Digest, PublicKey};
use f2z_kt::testing::{EntryBuilder, Identity, Key};
use f2z_kt::vrf::FileVrf;
use f2z_kt_core::cosign::{WitnessCosignature, WitnessCosignatureTBS};
use f2z_kt_core::entry::DirectoryEntry;
use f2z_kt_core::labels;
use f2z_kt_core::sth::{SignedTreeHead, SignedTreeHeadTBS};
use f2z_kt_core::types::{Handle, LogId, label_field};
use f2z_kt_core::verify::{Configuration, HistoryParams, verify_key_history};
use f2z_kt_core::{ConfiguredWitness, KT_VERSION, KtError, WitnessSet, verify_threshold};
use protobuf::Message as _;

const NOW: u64 = 1_700_000_100_000;
const LOG_SEED: u8 = 0xa1;
const WITNESS_SEED: u8 = 0xc1;

/// A log with a real `akd` tree that publishes **whatever it is handed**.
///
/// The one difference from [`f2z_kt::LogService`], and it is the whole point:
/// there is no `validate_submission` between `publish` and the tree.
struct DishonestLog {
    tree: Directory<Configuration, AsyncInMemoryDatabase, FileVrf>,
    log_key: Key,
    log_id: LogId,
    vrf_public_key: PublicKey,
    epochs: Vec<(u64, Digest, u64)>,
    tree_size: u64,
}

impl DishonestLog {
    async fn new() -> Self {
        let log_key = Key::from_byte(LOG_SEED);
        let vrf = FileVrf::from_seed([0xb7; 32]).unwrap();
        let vrf_public_key = vrf.public_key().await.unwrap();
        let tree = Directory::<Configuration, _, _>::new(
            StorageManager::new_no_cache(AsyncInMemoryDatabase::new()),
            vrf.clone(),
            AzksParallelismConfig::default(),
        )
        .await
        .unwrap();
        Self {
            tree,
            log_id: labels::log_id(&log_key.public),
            log_key,
            vrf_public_key,
            epochs: Vec::new(),
            tree_size: 0,
        }
    }

    /// Insert one entry's committed value at the handle's label and close an
    /// epoch. The bytes are never checked against anything.
    async fn publish(&mut self, entry: &DirectoryEntry) {
        let canonical = entry.encode_canonical().unwrap();
        let label = AkdLabel(labels::akd_label(&entry.entry.handle));
        let value = AkdValue(labels::entry_value(&canonical).as_bytes().to_vec());
        let epoch_hash = self.tree.publish(vec![(label, value)]).await.unwrap();
        self.tree_size += 1;
        self.epochs.push((
            epoch_hash.epoch(),
            Digest::new(epoch_hash.hash()),
            self.tree_size,
        ));
    }

    /// The latest head, signed by the log's own key exactly as `publish_epoch`
    /// signs one.
    fn head(&self) -> SignedTreeHead {
        let mut prev_sth_hash = Digest::zero();
        let mut head = None;
        for (epoch, root_hash, tree_size) in &self.epochs {
            let sth = SignedTreeHeadTBS {
                label: label_field(labels::LABEL_STH).unwrap(),
                kt_version: KT_VERSION,
                log_id: self.log_id,
                epoch: *epoch,
                tree_size: *tree_size,
                root_hash: *root_hash,
                prev_sth_hash,
                vrf_public_key: self.vrf_public_key,
                published_at_ms: NOW + epoch,
                reset_count: 0,
                epoch_interval_seconds: 600,
                max_merge_delay_seconds: 3_600,
                successor_log_pk: PublicKey::zero(),
            };
            prev_sth_hash = sth.chain_hash().unwrap();
            let signature = self.log_key.sign(&sth.signing_bytes().unwrap());
            head = Some(SignedTreeHead { sth, signature });
        }
        head.expect("at least one epoch was published")
    }

    /// A genuine cosignature over the latest head by the configured witness.
    ///
    /// The witness is honest here: it is signing exactly the root this log
    /// published. §7.2's cosignature says the witness *saw* the root, never that
    /// the root's contents are authorized — and this file is about a log whose
    /// contents are not.
    fn cosignature(&self, head: &SignedTreeHead) -> WitnessCosignature {
        let witness = Key::from_byte(WITNESS_SEED);
        let statement = WitnessCosignatureTBS {
            label: WitnessCosignatureTBS::label_bytes().unwrap(),
            kt_version: KT_VERSION,
            log_id: head.sth.log_id,
            epoch: head.sth.epoch,
            tree_size: head.sth.tree_size,
            root_hash: head.sth.root_hash,
            witness_pk: witness.public,
            observed_at_ms: NOW,
        };
        let signature = witness.sign(&statement.signing_bytes().unwrap());
        let cosignature = WitnessCosignature {
            statement,
            signature,
        };
        cosignature.verify().expect("the fixture is well formed");
        cosignature
    }

    /// A real complete-history proof for `handle`, with the entry bytes in
    /// `akd`'s decreasing-version order.
    async fn history(&self, handle: &Handle) -> Vec<u8> {
        let label = AkdLabel(labels::akd_label(handle));
        let (proof, _) = self
            .tree
            .key_history(&label, HistoryParams::Complete)
            .await
            .unwrap();
        akd_core::proto::specs::types::HistoryProof::from(&proof)
            .write_to_bytes()
            .unwrap()
    }
}

/// The client's side: threshold, then §8.2.
fn audit(
    log: &DishonestLog,
    handle: &Handle,
    entries: &[Vec<u8>],
    proof: &[u8],
) -> Result<usize, KtError> {
    let head = log.head();
    let cosignature = log.cosignature(&head);
    let set = WitnessSet::new(
        vec![ConfiguredWitness::dependent(
            Key::from_byte(WITNESS_SEED).public,
        )],
        1,
    )
    .unwrap();
    // §8.3 first, and the type carries the proof that it ran.
    let root = verify_threshold(&head, &[cosignature], &set, &log.log_id)?;
    let borrowed: Vec<&[u8]> = entries.iter().map(Vec::as_slice).collect();
    verify_key_history(&root, handle, &borrowed, proof).map(|verified| verified.len())
}

fn handle() -> Handle {
    Handle::new(b"alice".to_vec()).unwrap()
}

/// A version-1 registration for `@alice`.
fn genesis(log_id: LogId, identity: &Identity) -> DirectoryEntry {
    EntryBuilder::first(log_id, "alice", identity)
        .device(0x51, &identity.isk)
        .endpoint(0x52)
        .same_key(&identity.dak)
}

/// A version-2 `same_key` successor whose `prev_entry_hash` is `prev`.
///
/// Every field a decoder or `DirectoryEntry::validate` can check is correct: the
/// right log, the right handle, version 2, a non-zero predecessor hash (§4.2
/// requires exactly that of a non-genesis entry), a valid self-signature.
fn successor(log_id: LogId, identity: &Identity, prev: Digest) -> DirectoryEntry {
    EntryBuilder::first(log_id, "alice", identity)
        .version(2)
        .prev_entry_hash(prev)
        .device(0x53, &identity.isk)
        .endpoint(0x54)
        .same_key(&identity.dak)
}

// ---------------------------------------------------------------------------
// The defect.
// ---------------------------------------------------------------------------

/// **zuu#708.** A history whose versions are contiguous, whose every entry is
/// genuinely in the tree, and whose `prev_entry_hash` chain does not link.
///
/// `key_history_verify` accepts it. It has no reason not to: both versions are
/// in the tree, they are a contiguous run starting at 1, and the values match
/// the entries served. **`akd` never reads `prev_entry_hash`.** Step 4 is the
/// only thing in the system that does.
#[tokio::test]
async fn a_history_the_akd_proof_verifies_but_whose_entries_do_not_chain_is_refused() {
    let mut log = DishonestLog::new().await;
    let identity = Identity::from_byte(0x31);
    let first = genesis(log.log_id, &identity);
    // The substitution: version 2 chains to something that is not version 1.
    let second = successor(log.log_id, &identity, Digest::new([0x5a; 32]));

    log.publish(&first).await;
    log.publish(&second).await;

    let proof = log.history(&handle()).await;
    let entries = vec![
        second.encode_canonical().unwrap(),
        first.encode_canonical().unwrap(),
    ];

    assert_eq!(
        audit(&log, &handle(), &entries, &proof),
        Err(KtError::HistoryIncomplete),
        "the proof verifies; the chain does not link, and only §8.2 step 4 looks",
    );
}

/// The control, and it is not optional: the same tree, the same proof
/// machinery, the same client, a **correct** chain — and it verifies.
///
/// Without this the refusal above would be evidence that this file cannot build
/// a working log rather than evidence that the check works.
#[tokio::test]
async fn the_same_log_serving_a_chain_that_links_is_accepted() {
    let mut log = DishonestLog::new().await;
    let identity = Identity::from_byte(0x31);
    let first = genesis(log.log_id, &identity);
    let second = successor(log.log_id, &identity, first.chain_hash().unwrap());

    log.publish(&first).await;
    log.publish(&second).await;

    let proof = log.history(&handle()).await;
    let entries = vec![
        second.encode_canonical().unwrap(),
        first.encode_canonical().unwrap(),
    ];

    assert_eq!(
        audit(&log, &handle(), &entries, &proof),
        Ok(2),
        "two versions, in the tree, chained — §8.2 is satisfied",
    );
}

/// A history that skips versions while still chaining by hash.
///
/// This is the case the `entry_version` half of step 4 catches on its own: the
/// `prev_entry_hash` walk is satisfied — the served version-5 entry really does
/// chain to version 1 — and §8.2's *"unbroken `entry_version` sequence"* is not.
///
/// It is refused here by `akd` rather than by step 4, and that is worth
/// asserting rather than glossing: under `HistoryParams::Complete`
/// `key_history_verify` checks its own update proofs are a contiguous
/// decreasing run, so on the witnessed path the version half of step 4 is a
/// second opinion. On the **unwitnessed** path (§8.3's self-audit row) there is
/// no `akd` and step 4 is alone, which is what `f2z-kt-client`'s
/// `a_history_with_a_version_omitted_is_refused_under_an_unwitnessed_root`
/// covers.
#[tokio::test]
async fn a_history_that_chains_by_hash_but_skips_a_version_is_refused() {
    let mut log = DishonestLog::new().await;
    let identity = Identity::from_byte(0x31);
    let first = genesis(log.log_id, &identity);
    let jumped = EntryBuilder::first(log.log_id, "alice", &identity)
        .version(5)
        .prev_entry_hash(first.chain_hash().unwrap())
        .device(0x55, &identity.isk)
        .endpoint(0x56)
        .same_key(&identity.dak);

    log.publish(&first).await;
    log.publish(&jumped).await;

    let proof = log.history(&handle()).await;
    let entries = vec![
        jumped.encode_canonical().unwrap(),
        first.encode_canonical().unwrap(),
    ];

    // `akd` assigns versions itself — the tree holds versions 1 and 2 — so the
    // entry claiming version 5 does not match the version the proof carries.
    // §8.1 step 4's binding catches it before step 4 does, and a client that
    // trusted the entry's own claim would not have noticed.
    assert_eq!(
        audit(&log, &handle(), &entries, &proof),
        Err(KtError::ValueMismatch),
        "an entry's claimed version is bound to the version the proof proves",
    );
}
