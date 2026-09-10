//! This device's public keys, for the `issue-device-credential` intent (#905).
//!
//! `docs/e2ee/ARCHITECTURE.md` §4.2 splits the messaging key material in two:
//!
//! - **Account keys** — `IdentitySigningKey`, `DirectoryAuthKey`,
//!   `BackupWrapKey` — are *seed-derived*, so restoring the mnemonic restores
//!   the identity. e2e2z never holds the seed and therefore never holds these.
//! - **Device keys** — `DeviceSignatureKey`, `DeviceInitKey`, `QueueKey_{q}` —
//!   are generated on-device from the **OS CSPRNG**, are **never
//!   seed-derived**, and are **never exported**.
//!
//! That split is the entire reason this app can exist: ongoing messaging needs
//! only the second set, so the seed is needed exactly once, at enrollment, to
//! sign a `DeviceCredential` binding the account to the device. #905's
//! `issue-device-credential` intent is how that one signature is asked for, and
//! the request it carries needs this device's **public** halves.
//!
//! # Why this is a Rust command and not a few lines of `crypto.subtle`
//!
//! The keys already exist here. `tauri_plugin_f2zmsg::engine::Engine`'s
//! `prepare_device` is the *only* place in the shipping tree that samples a
//! device key set, it does it from `rand::rng()` (the OS generator), it keeps
//! the private halves in the plugin's process memory, and `install_identity`
//! is the only thing that can consume them. Generating a second keypair in the
//! renderer would mean:
//!
//! 1. a second cryptographic implementation, in the least auditable process in
//!    the system, whose output would then have to be smuggled *back* into the
//!    engine for the credential to be worth anything, and
//! 2. a private key in a garbage-collected JavaScript heap — the same exposure
//!    `docs/e2ee/CLIENT-CONTRACT.md` §2.2 refuses for the wallet seed.
//!
//! So this command returns public halves and nothing else. There is no
//! argument, no secret in the response, and no path from here to a private
//! key.
//!
//! # Why an app-crate command and not a plugin command
//!
//! §2.2's rule: app-crate commands carry no `plugin:` prefix and need no
//! capability entry, and `tauri-plugin-f2zmsg`'s command surface is the
//! population `docs/e2ee/CLIENT-CONTRACT.md` §3 pins and
//! `wallet/zuuli/scripts/messaging-contract.node-test.mjs` compares in both
//! directions. This is not a messaging operation — it is enrollment's
//! preparation, which is precisely the thing §2.2 keeps out of the plugin's
//! IPC surface. ZUULI reaches `prepare_device` the same way, in process, from
//! `wallet/zuuli/src-tauri/src/messaging.rs`.
//!
//! # It is not idempotent, and the caller must know that
//!
//! Each call samples a **fresh** device key set and replaces the engine's
//! pending one, discarding the previous secrets. That is `prepare_device`'s
//! existing contract and it is why the client calls this **after** it has
//! established that a transport exists: preparing a device for a request that
//! cannot be sent throws away key material for nothing.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_f2zmsg::engine::IdentityInstall;
use tauri_plugin_f2zmsg::error::Error;
use tauri_plugin_f2zmsg::models::{EngineStatus, EnrollmentStatus};
use tauri_plugin_f2zmsg::{F2zMsgExt as _, Result};

/// The public halves of this device's key set, hex-encoded.
///
/// Hex rather than bytes because that is what the rest of this surface already
/// speaks — `DeviceInfo.deviceFingerprint`, `StoredIdentity.device_pk` — and a
/// JSON array of 32 numbers is the shape nobody can eyeball in a log.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCredentialKeys {
    /// `DSK.public` — the MLS leaf `signature_key`, 32 bytes, 64 hex
    /// characters. `IssueDeviceCredentialRequestV1.device_pk`.
    pub device_pk: String,
    /// The X-Wing hybrid KEM public key.
    /// `IssueDeviceCredentialRequestV1.device_kem_pk`.
    ///
    /// `tauri_plugin_f2zmsg::engine::DevicePublicKeys` documents at length why
    /// this is a placeholder in this build: the HPKE init key MLS actually
    /// uses is generated inside each OpenMLS `KeyPackage`, and nothing yet
    /// binds the two. It is carried faithfully rather than being invented
    /// here, so that when that circularity is broken upstream this path does
    /// not have to change.
    pub device_kem_pk: String,
}

