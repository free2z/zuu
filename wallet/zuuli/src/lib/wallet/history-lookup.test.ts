import { afterEach, expect, it, vi } from "vitest";
import type { TransactionEntry } from "./types";
vi.mock("./bridge", () => ({ wallet: { getTransactionHistory: vi.fn() } }));
import { wallet } from "./bridge";
import { findWalletTransaction } from "./history-lookup";
const txid = "ab".repeat(32);
const tx = {
  txid,
  value: -50_000,
  incoming: false,
  memo: null,
  blockHeight: null,
  timestamp: null,
} satisfies TransactionEntry;
const page = Array.from({ length: 500 }, () => ({
  ...tx,
  txid: "cd".repeat(32),
}));
afterEach(() => vi.resetAllMocks());
it("finds an older receipt beyond the default first page without creating a payment", async () => {
  vi.mocked(wallet.getTransactionHistory).mockImplementation(
    async (_account, offset) => (offset === 0 ? page : [tx]),
  );
  await expect(findWalletTransaction(txid)).resolves.toEqual(tx);
  expect(wallet.getTransactionHistory).toHaveBeenNthCalledWith(2, 0, 500, 500);
});
it("only reports missing after a complete history read", async () => {
  vi.mocked(wallet.getTransactionHistory).mockResolvedValue([
    { ...tx, txid: "cd".repeat(32) },
  ]);
  await expect(findWalletTransaction(txid)).resolves.toBeNull();
});
it("does not interpret an adapter failure or exhausted lookup budget as absence", async () => {
  vi.mocked(wallet.getTransactionHistory).mockRejectedValueOnce(
    new Error("wallet unavailable"),
  );
  await expect(findWalletTransaction(txid)).rejects.toThrow(
    "wallet unavailable",
  );
  vi.mocked(wallet.getTransactionHistory).mockResolvedValue(page);
  await expect(findWalletTransaction(txid)).rejects.toThrow(
    "absence is unknown",
  );
  expect(wallet.getTransactionHistory).toHaveBeenCalledTimes(21);
});
it("never forwards an invalid identifier into wallet lookup", async () => {
  await expect(findWalletTransaction("../../send")).rejects.toThrow(
    "Invalid transaction identifier",
  );
  expect(wallet.getTransactionHistory).not.toHaveBeenCalled();
});
