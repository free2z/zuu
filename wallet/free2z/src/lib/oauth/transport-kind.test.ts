import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: false,
  invoke: vi.fn(),
}));

vi.mock("../platform", () => ({
  isTauri: () => mocks.isTauri,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

async function resolveTransport() {
  const { oauthCallbackTransport } = await import("./transport");
  return oauthCallbackTransport();
}

describe("OAuth callback transport discriminator", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.isTauri = false;
    mocks.invoke.mockReset();
  });

  it("uses web without asking the native shell", async () => {
    await expect(resolveTransport()).resolves.toBe("web");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each(["desktop", "mobile"] as const)(
    "returns the native command's exact %s result",
    async (transport) => {
      mocks.isTauri = true;
      mocks.invoke.mockResolvedValue(transport);

      await expect(resolveTransport()).resolves.toBe(transport);
      expect(mocks.invoke).toHaveBeenCalledWith("oauth_callback_transport", undefined);
    },
  );

  it("rejects rather than guessing when the native command fails", async () => {
    mocks.isTauri = true;
    mocks.invoke.mockRejectedValue(new Error("native discriminator failed"));

    await expect(resolveTransport()).rejects.toThrow("native discriminator failed");
  });
});
