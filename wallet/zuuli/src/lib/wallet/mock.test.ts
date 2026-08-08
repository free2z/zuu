import { describe, expect, it } from "vitest";
import { mockWallet } from "./mock";

describe("mockWallet.parsePaymentUri", () => {
  it("preserves an exact eight-decimal URI amount", () => {
    expect(mockWallet.parsePaymentUri("zcash:u1test?amount=1.00000001").amount).toBe(
      100_000_001,
    );
  });

  it.each(["1.000000001", "1e3", "-1", "Infinity"])(
    "rejects malformed URI amount %s instead of rounding it",
    (amount) => {
      expect(() =>
        mockWallet.parsePaymentUri(`zcash:u1test?amount=${encodeURIComponent(amount)}`),
      ).toThrow("Invalid ZEC amount");
    },
  );
});