/// Lowercase hex. Four lines, so that this crate does not grow a dependency to
/// avoid writing them.
fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Sample this device's keys and return only their public halves.
///
/// # Errors
///
/// Whatever `tauri_plugin_f2zmsg` refuses with — the engine failing to open its
/// store, or `prepare_device` refusing a degenerate sample. As every f2zmsg
/// error does, it reaches the webview as a bare `ErrorCode` string.
#[tauri::command]
pub async fn e2e2z_device_credential_keys<R: Runtime>(
    app: AppHandle<R>,
) -> Result<DeviceCredentialKeys> {
    let engine = app.f2zmsg().engine_handle()?;
    let device = engine.prepare_device().await?;
    Ok(DeviceCredentialKeys {
        device_pk: hex(&device.device_pk),
        device_kem_pk: hex(&device.device_kem_pk),
    })
}

/// What the renderer hands back once the wallet authority has answered.
///
/// Everything here has been through the webview's heap, so both fields are
/// public: signed credential bytes, and a handle the user typed. A wrap key is
/// deliberately absent — before ADR 0016 the engine sealed under the
/// seed-derived `BackupWrapKey`, and routing that through here would have given
/// this app account-scoped authority (`ARCHITECTURE.md` §4.2).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallDeviceCredentialArgs {
    /// The `DeviceCredential`'s canonical bytes, lowercase hex — the same
    /// encoding [`DeviceCredentialKeys`] uses on the way out.
    pub credential: String,
    /// The handle **this enrollment asked for**, so a credential attesting a
    /// different one is refused. See [`IdentityInstall::expected_handle`] for
    /// why a signature is not enough on a first enrollment.
    pub expected_handle: String,
}

/// Install a `DeviceCredential` issued by the wallet authority.
///
/// ADR 0016 §5, and the step whose absence meant the round trip could not
/// complete even with a transport (#928). App-crate for the same reason as its
/// sibling above (§2.2), and it grants nothing new: no wallet crate, no
/// `zcash:*`, no seed — the install path is seed-free because ADR 0016 moved
/// the seal to a per-device key.
///
/// [`e2e2z_device_credential_keys`] must have run in this process for the
/// credential being installed. `prepare_device` is not idempotent, so a
/// credential issued over discarded keys is refused by the engine's `device_pk`
/// binding, and the UI has to be able to explain that refusal.
///
/// # Errors
///
/// `internal` if the credential is not hex, does not parse, or does not bind
/// the device key this process prepared; `handle-ineligible` if it attests a
/// handle that is not `expectedHandle`; `durability-unavailable` if this device
/// cannot keep the wrap key the engine seals under.
#[tauri::command]
pub async fn e2e2z_install_device_credential<R: Runtime>(
    app: AppHandle<R>,
    args: InstallDeviceCredentialArgs,
) -> Result<EnrollmentStatus> {
    let engine = app.f2zmsg().engine_handle()?;
    let credential = unhex(&args.credential)?;
    engine
        .install_identity(IdentityInstall {
            credential,
            expected_handle: args.expected_handle,
            submitted_at: now_ms(),
        })
        .await
}

