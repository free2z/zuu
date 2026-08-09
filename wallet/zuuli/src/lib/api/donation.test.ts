import { describe, expect, it } from "vitest";
import {
  DonationContractError,
  authoritativeBalanceFromErrorBody,
  normalizeDonationResult,
  parseBalanceTuzis,
  parseWholeTuzis,
} from "./donation";

describe("idempotent donation wire contract", () => {
  it.each([
    [0, 0],
    [42, 42],
    ["42", 42],
    ["42.00", 42],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ] as const)("parses exact whole balance %s", (wire, expected) => {
    expect(parseWholeTuzis(wire)).toBe(expected);
  });

  it.each([
    -1,
    1.2,
    "-1",
    "01",
    "1.2",
    "1e3",
    "NaN",
    String(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
  ])("rejects unsafe balance %s", (wire) => {
    expect(parseWholeTuzis(wire)).toBeNull();
  });

  it.each([
    [0, 0],
    [900.5, 900.5],
    ["900.500", 900.5],
    ["75.25", 75.25],
    ["0.001", 0.001],
  ] as const)("preserves exact Decimal(17,3) balance %s", (wire, expected) => {
    expect(parseBalanceTuzis(wire)).toBe(expected);
  });

  it.each([
    -0.001,
    "-0.001",
    "01.000",
    "1.0001",
    "1e3",
    "9007199254741.000",
  ])("rejects unsafe fractional balance %s", (wire) => {
    expect(parseBalanceTuzis(wire)).toBeNull();
  });

  it("normalizes the authoritative first-charge and replay responses", () => {
    expect(
      normalizeDonationResult(
        { balance: "900.500", charged: "100.000", replayed: false },
        100,
      ),
    ).toEqual({ balance: 900.5, charged: 100, replayed: false });
    expect(
      normalizeDonationResult(
        { balance: "900.500", charged: "100.000", replayed: true },
        100,
      ),
    ).toEqual({ balance: 900.5, charged: 100, replayed: true });
  });

  it.each([
    900,
    { balance: "bad", charged: "100", replayed: false },
    { balance: "900", charged: "101", replayed: false },
    { balance: "900", charged: "100", replayed: "false" },
  ])("rejects malformed or mismatched result %#", (response) => {
    expect(() => normalizeDonationResult(response, 100)).toThrow(
      DonationContractError,
    );
  });

  it("extracts an authoritative balance only from a valid error body", () => {
    expect(authoritativeBalanceFromErrorBody({ balance: "75.250" })).toBe(
      75.25,
    );
    expect(authoritativeBalanceFromErrorBody({ balance: "75.2501" })).toBeNull();
    expect(authoritativeBalanceFromErrorBody("75")).toBeNull();
  });
});
