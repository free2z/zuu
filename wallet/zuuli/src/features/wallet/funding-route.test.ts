import { describe, expect, it } from "vitest";
import { isWalletFundingPath } from ".";

describe("Wallet funding route", () => {
  it.each(["/wallet/fund", "/wallet/fund/card"])(
    "recognizes the exact route segment: %s",
    (pathname) => {
      expect(isWalletFundingPath(pathname)).toBe(true);
    },
  );

  it.each(["/wallet", "/wallet/funding", "/wallet/fundraiser", "/wallet/fund-me"])(
    "does not bypass wallet setup for a prefix lookalike: %s",
    (pathname) => {
      expect(isWalletFundingPath(pathname)).toBe(false);
    },
  );
});
