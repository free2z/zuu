import { useTranslation as useUiTranslation } from "react-i18next";
import { translate } from "@/i18n/translate";
import { MESSAGE_KEYS } from "@/i18n/messages";
// Zcash Wallet — flagship wallet UI. Mounted at /wallet/*.
import { useEffect } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
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
  {
    to: "/wallet",
    get label() {
      return translate(MESSAGE_KEYS.featuresWalletIndexOverview);
    },
    icon: LayoutDashboard,
    end: true,
  },
  {
    to: "/wallet/send",
    get label() {
      return translate(MESSAGE_KEYS.featuresWalletIndexSend);
    },
    icon: ArrowUpRight,
  },
  {
    to: "/wallet/receive",
    get label() {
      return translate(MESSAGE_KEYS.featuresWalletIndexReceive);
    },
    icon: ArrowDownToLine,
  },
  {
    to: "/wallet/history",
    get label() {
      return translate(MESSAGE_KEYS.featuresWalletIndexHistory);
    },
    icon: ListOrdered,
  },
  {
    to: "/wallet/fund",
    get label() {
      return translate(MESSAGE_KEYS.featuresWalletIndexFund);
    },
    icon: Coins,
  },
];

function WalletNav() {
  const { t: uiT } = useUiTranslation();

  return (
    <nav
      className="mb-6 grid w-full grid-cols-2 gap-1 rounded-lg bg-muted/60 p-1 sm:inline-flex sm:w-auto sm:items-center"
      aria-label={uiT(MESSAGE_KEYS.featuresWalletIndexWalletSections)}
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
  const { t: uiT } = useUiTranslation();

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
      aria-label={uiT(MESSAGE_KEYS.featuresWalletIndexWalletCleanupStatus)}
    >
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-warning">
            {cleanup.blockedOperations > 0
              ? uiT(
                  MESSAGE_KEYS.featuresWalletIndexWalletMaintenanceNeedsAttention,
                )
              : cleanup.pendingOperations > 0
                ? uiT(
                    MESSAGE_KEYS.featuresWalletIndexWalletMaintenanceNeedsAnotherPass,
                  )
                : uiT(
                    MESSAGE_KEYS.featuresWalletIndexWalletMaintenanceCompletedWithARecoveryNote,
                  )}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {cleanup.blockedOperations > 0
              ? uiT(MESSAGE_KEYS.maintenanceNote)
              : cleanup.pendingOperations > 0
                ? uiT(MESSAGE_KEYS.maintenanceRemaining, {
                    operations: cleanup.pendingOperations,
                    stages: cleanup.pendingStages,
                  })
                : uiT(MESSAGE_KEYS.maintenanceNote)}
          </p>
          {cleanup.diagnostics.length > 0 && cleanup.pendingOperations > 0 && (
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="min-tap inline-flex cursor-pointer items-center">
                {uiT(MESSAGE_KEYS.featuresWalletIndexTechnicalDetails)}
              </summary>
              <ul className="mt-1 list-disc space-y-1 ps-5">
                {cleanup.diagnostics.map((_, index) => (
                  <li key={index}>{uiT(MESSAGE_KEYS.maintenanceNote)}</li>
                ))}
              </ul>
            </details>
          )}
          {retryError && (
            <p className="mt-2 text-sm text-destructive">
              {uiT(MESSAGE_KEYS.errorRequest)}
            </p>
          )}
        </div>
        {(cleanup.pendingOperations > 0 || cleanup.blockedOperations > 0) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={retrying}
            onClick={() => void retryCleanup()}
          >
            <RefreshCw
              className={cn("h-4 w-4", retrying && "animate-spin")}
              aria-hidden
            />
            {retrying
              ? uiT(MESSAGE_KEYS.featuresWalletIndexRetrying)
              : uiT(MESSAGE_KEYS.featuresWalletIndexRetryNow)}
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
  const { t: uiT } = useUiTranslation();

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
        <PageHeader
          title={uiT(MESSAGE_KEYS.featuresWalletIndexWallet)}
          description={uiT(
            MESSAGE_KEYS.featuresWalletIndexYourZcashShieldedByDefault,
          )}
        />
        <Skeleton className="mb-6 h-10 w-72 rounded-lg" />
        <div className="grid gap-6 lg:grid-cols-3">
          <Skeleton className="h-64 rounded-xl lg:col-span-2" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </div>
    );
  }

  // No wallet yet → create/restore flow (no sub-nav).
  if (!isFunding && (!status || !status.initialized || status.backupRequired)) {
    return <Onboarding />;
  }

  const title =
    SECTION_TITLES[location.pathname] ??
    uiT(MESSAGE_KEYS.featuresWalletIndexWallet);

  return (
    <div>
      {!isFunding ? (
        <>
          <PageHeader title={title.heading} description={title.description} />
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

const SECTION_TITLES: Record<string, { heading: string; description: string }> =
  {
    "/wallet": {
      get heading() {
        return translate(MESSAGE_KEYS.featuresWalletIndexWallet);
      },
      get description() {
        return translate(
          MESSAGE_KEYS.featuresWalletIndexYourZcashShieldedByDefault,
        );
      },
    },
    "/wallet/send": {
      get heading() {
        return translate(MESSAGE_KEYS.featuresWalletIndexSend);
      },
      get description() {
        return translate(
          MESSAGE_KEYS.featuresWalletIndexSendShieldedZECWithAnOptionalEncrypted,
        );
      },
    },
    "/wallet/send/creator-tip": {
      get heading() {
        return translate(MESSAGE_KEYS.featuresWalletIndexTipWithZEC);
      },
      get description() {
        return translate(
          MESSAGE_KEYS.featuresWalletIndexReviewACreatorPaymentThroughWalletSend,
        );
      },
    },
    "/wallet/receive": {
      get heading() {
        return translate(MESSAGE_KEYS.featuresWalletIndexReceive);
      },
      get description() {
        return translate(
          MESSAGE_KEYS.featuresWalletIndexShareYourUnifiedAddressToGetPaid,
        );
      },
    },
    "/wallet/history": {
      get heading() {
        return translate(MESSAGE_KEYS.featuresWalletIndexHistory);
      },
      get description() {
        return translate(
          MESSAGE_KEYS.featuresWalletIndexEveryPaymentInAndOutOfThis,
        );
      },
    },
    "/wallet/fund": {
      get heading() {
        return translate(MESSAGE_KEYS.featuresWalletIndexFund);
      },
      get description() {
        return translate(
          MESSAGE_KEYS.featuresWalletIndexAdd2ZsForTipsAIAndMemberships,
        );
      },
    },
  };
