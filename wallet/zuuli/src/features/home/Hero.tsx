import { Link } from "react-router-dom";
import { Coins, Wallet, ArrowUpRight } from "lucide-react";
import { formatTuzis, formatZecTrim } from "@/lib/format";
import { useSession } from "@/store/session";
import { useWallet } from "@/store/wallet";
import { cn } from "@/lib/utils";

/** One tappable stat chip linking to a balance destination. */
function StatChip({
  to,
  icon: Icon,
  label,
  value,
  loading,
  accent,
  ariaLabel,
}: {
  to: string;
  icon: typeof Coins;
  label: string;
  value: string;
  loading?: boolean;
  accent: string;
  ariaLabel: string;
}) {
  return (
    <Link
      to={to}
      aria-label={ariaLabel}
      className="group flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <span
        className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-lg", accent)}
        aria-hidden
      >
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0">
        <div className="eyebrow text-muted-foreground">{label}</div>
        <div className="bidi-number numeral text-lg font-medium leading-tight">
          {loading ? "—" : value}
        </div>
      </div>
      <ArrowUpRight className="rtl:-scale-x-100 ms-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 ltr:group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5" />
    </Link>
  );
}

export function Hero() {
  const user = useSession((s) => s.user);
  const tuzis = useSession((s) => s.tuzis);
  const sessionLoading = useSession((s) => s.loading);
  const balance = useWallet((s) => s.balance);
  const walletLoading = useWallet((s) => s.loading);

  const name = user?.display_name || user?.username;
  const greeting = name ? `Welcome back, ${name}` : "Welcome to ZUULI";
  const spendable = balance?.spendable ?? 0;

  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-card px-6 py-10 md:px-10 md:py-14">
      <div className="max-w-2xl space-y-3">
        <p className="eyebrow text-muted-foreground">Your vault</p>
        <h1 className="text-3xl font-semibold md:text-4xl">{greeting}</h1>
        <p className="max-w-xl text-sm text-muted-foreground md:text-base">
          Your seed and your spending keys live in this app and never leave it.
          ZUULI signs and sends; it renders nothing it did not write.
        </p>
      </div>

      <div className="mt-8 flex flex-wrap gap-3">
        <StatChip
          to="/wallet/fund"
          icon={Coins}
          label="2Z balance"
          value={formatTuzis(tuzis)}
          loading={sessionLoading}
          accent="bg-tuzi/10 text-tuzi"
          ariaLabel={`2Z balance ${formatTuzis(tuzis)}. Buy more 2Z.`}
        />
        <StatChip
          to="/wallet"
          icon={Wallet}
          label="ZEC spendable"
          value={`${formatZecTrim(spendable)} ZEC`}
          loading={walletLoading}
          accent="bg-zec/10 text-zec"
          ariaLabel={`ZEC spendable ${formatZecTrim(spendable)}. Open wallet.`}
        />
      </div>
    </div>
  );
}
