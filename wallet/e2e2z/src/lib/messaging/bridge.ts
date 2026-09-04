// Messaging bridge — the ONLY place the frontend talks to the messaging engine.
//
// One method per command, `useMock()` on the first line of each, lazy
// `@tauri-apps/api/core` import so the browser bundle never requires it.
// Features import from here, never call `invoke()`.
//
// Moved from `wallet/zuuli/src/lib/messaging/bridge.ts` in #904 phase 3. The
// forty-three plugin commands are unchanged; the enrollment trio is refused
// here rather than invoked, because e2e2z holds no wallet seed — see
// `EnrollmentUnavailableError` below.
//
// `docs/e2ee/CLIENT-CONTRACT.md` §4.

import { useMock } from "../platform";
import { mockMessaging } from "./mock";
import {
  AlarmSchema,
  ContactRequestSchema,
  ConversationPageSchema,
  ConversationSchema,
  DeliveryStatusSchema,
  DeviceInfoSchema,
  DirectoryResolutionSchema,
  EngineStatusSchema,
  EnrollmentStatusSchema,
  EphemeralHintStateSchema,
  GapRepairStatusSchema,
  GapSchema,
  HandleEligibilitySchema,
  MessagePageSchema,
  MessageSchema,
  PurgeRequestStatusSchema,
  ReceiptPolicySchema,
  RelayCapabilitiesSchema,
  RelayConfigSchema,
  RetentionPolicySchema,
  SafetyNumberSchema,
  SelfAuditStateSchema,
  SendAcceptedSchema,
  VerificationStateSchema,
  VoidSchema,
  WitnessConfigSchema,
  WitnessSetStateSchema,
  type Alarm,
  type ContactRequest,
  type Conversation,
  type ConversationPage,
  type DeliveryStatus,
  type DeviceInfo,
  type DirectoryResolution,
  type EngineStatus,
  type EnrollmentStatus,
  type EphemeralHintState,
  type Gap,
  type GapRepairStatus,
  type HandleEligibility,
  type Message,
  type MessagePage,
  type PurgeRequestStatus,
  type ReceiptPolicy,
  type RelayCapabilities,
  type RelayConfig,
  type RetentionPolicy,
  type SafetyNumber,
  type SelfAuditState,
  type SendAccepted,
  type VerificationState,
  type WitnessConfig,
  type WitnessSetState,
} from "./types";
import { z } from "zod";

/**
 * The wire name of every bridge method, in one place.
 *
 * This is the module's single population: `BridgeMethod` is its keys, `RESULTS`
 * must cover exactly those keys, and `ALWAYS_PARSED` is typed against them. A
 * renamed command is therefore a compile error in every consumer rather than a
 * string that silently stops matching.
 *
 * The enrollment trio carries no `plugin:` prefix (§2.2); the prefix is applied
 * by `invoke` and not by these names.
 */
export const WIRE_COMMANDS = {
  getEngineStatus: "get_engine_status",
  startEngine: "start_engine",
  stopEngine: "stop_engine",
  getDeviceInfo: "get_device_info",
  listConversations: "list_conversations",
  getConversation: "get_conversation",
  startConversation: "start_conversation",
  listContactRequests: "list_contact_requests",
  acceptContactRequest: "accept_contact_request",
  rejectContactRequest: "reject_contact_request",
  leaveConversation: "leave_conversation",
  sendMessage: "send_message",
  retrySend: "retry_send",
  cancelSend: "cancel_send",
  listMessages: "list_messages",
  getMessage: "get_message",
  getDeliveryState: "get_delivery_state",
  markRead: "mark_read",
  getReceiptPolicy: "get_receipt_policy",
  setReceiptPolicy: "set_receipt_policy",
  listGaps: "list_gaps",
  requestGapRepair: "request_gap_repair",
  getRetentionPolicy: "get_retention_policy",
  setRetentionPolicy: "set_retention_policy",
  sendEphemeralHint: "send_ephemeral_hint",
  getEphemeralHint: "get_ephemeral_hint",
  sendPurgeRequest: "send_purge_request",
  listPurgeRequests: "list_purge_requests",
  resolveHandle: "resolve_handle",
  checkHandleEligibility: "check_handle_eligibility",
  getSafetyNumber: "get_safety_number",
  setVerification: "set_verification",
  getSelfAuditState: "get_self_audit_state",
  listAlarms: "list_alarms",
  acknowledgeAlarm: "acknowledge_alarm",
  listRelays: "list_relays",
  addRelay: "add_relay",
  removeRelay: "remove_relay",
  getRelayCapabilities: "get_relay_capabilities",
  setRelayTrust: "set_relay_trust",
  listWitnesses: "list_witnesses",
  setWitnessSet: "set_witness_set",
  getWitnessSetState: "get_witness_set_state",
  getEnrollmentStatus: "f2zmsg_enrollment_status",
  enroll: "f2zmsg_enroll",
  unenroll: "f2zmsg_unenroll",
} as const;

