import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
  formatZecDisplay,
  MAX_TIP_ZEC,
  MAX_TUZIS,
  MAX_ZEC_INPUT_LENGTH,
  truncateAddress,
  tuziInputExample,
  tuziInputMaxLength,
  validateTuzis,
  validateZec,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { useSession } from "@/store/session";
import type { CreatorDetail } from "@/lib/api/types";
import { paidActionGate } from "@/lib/auth/paid-action";
import { preservePaidIntent, type PaidIntent } from "@/lib/auth/paid-intent";
import {
  isCreatorTipSource,
  type CreatorTipIntent,
} from "@/lib/bridge/creator-tip";
import { openWalletHistory } from "@/lib/bridge/wallet-history";
import { MESSAGE_KEYS } from "@/i18n/messages";
import {
  acknowledgeZecTip,
  startZecTip,
  useZecTipSession,
} from "./zec-tip-session";
import { creatorTipCopy } from "./tip-copy";

// ─── Tip ──────────────────────────────────────────────────────────────────────
const TIP_PRESETS = [50, 100, 250, 500];

/**
 * ZEC tip presets, as the exact decimal strings the input carries.
 *
 * Strings, not numbers: `parseZecToZatoshis` is the one conversion and it reads
 * text, so a preset that arrived as `0.05` the float would be converted by a
 * second, different path. Every one of these is a whole number of zatoshis.
 */
const ZEC_TIP_PRESETS = ["0.001", "0.01", "0.05", "0.1"];

