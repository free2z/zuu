import { describe, expect, it } from "vitest";
import {
  desktopNavigation,
  isNavigationRouteActive,
  mobileMoreNavigation,
  mobilePrimaryNavigation,
  NAVIGATION,
} from "./navigation";
import { MESSAGE_KEYS } from "@/i18n/messages";

describe("app navigation information architecture", () => {
  it("keeps exactly five stable mobile destinations", () => {
    const signedOut = mobilePrimaryNavigation().map((item) => item.id);
    const signedIn = mobilePrimaryNavigation().map((item) => item.id);

    expect(signedOut).toEqual(["home", "live", "ai", "wallet", "more"]);
    expect(signedIn).toEqual(signedOut);
  });

  it("keeps search in TopBar and funding inside Wallet", () => {
    expect(
      NAVIGATION.some((item) => item.labelKey === MESSAGE_KEYS.navSearch),
    ).toBe(false);
    expect(NAVIGATION.some((item) => item.id === "buy")).toBe(false);
    const wallet = NAVIGATION.find((item) => item.id === "wallet");
    expect(wallet?.kind).toBe("route");
    expect(wallet?.kind === "route" ? wallet.to : null).toBe("/wallet");
  });

  it("binds every destination to its reviewed visible and accessible message keys", () => {
    expect(
      NAVIGATION.map((item) => [
        item.id,
        item.labelKey,
        item.accessibleLabelKey,
        item.mobile.area === "primary" ? item.mobile.labelKey : null,
      ]),
    ).toEqual([
      [
        "home",
        MESSAGE_KEYS.navHome,
        MESSAGE_KEYS.navHome,
        MESSAGE_KEYS.navHome,
      ],
      [
        "live",
        MESSAGE_KEYS.navLive,
        MESSAGE_KEYS.navLive,
        MESSAGE_KEYS.navLiveShort,
      ],
      ["articles", MESSAGE_KEYS.navArticles, MESSAGE_KEYS.navArticles, null],
      ["ai", MESSAGE_KEYS.navAi, MESSAGE_KEYS.navAiAccessible, MESSAGE_KEYS.navAi],
      [
        "messages",
        MESSAGE_KEYS.navMessages,
        MESSAGE_KEYS.navMessagesAccessible,
        null,
      ],
      [
        "wallet",
        MESSAGE_KEYS.navWallet,
        MESSAGE_KEYS.navWalletAccessible,
        MESSAGE_KEYS.navWallet,
      ],
      [
        "profile",
        MESSAGE_KEYS.navProfile,
        MESSAGE_KEYS.navProfileAccessible,
        null,
      ],
      [
        "revenue-share",
        MESSAGE_KEYS.navRevenueShare,
        MESSAGE_KEYS.navRevenueShare,
        null,
      ],
      ["sign-in", MESSAGE_KEYS.navLogin, MESSAGE_KEYS.navLogin, null],
      [
        "more",
        MESSAGE_KEYS.navMore,
        MESSAGE_KEYS.navMoreAccessible,
        MESSAGE_KEYS.navMore,
      ],
    ]);
  });

  it("exposes secondary and account routes coherently", () => {
    expect(mobileMoreNavigation(false).map((item) => item.id)).toEqual([
      "articles",
      "sign-in",
    ]);
    // Messaging is signed-in only, so it appears here and not in the
    // signed-out list above. CLIENT-CONTRACT.md §2.4 places it at
    // `{ area: "more", order: 0 }`; articles already holds that order, so the
    // two tie and declaration order puts messaging second.
    expect(mobileMoreNavigation(true).map((item) => item.id)).toEqual([
      "articles",
      "messages",
      "profile",
      "revenue-share",
    ]);
    const messages = NAVIGATION.find((item) => item.id === "messages");
    expect(messages?.labelKey).toBe(MESSAGE_KEYS.navMessages);
    expect(messages?.accessibleLabelKey).toBe(
      MESSAGE_KEYS.navMessagesAccessible,
    );
    const revenueShare = NAVIGATION.find((item) => item.id === "revenue-share");
    expect(revenueShare?.labelKey).toBe(MESSAGE_KEYS.navRevenueShare);
    expect(revenueShare?.accessibleLabelKey).toBe(
      MESSAGE_KEYS.navRevenueShare,
    );
  });

  it("drives grouped desktop routes from the same config", () => {
    expect(desktopNavigation(false).map((item) => item.id)).toEqual([
      "home",
      "live",
      "articles",
      "ai",
      "wallet",
      "sign-in",
    ]);
    // Messaging is `tools` order 1, directly after AI at order 0, and before
    // the `money` group (CLIENT-CONTRACT.md §2.4).
    expect(desktopNavigation(true).map((item) => item.id)).toEqual([
      "home",
      "live",
      "articles",
      "ai",
      "messages",
      "wallet",
      "profile",
      "revenue-share",
    ]);
  });

  it("marks nested routes without making Home match everything", () => {
    const wallet = NAVIGATION.find(
      (item) => item.kind === "route" && item.id === "wallet",
    );
    const home = NAVIGATION.find(
      (item) => item.kind === "route" && item.id === "home",
    );

    expect(wallet?.kind).toBe("route");
    expect(home?.kind).toBe("route");
    if (wallet?.kind !== "route" || home?.kind !== "route") return;

    expect(isNavigationRouteActive(wallet, "/wallet/fund")).toBe(true);
    expect(isNavigationRouteActive(home, "/wallet/fund")).toBe(false);
  });
});
