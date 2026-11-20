import { translate } from "@/i18n/translate";
import { useTranslation as useUiTranslation } from "react-i18next";
import { localizedError } from "@/i18n/errors";
import { MESSAGE_KEYS } from "@/i18n/messages";
import { Trans } from "react-i18next";
// Send ZEC: live address validation, memo, payment-URI paste, review + confirm.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  Heart,
  Loader2,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BidiIdentifier } from "@/components/common/BidiIdentifier";
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
import { Callout } from "@/components/ui/callout";
import {
  formatZec,
  formatZecDisplay,
  MAX_ZEC_INPUT_LENGTH,
  parseZecToZatoshis,
} from "@/lib/format";
import { wallet } from "@/lib/wallet/bridge";
import {
  readCreatorTipRouteState,
  retireCreatorTipIntent,
  type CreatorTipIntent,
} from "@/lib/wallet/creator-tip";
import {
  assertExactSendProposal,
  assertFreshSendConfirmation,
} from "@/lib/wallet/amounts";
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
  return localizedError(error, fallback);
}

export function Send({
  creatorTipRoute = false,
}: {
  creatorTipRoute?: boolean;
}) {
  const { t: uiT } = useUiTranslation();

  const location = useLocation();
  const navigate = useNavigate();
  const creatorTip = useMemo(
    () => (creatorTipRoute ? readCreatorTipRouteState(location.state) : null),
    [creatorTipRoute, location.state],
  );

  if (creatorTipRoute && !creatorTip) {
    return (
      <Card className="mx-auto max-w-xl rounded-xl">
        <CardHeader>
          <CardTitle>
            {uiT(MESSAGE_KEYS.featuresWalletSendCreatorZECTipUnavailable)}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Callout
            tone="destructive"
            icon={TriangleAlert}
            title={uiT(
              MESSAGE_KEYS.featuresWalletSendTheCreatorPaymentDetailsCouldNotBe,
            )}
            role="alert"
          >
            {uiT(
              MESSAGE_KEYS.featuresWalletSendReturnToTheCreatorProfileAndStart,
            )}
          </Callout>
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate("/search")}
          >
            {uiT(MESSAGE_KEYS.featuresWalletSendBrowseCreators)}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <SendForm
      key={location.key}
      creatorTip={creatorTipRoute ? creatorTip : null}
    />
  );
}

