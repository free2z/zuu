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
  ZATOSHIS_PER_ZEC,
  formatZecDisplay,
  truncateAddress,
} from "@/lib/format";
import { wallet } from "@/lib/wallet/bridge";
import type { AddressValidation, SendProposal } from "@/lib/wallet/types";
import { useWallet } from "@/store/wallet";
import { cn } from "@/lib/utils";
import { ZecTag } from "./shared";

const MEMO_MAX = 512;

function toZatoshis(zec: string): number | null {
  const n = Number(zec);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * ZATOSHIS_PER_ZEC);
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
  const [reviewing, setReviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const debounceRef = useRef<number | null>(null);

  const canReceiveMemo = validation?.valid ? validation.canReceiveMemo : true;
  const zatoshis = toZatoshis(amount);
  const spendable = balance?.spendable ?? 0;
  const overBalance = zatoshis !== null && zatoshis > spendable;

  // Parse a pasted `zcash:` payment URI and prefill the form.
  const applyUri = useCallback(async (uri: string) => {
    try {
      const req = await wallet.parsePaymentUri(uri);
      setTo(req.address);
      if (req.amount !== null)
        setAmount((req.amount / ZATOSHIS_PER_ZEC).toString());
      if (req.memo !== null) setMemo(req.memo);
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
    if (!canReview || zatoshis === null) return;
    setReviewing(true);
    try {
      const p = await wallet.proposeSend(
        to.trim(),
        zatoshis,
        canReceiveMemo && memo ? memo : undefined,
      );
      setProposal(p);
      setDialogOpen(true);
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Couldn't build the transaction",
      );
    } finally {
      setReviewing(false);
    }
  }, [canReview, zatoshis, to, memo, canReceiveMemo]);

  const onConfirm = useCallback(async () => {
    if (!proposal) return;
    setSending(true);
    try {
      const txid = await wallet.executeSend(proposal.proposalId);
      setDialogOpen(false);
      toast.success("Transaction sent", {
        description: `txid ${truncateAddress(txid, 8)}`,
      });
      await refreshBalance();
      navigate("/wallet/history");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  }, [proposal, refreshBalance, navigate]);

  return (
    <div className="mx-auto max-w-xl">
      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle>Send ZEC</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
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
                    Not a recognizable Zcash address
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
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    setAmount((spendable / ZATOSHIS_PER_ZEC).toString())
                  }
                >
                  Max: {formatZecDisplay(spendable)}
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
                type="number"
                min="0"
                step="0.00000001"
                className={cn(
                  "pr-14 tabular-nums",
                  overBalance && "border-destructive",
                )}
                aria-invalid={overBalance || undefined}
              />
              <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
                <ZecTag className="text-xs" />
              </div>
            </div>
            <div className="min-h-[1.25rem] text-xs">
              {overBalance ? (
                <span className="flex items-center gap-1.5 text-destructive">
                  <AlertCircle className="h-3.5 w-3.5" />
                  Amount exceeds spendable balance
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
                <span className="text-xs tabular-nums text-muted-foreground">
                  {memo.length}/{MEMO_MAX}
                </span>
              ) : null}
            </div>
            <Textarea
              id="memo"
              value={memo}
              onChange={(e) => setMemo(e.target.value.slice(0, MEMO_MAX))}
              disabled={!canReceiveMemo}
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
            disabled={!canReview || reviewing}
            onClick={onReview}
          >
            {reviewing ? (
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
                <span className="font-mono text-xs">
                  {truncateAddress(to.trim(), 12)}
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
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
