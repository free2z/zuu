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

use std::collections::HashMap;
use std::sync::Mutex;

use f2z_codec::commands::{NoticePush, PushEvent, QueueEventPush, QueuedMessage};
use f2z_codec::types::QueueAddress;

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
#[derive(Debug, Default)]
pub struct Subscriptions {
    // The key is a queue address. `QueueAddress`'s `Debug` redacts, so the
    // derived `Debug` on this map does too.
    by_recv: Mutex<HashMap<QueueAddress, Vec<Subscriber>>>,
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
        let mut table = self.lock();
        let entries = table.entry(recv_addr).or_default();
        if entries
            .iter()
            .any(|subscriber| subscriber.connection == connection)
        {
            return;
        }
        entries.push(Subscriber { connection, sender });
    }

    /// Drop one connection's registration on one address.
    pub fn unsubscribe(&self, recv_addr: &QueueAddress, connection: u64) {
        let mut table = self.lock();
        if let Some(entries) = table.get_mut(recv_addr) {
            entries.retain(|subscriber| subscriber.connection != connection);
            if entries.is_empty() {
                table.remove(recv_addr);
            }
        }
    }

    /// Drop every registration a connection holds — §6.2's "dies with it".
    pub fn drop_connection(&self, connection: u64, addresses: &[QueueAddress]) {
        for address in addresses {
            self.unsubscribe(address, connection);
        }
    }

    /// Whether anybody is listening. Lets the engine skip encoding a push
    /// nobody will receive, which on a relay with few subscribers is most of
    /// them.
    #[must_use]
    pub fn has_subscriber(&self, recv_addr: &QueueAddress) -> bool {
        self.lock().contains_key(recv_addr)
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
        let table = self.lock();
        for entries in table.values() {
            for subscriber in entries {
                let Some(outbound) = push(PushEvent::Notice, &body) else {
                    continue;
                };
                if subscriber.sender.try_send(outbound).is_err() {
                    Metrics::inc(&metrics.pushes_dropped);
                }
            }
        }
    }

    fn deliver<F: Fn() -> Option<Outbound>>(
        &self,
        recv_addr: &QueueAddress,
        metrics: &Metrics,
        build: F,
    ) {
        let table = self.lock();
        let Some(entries) = table.get(recv_addr) else {
            return;
        };
        for subscriber in entries {
            let Some(outbound) = build() else {
                continue;
            };
            // `try_send`, never `send`: a slow reader must not be able to stall
            // the task that just committed somebody else's append.
            if subscriber.sender.try_send(outbound).is_err() {
                Metrics::inc(&metrics.pushes_dropped);
            }
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<QueueAddress, Vec<Subscriber>>> {
        self.by_recv
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
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
        table.drop_connection(9, &[first, second]);
        assert!(!table.has_subscriber(&first));
        assert!(!table.has_subscriber(&second));
        table.notify_message(first, &message(), &metrics);
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn a_full_outbound_queue_drops_the_push_and_counts_it() {
        let table = Subscriptions::new();
        let metrics = Metrics::new();
        let address = QueueAddress::new([5u8; 32]);
        let (sender, _receiver) = tokio::sync::mpsc::channel(1);
        table.subscribe(address, 1, sender);
        for _ in 0..4 {
            table.notify_message(address, &message(), &metrics);
        }
        assert!(
            metrics
                .pushes_dropped
                .load(std::sync::atomic::Ordering::Relaxed)
                > 0
        );
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
