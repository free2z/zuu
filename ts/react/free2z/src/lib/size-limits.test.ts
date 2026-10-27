import { getMessage, maxBytesForTuzis, MB } from "./size-limits";

describe("upload request size limits", () => {
  it("keeps the 5000 2Z rung at the buffered request cap", () => {
    expect(maxBytesForTuzis(0)).toBe(5 * MB);
    expect(maxBytesForTuzis(0.999)).toBe(5 * MB);
    expect(maxBytesForTuzis(1)).toBe(250 * MB);
    expect(maxBytesForTuzis(4999.999)).toBe(250 * MB);
    expect(maxBytesForTuzis(5000)).toBe(250 * MB);
    expect(maxBytesForTuzis(100000)).toBe(250 * MB);
  });

  it("does not promise a larger upload at 5000 2Z", () => {
    expect(getMessage(250 * MB)).toContain("request cap is 250MB");
    expect(getMessage(250 * MB)).not.toMatch(/5\s*GB/i);
  });
});
