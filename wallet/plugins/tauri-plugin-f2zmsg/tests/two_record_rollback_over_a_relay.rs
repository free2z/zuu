//! A failed rollback reload stops a real relay batch at its first ciphertext.
//!
//! This is intentionally above the MLS crate's focused rollback tests. Two
//! application messages cross the plugin's real WebSocket client and occupy one
//! relay `READ`; the receiver then suffers an apply failure followed by a
//! one-shot restore read failure. The production pump must leave both records
//! behind the first failure so a fresh durable group load can process them in
//! order on the next pass.

#![cfg(feature = "relay-harness")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use f2z_codec::types::PublicKey;
use f2z_kt_core::types::{Handle, KemPublicKey};
use f2z_msg_identity::{AccountKeys, DeviceCredentialRequest};
use f2z_msg_store::{Durability, MemoryBackend, Op, StorageBackend, StoreError};
use f2z_relay_testkit::fake::FakeRelay;
use tauri_plugin_f2zmsg::directory::{Directory, ResolvedIdentity, ResolvedPeer};
use tauri_plugin_f2zmsg::engine::{Engine, IdentityInstall};
use tauri_plugin_f2zmsg::error::{Error, Result};
use tauri_plugin_f2zmsg::events::{EventSink, NullSink};
use tauri_plugin_f2zmsg::models::{
    DirectoryResolution, ErrorCode, MessageBody, Platform, TransportHealth,
};

const NOW: i64 = 1_800_000_000_000;

#[derive(Clone, Debug)]
struct FailOnceBackend {
    inner: Arc<MemoryBackend>,
    fail_apply: Arc<AtomicBool>,
    fail_restore_get_after_apply: Arc<AtomicBool>,
    fail_next_get: Arc<AtomicBool>,
    apply_failures: Arc<AtomicUsize>,
    restore_get_failures: Arc<AtomicUsize>,
}

