import { Coins, ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useSession } from "@/store/session";
import { useWallet } from "@/store/wallet";
import { formatUsd, formatZecTrim, tuzisToUsd } from "@/lib/format";

/**
 * The "two balances, one app" hero: 2Z credit balance front and centre with
 * its USD value, and the on-chain ZEC spendable alongside.
 */
export function BalanceHero() {
  const tuzis = useSession((s) => s.tuzis);
  const balance = useWallet((s) => s.balance);
  const walletLoading = useWallet((s) => s.loading);

  return (
    <Card className="relative overflow-hidden border-primary/20 bg-gradient-to-br from-card via-card to-primary/5">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-16 h-52 w-52 rounded-full bg-primary/20 blur-3xl"
      />
      <div className="relative grid gap-6 p-6 sm:grid-cols-[1.4fr_auto_1fr] sm:items-center sm:p-8">
        {/* 2Z balance */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Coins className="h-3.5 w-3.5 text-primary" />
            2Z balance
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-bold tabular-nums tracking-tight md:text-5xl">
              {tuzis.toLocaleString()}
            </span>
            <span className="text-lg font-semibold text-primary">2Z</span>
          </div>
          <div className="text-sm text-muted-foreground tabular-nums">
            {formatUsd(tuzisToUsd(tuzis))} in spendable credit
          </div>
        </div>

        {/* divider */}
        <div
          aria-hidden
          className="hidden h-16 w-px bg-border sm:block"
        />

        {/* ZEC spendable */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <span className="grid h-3.5 w-3.5 place-items-center rounded-full bg-zec text-[9px] font-bold leading-none text-zec-fg">
              Z
            </span>
            ZEC in wallet
          </div>
          {walletLoading && !balance ? (
            <Skeleton className="h-9 w-32" />
          ) : (
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-bold tabular-nums tracking-tight text-zec md:text-3xl">
                {formatZecTrim(balance?.spendable ?? 0)}
              </span>
              <span className="text-sm font-semibold text-zec/80">ZEC</span>
            </div>
          )}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Badge variant="zec" className="gap-1">
              spendable
            </Badge>
            <ArrowRight className="h-3 w-3" />
            <span>fund 2Zs instantly</span>
          </div>
        </div>
      </div>
    </Card>
  );
}
