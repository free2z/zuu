// A self-contained in-memory messaging engine, so every screen is buildable
// and screenshotable in a plain browser with no Rust backend (§4).
//
// It generates inbound traffic rather than only answering commands: the inbox,
// the transcript, the delivery indicators and the gap marker are all driven by
// events, and a mock that stays silent leaves those screens built blind (§5.4).

import { emitMockEvent } from "./events";
import {
  HANDLE_PATTERN,
  MAX_HANDLE_LENGTH,
  compareMessages,
  type Alarm,
  type ContactRequest,
  type Conversation,
  type ConversationPage,
  type DeliveryState,
  type DeliveryStatus,
  type DeviceInfo,
  type DirectoryResolution,
  type EngineState,
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
  type RelayOperator,
  type RetentionPolicy,
  type SafetyNumber,
  type SelfAuditState,
  type SendAccepted,
  type VerificationState,
  type WitnessConfig,
  type WitnessSetState,
} from "./types";

const MOCK_USERNAME = "fixturecreator";
const SCENARIO_KEY = "zuuli.mock.f2zmsg-scenario";
const ECHO_DELAY_KEY = "zuuli.mock.f2zmsg-echo-delay-ms";

// Single-witness on purpose: on day one free2z runs the only relay and is
// therefore the only witness, so the threshold is unmet. Reporting it met would
// let screens be built against a state that does not exist yet, and §9 rule 5
// would go untested.
const INDEPENDENT_WITNESSES = 1;
const WITNESS_THRESHOLD = 2;

const SCENARIOS = [
  "not-enrolled",
  "ineligible-handle",
  "enrolling",
  "first-contact",
  "echo-slow",
  "gap",
  "gap-unrecoverable",
] as const;

type Scenario = (typeof SCENARIOS)[number];

// Both the try/catch and the optional chaining are load-bearing: an absent
// localStorage and a throwing one must each yield null rather than an
// exception, so production and native behavior cannot observe this.
function scenario(): Scenario | null {
  try {
    const value = globalThis.localStorage?.getItem(SCENARIO_KEY);
    return SCENARIOS.includes(value as Scenario) ? (value as Scenario) : null;
  } catch {
    return null;
  }
}

function echoDelayMs(): number {
  if (scenario() === "echo-slow") return 4000;
  try {
    const raw = globalThis.localStorage?.getItem(ECHO_DELAY_KEY);
    const parsed = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 400;
  } catch {
    return 400;
  }
}

interface MockState {
  engine: EngineState;
  enrolled: boolean;
  handle: string | null;
  directoryEntryVersion: number | null;
  submittedAt: number | null;
  mergedAtEpoch: number | null;
  relaysConnected: number;
  relaysConfigured: number;
  pendingInbound: number;
  unacknowledgedAlarms: number;
  conversations: Map<string, Conversation>;
  messages: Map<string, Message>;
  contactRequests: ContactRequest[];
  nextLeafIndex: number;
  nextEpoch: number;
  retention: RetentionPolicy;
  purges: PurgeRequestStatus[];
  alarms: Alarm[];
  relays: RelayConfig[];
  witnessThreshold: number;
  timers: ReturnType<typeof setTimeout>[];
}

const DEFAULT_CONVERSATION_ID = "conv-echo";
const ECHO_HANDLE = "echo_peer";

function defaultReceiptPolicy(): ReceiptPolicy {
  return { deliveryReceipts: true, readReceipts: false };
}

function echoConversation(): Conversation {
  const active = scenario();
  return {
    conversationId: DEFAULT_CONVERSATION_ID,
    peerHandle: ECHO_HANDLE,
    peerIdentityFingerprint: "7C4D 91E2 05AB 3F68 D172 8E30 B95C 6A4F",
    verification: { state: "unverified" },
    epoch: 1,
    createdAt: Date.UTC(2026, 7, 20),
    lastMessageAt: null,
    unreadCount: 0,
    retention: {
      scope: "global",
      mode: "keep",
      ttlSeconds: null,
      effectiveFrom: Date.UTC(2026, 7, 20),
    },
    ephemeralHint: null,
    receiptPolicy: defaultReceiptPolicy(),
    hasGaps: active === "gap" || active === "gap-unrecoverable",
    transportHealth: "ok",
  };
}

