//! Publishing this wallet's messaging device to the key-transparency log —
//! [ADR 0017](../../../../docs/e2ee/decisions/0017-internal-directory-activation.md) §4.
//!
//! # Why here
//!
//! A `DirectoryEntry` is signed by the seed-derived `DirectoryAuthKey`, and the
//! identity binding beside it by the seed-derived `IdentitySigningKey`. ZUULI is
//! the one app that holds the seed, so the signing happens in this process,
//! next to `messaging::account_keys` and `intent.rs`'s
//! `issue_device_credential`. The messaging plugin never sees the seed: it
//! hands over public material ([`DirectoryPublication`]), carries the signed
//! bytes to the log, and verifies the receipt.
//!
//! ```text
//!   engine.start()                       relay + contact queue + key packages
//!   engine.refresh_enrollment()          already merged?  → done
//!   engine.directory_publication()       credential, endpoint, predecessor
//!   HandleAssertionClient::fetch         first entry only, Knox token   (Contract C)
//!   AccountKeys::sign_directory_submission    DirectoryAuthKey + IdentitySigningKey
//!   precheck                             the log's own assertion rules, locally
//!   engine.submit_directory_entry()      POST /kt/v1/submit, receipt verified + kept
//!   engine.refresh_enrollment()          mergedAtEpoch once a lookup proves it
//! ```
//!
//! # Contract C, as this client implements it
//!
//! ```text
//! POST {handle_assertion_url}            (https://free2z.cash/api/kt/handle-assertion/)
//! Authorization: Token <knox>
//! Content-Type: application/json
//! {"identity_key": "<base64url, no padding, 32 bytes>", "intent": "bind"}
//!
//! 200 {"assertion": "<base64url of tls_codec(HandleAssertion)>",
//!      "handle": str, "issued_ms": int, "expires_ms": int}
//! 409 {"reason": "handle_unclaimed"}     503 authority key not configured
//! ```
//!
//! A POST, so the identity key never lands in an access log beside the
//! account. The decoded `assertion` is exactly the `assertion` bytes of
//! `rs/crates/f2z-authority/tests/fixtures/handle-assertion-v1.vectors`, and is
//! decoded by `f2z-authority`'s own codec in [`precheck`]. Every other status
//! is a refusal, mapped in [`status_refusal`]. The backend chooses the handle
//! from the authenticated account; this client never sends one, and refuses an
//! assertion for a handle other than the one it is enrolling.
//!
//! # What this does not protect against
//!
//! A compromised WebView can call `f2zmsg_enroll` with the user's own token —
//! the residual risk `lib.rs` already records for the enrollment trio. It
//! cannot obtain an assertion for another account, and it cannot publish under
//! another identity key, because the log checks the binding signature only
//! this process can make.

use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use f2z_authority::{
    AuthorityConfig, AuthorityError, AuthorityKey, AuthoritySet, EntryKind,
    Handle as AuthorityHandle, HandleAssertion, Intent as AssertionIntent, LogId as AuthorityLogId,
    NonceLedger, Submission, VerifyingKey,
};
use f2z_codec::canonical::decode_canonical;
use f2z_codec::types::{PublicKey, QueueAddress, RelayId, ShortBytes};
use f2z_kt_core::api::SubmissionEnvelope;
use f2z_kt_core::entry::{ContactEndpoint, DeviceCredential};
use f2z_kt_core::receipt::SubmissionReceipt;
use f2z_kt_core::types::{Handle, LogId};
use f2z_msg_identity::{AccountKeys, SignedSubmission, SubmissionDraft};
use f2z_msg_store::StorageBackend;
use tauri_plugin_f2zmsg::directory::{SubmissionExpectation, VerifiedEntry};
use tauri_plugin_f2zmsg::engine::{DeviceEndpoint, DirectoryPublication, Engine};
use tauri_plugin_f2zmsg::error::{Error, Result};
use tauri_plugin_f2zmsg::internal_directory::InternalDirectory;
use tauri_plugin_f2zmsg::models::ErrorCode;

/// How long the backend has to answer.
const ASSERTION_TIMEOUT: Duration = Duration::from_secs(15);

/// The largest assertion accepted, decoded. A v1 assertion is at most 290
/// bytes (a 30-byte handle); anything much larger is not one.
const MAX_ASSERTION_BYTES: usize = 1024;

/// The largest response body read. The JSON around a maximal assertion is a
/// few hundred bytes more than its base64.
const MAX_RESPONSE_BYTES: usize = 4096;

#[derive(Serialize)]
struct AssertionRequest<'a> {
    identity_key: String,
    intent: &'a str,
}

#[derive(Deserialize)]
struct AssertionResponse {
    assertion: String,
    handle: String,
}

#[derive(Deserialize)]
struct RefusalBody {
    reason: Option<String>,
}

/// What the handle authority issued.
#[derive(Clone, PartialEq, Eq)]
pub struct IssuedAssertion {
    /// `tls_codec(HandleAssertion)`, decoded from the response.
    pub bytes: Vec<u8>,
    /// The handle the authority says it bound. Advisory: [`precheck`] reads
    /// the one inside the signed bytes.
    pub handle: String,
}

/// Hand-written: a derived `Debug` would print the assertion as a decimal
/// byte dump.
impl std::fmt::Debug for IssuedAssertion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IssuedAssertion")
            .field("bytes", &format_args!("<{} bytes>", self.bytes.len()))
            .field("handle", &self.handle)
            .finish()
    }
}

/// Base64url, with or without padding.
fn decode_base64url(text: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text.trim_end_matches('=')).ok()
}

/// Contract C's issuing endpoint, as a typed client.
#[derive(Debug)]
pub struct HandleAssertionClient {
    url: String,
    client: tauri_plugin_http::reqwest::Client,
}

impl HandleAssertionClient {
    /// A client for the build's `handle_assertion_url`, which
    /// `internal_directory` has already required to be `https://`.
    ///
    /// # Errors
    ///
    /// `internal` if the HTTP client cannot be built.
    pub fn new(url: &str) -> Result<Self> {
        let client = tauri_plugin_http::reqwest::Client::builder()
            .timeout(ASSERTION_TIMEOUT)
            // A redirect would carry the Knox token to wherever it points.
            .redirect(tauri_plugin_http::reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| Error::internal(format!("building the assertion client: {error}")))?;
        Ok(Self {
            url: url.to_owned(),
            client,
        })
    }

