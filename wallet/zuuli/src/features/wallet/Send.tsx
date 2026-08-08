// Send ZEC: live address validation, memo, payment-URI paste, review + confirm.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  formatZec,
  formatZecDisplay,
  MAX_ZEC_INPUT_LENGTH,
  parseZecToZatoshis,
  truncateAddress,
} from "@/lib/format";
import { wallet } from "@/lib/wallet/bridge";
import { assertExactSendProposal } from "@/lib/wallet/amounts";
import type {
  AddressValidation,
  ExecuteSendResult,
  PendingSendStatus,
  SendProposal,
} from "@/lib/wallet/types";
import { useWallet } from "@/store/wallet";
import { cn } from "@/lib/utils";
import { ZecTag } from "./shared";

// Zcash encrypted memos are 512 *bytes* (UTF-8), not 512 characters.
const MEMO_MAX_BYTES = 512;

// Client-side fee reserve for pre-flight Max / over-balance checks. The real
// fee is computed by the engine and returned on the proposal; this is the
// ZIP-317 minimum fee (matches the mock) so we never propose a send that
// leaves nothing to cover the fee. A fixed reserve works for both memo and
// no-memo destinations.
const FEE_RESERVE = 10_000;

const memoEncoder = new TextEncoder();

/** UTF-8 byte length of a memo. */
function memoByteLength(memo: string): number {
  return memoEncoder.encode(memo).length;
}

