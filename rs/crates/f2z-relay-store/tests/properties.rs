//! The rules that lose messages when they are wrong, checked against **both**
//! stores.
//!
//! Everything here runs twice: once against [`SqliteStore`], where a `NOT
//! NULL`, a `PRIMARY KEY` or a `MAX(0, …)` might be doing the work, and once
//! against [`MemoryStore`], where nothing enforces anything except the code
//! that is supposed to. A rule that only holds in one of them is a rule that
//! does not hold.

// Test code, run on the host by a person reading the failure. The workspace
// denies these because a panic in the relay's request path is a remote denial
// of service; neither hazard exists in a test harness.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_codec::ErrorCode;
use f2z_codec::types::{Payload, PublicKey, QueueAddress};
use f2z_relay_proto::queue::{AppendQuota, QueueKind};
use f2z_relay_store::{
    Append, ExpiryReason, MemoryStore, QueueSpec, ReadWindow, RelayStore, SendAuth, SqliteStore,
    StoreError,
};
use proptest::prelude::*;

const RECV: QueueAddress = QueueAddress::new([0x11; 32]);
const SEND: QueueAddress = QueueAddress::new([0x22; 32]);
const RECV_KEY: PublicKey = PublicKey::new([0x33; 32]);
const SEND_KEY: PublicKey = PublicKey::new([0x44; 32]);
const OTHER_KEY: PublicKey = PublicKey::new([0x55; 32]);
const ABSENT: QueueAddress = QueueAddress::new([0x99; 32]);

fn spec(kind: QueueKind, quota: AppendQuota, message_ttl: u32, idle_ttl: u32) -> QueueSpec {
    QueueSpec {
        kind,
        recv_addr: RECV,
        send_addr: SEND,
        recv_key: RECV_KEY,
        message_ttl_seconds: message_ttl,
        idle_ttl_seconds: idle_ttl,
        quota,
        created_at_ms: 1_000,
    }
}

fn generous() -> AppendQuota {
    AppendQuota {
        max_messages: 4_096,
        max_bytes: 1 << 24,
    }
}

/// Run one check against both stores.
///
/// The `SqliteStore` half uses a real file rather than `:memory:` — the same
/// journalling, the same pragmas, the same `WITHOUT ROWID` page layout the
/// relay will run on.
fn both(check: impl Fn(&dyn RelayStore, &str)) {
    let directory = tempfile::tempdir().unwrap();
    let sqlite = SqliteStore::open(directory.path().join("relay.sqlite3")).unwrap();
    check(&sqlite, "SqliteStore");
    let memory = MemoryStore::new();
    check(&memory, "MemoryStore");
}

fn code(error: &StoreError) -> ErrorCode {
    error.error_code()
}

fn append_at(store: &dyn RelayStore, payload: &Payload, at_ms: u64) -> Result<u64, StoreError> {
    store
        .append(&Append {
            send_addr: SEND,
            auth: SendAuth::Signed(SEND_KEY),
            payload,
            received_at_ms: at_ms,
        })
        .map(|committed| committed.into_inner().index)
}

fn read_all(store: &dyn RelayStore, now_ms: u64) -> Vec<u64> {
    store
        .read(
            &RECV,
            &RECV_KEY,
            ReadWindow {
                from_index: 0,
                max_messages: u16::MAX,
                max_bytes: u32::MAX,
            },
            now_ms,
        )
        .unwrap()
        .messages
        .into_iter()
        .map(|message| message.index)
        .collect()
}

// ---------------------------------------------------------------------------
// §7.3 — bind-once.
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// §7.3: "There is no rebind, no unbind, and no reset by the recv key."
    /// Whatever sequence of keys arrives, the first one wins forever — including
    /// a second attempt with the *same* key, which §7.4 calls out explicitly
    /// because that is what a legitimate sender's retry looks like and it must
    /// still be the loud failure.
    #[test]
    fn binding_is_once_only_whatever_arrives(
        keys in prop::collection::vec(0u8..8, 1..8),
    ) {
        both(|store, name| {
            let _ = store.create_queue(&spec(QueueKind::Standard, generous(), 3_600, 86_400)).unwrap();
            let mut bound: Option<PublicKey> = None;
            for byte in &keys {
                let key = PublicKey::new([*byte; 32]);
                let outcome = store.bind_send(&SEND, &key, 2_000);
                match bound {
                    None => {
                        assert!(outcome.is_ok(), "{name}: the first bind must succeed");
                        bound = Some(key);
                    }
                    Some(_) => {
                        let error = outcome.expect_err("{name}: a second bind never succeeds");
                        assert_eq!(code(&error), ErrorCode::AlreadyBound, "{name}");
                    }
                }
            }
            let record = store.queue_by_recv(&RECV, &RECV_KEY).unwrap();
            assert_eq!(record.state.send_key(), bound, "{name}");
            let _ = store.delete_queue(&RECV, &RECV_KEY).unwrap();
        });
    }
}