    /// The JSON body sent for `identity_pk`.
    #[must_use]
    pub fn request_body(identity_pk: &[u8; 32]) -> Vec<u8> {
        serde_json::to_vec(&AssertionRequest {
            identity_key: URL_SAFE_NO_PAD.encode(identity_pk),
            // Enrollment only ever binds. A reset is ADR 0014's path, and this
            // client does not ask for one.
            intent: "bind",
        })
        .unwrap_or_default()
    }

    /// Ask the handle authority to bind the signed-in account's handle to
    /// `identity_pk`.
    ///
    /// # Errors
    ///
    /// See [`status_refusal`]; `directory-unreachable` for a network failure;
    /// `directory-protocol-violation` for a body that is too large, is not the
    /// documented JSON, or carries an assertion that is not base64url.
    pub async fn fetch(&self, knox_token: &str, identity_pk: &[u8; 32]) -> Result<IssuedAssertion> {
        let response = self
            .client
            .post(&self.url)
            .header("Authorization", format!("Token {knox_token}"))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .body(Self::request_body(identity_pk))
            .send()
            .await
            .map_err(|error| {
                Error::new(
                    ErrorCode::DirectoryUnreachable,
                    format!(
                        "the handle authority did not answer: {}",
                        error.without_url()
                    ),
                )
            })?;
        let status = response.status().as_u16();
        let body = response.bytes().await.map_err(|error| {
            Error::new(
                ErrorCode::DirectoryUnreachable,
                format!(
                    "reading the handle authority's answer: {}",
                    error.without_url()
                ),
            )
        })?;
        if body.len() > MAX_RESPONSE_BYTES {
            return Err(Error::new(
                ErrorCode::DirectoryProtocolViolation,
                format!("the handle authority answered {} bytes", body.len()),
            ));
        }
        if status != 200 {
            let reason = serde_json::from_slice::<RefusalBody>(&body)
                .ok()
                .and_then(|refusal| refusal.reason);
            return Err(status_refusal(status, reason.as_deref()));
        }
        let malformed = |why: &str| {
            Error::new(
                ErrorCode::DirectoryProtocolViolation,
                format!("the handle authority's answer {why}"),
            )
        };
        let parsed: AssertionResponse =
            serde_json::from_slice(&body).map_err(|_| malformed("is not the documented JSON"))?;
        let bytes = decode_base64url(&parsed.assertion)
            .ok_or_else(|| malformed("carries an assertion that is not base64url"))?;
        if bytes.len() > MAX_ASSERTION_BYTES {
            return Err(malformed("carries an oversized assertion"));
        }
        Ok(IssuedAssertion {
            bytes,
            handle: parsed.handle,
        })
    }
}

/// Contract C's non-200 answers, onto `CLIENT-CONTRACT.md` §8's union.
///
/// §8 has no authentication member, so an unauthenticated request and an
/// account with no bound handle are both `handle-ineligible` — the state the UI
/// already explains as "no messaging handle" — with the detail in the log.
/// `reason` is the body's `reason` field, logged and never interpreted beyond
/// that.
#[must_use]
pub fn status_refusal(status: u16, reason: Option<&str>) -> Error {
    let (code, why) = match status {
        401 | 403 => (
            ErrorCode::HandleIneligible,
            "the free2z session was refused; sign in again",
        ),
        409 => (
            ErrorCode::HandleIneligible,
            "this free2z account has no bound messaging handle; claim one first",
        ),
        429 => (
            ErrorCode::DirectoryRateLimited,
            "the handle authority is rate limiting",
        ),
        503 => (
            ErrorCode::DirectoryUnreachable,
            "the handle authority is not configured on the server",
        ),
        _ => (
            ErrorCode::DirectoryUnreachable,
            "the handle authority answered with an unexpected status",
        ),
    };
    // Only a short, printable reason is echoed into the log line.
    let reason = reason
        .filter(|text| text.len() <= 64 && text.bytes().all(|byte| byte.is_ascii_graphic()))
        .unwrap_or("-");
    Error::new(code, format!("HTTP {status} ({reason}): {why}"))
}

/// Assemble what the seed signs: this device's credential and endpoint, and
/// everything the published predecessor already carries.
///
/// The new endpoint goes **first**, because a client uses the first one
/// (`ARCHITECTURE.md` §13-G, `k = 1`) and the device being enrolled is the one
/// that should receive first contact. A predecessor's credential or endpoint
/// for this same device is replaced rather than duplicated.
///
/// # Errors
///
/// `internal` if the stored credential does not parse or is not for this
/// handle; `handle-ineligible` if the handle is not a directory handle.
pub fn draft_for<'a>(
    internal: &InternalDirectory,
    publication: &'a DirectoryPublication,
    now_ms: u64,
) -> Result<SubmissionDraft<'a>> {
    let handle = Handle::new(publication.handle.as_bytes().to_vec()).map_err(|_| {
        Error::new(
            ErrorCode::HandleIneligible,
            format!("{:?} is not a directory handle", publication.handle),
        )
    })?;
    let credential: DeviceCredential = f2z_msg_mls::credential::parse(&publication.credential)
        .map_err(|error| Error::internal(format!("the stored credential: {error}")))?;
    if credential.credential.handle != handle
        || credential.credential.device_pk.as_bytes() != &publication.device_pk
    {
        return Err(Error::internal(
            "the stored credential is not this device's credential for this handle",
        ));
    }
    let endpoint = ContactEndpoint {
        relay_url: ShortBytes::new(publication.relay_url.as_bytes().to_vec())
            .map_err(|_| Error::internal("the contact relay URL is longer than 255 bytes"))?,
        relay_id: RelayId::new(publication.relay_id),
        contact_addr: QueueAddress::new(publication.contact_addr),
    };

    // The list building is `f2z-msg-identity`'s, so ZUULI's own enrollment and
    // a device it publishes for another app cannot disagree about what adding
    // one does to the devices already published.
    Ok(SubmissionDraft::adding_device(
        LogId::new(internal.log_id),
        handle,
        credential,
        endpoint,
        publication.predecessor.as_ref().map(|found| &found.entry),
        now_ms,
    ))
}

/// Ask the handle authority to bind `identity_pk`, and refuse an answer for a
/// handle other than `expected` (ADR 0017 §5.1's precheck rule 6, stated in
/// plainer words than the signed bytes would give).
///
/// # Errors
///
/// [`status_refusal`]'s codes; `handle-ineligible` when the account's handle is
/// not the one being enrolled.
pub async fn fetch_assertion(
    client: &HandleAssertionClient,
    knox_token: &str,
    identity_pk: &[u8; 32],
    expected: &str,
) -> Result<IssuedAssertion> {
    let issued = client.fetch(knox_token, identity_pk).await?;
    if issued.handle != expected {
        return Err(Error::new(
            ErrorCode::HandleIneligible,
            format!(
                "the free2z account's handle is {:?}, but this device enrolled {:?}",
                issued.handle, expected
            ),
        ));
    }
    Ok(issued)
}