export type BridgeMethod = keyof typeof WIRE_COMMANDS;
export type WireCommand = (typeof WIRE_COMMANDS)[BridgeMethod];

/**
 * Commands whose response is parsed in every build, not only in development.
 *
 * The symptom this file exists to prevent — a renamed engine field arriving as
 * `undefined` and rendering nothing — is a production symptom, so a guard that
 * only runs in development cannot see it, and neither can the parity test,
 * which runs against the mock. These are the small, low-frequency responses
 * where the parse costs nothing measurable; the hot list paths stay cast.
 */
const ALWAYS_PARSED: ReadonlySet<BridgeMethod> = new Set<BridgeMethod>([
  "getEngineStatus",
  "getDeviceInfo",
  "getEnrollmentStatus",
  "enroll",
  "unenroll",
  "startEngine",
  "stopEngine",
]);

function checked<T>(
  schema: z.ZodType<T>,
  value: unknown,
  method: BridgeMethod,
): T {
  if (!import.meta.env.DEV && !ALWAYS_PARSED.has(method)) return value as T;
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `f2zmsg response for "${WIRE_COMMANDS[method]}" does not match its declared schema: ${result.error.message}`,
    );
  }
  return result.data;
}

async function invoke<T>(
  schema: z.ZodType<T>,
  method: BridgeMethod,
  args?: Record<string, unknown>,
): Promise<T> {
  const cmd = WIRE_COMMANDS[method];
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return checked(
    schema,
    await tauriInvoke(`plugin:f2zmsg|${cmd}`, args),
    method,
  );
}

/**
 * The enrollment gap, and why it is a gap rather than an implementation.
 *
 * In ZUULI these three are app-crate commands with no `plugin:` prefix (§2.2):
 * enrollment needs the wallet seed, and every route into a plugin would put the
 * mnemonic in the webview's garbage-collected JS heap, so `messaging.rs` reads
 * the seed **in process** from `tauri-plugin-zcash` and derives
 * `ARCHITECTURE.md` §4.2's account keys there.
 *
 * e2e2z has no seed, by construction and permanently (#904): it links no
 * `tauri-plugin-zcash`, holds no mnemonic, and must never be able to obtain
 * one. §4.2 is precisely what makes that workable — *ongoing* messaging needs
 * only device keys (OS CSPRNG, never seed-derived, never exported) plus a
 * `DeviceCredential`. Only enrollment needs the seed, and issuing that
 * credential is therefore the wallet authority's job.
 *
 * The path is the `issue-device-credential` intent (#905,
 * `rs/crates/f2z-intent`), and it cannot ship yet: custom-scheme deep links are
 * not an authenticated channel, so the cross-surface protocol is blocked on
 * #461. Until it lands there is no honest local implementation, so this app has
 * no enrollment command, no capability addressing one, and — here — no stub
 * that can be mistaken for one. Every call refuses with a distinct, typed
 * refusal the UI presents as "enrollment happens in the wallet app".
 *
 * What must NOT be done in its place: synthesizing an `EnrollmentStatus`. Every
 * field of one is a claim about the key-transparency directory, and a
 * fabricated `enrolled: true` would make this app render a handle nobody
 * published and offer first contact it cannot complete. Failing closed is the
 * only answer that stays true.
 *
 * `enroll` is no longer a bare refusal: it runs `../enrollment`'s real
 * `issue-device-credential` client, which builds the request the wallet
 * authority would answer and fails at the one seam that has no implementation.
 * The refusal it produces is wrapped back into this type, with the underlying
 * cause attached, so every consumer's branch is unchanged and no shipping build
 * can reach an `EnrollmentStatus` by that path either.
 */
