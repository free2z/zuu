//! **`/kt/v1/cosign` must fail closed** — zuu#669.
//!
//! A log that accepts a cosignature from anybody does not merely fail to add
//! security. It **manufactures the appearance of it**: `/kt/v1/sth` hands every
//! client a bundle with a reassuring number of cosignatures in it, and the
//! number means nothing. Anti-equivocation is the one property cosigning
//! exists to provide, and
//! [`ARCHITECTURE.md` §9.3](../../../docs/e2ee/ARCHITECTURE.md) already says
//! plainly that witnesses free2z operates are not independent witnesses — a
//! count inflated by four strangers is strictly worse than a count of zero,
//! because zero is true.
//!
//! The defect was measured, not theorised: four `f2z-witness` instances with
//! four freshly generated keys, none of them named anywhere in the log's
//! configuration, were all accepted by a real log, journalled with an `fsync`,
//! and replayed into memory at every subsequent startup. The condition
//!
//! ```text
//! if !self.known_witnesses.is_empty() && !self.known_witnesses.contains(...)
//! ```
//!
//! never ran its second half, because `witness_pk` is optional and the shipped
//! deployment had none.
//!
//! # Why these tests are written against the HTTP endpoint
//!
//! `/kt/v1/cosign` is public and unauthenticated. The rule is a property of
//! **what a stranger with a socket can make the log store**, so the test is a
//! request through the router rather than a call to a method — the same route
//! the four witnesses took.
//!
//! Every assertion here is a rule that, before this file existed, could not
//! fail. That is exactly how the defect survived review: a happy-path test with
//! one configured witness passes identically on a log that accepts everyone.

// An integration test is its own crate, so the workspace's denials of the
// panicking families do not reach it. A `.unwrap()` here is a failing test.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use f2z_codec::Canonical as _;
use f2z_codec::decode_canonical;
use f2z_codec::types::PublicKey;
use f2z_kt::FileSigner;
use f2z_kt::api::AppState;
use f2z_kt::ratelimit::RateLimiter;
use f2z_kt::testing::{Harness, Key};
use f2z_kt_core::KtError;
use f2z_kt_core::api::ErrorBody;
use f2z_kt_core::cosign::{WitnessCosignature, WitnessCosignatureTBS};
use f2z_kt_core::sth::SignedTreeHead;
use tower::ServiceExt as _;

const NOW: u64 = 1_700_000_100_000;

/// `ERR_NOT_A_WITNESS`, `KT.md` §9.5. Written as a literal: the point of that
/// table is that a code's number never changes.
const ERR_NOT_A_WITNESS: u16 = 10;

/// A cosignature over `head`, signed by `key`.
///
/// Correctly formed in every way — the label, the version, the log id, the
/// epoch, the size, the root and the signature all check out. The *only* thing
/// wrong with it is whose key it is, which is the whole point: a log that
/// refuses it for any other reason is not testing zuu#669.
fn cosignature_over(head: &SignedTreeHead, key: &Key) -> WitnessCosignature {
    let statement = WitnessCosignatureTBS {
        label: WitnessCosignatureTBS::label_bytes().unwrap(),
        kt_version: f2z_kt_core::KT_VERSION,
        log_id: head.sth.log_id,
        epoch: head.sth.epoch,
        tree_size: head.sth.tree_size,
        root_hash: head.sth.root_hash,
        witness_pk: key.public,
        observed_at_ms: NOW,
    };
    let signature = key.sign(&statement.signing_bytes().unwrap());
    let cosignature = WitnessCosignature {
        statement,
        signature,
    };
    // The fixture is not the thing under test: if this ever fails, the test
    // below would be asserting a refusal the log owes to a bad signature.
    cosignature.verify().expect("the fixture is well formed");
    assert!(cosignature.covers(head), "the fixture covers the head");
    cosignature
}

async fn app_state(harness: &Harness) -> Arc<AppState> {
    let signer = FileSigner::from_seed(&[0xa1; 32]);
    Arc::new(AppState {
        descriptor: f2z_kt::descriptor::sign_descriptor(
            harness.log.settings(),
            harness.log_id,
            *harness.log.vrf_public_key(),
            &signer,
            NOW,
        )
        .unwrap(),
        policy: f2z_kt::sign_policy(harness.log.authority(), harness.log_id, &signer, NOW).unwrap(),
        log: Arc::clone(&harness.log),
        limits: RateLimiter::defaults(),
        clock: Arc::new(|| NOW),
    })
}