/// The handle the **authority signed**, from an assertion this build's bundled
/// authority key verifies.
///
/// A subset of the log's rules ([`precheck`] runs the rest, over the signed
/// submission), chosen for one job: the confirmation a human approves must
/// name a handle that a key this build trusts vouched for, rather than one the
/// requesting app wrote. It is checked **before** the dialog because a dialog
/// that named the request's handle would be asking the user to approve a claim
/// nobody made.
///
/// # Errors
///
/// `handle-ineligible`, naming which of the rules failed.
pub fn vouched_handle(
    internal: &InternalDirectory,
    issued: &IssuedAssertion,
    identity_pk: &[u8; 32],
    now_ms: u64,
) -> Result<String> {
    let refuse = |why: String| Error::new(ErrorCode::HandleIneligible, why);
    let assertion = decode_canonical::<HandleAssertion>(&issued.bytes)
        .map_err(|error| refuse(format!("the assertion does not decode: {error}")))?
        .into_value();
    let body = &assertion.assertion;
    if body.log_id.as_bytes() != &internal.log_id {
        return Err(refuse("the assertion is for another log".to_owned()));
    }
    if body.identity_pk.as_bytes() != identity_pk {
        return Err(refuse(
            "the assertion binds another messaging identity".to_owned(),
        ));
    }
    if body.intent != AssertionIntent::Bind {
        return Err(refuse("the assertion is not a binding".to_owned()));
    }
    if body.expires_ms <= body.issued_ms
        || body.expires_ms.saturating_sub(body.issued_ms) > f2z_authority::DEFAULT_MAX_VALIDITY_MS
        || now_ms >= body.expires_ms
        || body.issued_ms.saturating_sub(now_ms) > f2z_authority::DEFAULT_CLOCK_SKEW_MS
    {
        return Err(refuse("the assertion is not valid now".to_owned()));
    }
    let bundled = AuthorityKey::new(PublicKey::new(internal.handle_authority_pk));
    if body.authority_id != bundled.id() {
        return Err(refuse(
            "the assertion is signed by an authority this build does not trust".to_owned(),
        ));
    }
    let signing_bytes = body
        .signing_bytes()
        .map_err(|error| refuse(format!("the assertion will not re-encode: {error}")))?;
    VerifyingKey::from_public_key(&bundled.key(), AuthorityError::BadAuthoritySignature)
        .and_then(|key| {
            key.verify(
                &signing_bytes,
                &assertion.signature,
                AuthorityError::BadAuthoritySignature,
            )
        })
        .map_err(|error| {
            refuse(format!(
                "the authority's signature does not verify: {error}"
            ))
        })?;
    // `Handle`'s charset is a type invariant, so this is a `&str` already.
    Ok(body.handle.as_str().to_owned())
}

/// Everything the wallet has to establish **before** it asks a human whether
/// to publish a device it did not enroll itself (ADR 0017 §4.1).
#[derive(Debug)]
pub struct PublicationPlan {
    /// The handle, from the authority's signed assertion or from the verified
    /// entry already published under this wallet's identity — **never** from
    /// the request.
    pub handle: String,
    /// The assertion a first entry carries, `None` for a routine update.
    pub assertion: Option<IssuedAssertion>,
    /// The verified entry this one chains to.
    pub predecessor: Option<VerifiedEntry>,
}

impl PublicationPlan {
    /// How many devices the handle already publishes. Shown in the
    /// confirmation: adding a device to an account is a wiretap
    /// (`ARCHITECTURE.md`), and how many are already there is part of what a
    /// human is judging.
    #[must_use]
    pub fn published_devices(&self) -> usize {
        self.predecessor
            .as_ref()
            .map_or(0, |found| found.entry.entry.devices.as_slice().len())
    }

    /// Where the authenticated handle came from, for the confirmation's copy.
    #[must_use]
    pub const fn handle_is_vouched(&self) -> bool {
        self.assertion.is_some()
    }
}

/// Resolve who this handle belongs to, from the log and the handle authority.
///
/// A first entry needs an assertion, so this fetches one and refuses it unless
/// it is signed, current, for this log, for this identity key, and for the
/// handle the requesting app asked for. A handle the log already publishes
/// under **this wallet's** identity key is stronger evidence than any
/// assertion — the seed proved it — so no assertion is fetched for an update,
/// and a handle published under another identity is refused outright.
///
/// # Errors
///
/// `handle-ineligible` when the handle is not this account's, when no free2z
/// session is signed in, or when the assertion does not verify; the directory's
/// lookup errors; [`status_refusal`]'s codes.
pub async fn plan_publication<B: StorageBackend>(
    internal: &InternalDirectory,
    engine: &Engine<B>,
    client: &HandleAssertionClient,
    identity_pk: &[u8; 32],
    requested_handle: &str,
    knox_token: Option<&str>,
    now_ms: u64,
) -> Result<PublicationPlan> {
    Handle::new(requested_handle.as_bytes().to_vec()).map_err(|_| {
        Error::new(
            ErrorCode::HandleIneligible,
            format!("{requested_handle:?} is not a directory handle"),
        )
    })?;
    let predecessor = engine.lookup_published_entry(requested_handle).await?;
    if let Some(published) = predecessor {
        if published.entry.entry.identity_pk.as_bytes() != identity_pk {
            return Err(Error::new(
                ErrorCode::HandleIneligible,
                format!(
                    "{requested_handle:?} is published under another messaging identity; \
                     this wallet cannot add a device to it"
                ),
            ));
        }
        return Ok(PublicationPlan {
            handle: String::from_utf8_lossy(published.entry.entry.handle.as_slice()).into_owned(),
            assertion: None,
            predecessor: Some(published),
        });
    }

    let token = knox_token.ok_or_else(|| {
        Error::new(
            ErrorCode::HandleIneligible,
            "publishing a first directory entry needs a signed-in free2z session in this wallet",
        )
    })?;
    let issued = fetch_assertion(client, token, identity_pk, requested_handle).await?;
    let handle = vouched_handle(internal, &issued, identity_pk, now_ms)?;
    if handle != requested_handle {
        return Err(Error::new(
            ErrorCode::HandleIneligible,
            format!("the authority signed {handle:?}, not {requested_handle:?}"),
        ));
    }
    Ok(PublicationPlan {
        handle,
        assertion: Some(issued),
        predecessor: None,
    })
}

