// "Enroll with ZUULI" (#1022): every state renders, none of them claims an
// enrollment the engine did not report, and the handle ZUULI is asked for is
// the engine's eligibility candidate.

import { act } from "react";
import type { Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntentErrorCode } from "@free2z/wallet-shared";
import type { EnrollmentStatus } from "../../lib/messaging/types";

const controls = vi.hoisted(() => ({
  enroll: vi.fn(),
  canEnroll: vi.fn(() => true),
  cancelEnroll: vi.fn(),
  checkHandleEligibility: vi.fn(),
}));

vi.mock("../../lib/messaging/bridge", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/messaging/bridge")>();
  return {
    EnrollmentUnavailableError: actual.EnrollmentUnavailableError,
    enrollment: { enroll: controls.enroll },
    enrollmentTransport: {
      canEnroll: controls.canEnroll,
      cancelEnroll: controls.cancelEnroll,
    },
    messaging: { checkHandleEligibility: controls.checkHandleEligibility },
  };
});

const { EnrollmentUnavailableError } = await import(
  "../../lib/messaging/bridge"
);
const {
  IntentDispatchCancelledError,
  IntentResponseTimeoutError,
  AuthorityLinkError,
} = await import("../../lib/enrollment/appLinkTransport");
const { IntentRefusedError } = await import(
  "../../lib/enrollment/issueDeviceCredential"
);
const { DeviceCredentialInstallError } = await import(
  "../../lib/enrollment/installDeviceCredential"
);
const { Enrollment } = await import("./Enrollment");

const INSTALLED: EnrollmentStatus = {
  enrolled: true,
  handle: "alice",
  eligibility: { eligible: true, candidate: "alice", reason: null },
  directoryEntryVersion: null,
  submittedAt: 1,
  mergedAtEpoch: null,
  blocked: null,
};

let container: HTMLElement;
let root: Root;
let restoreGlobals: () => void;

beforeEach(async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
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

  controls.enroll.mockReset();
  controls.canEnroll.mockReset().mockReturnValue(true);
  controls.cancelEnroll.mockReset();
  // The engine's rule, reduced: lowercase ASCII, or a punctuation refusal.
  controls.checkHandleEligibility
    .mockReset()
    .mockImplementation(async (username: string) => {
      const candidate = username.toLowerCase();
      return /^[a-z0-9_]{1,30}$/.test(candidate)
        ? { eligible: true, candidate, reason: null }
        : { eligible: false, candidate: null, reason: "punctuation" };
    });
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  restoreGlobals?.();
});

async function render(onEnrolled = vi.fn(async () => {})) {
  await act(async () => root.render(<Enrollment onEnrolled={onEnrolled} />));
  return onEnrolled;
}

function button(label: RegExp): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (candidate) => label.test(candidate.textContent?.trim() ?? ""),
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

