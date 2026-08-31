// Zcash Wallet — flagship wallet UI. Mounted at /wallet/*.
import { useEffect } from "react";
import {
  NavLink,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Coins,
  LayoutDashboard,
  ListOrdered,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/common/PageHeader";
import { Skeleton } from "@/components/ui/skeleton";
import { Callout } from "@/components/ui/callout";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/store/wallet";
import { cn } from "@/lib/utils";
import { Overview } from "./Overview";
import { Send } from "./Send";
import { Receive } from "./Receive";
import { History } from "./History";
import { Onboarding } from "./Onboarding";
import FundingFeature from "./funding";

const NAV: { to: string; label: string; icon: LucideIcon; end?: boolean }[] = [
  { to: "/wallet", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/wallet/send", label: "Send", icon: ArrowUpRight },
  { to: "/wallet/receive", label: "Receive", icon: ArrowDownToLine },
  { to: "/wallet/history", label: "History", icon: ListOrdered },
  { to: "/wallet/fund", label: "Fund", icon: Coins },
];

function WalletNav() {
  return (
    <nav
      className="mb-6 grid w-full grid-cols-2 gap-1 rounded-lg bg-muted/60 p-1 sm:inline-flex sm:w-auto sm:items-center"
      aria-label="Wallet sections"
    >
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            cn(
              "min-tap inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isActive
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )
          }
        >
          <Icon className="h-4 w-4" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

function CleanupNotice() {
  const cleanup = useWallet((state) => state.status?.cleanup);
  const retrying = useWallet((state) => state.cleanupRetrying);
  const retryError = useWallet((state) => state.cleanupError);
  const retryCleanup = useWallet((state) => state.retryCleanup);

  if (
    !cleanup ||
    (cleanup.pendingOperations === 0 &&
      cleanup.blockedOperations === 0 &&
      cleanup.diagnostics.length === 0)
  ) {
    return null;
  }

  return (
    <Callout
      className="mb-6"
      icon={TriangleAlert}
      aria-label="Wallet cleanup status"
    >
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-warning">
            {cleanup.blockedOperations > 0
              ? "Wallet maintenance needs attention"
              : cleanup.pendingOperations > 0
                ? "Wallet maintenance needs another pass"
                : "Wallet maintenance completed with a recovery note"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {cleanup.blockedOperations > 0
              ? cleanup.diagnostics[0]
              : cleanup.pendingOperations > 0
              ? `${cleanup.pendingOperations} operation${cleanup.pendingOperations === 1 ? "" : "s"} and ${cleanup.pendingStages} stage${cleanup.pendingStages === 1 ? "" : "s"} remain safely journaled.`
              : cleanup.diagnostics[0]}
          </p>
          {cleanup.diagnostics.length > 0 && cleanup.pendingOperations > 0 && (
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="min-tap inline-flex cursor-pointer items-center">Technical details</summary>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {cleanup.diagnostics.map((diagnostic) => (
                  <li key={diagnostic}>{diagnostic}</li>
                ))}
              </ul>
            </details>
          )}
          {retryError && <p className="mt-2 text-sm text-destructive">{retryError}</p>}
        </div>
        {(cleanup.pendingOperations > 0 || cleanup.blockedOperations > 0) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={retrying}
            onClick={() => void retryCleanup()}
          >
            <RefreshCw className={cn("h-4 w-4", retrying && "animate-spin")} aria-hidden />
            {retrying ? "Retrying" : "Retry now"}
          </Button>
        )}
      </div>
    </Callout>
  );
}

export function isWalletFundingPath(pathname: string): boolean {
  return pathname === "/wallet/fund" || pathname.startsWith("/wallet/fund/");
}

export default function WalletFeature() {
  const status = useWallet((s) => s.status);
  const loading = useWallet((s) => s.loading);
  const bootstrap = useWallet((s) => s.bootstrap);
  const location = useLocation();
  const isFunding = isWalletFundingPath(location.pathname);

  // Ensure data is loaded even if we land here before the app-level bootstrap.
  useEffect(() => {
    if (!status) void bootstrap();
  }, [status, bootstrap]);

  // Initial load: skeleton chrome.
  if (!isFunding && loading && !status) {
    return (
      <div>
        <PageHeader title="Wallet" description="Your Zcash, shielded by default." />
        <Skeleton className="mb-6 h-10 w-72 rounded-lg" />
        <div className="grid gap-6 lg:grid-cols-3">
          <Skeleton className="h-64 rounded-xl lg:col-span-2" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </div>
    );
  }

  // No wallet yet → create/restore flow (no sub-nav).
  if (
    !isFunding &&
    (!status || !status.initialized || status.backupRequired)
  ) {
    return <Onboarding />;
  }

  const title = SECTION_TITLES[location.pathname] ?? "Wallet";

  return (
    <div>
      {!isFunding ? (
        <>
          <PageHeader
            title={title.heading}
            description={title.description}
          />
          <CleanupNotice />
        </>
      ) : null}
      <WalletNav />
      <Routes>
        <Route index element={<Overview />} />
        <Route path="send" element={<Send />} />
        <Route path="send/creator-tip" element={<Send creatorTipRoute />} />
        <Route path="receive" element={<Receive />} />
        <Route path="history" element={<History />} />
        <Route path="fund/*" element={<FundingFeature />} />
        <Route path="*" element={<Overview />} />
      </Routes>
    </div>
  );
}

const SECTION_TITLES: Record<
  string,
  { heading: string; description: string }
> = {
  "/wallet": { heading: "Wallet", description: "Your Zcash, shielded by default." },
  "/wallet/send": {
    heading: "Send",
    description: "Send shielded ZEC with an optional encrypted memo.",
  },
  "/wallet/send/creator-tip": {
    heading: "Tip with ZEC",
    description: "Review a creator payment through Wallet Send.",
  },
  "/wallet/receive": {
    heading: "Receive",
    description: "Share your unified address to get paid privately.",
  },
  "/wallet/history": {
    heading: "History",
    description: "Every payment in and out of this wallet.",
  },
  "/wallet/fund": {
    heading: "Fund",
    description: "Add 2Zs for tips, AI, and memberships.",
  },
};
