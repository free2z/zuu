import { Outlet, useLocation } from "react-router-dom";
import { Sidebar, MobileTabBar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TriangleAlert } from "lucide-react";
import { useWallet } from "@/store/wallet";

function LegacyWalletNotice() {
  const legacy = useWallet((state) => state.status?.legacyAppData);
  if (legacy?.state !== "importPending") return null;

  return (
    <section
      role="status"
      aria-label="Preserved legacy wallet"
      className="border-b border-amber-500/35 bg-amber-500/10 px-4 py-3 md:px-8"
    >
      <div className="mx-auto flex w-full max-w-6xl items-start gap-3">
        <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden />
        <div>
          <p className="text-sm font-medium text-foreground">Earlier wallet preserved</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {legacy.diagnostic ??
              "An earlier ZUULI wallet remains safely preserved. This app opened only the current wallet; explicit import is pending."}
          </p>
        </div>
      </div>
    </section>
  );
}

export function AppShell() {
  const location = useLocation();
  // The AI chat needs a bounded-height panel with its own internal scroll
  // region (message list) and a footer pinned to the true bottom — Radix's
  // ScrollArea wraps children in a `display: table` div that sizes to
  // content, so a `h-full` flex column nested inside it can never resolve a
  // real height. Give that route a plain, height-bound `main` instead of the
  // page-scrolling ScrollArea every other route uses.
  const isFullBleed = location.pathname.startsWith("/ai");

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <LegacyWalletNotice />
        {isFullBleed ? (
          <main className="min-h-0 flex-1 overflow-hidden">
            <Outlet />
          </main>
        ) : (
          <ScrollArea className="flex-1">
            <main className="mx-auto w-full max-w-6xl px-4 pb-24 pt-6 md:px-8 md:pb-10">
              <Outlet />
            </main>
          </ScrollArea>
        )}
      </div>
      <MobileTabBar />
    </div>
  );
}
