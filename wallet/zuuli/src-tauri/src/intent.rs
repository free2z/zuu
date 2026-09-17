//! The **authority side** of the cross-app intent bridge — `#905`, inside
//! `cash.free2z.zuuli`, the one app that holds the seed.
//!
//! `rs/crates/f2z-intent` decides *whether* a request may be acted on. This
//! module is what acting on it means: it turns admitted bytes into a native
//! confirmation the user approves, and an approval into the wallet's existing
//! propose → confirm → execute path. Nothing here re-implements a guard;
//! [`f2z_intent::IntentGate::admit`] is called once and its verdict is final.
//!
//! ```text
//!   decoded bytes ──► IntentGate::admit          (every guard, one call)
//!                       ▼
//!                     the family dispatch        (see "What is not here")
//!                       ▼
//!   execute-payment:  propose_send               ZUULI's OWN proposal
//!                       ▼
//!                     prepare_send_confirmation  the plugin re-derives the review
//!                       ▼
//!                     review_matches_request     the review must agree with the ask
//!                       ▼
//!                     native dialog              ZUULI's OWN rendering
//!                       ▼ approved
//!                     ConfirmationAuthorization  binds request ⊗ review ⊗ token
//!                     issue_send_confirmation    #528's own execution credential
//!                       ▼
//!                     consume (takes self)       one use, both clocks
//!                       ▼
//!                     take_send_proposal → ensure_active_seed_loaded → execute_send
//!
//!   issue-device-credential:
//!                     native dialog              BEFORE the seed is read
//!                       ▼ approved
//!                     messaging::account_keys    the one seed read, in process
//!                       ▼
//!                     issue_device_credential    §4.2's identity key signs
//!
//!   issue-device-credential-v2:                  (ADR 0017 §4.1)
//!                     account_identity           the account's PUBLIC key
//!                       ▼
//!                     plan_publication           who the log and the handle
//!                                                authority say this handle is
//!                       ▼
//!                     native dialog              names the AUTHORITY's handle,
//!                                                the relay, and "PUBLISHED"
//!                       ▼ approved
//!                     messaging::account_keys    the signing keys, after the yes
//!                       ▼
//!                     issue_device_credential    §4.2's identity key signs
//!                       ▼
//!                     publish_device             DirectoryAuthKey signs the
//!                                                entry; the log's receipt is
//!                                                verified and kept
//! ```
//!
//! # What is NOT here, deliberately
//!
//! **No transport.** No deep-link parsing, no URL handling, no intent filter,
//! no scheme registration. [`receive_intent`] takes bytes that somebody else
//! decided to hand it, and it stays that way: `bridge.rs` is the one module
//! that knows a URL exists, so this one can be read as "what acting on an
//! admitted request means" without a reader having to hold a transport in
//! their head. Dispatching authority over a *custom scheme* would recreate
//! `#367` — a confused deputy — at the OS layer instead of the frame layer,
//! which is why the transport is a **verified** App Link (`#461`, landed in
//! `#977`) and nothing else.
//!
//! **No IPC surface.** [`receive_intent`] is deliberately *not* a
//! `#[tauri::command]` and appears in no capability. The privileged WebView
//! must not be able to mint an intent: `#367` is that the WebView's frames are
//! not separated from each other, so a command that turns caller-supplied bytes
//! into a payment confirmation is exactly the deputy that issue is about. A
//! test in this module reads `lib.rs` and fails if anything from here reaches
//! the invoke handler.
//!
//! **`issue-device-credential`, but not `sign-challenge`.** `#905`'s
//! correction comment ranks the three families:
//!
//! > Strength runs: **strong for `execute-payment`, medium for
//! > `issue-device-credential`, weak for `sign-challenge`.** … shipping
//! > `sign-challenge` first because it "only signs" is backwards.
//!
//! For `execute-payment` the confirmation carries content a human can actually
//! judge — an address and an amount, both re-derived by the wallet.
//! `issue-device-credential` is the same shape: the handle and the requested
//! validity window are shown, and the wallet's own lifetime policy (not the
//! caller's) decides the credential's actual `not_before` / `not_after`. For
//! `sign-challenge` the only human-meaningful content is *who is asking* and
//! *why*, and absent caller attestation both are attacker-chosen: a hostile app
//! sends `caller: cash.free2z.free2z`, `purpose: "Sign in to free2z"`, ZUULI
//! renders an entirely honest confirmation with a dishonest sender, and the
//! user approves. The confirmation does not fail there — it was never able to
//! tell the difference. `issue-device-credential` carries the identical
//! unattested-caller weakness — see [`CallerTrust::Claimed`]'s "NOT CONFIRMED"
//! line in both confirmations, and `#929` for the open gap that correlation is
//! not authentication. It ships anyway, on the same basis `execute-payment`
//! already did: the human reads an honest "NOT CONFIRMED" and decides, rather
//! than the wallet deciding silently. `sign-challenge` stays refused until a
//! platform brings [`CallerTrust::Attested`].
//!
//! # Caller trust, and the empty certificate lists
//!
//! [`REGISTERED_CALLERS`] carries no signing certificates yet, which is not an
//! oversight: `CallerRegistry::authorize` treats an attestation that no
//! registered certificate matches as a **refusal**, never as a downgrade to
//! [`CallerTrust::Claimed`]. So until the Android surface measures whether
//! `startActivityForResult` composes with a verified App Link (`#905`'s amended
//! acceptance criteria) and real certificate digests are registered here, an
//! attested call is refused rather than quietly believed. That is the
//! fail-closed direction, and it is the same direction `#911` chose when it
//! gave `CallerTrust` no `Claimed` → `Attested` path.
//!
//! The name the confirmation renders always comes from
//! [`AuthorizedCaller::display_name`] — our registry — and never from the
//! request's `caller` field.

use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use f2z_codec::canonical::Canonical as _;
use f2z_codec::types::{Body, Digest};
use f2z_intent::{
    encode_response, AdmittedIntent, CallerAttestation, CallerRegistry, CallerTrust,
    ConfirmationAuthorization, ConfirmationToken, ExecutePaymentRequestV1, ExecutePaymentResultV1,
    Intent, IntentBody, IntentClock, IntentError, IntentGate, IntentRequest, IntentResponseV1,
    IssueDeviceCredentialRequestV1, IssueDeviceCredentialRequestV2, IssueDeviceCredentialResultV1,
    RegisteredCaller, TxId, VisibleText, CONFIRMATION_TTL_MS,
};
use f2z_kt_core::types::{Handle, KemPublicKey};
use f2z_msg_identity::DeviceCredentialRequest;
use tauri::{AppHandle, Manager as _, Runtime};
use tauri_plugin_dialog::{DialogExt as _, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_f2zmsg::engine::DeviceEndpoint;
use tauri_plugin_f2zmsg::internal_directory;
use tauri_plugin_f2zmsg::models::ErrorCode;
use tauri_plugin_f2zmsg::state::F2zMsgExt as _;

use crate::directory_publish::{self, PublicationPlan};
use tauri_plugin_zcash::models::{BroadcastStatus, ExecuteSendResult, SendReview};
use tauri_plugin_zcash::wallet::send;
use tauri_plugin_zcash::ZcashExt as _;

/// Every app permitted to send an intent, and the name **ZUULI** renders for
/// it.
///
/// `(identifier, display name)`. The identifier is what the request's `caller`
/// field must equal — an Android package name or an iOS bundle identifier — and
/// the display name is what a human sees. They are separate values on purpose:
/// a caller chooses the first and cannot choose the second.
///
/// These are `#904`'s two delegated surfaces. An app that is not on this list
/// is refused before its identifier is even recorded in the replay ledger.
/// `(identifier, display name, reply URL)`.
///
/// The third field is where an answer to this caller is delivered, and it is a
/// **compile-time constant for exactly the reason the first two are
/// separate**: a caller that could name its own return address would be handed
/// the confused deputy back after every guard in this module had run. The
/// transport reads the reply URL from here, keyed by the caller the gate
/// admitted — never from the inbound URL, and never from the request body.
///
/// Each one is the verified App Link that app owns (`#977`,
/// `docs/intent-bridge/association/`). Only the app whose package or team owns
/// the domain association receives it, which is the property
/// `CALLER-AUTHENTICATION.md` §4 rests the response half on.
const REGISTERED_CALLERS: &[(&str, &str, &str)] = &[
    (
        "cash.free2z.free2z",
        "free2z",
        "https://free2z.com/bridge/free2z/",
    ),
    (
        "cash.free2z.e2e2z",
        "free2z Chat",
        "https://free2z.com/bridge/e2e2z/",
    ),
];

/// One answered intent: the bytes, and where they are addressed.
///
/// `reply_to` is resolved from [`REGISTERED_CALLERS`] against the caller
/// [`IntentGate::admit`] authorized, so the transport never has to re-parse a
/// request to learn where to send its answer — re-parsing outside `admit` is
/// exactly the "four checks out of five" this module exists to prevent.
#[derive(Debug, Clone)]
pub struct IntentOutcome {
    /// The encoded `IntentResponseV1`, fulfilled or refused.
    pub response: Vec<u8>,
    /// The registered reply URL for the caller that was admitted.
    pub reply_to: &'static str,
    /// The request identifier the answer correlates to, as the gate read it.
    pub request_id: [u8; 32],
}

/// The reply URL registered for `identifier`, if it is a registered caller.
fn reply_url_for(identifier: &str) -> Option<&'static str> {
    REGISTERED_CALLERS
        .iter()
        .find(|(registered, _, _)| *registered == identifier)
        .map(|(_, _, url)| *url)
}

/// The wallet's intent gate, held as Tauri managed state.
///
/// The replay ledger lives inside it, so it must be **one** value for the
/// process — a second gate is a second ledger, and two ledgers that each accept
/// an identifier the other has seen is one-use in name only.
pub struct IntentAuthority {
    /// `std::sync::Mutex` rather than an async one, and that is a constraint
    /// the code has to keep: [`IntentGate::admit`] is synchronous and the guard
    /// is dropped before the first `.await`. Nothing behind this lock does I/O.
    gate: Mutex<IntentGate>,
}

impl IntentAuthority {
    /// A gate over [`REGISTERED_CALLERS`].
    ///
    /// # Panics
    ///
    /// If a literal above is not bridge text or is registered twice. Both are
    /// impossible for the constants as written and both are asserted by
    /// `the_registry_is_exactly_the_two_delegated_surfaces`, so this can only
    /// fire on an edit that CI has already reddened.
    #[must_use]
    pub fn new() -> Self {
        Self {
            gate: Mutex::new(IntentGate::new(caller_registry())),
        }
    }
}

/// [`REGISTERED_CALLERS`], as a registry.
///
/// Separate from [`IntentAuthority::new`] only so that the *ledger* and the
/// *registry* are visibly different things: there is exactly one gate for the
/// process because a second ledger would accept an identifier the first one
/// spent, and `a_replayed_intent_is_refused_by_the_receiver` is what would go
/// red if [`receive_intent`] ever built its own.
fn caller_registry() -> CallerRegistry {
    let mut registry = CallerRegistry::new();
    for (identifier, display_name, _reply_to) in REGISTERED_CALLERS {
        registry
            .register(RegisteredCaller {
                identifier: bridge_text(identifier),
                display_name: bridge_text(display_name),
                // Empty, and fail-closed. See the module note.
                signing_certs: Vec::new(),
            })
            .expect("REGISTERED_CALLERS must not name one identifier twice");
    }
    registry
}