/** Trim a string to at most `maxBytes` UTF-8 bytes, never splitting a code point. */
function clampToBytes(value: string, maxBytes: number): string {
  if (memoByteLength(value) <= maxBytes) return value;
  let out = "";
  for (const ch of value) {
    if (memoByteLength(out + ch) > maxBytes) break;
    out += ch;
  }
  return out;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

export function Send() {
  const navigate = useNavigate();
  const balance = useWallet((s) => s.balance);
  const refreshBalance = useWallet((s) => s.refreshBalance);

  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");

  const [validation, setValidation] = useState<AddressValidation | null>(null);
  const [validating, setValidating] = useState(false);

  const [proposal, setProposal] = useState<SendProposal | null>(null);
  const [preparingParams, setPreparingParams] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [broadcastResult, setBroadcastResult] = useState<ExecuteSendResult | null>(null);
  const [pendingSend, setPendingSend] = useState<PendingSendStatus | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const debounceRef = useRef<number | null>(null);

  const canReceiveMemo = validation?.valid ? validation.canReceiveMemo : true;
  const zatoshis = parseZecToZatoshis(amount);
  const invalidAmount = amount.length > 0 && zatoshis === null;
  const spendable = balance?.spendable ?? 0;
  // Largest amount that still leaves room for the network fee.
  const maxSpendable = Math.max(0, spendable - FEE_RESERVE);
  // A send costs amount + fee, so anything within one fee of spendable is unfundable.
  const overBalance = zatoshis !== null && zatoshis + FEE_RESERVE > spendable;
  const memoBytes = memoByteLength(memo);
  const hasUnknownBroadcast =
    broadcastResult?.status === "unknown" || pendingSend?.status === "unknown";

  useEffect(() => {
    let active = true;
    void wallet
      .getPendingSend()
      .then((pending) => {
        if (active && pending?.status === "unknown") setPendingSend(pending);
      })
      .catch((error) => {
        if (active) toast.error(errorMessage(error, "Couldn't load pending payment state"));
      });
    return () => {
      active = false;
    };
  }, []);

  // Parse a pasted `zcash:` payment URI and prefill the form.
  const applyUri = useCallback(async (uri: string) => {
    try {
      const req = await wallet.parsePaymentUri(uri);
      setTo(req.address);
      if (req.amount !== null) setAmount(formatZec(req.amount));
      if (req.memo !== null) setMemo(clampToBytes(req.memo, MEMO_MAX_BYTES));
      toast.success("Payment request loaded");
    } catch {
      toast.error("Couldn't read that payment link");
    }
  }, []);

  const onToChange = useCallback(
    (raw: string) => {
      const v = raw.trim();
      if (v.toLowerCase().startsWith("zcash:")) {
        void applyUri(v);
        return;
      }
      setTo(raw);
    },
    [applyUri],
  );

  // Debounced live validation of the destination address.
  useEffect(() => {
    const addr = to.trim();
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    if (!addr) {
      setValidation(null);
      setValidating(false);
      return;
    }
    setValidating(true);
    debounceRef.current = window.setTimeout(() => {
      void wallet
        .validateAddress(addr)
        .then((res) => setValidation(res))
        .catch(() => setValidation({ valid: false, addressType: null, canReceiveMemo: false }))
        .finally(() => setValidating(false));
    }, 350);
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [to]);

  // Clear a memo the destination can't carry.
  useEffect(() => {
    if (validation && validation.valid && !validation.canReceiveMemo && memo) {
      setMemo("");
    }
  }, [validation, memo]);

  const canReview =
    !!validation?.valid && zatoshis !== null && !overBalance && !validating;

  const onReview = useCallback(async () => {
    if (hasUnknownBroadcast && proposal) {
      setDialogOpen(true);
      return;
    }
    if (!canReview || zatoshis === null) return;
    setBroadcastResult(null);
    setPreparingParams(true);
    try {
      const params = await wallet.ensureSaplingParams();
      if (!params.ready) {
        throw new Error("Sapling proving parameters are not ready");
      }
      setPreparingParams(false);
      setReviewing(true);
      const p = await wallet.proposeSend(
        to.trim(),
        zatoshis,
        canReceiveMemo && memo ? memo : undefined,
      );
      assertExactSendProposal(zatoshis, p);
      setProposal(p);
      setDialogOpen(true);
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't build the transaction"));
    } finally {
      setPreparingParams(false);
      setReviewing(false);
    }
  }, [hasUnknownBroadcast, proposal, canReview, zatoshis, to, memo, canReceiveMemo]);

  const onConfirm = useCallback(async () => {
    if (!proposal) return;
    setSending(true);
    try {
      const result = await wallet.executeSend(proposal.proposalId);
      setBroadcastResult(result);
      if (result.status === "accepted") {
        setPendingSend(null);
        setDialogOpen(false);
        toast.success("Transaction sent", {
          description: `txid ${truncateAddress(result.txid)}`,
        });
        await refreshBalance();
        navigate("/wallet/history");
      } else if (result.status === "unknown") {
        setPendingSend({
          ...result,
          proposalId: proposal.proposalId,
          recoveryRequired: false,
          canDiscard: false,
        });
        toast.warning("Broadcast status unknown", {
          description: "Retrying will rebroadcast the same transaction safely.",
        });
      } else {
        toast.error("Transaction rejected", {
          description: result.message ?? "The server rejected this transaction.",
        });
      }
    } catch (e) {
      const recovered = await wallet.getPendingSend().catch(() => null);
      if (recovered?.status === "unknown") setPendingSend(recovered);
      toast.error(errorMessage(e, "Send failed"));
    } finally {
      setSending(false);
    }
  }, [proposal, refreshBalance, navigate]);

  const onRetryPending = useCallback(async () => {
    setSending(true);
    try {
      const result = await wallet.retryPendingSend();
      setBroadcastResult(result);
      if (result.status === "accepted") {
        setPendingSend(null);
        toast.success("Transaction broadcast confirmed", {
          description: `txid ${truncateAddress(result.txid)}`,
        });
        await refreshBalance();
        navigate("/wallet/history");
      } else if (result.status === "unknown") {
        setPendingSend((pending) =>
          pending ? { ...pending, ...result } : null,
        );
        toast.warning("Broadcast is still unresolved", {
          description: "No replacement payment was created.",
        });
      } else {
        setPendingSend(null);
        setProposal(null);
        toast.info("Transaction expired without being found", {
          description: result.message ?? "It is safe to review a new payment.",
        });
      }
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't retry the pending transaction"));
    } finally {
      setSending(false);
    }
  }, [navigate, refreshBalance]);

  const onDiscardUnrecoverable = useCallback(async () => {
    if (!pendingSend?.canDiscard) return;
    const confirmed = window.confirm(
      "Only continue if you checked wallet history and verified that no payment was sent. Discarding this recovery lock can allow a replacement payment.",
    );
    if (!confirmed) return;
    setSending(true);
    try {
      await wallet.discardUnrecoverableSend(pendingSend.proposalId);
      setPendingSend(null);
      setBroadcastResult(null);
      setProposal(null);
      toast.warning("Recovery lock discarded after wallet-history confirmation");
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't discard recovery state"));
    } finally {
      setSending(false);
    }
  }, [pendingSend]);

  return (
    <div className="mx-auto max-w-xl">
      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle>Send ZEC</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {pendingSend?.status === "unknown" ? (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200" role="status">
              <p className="font-medium">A previous broadcast is unresolved</p>
              <p className="mt-1 text-xs">
                {pendingSend.canDiscard
                  ? "Transaction creation was interrupted and exact retry data is unavailable. Check wallet history before unlocking sends."
                  : pendingSend.recoveryRequired
                    ? "The recovery journal could not be decoded safely. It remains locked to preserve possible transaction evidence; restore or reconcile the wallet data before sending again."
                  : "ZUULI recovered the exact transaction after restart. Retry it before creating another payment."}
              </p>
              <p className="mt-1 break-all font-mono text-xs opacity-75">
                txid {pendingSend.txid}
              </p>
            </div>
          ) : null}
          {/* Recipient */}
          <div className="space-y-1.5">
            <Label htmlFor="to">Recipient address</Label>
            <Input
              id="to"
              value={to}
              onChange={(e) => onToChange(e.target.value)}
              placeholder="u1… / zs1… / t1… or paste a zcash: link"
              autoComplete="off"
              spellCheck={false}
              disabled={hasUnknownBroadcast}
              className={cn(
                "font-mono",
                validation && !validation.valid && to.trim() && "border-destructive",
              )}
              aria-invalid={validation ? !validation.valid : undefined}
            />
            <div className="min-h-[1.25rem] text-xs">
              {validating ? (
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Checking address…
                </span>
              ) : validation && to.trim() ? (
                validation.valid ? (
                  <span className="flex items-center gap-1.5 text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Valid {validation.addressType} address
                    {validation.canReceiveMemo
                      ? " · supports memos"
                      : " · no memo support"}
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-destructive">
                    <AlertCircle className="h-3.5 w-3.5" />
                    {validation.error ?? "Not a recognizable Zcash address"}
                  </span>
                )
              ) : null}
            </div>
          </div>

          {/* Amount */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="amount">Amount</Label>
              {balance ? (
                <button
                  type="button"
                  disabled={hasUnknownBroadcast}
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setAmount(formatZec(maxSpendable))}
                >
                  Max: {formatZecDisplay(maxSpendable)}
                </button>
              ) : null}
            </div>
            <div className="relative">
              <Input
                id="amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                inputMode="decimal"
                maxLength={MAX_ZEC_INPUT_LENGTH}
                type="text"
                disabled={hasUnknownBroadcast}
                className={cn(
                  "pr-14 tabular-nums",
                  (invalidAmount || overBalance) && "border-destructive",
                )}
                aria-describedby="amount-error"
                aria-invalid={invalidAmount || overBalance || undefined}
              />
              <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
                <ZecTag className="text-xs" />
              </div>
            </div>
            <div id="amount-error" className="min-h-[1.25rem] text-xs">
              {invalidAmount ? (
                <span className="flex items-center gap-1.5 text-destructive">
                  <AlertCircle className="h-3.5 w-3.5" />
                  Enter a positive ZEC amount with no more than 8 decimal places
                </span>
              ) : overBalance ? (
                <span className="flex items-center gap-1.5 text-destructive">
                  <AlertCircle className="h-3.5 w-3.5" />
                  Amount plus network fee exceeds spendable balance
                </span>
              ) : null}
            </div>
          </div>

          {/* Memo */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="memo">
                Memo <span className="text-muted-foreground">(optional)</span>
              </Label>
              {canReceiveMemo ? (
                <span
                  className={cn(
                    "text-xs tabular-nums text-muted-foreground",
                    memoBytes >= MEMO_MAX_BYTES && "text-destructive",
                  )}
                >
                  {memoBytes}/{MEMO_MAX_BYTES} bytes
                </span>
              ) : null}
            </div>
            <Textarea
              id="memo"
              value={memo}
              onChange={(e) => setMemo(clampToBytes(e.target.value, MEMO_MAX_BYTES))}
              disabled={!canReceiveMemo || hasUnknownBroadcast}
              placeholder={
                canReceiveMemo
                  ? "Encrypted note delivered with the payment"
                  : "This address type can't receive memos"
              }
              className="resize-none"
            />
            {canReceiveMemo ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5" />
                Memos are encrypted and only visible to the recipient.
              </p>
            ) : null}
          </div>

          <Button
            type="button"
            variant="zec"
            size="lg"
            className="w-full"
            disabled={
              (!hasUnknownBroadcast && !canReview) ||
              preparingParams ||
              reviewing ||
              sending ||
              Boolean(pendingSend?.recoveryRequired && !pendingSend.canDiscard)
            }
            onClick={
              pendingSend?.canDiscard
                ? onDiscardUnrecoverable
                : pendingSend?.recoveryRequired
                  ? undefined
                : pendingSend?.status === "unknown"
                  ? onRetryPending
                  : onReview
            }
          >
            {pendingSend?.canDiscard ? (
              sending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Unlocking…
                </>
              ) : (
                "I checked history — unlock sends"
              )
            ) : pendingSend?.recoveryRequired ? (
              "Recovery data locked"
            ) : pendingSend?.status === "unknown" ? (
              sending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Retrying exact transaction…
                </>
              ) : (
                "Retry recovered transaction"
              )
            ) : hasUnknownBroadcast ? (
              "Resume pending broadcast"
            ) : preparingParams ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Preparing proving data…
              </>
            ) : reviewing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Building…
              </>
            ) : (
              "Review payment"
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Confirmation dialog */}
      <Dialog open={dialogOpen} onOpenChange={(o) => !sending && setDialogOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm payment</DialogTitle>
            <DialogDescription>
              Review the details before broadcasting. This can't be undone.
            </DialogDescription>
          </DialogHeader>

          {proposal ? (
            <div className="space-y-3 rounded-lg border border-border bg-background/40 p-4 text-sm">
              <Row label="To">
                <span className="break-all font-mono text-xs">
                  {truncateAddress(to.trim())}
                </span>
              </Row>
              <Row label="Amount">
                <span className="tabular-nums">
                  {formatZecDisplay(proposal.amount)}
                </span>
              </Row>
              <Row label="Network fee">
                <span className="tabular-nums text-muted-foreground">
                  {formatZecDisplay(proposal.fee)}
                </span>
              </Row>
              {canReceiveMemo && memo ? (
                <Row label="Memo">
                  <span className="max-w-[16rem] truncate text-right text-muted-foreground">
                    {memo}
                  </span>
                </Row>
              ) : null}
              <Separator />
              <Row label="Total">
                <span className="text-base font-semibold tabular-nums text-[#f4b728]">
                  {formatZecDisplay(proposal.total)}
                </span>
              </Row>
            </div>
          ) : null}

          {broadcastResult && broadcastResult.status !== "accepted" ? (
            <div
              className={cn(
                "rounded-lg border p-3 text-sm",
                broadcastResult.status === "unknown"
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                  : "border-destructive/40 bg-destructive/10 text-destructive",
              )}
              role="status"
            >
              <p className="font-medium">
                {broadcastResult.status === "unknown"
                  ? "Broadcast status unknown"
                  : "Broadcast rejected"}
              </p>
              <p className="mt-1 text-xs opacity-90">
                {broadcastResult.message}
              </p>
              <p className="mt-1 break-all font-mono text-xs opacity-75">
                txid {broadcastResult.txid}
              </p>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={sending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="zec"
              onClick={
                broadcastResult?.status === "rejected"
                  ? () => {
                      setDialogOpen(false);
                      setBroadcastResult(null);
                      setProposal(null);
                    }
                  : onConfirm
              }
              disabled={sending}
            >
              {sending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Sending…
                </>
              ) : (
                broadcastResult?.status === "rejected"
                  ? "Edit payment"
                  : broadcastResult
                    ? "Retry same transaction"
                    : "Confirm & send"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
