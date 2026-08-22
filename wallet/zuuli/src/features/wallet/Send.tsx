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
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const proposalRef = useRef<SendProposal | null>(null);
  const confirmingRef = useRef(false);

  const discardNativeProposal = useCallback(async (stale: SendProposal) => {
    try {
      await wallet.discardSendProposal(
        stale.proposalId,
        stale.reviewDigest,
        stale.confirmationToken,
      );
    } catch {
      // Exact credentials make this safe when a newer proposal replaced it or
      // execution already consumed it. Discard must not surface private review
      // details through a toast during navigation or unmount.
    }
  }, []);

  const invalidateReview = useCallback(() => {
    generationRef.current += 1;
    const stale = proposalRef.current;
    proposalRef.current = null;
    setProposal(null);
    setDialogOpen(false);
    setPreparingParams(false);
    setReviewing(false);
    if (stale) void discardNativeProposal(stale);
    return generationRef.current;
  }, [discardNativeProposal]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      const stale = proposalRef.current;
      proposalRef.current = null;
      if (stale) void discardNativeProposal(stale);
    };
  }, [discardNativeProposal]);

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
  const formLocked =
    hasUnknownBroadcast || preparingParams || reviewing || sending || proposal !== null;

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
  const applyUri = useCallback(
    async (uri: string) => {
      const generation = invalidateReview();
      try {
        const req = await wallet.parsePaymentUri(uri);
        if (!mountedRef.current || generation !== generationRef.current) return;
        setTo(req.address);
        if (req.amount !== null) setAmount(formatZec(req.amount));
        if (req.memo !== null) setMemo(clampToBytes(req.memo, MEMO_MAX_BYTES));
        toast.success("Payment request loaded");
      } catch {
        if (mountedRef.current && generation === generationRef.current) {
          toast.error("Couldn't read that payment link");
        }
      }
    },
    [invalidateReview],
  );

  const onToChange = useCallback(
    (raw: string) => {
      const v = raw.trim();
      if (v.toLowerCase().startsWith("zcash:")) {
        void applyUri(v);
        return;
      }
      invalidateReview();
      setTo(raw);
    },
    [applyUri, invalidateReview],
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
      invalidateReview();
      setMemo("");
    }
  }, [validation, memo, invalidateReview]);

  const canReview =
    !!validation?.valid && zatoshis !== null && !overBalance && !validating;

  const onReview = useCallback(async () => {
    if (!canReview || zatoshis === null) return;
    const generation = invalidateReview();
    const requested = {
      recipient: to.trim(),
      amount: zatoshis,
      memo: canReceiveMemo && memo ? memo : undefined,
    };
    setBroadcastResult(null);
    setPreparingParams(true);
    try {
      const params = await wallet.ensureSaplingParams();
      if (!mountedRef.current || generation !== generationRef.current) return;
      if (!params.ready) {
        throw new Error("Sapling proving parameters are not ready");
      }
      setPreparingParams(false);
      setReviewing(true);
      const p = await wallet.proposeSend(requested.recipient, requested.amount, requested.memo);
      if (!mountedRef.current || generation !== generationRef.current) {
        void discardNativeProposal(p);
        return;
      }
      try {
        assertExactSendProposal(requested, p);
      } catch (error) {
        void discardNativeProposal(p);
        throw error;
      }
      proposalRef.current = p;
      setProposal(p);
      setDialogOpen(true);
    } catch (e) {
      if (mountedRef.current && generation === generationRef.current) {
        toast.error(errorMessage(e, "Couldn't build the transaction"));
      }
    } finally {
      if (mountedRef.current && generation === generationRef.current) {
        setPreparingParams(false);
        setReviewing(false);
      }
    }
  }, [
    canReview,
    zatoshis,
    invalidateReview,
    to,
    canReceiveMemo,
    memo,
    discardNativeProposal,
  ]);

  const onConfirm = useCallback(async () => {
    const confirmedProposal = proposalRef.current;
    if (!confirmedProposal || confirmingRef.current) return;
    confirmingRef.current = true;
    const generation = generationRef.current;
    setSending(true);
    try {
      const result = await wallet.executeSend(
        confirmedProposal.proposalId,
        confirmedProposal.reviewDigest,
        confirmedProposal.confirmationToken,
      );
      if (!mountedRef.current || generation !== generationRef.current) return;
      proposalRef.current = null;
      setProposal(null);
      setDialogOpen(false);
      setBroadcastResult(result);
      if (result.status === "accepted") {
        setPendingSend(null);
        toast.success("Transaction sent", {
          description: `txid ${truncateAddress(result.txid)}`,
        });
        await refreshBalance().catch(() => {
          if (mountedRef.current && generation === generationRef.current) {
            toast.warning("Payment sent; balance refresh is still pending");
          }
        });
        if (!mountedRef.current || generation !== generationRef.current) return;
        navigate("/wallet/history");
      } else if (result.status === "unknown") {
        setPendingSend({
          ...result,
          proposalId: confirmedProposal.proposalId,
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
      if (!mountedRef.current || generation !== generationRef.current) return;
      proposalRef.current = null;
      setProposal(null);
      setDialogOpen(false);
      if (recovered?.status === "unknown") setPendingSend(recovered);
      toast.error(errorMessage(e, "Send failed"));
    } finally {
      confirmingRef.current = false;
      if (mountedRef.current && generation === generationRef.current) setSending(false);
    }
  }, [refreshBalance, navigate]);

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
        proposalRef.current = null;
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
      proposalRef.current = null;
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
            <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning" role="status">
              <p className="font-medium">A previous broadcast is unresolved</p>
              <p className="mt-1 text-xs">
                {pendingSend.canDiscard
                  ? "Transaction creation was interrupted and exact retry data is unavailable. Check wallet history before unlocking sends."
                  : pendingSend.recoveryRequired
                    ? "The recovery journal could not be decoded safely. It remains locked to preserve possible transaction evidence; restore or reconcile the wallet data before sending again."
                  : "ZUULI recovered the exact transaction after restart. Retry it before creating another payment."}
              </p>
              <p className="mono-id mt-1 break-all font-mono text-xs opacity-75">
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
              disabled={formLocked}
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
                  <span className="flex items-center gap-1.5 text-success">
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
                  disabled={formLocked}
                  className="min-tap inline-flex items-center justify-center rounded-md text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    invalidateReview();
                    setAmount(formatZec(maxSpendable));
                  }}
                >
                  Max: {formatZecDisplay(maxSpendable)}
                </button>
              ) : null}
            </div>
            <div className="relative">
              <Input
                id="amount"
                value={amount}
                onChange={(e) => {
                  invalidateReview();
                  setAmount(e.target.value);
                }}
                placeholder="0.00"
                inputMode="decimal"
                maxLength={MAX_ZEC_INPUT_LENGTH}
                type="text"
                disabled={formLocked}
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
              onChange={(e) => {
                invalidateReview();
                setMemo(clampToBytes(e.target.value, MEMO_MAX_BYTES));
              }}
              disabled={!canReceiveMemo || formLocked}
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
              proposal !== null ||
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
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!sending && !open) invalidateReview();
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Confirm payment</DialogTitle>
            <DialogDescription>
              Review the details before broadcasting. This can't be undone.
            </DialogDescription>
          </DialogHeader>

          {proposal ? (
            <div className="space-y-3 rounded-lg border border-border bg-background/40 p-4 text-sm">
              <Row label="To">
                <span
                  className="mono-id min-w-0 break-all text-right font-mono text-xs"
                  data-testid="send-review-recipient"
                >
                  {proposal.review.payments[0]?.recipient ?? ""}
                </span>
              </Row>
              <Row label="Amount">
                <span className="tabular-nums" data-testid="send-review-amount">
                  {formatZecDisplay(proposal.review.payments[0]?.amount ?? 0)}
                </span>
              </Row>
              <Row label="Network fee">
                <span
                  className="tabular-nums text-muted-foreground"
                  title={proposal.review.feePolicy}
                >
                  {formatZecDisplay(proposal.review.fee)}
                </span>
              </Row>
              {proposal.review.payments[0]?.memo ? (
                <Row label="Memo">
                  <span
                    className="min-w-0 whitespace-pre-wrap break-words text-right text-muted-foreground"
                    data-testid="send-review-memo"
                  >
                    {proposal.review.payments[0].memo}
                  </span>
                </Row>
              ) : null}
              <Row label="Network">
                <span className="capitalize text-muted-foreground">
                  {proposal.review.network}
                </span>
              </Row>
              <Row label="Change">
                <span
                  className="text-muted-foreground"
                  data-testid="send-review-change-policy"
                  title={proposal.review.changePolicy}
                >
                  Shielded automatically
                </span>
              </Row>
              <Separator />
              <Row label="Total">
                <span className="text-base font-semibold tabular-nums text-zec">
                  {formatZecDisplay(proposal.review.total)}
                </span>
              </Row>
            </div>
          ) : null}

          {broadcastResult && broadcastResult.status !== "accepted" ? (
            <div
              className={cn(
                "rounded-lg border p-3 text-sm",
                broadcastResult.status === "unknown"
                  ? "border-warning/30 bg-warning/10 text-warning"
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
              <p className="mono-id mt-1 break-all font-mono text-xs opacity-75">
                txid {broadcastResult.txid}
              </p>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={invalidateReview}
              disabled={sending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="zec"
              onClick={onConfirm}
              disabled={sending}
            >
              {sending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Sending…
                </>
              ) : (
                "Confirm & send"
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
    <div className="flex min-w-0 items-start justify-between gap-4">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