// ---------------------------------------------------------------------------
// §8 — the acknowledgement arithmetic, over persisted state.
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    /// §8.1, §8.2, §8.3 together, because they are only safe together:
    /// cumulative (an ack deletes every index at or below it), monotone (an ack
    /// below the watermark is a no-op and the watermark never moves back),
    /// idempotent (a retry after a lost response is safe), and bounded (an ack
    /// above the highest index ever appended is an error and moves nothing).
    #[test]
    fn acknowledgement_is_cumulative_monotone_idempotent_and_bounded(
        appended in 1usize..24,
        acks in prop::collection::vec(0u64..32, 1..16),
    ) {
        both(|store, name| {
            let _ = store.create_queue(&spec(QueueKind::Standard, generous(), 86_400, 86_400)).unwrap();
            let _ = store.bind_send(&SEND, &SEND_KEY, 1_000).unwrap();
            let payload = Payload::new(vec![0u8; 64]).unwrap();
            for _ in 0..appended {
                append_at(store, &payload, 2_000).unwrap();
            }
            let highest = (appended - 1) as u64;

            let mut watermark: Option<u64> = None;
            for up_to in &acks {
                let outcome = store.ack(&RECV, &RECV_KEY, *up_to, 3_000);
                if *up_to > highest {
                    // §8.2: pre-acking is the failure that would let a reader
                    // black-hole its own queue while senders kept seeing
                    // successful, empty APPEND responses.
                    let error = outcome.expect_err("a pre-ack must fail");
                    assert_eq!(code(&error), ErrorCode::AckTooHigh, "{name}");
                } else {
                    let outcome = outcome.unwrap().into_inner();
                    let advanced = match watermark {
                        Some(previous) if *up_to <= previous => 0,
                        Some(previous) => up_to - previous,
                        None => up_to + 1,
                    };
                    assert_eq!(outcome.acknowledged, advanced, "{name}: ack {up_to}");
                    if advanced > 0 {
                        watermark = Some(*up_to);
                    }
                }

                // The watermark never moves backwards, whatever arrived.
                let record = store.queue_by_recv(&RECV, &RECV_KEY).unwrap();
                assert_eq!(record.state.acked_through(), watermark, "{name}");

                // Cumulative: every index at or below the watermark is gone,
                // and every index above it is still there.
                let first_unacked = watermark.map_or(0, |value| value + 1);
                let expected: Vec<u64> = (first_unacked..=highest).collect();
                assert_eq!(read_all(store, 4_000), expected, "{name}");
            }
            let _ = store.delete_queue(&RECV, &RECV_KEY).unwrap();
        });
    }
}

#[test]
fn a_read_below_the_watermark_returns_from_the_watermark_and_never_errors() {
    both(|store, name| {
        let _ = store
            .create_queue(&spec(QueueKind::Standard, generous(), 86_400, 86_400))
            .unwrap();
        let _ = store.bind_send(&SEND, &SEND_KEY, 1_000).unwrap();
        let payload = Payload::new(vec![7u8; 32]).unwrap();
        for _ in 0..4 {
            append_at(store, &payload, 2_000).unwrap();
        }
        let _ = store.ack(&RECV, &RECV_KEY, 1, 3_000).unwrap();

        // §6.2: "the relay MUST NOT resurrect deleted messages and MUST NOT
        // error", so a client recovering from a crash can simply ask for
        // everything it might have missed.
        let page = store
            .read(
                &RECV,
                &RECV_KEY,
                ReadWindow {
                    from_index: 0,
                    max_messages: 16,
                    max_bytes: u32::MAX,
                },
                4_000,
            )
            .unwrap();
        let indices: Vec<u64> = page.messages.iter().map(|message| message.index).collect();
        assert_eq!(indices, vec![2, 3], "{name}");
        assert_eq!(page.next_index, 4, "{name}");
        assert_eq!(page.pending, 2, "{name}");
        assert!(!page.has_more, "{name}");
        let _ = store.delete_queue(&RECV, &RECV_KEY).unwrap();
    });
}

