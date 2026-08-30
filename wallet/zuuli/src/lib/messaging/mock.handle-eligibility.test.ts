import { describe, expect, it } from "vitest";
import { evaluateHandle } from "./mock";

describe("handle eligibility uses raw ASCII before case mapping", () => {
  it("rejects Unicode characters that a Unicode lowercase could map to ASCII", () => {
    expect(evaluateHandle("\u212A")).toEqual({
      eligible: false,
      candidate: null,
      reason: "non-ascii",
    });
  });

  it("maps ASCII uppercase only after the raw ASCII check", () => {
    expect(evaluateHandle("Alice_1")).toEqual({
      eligible: true,
      candidate: "alice_1",
      reason: null,
    });
  });
});
