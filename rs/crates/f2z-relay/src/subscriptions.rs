//! Who is listening on which receive address (§6.2, §6.4).
//!
//! A subscription is **scoped to the connection and dies with it** — §6.2 says
//! so, and it is the reason this table is keyed by receive address and holds a
//! connection id beside every sender: dropping a connection has to be able to
//! find and remove every entry it owns without walking the whole table.
//!
//! # Only the receive side, ever
//!
//! §6.4: *"There is no push to a sender, ever — a push to a sender would be a
//! channel that tells it something about queue state, which §6.3 forbids."*
//! There is no send-address index here, so there is nothing to push to.
//!
//! # Bounded, and dropping rather than buffering
//!
//! §13.1 makes a subscriber that cannot keep up subject to backpressure "not to
//! unbounded server-side buffering". The channel is bounded; when it is full the
//! push is **dropped** and counted. That is safe in a way that dropping a
//! message would not be: the ciphertext is still in the queue, the reader's
//! `READ` still returns it, and the push was only ever a hint that a `READ` is
//! worth doing. §13.2's rule is about *messages*, and a push is not one.

use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;

use f2z_codec::commands::{NoticePush, PushEvent, QueueEventPush, QueuedMessage};
use f2z_codec::types::QueueAddress;
use tokio::sync::mpsc::error::TrySendError;

use crate::metrics::Metrics;
use crate::outbound::{Outbound, msg_push, push};

/// `QUEUE_EVENT` reason 1 (§6.4): the queue was deleted.
pub const QUEUE_EVENT_DELETED: u8 = 1;
/// `QUEUE_EVENT` reason 4 (§6.4): a quota was reached.
pub const QUEUE_EVENT_QUOTA: u8 = 4;
/// `NOTICE` kind 2 (§6.4): the relay is shutting down at `at_ms`.
pub const NOTICE_SHUTDOWN: u8 = 2;

/// One connection's registration on one address.
struct Subscriber {
    connection: u64,
    sender: tokio::sync::mpsc::Sender<Outbound>,
}

impl core::fmt::Debug for Subscriber {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Subscriber")
            .field("connection", &self.connection)
            .finish_non_exhaustive()
    }
}

/// The relay's subscription table.
///
/// Both directions are held here, under one lock, because §6.2's "dies with it"
/// is only as good as the list teardown is given. When the connection kept that
/// list itself, a `SUBSCRIBE` path that forgot to record an address left a row
/// nothing would ever remove — and nothing prunes an orphan, because a failed
/// `try_send` is counted and the subscriber is left in place. Owning the reverse
/// index means [`Subscriptions::drop_connection`] needs no caller-supplied list,
/// so there is no second place to forget (zuu#722).
#[derive(Debug, Default)]
pub struct Subscriptions {
    inner: Mutex<Tables>,
}

/// The two indexes, kept consistent by every method that touches either.
///
/// The address map's key is a `QueueAddress`, whose `Debug` redacts, so the
/// derived `Debug` here does too.
#[derive(Debug, Default)]
struct Tables {
    by_recv: HashMap<QueueAddress, Vec<Subscriber>>,
    by_connection: HashMap<u64, BTreeSet<QueueAddress>>,
}

impl Subscriptions {
    /// An empty table.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a connection for pushes on `recv_addr`. Idempotent.
    pub fn subscribe(
        &self,
        recv_addr: QueueAddress,
        connection: u64,
        sender: tokio::sync::mpsc::Sender<Outbound>,
    ) {
        let mut tables = self.lock();
        let entries = tables.by_recv.entry(recv_addr).or_default();
        if entries
            .iter()
            .any(|subscriber| subscriber.connection == connection)
        {
            return;
        }
        entries.push(Subscriber { connection, sender });
        tables
            .by_connection
            .entry(connection)
            .or_default()
            .insert(recv_addr);
    }

    /// Drop one connection's registration on one address.
    pub fn unsubscribe(&self, recv_addr: &QueueAddress, connection: u64) {
        let mut tables = self.lock();
        Self::remove_one(&mut tables, recv_addr, connection);
    }

    /// Drop every registration a connection holds — §6.2's "dies with it".
    ///
    /// The addresses come from this table's own reverse index, so a caller
    /// cannot pass an incomplete list.
    pub fn drop_connection(&self, connection: u64) {
        let mut tables = self.lock();
        let Some(addresses) = tables.by_connection.remove(&connection) else {
            return;
        };
        for address in addresses {
            Self::remove_one(&mut tables, &address, connection);
        }
    }

