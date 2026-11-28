import { describe, expect, it } from "vitest";
import { kindMeta, zatoshisFromQuote } from "./lib";

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

describe("kindMeta", () => {
  it.each(["__proto__", "constructor", "toString", "future-kind"])(
    "uses safe fallback metadata for unknown kind %s",
    (kind) => {
      expect(kindMeta(kind)).toMatchObject({
        label: "Activity",
        badge: "secondary",
      });
      expect(kindMeta(kind).icon).toBe(kindMeta("future-kind").icon);
    },
  );
  it("preserves known non-buy kinds", () => {
    expect(kindMeta("donate").label).toBe("Tip");
  });
});
