//! `CLIENT-CONTRACT.md` §5 — the eleven events, and the sink they go through.
//!
//! # This is the app's first real `listen()` consumer, so it is built deliberately
//!
//! `zcash://sync-progress` is emitted by the Zcash plugin at six sites and has
//! **zero listeners in ZUULI**; the app polls `get_sync_status` instead. Polling
//! is acceptable for a progress bar and is not acceptable for inbound messages,
//! so the event path gets built for real here — and, because it was unproven,
//! it is *tested* rather than assumed: `tests/events.rs` drives a real
//! `tauri::test` app, subscribes with the same `listen()` the frontend uses, and
//! asserts each payload arrives and parses.
//!
//! # Two rules the emitter has to keep, because the contract promises them
//!
//! 1. **`message-received` fires only after the durable write.** §5.2 and §9
//!    rule 1: if the UI has the event, the message is on disk. That is why
//!    emission is not a method anyone can call at any time — it is reached
//!    through [`EventSink::message_received`] from exactly one place, after the
//!    store transaction commits and before the ACK.
//! 2. **Events are notifications, not state and not a log.** They may be
//!    coalesced and they may be missed; the engine's local store is the source
//!    of truth. Nothing here retries, buffers or replays, and adding any of
//!    those would be a change to the contract rather than an improvement.
//!
//! # Why a trait
//!
//! The engine is Tauri-free. That is not tidiness: the two-process relay
//! harness that proves messages cross a real relay runs the engine without a
//! webview at all, and an engine that could only emit through an `AppHandle`
//! could not be tested that way. [`TauriSink`] is the shipping implementation
//! and is the only one compiled into a release build.

use crate::models::{
    Alarm, ContactRequest, Conversation, DeliveryStatus, EngineStatus, Gap, MessageReceivedEvent,
    PurgeRequestStatus, RelayConfig, RetentionExpiredEvent,
};

/// §5.1's event names. `f2zmsg://…`, matching `zcash://sync-progress`'s scheme.
///
/// A `const` per event rather than a string at each call site, so a rename is a
/// compile error here and a single diff — and so `tests/events.rs` can assert
/// this list equals `wallet/e2e2z/src/lib/messaging/events.ts`'s `EVENTS` keys.
pub mod names {
    pub const ENGINE_STATE: &str = "f2zmsg://engine-state";
    pub const MESSAGE_RECEIVED: &str = "f2zmsg://message-received";
    pub const MESSAGE_STATE: &str = "f2zmsg://message-state";
    pub const CONVERSATION_UPDATED: &str = "f2zmsg://conversation-updated";
    pub const CONTACT_REQUEST: &str = "f2zmsg://contact-request";
    pub const GAP_DETECTED: &str = "f2zmsg://gap-detected";
    pub const GAP_REPAIRED: &str = "f2zmsg://gap-repaired";
    pub const ALARM: &str = "f2zmsg://alarm";
    pub const RELAY_STATE: &str = "f2zmsg://relay-state";
    pub const RETENTION_EXPIRED: &str = "f2zmsg://retention-expired";
    pub const PURGE_PROGRESS: &str = "f2zmsg://purge-progress";

    /// Every event §5.1 declares, in the table's order. The population
    /// `tests/events.rs` compares against `events.ts`.
    pub const ALL: [&str; 11] = [
        ENGINE_STATE,
        MESSAGE_RECEIVED,
        MESSAGE_STATE,
        CONVERSATION_UPDATED,
        CONTACT_REQUEST,
        GAP_DETECTED,
        GAP_REPAIRED,
        ALARM,
        RELAY_STATE,
        RETENTION_EXPIRED,
        PURGE_PROGRESS,
    ];
}

/// Where the engine's notifications go.
///
/// Every method is infallible by signature. An event that cannot be delivered
/// is not an error the engine can act on — §5.2 already says events may be
/// missed, and a failed emit that propagated would turn a webview that closed
/// mid-send into a failed message write.
pub trait EventSink: Send + Sync + 'static {
    /// Any transition in §6.1, and every relay connect/disconnect.
    fn engine_state(&self, status: &EngineStatus);
    /// An inbound message has been **durably written** and is safe to display.
    fn message_received(&self, event: &MessageReceivedEvent);
    /// Any transition in §6.2, outbound or inbound.
    fn message_state(&self, status: &DeliveryStatus);
    /// Retention, hint, verification, epoch or transport-health change.
    fn conversation_updated(&self, conversation: &Conversation);
    /// An inbound `Welcome` was accepted as a contact request.
    fn contact_request(&self, request: &ContactRequest);
    /// A dangling parent was seen. **Never silent.**
    fn gap_detected(&self, gap: &Gap);
    /// A `gap_response` landed, or the gap became `unrecoverable`.
    fn gap_repaired(&self, gap: &Gap);
    /// §3.10. Critical alarms are non-dismissible by construction.
    fn alarm(&self, alarm: &Alarm);
    /// Connection or warning change for one relay.
    fn relay_state(&self, relay: &RelayConfig);
    /// Local plaintext expired under this device's own policy.
    fn retention_expired(&self, event: &RetentionExpiredEvent);
    /// A `PurgeAck` arrived.
    fn purge_progress(&self, status: &PurgeRequestStatus);
}

/// The sink that drops everything.
///
/// Used before a webview exists — the engine can be constructed and can run
/// during app setup, and an `Option<Box<dyn EventSink>>` threaded through every
/// emit site would be the same thing with more branches.
pub struct NullSink;