/// `POST /kt/v1/cosign`, returning the status and the §9.5 code in the body.
///
/// `None` for the code on a `204`, which carries no body by design.
async fn post_cosign(
    state: &Arc<AppState>,
    cosignature: &WitnessCosignature,
) -> (StatusCode, Option<u16>) {
    let body = cosignature.encode_canonical().unwrap();
    let response = f2z_kt::api::router(Arc::clone(state))
        .oneshot(
            Request::post("/kt/v1/cosign")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 16)
        .await
        .unwrap();
    let code = decode_canonical::<ErrorBody>(&bytes)
        .ok()
        .map(|body| body.into_value().code);
    (status, code)
}

/// How many cosignatures the log serves for its latest head, which is what a
/// client counts a threshold against.
async fn served(harness: &Harness) -> usize {
    harness
        .log
        .latest_bundle()
        .await
        .unwrap()
        .cosignatures
        .len()
}

/// The size of the append-only cosignature journal, in bytes.
///
/// Asserted separately from what the log serves because the two failures are
/// different: serving a stranger's cosignature is this epoch's problem, and
/// `fsync`ing it is every future startup's problem. §9.2's journal is
/// append-only with no backup, on a `replicas: 1` ReadWriteOnce volume, and the
/// documented recovery for junk in it is hand-editing a security-sensitive
/// file.
fn journal_bytes(harness: &Harness) -> u64 {
    std::fs::metadata(harness.dir.join("cosignatures.log")).map_or(0, |meta| meta.len())
}

// ---------------------------------------------------------------------------
// The defect.
// ---------------------------------------------------------------------------

/// **zuu#669.** With no `witness_pk` configured, four unrelated keys are
/// refused — and nothing about them reaches memory or the journal.
#[tokio::test]
async fn a_log_with_no_configured_witnesses_refuses_every_cosignature() {
    let harness = Harness::vouched("cosign-fail-open").await;
    harness.log.publish_epoch(NOW).await.unwrap();
    let state = app_state(&harness).await;
    let head = harness.log.latest_bundle().await.unwrap().head;

    // Four unrelated keys, as in the reproduction on the issue. None of them is
    // named anywhere in this log's configuration, because this log's
    // configuration names no witness at all.
    for seed in [0xd1_u8, 0xd2, 0xd3, 0xd4] {
        let stranger = Key::from_byte(seed);
        let cosignature = cosignature_over(&head, &stranger);
        let (status, code) = post_cosign(&state, &cosignature).await;
        assert_eq!(
            (status, code),
            (StatusCode::BAD_REQUEST, Some(ERR_NOT_A_WITNESS)),
            "a log that recognises nobody must recognise nobody, key {seed:#x}"
        );
    }

    assert_eq!(
        served(&harness).await,
        0,
        "a client counting cosignatures on this log must count zero, which is the truth"
    );
    assert_eq!(
        journal_bytes(&harness),
        0,
        "nothing a stranger sent was fsynced into the append-only journal"
    );
}

/// The same rule where it is cheapest to get wrong: an empty configured list is
/// **nobody**, not everybody, on the service as well as through the router.
#[tokio::test]
async fn an_empty_witness_list_is_nobody_not_everybody() {
    let harness = Harness::vouched("cosign-empty-means-nobody").await;
    harness.log.publish_epoch(NOW).await.unwrap();
    let head = harness.log.latest_bundle().await.unwrap().head;

    let error = harness
        .log
        .accept_cosignature(&cosignature_over(&head, &Key::from_byte(0xd5)))
        .await
        .expect_err("an unrecognised key is refused");
    assert_eq!(error.wire_code().code(), ERR_NOT_A_WITNESS);
}

// ---------------------------------------------------------------------------
// The control: the fix must not break the configuration it exists to serve.
// ---------------------------------------------------------------------------

