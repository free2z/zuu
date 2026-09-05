import { describe, expect, it } from "vitest";
import { MAX_COMMENT_TUZIS } from "@/lib/format";
import { commentWeightState } from "./comment-weight";

describe("commentWeightState", () => {
  it("offers a top-up only for a valid positive weight above the balance", () => {
    expect(commentWeightState("11", 10)).toEqual({
      value: 11,
      error: null,
      needsTopUp: true,
    });
    expect(commentWeightState("10", 10).needsTopUp).toBe(false);
  });

  it.each(["", "-1", "1.5", "1e3", "junk"])(
    "keeps malformed weight %s in validation instead of the top-up path",
    (raw) => {
      const state = commentWeightState(raw, 0);
      expect(state.error).not.toBeNull();
      expect(state.needsTopUp).toBe(false);
    },
  );

  it("enforces the backend signed-32-bit maximum", () => {
    expect(commentWeightState(String(MAX_COMMENT_TUZIS), MAX_COMMENT_TUZIS)).toEqual({
      value: MAX_COMMENT_TUZIS,
      error: null,
      needsTopUp: false,
    });
    expect(commentWeightState(String(MAX_COMMENT_TUZIS + 1), Number.MAX_SAFE_INTEGER)).toEqual({
      value: MAX_COMMENT_TUZIS + 1,
      error: "tooLarge",
      needsTopUp: false,
    });
  });
});
