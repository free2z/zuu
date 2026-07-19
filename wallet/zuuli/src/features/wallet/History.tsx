// Full transaction history.
import { useEffect, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, History as HistoryIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import {
  formatDate,
  formatZecDisplay,
  truncateAddress,
} from "@/lib/format";
import { wallet } from "@/lib/wallet/bridge";
import type { TransactionEntry } from "@/lib/wallet/types";
import { cn } from "@/lib/utils";
import { CopyButton } from "./shared";

export function History() {
  const [txs, setTxs] = useState<TransactionEntry[] | null>(null);

  useEffect(() => {
    let alive = true;
    void wallet
      .getTransactionHistory(0)
      .then((res) => {
        if (alive) setTxs(res);
      })
      .catch(() => {
        if (alive) setTxs([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (txs === null) {
    return (
      <Card className="rounded-xl">
        <CardContent className="divide-y divide-border/60 p-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-4">
              <Skeleton className="h-10 w-10 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-48" />
              </div>
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  if (txs.length === 0) {
    return (
      <EmptyState
        icon={HistoryIcon}
        title="No transactions yet"
        description="Send or receive ZEC and every transaction will appear here."
      />
    );
  }

  return (
    <Card className="rounded-xl">
      <CardContent className="divide-y divide-border/60 p-2">
        {txs.map((tx) => (
          <HistoryRow key={tx.txid} tx={tx} />
        ))}
      </CardContent>
    </Card>
  );
}

function HistoryRow({ tx }: { tx: TransactionEntry }) {
  const incoming = tx.incoming;
  return (
    <div className="flex items-start gap-3 px-3 py-4">
      <div
        className={cn(
          "grid h-10 w-10 shrink-0 place-items-center rounded-full",
          incoming
            ? "bg-emerald-500/15 text-emerald-400"
            : "bg-secondary text-muted-foreground",
        )}
        aria-hidden
      >
        {incoming ? (
          <ArrowDownLeft className="h-4 w-4" />
        ) : (
          <ArrowUpRight className="h-4 w-4" />
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">
            {incoming ? "Received" : "Sent"}
          </span>
          {tx.blockHeight === null ? (
            <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              Pending
            </span>
          ) : null}
        </div>

        {tx.memo ? (
          <p className="text-sm text-muted-foreground" title={tx.memo}>
            {tx.memo}
          </p>
        ) : null}

        <div className="flex items-center gap-1.5">
          <span className="font-mono text-xs text-muted-foreground/70">
            {truncateAddress(tx.txid)}
          </span>
          <CopyButton
            value={tx.txid}
            label="Transaction ID copied"
            ariaLabel="Copy transaction ID"
            className="h-6 w-6"
          />
        </div>
      </div>

      <div className="shrink-0 text-right">
        <div
          className={cn(
            "text-sm font-semibold tabular-nums",
            incoming ? "text-emerald-400" : "text-foreground",
          )}
        >
          {incoming ? "+" : "−"}
          {formatZecDisplay(Math.abs(tx.value))}
        </div>
        <div className="text-xs tabular-nums text-muted-foreground">
          {formatDate(tx.timestamp)}
        </div>
      </div>
    </div>
  );
}
