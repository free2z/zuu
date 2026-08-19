import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Home,
  LogIn,
  Menu,
  Radio,
  ShieldCheck,
  Sparkles,
  UserCog,
  Wallet,
} from "lucide-react";

export type NavigationAuth = "always" | "signed-in" | "signed-out";
export type NavigationGroup = "explore" | "tools" | "money" | "account";

type DesktopPlacement = {
  group: NavigationGroup;
  order: number;
};

type MobilePlacement =
  | { area: "primary"; label: string; order: number }
  | { area: "more"; order: number };

type NavigationBase = {
  accessibleLabel: string;
  auth: NavigationAuth;
  desktop: DesktopPlacement | null;
  icon: LucideIcon;
  id: string;
  label: string;
  mobile: MobilePlacement;
};

export type NavigationRoute = NavigationBase & {
  activePrefixes?: readonly string[];
  end?: boolean;
  kind: "route";
  to: string;
};

export type NavigationMenu = NavigationBase & {
  kind: "menu";
};

export type NavigationItem = NavigationRoute | NavigationMenu;

/**
 * The single placement contract for app navigation. Desktop exposes grouped
 * routes; mobile consumes four stable routes plus the More menu. Search stays
 * in TopBar, and 2Z funding lives inside Wallet rather than as a top-level app
 * destination.
 */
export const NAVIGATION: readonly NavigationItem[] = [
  {
    id: "home",
    kind: "route",
    to: "/",
    label: "Home",
    accessibleLabel: "Home",
    icon: Home,
    end: true,
    auth: "always",
    desktop: { group: "explore", order: 0 },
    mobile: { area: "primary", label: "Home", order: 0 },
  },
  {
    id: "live",
    kind: "route",
    to: "/live",
    label: "Livestreams",
    accessibleLabel: "Livestreams",
    icon: Radio,
    auth: "always",
    desktop: { group: "explore", order: 1 },
    mobile: { area: "primary", label: "Live", order: 1 },
  },
  {
    id: "articles",
    kind: "route",
    to: "/articles",
    label: "Articles",
    accessibleLabel: "Articles",
    icon: BookOpen,
    auth: "always",
    desktop: { group: "explore", order: 2 },
    mobile: { area: "more", order: 0 },
  },
  {
    id: "ai",
    kind: "route",
    to: "/ai",
    label: "AI",
    accessibleLabel: "Artificial intelligence",
    icon: Sparkles,
    auth: "always",
    desktop: { group: "tools", order: 0 },
    mobile: { area: "primary", label: "AI", order: 2 },
  },
  {
    id: "wallet",
    kind: "route",
    to: "/wallet",
    label: "Wallet",
    accessibleLabel: "Zcash wallet",
    icon: Wallet,
    auth: "always",
    desktop: { group: "money", order: 0 },
    mobile: { area: "primary", label: "Wallet", order: 3 },
  },
  {
    id: "profile",
    kind: "route",
    to: "/profile",
    label: "Profile",
    accessibleLabel: "Edit profile",
    icon: UserCog,
    auth: "signed-in",
    desktop: { group: "account", order: 0 },
    mobile: { area: "more", order: 1 },
  },
  {
    id: "revenue-share",
    kind: "route",
    to: "/kyc",
    label: "Revenue share",
    accessibleLabel: "Revenue share",
    icon: ShieldCheck,
    auth: "signed-in",
    desktop: { group: "account", order: 1 },
    mobile: { area: "more", order: 2 },
  },
  {
    id: "sign-in",
    kind: "route",
    to: "/login",
    label: "Log in",
    accessibleLabel: "Log in",
    icon: LogIn,
    auth: "signed-out",
    desktop: { group: "account", order: 0 },
    mobile: { area: "more", order: 1 },
  },
  {
    id: "more",
    kind: "menu",
    label: "More",
    accessibleLabel: "More navigation",
    icon: Menu,
    auth: "always",
    desktop: null,
    mobile: { area: "primary", label: "More", order: 4 },
  },
];

export const NAVIGATION_GROUP_LABELS: Record<NavigationGroup, string> = {
  explore: "Explore",
  tools: "Tools",
  money: "Money",
  account: "Account",
};

export const NAVIGATION_GROUP_ORDER: readonly NavigationGroup[] = [
  "explore",
  "tools",
  "money",
  "account",
];

export function isNavigationVisible(item: NavigationItem, signedIn: boolean) {
  return (
    item.auth === "always" ||
    (item.auth === "signed-in" && signedIn) ||
    (item.auth === "signed-out" && !signedIn)
  );
}

export function isNavigationRouteActive(
  item: NavigationRoute,
  pathname: string,
) {
  const prefixes = item.activePrefixes ?? [item.to];
  return prefixes.some((prefix) =>
    item.end || prefix === "/"
      ? pathname === prefix
      : pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function desktopNavigation(signedIn: boolean) {
  return NAVIGATION.filter(
    (item): item is NavigationRoute =>
      item.kind === "route" &&
      item.desktop !== null &&
      isNavigationVisible(item, signedIn),
  );
}

export function mobilePrimaryNavigation() {
  return NAVIGATION.filter(
    (item) => item.mobile.area === "primary",
  ).sort((left, right) => left.mobile.order - right.mobile.order);
}

export function mobileMoreNavigation(signedIn: boolean) {
  return NAVIGATION.filter(
    (item): item is NavigationRoute =>
      item.kind === "route" &&
      item.mobile.area === "more" &&
      isNavigationVisible(item, signedIn),
  ).sort((left, right) => left.mobile.order - right.mobile.order);
}
