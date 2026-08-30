import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("../platform", () => ({ useMock: () => false }));

import { wallet } from "./bridge";

describe("wallet identity bridge", () => {
  beforeEach(() => native.invoke.mockReset());

  it("lists wallets through the exact typed native command", async () => {
    const inventory = [
      {
        id: "wallet-a",
        name: "Alpha",
        isActive: true,
        birthdayHeight: 100,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    native.invoke.mockResolvedValueOnce(inventory);

    await expect(wallet.listWallets()).resolves.toEqual(inventory);
    expect(native.invoke.mock.calls).toEqual([
      ["plugin:zcash|list_wallets", undefined],
    ]);
  });

  it("passes only the exact wallet identifier to native switching", async () => {
    native.invoke.mockResolvedValueOnce(undefined);

    await wallet.switchWallet("wallet-b");

    expect(native.invoke.mock.calls).toEqual([
      ["plugin:zcash|switch_wallet", { args: { walletId: "wallet-b" } }],
    ]);
  });
});
