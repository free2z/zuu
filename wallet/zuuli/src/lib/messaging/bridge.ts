// Messaging bridge — the ONLY place the frontend talks to the messaging engine.
//
// Mirrors `src/lib/wallet/bridge.ts`: one method per command, `useMock()` on the
// first line of each, lazy `@tauri-apps/api/core` import so the browser bundle
// never requires it. Features import from here, never call `invoke()`.
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
 * Commands whose response is parsed in every build, not only in development.
 *
 * The symptom this file exists to prevent — a renamed engine field arriving as
 * `undefined` and rendering nothing — is a production symptom, so a guard that
 * only runs in development cannot see it, and neither can the parity test,
 * which runs against the mock. These are the small, low-frequency responses
 * where the parse costs nothing measurable; the hot list paths stay cast.
 */
const ALWAYS_PARSED = new Set([
  "get_engine_status",
  "get_device_info",
  "f2zmsg_enrollment_status",
  "f2zmsg_enroll",
  "f2zmsg_unenroll",
  "start_engine",
  "stop_engine",
]);

function checked<T>(schema: z.ZodType<T>, value: unknown, cmd: string): T {
  if (!import.meta.env.DEV && !ALWAYS_PARSED.has(cmd)) return value as T;
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `f2zmsg response for "${cmd}" does not match its declared schema: ${result.error.message}`,
    );
  }
  return result.data;
}

async function invoke<T>(
  schema: z.ZodType<T>,
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return checked(schema, await tauriInvoke(`plugin:f2zmsg|${cmd}`, args), cmd);
}

/**
 * No `plugin:` prefix, deliberately. Enrollment needs the wallet seed, and
 * every route into a plugin would put the mnemonic in the webview's JS heap —
 * garbage-collected, unzeroizable, readable by any XSS. So it is an app-crate
 * command that reads the seed in process and returns only a public summary
 * (§2.2). Do not "fix" this inconsistency.
 */
async function invokeApp<T>(
  schema: z.ZodType<T>,
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return checked(schema, await tauriInvoke(cmd, args), cmd);
}

