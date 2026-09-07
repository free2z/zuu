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
    // Only the typed refusal takes the gap path. Anything else is a real
    // failure and must keep its own identity — a `catch` that swallowed every
    // rejection would hide a broken plugin behind a tidy screen saying the
    // wrong thing about why.
    //
    // This assertion used to be "an unhandled rejection escaped to the host",
    // which passed while #973 was live and was in fact a description of it.
    // What must actually hold is that the failure is *rendered*.
    controls.getEnrollmentStatus.mockRejectedValue(
      new Error("engine-not-running"),
    );

    await act(async () => root.render(<MessagesFeature />));

    expect(container.textContent).not.toContain(
      "Enrollment happens in the wallet app",
    );
    expect(container.querySelector("[data-messages-failure]")).not.toBe(null);
    expect(container.querySelector("[data-messages-loading]")).toBe(null);
    expect(container.textContent).toContain("f2zmsg_enrollment_status");
    expect(container.textContent).toContain("engine-not-running");
  });

  // #973, at the seam it actually broke. `get_device_info` reads the stored
  // device identity and answers §8 `not-enrolled` when there is none, and this
  // app can never install one (#905, blocked on #461) — so this is not an edge
  // case, it is the only answer a packaged e2e2z ever gets, and the version of
  // this file that shipped mocked a `DeviceInfo` a real build cannot produce.
  it("renders the gap when device info refuses the way the plugin really does", async () => {
    controls.getDeviceInfo.mockRejectedValue("not-enrolled");

    await act(async () => root.render(<MessagesFeature />));

    expect(container.querySelector("[data-messages-loading]")).toBe(null);
    expect(container.textContent).toContain(
      "Enrollment happens in the wallet app",
    );
    // The engine status survived a sibling's rejection — the whole reason for
    // `allSettled`. Under `Promise.all` this answer was thrown away.
    expect(container.textContent).toContain("Witnesses");
    // A standing condition is not a fault, and must not be dressed as one.
    expect(container.querySelector("[data-messages-failure]")).toBe(null);
    expect(container.textContent).not.toContain("not-enrolled");
  });

  it("names a device-info failure that is not the standing refusal", async () => {
    // `durability-unavailable`: the store would not open. That is a real fault
    // and worth saying, but it must not cost the user the rest of the screen.
    controls.getDeviceInfo.mockRejectedValue("durability-unavailable");

    await act(async () => root.render(<MessagesFeature />));

    expect(container.querySelector("[data-messages-loading]")).toBe(null);
    expect(container.textContent).toContain("get_device_info");
    expect(container.textContent).toContain("durability-unavailable");
    // Non-blocking: the gap and the engine summary are both still there.
    expect(container.querySelector("[data-messages-failure]")).toBe(null);
    expect(container.textContent).toContain(
      "Enrollment happens in the wallet app",
    );
    expect(container.textContent).toContain("Witnesses");
  });

  it("names a failing engine status instead of sitting on the skeleton", async () => {
    // The engine status is the one read with no substitute, so unlike the
    // others its refusal takes the screen — but it takes it to something that
    // says which call failed and what the engine said.
    controls.getEngineStatus.mockRejectedValue("durability-unavailable");

    await act(async () => root.render(<MessagesFeature />));

    expect(container.querySelector("[data-messages-loading]")).toBe(null);
    expect(container.querySelector("[data-messages-failure]")).not.toBe(null);
    expect(container.textContent).toContain("get_engine_status");
    expect(container.textContent).toContain("durability-unavailable");
    expect(container.textContent).not.toContain(
      "Enrollment happens in the wallet app",
    );
  });

  it("recovers when a retry succeeds", async () => {
    controls.getEngineStatus.mockRejectedValueOnce("relay-unreachable");

    await act(async () => root.render(<MessagesFeature />));
    expect(container.querySelector("[data-messages-failure]")).not.toBe(null);

    const retry = container.querySelector(
      '[aria-label="Read the messaging engine again"]',
    ) as HTMLElement | null;
    expect(retry).not.toBe(null);

    await act(async () => {
      retry?.dispatchEvent(new window.Event("click", { bubbles: true }));
    });

    expect(container.querySelector("[data-messages-failure]")).toBe(null);
    expect(container.textContent).toContain(
      "Enrollment happens in the wallet app",
    );
  });

  // The backstop, proved rather than assumed. `reconcile` is written to end in
  // a rendered state on its own; if a future edit makes it throw before it can,
  // the effect that drives it must still not strand anyone.
  it("renders a failure when the whole read throws unexpectedly", async () => {
    controls.getEngineStatus.mockImplementation(() => {
      throw new Error("the bridge module blew up");
    });

    await act(async () => root.render(<MessagesFeature />));

    expect(container.querySelector("[data-messages-loading]")).toBe(null);
    expect(container.querySelector("[data-messages-failure]")).not.toBe(null);
    expect(container.textContent).toContain("the bridge module blew up");
  });
});
