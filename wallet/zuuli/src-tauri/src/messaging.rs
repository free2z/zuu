//! Enrollment — the three commands `docs/e2ee/CLIENT-CONTRACT.md` §2.2 keeps
//! out of `tauri-plugin-f2zmsg` on purpose.
//!
//! # Why these three live here and the other forty-three do not
//!
//! Enrollment is the one messaging operation that needs the **wallet seed**.
//! The messaging identity is seed-derived — `ARCHITECTURE.md` §4.2's
//! `S → MSK → account_node → IdentitySigningKey / DirectoryAuthKey /
//! BackupWrapKey` — so that restoring the mnemonic restores the identity.
//!
//! If this were a plugin command the seed would have to *reach* the plugin, and
//! the only two routes are the frontend reading it out of `tauri-plugin-zcash`
//! and handing it on, or one plugin calling the other across an IPC-visible
//! surface. Both put the mnemonic in the webview's garbage-collected JavaScript
//! heap, where nothing can zeroize it and any XSS, devtools session or future
//! dependency compromise can read it. ZUULI's only two seed-reaching commands
//! (`get_seed_phrase`, `get_backup_seed_phrase`) are each gated behind a
//! single-use sensitive-display lease *precisely* so the phrase is shown to a
//! human and nothing else; using one as an enrollment transport would defeat
//! the reason the lease exists.
//!
//! So this module reads the seed **in process** from `tauri-plugin-zcash`'s
//! managed state, derives §4.2's keys, issues a `DeviceCredential`, and hands
//! the messaging engine **only public material** — since ADR 0016 not even a
//! wrap key, because the engine seals under one it samples itself. The seed
//! never becomes JSON, never crosses IPC, and never enters the webview. The engine's
//! own API — [`Engine::prepare_device`] and [`Engine::install_identity`] — is
//! shaped so it never sees the seed either: the device secrets are generated
//! *inside* the engine from the OS CSPRNG and only their public halves come
//! back here to be signed over.
//!
//! # Two conventions, taken from two different places
//!
//! * **No `plugin:` prefix.** These are app-crate commands, invoked as
//!   `invoke("f2zmsg_enroll", …)`. That is `src/oauth.rs`'s precedent, and it
//!   is why they need no entry in `capabilities/default.json` or
//!   `capabilities/mobile.json` — a capability grants *plugin* commands.
//! * **Arguments nested under a single `args` key, `camelCase` inside.** That
//!   is §3's rule, which `bridge.ts` already follows for the enrollment trio.
//!   `oauth.rs` is *not* the precedent here — it passes some arguments flat —
//!   and §2.2 says so in as many words.
//!
//! # Where the caller lives
//!
//! `bridge.ts` moved to `wallet/e2e2z` in #904 phase 3, along with the whole
//! messaging surface: that app holds device keys and never the seed, which is
//! exactly why these three could not go with it. e2e2z's copy of the bridge
//! keeps the trio in its declared command population and refuses every call
//! with a typed `EnrollmentUnavailableError`, so nothing there can appear
//! enrolled. Issuing a `DeviceCredential` to that app is #905's
//! `issue-device-credential` intent, and it does not ship before #461 gives it
//! an authenticated channel — a custom-scheme deep link is not one.
//!
//! # `f2zmsg_enroll` still unlocks, but it is no longer the only thing that can
//!
//! §6.1's `locked` is a real state: after a restart the engine has an identity
//! but no device signing key, because that key is sealed at rest. Until ADR
//! 0016 (#935, #928) the seal was under the seed-derived `BackupWrapKey`, so
//! lifting `locked` needed the seed and therefore needed this file. It is now
//! under a per-device key the plugin keeps in the OS secret store, so
//! `Engine::unlock` needs no seed and `cash.free2z.e2e2z` can leave `locked` on
//! its own.
//!
//! This command keeps unlocking anyway, so a frontend that calls `enroll` on
//! launch gets "ready" rather than an error it cannot resolve — but that is now
//! a convenience, and the branch no longer reads the seed.
//!
//! # These three refuse when the plugin has no engine
//!
//! `F2zMsgExt::f2zmsg` answers even when `tauri-plugin-f2zmsg`'s `setup` could
//! not open the durable store, and `F2zMsg::engine` is a `Result` for exactly
//! that reason (#753). So each command below takes it with `?` and refuses with
//! the §8 code the store failure produced, rather than panicking on an engine
//! that was never built. In `f2zmsg_enroll` the `?` is deliberately the *first*
//! statement: there is no point reading the wallet seed for an enrollment that
//! has nowhere to be written. The plugin's pure handle-eligibility command is
//! the deliberate exception because it reads no engine or store (#762).

