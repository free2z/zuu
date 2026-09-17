import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Download,
  Loader2,
  LockKeyhole,
  MessageSquareLock,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MESSAGE_KEYS } from "@/i18n/messages";
import {
  classifyChatRequestFailure,
  type ChatRequestOutcome,
  type ChatRequestResult,
} from "@/lib/api/chat-request";
import { e2ee } from "@/lib/api/free2z";
import type { CreatorDetail } from "@/lib/api/types";
import { paidActionGate } from "@/lib/auth/paid-action";
import { preservePaidIntent, type PaidIntent } from "@/lib/auth/paid-intent";
import {
  E2E2Z_INSTALL_URL,
  e2e2zChatLink,
  openE2e2z,
} from "@/lib/bridge/e2e2z-chat";
import { formatTuzis } from "@/lib/format";
import { useSession } from "@/store/session";
import { chatRequestCopy } from "./chat-request-copy";
import {
  rememberChatRequest,
  useStartedChatRequest,
} from "./chat-request-session";

type PriceState =
  | { status: "loading"; cost: null }
  | { status: "ready"; cost: number }
  | { status: "error"; cost: null };

/**
 * One paid attempt. The key is minted when the payer first confirms and is
 * kept, with the cost they saw, for as long as the outcome is unknown: a retry
 * of an unknown outcome MUST send the same key, so the server replays instead
 * of charging twice. A definitive answer ends the attempt.
 */
interface Attempt {
  viewer: string;
  key: string;
  cost: number;
}

/** Footer buttons may wrap: their copy is never clipped (ui-copy doctrine). */
const WRAPPING_BUTTON = "h-auto min-h-11 whitespace-normal text-center";

/**
 * "Start encrypted chat" (#1022): pay the server-set price to introduce
 * yourself to a creator, then open e2e2z on its first-contact screen.
 *
 * Follows `TipButton`'s paid-action shape: `paidActionGate` decides what the
 * primary button may do, a signed-out tap preserves the intent across login,
 * and every outcome is worded by the exhaustive `chatRequestCopy`.
 */
