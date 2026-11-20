import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ mobile: true, native: true, open: vi.fn() }));
vi.mock("@/lib/platform", () => ({
  isTauri: () => mocks.native,
  isMobileRuntime: () => mocks.mobile,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.open }));
import { openWalletHistory, walletHistoryLink } from "./wallet-history";
it("opens only a bounded read-only App Link with the full txid in the fragment", async () => {
  const txid = "ab".repeat(32);
  expect(walletHistoryLink(txid)).toBe(
    `https://free2z.com/bridge/zuuli/#history=${txid}`,
  );
  expect(walletHistoryLink()).toBe(
    "https://free2z.com/bridge/zuuli/#history=all",
  );
  for (const invalid of [
    "",
    "ab",
    "zz".repeat(32),
    txid + "&req=00",
    "https://evil.example/",
  ]) {
    expect(() => walletHistoryLink(invalid)).toThrow();
  }
  await openWalletHistory(txid);
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith(walletHistoryLink(txid));
  mocks.mobile = false;
  await expect(openWalletHistory(txid)).rejects.toThrow(
    "Mobile ZUULI required",
  );
  expect(mocks.open).toHaveBeenCalledTimes(1);
});
