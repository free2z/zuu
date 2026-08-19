import { NavLink } from "react-router-dom";
import {
  Home,
  Wallet,
  Sparkles,
  Radio,
  BookOpen,
  Coins,
  Search,
} from "lucide-react";
import { Wordmark } from "@/components/brand/Logo";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Discover", mobileLabel: "Home", icon: Home, end: true },
  { to: "/search", label: "Search", mobileLabel: "Search", icon: Search },
  { to: "/live", label: "Livestreams", mobileLabel: "Live", icon: Radio },
  { to: "/ai", label: "AI", mobileLabel: "AI", icon: Sparkles },
  { to: "/articles", label: "Articles", mobileLabel: "Read", icon: BookOpen },
  { to: "/wallet", label: "Wallet", mobileLabel: "Wallet", icon: Wallet },
  { to: "/buy", label: "Buy & Send 2Z", mobileLabel: "Buy", icon: Coins },
];

export function Sidebar() {
  return (
    <aside className="app-sidebar hidden w-60 shrink-0 flex-col border-r border-border bg-card/40 md:flex">
      <div className="px-5 py-5">
        <Wordmark />
      </div>
      <nav className="flex flex-1 flex-col gap-1 px-3">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                "min-tap flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isActive
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              )
            }
          >
            <Icon className="h-[18px] w-[18px]" />
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="px-5 py-4 text-[11px] leading-relaxed text-muted-foreground">
        Shielded by default.
        <br />
        Powered by free2z.
      </div>
    </aside>
  );
}

/** Bottom tab bar for narrow / mobile widths. */
export function MobileTabBar() {
  // Equal zero-minimum tracks prevent a long translated/desktop label from
  // stealing width from neighboring targets. Compact visible labels keep all
  // seven real hit boxes above 44px at a 320px viewport.
  return (
    <nav
      className="app-bottom-nav fixed inset-x-0 bottom-0 z-40 grid grid-cols-7 border-t border-border bg-card/95 backdrop-blur md:hidden"
      data-app-bottom-nav
    >
      {NAV.map(({ to, label, mobileLabel, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          aria-label={label}
          className={({ isActive }) =>
            cn(
              "min-tap flex min-w-0 flex-col items-center justify-center gap-1 text-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              isActive ? "text-primary" : "text-muted-foreground",
            )
          }
        >
          <Icon className="h-5 w-5" aria-hidden />
          <span className="max-w-full truncate px-0.5" aria-hidden>
            {mobileLabel}
          </span>
        </NavLink>
      ))}
    </nav>
  );
}
