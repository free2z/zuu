import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowRight, Heart, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { tuzi } from "@/lib/api/free2z";
import {
  formatTuzis,
  MAX_TUZIS,
  tuziInputExample,
  tuziInputMaxLength,
  validateTuzis,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { useSession } from "@/store/session";
import type { SimpleCreator } from "@/lib/api/types";
import { paidActionGate } from "@/lib/auth/paid-action";
import { preservePaidIntent } from "@/lib/auth/paid-intent";
import { usePaidIntent } from "@/hooks/usePaidIntent";

const PRESETS = [50, 100, 250, 500];

export function TipDialog({ author }: { author: SimpleCreator }) {
  const name = author.display_name || author.username;
  const navigate = useNavigate();
  const location = useLocation();
  const user = useSession((s) => s.user);
  const sessionLoading = useSession((s) => s.loading);
  const tuzis = useSession((s) => s.tuzis);
  const adjustTuzis = useSession((s) => s.adjustTuzis);
  const restored = usePaidIntent(location.pathname, "article-tip");
  const restoredTip =
    restored?.kind === "article-tip" && restored.subject === author.username
      ? restored
      : null;
  const restoredHandled = useRef(false);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("100");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!restoredTip || restoredHandled.current) return;
    restoredHandled.current = true;
    setAmount(restoredTip.amount);
    setOpen(true);
  }, [restoredTip]);

  const amountResult = validateTuzis(amount, {
    minimum: 1,
    maximum: MAX_TUZIS,
  });
  const parsedAmount = amountResult.value;
  const validAmount = amountResult.error === null;
  const gate = paidActionGate({
    sessionLoading,
    user,
    balance: tuzis,
    cost: validAmount ? parsedAmount : null,
  });
  const canSend = validAmount && gate === "ready" && !sending;

  function signIn() {
    const returnTo = preservePaidIntent(location.pathname, {
      kind: "article-tip",
      subject: author.username,
      amount,
    });
    navigate("/login", { state: { returnTo } });
  }

  async function send() {
    if (!useSession.getState().user || gate === "sign-in") {
      signIn();
      return;
    }
    if (!canSend || parsedAmount === null) return;
    setSending(true);
    try {
      await tuzi.donate(author.username, parsedAmount);
      adjustTuzis(-parsedAmount);
      toast.success(`Sent ${formatTuzis(parsedAmount)} to ${name}`);
      setOpen(false);
    } catch {
      toast.error("Could not send your tip. Please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="default" aria-label={`Tip ${name}`}>
          <Heart className="h-4 w-4" aria-hidden />
          Tip the author
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tip {name}</DialogTitle>
          <DialogDescription>
            Send 2Zs straight to the author, from your platform credit balance.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-2">
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setAmount(String(preset))}
                aria-pressed={parsedAmount === preset}
                className={cn(
                  "min-tap rounded-lg border px-3 py-2 text-sm font-medium bidi-number tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  parsedAmount === preset
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border bg-transparent text-muted-foreground hover:bg-secondary",
                )}
              >
                {preset}
              </button>
            ))}
          </div>

          <div className="space-y-2">
            <Label htmlFor="tip-amount">Amount (2Z)</Label>
            <Input
              id="tip-amount"
              type="text"
              inputMode="numeric"
              maxLength={tuziInputMaxLength(MAX_TUZIS)}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="bidi-number tabular-nums"
              aria-describedby={
                user ? "tip-amount-error tip-balance" : "tip-amount-error"
              }
              aria-invalid={amount.length > 0 && !validAmount}
            />
            {user ? (
              <p
                id="tip-balance"
                className="text-xs text-muted-foreground bidi-number tabular-nums"
              >
                Balance: {formatTuzis(tuzis)}
              </p>
            ) : null}
            <p
              id="tip-amount-error"
              className="min-h-[1rem] text-xs text-destructive"
            >
              {amountResult.error === "tooLarge"
                ? `Max ${MAX_TUZIS.toLocaleString()} 2Z per tip.`
                : amount.length > 0 && amountResult.error !== null
                  ? `Enter a positive whole 2Z amount, e.g. ${tuziInputExample()}.`
                  : null}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={sending}
          >
            Cancel
          </Button>
          {gate === "loading" ? (
            <Button disabled>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Checking account
            </Button>
          ) : gate === "sign-in" ? (
            <Button onClick={signIn}>Sign in to tip</Button>
          ) : validAmount && gate === "low-balance" ? (
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
                navigate("/wallet/fund");
              }}
            >
              Not enough 2Z — buy more
              <ArrowRight className="rtl:-scale-x-100 h-4 w-4" aria-hidden />
            </Button>
          ) : (
            <Button onClick={send} disabled={!canSend}>
              {sending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Sending
                </>
              ) : (
                <>
                  Send{" "}
                  {parsedAmount !== null ? formatTuzis(parsedAmount) : "2Zs"}
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
