import { type MouseEvent } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Wordmark } from "@/components/brand/Logo";
import { cn } from "@/lib/utils";
import { useSession } from "@/store/session";
import {
  desktopNavigation,
  isNavigationRouteActive,
  mobileNavigation,
  NAVIGATION_GROUP_LABEL_KEYS,
  NAVIGATION_GROUP_ORDER,
  type NavigationRoute,
} from "./navigation";
import { useRouteScroll } from "@/hooks/useRouteScroll";
import { MESSAGE_KEYS } from "@/i18n/messages";

const desktopLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "min-tap flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    isActive
      ? "bg-primary/15 text-primary"
      : "text-muted-foreground hover:bg-secondary hover:text-foreground",
  );

function useActiveRouteRetap(item: NavigationRoute) {
  const location = useLocation();
  const { scrollToTop } = useRouteScroll();

  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !isNavigationRouteActive(item, location.pathname) ||
      location.pathname !== item.to
    ) {
      return;
    }
    event.preventDefault();
    scrollToTop();
  };
}

function DesktopRoute({ item }: { item: NavigationRoute }) {
  const { t } = useTranslation();
  const onClick = useActiveRouteRetap(item);
  const Icon = item.icon;

  return (
    <NavLink
      to={item.to}
      end={item.end}
      aria-label={t(item.accessibleLabelKey)}
      className={desktopLinkClass}
      onClick={onClick}
    >
      <Icon className="h-[18px] w-[18px]" aria-hidden />
      <span className="min-w-0 break-words [overflow-wrap:anywhere]" aria-hidden>
        {t(item.labelKey)}
      </span>
    </NavLink>
  );
}

export function Sidebar() {
  const { t } = useTranslation();
  const signedIn = useSession((state) => Boolean(state.user));
  const routes = desktopNavigation(signedIn);

  return (
    <aside className="app-sidebar hidden w-60 shrink-0 flex-col border-e border-border bg-card/40 md:flex">
      <div className="shrink-0 px-5 py-5">
        <Wordmark />
      </div>
      <nav
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3"
        aria-label={t(MESSAGE_KEYS.navApp)}
      >
        {NAVIGATION_GROUP_ORDER.map((group) => {
          const groupRoutes = routes
            .filter((item) => item.desktop?.group === group)
            .sort(
              (left, right) =>
                (left.desktop?.order ?? 0) - (right.desktop?.order ?? 0),
            );
          if (groupRoutes.length === 0) return null;

          return (
            <section key={group} aria-labelledby={`nav-group-${group}`}>
              <h2
                id={`nav-group-${group}`}
                className="mb-1 px-3 eyebrow text-muted-foreground"
              >
                {t(NAVIGATION_GROUP_LABEL_KEYS[group])}
              </h2>
              <div className="flex flex-col gap-1">
                {groupRoutes.map((item) => (
                  <DesktopRoute key={item.to} item={item} />
                ))}
              </div>
            </section>
          );
        })}
      </nav>
    </aside>
  );
}

function MobileRoute({ item }: { item: NavigationRoute }) {
  const { t } = useTranslation();
  const onClick = useActiveRouteRetap(item);

  return (
    <NavLink
      to={item.to}
      end={item.end}
      aria-label={t(item.accessibleLabelKey)}
      data-navigation-id={item.id}
      onClick={onClick}
      className={({ isActive }) =>
        cn(
          "min-tap flex min-w-0 flex-col items-center justify-center gap-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isActive ? "text-primary" : "text-muted-foreground",
        )
      }
    >
      <item.icon className="h-5 w-5" aria-hidden />
      <span
        className="max-w-full whitespace-nowrap px-0.5 leading-none"
        aria-hidden
      >
        {t(item.labelKey)}
      </span>
    </NavLink>
  );
}

/**
 * The narrow/mobile destinations.
 *
 * ZUULI needs a "More" sheet because it carries nine destinations. This surface
 * carries three, so every one of them is reachable in a single tap and the
 * sheet — along with the ambiguity of a hidden destination — is simply absent.
 * The columns are derived rather than fixed so the bar stays even when the
 * signed-out "Log in" entry swaps for "Buy 2Zs".
 */
export function MobileTabBar() {
  const { t } = useTranslation();
  const signedIn = useSession((state) => Boolean(state.user));
  const items = mobileNavigation(signedIn);

  return (
    <nav
      className="app-bottom-nav fixed inset-x-0 bottom-0 z-40 grid grid-flow-col auto-cols-fr border-t border-border bg-card/95 backdrop-blur md:hidden"
      aria-label={t(MESSAGE_KEYS.navPrimary)}
      data-app-bottom-nav
    >
      {items.map((item) => (
        <MobileRoute key={item.id} item={item} />
      ))}
    </nav>
  );
}