#[test]
fn a_read_always_yields_one_message_even_under_an_impossible_byte_budget() {
    both(|store, name| {
        let _ = store
            .create_queue(&spec(QueueKind::Standard, generous(), 86_400, 86_400))
            .unwrap();
        let _ = store.bind_send(&SEND, &SEND_KEY, 1_000).unwrap();
        let payload = Payload::new(vec![7u8; 1024]).unwrap();
        append_at(store, &payload, 2_000).unwrap();
        append_at(store, &payload, 2_000).unwrap();

        // A `max_bytes` below the smallest padding bucket would otherwise
        // return an empty page with `has_more = 1` forever, and a reader that
        // cannot make progress cannot acknowledge — which under delete-on-ack
        // is a queue that fills and then refuses its sender.
        let page = store
            .read(
                &RECV,
                &RECV_KEY,
                ReadWindow {
                    from_index: 0,
                    max_messages: 16,
                    max_bytes: 1,
                },
                3_000,
            )
            .unwrap();
        assert_eq!(page.messages.len(), 1, "{name}");
        assert!(page.has_more, "{name}");
        let _ = store.delete_queue(&RECV, &RECV_KEY).unwrap();
    });
}

// ---------------------------------------------------------------------------
// §13.1 layer 2 and §13.2 — quotas refuse, and never evict.
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    /// §13.2: "Under no circumstance does a relay delete an unacknowledged
    /// message to free space." The property is therefore two-sided — a refusal
    /// happens *and* nothing already stored changes — because a store that
    /// evicted the oldest message and then accepted the new one would satisfy a
    /// test that only checked the cap.
    #[test]
    fn a_full_queue_refuses_and_never_evicts(
        max_messages in 1u64..8,
        attempts in 1usize..16,
    ) {
        both(|store, name| {
            let quota = AppendQuota { max_messages, max_bytes: 1 << 20 };
            let _ = store.create_queue(&spec(QueueKind::Standard, quota, 86_400, 86_400)).unwrap();
            let _ = store.bind_send(&SEND, &SEND_KEY, 1_000).unwrap();
            let payload = Payload::new(vec![3u8; 128]).unwrap();

            let mut accepted = 0u64;
            for _ in 0..attempts {
                match append_at(store, &payload, 2_000) {
                    Ok(_) => accepted += 1,
                    Err(error) => {
                        // §6.3: never a distinguishable code. "Queue full" and
                        // "no such queue" must look identical to a sender.
                        assert_eq!(code(&error), ErrorCode::Unavailable, "{name}");
                    }
                }
                assert!(accepted <= max_messages, "{name}");
                let stored = read_all(store, 3_000);
                assert_eq!(stored.len() as u64, accepted, "{name}: nothing was evicted");
                // The surviving messages are the *oldest* ones, contiguously
                // from zero: an eviction policy would show up as a moved floor.
                assert_eq!(stored, (0..accepted).collect::<Vec<_>>(), "{name}");
            }
            let _ = store.delete_queue(&RECV, &RECV_KEY).unwrap();
        });
    }
}

#[test]
fn the_byte_cap_refuses_the_append_that_would_cross_it() {
    both(|store, name| {
        let quota = AppendQuota {
            max_messages: 100,
            max_bytes: 2_048,
        };
        let _ = store
            .create_queue(&spec(QueueKind::Standard, quota, 86_400, 86_400))
            .unwrap();
        let _ = store.bind_send(&SEND, &SEND_KEY, 1_000).unwrap();
        let payload = Payload::new(vec![3u8; 1024]).unwrap();

        assert!(append_at(store, &payload, 2_000).is_ok(), "{name}");
        assert!(append_at(store, &payload, 2_000).is_ok(), "{name}");
        let error = append_at(store, &payload, 2_000).expect_err("the third crosses 2 KiB");
        assert_eq!(code(&error), ErrorCode::Unavailable, "{name}");
        assert_eq!(read_all(store, 3_000).len(), 2, "{name}");

        // Acking makes room, which is the only mechanism that ever does.
        let _ = store.ack(&RECV, &RECV_KEY, 0, 3_000).unwrap();
        assert!(append_at(store, &payload, 4_000).is_ok(), "{name}");
        let _ = store.delete_queue(&RECV, &RECV_KEY).unwrap();
    });
}