function initialState(): MockState {
  const active = scenario();
  const enrolled = active !== "not-enrolled" && active !== "ineligible-handle";

  const conversations = new Map<string, Conversation>();
  const messages = new Map<string, Message>();
  if (enrolled && active !== "enrolling") {
    const conversation = echoConversation();
    conversations.set(conversation.conversationId, conversation);
    for (const message of seedTranscript(active)) {
      messages.set(message.msgId, message);
    }
  }

  return {
    engine: enrolled
      ? active === "enrolling"
        ? "enrolling"
        : "not-enrolled"
      : active === "ineligible-handle"
        ? "ineligible"
        : "not-enrolled",
    enrolled,
    handle: enrolled ? MOCK_USERNAME : null,
    directoryEntryVersion: enrolled ? 1 : null,
    submittedAt: enrolled ? Date.UTC(2026, 7, 21) : null,
    mergedAtEpoch: enrolled && active !== "enrolling" ? 412 : null,
    relaysConnected: 0,
    relaysConfigured: 1,
    pendingInbound: 0,
    unacknowledgedAlarms: 0,
    conversations,
    messages,
    contactRequests:
      active === "first-contact"
        ? [
            {
              requestId: "req-0001",
              peerHandle: "newcomer",
              peerIdentityFingerprint:
                "2B8F 60C1 D4A7 39E5 0F26 87BD 4C31 9A0E",
              receivedAt: Date.UTC(2026, 7, 23),
              bodyPreview: null,
            },
          ]
        : [],
    nextLeafIndex: 2,
    // The seed transcript sits at epoch 1; every later message advances it, so
    // the §7 sort key orders new traffic after old rather than by leaf index
    // alone.
    nextEpoch: 2,
    retention: {
      scope: "global",
      mode: "keep",
      ttlSeconds: null,
      effectiveFrom: Date.UTC(2026, 7, 20),
    },
    purges: [],
    alarms:
      active === "gap" || active === "gap-unrecoverable"
        ? []
        : [
            {
              alarmId: "alarm-witness",
              kind: "witness-threshold-unmet",
              severity: "warning",
              raisedAt: Date.UTC(2026, 7, 24),
              dismissible: false,
              handle: null,
              oldFingerprint: null,
              newFingerprint: null,
              platformAssisted: false,
              cooldownEndsAt: null,
              acknowledgedAt: null,
            },
          ],
    relays: [
      {
        relayId: "relay-1",
        relayUrl: "wss://relay.free2z.cash",
        connection: "disconnected",
        trusted: true,
        operator: OPERATOR,
        warnings: [],
      },
    ],
    witnessThreshold: WITNESS_THRESHOLD,
    timers: [],
  };
}

