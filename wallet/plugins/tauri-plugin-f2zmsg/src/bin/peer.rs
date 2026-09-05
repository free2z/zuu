//! `f2zmsg-peer` — one messaging engine, in its own process.
//!
//! This exists for one claim: **two independent instances exchange a message
//! over a real relay.** Two engines in one process would prove much less — they
//! would share an allocator, a runtime, a clock and, if anything were wired
//! wrong, a store. So this is a binary, `tests/two_instances_over_a_relay.rs`
//! spawns two of them against a real WebSocket listener, and each one has its
//! own SQLite file, its own device keys and its own relay connection.
//!
//! # What is substituted, and nothing else
//!
//! Exactly one thing: the **proof machinery** behind the directory resolution.
//! `CLIENT-CONTRACT.md` §6.4 and §9 rule 5 say a client must never proceed on an
//! unverified key at first contact, and the shipping build therefore refuses —
//! see `crate::directory`. So [`FileDirectory`] below reads what each peer
//! published into a shared filesystem directory, and the engine's own
//! `start_conversation` and `accept_contact_request` run **unchanged** from
//! there.
//!
//! What is *not* substituted, and matters since `WIRE.md` §12.6: the
//! `DirectoryEntry` each peer publishes is a **real, canonically encoded
//! `DirectoryEntryTBS`** carrying a real `DeviceCredential` signed by a real
//! seed-derived identity key. That is what §12.6's authentication runs against,
//! so the check `f2z_msg_mls::VerifiedKeyPackage::verify` performs here is the
//! shipping one against real bytes; what a real log adds on top is the
//! inclusion proof, the witness cosignatures and the pin, and those are
//! exercised — with a real `f2z-kt` and a real `f2z-witness` — by
//! `rs/crates/f2z-kt-client/tests/first_contact.rs`. They live there rather
//! than here because `f2z-kt` and `f2z-witness` are AGPL-3.0 and this crate is
//! on the client side of the boundary `rs/README.md` describes; a dev-dependency
//! on either would put them in ZUULI's lockfile.
//!
//! Nothing else is faked. The relay is a real one over a real socket, key
//! packages are really published to it and really claimed from it (§12.6), the
//! ciphertext is real MLS `PrivateMessage`s under the X-Wing hybrid ciphersuite,
//! and the ACK is sent only after the local write commits.
//!
//! # Usage
//!
//! ```text
//! f2zmsg-peer --handle alice --peer bob --role initiator \
//!             --relay ws://127.0.0.1:9944/relay/v1 \
//!             --state /tmp/alice --shared /tmp/shared \
//!             --send "hello, bob" --expect "hello, alice"
//! ```
//!
//! It prints one JSON object on stdout and exits non-zero on any failure.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use f2z_codec::canonical::{decode_canonical, encode as encode_canonical};
use f2z_codec::types::{Digest, PublicKey, QueueAddress, RelayId, ShortBytes};
use f2z_kt_core::entry::{ContactEndpoint, DeviceCredential, DirectoryEntryTBS, EntryKind};
use f2z_kt_core::types::{Handle, KemPublicKey, LogId};
use f2z_msg_identity::{AccountKeys, DeviceCredentialRequest};
use f2z_msg_store::SqliteBackend;
use serde::{Deserialize, Serialize};
use tauri_plugin_f2zmsg::custody::WrapKeyCustody;
use tauri_plugin_f2zmsg::directory::{Directory, ResolvedIdentity, ResolvedPeer};
use tauri_plugin_f2zmsg::engine::{Engine, IdentityInstall};
use tauri_plugin_f2zmsg::error::{Error, Result};
use tauri_plugin_f2zmsg::events::RecordingSink;
use tauri_plugin_f2zmsg::models::{DirectoryResolution, ErrorCode, Platform};

/// What a peer publishes about itself.
///
/// `entry` is a **real** canonically encoded `DirectoryEntryTBS`, exactly the
/// structure a log would commit to its tree and exactly what §12.6's key-package
/// authentication is checked against. There is deliberately no `key_package`
/// field any more: since §12.6 a key package is *not* published in the
/// directory — it is claimed from the relay, one per claimer, and authenticated
/// against this entry.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Published {
    handle: String,
    identity_pk: String,
    /// `hex(tls_codec(DirectoryEntryTBS))`.
    entry: String,
    contact_relay_url: String,
    contact_relay_id: String,
    contact_addr: String,
}

