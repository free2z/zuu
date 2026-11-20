import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ExternalLink, RefreshCw } from "lucide-react";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { useMock } from "@/lib/platform";
import { Button } from "@/components/ui/button";
import { BidiIdentifier } from "@/components/common/BidiIdentifier";
import { openAccountBilling, refreshBillingBalance } from "@/lib/account-billing";
import { useSession } from "@/store/session";
import { useAttemptLease } from "@/hooks/useAttemptLease";

export function AccountBilling() {
  const navigate = useNavigate();
  const user = useSession((s) => s.user);
  const loading = useSession((s) => s.loading);
  const [opening, setOpening] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState("");
  const [openError, setOpenError] = useState("");
  const openingRef = useRef(false);
  const reading = useRef<AbortController | null>(null);
  const openAttempt = useAttemptLease();
  const readAttempt = useAttemptLease();

  const checkBalance = useCallback(async () => {
    // Focus + visibility + a quick second tap must share one read.
    if (useMock() || reading.current || !useSession.getState().user) return;
    const controller = new AbortController();
    reading.current = controller;
    const current = readAttempt.begin();
    setChecking(true);
    setMessage("");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        refreshBillingBalance(controller.signal),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error("Balance check timed out."));
          }, 15_000);
        }),
      ]);
      if (current()) {
        setMessage("Account balance refreshed. Pending payments may still be processing.");
      }
    } catch {
      if (current()) {
        setMessage(
          "Couldn't refresh your account balance. Your last known balance is shown. " +
          "Check your connection and login, then retry. A balance check never sends a payment.",
        );
      }
    } finally {
      clearTimeout(timeout);
      if (reading.current === controller) reading.current = null;
      if (current()) setChecking(false);
    }
  }, [readAttempt]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkBalance();
    };
    window.addEventListener("focus", checkBalance);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", checkBalance);
      document.removeEventListener("visibilitychange", onVisible);
      reading.current?.abort();
    };
  }, [checkBalance]);

  async function openBilling() {
    if (!useSession.getState().user) {
      navigate("/login", { state: { returnTo: "/wallet/fund" } });
      return;
    }
    if (openingRef.current) return;
    openingRef.current = true;
    const current = openAttempt.begin();
    setOpening(true);
    setOpenError("");
    try {
      await openAccountBilling();
      // Opening a browser is not payment evidence. Do not report success.
    } catch {
      if (current()) {
        setOpenError(
          "Couldn't open Free2Z billing. Allow external links and try again. " +
          "If you already sent ZEC, check your balance and original transaction before sending again.",
        );
      }
    } finally {
      openingRef.current = false;
      if (current()) setOpening(false);
    }
  }

  if (useMock()) {
    return (
      <Callout title="Live account billing unavailable">
        This runtime uses mock data. No payment can be made or verified here.
      </Callout>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Get 2Z on Free2Z</CardTitle>
        <CardDescription>Buy usage credits on your Free2Z account page. Zcash first, card second.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {user && (
          <p className="break-words text-sm">
            In your browser, sign in as <BidiIdentifier value={user.username} className="break-all" /> to fund this account.
            Your browser may be signed in to a different account.
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          Free2Z shows the shielded address, required account memo and current estimated amount.
          Estimates do not lock a rate or reserve credits. Stale pricing or unavailable funding must be resolved there before sending.
        </p>
        <Button onClick={openBilling} disabled={loading || opening}>
          <ExternalLink className="h-4 w-4" aria-hidden />
          {user ? "Open Free2Z billing" : "Log in to get 2Z"}
        </Button>
        {openError && <Callout role="alert" tone="destructive">{openError}</Callout>}
        <p className="text-sm text-muted-foreground">
          After confirmations, Free2Z credits the ZEC actually received at the processing rate.
          Returning here does not confirm a payment. If you already sent ZEC, keep the original transaction and receipt references;
          do not send again because confirmation or credit is delayed.
        </p>
        {user && (
          <Button variant="outline" onClick={checkBalance} disabled={checking}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            {checking ? "Checking account balance…" : "Refresh account balance"}
          </Button>
        )}
        <p role="status" className="text-sm text-muted-foreground">{message}</p>
      </CardContent>
    </Card>
  );
}
