import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Coins,
  LogIn,
  Radio,
  Search,
  ShieldCheck,
  Sparkles,
  UserCog,
} from "lucide-react";
import { MESSAGE_KEYS, type MessageKey } from "@/i18n/messages";

export type NavigationAuth = "always" | "signed-in" | "signed-out";
export type NavigationGroup = "explore" | "money" | "account";

type DesktopPlacement = {
  group: NavigationGroup;
  order: number;
};

export type NavigationRoute = {
  accessibleLabelKey: MessageKey;
  activePrefixes?: readonly string[];
  auth: NavigationAuth;
  desktop: DesktopPlacement | null;
  end?: boolean;
  icon: LucideIcon;
  id: string;
  labelKey: MessageKey;
  /** Mobile order, or null for a destination the tab bar does not carry. */
  mobileOrder: number | null;
  to: string;
};

/**
 * The single placement contract for this surface's navigation.
 *
 * free2z holds no spending authority, so there is no wallet destination and no
 * ZEC affordance anywhere in the shell — that separation is the whole point of
 * #904, not a styling choice. `/fund` is a 2Z (fiat) destination; it never
 * touches a Zcash key.
 */
export const NAVIGATION: readonly NavigationRoute[] = [
  {
    id: "articles",
    to: "/articles",
    labelKey: MESSAGE_KEYS.navArticles,
    accessibleLabelKey: MESSAGE_KEYS.navArticles,
    icon: BookOpen,
    auth: "always",
    desktop: { group: "explore", order: 0 },
    mobileOrder: 0,
  },
  {
    id: "search",
    to: "/search",
    labelKey: MESSAGE_KEYS.navSearch,
    accessibleLabelKey: MESSAGE_KEYS.navSearch,
    icon: Search,
    auth: "always",
    desktop: { group: "explore", order: 1 },
    mobileOrder: 1,
  },
  {
    id: "live",
    to: "/live",
    labelKey: MESSAGE_KEYS.navLive,
    accessibleLabelKey: MESSAGE_KEYS.navLive,
    icon: Radio,
    auth: "always",
    desktop: { group: "explore", order: 2 },
    mobileOrder: 2,
  },
  {
    id: "ai",
    to: "/ai",
    labelKey: MESSAGE_KEYS.navAi,
    accessibleLabelKey: MESSAGE_KEYS.navAiAccessible,
    icon: Sparkles,
    auth: "always",
    desktop: { group: "explore", order: 3 },
    mobileOrder: 3,
  },
  {
    id: "fund",
    to: "/fund",
    labelKey: MESSAGE_KEYS.navBuyTuzis,
    accessibleLabelKey: MESSAGE_KEYS.navBuyTuzis,
    icon: Coins,
    auth: "signed-in",
    desktop: { group: "money", order: 0 },
    mobileOrder: 4,
  },
  // Account destinations. Both are signed-in only, so they never render
  // alongside "sign-in" despite sharing the group. Neither carries a mobile tab
  // slot — the bar holds five, and the account menu in TopBar is how a phone
  // reaches these.
  {
    id: "profile",
    to: "/profile",
    labelKey: MESSAGE_KEYS.navProfile,
    accessibleLabelKey: MESSAGE_KEYS.navProfileAccessible,
    icon: UserCog,
    auth: "signed-in",
    desktop: { group: "account", order: 0 },
    mobileOrder: null,
  },
  {
    id: "revenue-share",
    to: "/kyc",
    labelKey: MESSAGE_KEYS.navRevenueShare,
    accessibleLabelKey: MESSAGE_KEYS.navRevenueShare,
    icon: ShieldCheck,
    auth: "signed-in",
    desktop: { group: "account", order: 1 },
    mobileOrder: null,
  },
  {
    id: "sign-in",
    to: "/login",
    labelKey: MESSAGE_KEYS.navLogin,
    accessibleLabelKey: MESSAGE_KEYS.navLogin,
    icon: LogIn,
    auth: "signed-out",
    desktop: { group: "account", order: 2 },
    mobileOrder: 4,
  },
];

export const NAVIGATION_GROUP_LABEL_KEYS: Record<NavigationGroup, MessageKey> = {
  explore: MESSAGE_KEYS.navGroupExplore,
  money: MESSAGE_KEYS.navGroupMoney,
  account: MESSAGE_KEYS.navGroupAccount,
};

export const NAVIGATION_GROUP_ORDER: readonly NavigationGroup[] = [
  "explore",
  "money",
  "account",
];

export function isNavigationVisible(item: NavigationRoute, signedIn: boolean) {
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
    (item) => item.desktop !== null && isNavigationVisible(item, signedIn),
  );
}

export function mobileNavigation(signedIn: boolean) {
  return NAVIGATION.filter(
    (item) => item.mobileOrder !== null && isNavigationVisible(item, signedIn),
  ).sort((left, right) => (left.mobileOrder ?? 0) - (right.mobileOrder ?? 0));
}
