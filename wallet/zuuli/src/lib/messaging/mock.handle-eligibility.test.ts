// `evaluateHandle`'s doc comment (mock.ts §11.3) already states the rule: the
// raw-ASCII check runs before `toLowerCase()`, because `toLowerCase()` can
// turn a non-ASCII string into an ASCII one. U+212A KELVIN SIGN is the
// concrete case that ordering exists for — `"K".toLowerCase()` is `"k"`,
// so a check that lower-cased first and then tested for ASCII would let it
// through as a plain ASCII handle. Nothing exercised that ordering as a
// regression test before this file, so a future edit could restore the
// case-fold-then-check order without any test failing.
import { describe, expect, it } from "vitest";
import { evaluateHandle } from "./mock";

describe("handle eligibility uses raw ASCII before case mapping", () => {
  it("rejects Unicode characters that a Unicode lowercase could map to ASCII", () => {
    expect(evaluateHandle("K")).toEqual({
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