export class EnrollmentUnavailableError extends Error {
  /** Machine-readable, so a caller never has to match on the message. */
  readonly reason = "enrollment-requires-wallet-app" as const;
  /** The bridge method that was refused, for logs and tests. */
  readonly method: BridgeMethod;
  /**
   * What actually stopped the call, when something did.
   *
   * Declared here rather than passed to `Error`'s `options.cause`, which is
   * ES2022 and this app compiles to ES2020. A boundary that summarised the
   * failure and discarded it would make every enrollment bug read the same in
   * a report, which is exactly the state #904 is trying to leave.
   */
  readonly cause?: unknown;

  constructor(method: BridgeMethod, options?: { cause?: unknown }) {
    super(
      `${WIRE_COMMANDS[method]} is unavailable in e2e2z: enrollment derives ` +
        "account keys from the wallet seed, which this app never holds. Enroll " +
        "in the wallet app (see issue #905, blocked on #461).",
    );
    this.name = "EnrollmentUnavailableError";
    this.method = method;
    this.cause = options?.cause;
  }
}

export function isEnrollmentUnavailable(
  error: unknown,
): error is EnrollmentUnavailableError {
  return (
    error instanceof EnrollmentUnavailableError ||
    // Survives a structured-clone or a re-thrown copy across a module boundary.
    (typeof error === "object" &&
      error !== null &&
      (error as { reason?: unknown }).reason === "enrollment-requires-wallet-app")
  );
}

/**
 * The refusal itself. It never reaches `@tauri-apps/api/core`: there is no
 * command on the other side, and letting Tauri answer "command not found"
 * would turn a designed boundary into a runtime accident that reads like a
 * packaging bug.
 */
function refuseEnrollment(method: BridgeMethod): never {
  throw new EnrollmentUnavailableError(method);
}

