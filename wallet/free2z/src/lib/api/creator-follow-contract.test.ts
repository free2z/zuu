import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("../platform", () => ({ useMock: () => false }));
vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  request,
}));

import {
  parseCreatorFollowState,
  parseCreatorMembershipPrice,
  tuzi,
} from "./free2z";

const state = {
  username: "Creator",
  following: true,
  follower_count: 12,
  following_count: 3,
};

describe("free creator-follow API contract", () => {
  beforeEach(() => {
    request.mockReset().mockResolvedValue(state);
  });

  it("uses the existing unaffiliated GET/PUT/DELETE follow resource", async () => {
    await tuzi.creatorFollow("Creator", "state");
    await tuzi.creatorFollow("Creator", "follow");
    await tuzi.creatorFollow("Creator", "unfollow");

    expect(request.mock.calls).toEqual([
      ["/api/creator/Creator/follow/", { method: "GET", cache: "no-store" }],
      ["/api/creator/Creator/follow/", { method: "PUT", cache: "no-store" }],
      ["/api/creator/Creator/follow/", { method: "DELETE", cache: "no-store" }],
    ]);
  });

  it("validates authoritative state and rejects malformed or mismatched data", () => {
    expect(parseCreatorFollowState(state, "creator")).toEqual(state);
    expect(() =>
      parseCreatorFollowState({ ...state, following: "yes" }, "creator"),
    ).toThrow("Malformed creator follow response");
    expect(() =>
      parseCreatorFollowState(
        { ...state, username: "someone-else" },
        "creator",
      ),
    ).toThrow("Malformed creator follow response");
    expect(() =>
      parseCreatorFollowState({ ...state, follower_count: -1 }, "creator"),
    ).toThrow("Malformed creator follow response");
    expect(() =>
      parseCreatorFollowState({ ...state, following_count: -1 }, "creator"),
    ).toThrow("Malformed creator follow response");
  });

  it("distinguishes absent/free membership prices from malformed prices", () => {
    expect(parseCreatorMembershipPrice(null)).toBeNull();
    expect(parseCreatorMembershipPrice("0.00")).toBe(0);
    expect(parseCreatorMembershipPrice("12.50")).toBe(13);
    expect(Number.isNaN(parseCreatorMembershipPrice("bad"))).toBe(true);
    expect(Number.isNaN(parseCreatorMembershipPrice("-2"))).toBe(true);
  });
});