impl EventSink for NullSink {
    fn engine_state(&self, _: &EngineStatus) {}
    fn message_received(&self, _: &MessageReceivedEvent) {}
    fn message_state(&self, _: &DeliveryStatus) {}
    fn conversation_updated(&self, _: &Conversation) {}
    fn contact_request(&self, _: &ContactRequest) {}
    fn gap_detected(&self, _: &Gap) {}
    fn gap_repaired(&self, _: &Gap) {}
    fn alarm(&self, _: &Alarm) {}
    fn relay_state(&self, _: &RelayConfig) {}
    fn retention_expired(&self, _: &RetentionExpiredEvent) {}
    fn purge_progress(&self, _: &PurgeRequestStatus) {}
}

/// The shipping sink: Tauri's `emit`, which is what `listen()` on the frontend
/// receives.
pub struct TauriSink<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> TauriSink<R> {
    #[must_use]
    pub const fn new(app: tauri::AppHandle<R>) -> Self {
        Self { app }
    }

    fn emit<T: serde::Serialize + Clone>(&self, name: &str, payload: &T) {
        use tauri::Emitter as _;
        if let Err(error) = self.app.emit(name, payload.clone()) {
            // Logged and dropped. §5.2: events may be missed, and the UI
            // reconciles by re-reading after every transition into `running`
            // and on window focus. Retrying here would build the durable event
            // log the contract says does not exist.
            tracing::debug!(event = name, %error, "f2zmsg event not delivered");
        }
    }
}

impl<R: tauri::Runtime> EventSink for TauriSink<R> {
    fn engine_state(&self, status: &EngineStatus) {
        self.emit(names::ENGINE_STATE, status);
    }
    fn message_received(&self, event: &MessageReceivedEvent) {
        self.emit(names::MESSAGE_RECEIVED, event);
    }
    fn message_state(&self, status: &DeliveryStatus) {
        self.emit(names::MESSAGE_STATE, status);
    }
    fn conversation_updated(&self, conversation: &Conversation) {
        self.emit(names::CONVERSATION_UPDATED, conversation);
    }
    fn contact_request(&self, request: &ContactRequest) {
        self.emit(names::CONTACT_REQUEST, request);
    }
    fn gap_detected(&self, gap: &Gap) {
        self.emit(names::GAP_DETECTED, gap);
    }
    fn gap_repaired(&self, gap: &Gap) {
        self.emit(names::GAP_REPAIRED, gap);
    }
    fn alarm(&self, alarm: &Alarm) {
        self.emit(names::ALARM, alarm);
    }
    fn relay_state(&self, relay: &RelayConfig) {
        self.emit(names::RELAY_STATE, relay);
    }
    fn retention_expired(&self, event: &RetentionExpiredEvent) {
        self.emit(names::RETENTION_EXPIRED, event);
    }
    fn purge_progress(&self, status: &PurgeRequestStatus) {
        self.emit(names::PURGE_PROGRESS, status);
    }
}

/// A sink that records what it was handed, for tests that have no webview.
#[cfg(any(test, feature = "relay-harness"))]
#[derive(Default)]
pub struct RecordingSink {
    seen: std::sync::Mutex<Vec<(&'static str, serde_json::Value)>>,
}

#[cfg(any(test, feature = "relay-harness"))]
impl RecordingSink {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Every `(name, payload)` recorded so far, oldest first.
    #[must_use]
    pub fn seen(&self) -> Vec<(&'static str, serde_json::Value)> {
        self.seen
            .lock()
            .map(|seen| seen.clone())
            .unwrap_or_default()
    }

    /// The payloads recorded under one event name.
    #[must_use]
    pub fn payloads(&self, name: &str) -> Vec<serde_json::Value> {
        self.seen()
            .into_iter()
            .filter(|(seen, _)| *seen == name)
            .map(|(_, payload)| payload)
            .collect()
    }

    fn record<T: serde::Serialize>(&self, name: &'static str, payload: &T) {
        let value = serde_json::to_value(payload).unwrap_or(serde_json::Value::Null);
        if let Ok(mut seen) = self.seen.lock() {
            seen.push((name, value));
        }
    }
}

#[cfg(any(test, feature = "relay-harness"))]
impl EventSink for RecordingSink {
    fn engine_state(&self, status: &EngineStatus) {
        self.record(names::ENGINE_STATE, status);
    }
    fn message_received(&self, event: &MessageReceivedEvent) {
        self.record(names::MESSAGE_RECEIVED, event);
    }
    fn message_state(&self, status: &DeliveryStatus) {
        self.record(names::MESSAGE_STATE, status);
    }
    fn conversation_updated(&self, conversation: &Conversation) {
        self.record(names::CONVERSATION_UPDATED, conversation);
    }
    fn contact_request(&self, request: &ContactRequest) {
        self.record(names::CONTACT_REQUEST, request);
    }
    fn gap_detected(&self, gap: &Gap) {
        self.record(names::GAP_DETECTED, gap);
    }
    fn gap_repaired(&self, gap: &Gap) {
        self.record(names::GAP_REPAIRED, gap);
    }
    fn alarm(&self, alarm: &Alarm) {
        self.record(names::ALARM, alarm);
    }
    fn relay_state(&self, relay: &RelayConfig) {
        self.record(names::RELAY_STATE, relay);
    }
    fn retention_expired(&self, event: &RetentionExpiredEvent) {
        self.record(names::RETENTION_EXPIRED, event);
    }
    fn purge_progress(&self, status: &PurgeRequestStatus) {
        self.record(names::PURGE_PROGRESS, status);
    }
}

#[cfg(test)]
mod tests {
    use super::names;

    #[test]
    fn every_event_name_is_in_the_all_array_exactly_once() {
        let mut sorted = names::ALL.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), names::ALL.len());
    }

    #[test]
    fn every_event_uses_the_f2zmsg_scheme() {
        for name in names::ALL {
            assert!(name.starts_with("f2zmsg://"), "{name}");
        }
    }
}