export const messaging = {
  async getEngineStatus(): Promise<EngineStatus> {
    if (useMock()) return mockMessaging.getEngineStatus();
    return invoke(EngineStatusSchema, "getEngineStatus");
  },

  /** Idempotent (§3.1). */
  async startEngine(): Promise<EngineStatus> {
    if (useMock()) return mockMessaging.startEngine();
    return invoke(EngineStatusSchema, "startEngine");
  },

  /** Closes relays and stops events; does not unenroll or discard history. */
  async stopEngine(): Promise<EngineStatus> {
    if (useMock()) return mockMessaging.stopEngine();
    return invoke(EngineStatusSchema, "stopEngine");
  },

  async getDeviceInfo(): Promise<DeviceInfo> {
    if (useMock()) return mockMessaging.getDeviceInfo();
    return invoke(DeviceInfoSchema, "getDeviceInfo");
  },

  async listConversations(
    limit?: number,
    cursor?: string,
  ): Promise<ConversationPage> {
    if (useMock()) return mockMessaging.listConversations(limit, cursor);
    return invoke(ConversationPageSchema, "listConversations", {
      args: { limit, cursor },
    });
  },

  async getConversation(conversationId: string): Promise<Conversation> {
    if (useMock()) return mockMessaging.getConversation(conversationId);
    return invoke(ConversationSchema, "getConversation", {
      args: { conversationId },
    });
  },

  /**
   * Runs the whole first-contact handshake, including proof of work on this
   * device. It can take seconds and the delay is computation, not network —
   * show it as work. It fails closed when the witness threshold is unmet:
   * resolving a new handle is refused, not degraded (§3.3, §9 rule 5).
   */
  async startConversation(handle: string): Promise<Conversation> {
    if (useMock()) return mockMessaging.startConversation(handle);
    return invoke(ConversationSchema, "startConversation", {
      args: { handle },
    });
  },

  async listContactRequests(): Promise<ContactRequest[]> {
    if (useMock()) return mockMessaging.listContactRequests();
    return invoke(z.array(ContactRequestSchema), "listContactRequests");
  },

  async acceptContactRequest(requestId: string): Promise<Conversation> {
    if (useMock()) return mockMessaging.acceptContactRequest(requestId);
    return invoke(ConversationSchema, "acceptContactRequest", {
      args: { requestId },
    });
  },

  /** `block` is local only: no server knows who talks to whom (§3.3). */
  async rejectContactRequest(requestId: string, block: boolean): Promise<void> {
    if (useMock()) return mockMessaging.rejectContactRequest(requestId, block);
    await invoke(VoidSchema, "rejectContactRequest", {
      args: { requestId, block },
    });
  },

  async leaveConversation(conversationId: string): Promise<void> {
    if (useMock()) return mockMessaging.leaveConversation(conversationId);
    await invoke(VoidSchema, "leaveConversation", {
      args: { conversationId },
    });
  },

  async sendMessage(
    conversationId: string,
    body: string,
    clientRef: string,
  ): Promise<SendAccepted> {
    if (useMock())
      return mockMessaging.sendMessage(conversationId, body, clientRef);
    return invoke(SendAcceptedSchema, "sendMessage", {
      args: { conversationId, body, clientRef },
    });
  },

  /** Safe after any failure, including one with an unknown outcome (§3.4). */
  async retrySend(msgId: string): Promise<SendAccepted> {
    if (useMock()) return mockMessaging.retrySend(msgId);
    return invoke(SendAcceptedSchema, "retrySend", { args: { msgId } });
  },

  async cancelSend(msgId: string): Promise<void> {
    if (useMock()) return mockMessaging.cancelSend(msgId);
    await invoke(VoidSchema, "cancelSend", { args: { msgId } });
  },

  async listMessages(
    conversationId: string,
    limit: number,
    before?: string,
    after?: string,
  ): Promise<MessagePage> {
    if (useMock())
      return mockMessaging.listMessages(conversationId, limit, before, after);
    return invoke(MessagePageSchema, "listMessages", {
      args: { conversationId, limit, before, after },
    });
  },

  async getMessage(msgId: string): Promise<Message> {
    if (useMock()) return mockMessaging.getMessage(msgId);
    return invoke(MessageSchema, "getMessage", { args: { msgId } });
  },

  async getDeliveryState(msgId: string): Promise<DeliveryStatus> {
    if (useMock()) return mockMessaging.getDeliveryState(msgId);
    return invoke(DeliveryStatusSchema, "getDeliveryState", {
      args: { msgId },
    });
  },

  async markRead(conversationId: string, upToMsgId: string): Promise<void> {
    if (useMock()) return mockMessaging.markRead(conversationId, upToMsgId);
    await invoke(VoidSchema, "markRead", {
      args: { conversationId, upToMsgId },
    });
  },

  async getReceiptPolicy(conversationId: string): Promise<ReceiptPolicy> {
    if (useMock()) return mockMessaging.getReceiptPolicy(conversationId);
    return invoke(ReceiptPolicySchema, "getReceiptPolicy", {
      args: { conversationId },
    });
  },

  async setReceiptPolicy(
    conversationId: string,
    deliveryReceipts: boolean,
    readReceipts: boolean,
  ): Promise<ReceiptPolicy> {
    if (useMock())
      return mockMessaging.setReceiptPolicy(
        conversationId,
        deliveryReceipts,
        readReceipts,
      );
    return invoke(ReceiptPolicySchema, "setReceiptPolicy", {
      args: { conversationId, deliveryReceipts, readReceipts },
    });
  },

  async listGaps(conversationId: string): Promise<Gap[]> {
    if (useMock()) return mockMessaging.listGaps(conversationId);
    return invoke(z.array(GapSchema), "listGaps", {
      args: { conversationId },
    });
  },

  async requestGapRepair(
    conversationId: string,
    gapIds: string[],
  ): Promise<GapRepairStatus[]> {
    if (useMock())
      return mockMessaging.requestGapRepair(conversationId, gapIds);
    return invoke(z.array(GapRepairStatusSchema), "requestGapRepair", {
      args: { conversationId, gapIds },
    });
  },

  /** No `conversationId` returns the global policy (§3.7). */
  async getRetentionPolicy(conversationId?: string): Promise<RetentionPolicy> {
    if (useMock()) return mockMessaging.getRetentionPolicy(conversationId);
    return invoke(RetentionPolicySchema, "getRetentionPolicy", {
      args: { conversationId },
    });
  },

  /**
   * `scope` says which policy is being written. Global takes no
   * `conversationId` and passing one is a client bug; conversation requires it
   * and overrides the global policy for that conversation only.
   *
   * Shortening retention shortens the gap-repair window — say that at the
   * moment the user shortens it, not in a help page (§3.7).
   */
  async setRetentionPolicy(
    scope: "global" | "conversation",
    mode: "keep" | "expire",
    ttlSeconds: number | null,
    conversationId?: string,
  ): Promise<RetentionPolicy> {
    if (useMock())
      return mockMessaging.setRetentionPolicy(
        scope,
        mode,
        ttlSeconds,
        conversationId,
      );
    return invoke(RetentionPolicySchema, "setRetentionPolicy", {
      args: { scope, conversationId, mode, ttlSeconds },
    });
  },

  async sendEphemeralHint(
    conversationId: string,
    mode: "ephemeral" | "retained",
    ttlSeconds: number | null,
  ): Promise<EphemeralHintState> {
    if (useMock())
      return mockMessaging.sendEphemeralHint(conversationId, mode, ttlSeconds);
    return invoke(EphemeralHintStateSchema, "sendEphemeralHint", {
      args: { conversationId, mode, ttlSeconds },
    });
  },

  async getEphemeralHint(
    conversationId: string,
  ): Promise<EphemeralHintState | null> {
    if (useMock()) return mockMessaging.getEphemeralHint(conversationId);
    return invoke(EphemeralHintStateSchema.nullable(), "getEphemeralHint", {
      args: { conversationId },
    });
  },

  async sendPurgeRequest(
    conversationId: string,
    beforeEpoch: number,
  ): Promise<PurgeRequestStatus> {
    if (useMock())
      return mockMessaging.sendPurgeRequest(conversationId, beforeEpoch);
    return invoke(PurgeRequestStatusSchema, "sendPurgeRequest", {
      args: { conversationId, beforeEpoch },
    });
  },

  async listPurgeRequests(
    conversationId: string,
  ): Promise<PurgeRequestStatus[]> {
    if (useMock()) return mockMessaging.listPurgeRequests(conversationId);
    return invoke(z.array(PurgeRequestStatusSchema), "listPurgeRequests", {
      args: { conversationId },
    });
  },

  /**
   * An unregistered handle is an answer, not a failure: this succeeds with
   * `found: false` and there is no unknown-handle error code (§3.10).
   */
  async resolveHandle(handle: string): Promise<DirectoryResolution> {
    if (useMock()) return mockMessaging.resolveHandle(handle);
    return invoke(DirectoryResolutionSchema, "resolveHandle", {
      args: { handle },
    });
  },

  async checkHandleEligibility(username: string): Promise<HandleEligibility> {
    if (useMock()) return mockMessaging.checkHandleEligibility(username);
    return invoke(HandleEligibilitySchema, "checkHandleEligibility", {
      args: { username },
    });
  },

  async getSafetyNumber(conversationId: string): Promise<SafetyNumber> {
    if (useMock()) return mockMessaging.getSafetyNumber(conversationId);
    return invoke(SafetyNumberSchema, "getSafetyNumber", {
      args: { conversationId },
    });
  },

  async setVerification(
    conversationId: string,
    safetyNumberDigest: string,
    verified: boolean,
  ): Promise<VerificationState> {
    if (useMock())
      return mockMessaging.setVerification(
        conversationId,
        safetyNumberDigest,
        verified,
      );
    return invoke(VerificationStateSchema, "setVerification", {
      args: { conversationId, safetyNumberDigest, verified },
    });
  },

  async getSelfAuditState(): Promise<SelfAuditState> {
    if (useMock()) return mockMessaging.getSelfAuditState();
    return invoke(SelfAuditStateSchema, "getSelfAuditState");
  },

  async listAlarms(): Promise<Alarm[]> {
    if (useMock()) return mockMessaging.listAlarms();
    return invoke(z.array(AlarmSchema), "listAlarms");
  },

  /** Acknowledging is not dismissing: the alarm stays visible (§3.10). */
  async acknowledgeAlarm(
    alarmId: string,
    confirmation: string,
  ): Promise<Alarm> {
    if (useMock()) return mockMessaging.acknowledgeAlarm(alarmId, confirmation);
    return invoke(AlarmSchema, "acknowledgeAlarm", {
      args: { alarmId, confirmation },
    });
  },

  async listRelays(): Promise<RelayConfig[]> {
    if (useMock()) return mockMessaging.listRelays();
    return invoke(z.array(RelayConfigSchema), "listRelays");
  },

  async addRelay(relayUrl: string): Promise<RelayConfig> {
    if (useMock()) return mockMessaging.addRelay(relayUrl);
    return invoke(RelayConfigSchema, "addRelay", { args: { relayUrl } });
  },

  async removeRelay(relayId: string): Promise<void> {
    if (useMock()) return mockMessaging.removeRelay(relayId);
    await invoke(VoidSchema, "removeRelay", { args: { relayId } });
  },

  async getRelayCapabilities(relayId: string): Promise<RelayCapabilities> {
    if (useMock()) return mockMessaging.getRelayCapabilities(relayId);
    return invoke(RelayCapabilitiesSchema, "getRelayCapabilities", {
      args: { relayId },
    });
  },

  async setRelayTrust(
    relayId: string,
    allowInsecureTransport: boolean,
    allowNoChannelBinding: boolean,
  ): Promise<RelayConfig> {
    if (useMock())
      return mockMessaging.setRelayTrust(
        relayId,
        allowInsecureTransport,
        allowNoChannelBinding,
      );
    return invoke(RelayConfigSchema, "setRelayTrust", {
      args: { relayId, allowInsecureTransport, allowNoChannelBinding },
    });
  },

  async listWitnesses(): Promise<WitnessConfig[]> {
    if (useMock()) return mockMessaging.listWitnesses();
    return invoke(z.array(WitnessConfigSchema), "listWitnesses");
  },

  async setWitnessSet(
    witnesses: string[],
    threshold: number,
  ): Promise<WitnessSetState> {
    if (useMock()) return mockMessaging.setWitnessSet(witnesses, threshold);
    return invoke(WitnessSetStateSchema, "setWitnessSet", {
      args: { witnesses, threshold },
    });
  },

  async getWitnessSetState(): Promise<WitnessSetState> {
    if (useMock()) return mockMessaging.getWitnessSetState();
    return invoke(WitnessSetStateSchema, "getWitnessSetState");
  },
};

