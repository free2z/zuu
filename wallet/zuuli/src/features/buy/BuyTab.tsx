import { useEffect, useState } from "react";
import { CreditCard, Check, Loader2, ShieldCheck, Wallet } from "lucide-react";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { pricing, tuzi } from "@/lib/api/free2z";
import { useSession } from "@/store/session";
import { useWallet } from "@/store/wallet";
import { cn } from "@/lib/utils";
import {
  ZATOSHIS_PER_ZEC,
  formatTuzis,
  formatUsd,
  formatZecTrim,
  tuzisToUsd,
} from "@/lib/format";
import { BUY_PACKS, MAX_TUZIS, parseTuzis } from "./lib";
import type { PricingQuote } from "@/lib/api/types";

/** Open an external URL, falling back to a browser tab outside Tauri. */
async function open(url: string) {
  try {
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

type QuoteState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; quote: PricingQuote }
  | { status: "error" };

export function BuyTab() {
  const adjustTuzis = useSession((s) => s.adjustTuzis);
  const spendable = useWallet((s) => s.balance?.spendable ?? 0);

  const [selected, setSelected] = useState<number>(BUY_PACKS[1]);
  const [custom, setCustom] = useState("");
  const [cardLoading, setCardLoading] = useState(false);
  const [zecConfirm, setZecConfirm] = useState(false);
  const [zecLoading, setZecLoading] = useState(false);
  const [quoteState, setQuoteState] = useState<QuoteState>({ status: "idle" });

  // The custom field wins when it holds a valid amount, keeping one source of
  // truth for "amount". Everything downstream reads `amount`.
  const customTuzis = parseTuzis(custom);
  const amount = custom.trim() ? customTuzis : selected;
  const valid = amount > 0 && amount <= MAX_TUZIS;

  const usd = tuzisToUsd(amount);

  // Live ZEC cost from the backend pricing service, debounced on the amount.
  // We NEVER recompute ZEC on the client — the backend returns the exact
  // `zec_amount`. A cancel flag keeps only the latest request's result, and a
  // 503 / fetch error surfaces as an "unavailable" state (no fabricated number).
  useEffect(() => {
    if (!valid) {
      setQuoteState({ status: "idle" });
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    setQuoteState({ status: "loading" });
    const t = setTimeout(() => {
      pricing
        .quote(amount, ctrl.signal)
        .then((quote) => {
          if (!cancelled) setQuoteState({ status: "ready", quote });
        })
        .catch(() => {
          if (!cancelled) setQuoteState({ status: "error" });
        });
    }, 300);
    return () => {
      cancelled = true;
      ctrl.abort();
      clearTimeout(t);
    };
  }, [amount, valid]);

  const quote = quoteState.status === "ready" ? quoteState.quote : null;
  const zatoshisNeeded = quote
    ? Math.round(Number(quote.zec_amount) * ZATOSHIS_PER_ZEC)
    : 0;
  const enoughZec = !!quote && spendable >= zatoshisNeeded;
  const isEstimate = !!quote && (quote.stale || quote.bootstrap);
  const quoteLoading = quoteState.status === "loading";
  const quoteUnavailable = quoteState.status === "error";

  async function payWithCard() {
    if (!valid) return;
    setCardLoading(true);
    try {
      const { url } = await tuzi.buyCheckout(amount);
      toast.info("Opening secure checkout…", {
        description: "Complete your purchase with Stripe.",
      });
      await open(url);
    } catch {
      toast.error("Could not start checkout. Please try again.");
    } finally {
      setCardLoading(false);
    }
  }

  async function payWithZec() {
    if (!valid || !quote || !enoughZec) return;
    setZecLoading(true);
    try {
      // Mock settlement — in production this proposes + broadcasts a shielded
      // spend, then the backend credits the 2Zs on confirmation.
      await new Promise((r) => setTimeout(r, 650));
      adjustTuzis(amount);
      toast.success(`Bought ${formatTuzis(amount)} with ZEC`, {
        description: `${quote.zec_amount} ZEC debited from your wallet.`,
      });
      setZecConfirm(false);
    } finally {
      setZecLoading(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
      {/* Packs + custom */}
      <div className="space-y-5">
        <div>
          <h2 className="text-sm font-semibold">Choose an amount</h2>
          <p className="text-sm text-muted-foreground">
            2Zs never expire and power AI, tips, pay-per-view and subscriptions.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {BUY_PACKS.map((pack) => {
            const active = !custom.trim() && selected === pack;
            return (
              <button
                key={pack}
                type="button"
                onClick={() => {
                  setSelected(pack);
                  setCustom("");
                }}
                aria-pressed={active}
                aria-label={`Buy ${formatTuzis(pack)} for ${formatUsd(tuzisToUsd(pack))}`}
                className={cn(
                  "group relative flex flex-col items-start gap-1 rounded-xl border p-4 text-left transition-all",
                  active
                    ? "border-primary bg-primary/10 shadow-glow"
                    : "border-border bg-card hover:border-primary/40 hover:bg-primary/5",
                )}
              >
                {active && (
                  <span className="absolute right-3 top-3 grid h-5 w-5 place-items-center rounded-full bg-primary text-primary-foreground">
                    <Check className="h-3 w-3" />
                  </span>
                )}
                <span className="text-lg font-bold tabular-nums">
                  {pack.toLocaleString()}
                </span>
                <span className="text-xs font-medium text-primary">2Z</span>
                <span className="mt-1 text-sm font-semibold tabular-nums text-muted-foreground">
                  {formatUsd(tuzisToUsd(pack))}
                </span>
              </button>
            );
          })}
        </div>

        <div className="space-y-2">
          <Label htmlFor="custom-tuzis">Custom amount (2Z)</Label>
          <div className="relative">
            <Input
              id="custom-tuzis"
              inputMode="numeric"
              placeholder="e.g. 3,000"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              className="pr-24 tabular-nums"
              aria-describedby="custom-tuzis-usd"
            />
            <span
              id="custom-tuzis-usd"
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium tabular-nums text-muted-foreground"
            >
              {custom.trim() && customTuzis > 0
                ? formatUsd(tuzisToUsd(customTuzis))
                : "2Z"}
            </span>
          </div>
          {custom.trim() && customTuzis > MAX_TUZIS && (
            <p className="text-xs text-destructive">
              Max {MAX_TUZIS.toLocaleString()} 2Z per purchase.
            </p>
          )}
        </div>
      </div>

      {/* Checkout panel */}
      <Card className="h-fit lg:sticky lg:top-4">
        <CardHeader className="pb-4">
          <CardTitle className="flex items-baseline justify-between">
            <span>You pay</span>
            <span className="text-2xl font-bold tabular-nums">
              {valid ? formatUsd(usd) : "—"}
            </span>
          </CardTitle>
          <CardDescription className="tabular-nums">
            for {valid ? formatTuzis(amount) : "—"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button
            size="lg"
            className="w-full"
            disabled={!valid || cardLoading}
            onClick={payWithCard}
          >
            {cardLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CreditCard className="h-4 w-4" />
            )}
            Pay with card
          </Button>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
            Secured by Stripe. We never see your card details.
          </p>

          <div className="flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-xs text-muted-foreground">or</span>
            <Separator className="flex-1" />
          </div>

          <Button
            size="lg"
            variant="zec"
            className="w-full"
            disabled={!valid || !quote || !enoughZec || quoteLoading}
            onClick={() => setZecConfirm(true)}
          >
            <Wallet className="h-4 w-4" />
            Pay with ZEC
          </Button>
          <div className="space-y-1 text-xs">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="flex items-center gap-1">
                {isEstimate ? "Est. cost" : "Cost"}
                {isEstimate && (
                  <Badge variant="zec" className="px-1.5 py-0 text-[10px]">
                    estimated
                  </Badge>
                )}
              </span>
              <span className="tabular-nums text-zec">
                {!valid
                  ? "—"
                  : quoteLoading
                    ? "…"
                    : quote
                      ? `${quote.zec_amount} ZEC`
                      : "—"}
              </span>
            </div>
            <div className="flex items-center justify-between text-muted-foreground">
              <span>Wallet spendable</span>
              <span className="tabular-nums">
                {formatZecTrim(spendable)} ZEC
              </span>
            </div>
            {valid && quoteUnavailable && (
              <p className="pt-1 text-destructive">
                Live pricing unavailable — try again.
              </p>
            )}
            {valid && quote && !enoughZec && (
              <p className="pt-1 text-destructive">
                Not enough ZEC — top up your wallet or pay with card.
              </p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            No exchange, no leaving the app. Your wallet is right here — fund 2Zs
            straight from your shielded balance.
          </p>
        </CardContent>
      </Card>

      {/* ZEC confirm */}
      <Dialog open={zecConfirm} onOpenChange={(o) => !zecLoading && setZecConfirm(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm ZEC payment</DialogTitle>
            <DialogDescription>
              Fund your 2Z balance directly from your shielded wallet.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 rounded-lg border border-border bg-secondary/40 p-4 text-sm">
            <Row label="You receive" value={formatTuzis(amount)} strong />
            <Row label="USD value" value={formatUsd(usd)} />
            <Separator />
            <Row
              label={
                <span className="flex items-center gap-1.5">
                  {isEstimate ? "Estimated ZEC" : "ZEC to send"}
                  {isEstimate && (
                    <Badge variant="zec" className="px-1.5 py-0 text-[10px]">
                      estimated
                    </Badge>
                  )}
                </span>
              }
              value={quote ? `${quote.zec_amount} ZEC` : "—"}
              accent
            />
          </div>
          <p className="text-xs text-muted-foreground">
            The final ZEC amount is locked from a live quote at signing. This
            demo settles instantly.
          </p>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setZecConfirm(false)}
              disabled={zecLoading}
            >
              Cancel
            </Button>
            <Button variant="zec" onClick={payWithZec} disabled={zecLoading}>
              {zecLoading && <Loader2 className="h-4 w-4 animate-spin" />}
              Confirm &amp; pay
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  accent,
}: {
  label: React.ReactNode;
  value: string;
  strong?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          "tabular-nums",
          strong && "font-semibold",
          accent && "font-semibold text-zec",
        )}
      >
        {value}
      </span>
    </div>
  );
}
