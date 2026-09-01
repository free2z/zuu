import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("../platform", () => ({ useMock: () => false }));

import { wallet } from "./bridge";

describe("production sensitive-entry bridges", () => {
  beforeEach(() => {
    native.invoke.mockReset();
  });

  it("ZUULI returns the native lease and releases its exact token and purpose", async () => {
    native.invoke.mockResolvedValueOnce({ token: "zuuli-native-token" });

    await expect(wallet.beginSensitiveEntry("zuuliRestore")).resolves.toEqual({
      token: "zuuli-native-token",
    });
    expect(native.invoke).toHaveBeenNthCalledWith(
      1,
      "plugin:zcash|begin_sensitive_entry",
      { args: { purpose: "zuuliRestore" } },
    );

    native.invoke.mockResolvedValueOnce(undefined);
    await wallet.endSensitiveDisplay("zuuli-native-token", "zuuliRestore");
    expect(native.invoke).toHaveBeenNthCalledWith(
      2,
      "plugin:zcash|end_sensitive_display",
      {
        args: { token: "zuuli-native-token", purpose: "zuuliRestore" },
      },
    );
  });

});