/// Re-ask the OS secret store for this device's wrap key and leave §6.1's
/// `locked`.
///
/// ADR 0016 §3 requires this to be reachable here: the exit it replaced was
/// `f2zmsg_enroll` re-deriving the wrap key from the mnemonic, which this app
/// cannot do. Without it a transient secret-store failure leaves this app
/// `locked` with no way back.
///
/// # Errors
///
/// `not-enrolled` before enrollment, `durability-unavailable` when the secret
/// store cannot answer, `engine-locked` when the key does not open the seal.
#[tauri::command]
pub async fn e2e2z_retry_device_unlock<R: Runtime>(app: AppHandle<R>) -> Result<EngineStatus> {
    app.f2zmsg().engine_handle()?.unlock().await
}

/// Decode lowercase hex. Local for the reason [`hex`] is.
fn unhex(value: &str) -> Result<Vec<u8>> {
    let bytes = value.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return Err(Error::internal("the credential is not whole bytes of hex"));
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks(2) {
        let digits = core::str::from_utf8(pair)
            .ok()
            .filter(|text| text.chars().all(|digit| digit.is_ascii_hexdigit()));
        let Some(digits) = digits else {
            return Err(Error::internal("the credential is not hex"));
        };
        let byte = u8::from_str_radix(digits, 16)
            .map_err(|_| Error::internal("the credential is not hex"))?;
        out.push(byte);
    }
    if out.is_empty() {
        return Err(Error::internal("the credential is empty"));
    }
    Ok(out)
}

/// This app's own clock, for `StoredIdentity.submitted_at` — ADR 0016 §4.2
/// keeps that timestamp local rather than taking it from the responder.
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

    #[test]
    fn hex_is_lowercase_and_zero_padded() {
        assert_eq!(hex(&[0x00, 0x0f, 0xa0, 0xff]), "000fa0ff");
        assert_eq!(hex(&[]), "");
    }

    #[test]
    fn hex_round_trips_through_unhex() {
        assert_eq!(
            unhex(&hex(&[0x00, 0x0f, 0xa0, 0xff])).expect("hex"),
            vec![0x00, 0x0f, 0xa0, 0xff]
        );
    }

    #[test]
    fn a_credential_that_is_not_whole_lowercase_bytes_is_refused() {
        for candidate in ["", "abc", "zz", "00 11", "ab\n"] {
            assert!(
                unhex(candidate).is_err(),
                "{candidate:?} is not a credential"
            );
        }
    }

    /// The field set is asserted rather than left to review: a wrap key routed
    /// through here would put an account-scoped key in the webview's heap.
    /// `deny_unknown_fields` is what makes it a check rather than a comment.
    #[test]
    fn the_install_arguments_carry_a_credential_and_a_handle_and_nothing_else() {
        let args: InstallDeviceCredentialArgs = serde_json::from_value(serde_json::json!({
            "credential": "0a0b",
            "expectedHandle": "alice",
        }))
        .expect("the two reviewed arguments deserialize");
        assert_eq!(args.credential, "0a0b");
        assert_eq!(args.expected_handle, "alice");

        let widened = serde_json::from_value::<InstallDeviceCredentialArgs>(serde_json::json!({
            "credential": "0a0b",
            "expectedHandle": "alice",
            "wrapKey": "5a".repeat(32),
        }));
        assert!(
            widened.is_err(),
            "a wrap key must not be accepted here: e2e2z holds nothing seed-derived"
        );
    }

    /// The response type is public keys and nothing else. A private half added
    /// here would be exported device key material, which `ARCHITECTURE.md`
    /// §4.2 forbids outright — so the field set is asserted rather than left to
    /// review.
    #[test]
    fn the_response_carries_only_public_halves() {
        let json = serde_json::to_value(DeviceCredentialKeys {
            device_pk: hex(&[0x11; 32]),
            device_kem_pk: hex(&[0x22; 8]),
        })
        .expect("the response serializes");
        let object = json.as_object().expect("a JSON object");
        let mut names: Vec<&str> = object.keys().map(String::as_str).collect();
        names.sort_unstable();
        assert_eq!(names, ["deviceKemPk", "devicePk"]);
    }
}
