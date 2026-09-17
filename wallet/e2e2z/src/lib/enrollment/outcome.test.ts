// Every way "Enroll with ZUULI" can end, read from the real error types the
// enrollment path throws — wrapped the way `bridge.enroll` wraps them.

import { describe, expect, it } from "vitest";
import { IntentErrorCode } from "@free2z/wallet-shared";
import { EnrollmentUnavailableError } from "../messaging/bridge";
import {
  AuthorityLinkError,
  IntentDispatchBusyError,
  IntentDispatchCancelledError,
  IntentResponseTimeoutError,
} from "./appLinkTransport";
import { DeviceKeysUnavailableError } from "./deviceKeys";
import { DeviceCredentialInstallError } from "./installDeviceCredential";
import {
  IntentRefusedError,
  IntentStatusUnknownError,
} from "./issueDeviceCredential";
import { classifyEnrollmentFailure } from "./outcome";
import { IntentTransportUnavailableError } from "./transport";

/** What `bridge.enroll` throws. */
const wrapped = (cause: unknown) =>
  new EnrollmentUnavailableError("enroll", { cause });

/** What `installDeviceCredential` throws for an engine refusal. */
const installRefused = (code: string) =>
  new DeviceCredentialInstallError(code, { cause: code });

describe("classifyEnrollmentFailure", () => {
  it.each([
    ["unavailable", new IntentTransportUnavailableError("issue-device-credential")],
    ["busy", new IntentDispatchBusyError()],
    ["cancelled", new IntentDispatchCancelledError()],
    ["expired", new IntentResponseTimeoutError("issue-device-credential")],
    ["expired", new IntentRefusedError("response", IntentErrorCode.Expired)],
    ["declined", new IntentRefusedError("response", IntentErrorCode.NotConfirmed)],
    [
      "wallet-not-ready",
      new IntentRefusedError("response", IntentErrorCode.Unavailable),
    ],
    [
      "not-registered",
      new IntentRefusedError("response", IntentErrorCode.CallerNotAuthorized),
    ],
    ["link-failed", new AuthorityLinkError("internal")],
    ["unknown-outcome", new IntentStatusUnknownError(4242)],
    // ADR 0016 §4: the engine refused a credential for another handle.
    ["handle-mismatch", installRefused("handle-ineligible")],
    // Custody refused at key sampling (a bare code) or at install.
    ["durability", "durability-unavailable"],
    ["durability", installRefused("durability-unavailable")],
    // ADR 0017 §4.1: ZUULI could not establish the handle is this account's —
    // no free2z session there, no bound handle, or a different one. Nothing
    // was issued and nothing was published.
    [
      "handle-unavailable",
      new IntentRefusedError("response", IntentErrorCode.HandleUnavailable),
    ],
    // This build has no relay, so the device has no address to publish and the
    // key command refused before anything was sampled.
    ["no-relay", "relay-unreachable"],
  ] as const)("reads %s", (kind, cause) => {
    expect(classifyEnrollmentFailure(wrapped(cause)).kind).toBe(kind);
    // The same answer without the wrapper, and after a structured clone.
    expect(classifyEnrollmentFailure(cause).kind).toBe(kind);
  });

  it("does not call a handle-ineligible outside the install a mismatch", () => {
    // The only place that code means "ZUULI signed another handle" is the
    // install step. Elsewhere it is not this story.
    expect(classifyEnrollmentFailure(wrapped("handle-ineligible")).kind).toBe(
      "defect",
    );
  });

  it.each([
    ["a request the protocol refused", new IntentRefusedError("request", IntentErrorCode.InvalidValue)],
    ["a forged answer", new IntentRefusedError("response", IntentErrorCode.Unsolicited)],
    ["a malformed answer", new IntentRefusedError("response", IntentErrorCode.Malformed)],
    ["unusable device keys", new DeviceKeysUnavailableError("devicePk is 3 bytes, not 32")],
    ["an engine refusal", "internal"],
    ["an empty credential", new DeviceCredentialInstallError("the credential is empty")],
    ["anything else", new TypeError("boom")],
  ])("keeps %s as a defect, with its detail", (_label, cause) => {
    const failure = classifyEnrollmentFailure(wrapped(cause));
    expect(failure.kind).toBe("defect");
    expect(failure.detail).not.toBe("");
  });

  it("names the protocol status in the detail", () => {
    expect(
      classifyEnrollmentFailure(
        wrapped(new IntentRefusedError("response", IntentErrorCode.Unsolicited)),
      ).detail,
    ).toBe("INTENT_UNSOLICITED");
  });

  it("reads a wrapper with no cause as no transport", () => {
    expect(
      classifyEnrollmentFailure(new EnrollmentUnavailableError("enroll")).kind,
    ).toBe("unavailable");
  });

  it("reads plain objects by their reason", () => {
    expect(
      classifyEnrollmentFailure({
        reason: "enrollment-requires-wallet-app",
        cause: { reason: "intent-dispatch-cancelled" },
      }).kind,
    ).toBe("cancelled");
  });
});