// ---------------------------------------------------------------------------
// §7.7 — the two timers.
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    /// A message is readable strictly before its deadline and gone strictly
    /// after, whether or not a sweep has run — a relay that swept lazily and
    /// served expired ciphertext in between would be retaining past its own
    /// published policy.
    #[test]
    fn a_message_expires_exactly_at_its_deadline(
        ttl_seconds in 1u32..600,
        offset_seconds in 0u32..1_200,
    ) {
        both(|store, name| {
            let _ = store.create_queue(&spec(QueueKind::Standard, generous(), ttl_seconds, 31_536_000)).unwrap();
            let _ = store.bind_send(&SEND, &SEND_KEY, 1_000).unwrap();
            let payload = Payload::new(vec![5u8; 64]).unwrap();
            let appended_at = 10_000u64;
            append_at(store, &payload, appended_at).unwrap();

            let deadline = appended_at + u64::from(ttl_seconds) * 1_000;
            let now = appended_at + u64::from(offset_seconds) * 1_000;
            let alive = now < deadline;

            assert_eq!(read_all(store, now).is_empty(), !alive, "{name}: read at {now}");

            let report = store.expire(now).unwrap().into_inner();
            if alive {
                assert!(report.is_empty(), "{name}");
            } else {
                assert_eq!(report.messages_expired, 1, "{name}");
                assert_eq!(report.expired[0].reason, ExpiryReason::MessageTtl, "{name}");
                // The queue survives, and the watermark did not move: an
                // expired message was never acknowledged, and advancing the
                // watermark would acknowledge it on the reader's behalf.
                let record = store.queue_by_recv(&RECV, &RECV_KEY).unwrap();
                assert_eq!(record.state.acked_through(), None, "{name}");
                assert_eq!(record.state.next_index(), 1, "{name}");
                assert_eq!(record.stored_messages, 0, "{name}");
                assert_eq!(record.stored_bytes, 0, "{name}");
            }
            let _ = store.delete_queue(&RECV, &RECV_KEY).unwrap();
        });
    }
}

#[test]
fn the_idle_timer_retires_the_queue_and_activity_resets_it() {
    both(|store, name| {
        // 60-second idle TTL, created at 1_000 ms.
        let _ = store
            .create_queue(&spec(QueueKind::Standard, generous(), 86_400, 60))
            .unwrap();
        let _ = store.bind_send(&SEND, &SEND_KEY, 1_000).unwrap();

        // §7.7: the idle TTL "resets on any successful APPEND, READ, ACK,
        // SUBSCRIBE". `touch` is SUBSCRIBE's reset.
        store.touch(&RECV, &RECV_KEY, 50_000).unwrap();
        let report = store.expire(60_500).unwrap().into_inner();
        assert!(report.is_empty(), "{name}: the touch moved the deadline");

        let report = store.expire(110_001).unwrap().into_inner();
        assert_eq!(report.queues_expired, 1, "{name}");
        assert_eq!(report.expired[0].reason, ExpiryReason::IdleTtl, "{name}");

        // §7.6: no tombstone. Afterwards both addresses answer exactly as an
        // address that never existed does.
        let error = store.queue_by_recv(&RECV, &RECV_KEY).expect_err("gone");
        assert_eq!(code(&error), ErrorCode::NoAccess, "{name}");
        let error = store
            .queue_by_send(&SEND, &SendAuth::Signed(SEND_KEY))
            .expect_err("gone");
        assert_eq!(code(&error), ErrorCode::Unavailable, "{name}");
    });
}

// ---------------------------------------------------------------------------
// §10 / §6.3 — what a stranger can learn by asking.
// ---------------------------------------------------------------------------