async function type(value: string) {
  const input = container.querySelector("#enrollment-username")!;
  await act(async () => {
    Simulate.change(input, { target: { value } } as never);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function submit() {
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function failWith(cause: unknown) {
  controls.enroll.mockRejectedValue(
    new EnrollmentUnavailableError("enroll", { cause }),
  );
  await render();
  await type("Alice");
  await submit();
}

describe("Enroll with ZUULI", () => {
  it("keeps the standing gap copy where no transport exists", async () => {
    controls.canEnroll.mockReturnValue(false);
    await render();
    expect(container.textContent).toContain(
      "Enrollment happens in the wallet app",
    );
    expect(container.querySelector("form")).toBe(null);
    expect(container.textContent).not.toContain("Enroll with ZUULI");
  });

  it("explains the flow and waits for an eligible username", async () => {
    await render();
    expect(container.textContent).toContain("Set up messaging on this device");
    expect(container.textContent).toContain("never holds your wallet's recovery phrase");
    expect(button(/^Enroll with ZUULI$/).disabled).toBe(true);

    await type("a.b");
    expect(container.textContent).toContain(
      "can only use the letters a to z",
    );
    expect(button(/^Enroll with ZUULI$/).disabled).toBe(true);

    await type("Alice");
    // The engine's candidate, labeled as a request rather than a binding.
    expect(
      container.querySelector("[data-enrollment-candidate]")?.textContent,
    ).toBe("@alice");
    expect(container.textContent).toContain("Handle to request");
    expect(container.textContent).toContain(
      "once free2z's directory confirms it belongs to your account",
    );
    expect(button(/^Enroll with ZUULI$/).disabled).toBe(false);
    expect(controls.enroll).not.toHaveBeenCalled();
  });

  it("asks ZUULI for the candidate, not the typed text, and waits with a way out", async () => {
    controls.enroll.mockReturnValue(new Promise(() => {}));
    await render();
    await type("Alice");
    await submit();

    expect(controls.enroll).toHaveBeenCalledWith("alice");
    expect(controls.enroll).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-enrollment-waiting]")).not.toBe(null);
    expect(container.textContent).toContain("Waiting for ZUULI");
    expect(container.textContent).toContain("@alice");
    expect(container.textContent).toContain("This request expires in 2:00");
    expect(container.querySelector("[data-zuuli-missing-hint]")).not.toBe(null);

    await act(async () => button(/^Cancel$/).click());
    expect(controls.cancelEnroll).toHaveBeenCalledTimes(1);
  });

  it("hands the engine's status on once the credential is installed", async () => {
    controls.enroll.mockResolvedValue(INSTALLED);
    const onEnrolled = await render();
    await type("alice");
    await submit();
    expect(onEnrolled).toHaveBeenCalledWith(INSTALLED);
    expect(container.querySelector("[data-enrollment-failure]")).toBe(null);
  });

  it("never treats an unenrolled answer as success", async () => {
    controls.enroll.mockResolvedValue({ ...INSTALLED, enrolled: false });
    const onEnrolled = await render();
    await type("alice");
    await submit();
    expect(onEnrolled).not.toHaveBeenCalled();
    expect(
      container.querySelector("[data-enrollment-failure]")?.getAttribute(
        "data-enrollment-failure",
      ),
    ).toBe("defect");
  });

  it.each([
    ["cancelled", (): unknown => new IntentDispatchCancelledError(), "Enrollment cancelled"],
    [
      "expired",
      (): unknown => new IntentResponseTimeoutError("issue-device-credential"),
      "The request expired",
    ],
    [
      "declined",
      (): unknown => new IntentRefusedError("response", IntentErrorCode.NotConfirmed),
      "You declined in ZUULI",
    ],
    [
      "wallet-not-ready",
      (): unknown => new IntentRefusedError("response", IntentErrorCode.Unavailable),
      "ZUULI couldn't vouch for this device",
    ],
    ["link-failed", (): unknown => new AuthorityLinkError("internal"), "ZUULI didn't open"],
    [
      "handle-mismatch",
      (): unknown => new DeviceCredentialInstallError("handle-ineligible", { cause: "handle-ineligible" }),
      "ZUULI signed a different handle",
    ],
    [
      "durability",
      (): unknown => "durability-unavailable",
      "This device can't keep messaging keys safely",
    ],
    ["defect", (): unknown => new TypeError("boom"), "Enrollment stopped"],
  ] as const)("renders %s and offers another try", async (kind, cause, title) => {
    await failWith(cause());
    const failure = container.querySelector("[data-enrollment-failure]");
    expect(failure?.getAttribute("data-enrollment-failure")).toBe(kind);
    expect(failure?.getAttribute("role")).toBe("alert");
    expect(failure?.textContent).toContain(title);
    // The username survives, so trying again is one tap.
    expect(button(/^Try again with ZUULI$/).disabled).toBe(false);
    // Nothing that reads as enrolled.
    expect(container.textContent).not.toContain("Handle active");
  });

  it("names the requested handle when ZUULI signed another", async () => {
    await failWith(
      new DeviceCredentialInstallError("handle-ineligible", {
        cause: "handle-ineligible",
      }),
    );
    expect(container.textContent).toContain(
      "This device asked for @alice, but the credential that came back is for another handle",
    );
  });

  it("points at installing ZUULI when the request expired or the link failed", async () => {
    await failWith(new IntentResponseTimeoutError("issue-device-credential"));
    expect(container.textContent).toContain("ZUULI isn't installed on this device");
    expect(container.textContent).toContain("within 2 minutes");
  });

  it("keeps the evidence for a defect", async () => {
    await failWith("internal");
    expect(container.textContent).toContain("internal");
  });
});
