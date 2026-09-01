// Messaging domain types — the single source of truth for shapes.
// Mirrors the plugin's `models.rs` serde output; camelCase on both sides.
//
// Each type is declared once as a runtime schema with the static type derived
// from it, because `invoke<T>()` never checks the shape it asserts: a renamed
// backend field ships as `undefined` and nothing fails until a user sees a
// blank row. `docs/e2ee/CLIENT-CONTRACT.md` §4.1.

import { z } from "zod";

/**
 * Commands the contract declares as `void`. Tauri sends `null` for a Rust unit
 * return and the mock returns `undefined`, so both are accepted and normalized.
 */
export const VoidSchema = z.union([z.null(), z.undefined()]);

/** §8. Closed union; adding a member is a contract change. */
export const ErrorCodeSchema = z.enum([
  // relay / transport
  "relay-unreachable",
  "relay-rate-limited",
  "relay-backpressure",
  "relay-quota",
  "relay-version-unsupported",
  "relay-protocol-violation",
  "relay-identity-mismatch",
  "relay-refused-insecure",
  "relay-capability-mismatch",
  "send-unavailable",
  "send-address-stolen",
  "pow-required",
  "pow-failed",
  // directory / key transparency
  "directory-unreachable",
  "directory-rate-limited",
  "directory-proof-invalid",
  "directory-version-conflict",
  "directory-cooldown",
  "directory-epoch-unavailable",
  "directory-protocol-violation",
  "witness-threshold-unmet",
  "handle-ineligible",
  // local
  "not-enrolled",
  "engine-locked",
  "engine-not-running",
  "device-clock-skew",
  "durability-unavailable",
  "storage-full",
  "gap-unrecoverable",
  "not-supported-in-browser",
  // component-internal (local engine or peer-reported relay/directory fault)
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/**
 * §8's retryable column, as data so the client has one answer. Everything
 * absent is terminal until the user acts — notably `witness-threshold-unmet`
 * and `directory-proof-invalid`, which §9 rules 5 and 9 forbid retrying past.
 */
export const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set([
  "relay-unreachable",
  "relay-rate-limited",
  "relay-backpressure",
  "send-unavailable",
  "pow-required",
  "pow-failed",
  "directory-unreachable",
  "directory-rate-limited",
  "directory-version-conflict",
]);

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE_ERROR_CODES.has(code);
}

/**
 * §6.1. `degraded` is a running state, not an error one: an established
 * conversation keeps sending and receiving; what it refuses is resolving a new
 * handle and accepting a key change. `faulted` is reachable only from
 * `starting` / `running` / `degraded`, and leaving it takes an explicit
 * `startEngine()` — nothing retries out of it on a timer.
 */
export const EngineStateSchema = z.enum([
  "uninitialized",
  "ineligible",
  "not-enrolled",
  "enrolling",
  "locked",
  "starting",
  "running",
  "degraded",
  "stopped",
  "faulted",
]);
export type EngineState = z.infer<typeof EngineStateSchema>;

/** §11.2. */
export const DurabilityModeSchema = z.enum(["durable", "best-effort", "none"]);
export type DurabilityMode = z.infer<typeof DurabilityModeSchema>;

export const EngineStatusSchema = z.object({
  state: EngineStateSchema,
  enrolled: z.boolean(),
  handle: z.string().nullable(),
  relaysConnected: z.number().int().nonnegative(),
  relaysConfigured: z.number().int().nonnegative(),
  witnessThresholdMet: z.boolean(),
  /** `KT.md` §8.3 — independent witnesses, NOT the configured count. */
  independentWitnesses: z.number().int().nonnegative(),
  /** Durably written, not yet surfaced. */
  pendingInbound: z.number().int().nonnegative(),
  unacknowledgedAlarms: z.number().int().nonnegative(),
  lastError: ErrorCodeSchema.nullable(),
});
export type EngineStatus = z.infer<typeof EngineStatusSchema>;

export const DeviceInfoSchema = z.object({
  deviceId: z.string(),
  /** `DSK.public`, grouped for human reading. */
  deviceFingerprint: z.string(),
  /** `ISK.public`, grouped for human reading. */
  identityFingerprint: z.string(),
  createdAt: z.number().int(),
  platform: z.enum(["zuuli-desktop", "zuuli-mobile", "browser"]),
  durability: DurabilityModeSchema,
});
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

/** §3.2. Kept apart because the UI should name the specific cause. */
export const IneligibilityReasonSchema = z.enum([
  "punctuation",
  "non-ascii",
  "too-long",
  "not-signed-in",
]);
export type IneligibilityReason = z.infer<typeof IneligibilityReasonSchema>;

export const HandleEligibilitySchema = z.object({
  eligible: z.boolean(),
  /** `lowercase(username)`, present only when it matches. */
  candidate: z.string().nullable(),
  reason: IneligibilityReasonSchema.nullable(),
});
export type HandleEligibility = z.infer<typeof HandleEligibilitySchema>;

export const EnrollmentStatusSchema = z.object({
  enrolled: z.boolean(),
  handle: z.string().nullable(),
  eligibility: HandleEligibilitySchema,
  directoryEntryVersion: z.number().int().nullable(),
  submittedAt: z.number().int().nullable(),
  /** Null until the log merges the submission at an epoch boundary (§3.2). */
  mergedAtEpoch: z.number().int().nullable(),
  blocked: ErrorCodeSchema.nullable(),
});
export type EnrollmentStatus = z.infer<typeof EnrollmentStatusSchema>;

/** §3.10. A discriminated union: each state carries its own evidence. */
export const VerificationStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unverified") }),
  z.object({
    state: z.literal("verified"),
    verifiedAt: z.number().int(),
    digest: z.string(),
  }),
  z.object({
    state: z.literal("changed"),
    previousDigest: z.string(),
    changedAt: z.number().int(),
  }),
]);
export type VerificationState = z.infer<typeof VerificationStateSchema>;

