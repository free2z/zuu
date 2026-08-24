//! Property tests for the four rules where a single wrong branch loses
//! ciphertext or makes a signature valid where it must not be.
//!
//! Each one is stated as an invariant over generated inputs rather than as a
//! handful of hand-picked cases, because the failure mode of every one of them
//! is an edge: an off-by-one at the acknowledgement watermark, a boundary
//! millisecond in the timestamp window, a second `BIND_SEND` that arrives with
//! the same key as the first, a relay id that happens to share a prefix.
//!
//! - **Acknowledgement** (§8.1, §8.2, §8.3) — cumulative, monotone, idempotent,
//!   and never above the highest index ever appended.
//! - **Anti-replay** (§5.5) — accepted exactly inside `±clock_skew_ms`, and
//!   never twice for one `(signer_key, nonce)`.
//! - **Transcript domain separation** (§5.2, §5.3) — a signature made for one
//!   relay, or on one TLS session, verifies at that relay on that session and
//!   nowhere else. This is the property whose absence lets relay A replay a
//!   recipient's cumulative `ACK` at relay B so that **B deletes ciphertext the
//!   recipient never received from B**.
//! - **Bind-once** (§7.3) — the first `BIND_SEND` wins, forever, and no later
//!   attempt with any key changes what is bound.

// Test code, run on the host by a person reading the failure. The workspace
// denies these because a panic in the relay's parser is a remote denial of
// service; neither hazard exists here.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_codec::ErrorCode;
use f2z_codec::commands::AckRequest;
use f2z_codec::padding::PaddingBuckets;
use f2z_codec::transcript::TranscriptBuilder;
use f2z_codec::types::{ChannelBinding, Nonce, PublicKey, QueueAddress, RelayId};
use f2z_relay_proto::command::{CommandVerifier, SignedCommand, ops};
use f2z_relay_proto::error::ProtoError;
use f2z_relay_proto::key::SigningKey;
use f2z_relay_proto::queue::{QueueKind, QueueState};
use f2z_relay_proto::replay::{ReplayKey, SeenSet, TimestampWindow};
use proptest::prelude::*;

const NOW: u64 = 1_800_000_000_000;

fn verifier(relay_id: RelayId, binding: ChannelBinding) -> CommandVerifier {
    CommandVerifier::new(
        TranscriptBuilder::new(f2z_relay_proto::PROTOCOL_VERSION, relay_id, binding),
        TimestampWindow::default(),
        SeenSet::new(240_000, 4_096),
        PaddingBuckets::default(),
    )
}

