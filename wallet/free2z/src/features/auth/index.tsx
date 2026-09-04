// free2z — Login.
//
// A viewport-bound auth page mounted inside the persistent app shell.
//
// ZUULI leads with Login with Zcash, because ZUULI holds the key that signs the
// challenge. This surface holds none: it links no `tauri-plugin-zcash` and
// carries no `zcash:*` capability, so the whole method is absent here rather
// than stubbed behind a button that cannot work. Password and linked accounts
// are the two methods that ship, and the Zcash path is stated plainly instead
// of being hidden — see `ZcashLoginPending` below and #904/#905.

import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowLeft, ArrowUpRight, KeyRound, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Wordmark } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SocialButtons } from "@/components/common/SocialButtons";
import { useRouteScroll } from "@/hooks/useRouteScroll";
import { BrandPanel } from "./BrandPanel";
import { ClassicLoginForm } from "./ClassicLoginForm";
import {
  loginDestinationFromState,
  type LoginDestination,
} from "@/lib/auth/login-destination";
import { discardPaidIntent } from "@/lib/auth/paid-intent";
import { useSession } from "@/store/session";
import { MESSAGE_KEYS } from "@/i18n/messages";

export type AuthMethod = "chooser" | "password";

export default function AuthFeature() {
  const location = useLocation();
  const { registerViewport } = useRouteScroll();
  const loginDestination = loginDestinationFromState(location.state);
  const [method, setMethod] = useState<AuthMethod>("chooser");
  const abandonedIntentTimer = useRef<number | null>(null);

  // ZUULI's login route also calls `useWallet().bootstrap()` here, because its
  // Zcash method needs a loaded wallet before it can sign. Nothing on this
  // surface can sign, so nothing is bootstrapped.

  useEffect(() => {
    const clearAbandonedFullPageLogin = () => {
      if (!useSession.getState().user) discardPaidIntent();
    };

    // sessionStorage survives reloads and same-tab full-page departures. A
    // pagehide listener closes that privacy boundary; social auth uses the
    // app's popup/native-loopback transport, so its login page stays mounted.
    window.addEventListener("pagehide", clearAbandonedFullPageLogin);

    // React StrictMode replays effects in development. Cancel the first
    // cleanup on the replayed setup, but clear after a real SPA departure when
    // no login flow committed a user. This prevents one guest's private draft
    // from being restored into a later account in the same tab.
    if (abandonedIntentTimer.current !== null) {
      window.clearTimeout(abandonedIntentTimer.current);
      abandonedIntentTimer.current = null;
    }
    return () => {
      window.removeEventListener("pagehide", clearAbandonedFullPageLogin);
      abandonedIntentTimer.current = window.setTimeout(() => {
        if (!useSession.getState().user) discardPaidIntent();
      }, 0);
    };
  }, []);

  return (
    <div
      ref={registerViewport}
      className="grid h-full min-h-0 w-full grid-cols-1 overflow-y-auto bg-background lg:grid-cols-2"
      data-route-scroll
    >
      <BrandPanel />

      <main className="app-auth-content relative flex min-h-full flex-col items-center justify-start p-4 sm:p-10">
        {/* Auto block margins center the stack only when it fits. Unlike
            justify-center, they collapse to zero when the stack is taller
            than the bounded scroller, so its top can always be reached. */}
        <div className="app-auth-stack my-auto flex w-full max-w-md flex-col">
          {/* Compact wordmark for small screens where the brand panel is hidden */}
          <div className="mb-4 lg:hidden">
            <Wordmark />
          </div>

          <div className="w-full animate-slide-up">
            {method === "chooser" ? (
              <AuthChooser
                loginDestination={loginDestination}
                onSelect={setMethod}
              />
            ) : (
              <SelectedAuthMethod
                loginDestination={loginDestination}
                method={method}
                onBack={() => setMethod("chooser")}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

/**
 * Why Login with Zcash is not offered here.
 *
 * Signing a login challenge is an attestation, not a spend — which is exactly
 * why it looks like the easy first grant to bridge. It is not. Of the three
 * cross-surface grants in #904, `sign-challenge` is the WEAKEST family for
 * native confirmation: a tip names an amount and a recipient a human can read
 * and check, while a challenge is an opaque nonce that confirms nothing to the
 * person approving it. It is deliberately not the first thing wired, and no
 * transport ships before #461.
 */
export function ZcashLoginPending() {
  const { t } = useTranslation();
  return (
    <Callout
      tone="info"
      icon={ShieldCheck}
      title={t(MESSAGE_KEYS.authZcashPendingTitle)}
      data-auth-zcash-pending
    >
      {t(MESSAGE_KEYS.authZcashPendingBody)}
    </Callout>
  );
}

export function AuthChooser({
  loginDestination = "/",
  onSelect,
}: {
  loginDestination?: LoginDestination;
  onSelect: (method: Exclude<AuthMethod, "chooser">) => void;
}) {
  return (
    <Card
      className="border-border/80 bg-card/70 backdrop-blur"
      data-auth-chooser
    >
      <CardHeader className="px-5 pb-3 pt-4">
        <CardTitle className="text-2xl">
          <h1>Log in</h1>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 px-5 pb-4 pt-0">
        <Button
          type="button"
          size="lg"
          className="w-full justify-center"
          onClick={() => onSelect("password")}
        >
          <KeyRound aria-hidden />
          Password
        </Button>

        {/* Configured providers are additional methods. The empty state adds
            no decision and no translation surface, so it stays invisible. */}
        <SocialButtons emptyState={null} loginDestination={loginDestination} />

        <ZcashLoginPending />

        <div className="flex min-h-11 items-center justify-end">
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="min-tap text-muted-foreground"
          >
            <Link to="/" aria-label="Continue as guest">
              Guest
              <ArrowUpRight className="rtl:-scale-x-100" aria-hidden />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function SelectedAuthMethod({
  loginDestination = "/",
  method,
  onBack,
}: {
  loginDestination?: LoginDestination;
  method: Exclude<AuthMethod, "chooser">;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Card
      className="border-border/80 bg-card/70 backdrop-blur"
      data-auth-selected={method}
    >
      <CardHeader className="flex-row items-center gap-3 space-y-0 px-5 pb-3 pt-4">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="min-tap h-11 w-11 shrink-0"
              onClick={onBack}
              disabled={busy}
              aria-label="Choose another login method"
            >
              <ArrowLeft className="rtl:-scale-x-100" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Choose another method</TooltipContent>
        </Tooltip>
        <CardTitle className="text-xl">
          <h1>Password</h1>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-5 pb-4 pt-0">
        <ClassicLoginForm
          loginDestination={loginDestination}
          onBusyChange={setBusy}
        />
      </CardContent>
    </Card>
  );
}