#[test]
fn an_absent_address_and_a_wrong_key_are_indistinguishable() {
    both(|store, name| {
        let _ = store
            .create_queue(&spec(QueueKind::Standard, generous(), 86_400, 86_400))
            .unwrap();
        let _ = store.bind_send(&SEND, &SEND_KEY, 1_000).unwrap();

        // Receive side: one code for both, so sweeping the 32-byte address
        // space learns nothing (§10's existence-oracle rule).
        let absent = store.queue_by_recv(&ABSENT, &RECV_KEY).expect_err("absent");
        let wrong = store
            .queue_by_recv(&RECV, &OTHER_KEY)
            .expect_err("wrong key");
        assert_eq!(code(&absent), ErrorCode::NoAccess, "{name}");
        assert_eq!(code(&wrong), ErrorCode::NoAccess, "{name}");

        // Send side: everything collapses to ERR_UNAVAILABLE, so a bound sender
        // cannot learn queue state by filling it (§6.3).
        let payload = Payload::new(vec![1u8; 64]).unwrap();
        for auth in [
            SendAuth::Signed(OTHER_KEY),
            SendAuth::ContactStamp,
            SendAuth::Signed(SEND_KEY),
        ] {
            let addr = if matches!(auth, SendAuth::Signed(SEND_KEY)) {
                ABSENT
            } else {
                SEND
            };
            let error = store
                .append(&Append {
                    send_addr: addr,
                    auth,
                    payload: &payload,
                    received_at_ms: 2_000,
                })
                .expect_err("every send-side refusal is the same code");
            assert_eq!(code(&error), ErrorCode::Unavailable, "{name}");
        }
        let _ = store.delete_queue(&RECV, &RECV_KEY).unwrap();
    });
}

#[test]
fn a_contact_queue_takes_unsigned_appends_and_never_binds() {
    both(|store, name| {
        let _ = store
            .create_queue(&spec(QueueKind::Contact, generous(), 86_400, 86_400))
            .unwrap();

        // §12.2 point 1: BIND_SEND on a contact address returns
        // ERR_NOT_PERMITTED "always, for everyone".
        let error = store
            .bind_send(&SEND, &SEND_KEY, 2_000)
            .expect_err("a contact queue is never bindable");
        assert_eq!(code(&error), ErrorCode::NotPermitted, "{name}");

        // §12.2 point 2: it accepts unsigned appends from anyone with a stamp.
        let payload = Payload::new(vec![9u8; 64]).unwrap();
        let _ = store
            .append(&Append {
                send_addr: SEND,
                auth: SendAuth::ContactStamp,
                payload: &payload,
                received_at_ms: 2_000,
            })
            .unwrap();
        // And a *signed* append to a published contact address is refused the
        // same way everything else on the send side is.
        let error = store
            .append(&Append {
                send_addr: SEND,
                auth: SendAuth::Signed(SEND_KEY),
                payload: &payload,
                received_at_ms: 2_000,
            })
            .expect_err("a signed APPEND is not a CONTACT_APPEND");
        assert_eq!(code(&error), ErrorCode::Unavailable, "{name}");

        // Its receive side is a perfectly normal queue.
        assert_eq!(read_all(store, 3_000), vec![0], "{name}");
        assert_eq!(store.stats().unwrap().contact_queues, 1, "{name}");
        let _ = store.delete_queue(&RECV, &RECV_KEY).unwrap();
    });
}

// ---------------------------------------------------------------------------
// Group commit.
// ---------------------------------------------------------------------------

