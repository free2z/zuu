import { act } from "react";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Conversation,
  DeviceInfo,
  EngineStatus,
  EnrollmentStatus,
} from "../../lib/messaging/types";

const controls = vi.hoisted(() => ({
  getEngineStatus: vi.fn(),
  getEnrollmentStatus: vi.fn(),
  getDeviceInfo: vi.fn(),
  listConversations: vi.fn(),
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock("../../lib/messaging/bridge", () => ({
  messaging: {
    getEngineStatus: controls.getEngineStatus,
    getDeviceInfo: controls.getDeviceInfo,
    listConversations: controls.listConversations,
  },
  enrollment: { getEnrollmentStatus: controls.getEnrollmentStatus },
}));
vi.mock("../../lib/messaging/events", () => ({ listenMessaging: controls.listen }));
vi.mock("./BrowserGuarantee", () => ({ BrowserGuarantee: () => null }));
vi.mock("./FirstContact", () => ({ FirstContact: () => null }));
vi.mock("./Transcript", () => ({
  Transcript: ({ conversation }: { conversation: Conversation }) => (
    <p data-transcript>{conversation.peerHandle}</p>
  ),
}));

import MessagesFeature from "./index";

const STATUS: EngineStatus = {
  state: "running",
  enrolled: true,
  handle: "self",
  relaysConnected: 1,
  relaysConfigured: 1,
  witnessThresholdMet: true,
  independentWitnesses: 2,
  pendingInbound: 0,
  unacknowledgedAlarms: 0,
  lastError: null,
};
const ENROLLMENT: EnrollmentStatus = {
  enrolled: true,
  handle: "self",
  eligibility: { eligible: true, candidate: "self", reason: null },
  directoryEntryVersion: 1,
  submittedAt: 1,
  mergedAtEpoch: 1,
  blocked: null,
};
const DEVICE: DeviceInfo = {
  deviceId: "device",
  deviceFingerprint: "AAAAA",
  identityFingerprint: "BBBBB",
  createdAt: 1,
  platform: "zuuli-desktop",
  durability: "durable",
};

function conversation(peerHandle: string): Conversation {
  return {
    conversationId: `conv-${peerHandle}`,
    peerHandle,
    peerIdentityFingerprint: "CCCCC",
    verification: { state: "unverified" },
    epoch: 1,
    createdAt: 1,
    lastMessageAt: null,
    unreadCount: 0,
    retention: {
      scope: "global",
      mode: "keep",
      ttlSeconds: null,
      effectiveFrom: 1,
    },
    ephemeralHint: null,
    receiptPolicy: { deliveryReceipts: true, readReceipts: false },
    hasGaps: false,
    transportHealth: "ok",
    compromiseRelayUrl: null,
  };
}

let root: Root;
let container: HTMLElement;
let restoreGlobals: () => void;

beforeEach(async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { protocol: "http:" },
  });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
  restoreGlobals = () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  };
  container = document.getElementById("root") as unknown as HTMLElement;
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container);
  controls.getEngineStatus.mockReset().mockResolvedValue(STATUS);
  controls.getEnrollmentStatus.mockReset().mockResolvedValue(ENROLLMENT);
  controls.getDeviceInfo.mockReset().mockResolvedValue(DEVICE);
  controls.listConversations.mockReset();
  controls.listen.mockClear();
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  restoreGlobals?.();
});

describe("messages reconciliation", () => {
  it("does not let an older conversation read overwrite a newer focus read", async () => {
    const reads: Array<(page: { conversations: Conversation[]; cursor: null }) => void> = [];
    controls.listConversations.mockImplementation(
      () => new Promise((resolve) => reads.push(resolve)),
    );
    await act(async () => root.render(<MessagesFeature />));
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    await act(async () =>
      window.dispatchEvent(new window.Event("focus")),
    );
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    await act(async () =>
      reads[1]({ conversations: [conversation("new")], cursor: null }),
    );
    expect(container.textContent).toContain("@new");
    await act(async () =>
      reads[0]({ conversations: [conversation("old")], cursor: null }),
    );
    expect(container.textContent).toContain("@new");
    expect(container.textContent).not.toContain("@old");
  });
});
