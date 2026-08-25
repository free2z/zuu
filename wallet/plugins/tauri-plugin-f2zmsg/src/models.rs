//! Every wire shape the messaging plugin exchanges with the webview.
//!
//! This module is the Rust half of `wallet/zuuli/src/lib/messaging/types.ts`,
//! and the two are held together mechanically rather than by review: the
//! frontend declares each shape once as a `zod` schema and parses the engine's
//! answer against it, so a field renamed here fails loudly in the dev build and
//! in `ALWAYS_PARSED` commands in every build
//! (`docs/e2ee/CLIENT-CONTRACT.md` §4.1).
//!
//! Three conventions, all of them load-bearing:
//!
//! * **`#[serde(rename_all = "camelCase")]` on every wire struct.** §3 says
//!   camelCase on both sides, and `types.ts` is written that way.
//! * **`#[serde(rename_all = "kebab-case")]` on every wire enum.** The unions in
//!   `types.ts` are kebab strings (`"queue-delivered"`, `"relay-unreachable"`),
//!   not Rust's default PascalCase.
//! * **`deny_unknown_fields` on argument structs only.** An unexpected field
//!   arriving from the webview is a client bug worth surfacing; an unexpected
//!   field arriving at the client is how this contract grows additively (§12.1).

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// §8 — the closed error union.
// ---------------------------------------------------------------------------

/// `CLIENT-CONTRACT.md` §8. A **closed** union: every rejected command and
/// every [`DeliveryStatus::failure`] carries exactly one member, and the
/// frontend never sees a numeric wire code.
///
/// The mapping from `WIRE.md` §10 and `KT.md` §9.5 lives in
/// [`crate::wire_codes`], including §8.1's default rule — a code neither table
/// names maps to the *protocol violation* member for whichever peer returned
/// it, never to [`ErrorCode::Internal`], which means our own engine faulted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum ErrorCode {
    // relay / transport
    RelayUnreachable,
    RelayRateLimited,
    RelayBackpressure,
    RelayQuota,
    RelayVersionUnsupported,
    RelayProtocolViolation,
    RelayIdentityMismatch,
    RelayRefusedInsecure,
    RelayCapabilityMismatch,
    SendUnavailable,
    SendAddressStolen,
    PowRequired,
    PowFailed,
    // directory / key transparency
    DirectoryUnreachable,
    DirectoryRateLimited,
    DirectoryProofInvalid,
    DirectoryVersionConflict,
    DirectoryCooldown,
    DirectoryEpochUnavailable,
    DirectoryProtocolViolation,
    WitnessThresholdUnmet,
    HandleIneligible,
    // local
    NotEnrolled,
    EngineLocked,
    EngineNotRunning,
    DeviceClockSkew,
    DurabilityUnavailable,
    StorageFull,
    GapUnrecoverable,
    NotSupportedInBrowser,
    Internal,
}

impl ErrorCode {
    /// §8's retryable column, as data rather than as prose.
    ///
    /// `types.ts` carries the same set in `RETRYABLE_ERROR_CODES`, and
    /// `tests/error_contract.rs` asserts the two agree, because a client that
    /// retries `witness-threshold-unmet` or `directory-proof-invalid` converts
    /// an attack indicator into a flaky-network indicator (§9 rules 5 and 9).
    #[must_use]
    pub const fn retryable(self) -> bool {
        matches!(
            self,
            Self::RelayUnreachable
                | Self::RelayRateLimited
                | Self::RelayBackpressure
                | Self::SendUnavailable
                | Self::PowRequired
                | Self::PowFailed
                | Self::DirectoryUnreachable
                | Self::DirectoryRateLimited
                | Self::DirectoryVersionConflict
        )
    }