/// The device this wallet is about to vouch for in the directory.
///
/// One value rather than three arguments, because the three only ever travel
/// together: a credential, the key it binds, and where that key receives first
/// contact.
#[derive(Debug)]
pub struct DeviceToPublish {
    /// The `DeviceCredential` this wallet just issued, canonically encoded.
    pub credential: Vec<u8>,
    /// `DSK.public`, as the requesting device generated it.
    pub device_pk: [u8; 32],
    /// The contact queue the requesting device opened.
    pub endpoint: DeviceEndpoint,
}

/// Sign the entry that adds `device` at its endpoint, submit it, and return the
/// log's verified receipt (ADR 0017 §4.1).
///
/// The same signing, prechecking and submitting `f2zmsg_enroll` does for this
/// wallet's own device — [`draft_for`], [`sign`], [`precheck`] — with the
/// receipt kept against the *issuing* wallet rather than against an identity
/// this engine does not hold.
///
/// # Errors
///
/// `internal` if the credential does not match the plan; `handle-ineligible`
/// when the precheck refuses; the log's refusals.
pub async fn publish_device<B: StorageBackend>(
    internal: &InternalDirectory,
    engine: &Engine<B>,
    account: &AccountKeys,
    plan: &PublicationPlan,
    device: DeviceToPublish,
    now_ms: u64,
) -> Result<SubmissionReceipt> {
    let publication = DirectoryPublication {
        handle: plan.handle.clone(),
        identity_pk: *account.identity.public().as_bytes(),
        device_pk: device.device_pk,
        credential: device.credential,
        relay_url: device.endpoint.relay_url,
        relay_id: device.endpoint.relay_id,
        contact_addr: device.endpoint.contact_addr,
        predecessor: plan.predecessor.clone(),
    };
    let draft = draft_for(internal, &publication, now_ms)?;
    let assertion = plan.assertion.as_ref().map(|issued| issued.bytes.clone());
    let signed = sign(account, &publication, &draft, assertion.as_deref())?;
    if let Some(assertion) = &assertion {
        precheck(internal, &signed, assertion, now_ms)?;
    }
    engine
        .submit_entry_for_device(
            signed.envelope.clone(),
            SubmissionExpectation {
                handle: plan.handle.clone(),
                entry_version: signed.entry_version(),
                entry_digest: *signed.entry_digest.as_bytes(),
            },
        )
        .await
}

/// Run the log's own assertion rules on a signed first entry before sending
/// it, against the **bundled** authority key.
///
/// The log is the party that must refuse a bad assertion, and it does. This is
/// here so a backend that issued for the wrong handle, key, log or authority is
/// reported as that — with the rule that failed in the log line — instead of
/// as an opaque `ERR_BAD_AUTHORIZATION` after a round trip, and so a bundled
/// `handle_authority_pk` that disagrees with the backend is caught on the
/// first device that tries.
///
/// # Errors
///
/// `handle-ineligible` naming the `f2z-authority` rule that failed.
pub fn precheck(
    internal: &InternalDirectory,
    signed: &SignedSubmission,
    assertion: &[u8],
    now_ms: u64,
) -> Result<()> {
    let config = AuthorityConfig::with_defaults(
        AuthorityLogId::new(internal.log_id),
        AuthoritySet::single(PublicKey::new(internal.handle_authority_pk))
            .map_err(|error| Error::internal(format!("the bundled authority: {error}")))?,
    )
    .map_err(|error| Error::internal(format!("the bundled authority policy: {error}")))?;
    let envelope = decode_canonical::<SubmissionEnvelope>(&signed.envelope)
        .map_err(|error| Error::internal(format!("re-reading our own envelope: {error}")))?
        .into_value();
    let entry = &signed.entry.entry;
    let handle = AuthorityHandle::parse(entry.handle.as_slice())
        .map_err(|error| Error::internal(format!("our own handle: {error}")))?;
    // One assertion, one check: a ledger of one is all this needs, and it is
    // dropped here, so no nonce is remembered on the client.
    let mut ledger = NonceLedger::new(1, config.clock_skew_ms());
    config
        .check_assertion_layer(
            &Submission {
                assertion: Some(assertion),
                kind: EntryKind::InitialBind,
                handle: &handle,
                identity_pk: &entry.identity_pk,
                entry_version: entry.entry_version,
                entry_digest: &signed.entry_digest,
                identity_signature: &envelope.identity_signature,
                previous_identity_pk: None,
                previous_vouch: None,
                previous_account_epoch: None,
            },
            now_ms,
            &mut ledger,
        )
        .map(|_| ())
        .map_err(|error| {
            Error::new(
                ErrorCode::HandleIneligible,
                format!("the handle authority's assertion does not verify: {error}"),
            )
        })
}

