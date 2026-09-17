// The messages screen with a chat link (Contract B, #1022), and the engine
// states workstream 5 made visible: no relay in the build, and a locked seal.

import { act } from "react";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EngineStatus,
  EnrollmentStatus,
} from "../../lib/messaging/types";
import type { FirstContactPrefill } from "./FirstContact";

const controls = vi.hoisted(() => ({
  getEngineStatus: vi.fn(),
  getEnrollmentStatus: vi.fn(),
  getDeviceInfo: vi.fn(),
  listConversations: vi.fn(),
  retryUnlock: vi.fn(),
  listen: vi.fn(async () => vi.fn()),
  firstContact: vi.fn(),
}));

vi.mock("../../lib/messaging/bridge", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/messaging/bridge")>();
  return {
    isEnrollmentUnavailable: actual.isEnrollmentUnavailable,
    messaging: {
      getEngineStatus: controls.getEngineStatus,
      getDeviceInfo: controls.getDeviceInfo,
      listConversations: controls.listConversations,
      startEngine: vi.fn(),
      stopEngine: vi.fn(),
    },
    enrollment: { getEnrollmentStatus: controls.getEnrollmentStatus },
    deviceSeal: { retryUnlock: controls.retryUnlock },
  };
});
vi.mock("../../lib/messaging/events", () => ({ listenMessaging: controls.listen }));
vi.mock("./BrowserGuarantee", () => ({ BrowserGuarantee: () => null }));
vi.mock("./Transcript", () => ({ Transcript: () => null }));
vi.mock("./Enrollment", () => ({
  Enrollment: () => <p data-enrollment-stub>enroll with zuuli</p>,
  EnrollmentUnavailable: () => <p>enrollment unavailable</p>,
}));
vi.mock("./FirstContact", () => ({
  FirstContact: (props: {
    prefill: FirstContactPrefill | null;
    onPrefillApplied: () => void;
  }) => {
    controls.firstContact(props);
    return <p data-first-contact>first contact {props.prefill?.handle ?? "-"}</p>;
  },
}));

const chat = await import("../../lib/chat/chatLink");
const { default: MessagesFeature } = await import("./index");

const STATUS: EngineStatus = {
  state: "running",
  enrolled: true,
  handle: "self",
  relaysConnected: 1,
  relaysConfigured: 1,
  witnessThresholdMet: false,
  independentWitnesses: 1,
  pendingInbound: 0,
  unacknowledgedAlarms: 0,
  lastError: null,
  directoryBlocked: null,
};

const UNENROLLED: EnrollmentStatus = {
  enrolled: false,
  handle: null,
  eligibility: { eligible: false, candidate: null, reason: "not-signed-in" },
  directoryEntryVersion: null,
  submittedAt: null,
  mergedAtEpoch: null,
  blocked: null,
};

const SUBMITTED: EnrollmentStatus = {
  enrolled: true,
  handle: "self",
  eligibility: { eligible: true, candidate: "self", reason: null },
  directoryEntryVersion: null,
  submittedAt: 1,
  mergedAtEpoch: null,
  blocked: "directory-unreachable",
};

const ACTIVE: EnrollmentStatus = { ...SUBMITTED, mergedAtEpoch: 7, blocked: null };

let container: HTMLElement;
let root: Root;
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

  chat.resetChatLinksForTests();
  controls.getEngineStatus.mockReset().mockResolvedValue(STATUS);
  controls.getDeviceInfo.mockReset().mockRejectedValue("not-enrolled");
  controls.listConversations.mockReset().mockResolvedValue({
    conversations: [],
    nextCursor: null,
  });
  controls.getEnrollmentStatus.mockReset().mockResolvedValue(UNENROLLED);
  controls.retryUnlock.mockReset().mockResolvedValue(STATUS);
  controls.firstContact.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  restoreGlobals?.();
});

const LINK = "https://free2z.com/bridge/e2e2z/chat/#peer=alice";

