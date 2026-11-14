import { openUrl } from "@tauri-apps/plugin-opener";
import { isMobileRuntime, isTauri } from "@/lib/platform";

/** Read-only destination, constant host/path, optional validated txid. No authority. */
export function walletHistoryLink(txid?: string): string {
  if (txid !== undefined && !/^[0-9a-f]{64}$/.test(txid)) {
    throw new Error("Invalid transaction identifier");
  }
  return `https://free2z.com/bridge/zuuli/#history=${txid ?? "all"}`;
}
export async function openWalletHistory(txid?: string): Promise<void> {
  if (!isTauri() || !isMobileRuntime())
    throw new Error("Mobile ZUULI required");
  await openUrl(walletHistoryLink(txid));
}