impl FailOnceBackend {
    fn new() -> Self {
        Self {
            inner: Arc::new(MemoryBackend::new()),
            fail_apply: Arc::new(AtomicBool::new(false)),
            fail_restore_get_after_apply: Arc::new(AtomicBool::new(false)),
            fail_next_get: Arc::new(AtomicBool::new(false)),
            apply_failures: Arc::new(AtomicUsize::new(0)),
            restore_get_failures: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn fail_apply_and_restore_get_once(&self) {
        self.fail_restore_get_after_apply
            .store(true, Ordering::SeqCst);
        self.fail_apply.store(true, Ordering::SeqCst);
    }

    fn failure_counts(&self) -> (usize, usize) {
        (
            self.apply_failures.load(Ordering::SeqCst),
            self.restore_get_failures.load(Ordering::SeqCst),
        )
    }
}

impl StorageBackend for FailOnceBackend {
    fn get(&self, key: &[u8]) -> f2z_msg_store::Result<Option<Vec<u8>>> {
        if self.fail_next_get.swap(false, Ordering::SeqCst) {
            self.restore_get_failures.fetch_add(1, Ordering::SeqCst);
            return Err(StoreError::Backend("injected restore get failure"));
        }
        self.inner.get(key)
    }

    fn apply(&self, ops: &[Op]) -> f2z_msg_store::Result<()> {
        if self.fail_apply.swap(false, Ordering::SeqCst) {
            self.apply_failures.fetch_add(1, Ordering::SeqCst);
            if self
                .fail_restore_get_after_apply
                .swap(false, Ordering::SeqCst)
            {
                self.fail_next_get.store(true, Ordering::SeqCst);
            }
            return Err(StoreError::Backend("injected apply failure"));
        }
        self.inner.apply(ops)
    }

    fn durability(&self) -> Durability {
        // This test exercises the shipping ACK path after recovery. Atomicity
        // comes from MemoryBackend; process durability is intentionally asserted
        // here only so the plugin is permitted to send that ACK.
        Durability::Durable
    }
}

#[derive(Clone, Debug)]
struct Published {
    identity_pk: String,
    key_package: Vec<u8>,
    contact_relay_url: String,
    contact_addr: String,
}

#[derive(Debug, Default)]
struct HarnessDirectory {
    entries: Mutex<HashMap<String, Published>>,
}

impl HarnessDirectory {
    fn publish(&self, handle: &str, entry: Published) {
        self.entries
            .lock()
            .expect("directory lock")
            .insert(handle.to_owned(), entry);
    }

    fn entry(&self, handle: &str) -> Result<Published> {
        self.entries
            .lock()
            .map_err(|_| Error::internal("the harness directory lock was poisoned"))?
            .get(handle)
            .cloned()
            .ok_or_else(|| Error::new(ErrorCode::DirectoryUnreachable, "peer not published"))
    }

    fn resolution(&self, handle: &str, found: bool) -> DirectoryResolution {
        DirectoryResolution {
            handle: handle.to_owned(),
            found,
            identity_fingerprint: found.then(|| {
                self.entries
                    .lock()
                    .expect("directory lock")
                    .get(handle)
                    .expect("published entry")
                    .identity_pk
                    .clone()
            }),
            device_count: u32::from(found),
            entry_version: found.then_some(1),
            epoch: 1,
            witness_cosignatures: 1,
            independent_witnesses: 1,
            threshold_met: true,
        }
    }
}

impl Directory for HarnessDirectory {
    fn resolve(&self, handle: &str) -> Result<DirectoryResolution> {
        let found = self
            .entries
            .lock()
            .map_err(|_| Error::internal("the harness directory lock was poisoned"))?
            .contains_key(handle);
        Ok(self.resolution(handle, found))
    }

    fn resolve_identity(&self, handle: &str) -> Result<ResolvedIdentity> {
        let published = self.entry(handle)?;
        Ok(ResolvedIdentity {
            resolution: self.resolution(handle, true),
            identity_pk: published.identity_pk,
            contact_relay_url: published.contact_relay_url,
            contact_addr: published.contact_addr,
        })
    }

    fn resolve_peer(&self, handle: &str) -> Result<ResolvedPeer> {
        let published = self.entry(handle)?;
        Ok(ResolvedPeer {
            resolution: self.resolution(handle, true),
            identity_pk: published.identity_pk,
            key_package: published.key_package,
            contact_relay_url: published.contact_relay_url,
            contact_addr: published.contact_addr,
        })
    }

    fn independent_witnesses(&self) -> u32 {
        1
    }

    fn threshold_met(&self) -> bool {
        true
    }
}

fn engine<B: StorageBackend>(backend: B, directory: Arc<HarnessDirectory>) -> Engine<B> {
    Engine::new(
        backend,
        Arc::new(NullSink) as Arc<dyn EventSink>,
        Platform::ZuuliDesktop,
    )
    .expect("engine")
    .with_directory(directory)
}

async fn enroll<B: StorageBackend>(engine: &Engine<B>, handle: &str, seed: u8) {
    let device = engine.prepare_device().await.expect("device keys");
    let account = AccountKeys::from_seed(&[seed; 64], 0).expect("account keys");
    let credential = account
        .identity
        .issue_device_credential(&DeviceCredentialRequest {
            handle: Handle::new(handle.as_bytes().to_vec()).expect("handle"),
            device_pk: PublicKey::new(device.device_pk),
            device_kem_pk: KemPublicKey::new(device.device_kem_pk).expect("KEM key"),
            not_before_ms: 0,
            not_after_ms: u64::MAX / 2,
        })
        .expect("credential");
    engine
        .install_identity(IdentityInstall {
            handle: handle.to_owned(),
            identity_pk: hex::encode(account.identity.public().as_bytes()),
            credential: f2z_msg_mls::credential::encode(&credential).expect("encode credential"),
            wrap_key: *account.backup_wrap.as_bytes(),
            submitted_at: NOW,
        })
        .await
        .expect("install identity");
    engine
        .unlock(account.backup_wrap.as_bytes())
        .await
        .expect("unlock");
}

async fn configure_relay<B: StorageBackend>(engine: &Engine<B>, url: &str) {
    let refusal = engine
        .add_relay(url)
        .await
        .expect_err("cleartext relay requires explicit consent");
    assert_eq!(refusal.code(), ErrorCode::RelayRefusedInsecure);
    let relay = engine
        .list_relays()
        .await
        .expect("relay list")
        .into_iter()
        .find(|relay| relay.relay_url == url)
        .expect("stored refused relay");
    engine
        .set_relay_trust(&relay.relay_id, true, true)
        .await
        .expect("relay consent");
}

async fn publish<B: StorageBackend>(
    engine: &Engine<B>,
    directory: &HarnessDirectory,
    handle: &str,
) {
    let (contact_relay_url, contact_addr) = engine
        .contact_advert()
        .await
        .expect("contact advert")
        .expect("contact queue");
    directory.publish(
        handle,
        Published {
            identity_pk: engine
                .device_info()
                .await
                .expect("device info")
                .identity_fingerprint
                .replace(' ', ""),
            key_package: engine.key_package().await.expect("key package"),
            contact_relay_url,
            contact_addr,
        },
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn two_relay_records_remain_behind_an_unavailable_group() {
    let relay = FakeRelay::with_defaults().expect("fake relay");
    let server = relay.listen_loopback().await.expect("WebSocket listener");
    let url = server.url().to_owned();

    let directory = Arc::new(HarnessDirectory::default());
    let alice = engine(MemoryBackend::new(), Arc::clone(&directory));
    let bob_backend = FailOnceBackend::new();
    let bob = engine(bob_backend.clone(), Arc::clone(&directory));

    enroll(&alice, "alice", 1).await;
    enroll(&bob, "bob", 2).await;
    configure_relay(&alice, &url).await;
    configure_relay(&bob, &url).await;
    alice.start().await.expect("start alice");
    bob.start().await.expect("start bob");
    publish(&alice, &directory, "alice").await;
    publish(&bob, &directory, "bob").await;

    let conversation = alice
        .start_conversation("bob")
        .await
        .expect("start conversation");
    bob.pump_inbound().await.expect("contact queue pump");
    let request = bob
        .list_contact_requests()
        .await
        .expect("contact requests")
        .into_iter()
        .next()
        .expect("contact request");
    let joined = bob
        .accept_contact_request(&request.request_id)
        .await
        .expect("accept contact request");
    assert_eq!(conversation.conversation_id, joined.conversation_id);

    // The joiner's queue advert crosses the same socket before Alice can send.
    alice.pump_inbound().await.expect("queue advert pump");
    assert_eq!(
        alice
            .get_conversation(&conversation.conversation_id)
            .await
            .expect("conversation")
            .transport_health,
        TransportHealth::Ok
    );

    let first = alice
        .send_message(&conversation.conversation_id, "first", "first-ref")
        .await
        .expect("first append");
    let second = alice
        .send_message(&conversation.conversation_id, "second", "second-ref")
        .await
        .expect("second append");

    bob_backend.fail_apply_and_restore_get_once();
    assert_eq!(bob.pump_inbound().await.expect("failed receive pass"), 0);
    assert_eq!(bob_backend.failure_counts(), (1, 1));
    assert!(
        bob.list_messages(&conversation.conversation_id, 100, None, None)
            .await
            .expect("messages after failure")
            .messages
            .is_empty(),
        "neither later ciphertext may be applied after the first group becomes unusable"
    );

    // The backend recovered after its two one-shot failures. A fresh durable
    // load must restart at the first relay index and deliver both records from
    // the same batch; the second may not have advanced the cursor past it.
    let recovered_events = bob.pump_inbound().await.expect("recovery pass");
    assert!(
        recovered_events >= 2,
        "recovering both messages must emit at least their two receive events"
    );
    let messages = bob
        .list_messages(&conversation.conversation_id, 100, None, None)
        .await
        .expect("messages after recovery")
        .messages;
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].msg_id, first.msg_id);
    assert_eq!(messages[1].msg_id, second.msg_id);
    assert!(matches!(
        &messages[0].body,
        MessageBody::Text { text } if text == "first"
    ));
    assert!(matches!(
        &messages[1].body,
        MessageBody::Text { text } if text == "second"
    ));
}
