//! **A device opens its contact queue before it asks for a credential**
//! (ADR 0017 §4.1).
//!
//! e2e2z cannot publish itself: the wallet authority signs its directory
//! entry, and that entry carries the relay-issued `contact_addr` only the
//! device that opened the queue knows. So the device opens the queue first,
//! sends the address with `issue-device-credential-v2`, and installs the
//! credential that comes back. These tests hold the engine half of that to a
//! real relay: the queue exists at the relay before any identity does, the
//! install commits exactly that queue, and a second preparation discards the
//! first one's.

#![cfg(feature = "relay-harness")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use f2z_codec::types::PublicKey;
use f2z_kt_core::types::{Handle, KemPublicKey};
use f2z_msg_identity::{AccountKeys, DeviceCredentialRequest};
use f2z_msg_store::MemoryBackend;
use f2z_relay_testkit::fake::FakeRelay;
use tauri_plugin_f2zmsg::custody::WrapKeyCustody;
use tauri_plugin_f2zmsg::engine::{Engine, IdentityInstall, PreparedDevice};
use tauri_plugin_f2zmsg::events::{EventSink, NullSink};
use tauri_plugin_f2zmsg::models::{ErrorCode, Platform};

const NOW: i64 = 1_800_000_000_000;

fn engine() -> Engine<MemoryBackend> {
    Engine::new(
        MemoryBackend::new(),
        Arc::new(NullSink) as Arc<dyn EventSink>,
        Platform::ZuuliMobile,
    )
    .expect("engine")
    .with_wrap_key_custody(WrapKeyCustody::in_memory())
}

/// A loopback relay speaks `ws://`, which the strict policy refuses; the user
/// opt-in is the reviewed way to use one, and it is what the harness does.
async fn trust_loopback_relay(engine: &Engine<MemoryBackend>, url: &str) {
    let refused = engine.add_relay(url).await.expect_err("ws:// needs opt-in");
    assert_eq!(refused.code(), ErrorCode::RelayRefusedInsecure);
    let relay = engine.list_relays().await.expect("relays").remove(0);
    engine
        .set_relay_trust(&relay.relay_id, true, true)
        .await
        .expect("opt in");
}

fn install_for(prepared: &PreparedDevice, handle: &str) -> IdentityInstall {
    let account = AccountKeys::from_seed(&[0x5a; 64], 0).expect("§4.2 keys");
    let credential = account
        .identity
        .issue_device_credential(&DeviceCredentialRequest {
            handle: Handle::new(handle.as_bytes().to_vec()).expect("handle"),
            device_pk: PublicKey::new(prepared.keys.device_pk),
            device_kem_pk: KemPublicKey::new(prepared.keys.device_kem_pk.clone()).expect("kem key"),
            not_before_ms: 0,
            not_after_ms: u64::MAX / 2,
        })
        .expect("credential");
    IdentityInstall {
        credential: f2z_msg_mls::credential::encode(&credential).expect("encode"),
        expected_handle: handle.to_owned(),
        submitted_at: NOW,
        submitted_by_issuer: true,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_queue_is_opened_before_the_credential_and_installed_with_it() {
    let relay = FakeRelay::with_defaults().expect("relay");
    let server = relay.listen_loopback().await.expect("listener");
    let engine = engine();
    trust_loopback_relay(&engine, &server.url()).await;

    let prepared = engine
        .prepare_device_with_endpoint()
        .await
        .expect("keys and an endpoint");
    assert_eq!(prepared.endpoint.relay_url, server.url());
    assert_ne!(prepared.endpoint.contact_addr, [0; 32]);
    assert_ne!(prepared.endpoint.relay_id, [0; 32]);
    assert!(
        !engine.enrollment_status().await.expect("status").enrolled,
        "an endpoint is not an enrollment"
    );

    let status = engine
        .install_identity(install_for(&prepared, "alice"))
        .await
        .expect("install");
    assert!(status.enrolled);
    // This engine has no directory at all, and that outranks every publication
    // detail. What `submitted_by_issuer` does to a *configured* build is
    // `engine::activation_tests`' question.
    assert_eq!(status.blocked, Some(ErrorCode::DirectoryUnreachable));
    engine.unlock().await.expect("unlock");
    // The queue the relay issued is the one this device now advertises, and
    // starting the engine keeps it rather than opening another.
    engine.start().await.expect("start");
    let (url, relay_id, contact_addr) = engine
        .contact_advert()
        .await
        .expect("advert")
        .expect("a contact queue is installed");
    assert_eq!(url, prepared.endpoint.relay_url);
    assert_eq!(relay_id.as_bytes(), &prepared.endpoint.relay_id);
    assert_eq!(contact_addr, hex::encode(prepared.endpoint.contact_addr));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_preparation_discards_the_first_queue() {
    let relay = FakeRelay::with_defaults().expect("relay");
    let server = relay.listen_loopback().await.expect("listener");
    let device = engine();
    trust_loopback_relay(&device, &server.url()).await;

    let first = device.prepare_device_with_endpoint().await.expect("first");
    let second = device.prepare_device_with_endpoint().await.expect("second");
    assert_ne!(first.endpoint.contact_addr, second.endpoint.contact_addr);
    assert_ne!(first.keys.device_pk, second.keys.device_pk);

    device
        .install_identity(install_for(&second, "alice"))
        .await
        .expect("install the second");
    device.unlock().await.expect("unlock");
    let (_, _, contact_addr) = device.contact_advert().await.unwrap().unwrap();
    assert_eq!(contact_addr, hex::encode(second.endpoint.contact_addr));

    // A plain preparation also drops a pending queue: a later install would
    // otherwise commit an address that belongs to no key it holds.
    let fresh = engine();
    trust_loopback_relay(&fresh, &server.url()).await;
    let with_queue = fresh.prepare_device_with_endpoint().await.expect("queue");
    let plain = fresh.prepare_device().await.expect("plain keys");
    let prepared = PreparedDevice {
        keys: plain,
        endpoint: with_queue.endpoint,
    };
    fresh
        .install_identity(install_for(&prepared, "alice"))
        .await
        .expect("install");
    fresh.unlock().await.expect("unlock");
    assert!(
        fresh.contact_advert().await.unwrap().is_none(),
        "the queue opened for discarded keys must not be installed"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn no_relay_means_no_endpoint_and_the_default_is_judged_like_any_other() {
    let bare = engine();
    assert_eq!(
        bare.prepare_device_with_endpoint()
            .await
            .expect_err("nowhere to open a queue")
            .code(),
        ErrorCode::RelayUnreachable
    );

    // A build's default relay goes through `add_relay`, so a plaintext one is
    // refused rather than quietly used.
    let relay = FakeRelay::with_defaults().expect("relay");
    let server = relay.listen_loopback().await.expect("listener");
    let defaulted = engine().with_default_relay(server.url());
    assert_eq!(
        defaulted
            .prepare_device_with_endpoint()
            .await
            .expect_err("a ws:// default is not trusted")
            .code(),
        ErrorCode::RelayRefusedInsecure
    );
}
