import { describe, expect, it } from "vitest";
import { assertExactSendProposal } from "./amounts";

describe("assertExactSendProposal", () => {
  const exact = { proposalId: 1, amount: 100_000_001, fee: 10_000, total: 100_010_001 };

  it("accepts a safe proposal whose amount and total are exact", () => {
    expect(() => assertExactSendProposal(exact.amount, exact)).not.toThrow();
  });

  it("rejects a wallet proposal that changes the entered amount", () => {
    expect(() => assertExactSendProposal(exact.amount - 1, exact)).toThrow(
      "changed the payment amount",
    );
  });

  it("rejects inconsistent or non-integer proposal totals", () => {
    expect(() =>
      assertExactSendProposal(exact.amount, { ...exact, total: exact.total + 1 }),
    ).toThrow("invalid payment totals");
    expect(() =>
      assertExactSendProposal(exact.amount, { ...exact, fee: 0.5, total: exact.amount + 0.5 }),
    ).toThrow("invalid payment totals");
  });
});
