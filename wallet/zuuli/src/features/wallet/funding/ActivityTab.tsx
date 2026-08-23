import { LogIn, Receipt, TrendingUp, TrendingDown } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { SectionLoadError } from "@/components/common/SectionLoadError";
import { useAsync } from "@/hooks/useAsync";
import { tuzi } from "@/lib/api/free2z";
import type { TuziTransaction } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { formatTuzis, timeAgo } from "@/lib/format";
import { useSession } from "@/store/session";
import { kindMeta, kindIconClass } from "./lib";

export function ActivityTab() {
  const navigate = useNavigate();
  const user = useSession((state) => state.user);
  const sessionLoading = useSession((state) => state.loading);
  const {
    data: txns,
    loading,
    error,
    reload,
  } = useAsync<TuziTransaction[]>(
    () => (user ? tuzi.transactions() : Promise.resolve([])),
    [user?.username],
  );

  if (sessionLoading || (user && loading && txns === null && !error)) {
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

  if (!user) {
    return (
      <EmptyState
        icon={Receipt}
        title="Sign in to view activity"
        description="Card purchase history belongs to your account."
        action={
          <Button
            onClick={() =>
              navigate("/login", {
                state: { returnTo: "/wallet/fund/activity" },
              })
            }
          >
            <LogIn className="h-4 w-4" aria-hidden />
            Sign in
          </Button>
        }
      />
    );
  }

  if (error && txns === null) {
    return (
      <SectionLoadError
        title="Couldn't load purchase history"
        description="Your card purchase history is temporarily unavailable."
        retry={reload}
        retrying={loading}
      />
    );
  }

  if (!txns) return null;

  if (txns.length === 0) {
    return (
      <div className="space-y-3">
        {error ? (
          <SectionLoadError
            title="Couldn't refresh purchase history"
            description="Showing the last card purchase history loaded on this device."
            retry={reload}
            retrying={loading}
            stale
          />
        ) : null}
        <EmptyState
          icon={Receipt}
          title="No card purchases yet"
          description="Your available card purchase history will show up here."
        />
      </div>
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
      {error ? (
        <SectionLoadError
          title="Couldn't refresh purchase history"
          description="Showing the last card purchase history loaded on this device."
          retry={reload}
          retrying={loading}
          stale
        />
      ) : null}
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
              t.counterparty ?? (t.kind === "buy" ? "Added 2Zs" : meta.label);
            return (
              <div key={t.id} className="flex items-center gap-3 px-4 py-3.5">
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
                    <span className="min-w-0 break-words font-medium">
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
                      credit ? "text-success" : "text-muted-foreground",
                    )}
                  >
                    {credit ? "+" : "−"}
                    {formatTuzis(Math.abs(t.tuzis_credited))}
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
              ? "bg-success/10 text-success"
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