use f2z_codec::types::PublicKey;
use f2z_kt_core::types::{Handle, KemPublicKey};
use f2z_msg_identity::{AccountKeys, DeviceCredentialRequest};
use secrecy::ExposeSecret as _;
use serde::Deserialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_f2zmsg::engine::{Engine, IdentityInstall};
use tauri_plugin_f2zmsg::error::{Error, Result};
use tauri_plugin_f2zmsg::internal_directory;
use tauri_plugin_f2zmsg::models::{EngineState, EnrollmentStatus, ErrorCode};
use tauri_plugin_f2zmsg::state::Backend;
use tauri_plugin_f2zmsg::state::F2zMsgExt as _;
use tauri_plugin_zcash::ZcashExt as _;

use crate::directory_publish;

/// A `DeviceCredential` is valid from an hour before issuance…
///
/// `pub(crate)`: `intent.rs`'s `issue-device-credential` path applies this
/// same policy to a credential requested over the bridge, so ZUULI's own
/// self-enrollment and a cross-app request are issued under one lifetime rule
/// rather than two that could drift.
pub(crate) const CREDENTIAL_BACKDATE_MS: u64 = 3_600_000;
/// …until a year after it, matching the plugin's own harness. `KT.md` §4.1
/// leaves the window to the issuer; this is the one the two-process relay test
/// already exercises, so the shipping path and the tested path agree.
pub(crate) const CREDENTIAL_LIFETIME_MS: u64 = 31_536_000_000;

/// The account index §4.2 derives the messaging identity at. Zero, and not
/// configurable: a second index would be a second messaging identity for one
/// mnemonic, and nothing in the contract can express which one a peer resolved.
const MESSAGING_ACCOUNT: u32 = 0;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnrollArgs {
    pub handle: String,
    /// The signed-in free2z session's Knox token, used once to fetch this
    /// identity's `HandleAssertion` (ADR 0017 §5) and then dropped. Optional:
    /// without it enrollment still installs the device, and publication
    /// reports `blocked: "handle-ineligible"` until a call carries one.
    #[serde(default)]
    pub knox_token: Option<String>,
}