export const TransportHealthSchema = z.enum([
  "ok",
  "degraded",
  "unavailable",
  /**
   * The send side of a queue this conversation depends on was bound by someone
   * else. Loud and non-dismissible — never a toast, never a retry (§3.3).
   */
  "compromised",
]);
export type TransportHealth = z.infer<typeof TransportHealthSchema>;

/**
 * §3.7. Entirely local to this device: one participant keeps five minutes,
 * another keeps forever, and neither constrains the other. `effectiveFrom` is
 * forward-only — nothing here is retroactive in either direction, and the UI
 * has to say so rather than imply otherwise.
 */
export const RetentionPolicySchema = z.object({
  scope: z.enum(["global", "conversation"]),
  mode: z.enum(["keep", "expire"]),
  /** "expire" only. */
  ttlSeconds: z.number().int().positive().nullable(),
  effectiveFrom: z.number().int(),
});
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

/**
 * §3.8. A courtesy signal, never enforcement. It travels inside MLS so it is
 * confidential, authenticated and attributable — nobody can forge who asked —
 * but a non-conforming client ignores it and no mechanism exists, or can exist,
 * to detect that. `requestedBy` and `honoredLocally` are here so the UI can say
 * the true thing: who asked, and what this device is doing.
 */
export const EphemeralHintStateSchema = z.object({
  mode: z.enum(["ephemeral", "retained"]),
  ttlSeconds: z.number().int().positive().nullable(),
  /** Peer handle — the hint is attributable. */
  requestedBy: z.string(),
  requestedInEpoch: z.number().int().nonnegative(),
  honoredLocally: z.boolean(),
});
export type EphemeralHintState = z.infer<typeof EphemeralHintStateSchema>;

export const ReceiptPolicySchema = z.object({
  /** Batched and jittered, never immediate (§3.6). */
  deliveryReceipts: z.boolean(),
  /** Defaults false: receipt timing deanonymizes sealed sender. */
  readReceipts: z.boolean(),
});
export type ReceiptPolicy = z.infer<typeof ReceiptPolicySchema>;