proptest! {
    /// §8: whatever sequence of appends and acks arrives, the watermark never
    /// moves backwards, never passes the highest appended index, and a repeat
    /// of any accepted ack changes nothing.
    #[test]
    fn acknowledgement_is_cumulative_monotone_and_bounded(
        operations in prop::collection::vec(
            prop_oneof![
                (1u64..4).prop_map(Operation::Append),
                (0u64..12).prop_map(Operation::Ack),
            ],
            1..60,
        )
    ) {
        let mut queue = QueueState::create(QueueKind::Standard, PublicKey::new([1u8; 32]));
        let mut watermark: Option<u64> = None;

        for operation in operations {
            match operation {
                Operation::Append(count) => {
                    for _ in 0..count {
                        let expected = queue.next_index();
                        prop_assert_eq!(queue.append().unwrap(), expected);
                    }
                }
                Operation::Ack(up_to) => {
                    let highest = queue.next_index().checked_sub(1);
                    match queue.ack(up_to) {
                        Ok(outcome) => {
                            // Only ever inside what was appended.
                            prop_assert!(highest.is_some_and(|highest| up_to <= highest));

                            let advanced = match watermark {
                                Some(previous) if up_to <= previous => 0,
                                Some(previous) => up_to - previous,
                                None => up_to + 1,
                            };
                            prop_assert_eq!(outcome.acknowledged, advanced);
                            if advanced > 0 {
                                watermark = Some(up_to);
                            }

                            // Monotone.
                            prop_assert_eq!(queue.acked_through(), watermark);
                            // Idempotent: the same ack again does nothing.
                            let repeat = queue.ack(up_to).unwrap();
                            prop_assert_eq!(repeat.acknowledged, 0);
                            prop_assert_eq!(queue.acked_through(), watermark);
                            // Cumulative: `pending` is exactly what is left.
                            prop_assert_eq!(
                                outcome.pending,
                                queue.next_index() - queue.first_unacked()
                            );
                        }
                        Err(error) => {
                            // The only refusal §8 defines, and it never moves
                            // the watermark — this is the rule that makes
                            // pre-acking impossible.
                            prop_assert_eq!(error, ProtoError::Wire(ErrorCode::AckTooHigh));
                            prop_assert!(!highest.is_some_and(|highest| up_to <= highest));
                            prop_assert_eq!(queue.acked_through(), watermark);
                        }
                    }
                }
            }
            // A read never goes below the watermark, and never errors.
            prop_assert!(queue.read_from(0) >= queue.first_unacked());
        }
    }

    /// §8.2: no `ACK` above the highest index ever appended is ever accepted,
    /// even after the queue has been fully drained — "ever appended" is
    /// `next_index`, not what is currently stored.
    #[test]
    fn a_drained_queue_still_refuses_a_pre_ack(
        appended in 1u64..50,
        beyond in 1u64..50,
    ) {
        let mut queue = QueueState::create(QueueKind::Standard, PublicKey::new([1u8; 32]));
        for _ in 0..appended {
            queue.append().unwrap();
        }
        queue.ack(appended - 1).unwrap();
        prop_assert_eq!(queue.pending(), 0);
        prop_assert_eq!(
            queue.ack(appended - 1 + beyond),
            Err(ProtoError::Wire(ErrorCode::AckTooHigh))
        );
        prop_assert_eq!(queue.acked_through(), Some(appended - 1));
    }

    /// §5.5: the timestamp window accepts exactly `|now - timestamp| <=
    /// clock_skew_ms`, in both directions, with no wrap at the ends of the
    /// range.
    #[test]
    fn the_timestamp_window_is_exactly_the_published_skew(
        skew in 0u64..1_000_000,
        now in 0u64..u64::MAX,
        timestamp in 0u64..u64::MAX,
    ) {
        let window = TimestampWindow::new(skew);
        let inside = now.abs_diff(timestamp) <= skew;
        prop_assert_eq!(window.check(now, timestamp).is_ok(), inside);
    }

    /// §5.5: a `(signer_key, nonce)` pair is accepted at most once inside its
    /// retention, and a full set refuses rather than evicting a live entry.
    #[test]
    fn the_seen_set_never_forgets_a_live_entry(
        pairs in prop::collection::vec((any::<[u8; 32]>(), any::<[u8; 16]>()), 1..40),
        capacity in 1usize..40,
    ) {
        let mut seen = SeenSet::new(240_000, capacity);
        let mut accepted: Vec<ReplayKey> = Vec::new();

        for (key_bytes, nonce_bytes) in pairs {
            let key = ReplayKey::new(PublicKey::new(key_bytes), Nonce::new(nonce_bytes));
            match seen.commit(NOW, key) {
                Ok(()) => {
                    prop_assert!(!accepted.contains(&key));
                    accepted.push(key);
                }
                Err(error) => {
                    if accepted.contains(&key) {
                        prop_assert_eq!(error, ProtoError::Wire(ErrorCode::Replay));
                    } else {
                        // Only ever because the bound was reached — never
                        // because something was thrown away to make room.
                        prop_assert_eq!(error, ProtoError::Wire(ErrorCode::Backpressure));
                        prop_assert_eq!(seen.len(), capacity);
                    }
                }
            }
            // Everything ever accepted is still held.
            for held in &accepted {
                prop_assert!(seen.contains(held));
            }
        }
    }

    /// §5.2 and §5.3: a signed command verifies at the relay and on the session
    /// it was made for, and at no other. This is the ACK-replay attack of §5.2
    /// stated as a property.
    #[test]
    fn a_signed_command_verifies_at_exactly_one_relay_on_exactly_one_session(
        seed in any::<[u8; 32]>(),
        relay_a in any::<[u8; 32]>(),
        relay_b in any::<[u8; 32]>(),
        binding_a in any::<[u8; 32]>(),
        binding_b in any::<[u8; 32]>(),
        address in any::<[u8; 32]>(),
        nonce in any::<[u8; 16]>(),
        request_id in 1u32..u32::MAX,
        up_to_index in any::<u64>(),
    ) {
        prop_assume!(relay_a != relay_b);
        prop_assume!(binding_a != binding_b);
        prop_assume!(address != [0u8; 32]);

        let key = SigningKey::from_seed(&seed);
        let signed = SignedCommand::<ops::Ack>::create(
            &TranscriptBuilder::new(
                f2z_relay_proto::PROTOCOL_VERSION,
                RelayId::new(relay_a),
                ChannelBinding::new(binding_a),
            ),
            request_id,
            QueueAddress::new(address),
            NOW,
            Nonce::new(nonce),
            &key,
            &AckRequest { up_to_index },
        ).unwrap();
        let request = signed.request().unwrap();

        // The relay it was made for, on the session it was made on.
        let verified = verifier(RelayId::new(relay_a), ChannelBinding::new(binding_a))
            .verify::<ops::Ack>(NOW, request_id, &request)
            .unwrap();
        prop_assert_eq!(verified.signer_key(), key.public_key());
        prop_assert_eq!(verified.body().up_to_index, up_to_index);

        // A second relay, handed the frame verbatim by the first.
        prop_assert_eq!(
            verifier(RelayId::new(relay_b), ChannelBinding::new(binding_a))
                .verify::<ops::Ack>(NOW, request_id, &request)
                .map(|_| ()),
            Err(ProtoError::Wire(ErrorCode::BadSignature))
        );
        // The same relay, a different TLS session.
        prop_assert_eq!(
            verifier(RelayId::new(relay_a), ChannelBinding::new(binding_b))
                .verify::<ops::Ack>(NOW, request_id, &request)
                .map(|_| ()),
            Err(ProtoError::Wire(ErrorCode::BadSignature))
        );
        // And a different `request_id` on the right relay and session, because
        // the id is covered by the transcript too.
        prop_assert_eq!(
            verifier(RelayId::new(relay_a), ChannelBinding::new(binding_a))
                .verify::<ops::Ack>(NOW, request_id.wrapping_add(1).max(1), &request)
                .map(|_| ()),
            Err(ProtoError::Wire(ErrorCode::BadSignature))
        );
    }

    /// §7.3: whatever sequence of `BIND_SEND` attempts arrives, exactly the
    /// first one takes effect and nothing later changes the bound key —
    /// including a repeat of the same key, which §7.3 names explicitly.
    #[test]
    fn binding_is_once_only_whatever_arrives(
        attempts in prop::collection::vec(prop::sample::select(vec![0u8, 1, 2]), 1..20),
        kind in prop::sample::select(vec![QueueKind::Standard, QueueKind::Contact]),
    ) {
        let mut queue = QueueState::create(kind, PublicKey::new([9u8; 32]));
        let mut bound: Option<PublicKey> = None;

        for attempt in attempts {
            let candidate = PublicKey::new([attempt; 32]);
            let result = queue.bind_send(&candidate);
            match kind {
                QueueKind::Contact => {
                    // §12.2: always, for everyone. There is no key that
                    // authorizes writing to a contact queue, which means there
                    // is no key that can be stolen, squatted or lost.
                    prop_assert_eq!(result, Err(ProtoError::Wire(ErrorCode::NotPermitted)));
                    prop_assert_eq!(queue.send_key(), None);
                }
                QueueKind::Standard => match bound {
                    None => {
                        prop_assert!(result.is_ok());
                        bound = Some(candidate);
                    }
                    Some(_) => {
                        prop_assert_eq!(result, Err(ProtoError::Wire(ErrorCode::AlreadyBound)));
                    }
                },
            }
            prop_assert_eq!(queue.send_key(), bound);
        }

        // Only the bound key can ever authorize an append, and every other
        // refusal is indistinguishable from a full queue (§6.3).
        if let Some(bound) = bound {
            prop_assert!(queue.authorize_send(&bound).is_ok());
            prop_assert_eq!(
                queue.authorize_send(&PublicKey::new([0xff; 32])),
                Err(ProtoError::Wire(ErrorCode::Unavailable))
            );
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum Operation {
    Append(u64),
    Ack(u64),
}
