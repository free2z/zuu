// What the screen does when enrollment refuses.
//
// `src/lib/messaging/enrollment-gap.test.ts` proves the bridge refuses. This
// proves the refusal is *rendered* — the failure this pairs against is a screen
// that swallows the rejection and sits on its skeleton forever, or one that
// treats "cannot ask" as "not enrolled yet" and offers a claim control that
// cannot work.

import { act } from "react";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo, EngineStatus } from "../../lib/messaging/types";

const controls = vi.hoisted(() => ({
  getEngineStatus: vi.fn(),
  getEnrollmentStatus: vi.fn(),
  getDeviceInfo: vi.fn(),
  listConversations: vi.fn(),
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock("../../lib/messaging/bridge", async (importOriginal) => {
  // The refusal type itself is the real one: a test-local copy would pass even
  // if `isEnrollmentUnavailable` stopped recognizing what the bridge throws.
  const actual =
    await importOriginal<typeof import("../../lib/messaging/bridge")>();
  return {
    EnrollmentUnavailableError: actual.EnrollmentUnavailableError,
    isEnrollmentUnavailable: actual.isEnrollmentUnavailable,
    messaging: {
      getEngineStatus: controls.getEngineStatus,
      getDeviceInfo: controls.getDeviceInfo,
      listConversations: controls.listConversations,
    },
    enrollment: { getEnrollmentStatus: controls.getEnrollmentStatus },
  };
});
vi.mock("../../lib/messaging/events", () => ({ listenMessaging: controls.listen }));
vi.mock("./BrowserGuarantee", () => ({ BrowserGuarantee: () => null }));
vi.mock("./FirstContact", () => ({ FirstContact: () => <p>first contact</p> }));
vi.mock("./Transcript", () => ({ Transcript: () => <p>transcript</p> }));

const { EnrollmentUnavailableError } = await import(
  "../../lib/messaging/bridge"
);
const { default: MessagesFeature } = await import("./index");

const STATUS: EngineStatus = {
  state: "stopped",
  enrolled: false,
  handle: null,
  relaysConnected: 0,
  relaysConfigured: 1,
  witnessThresholdMet: true,
  independentWitnesses: 2,
  pendingInbound: 0,
  unacknowledgedAlarms: 0,
  lastError: null,
};

const DEVICE: DeviceInfo = {
  deviceId: "device-1",
  deviceFingerprint: "AAAA BBBB",
  identityFingerprint: "CCCC DDDD",
  createdAt: 0,
  platform: "zuuli-desktop",
  durability: "durable",
};

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
  controls.getEngineStatus.mockReset().mockResolvedValue(STATUS);
  controls.getDeviceInfo.mockReset().mockResolvedValue(DEVICE);
  controls.listConversations.mockReset();
  controls.getEnrollmentStatus
    .mockReset()
    .mockRejectedValue(new EnrollmentUnavailableError("getEnrollmentStatus"));
  controls.listen.mockClear();
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  restoreGlobals?.();
});

describe("the messages screen without enrollment authority", () => {
  it("renders the gap instead of hanging on the skeleton", async () => {
    await act(async () => root.render(<MessagesFeature />));

    expect(container.textContent).toContain(
      "Enrollment happens in the wallet app",
    );
    // The engine half of the surface still works and still reports.
    expect(container.textContent).toContain("Witnesses");
  });

  it("offers nothing that would read as enrolled", async () => {
    await act(async () => root.render(<MessagesFeature />));

    for (const forbidden of [
      "Claim your handle",
      "Handle active",
      "first contact",
      "transcript",
      "Submitted, not yet active",
    ]) {
      expect(container.textContent).not.toContain(forbidden);
    }
    expect(container.querySelector("nav")).toBe(null);
  });

  it("never asks the engine for conversations", async () => {
    await act(async () => root.render(<MessagesFeature />));
    expect(controls.listConversations).not.toHaveBeenCalled();
  });

  it("does not turn a different failure into the enrollment gap", async () => {
    // Only the typed refusal takes the gap path. Anything else keeps
    // propagating, exactly as it did before the gap existed — a `catch` that
    // swallowed every rejection would hide a broken plugin behind a tidy
    // screen that says the wrong thing about why.
    controls.getEnrollmentStatus.mockRejectedValue(
      new Error("engine-not-running"),
    );
    const rejections: unknown[] = [];
    const absorb = (reason: unknown) => rejections.push(reason);
    // `@types/node` is not in this project's `types`, and adding it to run one
    // assertion would widen every file's ambient scope.
    const host = (globalThis as unknown as {
      process: {
        on(event: string, listener: (reason: unknown) => void): void;
        off(event: string, listener: (reason: unknown) => void): void;
      };
    }).process;
    host.on("unhandledRejection", absorb);
    try {
      await act(async () => root.render(<MessagesFeature />));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      host.off("unhandledRejection", absorb);
    }
    expect(container.textContent).not.toContain(
      "Enrollment happens in the wallet app",
    );
    expect(rejections.map(String).join(" ")).toContain("engine-not-running");
  });
});