export function StartChatButton({
  creator,
  restored,
}: {
  creator: CreatorDetail;
  restored: PaidIntent | null;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const user = useSession((s) => s.user);
  const sessionLoading = useSession((s) => s.loading);
  const balance = useSession((s) => s.tuzis);
  const setTuzis = useSession((s) => s.setTuzis);
  const refreshSession = useSession((s) => s.refresh);
  const username = creator.username;
  const started = useStartedChatRequest(user?.username, username);

  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState<PriceState>({
    status: "loading",
    cost: null,
  });
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<ChatRequestOutcome | null>(null);
  const [refusedSelf, setRefusedSelf] = useState(false);
  const attempt = useRef<Attempt | null>(null);
  const priceRequest = useRef(0);
  const primaryAction = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoredHandled = useRef<PaidIntent | null>(null);

  const loadPrice = useCallback(async () => {
    const request = ++priceRequest.current;
    setPrice({ status: "loading", cost: null });
    try {
      const cost = await e2ee.chatRequestPrice();
      if (request === priceRequest.current) setPrice({ status: "ready", cost });
    } catch {
      if (request === priceRequest.current) {
        setPrice({ status: "error", cost: null });
      }
    }
  }, []);

  const openSheet = useCallback(() => {
    setOpen(true);
    // An unknown outcome stays on screen until it is resolved: closing the
    // sheet must not quietly turn "we don't know" into a fresh, re-keyed try.
    setOutcome((current) =>
      current && chatRequestCopy(current).retry === "same-attempt"
        ? current
        : null,
    );
    if (price.status !== "ready") void loadPrice();
  }, [loadPrice, price.status]);

  useEffect(() => {
    // `openSheet` changes with the price, so guard on the intent itself: a
    // restored intent reopens the sheet once, never again after a close.
    if (restoredHandled.current === restored) return;
    restoredHandled.current = restored;
    if (
      restored?.kind === "start-encrypted-chat" &&
      restored.subject === username
    ) {
      // Restoring only reopens the confirmation. The charge still waits for
      // a fresh, deliberate tap from the signed-in payer.
      openSheet();
    }
  }, [openSheet, restored, username]);

  const shown: ChatRequestOutcome | null =
    outcome ?? (started ? { kind: "started", result: started } : null);
  const copy = shown ? chatRequestCopy(shown) : null;

  // Move focus to the one thing to do next whenever the sheet changes state,
  // so a keyboard or screen-reader user is not left on a vanished button.
  useEffect(() => {
    if (open && copy) primaryAction.current?.focus();
  }, [open, copy]);

  const ownProfile =
    user !== null && user.username.toLowerCase() === username.toLowerCase();
  if (ownProfile || refusedSelf) return null;

  const cost = price.status === "ready" ? price.cost : null;
  const gate = paidActionGate({ sessionLoading, user, balance, cost });

  function signInToChat() {
    const returnTo = preservePaidIntent(location.pathname, {
      kind: "start-encrypted-chat",
      subject: username,
    });
    setOpen(false);
    navigate("/login", { state: { returnTo } });
  }

  function buyTuzis() {
    setOpen(false);
    navigate("/fund");
  }

  async function openChat(result: ChatRequestResult) {
    const link = e2e2zChatLink(result.recipient.handle);
    if (!link) return;
    if (!(await openE2e2z(link))) {
      toast.error(t(MESSAGE_KEYS.creatorChatActionOpenFailed));
    }
  }

  async function getE2e2z() {
    if (!(await openE2e2z(E2E2Z_INSTALL_URL))) {
      toast.error(t(MESSAGE_KEYS.creatorChatActionOpenFailed));
    }
  }

  async function start() {
    const viewer = useSession.getState().user;
    if (!viewer || gate === "sign-in") {
      signInToChat();
      return;
    }
    if (sending) return;
    const current =
      attempt.current && attempt.current.viewer === viewer.username
        ? attempt.current
        : null;
    // A retry of an unknown outcome replays the exact terms the payer saw.
    // Only a new attempt reads the gate and the current price.
    if (!current && (gate !== "ready" || cost === null)) return;
    const terms: Attempt = current ?? {
      viewer: viewer.username,
      key: crypto.randomUUID(),
      cost: cost as number,
    };
    attempt.current = terms;
    setSending(true);
    let next: ChatRequestOutcome;
    try {
      const result = await e2ee.startChatRequest(
        username,
        terms.cost,
        terms.key,
      );
      next = { kind: "started", result };
      rememberChatRequest(terms.viewer, username, result);
      if (useSession.getState().user?.username === terms.viewer) {
        setTuzis(result.balance);
      }
    } catch (error) {
      next = classifyChatRequestFailure(error);
    }
    const nextCopy = chatRequestCopy(next);
    if (nextCopy.retry !== "same-attempt") attempt.current = null;
    if (next.kind === "insufficient" && next.balance !== null) {
      setTuzis(next.balance);
    } else if (
      next.kind === "uncertain" ||
      next.kind === "mismatch" ||
      next.kind === "refused"
    ) {
      // The local balance may now be wrong in either direction. Ask the
      // server; a failed refresh keeps the session as it is.
      void refreshSession();
    }
    setOutcome(next);
    setSending(false);
  }

  function startOver() {
    attempt.current = null;
    setOutcome(null);
    void loadPrice();
  }

  function closeSheet(next: boolean) {
    if (sending && !next) return;
    setOpen(next);
    if (!next && shown?.kind === "self") setRefusedSelf(true);
  }

  // A paid introduction is never bought twice in one session. With a handle,
  // "Message again" goes straight to e2e2z; without one, it reopens the honest
  // status instead of a link that cannot work.
  const messageAgain = started
    ? () => {
        if (started.recipient.handleStatus === "bound") void openChat(started);
        else openSheet();
      }
    : null;

  const values = {
    username,
    cost:
      shown?.kind === "started"
        ? formatTuzis(shown.result.charged)
        : formatTuzis(attempt.current?.cost ?? cost ?? 0),
    charged: shown?.kind === "started" ? formatTuzis(shown.result.charged) : "",
    balance: formatTuzis(
      shown?.kind === "insufficient" && shown.balance !== null
        ? shown.balance
        : balance,
    ),
  };

  const footerButton = WRAPPING_BUTTON;

  return (
    <>
      {messageAgain ? (
        <Button
          ref={trigger}
          variant="secondary"
          onClick={messageAgain}
          aria-label={t(MESSAGE_KEYS.creatorChatAgainAccessible, { username })}
          data-creator-chat="again"
        >
          <MessageSquareLock className="h-4 w-4" aria-hidden />
          {t(MESSAGE_KEYS.creatorChatAgain)}
        </Button>
      ) : (
        <Button
          ref={trigger}
          variant="outline"
          onClick={openSheet}
          aria-haspopup="dialog"
          aria-label={t(MESSAGE_KEYS.creatorChatTriggerAccessible, {
            username,
          })}
          data-creator-chat="start"
        >
          <MessageSquareLock className="h-4 w-4" aria-hidden />
          {t(MESSAGE_KEYS.creatorChatTrigger)}
        </Button>
      )}

      <Dialog open={open} onOpenChange={closeSheet}>
        <DialogContent
          data-creator-chat-sheet={copy?.id ?? (sending ? "sending" : "confirm")}
          onCloseAutoFocus={(event) => {
            // The sheet has no Radix trigger (its opener changes after a
            // success), so return focus to whichever button is there now.
            event.preventDefault();
            trigger.current?.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (sending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (sending) event.preventDefault();
          }}
        >
          {shown && copy ? (
            <>
              <DialogHeader role="status" aria-live="polite">
                <DialogTitle className="pe-6">
                  {t(copy.titleKey, values)}
                </DialogTitle>
                <DialogDescription>{t(copy.bodyKey, values)}</DialogDescription>
              </DialogHeader>

              {shown.kind === "started" &&
              shown.result.recipient.handleStatus === "bound" ? (
                <p className="text-xs text-muted-foreground">
                  {t(MESSAGE_KEYS.creatorChatInstallHint)}
                </p>
              ) : null}

              <DialogFooter>
                <OutcomeActions
                  outcome={shown}
                  retry={copy.retry}
                  sending={sending}
                  primaryRef={primaryAction}
                  className={footerButton}
                  onOpen={openChat}
                  onGet={getE2e2z}
                  onBuy={buyTuzis}
                  onSignIn={signInToChat}
                  onRetrySame={() => void start()}
                  onStartOver={startOver}
                  onDone={() => closeSheet(false)}
                />
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="pe-6">
                  {t(MESSAGE_KEYS.creatorChatConfirmTitle, { username })}
                </DialogTitle>
                <DialogDescription>
                  {cost !== null
                    ? t(MESSAGE_KEYS.creatorChatConfirmBody, values)
                    : price.status === "error"
                      ? t(MESSAGE_KEYS.creatorChatConfirmPriceError)
                      : t(MESSAGE_KEYS.creatorChatConfirmPriceLoading)}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="text-sm text-muted-foreground">
                    {t(MESSAGE_KEYS.creatorChatConfirmCostLabel)}
                  </span>
                  <span
                    className="text-xl font-bold bidi-number tabular-nums"
                    data-creator-chat-cost
                  >
                    {cost !== null ? (
                      formatTuzis(cost)
                    ) : price.status === "loading" ? (
                      <Loader2
                        className="h-5 w-5 animate-spin text-muted-foreground"
                        aria-hidden
                      />
                    ) : (
                      "—"
                    )}
                  </span>
                </div>
                {user ? (
                  <p className="text-xs text-muted-foreground bidi-number tabular-nums">
                    {t(MESSAGE_KEYS.creatorChatConfirmBalance, {
                      balance: formatTuzis(balance),
                    })}
                  </p>
                ) : null}
                <p className="flex items-start gap-2 text-xs text-muted-foreground">
                  <LockKeyhole
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary"
                    aria-hidden
                  />
                  <span>
                    {t(MESSAGE_KEYS.creatorChatConfirmNoAutoSend, { username })}
                  </span>
                </p>
              </div>

              <DialogFooter>
                <Button
                  variant="ghost"
                  className={footerButton}
                  onClick={() => closeSheet(false)}
                  disabled={sending}
                >
                  {t(MESSAGE_KEYS.creatorChatActionCancel)}
                </Button>
                {sending ? (
                  <Button className={footerButton} disabled>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    {t(MESSAGE_KEYS.creatorChatActionPaying)}
                  </Button>
                ) : price.status === "error" ? (
                  <Button
                    variant="outline"
                    className={footerButton}
                    onClick={() => void loadPrice()}
                  >
                    {t(MESSAGE_KEYS.creatorChatActionRetryPrice)}
                  </Button>
                ) : gate === "loading" || price.status === "loading" ? (
                  <Button className={footerButton} disabled>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    {gate === "loading"
                      ? t(MESSAGE_KEYS.creatorChatActionChecking)
                      : t(MESSAGE_KEYS.creatorChatConfirmPriceLoading)}
                  </Button>
                ) : gate === "sign-in" ? (
                  <Button className={footerButton} onClick={signInToChat}>
                    {t(MESSAGE_KEYS.creatorChatActionSignIn)}
                  </Button>
                ) : gate === "low-balance" ? (
                  <Button
                    variant="outline"
                    className={footerButton}
                    onClick={buyTuzis}
                  >
                    {t(MESSAGE_KEYS.creatorChatActionLowBalance)}
                    <ArrowRight
                      className="rtl:-scale-x-100 h-4 w-4"
                      aria-hidden
                    />
                  </Button>
                ) : (
                  <Button className={footerButton} onClick={() => void start()}>
                    {t(MESSAGE_KEYS.creatorChatActionPay, {
                      cost: formatTuzis(cost ?? 0),
                    })}
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function OutcomeActions({
  outcome,
  retry,
  sending,
  primaryRef,
  className,
  onOpen,
  onGet,
  onBuy,
  onSignIn,
  onRetrySame,
  onStartOver,
  onDone,
}: {
  outcome: ChatRequestOutcome;
  retry: "same-attempt" | "new-attempt" | null;
  sending: boolean;
  primaryRef: RefObject<HTMLButtonElement>;
  className: string;
  onOpen: (result: ChatRequestResult) => Promise<void>;
  onGet: () => Promise<void>;
  onBuy: () => void;
  onSignIn: () => void;
  onRetrySame: () => void;
  onStartOver: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const done = (
    <Button
      variant="ghost"
      className={className}
      onClick={onDone}
      disabled={sending}
    >
      {t(MESSAGE_KEYS.creatorChatActionDone)}
    </Button>
  );
  const getApp = (
    <Button
      variant="outline"
      className={className}
      onClick={() => void onGet()}
    >
      <Download className="h-4 w-4" aria-hidden />
      {t(MESSAGE_KEYS.creatorChatActionGet)}
    </Button>
  );

  if (outcome.kind === "started") {
    if (outcome.result.recipient.handleStatus === "bound") {
      const result = outcome.result;
      return (
        <>
          {getApp}
          <Button
            ref={primaryRef}
            className={className}
            onClick={() => void onOpen(result)}
            data-creator-chat-open
          >
            <MessageSquareLock className="h-4 w-4" aria-hidden />
            {t(MESSAGE_KEYS.creatorChatActionOpen)}
          </Button>
        </>
      );
    }
    return (
      <>
        {getApp}
        <Button ref={primaryRef} className={className} onClick={onDone}>
          {t(MESSAGE_KEYS.creatorChatActionDone)}
        </Button>
      </>
    );
  }

  if (outcome.kind === "insufficient") {
    return (
      <>
        {done}
        <Button ref={primaryRef} className={className} onClick={onBuy}>
          {t(MESSAGE_KEYS.creatorChatActionBuy)}
          <ArrowRight className="rtl:-scale-x-100 h-4 w-4" aria-hidden />
        </Button>
      </>
    );
  }

  if (outcome.kind === "signed-out") {
    return (
      <>
        {done}
        <Button ref={primaryRef} className={className} onClick={onSignIn}>
          {t(MESSAGE_KEYS.creatorChatActionSignIn)}
        </Button>
      </>
    );
  }

  if (retry !== null) {
    return (
      <>
        {done}
        <Button
          ref={primaryRef}
          className={className}
          onClick={retry === "same-attempt" ? onRetrySame : onStartOver}
          disabled={sending}
        >
          {sending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              {t(MESSAGE_KEYS.creatorChatActionPaying)}
            </>
          ) : (
            t(MESSAGE_KEYS.creatorChatActionTryAgain)
          )}
        </Button>
      </>
    );
  }

  return (
    <Button ref={primaryRef} className={className} onClick={onDone}>
      {t(MESSAGE_KEYS.creatorChatActionDone)}
    </Button>
  );
}