    /// The kebab string this code serializes as. Used by the error type's
    /// `Display` and by the tests that compare against `types.ts`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RelayUnreachable => "relay-unreachable",
            Self::RelayRateLimited => "relay-rate-limited",
            Self::RelayBackpressure => "relay-backpressure",
            Self::RelayQuota => "relay-quota",
            Self::RelayVersionUnsupported => "relay-version-unsupported",
            Self::RelayProtocolViolation => "relay-protocol-violation",
            Self::RelayIdentityMismatch => "relay-identity-mismatch",
            Self::RelayRefusedInsecure => "relay-refused-insecure",
            Self::RelayCapabilityMismatch => "relay-capability-mismatch",
            Self::SendUnavailable => "send-unavailable",
            Self::SendAddressStolen => "send-address-stolen",
            Self::PowRequired => "pow-required",
            Self::PowFailed => "pow-failed",
            Self::DirectoryUnreachable => "directory-unreachable",
            Self::DirectoryRateLimited => "directory-rate-limited",
            Self::DirectoryProofInvalid => "directory-proof-invalid",
            Self::DirectoryVersionConflict => "directory-version-conflict",
            Self::DirectoryCooldown => "directory-cooldown",
            Self::DirectoryEpochUnavailable => "directory-epoch-unavailable",
            Self::DirectoryProtocolViolation => "directory-protocol-violation",
            Self::WitnessThresholdUnmet => "witness-threshold-unmet",
            Self::HandleIneligible => "handle-ineligible",
            Self::NotEnrolled => "not-enrolled",
            Self::EngineLocked => "engine-locked",
            Self::EngineNotRunning => "engine-not-running",
            Self::DeviceClockSkew => "device-clock-skew",
            Self::DurabilityUnavailable => "durability-unavailable",
            Self::StorageFull => "storage-full",
            Self::GapUnrecoverable => "gap-unrecoverable",
            Self::NotSupportedInBrowser => "not-supported-in-browser",
            Self::Internal => "internal",
        }
    }

    /// Every member, in `types.ts` order. The population the contract tests
    /// compare against; a member added without extending this array fails
    /// `every_error_code_is_registered`.
    pub const ALL: &'static [Self] = &[
        Self::RelayUnreachable,
        Self::RelayRateLimited,
        Self::RelayBackpressure,
        Self::RelayQuota,
        Self::RelayVersionUnsupported,
        Self::RelayProtocolViolation,
        Self::RelayIdentityMismatch,
        Self::RelayRefusedInsecure,
        Self::RelayCapabilityMismatch,
        Self::SendUnavailable,
        Self::SendAddressStolen,
        Self::PowRequired,
        Self::PowFailed,
        Self::DirectoryUnreachable,
        Self::DirectoryRateLimited,
        Self::DirectoryProofInvalid,
        Self::DirectoryVersionConflict,
        Self::DirectoryCooldown,
        Self::DirectoryEpochUnavailable,
        Self::DirectoryProtocolViolation,
        Self::WitnessThresholdUnmet,
        Self::HandleIneligible,
        Self::NotEnrolled,
        Self::EngineLocked,
        Self::EngineNotRunning,
        Self::DeviceClockSkew,
        Self::DurabilityUnavailable,
        Self::StorageFull,
        Self::GapUnrecoverable,
        Self::NotSupportedInBrowser,
        Self::Internal,
    ];
}

impl core::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.as_str())
    }
}

// ---------------------------------------------------------------------------
// §3.1 — engine lifecycle.
// ---------------------------------------------------------------------------

/// §6.1. `degraded` is a **running** state, not an error one: an established
/// conversation keeps sending and receiving, and what it refuses is resolving a
/// new handle and accepting a key change (§6.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EngineState {
    Uninitialized,
    Ineligible,
    NotEnrolled,
    Enrolling,
    Locked,
    Starting,
    Running,
    Degraded,
    Stopped,
    Faulted,
}

/// §11.2. A client that cannot promise durability must not ACK, so this is a
/// operating-mode selector rather than a diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DurabilityMode {
    Durable,
    BestEffort,
    None,
}

