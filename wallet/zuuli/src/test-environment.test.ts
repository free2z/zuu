import { describe, expect, it } from "vitest";

describe("Vitest environment", () => {
  it("uses fork workers so ICU boots with the configured en-US locale", () => {
    expect(Intl.NumberFormat().resolvedOptions().locale).toBe("en-US");
  });
});
