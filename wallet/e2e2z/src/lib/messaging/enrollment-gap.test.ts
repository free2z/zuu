// The enrollment gap is a contract, so it is tested like one.
//
// #904's whole premise is that e2e2z never holds the Zcash seed. Enrollment is
// the one messaging operation that needs it (ARCHITECTURE.md §4.2), so this app
// cannot perform it, and the failure mode that matters is not "it errors" — it
// is "it quietly appears to have worked". These assertions are the ones that
// would go red if someone replaced the refusal with a synthesized status, or
// let the call fall through to a Tauri host that has no such command.

import { describe, expect, it, vi } from "vitest";
import {
  EnrollmentUnavailableError,
  RESULTS,
  WIRE_COMMANDS,
  enrollment,
  isEnrollmentUnavailable,
} from "./bridge";

const TRIO = ["getEnrollmentStatus", "enroll", "unenroll"] as const;

/** Each trio member called the way a screen would call it. */
const CALLS: Record<(typeof TRIO)[number], () => Promise<unknown>> = {
  getEnrollmentStatus: () => enrollment.getEnrollmentStatus(),
  enroll: () => enrollment.enroll("alice"),
  unenroll: () => enrollment.unenroll("DELETE"),
};

describe("the enrollment gap", () => {
  it("refuses every enrollment call with a typed refusal", async () => {
    await expect(enrollment.getEnrollmentStatus()).rejects.toBeInstanceOf(
      EnrollmentUnavailableError,
    );
    await expect(enrollment.enroll("alice")).rejects.toBeInstanceOf(
      EnrollmentUnavailableError,
    );
    await expect(enrollment.unenroll("DELETE")).rejects.toBeInstanceOf(
      EnrollmentUnavailableError,
    );
  });

  it("carries a machine-readable reason and the refused method", async () => {
    for (const method of TRIO) {
      const refusal = await CALLS[method]().catch((cause: unknown) => cause);
      expect(isEnrollmentUnavailable(refusal)).toBe(true);
      expect((refusal as EnrollmentUnavailableError).reason).toBe(
        "enrollment-requires-wallet-app",
      );
      expect((refusal as EnrollmentUnavailableError).method).toBe(method);
      // The message has to be usable in a bug report without a debugger.
      expect(String(refusal)).toContain(WIRE_COMMANDS[method]);
    }
  });

  it("never reaches the Tauri IPC surface", async () => {
    // A stub host that answers everything. If the bridge invoked at all, the
    // refusal would be gone and this spy would have been called.
    const invoke = vi.fn(async () => ({}));
    const previous = Object.getOwnPropertyDescriptor(
      globalThis,
      "__TAURI_INTERNALS__",
    );
    Object.defineProperty(globalThis, "__TAURI_INTERNALS__", {
      configurable: true,
      writable: true,
      value: { invoke },
    });
    try {
      for (const method of TRIO) {
        await CALLS[method]().catch(() => undefined);
      }
    } finally {
      if (previous) {
        Object.defineProperty(globalThis, "__TAURI_INTERNALS__", previous);
      } else {
        Reflect.deleteProperty(
          globalThis as unknown as Record<string, unknown>,
          "__TAURI_INTERNALS__",
        );
      }
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("never resolves to an EnrollmentStatus, however shaped", async () => {
    for (const method of TRIO) {
      const settled = await CALLS[method]().then(
        (value) => ({ resolved: true as const, value }),
        () => ({ resolved: false as const }),
      );
      expect(settled.resolved).toBe(false);
    }
  });

  it("keeps the trio in the bridge's declared population", () => {
    // Deleting them would shrink the contract §3 declares rather than record
    // that this app cannot serve it, and `messaging-contract.node-test.mjs`
    // compares those populations by name.
    expect(WIRE_COMMANDS.getEnrollmentStatus).toBe("f2zmsg_enrollment_status");
    expect(WIRE_COMMANDS.enroll).toBe("f2zmsg_enroll");
    expect(WIRE_COMMANDS.unenroll).toBe("f2zmsg_unenroll");
    for (const method of TRIO) expect(RESULTS[method]).toBeDefined();
  });

  it("recognizes a refusal that lost its prototype", () => {
    // A refusal can cross a module or worker boundary as a plain object; the
    // UI's branch must still take the gap path rather than the error path.
    expect(
      isEnrollmentUnavailable({ reason: "enrollment-requires-wallet-app" }),
    ).toBe(true);
    expect(isEnrollmentUnavailable(new Error("something else"))).toBe(false);
    expect(isEnrollmentUnavailable(null)).toBe(false);
  });
});