impl Default for IntentAuthority {
    fn default() -> Self {
        Self::new()
    }
}

/// Parse a compile-time literal as bridge text.
fn bridge_text(value: &str) -> VisibleText {
    VisibleText::new(value.as_bytes()).expect("a registry literal must be bridge text")
}

/// Receive one intent and answer it.
///
/// `bytes` is a decoded `IntentRequestEnvelope` and `attestation` is what the
/// operating system — **not** the request — says about who sent it. Both come
/// from a transport this module does not contain: `bridge.rs` carries them in
/// over the verified App Link `#977` landed, and carries the answer back out
/// to [`IntentOutcome::reply_to`].
///
/// # The two shapes of "no"
///
/// A refusal that reaches the caller is an encoded `IntentResponseV1` with a
/// non-zero status and an empty payload. A refusal that returns `Err` is one
/// the wallet **cannot** address to anybody: every guard in
/// [`IntentGate::admit`] runs before this function holds a parsed request, so
/// there is no `request_id` to echo and no family to name. Emitting a
/// correlatable refusal for those would mean parsing outside `admit` — which is
/// precisely the "four checks out of five" that `admit` exists to prevent — so
/// they stay `Err` and the transport decides whether anything is sent at all.
///
/// # Errors
///
/// Any [`IntentError`] [`IntentGate::admit`] produces, plus
/// [`IntentError::Unavailable`] if the wallet's clock or its own lock is
/// unusable, or if a well-formed response could not be encoded.
pub async fn receive_intent<R: Runtime>(
    app: &AppHandle<R>,
    bytes: &[u8],
    attestation: CallerAttestation<'_>,
) -> Result<IntentOutcome, IntentError> {
    let admitted = {
        let authority = app.state::<IntentAuthority>();
        // A poisoned gate means a panic happened while the ledger was being
        // mutated, so what it remembers is unknown. Fail closed rather than
        // accept an identifier the ledger may or may not have recorded.
        let mut gate = authority
            .gate
            .lock()
            .map_err(|_| IntentError::Unavailable)?;
        gate.admit(bytes, attestation, clock_now()?)?
    };

    let request = admitted.request();
    let request_id = *request.request_id().as_bytes();
    // `admit` refuses an unregistered caller before this line, so the lookup
    // cannot miss for any request that reaches it. It is still written as a
    // refusal rather than an `expect`: a registry edit that added an
    // identifier without a reply URL would otherwise turn a caller-supplied
    // message into a panic in the app that holds the seed.
    let reply_to =
        reply_url_for(request.claimed_caller().as_str()).ok_or(IntentError::CallerNotAuthorized)?;

    let response = if let Ok(payment) = payment_request(&admitted) {
        match execute_payment(app, &admitted, payment).await {
            Ok(txid) => fulfil_payment(request, txid),
            Err(refusal) => refuse(request, refusal),
        }
    } else if let Ok(credential_request) = credential_request(&admitted) {
        match issue_device_credential(app, &admitted, credential_request).await {
            Ok(credential) => fulfil_credential(request, credential),
            Err(refusal) => refuse(request, refusal),
        }
    } else {
        match publish_request(&admitted) {
            Ok(publish) => match issue_and_publish_device_credential(app, &admitted, publish).await
            {
                Ok(credential) => fulfil_credential(request, credential),
                Err(refusal) => refuse(request, refusal),
            },
            Err(refusal) => refuse(request, refusal),
        }
    }?;

    Ok(IntentOutcome {
        response,
        reply_to,
        request_id,
    })
}

/// The family dispatch, and the whole of `#905`'s corrected staging.
///
/// # Errors
///
/// [`IntentError::UnknownIntent`] for every family but `execute-payment` —
/// including `issue-device-credential`, which [`credential_request`] handles
/// instead, tried only after this function refuses it.
fn payment_request(admitted: &AdmittedIntent) -> Result<&ExecutePaymentRequestV1, IntentError> {
    match admitted.body() {
        IntentBody::ExecutePayment(payment) => Ok(payment),
        // `sign-challenge` cannot ship without caller attestation (see the
        // module note); the two `issue-device-credential` payload versions are
        // well-formed but belong to `credential_request` and
        // `publish_request`, not this function.
        IntentBody::SignChallenge(_)
        | IntentBody::IssueDeviceCredential(_)
        | IntentBody::IssueDeviceCredentialV2(_) => Err(IntentError::UnknownIntent),
        // `IntentBody` is `#[non_exhaustive]`: a family added upstream is
        // refused here until somebody decides what confirming it would mean.
        _ => Err(IntentError::UnknownIntent),
    }
}

/// The family dispatch for `issue-device-credential`, [`payment_request`]'s
/// counterpart.
///
/// # Errors
///
/// [`IntentError::UnknownIntent`] for every family but
/// `issue-device-credential`.
fn credential_request(
    admitted: &AdmittedIntent,
) -> Result<&IssueDeviceCredentialRequestV1, IntentError> {
    match admitted.body() {
        IntentBody::IssueDeviceCredential(credential) => Ok(credential),
        _ => Err(IntentError::UnknownIntent),
    }
}

/// The family dispatch for `issue-device-credential-v2` — the same credential,
/// plus the directory entry that publishes the device (ADR 0017 §4.1).
///
/// # Errors
///
/// [`IntentError::UnknownIntent`] for every family but
/// `issue-device-credential-v2`.
fn publish_request(
    admitted: &AdmittedIntent,
) -> Result<&IssueDeviceCredentialRequestV2, IntentError> {
    match admitted.body() {
        IntentBody::IssueDeviceCredentialV2(publish) => Ok(publish),
        _ => Err(IntentError::UnknownIntent),
    }
}

/// Re-derive the payment, show ZUULI's own review, and — only on approval —
/// route through the existing execution path.
///
/// Every value the user sees comes from `review`, which
/// [`send::prepare_send_confirmation`] returns after the plugin has re-derived
/// it from the native proposal. The caller's own numbers are used for exactly
/// two things: as *inputs* to the proposal, and as a comparison the proposal
/// must survive ([`review_matches_request`]).
async fn execute_payment<R: Runtime>(
    app: &AppHandle<R>,
    admitted: &AdmittedIntent,
    payment: &ExecutePaymentRequestV1,
) -> Result<TxId, IntentError> {
    let state = &app.zcash().state;

    // Bridge text is UTF-8 by construction; these two are `VisibleText`'s
    // invariant restated for the plugin's `&str` API.
    let recipient = core::str::from_utf8(payment.recipient.as_slice())
        .map_err(|_| IntentError::InvalidValue)?;
    let memo =
        core::str::from_utf8(payment.memo.as_slice()).map_err(|_| IntentError::InvalidValue)?;
    let memo = (!memo.is_empty()).then_some(memo);

    // Held for the whole delegation, exactly as `confirm_send` holds it: no
    // wallet switch, restore or delete may land between the review the user
    // reads and the transaction ZUULI signs.
    let transition = state.lock_wallet_transition().await;

    let proposal = send::propose_send(state, recipient, payment.amount_zatoshis, memo)
        .await
        .map_err(|error| {
            tracing::warn!("intent execute-payment could not be proposed: {error}");
            IntentError::Unavailable
        })?;

    let outcome = async {
        // `send_operation` is taken *after* `propose_send`, which takes it
        // itself and releases it. From here it is held across the dialog and
        // through execution — `take_send_proposal` documents that requirement.
        let _send_operation = state.send_operation.lock().await;

        let review = send::prepare_send_confirmation(
            state,
            proposal.proposal_id,
            &proposal.review_digest,
            &proposal.proposal_token,
        )
        .await
        .map_err(|error| {
            tracing::warn!("intent execute-payment lost its proposal before review: {error}");
            IntentError::Unavailable
        })?;

        review_matches_request(payment, &review)?;

        let message = payment_confirmation(admitted, &review, payment.fee_zatoshis);
        if !confirm_natively(
            app,
            "Authorize Zcash payment for another app",
            "Authorize payment",
            message,
        )
        .await
        {
            return Err(IntentError::NotConfirmed);
        }

        // The approval, bound to THIS request and THIS review. `request_digest`
        // covers every field of the intent — family, identifier, caller,
        // purpose, window, payload — because it is taken over the re-encoded
        // envelope; `review_digest` is the plugin's own `send_review_digest`
        // over the proposal, wallet and session. Neither can move alone.
        let request_digest = admitted.request_digest();
        let review_digest = digest_from_hex(&proposal.review_digest)?;
        let token = mint_confirmation_token()?;
        let approval = ConfirmationAuthorization::issue(
            &request_digest,
            &review_digest,
            &token,
            clock_now()?,
            CONFIRMATION_TTL_MS,
        )?;

        // #528's own one-use execution credential, minted from the same
        // approval and bound to the same review.
        let confirmation = send::issue_send_confirmation(
            state,
            proposal.proposal_id,
            &proposal.review_digest,
            &proposal.proposal_token,
        )
        .await
        .map_err(|error| {
            tracing::warn!("intent execute-payment could not mint a confirmation: {error}");
            IntentError::Unavailable
        })?;

        // Spend the intent approval. `consume` takes `self`, so there is no
        // second use to prevent, and it re-checks the monotonic deadline, the
        // wall deadline and the rollback guard against a fresh reading.
        approval.consume(&request_digest, &review_digest, &token, clock_now()?)?;

        let pending = send::take_send_proposal(
            state,
            proposal.proposal_id,
            &proposal.review_digest,
            &confirmation.confirmation_token,
        )
        .await
        .map_err(|error| {
            tracing::warn!("intent execute-payment confirmation was not accepted: {error}");
            IntentError::NotConfirmed
        })?;

        // Consumption before custody, the same order `execute_send` uses: a
        // failed execution always requires a fresh confirmation.
        tauri_plugin_zcash::wallet::ensure_active_seed_loaded(state, &transition)
            .await
            .map_err(|error| {
                tracing::warn!("intent execute-payment could not load custody: {error}");
                IntentError::Unavailable
            })?;

        let executed = send::execute_send(state, proposal.proposal_id, pending)
            .await
            .map_err(|error| {
                tracing::warn!("intent execute-payment failed to execute: {error}");
                IntentError::Unavailable
            })?;

        payment_outcome(&executed)
    }
    .await;

    if outcome.is_err() {
        // `send_operation` is released above, and `discard_send_proposal` takes
        // it for itself. A cancelled or failed intent must not leave a reviewed
        // proposal sitting in the wallet for the next `confirm_send` to find.
        // It is already gone once execution consumed it, so a failure here is
        // expected and is not an additional refusal.
        if let Err(error) = send::discard_send_proposal(
            state,
            proposal.proposal_id,
            &proposal.review_digest,
            &proposal.proposal_token,
        )
        .await
        {
            tracing::debug!("intent execute-payment had no proposal left to discard: {error}");
        }
    }
    outcome
}

