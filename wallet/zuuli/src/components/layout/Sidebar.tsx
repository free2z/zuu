import { NavLink } from "react-router-dom";
import {
  Home,
  Wallet,
  Sparkles,
  Radio,
  BookOpen,
  Coins,
} from "lucide-react";
import { Wordmark } from "@/components/brand/Logo";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Discover", icon: Home, end: true },
  { to: "/live", label: "Livestreams", icon: Radio },
  { to: "/ai", label: "AI", icon: Sparkles },
  { to: "/articles", label: "Articles", icon: BookOpen },
  { to: "/wallet", label: "Wallet", icon: Wallet },
  { to: "/buy", label: "Buy & Send 2Z", icon: Coins },
];

export function Sidebar() {
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card/40 md:flex">
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
                "min-tap flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
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
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-card/95 backdrop-blur md:hidden">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            cn(
              "flex flex-1 flex-col items-center gap-1 py-2 text-[10px]",
              isActive ? "text-primary" : "text-muted-foreground",
            )
          }
        >
          <Icon className="h-5 w-5" />
          {label.split(" ")[0]}
        </NavLink>
      ))}
    </nav>
  );
}
