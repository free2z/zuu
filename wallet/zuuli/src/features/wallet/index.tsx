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
  LayoutDashboard,
  ListOrdered,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/common/PageHeader";
import { Skeleton } from "@/components/ui/skeleton";
import { useWallet } from "@/store/wallet";
import { cn } from "@/lib/utils";
import { Overview } from "./Overview";
import { Send } from "./Send";
import { Receive } from "./Receive";
import { History } from "./History";
import { Onboarding } from "./Onboarding";

const NAV: { to: string; label: string; icon: LucideIcon; end?: boolean }[] = [
  { to: "/wallet", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/wallet/send", label: "Send", icon: ArrowUpRight },
  { to: "/wallet/receive", label: "Receive", icon: ArrowDownToLine },
  { to: "/wallet/history", label: "History", icon: ListOrdered },
];

function WalletNav() {
  return (
    <nav
      className="mb-6 inline-flex items-center gap-1 rounded-lg bg-muted/60 p-1"
      aria-label="Wallet sections"
    >
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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

export default function WalletFeature() {
  const status = useWallet((s) => s.status);
  const loading = useWallet((s) => s.loading);
  const bootstrap = useWallet((s) => s.bootstrap);
  const location = useLocation();

  // Ensure data is loaded even if we land here before the app-level bootstrap.
  useEffect(() => {
    if (!status) void bootstrap();
  }, [status, bootstrap]);

  // Initial load: skeleton chrome.
  if (loading && !status) {
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
  if (status && !status.initialized) {
    return <Onboarding />;
  }

  const title = SECTION_TITLES[location.pathname] ?? "Wallet";

  return (
    <div>
      <PageHeader
        title={title.heading}
        description={title.description}
      />
      <WalletNav />
      <Routes>
        <Route index element={<Overview />} />
        <Route path="send" element={<Send />} />
        <Route path="receive" element={<Receive />} />
        <Route path="history" element={<History />} />
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
  "/wallet/receive": {
    heading: "Receive",
    description: "Share your unified address to get paid privately.",
  },
  "/wallet/history": {
    heading: "History",
    description: "Every payment in and out of this wallet.",
  },
};