/// Show ZUULI's own confirmation and — only on approval — read the seed once,
/// derive §4.2's identity key, and sign the caller's device keys into a
/// `DeviceCredential`.
///
/// The dialog is shown **before** [`crate::messaging::account_keys`] is
/// called, the same ordering `execute_payment` uses for
/// `ensure_active_seed_loaded`: the wallet's custody is touched only after a
/// human has already said yes, so a refused or cancelled request never opens
/// it at all.
///
/// The validity window is ZUULI's own policy —
/// [`crate::messaging::CREDENTIAL_BACKDATE_MS`] /
/// [`crate::messaging::CREDENTIAL_LIFETIME_MS`], the same constants
/// `f2zmsg_enroll` issues its own credentials under — not the caller's
/// `not_before_ms` / `not_after_ms`. Those two are advisory, exactly like
/// `execute_payment`'s `fee_zatoshis`: shown so a divergence is visible, never
/// enforced, because a credential's lifetime is the issuer's to set and a
/// caller-chosen window would let any registered app mint itself a
/// decades-long credential.
async fn issue_device_credential<R: Runtime>(
    app: &AppHandle<R>,
    admitted: &AdmittedIntent,
    request: &IssueDeviceCredentialRequestV1,
) -> Result<Vec<u8>, IntentError> {
    let handle =
        Handle::new(request.handle.as_slice().to_vec()).map_err(|_| IntentError::InvalidValue)?;
    let device_kem_pk = KemPublicKey::new(request.device_kem_pk.as_slice().to_vec())
        .map_err(|_| IntentError::InvalidValue)?;

    let now_ms = clock_now()?.wall_ms;
    let not_before_ms = now_ms.saturating_sub(crate::messaging::CREDENTIAL_BACKDATE_MS);
    let not_after_ms = now_ms.saturating_add(crate::messaging::CREDENTIAL_LIFETIME_MS);

    let message = credential_confirmation(
        admitted,
        &handle,
        request.not_before_ms,
        request.not_after_ms,
    );
    if !confirm_natively(
        app,
        "Authorize a messaging device credential for another app",
        "Authorize enrollment",
        message,
    )
    .await
    {
        return Err(IntentError::NotConfirmed);
    }

    let account = crate::messaging::account_keys(app).await.map_err(|error| {
        tracing::warn!("intent issue-device-credential could not read wallet custody: {error}");
        IntentError::Unavailable
    })?;

    let credential = account
        .identity
        .issue_device_credential(&DeviceCredentialRequest {
            handle,
            device_pk: request.device_pk,
            device_kem_pk,
            not_before_ms,
            not_after_ms,
        })
        .map_err(|error| {
            tracing::warn!(
                "intent issue-device-credential was refused by the identity key: {error}"
            );
            IntentError::InvalidValue
        })?;

    f2z_msg_mls::credential::encode(&credential).map_err(|error| {
        tracing::warn!("intent issue-device-credential could not encode its result: {error}");
        IntentError::Unavailable
    })
}

/// Issue the credential **and publish the device**, which is the whole of
/// version 2 (ADR 0017 §4.1).
///
/// # The order, and why it is not version 1's
///
/// Version 1 shows its dialog before the wallet's custody is opened at all.
/// This one cannot, and the reason is the thing the dialog has to say: a
/// publication names a *handle*, and the only sources for a handle that are not
/// the requesting app are the handle authority's signed assertion and an entry
/// the log already publishes — and both are keyed by this account's **identity
/// key**, which is derived from the seed. So the public half of that key is
/// derived first ([`account_identity`], which drops everything else), the
/// handle is established, and only then is a human asked. The *signing* keys
/// are still read after the approval, and a refused request still signs
/// nothing, publishes nothing and spends nothing.
///
/// What that costs is stated rather than hidden: a request from a registered
/// caller now reaches the handle authority — one `POST` with the user's own
/// session, for the user's own account — before the user has approved
/// anything. The answer is useless without the seed's binding signature, and
/// the answer never reaches the caller.
async fn issue_and_publish_device_credential<R: Runtime>(
    app: &AppHandle<R>,
    admitted: &AdmittedIntent,
    request: &IssueDeviceCredentialRequestV2,
) -> Result<Vec<u8>, IntentError> {
    let handle =
        Handle::new(request.handle.as_slice().to_vec()).map_err(|_| IntentError::InvalidValue)?;
    let requested_handle = core::str::from_utf8(request.handle.as_slice())
        .map_err(|_| IntentError::InvalidValue)?
        .to_owned();
    let device_kem_pk = KemPublicKey::new(request.device_kem_pk.as_slice().to_vec())
        .map_err(|_| IntentError::InvalidValue)?;
    let endpoint = DeviceEndpoint {
        relay_url: core::str::from_utf8(request.contact_relay_url.as_slice())
            .map_err(|_| IntentError::InvalidValue)?
            .to_owned(),
        relay_id: *request.contact_relay_id.as_bytes(),
        contact_addr: *request.contact_addr.as_bytes(),
    };
    let relay_host = relay_host(&endpoint.relay_url).ok_or(IntentError::InvalidValue)?;

    let bundled = internal_directory::bundled();
    let Some(internal) = bundled.configured() else {
        tracing::warn!("intent issue-device-credential-v2 has no directory to publish to");
        return Err(IntentError::Unavailable);
    };
    let engine = app.f2zmsg().engine_handle().map_err(|error| {
        tracing::warn!(code = %error.code(), "intent publish could not reach the engine");
        IntentError::Unavailable
    })?;
    let client = directory_publish::HandleAssertionClient::new(&internal.handle_assertion_url)
        .map_err(|error| {
            tracing::warn!(code = %error.code(), "intent publish could not build a client");
            IntentError::Unavailable
        })?;

    // The account's public identity, and nothing else that the seed derives.
    let identity_pk = account_identity(app).await?;
    let now_ms = clock_now()?.wall_ms;
    let token = app.state::<crate::session::Free2zSession>().token().await;
    let plan = directory_publish::plan_publication(
        internal,
        &engine,
        &client,
        &identity_pk,
        &requested_handle,
        token.as_deref(),
        now_ms,
    )
    .await
    .map_err(|error| {
        tracing::warn!(
            code = %error.code(),
            context = %error.context(),
            "intent publish could not establish whose handle this is"
        );
        publication_refusal(error.code())
    })?;
    // The plan's handle comes from the authority or from the log. It is
    // compared against the request here so that a wallet whose account holds a
    // different handle refuses rather than publishing under one the requesting
    // app never asked for.
    if plan.handle != requested_handle {
        return Err(IntentError::HandleUnavailable);
    }

    let message = publish_confirmation(admitted, &plan, &relay_host);
    if !confirm_natively(
        app,
        "Publish a messaging device in your account",
        "Publish this device",
        message,
    )
    .await
    {
        return Err(IntentError::NotConfirmed);
    }

    let account = crate::messaging::account_keys(app).await.map_err(|error| {
        tracing::warn!(code = %error.code(), "intent publish could not read wallet custody");
        IntentError::Unavailable
    })?;
    if account.identity.public().as_bytes() != &identity_pk {
        // The active wallet changed between the handle being established and
        // the approval being acted on.
        tracing::warn!("intent publish: the active wallet changed mid-request");
        return Err(IntentError::Unavailable);
    }

    let not_before_ms = now_ms.saturating_sub(crate::messaging::CREDENTIAL_BACKDATE_MS);
    let not_after_ms = now_ms.saturating_add(crate::messaging::CREDENTIAL_LIFETIME_MS);
    let credential = account
        .identity
        .issue_device_credential(&DeviceCredentialRequest {
            handle,
            device_pk: request.device_pk,
            device_kem_pk,
            not_before_ms,
            not_after_ms,
        })
        .map_err(|error| {
            tracing::warn!("intent publish was refused by the identity key: {error}");
            IntentError::InvalidValue
        })?;
    let encoded = f2z_msg_mls::credential::encode(&credential).map_err(|error| {
        tracing::warn!("intent publish could not encode its credential: {error}");
        IntentError::Unavailable
    })?;

    // Only a device the log accepted is a device this wallet answers for: the
    // requesting app installs nothing unless the entry was submitted and its
    // receipt verified. A refusal here means nothing was installed anywhere.
    let receipt = directory_publish::publish_device(
        internal,
        &engine,
        &account,
        &plan,
        directory_publish::DeviceToPublish {
            credential: encoded.clone(),
            device_pk: *request.device_pk.as_bytes(),
            endpoint,
        },
        now_ms,
    )
    .await
    .map_err(|error| {
        tracing::warn!(
            code = %error.code(),
            context = %error.context(),
            "intent publish was not accepted by the directory"
        );
        publication_refusal(error.code())
    })?;
    tracing::info!(
        handle = %plan.handle,
        entry_version = receipt.receipt.entry_version,
        merge_by_ms = receipt.receipt.merge_by_ms,
        "published a device for another app, and kept the log's receipt"
    );
    Ok(encoded)
}

/// The account's identity **public** key, with everything else the seed derives
/// dropped before this returns.
///
/// A separate function from [`crate::messaging::account_keys`] so the ordering
/// rule is visible and testable: what runs before the confirmation reads the
/// account's public name, and what runs after it holds signing keys.
async fn account_identity<R: Runtime>(app: &AppHandle<R>) -> Result<[u8; 32], IntentError> {
    let account = crate::messaging::account_keys(app).await.map_err(|error| {
        tracing::warn!(code = %error.code(), "intent publish could not read wallet custody");
        IntentError::Unavailable
    })?;
    Ok(*account.identity.public().as_bytes())
}

/// The refusal a publication failure travels as.
///
/// `handle-ineligible` is the one case the caller can do something about — no
/// free2z session in this wallet, an account with no bound handle, or an
/// account whose handle is a different one — and PROTOCOL.md §6.2's rule
/// applies to the rest: [`IntentError::Unavailable`] claims nothing about
/// whether the entry reached the log.
const fn publication_refusal(code: ErrorCode) -> IntentError {
    match code {
        ErrorCode::HandleIneligible => IntentError::HandleUnavailable,
        _ => IntentError::Unavailable,
    }
}