impl Published {
    fn decoded_entry(&self) -> Result<DirectoryEntryTBS> {
        let bytes = hex::decode(&self.entry).map_err(|_| {
            Error::new(
                ErrorCode::DirectoryProtocolViolation,
                "a published entry is not hex",
            )
        })?;
        Ok(decode_canonical::<DirectoryEntryTBS>(&bytes)
            .map_err(|_| {
                Error::new(
                    ErrorCode::DirectoryProtocolViolation,
                    "a published entry is not a canonical DirectoryEntryTBS",
                )
            })?
            .into_value())
    }
}

/// A [`Directory`] backed by a shared filesystem directory.
///
/// It answers the two questions the log would, and it answers them **without
/// any cryptographic assurance at all** — which is the whole reason it lives in
/// a test binary and not in the plugin. `threshold_met()` reports `true` so the
/// engine does not refuse; that is a lie the harness is entitled to tell about
/// itself and the shipping build is not.
struct FileDirectory {
    shared: PathBuf,
}

impl Directory for FileDirectory {
    fn resolve(&self, handle: &str) -> Result<DirectoryResolution> {
        let published = self.read(handle);
        Ok(DirectoryResolution {
            handle: handle.to_owned(),
            found: published.is_some(),
            identity_fingerprint: published.as_ref().map(|entry| entry.identity_pk.clone()),
            device_count: u32::from(published.is_some()),
            entry_version: published.as_ref().map(|_| 1),
            epoch: 1,
            witness_cosignatures: 1,
            independent_witnesses: 1,
            threshold_met: true,
        })
    }

    fn resolve_identity(&self, handle: &str) -> Result<ResolvedIdentity> {
        let peer = self.resolve_peer(handle)?;
        Ok(ResolvedIdentity {
            resolution: peer.resolution,
            identity_pk: peer.identity_pk,
            entry: peer.entry,
            contact_relay_url: peer.contact_relay_url,
            contact_relay_id: peer.contact_relay_id,
            contact_addr: peer.contact_addr,
        })
    }