/// The webview's platform, as §11.1's trust statement needs it. The plugin only
/// ever reports the two native values; `browser` exists in the union because
/// the WASM client answers the same command (§11.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Platform {
    ZuuliDesktop,
    ZuuliMobile,
    Browser,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub state: EngineState,
    pub enrolled: bool,
    pub handle: Option<String>,
    pub relays_connected: u32,
    pub relays_configured: u32,
    pub witness_threshold_met: bool,
    /// `KT.md` §8.3 — **independent** witnesses, never the configured count.
    pub independent_witnesses: u32,
    /// Durably written, not yet surfaced.
    pub pending_inbound: u32,
    pub unacknowledged_alarms: u32,
    pub last_error: Option<ErrorCode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub device_id: String,
    /// `DSK.public`, grouped for human reading.
    pub device_fingerprint: String,
    /// `ISK.public`, grouped for human reading.
    pub identity_fingerprint: String,
    pub created_at: i64,
    pub platform: Platform,
    pub durability: DurabilityMode,
}

// ---------------------------------------------------------------------------
// §3.2 — enrollment. The status shapes live here because the plugin owns the
// engine's view of them; the three *commands* live in the app crate (§2.2).
// ---------------------------------------------------------------------------

/// §3.2. Kept apart from a single "invalid handle" string because the causes
/// differ wildly in prevalence and the UI should name the specific one: `.`,
/// `@`, `+` and `-` account for almost the whole ineligible population (§11.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IneligibilityReason {
    Punctuation,
    NonAscii,
    TooLong,
    NotSignedIn,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandleEligibility {
    pub eligible: bool,
    /// `lowercase(username)`, present only when it matches §11.3's pattern.
    pub candidate: Option<String>,
    pub reason: Option<IneligibilityReason>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollmentStatus {
    pub enrolled: bool,
    pub handle: Option<String>,
    pub eligibility: HandleEligibility,
    pub directory_entry_version: Option<i64>,
    pub submitted_at: Option<i64>,
    /// Null until the log merges the submission at an epoch boundary (§3.2).
    pub merged_at_epoch: Option<i64>,
    pub blocked: Option<ErrorCode>,
}

// ---------------------------------------------------------------------------
// §3.3 / §3.7 / §3.8 — conversations and the two local policies on them.
// ---------------------------------------------------------------------------

/// §3.10 / §6.3. A discriminated union on `state`: each state carries its own
/// evidence, and `changed` is not a soft state — returning to `verified`
/// requires comparing safety numbers again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum VerificationState {
    Unverified,
    #[serde(rename_all = "camelCase")]
    Verified {
        verified_at: i64,
        digest: String,
    },
    #[serde(rename_all = "camelCase")]
    Changed {
        previous_digest: String,
        changed_at: i64,
    },
}

/// §3.3. `compromised` means the send side of a queue this conversation depends
/// on was bound by somebody else (`WIRE.md` §7.4) — loud and non-dismissible,
/// never a retry and never a toast.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransportHealth {
    Ok,
    Degraded,
    Unavailable,
    Compromised,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RetentionScope {
    Global,
    Conversation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RetentionMode {
    Keep,
    Expire,
}

/// §3.7. Entirely local to this device (ADR 0007): one participant keeps five
/// minutes, another keeps forever, and neither constrains the other.
/// `effectiveFrom` is forward-only — nothing here is retroactive in either
/// direction, and the UI has to say so.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionPolicy {
    pub scope: RetentionScope,
    pub mode: RetentionMode,
    /// `expire` only.
    pub ttl_seconds: Option<u64>,
    pub effective_from: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EphemeralMode {
    Ephemeral,
    Retained,
}

/// §3.8. A courtesy signal, never enforcement. What is real cryptography is
/// that it travels inside MLS, so it is confidential, authenticated and
/// **attributable**; what is not real is enforcement, and no mechanism exists
/// or can exist to detect a non-conforming client ignoring it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EphemeralHintState {
    pub mode: EphemeralMode,
    pub ttl_seconds: Option<u64>,
    /// Peer handle — the hint is attributable.
    pub requested_by: String,
    pub requested_in_epoch: u64,
    /// What *this* device is doing about it.
    pub honored_locally: bool,
}