describe("a chat link on the messages screen", () => {
  it("waits for enrollment, and says nothing will be sent", async () => {
    chat.deliverChatLink(LINK);
    await act(async () => root.render(<MessagesFeature />));

    const notice = container.querySelector("[data-pending-peer]");
    expect(notice?.getAttribute("data-pending-peer")).toBe("alice");
    expect(notice?.textContent).toContain("Chat with @alice is waiting");
    expect(notice?.textContent).toContain("Set up messaging on this device first");
    expect(notice?.textContent).toContain("Nothing is sent until you tap Start chat");
    expect(container.querySelector("[data-enrollment-stub]")).not.toBe(null);
    expect(container.querySelector("[data-first-contact]")).toBe(null);
    // Still pending: nothing consumed it.
    expect(chat.chatLinkSnapshot().pending?.handle).toBe("alice");
  });

  it("arrives while the screen is open", async () => {
    await act(async () => root.render(<MessagesFeature />));
    expect(container.querySelector("[data-pending-peer]")).toBe(null);
    await act(async () => {
      chat.deliverChatLink(LINK);
    });
    expect(container.querySelector("[data-pending-peer]")).not.toBe(null);
  });

  it("can be dismissed", async () => {
    chat.deliverChatLink(LINK);
    await act(async () => root.render(<MessagesFeature />));
    const dismiss = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Dismiss",
    );
    await act(async () => dismiss?.click());
    expect(container.querySelector("[data-pending-peer]")).toBe(null);
    expect(chat.chatLinkSnapshot().pending).toBe(null);
  });

  it("keeps waiting while the handle is submitted but not active", async () => {
    controls.getEnrollmentStatus.mockResolvedValue(SUBMITTED);
    chat.deliverChatLink(LINK);
    await act(async () => root.render(<MessagesFeature />));

    expect(container.textContent).toContain("Submitted, not yet active");
    // The engine's reason, as the engine said it.
    expect(container.textContent).toContain("directory-unreachable");
    expect(
      container.querySelector("[data-pending-peer]")?.textContent,
    ).toContain("as soon as your handle is active in the directory");
    expect(container.querySelector("[data-first-contact]")).toBe(null);
  });

  it("resumes into first contact once the handle is active", async () => {
    chat.deliverChatLink(LINK);
    await act(async () => root.render(<MessagesFeature />));
    expect(container.querySelector("[data-first-contact]")).toBe(null);

    // Enrollment finishes and the log merges the entry; the next read says so.
    controls.getEnrollmentStatus.mockResolvedValue(ACTIVE);
    await act(async () => {
      window.dispatchEvent(new window.Event("focus"));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector("[data-first-contact]")?.textContent).toBe(
      "first contact alice",
    );
    expect(container.querySelector("[data-pending-peer]")).toBe(null);
    const props = controls.firstContact.mock.lastCall?.[0] as {
      prefill: FirstContactPrefill;
      onPrefillApplied: () => void;
    };
    expect(props.prefill.handle).toBe("alice");

    // First contact reports the field filled; the pending peer is done.
    await act(async () => props.onPrefillApplied());
    expect(chat.chatLinkSnapshot().pending).toBe(null);
  });

  it("says so when a chat link was malformed", async () => {
    await act(async () => root.render(<MessagesFeature />));
    await act(async () => {
      chat.deliverChatLink("https://free2z.com/bridge/e2e2z/chat/?peer=alice");
    });
    expect(
      container.querySelector("[data-chat-link-rejected]")?.textContent,
    ).toContain("That chat link didn't work");
    expect(container.querySelector("[data-pending-peer]")).toBe(null);
  });
});

describe("engine states", () => {
  it("names a build with no messaging relay", async () => {
    controls.getEngineStatus.mockResolvedValue({
      ...STATUS,
      state: "stopped",
      relaysConnected: 0,
      relaysConfigured: 0,
    });
    await act(async () => root.render(<MessagesFeature />));
    expect(
      container.querySelector("[data-service-not-configured]")?.textContent,
    ).toContain("Messaging service not configured in this build");
    expect(container.textContent).toContain("None configured in this build.");
  });

  it("does not claim a configuration problem when a relay exists", async () => {
    await act(async () => root.render(<MessagesFeature />));
    expect(container.querySelector("[data-service-not-configured]")).toBe(null);
  });

  it("keeps the witness warning visible before enrollment too", async () => {
    await act(async () => root.render(<MessagesFeature />));
    expect(container.textContent).toContain(
      "The directory is not independently witnessed yet",
    );
  });

  it("offers a seed-free unlock when the seal is shut", async () => {
    controls.getEnrollmentStatus.mockResolvedValue(ACTIVE);
    controls.getEngineStatus.mockResolvedValue({ ...STATUS, state: "locked" });
    await act(async () => root.render(<MessagesFeature />));

    const locked = container.querySelector("[data-device-locked]");
    expect(locked?.textContent).toContain("Messages are locked on this device");
    expect(locked?.textContent).not.toContain("seed");
    const unlock = Array.from(locked?.querySelectorAll("button") ?? []).find(
      (candidate) => candidate.textContent?.trim() === "Unlock",
    );
    await act(async () => unlock?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(controls.retryUnlock).toHaveBeenCalledTimes(1);
  });
});
