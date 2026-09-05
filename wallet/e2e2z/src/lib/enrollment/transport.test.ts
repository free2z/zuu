// The seam, tested as the thing it is: a refusal that cannot be argued out of.
//
// `docs/intent-bridge/PROTOCOL.md` §7 forbids dispatching any authority-bearing
// intent until #461 lands. The failure mode that matters is not "it errors" —
// it is a transport that quietly starts answering, because everything upstream
// of it is finished and would believe the answer.

import { describe, expect, it } from "vitest";
import {
  IntentTransportUnavailableError,
  intentTransport,
  isIntentTransportUnavailable,
  resetIntentTransport,
  setIntentTransport,
  unavailableIntentTransport,
  type IntentDispatchContext,
} from "./transport";

const CONTEXT: IntentDispatchContext = {
  family: "issue-device-credential",
  requestId: "77".repeat(32),
  expiresAtMs: 1_700_000_120_000,
};

describe("the intent transport", () => {
  it("is unavailable by default, in every build", () => {
    resetIntentTransport();
    expect(intentTransport()).toBe(unavailableIntentTransport);
    expect(intentTransport().available).toBe(false);
  });

  it("rejects rather than resolving, with a typed refusal", async () => {
    await expect(
      unavailableIntentTransport.dispatch(new Uint8Array(4), CONTEXT),
    ).rejects.toBeInstanceOf(IntentTransportUnavailableError);
  });

  it("never resolves to bytes a caller could mistake for a response", async () => {
    const settled = await unavailableIntentTransport
      .dispatch(new Uint8Array(4), CONTEXT)
      .then(
        (value) => ({ resolved: true as const, value }),
        () => ({ resolved: false as const }),
      );
    expect(settled.resolved).toBe(false);
  });

  it("names the family, the reason and the blocking issue", async () => {
    const refusal = await unavailableIntentTransport
      .dispatch(new Uint8Array(4), CONTEXT)
      .catch((cause: unknown) => cause);
    expect(isIntentTransportUnavailable(refusal)).toBe(true);
    const typed = refusal as IntentTransportUnavailableError;
    expect(typed.reason).toBe("intent-transport-not-built");
    expect(typed.blockedOn).toBe(461);
    expect(typed.family).toBe("issue-device-credential");
    // A bug report has to be actionable without a debugger.
    expect(String(typed)).toContain("#461");
  });

  it("does not gate its refusal on the availability flag", async () => {
    // The client checks `available` before it samples a device key set, so a
    // reviewer could reasonably ask whether flipping one boolean is all that
    // stands between here and a dispatch. It is not: `dispatch` refuses
    // unconditionally, and this is the assertion that keeps that true.
    const flipped = { ...unavailableIntentTransport, available: true };
    expect(flipped.available).toBe(true);
    await expect(
      flipped.dispatch(new Uint8Array(4), CONTEXT),
    ).rejects.toBeInstanceOf(IntentTransportUnavailableError);
  });

  it("recognizes a refusal that lost its prototype", () => {
    expect(
      isIntentTransportUnavailable({ reason: "intent-transport-not-built" }),
    ).toBe(true);
    expect(isIntentTransportUnavailable(new Error("something else"))).toBe(false);
    expect(isIntentTransportUnavailable(null)).toBe(false);
  });

  it("registers and restores, so a real transport is one registration", () => {
    const stub = {
      id: "test",
      available: true,
      dispatch: async () => new Uint8Array(0),
    };
    try {
      setIntentTransport(stub);
      expect(intentTransport()).toBe(stub);
    } finally {
      resetIntentTransport();
    }
    expect(intentTransport()).toBe(unavailableIntentTransport);
  });
});
