import { lazy, Suspense, useEffect, useRef } from "react";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
  Routes,
  Route,
  useNavigate,
} from "react-router-dom";
import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { AppShell } from "@/components/layout/AppShell";
import { NotFound } from "@/components/common/NotFound";
import { RouteFallback } from "@/components/common/RouteFallback";
import { useSession } from "@/store/session";
import { auth } from "@/lib/api/free2z";
import { setToken } from "@/lib/api/http";
import { APP_ROUTES } from "@/lib/routes";
import { useAttemptLease } from "@/hooks/useAttemptLease";
import {
  assertOAuthResultCurrent,
  recoverMobileOAuth,
} from "@/lib/oauth/transport";
import {
  clearPendingSocialLoginDestination,
  consumePendingSocialLoginDestination,
} from "@/lib/auth/login-destination";

import AuthFeature from "@/features/auth";

// Feature routes are code-split so the heavy markdown/math/prism/mermaid graph
// they transitively pull in never lands in the login/critical-path entry chunk.
// The login screen (AuthFeature), the AppShell layout, and the router stay
// eager so /login renders instantly inside the same viewport-bound chrome as
// every other route.
const ArticlesFeature = lazy(() => import("@/features/articles"));
const CreatorFeature = lazy(() => import("@/features/creator"));
const FundFeature = lazy(() => import("@/features/fund"));

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
        assertOAuthResultCurrent(result.sessionGeneration);
        if (result.status === "authenticated") {
          setToken(result.session.token);
          setUser(result.session.user);
        } else {
          setUser(result.user);
        }
        toast.success(capture.associate ? "Account linked" : "Welcome to free2z", {
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

function AppRoutes() {
  return (
    <>
      <MobileOAuthRecovery />
      <Routes>
        {/* Every route lives inside the viewport-bound shell. A single Suspense boundary
            per route keeps the AppShell mounted while the lazy chunk loads. */}
        <Route element={<AppShell />}>
          <Route path={APP_ROUTES.login} element={<AuthFeature />} />
          {/* Articles is this surface's front door; ZUULI's Discover home is
              not one of the five content features being extracted. */}
          <Route index element={<Navigate replace to="/articles" />} />
          <Route
            path={APP_ROUTES.articles}
            element={
              <Suspense fallback={<RouteFallback />}>
                <ArticlesFeature />
              </Suspense>
            }
          />
          <Route
            path={APP_ROUTES.creator}
            element={
              <Suspense fallback={<RouteFallback />}>
                <CreatorFeature />
              </Suspense>
            }
          />
          <Route
            path={APP_ROUTES.fund}
            element={
              <Suspense fallback={<RouteFallback />}>
                <FundFeature />
              </Suspense>
            }
          />

          {/* Catch-all: unknown paths render a NotFound inside the shell */}
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </>
  );
}

// A data router gives long-form editors a first-class blocker for every SPA
// transition, including browser POP gestures and imperative `navigate` calls.
// The existing route tree remains nested below a single catch-all root.
const appRouter = createBrowserRouter([{ path: "*", element: <AppRoutes /> }]);

/**
 * ZUULI's App also calls `useWallet().bootstrap()` unconditionally on mount.
 * This one bootstraps a session and nothing else — there is no wallet store on
 * this surface, by design (#904).
 */
export default function App() {
  const bootstrapSession = useSession((s) => s.bootstrap);

  useEffect(() => {
    void bootstrapSession();
  }, [bootstrapSession]);

  return (
    <TooltipProvider delayDuration={200}>
      <RouterProvider router={appRouter} />
      <Toaster />
    </TooltipProvider>
  );
}
