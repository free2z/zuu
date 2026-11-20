import { describe, expect, it } from "vitest";
import { parseUsernameAvailability } from "./username-availability";

describe("username availability response", () => {
  it("accepts the server's normalized spelling", () => {
    expect(parseUsernameAvailability(" Ａlice ", { username: "Alice", status: "available" })).toEqual({ username: "Alice", status: "available" });
  });
  it.each([null, {}, { username: "other", status: "available" }, { username: null, status: "available" }, { username: "Alice", status: "unknown" }, { username: 4, status: "available" }])("rejects malformed response %j", (value) => {
    expect(() => parseUsernameAvailability("Alice", value)).toThrow();
  });
});
