import { useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { AppShell } from "@/components/layout/AppShell";
import { NotFound } from "@/components/common/NotFound";
import { useSession } from "@/store/session";
import { useWallet } from "@/store/wallet";

import HomeFeature from "@/features/home";
import WalletFeature from "@/features/wallet";
import AiFeature from "@/features/ai";
import LiveFeature from "@/features/live";
import ArticlesFeature from "@/features/articles";
import BuyFeature from "@/features/buy";
import AuthFeature from "@/features/auth";
import SearchFeature from "@/features/search";
import CreatorFeature from "@/features/creator";
import ProfileFeature from "@/features/profile";

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
          {/* Full-screen auth, outside the app shell */}
          <Route path="/login" element={<AuthFeature />} />

          {/* Everything else lives inside the shell */}
          <Route element={<AppShell />}>
            <Route index element={<HomeFeature />} />
            <Route path="/search/*" element={<SearchFeature />} />
            <Route path="/creator/:username/*" element={<CreatorFeature />} />
            <Route path="/profile" element={<ProfileFeature />} />
            <Route path="/wallet/*" element={<WalletFeature />} />
            <Route path="/ai/*" element={<AiFeature />} />
            <Route path="/live/*" element={<LiveFeature />} />
            <Route path="/articles/*" element={<ArticlesFeature />} />
            <Route path="/buy/*" element={<BuyFeature />} />

            {/* Catch-all: unknown paths render a NotFound inside the shell */}
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
      <Toaster />
    </TooltipProvider>
  );
}
