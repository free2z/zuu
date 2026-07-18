// Wallet overview: balance, sync, address, recent activity.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDownToLine, ArrowUpRight, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { formatZecDisplay, splitZec } from "@/lib/format";
import { wallet } from "@/lib/wallet/bridge";
import type { TransactionEntry } from "@/lib/wallet/types";
import { useWallet } from "@/store/wallet";
import { AmountDisplay } from "./shared";
import { AddressCard, SyncBar, TxRow, ViewAllLink } from "./components";

export function Overview() {
  const balance = useWallet((s) => s.balance);
  const sync = useWallet((s) => s.sync);
  const unifiedAddress = useWallet((s) => s.unifiedAddress);
  const refreshSync = useWallet((s) => s.refreshSync);

  const [syncBusy, setSyncBusy] = useState(false);
  const [recent, setRecent] = useState<TransactionEntry[] | null>(null);
  const pollRef = useRef<number | null>(null);

  // Load a small recent-activity preview.
  useEffect(() => {
    let alive = true;
    void wallet
      .getTransactionHistory(0)
      .then((tx) => {
        if (alive) setRecent(tx.slice(0, 4));
      })
      .catch(() => {
        if (alive) setRecent([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Poll sync status roughly every 1.5s while a sync is in progress.
  useEffect(() => {
    const syncing = sync?.syncing ?? false;
    if (syncing && pollRef.current === null) {
      pollRef.current = window.setInterval(() => {
        void refreshSync();
      }, 1500);
    }
    if (!syncing && pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [sync?.syncing, refreshSync]);

  const onToggleSync = useCallback(async () => {
    setSyncBusy(true);
    try {
      if (sync?.syncing) {
        await wallet.stopSync();
      } else {
        await wallet.startSync();
      }
      await refreshSync();
    } finally {
      setSyncBusy(false);
    }
  }, [sync?.syncing, refreshSync]);

  const pending = balance
    ? balance.valuePending + balance.changePending
    : 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Balance hero */}
        <Card className="relative overflow-hidden rounded-xl lg:col-span-2">
          <div className="zuuli-hero-glow pointer-events-none absolute inset-0" />
          <CardContent className="relative space-y-5 p-6">
            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Spendable balance
              </div>
              {balance ? (
                <AmountDisplay
                  whole={splitZec(balance.spendable).whole}
                  decimal={splitZec(balance.spendable).decimal}
                  size="lg"
                />
              ) : (
                <Skeleton className="h-14 w-64" />
              )}
            </div>

            <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">Pending</div>
                {balance ? (
                  <div className="font-medium tabular-nums text-foreground">
                    {formatZecDisplay(pending)}
                  </div>
                ) : (
                  <Skeleton className="mt-1 h-5 w-24" />
                )}
              </div>
              <div>
                <div className="text-xs text-muted-foreground">
                  Total shielded
                </div>
                {balance ? (
                  <div className="font-medium tabular-nums text-foreground">
                    {formatZecDisplay(balance.totalShielded)}
                  </div>
                ) : (
                  <Skeleton className="mt-1 h-5 w-24" />
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              <Button asChild variant="zec" size="lg">
                <Link to="/wallet/send">
                  <ArrowUpRight className="h-4 w-4" />
                  Send
                </Link>
              </Button>
              <Button asChild variant="secondary" size="lg">
                <Link to="/wallet/receive">
                  <ArrowDownToLine className="h-4 w-4" />
                  Receive
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Sync + address column */}
        <div className="space-y-6">
          <SyncBar sync={sync} busy={syncBusy} onToggle={onToggleSync} />
          {unifiedAddress ? (
            <AddressCard address={unifiedAddress} compact />
          ) : (
            <Card className="rounded-xl p-4">
              <Skeleton className="h-20 w-full" />
            </Card>
          )}
        </div>
      </div>

      {/* Recent activity */}
      <Card className="rounded-xl">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Recent activity</CardTitle>
          {recent && recent.length > 0 ? <ViewAllLink /> : null}
        </CardHeader>
        <CardContent className="pt-0">
          {recent === null ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-3">
                  <Skeleton className="h-9 w-9 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-3 w-40" />
                  </div>
                  <Skeleton className="h-4 w-20" />
                </div>
              ))}
            </div>
          ) : recent.length === 0 ? (
            <EmptyState
              icon={History}
              title="No transactions yet"
              description="Once you send or receive ZEC, your activity shows up here."
            />
          ) : (
            <div className="-mx-3 divide-y divide-border/60">
              {recent.map((tx) => (
                <TxRow key={tx.txid} tx={tx} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