/**
 * The enrollment trio, kept in the bridge's population and refused at its
 * boundary — see [`EnrollmentUnavailableError`].
 *
 * They stay named here rather than being deleted because `WIRE_COMMANDS`,
 * `RESULTS` and `BridgeMethod` are one population that `parity.test.ts` and
 * `wallet/zuuli/scripts/messaging-contract.node-test.mjs` hold to §3 of
 * `docs/e2ee/CLIENT-CONTRACT.md`. Deleting them would silently shrink the
 * contract instead of recording that this app cannot serve them.
 *
 * `useMock()` still answers first, and only there: `VITE_MOCK=1` is an explicit
 * build-time opt-in that replaces the entire data layer with fixtures for
 * offline UI work and the browser test run. It is never set in a packaged
 * build, so no shipped e2e2z can reach a mocked enrollment.
 */
export const enrollment = {
  async getEnrollmentStatus(): Promise<EnrollmentStatus> {
    if (useMock()) return mockMessaging.getEnrollmentStatus();
    return refuseEnrollment("getEnrollmentStatus");
  },

  /**
   * In ZUULI: a directory submission, not an instant effect. Here: an
   * `issue-device-credential` intent addressed to the wallet authority, which
   * holds the seed-derived §4.2 `IdentitySigningKey` this app never will.
   *
   * The request is built for real — through `@free2z/wallet-shared`, over this
   * device's OS-CSPRNG public keys, byte-identical to what `f2z-intent` parses
   * — and then fails at the transport, because there is no channel that
   * authenticates either end (`docs/intent-bridge/PROTOCOL.md` §7, #461).
   *
   * **It can only reject.** The declared return type is `EnrollmentStatus` and
   * there is no expression in this function that produces one: even a
   * successful round trip yields a `DeviceCredential`, which has to be
   * installed before any status could be read back, and installing it is
   * `install_identity`'s job in a process this app does not have a command for.
   * The refusal is re-wrapped so the screen's branch stays the one it was.
   */
  async enroll(handle: string): Promise<EnrollmentStatus> {
    if (useMock()) return mockMessaging.enroll(handle);
    const { createDeviceCredentialClient } = await import(
      "../enrollment/issueDeviceCredential"
    );
    try {
      await createDeviceCredentialClient().requestDeviceCredential(handle);
    } catch (cause) {
      throw new EnrollmentUnavailableError("enroll", { cause });
    }
    // Unreachable while no transport exists, and it must stay unreachable in
    // the sense that matters: a credential is not a status, and this app has no
    // way to install one. Refusing here rather than returning a shape is what
    // keeps `enrolled: true` unfabricatable.
    return refuseEnrollment("enroll");
  },

  async unenroll(confirmation: string): Promise<EnrollmentStatus> {
    if (useMock()) return mockMessaging.unenroll(confirmation);
    void confirmation;
    return refuseEnrollment("unenroll");
  },
};

