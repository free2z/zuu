import { describe, expect, it } from "vitest";
import { isWalletFundingPath } from ".";
import { fundingTabForPath } from "./funding";

describe("Wallet funding route", () => {
  it.each(["/wallet/fund", "/wallet/fund/card"])(
    "recognizes the exact route segment: %s",
    (pathname) => {
      expect(isWalletFundingPath(pathname)).toBe(true);
    },
  );

  it.each([
    ["/wallet/fund", "buy"],
    ["/wallet/fund/send", "send"],
    ["/wallet/fund/send/", "send"],
    ["/wallet/fund/activity", "activity"],
    ["/wallet/fund/activity/", "activity"],
  ] as const)("selects the addressable funding tab for %s", (pathname, tab) => {
    expect(fundingTabForPath(pathname)).toBe(tab);
  });

  it.each(["/wallet", "/wallet/funding", "/wallet/fundraiser", "/wallet/fund-me"])(
    "does not bypass wallet setup for a prefix lookalike: %s",
    (pathname) => {
      expect(isWalletFundingPath(pathname)).toBe(false);
    },
  );
});
