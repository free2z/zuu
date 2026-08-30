//! The IPC surface — `CLIENT-CONTRACT.md` §3, one function per row.
//!
//! Every engine-dependent command here is the same four lines: take
//! `AppHandle`, take the deserialized `args`, call exactly one
//! [`crate::engine::Engine`] method, and return. Pure
//! `check_handle_eligibility` is the deliberate exception: it takes only its
//! string input and routes to [`crate::handle::eligibility`]. No policy logic
//! lives in this file — it is the layer the webview can reach, and the less it
//! decides the less there is to get wrong at the boundary.
//!
//! Two conventions, both of which the frontend already depends on:
//!
//! * **Every payload is nested under a single `args` key**, and every field is
//!   `camelCase` on both sides. `bridge.ts` sends
//!   `invoke("plugin:f2zmsg|send_message", { args: { … } })`, so the second
//!   parameter of each function below is named `args` and nothing else.
//! * **Commands with no arguments take no `args` key at all**, so they have no
//!   second parameter.
//!
//! # `engine()` is a `Result`, and every engine-dependent command takes it with `?`
//!
//! The plugin's `setup` can finish without an engine: a durable store that will
//! not open must make messaging unavailable, not the wallet (#753). The managed
//! state is registered either way — it has to be, because
//! [`crate::state::F2zMsgExt::f2zmsg`] panics on an unmanaged type — and
//! [`crate::state::F2zMsg::engine`] hands back the §8 code that stopped the
//! engine from being built. Returning that *by type* is what makes the refusal
//! total: there is no way to reach the engine that skips it, so a command that
//! compiles is a command that cannot panic in the faulted state.
//!
//! `get_engine_status` and the pure `check_handle_eligibility` validator are
//! the two exceptions: neither needs an engine, so both answer when store
//! startup faulted. Everything engine- or storage-dependent refuses.
//!
//! Enrollment is **not** here. `f2zmsg_enroll`, `f2zmsg_enrollment_status` and
//! `f2zmsg_unenroll` need the wallet seed, and putting them behind a plugin
//! would mean the mnemonic reaching the webview's JavaScript heap. They live in
//! `wallet/zuuli/src-tauri/src/messaging.rs` and are invoked with **no**
//! `plugin:` prefix (§2.2).

use tauri::{AppHandle, Runtime, command};

use crate::error::Result;
use crate::models::*;
use crate::state::F2zMsgExt as _;

// ---------------------------------------------------------------------------
// §3.1 — engine lifecycle
// ---------------------------------------------------------------------------

/// The one command that **answers** instead of refusing when the plugin has no
/// engine (#753).
///
/// A store that would not open leaves §6.1's `faulted` and the §8 code that
/// caused it, because a UI told only "internal" on every command has nothing to
/// render but an empty screen; told `faulted` with `lastError`, it can say that
/// messaging is unavailable and why. Every *other* command refuses with the
/// same code.
#[command]
pub(crate) async fn get_engine_status<R: Runtime>(app: AppHandle<R>) -> Result<EngineStatus> {
    let state = app.f2zmsg();
    match state.faulted_status() {
        Some(faulted) => Ok(faulted),
        None => state.engine()?.status().await,
    }
}

#[command]
pub(crate) async fn start_engine<R: Runtime>(app: AppHandle<R>) -> Result<EngineStatus> {
    app.f2zmsg().engine()?.start().await
}

#[command]
pub(crate) async fn stop_engine<R: Runtime>(app: AppHandle<R>) -> Result<EngineStatus> {
    app.f2zmsg().engine()?.stop().await
}

#[command]
pub(crate) async fn get_device_info<R: Runtime>(app: AppHandle<R>) -> Result<DeviceInfo> {
    app.f2zmsg().engine()?.device_info().await
}

// ---------------------------------------------------------------------------
// §3.3 — conversations and first contact
// ---------------------------------------------------------------------------

#[command]
pub(crate) async fn list_conversations<R: Runtime>(
    app: AppHandle<R>,
    args: ListConversationsArgs,
) -> Result<ConversationPage> {
    app.f2zmsg()
        .engine()?
        .list_conversations(args.limit, args.cursor)
        .await
}

