import { splitZec, formatZec } from "../lib/format";
import type { AccountBalance } from "../types";

interface Props {
  balance: AccountBalance | null;
}

export function BalanceDisplay({ balance }: Props) {
  if (!balance) {
    return (
      <div className="text-center py-8 animate-fade-in">
        <div className="h-12 w-48 mx-auto bg-zinc-800 rounded-lg animate-pulse" />
      </div>
    );
  }

  const { whole, decimal } = splitZec(balance.totalShielded);
  const pending = balance.changePending + balance.valuePending;

  return (
    <div className="text-center py-8 animate-fade-in">
      <div className="flex items-baseline justify-center">
        <span className="text-5xl font-bold text-white tracking-tight">{whole}</span>
        <span className="text-3xl text-zinc-500">{decimal}</span>
        <span className="text-lg text-zinc-500 ml-2">ZEC</span>
      </div>
      <div className="mt-4 flex items-center justify-center gap-6 text-sm">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          <span className="text-zinc-400">Spendable: {formatZec(balance.spendable)}</span>
        </div>
        {pending > 0 && (
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-amber-400" />
            <span className="text-zinc-400">Pending: {formatZec(pending)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
