import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Coins,
  LogIn,
  Plus,
  Wallet as WalletIcon,
  LogOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
import { MESSAGE_KEYS } from "@/i18n/messages";

export function TopBar() {
  const { t } = useTranslation();
  const { user, tuzis, logout } = useSession();
  const balance = useWallet((s) => s.balance);
  const navigate = useNavigate();
  const location = useLocation();

  // This is an app, not a browser — surface a persistent back affordance so
  // fans can retreat from any screen. React Router stamps a monotonic `idx`
  // onto `window.history.state` for every in-app entry, so `idx > 0` means
  // there is a real prior in-app screen to return to (a fresh load / deep
  // link starts at 0). Reading it during render keyed on `location` keeps it
  // reactive. Hidden on the root/home route, where "back" is meaningless, so
  // it never dead-ends the user out of the app.
  const historyIdx = (window.history.state?.idx as number | undefined) ?? 0;
  const canGoBack = historyIdx > 0 && location.pathname !== "/";

  return (
    <header
      className="app-top-bar sticky top-0 z-30 flex shrink-0 items-center gap-2 border-b border-border bg-background/80 px-3 backdrop-blur sm:gap-3 sm:px-4"
      data-app-top-bar
    >
      {/* Global back — available on every screen inside the shell */}
      {canGoBack ? (
        <Tooltip>
          <TooltipTrigger asChild aria-describedby={undefined}>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => navigate(-1)}
              aria-label={t(MESSAGE_KEYS.navBack)}
              className="min-tap h-9 w-9 shrink-0"
            >
              <ArrowLeft className="rtl:-scale-x-100 h-5 w-5" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t(MESSAGE_KEYS.navBack)}
          </TooltipContent>
        </Tooltip>
      ) : null}

      {/* ZUULI is the wallet authority (#904): it hosts no discovery surface,
          so the TopBar carries no search chrome. Search lives in free2z. */}
      <div className="flex-1" />

      {/* ZEC wallet chip */}
      {user ? (
        <Link
          to="/wallet"
          className="hidden items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1.5 text-sm transition-colors hover:bg-secondary sm:flex"
          aria-label={t(MESSAGE_KEYS.navOpenWallet)}
        >
          <WalletIcon className="h-4 w-4 text-zec" />
          <span className="font-medium bidi-number tabular-nums">
            {balance ? formatZecTrim(balance.spendable) : "—"}
          </span>
          <span className="text-xs text-muted-foreground">ZEC</span>
        </Link>
      ) : null}

      {/* 2Z balance chip */}
      {user ? (
        <Link
          to="/wallet/fund"
          className="flex min-h-11 min-w-0 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 text-sm transition-colors hover:bg-primary/20 sm:gap-2 sm:px-3"
          aria-label={t(MESSAGE_KEYS.navBuyTuzisBalance, {
            balance: formatTuzis(tuzis),
          })}
        >
          <Coins className="h-4 w-4 shrink-0 text-primary" />
          <span className="whitespace-nowrap font-semibold bidi-number tabular-nums">
            {formatTuzis(tuzis)}
          </span>
          <Plus className="hidden h-3.5 w-3.5 shrink-0 text-primary min-[360px]:block" />
        </Link>
      ) : null}

      {user ? (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild aria-describedby={undefined}>
              <DropdownMenuTrigger asChild>
                <button
                  className="min-tap rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={t(MESSAGE_KEYS.navAccountMenu)}
                >
                  {/* Initials only. A remote avatar would be the one image the
                      seed-holding WebView fetches from a host it does not
                      author, and `img-src` no longer admits one (#904). */}
                  <Avatar className="h-9 w-9 border border-border">
                    <AvatarFallback className="bg-primary/20 text-primary">
                      {initials(user.display_name || user.username)}
                    </AvatarFallback>
                  </Avatar>
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t(MESSAGE_KEYS.navAccountMenu)}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <div className="font-medium text-foreground">
                {user.display_name || user.username}
              </div>
              <div className="text-xs text-muted-foreground">
                @{user.username}
                {user.zcashLinked ? ` · ${t(MESSAGE_KEYS.navZcashLogin)}` : ""}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate("/wallet")}>
              <WalletIcon /> {t(MESSAGE_KEYS.navWallet)}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/wallet/fund")}>
              <Coins /> {t(MESSAGE_KEYS.navBuyTuzis)}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => logout()}>
              <LogOut className="rtl:-scale-x-100" /> {t(MESSAGE_KEYS.navSignOut)}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild aria-describedby={undefined}>
            <Button
              variant="ghost"
              size="icon"
              className="min-tap shrink-0 rounded-full"
              onClick={() => navigate("/login")}
              aria-label={t(MESSAGE_KEYS.navLogin)}
            >
              <LogIn className="rtl:-scale-x-100 h-5 w-5" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t(MESSAGE_KEYS.navLogin)}
          </TooltipContent>
        </Tooltip>
      )}
    </header>
  );
}

export function LiveTuziBadge({ tuzis }: { tuzis: number }) {
  return <Badge variant="zec">{formatTuzis(tuzis)}</Badge>;
}
