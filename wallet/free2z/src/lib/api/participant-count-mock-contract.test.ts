import { describe, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({ useMock: () => true }));

import { live } from "./free2z";

describe("mock participant count hydration", () => {
  it("keeps a missing creator unavailable instead of coercing it to zero", async () => {
    await expect(live.status("missing-creator")).resolves.toEqual({
      live: false,
      participants: null,
    });
  });
});