/// Sign this device's submission with the seed-derived keys.
///
/// # Errors
///
/// `internal` if the account's identity key is not the one this device was
/// enrolled under (the active wallet changed), or if signing refuses.
pub fn sign(
    account: &AccountKeys,
    publication: &DirectoryPublication,
    draft: &SubmissionDraft<'_>,
    assertion: Option<&[u8]>,
) -> Result<SignedSubmission> {
    if account.identity.public().as_bytes() != &publication.identity_pk {
        return Err(Error::internal(
            "the active wallet's messaging identity is not the one this device was enrolled \
             under; refusing to publish",
        ));
    }
    account
        .sign_directory_submission(draft, assertion)
        .map_err(|error| Error::internal(format!("signing the directory submission: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use f2z_authority::{AssertionNonce, HandleAssertionTBS, Intent, SigningKey};
    use f2z_codec::canonical::Canonical as _;
    use f2z_kt_core::types::KemPublicKey;
    use f2z_msg_identity::DeviceCredentialRequest;

    const NOW: u64 = 1_758_067_200_000;
    const AUTHORITY_SEED: [u8; 32] = [0x21; 32];

    fn internal() -> InternalDirectory {
        InternalDirectory {
            log_url: "https://kt.internal.example".to_owned(),
            log_public_key: [1; 32],
            log_id: [2; 32],
            vrf_public_key: [5; 32],
            reset_authority_pk: [3; 32],
            reset_cooldown_seconds: 604_800,
            witnesses: vec![[4; 32]],
            threshold: 1,
            handle_authority_pk: *SigningKey::from_seed(&AUTHORITY_SEED)
                .public_key()
                .as_bytes(),
            handle_assertion_url: "https://api.internal.example/api/kt/handle-assertion/"
                .to_owned(),
            relay_url: "wss://relay.internal.example/relay/v1".to_owned(),
            retired_log_public_keys: Vec::new(),
        }
    }

    fn account() -> AccountKeys {
        AccountKeys::from_seed(&[0x33; 64], 0).unwrap()
    }

    fn publication(account: &AccountKeys, device: u8) -> DirectoryPublication {
        let credential = account
            .identity
            .issue_device_credential(&DeviceCredentialRequest {
                handle: Handle::new(b"alice".to_vec()).unwrap(),
                device_pk: PublicKey::new([device; 32]),
                device_kem_pk: KemPublicKey::new(vec![9]).unwrap(),
                not_before_ms: NOW - 1,
                not_after_ms: NOW + 1_000_000,
            })
            .unwrap();
        DirectoryPublication {
            handle: "alice".to_owned(),
            identity_pk: *account.identity.public().as_bytes(),
            device_pk: [device; 32],
            credential: f2z_msg_mls::credential::encode(&credential).unwrap(),
            relay_url: "wss://relay.internal.example/relay/v1".to_owned(),
            relay_id: [0x77; 32],
            contact_addr: [device; 32],
            predecessor: None,
        }
    }

    fn assertion_for(identity_pk: PublicKey, handle: &[u8], authority_seed: [u8; 32]) -> Vec<u8> {
        let authority = SigningKey::from_seed(&authority_seed);
        HandleAssertionTBS::new(
            &authority.public_key(),
            AuthorityLogId::new(internal().log_id),
            AuthorityHandle::parse(handle).unwrap(),
            identity_pk,
            Intent::Bind,
            0,
            NOW,
            NOW + 60_000,
            AssertionNonce::new([7; 16]),
        )
        .unwrap()
        .sign(&authority)
        .unwrap()
        .encode_canonical()
        .unwrap()
    }

    fn signed_first(account: &AccountKeys, assertion: &[u8]) -> SignedSubmission {
        let publication = publication(account, 0x10);
        let draft = draft_for(&internal(), &publication, NOW).unwrap();
        sign(account, &publication, &draft, Some(assertion)).unwrap()
    }

    #[test]
    fn the_request_body_is_contract_c_and_carries_no_handle() {
        let body: serde_json::Value =
            serde_json::from_slice(&HandleAssertionClient::request_body(&[0xfb; 32])).unwrap();
        assert_eq!(
            body,
            serde_json::json!({
                // 0xfb bytes exercise both URL-safe substitutions' neighbourhood
                // and the unpadded tail.
                "identity_key": "-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_s",
                "intent": "bind",
            })
        );
    }

    #[test]
    fn statuses_map_onto_the_contract_union() {
        for (status, code) in [
            (401, ErrorCode::HandleIneligible),
            (403, ErrorCode::HandleIneligible),
            (409, ErrorCode::HandleIneligible),
            (429, ErrorCode::DirectoryRateLimited),
            (503, ErrorCode::DirectoryUnreachable),
            (500, ErrorCode::DirectoryUnreachable),
            (302, ErrorCode::DirectoryUnreachable),
        ] {
            assert_eq!(status_refusal(status, None).code(), code, "HTTP {status}");
        }
        assert!(status_refusal(409, Some("handle_unclaimed"))
            .context()
            .contains("handle_unclaimed"));
        assert!(
            !status_refusal(409, Some("line\nbreak"))
                .context()
                .contains("break"),
            "a reason is echoed only when it is short and printable"
        );
    }

    #[test]
    fn base64url_is_accepted_with_or_without_padding() {
        assert_eq!(decode_base64url("AQID").unwrap(), vec![1, 2, 3]);
        assert_eq!(decode_base64url("AQI").unwrap(), vec![1, 2]);
        assert_eq!(decode_base64url("AQI=").unwrap(), vec![1, 2]);
        assert_eq!(decode_base64url("-_8").unwrap(), vec![0xfb, 0xff]);
        assert!(
            decode_base64url("+/8").is_none(),
            "standard base64 is not base64url"
        );
    }

    #[test]
    fn a_valid_assertion_from_the_bundled_authority_passes_the_precheck() {
        let account = account();
        let assertion = assertion_for(account.identity.public(), b"alice", AUTHORITY_SEED);
        let signed = signed_first(&account, &assertion);
        precheck(&internal(), &signed, &assertion, NOW + 1).unwrap();
        assert_eq!(signed.entry_version(), 1);
    }

    #[test]
    fn the_precheck_refuses_what_the_log_would_refuse() {
        let account = account();
        let other = AccountKeys::from_seed(&[0x34; 64], 0).unwrap();
        let cases = [
            // An unconfigured authority.
            assertion_for(account.identity.public(), b"alice", [0x22; 32]),
            // Another identity key.
            assertion_for(other.identity.public(), b"alice", AUTHORITY_SEED),
            // Another handle.
            assertion_for(account.identity.public(), b"bob", AUTHORITY_SEED),
        ];
        for assertion in cases {
            let signed = signed_first(&account, &assertion);
            assert_eq!(
                precheck(&internal(), &signed, &assertion, NOW + 1)
                    .unwrap_err()
                    .code(),
                ErrorCode::HandleIneligible
            );
        }
        // And an expired one.
        let assertion = assertion_for(account.identity.public(), b"alice", AUTHORITY_SEED);
        let signed = signed_first(&account, &assertion);
        assert!(precheck(&internal(), &signed, &assertion, NOW + 60_000).is_err());
    }

    #[test]
    fn a_different_wallet_does_not_sign_for_this_device() {
        let enrolled = account();
        let switched = AccountKeys::from_seed(&[0x35; 64], 0).unwrap();
        let publication = publication(&enrolled, 0x10);
        let draft = draft_for(&internal(), &publication, NOW).unwrap();
        let assertion = assertion_for(switched.identity.public(), b"alice", AUTHORITY_SEED);
        assert!(sign(&switched, &publication, &draft, Some(&assertion)).is_err());
    }

    #[test]
    fn a_second_device_is_added_first_and_keeps_the_published_ones() {
        let account = account();
        let first_publication = publication(&account, 0x10);
        let first = signed_first(
            &account,
            &assertion_for(account.identity.public(), b"alice", AUTHORITY_SEED),
        );

        let mut second = publication(&account, 0x11);
        second.predecessor = Some(VerifiedEntry {
            entry: first.entry.clone(),
            epoch: 4,
        });
        let draft = draft_for(&internal(), &second, NOW).unwrap();
        assert_eq!(draft.devices.len(), 2);
        assert_eq!(
            draft.devices[0].credential.device_pk.as_bytes(),
            &[0x11; 32]
        );
        assert_eq!(
            draft.devices[1].credential.device_pk.as_bytes(),
            &[0x10; 32]
        );
        assert_eq!(
            draft.contact_endpoints[0].contact_addr.as_bytes(),
            &[0x11; 32]
        );
        assert_eq!(draft.contact_endpoints.len(), 2);
        let signed = sign(&account, &second, &draft, None).unwrap();
        assert_eq!(signed.entry_version(), 2);

        // Re-publishing the first device replaces rather than duplicates it.
        let mut again = first_publication;
        again.predecessor = Some(VerifiedEntry {
            entry: signed.entry.clone(),
            epoch: 5,
        });
        let draft = draft_for(&internal(), &again, NOW).unwrap();
        assert_eq!(draft.devices.len(), 2);
        assert_eq!(draft.contact_endpoints.len(), 2);
        assert!(again.already_published());
    }

    #[test]
    fn a_credential_for_another_device_is_refused() {
        let account = account();
        let mut publication = publication(&account, 0x10);
        publication.device_pk = [0x12; 32];
        assert!(draft_for(&internal(), &publication, NOW).is_err());
    }

    /// One request to a loopback server: the request as received, and
    /// whatever the client made of the canned answer.
    fn exchange(
        status: u16,
        answer: Vec<u8>,
        identity_pk: [u8; 32],
    ) -> (
        tiny_http::Method,
        String,
        Option<String>,
        Vec<u8>,
        Result<IssuedAssertion>,
    ) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let handle = std::thread::spawn(move || {
            let mut request = server.recv().unwrap();
            let method = request.method().clone();
            let url = request.url().to_owned();
            let auth = request
                .headers()
                .iter()
                .find(|header| header.field.equiv("Authorization"))
                .map(|header| header.value.to_string());
            let mut body = Vec::new();
            std::io::Read::read_to_end(request.as_reader(), &mut body).unwrap();
            request
                .respond(tiny_http::Response::from_data(answer).with_status_code(status))
                .unwrap();
            (method, url, auth, body)
        });
        let client = HandleAssertionClient::new(&format!(
            "http://127.0.0.1:{port}/api/kt/handle-assertion/"
        ))
        .unwrap();
        let outcome = tauri::async_runtime::block_on(client.fetch("knox-token", &identity_pk));
        let (method, url, auth, body) = handle.join().unwrap();
        (method, url, auth, body, outcome)
    }

    #[test]
    fn the_client_posts_the_key_with_the_token_and_decodes_the_assertion() {
        // The Contract C vector, as the backend would return it.
        let assertion = assertion_for(account().identity.public(), b"alice", AUTHORITY_SEED);
        let answer = serde_json::to_vec(&serde_json::json!({
            "assertion": URL_SAFE_NO_PAD.encode(&assertion),
            "handle": "alice",
            "issued_ms": NOW,
            "expires_ms": NOW + 60_000,
        }))
        .unwrap();
        let (method, url, auth, body, outcome) = exchange(200, answer, [0x01; 32]);
        assert_eq!(method, tiny_http::Method::Post);
        assert_eq!(
            url, "/api/kt/handle-assertion/",
            "nothing identifying in the URL"
        );
        assert_eq!(auth.as_deref(), Some("Token knox-token"));
        assert_eq!(body, HandleAssertionClient::request_body(&[0x01; 32]));
        let issued = outcome.unwrap();
        assert_eq!(issued.bytes, assertion);
        assert_eq!(issued.handle, "alice");
    }

    #[test]
    fn refusals_and_malformed_answers_are_not_assertions() {
        let cases: [(u16, Vec<u8>, ErrorCode); 5] = [
            (
                409,
                br#"{"reason":"handle_unclaimed"}"#.to_vec(),
                ErrorCode::HandleIneligible,
            ),
            (503, b"{}".to_vec(), ErrorCode::DirectoryUnreachable),
            (
                200,
                br#"{"assertion":"+/+/","handle":"alice"}"#.to_vec(),
                ErrorCode::DirectoryProtocolViolation,
            ),
            (
                200,
                b"not json".to_vec(),
                ErrorCode::DirectoryProtocolViolation,
            ),
            (
                200,
                vec![b' '; MAX_RESPONSE_BYTES + 1],
                ErrorCode::DirectoryProtocolViolation,
            ),
        ];
        for (status, answer, code) in cases {
            let (.., outcome) = exchange(status, answer, [0; 32]);
            assert_eq!(outcome.unwrap_err().code(), code, "HTTP {status}");
        }
    }

    // ------------------------------------------------------------------
    // Publishing a device this wallet did not enroll (ADR 0017 §4.1).
    // ------------------------------------------------------------------

    /// A log that publishes whatever it is told to, and records what it was
    /// asked. The real one is `KtDirectory`; what these tests are about is the
    /// wallet's half, and a real log has its own suite in
    /// `rs/crates/f2z-kt-client/tests`.
    #[derive(Default)]
    struct FakeLog {
        published: std::sync::Mutex<Option<VerifiedEntry>>,
        submitted: std::sync::Mutex<Vec<SubmissionExpectation>>,
        refuse_with: Option<ErrorCode>,
    }

    impl tauri_plugin_f2zmsg::directory::Directory for FakeLog {
        fn resolve(
            &self,
            _handle: &str,
        ) -> Result<tauri_plugin_f2zmsg::models::DirectoryResolution> {
            Err(Error::internal("not under test"))
        }

        fn resolve_identity(
            &self,
            _handle: &str,
        ) -> Result<tauri_plugin_f2zmsg::directory::ResolvedIdentity> {
            Err(Error::internal("not under test"))
        }

        fn resolve_peer(
            &self,
            _handle: &str,
        ) -> Result<tauri_plugin_f2zmsg::directory::ResolvedPeer> {
            Err(Error::internal("not under test"))
        }

        fn independent_witnesses(&self) -> u32 {
            0
        }

        fn threshold_met(&self) -> bool {
            true
        }

        fn is_configured(&self) -> bool {
            true
        }

        fn lookup_entry(&self, _handle: &str) -> Result<Option<VerifiedEntry>> {
            Ok(self.published.lock().unwrap().clone())
        }

        fn submit(
            &self,
            _envelope: &[u8],
            expected: &SubmissionExpectation,
        ) -> Result<SubmissionReceipt> {
            if let Some(code) = self.refuse_with {
                return Err(Error::new(code, "refused by the fake log"));
            }
            self.submitted.lock().unwrap().push(expected.clone());
            Ok(SubmissionReceipt {
                receipt: f2z_kt_core::receipt::SubmissionReceiptTBS {
                    label: f2z_kt_core::receipt::SubmissionReceiptTBS::label_bytes().unwrap(),
                    kt_version: f2z_kt_core::KT_VERSION,
                    log_id: LogId::new(internal().log_id),
                    handle: Handle::new(expected.handle.as_bytes().to_vec()).unwrap(),
                    entry_version: expected.entry_version,
                    entry_hash: f2z_codec::types::Digest::new(expected.entry_digest),
                    received_at_ms: NOW,
                    merge_by_ms: NOW + 60_000,
                },
                signature: f2z_codec::types::Signature::new([0; 64]),
            })
        }
    }

    fn engine_over(log: std::sync::Arc<FakeLog>) -> Engine<f2z_msg_store::MemoryBackend> {
        Engine::new(
            f2z_msg_store::MemoryBackend::new(),
            std::sync::Arc::new(tauri_plugin_f2zmsg::events::NullSink),
            tauri_plugin_f2zmsg::models::Platform::ZuuliDesktop,
        )
        .unwrap()
        .with_directory(log as std::sync::Arc<dyn tauri_plugin_f2zmsg::directory::Directory>)
    }

    fn endpoint_at(address: u8) -> DeviceEndpoint {
        DeviceEndpoint {
            relay_url: "wss://relay.internal.example/relay/v1".to_owned(),
            relay_id: [0x77; 32],
            contact_addr: [address; 32],
        }
    }

    /// A credential for a device this wallet is vouching for, as `intent.rs`
    /// issues one.
    fn credential_for(account: &AccountKeys, device: u8) -> Vec<u8> {
        let credential = account
            .identity
            .issue_device_credential(&DeviceCredentialRequest {
                handle: Handle::new(b"alice".to_vec()).unwrap(),
                device_pk: PublicKey::new([device; 32]),
                device_kem_pk: KemPublicKey::new(vec![9]).unwrap(),
                not_before_ms: NOW - 1,
                not_after_ms: NOW + 1_000_000,
            })
            .unwrap();
        f2z_msg_mls::credential::encode(&credential).unwrap()
    }

    fn issued(bytes: Vec<u8>, handle: &str) -> IssuedAssertion {
        IssuedAssertion {
            bytes,
            handle: handle.to_owned(),
        }
    }

    #[test]
    fn a_handle_is_read_from_the_authoritys_signature_and_not_from_the_answer() {
        let account = account();
        let bytes = assertion_for(account.identity.public(), b"alice", AUTHORITY_SEED);
        // The JSON's `handle` field is advisory; the signed one is the answer.
        let lying = issued(bytes.clone(), "mallory");
        assert_eq!(
            vouched_handle(
                &internal(),
                &lying,
                account.identity.public().as_bytes(),
                NOW + 1
            )
            .unwrap(),
            "alice"
        );
    }

    #[test]
    fn an_assertion_that_does_not_verify_names_no_handle() {
        let account = account();
        let other = AccountKeys::from_seed(&[0x34; 64], 0).unwrap();
        let identity_pk = *account.identity.public().as_bytes();
        let good = assertion_for(account.identity.public(), b"alice", AUTHORITY_SEED);

        let mut forged = good.clone();
        let last = forged.len() - 1;
        forged[last] ^= 0x01;

        let cases: [(&str, Vec<u8>, u64); 6] = [
            (
                "another authority",
                assertion_for(account.identity.public(), b"alice", [0x22; 32]),
                NOW + 1,
            ),
            (
                "another identity",
                assertion_for(other.identity.public(), b"alice", AUTHORITY_SEED),
                NOW + 1,
            ),
            ("a tampered signature", forged, NOW + 1),
            ("an expired window", good.clone(), NOW + 60_001),
            ("a not-yet-issued assertion", good.clone(), NOW - 200_000),
            (
                "bytes that are not an assertion",
                vec![0x01, 0x02, 0x03],
                NOW + 1,
            ),
        ];
        for (name, bytes, now) in cases {
            assert_eq!(
                vouched_handle(&internal(), &issued(bytes, "alice"), &identity_pk, now)
                    .unwrap_err()
                    .code(),
                ErrorCode::HandleIneligible,
                "{name} must not name a handle"
            );
        }
        // The positive control.
        assert_eq!(
            vouched_handle(&internal(), &issued(good, "alice"), &identity_pk, NOW + 1).unwrap(),
            "alice"
        );
    }

    #[tokio::test]
    async fn a_handle_this_wallet_already_publishes_needs_no_assertion() {
        let account = account();
        let first = signed_first(
            &account,
            &assertion_for(account.identity.public(), b"alice", AUTHORITY_SEED),
        );
        let log = std::sync::Arc::new(FakeLog::default());
        *log.published.lock().unwrap() = Some(VerifiedEntry {
            entry: first.entry.clone(),
            epoch: 7,
        });
        let engine = engine_over(std::sync::Arc::clone(&log));
        // No assertion client can answer here: the URL is not served, and the
        // plan must not need it.
        let client = HandleAssertionClient::new("http://127.0.0.1:1/unused").unwrap();
        let plan = plan_publication(
            &internal(),
            &engine,
            &client,
            account.identity.public().as_bytes(),
            "alice",
            None,
            NOW,
        )
        .await
        .expect("a published handle plans without an assertion");
        assert_eq!(plan.handle, "alice");
        assert!(!plan.handle_is_vouched());
        assert_eq!(plan.published_devices(), 1);

        // Publishing chains to it, keeps the published device, and the log's
        // receipt is what comes back.
        let receipt = publish_device(
            &internal(),
            &engine,
            &account,
            &plan,
            DeviceToPublish {
                credential: credential_for(&account, 0x21),
                device_pk: [0x21; 32],
                endpoint: endpoint_at(0x21),
            },
            NOW,
        )
        .await
        .expect("the log admitted it");
        assert_eq!(receipt.receipt.entry_version, 2);
        assert_eq!(log.submitted.lock().unwrap()[0].handle, "alice".to_owned());
    }

    #[tokio::test]
    async fn a_handle_published_under_another_identity_is_refused_before_anything_is_asked() {
        let stranger = AccountKeys::from_seed(&[0x99; 64], 0).unwrap();
        let theirs = signed_first(
            &stranger,
            &assertion_for(stranger.identity.public(), b"alice", AUTHORITY_SEED),
        );
        let log = std::sync::Arc::new(FakeLog::default());
        *log.published.lock().unwrap() = Some(VerifiedEntry {
            entry: theirs.entry.clone(),
            epoch: 3,
        });
        let engine = engine_over(log);
        let client = HandleAssertionClient::new("http://127.0.0.1:1/unused").unwrap();
        let mine = account();
        assert_eq!(
            plan_publication(
                &internal(),
                &engine,
                &client,
                mine.identity.public().as_bytes(),
                "alice",
                Some("knox-token"),
                NOW,
            )
            .await
            .unwrap_err()
            .code(),
            ErrorCode::HandleIneligible,
        );
    }

    #[tokio::test]
    async fn a_first_entry_needs_a_session_and_an_assertion_for_the_handle_asked_for() {
        let account = account();
        let engine = engine_over(std::sync::Arc::new(FakeLog::default()));
        let client = HandleAssertionClient::new("http://127.0.0.1:1/unused").unwrap();
        // Signed out: refused before any request leaves the process.
        assert_eq!(
            plan_publication(
                &internal(),
                &engine,
                &client,
                account.identity.public().as_bytes(),
                "alice",
                None,
                NOW,
            )
            .await
            .unwrap_err()
            .code(),
            ErrorCode::HandleIneligible,
        );
        // …and a handle that is not a handle never reaches the log.
        assert_eq!(
            plan_publication(
                &internal(),
                &engine,
                &client,
                account.identity.public().as_bytes(),
                "Alice!",
                Some("knox-token"),
                NOW,
            )
            .await
            .unwrap_err()
            .code(),
            ErrorCode::HandleIneligible,
        );
    }

    /// One loopback answer from the handle authority, planned against a log
    /// that publishes nothing yet.
    fn plan_against(status: u16, answer: Vec<u8>) -> Result<PublicationPlan> {
        let account = account();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let handle = std::thread::spawn(move || {
            let request = server.recv().unwrap();
            request
                .respond(tiny_http::Response::from_data(answer).with_status_code(status))
                .unwrap();
        });
        let engine = engine_over(std::sync::Arc::new(FakeLog::default()));
        let client = HandleAssertionClient::new(&format!(
            "http://127.0.0.1:{port}/api/kt/handle-assertion/"
        ))
        .unwrap();
        let outcome = tauri::async_runtime::block_on(plan_publication(
            &internal(),
            &engine,
            &client,
            account.identity.public().as_bytes(),
            "alice",
            Some("knox-token"),
            NOW + 1,
        ));
        handle.join().unwrap();
        outcome
    }

    #[test]
    fn contract_cs_refusals_reach_the_plan_as_themselves() {
        let account = account();
        let good = serde_json::to_vec(&serde_json::json!({
            "assertion": URL_SAFE_NO_PAD
                .encode(assertion_for(account.identity.public(), b"alice", AUTHORITY_SEED)),
            "handle": "alice",
            "issued_ms": NOW,
            "expires_ms": NOW + 60_000,
        }))
        .unwrap();
        let planned = plan_against(200, good).expect("a valid assertion plans a first entry");
        assert!(planned.handle_is_vouched());
        assert_eq!(planned.handle, "alice");
        assert_eq!(planned.published_devices(), 0);

        // An account with no bound handle, and a backend with no authority key.
        assert_eq!(
            plan_against(409, br#"{"reason":"handle_unclaimed"}"#.to_vec())
                .unwrap_err()
                .code(),
            ErrorCode::HandleIneligible,
        );
        assert_eq!(
            plan_against(503, b"{}".to_vec()).unwrap_err().code(),
            ErrorCode::DirectoryUnreachable,
        );
        // An assertion for somebody else's handle.
        let elsewhere = serde_json::to_vec(&serde_json::json!({
            "assertion": URL_SAFE_NO_PAD
                .encode(assertion_for(account.identity.public(), b"bob", AUTHORITY_SEED)),
            "handle": "bob",
            "issued_ms": NOW,
            "expires_ms": NOW + 60_000,
        }))
        .unwrap();
        assert_eq!(
            plan_against(200, elsewhere).unwrap_err().code(),
            ErrorCode::HandleIneligible,
        );
    }

    #[tokio::test]
    async fn a_log_that_refuses_the_entry_publishes_nothing() {
        let account = account();
        let log = std::sync::Arc::new(FakeLog {
            refuse_with: Some(ErrorCode::DirectoryProtocolViolation),
            ..FakeLog::default()
        });
        let engine = engine_over(std::sync::Arc::clone(&log));
        let plan = PublicationPlan {
            handle: "alice".to_owned(),
            assertion: Some(issued(
                assertion_for(account.identity.public(), b"alice", AUTHORITY_SEED),
                "alice",
            )),
            predecessor: None,
        };
        assert_eq!(
            publish_device(
                &internal(),
                &engine,
                &account,
                &plan,
                DeviceToPublish {
                    credential: credential_for(&account, 0x21),
                    device_pk: [0x21; 32],
                    endpoint: endpoint_at(0x21),
                },
                NOW,
            )
            .await
            .unwrap_err()
            .code(),
            ErrorCode::DirectoryProtocolViolation,
        );
        assert!(log.submitted.lock().unwrap().is_empty());
    }

    /// The precheck is not skipped on this path: an assertion the log would
    /// refuse never reaches it.
    #[tokio::test]
    async fn an_assertion_the_log_would_refuse_is_caught_before_submission() {
        let account = account();
        let log = std::sync::Arc::new(FakeLog::default());
        let engine = engine_over(std::sync::Arc::clone(&log));
        let plan = PublicationPlan {
            handle: "alice".to_owned(),
            // Signed by an authority this build does not bundle.
            assertion: Some(issued(
                assertion_for(account.identity.public(), b"alice", [0x22; 32]),
                "alice",
            )),
            predecessor: None,
        };
        assert_eq!(
            publish_device(
                &internal(),
                &engine,
                &account,
                &plan,
                DeviceToPublish {
                    credential: credential_for(&account, 0x21),
                    device_pk: [0x21; 32],
                    endpoint: endpoint_at(0x21),
                },
                NOW,
            )
            .await
            .unwrap_err()
            .code(),
            ErrorCode::HandleIneligible,
        );
        assert!(
            log.submitted.lock().unwrap().is_empty(),
            "a precheck that ran after the submission would prove nothing"
        );
    }
}
