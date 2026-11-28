import { useEffect, useRef, useState } from "react";
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
import { captureSessionOwnership, useSession } from "@/store/session";
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
import { cardCheckoutFeedback, openCardCheckout } from "./card-checkout";
import { getTokenSnapshot } from "@/lib/api/http";
import {
  clearCreditedCardPurchase,
  pendingCardPurchase,
  persistWebCardPurchase,
  type CardPurchase,
  type PendingCardPurchase,
} from "@/lib/checkout/card-purchase";
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
  const [cardPurchase, setCardPurchase] = useState<{
    pending: PendingCardPurchase;
    order: CardPurchase;
  } | null>(null);
  const cardBusy = useRef(false);
  const cardMounted = useRef(false);
  useEffect(() => {
    cardMounted.current = true;
    return () => {
      cardMounted.current = false;
    };
  }, []);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const reviewedCard =
    cardPurchase?.pending.actorId === user?.id ? cardPurchase : null;
  const cardExpired =
    !!reviewedCard && reviewedCard.order.expires_at * 1000 <= now;
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

  async function readOriginalCardPurchase(pending: PendingCardPurchase) {
    try {
      return await tuzi.buyCheckout(
        pending.quantity,
        pending.returnMode,
        pending,
      );
    } catch (error) {
      const { ApiError } = await import("@/lib/api/http");
      if (
        !(error instanceof ApiError) ||
        error.status !== 503 ||
        !error.body ||
        typeof error.body !== "object" ||
        !("code" in error.body) ||
        error.body.code !== "native_checkout_unavailable" ||
        pending.returnMode === "web"
      )
        throw error;
      persistWebCardPurchase(pending);
      return tuzi.buyCheckout(pending.quantity, pending.returnMode, pending);
    }
  }

  async function payWithCard() {
    const actor = useSession.getState().user;
    if (!actor) {
      navigate("/login", { state: { returnTo: "/wallet/fund" } });
      return;
    }
    if (
      cardBusy.current ||
      !valid ||
      amount === null ||
      typeof actor.id !== "number"
    )
      return;
    cardBusy.current = true;
    setCardLoading(true);
    const session = getTokenSnapshot();
    const current = () =>
      cardMounted.current &&
      useSession.getState().user?.id === actor.id &&
      getTokenSnapshot().generation === session.generation;
    try {
      const returnMode = await checkoutReturnMode();
      if (!current()) return;
      const pending = pendingCardPurchase(actor.id, amount, returnMode);
      const order = await readOriginalCardPurchase(pending);
      if (current()) setCardPurchase({ pending, order });
    } catch (error) {
      if (!current()) return;
      const feedback = cardCheckoutFeedback(error);
      toast.error(feedback.title, { description: feedback.description });
    } finally {
      cardBusy.current = false;
      setCardLoading(false);
    }
  }

  async function confirmCard() {
    if (!reviewedCard || cardBusy.current || cardExpired) return;
    cardBusy.current = true;
    setCardLoading(true);
    const actorId = reviewedCard.pending.actorId;
    const session = getTokenSnapshot();
    try {
      // Re-read the original response, with the original key and terms. Never
      // create a replacement purchase when resuming a quote or browser return.
      const order = await readOriginalCardPurchase(reviewedCard.pending);
      if (
        !cardMounted.current ||
        useSession.getState().user?.id !== actorId ||
        getTokenSnapshot().generation !== session.generation
      )
        return;
      if (
        JSON.stringify(order.quote) !==
          JSON.stringify(reviewedCard.order.quote) ||
        order.id !== reviewedCard.order.id ||
        order.url !== reviewedCard.order.url ||
        order.expires_at !== reviewedCard.order.expires_at ||
        order.expires_at * 1000 <= Date.now()
      )
        throw new Error(
          "Review the original purchase again before opening checkout.",
        );
      await openCardCheckout(order.url);
    } catch (error) {
      toast.error("Couldn't open checkout", {
        description:
          error instanceof Error
            ? error.message
            : "Retry the original purchase.",
      });
    } finally {
      cardBusy.current = false;
      setCardLoading(false);
    }
  }

  async function checkCardReceipt() {
    if (!reviewedCard || cardBusy.current) return;
    cardBusy.current = true;
    setCardLoading(true);
    const ownsSession = captureSessionOwnership();
    const current = () => cardMounted.current && ownsSession();
    try {
      const status = await tuzi.checkoutReturnStatus(
        reviewedCard.order.status_token,
      );
      if (!current()) return;
      if (status.status === "credited") {
        if (status.tuzisCredited !== reviewedCard.order.quote.tuzis)
          throw new Error(
            "The receipt does not match the original purchase. Contact support.",
          );
        clearCreditedCardPurchase(reviewedCard.pending);
        setCardPurchase(null);
        await useSession.getState().refresh({ isCurrent: current });
        if (!current()) return;
        toast.success(
          `${formatTuzis(status.tuzisCredited)} purchase confirmed`,
          { description: "Free2Z verified the original credit receipt." },
        );
      } else
        toast.info("Payment processing", {
          description:
            "No credit receipt yet. Retry this check; keep the original purchase.",
        });
    } catch (error) {
      if (!current()) return;
      toast.error("Couldn't verify purchase", {
        description:
          error instanceof Error ? error.message : "Retry the receipt check.",
      });
    } finally {
      cardBusy.current = false;
      if (cardMounted.current) setCardLoading(false);
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
                aria-label={`Select ${formatTuzis(pack)}; face value ${formatUsd(tuzisToUsd(pack))} before card fees`}
                className={cn(
                  "min-tap group relative flex flex-col items-start gap-1 rounded-xl border p-4 text-start transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "border-primary bg-primary/10"
                    : "border-border bg-card hover:border-primary/40 hover:bg-primary/5",
                )}
              >
                {active && (
                  <span className="absolute end-3 top-3 grid h-5 w-5 place-items-center rounded-full bg-primary text-primary-foreground">
                    <Check className="h-3 w-3" />
                  </span>
                )}
                <span className="text-lg font-bold bidi-number tabular-nums">
                  {pack.toLocaleString()}
                </span>
                <span className="text-xs font-medium text-primary">2Z</span>
                <span className="mt-1 text-sm font-semibold bidi-number tabular-nums text-muted-foreground">
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
              className="pe-24 bidi-number tabular-nums"
              aria-describedby="custom-tuzis-usd custom-tuzis-error"
              aria-invalid={hasCustomAmount && !valid}
            />
            <span
              id="custom-tuzis-usd"
              className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-sm font-medium bidi-number tabular-nums text-muted-foreground"
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
          <CardTitle className="flex flex-col items-start gap-2">
            <span>
              {reviewedCard
                ? "Card total, including fees"
                : "Face value before card fees"}
            </span>
            <span className="text-2xl font-bold bidi-number tabular-nums">
              {reviewedCard
                ? formatUsd(reviewedCard.order.quote.amount_cents / 100)
                : valid
                  ? formatUsd(usd)
                  : "—"}
            </span>
          </CardTitle>
          <CardDescription className="bidi-number tabular-nums">
            for{" "}
            {reviewedCard
              ? formatTuzis(reviewedCard.order.quote.tuzis)
              : valid && amount !== null
                ? formatTuzis(amount)
                : "—"}
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
              <LogIn className="rtl:-scale-x-100 h-4 w-4" />
            ) : (
              <CreditCard className="h-4 w-4" />
            )}
            {user ? "Review card purchase" : "Log in to buy"}
          </Button>
          {reviewedCard && (
            <div className="space-y-3" aria-live="polite">
              <p className="text-sm">
                Exact server quote:{" "}
                {formatTuzis(reviewedCard.order.quote.tuzis)} for{" "}
                {formatUsd(reviewedCard.order.quote.amount_cents / 100)} USD,
                including fees.
              </p>
              <p className="text-xs text-muted-foreground">
                Keep this original purchase until Free2Z confirms its receipt.
                Returning from Stripe does not confirm payment.
              </p>
              {cardExpired && (
                <p role="status">
                  This checkout quote expired. Check the original receipt or
                  contact support before another purchase.
                </p>
              )}
              <Button
                className="h-auto w-full whitespace-normal py-3"
                disabled={cardLoading || cardExpired}
                onClick={confirmCard}
              >
                Pay with card{" "}
                {formatUsd(reviewedCard.order.quote.amount_cents / 100)} USD
              </Button>
              <Button
                className="w-full"
                variant="outline"
                disabled={cardLoading}
                onClick={checkCardReceipt}
              >
                Check payment receipt
              </Button>
            </div>
          )}
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 text-success" />
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
              <LogIn className="rtl:-scale-x-100 h-4 w-4" />
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
                    <Badge variant="zec" className="px-1.5 py-0 text-xs">
                      demo only
                    </Badge>
                  </span>
                  <span className="bidi-number tabular-nums text-zec">
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
                  <span className="bidi-number tabular-nums">
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
                    <Badge variant="zec" className="px-1.5 py-0 text-xs">
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
          "bidi-number tabular-nums",
          strong && "font-semibold",
          accent && "font-semibold text-zec",
        )}
      >
        {value}
      </span>
    </div>
  );
}
