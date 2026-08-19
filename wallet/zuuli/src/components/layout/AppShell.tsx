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
  // AI and login each own a bounded internal scroll region while the header
  // and mobile tabs stay pinned. Keep those routes in a plain, height-bound
  // main instead of nesting their scroll owners inside the generic page
  // ScrollArea used by every other route.
  const isFullBleed =
    location.pathname.startsWith("/ai") || location.pathname === "/login";

  return (
    <div className="app-viewport flex bg-background" data-app-frame>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <LegacyWalletNotice />
        {isFullBleed ? (
          <main className="min-h-0 flex-1 overflow-hidden" data-route-frame>
            <Outlet />
          </main>
        ) : (
          <ScrollArea className="min-h-0 min-w-0 max-w-full flex-1" data-route-scroll>
            <main className="app-scroll-content mx-auto w-full min-w-0 max-w-6xl px-4 pt-6 md:px-8">
              <Outlet />
            </main>
          </ScrollArea>
        )}
      </div>
      <MobileTabBar />
    </div>
  );
}
