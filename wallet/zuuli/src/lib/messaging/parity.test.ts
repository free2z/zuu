// The mock-covers-bridge parity test (§4.1).
//
// Catches what `tsc --noEmit` cannot: a mock returning the right type with the
// wrong values, arity drift, a dead mock method left by a bridge rename, and an
// engine response that does not match the declared type at all — which
// TypeScript believes because `invoke<T>` is an unchecked cast.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_BRIDGE_METHODS, RESULTS, type BridgeMethod } from "./bridge";
import {
  EVENTS,
  resetMockEvents,
  subscribeMockEvent,
  type EventName,
  type Unlisten,
} from "./events";
import { mockMessaging, resetMockMessaging } from "./mock";

const SCENARIO_KEY = "zuuli.mock.f2zmsg-scenario";
const SEED_CONVERSATION_ID = "conv-echo";
const SEED_MESSAGE_ID = "aa01";
const SEED_REQUEST_ID = "req-0001";
const SEED_ALARM_ID = "alarm-witness";
const SEED_RELAY_ID = "relay-1";

// vitest's node environment has no localStorage, and the mock reads its
// scenario from one. Deliberately minimal: the mock only ever calls getItem,
// behind both a try/catch and optional chaining.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
});

function useScenario(name: string | null): void {
  if (name === null) store.delete(SCENARIO_KEY);
  else store.set(SCENARIO_KEY, name);
  resetMockMessaging();
}

// Accepted inputs only: a rejected one exercises the refusal path and proves
// nothing about the success shape.
const SAMPLE_ARGS: Record<BridgeMethod, unknown[]> = {
  getEngineStatus: [],
  startEngine: [],
  stopEngine: [],
  getDeviceInfo: [],
  getEnrollmentStatus: [],
  enroll: ["fixturecreator"],
  // Any non-empty string: the engine owns the phrase, so the test must not
  // pin one either.
  unenroll: ["typed confirmation"],
  listConversations: [10, undefined],
  getConversation: [SEED_CONVERSATION_ID],
  startConversation: ["newcomer"],
  listContactRequests: [],
  acceptContactRequest: [SEED_REQUEST_ID],
  rejectContactRequest: [SEED_REQUEST_ID, true],
  leaveConversation: [SEED_CONVERSATION_ID],
  sendMessage: [SEED_CONVERSATION_ID, "hello", "ref-0001"],
  retrySend: [SEED_MESSAGE_ID],
  cancelSend: [SEED_MESSAGE_ID],
  listMessages: [SEED_CONVERSATION_ID, 50, undefined, undefined],
  getMessage: [SEED_MESSAGE_ID],
  getDeliveryState: [SEED_MESSAGE_ID],
  markRead: [SEED_CONVERSATION_ID, SEED_MESSAGE_ID],
  getReceiptPolicy: [SEED_CONVERSATION_ID],
  setReceiptPolicy: [SEED_CONVERSATION_ID, true, false],
  listGaps: [SEED_CONVERSATION_ID],
  requestGapRepair: [SEED_CONVERSATION_ID, ["gap-0001"]],
  getRetentionPolicy: [undefined],
  setRetentionPolicy: ["global", "expire", 3600, undefined],
  sendEphemeralHint: [SEED_CONVERSATION_ID, "ephemeral", 300],
  getEphemeralHint: [SEED_CONVERSATION_ID],
  sendPurgeRequest: [SEED_CONVERSATION_ID, 2],
  listPurgeRequests: [SEED_CONVERSATION_ID],
  resolveHandle: ["echo_peer"],
  checkHandleEligibility: ["fixturecreator"],
  getSafetyNumber: [SEED_CONVERSATION_ID],
  setVerification: [SEED_CONVERSATION_ID, "3f6a1c94b70d2e58", true],
  getSelfAuditState: [],
  listAlarms: [],
  acknowledgeAlarm: [SEED_ALARM_ID, "typed confirmation"],
  listRelays: [],
  addRelay: ["wss://relay.example.invalid"],
  removeRelay: [SEED_RELAY_ID],
  getRelayCapabilities: [SEED_RELAY_ID],
  setRelayTrust: [SEED_RELAY_ID, false, false],
  listWitnesses: [],
  setWitnessSet: [["0f2c8a41"], 2],
  getWitnessSetState: [],
};

