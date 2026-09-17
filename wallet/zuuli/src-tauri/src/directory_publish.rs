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
    AuthorityConfig, AuthoritySet, EntryKind, Handle as AuthorityHandle, LogId as AuthorityLogId,
    NonceLedger, Submission,
};
use f2z_codec::canonical::decode_canonical;
use f2z_codec::types::{PublicKey, QueueAddress, RelayId, ShortBytes};
use f2z_kt_core::api::SubmissionEnvelope;
use f2z_kt_core::entry::{ContactEndpoint, DeviceCredential};
use f2z_kt_core::types::{Handle, LogId};
use f2z_msg_identity::{AccountKeys, SignedSubmission, SubmissionDraft};
use tauri_plugin_f2zmsg::engine::DirectoryPublication;
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

    let published = publication.predecessor.as_ref().map(|found| &found.entry);
    let mut devices = vec![credential];
    let mut contact_endpoints = vec![endpoint];
    let mut revocations = Vec::new();
    if let Some(previous) = published {
        devices.extend(
            previous
                .entry
                .devices
                .as_slice()
                .iter()
                .filter(|existing| {
                    existing.credential.device_pk.as_bytes() != &publication.device_pk
                })
                .cloned(),
        );
        contact_endpoints.extend(
            previous
                .entry
                .contact_endpoints
                .as_slice()
                .iter()
                .filter(|existing| existing.contact_addr.as_bytes() != &publication.contact_addr)
                .cloned(),
        );
        revocations.extend(previous.entry.revocations.as_slice().iter().cloned());
    }

    Ok(SubmissionDraft {
        log_id: LogId::new(internal.log_id),
        handle,
        devices,
        revocations,
        contact_endpoints,
        predecessor: published,
        created_at_ms: now_ms,
    })
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
    use tauri_plugin_f2zmsg::directory::VerifiedEntry;

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
}