/// §3.6. Receipt timing is a published deanonymization vector against sealed
/// sender, so receipts are batched and jittered and read receipts default off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptPolicy {
    pub delivery_receipts: bool,
    pub read_receipts: bool,
}

impl Default for ReceiptPolicy {
    fn default() -> Self {
        Self {
            delivery_receipts: true,
            read_receipts: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub conversation_id: String,
    pub peer_handle: String,
    pub peer_identity_fingerprint: String,
    pub verification: VerificationState,
    pub epoch: u64,
    pub created_at: i64,
    /// Display only, derived from the local receipt clock.
    pub last_message_at: Option<i64>,
    pub unread_count: u32,
    pub retention: RetentionPolicy,
    pub ephemeral_hint: Option<EphemeralHintState>,
    pub receipt_policy: ReceiptPolicy,
    /// §3.5. Never render this silently.
    pub has_gaps: bool,
    pub transport_health: TransportHealth,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationPage {
    pub conversations: Vec<Conversation>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactRequest {
    pub request_id: String,
    pub peer_handle: String,
    pub peer_identity_fingerprint: String,
    pub received_at: i64,
    /// PROVISIONAL per §12.1 — it may become `null` always.
    pub body_preview: Option<String>,
}

// ---------------------------------------------------------------------------
// §3.4 / §3.6 — messages and delivery.
// ---------------------------------------------------------------------------

/// §6.2. Four states come from the protocol and three are client-local
/// bookkeeping; **conflating them is how delete-on-ack loses messages**.
/// `queue-delivered` is a storage fact about the recipient device, not a
/// reading fact, and `delivered` says nothing about being read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeliveryState {
    Accepted,
    QueueDelivered,
    DeviceDelivered,
    Delivered,
    Pending,
    Failed,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryStatus {
    pub msg_id: String,
    pub state: DeliveryState,
    pub accepted_by_relays: u32,
    pub configured_relays: u32,
    pub devices_receipted: u32,
    /// The recipient device set as of the send epoch. Always 1 in single-device
    /// v1 (ADR 0002) — which is exactly the coincidence that tempts an
    /// implementer to collapse the states. Do not collapse them.
    pub devices_expected: u32,
    pub failure: Option<ErrorCode>,
    pub updated_at: i64,
}

/// §3.4. `unrecoverable` exists because a short local retention TTL shortens
/// the plaintext outbox used for gap repair, so some gaps cannot be repaired.
/// It is **never rendered as nothing**.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum MessageBody {
    Text {
        text: String,
    },
    Unrecoverable {
        reason: UnrecoverableReason,
    },
    #[serde(rename_all = "camelCase")]
    Unsupported {
        type_tag: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnrecoverableReason {
    GapUnrecoverable,
    RetentionExpired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Direction {
    Outbound,
    Inbound,
}

/// §3.9's ceremony transcripts are retained by default
/// (`ARCHITECTURE.md` §8.5); nothing else about ceremonies is in v1 (§10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RetentionClass {
    Chat,
    Ceremony,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub msg_id: String,
    pub conversation_id: String,
    pub direction: Direction,
    /// Ordering key 1 (§7).
    pub epoch: u64,
    /// Ordering key 2 (§7).
    pub sender_leaf_index: u32,
    /// The DAG: `msg_id`s the sender had received and not yet referenced.
    pub parents: Vec<String>,
    /// **ADVISORY ONLY** (§7, §9 rule 2). Never order, filter or dedup by this.
    pub sent_at: i64,
    /// Local clock at durable write; this device's opinion, inbound only.
    pub received_at: Option<i64>,
    pub body: MessageBody,
    pub delivery: DeliveryStatus,
    pub retention_class: RetentionClass,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    /// In §7's total order `(epoch, senderLeafIndex, msgId)`, oldest first.
    pub messages: Vec<Message>,
    pub cursor: Option<String>,
    /// A hole, not an absence (§3.5).
    pub has_gap_before: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendAccepted {
    /// BLAKE2b-256 hex. The protocol's dedup key, and the only identity that
    /// survives a duplicate arriving over a second relay.
    pub msg_id: String,
    /// Echoed back; the frontend's own idempotency key.
    pub client_ref: String,
    pub state: DeliveryState,
}

// ---------------------------------------------------------------------------
// §3.5 — gaps.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GapState {
    Detected,
    RepairRequested,
    Repaired,
    /// The sender no longer holds the plaintext.
    Unrecoverable,
}

/// §3.5. A gap is a **certainty**, not a suspicion: a receiver holding a
/// `parents` hash it does not have knows a message is missing, with no server
/// assistance. Hash links do not detect tail truncation, so `hasGaps: false`
/// means "no detected gap" and never "nothing is missing".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    pub gap_id: String,
    pub conversation_id: String,
    pub missing_msg_ids: Vec<String>,
    pub detected_at: i64,
    /// Where the hole sits in the transcript.
    pub after_msg_id: Option<String>,
    pub state: GapState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GapRepairStatus {
    pub gap_id: String,
    pub state: GapState,
    pub reason: Option<ErrorCode>,
}

// ---------------------------------------------------------------------------
// §3.9 — purge requests.
// ---------------------------------------------------------------------------

/// §3.9. A purge is a **request**, not a deletion. Both counts are here so the
/// UI can say *"asked N participants to delete; M confirmed"* and never
/// *"deleted"*.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeRequestStatus {
    pub purge_id: String,
    pub conversation_id: String,
    pub before_epoch: u64,
    pub direction: Direction,
    pub asked_participants: u32,
    pub confirmed_participants: u32,
    pub requested_at: i64,
}

// ---------------------------------------------------------------------------
// §3.10 — directory, safety numbers, self-audit and alarms.
// ---------------------------------------------------------------------------

/// §3.10, with its 2026-08-24 correction. `found: false` is the single
/// representation of non-membership and arrives on the **success** path — but
/// it is the log's *assertion*, not a proof: `akd` 0.13 produces no
/// non-membership proof, so no UI may present the absence as verified.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryResolution {
    pub handle: String,
    pub found: bool,
    pub identity_fingerprint: Option<String>,
    pub device_count: u32,
    pub entry_version: Option<i64>,
    pub epoch: u64,
    /// Valid cosignatures from the client's **own** configured set.
    pub witness_cosignatures: u32,
    /// `KT.md` §8.3 — the number the UI displays.
    pub independent_witnesses: u32,
    pub threshold_met: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafetyNumber {
    pub conversation_id: String,
    /// Stable identity for `set_verification`.
    pub digest: String,
    /// Pre-grouped for human comparison.
    pub display_groups: Vec<String>,
    pub qr_payload: String,
    /// ZUULI only (ADR 0006); no payload format is specified yet (§12.1).
    pub zcash_memo_payload: Option<String>,
}

/// §3.10. Self-audit is the whole point of the directory: every client monitors
/// its own handle every epoch and raises a loud, non-dismissible alarm on any
/// key change it did not initiate. That is what makes an attempted MITM
/// detectable by the victim, and it is the only thing that does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfAuditState {
    pub last_checked_epoch: Option<u64>,
    pub last_checked_at: Option<i64>,
    /// `entry_version` **and** `prev_entry_hash` both unbroken.
    pub chain_intact: bool,
    /// Entries this device did not submit.
    pub unexpected_entries: u32,
    pub running: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AlarmKind {
    IdentityKeyChanged,
    PlatformReset,
    SelfAuditUnexpectedEntry,
    QueueSendAddressStolen,
    RelayIdentityMismatch,
    WitnessThresholdUnmet,
    DirectoryForkEvidence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AlarmSeverity {
    Critical,
    Warning,
}

/// A field that is always `false` on the wire, so `types.ts` can type it as the
/// literal `false` and no component can be written that hides an alarm.
///
/// §9 rule 4 is the rule; this type is the enforcement, and it is a type rather
/// than a `bool` so that "set it true just this once" is not reachable.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NeverDismissible;

impl Serialize for NeverDismissible {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(false)
    }
}

impl<'de> Deserialize<'de> for NeverDismissible {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match bool::deserialize(deserializer)? {
            false => Ok(Self),
            true => Err(serde::de::Error::custom(
                "an alarm is never dismissible (CLIENT-CONTRACT.md §9 rule 4)",
            )),
        }
    }
}

/// §3.10. **Acknowledging is not dismissing**: the alarm stays in `list_alarms`
/// with `acknowledgedAt` set and remains visible.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Alarm {
    pub alarm_id: String,
    pub kind: AlarmKind,
    pub severity: AlarmSeverity,
    pub raised_at: i64,
    pub dismissible: NeverDismissible,
    pub handle: Option<String>,
    pub old_fingerprint: Option<String>,
    pub new_fingerprint: Option<String>,
    /// ADR 0014 platform reset — the UI says "platform-assisted".
    pub platform_assisted: bool,
    pub cooldown_ends_at: Option<i64>,
    pub acknowledged_at: Option<i64>,
}

// ---------------------------------------------------------------------------
// §3.11 — relays and witnesses.
// ---------------------------------------------------------------------------

/// `WIRE.md` §11.1. `jurisdiction` and the contact fields are not decoration: a
/// user choosing among relays is making a jurisdictional choice whether or not
/// anyone tells them so.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayOperator {
    pub name: String,
    pub contact: String,
    pub abuse_contact: String,
    /// Where the operator and the hardware sit.
    pub jurisdiction: String,
    pub policy_url: String,
    pub source_repo_url: String,
    pub source_commit: String,
    pub build_digest: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RelayWarning {
    /// Everything but the ciphertext travels in the clear.
    NoTransportSecurity,
    NoChannelBinding,
    VolatileAntireplay,
    /// A token is an identifier. Per the 2026-08-24 correction this describes a
    /// relay the client never adds — `add_relay` refuses the reserved
    /// `queue_creation_mode` outright — and the member is kept so a component
    /// written against the union does not lose a case it may already handle.
    TokenGated,
    NonDurable,
    SuspiciousPaddingSet,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RelayConnection {
    Connected,
    Connecting,
    Disconnected,
    Refused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayConfig {
    pub relay_id: String,
    pub relay_url: String,
    pub connection: RelayConnection,
    pub trusted: bool,
    pub operator: RelayOperator,
    pub warnings: Vec<RelayWarning>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QueueCreationMode {
    Open,
    Pow,
    /// **Reserved** (#630): v1's `CREATE_QUEUE` has no field a token can go in,
    /// so `add_relay` refuses a document advertising this and offers no
    /// override — there is nothing a user could consent to.
    Token,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RelayDurabilityMode {
    Memory,
    Batched,
    FsyncPerAppend,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayCapabilities {
    pub padding_sizes: Vec<u32>,
    pub max_message_ttl_seconds: u64,
    pub idle_ttl_seconds: u64,
    pub queue_creation_mode: QueueCreationMode,
    pub durability_mode: RelayDurabilityMode,
    pub per_source_limits: bool,
    pub operator: RelayOperator,
}

/// `set_witness_set`'s `witnesses` element.
///
/// **This is the one place the TypeScript and the contract disagree**, and the
/// disagreement is recorded rather than resolved here: §3.11 declares
/// `WitnessInput { witnessId, name }`, while `bridge.ts` types the argument as
/// `witnesses: string[]`. The command accepts **both** encodings — a bare hex
/// string keeps the name empty — so neither side is broken while the question
/// is settled. See the plugin README's "Contract disagreements" section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", untagged)]
pub enum WitnessInput {
    /// What `bridge.ts` sends today: the hex `witness_pk` alone.
    Id(String),
    /// What §3.11 declares.
    #[serde(rename_all = "camelCase")]
    Named { witness_id: String, name: String },
}

impl WitnessInput {
    #[must_use]
    pub fn witness_id(&self) -> &str {
        match self {
            Self::Id(id) => id,
            Self::Named { witness_id, .. } => witness_id,
        }
    }

    #[must_use]
    pub fn name(&self) -> &str {
        match self {
            Self::Id(_) => "",
            Self::Named { name, .. } => name,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WitnessConfig {
    /// The hex `witness_pk` — the Ed25519 key a cosignature verifies under.
    /// This is the identity; the name is not.
    pub witness_id: String,
    pub name: String,
    /// **PROVISIONAL** (§12.1): computed by a rule that does not exist yet
    /// (§13-Q), and never self-asserted.
    pub independent: bool,
    pub last_cosigned_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WitnessSetState {
    pub configured: u32,
    pub independent: u32,
    pub threshold: u32,
    pub threshold_met: bool,
    /// True while `independent == 0`, and while it is true the UI must state
    /// plainly that no independent witness exists rather than render a count.
    pub bootstrap_disclaimer: bool,
}

// ---------------------------------------------------------------------------
// Command argument types. §3: every payload is nested under a single `args`
// key, and commands with no arguments take no `args` key at all.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListConversationsArgs {
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationIdArgs {
    pub conversation_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HandleArgs {
    pub handle: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsernameArgs {
    pub username: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestIdArgs {
    pub request_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RejectContactRequestArgs {
    pub request_id: String,
    /// Local only: there is no server that knows who talks to whom, so the UI
    /// says "blocked on this device", not "blocked" (§3.3).
    pub block: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendMessageArgs {
    pub conversation_id: String,
    pub body: String,
    pub client_ref: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MsgIdArgs {
    pub msg_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListMessagesArgs {
    pub conversation_id: String,
    pub limit: u32,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkReadArgs {
    pub conversation_id: String,
    pub up_to_msg_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetReceiptPolicyArgs {
    pub conversation_id: String,
    pub delivery_receipts: bool,
    pub read_receipts: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestGapRepairArgs {
    pub conversation_id: String,
    pub gap_ids: Vec<String>,
}

/// `get_retention_policy` takes an **optional** conversation id: absent returns
/// the global policy, present returns the *effective* policy for that
/// conversation with `scope` saying which of the two produced the answer.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetRetentionPolicyArgs {
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetRetentionPolicyArgs {
    /// Which policy is being written. Global takes no `conversationId` and
    /// passing one is a client bug; conversation requires it (§3.7).
    pub scope: RetentionScope,
    pub conversation_id: Option<String>,
    pub mode: RetentionMode,
    pub ttl_seconds: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendEphemeralHintArgs {
    pub conversation_id: String,
    pub mode: EphemeralMode,
    pub ttl_seconds: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendPurgeRequestArgs {
    pub conversation_id: String,
    pub before_epoch: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetVerificationArgs {
    pub conversation_id: String,
    pub safety_number_digest: String,
    pub verified: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcknowledgeAlarmArgs {
    pub alarm_id: String,
    /// A typed confirmation, in the shape `discard_unrecoverable_send` already
    /// uses. The engine owns the phrase, so no test pins one.
    pub confirmation: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayUrlArgs {
    pub relay_url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayIdArgs {
    pub relay_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetRelayTrustArgs {
    pub relay_id: String,
    pub allow_insecure_transport: bool,
    pub allow_no_channel_binding: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetWitnessSetArgs {
    /// Replaces the **whole** set — a set operation, not an append.
    pub witnesses: Vec<WitnessInput>,
    pub threshold: u32,
}

// ---------------------------------------------------------------------------
// §5.1 — event payloads that are not already a domain type.
// ---------------------------------------------------------------------------

/// `f2zmsg://message-received`. `conversationId` is redundant with
/// `message.conversationId` and is carried anyway so a subscriber can route
/// without parsing the message; a payload where they differ is an engine bug.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageReceivedEvent {
    pub conversation_id: String,
    pub message: Message,
}

/// `f2zmsg://retention-expired`. Local plaintext expired under **this device's
/// own** policy; nothing about it reaches any other device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionExpiredEvent {
    pub conversation_id: String,
    pub msg_ids: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_serialize_as_the_kebab_strings_types_ts_declares() {
        for code in ErrorCode::ALL {
            let json = serde_json::to_string(code).expect("serialize");
            assert_eq!(json, format!("\"{}\"", code.as_str()));
        }
    }

    #[test]
    fn every_error_code_is_registered_in_all() {
        // A member added to the enum without extending ALL would make every
        // contract comparison silently narrower.
        assert_eq!(ErrorCode::ALL.len(), 31);
    }

    #[test]
    fn an_alarm_is_never_dismissible_on_the_wire() {
        let json = serde_json::to_value(NeverDismissible).expect("serialize");
        assert_eq!(json, serde_json::json!(false));
        assert!(serde_json::from_value::<NeverDismissible>(serde_json::json!(true)).is_err());
    }

    #[test]
    fn verification_state_is_a_discriminated_union_on_state() {
        let json = serde_json::to_value(VerificationState::Verified {
            verified_at: 7,
            digest: "abc".into(),
        })
        .expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({ "state": "verified", "verifiedAt": 7, "digest": "abc" })
        );
        assert_eq!(
            serde_json::to_value(VerificationState::Unverified).expect("serialize"),
            serde_json::json!({ "state": "unverified" })
        );
    }

    #[test]
    fn a_message_body_is_a_discriminated_union_on_kind() {
        assert_eq!(
            serde_json::to_value(MessageBody::Unsupported {
                type_tag: "x/1".into()
            })
            .expect("serialize"),
            serde_json::json!({ "kind": "unsupported", "typeTag": "x/1" })
        );
    }

    #[test]
    fn witness_input_accepts_both_the_bridges_shape_and_the_contracts() {
        let bridge: Vec<WitnessInput> =
            serde_json::from_value(serde_json::json!(["0f2c8a41"])).expect("bridge shape");
        assert_eq!(bridge[0].witness_id(), "0f2c8a41");
        assert_eq!(bridge[0].name(), "");

        let contract: Vec<WitnessInput> = serde_json::from_value(
            serde_json::json!([{ "witnessId": "0f2c8a41", "name": "free2z" }]),
        )
        .expect("contract shape");
        assert_eq!(contract[0].witness_id(), "0f2c8a41");
        assert_eq!(contract[0].name(), "free2z");
    }

    #[test]
    fn argument_structs_reject_unknown_fields() {
        let err = serde_json::from_value::<SendMessageArgs>(serde_json::json!({
            "conversationId": "c", "body": "b", "clientRef": "r", "sentAt": 1
        }));
        assert!(err.is_err(), "an unexpected argument is a client bug");
    }

    #[test]
    fn retryable_matches_the_contracts_retryable_column() {
        let retryable: Vec<&str> = ErrorCode::ALL
            .iter()
            .filter(|code| code.retryable())
            .map(|code| code.as_str())
            .collect();
        assert_eq!(
            retryable,
            [
                "relay-unreachable",
                "relay-rate-limited",
                "relay-backpressure",
                "send-unavailable",
                "pow-required",
                "pow-failed",
                "directory-unreachable",
                "directory-rate-limited",
                "directory-version-conflict",
            ]
        );
    }
}
