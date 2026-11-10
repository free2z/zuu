import { describe, expect, it, vi } from "vitest";
import { createReactionController, REACTION_EVENT } from "./reactions";

describe("meeting reaction transport", () => {
  it("accepts only the exact versioned payload and actual SDK event shape", () => {
    const c = createReactionController();
    expect(
      c.receive({
        type: REACTION_EVENT,
        payload: { emoji: "👏" },
        timestamp: 10,
      })?.emoji,
    ).toBe("👏");
    expect(
      c.receive({
        type: REACTION_EVENT,
        payload: { emoji: "<img>", sender: "alice" },
        timestamp: 11,
      }),
    ).toBeNull();
    expect(
      c.receive({ type: "other", payload: { emoji: "👏" }, timestamp: 12 }),
    ).toBeNull();
  });
  it("limits sends, global receive volume, visible queue and expiry", () => {
    let now = 1_000;
    const c = createReactionController(() => now);
    expect(c.makePayload("❤️")).toEqual({ emoji: "❤️" });
    expect(c.makePayload("👏")).toBeNull();
    now += 1_000;
    for (let i = 0; i < 12; i++)
      expect(
        c.receive({
          type: REACTION_EVENT,
          payload: { emoji: "😂" },
          timestamp: now,
        }),
      ).not.toBeNull();
    expect(c.visible).toHaveLength(8);
    expect(
      c.receive({
        type: REACTION_EVENT,
        payload: { emoji: "😂" },
        timestamp: now,
      }),
    ).toBeNull();
    c.expire(c.visible[0]!.id);
    expect(c.visible).toHaveLength(7);
    now += 5_001;
    expect(
      c.receive({
        type: REACTION_EVENT,
        payload: { emoji: "🎉" },
        timestamp: now,
      }),
    ).not.toBeNull();
  });
});