function deliveryStatus(
  msgId: string,
  state: DeliveryState,
  overrides: Partial<DeliveryStatus> = {},
): DeliveryStatus {
  return {
    msgId,
    state,
    acceptedByRelays: state === "pending" ? 0 : 1,
    configuredRelays: 1,
    devicesReceipted:
      state === "device-delivered" || state === "delivered" ? 1 : 0,
    devicesExpected: 1,
    failure: null,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function textMessage(
  msgId: string,
  direction: "outbound" | "inbound",
  senderLeafIndex: number,
  text: string,
  parents: string[],
  delivery: DeliveryStatus,
  epoch = 1,
): Message {
  return {
    msgId,
    conversationId: DEFAULT_CONVERSATION_ID,
    direction,
    epoch,
    senderLeafIndex,
    parents,
    sentAt: Date.now(),
    receivedAt: direction === "inbound" ? Date.now() : null,
    body: { kind: "text", text },
    delivery,
    retentionClass: "chat",
    expiresAt: null,
  };
}

function seedTranscript(active: Scenario | null): Message[] {
  const first = textMessage(
    "aa01",
    "inbound",
    1,
    "This peer echoes whatever you send, so the transcript has real traffic.",
    [],
    deliveryStatus("aa01", "delivered"),
  );

  if (active !== "gap-unrecoverable") return [first];

  // A short local retention TTL shortens the plaintext outbox used for gap
  // repair, so some gaps cannot be repaired. That is an explicit marker in the
  // transcript and is never rendered as nothing (§3.4).
  const hole: Message = {
    ...textMessage(
      "aa02",
      "inbound",
      1,
      "",
      ["aa01"],
      deliveryStatus("aa02", "delivered"),
    ),
    body: { kind: "unrecoverable", reason: "gap-unrecoverable" },
  };
  return [first, hole];
}

const OPERATOR: RelayOperator = {
  name: "free2z",
  contact: "relay@free2z.cash",
  abuseContact: "abuse@free2z.cash",
  jurisdiction: "United States",
  policyUrl: "https://free2z.cash/relay-policy",
  sourceRepoUrl: "https://github.com/free2z/zuu",
  sourceCommit: "0000000000000000000000000000000000000000",
  buildDigest:
    "sha256:0000000000000000000000000000000000000000000000000000000000000000",
};

function seedGap(): Gap {
  return {
    gapId: "gap-0001",
    conversationId: DEFAULT_CONVERSATION_ID,
    missingMsgIds: ["missing-01"],
    detectedAt: Date.UTC(2026, 7, 23),
    afterMsgId: "aa01",
    state: scenario() === "gap-unrecoverable" ? "unrecoverable" : "detected",
  };
}

let state: MockState = initialState();

export function resetMockMessaging(): void {
  for (const timer of state.timers) clearTimeout(timer);
  state = initialState();
}

function later(fn: () => void, ms: number): void {
  state.timers.push(setTimeout(fn, ms));
}

/**
 * §11.3. Reason precedence is this function's choice, not §3.2's: non-ASCII is
 * checked before length because `toLowerCase()` can change a non-ASCII string's
 * length, reporting a number the user cannot map to what they typed.
 */
export function evaluateHandle(username: string | null): HandleEligibility {
  if (!username) {
    return { eligible: false, candidate: null, reason: "not-signed-in" };
  }
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(username)) {
    return { eligible: false, candidate: null, reason: "non-ascii" };
  }
  const candidate = username.toLowerCase();
  if (!/^[a-z0-9_]*$/.test(candidate)) {
    return { eligible: false, candidate: null, reason: "punctuation" };
  }
  if (candidate.length > MAX_HANDLE_LENGTH) {
    return { eligible: false, candidate: null, reason: "too-long" };
  }
  if (!HANDLE_PATTERN.test(candidate)) {
    return { eligible: false, candidate: null, reason: "not-signed-in" };
  }
  return { eligible: true, candidate, reason: null };
}

function engineStatus(): EngineStatus {
  return {
    state: state.engine,
    enrolled: state.enrolled,
    handle: state.handle,
    relaysConnected: state.relaysConnected,
    relaysConfigured: state.relaysConfigured,
    witnessThresholdMet: INDEPENDENT_WITNESSES >= WITNESS_THRESHOLD,
    independentWitnesses: INDEPENDENT_WITNESSES,
    pendingInbound: state.pendingInbound,
    unacknowledgedAlarms: state.unacknowledgedAlarms,
    lastError: null,
  };
}

function enrollmentStatus(): EnrollmentStatus {
  const eligibility = evaluateHandle(
    scenario() === "ineligible-handle" ? "fixture.creator" : MOCK_USERNAME,
  );
  return {
    enrolled: state.enrolled,
    handle: state.handle,
    eligibility,
    directoryEntryVersion: state.directoryEntryVersion,
    submittedAt: state.submittedAt,
    mergedAtEpoch: state.mergedAtEpoch,
    blocked: eligibility.eligible ? null : "handle-ineligible",
  };
}

function transition(next: EngineState): EngineStatus {
  state.engine = next;
  const status = engineStatus();
  emitMockEvent("f2zmsg://engine-state", status);
  return status;
}

function conversationOrThrow(conversationId: string): Conversation {
  const conversation = state.conversations.get(conversationId);
  if (!conversation) throw new Error(`unknown conversation ${conversationId}`);
  return conversation;
}

function touchConversation(conversationId: string): void {
  const conversation = conversationOrThrow(conversationId);
  const updated: Conversation = { ...conversation, lastMessageAt: Date.now() };
  state.conversations.set(conversationId, updated);
  emitMockEvent("f2zmsg://conversation-updated", updated);
}

function advanceDelivery(msgId: string, states: DeliveryState[]): void {
  const step = echoDelayMs() / 4;
  states.forEach((next, index) => {
    later(
      () => {
        const message = state.messages.get(msgId);
        if (!message) return;
        const delivery = deliveryStatus(msgId, next);
        state.messages.set(msgId, { ...message, delivery });
        emitMockEvent("f2zmsg://message-state", delivery);
      },
      step * (index + 1),
    );
  });
}

/** The heads of the local DAG: what a new message should name as parents. */
function currentHeads(conversationId: string): string[] {
  const all = [...state.messages.values()].filter(
    (m) => m.conversationId === conversationId,
  );
  const referenced = new Set(all.flatMap((m) => m.parents));
  return all.filter((m) => !referenced.has(m.msgId)).map((m) => m.msgId);
}

export const mockMessaging = {
  async getEngineStatus(): Promise<EngineStatus> {
    return engineStatus();
  },

  async startEngine(): Promise<EngineStatus> {
    if (state.engine === "running" || state.engine === "degraded") {
      return engineStatus();
    }
    if (!state.enrolled) {
      return transition("not-enrolled");
    }
    transition("starting");
    state.relaysConnected = state.relaysConfigured;

    for (const relay of state.relays) {
      const connected: RelayConfig = { ...relay, connection: "connected" };
      state.relays = state.relays.map((candidate) =>
        candidate.relayId === relay.relayId ? connected : candidate,
      );
      emitMockEvent("f2zmsg://relay-state", connected);
    }

    for (const request of state.contactRequests) {
      emitMockEvent("f2zmsg://contact-request", request);
    }

    for (const alarm of state.alarms) {
      emitMockEvent("f2zmsg://alarm", alarm);
    }

    const active = scenario();
    if (active === "gap" || active === "gap-unrecoverable") {
      emitMockEvent("f2zmsg://gap-detected", seedGap());
    }

    // `degraded`, not `running`: single-witness, so the threshold is unmet.
    return transition("degraded");
  },

  async stopEngine(): Promise<EngineStatus> {
    state.relaysConnected = 0;
    return transition("stopped");
  },

  async getDeviceInfo(): Promise<DeviceInfo> {
    return {
      deviceId: "mock-device-0001",
      deviceFingerprint: "A1B2 C3D4 E5F6 0718 293A 4B5C 6D7E 8F90",
      identityFingerprint: "0F1E 2D3C 4B5A 6978 8796 A5B4 C3D2 E1F0",
      createdAt: Date.UTC(2026, 7, 24),
      platform: "browser",
      // A browser tab cannot promise a durable write, and §9 rule 1 depends on
      // that promise being honest.
      durability: "best-effort",
    };
  },

  async getEnrollmentStatus(): Promise<EnrollmentStatus> {
    return enrollmentStatus();
  },

  async enroll(handle: string): Promise<EnrollmentStatus> {
    const eligibility = evaluateHandle(handle);
    if (!eligibility.eligible) {
      return { ...enrollmentStatus(), blocked: "handle-ineligible" };
    }

    state.handle = eligibility.candidate;
    state.enrolled = true;
    state.submittedAt = Date.now();
    state.directoryEntryVersion = 1;
    // Stays null: the entry is not active until the log merges it at an epoch
    // boundary, and the real log never gets there this fast.
    state.mergedAtEpoch = null;
    transition("enrolling");
    return enrollmentStatus();
  },

  /**
   * The engine decides whether the typed confirmation matches; §3.2 fixes the
   * shape of that string and not the string, so nothing here may assert one.
   * What the mock can check without inventing anything is that a confirmation
   * was collected at all, which is the part the UI is responsible for.
   */
  async unenroll(confirmation: string): Promise<EnrollmentStatus> {
    if (confirmation.trim().length === 0) {
      return enrollmentStatus();
    }
    resetMockMessaging();
    state.enrolled = false;
    state.handle = null;
    transition("not-enrolled");
    return enrollmentStatus();
  },

  async listConversations(
    limit?: number,
    cursor?: string,
  ): Promise<ConversationPage> {
    void cursor;
    const conversations = [...state.conversations.values()];
    return {
      conversations:
        limit === undefined ? conversations : conversations.slice(0, limit),
      cursor: null,
    };
  },

  async getConversation(conversationId: string): Promise<Conversation> {
    return conversationOrThrow(conversationId);
  },

  async startConversation(handle: string): Promise<Conversation> {
    const conversation: Conversation = {
      ...echoConversation(),
      conversationId: `conv-${handle}`,
      peerHandle: handle,
      createdAt: Date.now(),
    };
    state.conversations.set(conversation.conversationId, conversation);
    emitMockEvent("f2zmsg://conversation-updated", conversation);
    return conversation;
  },

  async listContactRequests(): Promise<ContactRequest[]> {
    return [...state.contactRequests];
  },

  async acceptContactRequest(requestId: string): Promise<Conversation> {
    const request = state.contactRequests.find(
      (candidate) => candidate.requestId === requestId,
    );
    if (!request) throw new Error(`unknown contact request ${requestId}`);
    state.contactRequests = state.contactRequests.filter(
      (candidate) => candidate.requestId !== requestId,
    );
    return this.startConversation(request.peerHandle);
  },

  async rejectContactRequest(requestId: string, block: boolean): Promise<void> {
    // `block` is local only; there is no server that could enforce it.
    void block;
    state.contactRequests = state.contactRequests.filter(
      (candidate) => candidate.requestId !== requestId,
    );
  },

  async leaveConversation(conversationId: string): Promise<void> {
    state.conversations.delete(conversationId);
    for (const [msgId, message] of state.messages) {
      if (message.conversationId === conversationId)
        state.messages.delete(msgId);
    }
  },

  async sendMessage(
    conversationId: string,
    body: string,
    clientRef: string,
  ): Promise<SendAccepted> {
    conversationOrThrow(conversationId);
    const msgId = `out-${clientRef}`;
    const message = textMessage(
      msgId,
      "outbound",
      0,
      body,
      currentHeads(conversationId),
      deliveryStatus(msgId, "pending"),
      state.nextEpoch++,
    );
    state.messages.set(msgId, message);
    touchConversation(conversationId);

    advanceDelivery(msgId, [
      "accepted",
      "queue-delivered",
      "device-delivered",
      "delivered",
    ]);

    // The echo reply carries real parents, epoch and leaf index, so the §7
    // ordering code is exercised by data rather than by a pre-sorted fixture.
    later(() => {
      const replyId = `in-${clientRef}`;
      const reply = textMessage(
        replyId,
        "inbound",
        state.nextLeafIndex,
        body,
        [msgId],
        deliveryStatus(replyId, "delivered"),
        state.nextEpoch++,
      );
      state.messages.set(replyId, reply);
      touchConversation(conversationId);
      emitMockEvent("f2zmsg://message-received", {
        conversationId,
        message: reply,
      });
    }, echoDelayMs() * 1.5);

    return { msgId, clientRef, state: "pending" };
  },

  async retrySend(msgId: string): Promise<SendAccepted> {
    const message = state.messages.get(msgId);
    if (!message) throw new Error(`unknown message ${msgId}`);
    advanceDelivery(msgId, ["accepted", "queue-delivered", "delivered"]);
    return { msgId, clientRef: msgId.replace(/^out-/, ""), state: "pending" };
  },

  async cancelSend(msgId: string): Promise<void> {
    state.messages.delete(msgId);
  },

  async listMessages(
    conversationId: string,
    limit: number,
    before?: string,
    after?: string,
  ): Promise<MessagePage> {
    void before;
    void after;
    const messages = [...state.messages.values()]
      .filter((message) => message.conversationId === conversationId)
      .sort(compareMessages)
      .slice(-limit);

    return {
      messages,
      cursor: null,
      hasGapBefore: scenario() === "gap",
    };
  },

  async getMessage(msgId: string): Promise<Message> {
    const message = state.messages.get(msgId);
    if (!message) throw new Error(`unknown message ${msgId}`);
    return message;
  },

  async getDeliveryState(msgId: string): Promise<DeliveryStatus> {
    const message = state.messages.get(msgId);
    if (!message) throw new Error(`unknown message ${msgId}`);
    return message.delivery;
  },

  async markRead(conversationId: string, upToMsgId: string): Promise<void> {
    void upToMsgId;
    const conversation = conversationOrThrow(conversationId);
    const updated: Conversation = { ...conversation, unreadCount: 0 };
    state.conversations.set(conversationId, updated);
    emitMockEvent("f2zmsg://conversation-updated", updated);
  },

  async getReceiptPolicy(conversationId: string): Promise<ReceiptPolicy> {
    return conversationOrThrow(conversationId).receiptPolicy;
  },

  async setReceiptPolicy(
    conversationId: string,
    deliveryReceipts: boolean,
    readReceipts: boolean,
  ): Promise<ReceiptPolicy> {
    const conversation = conversationOrThrow(conversationId);
    const receiptPolicy: ReceiptPolicy = { deliveryReceipts, readReceipts };
    const updated: Conversation = { ...conversation, receiptPolicy };
    state.conversations.set(conversationId, updated);
    emitMockEvent("f2zmsg://conversation-updated", updated);
    return receiptPolicy;
  },
  async listGaps(conversationId: string): Promise<Gap[]> {
    const active = scenario();
    if (active !== "gap" && active !== "gap-unrecoverable") return [];
    return [{ ...seedGap(), conversationId }];
  },

  async requestGapRepair(
    conversationId: string,
    gapIds: string[],
  ): Promise<GapRepairStatus[]> {
    void conversationId;
    const unrecoverable = scenario() === "gap-unrecoverable";
    return gapIds.map((gapId) => {
      const repaired: Gap = {
        ...seedGap(),
        gapId,
        state: unrecoverable ? "unrecoverable" : "repaired",
      };
      emitMockEvent("f2zmsg://gap-repaired", repaired);
      return {
        gapId,
        state: repaired.state,
        reason: unrecoverable ? ("gap-unrecoverable" as const) : null,
      };
    });
  },

  async getRetentionPolicy(conversationId?: string): Promise<RetentionPolicy> {
    if (conversationId === undefined) return state.retention;
    // With a conversation, the answer is the effective policy and `scope` says
    // which of the two produced it — that is the field's purpose on a read.
    return conversationOrThrow(conversationId).retention;
  },

  async setRetentionPolicy(
    scope: "global" | "conversation",
    mode: "keep" | "expire",
    ttlSeconds: number | null,
    conversationId?: string,
  ): Promise<RetentionPolicy> {
    // Passing a conversation with global scope, or omitting it with
    // conversation scope, is a client bug and is rejected rather than guessed.
    if (scope === "global" && conversationId !== undefined) {
      throw new Error("global retention takes no conversationId");
    }
    if (scope === "conversation" && conversationId === undefined) {
      throw new Error("conversation retention requires a conversationId");
    }

    const policy: RetentionPolicy = {
      scope,
      mode,
      ttlSeconds: mode === "expire" ? ttlSeconds : null,
      effectiveFrom: Date.now(),
    };

    if (scope === "global") {
      state.retention = policy;
      if (mode === "expire") {
        const expired = [...state.messages.values()].map(
          (message) => message.msgId,
        );
        later(() => {
          emitMockEvent("f2zmsg://retention-expired", {
            conversationId: DEFAULT_CONVERSATION_ID,
            msgIds: expired,
          });
        }, echoDelayMs());
      }
      return policy;
    }
    const conversation = conversationOrThrow(conversationId as string);
    const updated: Conversation = { ...conversation, retention: policy };
    state.conversations.set(updated.conversationId, updated);
    emitMockEvent("f2zmsg://conversation-updated", updated);
    return policy;
  },

  async sendEphemeralHint(
    conversationId: string,
    mode: "ephemeral" | "retained",
    ttlSeconds: number | null,
  ): Promise<EphemeralHintState> {
    const conversation = conversationOrThrow(conversationId);
    const hint: EphemeralHintState = {
      mode,
      ttlSeconds: mode === "ephemeral" ? ttlSeconds : null,
      requestedBy: state.handle ?? MOCK_USERNAME,
      requestedInEpoch: conversation.epoch,
      honoredLocally: true,
    };
    const updated: Conversation = { ...conversation, ephemeralHint: hint };
    state.conversations.set(conversationId, updated);
    emitMockEvent("f2zmsg://conversation-updated", updated);
    return hint;
  },

  async getEphemeralHint(
    conversationId: string,
  ): Promise<EphemeralHintState | null> {
    return conversationOrThrow(conversationId).ephemeralHint;
  },

  async sendPurgeRequest(
    conversationId: string,
    beforeEpoch: number,
  ): Promise<PurgeRequestStatus> {
    const request: PurgeRequestStatus = {
      purgeId: `purge-${state.purges.length + 1}`,
      conversationId,
      beforeEpoch,
      direction: "outbound",
      askedParticipants: 1,
      // Zero until a PurgeAck arrives: a purge is a request, and the mock must
      // not let a screen be built against an instant confirmation.
      confirmedParticipants: 0,
      requestedAt: Date.now(),
    };
    state.purges.push(request);
    later(() => {
      const confirmed = { ...request, confirmedParticipants: 1 };
      state.purges = state.purges.map((candidate) =>
        candidate.purgeId === request.purgeId ? confirmed : candidate,
      );
      emitMockEvent("f2zmsg://purge-progress", confirmed);
    }, echoDelayMs());
    return request;
  },

  async listPurgeRequests(
    conversationId: string,
  ): Promise<PurgeRequestStatus[]> {
    return state.purges.filter(
      (request) => request.conversationId === conversationId,
    );
  },

  async resolveHandle(handle: string): Promise<DirectoryResolution> {
    const known = handle === ECHO_HANDLE || handle === MOCK_USERNAME;
    return {
      handle,
      // An unregistered handle is an answer on the success path, and it is the
      // log's assertion rather than a proof — nothing here may be rendered as
      // a verified absence.
      found: known,
      identityFingerprint: known
        ? "7C4D 91E2 05AB 3F68 D172 8E30 B95C 6A4F"
        : null,
      deviceCount: known ? 1 : 0,
      entryVersion: known ? 1 : null,
      epoch: 412,
      witnessCosignatures: INDEPENDENT_WITNESSES,
      independentWitnesses: INDEPENDENT_WITNESSES,
      thresholdMet: INDEPENDENT_WITNESSES >= WITNESS_THRESHOLD,
    };
  },

  async checkHandleEligibility(username: string): Promise<HandleEligibility> {
    return evaluateHandle(username);
  },

  async getSafetyNumber(conversationId: string): Promise<SafetyNumber> {
    conversationOrThrow(conversationId);
    return {
      conversationId,
      digest: "3f6a1c94b70d2e58",
      displayGroups: [
        "31402",
        "88157",
        "60923",
        "47016",
        "22589",
        "70334",
        "15928",
        "40671",
      ],
      qrPayload: `f2z:sn:${conversationId}:3f6a1c94b70d2e58`,
      zcashMemoPayload: null,
    };
  },

  async setVerification(
    conversationId: string,
    safetyNumberDigest: string,
    verified: boolean,
  ): Promise<VerificationState> {
    const conversation = conversationOrThrow(conversationId);
    const verification: VerificationState = verified
      ? {
          state: "verified",
          verifiedAt: Date.now(),
          digest: safetyNumberDigest,
        }
      : { state: "unverified" };
    const updated: Conversation = { ...conversation, verification };
    state.conversations.set(conversationId, updated);
    emitMockEvent("f2zmsg://conversation-updated", updated);
    return verification;
  },

  async getSelfAuditState(): Promise<SelfAuditState> {
    return {
      lastCheckedEpoch: 412,
      lastCheckedAt: Date.now(),
      chainIntact: true,
      unexpectedEntries: 0,
      running: state.engine === "running" || state.engine === "degraded",
    };
  },

  async listAlarms(): Promise<Alarm[]> {
    return [...state.alarms];
  },

  async acknowledgeAlarm(
    alarmId: string,
    confirmation: string,
  ): Promise<Alarm> {
    const alarm = state.alarms.find(
      (candidate) => candidate.alarmId === alarmId,
    );
    if (!alarm) throw new Error(`unknown alarm ${alarmId}`);
    // Same as unenroll: the phrase is the engine's, not this client's.
    if (confirmation.trim().length === 0) return alarm;
    // Acknowledged, not removed: it stays in the list with a timestamp.
    const acknowledged: Alarm = { ...alarm, acknowledgedAt: Date.now() };
    state.alarms = state.alarms.map((candidate) =>
      candidate.alarmId === alarmId ? acknowledged : candidate,
    );
    emitMockEvent("f2zmsg://alarm", acknowledged);
    return acknowledged;
  },

  async listRelays(): Promise<RelayConfig[]> {
    return [...state.relays];
  },

  async addRelay(relayUrl: string): Promise<RelayConfig> {
    const relay: RelayConfig = {
      relayId: `relay-${state.relays.length + 1}`,
      relayUrl,
      connection: "connecting",
      trusted: false,
      operator: OPERATOR,
      warnings: [],
    };
    state.relays.push(relay);
    emitMockEvent("f2zmsg://relay-state", relay);
    return relay;
  },

  async removeRelay(relayId: string): Promise<void> {
    state.relays = state.relays.filter((relay) => relay.relayId !== relayId);
  },

  async getRelayCapabilities(relayId: string): Promise<RelayCapabilities> {
    void relayId;
    return {
      paddingSizes: [1024, 4096, 16384],
      maxMessageTtlSeconds: 604800,
      idleTtlSeconds: 2592000,
      queueCreationMode: "pow",
      durabilityMode: "fsync-per-append",
      perSourceLimits: true,
      operator: OPERATOR,
    };
  },

  async setRelayTrust(
    relayId: string,
    allowInsecureTransport: boolean,
    allowNoChannelBinding: boolean,
  ): Promise<RelayConfig> {
    const relay = state.relays.find(
      (candidate) => candidate.relayId === relayId,
    );
    if (!relay) throw new Error(`unknown relay ${relayId}`);
    const warnings = [
      ...(allowInsecureTransport ? (["no-transport-security"] as const) : []),
      ...(allowNoChannelBinding ? (["no-channel-binding"] as const) : []),
    ];
    const updated: RelayConfig = {
      ...relay,
      trusted: true,
      warnings: [...warnings],
    };
    state.relays = state.relays.map((candidate) =>
      candidate.relayId === relayId ? updated : candidate,
    );
    emitMockEvent("f2zmsg://relay-state", updated);
    return updated;
  },

  async listWitnesses(): Promise<WitnessConfig[]> {
    return [
      {
        witnessId: "0f2c8a41",
        name: "free2z",
        // False on purpose: the only witness at launch is the log operator, so
        // nothing it cosigns is independent evidence.
        independent: false,
        lastCosignedEpoch: 412,
      },
    ];
  },

  async setWitnessSet(
    witnesses: string[],
    threshold: number,
  ): Promise<WitnessSetState> {
    state.witnessThreshold = threshold;
    return {
      configured: witnesses.length,
      independent: INDEPENDENT_WITNESSES,
      threshold,
      thresholdMet: INDEPENDENT_WITNESSES >= threshold,
      // The mock always has one witness, so the bootstrap disclaimer (which
      // covers having none at all) never applies here.
      bootstrapDisclaimer: false,
    };
  },

  async getWitnessSetState(): Promise<WitnessSetState> {
    return {
      configured: 1,
      independent: INDEPENDENT_WITNESSES,
      threshold: state.witnessThreshold,
      thresholdMet: INDEPENDENT_WITNESSES >= state.witnessThreshold,
      // The mock always has one witness, so the bootstrap disclaimer (which
      // covers having none at all) never applies here.
      bootstrapDisclaimer: false,
    };
  },
};