/// A configured witness is still accepted, still exactly once, and a stranger
/// is still refused on the same log.
///
/// The second half is the bound the issue asked for and it needs no magic
/// number: storage is idempotent per `witness_pk` and every accepted key must
/// be on the configured list, so one epoch can accumulate at most as many
/// cosignatures as there are configured witnesses. There is no longer any input
/// that grows the journal without bound.
#[tokio::test]
async fn a_configured_witness_is_accepted_exactly_once_and_a_stranger_is_not() {
    let witness = Key::from_byte(0xc1);
    let stranger = Key::from_byte(0xc2);
    let harness = Harness::vouched_with_witnesses("cosign-configured", vec![witness.public]).await;
    harness.log.publish_epoch(NOW).await.unwrap();
    let state = app_state(&harness).await;
    let head = harness.log.latest_bundle().await.unwrap().head;

    let theirs = cosignature_over(&head, &witness);
    assert_eq!(
        post_cosign(&state, &theirs).await,
        (StatusCode::NO_CONTENT, None),
        "the configured witness is accepted"
    );
    assert_eq!(served(&harness).await, 1);
    let after_first = journal_bytes(&harness);
    assert!(after_first > 0, "an accepted cosignature is journalled");

    // A retry after a timeout is ordinary and must not inflate the count a
    // client applies a threshold to, nor grow the journal.
    assert_eq!(
        post_cosign(&state, &theirs).await,
        (StatusCode::NO_CONTENT, None),
        "a retry is idempotent"
    );
    assert_eq!(served(&harness).await, 1);
    assert_eq!(journal_bytes(&harness), after_first);

    let (status, code) = post_cosign(&state, &cosignature_over(&head, &stranger)).await;
    assert_eq!(
        (status, code),
        (StatusCode::BAD_REQUEST, Some(ERR_NOT_A_WITNESS)),
        "a key that is not on the list is refused on a log that has a list"
    );
    assert_eq!(served(&harness).await, 1);
    assert_eq!(journal_bytes(&harness), after_first);
}

// ---------------------------------------------------------------------------
// "every accepted record is permanent" — the other half of the issue's title.
// ---------------------------------------------------------------------------

/// A cosignature already in the journal from a key the log no longer recognises
/// is **not replayed** into what the log serves.
///
/// Without this, the fix above would close the door and leave whatever came
/// through it while it was open: the journal is `fsync`ed and append-only, it is
/// replayed at every startup, and the issue's stated recovery — hand-editing a
/// security-sensitive append-only file — is not a recovery anyone should be
/// asked to perform. Configuration decides what the log serves, at every
/// startup, and the journal keeps the evidence of what it was sent.
#[tokio::test]
async fn a_journalled_cosignature_from_an_unrecognised_key_is_not_served_after_a_restart() {
    let kept = Key::from_byte(0xc1);
    let dropped = Key::from_byte(0xc2);
    let harness =
        Harness::vouched_with_witnesses("cosign-replay", vec![kept.public, dropped.public]).await;
    harness.log.publish_epoch(NOW).await.unwrap();
    let head = harness.log.latest_bundle().await.unwrap().head;
    for key in [&kept, &dropped] {
        harness
            .log
            .accept_cosignature(&cosignature_over(&head, key))
            .await
            .unwrap();
    }
    assert_eq!(
        served(&harness).await,
        2,
        "both were configured, both stored"
    );

    // The operator removes one `witness_pk` line and restarts. Both records are
    // still in the journal — it is append-only and nothing rewrites it.
    let reopened = reopen(&harness, vec![kept.public]).await;
    let bundle = reopened.latest_bundle().await.unwrap();
    let keys: Vec<PublicKey> = bundle
        .cosignatures
        .as_slice()
        .iter()
        .map(|cosignature| cosignature.statement.witness_pk)
        .collect();
    assert_eq!(
        keys,
        vec![kept.public],
        "the log serves what it is configured to recognise, not what it once accepted"
    );

    // And a restart with no `witness_pk` at all serves none of them.
    let unconfigured = reopen(&harness, Vec::new()).await;
    assert_eq!(
        unconfigured
            .latest_bundle()
            .await
            .unwrap()
            .cosignatures
            .len(),
        0
    );
}

/// Reopen the log at the same data directory with the same keys and a possibly
/// different witness list.
async fn reopen(harness: &Harness, witnesses: Vec<PublicKey>) -> f2z_kt::LogService {
    let mut settings =
        f2z_kt::LogSettings::defaults(harness.log_key.public, harness.reset_authority.public)
            .unwrap();
    settings.reset_cooldown_seconds = 60;
    f2z_kt::LogService::open(
        &harness.dir,
        settings,
        Arc::new(FileSigner::from_seed(&[0xa1; 32])),
        f2z_kt::vrf::FileVrf::from_seed([0xb0; 32]).unwrap(),
        harness.log.authority().clone(),
        witnesses,
    )
    .await
    .unwrap()
}

