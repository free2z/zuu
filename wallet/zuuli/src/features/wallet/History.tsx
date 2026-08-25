// Full transaction history.
import {
  ArrowDownLeft,
  ArrowUpRight,
  History as HistoryIcon,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { SectionLoadError } from "@/components/common/SectionLoadError";
import { BidiIdentifier } from "@/components/common/BidiIdentifier";
import { useAsync } from "@/hooks/useAsync";
import { formatDate, formatZecDisplay } from "@/lib/format";
import { wallet } from "@/lib/wallet/bridge";
import type { TransactionEntry } from "@/lib/wallet/types";
import { cn } from "@/lib/utils";
import { CopyButton } from "./shared";

export function History() {
  const {
    data: txs,
    loading,
    error,
    reload,
  } = useAsync<TransactionEntry[]>(() => wallet.getTransactionHistory(0), []);

  if (loading && txs === null && !error) {
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

  if (error && txs === null) {
    return (
      <SectionLoadError
        title="Couldn't load transaction history"
        description="Your transaction history is temporarily unavailable."
        retry={reload}
        retrying={loading}
      />
    );
  }

  if (!txs) return null;

  if (txs.length === 0) {
    return (
      <div className="space-y-3">
        {error ? (
          <SectionLoadError
            title="Couldn't refresh transaction history"
            description="Showing the last transaction history loaded on this device."
            retry={reload}
            retrying={loading}
            stale
          />
        ) : null}
        <EmptyState
          icon={HistoryIcon}
          title="No transactions yet"
          description="Send or receive ZEC and every transaction will appear here."
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error ? (
        <SectionLoadError
          title="Couldn't refresh transaction history"
          description="Showing the last transaction history loaded on this device."
          retry={reload}
          retrying={loading}
          stale
        />
      ) : null}
      <Card className="rounded-xl">
        <CardContent className="divide-y divide-border/60 p-2">
          {txs.map((tx) => (
            <HistoryRow key={tx.txid} tx={tx} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function HistoryRow({ tx }: { tx: TransactionEntry }) {
  const incoming = tx.incoming;
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 px-3 py-4 sm:flex sm:gap-3">
      <div
        className={cn(
          "grid h-10 w-10 shrink-0 place-items-center rounded-full",
          incoming
            ? "bg-success/10 text-success"
            : "bg-secondary text-muted-foreground",
        )}
        aria-hidden
      >
        {incoming ? (
          <ArrowDownLeft className="rtl:-scale-x-100 h-4 w-4" />
        ) : (
          <ArrowUpRight className="rtl:-scale-x-100 h-4 w-4" />
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">
            {incoming ? "Received" : "Sent"}
          </span>
          {tx.blockHeight === null ? (
            <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-xs font-medium text-primary">
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
          <BidiIdentifier
            value={tx.txid}
            shorten
            className="mono-id font-mono text-xs text-muted-foreground/70"
          />
          <CopyButton
            value={tx.txid}
            label="Transaction ID copied"
            ariaLabel="Copy transaction ID"
            className="h-6 w-6"
          />
        </div>
      </div>

      <div className="col-start-2 mt-1 flex min-w-0 items-baseline justify-between gap-2 text-start sm:mt-0 sm:block sm:shrink-0 sm:text-end">
        <div
          className={cn(
            "text-sm font-semibold bidi-number tabular-nums",
            incoming ? "text-success" : "text-foreground",
          )}
        >
          {incoming ? "+" : "−"}
          {formatZecDisplay(Math.abs(tx.value))}
        </div>
        <div className="text-xs bidi-number tabular-nums text-muted-foreground">
          {formatDate(tx.timestamp)}
        </div>
      </div>
    </div>
  );
}
