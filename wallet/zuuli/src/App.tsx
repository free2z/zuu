import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { AppShell } from "@/components/layout/AppShell";
import { NotFound } from "@/components/common/NotFound";
import { useSession } from "@/store/session";
import { useWallet } from "@/store/wallet";

import AuthFeature from "@/features/auth";

// Feature routes are code-split so the heavy markdown/math/prism graph they
// transitively pull in (rehype-mathjax, rehype-prism-plus) never lands in the
// login/critical-path entry chunk. The login screen (AuthFeature), the AppShell
// layout, and the router stay eager so /login renders instantly.
const HomeFeature = lazy(() => import("@/features/home"));
const WalletFeature = lazy(() => import("@/features/wallet"));
const AiFeature = lazy(() => import("@/features/ai"));
const LiveFeature = lazy(() => import("@/features/live"));
const ArticlesFeature = lazy(() => import("@/features/articles"));
const BuyFeature = lazy(() => import("@/features/buy"));
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
        <Routes>
          {/* Full-screen auth, outside the app shell — kept eager so /login is instant */}
          <Route path="/login" element={<AuthFeature />} />

          {/* Everything else lives inside the shell. A single Suspense boundary
              per route keeps the AppShell mounted while the lazy chunk loads. */}
          <Route element={<AppShell />}>
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
              element={
                <Suspense fallback={<RouteFallback />}>
                  <BuyFeature />
                </Suspense>
              }
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