export const ConversationSchema = z.object({
  conversationId: z.string(),
  peerHandle: z.string(),
  peerIdentityFingerprint: z.string(),
  verification: VerificationStateSchema,
  epoch: z.number().int().nonnegative(),
  createdAt: z.number().int(),
  /** Display only, derived from the local receipt clock. */
  lastMessageAt: z.number().int().nullable(),
  unreadCount: z.number().int().nonnegative(),
  retention: RetentionPolicySchema,
  ephemeralHint: EphemeralHintStateSchema.nullable(),
  receiptPolicy: ReceiptPolicySchema,
  /** §3.5. Never render this silently. */
  hasGaps: z.boolean(),
  transportHealth: TransportHealthSchema,
  /** Current compromised outbound relay; never selected from alarm history. */
  compromiseRelayUrl: z.string().nullable(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const ConversationPageSchema = z.object({
  conversations: z.array(ConversationSchema),
  cursor: z.string().nullable(),
});
export type ConversationPage = z.infer<typeof ConversationPageSchema>;

export const ContactRequestSchema = z.object({
  requestId: z.string(),
  peerHandle: z.string(),
  peerIdentityFingerprint: z.string(),
  receivedAt: z.number().int(),
  /** PROVISIONAL per §12. */
  bodyPreview: z.string().nullable(),
});
export type ContactRequest = z.infer<typeof ContactRequestSchema>;

/**
 * §6.2. Four states come from the protocol and three are client-local
 * bookkeeping; conflating them is how delete-on-ack loses messages.
 * `queue-delivered` is a storage fact about the recipient device, not a
 * reading fact, and `delivered` says nothing about being read.
 */
export const DeliveryStateSchema = z.enum([
  "accepted",
  "queue-delivered",
  "device-delivered",
  "delivered",
  "pending",
  "failed",
  "expired",
]);
export type DeliveryState = z.infer<typeof DeliveryStateSchema>;

export const DeliveryStatusSchema = z.object({
  msgId: z.string(),
  state: DeliveryStateSchema,
  acceptedByRelays: z.number().int().nonnegative(),
  configuredRelays: z.number().int().nonnegative(),
  devicesReceipted: z.number().int().nonnegative(),
  /** The recipient device set as of the send epoch. */
  devicesExpected: z.number().int().nonnegative(),
  failure: ErrorCodeSchema.nullable(),
  updatedAt: z.number().int(),
});
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

export const MessageBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({
    kind: z.literal("unrecoverable"),
    reason: z.enum(["gap-unrecoverable", "retention-expired"]),
  }),
  z.object({ kind: z.literal("unsupported"), typeTag: z.string() }),
]);
export type MessageBody = z.infer<typeof MessageBodySchema>;

export const MessageSchema = z.object({
  msgId: z.string(),
  conversationId: z.string(),
  direction: z.enum(["outbound", "inbound"]),
  epoch: z.number().int().nonnegative(),
  /**
   * The author's MLS leaf index — hashed into `msgId` since ARCHITECTURE.md
   * §7's 2026-08-25 correction. Carried for display and diagnostics: this is
   * ordering key 2, and the frontend does not order (§9 rule 10).
   */
  senderLeafIndex: z.number().int().nonnegative(),
  /** The DAG. */
  parents: z.array(z.string()),
  /** ADVISORY ONLY (§7). Never order, filter, or dedup by this. */
  sentAt: z.number().int(),
  /** Local clock at durable write; this device's opinion, inbound only. */
  receivedAt: z.number().int().nullable(),
  body: MessageBodySchema,
  delivery: DeliveryStatusSchema,
  retentionClass: z.enum(["chat", "ceremony"]),
  expiresAt: z.number().int().nullable(),
});
export type Message = z.infer<typeof MessageSchema>;

export const MessagePageSchema = z.object({
  /**
   * ALREADY in the §7 total order, oldest first. The engine linearises the
   * causal DAG; render this sequence as given and never re-sort it (§7, §9
   * rule 10).
   */
  messages: z.array(MessageSchema),
  /** A `msgId`, never an offset — positions are not stable under arrival. */
  cursor: z.string().nullable(),
  /** A hole, not an absence (§3.5). */
  hasGapBefore: z.boolean(),
});
export type MessagePage = z.infer<typeof MessagePageSchema>;

export const SendAcceptedSchema = z.object({
  /** BLAKE2b-256 hex. The protocol's dedup key. */
  msgId: z.string(),
  /** Echoed back; the frontend's own idempotency key. */
  clientRef: z.string(),
  state: DeliveryStateSchema,
});
export type SendAccepted = z.infer<typeof SendAcceptedSchema>;

// There is deliberately NO `compareMessages` here, and there must not be one.
//
// §7's display order is the causal DAG's partial order, with
// `(epoch, senderLeafIndex, msgId)` breaking ties only between messages the DAG
// leaves incomparable. A `.sort()` comparator cannot express that — it sees two
// elements, and causal precedence is a relation over the whole graph — so the
// comparator this file used to export was the tie-break mistaken for the order,
// and it rendered a reply above the message it answered in about half of all
// one-to-one conversations (zuu#733).
//
// The fix was not a better comparator. §7's ordering is protocol logic, the
// engine owns it, and `list_messages` returns `MessagePage.messages` already
// linearised by `rs/crates/f2z-msg-dag` — natively in ZUULI, through WASM in the
// browser. A second implementation here is what ADR 0001 exists to prevent.
// CLIENT-CONTRACT.md §7's 2026-08-25 correction and §9 rule 10 are normative:
// render the sequence as given.

export const GapStateSchema = z.enum([
  "detected",
  "repair-requested",
  "repaired",
  /** The sender no longer holds the plaintext. */
  "unrecoverable",
]);
export type GapState = z.infer<typeof GapStateSchema>;

/**
 * §3.5. A gap is a certainty, not a suspicion: a receiver holding a `parents`
 * hash it does not have knows a message is missing, with no server assistance.
 *
 * Hash links do not detect tail truncation — if the last messages from a peer
 * are dropped and nothing later arrives, there is no dangling parent. So
 * `hasGaps: false` means "no detected gap", never "nothing is missing", and no
 * string may imply the latter.
 */
export const GapSchema = z.object({
  gapId: z.string(),
  conversationId: z.string(),
  missingMsgIds: z.array(z.string()),
  detectedAt: z.number().int(),
  /** Where the hole sits in the transcript. */
  afterMsgId: z.string().nullable(),
  state: GapStateSchema,
});
export type Gap = z.infer<typeof GapSchema>;

export const GapRepairStatusSchema = z.object({
  gapId: z.string(),
  state: GapStateSchema,
  reason: ErrorCodeSchema.nullable(),
});
export type GapRepairStatus = z.infer<typeof GapRepairStatusSchema>;

/**
 * §3.9. A purge is a request, not a deletion. Both counts are here so the UI
 * can say "asked N participants to delete; M confirmed" and never "deleted".
 */
export const PurgeRequestStatusSchema = z.object({
  purgeId: z.string(),
  conversationId: z.string(),
  beforeEpoch: z.number().int().nonnegative(),
  direction: z.enum(["outbound", "inbound"]),
  askedParticipants: z.number().int().nonnegative(),
  confirmedParticipants: z.number().int().nonnegative(),
  requestedAt: z.number().int(),
});
export type PurgeRequestStatus = z.infer<typeof PurgeRequestStatusSchema>;

/**
 * §3.10. `found: false` is the single representation of non-membership and
 * arrives on the success path — there is no unknown-handle error code, in
 * either direction.
 *
 * Per the 2026-08-24 correction it is the log's assertion, not a proof: `akd`
 * 0.13 produces no non-membership proof, so the UI must not state or imply that
 * the absence was verified. No shield, no "verified: no such handle".
 */
export const DirectoryResolutionSchema = z.object({
  handle: z.string(),
  found: z.boolean(),
  identityFingerprint: z.string().nullable(),
  deviceCount: z.number().int().nonnegative(),
  entryVersion: z.number().int().nullable(),
  epoch: z.number().int().nonnegative(),
  /** Valid cosignatures from the client's own configured set. */
  witnessCosignatures: z.number().int().nonnegative(),
  /** `KT.md` §8.3 — the number the UI displays. */
  independentWitnesses: z.number().int().nonnegative(),
  thresholdMet: z.boolean(),
});
export type DirectoryResolution = z.infer<typeof DirectoryResolutionSchema>;

export const SafetyNumberSchema = z.object({
  conversationId: z.string(),
  /** Stable identity for `setVerification`. */
  digest: z.string(),
  /** Pre-grouped for human comparison. */
  displayGroups: z.array(z.string()),
  qrPayload: z.string(),
  /** ZUULI only (ADR 0006). */
  zcashMemoPayload: z.string().nullable(),
});
export type SafetyNumber = z.infer<typeof SafetyNumberSchema>;

/**
 * §3.10. Every client monitors its own handle each epoch and raises a loud,
 * non-dismissible alarm on any key change it did not initiate. That is what
 * makes an attempted MITM detectable by the victim, and it is the only thing
 * that does.
 */
export const SelfAuditStateSchema = z.object({
  lastCheckedEpoch: z.number().int().nullable(),
  lastCheckedAt: z.number().int().nullable(),
  /** `entry_version` and `prev_entry_hash` both unbroken. */
  chainIntact: z.boolean(),
  /** Entries this device did not submit. */
  unexpectedEntries: z.number().int().nonnegative(),
  running: z.boolean(),
});
export type SelfAuditState = z.infer<typeof SelfAuditStateSchema>;

export const AlarmKindSchema = z.enum([
  "identity-key-changed",
  "platform-reset",
  "self-audit-unexpected-entry",
  "queue-send-address-stolen",
  "relay-identity-mismatch",
  "witness-threshold-unmet",
  "directory-fork-evidence",
]);
export type AlarmKind = z.infer<typeof AlarmKindSchema>;

/**
 * §3.10. Acknowledging is not dismissing: the alarm stays in `listAlarms` with
 * `acknowledgedAt` set and remains visible. `dismissible` is structurally
 * `false` so no component can be written that hides it — §9 rule 4 is the rule,
 * this field is the enforcement.
 */
export const AlarmSchema = z.object({
  alarmId: z.string(),
  kind: AlarmKindSchema,
  severity: z.enum(["critical", "warning"]),
  raisedAt: z.number().int(),
  dismissible: z.literal(false),
  handle: z.string().nullable(),
  conversationId: z.string().nullable(),
  relayUrl: z.string().nullable(),
  oldFingerprint: z.string().nullable(),
  newFingerprint: z.string().nullable(),
  /** ADR 0014 platform reset — say "platform-assisted". */
  platformAssisted: z.boolean(),
  cooldownEndsAt: z.number().int().nullable(),
  acknowledgedAt: z.number().int().nullable(),
});
export type Alarm = z.infer<typeof AlarmSchema>;

export const RelayOperatorSchema = z.object({
  name: z.string(),
  contact: z.string(),
  abuseContact: z.string(),
  /** Where the operator and the hardware sit. */
  jurisdiction: z.string(),
  policyUrl: z.string(),
  sourceRepoUrl: z.string(),
  sourceCommit: z.string(),
  buildDigest: z.string(),
});
export type RelayOperator = z.infer<typeof RelayOperatorSchema>;

export const RelayWarningSchema = z.enum([
  /** Everything but the ciphertext travels in the clear. */
  "no-transport-security",
  "no-channel-binding",
  "volatile-antireplay",
  /** A token is an identifier. */
  "token-gated",
  "non-durable",
  "suspicious-padding-set",
]);
export type RelayWarning = z.infer<typeof RelayWarningSchema>;

export const RelayConfigSchema = z.object({
  relayId: z.string(),
  relayUrl: z.string(),
  connection: z.enum(["connected", "connecting", "disconnected", "refused"]),
  trusted: z.boolean(),
  operator: RelayOperatorSchema,
  warnings: z.array(RelayWarningSchema),
});
export type RelayConfig = z.infer<typeof RelayConfigSchema>;

export const RelayCapabilitiesSchema = z.object({
  paddingSizes: z.array(z.number().int().positive()),
  maxMessageTtlSeconds: z.number().int().positive(),
  idleTtlSeconds: z.number().int().positive(),
  queueCreationMode: z.enum(["open", "pow", "token"]),
  durabilityMode: z.enum(["memory", "batched", "fsync-per-append"]),
  perSourceLimits: z.boolean(),
  operator: RelayOperatorSchema,
});
export type RelayCapabilities = z.infer<typeof RelayCapabilitiesSchema>;

export const WitnessConfigSchema = z.object({
  /** The same hex witness_pk. */
  witnessId: z.string(),
  name: z.string(),
  /** Not self-asserted. */
  independent: z.boolean(),
  lastCosignedEpoch: z.number().int().nullable(),
});
export type WitnessConfig = z.infer<typeof WitnessConfigSchema>;

export const WitnessSetStateSchema = z.object({
  configured: z.number().int().nonnegative(),
  independent: z.number().int().nonnegative(),
  threshold: z.number().int().nonnegative(),
  thresholdMet: z.boolean(),
  /** True while independent === 0. */
  bootstrapDisclaimer: z.boolean(),
});
export type WitnessSetState = z.infer<typeof WitnessSetStateSchema>;

/** §11.3. ASCII only, compared as bytes, no normalization. */
export const HANDLE_PATTERN = /^[a-z0-9_]{1,30}$/;

export const MAX_HANDLE_LENGTH = 30;
