//! Restarting a log must produce the same tree, or refuse to start.
//!
//! `KT.md` §11.2 tells us to treat storage as security-critical rather than as
//! plumbing, and gives the reason: NCC Group explicitly deprioritised `akd`'s
//! "storage caching and parallelization strategy", and facebook/akd#495 — the
//! append-only bypass that sets our version floor — was in exactly that
//! unreviewed region.
//!
//! The durable artefact here is the log's own history and the `akd` tree is
//! **derived** from it by replaying `publish()`. That design is only worth
//! anything if the replay is checked, so these tests are about the check: a
//! restart reproduces every root the log signed, and a journal that has been
//! edited fails at startup instead of quietly serving proofs against a root
//! nobody cosigned.

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

use std::sync::Arc;

use f2z_kt::testing::{EntryBuilder, Harness, Identity};
use f2z_kt_core::types::Handle;

const NOW: u64 = 1_700_000_100_000;

/// Reopen the log at the same data directory with the same keys.
async fn reopen(harness: &Harness) -> f2z_kt::Result<f2z_kt::LogService> {
    let mut settings =
        f2z_kt::LogSettings::defaults(harness.log_key.public, harness.reset_authority.public)
            .unwrap();
    settings.reset_cooldown_seconds = 60;
    let authority = harness.log.authority().clone();
    f2z_kt::LogService::open(
        &harness.dir,
        settings,
        Arc::new(f2z_kt::FileSigner::from_seed(&[0xa1; 32])),
        f2z_kt::vrf::FileVrf::from_seed([0xb0; 32]).unwrap(),
        authority,
        Vec::new(),
    )
    .await
}

#[tokio::test]
async fn a_restart_reproduces_every_root_the_log_signed() {
    let harness = Harness::vouched("dur-replay").await;
    harness.log.publish_epoch(NOW).await.unwrap();

    let mut expected = Vec::new();
    for (index, handle) in ["alice", "bob", "carol"].iter().enumerate() {
        let identity = Identity::from_byte(u8::try_from(index).unwrap().wrapping_add(1));
        let entry = EntryBuilder::first(harness.log_id, handle, &identity)
            .device(0x30, &identity.isk)
            .same_key(&identity.dak);
        harness
            .log
            .submit(&harness.envelope(&entry, &identity, NOW), NOW)
            .await
            .unwrap();
        expected.push(harness.log.publish_epoch(NOW).await.unwrap());
    }

    // A restart is a full replay: three epochs, three batches, every root
    // recomputed and compared against what was signed. If `akd` ever stops
    // being deterministic for our configuration, this is where we find out.
    let reopened = reopen(&harness).await.unwrap();
    assert_eq!(reopened.current_epoch().await, 4);

    let head = reopened.latest_bundle().await.unwrap().head;
    let last = expected.last().unwrap();
    assert_eq!(head.sth.root_hash, last.sth.root_hash);
    assert_eq!(head.sth.tree_size, last.sth.tree_size);
    assert_eq!(head.sth.epoch, last.sth.epoch);

    // And it can still serve a proof against that root.
    let handle = Handle::new(b"bob".to_vec()).unwrap();
    let response = reopened.lookup(&handle).await.unwrap();
    response.validate().unwrap();
    assert_eq!(
        f2z_kt::Presence::from_code(response.presence).unwrap(),
        f2z_kt::Presence::Present
    );
}

#[tokio::test]
async fn a_submission_accepted_but_not_yet_published_survives_a_restart() {
    // §5.2's merge promise is signed. A submission the log accepted, issued a
    // receipt for, and then forgot across a restart is a broken promise with
    // the victim holding the evidence — so the journal has to carry the pending
    // batch, not just the published epochs.
    let harness = Harness::vouched("dur-pending").await;
    harness.log.publish_epoch(NOW).await.unwrap();

    let alice = Identity::from_byte(1);
    let entry = EntryBuilder::first(harness.log_id, "alice", &alice).same_key(&alice.dak);
    let receipt = harness
        .log
        .submit(&harness.envelope(&entry, &alice, NOW), NOW)
        .await
        .unwrap();
    assert_eq!(harness.log.pending_count().await, 1);

    let reopened = reopen(&harness).await.unwrap();
    assert_eq!(
        reopened.pending_count().await,
        1,
        "the accepted submission is still owed an epoch"
    );

    let head = reopened.publish_epoch(NOW + 1_000).await.unwrap();
    assert!(
        head.sth.published_at_ms <= receipt.receipt.merge_by_ms,
        "the promise was kept"
    );

    let handle = Handle::new(b"alice".to_vec()).unwrap();
    let response = reopened.lookup(&handle).await.unwrap();
    assert_eq!(
        f2z_kt::Presence::from_code(response.presence).unwrap(),
        f2z_kt::Presence::Present
    );
}

