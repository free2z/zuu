import { describe, expect, it } from "vitest";
import { assertExactSendProposal } from "./amounts";

describe("assertExactSendProposal", () => {
  const expected = { recipient: "u1recipient", amount: 100_000_001, memo: "private note" };
  const exact = {
    proposalId: 1,
    review: {
      version: 1,
      network: "mainnet" as const,
      payments: [{ ...expected }],
      feePolicy: "zip317-standard",
      fee: 10_000,
      total: 100_010_001,
      changePolicy: "zip317-shielded-auto",
    },
    reviewDigest: "a".repeat(64),
    confirmationToken: "b".repeat(64),
  };

  it("accepts a safe proposal whose amount and total are exact", () => {
    expect(() => assertExactSendProposal(expected, exact)).not.toThrow();
  });

  it("rejects a wallet proposal that changes any requested field", () => {
    expect(() => assertExactSendProposal({ ...expected, amount: expected.amount - 1 }, exact)).toThrow(
      "changed the requested payment",
    );
    expect(() =>
      assertExactSendProposal(expected, {
        ...exact,
        review: {
          ...exact.review,
          payments: [{ ...expected, recipient: "u1different" }],
        },
      }),
    ).toThrow("changed the requested payment");
  });

  it("rejects inconsistent or non-integer proposal totals", () => {
    expect(() =>
      assertExactSendProposal(expected, {
        ...exact,
        review: { ...exact.review, total: exact.review.total + 1 },
      }),
    ).toThrow("invalid payment totals");
    expect(() =>
      assertExactSendProposal(expected, {
        ...exact,
        review: {
          ...exact.review,
          fee: 0.5,
          total: expected.amount + 0.5,
        },
      }),
    ).toThrow("invalid payment totals");
  });

  it("rejects unknown policy and malformed confirmation credentials", () => {
    expect(() =>
      assertExactSendProposal(expected, {
        ...exact,
        review: { ...exact.review, feePolicy: "unknown" },
      }),
    ).toThrow("unsupported review authorization");
    expect(() =>
      assertExactSendProposal(expected, { ...exact, confirmationToken: "short" }),
    ).toThrow("unsupported review authorization");
  });
});