#[command]
pub(crate) async fn get_conversation<R: Runtime>(
    app: AppHandle<R>,
    args: ConversationIdArgs,
) -> Result<Conversation> {
    app.f2zmsg()
        .engine()?
        .get_conversation(&args.conversation_id)
        .await
}

/// Runs the whole first-contact handshake, proof of work included. It can take
/// seconds and the delay is computation, not network — the UI shows it as work.
#[command]
pub(crate) async fn start_conversation<R: Runtime>(
    app: AppHandle<R>,
    args: HandleArgs,
) -> Result<Conversation> {
    app.f2zmsg()
        .engine()?
        .start_conversation(&args.handle)
        .await
}

#[command]
pub(crate) async fn list_contact_requests<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<ContactRequest>> {
    app.f2zmsg().engine()?.list_contact_requests().await
}

#[command]
pub(crate) async fn accept_contact_request<R: Runtime>(
    app: AppHandle<R>,
    args: RequestIdArgs,
) -> Result<Conversation> {
    app.f2zmsg()
        .engine()?
        .accept_contact_request(&args.request_id)
        .await
}

#[command]
pub(crate) async fn reject_contact_request<R: Runtime>(
    app: AppHandle<R>,
    args: RejectContactRequestArgs,
) -> Result<()> {
    app.f2zmsg()
        .engine()?
        .reject_contact_request(&args.request_id, args.block)
        .await
}

#[command]
pub(crate) async fn leave_conversation<R: Runtime>(
    app: AppHandle<R>,
    args: ConversationIdArgs,
) -> Result<()> {
    app.f2zmsg()
        .engine()?
        .leave_conversation(&args.conversation_id)
        .await
}

// ---------------------------------------------------------------------------
// §3.4 — sending and listing
// ---------------------------------------------------------------------------

#[command]
pub(crate) async fn send_message<R: Runtime>(
    app: AppHandle<R>,
    args: SendMessageArgs,
) -> Result<SendAccepted> {
    app.f2zmsg()
        .engine()?
        .send_message(&args.conversation_id, &args.body, &args.client_ref)
        .await
}

/// Safe after any failure, including one with an unknown outcome: a retried
/// `APPEND` produces a duplicate at the relay, and duplicates are removed end to
/// end by `msg_id`.
#[command]
pub(crate) async fn retry_send<R: Runtime>(
    app: AppHandle<R>,
    args: MsgIdArgs,
) -> Result<SendAccepted> {
    app.f2zmsg().engine()?.retry_send(&args.msg_id).await
}

#[command]
pub(crate) async fn cancel_send<R: Runtime>(app: AppHandle<R>, args: MsgIdArgs) -> Result<()> {
    app.f2zmsg().engine()?.cancel_send(&args.msg_id).await
}

#[command]
pub(crate) async fn list_messages<R: Runtime>(
    app: AppHandle<R>,
    args: ListMessagesArgs,
) -> Result<MessagePage> {
    app.f2zmsg()
        .engine()?
        .list_messages(&args.conversation_id, args.limit, args.before, args.after)
        .await
}

#[command]
pub(crate) async fn get_message<R: Runtime>(app: AppHandle<R>, args: MsgIdArgs) -> Result<Message> {
    app.f2zmsg().engine()?.get_message(&args.msg_id).await
}

// ---------------------------------------------------------------------------
// §3.6 — delivery state and receipts
// ---------------------------------------------------------------------------

#[command]
pub(crate) async fn get_delivery_state<R: Runtime>(
    app: AppHandle<R>,
    args: MsgIdArgs,
) -> Result<DeliveryStatus> {
    app.f2zmsg().engine()?.delivery_state(&args.msg_id).await
}

#[command]
pub(crate) async fn mark_read<R: Runtime>(app: AppHandle<R>, args: MarkReadArgs) -> Result<()> {
    app.f2zmsg()
        .engine()?
        .mark_read(&args.conversation_id, &args.up_to_msg_id)
        .await
}

#[command]
pub(crate) async fn get_receipt_policy<R: Runtime>(
    app: AppHandle<R>,
    args: ConversationIdArgs,
) -> Result<ReceiptPolicy> {
    app.f2zmsg()
        .engine()?
        .receipt_policy(&args.conversation_id)
        .await
}