export function TipButton({
  creator,
  restored,
  intentKind = "creator-tip",
  triggerText = "Tip",
  variant = "outline",
  destinationStatus,
}: {
  creator: Pick<CreatorDetail, "username" | "display_name" | "p2paddr">;
  restored: PaidIntent | null;
  intentKind?: "creator-tip" | "article-tip";
  triggerText?: string;
  variant?: "default" | "outline";
  destinationStatus?: "loading" | "failed";
}) {
  const { t } = useTranslation();
  const name = creator.display_name || creator.username;
  const navigate = useNavigate();
  const location = useLocation();
  const user = useSession((s) => s.user);
  const sessionLoading = useSession((s) => s.loading);
  const balance = useSession((s) => s.tuzis);
  const adjustTuzis = useSession((s) => s.adjustTuzis);
  const restoredTip =
    restored?.kind === intentKind && restored.subject === creator.username
      ? restored
      : null;
  const [open, setOpen] = useState(false);
  const [currency, setCurrency] = useState<"zec" | "tuzi">("tuzi");
  const [amount, setAmount] = useState("100");
  const [zecAmount, setZecAmount] = useState("0.01");
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<CreatorTipIntent | null>(null);
  const [checkedWallet, setCheckedWallet] = useState(false);
  const tipSession = useZecTipSession();
  const attempt = tipSession.attempt;
  const pending = attempt !== null && attempt.outcome === null;
  const zecLocked = tipSession.blocked || attempt !== null;
  const destinationChanged =
    source !== null &&
    (source.username !== creator.username ||
      source.label !== name ||
      source.recipient !== (creator.p2paddr ?? ""));
  function changeOpen(next: boolean) {
    if (pending) return;
    if (next) {
      setSource(
        Object.freeze({
          username: creator.username,
          label: name,
          recipient: creator.p2paddr ?? "",
        }),
      );
      setCheckedWallet(false);
    }
    setOpen(next);
  }

  useEffect(() => {
    if (!restoredTip) return;
    setSource(
      Object.freeze({
        username: creator.username,
        label: name,
        recipient: creator.p2paddr ?? "",
      }),
    );
    setCurrency("tuzi");
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
    balance,
    cost: validAmount ? parsedAmount : null,
  });
  const canSend = validAmount && gate === "ready" && !busy;

  const zecResult = validateZec(zecAmount);
  const zatoshis = zecResult.zatoshis;
  const validZec = zecResult.error === null && zatoshis !== null;
  const canSendZec =
    validZec &&
    source !== null &&
    isCreatorTipSource(source) &&
    !destinationChanged &&
    !destinationStatus &&
    !busy &&
    !zecLocked;

  function signInToTip() {
    const returnTo = preservePaidIntent(location.pathname, {
      kind: intentKind,
      subject: creator.username,
      amount,
    });
    navigate("/login", { state: { returnTo } });
  }

  async function send() {
    if (!useSession.getState().user || gate === "sign-in") {
      signInToTip();
      return;
    }
    if (!canSend || parsedAmount === null) return;
    setBusy(true);
    try {
      await tuzi.donate(creator.username, parsedAmount);
      adjustTuzis(-parsedAmount);
      toast.success(`Sent ${formatTuzis(parsedAmount)} to ${name}`);
      setOpen(false);
    } catch {
      toast.error("Could not send your tip. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function continueWithZec() {
    if (!canSendZec || zatoshis === null || !source) return;
    await startZecTip(source, zatoshis);
  }

  async function showWalletHistory(txid?: string) {
    try {
      await openWalletHistory(txid);
    } catch {
      toast.info(t(MESSAGE_KEYS.creatorZecTipOpenManually));
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button variant={variant} aria-label={`Tip ${name}`}>
          <Heart className="h-4 w-4" aria-hidden />
          {triggerText}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Tip {source?.label ?? name}</DialogTitle>
          <DialogDescription>
            Choose ZEC from your wallet or 2Z from your platform credit balance.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div
            className="grid grid-cols-2 gap-2"
            role="group"
            aria-label="Tip currency"
          >
            <button
              type="button"
              onClick={() => setCurrency("zec")}
              disabled={pending}
              aria-pressed={currency === "zec"}
              className={cn(
                "min-tap rounded-lg border px-3 py-2 text-start text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                currency === "zec"
                  ? "border-zec/50 bg-zec/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-secondary",
              )}
            >
              <span className="block font-semibold text-zec">ZEC</span>
              <span className="block text-xs">Zcash wallet</span>
            </button>
            <button
              type="button"
              onClick={() => setCurrency("tuzi")}
              disabled={pending}
              aria-pressed={currency === "tuzi"}
              className={cn(
                "min-tap rounded-lg border px-3 py-2 text-start text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                currency === "tuzi"
                  ? "border-primary bg-primary/15 text-foreground"
                  : "border-border text-muted-foreground hover:bg-secondary",
              )}
            >
              <span className="block font-semibold text-tuzi">2Z</span>
              <span className="block text-xs">Platform credits</span>
            </button>
          </div>
          {attempt || tipSession.blocked ? (
            <div
              className="space-y-3 rounded-lg border border-border p-3"
              role="status"
              data-zec-tip-outcome
            >
              {attempt ? (
                <>
                  <p>
                    {t(MESSAGE_KEYS.creatorZecTipAttribution, {
                      amount: formatZecDisplay(attempt.amountZatoshis),
                      creator: attempt.source.label,
                      username: attempt.source.username,
                    })}
                  </p>
                  <p className="break-all font-mono text-xs">
                    {attempt.source.recipient}
                  </p>
                  <p>
                    {pending
                      ? t(MESSAGE_KEYS.creatorZecTipPending)
                      : t(creatorTipCopy(attempt.outcome!).titleKey)}
                  </p>
                  {attempt.outcome ? (
                    <p>
                      {t(creatorTipCopy(attempt.outcome).bodyKey, {
                        amount: formatZecDisplay(attempt.amountZatoshis),
                        creator: attempt.source.label,
                        txid:
                          attempt.outcome.kind === "sent"
                            ? truncateAddress(attempt.outcome.txid)
                            : "",
                      })}
                    </p>
                  ) : null}
                  {attempt.outcome?.kind === "sent" ? (
                    <p className="break-all font-mono text-xs">
                      {attempt.outcome.txid}
                    </p>
                  ) : null}
                </>
              ) : (
                <p>{t(MESSAGE_KEYS.creatorZecTipRecovery)}</p>
              )}
              {!pending ? (
                <>
                  <Button
                    variant="outline"
                    onClick={() =>
                      void showWalletHistory(
                        attempt?.outcome?.kind === "sent"
                          ? attempt.outcome.txid
                          : undefined,
                      )
                    }
                  >
                    {t(MESSAGE_KEYS.creatorZecTipHistory)}
                  </Button>
                  {tipSession.blocked ? (
                    <Label className="min-tap flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        className="cursor-pointer"
                        checked={checkedWallet}
                        onChange={(event) =>
                          setCheckedWallet(event.target.checked)
                        }
                      />
                      {t(MESSAGE_KEYS.creatorZecTipChecked)}
                    </Label>
                  ) : null}
                  <Button
                    variant="ghost"
                    disabled={tipSession.blocked && !checkedWallet}
                    onClick={() => {
                      acknowledgeZecTip();
                      setCheckedWallet(false);
                    }}
                  >
                    {t(MESSAGE_KEYS.creatorZecTipNewPayment)}
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}
          {currency === "zec" ? (
            <div className="space-y-4">
              <div className="space-y-1 rounded-xl border border-border bg-card/50 p-4">
                <p className="font-medium">Send ZEC from your wallet</p>
                <p className="text-sm text-muted-foreground">
                  Choose the amount here. ZUULI holds the key, re-derives this
                  payment from its own wallet, and shows you the destination,
                  fee and network before it signs anything.
                  <span className="block">
                    {t(MESSAGE_KEYS.creatorZecTipWalletBalance)}
                  </span>
                </p>
              </div>
              {destinationChanged ? (
                <p role="alert">{t(MESSAGE_KEYS.creatorZecTipChanged)}</p>
              ) : null}
              {source?.recipient ? (
                <>
                  <div
                    className="grid grid-cols-4 gap-2"
                    role="group"
                    aria-label="ZEC tip presets"
                  >
                    {ZEC_TIP_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setZecAmount(preset)}
                        disabled={zecLocked}
                        aria-pressed={zecAmount === preset}
                        className={cn(
                          "min-tap rounded-lg border px-2 py-2 text-sm font-medium bidi-number tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          zecAmount === preset
                            ? "border-zec/50 bg-zec/10 text-zec"
                            : "border-border bg-transparent text-muted-foreground hover:bg-secondary",
                        )}
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="creator-tip-zec-amount">Amount (ZEC)</Label>
                    <Input
                      id="creator-tip-zec-amount"
                      type="text"
                      inputMode="decimal"
                      maxLength={MAX_ZEC_INPUT_LENGTH}
                      value={zecAmount}
                      disabled={zecLocked}
                      onChange={(e) => setZecAmount(e.target.value)}
                      className="bidi-number tabular-nums"
                      aria-describedby="creator-tip-zec-error creator-tip-zec-destination"
                      aria-invalid={zecAmount.length > 0 && !validZec}
                    />
                    <p
                      id="creator-tip-zec-destination"
                      className="text-xs text-muted-foreground"
                    >
                      {t(MESSAGE_KEYS.creatorZecTipDestination, {
                        username: source.username,
                      })}
                      <span className="block break-all font-mono">
                        {source.recipient}
                      </span>
                    </p>
                    <p
                      id="creator-tip-zec-error"
                      className="min-h-[1rem] text-xs text-destructive"
                    >
                      {zecResult.error === "tooLarge"
                        ? `Max ${MAX_TIP_ZEC.toLocaleString()} ZEC per tip.`
                        : zecAmount.length > 0 && zecResult.error !== null
                          ? "Enter a ZEC amount above zero, using a period, with up to 8 decimals."
                          : null}
                    </p>
                  </div>
                </>
              ) : (
                <p className="text-sm text-warning" role="status">
                  {destinationStatus === "loading"
                    ? t(MESSAGE_KEYS.creatorZecTipLoadingDestination)
                    : destinationStatus === "failed"
                      ? t(MESSAGE_KEYS.creatorZecTipFailedDestination)
                      : `${name} hasn't added a ZEC tip address yet.`}
                </p>
              )}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-4 gap-2">
                {TIP_PRESETS.map((preset) => (
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
                <Label htmlFor="creator-tip-amount">Amount (2Z)</Label>
                <Input
                  id="creator-tip-amount"
                  type="text"
                  inputMode="numeric"
                  maxLength={tuziInputMaxLength(MAX_TUZIS)}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="bidi-number tabular-nums"
                  aria-describedby={
                    user
                      ? "creator-tip-error creator-tip-balance"
                      : "creator-tip-error"
                  }
                  aria-invalid={amount.length > 0 && !validAmount}
                />
                {user ? (
                  <p
                    id="creator-tip-balance"
                    className="text-xs text-muted-foreground bidi-number tabular-nums"
                  >
                    Balance: {formatTuzis(balance)}
                  </p>
                ) : null}
                <p
                  id="creator-tip-error"
                  className="min-h-[1rem] text-xs text-destructive"
                >
                  {amountResult.error === "tooLarge"
                    ? `Max ${MAX_TUZIS.toLocaleString()} 2Z per tip.`
                    : amount.length > 0 && amountResult.error !== null
                      ? `Enter a positive whole 2Z amount, e.g. ${tuziInputExample()}.`
                      : null}
                </p>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={busy || pending}
          >
            Cancel
          </Button>
          {currency === "zec" ? (
            <Button
              variant="zec"
              onClick={() => void continueWithZec()}
              disabled={!canSendZec}
            >
              {pending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Asking ZUULI
                </>
              ) : (
                <>
                  Continue with ZEC
                  <ArrowRight
                    className="rtl:-scale-x-100 h-4 w-4"
                    aria-hidden
                  />
                </>
              )}
            </Button>
          ) : gate === "loading" ? (
            <Button disabled>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Checking account
            </Button>
          ) : gate === "sign-in" ? (
            <Button onClick={signInToTip}>Sign in to tip</Button>
          ) : validAmount && gate === "low-balance" ? (
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
                navigate("/fund");
              }}
            >
              Not enough 2Z — buy more
              <ArrowRight className="rtl:-scale-x-100 h-4 w-4" aria-hidden />
            </Button>
          ) : (
            <Button onClick={send} disabled={!canSend}>
              {busy ? (
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
