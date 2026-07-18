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
      className="group flex items-center gap-3 rounded-xl border border-border bg-card/70 px-4 py-3 shadow-sm backdrop-blur transition-colors hover:border-primary/40 hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <span
        className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-lg", accent)}
        aria-hidden
      >
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div className="text-base font-semibold tabular-nums leading-tight">
          {loading ? "—" : value}
        </div>
      </div>
      <ArrowUpRight className="ml-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
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
    <div className="zuuli-hero-glow relative overflow-hidden rounded-2xl border border-border bg-card/40 px-6 py-10 md:px-10 md:py-14">
      <div className="max-w-2xl space-y-3">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
          Discover
        </p>
        <h1 className="text-3xl font-bold tracking-tight md:text-5xl">
          <span className="zuuli-gradient-text">{greeting}</span>
        </h1>
        <p className="max-w-xl text-sm text-muted-foreground md:text-base">
          Livestreams, long-form writing, and any AI model — metered in 2Zs,
          shielded by default. Your key is your identity; the provider never
          sees you.
        </p>
      </div>

      <div className="mt-8 flex flex-wrap gap-3">
        <StatChip
          to="/buy"
          icon={Coins}
          label="2Z balance"
          value={formatTuzis(tuzis)}
          loading={sessionLoading}
          accent="bg-primary/15 text-primary"
          ariaLabel={`2Z balance ${formatTuzis(tuzis)}. Buy more 2Z.`}
        />
        <StatChip
          to="/wallet"
          icon={Wallet}
          label="ZEC spendable"
          value={`${formatZecTrim(spendable)} ZEC`}
          loading={walletLoading}
          accent="bg-[#f4b728]/15 text-[#f4b728]"
          ariaLabel={`ZEC spendable ${formatZecTrim(spendable)}. Open wallet.`}
        />
      </div>
    </div>
  );
}
