import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { beginSensitiveEntry, endSensitiveDisplay } from "./tauri";

describe("Zuuallet production sensitive-entry bridge", () => {
  beforeEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("returns the native lease and releases its exact token and purpose", async () => {
    const invoke = vi.fn();
    (globalThis as { window?: unknown }).window = {
      __TAURI_INTERNALS__: { invoke },
    };
    invoke.mockResolvedValueOnce({ token: "zuuallet-native-token" });

    await expect(beginSensitiveEntry("zuualletRelink")).resolves.toEqual({
      token: "zuuallet-native-token",
    });
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      "plugin:zcash|begin_sensitive_entry",
      { args: { purpose: "zuualletRelink" } },
      undefined,
    );

    invoke.mockResolvedValueOnce(undefined);
    await endSensitiveDisplay("zuuallet-native-token", "zuualletRelink");
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      "plugin:zcash|end_sensitive_display",
      {
        args: { token: "zuuallet-native-token", purpose: "zuualletRelink" },
      },
      undefined,
    );
  });
});
