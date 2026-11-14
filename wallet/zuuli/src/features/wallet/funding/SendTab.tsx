import { translate } from "@/i18n/translate";
import { useTranslation as useUiTranslation } from "react-i18next";
import { MESSAGE_KEYS } from "@/i18n/messages";
import {
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Gift,
  Loader2,
  Search,
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
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { discover, tuzi } from "@/lib/api/free2z";
import {
  authoritativeBalanceFromErrorBody,
  type DonationResult,
} from "@/lib/api/donation";
import { setToken } from "@/lib/api/http";
import type { SimpleCreator } from "@/lib/api/types";
import { useSession } from "@/store/session";
import { cn } from "@/lib/utils";
import {
  formatTuzis,
  initials,
  MAX_TUZIS,
  parseTuzis,
  tuziInputExample,
  tuziInputMaxLength,
  validateTuzis,
} from "@/lib/format";
import { TIP_PRESETS } from "./lib";
import { paidActionGate } from "@/lib/auth/paid-action";
import { preservePaidIntent } from "@/lib/auth/paid-intent";
import { usePaidIntent } from "@/hooks/usePaidIntent";
import {
  classifyTransferFailure,
  clearPendingDonation,
  createDonationIdempotencyKey,
  initialRecipientState,
  loadPendingDonation,
  pendingDonationMatches,
  persistPendingDonation,
  recipientKeyAction,
  recipientReducer,
  reviewMatchesTransfer,
  sameUsername,
  shouldSearchRecipients,
  transferBlock,
  transferFailureIsAmbiguous,
  TRANSFER_FAILURE_MESSAGES,
  type TransferFailure,
  type TransferReview,
} from "./send-recipient";

const SEARCH_DEBOUNCE_MS = 300;

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function SendTab({ onNeedBuy }: { onNeedBuy: () => void }) {
  const { t: uiT } = useUiTranslation();

  const navigate = useNavigate();
  const user = useSession((s) => s.user);
  const sessionLoading = useSession((s) => s.loading);
  const tuzis = useSession((s) => s.tuzis);
  const setTuzis = useSession((s) => s.setTuzis);
  const setUser = useSession((s) => s.setUser);
  const refreshSession = useSession((s) => s.refresh);
  const restored = usePaidIntent("/wallet/fund/send", "send");
  const restoredSend = restored?.kind === "send" ? restored : null;
  const restoredHandled = useRef(false);
  const [recipientState, dispatch] = useReducer(recipientReducer, {
    ...initialRecipientState,
  });
  const [selectedAmount, setSelectedAmount] = useState<number>(TIP_PRESETS[1]);
  const [custom, setCustom] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [transferFailure, setTransferFailure] =
    useState<TransferFailure | null>(null);
  const [completedTransfer, setCompletedTransfer] = useState<{
    review: TransferReview;
    result: DonationResult;
  } | null>(null);
  const resultsId = useId();

  useEffect(() => {
    if (!restoredSend || restoredHandled.current) return;
    restoredHandled.current = true;
    dispatch({ type: "queryChanged", query: restoredSend.query });
    const restoredAmount =
      typeof restoredSend.amount === "number"
        ? restoredSend.amount
        : parseTuzis(restoredSend.amount);
    if (
      restoredAmount !== null &&
      TIP_PRESETS.some((preset) => preset === restoredAmount)
    ) {
      setSelectedAmount(restoredAmount);
      setCustom("");
    } else {
      setCustom(
        typeof restoredSend.amount === "number"
          ? restoredSend.amount.toLocaleString()
          : restoredSend.amount,
      );
    }
  }, [restoredSend]);

  const debouncedQuery = useDebounced(
    recipientState.query.trim(),
    SEARCH_DEBOUNCE_MS,
  );
  const currentQuery = recipientState.query.trim();
  const debouncedQueryIsCurrent = debouncedQuery === currentQuery;

  const ownUsername = user?.username;
  const exactSelfQuery = Boolean(
    ownUsername && currentQuery && sameUsername(currentQuery, ownUsername),
  );

  useEffect(() => {
    if (
      !shouldSearchRecipients({
        currentQuery,
        debouncedQuery,
        selected: recipientState.selected,
        isSelf: exactSelfQuery,
      })
    ) {
      return;
    }

    const generation = recipientState.generation;
    let alive = true;
    dispatch({ type: "searchStarted", generation });
    discover
      .searchCreators(debouncedQuery)
      .then((creators) => {
        if (!alive) return;
        const candidates = ownUsername
          ? creators.filter(
              (creator) => !sameUsername(creator.username, ownUsername),
            )
          : creators;
        dispatch({ type: "searchSucceeded", generation, results: candidates });
      })
      .catch(() => {
        if (alive) dispatch({ type: "searchFailed", generation });
      });

    return () => {
      alive = false;
    };
  }, [
    debouncedQuery,
    debouncedQueryIsCurrent,
    currentQuery,
    exactSelfQuery,
    ownUsername,
    recipientState.generation,
    recipientState.selected,
  ]);

  const hasCustomAmount = custom.length > 0;
  const customAmount = validateTuzis(custom, {
    minimum: 1,
    maximum: MAX_TUZIS,
  });
  const amount = hasCustomAmount ? customAmount.value : selectedAmount;
  const validAmount = !hasCustomAmount || customAmount.error === null;
  const enough = amount !== null && amount <= tuzis;
  const gate = paidActionGate({
    sessionLoading,
    user,
    balance: tuzis,
    cost: validAmount ? amount : null,
  });
  const block = transferBlock({
    selected: recipientState.selected,
    query: recipientState.query,
    ownUsername,
    amount,
    validAmount,
    balance: tuzis,
    sending,
  });
  const pendingDonation = loadPendingDonation();
  const pendingMatchesCurrent = Boolean(
    pendingDonation &&
    recipientState.selected &&
    ownUsername &&
    amount !== null &&
    validAmount &&
    pendingDonationMatches(pendingDonation, {
      senderUsername: ownUsername,
      recipient: recipientState.selected,
      amount,
    }),
  );
  const canReview =
    block === null || (block === "balance" && pendingMatchesCurrent);
  const reviewHasPersistedAttempt = Boolean(
    recipientState.review &&
    pendingDonation &&
    recipientState.review.idempotencyKey === pendingDonation.idempotencyKey &&
    pendingDonationMatches(pendingDonation, recipientState.review),
  );
  const reviewIsCurrent = reviewMatchesTransfer({
    review: recipientState.review,
    selected: recipientState.selected,
    query: recipientState.query,
    ownUsername,
    amount,
    validAmount,
    balance: reviewHasPersistedAttempt ? Number.MAX_SAFE_INTEGER : tuzis,
  });
  const transferLocked = Boolean(
    transferFailure && transferFailureIsAmbiguous(transferFailure),
  );
  const flowLocked = transferLocked || completedTransfer !== null;
  const transferCanRetry =
    transferFailure === "network" || transferFailure === "pending";
  const showingResults =
    !recipientState.selected &&
    (recipientState.searchStatus === "loading" ||
      recipientState.searchStatus === "ready" ||
      recipientState.searchStatus === "error");

  const activeResultId =
    recipientState.highlightedIndex >= 0
      ? `${resultsId}-option-${recipientState.highlightedIndex}`
      : undefined;

  const recipientHelp = useMemo(() => {
    if (!ownUsername)
      return uiT(MESSAGE_KEYS.featuresWalletFundingSendTabLogInBeforeSending2Z);
    if (exactSelfQuery)
      return uiT(MESSAGE_KEYS.featuresWalletFundingSendTabYouCanTSend2ZToYour);
    if (recipientState.searchStatus === "error") {
      return uiT(
        MESSAGE_KEYS.featuresWalletFundingSendTabCreatorSearchFailedCheckYourConnectionAnd,
      );
    }
    if (
      debouncedQuery &&
      debouncedQueryIsCurrent &&
      recipientState.searchStatus === "ready" &&
      recipientState.results.length === 0
    ) {
      return uiT(MESSAGE_KEYS.featuresWalletFundingSendTabNoCreatorFoundFor, {
        value1: debouncedQuery,
      });
    }
    if (!recipientState.selected) {
      return uiT(
        MESSAGE_KEYS.featuresWalletFundingSendTabSearchAndChooseACreatorTypedText,
      );
    }
    return null;
  }, [
    uiT,
    debouncedQuery,
    debouncedQueryIsCurrent,
    exactSelfQuery,
    ownUsername,
    recipientState.results.length,
    recipientState.searchStatus,
    recipientState.selected,
  ]);

  useEffect(() => {
    if (recipientState.review && !reviewIsCurrent) {
      dispatch({ type: "clearReview" });
    }
  }, [recipientState.review, reviewIsCurrent]);

  function changeRecipient(query: string) {
    if (flowLocked) return;
    setTransferFailure(null);
    dispatch({ type: "queryChanged", query });
  }

  function chooseRecipient(creator: SimpleCreator) {
    if (flowLocked) return;
    setTransferFailure(null);
    dispatch({ type: "select", creator });
  }

  function onRecipientKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const action = recipientKeyAction(
      event.key,
      recipientState.results,
      recipientState.highlightedIndex,
    );
    if (!action || (action.type === "closeResults" && !showingResults)) return;
    event.preventDefault();
    if (action.type === "select") setTransferFailure(null);
    dispatch(action);
  }

  function changeAmount(next: () => void) {
    if (flowLocked) return;
    setTransferFailure(null);
    dispatch({ type: "clearReview" });
    next();
  }

  function signInToSend() {
    const returnTo = preservePaidIntent("/wallet/fund/send", {
      kind: "send",
      query: recipientState.query,
      amount: validAmount && amount !== null ? amount : custom,
    });
    navigate("/login", { state: { returnTo } });
  }

  function beginReview() {
    if (gate === "sign-in") {
      signInToSend();
      return;
    }
    if (!canReview || amount === null || !ownUsername) return;
    const selected = recipientState.selected;
    if (!selected) return;
    const pending = loadPendingDonation();
    const candidate = {
      senderUsername: ownUsername,
      recipient: selected,
      amount,
    };
    if (pending && !pendingDonationMatches(pending, candidate)) {
      setTransferFailure("pending-conflict");
      return;
    }
    let idempotencyKey: string;
    try {
      idempotencyKey =
        pending?.idempotencyKey ?? createDonationIdempotencyKey();
    } catch {
      setTransferFailure("security");
      return;
    }
    setTransferFailure(pending ? "pending" : null);
    dispatch({
      type: "startReview",
      amount,
      senderUsername: ownUsername,
      idempotencyKey,
    });
  }

  async function send() {
    const review = recipientState.review;
    if (!useSession.getState().user) {
      dispatch({ type: "clearReview" });
      signInToSend();
      return;
    }
    if (sendingRef.current || !review || !reviewIsCurrent) {
      dispatch({ type: "clearReview" });
      return;
    }

    if (!persistPendingDonation(review)) {
      setTransferFailure("security");
      dispatch({ type: "clearReview" });
      return;
    }

    sendingRef.current = true;
    setSending(true);
    setTransferFailure(null);
    try {
      const result = await tuzi.donateIdempotent(
        review.recipient.username,
        review.amount,
        review.idempotencyKey,
      );
      setTuzis(result.balance);
      // Keep the keyed record until the user acknowledges this result. If the
      // app dies between the committed response and visible success, the next
      // attempt must replay this key rather than create a second charge.
      setCompletedTransfer({ review, result });
      toast.success(
        translate(MESSAGE_KEYS.fundingReceipt, {
          replayed: result.replayed ? "yes" : "no",
          amount: formatTuzis(review.amount),
          username: review.recipient.username,
        }),
        {
          description: result.replayed
            ? translate(
                MESSAGE_KEYS.featuresWalletFundingSendTabTheOriginalTransferWasNotChargedAgain,
              )
            : translate(
                MESSAGE_KEYS.featuresWalletFundingSendTabThanksForSupportingTheCreator,
              ),
        },
      );
      setCustom("");
      dispatch({ type: "reset" });
    } catch (error) {
      const failure = classifyTransferFailure(error);
      setTransferFailure(failure);
      if (failure === "balance" && error instanceof Error && "body" in error) {
        const balance = authoritativeBalanceFromErrorBody(
          (error as { body?: unknown }).body,
        );
        if (balance !== null) setTuzis(balance);
        else void refreshSession();
      }
      if (!transferFailureIsAmbiguous(failure)) {
        clearPendingDonation(review.idempotencyKey);
        dispatch({ type: "clearReview" });
      }
      if (failure === "not-found") dispatch({ type: "reset" });
      if (failure === "auth") {
        setToken(null);
        setUser(null);
      }
      toast.error(TRANSFER_FAILURE_MESSAGES[failure]);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
      <div className="space-y-5">
        <div className="space-y-3">
          <Label htmlFor="recipient">
            {uiT(MESSAGE_KEYS.featuresWalletFundingSendTabSendTo)}
          </Label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id="recipient"
              type="search"
              autoComplete="off"
              maxLength={128}
              placeholder={uiT(
                MESSAGE_KEYS.featuresWalletFundingSendTabSearchCreatorsByNameOrUsername,
              )}
              value={recipientState.query}
              onChange={(event) => changeRecipient(event.target.value)}
              onKeyDown={onRecipientKeyDown}
              className="h-11 ps-9"
              role="combobox"
              aria-label={uiT(
                MESSAGE_KEYS.featuresWalletFundingSendTabSearchForA2ZRecipient,
              )}
              aria-autocomplete="list"
              aria-expanded={
                showingResults && recipientState.results.length > 0
              }
              aria-controls={
                showingResults && recipientState.results.length > 0
                  ? resultsId
                  : undefined
              }
              aria-activedescendant={activeResultId}
              aria-describedby="recipient-help"
              aria-invalid={exactSelfQuery}
              disabled={sending || flowLocked}
            />
            {recipientState.searchStatus === "loading" ? (
              <Loader2
                className="absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground"
                aria-label={uiT(
                  MESSAGE_KEYS.featuresWalletFundingSendTabSearchingCreators,
                )}
              />
            ) : null}
          </div>

          {showingResults && recipientState.results.length > 0 ? (
            <div
              id={resultsId}
              role="listbox"
              aria-label={uiT(
                MESSAGE_KEYS.featuresWalletFundingSendTabMatchingCreators,
              )}
              className="overflow-hidden rounded-xl border border-border bg-card shadow-lg"
            >
              {recipientState.results.map((creator, index) => {
                const name = creator.display_name || creator.username;
                return (
                  <button
                    id={`${resultsId}-option-${index}`}
                    key={creator.username}
                    type="button"
                    role="option"
                    aria-selected={index === recipientState.highlightedIndex}
                    onClick={() => chooseRecipient(creator)}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-3 border-b border-border px-3 py-2 text-start last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      index === recipientState.highlightedIndex
                        ? "bg-primary/10"
                        : "hover:bg-secondary",
                    )}
                  >
                    <CreatorAvatar creator={creator} className="h-9 w-9" />
                    <span className="min-w-0">
                      <span className="block break-words font-medium">
                        {name}
                      </span>
                      <span className="block break-words text-xs text-muted-foreground">
                        @{creator.username}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {recipientState.selected ? (
            <div className="flex items-center gap-3 rounded-xl border border-primary/40 bg-primary/10 p-3">
              <CreatorAvatar
                creator={recipientState.selected}
                className="h-11 w-11"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 font-medium">
                  <CheckCircle2 className="h-4 w-4 text-primary" aria-hidden />
                  <span className="min-w-0 break-words">
                    {recipientState.selected.display_name ||
                      recipientState.selected.username}
                  </span>
                </div>
                <div className="break-words text-sm text-muted-foreground">
                  @{recipientState.selected.username}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => changeRecipient("")}
                disabled={sending || flowLocked}
                aria-label={uiT(
                  MESSAGE_KEYS.featuresWalletFundingSendTabChangeRecipientFrom,
                  { value1: recipientState.selected.username },
                )}
              >
                {uiT(MESSAGE_KEYS.featuresWalletFundingSendTabChange)}
              </Button>
            </div>
          ) : null}

          <div
            id="recipient-help"
            className={cn(
              "min-h-[1rem] text-xs text-muted-foreground",
              (exactSelfQuery || recipientState.searchStatus === "error") &&
                "text-destructive",
            )}
            role={
              exactSelfQuery || recipientState.searchStatus === "error"
                ? "alert"
                : "status"
            }
          >
            {recipientHelp}
          </div>
        </div>

        <div className="space-y-3">
          <Label>{uiT(MESSAGE_KEYS.featuresWalletFundingSendTabAmount)}</Label>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {TIP_PRESETS.map((preset) => {
              const active = !hasCustomAmount && selectedAmount === preset;
              return (
                <button
                  key={preset}
                  type="button"
                  onClick={() =>
                    changeAmount(() => {
                      setSelectedAmount(preset);
                      setCustom("");
                    })
                  }
                  aria-pressed={active}
                  disabled={sending || flowLocked}
                  className={cn(
                    "min-tap rounded-xl border p-3 text-center transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                    active
                      ? "border-primary bg-primary/10"
                      : "border-border hover:border-primary/40 hover:bg-primary/5",
                  )}
                >
                  <div className="text-base font-bold bidi-number tabular-nums">
                    {preset.toLocaleString()}
                  </div>
                  <div className="text-xs font-medium text-primary">2Z</div>
                </button>
              );
            })}
          </div>
          <div className="relative">
            <Input
              inputMode="numeric"
              placeholder={uiT(
                MESSAGE_KEYS.featuresWalletFundingSendTabCustomAmount,
              )}
              maxLength={tuziInputMaxLength(MAX_TUZIS)}
              value={custom}
              onChange={(event) =>
                changeAmount(() => setCustom(event.target.value))
              }
              className="pe-24 bidi-number tabular-nums"
              aria-label={uiT(
                MESSAGE_KEYS.featuresWalletFundingSendTabCustomTipAmountIn2Z,
              )}
              aria-describedby="custom-tip-error"
              aria-invalid={hasCustomAmount && !validAmount}
              disabled={sending || flowLocked}
            />
            <span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-sm font-medium bidi-number tabular-nums text-muted-foreground">
              2Z
            </span>
          </div>
          <div
            id="custom-tip-error"
            className="min-h-[1rem] text-xs text-destructive"
          >
            {hasCustomAmount && customAmount.error === "tooLarge"
              ? uiT(MESSAGE_KEYS.featuresWalletFundingSendTabMax2ZPerTip, {
                  value1: MAX_TUZIS.toLocaleString(),
                })
              : hasCustomAmount && customAmount.error !== null
                ? uiT(
                    MESSAGE_KEYS.featuresWalletFundingSendTabEnterAPositiveWhole2ZAmountE,
                    { value1: tuziInputExample() },
                  )
                : null}
          </div>
        </div>
      </div>

      <Card className="h-fit lg:sticky lg:top-4">
        <CardHeader className="pb-4">
          <CardTitle>
            {uiT(MESSAGE_KEYS.featuresWalletFundingSendTabReviewTip)}
          </CardTitle>
          <CardDescription>
            {uiT(
              MESSAGE_KEYS.featuresWalletFundingSendTabYouWillConfirmBeforeAnythingIsSent,
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground">
              {uiT(MESSAGE_KEYS.featuresWalletFundingSendTabRecipient)}
            </span>
            {recipientState.selected ? (
              <span className="min-w-0 text-end">
                <span className="block break-words font-medium">
                  {recipientState.selected.display_name ||
                    recipientState.selected.username}
                </span>
                <span className="block break-words text-xs text-muted-foreground">
                  @{recipientState.selected.username}
                </span>
              </span>
            ) : (
              <span className="font-medium">—</span>
            )}
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-muted-foreground">
              {uiT(MESSAGE_KEYS.featuresWalletFundingSendTabAmount)}
            </span>
            <div className="text-xl font-bold bidi-number tabular-nums">
              {validAmount && amount !== null ? formatTuzis(amount) : "—"}
            </div>
          </div>
          {user ? (
            <div className="flex items-center justify-between border-t border-border pt-3 text-sm">
              <span className="text-muted-foreground">
                {uiT(MESSAGE_KEYS.featuresWalletFundingSendTabBalanceAfter)}
              </span>
              <span
                className={cn(
                  "bidi-number tabular-nums",
                  validAmount && !enough && "text-destructive",
                )}
              >
                {formatTuzis(
                  Math.max(
                    0,
                    tuzis - (validAmount && amount !== null ? amount : 0),
                  ),
                )}
              </span>
            </div>
          ) : null}

          {transferFailure && (user || transferFailure !== "balance") ? (
            <div
              role="alert"
              className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{TRANSFER_FAILURE_MESSAGES[transferFailure]}</span>
            </div>
          ) : null}

          {completedTransfer ? (
            <div className="space-y-3 rounded-xl border border-success/40 bg-success/10 p-3">
              <div className="flex items-center gap-2 font-medium text-success">
                <CheckCircle2 className="h-4 w-4" aria-hidden />
                {uiT(
                  MESSAGE_KEYS.featuresWalletFundingSendTabTransferConfirmed,
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {uiT(MESSAGE_KEYS.fundingConfirmed, {
                  amount: formatTuzis(completedTransfer.result.charged),
                  username: completedTransfer.review.recipient.username,
                  replayed: completedTransfer.result.replayed ? "yes" : "no",
                })}
              </p>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => {
                  clearPendingDonation(completedTransfer.review.idempotencyKey);
                  setCompletedTransfer(null);
                }}
              >
                {uiT(
                  MESSAGE_KEYS.featuresWalletFundingSendTabStartAnotherTransfer,
                )}
              </Button>
            </div>
          ) : gate === "loading" ? (
            <Button className="w-full" disabled>
              <Loader2 className="h-4 w-4 animate-spin" />
              {uiT(MESSAGE_KEYS.featuresWalletFundingSendTabCheckingAccount)}
            </Button>
          ) : gate === "sign-in" ? (
            <Button className="w-full" onClick={signInToSend}>
              {uiT(MESSAGE_KEYS.featuresWalletFundingSendTabSignInToSend2Z)}
              <ArrowRight className="rtl:-scale-x-100 h-4 w-4" />
            </Button>
          ) : block === "balance" && !pendingMatchesCurrent ? (
            <Button variant="outline" className="w-full" onClick={onNeedBuy}>
              {uiT(MESSAGE_KEYS.featuresWalletFundingSendTabNotEnough2ZBuyMore)}
              <ArrowRight className="rtl:-scale-x-100 h-4 w-4" />
            </Button>
          ) : recipientState.review && reviewIsCurrent ? (
            <div className="space-y-3 rounded-xl border border-primary/40 bg-primary/5 p-3">
              <p className="text-sm font-medium">
                {uiT(
                  MESSAGE_KEYS.featuresWalletFundingSendTabConfirmThisTransfer,
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {uiT(MESSAGE_KEYS.fundingConfirm, {
                  amount: formatTuzis(recipientState.review.amount),
                  username: recipientState.review.recipient.username,
                })}
              </p>
              <div
                className={cn("grid gap-2", !transferLocked && "grid-cols-2")}
              >
                {!transferLocked ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => dispatch({ type: "clearReview" })}
                    disabled={sending}
                  >
                    {uiT(MESSAGE_KEYS.featuresWalletFundingSendTabCancel)}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  onClick={send}
                  disabled={
                    sending ||
                    !reviewIsCurrent ||
                    (!transferCanRetry && transferLocked)
                  }
                >
                  {sending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Gift className="h-4 w-4" />
                  )}
                  {transferCanRetry
                    ? uiT(
                        MESSAGE_KEYS.featuresWalletFundingSendTabRetrySameTransfer,
                      )
                    : uiT(MESSAGE_KEYS.featuresWalletFundingSendTabConfirmSend)}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              className="w-full"
              disabled={!canReview}
              onClick={beginReview}
            >
              <Gift className="h-4 w-4" />
              {uiT(MESSAGE_KEYS.featuresWalletFundingSendTabReviewTransfer)}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CreatorAvatar({
  creator,
  className,
}: {
  creator: SimpleCreator;
  className?: string;
}) {
  const name = creator.display_name || creator.username;
  // Initials, never the uploaded avatar. A creator-supplied image is content
  // ZUULI does not author, and the wallet authority renders none of that
  // (#904); `img-src` no longer admits a remote host at all.
  return (
    <Avatar className={className}>
      <AvatarFallback className="text-xs">{initials(name)}</AvatarFallback>
    </Avatar>
  );
}