/**
 * Every bridge method mapped to its result schema. The parity test asserts
 * these keys equal the bridge's own, so a command added without a schema fails
 * the build rather than review (§4.1).
 */
export const RESULTS = {
  getEngineStatus: EngineStatusSchema,
  startEngine: EngineStatusSchema,
  stopEngine: EngineStatusSchema,
  getDeviceInfo: DeviceInfoSchema,
  getEnrollmentStatus: EnrollmentStatusSchema,
  enroll: EnrollmentStatusSchema,
  unenroll: EnrollmentStatusSchema,
  listConversations: ConversationPageSchema,
  getConversation: ConversationSchema,
  startConversation: ConversationSchema,
  listContactRequests: z.array(ContactRequestSchema),
  acceptContactRequest: ConversationSchema,
  rejectContactRequest: VoidSchema,
  leaveConversation: VoidSchema,
  sendMessage: SendAcceptedSchema,
  retrySend: SendAcceptedSchema,
  cancelSend: VoidSchema,
  listMessages: MessagePageSchema,
  getMessage: MessageSchema,
  getDeliveryState: DeliveryStatusSchema,
  markRead: VoidSchema,
  getReceiptPolicy: ReceiptPolicySchema,
  setReceiptPolicy: ReceiptPolicySchema,
  listGaps: z.array(GapSchema),
  requestGapRepair: z.array(GapRepairStatusSchema),
  getRetentionPolicy: RetentionPolicySchema,
  setRetentionPolicy: RetentionPolicySchema,
  sendEphemeralHint: EphemeralHintStateSchema,
  getEphemeralHint: EphemeralHintStateSchema.nullable(),
  sendPurgeRequest: PurgeRequestStatusSchema,
  listPurgeRequests: z.array(PurgeRequestStatusSchema),
  resolveHandle: DirectoryResolutionSchema,
  checkHandleEligibility: HandleEligibilitySchema,
  getSafetyNumber: SafetyNumberSchema,
  setVerification: VerificationStateSchema,
  getSelfAuditState: SelfAuditStateSchema,
  listAlarms: z.array(AlarmSchema),
  acknowledgeAlarm: AlarmSchema,
  listRelays: z.array(RelayConfigSchema),
  addRelay: RelayConfigSchema,
  removeRelay: VoidSchema,
  getRelayCapabilities: RelayCapabilitiesSchema,
  setRelayTrust: RelayConfigSchema,
  listWitnesses: z.array(WitnessConfigSchema),
  setWitnessSet: WitnessSetStateSchema,
  getWitnessSetState: WitnessSetStateSchema,
} as const satisfies Record<BridgeMethod, z.ZodTypeAny>;

export const ALL_BRIDGE_METHODS = {
  ...messaging,
  ...enrollment,
} as const;
