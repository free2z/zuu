import { describe, expect, it } from "vitest";
import { viewerEntryState } from "./viewer-safety";

describe("creator-safe viewer entry", () => {
  it("cannot issue a public join while identity hydration is unresolved", () => {
    expect(
      viewerEntryState({
        sessionLoading: true,
        creatorUsername: "alice",
        kind: "broadcast",
      }),
    ).toBe("checking-session");
  });

  it("blocks the authenticated creator case-insensitively from the overloaded public route", () => {
    expect(
      viewerEntryState({
        sessionLoading: false,
        viewerUsername: "ALICE",
        creatorUsername: "alice",
        kind: "broadcast",
      }),
    ).toBe("creator-blocked");
  });

  it("allows guests, other viewers, and the dedicated non-management private invite route", () => {
    expect(
      viewerEntryState({
        sessionLoading: false,
        creatorUsername: "alice",
        kind: "broadcast",
      }),
    ).toBe("allowed");
    expect(
      viewerEntryState({
        sessionLoading: false,
        viewerUsername: "bob",
        creatorUsername: "alice",
        kind: "subscriber",
      }),
    ).toBe("allowed");
    expect(
      viewerEntryState({
        sessionLoading: false,
        viewerUsername: "alice",
        creatorUsername: "alice",
        kind: "private",
      }),
    ).toBe("allowed");
  });
});