// ---------------------------------------------------------------------------
// §7.2 — a witness that contradicts itself, and the evidence that survives it.
//
// zuu#746. `VerifiedCosignature::contradicts` was made sound by #704 and given
// no caller, so the accountability §7.2 claims was correctly implemented and
// never exercised:
//
// > Two conflicting statements are directly non-repudiable against the witness
// > … **That is what makes a witness accountable rather than merely helpful.**
//
// A witness that signs two different roots for one epoch was detected by
// nothing — the second cosignature was refused as `ERR_INTERNAL`/`Fork`, which
// is evidence against the *log*, and the pair was thrown away.
// ---------------------------------------------------------------------------

/// A cosignature by `key` over an epoch the log published, but naming a root it
/// did not.
///
/// A **genuine** signature over genuinely different contents — not a corrupted
/// byte. That is what self-equivocation is: the witness really did sign both.
fn cosignature_over_another_root(head: &SignedTreeHead, key: &Key) -> WitnessCosignature {
    let statement = WitnessCosignatureTBS {
        label: WitnessCosignatureTBS::label_bytes().unwrap(),
        kt_version: f2z_kt_core::KT_VERSION,
        log_id: head.sth.log_id,
        epoch: head.sth.epoch,
        tree_size: head.sth.tree_size,
        root_hash: f2z_codec::types::Digest::new([0xaa; 32]),
        witness_pk: key.public,
        observed_at_ms: NOW + 60_000,
    };
    assert_ne!(statement.root_hash, head.sth.root_hash);
    let signature = key.sign(&statement.signing_bytes().unwrap());
    let cosignature = WitnessCosignature {
        statement,
        signature,
    };
    cosignature
        .verify()
        .expect("the witness really did sign this one too");
    cosignature
}

/// **zuu#746.** One witness, two genuine cosignatures, one epoch, two roots.
///
/// The finding is named as the witness's fault, both statements are retained
/// verbatim, and the evidence re-establishes itself from its own bytes.
#[tokio::test]
async fn a_witness_that_signs_two_roots_for_one_epoch_is_caught_and_the_pair_is_kept() {
    let witness = Key::from_byte(0xc1);
    let harness =
        Harness::vouched_with_witnesses("cosign-equivocation", vec![witness.public]).await;
    harness.log.publish_epoch(NOW).await.unwrap();
    let head = harness.log.latest_bundle().await.unwrap().head;

    // The honest half, first: this is the statement the log and every client
    // will keep counting.
    let honest = cosignature_over(&head, &witness);
    harness.log.accept_cosignature(&honest).await.unwrap();
    assert_eq!(served(&harness).await, 1);
    assert!(harness.log.witness_equivocations().await.is_empty());

    // The same witness now signs a different root for the same epoch.
    let dishonest = cosignature_over_another_root(&head, &witness);
    let error = harness
        .log
        .accept_cosignature(&dishonest)
        .await
        .expect_err("a witness contradicting itself is not accepted");

    // 1. A named fault, distinct from `Fork`. `Fork` is evidence against the
    //    log; this is a fault of the witness and stands even if the log is
    //    honest, so reporting it as `Fork` would file it against the wrong
    //    party.
    assert!(
        matches!(error, f2z_kt::LogError::Kt(KtError::WitnessEquivocation)),
        "expected KtError::WitnessEquivocation, got {error:?}",
    );

    // 2. Both cosignatures retained, verbatim, so the pair can be handed to
    //    anyone.
    let evidence = harness.log.witness_equivocations().await;
    assert_eq!(evidence.len(), 1);
    let pair = &evidence[0];
    assert_eq!(pair.witness_pk(), &witness.public);
    assert_eq!(pair.epoch(), head.sth.epoch);
    assert_eq!(&pair.a, &honest);
    assert_eq!(&pair.b, &dishonest);

    // 3. And it is non-repudiable with no third document: the two cosignatures
    //    and the key they both name are the whole proof (§7.2). Checked here
    //    the way a stranger would check it — from the encoded bytes alone.
    assert_eq!(pair.verify_evidence(), Ok(()));
    let bytes = pair.encode_canonical().unwrap();
    let decoded = decode_canonical::<f2z_kt_core::cosign::WitnessEquivocation>(&bytes)
        .unwrap()
        .into_value();
    assert_eq!(decoded.verify_evidence(), Ok(()));

    // 4. The earlier, covering cosignature is still served. §8.3 and §9.5 are
    //    explicit that the log's opinion of who is a witness has no bearing on
    //    a client's configured set, so dropping a genuine cosignature would
    //    degrade a client's threshold on the log's own authority.
    assert_eq!(served(&harness).await, 1);
}