#[command]
pub(crate) async fn set_receipt_policy<R: Runtime>(
    app: AppHandle<R>,
    args: SetReceiptPolicyArgs,
) -> Result<ReceiptPolicy> {
    app.f2zmsg()
        .engine()?
        .set_receipt_policy(
            &args.conversation_id,
            args.delivery_receipts,
            args.read_receipts,
        )
        .await
}

// ---------------------------------------------------------------------------
// §3.5 — gap detection and repair
// ---------------------------------------------------------------------------

#[command]
pub(crate) async fn list_gaps<R: Runtime>(
    app: AppHandle<R>,
    args: ConversationIdArgs,
) -> Result<Vec<Gap>> {
    app.f2zmsg()
        .engine()?
        .list_gaps(&args.conversation_id)
        .await
}

#[command]
pub(crate) async fn request_gap_repair<R: Runtime>(
    app: AppHandle<R>,
    args: RequestGapRepairArgs,
) -> Result<Vec<GapRepairStatus>> {
    app.f2zmsg()
        .engine()?
        .request_gap_repair(&args.conversation_id, &args.gap_ids)
        .await
}

// ---------------------------------------------------------------------------
// §3.7 — local retention
// ---------------------------------------------------------------------------

#[command]
pub(crate) async fn get_retention_policy<R: Runtime>(
    app: AppHandle<R>,
    args: GetRetentionPolicyArgs,
) -> Result<RetentionPolicy> {
    app.f2zmsg()
        .engine()?
        .retention_policy(args.conversation_id.as_deref())
        .await
}

#[command]
pub(crate) async fn set_retention_policy<R: Runtime>(
    app: AppHandle<R>,
    args: SetRetentionPolicyArgs,
) -> Result<RetentionPolicy> {
    app.f2zmsg()
        .engine()?
        .set_retention_policy(
            args.scope,
            args.mode,
            args.ttl_seconds,
            args.conversation_id.as_deref(),
        )
        .await
}

// ---------------------------------------------------------------------------
// §3.8 — ephemeral hints
// ---------------------------------------------------------------------------

#[command]
pub(crate) async fn send_ephemeral_hint<R: Runtime>(
    app: AppHandle<R>,
    args: SendEphemeralHintArgs,
) -> Result<EphemeralHintState> {
    app.f2zmsg()
        .engine()?
        .send_ephemeral_hint(&args.conversation_id, args.mode, args.ttl_seconds)
        .await
}

#[command]
pub(crate) async fn get_ephemeral_hint<R: Runtime>(
    app: AppHandle<R>,
    args: ConversationIdArgs,
) -> Result<Option<EphemeralHintState>> {
    app.f2zmsg()
        .engine()?
        .ephemeral_hint(&args.conversation_id)
        .await
}

// ---------------------------------------------------------------------------
// §3.9 — purge requests
// ---------------------------------------------------------------------------

#[command]
pub(crate) async fn send_purge_request<R: Runtime>(
    app: AppHandle<R>,
    args: SendPurgeRequestArgs,
) -> Result<PurgeRequestStatus> {
    app.f2zmsg()
        .engine()?
        .send_purge_request(&args.conversation_id, args.before_epoch)
        .await
}

#[command]
pub(crate) async fn list_purge_requests<R: Runtime>(
    app: AppHandle<R>,
    args: ConversationIdArgs,
) -> Result<Vec<PurgeRequestStatus>> {
    app.f2zmsg()
        .engine()?
        .list_purge_requests(&args.conversation_id)
        .await
}

// ---------------------------------------------------------------------------
// §3.10 — directory, safety numbers, self-audit and alarms
// ---------------------------------------------------------------------------

/// An unregistered handle is an **answer**, not a failure: this succeeds with
/// `found: false`, and there is no unknown-handle error code in either
/// direction.
#[command]
pub(crate) async fn resolve_handle<R: Runtime>(
    app: AppHandle<R>,
    args: HandleArgs,
) -> Result<DirectoryResolution> {
    app.f2zmsg().engine()?.resolve_handle(&args.handle).await
}

/// Callable **before** enrollment and without an engine, so the UI can decide
/// what to render even when durable-store startup faulted (§11.3, #762).
///
/// The answer is a pure function of `username`. Routing it through
/// `F2zMsg::engine()` would turn an available syntactic diagnosis into the
/// unrelated storage fault and would contradict the contract's pre-engine
/// guarantee.
#[command]
pub(crate) async fn check_handle_eligibility(args: UsernameArgs) -> Result<HandleEligibility> {
    Ok(crate::handle::eligibility(&args.username))
}

