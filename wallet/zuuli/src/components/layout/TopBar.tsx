import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Coins,
  Plus,
  Wallet as WalletIcon,
  LogOut,
  User,
  UserCog,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSession } from "@/store/session";
import { useWallet } from "@/store/wallet";
import { formatTuzis, formatZecTrim, initials } from "@/lib/format";

export function TopBar() {
  const { user, tuzis, logout } = useSession();
  const balance = useWallet((s) => s.balance);
  const navigate = useNavigate();
  const [q, setQ] = useState("");

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur">
      {/* Global search */}
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const term = q.trim();
          navigate(term ? `/search?q=${encodeURIComponent(term)}` : "/search");
        }}
        className="relative hidden max-w-sm flex-1 sm:block"
      >
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search creators and pages…"
          aria-label="Search creators and pages"
          className="h-9 w-full rounded-full border border-border bg-card/60 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring"
        />
      </form>

      {/* Search icon (mobile) */}
      <Link
        to="/search"
        className="min-tap grid place-items-center rounded-full text-muted-foreground transition-colors hover:text-foreground sm:hidden"
        aria-label="Search"
      >
        <Search className="h-5 w-5" />
      </Link>

      <div className="flex-1" />

      {/* ZEC wallet chip */}
      <Link
        to="/wallet"
        className="hidden items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1.5 text-sm transition-colors hover:bg-secondary sm:flex"
        aria-label="Open wallet"
      >
        <WalletIcon className="h-4 w-4 text-[#f4b728]" />
        <span className="font-medium tabular-nums">
          {balance ? formatZecTrim(balance.spendable) : "0.00"}
        </span>
        <span className="text-xs text-muted-foreground">ZEC</span>
      </Link>

      {/* 2Z balance chip */}
      <Link
        to="/buy"
        className="flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-sm transition-colors hover:bg-primary/20"
        aria-label="Buy 2Zs"
      >
        <Coins className="h-4 w-4 text-primary" />
        <span className="font-semibold tabular-nums">{formatTuzis(tuzis)}</span>
        <Plus className="h-3.5 w-3.5 text-primary" />
      </Link>

      {user ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="min-tap rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Account menu"
            >
              <Avatar className="h-9 w-9 border border-border">
                {user.image ? <AvatarImage src={user.image} /> : null}
                <AvatarFallback className="bg-primary/20 text-primary">
                  {initials(user.display_name || user.username)}
                </AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <div className="font-medium text-foreground">
                {user.display_name || user.username}
              </div>
              <div className="text-xs text-muted-foreground">
                @{user.username}
                {user.zcashLinked ? " · Zcash login" : ""}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate("/profile")}>
              <UserCog /> Edit profile
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/wallet")}>
              <WalletIcon /> Wallet
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/buy")}>
              <Coins /> Buy 2Zs
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => logout()}>
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button size="sm" onClick={() => navigate("/login")}>
          <User className="h-4 w-4" /> Login with Zcash
        </Button>
      )}
    </header>
  );
}

export function LiveTuziBadge({ tuzis }: { tuzis: number }) {
  return <Badge variant="zec">{formatTuzis(tuzis)}</Badge>;
}
