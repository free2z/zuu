import { ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useSession } from "@/store/session";
import { useWallet } from "@/store/wallet";
import { formatZecTrim } from "@/lib/format";

/**
 * The "two balances, one app" hero: 2Z platform-credit balance front and
 * centre, and the on-chain ZEC spendable alongside. The 2Z balance is shown
 * in 2Z units only — it's a spendable credit, not a cash value, so we never
 * print a "$X" equivalent next to it.
 *
 * Both readouts follow the house rule for money: the digits are set in the
 * mono face with fixed-width figures and tight tracking, always in the primary
 * text colour, and the unit beside them carries the currency's colour. That
 * keeps the two amounts on one visual grid and lets the eye compare magnitudes
 * before it reads the labels. The card separates from the page with a hairline
 * and a single step of lift — no gradient, no glow.
 */
export function BalanceHero() {
  const tuzis = useSession((s) => s.tuzis);
  const balance = useWallet((s) => s.balance);
  const walletLoading = useWallet((s) => s.loading);

  return (
    <Card className="overflow-hidden">
      <div className="grid gap-6 p-6 sm:grid-cols-[1.4fr_auto_1fr] sm:items-center sm:p-8">
        {/* 2Z balance */}
        <div className="space-y-2.5">
          <div className="eyebrow text-muted-foreground">2Z balance</div>
          <div className="numeral flex min-w-0 items-baseline leading-none">
            <span className="text-4xl font-semibold text-foreground md:text-5xl">
              {tuzis.toLocaleString()}
            </span>
            <span className="ml-2 text-sm font-semibold tracking-[0.06em] text-tuzi md:text-base">
              2Z
            </span>
          </div>
          <div className="text-sm text-muted-foreground">
            Spendable platform credit
          </div>
        </div>

        {/* divider */}
        <div aria-hidden className="hidden h-16 w-px bg-border sm:block" />

        {/* ZEC spendable */}
        <div className="space-y-2.5">
          <div className="eyebrow text-muted-foreground">ZEC in wallet</div>
          {walletLoading && !balance ? (
            <Skeleton className="h-9 w-32" />
          ) : (
            <div className="numeral flex min-w-0 items-baseline leading-none">
              <span className="text-2xl font-semibold text-foreground md:text-3xl">
                {formatZecTrim(balance?.spendable ?? 0)}
              </span>
              <span className="ml-1.5 text-xs font-semibold tracking-[0.06em] text-zec md:text-sm">
                ZEC
              </span>
            </div>
          )}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Badge variant="zec">spendable</Badge>
            <ArrowRight className="h-3 w-3" aria-hidden />
            <span>fund 2Zs instantly</span>
          </div>
        </div>
      </div>
    </Card>
  );
}