/// The host of a `wss://` relay URL, for the confirmation.
///
/// `f2z_intent` has already refused a URL that is not `wss://` with a host, so
/// this is the rendering half: a human judges "where will strangers reach this
/// device", and that is a host, not a path.
fn relay_host(relay_url: &str) -> Option<String> {
    let parsed = url::Url::parse(relay_url).ok()?;
    let host = parsed.host_str()?.to_owned();
    Some(match parsed.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

/// ZUULI's own confirmation copy for `issue-device-credential-v2`.
///
/// Three rules beyond [`format_payment_confirmation`]'s two:
///
/// 1. **It says PUBLISHED.** `ARCHITECTURE.md`: "adding a device to an account
///    is a wiretap". The user is not approving a local setup step; they are
///    approving an append-only, world-readable statement that another device
///    may speak as them.
/// 2. **The handle is the authority's, never the request's.** `plan.handle`
///    comes from a signed `HandleAssertion` this build's bundled key verified,
///    or from an entry the log publishes under this wallet's own identity key.
///    The request's handle never reaches this function.
/// 3. **The relay is named.** ADR 0017 §4.1: the endpoint is a value the
///    *requester* chose, so the confirmation shows where first contact will be
///    delivered.
fn publish_confirmation(
    admitted: &AdmittedIntent,
    plan: &PublicationPlan,
    relay_host: &str,
) -> String {
    let caller = admitted.caller();
    format_publish_confirmation(
        caller.display_name().as_str(),
        caller.trust(),
        admitted.request().purpose().as_str(),
        plan,
        relay_host,
    )
}

fn format_publish_confirmation(
    caller_display_name: &str,
    trust: CallerTrust,
    purpose: &str,
    plan: &PublicationPlan,
    relay_host: &str,
) -> String {
    let named = send::quote_native_memo(caller_display_name);
    let handle = send::quote_native_memo(&format!("@{}", plan.handle));
    let mut lines = vec![
        "Another app asked ZUULI to add a device to your messaging account.".to_owned(),
        String::new(),
        format!("Requesting app: {named}"),
        match trust {
            CallerTrust::Attested => {
                "Identity: CONFIRMED by this device's operating system.".to_owned()
            }
            CallerTrust::Claimed => "Identity: NOT CONFIRMED. This device cannot tell whether the app that sent this request is the one named above.".to_owned(),
        },
        format!("Its stated reason, in its own words: {}", send::quote_native_memo(purpose)),
        String::new(),
        format!("This device will be PUBLISHED in the free2z directory under {handle}."),
        if plan.handle_is_vouched() {
            format!("free2z's handle authority signed for {handle} just now, and this would be its first published entry.")
        } else {
            format!("{handle} is already published under this wallet's messaging identity.")
        },
        format!(
            "Your account already publishes {} device(s).",
            plan.published_devices()
        ),
        format!(
            "First contact for the new device will be delivered at {}.",
            send::quote_native_memo(relay_host)
        ),
        String::new(),
    ];
    lines.push(
        "Publishing is permanent and public: anyone who looks up this handle will see that this \
         device may send and receive encrypted messages as you. Adding a device you did not set \
         up yourself is what a wiretap looks like. Authorize only if you are setting up messaging \
         on this device, right now."
            .to_owned(),
    );
    lines.join("\n")
}

/// The confirmation for one admitted intent, assembled from the wallet's own
/// values.
///
/// This function exists so that *where each string comes from* is a decision a
/// test can drive. The display name is
/// [`f2z_intent::AuthorizedCaller::display_name`] — our registry — and the
/// request's own `caller` field never appears on the screen at all;
/// `the_confirmation_names_the_caller_from_our_registry_and_not_from_the_request`
/// admits a real request and asserts exactly that, so substituting
/// `claimed_caller()` here is a red test rather than a code review.
fn payment_confirmation(
    admitted: &AdmittedIntent,
    review: &SendReview,
    expected_fee_zatoshis: u64,
) -> String {
    let caller = admitted.caller();
    format_payment_confirmation(
        caller.display_name().as_str(),
        caller.trust(),
        admitted.request().purpose().as_str(),
        review,
        expected_fee_zatoshis,
    )
}

/// ZUULI's own confirmation copy.
///
/// Two rules, and both are the reason this function exists rather than a
/// caller-supplied string being shown:
///
/// 1. **The identity is ours.** `caller_display_name` comes from
///    [`REGISTERED_CALLERS`] via [`f2z_intent::AuthorizedCaller::display_name`].
///    The request's own `caller` field is a lookup key and never reaches this
///    line.
/// 2. **The caller's one string is quoted and escaped.** `purpose` is the only
///    caller-authored text on the screen. `VisibleText` has already refused
///    every layout control in it; [`send::quote_native_memo`] is #528's exact
///    treatment applied a second time, so the property holds by rendering and
///    not only by parsing. `assert_hostile_purpose_cannot_restructure_the_dialog`
///    drives this function with strings `VisibleText` would have rejected.
///
/// The payment block itself is [`send::native_review_lines`] — the same lines
/// the wallet's own send flow shows, not a second rendering of one payment.
fn format_payment_confirmation(
    caller_display_name: &str,
    trust: CallerTrust,
    purpose: &str,
    review: &SendReview,
    expected_fee_zatoshis: u64,
) -> String {
    let named = send::quote_native_memo(caller_display_name);
    let mut lines = vec![
        "Another app asked ZUULI to send this Zcash payment.".to_owned(),
        String::new(),
        format!("Requesting app: {named}"),
        match trust {
            CallerTrust::Attested => {
                "Identity: CONFIRMED by this device's operating system.".to_owned()
            }
            CallerTrust::Claimed => "Identity: NOT CONFIRMED. This device cannot tell whether the app that sent this request is the one named above.".to_owned(),
        },
        format!("Its stated reason, in its own words: {}", send::quote_native_memo(purpose)),
        String::new(),
    ];
    lines.extend(send::native_review_lines(review));
    if expected_fee_zatoshis != review.fee {
        // Advisory in the wire format, and shown rather than enforced: the
        // wallet's own fee rule decides, and a caller that expected something
        // else is a discrepancy the human should see.
        lines.push(format!(
            "The requesting app expected a fee of {}.",
            send::format_zec_amount(expected_fee_zatoshis)
        ));
    }
    lines.extend([
        String::new(),
        "Every amount above was re-derived by ZUULI from its own wallet. Authorize only if this is the payment you intend to send.".to_owned(),
    ]);
    lines.join("\n")
}

/// The confirmation for one admitted `issue-device-credential`, assembled
/// from the wallet's own values and the caller's handle.
///
/// Mirrors [`payment_confirmation`]: the display name is always
/// [`f2z_intent::AuthorizedCaller::display_name`], never the request's own
/// `caller` field.
fn credential_confirmation(
    admitted: &AdmittedIntent,
    handle: &Handle,
    requested_not_before_ms: u64,
    requested_not_after_ms: u64,
) -> String {
    let caller = admitted.caller();
    format_credential_confirmation(
        caller.display_name().as_str(),
        caller.trust(),
        admitted.request().purpose().as_str(),
        handle,
        requested_not_before_ms,
        requested_not_after_ms,
    )
}

/// ZUULI's own confirmation copy for `issue-device-credential`.
///
/// Same two rules as [`format_payment_confirmation`]: the identity shown is
/// ours, from the registry, and the caller's one string (`purpose`) is quoted
/// and escaped by [`send::quote_native_memo`] — reused here rather than
/// duplicated, since the hostile-input treatment it gives is not specific to
/// Zcash memos.
///
/// The handle is quoted the same way: `Handle`'s charset
/// (`[a-z0-9_]{1,30}`) cannot itself carry a layout control, but quoting it
/// keeps the confirmation's escaping uniform rather than "safe here because
/// the type happens to forbid it".
fn format_credential_confirmation(
    caller_display_name: &str,
    trust: CallerTrust,
    purpose: &str,
    handle: &Handle,
    requested_not_before_ms: u64,
    requested_not_after_ms: u64,
) -> String {
    let named = send::quote_native_memo(caller_display_name);
    let handle_text = send::quote_native_memo(&String::from_utf8_lossy(handle.as_slice()));
    let requested_days =
        requested_not_after_ms.saturating_sub(requested_not_before_ms) / 86_400_000;
    [
        "Another app asked ZUULI to issue a messaging device credential.".to_owned(),
        String::new(),
        format!("Requesting app: {named}"),
        match trust {
            CallerTrust::Attested => {
                "Identity: CONFIRMED by this device's operating system.".to_owned()
            }
            CallerTrust::Claimed => "Identity: NOT CONFIRMED. This device cannot tell whether the app that sent this request is the one named above.".to_owned(),
        },
        format!("Its stated reason, in its own words: {}", send::quote_native_memo(purpose)),
        String::new(),
        format!("Handle this credential will speak for: {handle_text}"),
        format!(
            "The requesting app asked for approximately {requested_days} day(s) of validity."
        ),
        String::new(),
        "This credential lets the requesting app send and receive encrypted messages under your messaging identity, for as long as ZUULI's own credential lifetime allows — not necessarily what the app above requested. Authorize only if you intend to enroll that app for messaging.".to_owned(),
    ]
    .join("\n")
}

/// Encode a fulfilled `issue-device-credential`.
fn fulfil_credential(request: &IntentRequest, credential: Vec<u8>) -> Result<Vec<u8>, IntentError> {
    let payload = IssueDeviceCredentialResultV1 {
        credential: Body::new(credential)?,
    }
    .encode_canonical()?;
    encode_response(&IntentResponseV1 {
        request_id: *request.request_id(),
        // The family that was asked: version 2 is answered as version 2, and a
        // client that checked the echo against its own question would refuse
        // anything else.
        intent: request.intent().code(),
        status: 0,
        payload: Body::new(payload)?,
    })
}

/// Show the OS-owned dialog and answer whether it was authorized.
///
/// The dialog plugin is reachable only from Rust — `lib.rs` grants it to no
/// capability — so this is the same OS-owned surface `confirm_send` uses, and
/// no renderer can draw over it or answer it.
async fn confirm_natively<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    accept_label: &str,
    message: String,
) -> bool {
    let (sender, mut receiver) = tauri::async_runtime::channel::<bool>(1);
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            accept_label.to_owned(),
            "Cancel".to_owned(),
        ))
        .show(move |accepted| {
            // Capacity is one and nothing else sends, so this cannot be full.
            // `try_send` rather than `blocking_send` because the callback runs
            // on the platform's UI thread, which may be a runtime thread.
            let _ = sender.try_send(accepted);
        });
    dialog_verdict(receiver.recv().await)
}

/// What the dialog channel's answer means.
///
/// `Some(true)` is the only authorization. `Some(false)` is *Cancel*, and
/// `None` is a sender dropped without a verdict — a dialog the platform closed,
/// a callback that never ran, a runtime torn down mid-prompt. All three of the
/// non-`Some(true)` cases are refusals, and none of them is a default: written
/// as `matches!` rather than `unwrap_or`, the refusing branch is the one you
/// have to delete rather than the one you have to remember.
///
/// A pure function so `silence_from_the_dialog_is_a_refusal` can drive every
/// case; the surrounding `async fn` needs a real window and cannot be.
const fn dialog_verdict(reported: Option<bool>) -> bool {
    matches!(reported, Some(true))
}

/// The wallet's re-derived review must describe the payment that was asked for.
///
/// [`send::propose_send`] is given the caller's recipient, amount and memo, so
/// agreement is the expected case. It is checked anyway because the review is
/// what the user approves and the request is what the confirmation binds: if
/// the wallet's own re-derivation ever differed — a re-encoded address, a memo
/// the proposal normalised, a second payment appearing in one step — the human
/// would approve one thing while `request_digest` attested to another. Failing
/// closed is the only reading of that divergence that is not a guess.
///
/// # Errors
///
/// [`IntentError::InvalidValue`] on any divergence, and on a review that does
/// not hold exactly one payment.
fn review_matches_request(
    request: &ExecutePaymentRequestV1,
    review: &SendReview,
) -> Result<(), IntentError> {
    let [payment] = review.payments.as_slice() else {
        return Err(IntentError::InvalidValue);
    };
    if payment.recipient.as_bytes() != request.recipient.as_slice() {
        return Err(IntentError::InvalidValue);
    }
    if payment.amount != request.amount_zatoshis {
        return Err(IntentError::InvalidValue);
    }
    // An absent memo and an empty memo are the same request; anything else must
    // match byte for byte.
    let rendered_memo = payment.memo.as_deref().unwrap_or_default();
    if rendered_memo.as_bytes() != request.memo.as_slice() {
        return Err(IntentError::InvalidValue);
    }
    Ok(())
}