function SendForm({ creatorTip }: { creatorTip: CreatorTipIntent | null }) {
  const { t: uiT } = useUiTranslation();

  const navigate = useNavigate();
  const balance = useWallet((s) => s.balance);
  const refreshBalance = useWallet((s) => s.refreshBalance);

  const [to, setTo] = useState(creatorTip?.recipient ?? "");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");

  const [validation, setValidation] = useState<AddressValidation | null>(null);
  const [validating, setValidating] = useState(false);

  const [proposal, setProposal] = useState<SendProposal | null>(null);
  const [preparingParams, setPreparingParams] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [broadcastResult, setBroadcastResult] =
    useState<ExecuteSendResult | null>(null);
  const [pendingSend, setPendingSend] = useState<PendingSendStatus | null>(
    null,
  );
  const [pendingCheck, setPendingCheck] = useState<
    "loading" | "ready" | "failed"
  >("loading");
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
        stale.proposalToken,
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
    hasUnknownBroadcast ||
    preparingParams ||
    reviewing ||
    sending ||
    proposal !== null;

  useEffect(() => {
    let active = true;
    void wallet
      .getPendingSend()
      .then((pending) => {
        if (!active) return;
        if (creatorTip && pending?.status === "unknown") {
          // Recovery belongs to a transaction created before this in-memory
          // creator intent. Move to the neutral recovery surface without ever
          // attributing or retiring it as the newly selected creator's tip.
          navigate("/wallet/send", { replace: true });
          return;
        }
        if (pending?.status === "unknown") setPendingSend(pending);
        setPendingCheck("ready");
      })
      .catch((error) => {
        if (active) {
          setPendingCheck("failed");
          toast.error(
            errorMessage(
              error,
              translate(
                MESSAGE_KEYS.featuresWalletSendCouldnTLoadPendingPaymentState,
              ),
            ),
          );
        }
      });
    return () => {
      active = false;
    };
  }, [creatorTip, navigate]);

  // Parse a pasted `zcash:` payment URI and prefill the form.
  const applyUri = useCallback(
    async (uri: string) => {
      const generation = invalidateReview();
      // Clear the previous intent before parsing. A rejected multi-payment or
      // wrong-network request must not leave an older payable form looking as
      // though the new link was accepted.
      setTo("");
      setAmount("");
      setMemo("");
      setValidation(null);
      try {
        const req = await wallet.parsePaymentUri(uri);
        if (!mountedRef.current || generation !== generationRef.current) return;
        setTo(req.address);
        if (req.amount !== null) setAmount(formatZec(req.amount));
        if (req.memo !== null) setMemo(clampToBytes(req.memo, MEMO_MAX_BYTES));
        toast.success(
          translate(MESSAGE_KEYS.featuresWalletSendPaymentRequestLoaded),
        );
      } catch {
        if (mountedRef.current && generation === generationRef.current) {
          toast.error(
            translate(
              MESSAGE_KEYS.featuresWalletSendCouldnTReadThatPaymentLink,
            ),
          );
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
    let active = true;
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    if (!addr) {
      setValidation(null);
      setValidating(false);
      return;
    }
    setValidation(null);
    setValidating(true);
    debounceRef.current = window.setTimeout(() => {
      void wallet
        .validateAddress(addr)
        .then((res) => {
          if (active) setValidation(res);
        })
        .catch(() => {
          if (active) {
            setValidation({
              valid: false,
              addressType: null,
              canReceiveMemo: false,
            });
          }
        })
        .finally(() => {
          if (active) setValidating(false);
        });
    }, 350);
    return () => {
      active = false;
      if (debounceRef.current !== null)
        window.clearTimeout(debounceRef.current);
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
      recipient: creatorTip?.recipient ?? to.trim(),
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
      const p = await wallet.proposeSend(
        requested.recipient,
        requested.amount,
        requested.memo,
      );
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
        toast.error(
          errorMessage(
            e,
            translate(
              MESSAGE_KEYS.featuresWalletSendCouldnTBuildTheTransaction,
            ),
          ),
        );
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
    creatorTip,
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
      const confirmation = await wallet.confirmSend(
        confirmedProposal.proposalId,
        confirmedProposal.reviewDigest,
        confirmedProposal.proposalToken,
      );
      assertFreshSendConfirmation(confirmation);
      if (!mountedRef.current || generation !== generationRef.current) return;
      const result = await wallet.executeSend(
        confirmedProposal.proposalId,
        confirmedProposal.reviewDigest,
        confirmation.confirmationToken,
      );
      if (!mountedRef.current || generation !== generationRef.current) return;
      proposalRef.current = null;
      setProposal(null);
      setDialogOpen(false);
      setBroadcastResult(result);
      if (result.status === "accepted") {
        if (creatorTip) retireCreatorTipIntent(creatorTip);
        setPendingSend(null);
        toast.success(
          translate(MESSAGE_KEYS.featuresWalletSendTransactionSent),
          {
            description: (
              <span>
                txid <BidiIdentifier value={result.txid} shorten />
              </span>
            ),
          },
        );
        await refreshBalance().catch(() => {
          if (mountedRef.current && generation === generationRef.current) {
            toast.warning(
              translate(
                MESSAGE_KEYS.featuresWalletSendPaymentSentBalanceRefreshIsStillPending,
              ),
            );
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
        toast.warning(
          translate(MESSAGE_KEYS.featuresWalletSendBroadcastStatusUnknown),
          {
            description: translate(
              MESSAGE_KEYS.featuresWalletSendRetryingWillRebroadcastTheSameTransactionSafely,
            ),
          },
        );
      } else {
        toast.error(
          translate(MESSAGE_KEYS.featuresWalletSendTransactionRejected),
          {
            description: translate(
              MESSAGE_KEYS.featuresWalletSendTheServerRejectedThisTransaction,
            ),
          },
        );
      }
    } catch (e) {
      const recovered = await wallet.getPendingSend().catch(() => null);
      if (!mountedRef.current || generation !== generationRef.current) return;
      void discardNativeProposal(confirmedProposal);
      proposalRef.current = null;
      setProposal(null);
      setDialogOpen(false);
      if (recovered?.status === "unknown") setPendingSend(recovered);
      toast.error(
        errorMessage(e, translate(MESSAGE_KEYS.featuresWalletSendSendFailed)),
      );
    } finally {
      confirmingRef.current = false;
      if (mountedRef.current && generation === generationRef.current)
        setSending(false);
    }
  }, [creatorTip, discardNativeProposal, refreshBalance, navigate]);

  const onRetryPending = useCallback(async () => {
    setSending(true);
    try {
      const result = await wallet.retryPendingSend();
      setBroadcastResult(result);
      if (result.status === "accepted") {
        if (creatorTip) retireCreatorTipIntent(creatorTip);
        setPendingSend(null);
        toast.success(
          translate(
            MESSAGE_KEYS.featuresWalletSendTransactionBroadcastConfirmed,
          ),
          {
            description: (
              <span>
                txid <BidiIdentifier value={result.txid} shorten />
              </span>
            ),
          },
        );
        await refreshBalance();
        navigate("/wallet/history");
      } else if (result.status === "unknown") {
        setPendingSend((pending) =>
          pending ? { ...pending, ...result } : null,
        );
        toast.warning(
          translate(MESSAGE_KEYS.featuresWalletSendBroadcastIsStillUnresolved),
          {
            description: translate(
              MESSAGE_KEYS.featuresWalletSendNoReplacementPaymentWasCreated,
            ),
          },
        );
      } else {
        setPendingSend(null);
        proposalRef.current = null;
        setProposal(null);
        toast.info(
          translate(
            MESSAGE_KEYS.featuresWalletSendTransactionExpiredWithoutBeingFound,
          ),
          {
            description: translate(
              MESSAGE_KEYS.featuresWalletSendItIsSafeToReviewANew,
            ),
          },
        );
      }
    } catch (error) {
      toast.error(
        errorMessage(
          error,
          translate(
            MESSAGE_KEYS.featuresWalletSendCouldnTRetryThePendingTransaction,
          ),
        ),
      );
    } finally {
      setSending(false);
    }
  }, [creatorTip, navigate, refreshBalance]);

  const onDiscardUnrecoverable = useCallback(async () => {
    if (!pendingSend?.canDiscard) return;
    const confirmed = window.confirm(
      translate(
        MESSAGE_KEYS.featuresWalletSendOnlyContinueIfYouCheckedWalletHistory,
      ),
    );
    if (!confirmed) return;
    setSending(true);
    try {
      await wallet.discardUnrecoverableSend(pendingSend.proposalId);
      setPendingSend(null);
      setBroadcastResult(null);
      proposalRef.current = null;
      setProposal(null);
      toast.warning(
        translate(
          MESSAGE_KEYS.featuresWalletSendRecoveryLockDiscardedAfterWalletHistoryConfirmation,
        ),
      );
    } catch (error) {
      toast.error(
        errorMessage(
          error,
          translate(MESSAGE_KEYS.featuresWalletSendCouldnTDiscardRecoveryState),
        ),
      );
    } finally {
      setSending(false);
    }
  }, [pendingSend]);

  if (creatorTip && pendingCheck !== "ready") {
    return (
      <Card className="mx-auto max-w-xl rounded-xl">
        <CardHeader>
          <CardTitle>
            {uiT(MESSAGE_KEYS.featuresWalletSendCheckingWalletRecovery)}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {pendingCheck === "failed" ? (
            <Callout
              tone="destructive"
              icon={TriangleAlert}
              title={uiT(
                MESSAGE_KEYS.featuresWalletSendWalletRecoveryStateUnavailable,
              )}
              role="alert"
            >
              {uiT(
                MESSAGE_KEYS.featuresWalletSendReturnToWalletSendAndResolveRecovery,
              )}
            </Callout>
          ) : (
            <p className="text-sm text-muted-foreground" role="status">
              {uiT(MESSAGE_KEYS.featuresWalletSendCheckingForAnEarlierPayment)}
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-xl">
      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle>{uiT(MESSAGE_KEYS.featuresWalletSendSendZEC)}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {creatorTip ? (
            <Callout
              tone="info"
              icon={Heart}
              title={uiT(MESSAGE_KEYS.featuresWalletSendZECTipFor, {
                value1: creatorTip.label,
              })}
              data-testid="creator-tip-context"
            >
              <p className="text-muted-foreground">
                {uiT(
                  MESSAGE_KEYS.featuresWalletSendTheCreatorDestinationIsLockedFromThe,
                  { value1: creatorTip.username },
                )}
              </p>
            </Callout>
          ) : null}
          {pendingSend?.status === "unknown" ? (
            <div
              className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning"
              role="status"
            >
              <p className="font-medium">
                {uiT(
                  MESSAGE_KEYS.featuresWalletSendAPreviousBroadcastIsUnresolved,
                )}
              </p>
              <p className="mt-1 text-xs">
                {pendingSend.canDiscard
                  ? uiT(
                      MESSAGE_KEYS.featuresWalletSendTransactionCreationWasInterruptedAndExactRetry,
                    )
                  : pendingSend.recoveryRequired
                    ? uiT(
                        MESSAGE_KEYS.featuresWalletSendTheRecoveryJournalCouldNotBeDecoded,
                      )
                    : uiT(
                        MESSAGE_KEYS.featuresWalletSendZUULIRecoveredTheExactTransactionAfterRestart,
                      )}
              </p>
              <p className="mono-id mt-1 break-all font-mono text-xs opacity-75">
                txid <BidiIdentifier value={pendingSend.txid} />
              </p>
            </div>
          ) : null}
          {/* Recipient */}
          <div className="space-y-1.5">
            <Label htmlFor="to">
              {uiT(MESSAGE_KEYS.featuresWalletSendRecipientAddress)}
            </Label>
            <Input
              id="to"
              dir="ltr"
              value={to}
              onChange={
                creatorTip ? undefined : (e) => onToChange(e.target.value)
              }
              placeholder={uiT(
                MESSAGE_KEYS.featuresWalletSendU1Zs1T1OrPasteAZcash,
              )}
              autoComplete="off"
              spellCheck={false}
              readOnly={Boolean(creatorTip)}
              aria-readonly={creatorTip ? true : undefined}
              disabled={formLocked}
              className={cn(
                "font-mono",
                validation &&
                  !validation.valid &&
                  to.trim() &&
                  "border-destructive",
              )}
              aria-invalid={validation ? !validation.valid : undefined}
            />
            <div className="min-h-[1.25rem] text-xs">
              {validating ? (
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {uiT(MESSAGE_KEYS.featuresWalletSendCheckingAddress)}
                </span>
              ) : validation && to.trim() ? (
                validation.valid ? (
                  <span className="flex items-center gap-1.5 text-success">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {uiT(MESSAGE_KEYS.validAddress, {
                      type: validation.addressType,
                      memo: validation.canReceiveMemo ? "yes" : "no",
                    })}
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-destructive">
                    <AlertCircle className="h-3.5 w-3.5" />
                    {uiT(
                      MESSAGE_KEYS.featuresWalletSendNotARecognizableZcashAddress,
                    )}
                  </span>
                )
              ) : null}
            </div>
          </div>

          {creatorTip && validation?.valid && !validation.canReceiveMemo ? (
            <Callout
              icon={TriangleAlert}
              title={uiT(MESSAGE_KEYS.featuresWalletSendTransparentZECTip)}
              role="alert"
              data-testid="creator-tip-privacy-warning"
            >
              {uiT(
                MESSAGE_KEYS.featuresWalletSendThisPaymentWillBePubliclyVisibleOn,
              )}
            </Callout>
          ) : null}

          {/* Amount */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="amount">
                {uiT(MESSAGE_KEYS.featuresWalletSendAmount)}
              </Label>
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
                  {uiT(MESSAGE_KEYS.featuresWalletSendMax, {
                    value1: formatZecDisplay(maxSpendable),
                  })}
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
                  "pe-14 bidi-number tabular-nums",
                  (invalidAmount || overBalance) && "border-destructive",
                )}
                aria-describedby="amount-error"
                aria-invalid={invalidAmount || overBalance || undefined}
              />
              <div className="pointer-events-none absolute inset-y-0 end-3 flex items-center">
                <ZecTag className="text-xs" />
              </div>
            </div>
            <div id="amount-error" className="min-h-[1.25rem] text-xs">
              {invalidAmount ? (
                <span className="flex items-center gap-1.5 text-destructive">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {uiT(
                    MESSAGE_KEYS.featuresWalletSendEnterAPositiveZECAmountWithNo,
                  )}
                </span>
              ) : overBalance ? (
                <span className="flex items-center gap-1.5 text-destructive">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {uiT(
                    MESSAGE_KEYS.featuresWalletSendAmountPlusNetworkFeeExceedsSpendableBalance,
                  )}
                </span>
              ) : null}
            </div>
          </div>

          {/* Memo */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="memo">
                <Trans
                  i18nKey={MESSAGE_KEYS.featuresWalletSendMemoOptional}
                  components={{
                    part1: <span className="text-muted-foreground"></span>,
                  }}
                />
              </Label>
              {canReceiveMemo ? (
                <span
                  className={cn(
                    "text-xs bidi-number tabular-nums text-muted-foreground",
                    memoBytes >= MEMO_MAX_BYTES && "text-destructive",
                  )}
                >
                  {uiT(MESSAGE_KEYS.memoBytes, {
                    count: memoBytes,
                    limit: MEMO_MAX_BYTES,
                  })}
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
                  ? uiT(
                      MESSAGE_KEYS.featuresWalletSendEncryptedNoteDeliveredWithThePayment,
                    )
                  : uiT(
                      MESSAGE_KEYS.featuresWalletSendThisAddressTypeCanTReceiveMemos,
                    )
              }
              className="resize-none"
            />
            {canReceiveMemo ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5" />
                {uiT(
                  MESSAGE_KEYS.featuresWalletSendMemosAreEncryptedAndOnlyVisibleTo,
                )}
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
                  {uiT(MESSAGE_KEYS.featuresWalletSendUnlocking)}
                </>
              ) : (
                uiT(MESSAGE_KEYS.featuresWalletSendICheckedHistoryUnlockSends)
              )
            ) : pendingSend?.recoveryRequired ? (
              uiT(MESSAGE_KEYS.featuresWalletSendRecoveryDataLocked)
            ) : pendingSend?.status === "unknown" ? (
              sending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {uiT(MESSAGE_KEYS.featuresWalletSendRetryingExactTransaction)}
                </>
              ) : (
                uiT(MESSAGE_KEYS.featuresWalletSendRetryRecoveredTransaction)
              )
            ) : hasUnknownBroadcast ? (
              uiT(MESSAGE_KEYS.featuresWalletSendResumePendingBroadcast)
            ) : preparingParams ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {uiT(MESSAGE_KEYS.featuresWalletSendPreparingProvingData)}
              </>
            ) : reviewing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {uiT(MESSAGE_KEYS.featuresWalletSendBuilding)}
              </>
            ) : (
              uiT(MESSAGE_KEYS.featuresWalletSendReviewPayment)
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
            <DialogTitle>
              {uiT(MESSAGE_KEYS.featuresWalletSendConfirmPayment)}
            </DialogTitle>
            <DialogDescription>
              {uiT(
                MESSAGE_KEYS.featuresWalletSendReviewTheDetailsBeforeBroadcastingThisCan,
              )}
            </DialogDescription>
          </DialogHeader>

          {proposal ? (
            <div className="space-y-3">
              {creatorTip ? (
                <Callout
                  tone="info"
                  icon={Heart}
                  title={uiT(MESSAGE_KEYS.featuresWalletSendCreatorTipFor, {
                    value1: creatorTip.label,
                  })}
                  data-testid="creator-tip-review-context"
                >
                  @{creatorTip.username}
                </Callout>
              ) : null}
              <div className="space-y-3 rounded-lg border border-border bg-background/40 p-4 text-sm">
                <Row label={uiT(MESSAGE_KEYS.featuresWalletSendTo)}>
                  <BidiIdentifier
                    value={proposal.review.payments[0]?.recipient ?? ""}
                    className="mono-id min-w-0 break-all text-end font-mono text-xs"
                    data-testid="send-review-recipient"
                  />
                </Row>
                <Row label={uiT(MESSAGE_KEYS.featuresWalletSendAmount)}>
                  <span
                    className="bidi-number tabular-nums"
                    data-testid="send-review-amount"
                  >
                    {formatZecDisplay(proposal.review.payments[0]?.amount ?? 0)}
                  </span>
                </Row>
                <Row label={uiT(MESSAGE_KEYS.featuresWalletSendNetworkFee)}>
                  <span
                    className="bidi-number tabular-nums text-muted-foreground"
                    title={proposal.review.feePolicy}
                  >
                    {formatZecDisplay(proposal.review.fee)}
                  </span>
                </Row>
                <Row label={uiT(MESSAGE_KEYS.featuresWalletSendMemo)}>
                  <span
                    className="min-w-0 whitespace-pre-wrap break-words text-end text-muted-foreground"
                    data-testid="send-review-memo"
                  >
                    {proposal.review.payments[0]?.memo ??
                      uiT(MESSAGE_KEYS.featuresWalletSendNone)}
                  </span>
                </Row>
                <Row label={uiT(MESSAGE_KEYS.featuresWalletSendNetwork)}>
                  <span className="capitalize text-muted-foreground">
                    {proposal.review.network}
                  </span>
                </Row>
                <Row label={uiT(MESSAGE_KEYS.featuresWalletSendChange)}>
                  <span
                    className="text-muted-foreground"
                    data-testid="send-review-change-policy"
                    title={proposal.review.changePolicy}
                  >
                    {uiT(MESSAGE_KEYS.featuresWalletSendShieldedAutomatically)}
                  </span>
                </Row>
                <Separator />
                <Row label={uiT(MESSAGE_KEYS.featuresWalletSendTotal)}>
                  <span className="text-base font-semibold bidi-number tabular-nums text-zec">
                    {formatZecDisplay(proposal.review.total)}
                  </span>
                </Row>
              </div>
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
                  ? uiT(MESSAGE_KEYS.featuresWalletSendBroadcastStatusUnknown)
                  : uiT(MESSAGE_KEYS.featuresWalletSendBroadcastRejected)}
              </p>
              <p className="mt-1 text-xs opacity-90">
                {uiT(
                  broadcastResult.status === "unknown"
                    ? MESSAGE_KEYS.featuresWalletSendRetryingWillRebroadcastTheSameTransactionSafely
                    : MESSAGE_KEYS.featuresWalletSendTheServerRejectedThisTransaction,
                )}
              </p>
              <p className="mono-id mt-1 break-all font-mono text-xs opacity-75">
                txid <BidiIdentifier value={broadcastResult.txid} />
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
              {uiT(MESSAGE_KEYS.featuresWalletSendCancel)}
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
                  {uiT(MESSAGE_KEYS.featuresWalletSendSending)}
                </>
              ) : (
                uiT(MESSAGE_KEYS.featuresWalletSendConfirmSend)
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
