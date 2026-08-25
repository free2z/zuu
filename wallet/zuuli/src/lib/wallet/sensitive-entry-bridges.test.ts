import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("../platform", () => ({ useMock: () => false }));

import {
  beginSensitiveEntry as beginZuualletEntry,
  endSensitiveDisplay as endZuualletDisplay,
} from "../../../../zuuallet/src/lib/tauri";
import { wallet } from "./bridge";

describe("production sensitive-entry bridges", () => {
  beforeEach(() => {
    native.invoke.mockReset();
    delete (globalThis as { window?: unknown }).window;
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
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

  it("Zuuallet returns the native lease and releases its exact token and purpose", async () => {
    const classicInvoke = vi.fn();
    (globalThis as { window?: unknown }).window = {
      __TAURI_INTERNALS__: { invoke: classicInvoke },
    };
    classicInvoke.mockResolvedValueOnce({ token: "zuuallet-native-token" });

    await expect(beginZuualletEntry("zuualletRelink")).resolves.toEqual({
      token: "zuuallet-native-token",
    });
    expect(classicInvoke).toHaveBeenNthCalledWith(
      1,
      "plugin:zcash|begin_sensitive_entry",
      { args: { purpose: "zuualletRelink" } },
      undefined,
    );

    classicInvoke.mockResolvedValueOnce(undefined);
    await endZuualletDisplay("zuuallet-native-token", "zuualletRelink");
    expect(classicInvoke).toHaveBeenNthCalledWith(
      2,
      "plugin:zcash|end_sensitive_display",
      {
        args: { token: "zuuallet-native-token", purpose: "zuualletRelink" },
      },
      undefined,
    );
  });
});