export const messaging = {
  async getEngineStatus(): Promise<EngineStatus> {
    if (useMock()) return mockMessaging.getEngineStatus();
    return invoke(EngineStatusSchema, "get_engine_status");
  },

  /** Idempotent (§3.1). */
  async startEngine(): Promise<EngineStatus> {
    if (useMock()) return mockMessaging.startEngine();
    return invoke(EngineStatusSchema, "start_engine");
  },

  /** Closes relays and stops events; does not unenroll or discard history. */
  async stopEngine(): Promise<EngineStatus> {
    if (useMock()) return mockMessaging.stopEngine();
    return invoke(EngineStatusSchema, "stop_engine");
  },

  async getDeviceInfo(): Promise<DeviceInfo> {
    if (useMock()) return mockMessaging.getDeviceInfo();
    return invoke(DeviceInfoSchema, "get_device_info");
  },

  async listConversations(
    limit?: number,
    cursor?: string,
  ): Promise<ConversationPage> {
    if (useMock()) return mockMessaging.listConversations(limit, cursor);
    return invoke(ConversationPageSchema, "list_conversations", {
      args: { limit, cursor },
    });
  },

  async getConversation(conversationId: string): Promise<Conversation> {
    if (useMock()) return mockMessaging.getConversation(conversationId);
    return invoke(ConversationSchema, "get_conversation", {
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
    return invoke(ConversationSchema, "start_conversation", {
      args: { handle },
    });
  },

  async listContactRequests(): Promise<ContactRequest[]> {
    if (useMock()) return mockMessaging.listContactRequests();
    return invoke(z.array(ContactRequestSchema), "list_contact_requests");
  },

  async acceptContactRequest(requestId: string): Promise<Conversation> {
    if (useMock()) return mockMessaging.acceptContactRequest(requestId);
    return invoke(ConversationSchema, "accept_contact_request", {
      args: { requestId },
    });
  },

  /** `block` is local only: no server knows who talks to whom (§3.3). */
  async rejectContactRequest(requestId: string, block: boolean): Promise<void> {
    if (useMock()) return mockMessaging.rejectContactRequest(requestId, block);
    await invoke(VoidSchema, "reject_contact_request", {
      args: { requestId, block },
    });
  },

  async leaveConversation(conversationId: string): Promise<void> {
    if (useMock()) return mockMessaging.leaveConversation(conversationId);
    await invoke(VoidSchema, "leave_conversation", {
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
    return invoke(SendAcceptedSchema, "send_message", {
      args: { conversationId, body, clientRef },
    });
  },

  /** Safe after any failure, including one with an unknown outcome (§3.4). */
  async retrySend(msgId: string): Promise<SendAccepted> {
    if (useMock()) return mockMessaging.retrySend(msgId);
    return invoke(SendAcceptedSchema, "retry_send", { args: { msgId } });
  },

  async cancelSend(msgId: string): Promise<void> {
    if (useMock()) return mockMessaging.cancelSend(msgId);
    await invoke(VoidSchema, "cancel_send", { args: { msgId } });
  },

  async listMessages(
    conversationId: string,
    limit: number,
    before?: string,
    after?: string,
  ): Promise<MessagePage> {
    if (useMock())
      return mockMessaging.listMessages(conversationId, limit, before, after);
    return invoke(MessagePageSchema, "list_messages", {
      args: { conversationId, limit, before, after },
    });
  },

  async getMessage(msgId: string): Promise<Message> {
    if (useMock()) return mockMessaging.getMessage(msgId);
    return invoke(MessageSchema, "get_message", { args: { msgId } });
  },

  async getDeliveryState(msgId: string): Promise<DeliveryStatus> {
    if (useMock()) return mockMessaging.getDeliveryState(msgId);
    return invoke(DeliveryStatusSchema, "get_delivery_state", {
      args: { msgId },
    });
  },

  async markRead(conversationId: string, upToMsgId: string): Promise<void> {
    if (useMock()) return mockMessaging.markRead(conversationId, upToMsgId);
    await invoke(VoidSchema, "mark_read", {
      args: { conversationId, upToMsgId },
    });
  },

  async getReceiptPolicy(conversationId: string): Promise<ReceiptPolicy> {
    if (useMock()) return mockMessaging.getReceiptPolicy(conversationId);
    return invoke(ReceiptPolicySchema, "get_receipt_policy", {
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
    return invoke(ReceiptPolicySchema, "set_receipt_policy", {
      args: { conversationId, deliveryReceipts, readReceipts },
    });
  },

  async listGaps(conversationId: string): Promise<Gap[]> {
    if (useMock()) return mockMessaging.listGaps(conversationId);
    return invoke(z.array(GapSchema), "list_gaps", {
      args: { conversationId },
    });
  },

  async requestGapRepair(
    conversationId: string,
    gapIds: string[],
  ): Promise<GapRepairStatus[]> {
    if (useMock())
      return mockMessaging.requestGapRepair(conversationId, gapIds);
    return invoke(z.array(GapRepairStatusSchema), "request_gap_repair", {
      args: { conversationId, gapIds },
    });
  },

  /** No `conversationId` returns the global policy (§3.7). */
  async getRetentionPolicy(conversationId?: string): Promise<RetentionPolicy> {
    if (useMock()) return mockMessaging.getRetentionPolicy(conversationId);
    return invoke(RetentionPolicySchema, "get_retention_policy", {
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
    return invoke(RetentionPolicySchema, "set_retention_policy", {
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
    return invoke(EphemeralHintStateSchema, "send_ephemeral_hint", {
      args: { conversationId, mode, ttlSeconds },
    });
  },

  async getEphemeralHint(
    conversationId: string,
  ): Promise<EphemeralHintState | null> {
    if (useMock()) return mockMessaging.getEphemeralHint(conversationId);
    return invoke(EphemeralHintStateSchema.nullable(), "get_ephemeral_hint", {
      args: { conversationId },
    });
  },

  async sendPurgeRequest(
    conversationId: string,
    beforeEpoch: number,
  ): Promise<PurgeRequestStatus> {
    if (useMock())
      return mockMessaging.sendPurgeRequest(conversationId, beforeEpoch);
    return invoke(PurgeRequestStatusSchema, "send_purge_request", {
      args: { conversationId, beforeEpoch },
    });
  },

  async listPurgeRequests(
    conversationId: string,
  ): Promise<PurgeRequestStatus[]> {
    if (useMock()) return mockMessaging.listPurgeRequests(conversationId);
    return invoke(z.array(PurgeRequestStatusSchema), "list_purge_requests", {
      args: { conversationId },
    });
  },

  /**
   * An unregistered handle is an answer, not a failure: this succeeds with
   * `found: false` and there is no unknown-handle error code (§3.10).
   */
  async resolveHandle(handle: string): Promise<DirectoryResolution> {
    if (useMock()) return mockMessaging.resolveHandle(handle);
    return invoke(DirectoryResolutionSchema, "resolve_handle", {
      args: { handle },
    });
  },

  async checkHandleEligibility(username: string): Promise<HandleEligibility> {
    if (useMock()) return mockMessaging.checkHandleEligibility(username);
    return invoke(HandleEligibilitySchema, "check_handle_eligibility", {
      args: { username },
    });
  },

  async getSafetyNumber(conversationId: string): Promise<SafetyNumber> {
    if (useMock()) return mockMessaging.getSafetyNumber(conversationId);
    return invoke(SafetyNumberSchema, "get_safety_number", {
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
    return invoke(VerificationStateSchema, "set_verification", {
      args: { conversationId, safetyNumberDigest, verified },
    });
  },

  async getSelfAuditState(): Promise<SelfAuditState> {
    if (useMock()) return mockMessaging.getSelfAuditState();
    return invoke(SelfAuditStateSchema, "get_self_audit_state");
  },

  async listAlarms(): Promise<Alarm[]> {
    if (useMock()) return mockMessaging.listAlarms();
    return invoke(z.array(AlarmSchema), "list_alarms");
  },

  /** Acknowledging is not dismissing: the alarm stays visible (§3.10). */
  async acknowledgeAlarm(
    alarmId: string,
    confirmation: string,
  ): Promise<Alarm> {
    if (useMock()) return mockMessaging.acknowledgeAlarm(alarmId, confirmation);
    return invoke(AlarmSchema, "acknowledge_alarm", {
      args: { alarmId, confirmation },
    });
  },

  async listRelays(): Promise<RelayConfig[]> {
    if (useMock()) return mockMessaging.listRelays();
    return invoke(z.array(RelayConfigSchema), "list_relays");
  },

  async addRelay(relayUrl: string): Promise<RelayConfig> {
    if (useMock()) return mockMessaging.addRelay(relayUrl);
    return invoke(RelayConfigSchema, "add_relay", { args: { relayUrl } });
  },

  async removeRelay(relayId: string): Promise<void> {
    if (useMock()) return mockMessaging.removeRelay(relayId);
    await invoke(VoidSchema, "remove_relay", { args: { relayId } });
  },

  async getRelayCapabilities(relayId: string): Promise<RelayCapabilities> {
    if (useMock()) return mockMessaging.getRelayCapabilities(relayId);
    return invoke(RelayCapabilitiesSchema, "get_relay_capabilities", {
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
    return invoke(RelayConfigSchema, "set_relay_trust", {
      args: { relayId, allowInsecureTransport, allowNoChannelBinding },
    });
  },

  async listWitnesses(): Promise<WitnessConfig[]> {
    if (useMock()) return mockMessaging.listWitnesses();
    return invoke(z.array(WitnessConfigSchema), "list_witnesses");
  },

  async setWitnessSet(
    witnesses: string[],
    threshold: number,
  ): Promise<WitnessSetState> {
    if (useMock()) return mockMessaging.setWitnessSet(witnesses, threshold);
    return invoke(WitnessSetStateSchema, "set_witness_set", {
      args: { witnesses, threshold },
    });
  },

  async getWitnessSetState(): Promise<WitnessSetState> {
    if (useMock()) return mockMessaging.getWitnessSetState();
    return invoke(WitnessSetStateSchema, "get_witness_set_state");
  },
};

export const enrollment = {
  async getEnrollmentStatus(): Promise<EnrollmentStatus> {
    if (useMock()) return mockMessaging.getEnrollmentStatus();
    return invokeApp(EnrollmentStatusSchema, "f2zmsg_enrollment_status");
  },

  /**
   * A directory submission, not an instant effect: `mergedAtEpoch` stays null
   * until the log merges it, and the UI shows "submitted", not "active" (§3.2).
   */
  async enroll(handle: string): Promise<EnrollmentStatus> {
    if (useMock()) return mockMessaging.enroll(handle);
    return invokeApp(EnrollmentStatusSchema, "f2zmsg_enroll", {
      args: { handle },
    });
  },

  async unenroll(confirmation: string): Promise<EnrollmentStatus> {
    if (useMock()) return mockMessaging.unenroll(confirmation);
    return invokeApp(EnrollmentStatusSchema, "f2zmsg_unenroll", {
      args: { confirmation },
    });
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
} as const;

export type BridgeMethod = keyof typeof RESULTS;

export const ALL_BRIDGE_METHODS = {
  ...messaging,
  ...enrollment,
} as const;