/// What a completed `execute_send` means to the caller.
///
/// Only [`BroadcastStatus::Accepted`] is a payment. `Rejected` is a refusal and
/// `Unknown` is an **ambiguous** broadcast — the transaction exists locally and
/// the wallet retains the exact bytes for `retry_pending_send`, but nothing
/// establishes that the network took them. Returning a txid for either would
/// tell the caller a payment landed that may not have, and that is the one
/// answer no later message can correct: an app that showed "sent" cannot
/// unshow it.
///
/// A pure function rather than three lines inside the delegation, so that all
/// three variants are drivable by a test. Nothing above `execute_send` can be
/// unit-tested — it needs a funded wallet, a prover and a network — and this is
/// the part of it that does not have to inherit that.
///
/// # Errors
///
/// [`IntentError::Unavailable`] for any status but `Accepted`, and for a
/// transaction identifier that is not 32 bytes.
fn payment_outcome(executed: &ExecuteSendResult) -> Result<TxId, IntentError> {
    if executed.status != BroadcastStatus::Accepted {
        tracing::warn!(
            "intent execute-payment broadcast did not complete: {:?}",
            executed.status
        );
        return Err(IntentError::Unavailable);
    }
    txid_from_rendered(&executed.txid)
}

/// Encode a refusal: the status, echoed correlation, and nothing else.
fn refuse(request: &IntentRequest, error: IntentError) -> Result<Vec<u8>, IntentError> {
    encode_response(&IntentResponseV1 {
        request_id: *request.request_id(),
        intent: request.intent().code(),
        // Never zero: `IntentError::status` has no variant that maps to
        // `fulfilled`, and `a_refusal_never_claims_to_have_acted` pins it.
        status: error.status(),
        payload: Body::new(Vec::new())?,
    })
}

/// Encode a fulfilled `execute-payment`.
fn fulfil_payment(request: &IntentRequest, txid: TxId) -> Result<Vec<u8>, IntentError> {
    let payload = ExecutePaymentResultV1 { txid }.encode_canonical()?;
    encode_response(&IntentResponseV1 {
        request_id: *request.request_id(),
        intent: Intent::ExecutePayment.code(),
        status: 0,
        payload: Body::new(payload)?,
    })
}

/// The 32 bytes of a transaction identifier, in the order ZUULI renders it.
///
/// `ExecuteSendResult::txid` is `format!("{txid}")` over a `zcash_protocol::TxId`,
/// which is the display (reversed) order every Zcash explorer uses. The wire
/// field is opaque, so the choice has to be stated somewhere: it is stated here
/// and in `docs/intent-bridge/AUTHORITY.md`, and a client that hex-encodes these
/// bytes gets the string a user would paste into an explorer.
fn txid_from_rendered(rendered: &str) -> Result<TxId, IntentError> {
    let bytes = hex::decode(rendered).map_err(|_| IntentError::Unavailable)?;
    TxId::from_slice(&bytes).map_err(|_| IntentError::Unavailable)
}

/// The plugin's `send_review_digest`, which is hex, as the 32 bytes a
/// confirmation binds.
fn digest_from_hex(rendered: &str) -> Result<Digest, IntentError> {
    let bytes = hex::decode(rendered).map_err(|_| IntentError::Unavailable)?;
    let array: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| IntentError::Unavailable)?;
    Ok(Digest::new(array))
}

/// 32 CSPRNG bytes for one approval.
fn mint_confirmation_token() -> Result<ConfirmationToken, IntentError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| IntentError::Unavailable)?;
    Ok(ConfirmationToken::new(bytes))
}

/// One reading of both clocks.
///
/// `f2z-intent` is `no_std` and reads no clock, so this is the only place the
/// wallet's two clocks are sampled. The monotonic half is measured from a
/// process-start baseline because `Instant` has no epoch — only differences in
/// it are ever used, which is exactly why it is trusted where the wall clock is
/// not.
fn clock_now() -> Result<IntentClock, IntentError> {
    static START: OnceLock<Instant> = OnceLock::new();
    let monotonic_ms = u64::try_from(START.get_or_init(Instant::now).elapsed().as_millis())
        .map_err(|_| IntentError::Unavailable)?;
    let wall_ms = u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| IntentError::Unavailable)?
            .as_millis(),
    )
    .map_err(|_| IntentError::Unavailable)?;
    Ok(IntentClock::new(monotonic_ms, wall_ms))
}

#[cfg(test)]
mod tests {
    use super::*;
    use f2z_codec::types::ShortBytes;
    use f2z_intent::{
        decode_response, encode_request, IntentRequestV1, RequestId, SigningCertDigest,
    };
    use tauri_plugin_zcash::models::SendPaymentReview;

    const ISSUED_AT_MS: u64 = 1_700_000_000_000;
    const RECIPIENT: &str = "u1exampleexampleexample";

    fn review(memo: Option<&str>) -> SendReview {
        SendReview {
            version: 2,
            network: "mainnet".to_owned(),
            payments: vec![SendPaymentReview {
                recipient: RECIPIENT.to_owned(),
                amount: 50_000,
                memo: memo.map(str::to_owned),
            }],
            fee_policy: "zip317-standard".to_owned(),
            fee: 10_000,
            total: 60_000,
            change_policy: "zip317-shielded-auto".to_owned(),
        }
    }

    fn payment(memo: &str) -> ExecutePaymentRequestV1 {
        ExecutePaymentRequestV1 {
            recipient: ShortBytes::new(RECIPIENT.as_bytes().to_vec()).unwrap(),
            amount_zatoshis: 50_000,
            memo: ShortBytes::new(memo.as_bytes().to_vec()).unwrap(),
            fee_zatoshis: 10_000,
        }
    }

    fn request_bytes(intent: Intent, payload: Vec<u8>, caller: &str, request_id: u8) -> Vec<u8> {
        request_bytes_at(intent, payload, caller, request_id, ISSUED_AT_MS)
    }

    fn request_bytes_at(
        intent: Intent,
        payload: Vec<u8>,
        caller: &str,
        request_id: u8,
        issued_at_ms: u64,
    ) -> Vec<u8> {
        encode_request(&IntentRequestV1 {
            intent: intent.code(),
            request_id: RequestId::new([request_id; 32]),
            caller: ShortBytes::new(caller.as_bytes().to_vec()).unwrap(),
            purpose: ShortBytes::new(b"Tip for your article".to_vec()).unwrap(),
            issued_at_ms,
            expires_at_ms: issued_at_ms + 60_000,
            payload: Body::new(payload).unwrap(),
        })
        .unwrap()
    }

    fn payment_bytes(caller: &str, request_id: u8) -> Vec<u8> {
        request_bytes(
            Intent::ExecutePayment,
            payment("thanks").encode_canonical().unwrap(),
            caller,
            request_id,
        )
    }

    fn admit(gate: &mut IntentGate, bytes: &[u8]) -> Result<AdmittedIntent, IntentError> {
        gate.admit(
            bytes,
            CallerAttestation::None,
            IntentClock::new(42_000, ISSUED_AT_MS),
        )
    }

    fn gate() -> IntentGate {
        let authority = IntentAuthority::new();
        authority.gate.into_inner().unwrap()
    }

