import { useEffect, useState } from "react";
import { Receipt, TrendingUp, TrendingDown } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { tuzi } from "@/lib/api/free2z";
import type { TuziTransaction } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { formatTuzis, formatUsd, timeAgo, tuzisToUsd } from "@/lib/format";
import { kindMeta, kindIconClass } from "./lib";

export function ActivityTab() {
  const [txns, setTxns] = useState<TuziTransaction[] | null>(null);

  useEffect(() => {
    let alive = true;
    tuzi
      .transactions()
      .then((t) => alive && setTxns(t))
      .catch(() => alive && setTxns([]));
    return () => {
      alive = false;
    };
  }, []);

  if (txns === null) {
    return (
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
        </div>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-xl" />
        ))}
      </div>
    );
  }

  if (txns.length === 0) {
    return (
      <EmptyState
        icon={Receipt}
        title="No activity yet"
        description="Your 2Z purchases, tips and charges will show up here."
      />
    );
  }

  const bought = txns
    .filter((t) => t.tuzis_credited > 0)
    .reduce((s, t) => s + t.tuzis_credited, 0);
  const spent = txns
    .filter((t) => t.tuzis_credited < 0)
    .reduce((s, t) => s + Math.abs(t.tuzis_credited), 0);

  return (
    <div className="space-y-4">
      {/* Summary chips — "Total spent" only appears once there is real spend
          (the purchases-only Stripe ledger has none, so it isn't shown as a
          permanent 0). */}
      <div className={cn("grid gap-3", spent > 0 && "sm:grid-cols-2")}>
        <SummaryChip
          icon={TrendingUp}
          label="Total bought"
          tuzis={bought}
          tone="credit"
        />
        {spent > 0 ? (
          <SummaryChip
            icon={TrendingDown}
            label="Total spent"
            tuzis={spent}
            tone="debit"
          />
        ) : null}
      </div>

      {/* Rows */}
      <Card>
        <CardContent className="divide-y divide-border p-0">
          {txns.map((t) => {
            const meta = kindMeta(t.kind);
            const Icon = meta.icon;
            const credit = t.tuzis_credited > 0;
            const label =
              t.counterparty ??
              (t.kind === "buy" ? "Added 2Zs" : meta.label);
            return (
              <div
                key={t.id}
                className="flex items-center gap-3 px-4 py-3.5"
              >
                <div
                  className={cn(
                    "grid h-10 w-10 shrink-0 place-items-center rounded-full",
                    kindIconClass(t.kind),
                  )}
                >
                  <Icon className="h-[18px] w-[18px]" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">
                      {t.counterparty ? `@${t.counterparty}` : label}
                    </span>
                    <Badge variant={meta.badge} className="shrink-0">
                      {meta.label}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {timeAgo(t.timestamp)}
                  </div>
                </div>
                <div className="text-right">
                  <div
                    className={cn(
                      "font-semibold tabular-nums",
                      credit ? "text-emerald-400" : "text-muted-foreground",
                    )}
                  >
                    {credit ? "+" : "−"}
                    {formatTuzis(Math.abs(t.tuzis_credited))}
                  </div>
                  <div className="text-xs tabular-nums text-muted-foreground">
                    {formatUsd(tuzisToUsd(Math.abs(t.tuzis_credited)))}
                  </div>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryChip({
  icon: Icon,
  label,
  tuzis,
  tone,
}: {
  icon: typeof TrendingUp;
  label: string;
  tuzis: number;
  tone: "credit" | "debit";
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div
          className={cn(
            "grid h-10 w-10 place-items-center rounded-full",
            tone === "credit"
              ? "bg-emerald-500/15 text-emerald-400"
              : "bg-secondary text-muted-foreground",
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-lg font-bold tabular-nums">
            {formatTuzis(tuzis)}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