    /// Remove one (address, connection) pair from both indexes.
    fn remove_one(tables: &mut Tables, recv_addr: &QueueAddress, connection: u64) {
        if let Some(entries) = tables.by_recv.get_mut(recv_addr) {
            entries.retain(|subscriber| subscriber.connection != connection);
            if entries.is_empty() {
                tables.by_recv.remove(recv_addr);
            }
        }
        if let Some(addresses) = tables.by_connection.get_mut(&connection) {
            addresses.remove(recv_addr);
            if addresses.is_empty() {
                tables.by_connection.remove(&connection);
            }
        }
    }

    /// Whether anybody is listening. Lets the engine skip encoding a push
    /// nobody will receive, which on a relay with few subscribers is most of
    /// them.
    #[must_use]
    pub fn has_subscriber(&self, recv_addr: &QueueAddress) -> bool {
        self.lock().by_recv.contains_key(recv_addr)
    }

    /// Push a `MSG` to whoever is reading this queue (§6.4).
    pub fn notify_message(
        &self,
        recv_addr: QueueAddress,
        message: &QueuedMessage,
        metrics: &Metrics,
    ) {
        self.deliver(&recv_addr, metrics, || msg_push(recv_addr, message));
    }

    /// Push a `QUEUE_EVENT` (§6.4). Silent to a writer, always.
    pub fn notify_queue_event(&self, recv_addr: QueueAddress, reason: u8, metrics: &Metrics) {
        let body = QueueEventPush { recv_addr, reason };
        self.deliver(&recv_addr, metrics, || push(PushEvent::QueueEvent, &body));
    }

    /// Push a `NOTICE` to every subscribed connection (§6.4).
    ///
    /// The frame is identical for every recipient — a `NOTICE` carries no
    /// per-subscriber field (§4.3 fixes `request_id` at 0 for every push, and
    /// [`NoticePush`] is just `kind` and `at_ms`) — so it is built **once**,
    /// before the table lock is even taken, and the encoded [`Outbound`] is
    /// cloned to each subscriber of each address. Building it per subscriber,
    /// under the lock, used to pay one encode per recipient for bytes that
    /// were always going to come out the same (zuu#749).
    ///
    /// If the encode itself fails, that failure is not a function of *which*
    /// subscriber is being served — it is a function of `kind`/`at_ms` alone —
    /// so nobody receives the push. See [`Subscriptions::deliver`]'s doc
    /// comment for why "fail closed for everyone" is the right call and not
    /// merely a side effect of hoisting.
    pub fn notify_all(&self, kind: u8, at_ms: u64, metrics: &Metrics) {
        let body = NoticePush { kind, at_ms };
        let Some(outbound) = push(PushEvent::Notice, &body) else {
            return;
        };
        let tables = self.lock();
        for entries in tables.by_recv.values() {
            for subscriber in entries {
                count_push(subscriber.sender.try_send(outbound.clone()), metrics);
            }
        }
    }

