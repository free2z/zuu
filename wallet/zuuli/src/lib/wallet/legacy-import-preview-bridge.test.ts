import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("../platform", () => ({ useMock: () => false }));

import { wallet } from "./bridge";

describe("legacy import preview bridge", () => {
  beforeEach(() => native.invoke.mockReset());

  it("calls only the fixed read-only command with no caller arguments", async () => {
    const preview = {
      state: "absent",
      layout: null,
      wallets: [],
      diagnostics: ["No legacy data."],
    } as const;
    native.invoke.mockResolvedValue(preview);

    await expect(wallet.previewLegacyWalletImport()).resolves.toEqual(preview);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith(
      "plugin:zcash|preview_legacy_wallet_import",
      undefined,
    );
  });
});
