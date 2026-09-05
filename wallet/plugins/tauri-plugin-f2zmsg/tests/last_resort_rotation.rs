//! An online owner replaces its reusable key package before it expires.

#![cfg(feature = "relay-harness")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use f2z_codec::canonical::decode_canonical;
use f2z_codec::types::{Digest, PublicKey, QueueAddress, RelayId, ShortBytes};
use f2z_kt_core::entry::{DeviceCredential, DirectoryEntryTBS, EntryKind};
use f2z_kt_core::types::{Handle, KemPublicKey, LogId};
use f2z_msg_identity::{AccountKeys, DeviceCredentialRequest};
use f2z_msg_store::MemoryBackend;
use f2z_relay_testkit::config::RelayConfig;
use f2z_relay_testkit::fake::FakeRelay;
use tauri_plugin_f2zmsg::custody::WrapKeyCustody;
use tauri_plugin_f2zmsg::engine::{Engine, IdentityInstall};
use tauri_plugin_f2zmsg::events::{EventSink, NullSink};
use tauri_plugin_f2zmsg::models::{ErrorCode, Platform};

const NOW: i64 = 1_800_000_000_000;
const ONE_DAY_MS: i64 = 86_400_000;

async fn enrolled_engine() -> Engine<MemoryBackend> {
    let engine = Engine::new(
        MemoryBackend::new(),
        Arc::new(NullSink) as Arc<dyn EventSink>,
        Platform::ZuuliDesktop,
    )
    .expect("engine")
    .with_wrap_key_custody(WrapKeyCustody::in_memory());
    let device = engine.prepare_device().await.expect("device keys");
    let account = AccountKeys::from_seed(&[7; 64], 0).expect("account");
    let credential = account
        .identity
        .issue_device_credential(&DeviceCredentialRequest {
            handle: Handle::new(b"alice".to_vec()).expect("handle"),
            device_pk: PublicKey::new(device.device_pk),
            device_kem_pk: KemPublicKey::new(device.device_kem_pk).expect("kem key"),
            not_before_ms: 0,
            not_after_ms: u64::MAX / 2,
        })
        .expect("credential");
    let wrap_key = *account.backup_wrap.as_bytes();
    engine
        .install_identity(IdentityInstall {
            handle: "alice".to_owned(),
            identity_pk: hex::encode(account.identity.public().as_bytes()),
            credential: f2z_msg_mls::credential::encode(&credential).expect("encode"),
            wrap_key,
            submitted_at: NOW,
        })
        .await
        .expect("install");
    engine.unlock(&wrap_key).await.expect("unlock");
    engine
}

async fn directory_entry(engine: &Engine<MemoryBackend>) -> DirectoryEntryTBS {
    let credential = decode_canonical::<DeviceCredential>(
        &engine
            .installed_credential()
            .await
            .expect("installed credential"),
    )
    .expect("canonical credential")
    .into_value();
    DirectoryEntryTBS {
        label: ShortBytes::new(f2z_kt_core::labels::LABEL_ENTRY.to_vec()).expect("label"),
        kt_version: 1,
        log_id: LogId::new([0x11; 32]),
        handle: credential.credential.handle.clone(),
        entry_version: 1,
        kind: EntryKind::SameKey,
        identity_pk: credential.credential.identity_pk,
        directory_auth_pk: PublicKey::new([0x22; 32]),
        devices: vec![credential].into(),
        revocations: Vec::new().into(),
        contact_endpoints: Vec::new().into(),
        prev_entry_hash: Digest::new([0; 32]),
        no_reset: 0,
        created_at_ms: 0,
    }
}

#[tokio::test]
async fn online_owner_rotates_before_expiry_and_fallback_stays_verifiable() {
    let mut config = RelayConfig::default().with_system_clock();
    // One single-use claim reaches fallback without hiding the behavior behind
    // thirty-two unrelated claims.
    config.key_package_policy.max_pool_size = 1;
    let relay = FakeRelay::new(config).expect("relay");
    let server = relay.listen_loopback().await.expect("listener");
    let relay_url = server.url();

    let engine = enrolled_engine().await;
    let refused = engine
        .add_relay(&relay_url)
        .await
        .expect_err("plaintext relay requires explicit trust");
    assert_eq!(refused.code(), ErrorCode::RelayRefusedInsecure);
    engine
        .set_relay_trust(&hex::encode(relay.relay_id().as_bytes()), true, true)
        .await
        .expect("trust test relay");
    engine.start().await.expect("start");

    let (_, _, contact_addr) = engine
        .contact_advert()
        .await
        .expect("advert")
        .expect("contact queue");
    let contact_addr = QueueAddress::from_slice(&hex::decode(contact_addr).expect("hex address"))
        .expect("contact address");
    let mut claimant = relay.client().await.expect("claimant");
    let pooled = claimant
        .claim_key_package(contact_addr)
        .await
        .expect("single-use package");
    assert_eq!(pooled.last_resort, 0);
    let old_fallback = claimant
        .claim_key_package(contact_addr)
        .await
        .expect("old fallback");
    assert_eq!(old_fallback.last_resort, 1);

    assert!(
        engine
            .last_resort_expiry_for_harness()
            .await
            .expect("expiry")
            .is_some(),
        "start persists the initial package's real expiry"
    );
    let rotation_now = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_millis(),
    )
    .expect("current time fits i64");
    let old_expiry = rotation_now + ONE_DAY_MS;
    engine
        .set_last_resort_expiry_for_harness(old_expiry)
        .await
        .expect("move expiry into the controlled refresh window");
    engine
        .refresh_key_packages_at_for_harness(rotation_now)
        .await
        .expect("rotate at the refresh boundary");
    let new_expiry = engine
        .last_resort_expiry_for_harness()
        .await
        .expect("new expiry")
        .expect("new published expiry");
    assert!(new_expiry > old_expiry);

    let replenished = claimant
        .claim_key_package(contact_addr)
        .await
        .expect("replenished single-use package");
    assert_eq!(replenished.last_resort, 0);
    let new_fallback = claimant
        .claim_key_package(contact_addr)
        .await
        .expect("new fallback");
    assert_eq!(new_fallback.last_resort, 1);
    assert_ne!(new_fallback.key_package, old_fallback.key_package);
    engine
        .verify_key_package_for_harness(
            new_fallback.key_package.as_slice(),
            &directory_entry(&engine).await,
            u64::try_from(old_expiry).expect("positive expiry"),
        )
        .await
        .expect("replacement remains valid when the old fallback expires");

    server.shutdown().await;
}

#[tokio::test]
async fn a_relay_identity_substitution_is_refused_on_the_managed_connection() {
    let relay = FakeRelay::new(RelayConfig::default().with_system_clock()).expect("relay");
    let server = relay.listen_loopback().await.expect("listener");
    let engine = Engine::new(
        MemoryBackend::new(),
        Arc::new(NullSink) as Arc<dyn EventSink>,
        Platform::ZuuliDesktop,
    )
    .expect("engine")
    .with_wrap_key_custody(WrapKeyCustody::in_memory())
    .with_insecure_directory_relays_for_harness();

    let refused = engine
        .connect_endpoint_for_harness(&server.url(), RelayId::new([0x99; 32]))
        .await
        .expect_err("a URL serving a different relay identity must be refused");
    assert_eq!(refused.code(), ErrorCode::RelayIdentityMismatch);
    server.shutdown().await;
}
