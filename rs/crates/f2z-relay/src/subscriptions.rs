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
    pub fn notify_all(&self, kind: u8, at_ms: u64, metrics: &Metrics) {
        let body = NoticePush { kind, at_ms };
        let tables = self.lock();
        for entries in tables.by_recv.values() {
            for subscriber in entries {
                let Some(outbound) = push(PushEvent::Notice, &body) else {
                    continue;
                };
                count_push(subscriber.sender.try_send(outbound), metrics);
            }
        }
    }

    fn deliver<F: Fn() -> Option<Outbound>>(
        &self,
        recv_addr: &QueueAddress,
        metrics: &Metrics,
        build: F,
    ) {
        let tables = self.lock();
        let Some(entries) = tables.by_recv.get(recv_addr) else {
            return;
        };
        for subscriber in entries {
            let Some(outbound) = build() else {
                continue;
            };
            // `try_send`, never `send`: a slow reader must not be able to stall
            // the task that just committed somebody else's append.
            count_push(subscriber.sender.try_send(outbound), metrics);
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