    fn resolve_peer(&self, handle: &str) -> Result<ResolvedPeer> {
        let published = self.read(handle).ok_or_else(|| {
            Error::new(
                ErrorCode::DirectoryUnreachable,
                format!("{handle} has published nothing yet"),
            )
        })?;
        let entry = published.decoded_entry()?;
        Ok(ResolvedPeer {
            resolution: self.resolve(handle)?,
            identity_pk: published.identity_pk,
            entry,
            contact_relay_url: published.contact_relay_url,
            contact_relay_id: RelayId::new(
                hex::decode(published.contact_relay_id)
                    .map_err(|_| Error::internal("a relay id is not hex"))?
                    .try_into()
                    .map_err(|_| Error::internal("a relay id is the wrong length"))?,
            ),
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

impl FileDirectory {
    fn read(&self, handle: &str) -> Option<Published> {
        let bytes = std::fs::read(self.shared.join(format!("{handle}.peer.json"))).ok()?;
        serde_json::from_slice(&bytes).ok()
    }
}

struct Options {
    handle: String,
    peer: String,
    initiator: bool,
    relay: String,
    state: PathBuf,
    shared: PathBuf,
    send: String,
    expect: String,
    seed: u8,
    timeout: Duration,
}

fn parse() -> std::result::Result<Options, String> {
    let mut handle = None;
    let mut peer = None;
    let mut role = None;
    let mut relay = None;
    let mut state = None;
    let mut shared = None;
    let mut send = None;
    let mut expect = None;
    let mut seed = 1u8;
    let mut timeout = 120u64;

    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let mut value = || args.next().ok_or(format!("{flag} needs a value"));
        match flag.as_str() {
            "--handle" => handle = Some(value()?),
            "--peer" => peer = Some(value()?),
            "--role" => role = Some(value()?),
            "--relay" => relay = Some(value()?),
            "--state" => state = Some(PathBuf::from(value()?)),
            "--shared" => shared = Some(PathBuf::from(value()?)),
            "--send" => send = Some(value()?),
            "--expect" => expect = Some(value()?),
            "--seed" => seed = value()?.parse().map_err(|_| "--seed is a byte")?,
            "--timeout-seconds" => {
                timeout = value()?.parse().map_err(|_| "--timeout is seconds")?
            }
            other => return Err(format!("unknown flag {other}")),
        }
    }

    Ok(Options {
        handle: handle.ok_or("--handle is required")?,
        peer: peer.ok_or("--peer is required")?,
        initiator: role.as_deref() == Some("initiator"),
        relay: relay.ok_or("--relay is required")?,
        state: state.ok_or("--state is required")?,
        shared: shared.ok_or("--shared is required")?,
        send: send.ok_or("--send is required")?,
        expect: expect.ok_or("--expect is required")?,
        seed,
        timeout: Duration::from_secs(timeout),
    })
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    // The engine reports every refusal through `tracing` and puts nothing but a
    // §8 code on the wire. A harness that dropped those would turn any failure
    // into "it did not happen" with no way to find out why.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    match run().await {
        Ok(report) => {
            println!("{report}");
            std::process::ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("f2zmsg-peer: {message}");
            std::process::ExitCode::FAILURE
        }
    }
}

async fn run() -> std::result::Result<String, String> {
    let options = parse()?;
    std::fs::create_dir_all(&options.state).map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&options.shared).map_err(|error| error.to_string())?;

    let backend = SqliteBackend::open(&options.state.join("f2zmsg.sqlite"))
        .map_err(|error| format!("opening the store: {error}"))?;
    let sink = Arc::new(RecordingSink::new());
    let engine = Engine::new(backend, sink.clone(), Platform::ZuuliDesktop)
        .map_err(|error| describe(&error))?
        .with_wrap_key_custody(WrapKeyCustody::in_memory())
        .with_insecure_directory_relays_for_harness()
        .with_directory(Arc::new(FileDirectory {
            shared: options.shared.clone(),
        }));

    enroll(&engine, &options)
        .await
        .map_err(|error| describe(&error))?;
    connect(&engine, &options)
        .await
        .map_err(|error| describe(&error))?;
    engine.start().await.map_err(|error| describe(&error))?;

    publish(&engine, &options)
        .await
        .map_err(|error| describe(&error))?;
    wait_for_peer(&options)?;

    let conversation_id = if options.initiator {
        // The shipping path, in full: resolve, create the group, add the peer
        // from its published `KeyPackage`, open a queue, and `CONTACT_APPEND`
        // the `Welcome` behind a proof-of-work stamp.
        let conversation = engine
            .start_conversation(&options.peer)
            .await
            .map_err(|error| describe(&error))?;
        conversation.conversation_id
    } else {
        // The other side of §12.5: the `Welcome` lands on this device's contact
        // queue, becomes a pending `ContactRequest`, and is accepted only after
        // the directory answers for the sender's handle (§6.4).
        let request = poll(&engine, options.timeout, || async {
            engine
                .list_contact_requests()
                .await
                .ok()
                .and_then(|requests| requests.into_iter().next())
        })
        .await
        .ok_or("no contact request arrived")?;
        let conversation = engine
            .accept_contact_request(&request.request_id)
            .await
            .map_err(|error| describe(&error))?;
        conversation.conversation_id
    };

    // The initiator learns where to write from the joiner's in-band
    // `queue_advert`, which cannot arrive before the joiner has joined.
    poll(&engine, options.timeout, || async {
        let conversation = engine.get_conversation(&conversation_id).await.ok()?;
        (conversation.transport_health == tauri_plugin_f2zmsg::models::TransportHealth::Ok)
            .then_some(())
    })
    .await
    .ok_or("the conversation never became sendable")?;

    // Round one. Both peers send without waiting, so the two messages are
    // genuinely concurrent in the DAG — neither references the other, which is
    // what concurrent *means* and is the ordinary case in a live conversation.
    let accepted = engine
        .send_message(&conversation_id, &options.send, "harness-ref-1")
        .await
        .map_err(|error| describe(&error))?;
    let received = await_text(&engine, &conversation_id, &options.expect, options.timeout).await?;

    // Round two, sent strictly after round one arrived. This one is *causally
    // after* the peer's first message, so its `parents` must contain it — which
    // is the assertion round one cannot make without racing.
    let second_send = format!("{} (2)", options.send);
    let second_expect = format!("{} (2)", options.expect);
    let accepted_second = engine
        .send_message(&conversation_id, &second_send, "harness-ref-2")
        .await
        .map_err(|error| describe(&error))?;
    let received_second =
        await_text(&engine, &conversation_id, &second_expect, options.timeout).await?;

    // Every message this device holds, in §7's order, so the test can assert
    // that a `parents` hash always names something held — which is the property that makes gap
    // detection a certainty rather than a guess (§3.5).
    let page = engine
        .list_messages(&conversation_id, 100, None, None)
        .await
        .map_err(|error| describe(&error))?;
    let held: Vec<String> = page
        .messages
        .iter()
        .map(|message| message.msg_id.clone())
        .collect();
    // Each held message's parents, in the same order, so the test can assert
    // §7's primary half: every parent appears *earlier* in the page than the
    // message referencing it. That is the property the sort key alone does not
    // give — a reply from the lower leaf index sorts above what it answers —
    // and it is what `list_messages` exists to have already decided.
    let held_parents: Vec<Vec<String>> = page
        .messages
        .iter()
        .map(|message| message.parents.clone())
        .collect();
    let gaps = engine
        .list_gaps(&conversation_id)
        .await
        .map_err(|error| describe(&error))?
        .len();

    // §3.6's `mark_read`, exercised because it is the one command whose answer
    // is a *recomputation* against §7's order rather than a stored counter.
    // Both directions, since only the pair is race-free: which of the two
    // concurrent round-one messages sorts first depends on the interleaving.
    let unread_after_first = unread_after(
        &engine,
        &conversation_id,
        held.first().map_or("", String::as_str),
    )
    .await?;
    let unread_after_last = unread_after(
        &engine,
        &conversation_id,
        held.last().map_or("", String::as_str),
    )
    .await?;

    let events: Vec<&'static str> = sink.seen().into_iter().map(|(name, _)| name).collect();
    let report = serde_json::json!({
        "handle": options.handle,
        "conversationId": conversation_id,
        "sentMsgId": accepted.msg_id,
        "receivedMsgId": received.msg_id,
        "receivedEpoch": received.epoch,
        "receivedSenderLeafIndex": received.sender_leaf_index,
        "receivedParents": received.parents,
        "sentSecondMsgId": accepted_second.msg_id,
        "receivedSecondMsgId": received_second.msg_id,
        "receivedSecondParents": received_second.parents,
        "held": held,
        "heldParents": held_parents,
        "gaps": gaps,
        "unreadAfterFirst": unread_after_first,
        "unreadAfterLast": unread_after_last,
        "events": events,
    });
    Ok(report.to_string())
}

/// §2.2's enrollment, performed the way the app crate performs it: the seed
/// stays in this process, and only public material crosses into the engine.
async fn enroll(engine: &Engine<SqliteBackend>, options: &Options) -> Result<()> {
    if engine.enrollment_status().await?.enrolled {
        return Ok(());
    }
    let device = engine.prepare_device().await?;

    // A BIP-39-shaped seed. In ZUULI this is the wallet's, read in process from
    // `tauri-plugin-zcash`'s managed state and never serialized.
    let seed = [options.seed; 64];
    let account = AccountKeys::from_seed(&seed, 0)
        .map_err(|error| Error::internal(format!("deriving §4.2 keys: {error}")))?;

    let now = i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or_default();
    let credential = account
        .identity
        .issue_device_credential(&DeviceCredentialRequest {
            handle: Handle::new(options.handle.as_bytes().to_vec())
                .map_err(|error| Error::internal(format!("handle: {error}")))?,
            device_pk: PublicKey::new(device.device_pk),
            device_kem_pk: KemPublicKey::new(device.device_kem_pk.clone())
                .map_err(|error| Error::internal(format!("kem key: {error}")))?,
            not_before_ms: u64::try_from(now)
                .unwrap_or_default()
                .saturating_sub(3_600_000),
            not_after_ms: u64::try_from(now)
                .unwrap_or_default()
                .saturating_add(31_536_000_000),
        })
        .map_err(|error| Error::internal(format!("issuing a credential: {error}")))?;
    let credential_bytes = f2z_msg_mls::credential::encode(&credential)
        .map_err(|error| Error::internal(format!("encoding a credential: {error}")))?;

    engine
        .install_identity(IdentityInstall {
            handle: options.handle.clone(),
            identity_pk: hex::encode(account.identity.public().as_bytes()),
            credential: credential_bytes,
            wrap_key: *account.backup_wrap.as_bytes(),
            submitted_at: now,
        })
        .await?;
    engine.unlock(account.backup_wrap.as_bytes()).await?;
    Ok(())
}

/// Add the relay, then give it §2.3's explicit per-relay opt-in.
///
/// `FakeRelay` serves `ws://` and publishes `transport_security: none`, so
/// `add_relay` refuses it with `relay-refused-insecure` and stores it as
/// `refused` — which is exactly the flow a user takes with a developer relay,
/// and exercising it here is the point rather than an inconvenience.
async fn connect(engine: &Engine<SqliteBackend>, options: &Options) -> Result<()> {
    match engine.add_relay(&options.relay).await {
        Ok(_) => return Ok(()),
        Err(error) if error.code() == ErrorCode::RelayRefusedInsecure => {}
        Err(error) => return Err(error),
    }
    let relay = engine
        .list_relays()
        .await?
        .into_iter()
        .find(|relay| relay.relay_url == options.relay)
        .ok_or_else(|| Error::internal("the refused relay was not recorded"))?;
    engine.set_relay_trust(&relay.relay_id, true, true).await?;
    Ok(())
}

/// Publish the directory entry this device would submit to a log.
///
/// **No key package.** Since `WIRE.md` §12.6 those are published to the relay by
/// `start_engine` and claimed one at a time; a directory entry carries none, and
/// `KT.md` §4.1's exclusion stands.
async fn publish(engine: &Engine<SqliteBackend>, options: &Options) -> Result<()> {
    let (contact_relay_url, contact_relay_id, contact_addr) = engine
        .contact_advert()
        .await?
        .ok_or_else(|| Error::internal("start_engine did not open a contact queue"))?;
    let entry = directory_entry(
        engine,
        options,
        &contact_relay_url,
        contact_relay_id,
        &contact_addr,
    )
    .await?;
    let published = Published {
        handle: options.handle.clone(),
        identity_pk: engine
            .device_info()
            .await?
            .identity_fingerprint
            .replace(' ', ""),
        entry: hex::encode(
            encode_canonical(&entry)
                .map_err(|error| Error::internal(format!("encoding an entry: {error:?}")))?,
        ),
        contact_relay_url,
        contact_relay_id: hex::encode(contact_relay_id.as_bytes()),
        contact_addr,
    };
    let path = options.shared.join(format!("{}.peer.json", options.handle));
    let temporary = path.with_extension("tmp");
    std::fs::write(
        &temporary,
        serde_json::to_vec(&published)
            .map_err(|error| Error::internal(format!("publishing: {error}")))?,
    )
    .map_err(Error::from)?;
    // Rename rather than write in place, so the other process never reads half
    // a file — the same reason a real client would not publish a partial entry.
    std::fs::rename(&temporary, &path).map_err(Error::from)?;
    Ok(())
}

/// The `DirectoryEntryTBS` this device would submit to a log.
///
/// Assembled here rather than faked: every field is the real value, the
/// `DeviceCredential` is the one enrollment issued and signed with the
/// seed-derived identity key, and the `ContactEndpoint` is the address
/// `start_engine` actually opened. What a real log adds is the inclusion proof
/// and the witness cosignatures over a root — the parts this harness cannot
/// carry without an AGPL dependency, and which
/// `rs/crates/f2z-kt-client/tests/first_contact.rs` exercises for real.
async fn directory_entry(
    engine: &Engine<SqliteBackend>,
    options: &Options,
    contact_relay_url: &str,
    contact_relay_id: RelayId,
    contact_addr: &str,
) -> Result<DirectoryEntryTBS> {
    let credential_bytes = engine.installed_credential().await?;
    let credential = decode_canonical::<DeviceCredential>(&credential_bytes)
        .map_err(|error| Error::internal(format!("decoding a credential: {error:?}")))?
        .into_value();
    let identity_pk = credential.credential.identity_pk;
    let seed = [options.seed; 64];
    let account = AccountKeys::from_seed(&seed, 0)
        .map_err(|error| Error::internal(format!("deriving §4.2 keys: {error}")))?;

    let contact_addr =
        hex::decode(contact_addr).map_err(|_| Error::internal("a contact address is not hex"))?;
    let contact_addr = QueueAddress::from_slice(&contact_addr)
        .map_err(|_| Error::internal("a contact address is the wrong length"))?;

    Ok(DirectoryEntryTBS {
        label: ShortBytes::new(f2z_kt_core::labels::LABEL_ENTRY.to_vec())
            .map_err(|error| Error::internal(format!("entry label: {error:?}")))?,
        kt_version: 1,
        log_id: LogId::new([0u8; 32]),
        handle: credential.credential.handle.clone(),
        entry_version: 1,
        kind: EntryKind::SameKey,
        identity_pk,
        directory_auth_pk: PublicKey::new(*account.directory_auth.public().as_bytes()),
        devices: vec![credential].into(),
        revocations: Vec::new().into(),
        contact_endpoints: vec![ContactEndpoint {
            relay_url: ShortBytes::new(contact_relay_url.as_bytes().to_vec())
                .map_err(|error| Error::internal(format!("relay url: {error:?}")))?,
            relay_id: contact_relay_id,
            contact_addr,
        }]
        .into(),
        prev_entry_hash: Digest::new([0u8; 32]),
        no_reset: 0,
        created_at_ms: 0,
    })
}

fn wait_for_peer(options: &Options) -> std::result::Result<(), String> {
    let path = options.shared.join(format!("{}.peer.json", options.peer));
    let deadline = Instant::now() + options.timeout;
    while Instant::now() < deadline {
        if readable(&path) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!("{} never published", options.peer))
}

fn readable(path: &Path) -> bool {
    std::fs::read(path).is_ok_and(|bytes| serde_json::from_slice::<Published>(&bytes).is_ok())
}

/// `mark_read` up to one message, then read the counter back.
async fn unread_after(
    engine: &Engine<SqliteBackend>,
    conversation_id: &str,
    msg_id: &str,
) -> std::result::Result<u32, String> {
    engine
        .mark_read(conversation_id, msg_id)
        .await
        .map_err(|error| describe(&error))?;
    Ok(engine
        .get_conversation(conversation_id)
        .await
        .map_err(|error| describe(&error))?
        .unread_count)
}

/// Pump until a message with exactly this text has been durably written.
async fn await_text(
    engine: &Engine<SqliteBackend>,
    conversation_id: &str,
    text: &str,
    timeout: Duration,
) -> std::result::Result<tauri_plugin_f2zmsg::models::Message, String> {
    poll(engine, timeout, || async {
        let page = engine
            .list_messages(conversation_id, 100, None, None)
            .await
            .ok()?;
        page.messages.into_iter().find(|message| {
            matches!(
                &message.body,
                tauri_plugin_f2zmsg::models::MessageBody::Text { text: body } if body == text
            )
        })
    })
    .await
    .ok_or_else(|| format!("{text:?} never arrived"))
}

/// Drive the inbound pump until a condition holds, or give up.
///
/// The pump is what the plugin's receive task calls on a timer; here it is
/// called directly so the harness controls the pace and a failure is a timeout
/// with a message rather than a hang.
async fn poll<T, F, Fut>(
    engine: &Engine<SqliteBackend>,
    timeout: Duration,
    mut check: F,
) -> Option<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Err(error) = engine.pump_inbound().await {
            eprintln!("pump: {}", describe(&error));
        }
        if let Some(value) = check().await {
            return Some(value);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    None
}

/// The engine deliberately serializes only the §8 code to the webview; a
/// harness is allowed the context, and needs it to be diagnosable.
fn describe(error: &Error) -> String {
    format!("{} ({})", error.code(), error.context())
}
