import type { LucideIcon } from "lucide-react";
import { Home, Info, LogIn, Menu, Wallet } from "lucide-react";
import { MESSAGE_KEYS, type MessageKey } from "@/i18n/messages";

export type NavigationAuth = "always" | "signed-in" | "signed-out";
export type NavigationGroup = "overview" | "money" | "account";

type DesktopPlacement = {
  group: NavigationGroup;
  order: number;
};

type MobilePlacement =
  | { area: "primary"; labelKey: MessageKey; order: number }
  | { area: "more"; order: number };

type NavigationBase = {
  accessibleLabelKey: MessageKey;
  auth: NavigationAuth;
  desktop: DesktopPlacement | null;
  icon: LucideIcon;
  id: string;
  labelKey: MessageKey;
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
 * The single placement contract for app navigation.
 *
 * ZUULI is the wallet authority (#904): the content destinations — Live,
 * Articles, AI, Search, Profile and Revenue share — moved to `wallet/free2z`,
 * so they are absent here *and* their routes no longer exist. A nav entry
 * pointing at a route this app no longer mounts is a NotFound the type system
 * cannot see, so the two are deleted together. What remains is the vault
 * itself: the overview, the wallet, and the app's own About page. 2Z funding
 * stays inside Wallet rather than as a top-level destination.
 */
export const NAVIGATION: readonly NavigationItem[] = [
  {
    id: "home",
    kind: "route",
    to: "/",
    labelKey: MESSAGE_KEYS.navHome,
    accessibleLabelKey: MESSAGE_KEYS.navHome,
    icon: Home,
    end: true,
    auth: "always",
    desktop: { group: "overview", order: 0 },
    mobile: { area: "primary", labelKey: MESSAGE_KEYS.navHome, order: 0 },
  },
  {
    id: "wallet",
    kind: "route",
    to: "/wallet",
    labelKey: MESSAGE_KEYS.navWallet,
    accessibleLabelKey: MESSAGE_KEYS.navWalletAccessible,
    icon: Wallet,
    auth: "always",
    desktop: { group: "money", order: 0 },
    mobile: { area: "primary", labelKey: MESSAGE_KEYS.navWallet, order: 1 },
  },
  {
    id: "about",
    kind: "route",
    to: "/about",
    labelKey: MESSAGE_KEYS.navAbout,
    accessibleLabelKey: MESSAGE_KEYS.navAboutAccessible,
    icon: Info,
    auth: "always",
    desktop: { group: "account", order: 2 },
    mobile: { area: "more", order: 1 },
  },
  {
    id: "sign-in",
    kind: "route",
    to: "/login",
    labelKey: MESSAGE_KEYS.navLogin,
    accessibleLabelKey: MESSAGE_KEYS.navLogin,
    icon: LogIn,
    auth: "signed-out",
    desktop: { group: "account", order: 0 },
    mobile: { area: "more", order: 0 },
  },
  {
    id: "more",
    kind: "menu",
    labelKey: MESSAGE_KEYS.navMore,
    accessibleLabelKey: MESSAGE_KEYS.navMoreAccessible,
    icon: Menu,
    auth: "always",
    desktop: null,
    mobile: { area: "primary", labelKey: MESSAGE_KEYS.navMore, order: 2 },
  },
];

export const NAVIGATION_GROUP_LABEL_KEYS: Record<NavigationGroup, MessageKey> = {
  overview: MESSAGE_KEYS.navGroupOverview,
  money: MESSAGE_KEYS.navGroupMoney,
  account: MESSAGE_KEYS.navGroupAccount,
};

export const NAVIGATION_GROUP_ORDER: readonly NavigationGroup[] = [
  "overview",
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
