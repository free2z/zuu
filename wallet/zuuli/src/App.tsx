import { lazy, Suspense, useEffect, useRef } from "react";
import {
  BrowserRouter,
  Navigate,
  Routes,
  Route,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { AppShell } from "@/components/layout/AppShell";
import { NotFound } from "@/components/common/NotFound";
import { useSession } from "@/store/session";
import { useWallet } from "@/store/wallet";
import { auth, tuzi } from "@/lib/api/free2z";
import { setToken } from "@/lib/api/http";
import { useAttemptLease } from "@/hooks/useAttemptLease";
import { recoverMobileOAuth } from "@/lib/oauth/transport";
import {
  clearPendingSocialLoginDestination,
  consumePendingSocialLoginDestination,
} from "@/lib/auth/login-destination";
import {
  listenForCheckoutReturns,
  recoverCheckoutReturn,
} from "@/lib/checkout/native-return";

import AuthFeature from "@/features/auth";

// Feature routes are code-split so the heavy markdown/math/prism graph they
// transitively pull in (rehype-mathjax, rehype-prism-plus) never lands in the
// login/critical-path entry chunk. The login screen (AuthFeature), the AppShell
// layout, and the router stay eager so /login renders instantly inside the
// same viewport-bound chrome as every other route.
const HomeFeature = lazy(() => import("@/features/home"));
const WalletFeature = lazy(() => import("@/features/wallet"));
const AiFeature = lazy(() => import("@/features/ai"));
const LiveFeature = lazy(() => import("@/features/live"));
const ArticlesFeature = lazy(() => import("@/features/articles"));
const SearchFeature = lazy(() => import("@/features/search"));
const CreatorFeature = lazy(() => import("@/features/creator"));
const ProfileFeature = lazy(() => import("@/features/profile"));
const KycFeature = lazy(() => import("@/features/kyc"));

function RouteFallback() {
  return (
    <div
      className="flex min-h-[40vh] w-full items-center justify-center"
      role="status"
      aria-label="Loading"
    >
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
    </div>
  );
}

/** Keep old links/bookmarks working while funding now lives inside Wallet. */
function LegacyBuyRedirect() {
  const { search, hash } = useLocation();
  return <Navigate replace to={`/wallet/fund${search}${hash}`} />;
}

/** Finish a mobile OAuth callback that cold-started or resumed the app. */
function MobileOAuthRecovery() {
  const navigate = useNavigate();
  const setUser = useSession((state) => state.setUser);
  const sessionLoading = useSession((state) => state.loading);
  const started = useRef(false);
  const attempt = useAttemptLease();

  useEffect(() => {
    // The pending record is bound to the Knox session that initiated it.
    // Wait until bootstrap has validated/cleared that token before recovery.
    if (sessionLoading) return;
    // React StrictMode deliberately reruns effects in development. The native
    // state is one-shot too, but this guard avoids two backend exchanges.
    if (started.current) return;
    started.current = true;
    const isCurrent = attempt.begin();
    void recoverMobileOAuth()
      .then(async (capture) => {
        if (!isCurrent() || !capture) return;
        const result = await auth.completeSocialOAuth(capture);
        if (!isCurrent()) return;
        if (result.status === "authenticated") {
          setToken(result.session.token);
          setUser(result.session.user);
        } else {
          setUser(result.user);
        }
        toast.success(capture.associate ? "Account linked" : "Welcome to ZUULI", {
          description: `Finished ${capture.provider} sign-in after returning to the app.`,
        });
        if (!capture.associate) {
          navigate(consumePendingSocialLoginDestination(), { replace: true });
        } else {
          clearPendingSocialLoginDestination();
        }
      })
      .catch((error) => {
        if (!isCurrent()) return;
        clearPendingSocialLoginDestination();
        toast.error("Couldn't finish sign-in", {
          description: error instanceof Error ? error.message : "Please try again.",
        });
      });
  }, [attempt, navigate, sessionLoading, setUser]);

  return null;
}

/** Handle exact native Checkout links on both cold and warm app returns. */
function MobileCheckoutRecovery() {
  const navigate = useNavigate();
  const refreshSession = useSession((state) => state.refresh);
  const sessionLoading = useSession((state) => state.loading);
  const started = useRef(false);

  useEffect(() => {
    if (sessionLoading || started.current) return;
    started.current = true;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listenForCheckoutReturns(async (code) => {
      try {
        const result = await recoverCheckoutReturn(code, {
          claim: tuzi.claimCheckoutReturn,
          status: tuzi.checkoutReturnStatus,
          refreshSession,
          navigateToBuy: () => navigate("/wallet/fund", { replace: true }),
        });
        if (result.status === "cancelled") {
          toast.info("Checkout cancelled", {
            description: "No payment success was recorded.",
          });
        } else if (result.status === "credited") {
          toast.success("2Z added", {
            description: `${result.tuzisCredited.toLocaleString()} 2Z confirmed by Free2Z.`,
          });
        } else {
          toast.info("Payment processing", {
            description:
              "Your balance updates after Stripe's verified confirmation.",
          });
        }
      } catch (error) {
        navigate("/wallet/fund", { replace: true });
        await refreshSession();
        toast.error("Couldn't verify checkout return", {
          description:
            error instanceof Error ? error.message : "Refresh and try again.",
        });
      }
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch((error) => {
        toast.error("Checkout return unavailable", {
          description:
            error instanceof Error
              ? error.message
              : "Restart ZUULI and try again.",
        });
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [navigate, refreshSession, sessionLoading]);

  return null;
}

export default function App() {
  const bootstrapSession = useSession((s) => s.bootstrap);
  const bootstrapWallet = useWallet((s) => s.bootstrap);

  useEffect(() => {
    void bootstrapSession();
    void bootstrapWallet();
  }, [bootstrapSession, bootstrapWallet]);

  return (
    <TooltipProvider delayDuration={200}>
      <BrowserRouter>
        <MobileOAuthRecovery />
        <MobileCheckoutRecovery />
        <Routes>
          {/* Every route lives inside the viewport-bound shell. A single Suspense boundary
              per route keeps the AppShell mounted while the lazy chunk loads. */}
          <Route element={<AppShell />}>
            <Route path="/login" element={<AuthFeature />} />
            <Route
              index
              element={
                <Suspense fallback={<RouteFallback />}>
                  <HomeFeature />
                </Suspense>
              }
            />
            <Route
              path="/search/*"
              element={
                <Suspense fallback={<RouteFallback />}>
                  <SearchFeature />
                </Suspense>
              }
            />
            <Route
              path="/creator/:username/*"
              element={
                <Suspense fallback={<RouteFallback />}>
                  <CreatorFeature />
                </Suspense>
              }
            />
            <Route
              path="/profile"
              element={
                <Suspense fallback={<RouteFallback />}>
                  <ProfileFeature />
                </Suspense>
              }
            />
            <Route
              path="/kyc/*"
              element={
                <Suspense fallback={<RouteFallback />}>
                  <KycFeature />
                </Suspense>
              }
            />
            <Route
              path="/wallet/*"
              element={
                <Suspense fallback={<RouteFallback />}>
                  <WalletFeature />
                </Suspense>
              }
            />
            <Route
              path="/ai/*"
              element={
                <Suspense fallback={<RouteFallback />}>
                  <AiFeature />
                </Suspense>
              }
            />
            <Route
              path="/live/*"
              element={
                <Suspense fallback={<RouteFallback />}>
                  <LiveFeature />
                </Suspense>
              }
            />
            <Route
              path="/articles/*"
              element={
                <Suspense fallback={<RouteFallback />}>
                  <ArticlesFeature />
                </Suspense>
              }
            />
            <Route
              path="/buy/*"
              element={<LegacyBuyRedirect />}
            />

            {/* Catch-all: unknown paths render a NotFound inside the shell */}
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
      <Toaster />
    </TooltipProvider>
  );
}
