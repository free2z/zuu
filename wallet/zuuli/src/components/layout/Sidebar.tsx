import { useState, type MouseEvent } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Wordmark } from "@/components/brand/Logo";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useSession } from "@/store/session";
import {
  desktopNavigation,
  isNavigationRouteActive,
  mobileMoreNavigation,
  mobilePrimaryNavigation,
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
    <aside className="app-sidebar hidden w-60 shrink-0 flex-col border-r border-border bg-card/40 md:flex">
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
  const visibleLabel =
    item.mobile.area === "primary"
      ? t(item.mobile.labelKey)
      : t(item.labelKey);

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
        {visibleLabel}
      </span>
    </NavLink>
  );
}

function MobileMoreRoute({
  item,
  onSelect,
}: {
  item: NavigationRoute;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const onRetap = useActiveRouteRetap(item);

  return (
    <NavLink
      to={item.to}
      end={item.end}
      aria-label={t(item.accessibleLabelKey)}
      data-navigation-id={item.id}
      onClick={(event) => {
        onRetap(event);
        onSelect();
      }}
      className={({ isActive }) =>
        cn(
          "min-tap flex min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isActive
            ? "bg-primary/15 text-primary"
            : "text-foreground hover:bg-secondary",
        )
      }
    >
      <item.icon className="h-5 w-5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words [overflow-wrap:anywhere]">
        {t(item.labelKey)}
      </span>
    </NavLink>
  );
}

/** Five stable destinations for narrow/mobile widths. */
export function MobileTabBar() {
  const { t } = useTranslation();
  const signedIn = useSession((state) => Boolean(state.user));
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const primaryItems = mobilePrimaryNavigation();
  const moreItems = mobileMoreNavigation(signedIn);
  const moreIsActive = moreItems.some((item) =>
    isNavigationRouteActive(item, location.pathname),
  );

  return (
    <nav
      className="app-bottom-nav fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-border bg-card/95 backdrop-blur md:hidden"
      aria-label={t(MESSAGE_KEYS.navPrimary)}
      data-app-bottom-nav
    >
      {primaryItems.map((item) => {
        if (item.kind === "route") {
          return <MobileRoute key={item.id} item={item} />;
        }

        const Icon = item.icon;
        return (
          <Dialog key={item.id} open={moreOpen} onOpenChange={setMoreOpen}>
            <DialogTrigger asChild>
              <button
                type="button"
                aria-label={t(item.accessibleLabelKey)}
                aria-current={moreIsActive ? "page" : undefined}
                data-navigation-id={item.id}
                className={cn(
                  "min-tap flex min-w-0 flex-col items-center justify-center gap-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  moreIsActive ? "text-primary" : "text-muted-foreground",
                )}
              >
                <Icon className="h-5 w-5" aria-hidden />
                <span
                  className="max-w-full whitespace-nowrap px-0.5 leading-none"
                  aria-hidden
                >
                  {item.mobile.area === "primary"
                    ? t(item.mobile.labelKey)
                    : t(item.labelKey)}
                </span>
              </button>
            </DialogTrigger>
            <DialogContent
              className="app-mobile-more-dialog bottom-0 left-0 top-auto w-full max-w-none translate-x-0 translate-y-0 gap-2 overflow-y-auto rounded-b-none rounded-t-2xl border-x-0 border-b-0 p-4 data-[state=open]:animate-slide-up sm:bottom-0 sm:left-0 sm:top-auto sm:max-w-none sm:translate-x-0 sm:translate-y-0 sm:rounded-b-none sm:rounded-t-2xl"
              closeClassName="app-mobile-more-close min-tap top-2 grid place-items-center rounded-md"
              data-mobile-more-dialog
            >
              <div className="pr-12">
                <DialogTitle>{t(MESSAGE_KEYS.navMore)}</DialogTitle>
                <DialogDescription className="sr-only">
                  {t(MESSAGE_KEYS.navMoreDescription, {
                    count: moreItems.length,
                  })}
                </DialogDescription>
              </div>
              <nav
                className="mt-2 grid gap-1"
                aria-label={t(MESSAGE_KEYS.navMoreNavigation)}
              >
                {moreItems.map((moreItem) => (
                  <MobileMoreRoute
                    key={moreItem.id}
                    item={moreItem}
                    onSelect={() => setMoreOpen(false)}
                  />
                ))}
              </nav>
            </DialogContent>
          </Dialog>
        );
      })}
    </nav>
  );
}
