// @vitest-environment jsdom
//
// The enrollment boundary is a contract, so it is tested like one.
//
// #904's whole premise is that e2e2z never holds the Zcash seed. Enrollment is
// the one messaging operation that needs it (ARCHITECTURE.md §4.2), so this app
// asks ZUULI for it, and the failure mode that matters is not "it errors" — it
// is "it quietly appears to have worked". These assertions are the ones that
// would go red if someone replaced a refusal or a read with a synthesized
// status, or let a call fall through to a command this app never registered.
//
// #1022 changed one member of the trio deliberately. `getEnrollmentStatus` is
// now a read of this device's own store through the app crate
// (`e2e2z_enrollment_status`), because the screen has to know whether the
// device is enrolled. It still never answers with anything the engine did not
// say. `enroll` still refuses wherever there is no transport, and `unenroll`
// still refuses outright.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ENROLLMENT_STATUS_COMMAND } from "../enrollment/commands";
import {
  EnrollmentUnavailableError,
  RESULTS,
  WIRE_COMMANDS,
  enrollment,
  enrollmentTransport,
  isEnrollmentUnavailable,
} from "./bridge";

const REFUSED = ["enroll", "unenroll"] as const;
const TRIO = ["getEnrollmentStatus", ...REFUSED] as const;

/** Each refused member called the way a screen would call it. */
const CALLS: Record<(typeof REFUSED)[number], () => Promise<unknown>> = {
  enroll: () => enrollment.enroll("alice"),
  unenroll: () => enrollment.unenroll("DELETE"),
};

const NOT_ENROLLED = {
  enrolled: false,
  handle: null,
  eligibility: { eligible: false, candidate: null, reason: "not-signed-in" },
  directoryEntryVersion: null,
  submittedAt: null,
  mergedAtEpoch: null,
  blocked: null,
};

function installHost(answer: (cmd: string) => unknown) {
  const invoke = vi.fn(async (cmd: string) => answer(cmd));
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    writable: true,
    value: { invoke },
  });
  return invoke;
}

afterEach(() => {
  Reflect.deleteProperty(
    window as unknown as Record<string, unknown>,
    "__TAURI_INTERNALS__",
  );
});

describe("the enrollment boundary", () => {
  it("refuses enroll and unenroll with a typed refusal where nothing can carry them", async () => {
    await expect(enrollment.enroll("alice")).rejects.toBeInstanceOf(
      EnrollmentUnavailableError,
    );
    await expect(enrollment.unenroll("DELETE")).rejects.toBeInstanceOf(
      EnrollmentUnavailableError,
    );
  });

  it("carries a machine-readable reason and the refused method", async () => {
    for (const method of REFUSED) {
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

  it("reaches no command for enroll or unenroll without a transport", async () => {
    // A host that answers everything. If either refused call invoked at all,
    // the spy would have been called.
    const invoke = installHost(() => ({}));
    for (const method of REFUSED) {
      await CALLS[method]().catch(() => undefined);
    }
    expect(invoke).not.toHaveBeenCalled();
    expect(enrollmentTransport.canEnroll()).toBe(false);
  });

  it("reads enrollment through the app crate, and never through an f2zmsg_ command", async () => {
    const invoke = installHost((cmd) => {
      if (cmd === ENROLLMENT_STATUS_COMMAND) return NOT_ENROLLED;
      throw new Error(`Command ${cmd} not found`);
    });
    await expect(enrollment.getEnrollmentStatus()).resolves.toEqual(
      NOT_ENROLLED,
    );
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual([
      "e2e2z_enrollment_status",
    ]);
  });

  it("never resolves to a status the engine did not give", async () => {
    // A host that answers the read with something that is not a status.
    installHost(() => ({ enrolled: true }));
    await expect(enrollment.getEnrollmentStatus()).rejects.toThrow(
      "e2e2z_enrollment_status",
    );

    // And one that refuses: the engine's code comes through untouched, so the
    // screen can name it.
    installHost(() => {
      throw "internal";
    });
    await expect(enrollment.getEnrollmentStatus()).rejects.toBe("internal");

    for (const method of REFUSED) {
      const settled = await CALLS[method]().then(
        (value) => ({ resolved: true as const, value }),
        () => ({ resolved: false as const }),
      );
      expect(settled.resolved).toBe(false);
    }
  });

  it("keeps the trio in the bridge's declared population", () => {
    // Deleting them would shrink the contract §3 declares rather than record
    // how this app serves it, and `messaging-contract.node-test.mjs` compares
    // those populations by name.
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
