import { wallet } from "./bridge";
import type { TransactionEntry } from "./types";

/** Receipts must remain resolvable beyond the history screen's first page.
 * Read only through the existing paginated adapter, with a bounded work budget.
 * Exhausting that budget is an error, never evidence the transaction is absent.
 */
export async function findWalletTransaction(
  txid: string,
): Promise<TransactionEntry | null> {
  if (!/^[0-9a-f]{64}$/.test(txid))
    throw new Error("Invalid transaction identifier");
  const pageSize = 500;
  for (let page = 0; page < 20; page += 1) {
    const entries = await wallet.getTransactionHistory(
      0,
      page * pageSize,
      pageSize,
    );
    const found = entries.find((entry) => entry.txid === txid);
    if (found) return found;
    if (entries.length < pageSize) return null;
  }
  throw new Error(
    "Transaction lookup exceeded the history window; absence is unknown",
  );
}
