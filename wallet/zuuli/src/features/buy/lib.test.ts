import { describe, expect, it } from "vitest";
import { zatoshisFromQuote } from "./lib";

describe("zatoshisFromQuote", () => {
  it("preserves the backend's exact quoted zatoshi amount", () => {
    expect(zatoshisFromQuote({ zec_amount: "1.00000001" })).toBe(100_000_001);
  });

  it.each(["1.000000001", "1e3", "NaN", "90071992.54740992"])(
    "rejects unusable quote amount %s",
    (zec_amount) => {
      expect(zatoshisFromQuote({ zec_amount })).toBeNull();
    },
  );
});
