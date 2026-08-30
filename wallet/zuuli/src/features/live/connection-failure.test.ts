import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/http";
import { LiveTicketError } from "@/lib/api/live-ticket";
import { classifyLiveFailure, safeLiveDiagnostic } from "./connection-failure";

describe("live connection failure classification", () => {
  it.each([
    [new DOMException("blocked", "SecurityError"), true, "policy"],
    [new TypeError("Failed to fetch https://private.invalid/ticket"), false, "offline"],
    [new TypeError("Failed to fetch https://private.invalid/ticket"), true, "transport"],
    [new DOMException("request stopped", "AbortError"), true, "timeout"],
    [new ApiError(410, "meeting secret ended"), true, "ended-room"],
    [new ApiError(412, "creator lifecycle details"), true, "ended-room"],
    [new ApiError(409, "meeting rotated"), true, "lifecycle-race"],
    [new LiveTicketError("malformed-ticket"), true, "malformed-ticket"],
    [new LiveTicketError("meeting-mismatch"), true, "lifecycle-race"],
    [new LiveTicketError("environment-mismatch"), true, "lifecycle-race"],
    [new LiveTicketError("expired-ticket"), true, "expired-ticket"],
    [new LiveTicketError("replayed-ticket"), true, "replayed-ticket"],
    [new Error("ERR0004 participant token revoked"), true, "token-rejected"],
    [new Error("auth token belongs to wrong environment"), true, "token-rejected"],
    [new Error("[ERR0001] Unable to connect to the server"), true, "transport"],
  ])("classifies %s as %s", (error, online, expected) => {
    expect(classifyLiveFailure(error, "sdk-init", online).kind).toBe(expected);
  });

  it("emits only an allowlisted boundary, category, and provider code", () => {
    const token = "eyJ.private-identity-and-url.signature";
    const failure = classifyLiveFailure(
      new Error(`[ERR0004] rejected ${token} at https://private.invalid/join`),
      "sdk-init",
      true,
    );
    const diagnostic = JSON.stringify(safeLiveDiagnostic(failure));

    expect(JSON.parse(diagnostic)).toEqual({
      boundary: "sdk-init",
      category: "token-rejected",
      providerCode: "ERR0004",
    });
    expect(diagnostic).not.toContain(token);
    expect(diagnostic).not.toContain("private.invalid");
    expect(diagnostic).not.toContain("identity");
  });
});
