import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Home,
  Info,
  LogIn,
  Menu,
  MessagesSquare,
  Radio,
  ShieldCheck,
  Sparkles,
  UserCog,
  Wallet,
} from "lucide-react";
import { MESSAGE_KEYS, type MessageKey } from "@/i18n/messages";

export type NavigationAuth = "always" | "signed-in" | "signed-out";
export type NavigationGroup = "explore" | "tools" | "money" | "account";

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
    labelKey: MESSAGE_KEYS.navHome,
    accessibleLabelKey: MESSAGE_KEYS.navHome,
    icon: Home,
    end: true,
    auth: "always",
    desktop: { group: "explore", order: 0 },
    mobile: { area: "primary", labelKey: MESSAGE_KEYS.navHome, order: 0 },
  },
  {
    id: "live",
    kind: "route",
    to: "/live",
    labelKey: MESSAGE_KEYS.navLive,
    accessibleLabelKey: MESSAGE_KEYS.navLive,
    icon: Radio,
    auth: "always",
    desktop: { group: "explore", order: 1 },
    mobile: { area: "primary", labelKey: MESSAGE_KEYS.navLiveShort, order: 1 },
  },
  {
    id: "articles",
    kind: "route",
    to: "/articles",
    labelKey: MESSAGE_KEYS.navArticles,
    accessibleLabelKey: MESSAGE_KEYS.navArticles,
    icon: BookOpen,
    auth: "always",
    desktop: { group: "explore", order: 2 },
    mobile: { area: "more", order: 0 },
  },
  {
    id: "ai",
    kind: "route",
    to: "/ai",
    labelKey: MESSAGE_KEYS.navAi,
    accessibleLabelKey: MESSAGE_KEYS.navAiAccessible,
    icon: Sparkles,
    auth: "always",
    desktop: { group: "tools", order: 0 },
    mobile: { area: "primary", labelKey: MESSAGE_KEYS.navAi, order: 2 },
  },
  {
    id: "messages",
    kind: "route",
    to: "/messages",
    labelKey: MESSAGE_KEYS.navMessages,
    accessibleLabelKey: MESSAGE_KEYS.navMessagesAccessible,
    icon: MessagesSquare,
    auth: "signed-in",
    desktop: { group: "tools", order: 1 },
    // Mobile's primary area is full; promoting messaging means demoting
    // something else, which is a product decision this does not make.
    mobile: { area: "more", order: 0 },
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
    mobile: { area: "primary", labelKey: MESSAGE_KEYS.navWallet, order: 3 },
  },
  {
    id: "profile",
    kind: "route",
    to: "/profile",
    labelKey: MESSAGE_KEYS.navProfile,
    accessibleLabelKey: MESSAGE_KEYS.navProfileAccessible,
    icon: UserCog,
    auth: "signed-in",
    desktop: { group: "account", order: 0 },
    mobile: { area: "more", order: 1 },
  },
  {
    id: "revenue-share",
    kind: "route",
    to: "/kyc",
    labelKey: MESSAGE_KEYS.navRevenueShare,
    accessibleLabelKey: MESSAGE_KEYS.navRevenueShare,
    icon: ShieldCheck,
    auth: "signed-in",
    desktop: { group: "account", order: 1 },
    mobile: { area: "more", order: 2 },
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
    mobile: { area: "more", order: 3 },
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
    mobile: { area: "more", order: 1 },
  },
  {
    id: "more",
    kind: "menu",
    labelKey: MESSAGE_KEYS.navMore,
    accessibleLabelKey: MESSAGE_KEYS.navMoreAccessible,
    icon: Menu,
    auth: "always",
    desktop: null,
    mobile: { area: "primary", labelKey: MESSAGE_KEYS.navMore, order: 4 },
  },
];

export const NAVIGATION_GROUP_LABEL_KEYS: Record<NavigationGroup, MessageKey> = {
  explore: MESSAGE_KEYS.navGroupExplore,
  tools: MESSAGE_KEYS.navGroupTools,
  money: MESSAGE_KEYS.navGroupMoney,
  account: MESSAGE_KEYS.navGroupAccount,
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