    /// A ZUULI with the intent authority managed and nothing else.
    ///
    /// Enough to drive [`receive_intent`] for every path that refuses before
    /// the wallet is touched — which is every path this suite can reach, since
    /// acting on a payment needs a funded wallet, a prover and a network.
    #[cfg(not(target_os = "windows"))]
    fn mock_zuuli() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .manage(IntentAuthority::new())
            .build(crate::app_context())
            .expect("mock ZUULI with the intent authority managed")
    }

    #[cfg(not(target_os = "windows"))]
    /// The encoded answer only. The routing half of [`IntentOutcome`] has its
    /// own assertions in `the_answer_is_addressed_from_the_registry`.
    fn receive(
        app: &tauri::App<tauri::test::MockRuntime>,
        bytes: &[u8],
    ) -> Result<Vec<u8>, IntentError> {
        tauri::async_runtime::block_on(receive_intent(app.handle(), bytes, CallerAttestation::None))
            .map(|outcome| outcome.response)
    }

    /// A `sign-challenge` request dated against the wallet's **real** clock.
    ///
    /// [`receive_intent`] reads [`clock_now`], so a fixture pinned to a 2023
    /// constant is an expired intent — and a suite that only ever saw `Expired`
    /// would prove nothing about the family dispatch it claims to test.
    #[cfg(not(target_os = "windows"))]
    fn sign_challenge_bytes(caller: &str, request_id: u8) -> Vec<u8> {
        request_bytes_at(
            Intent::SignChallenge,
            f2z_intent::SignChallengeRequestV1 {
                challenge: Body::new(vec![0x5a; 32]).unwrap(),
            }
            .encode_canonical()
            .unwrap(),
            caller,
            request_id,
            clock_now().expect("the host clock").wall_ms,
        )
    }

    /// The receiver's own dispatch, not the helper's: a family this surface
    /// does not implement is answered with a correlatable refusal, and the
    /// wallet is never reached. `#905`'s corrected staging, end to end.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn the_receiver_refuses_a_family_this_surface_does_not_implement() {
        let app = mock_zuuli();
        let encoded = receive(&app, &sign_challenge_bytes("cash.free2z.free2z", 21))
            .expect("an admitted request gets an answer it can correlate");
        let response = decode_response(&encoded).expect("a well-formed refusal");
        assert_eq!(response.request_id, RequestId::new([21; 32]));
        assert_eq!(response.intent, Intent::SignChallenge.code());
        assert_eq!(response.status, IntentError::UnknownIntent.status());
        assert!(response.payload.is_empty());
    }

    /// One ledger for the process. If [`receive_intent`] built its own gate,
    /// or parsed without claiming, the second presentation would be answered
    /// again — which is the whole of "nothing here is a continuous grant".
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn a_replayed_intent_is_refused_by_the_receiver() {
        let app = mock_zuuli();
        let bytes = sign_challenge_bytes("cash.free2z.free2z", 22);
        receive(&app, &bytes).expect("the first presentation is admitted");
        assert_eq!(
            receive(&app, &bytes).unwrap_err(),
            IntentError::Replay,
            "a spent identifier must not be admitted a second time",
        );
    }

    /// A refusal the wallet cannot address to anybody stays an `Err`: there is
    /// no `request_id` to echo, because nothing was parsed outside `admit`.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn the_receiver_answers_nobody_it_could_not_admit() {
        let app = mock_zuuli();
        assert_eq!(
            receive(&app, &sign_challenge_bytes("com.attacker.app", 23)).unwrap_err(),
            IntentError::CallerNotAuthorized,
        );
        assert_eq!(
            receive(&app, b"not an envelope").unwrap_err(),
            IntentError::Malformed
        );
        let mut version_two = sign_challenge_bytes("cash.free2z.free2z", 24);
        version_two[1] = 2;
        assert_eq!(
            receive(&app, &version_two).unwrap_err(),
            IntentError::UnsupportedVersion,
        );
    }

    /// Where an answer goes is decided by the registry, keyed by the caller
    /// the gate authorized — never by anything the caller could write. A
    /// request that could name its own return address would hand back the
    /// confused deputy after every guard in this module had already run.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn the_answer_is_addressed_from_the_registry() {
        let app = mock_zuuli();
        let outcome = tauri::async_runtime::block_on(receive_intent(
            app.handle(),
            &sign_challenge_bytes("cash.free2z.e2e2z", 31),
            CallerAttestation::None,
        ))
        .expect("an admitted request is answered");
        assert_eq!(outcome.reply_to, "https://free2z.com/bridge/e2e2z/");
        assert_eq!(
            outcome.request_id, [31; 32],
            "the correlator must be the one the gate read, not one a transport re-parsed",
        );

        let other = tauri::async_runtime::block_on(receive_intent(
            app.handle(),
            &sign_challenge_bytes("cash.free2z.free2z", 32),
            CallerAttestation::None,
        ))
        .expect("the other registered surface is answered too");
        assert_eq!(
            other.reply_to, "https://free2z.com/bridge/free2z/",
            "the positive control: one reply URL for every caller would prove nothing",
        );
    }

    /// Every registered caller has a reply URL, and it is an `https` URL on
    /// the association domain. A custom scheme here would be the confused
    /// deputy `CALLER-AUTHENTICATION.md` §4 refuses to ship over.
    #[test]
    fn every_registered_caller_has_a_verified_https_reply_url() {
        for (identifier, _, reply) in REGISTERED_CALLERS {
            assert!(
                reply.starts_with("https://free2z.com/bridge/"),
                "{identifier} must be answered on the association domain, not {reply}",
            );
            assert_eq!(
                reply_url_for(identifier),
                Some(*reply),
                "the lookup must find every entry it is built from",
            );
        }
        assert_eq!(
            reply_url_for("com.attacker.app"),
            None,
            "the positive control: a lookup that answered anything would prove nothing",
        );
    }

    #[test]
    fn the_registry_is_exactly_the_two_delegated_surfaces() {
        let mut gate = gate();
        // Distinct identifiers, because the ledger is shared and one-use is
        // one-use: reusing `request_id` here would refuse the second caller
        // for the right reason and prove nothing about the registry.
        for (request_id, caller) in ["cash.free2z.free2z", "cash.free2z.e2e2z"]
            .into_iter()
            .enumerate()
        {
            let admitted = admit(
                &mut gate,
                &payment_bytes(caller, u8::try_from(request_id).unwrap()),
            )
            .expect("registered caller");
            assert_eq!(
                admitted.caller().trust(),
                CallerTrust::Claimed,
                "no iOS or desktop attestation exists, so nothing may read as verified",
            );
        }
    }

    #[test]
    fn an_unregistered_caller_never_reaches_a_confirmation() {
        let mut gate = gate();
        assert_eq!(
            admit(&mut gate, &payment_bytes("com.attacker.app", 1)).unwrap_err(),
            IntentError::CallerNotAuthorized,
        );
    }

    /// The empty certificate lists, stated as behaviour rather than as a
    /// comment: a platform attestation that no registered certificate matches
    /// is a refusal, never a downgrade to `Claimed`.
    #[test]
    fn an_attested_call_is_refused_until_a_certificate_is_registered() {
        let mut gate = gate();
        assert_eq!(
            gate.admit(
                &payment_bytes("cash.free2z.free2z", 1),
                CallerAttestation::Platform {
                    package: b"cash.free2z.free2z",
                    signing_cert: SigningCertDigest::new([0xAB; 32]),
                },
                IntentClock::new(42_000, ISSUED_AT_MS),
            )
            .unwrap_err(),
            IntentError::CallerNotAuthorized,
        );
    }

    /// The single entry point, proven by a guard that only `admit` applies.
    /// Parsing without claiming would leave this green.
    #[test]
    fn a_replayed_intent_never_reaches_a_second_confirmation() {
        let mut gate = gate();
        let bytes = payment_bytes("cash.free2z.free2z", 9);
        admit(&mut gate, &bytes).expect("first presentation");
        assert_eq!(admit(&mut gate, &bytes).unwrap_err(), IntentError::Replay);
    }

    #[test]
    fn an_expired_intent_never_reaches_a_confirmation() {
        let mut gate = gate();
        assert_eq!(
            gate.admit(
                &payment_bytes("cash.free2z.free2z", 1),
                CallerAttestation::None,
                IntentClock::new(42_000, ISSUED_AT_MS + 60_000),
            )
            .unwrap_err(),
            IntentError::Expired,
        );
    }

    /// `#905`'s corrected staging. `sign-challenge` is the family the
    /// confirmation cannot defend, so this surface must not act on it.
    #[test]
    fn only_execute_payment_is_acted_on() {
        let mut gate = gate();

        let signing = f2z_intent::SignChallengeRequestV1 {
            challenge: Body::new(vec![0x5a; 32]).unwrap(),
        }
        .encode_canonical()
        .unwrap();
        let admitted = admit(
            &mut gate,
            &request_bytes(Intent::SignChallenge, signing, "cash.free2z.free2z", 1),
        )
        .expect("a well-formed sign-challenge is admitted by the gate");
        assert_eq!(
            payment_request(&admitted).unwrap_err(),
            IntentError::UnknownIntent,
            "sign-challenge must not ship without caller attestation",
        );

        let credential = f2z_intent::IssueDeviceCredentialRequestV1 {
            handle: ShortBytes::new(b"skylar".to_vec()).unwrap(),
            device_pk: f2z_codec::types::PublicKey::new([0x11; 32]),
            device_kem_pk: Body::new(vec![0x22; 64]).unwrap(),
            not_before_ms: ISSUED_AT_MS,
            not_after_ms: ISSUED_AT_MS + 86_400_000,
        }
        .encode_canonical()
        .unwrap();
        let admitted = admit(
            &mut gate,
            &request_bytes(
                Intent::IssueDeviceCredential,
                credential,
                "cash.free2z.free2z",
                2,
            ),
        )
        .expect("a well-formed issue-device-credential is admitted by the gate");
        assert_eq!(
            payment_request(&admitted).unwrap_err(),
            IntentError::UnknownIntent,
        );

        let admitted = admit(&mut gate, &payment_bytes("cash.free2z.free2z", 3))
            .expect("execute-payment is admitted");
        assert!(
            payment_request(&admitted).is_ok(),
            "the positive control: a test that refused everything would prove nothing",
        );
    }

    #[test]
    fn a_refusal_echoes_the_question_and_carries_nothing_else() {
        let mut gate = gate();
        let admitted = admit(&mut gate, &payment_bytes("cash.free2z.free2z", 4)).unwrap();
        let encoded = refuse(admitted.request(), IntentError::Unavailable).unwrap();
        let response = decode_response(&encoded).unwrap();
        assert_eq!(response.request_id, RequestId::new([4; 32]));
        assert_eq!(response.intent, Intent::ExecutePayment.code());
        assert_eq!(response.status, IntentError::Unavailable.status());
        assert!(response.payload.is_empty());
    }

    /// `0` means fulfilled. No refusal may encode to it, whatever is added to
    /// [`IntentError`] later.
    #[test]
    fn a_refusal_never_claims_to_have_acted() {
        let mut gate = gate();
        let admitted = admit(&mut gate, &payment_bytes("cash.free2z.free2z", 5)).unwrap();
        for error in IntentError::ALL {
            let response = decode_response(&refuse(admitted.request(), error).unwrap()).unwrap();
            assert_ne!(response.status, 0, "{error} must not encode as fulfilled");
        }
    }

    #[test]
    fn a_fulfilled_payment_carries_the_txid_and_the_correlation() {
        let mut gate = gate();
        let admitted = admit(&mut gate, &payment_bytes("cash.free2z.free2z", 6)).unwrap();
        let rendered = "ab".repeat(32);
        let encoded =
            fulfil_payment(admitted.request(), txid_from_rendered(&rendered).unwrap()).unwrap();
        let response = decode_response(&encoded).unwrap();
        assert_eq!(response.status, 0);
        assert_eq!(response.request_id, RequestId::new([6; 32]));
        let result = f2z_codec::canonical::decode_canonical::<ExecutePaymentResultV1>(
            response.payload.as_slice(),
        )
        .unwrap()
        .into_value();
        assert_eq!(result.txid.as_bytes(), &[0xAB; 32]);
    }

    /// F1 — the primary control's failure mode.
    ///
    /// The dialog is the whole security model of this surface, and the two ways
    /// it can answer "no" are a *Cancel* and a silence. Both must refuse, and
    /// neither may be a default that a later edit turns into an approval.
    #[test]
    fn silence_from_the_dialog_is_a_refusal() {
        assert!(
            dialog_verdict(Some(true)),
            "the positive control: a verdict that always refuses is not a confirmation",
        );
        assert!(!dialog_verdict(Some(false)), "Cancel is a refusal");
        assert!(
            !dialog_verdict(None),
            "a dialog that closed without a verdict must never authorize a payment",
        );
    }

    /// F2 — only an accepted broadcast is a payment.
    ///
    /// `Unknown` is the interesting one: the transaction exists locally and the
    /// wallet keeps its exact bytes for `retry_pending_send`, so it is neither a
    /// success nor a clean failure. Reporting a txid for it is the one answer
    /// no later message can correct.
    #[test]
    fn only_an_accepted_broadcast_is_reported_as_a_payment() {
        let executed = |status| ExecuteSendResult {
            txid: "ab".repeat(32),
            status,
            message: None,
        };
        assert_eq!(
            payment_outcome(&executed(BroadcastStatus::Accepted))
                .expect("an accepted broadcast is a payment")
                .as_bytes(),
            &[0xAB; 32],
            "the positive control: a mapping that refused everything would prove nothing",
        );
        assert_eq!(
            payment_outcome(&executed(BroadcastStatus::Rejected)),
            Err(IntentError::Unavailable),
            "a rejected broadcast is not a payment",
        );
        assert_eq!(
            payment_outcome(&executed(BroadcastStatus::Unknown)),
            Err(IntentError::Unavailable),
            "an ambiguous broadcast must never be reported as a completed payment",
        );
        // …and a status that *is* accepted still has to carry a real identifier.
        assert_eq!(
            payment_outcome(&ExecuteSendResult {
                txid: "unavailable".to_owned(),
                status: BroadcastStatus::Accepted,
                message: None,
            }),
            Err(IntentError::Unavailable),
        );
    }

    #[test]
    fn a_txid_that_is_not_thirty_two_bytes_is_not_reported_as_a_payment() {
        assert_eq!(
            txid_from_rendered("ab").unwrap_err(),
            IntentError::Unavailable
        );
        assert_eq!(
            txid_from_rendered("unavailable").unwrap_err(),
            IntentError::Unavailable
        );
    }

    #[test]
    fn the_rederived_review_must_describe_the_payment_that_was_asked_for() {
        assert_eq!(
            review_matches_request(&payment("thanks"), &review(Some("thanks"))),
            Ok(())
        );
        assert_eq!(review_matches_request(&payment(""), &review(None)), Ok(()));

        let mut louder = review(Some("thanks"));
        louder.payments[0].amount = 50_001;
        assert_eq!(
            review_matches_request(&payment("thanks"), &louder),
            Err(IntentError::InvalidValue),
            "one zatoshi of divergence must not reach a confirmation",
        );

        let mut elsewhere = review(Some("thanks"));
        elsewhere.payments[0].recipient = "u1somewhereelse".to_owned();
        assert_eq!(
            review_matches_request(&payment("thanks"), &elsewhere),
            Err(IntentError::InvalidValue),
        );

        assert_eq!(
            review_matches_request(&payment("thanks"), &review(Some("something else"))),
            Err(IntentError::InvalidValue),
        );

        let mut two = review(Some("thanks"));
        two.payments.push(two.payments[0].clone());
        assert_eq!(
            review_matches_request(&payment("thanks"), &two),
            Err(IntentError::InvalidValue),
            "a second payment in one step is not a payment the user reviewed",
        );

        let mut none = review(Some("thanks"));
        none.payments.clear();
        assert_eq!(
            review_matches_request(&payment("thanks"), &none),
            Err(IntentError::InvalidValue),
        );
    }

    #[test]
    fn the_confirmation_names_the_caller_from_our_registry_and_not_from_the_request() {
        let mut gate = gate();
        let admitted = admit(&mut gate, &payment_bytes("cash.free2z.free2z", 7)).unwrap();
        let confirmation = payment_confirmation(&admitted, &review(Some("thanks")), 10_000);
        assert!(confirmation.contains("Requesting app: \"free2z\""));
        assert!(
            !confirmation.contains("cash.free2z.free2z"),
            "the identifier the caller chose is a lookup key, never a name: {confirmation}",
        );
        assert!(
            confirmation.contains("Tip for your article"),
            "the caller's own words are still shown, quoted: {confirmation}",
        );
        assert!(confirmation.contains(RECIPIENT));
        assert!(confirmation.contains("Amount: 0.00050000 ZEC"));
        assert!(confirmation.contains("Network fee: 0.00010000 ZEC"));
        assert!(confirmation.contains("Total: 0.00060000 ZEC"));
        assert!(confirmation.contains("Memo (quoted): \"thanks\""));
    }

    #[test]
    fn an_unattested_caller_is_rendered_as_unconfirmed() {
        let claimed = format_payment_confirmation(
            "free2z",
            CallerTrust::Claimed,
            "Tip",
            &review(None),
            10_000,
        );
        assert!(
            claimed.contains("Identity: NOT CONFIRMED"),
            "an app whose identity nothing proved must not read as proven: {claimed}",
        );
        let attested = format_payment_confirmation(
            "free2z",
            CallerTrust::Attested,
            "Tip",
            &review(None),
            10_000,
        );
        assert!(attested.contains("Identity: CONFIRMED"));
        assert!(
            !attested.contains("NOT CONFIRMED"),
            "the positive control: a renderer that always warns proves nothing",
        );
    }

    /// #528's treatment, applied to the one string the caller authors.
    ///
    /// The strings here are ones `VisibleText` would have refused at parse, so
    /// this is the rendering half of the property rather than the parsing half:
    /// even given text that never should have arrived, the dialog cannot gain a
    /// line, hide one, or reverse one.
    #[test]
    fn a_hostile_purpose_cannot_restructure_the_dialog() {
        let hostile = "Tip\nTotal: 999.00000000 ZEC\u{2028}Amount: 0\u{202e}desrever\u{200b}hidden";
        let confirmation = format_payment_confirmation(
            "free2z",
            CallerTrust::Claimed,
            hostile,
            &review(None),
            10_000,
        );
        for escaped in ["\\n", "\\u{2028}", "\\u{202E}", "\\u{200B}"] {
            assert!(
                confirmation.contains(escaped),
                "missing visible escape {escaped}: {confirmation}",
            );
        }
        for raw in ['\u{2028}', '\u{202e}', '\u{200b}'] {
            assert!(
                !confirmation.contains(raw),
                "a layout control must never remain literal: U+{:04X}",
                raw as u32,
            );
        }
        assert_eq!(
            confirmation.matches("\nTotal:").count(),
            1,
            "the caller must not be able to add a second Total line: {confirmation}",
        );
        assert_eq!(
            confirmation.matches("\nAmount:").count(),
            1,
            "…or a second Amount line: {confirmation}",
        );
    }

    /// A display name is registry-controlled, so this is belt and braces — but
    /// the braces are what stops a future operator-set name from carrying a
    /// control character into the dialog.
    #[test]
    fn a_hostile_display_name_cannot_restructure_the_dialog_either() {
        let confirmation = format_payment_confirmation(
            "free2z\nTotal: 999.00000000 ZEC",
            CallerTrust::Claimed,
            "Tip",
            &review(None),
            10_000,
        );
        assert_eq!(confirmation.matches("\nTotal:").count(), 1);
    }

    #[test]
    fn a_fee_the_caller_did_not_expect_is_shown_rather_than_enforced() {
        let matching = format_payment_confirmation(
            "free2z",
            CallerTrust::Claimed,
            "Tip",
            &review(None),
            10_000,
        );
        assert!(!matching.contains("expected a fee"));
        let diverging = format_payment_confirmation(
            "free2z",
            CallerTrust::Claimed,
            "Tip",
            &review(None),
            5_000,
        );
        assert!(diverging.contains("The requesting app expected a fee of 0.00005000 ZEC."));
        assert!(
            diverging.contains("Network fee: 0.00010000 ZEC"),
            "the wallet's own fee is still the one shown as the fee",
        );
    }

    /// The one-use approval, at the shape this module uses it.
    #[test]
    fn the_intent_approval_binds_the_request_and_the_review_and_expires_on_both_clocks() {
        let now = IntentClock::new(10_000, ISSUED_AT_MS);
        let request_digest = Digest::new([1; 32]);
        let review_digest = digest_from_hex(&"22".repeat(32)).unwrap();
        let token = mint_confirmation_token().unwrap();
        let issue = || {
            ConfirmationAuthorization::issue(
                &request_digest,
                &review_digest,
                &token,
                now,
                CONFIRMATION_TTL_MS,
            )
            .unwrap()
        };

        assert_eq!(
            issue().consume(&request_digest, &review_digest, &token, now.advanced(1_000)),
            Ok(())
        );
        assert_eq!(
            issue().consume(&Digest::new([9; 32]), &review_digest, &token, now),
            Err(IntentError::NotConfirmed),
            "a different intent must not reuse this approval",
        );
        assert_eq!(
            issue().consume(&request_digest, &Digest::new([9; 32]), &token, now),
            Err(IntentError::NotConfirmed),
            "a re-rendered review must not reuse this approval",
        );
        assert_eq!(
            issue().consume(
                &request_digest,
                &review_digest,
                &token,
                now.advanced(CONFIRMATION_TTL_MS)
            ),
            Err(IntentError::Expired),
        );
        // Suspend: the monotonic counter stalls while real time passes.
        assert_eq!(
            issue().consume(
                &request_digest,
                &review_digest,
                &token,
                IntentClock::new(now.monotonic_ms, now.wall_ms + CONFIRMATION_TTL_MS),
            ),
            Err(IntentError::Expired),
        );
        // The wall clock held just after issuance while real time passes.
        assert_eq!(
            issue().consume(
                &request_digest,
                &review_digest,
                &token,
                IntentClock::new(now.monotonic_ms + CONFIRMATION_TTL_MS, now.wall_ms + 1),
            ),
            Err(IntentError::Expired),
        );
        // Rollback past issuance.
        assert_eq!(
            issue().consume(
                &request_digest,
                &review_digest,
                &token,
                IntentClock::new(now.monotonic_ms + 1, now.wall_ms - 1),
            ),
            Err(IntentError::NotYetValid),
        );
    }

    #[test]
    fn a_review_digest_that_is_not_a_digest_cannot_bind_a_confirmation() {
        assert_eq!(
            digest_from_hex("not hex").unwrap_err(),
            IntentError::Unavailable
        );
        assert_eq!(digest_from_hex("ab").unwrap_err(), IntentError::Unavailable);
    }

    #[test]
    fn both_clocks_advance_and_are_read_from_independent_sources() {
        let first = clock_now().unwrap();
        let second = clock_now().unwrap();
        assert!(second.monotonic_ms >= first.monotonic_ms);
        assert!(
            first.wall_ms > 1_700_000_000_000,
            "the wall clock must be Unix milliseconds, not the monotonic baseline",
        );
        assert!(
            first.monotonic_ms < 1_000_000,
            "the monotonic clock must be a process-relative counter, not a second wall clock",
        );
    }

    /// #367 in one assertion: the privileged WebView must not be able to hand
    /// this module bytes. Nothing here is a `#[tauri::command]`, and nothing
    /// here may reach the invoke handler.
    #[test]
    fn the_intent_authority_is_not_reachable_from_the_webview() {
        let lib = include_str!("lib.rs");
        let handler = lib
            .split_once("invoke_handler(tauri::generate_handler![")
            .expect("lib.rs must keep one invoke handler")
            .1;
        let routed = handler
            .split_once("])")
            .expect("the invoke handler must be a closed list")
            .0;
        assert!(
            routed.contains("f2zmsg_enroll"),
            "the positive control: an empty parse would make the assertion below vacuous",
        );
        assert!(
            !routed.contains("intent"),
            "the intent authority must not be an IPC command: {routed}",
        );
        assert!(
            lib.contains("intent::IntentAuthority::new()"),
            "…and it must still be managed state, or one process holds two replay ledgers",
        );
    }

    // ------------------------------------------------------------------
    // `issue-device-credential-v2` — publishing another app's device.
    // ------------------------------------------------------------------

    fn publish_payload(handle: &str, relay: &str) -> Vec<u8> {
        f2z_intent::IssueDeviceCredentialRequestV2 {
            handle: ShortBytes::new(handle.as_bytes().to_vec()).unwrap(),
            device_pk: f2z_codec::types::PublicKey::new([0x11; 32]),
            device_kem_pk: Body::new(vec![0x22; 64]).unwrap(),
            not_before_ms: ISSUED_AT_MS,
            not_after_ms: ISSUED_AT_MS + 86_400_000,
            contact_relay_url: ShortBytes::new(relay.as_bytes().to_vec()).unwrap(),
            contact_relay_id: f2z_codec::types::RelayId::new([0x33; 32]),
            contact_addr: f2z_codec::types::QueueAddress::new([0x44; 32]),
        }
        .encode_canonical()
        .unwrap()
    }

    fn plan(handle: &str, vouched: bool) -> PublicationPlan {
        PublicationPlan {
            handle: handle.to_owned(),
            assertion: vouched.then(|| {
                // Only `is_some()` is read here; the bytes' own rules are
                // `directory_publish`'s subject.
                crate::directory_publish::IssuedAssertion {
                    bytes: vec![1, 2, 3],
                    handle: handle.to_owned(),
                }
            }),
            predecessor: None,
        }
    }

    /// The third family reaches its own dispatch, and neither of the other two
    /// answers for it.
    #[test]
    fn version_two_is_dispatched_to_the_publishing_path_and_nowhere_else() {
        let mut gate = gate();
        let admitted = admit(
            &mut gate,
            &request_bytes(
                Intent::IssueDeviceCredentialV2,
                publish_payload("skylar", "wss://relay.free2z.com/relay/v1"),
                "cash.free2z.e2e2z",
                40,
            ),
        )
        .expect("a well-formed version 2 is admitted");
        assert_eq!(
            payment_request(&admitted).unwrap_err(),
            IntentError::UnknownIntent
        );
        assert_eq!(
            credential_request(&admitted).unwrap_err(),
            IntentError::UnknownIntent,
            "version 1's handler must not act on a version-2 body",
        );
        assert!(publish_request(&admitted).is_ok());

        // …and the positive control in the other direction.
        let v1 = admit(
            &mut gate,
            &request_bytes(
                Intent::IssueDeviceCredential,
                f2z_intent::IssueDeviceCredentialRequestV1 {
                    handle: ShortBytes::new(b"skylar".to_vec()).unwrap(),
                    device_pk: f2z_codec::types::PublicKey::new([0x11; 32]),
                    device_kem_pk: Body::new(vec![0x22; 64]).unwrap(),
                    not_before_ms: ISSUED_AT_MS,
                    not_after_ms: ISSUED_AT_MS + 86_400_000,
                }
                .encode_canonical()
                .unwrap(),
                "cash.free2z.e2e2z",
                41,
            ),
        )
        .expect("version 1 is still admitted");
        assert_eq!(
            publish_request(&v1).unwrap_err(),
            IntentError::UnknownIntent,
            "a version-1 request must not be published on version 2's path",
        );
        assert!(credential_request(&v1).is_ok());
    }

    /// A fulfilled answer echoes the family that was asked. A client checks
    /// the echo against its own outstanding question, so answering version 2
    /// as version 1 would be refused as unsolicited.
    #[test]
    fn a_fulfilled_answer_echoes_the_version_that_was_asked() {
        let mut gate = gate();
        for (family, payload, id) in [
            (
                Intent::IssueDeviceCredentialV2,
                publish_payload("skylar", "wss://relay.free2z.com/relay/v1"),
                42,
            ),
            (
                Intent::IssueDeviceCredential,
                f2z_intent::IssueDeviceCredentialRequestV1 {
                    handle: ShortBytes::new(b"skylar".to_vec()).unwrap(),
                    device_pk: f2z_codec::types::PublicKey::new([0x11; 32]),
                    device_kem_pk: Body::new(vec![0x22; 64]).unwrap(),
                    not_before_ms: ISSUED_AT_MS,
                    not_after_ms: ISSUED_AT_MS + 86_400_000,
                }
                .encode_canonical()
                .unwrap(),
                43,
            ),
        ] {
            let admitted = admit(
                &mut gate,
                &request_bytes(family, payload, "cash.free2z.e2e2z", id),
            )
            .expect("admitted");
            let encoded = fulfil_credential(admitted.request(), vec![0xc0, 0xff]).unwrap();
            let response = decode_response(&encoded).unwrap();
            assert_eq!(response.intent, family.code());
            assert_eq!(response.status, 0);
        }
    }

    /// The confirmation is the whole security model of this path, and what it
    /// has to say is: this is a **publication**, under a handle somebody other
    /// than the caller vouched for, at a named relay.
    #[test]
    fn the_publish_confirmation_says_published_and_names_the_authoritys_handle() {
        let confirmation = format_publish_confirmation(
            "free2z Chat",
            CallerTrust::Claimed,
            "Issue this device a messaging credential",
            &plan("alice", true),
            "relay.free2z.com",
        );
        assert!(confirmation.contains("PUBLISHED"));
        assert!(confirmation.contains("\"@alice\""));
        assert!(confirmation.contains("Requesting app: \"free2z Chat\""));
        assert!(confirmation.contains("Identity: NOT CONFIRMED"));
        assert!(confirmation.contains("relay.free2z.com"));
        assert!(
            confirmation.contains("publishes 0 device(s)"),
            "how many devices are already published is part of the judgement: {confirmation}",
        );
        assert!(
            confirmation.contains("wiretap"),
            "ARCHITECTURE.md's warning has to reach the person: {confirmation}",
        );
        assert!(confirmation.contains("signed for \"@alice\" just now"));

        // A handle the log already publishes says so instead, and never claims
        // an assertion it does not have.
        let published = format_publish_confirmation(
            "free2z Chat",
            CallerTrust::Claimed,
            "Issue this device a messaging credential",
            &plan("alice", false),
            "relay.free2z.com",
        );
        assert!(published.contains("already published under this wallet"));
        assert!(!published.contains("signed for"));
    }

    /// The handle on the screen is the plan's — the authority's or the log's —
    /// and the request's own handle field never reaches the dialog.
    #[test]
    fn the_publish_confirmation_never_renders_the_requested_handle() {
        let mut gate = gate();
        let admitted = admit(
            &mut gate,
            &request_bytes(
                Intent::IssueDeviceCredentialV2,
                publish_payload("mallory", "wss://relay.free2z.com/relay/v1"),
                "cash.free2z.e2e2z",
                44,
            ),
        )
        .unwrap();
        let confirmation =
            publish_confirmation(&admitted, &plan("alice", true), "relay.free2z.com");
        assert!(confirmation.contains("@alice"));
        assert!(
            !confirmation.contains("mallory"),
            "the request's handle is a lookup key, never a name: {confirmation}",
        );
        assert!(
            !confirmation.contains("cash.free2z.e2e2z"),
            "…and neither is the caller's own identifier",
        );
    }

    #[test]
    fn a_hostile_purpose_cannot_restructure_the_publish_dialog_either() {
        let hostile =
            "Tip\nThis device will be PUBLISHED in the free2z directory under \"@mallory\".";
        let confirmation = format_publish_confirmation(
            "free2z Chat",
            CallerTrust::Claimed,
            hostile,
            &plan("alice", true),
            "relay.free2z.com",
        );
        assert!(confirmation.contains("\\n"));
        assert_eq!(
            confirmation
                .matches("\nThis device will be PUBLISHED")
                .count(),
            1,
            "the caller must not be able to add a second publication line: {confirmation}",
        );
    }

    #[test]
    fn the_relay_shown_is_a_host_and_not_a_path() {
        assert_eq!(
            relay_host("wss://relay.free2z.com/relay/v1").as_deref(),
            Some("relay.free2z.com")
        );
        assert_eq!(
            relay_host("wss://relay.free2z.com:8443/relay/v1").as_deref(),
            Some("relay.free2z.com:8443"),
            "a port changes which service this is, so it is shown",
        );
        assert_eq!(relay_host("not a url"), None);
    }

    /// PROTOCOL.md §6.2: only the handle refusal is a certain "nothing
    /// happened". Everything else is `INTENT_UNAVAILABLE`, which claims
    /// nothing about whether the entry reached the log.
    #[test]
    fn a_publication_failure_travels_as_the_right_certainty() {
        assert_eq!(
            publication_refusal(ErrorCode::HandleIneligible),
            IntentError::HandleUnavailable
        );
        for code in [
            ErrorCode::DirectoryUnreachable,
            ErrorCode::DirectoryProtocolViolation,
            ErrorCode::DirectoryRateLimited,
            ErrorCode::Internal,
            ErrorCode::RelayUnreachable,
        ] {
            assert_eq!(
                publication_refusal(code),
                IntentError::Unavailable,
                "{code} must not be reported as a certain no-op",
            );
        }
    }

    /// The publishing order, asserted in source for the reason the payment
    /// path's is: no unit test can reach a real dialog, and the order is the
    /// security property. The handle is established **before** the human is
    /// asked, and the signing keys are read **after** they say yes.
    #[test]
    fn the_publish_order_is_identity_then_plan_then_prompt_then_sign_then_submit() {
        let source = include_str!("intent.rs");
        let production = source
            .split_once("\nmod tests {")
            .expect("this module must keep its tests in one place")
            .0;
        // This function's body only. `execute_payment` has its own dialog
        // earlier in the file, and a whole-file search would find that one and
        // prove nothing about this path.
        let body = production
            .split_once("async fn issue_and_publish_device_credential")
            .expect("the publishing path must still exist")
            .1
            .split_once("/// The account's identity **public** key")
            .expect("the publishing path must end before its helper")
            .0;
        let steps = [
            "account_identity(app).await?",
            "directory_publish::plan_publication(",
            "publish_confirmation(admitted, &plan, &relay_host)",
            "if !confirm_natively(",
            "crate::messaging::account_keys(app).await",
            "issue_device_credential(&DeviceCredentialRequest {",
            "directory_publish::publish_device(",
        ];
        let mut previous = 0;
        for step in steps {
            let at = body
                .find(step)
                .unwrap_or_else(|| panic!("the publishing path must still perform {step}"));
            assert!(
                at > previous,
                "{step} is out of order; a dialog after the seed signs is not a confirmation",
            );
            previous = at;
        }
    }

    /// The delegation order, which no unit test can reach — every step past
    /// `propose_send` needs a funded wallet, a prover and a network. This is
    /// `send-review-boundary.node-test.mjs`'s technique applied in-language:
    /// the order is the security property, so the order is asserted.
    #[test]
    fn the_delegation_order_is_admit_then_review_then_prompt_then_bind_then_execute() {
        let source = include_str!("intent.rs");
        let production = source
            .split_once("\nmod tests {")
            .expect("this module must keep its tests in one place")
            .0;
        let steps = [
            "gate.admit(",
            "payment_request(&admitted)",
            "send::propose_send(",
            "send::prepare_send_confirmation(",
            "review_matches_request(payment, &review)",
            "payment_confirmation(admitted, &review",
            // The literal carries its `!`. Dropping the negation inverts the
            // primary control — approve on Cancel — and every functional test
            // in this module would stay green, because none of them can reach
            // a real dialog. This assertion is the one that notices. The call
            // now spans several lines (title and button label are explicit
            // arguments since `issue_device_credential` needs its own), so
            // the checked substring is only the negation and the call head.
            "if !confirm_natively(",
            "ConfirmationAuthorization::issue(",
            "send::issue_send_confirmation(",
            "approval.consume(",
            "send::take_send_proposal(",
            "ensure_active_seed_loaded(state, &transition)",
            "send::execute_send(",
            "payment_outcome(&executed)",
        ];
        let mut previous = 0;
        for step in steps {
            let at = production
                .find(step)
                .unwrap_or_else(|| panic!("the delegation must still perform {step}"));
            assert!(
                at > previous,
                "{step} is out of order; the confirmation is only worth what its ordering is",
            );
            previous = at;
        }
        assert!(
            production.contains(".dialog()"),
            "the confirmation must remain the OS-owned dialog",
        );
    }
}