// A method whose sample target only exists in one scenario runs under it.
const SCENARIO_FOR: Partial<Record<BridgeMethod, string>> = {
  acceptContactRequest: "first-contact",
  rejectContactRequest: "first-contact",
  listGaps: "gap",
  requestGapRepair: "gap",
};

const bridgeMethods = Object.keys(RESULTS).sort() as BridgeMethod[];

beforeEach(() => {
  useScenario(null);
  resetMockEvents();
});

afterEach(() => {
  resetMockMessaging();
});

describe("the RESULTS manifest covers the bridge exactly", () => {
  it("declares a schema for every bridge method and no others", () => {
    expect(Object.keys(ALL_BRIDGE_METHODS).sort()).toEqual(bridgeMethods);
  });

  it("has a sample argument list for every method", () => {
    expect(Object.keys(SAMPLE_ARGS).sort()).toEqual(bridgeMethods);
  });
});

describe("the mock covers the bridge", () => {
  it("exports exactly the bridge's methods — no dead, no uncovered", () => {
    expect(Object.keys(mockMessaging).sort()).toEqual(bridgeMethods);
  });

  it.each(bridgeMethods)(
    "takes the same number of arguments as the bridge for %s",
    (name) => {
      const mockFn = mockMessaging[name] as (...args: unknown[]) => unknown;
      const bridgeFn = ALL_BRIDGE_METHODS[name] as (
        ...args: unknown[]
      ) => unknown;
      expect(mockFn.length).toBe(bridgeFn.length);
    },
  );
});

describe("the mock returns what the schema declares", () => {
  it.each(bridgeMethods)(
    "%s parses against its declared schema",
    async (name) => {
      useScenario(SCENARIO_FOR[name] ?? null);

      const fn = mockMessaging[name] as (
        ...args: unknown[]
      ) => Promise<unknown>;
      const value = await fn.apply(mockMessaging, SAMPLE_ARGS[name]);

      const parsed = RESULTS[name].safeParse(value);
      expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(
        true,
      );
    },
  );
});

describe("the mock emits every declared event", () => {
  it("covers the EVENTS map across the scenario matrix", async () => {
    vi.useFakeTimers();
    const seen = new Set<EventName>();
    const failures: string[] = [];
    const unlisteners: Unlisten[] = [];

    for (const name of Object.keys(EVENTS) as EventName[]) {
      const schema = EVENTS[name];
      unlisteners.push(
        subscribeMockEvent(name, (payload) => {
          seen.add(name);
          const parsed = schema.safeParse(payload);
          if (!parsed.success)
            failures.push(`${name}: ${parsed.error.message}`);
        }),
      );
    }

    // No single scenario reaches every event: a pending contact request and a
    // detected gap are different fixtures. The matrix walks the ones that carry
    // inbound traffic, which is what §5.4 asks the mock to generate.
    for (const name of [null, "first-contact", "gap"]) {
      useScenario(name);
      await mockMessaging.enroll("fixturecreator");
      await mockMessaging.startEngine();

      if (name === "gap") {
        await mockMessaging.requestGapRepair(SEED_CONVERSATION_ID, [
          "gap-0001",
        ]);
      } else if (name === null) {
        await mockMessaging.sendMessage(
          SEED_CONVERSATION_ID,
          "hi",
          "ref-parity",
        );
        await mockMessaging.sendPurgeRequest(SEED_CONVERSATION_ID, 2);
        await mockMessaging.setRetentionPolicy("global", "expire", 3600);
      }

      // The echo peer, the purge ack and the retention sweep all land on
      // timers; without advancing them the mock generates no inbound traffic.
      await vi.advanceTimersByTimeAsync(5000);
      await mockMessaging.stopEngine();
    }

    for (const unlisten of unlisteners) unlisten();
    vi.useRealTimers();

    expect(failures).toEqual([]);
    expect([...seen].sort()).toEqual(Object.keys(EVENTS).sort());
  });
});