#[test]
fn one_refusal_in_a_batch_does_not_take_the_others_down() {
    both(|store, name| {
        let _ = store
            .create_queue(&spec(QueueKind::Standard, generous(), 86_400, 86_400))
            .unwrap();
        let _ = store.bind_send(&SEND, &SEND_KEY, 1_000).unwrap();
        let payload = Payload::new(vec![2u8; 64]).unwrap();

        let batch = [
            Append {
                send_addr: SEND,
                auth: SendAuth::Signed(SEND_KEY),
                payload: &payload,
                received_at_ms: 2_000,
            },
            // An unknown address: refused, and it must not roll back the two
            // legitimate appends sharing its transaction.
            Append {
                send_addr: ABSENT,
                auth: SendAuth::Signed(SEND_KEY),
                payload: &payload,
                received_at_ms: 2_000,
            },
            Append {
                send_addr: SEND,
                auth: SendAuth::Signed(SEND_KEY),
                payload: &payload,
                received_at_ms: 2_000,
            },
        ];
        let committed = store.append_batch(&batch).unwrap();
        assert_eq!(committed.durability(), store.durability(), "{name}");
        let results = committed.into_inner();
        assert_eq!(results.len(), 3, "{name}");
        assert_eq!(results[0].as_ref().unwrap().index, 0, "{name}");
        assert_eq!(
            code(results[1].as_ref().unwrap_err()),
            ErrorCode::Unavailable,
            "{name}"
        );
        assert_eq!(results[2].as_ref().unwrap().index, 1, "{name}");
        assert_eq!(read_all(store, 3_000), vec![0, 1], "{name}");
        let _ = store.delete_queue(&RECV, &RECV_KEY).unwrap();
    });
}

#[test]
fn indices_are_dense_and_ascending_across_batch_boundaries() {
    both(|store, name| {
        let _ = store
            .create_queue(&spec(QueueKind::Standard, generous(), 86_400, 86_400))
            .unwrap();
        let _ = store.bind_send(&SEND, &SEND_KEY, 1_000).unwrap();
        let payload = Payload::new(vec![4u8; 32]).unwrap();

        let mut expected = 0u64;
        for size in [1usize, 5, 1, 17] {
            let batch: Vec<Append<'_>> = (0..size)
                .map(|_| Append {
                    send_addr: SEND,
                    auth: SendAuth::Signed(SEND_KEY),
                    payload: &payload,
                    received_at_ms: 2_000,
                })
                .collect();
            for result in store.append_batch(&batch).unwrap().into_inner() {
                assert_eq!(result.unwrap().index, expected, "{name}");
                expected += 1;
            }
        }
        assert_eq!(
            read_all(store, 3_000),
            (0..expected).collect::<Vec<_>>(),
            "{name}"
        );
        let _ = store.delete_queue(&RECV, &RECV_KEY).unwrap();
    });
}

// ---------------------------------------------------------------------------
// Durability, as a published fact.
// ---------------------------------------------------------------------------

#[test]
fn each_store_publishes_the_durability_it_actually_has() {
    let directory = tempfile::tempdir().unwrap();
    let sqlite = SqliteStore::open(directory.path().join("relay.sqlite3")).unwrap();
    assert_eq!(
        sqlite.durability(),
        f2z_relay_store::Durability::FsyncPerAppend
    );
    assert_eq!(sqlite.durability().wire_value(), 2);
    assert!(sqlite.durability().survives_crash());

    let memory = MemoryStore::new();
    assert_eq!(memory.durability(), f2z_relay_store::Durability::Memory);
    assert_eq!(memory.durability().wire_value(), 0);
    assert!(!memory.durability().survives_crash());
}

#[test]
fn a_colliding_address_is_reported_rather_than_overwriting_a_live_queue() {
    both(|store, name| {
        let _ = store
            .create_queue(&spec(QueueKind::Standard, generous(), 86_400, 86_400))
            .unwrap();
        // §7.1 rejected client-chosen addresses partly because of squatting: a
        // create that silently replaced an existing record would be that attack
        // succeeding against the relay's own generator.
        let error = store
            .create_queue(&spec(QueueKind::Standard, generous(), 86_400, 86_400))
            .expect_err("the same pair of addresses collides");
        assert!(matches!(error, StoreError::AddressCollision), "{name}");

        // A collision across the two namespaces counts too: both addresses are
        // drawn from one 32-byte space and a lookup by either must be
        // unambiguous.
        let mut crossed = spec(QueueKind::Standard, generous(), 86_400, 86_400);
        crossed.recv_addr = QueueAddress::new([0x77; 32]);
        crossed.send_addr = RECV;
        let error = store
            .create_queue(&crossed)
            .expect_err("a send address equal to an existing receive address collides");
        assert!(matches!(error, StoreError::AddressCollision), "{name}");
        let _ = store.delete_queue(&RECV, &RECV_KEY).unwrap();
    });
}
