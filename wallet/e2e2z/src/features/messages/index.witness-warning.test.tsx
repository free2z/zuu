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
  directoryBlocked: null,
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
  controls.listConversations
    .mockReset()
    .mockResolvedValue({ conversations: [], cursor: null });
  controls.listen.mockClear();
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  restoreGlobals?.();
});

const TITLE = "The directory is not independently witnessed yet";
const INTERNAL = "This is an internal test directory.";
const HELD_BACK = "What is held back is resolving a new handle";

async function renderWith(status: Partial<EngineStatus>) {
  controls.getEngineStatus.mockResolvedValue({ ...STATUS, ...status });
  await act(async () => root.render(<MessagesFeature />));
  await vi.waitFor(() => expect(container.textContent).toContain("Witnesses"));
}

// ADR 0017: the internal directory meets its threshold with a witness free2z
// runs, so the warning cannot key on the threshold alone.
describe("the witness warning", () => {
  it("stays up when the threshold is met by a witness the log's operator runs", async () => {
    await renderWith({ witnessThresholdMet: true, independentWitnesses: 0 });
    expect(container.textContent).toContain(TITLE);
    expect(container.textContent).toContain(INTERNAL);
    expect(container.textContent).not.toContain(HELD_BACK);
  });

  it("stays up with one independent witness, which is still not two", async () => {
    await renderWith({ witnessThresholdMet: true, independentWitnesses: 1 });
    expect(container.textContent).toContain(INTERNAL);
  });

  it("says resolution is held back when the threshold is unmet", async () => {
    await renderWith({ witnessThresholdMet: false, independentWitnesses: 0 });
    expect(container.textContent).toContain(TITLE);
    expect(container.textContent).toContain(HELD_BACK);
    expect(container.textContent).not.toContain(INTERNAL);
  });

  it("comes down only when two independent witnesses meet the threshold", async () => {
    await renderWith({ witnessThresholdMet: true, independentWitnesses: 2 });
    expect(container.textContent).not.toContain(TITLE);
  });
});

// ADR 0017 §3: a directory this build refuses to use at all is said on the
// page, not only when a lookup fails.
describe("a directory this build refuses to use", () => {
  it("names an unvouched log and what it means", async () => {
    await renderWith({ directoryBlocked: "directory-unvouched" });
    expect(container.querySelector("[data-directory-unvouched]")).not.toBeNull();
    expect(container.textContent).toContain(
      "no longer proves that free2z vouched for the handles on it",
    );
  });

  it("names a damaged local directory record and the only way out", async () => {
    await renderWith({ directoryBlocked: "directory-state-invalid" });
    expect(
      container.querySelector("[data-directory-state-invalid]"),
    ).not.toBeNull();
    expect(container.textContent).toContain("enroll again");
  });

  it("says nothing when the directory is usable", async () => {
    await renderWith({ lastError: "relay-unreachable" });
    expect(container.querySelector("[data-directory-unvouched]")).toBeNull();
    expect(
      container.querySelector("[data-directory-state-invalid]"),
    ).toBeNull();
  });

  // The whole reason `directoryBlocked` exists: `lastError` is rewritten by
  // every inbound poll, so a banner keyed on it vanishes while the directory
  // is still refusing to be used (#1027 review, F2).
  it("stays up while the relay weather rewrites lastError", async () => {
    await renderWith({
      directoryBlocked: "directory-unvouched",
      lastError: "relay-unreachable",
    });
    expect(container.querySelector("[data-directory-unvouched]")).not.toBeNull();
  });

  it("is not raised by a relay failure alone", async () => {
    await renderWith({
      directoryBlocked: null,
      lastError: "directory-rate-limited",
    });
    expect(container.querySelector("[data-directory-unvouched]")).toBeNull();
    expect(
      container.querySelector("[data-directory-state-invalid]"),
    ).toBeNull();
  });
});