/// The evidence survives a restart, and is re-checked on the way back in.
#[tokio::test]
async fn a_journalled_equivocation_is_replayed_and_re_verified() {
    let witness = Key::from_byte(0xc1);
    let harness =
        Harness::vouched_with_witnesses("cosign-equivocation-replay", vec![witness.public]).await;
    harness.log.publish_epoch(NOW).await.unwrap();
    let head = harness.log.latest_bundle().await.unwrap().head;

    harness
        .log
        .accept_cosignature(&cosignature_over(&head, &witness))
        .await
        .unwrap();
    harness
        .log
        .accept_cosignature(&cosignature_over_another_root(&head, &witness))
        .await
        .unwrap_err();

    assert!(
        std::fs::metadata(harness.dir.join("equivocations.log"))
            .unwrap()
            .len()
            > 0,
        "the pair was fsynced, not held in memory until the process died",
    );

    let reopened = reopen(&harness, vec![witness.public]).await;
    let evidence = reopened.witness_equivocations().await;
    assert_eq!(evidence.len(), 1);
    assert_eq!(evidence[0].verify_evidence(), Ok(()));
    assert_eq!(evidence[0].witness_pk(), &witness.public);
}

/// A retry is still a retry. `contradicts` excludes `observed_at_ms` on purpose
/// — the same root seen at two times is normal, not a conflict — and the
/// idempotency the fix must not break is exactly that case.
#[tokio::test]
async fn re_sending_the_same_root_at_a_later_time_is_not_an_equivocation() {
    let witness = Key::from_byte(0xc1);
    let harness =
        Harness::vouched_with_witnesses("cosign-equivocation-retry", vec![witness.public]).await;
    harness.log.publish_epoch(NOW).await.unwrap();
    let head = harness.log.latest_bundle().await.unwrap().head;

    harness
        .log
        .accept_cosignature(&cosignature_over(&head, &witness))
        .await
        .unwrap();

    // Same four fields, later clock, fresh genuine signature.
    let mut later = cosignature_over(&head, &witness);
    later.statement.observed_at_ms = NOW + 120_000;
    later.signature = witness.sign(&later.statement.signing_bytes().unwrap());
    assert_ne!(later, cosignature_over(&head, &witness));

    harness
        .log
        .accept_cosignature(&later)
        .await
        .expect("a retry is idempotent, not an accusation");
    assert_eq!(served(&harness).await, 1);
    assert!(harness.log.witness_equivocations().await.is_empty());
}

/// A witness that has sent **nothing else** for the epoch and signs a root the
/// log did not publish is still `Fork`, not equivocation.
///
/// One statement disagreeing with the log's head is a disagreement between two
/// parties. It needs the log's own head to state at all, and the log is one of
/// the two — so it is not the self-contradiction §7.2 makes non-repudiable, and
/// calling it one would be an accusation with only one signature behind it.
#[tokio::test]
async fn a_first_cosignature_over_an_unpublished_root_is_still_a_fork() {
    let witness = Key::from_byte(0xc1);
    let harness = Harness::vouched_with_witnesses("cosign-first-fork", vec![witness.public]).await;
    harness.log.publish_epoch(NOW).await.unwrap();
    let head = harness.log.latest_bundle().await.unwrap().head;

    let error = harness
        .log
        .accept_cosignature(&cosignature_over_another_root(&head, &witness))
        .await
        .expect_err("the log did not publish that root");
    assert!(
        matches!(error, f2z_kt::LogError::Kt(KtError::Fork)),
        "expected KtError::Fork, got {error:?}",
    );
    assert!(harness.log.witness_equivocations().await.is_empty());
}