    /// Encode `build()` once and fan the result out to every subscriber of
    /// `recv_addr` (zuu#749).
    ///
    /// # Why one encode is safe to share
    ///
    /// Every caller of `deliver` closes over data that does not change across
    /// the loop — a `recv_addr`, a `QueuedMessage`, a `QueueEventPush` body —
    /// and none of that encodes any per-subscriber field: a push's
    /// `request_id` is always 0 (§4.3), and none of `MsgPush`, `QueueEventPush`
    /// carries a connection id, a sequence number or a nonce that would differ
    /// between two subscribers of the same address. `Outbound` is `Clone`, so
    /// building it once and cloning per subscriber produces the exact bytes
    /// the old per-subscriber loop did — this is a pure fan-out, not a change
    /// to what goes over the wire.
    ///
    /// # The encode-failure decision, made on purpose
    ///
    /// `build()` is a pure function of that same closed-over data — encoding
    /// has no dependency on which subscriber is being served — so if it fails
    /// for one subscriber it fails identically for all of them. The old
    /// per-subscriber loop called `build()` fresh for every subscriber and
    /// skipped just that one on `None`, which *looked* like a subscriber-scoped
    /// failure but, for any real encode failure (the body does not fit under
    /// `Body::MAX_LEN`; see the `encode_failure` tests), was never anything
    /// but the same failure repeated once per subscriber.
    ///
    /// Given that, failing the whole address once `build()` returns `None` is
    /// not a behaviour change hiding in a refactor — it is the behaviour the
    /// old code already had, made explicit and paid for once instead of N
    /// times. It also matches this module's doctrine on backpressure (top of
    /// file): a push is only ever a hint that a `READ` is worth doing, the
    /// message stays in the queue, and dropping the hint is safe in a way that
    /// dropping the message would not be. Nobody is unsubscribed, nothing
    /// partial or corrupt goes out, and no success is reported — the caller
    /// gets silence, exactly as it does today when `build()` fails.
    fn deliver<F: FnOnce() -> Option<Outbound>>(
        &self,
        recv_addr: &QueueAddress,
        metrics: &Metrics,
        build: F,
    ) {
        let tables = self.lock();
        let Some(entries) = tables.by_recv.get(recv_addr) else {
            return;
        };
        let Some(outbound) = build() else {
            return;
        };
        for subscriber in entries {
            // `try_send`, never `send`: a slow reader must not be able to stall
            // the task that just committed somebody else's append.
            count_push(subscriber.sender.try_send(outbound.clone()), metrics);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Tables> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Book one `try_send` outcome to the counter that describes *why* it failed.
///
/// `TrySendError` has two variants and they ask an operator for opposite
/// things, so they cannot share a series: `Full` means the subscriber is not
/// keeping up — raise `outbound` capacity or slow the producer — while `Closed`
/// means the subscriber's writer task has ended and [`Subscriptions::drop_connection`]
/// has not run yet, which is ordinary disconnect churn with nothing to tune.
/// Counting `Closed` as `pushes_dropped` made the backpressure signal rise with
/// client churn alone (zuu#676).
///
/// Both paths book through here so the two can never drift apart again.
fn count_push(result: Result<(), TrySendError<Outbound>>, metrics: &Metrics) {
    match result {
        Ok(()) => {}
        Err(TrySendError::Full(_)) => Metrics::inc(&metrics.pushes_dropped),
        Err(TrySendError::Closed(_)) => Metrics::inc(&metrics.pushes_to_closed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use f2z_codec::types::Payload;

    fn message() -> QueuedMessage {
        QueuedMessage {
            index: 0,
            received_at_ms: 1,
            payload: Payload::new(vec![0xde, 0xad, 0xbe, 0xef]).unwrap(),
        }
    }

    #[tokio::test]
    async fn a_subscriber_receives_and_an_unsubscriber_does_not() {
        let table = Subscriptions::new();
        let metrics = Metrics::new();
        let address = QueueAddress::new([1u8; 32]);
        let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
        table.subscribe(address, 1, sender);
        table.notify_message(address, &message(), &metrics);
        assert!(receiver.try_recv().is_ok());

        table.unsubscribe(&address, 1);
        table.notify_message(address, &message(), &metrics);
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn subscribing_twice_registers_once() {
        let table = Subscriptions::new();
        let metrics = Metrics::new();
        let address = QueueAddress::new([2u8; 32]);
        let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
        table.subscribe(address, 1, sender.clone());
        table.subscribe(address, 1, sender);
        table.notify_message(address, &message(), &metrics);
        assert!(receiver.try_recv().is_ok());
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn a_dropped_connection_takes_every_subscription_with_it() {
        let table = Subscriptions::new();
        let metrics = Metrics::new();
        let first = QueueAddress::new([3u8; 32]);
        let second = QueueAddress::new([4u8; 32]);
        let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
        table.subscribe(first, 9, sender.clone());
        table.subscribe(second, 9, sender);
        // No address list: the table knows what this connection holds, which is
        // the whole point — a caller cannot hand teardown a short list.
        table.drop_connection(9);
        assert!(!table.has_subscriber(&first));
        assert!(!table.has_subscriber(&second));
        table.notify_message(first, &message(), &metrics);
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn teardown_needs_nothing_the_caller_has_to_remember() {
        // zuu#722. The rule used to be kept in two places: this table, and a
        // `BTreeSet` on the connection that the `SUBSCRIBE` handler had to
        // remember to update. Deleting that one line left every workspace test
        // green while every subscription outlived its connection. There is now
        // no second place, and this asserts the reverse index really is what
        // teardown reads.
        let table = Subscriptions::new();
        let metrics = Metrics::new();
        let first = QueueAddress::new([5u8; 32]);
        let second = QueueAddress::new([6u8; 32]);
        let other = QueueAddress::new([7u8; 32]);
        let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
        let (survivor, mut survivor_receiver) = tokio::sync::mpsc::channel(4);

        table.subscribe(first, 11, sender.clone());
        table.subscribe(second, 11, sender);
        table.subscribe(other, 12, survivor);

        table.drop_connection(11);

        // Everything connection 11 held is gone, including the address it
        // subscribed to second — the one a partial list would have missed.
        assert!(!table.has_subscriber(&first));
        assert!(!table.has_subscriber(&second));
        table.notify_message(second, &message(), &metrics);
        assert!(receiver.try_recv().is_err());

        // …and only that connection's rows went.
        assert!(table.has_subscriber(&other));
        table.notify_message(other, &message(), &metrics);
        assert!(survivor_receiver.try_recv().is_ok());

        // Dropping a connection that holds nothing is not an error, and an
        // explicit unsubscribe leaves no empty row for a later teardown to walk.
        table.drop_connection(11);
        table.unsubscribe(&other, 12);
        assert!(!table.has_subscriber(&other));
        table.drop_connection(12);
    }

    fn dropped(metrics: &Metrics) -> u64 {
        metrics
            .pushes_dropped
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    fn to_closed(metrics: &Metrics) -> u64 {
        metrics
            .pushes_to_closed
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    #[tokio::test]
    async fn a_full_outbound_queue_drops_the_push_and_counts_it() {
        let table = Subscriptions::new();
        let metrics = Metrics::new();
        let address = QueueAddress::new([5u8; 32]);
        // The receiver stays bound, so the channel genuinely fills rather than
        // closing — this is the `Full` half and nothing else.
        let (sender, _receiver) = tokio::sync::mpsc::channel(1);
        table.subscribe(address, 1, sender);
        for _ in 0..4 {
            table.notify_message(address, &message(), &metrics);
        }
        assert!(dropped(&metrics) > 0);
        // zuu#676: the two causes must not be able to satisfy each other's
        // assertion, so a full queue has to leave the closed counter alone.
        assert_eq!(to_closed(&metrics), 0);
    }

    #[tokio::test]
    async fn a_full_outbound_queue_counts_full_in_notify_all_too() {
        // `notify_all` carries its own push, so the classification is asserted
        // on that path as well and not inferred from `deliver`.
        let table = Subscriptions::new();
        let metrics = Metrics::new();
        let address = QueueAddress::new([8u8; 32]);
        let (sender, _receiver) = tokio::sync::mpsc::channel(1);
        table.subscribe(address, 1, sender);
        for _ in 0..4 {
            table.notify_all(NOTICE_SHUTDOWN, 1_000, &metrics);
        }
        assert!(dropped(&metrics) > 0);
        assert_eq!(to_closed(&metrics), 0);
    }

    #[tokio::test]
    async fn a_closed_subscriber_is_not_counted_as_a_full_queue() {
        // zuu#676. The queue is 64 deep and nothing was ever sent, so there is
        // no capacity to raise: the receiver is simply gone, which is what
        // happens between a writer task ending and `drop_connection` running.
        let table = Subscriptions::new();
        let metrics = Metrics::new();
        let address = QueueAddress::new([9u8; 32]);
        let (sender, receiver) = tokio::sync::mpsc::channel(64);
        table.subscribe(address, 1, sender);
        drop(receiver);

        table.notify_message(address, &message(), &metrics);

        assert_eq!(to_closed(&metrics), 1);
        assert_eq!(
            dropped(&metrics),
            0,
            "a gone subscriber is not backpressure and must not inflate it"
        );
    }

    #[tokio::test]
    async fn a_closed_subscriber_is_not_counted_as_a_full_queue_in_notify_all() {
        let table = Subscriptions::new();
        let metrics = Metrics::new();
        let address = QueueAddress::new([10u8; 32]);
        let (sender, receiver) = tokio::sync::mpsc::channel(64);
        table.subscribe(address, 1, sender);
        drop(receiver);

        table.notify_all(NOTICE_SHUTDOWN, 1_000, &metrics);

        assert_eq!(to_closed(&metrics), 1);
        assert_eq!(dropped(&metrics), 0);
    }

    #[tokio::test]
    async fn a_delivered_push_counts_neither() {
        let table = Subscriptions::new();
        let metrics = Metrics::new();
        let address = QueueAddress::new([11u8; 32]);
        let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
        table.subscribe(address, 1, sender);
        table.notify_message(address, &message(), &metrics);
        table.notify_all(NOTICE_SHUTDOWN, 1_000, &metrics);
        assert!(receiver.try_recv().is_ok());
        assert_eq!(dropped(&metrics), 0);
        assert_eq!(to_closed(&metrics), 0);
    }

    #[tokio::test]
    async fn deliver_encodes_once_and_shares_it_across_every_subscriber() {
        // zuu#749: an identical push must be encoded once, then fanned out —
        // not rebuilt fresh for every subscriber on the address. This drives
        // `deliver` directly with a counting build so the encode count is
        // asserted, not just inferred from timing.
        let table = Subscriptions::new();
        let metrics = Metrics::new();
        let address = QueueAddress::new([12u8; 32]);
        let mut receivers = Vec::new();
        for connection in 0..5u64 {
            let (sender, receiver) = tokio::sync::mpsc::channel(4);
            table.subscribe(address, connection, sender);
            receivers.push(receiver);
        }

        let encodes = std::sync::atomic::AtomicUsize::new(0);
        let outbound = push(PushEvent::Notice, &NoticePush { kind: 1, at_ms: 0 }).unwrap();
        table.deliver(&address, &metrics, || {
            encodes.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Some(outbound.clone())
        });

        assert_eq!(
            encodes.load(std::sync::atomic::Ordering::Relaxed),
            1,
            "5 subscribers on one address must share a single encode"
        );
        for mut receiver in receivers {
            assert!(
                receiver.try_recv().is_ok(),
                "every subscriber still gets the (shared) frame"
            );
        }
    }

    #[tokio::test]
    async fn an_oversized_message_fails_the_encode_closed_not_partial() {
        // §6.4's `MSG` push wraps a `QueuedMessage` inside a `Push` whose body
        // is bounded by `Body::MAX_LEN` (2^24-1, the same cap `Payload::MAX_LEN`
        // uses). A payload sitting at that cap adds `MsgPush`'s own framing on
        // top of it — a 32-byte `recv_addr`, an 8-byte index, an 8-byte
        // timestamp and a 3-byte length prefix — so the encoded push can never
        // fit. That is a real encode failure driven by real production code
        // (`msg_push`/`push`), not a mocked `build()`.
        let table = Subscriptions::new();
        let metrics = Metrics::new();
        let address = QueueAddress::new([13u8; 32]);
        let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
        table.subscribe(address, 1, sender);

        let oversized = QueuedMessage {
            index: 0,
            received_at_ms: 1,
            payload: Payload::new(vec![0u8; Payload::MAX_LEN]).unwrap(),
        };
        // Confirm the premise before trusting what follows: this input really
        // does fail to encode, so the assertions below exercise the failure
        // path and not a payload that happened to succeed.
        assert!(
            msg_push(address, &oversized).is_none(),
            "test setup must actually overflow Body::MAX_LEN"
        );

        table.notify_message(address, &oversized, &metrics);

        // Fails closed: no partial or garbage frame reaches the subscriber…
        assert!(
            receiver.try_recv().is_err(),
            "an encode failure must not deliver a partial/corrupt frame"
        );
        // …the subscriber is not silently dropped from the table…
        assert!(
            table.has_subscriber(&address),
            "an encode failure must not silently unsubscribe anyone"
        );
        // …and nothing is miscounted as ordinary backpressure or a closed
        // receiver — both would misreport what actually happened.
        assert_eq!(dropped(&metrics), 0);
        assert_eq!(to_closed(&metrics), 0);
    }

    #[tokio::test]
    async fn the_table_never_renders_an_address_or_a_payload() {
        let table = Subscriptions::new();
        let address = QueueAddress::new([0xde; 32]);
        let (sender, _receiver) = tokio::sync::mpsc::channel(1);
        table.subscribe(address, 1, sender);
        let rendered = format!("{table:?}");
        assert!(
            !rendered.contains("222"),
            "decimal byte list leaked: {rendered}"
        );
        assert!(!rendered.contains("dede"));
    }
}