#[tokio::test]
async fn an_edited_journal_refuses_to_start() {
    // The whole value of deriving the tree rather than storing it: tampering is
    // caught by the root-hash comparison, at startup, loudly. A log that
    // started anyway would serve inclusion proofs — perfectly valid ones —
    // for an entry nobody authorized.
    let harness = Harness::vouched("dur-tamper").await;
    harness.log.publish_epoch(NOW).await.unwrap();

    let alice = Identity::from_byte(1);
    let entry = EntryBuilder::first(harness.log_id, "alice", &alice).same_key(&alice.dak);
    harness
        .log
        .submit(&harness.envelope(&entry, &alice, NOW), NOW)
        .await
        .unwrap();
    harness.log.publish_epoch(NOW).await.unwrap();

    // Flip a byte deep inside the published submission record.
    let path = harness.dir.join("submissions.log");
    let mut bytes = std::fs::read(&path).unwrap();
    let index = bytes.len() / 2;
    bytes[index] ^= 0xff;
    std::fs::write(&path, &bytes).unwrap();

    // Any of these is a correct refusal, and which one fires depends on which
    // byte the flip landed on — the record framing, §4.4, the assertion layer,
    // or the recomputed root. What must never happen is a log that starts.
    let error = reopen(&harness).await.unwrap_err();
    let rendered = format!("{error}");
    assert!(
        rendered.contains("does not decode")
            || rendered.contains("no longer admits")
            || rendered.contains("different root hash")
            || rendered.contains("tree_size"),
        "unexpected: {rendered}"
    );
}

#[tokio::test]
async fn a_truncated_epoch_journal_refuses_rather_than_reordering_the_history() {
    // Losing the tail of `epochs.log` means the log no longer holds a head it
    // signed. `KT.md` §6.3 rule 7 forbids a verifier from skipping an epoch, so
    // a log that cannot produce one has made every audit range across it
    // unverifiable — and the submissions it covered would be replayed into a
    // *different* epoch on the next publish, changing roots the log already
    // signed.
    let harness = Harness::vouched("dur-truncate").await;
    harness.log.publish_epoch(NOW).await.unwrap();

    let alice = Identity::from_byte(1);
    let entry = EntryBuilder::first(harness.log_id, "alice", &alice).same_key(&alice.dak);
    harness
        .log
        .submit(&harness.envelope(&entry, &alice, NOW), NOW)
        .await
        .unwrap();
    harness.log.publish_epoch(NOW).await.unwrap();

    let path = harness.dir.join("epochs.log");
    let bytes = std::fs::read(&path).unwrap();
    // Drop the last record entirely, leaving whole records behind — this is not
    // a torn write, it is a shorter history.
    std::fs::write(&path, &bytes[..bytes.len() / 2]).unwrap();

    // The submission for epoch 2 is still in `submissions.log` and is now
    // pending again. It must not be silently re-published into a *new* epoch 2
    // with a different root than the one already signed and possibly cosigned.
    match reopen(&harness).await {
        Err(error) => {
            let rendered = format!("{error}");
            assert!(
                rendered.contains("does not decode")
                    || rendered.contains("no longer admits")
                    || rendered.contains("watermark"),
                "unexpected: {rendered}"
            );
        }
        Ok(reopened) => {
            // If the truncation happened to land on a record boundary the log
            // legitimately comes up one epoch shorter with the entry pending.
            // What must NOT happen is a shorter history that still claims the
            // longer one's roots.
            assert_eq!(reopened.current_epoch().await, 1);
            assert_eq!(reopened.pending_count().await, 1);
        }
    }
}

#[tokio::test]
async fn a_journal_signed_by_another_key_refuses_to_start() {
    // Pointing a log at somebody else's data directory, or rotating the signing
    // key without §6.4's transition, would otherwise produce a log that serves
    // heads it cannot re-sign and cannot chain from.
    let harness = Harness::vouched("dur-wrong-key").await;
    harness.log.publish_epoch(NOW).await.unwrap();

    let mut settings =
        f2z_kt::LogSettings::defaults(harness.log_key.public, harness.reset_authority.public)
            .unwrap();
    settings.reset_cooldown_seconds = 60;
    let error = f2z_kt::LogService::open(
        &harness.dir,
        settings,
        // A different signing key over the same journals.
        Arc::new(f2z_kt::FileSigner::from_seed(&[0xff; 32])),
        f2z_kt::vrf::FileVrf::from_seed([0xb0; 32]).unwrap(),
        harness.log.authority().clone(),
        Vec::new(),
    )
    .await
    .unwrap_err();
    assert!(format!("{error}").contains("does not verify"));
}
