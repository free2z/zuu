import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CreditCard,
  Check,
  Loader2,
  LogIn,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
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
  formatTuzis,
  formatUsd,
  formatZecTrim,
  MAX_TUZIS,
  tuziInputExample,
  tuziInputMaxLength,
  tuzisToUsd,
  validateTuzis,
} from "@/lib/format";
import { BUY_PACKS, zatoshisFromQuote } from "./lib";
import type { PricingQuote } from "@/lib/api/types";
import { isTauri, useMock } from "@/lib/platform";
import {
  canRunZecTopUpDemo,
  settleZecTopUpDemo,
  type ZecTopUpDemoRuntime,
} from "./zec-top-up-demo";
import {
  cardCheckoutFeedback,
  openCardCheckout,
  startCardCheckout,
} from "./card-checkout";
import { checkoutReturnMode } from "@/lib/checkout/native-return";

type QuoteState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; quote: PricingQuote }
  | { status: "error" };

export function BuyTab() {
  const navigate = useNavigate();
  const user = useSession((s) => s.user);
  const sessionLoading = useSession((s) => s.loading);
  const adjustTuzis = useSession((s) => s.adjustTuzis);
  const spendable = useWallet((s) => s.balance?.spendable ?? 0);
  const zecDemoRuntime: ZecTopUpDemoRuntime = {
    explicitMock: useMock(),
    development: Boolean(
      (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV,
    ),
    tauri: isTauri(),
  };
  const zecDemoEnabled = canRunZecTopUpDemo(zecDemoRuntime);

  const [selected, setSelected] = useState<number>(BUY_PACKS[1]);
  const [custom, setCustom] = useState("");
  const [cardLoading, setCardLoading] = useState(false);
  const [zecConfirm, setZecConfirm] = useState(false);
  const [zecLoading, setZecLoading] = useState(false);
  const [quoteState, setQuoteState] = useState<QuoteState>({ status: "idle" });

  // The custom field wins whenever it has input, keeping one source of
  // truth for "amount". Everything downstream reads `amount`.
  const hasCustomAmount = custom.length > 0;
  const customAmount = validateTuzis(custom, {
    minimum: 1,
    maximum: MAX_TUZIS,
  });
  const customTuzis = customAmount.value;
  const amount = hasCustomAmount ? customTuzis : selected;
  const valid = !hasCustomAmount || customAmount.error === null;

  const usd = tuzisToUsd(amount ?? 0);

  // Live ZEC cost from the backend pricing service, debounced on the amount.
  // We NEVER recompute ZEC on the client — the backend returns the exact
  // `zec_amount`. A cancel flag keeps only the latest request's result, and a
  // 503 / fetch error surfaces as an "unavailable" state (no fabricated number).
  useEffect(() => {
    if (!user || !zecDemoEnabled || !valid || amount === null) {
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
  }, [amount, user, valid, zecDemoEnabled]);

  const quote = quoteState.status === "ready" ? quoteState.quote : null;
  const zatoshisNeeded = quote ? zatoshisFromQuote(quote) : null;
  const validQuote = quote !== null && zatoshisNeeded !== null;
  const enoughZec = validQuote && spendable >= zatoshisNeeded;
  const isEstimate = !!quote && (quote.stale || quote.bootstrap);
  const quoteLoading = quoteState.status === "loading";
  const quoteUnavailable =
    quoteState.status === "error" ||
    (quoteState.status === "ready" && zatoshisNeeded === null);

  async function payWithCard() {
    if (!valid || amount === null) return;
    const authenticated = useSession.getState().user !== null;
    if (authenticated) setCardLoading(true);
    try {
      const result = await startCardCheckout({
        authenticated,
        amount,
        returnMode: await checkoutReturnMode(),
        createCheckout: tuzi.buyCheckout,
        openCheckout: openCardCheckout,
      });
      if (result === "sign-in") {
        navigate("/login", { state: { returnTo: "/wallet/fund" } });
        return;
      }
      toast.info("Opening secure checkout…", {
        description: "Complete your purchase with Stripe.",
      });
    } catch (error) {
      const feedback = cardCheckoutFeedback(error);
      toast.error(feedback.title, { description: feedback.description });
      if (feedback.signIn) {
        navigate("/login", { state: { returnTo: "/wallet/fund" } });
      }
    } finally {
      if (authenticated) setCardLoading(false);
    }
  }

  async function payWithZec() {
    if (!useSession.getState().user) {
      navigate("/login", { state: { returnTo: "/wallet/fund" } });
      return;
    }
    if (
      !zecDemoEnabled ||
      !valid ||
      amount === null ||
      !quote ||
      !validQuote ||
      !enoughZec
    ) {
      return;
    }
    setZecLoading(true);
    try {
      await settleZecTopUpDemo(zecDemoRuntime, amount, adjustTuzis);
      toast.success(`Demo: added ${formatTuzis(amount)}`, {
        description: "Local mock balance only. No ZEC was sent.",
      });
      setZecConfirm(false);
    } finally {
      setZecLoading(false);
    }
  }

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-[1.5fr_1fr]">
      {/* Packs + custom */}
      <div className="min-w-0 space-y-5">
        <div>
          <h2 className="text-sm font-semibold">Choose an amount</h2>
          <p className="text-sm text-muted-foreground">
            2Zs never expire and power AI, tips, pay-per-view and subscriptions.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {BUY_PACKS.map((pack) => {
            const active = !hasCustomAmount && selected === pack;
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
                  "min-tap group relative flex flex-col items-start gap-1 rounded-xl border p-4 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
              placeholder={`e.g. ${tuziInputExample()}`}
              maxLength={tuziInputMaxLength(MAX_TUZIS)}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              className="pr-24 tabular-nums"
              aria-describedby="custom-tuzis-usd custom-tuzis-error"
              aria-invalid={hasCustomAmount && !valid}
            />
            <span
              id="custom-tuzis-usd"
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium tabular-nums text-muted-foreground"
            >
              {hasCustomAmount && customTuzis !== null && customTuzis > 0
                ? formatUsd(tuzisToUsd(customTuzis))
                : "2Z"}
            </span>
          </div>
          <div
            id="custom-tuzis-error"
            className="min-h-[1rem] text-xs text-destructive"
          >
            {hasCustomAmount && customAmount.error === "tooLarge"
              ? `Max ${MAX_TUZIS.toLocaleString()} 2Z per purchase.`
              : hasCustomAmount && customAmount.error !== null
                ? `Enter a positive whole 2Z amount, e.g. ${tuziInputExample()}.`
                : null}
          </div>
        </div>
      </div>

      {/* Checkout panel */}
      <Card className="h-fit min-w-0 lg:sticky lg:top-4">
        <CardHeader className="pb-4">
          <CardTitle className="flex items-baseline justify-between">
            <span>You pay</span>
            <span className="text-2xl font-bold tabular-nums">
              {valid ? formatUsd(usd) : "—"}
            </span>
          </CardTitle>
          <CardDescription className="tabular-nums">
            for {valid && amount !== null ? formatTuzis(amount) : "—"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button
            size="lg"
            className="w-full"
            disabled={!valid || cardLoading || sessionLoading}
            onClick={payWithCard}
          >
            {cardLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : !user ? (
              <LogIn className="h-4 w-4" />
            ) : (
              <CreditCard className="h-4 w-4" />
            )}
            {user ? "Pay with card" : "Log in to buy"}
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
            disabled={
              sessionLoading ||
              (user !== null && !zecDemoEnabled) ||
              !valid ||
              (user !== null && (!validQuote || !enoughZec || quoteLoading))
            }
            onClick={() => {
              if (!user) void payWithZec();
              else setZecConfirm(true);
            }}
          >
            {!user ? (
              <LogIn className="h-4 w-4" />
            ) : (
              <Wallet className="h-4 w-4" />
            )}
            {!user
              ? "Log in to pay with ZEC"
              : zecDemoEnabled
                ? "Demo: Pay with ZEC"
                : "Pay with ZEC unavailable"}
          </Button>
          {user && zecDemoEnabled ? (
            <>
              <div className="space-y-1 text-xs">
                <div className="flex items-center justify-between text-muted-foreground">
                  <span className="flex items-center gap-1">
                    {isEstimate ? "Est. demo cost" : "Demo cost"}
                    <Badge variant="zec" className="px-1.5 py-0 text-[10px]">
                      demo only
                    </Badge>
                  </span>
                  <span className="tabular-nums text-zec">
                    {!valid
                      ? "—"
                      : quoteLoading
                        ? "…"
                        : validQuote && quote
                          ? `${quote.zec_amount} ZEC`
                          : "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>Mock wallet spendable</span>
                  <span className="tabular-nums">
                    {formatZecTrim(spendable)} ZEC
                  </span>
                </div>
                {valid && quoteUnavailable && (
                  <p className="pt-1 text-destructive">
                    Demo pricing unavailable — try again.
                  </p>
                )}
                {valid && validQuote && !enoughZec && (
                  <p className="pt-1 text-destructive">
                    Not enough mock ZEC for this demo.
                  </p>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Demo only: this changes a local mock 2Z balance. It does not
                send ZEC or create a real purchase.
              </p>
            </>
          ) : user ? (
            <p className="text-xs text-muted-foreground">
              ZEC top-ups are not available yet. No ZEC will be sent and no 2Z
              balance will change. Pay with card for now.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* ZEC confirm */}
      <Dialog
        open={zecDemoEnabled && zecConfirm}
        onOpenChange={(o) => !zecLoading && setZecConfirm(o)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm demo ZEC payment</DialogTitle>
            <DialogDescription>
              Simulate funding a local mock 2Z balance. No ZEC will be sent.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 rounded-lg border border-border bg-secondary/40 p-4 text-sm">
            <Row
              label="You receive"
              value={amount !== null ? formatTuzis(amount) : "—"}
              strong
            />
            <Row label="Price" value={formatUsd(usd)} />
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
            Demo only: no transaction is proposed, signed, broadcast, or
            settled.
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
              Run demo purchase
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