/// Hand-written so the token never reaches a log line.
impl std::fmt::Debug for EnrollArgs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EnrollArgs")
            .field("handle", &self.handle)
            .field(
                "knox_token",
                &self.knox_token.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnenrollArgs {
    pub confirmation: String,
}

/// §3.2 `f2zmsg_enrollment_status`. Reads the store; needs no seed.
#[tauri::command]
pub async fn f2zmsg_enrollment_status<R: Runtime>(app: AppHandle<R>) -> Result<EnrollmentStatus> {
    app.f2zmsg().engine()?.enrollment_status().await
}

/// §3.2 `f2zmsg_enroll`.
///
/// A directory *submission*, not an instant effect: `mergedAtEpoch` stays null
/// until a verified lookup shows the log merged it, and the returned status says
/// `blocked: "directory-unreachable"` for as long as this build has no log to
/// talk to. The UI shows "submitted", not "active" (§3.2).
///
/// With a bundled internal directory (ADR 0017) this also publishes the device:
/// see [`publish`]. Calling it again on an enrolled device retries publication,
/// so a failed first attempt is not terminal.
#[tauri::command]
pub async fn f2zmsg_enroll<R: Runtime>(
    app: AppHandle<R>,
    args: EnrollArgs,
) -> Result<EnrollmentStatus> {
    let engine = app.f2zmsg().engine_handle()?;

    let status = engine.enrollment_status().await?;
    if status.enrolled {
        if status.handle.as_deref() != Some(args.handle.as_str()) {
            return Err(Error::new(
                ErrorCode::HandleIneligible,
                format!(
                    "this device is already enrolled under a different handle; \
                     requested {:?}",
                    args.handle
                ),
            ));
        }
        // §6.1's `locked` -> unlocked, and ONLY from `locked`. `unlock` ends by
        // setting the engine to `stopped`, which is right coming out of
        // `locked` and wrong on a running engine: a stray `enroll` would mark a
        // live engine stopped while its relay connections stayed open, and the
        // next `start_engine` would reconnect relays it was already connected
        // to. Every other state is already unlocked, so there is nothing to do.
        if engine.status().await?.state == EngineState::Locked {
            engine.unlock().await?;
        }
        publish(
            &engine,
            AccountSource::Wallet(&app),
            args.knox_token.as_deref(),
        )
        .await;
        return engine.enrollment_status().await;
    }

    // Read the seed only on the branch that needs it. Before ADR 0016 both did,
    // because unlocking meant re-deriving `BackupWrapKey`; now an `enroll` with
    // nothing to enroll never opens the wallet's custody.
    let account = account_keys(&app).await?;

    // The device keys are generated inside the engine, from the OS CSPRNG, and
    // are deliberately not seed-derivable (§4.2): restoring the mnemonic
    // restores the *identity*, it does not resurrect a device. Only the public
    // halves come back here.
    let device = engine.prepare_device().await?;

    let now = now_ms();
    let credential = account
        .identity
        .issue_device_credential(&DeviceCredentialRequest {
            handle: Handle::new(args.handle.as_bytes().to_vec()).map_err(|error| {
                Error::new(
                    ErrorCode::HandleIneligible,
                    format!("{:?} is not a directory handle: {error}", args.handle),
                )
            })?,
            device_pk: PublicKey::new(device.device_pk),
            device_kem_pk: KemPublicKey::new(device.device_kem_pk.clone())
                .map_err(|error| Error::internal(format!("device KEM key: {error}")))?,
            not_before_ms: u64::try_from(now)
                .unwrap_or_default()
                .saturating_sub(CREDENTIAL_BACKDATE_MS),
            not_after_ms: u64::try_from(now)
                .unwrap_or_default()
                .saturating_add(CREDENTIAL_LIFETIME_MS),
        })
        .map_err(|error| Error::internal(format!("issuing a device credential: {error}")))?;
    let credential = f2z_msg_mls::credential::encode(&credential)
        .map_err(|error| Error::internal(format!("encoding a device credential: {error}")))?;

    engine
        .install_identity(IdentityInstall {
            credential,
            // The handle the user asked for. ZUULI issues this credential
            // itself, from the seed, so today the comparison cannot fail — it
            // is the same check e2e2z will need when the credential arrives
            // over the intent bridge instead (#936).
            expected_handle: args.handle.clone(),
            submitted_at: now,
        })
        .await?;
    engine.unlock().await?;
    // The same account keys sign the entry; read the seed once, not twice.
    publish::<R>(
        &engine,
        AccountSource::Held(&account),
        args.knox_token.as_deref(),
    )
    .await;
    engine.enrollment_status().await
}

/// Where the account keys for signing come from.
enum AccountSource<'a, R: Runtime> {
    /// `f2zmsg_enroll` derived them a moment ago for the credential.
    Held(&'a AccountKeys),
    /// Read the wallet seed only if there turns out to be something to sign.
    Wallet(&'a AppHandle<R>),
}

/// Publish this device to the bundled directory (ADR 0017 §4). Never fails the
/// enrollment it follows: a refusal is recorded on the engine, where
/// `enrollment_status().blocked` reports it, and logged with its detail.
async fn publish<R: Runtime>(
    engine: &Engine<Backend>,
    source: AccountSource<'_, R>,
    knox_token: Option<&str>,
) {
    if let Err(error) = publish_steps(engine, source, knox_token).await {
        tracing::warn!(
            code = %error.code(),
            context = %error.context(),
            "messaging directory publication did not complete"
        );
        engine.record_publication_error(error.code()).await;
    }
}

async fn publish_steps<R: Runtime>(
    engine: &Engine<Backend>,
    source: AccountSource<'_, R>,
    knox_token: Option<&str>,
) -> Result<()> {
    let bundled = internal_directory::bundled();
    let Some(internal) = bundled.configured() else {
        // Fail closed: no log, nothing to publish, `blocked` already says so.
        return Ok(());
    };

    // The contact endpoint is the one the relay issues to a running engine.
    engine.start().await?;
    if engine.refresh_enrollment().await?.merged_at_epoch.is_some() {
        return Ok(());
    }
    let now = u64::try_from(now_ms()).unwrap_or_default();
    if engine.submission_pending(internal.log_id, now).await? {
        // Submitted and promised; resubmitting before the merge deadline
        // would only collide with our own pending entry.
        return Ok(());
    }
    let publication = engine.directory_publication().await?;
    if publication.already_published() {
        return Ok(());
    }

    let held;
    let account = match source {
        AccountSource::Held(account) => account,
        AccountSource::Wallet(app) => {
            held = account_keys(app).await?;
            &held
        }
    };

    let draft = directory_publish::draft_for(internal, &publication, now)?;
    let assertion = if publication.predecessor.is_none() {
        let token = knox_token.ok_or_else(|| {
            Error::new(
                ErrorCode::HandleIneligible,
                "publishing a first directory entry needs a signed-in free2z session",
            )
        })?;
        let client = directory_publish::HandleAssertionClient::new(&internal.handle_assertion_url)?;
        let issued = client.fetch(token, &publication.identity_pk).await?;
        // The signed bytes are what count, and `precheck` reads them; this is
        // the earlier, plainer refusal for the common mismatch.
        if issued.handle != publication.handle {
            return Err(Error::new(
                ErrorCode::HandleIneligible,
                format!(
                    "the free2z account's handle is {:?}, but this device enrolled {:?}",
                    issued.handle, publication.handle
                ),
            ));
        }
        Some(issued.bytes)
    } else {
        None
    };

    let signed = directory_publish::sign(account, &publication, &draft, assertion.as_deref())?;
    if let Some(assertion) = &assertion {
        directory_publish::precheck(internal, &signed, assertion, now)?;
    }
    engine
        .submit_directory_entry(
            signed.envelope.clone(),
            signed.entry_version(),
            *signed.entry_digest.as_bytes(),
        )
        .await?;
    engine.refresh_enrollment().await?;
    Ok(())
}

/// §3.2 `f2zmsg_unenroll`. Destructive and irreversible from the user's point
/// of view, which is why it takes a typed confirmation.
#[tauri::command]
pub async fn f2zmsg_unenroll<R: Runtime>(
    app: AppHandle<R>,
    args: UnenrollArgs,
) -> Result<EnrollmentStatus> {
    app.f2zmsg().engine()?.unenroll(&args.confirmation).await
}

/// Read the active wallet's seed **in process** and derive §4.2's account keys.
///
/// Everything the seed touches is confined to this function. The phrase is a
/// `Zeroizing<String>` from the Zcash plugin, the 64-byte seed is a
/// `SecretVec<u8>`, and [`AccountKeys`] holds only the derived keys — the seed
/// itself is dropped before this returns.
///
/// `pub(crate)`: `intent.rs` calls this to answer an `issue-device-credential`
/// request from another app. It is still the only function in the crate that
/// touches the seed for messaging purposes — the intent authority reads the
/// account keys through here rather than re-deriving them, for the same
/// reason `f2zmsg_enroll` does not restate `AccountKeys::from_seed` itself.
pub(crate) async fn account_keys<R: Runtime>(app: &AppHandle<R>) -> Result<AccountKeys> {
    let wallet = &app.zcash().state;
    let wallet_id = wallet.active_wallet_id().await.ok_or_else(|| {
        // §8's union has no "no wallet" member, and inventing one here would
        // put a code in the client's `ErrorCode` union that the contract does
        // not declare. The detail goes to the log, per §8's rule for
        // `internal`.
        Error::internal("messaging enrollment requires an active Zcash wallet")
    })?;

    // The same guard `get_backup_seed_phrase` takes: a wallet switch or delete
    // must not race a read of its custody.
    let transition = wallet.lock_wallet_transition().await;
    let phrase = wallet
        .get_seed_phrase(&transition, &wallet_id)
        .await
        .map_err(|error| Error::internal(format!("reading wallet custody: {error}")))?;
    let mnemonic = tauri_plugin_zcash::wallet::keys::parse_mnemonic(&phrase)
        .map_err(|error| Error::internal(format!("wallet custody: {error}")))?;
    let seed = tauri_plugin_zcash::wallet::keys::mnemonic_to_seed(&mnemonic);
    drop(phrase);

    AccountKeys::from_seed(seed.expose_secret(), MESSAGING_ACCOUNT)
        .map_err(|error| Error::internal(format!("deriving §4.2 account keys: {error}")))
}

fn now_ms() -> i64 {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire names `bridge.ts`'s `WIRE_COMMANDS` maps the enrollment trio
    /// to. They carry no `plugin:` prefix, and a rename here would leave the
    /// frontend invoking a command that does not exist — a runtime failure with
    /// no build-time symptom on either side.
    ///
    /// The bridge lives in `wallet/e2e2z` since #904 phase 3 — the messaging
    /// surface moved to the app that holds no seed. These three commands did
    /// not move and cannot: they read the wallet seed in process. The names
    /// therefore have to stay pinned across two packages rather than one, which
    /// is more reason for this assertion, not less.
    #[test]
    fn the_enrollment_trio_keeps_its_wire_names() {
        let bridge = include_str!("../../../e2e2z/src/lib/messaging/bridge.ts");
        for name in [
            "f2zmsg_enrollment_status",
            "f2zmsg_enroll",
            "f2zmsg_unenroll",
        ] {
            assert!(
                bridge.contains(&format!("\"{name}\"")),
                "bridge.ts no longer names {name}",
            );
        }
    }

    /// §3's argument rule, which is *not* `oauth.rs`'s. `bridge.ts` sends
    /// `{ args: { handle } }`, so a flat `handle: String` parameter would fail
    /// deserialization at the boundary for every caller.
    #[test]
    fn enrollment_arguments_are_nested_and_camel_case() {
        let args: EnrollArgs =
            serde_json::from_str(r#"{"handle":"alice"}"#).expect("handle is the only field");
        assert_eq!(args.handle, "alice");
        assert!(
            serde_json::from_str::<EnrollArgs>(r#"{"handle":"alice","extra":1}"#).is_err(),
            "deny_unknown_fields must reject an argument the command does not read",
        );

        let confirm: UnenrollArgs = serde_json::from_str(r#"{"confirmation":"DELETE"}"#)
            .expect("confirmation is the only field");
        assert_eq!(confirm.confirmation, "DELETE");
    }
}