#[command]
pub(crate) async fn get_safety_number<R: Runtime>(
    app: AppHandle<R>,
    args: ConversationIdArgs,
) -> Result<SafetyNumber> {
    app.f2zmsg()
        .engine()?
        .safety_number(&args.conversation_id)
        .await
}

#[command]
pub(crate) async fn set_verification<R: Runtime>(
    app: AppHandle<R>,
    args: SetVerificationArgs,
) -> Result<VerificationState> {
    app.f2zmsg()
        .engine()?
        .set_verification(
            &args.conversation_id,
            &args.safety_number_digest,
            args.verified,
        )
        .await
}

#[command]
pub(crate) async fn get_self_audit_state<R: Runtime>(app: AppHandle<R>) -> Result<SelfAuditState> {
    app.f2zmsg().engine()?.self_audit_state().await
}

#[command]
pub(crate) async fn list_alarms<R: Runtime>(app: AppHandle<R>) -> Result<Vec<Alarm>> {
    app.f2zmsg().engine()?.list_alarms().await
}

/// Acknowledging is **not** dismissing: the alarm stays in `list_alarms` with
/// `acknowledgedAt` set and remains visible.
#[command]
pub(crate) async fn acknowledge_alarm<R: Runtime>(
    app: AppHandle<R>,
    args: AcknowledgeAlarmArgs,
) -> Result<Alarm> {
    app.f2zmsg()
        .engine()?
        .acknowledge_alarm(&args.alarm_id, &args.confirmation)
        .await
}

// ---------------------------------------------------------------------------
// §3.11 — relays and witnesses
// ---------------------------------------------------------------------------

#[command]
pub(crate) async fn list_relays<R: Runtime>(app: AppHandle<R>) -> Result<Vec<RelayConfig>> {
    app.f2zmsg().engine()?.list_relays().await
}

#[command]
pub(crate) async fn add_relay<R: Runtime>(
    app: AppHandle<R>,
    args: RelayUrlArgs,
) -> Result<RelayConfig> {
    app.f2zmsg().engine()?.add_relay(&args.relay_url).await
}

#[command]
pub(crate) async fn remove_relay<R: Runtime>(app: AppHandle<R>, args: RelayIdArgs) -> Result<()> {
    app.f2zmsg().engine()?.remove_relay(&args.relay_id).await
}

#[command]
pub(crate) async fn get_relay_capabilities<R: Runtime>(
    app: AppHandle<R>,
    args: RelayIdArgs,
) -> Result<RelayCapabilities> {
    app.f2zmsg()
        .engine()?
        .relay_capabilities(&args.relay_id)
        .await
}

/// **The one command whose grant is a security downgrade.** It is how a user
/// opts in to a relay with `transport_security: "none"` or
/// `channel_binding_mode: "none"`, and the UI must gate it behind an explicit
/// per-relay confirmation that states what travels in the clear.
#[command]
pub(crate) async fn set_relay_trust<R: Runtime>(
    app: AppHandle<R>,
    args: SetRelayTrustArgs,
) -> Result<RelayConfig> {
    app.f2zmsg()
        .engine()?
        .set_relay_trust(
            &args.relay_id,
            args.allow_insecure_transport,
            args.allow_no_channel_binding,
        )
        .await
}

#[command]
pub(crate) async fn list_witnesses<R: Runtime>(app: AppHandle<R>) -> Result<Vec<WitnessConfig>> {
    app.f2zmsg().engine()?.list_witnesses().await
}

#[command]
pub(crate) async fn set_witness_set<R: Runtime>(
    app: AppHandle<R>,
    args: SetWitnessSetArgs,
) -> Result<WitnessSetState> {
    app.f2zmsg()
        .engine()?
        .set_witness_set(&args.witnesses, args.threshold)
        .await
}

#[command]
pub(crate) async fn get_witness_set_state<R: Runtime>(
    app: AppHandle<R>,
) -> Result<WitnessSetState> {
    app.f2zmsg().engine()?.witness_set_state().await
}
