import { Outlet, useLocation } from "react-router-dom";
import { Sidebar, MobileTabBar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useRouteScroll } from "@/hooks/useRouteScroll";
import { RouteScrollProvider } from "./route-scroll";

/**
 * ZUULI's shell also renders `LegacyWalletNotice`, which reads `store/wallet`.
 * There is no such store on this surface and there must not be one: free2z
 * holds no seed and no spending key (#904).
 */
function AppShellContent() {
  const location = useLocation();
  const { registerViewport } = useRouteScroll();
  // Login owns a bounded internal scroll region while the header and mobile
  // tabs stay pinned. Keep that route in a plain, height-bound main instead of
  // nesting its scroll owner inside the generic page ScrollArea.
  const isFullBleed = location.pathname === "/login";

  return (
    <div className="app-viewport flex bg-background" data-app-frame>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        {isFullBleed ? (
          <main className="min-h-0 flex-1 overflow-hidden" data-route-frame>
            <Outlet />
          </main>
        ) : (
          <ScrollArea
            className="min-h-0 min-w-0 max-w-full flex-1"
            data-route-scroll
            viewportRef={registerViewport}
          >
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

export function AppShell() {
  return (
    <RouteScrollProvider>
      <AppShellContent />
    </RouteScrollProvider>
  );
}
