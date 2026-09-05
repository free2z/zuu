import { describe, expect, it } from "vitest";
import {
  desktopNavigation,
  isNavigationRouteActive,
  mobileMoreNavigation,
  mobilePrimaryNavigation,
  NAVIGATION,
} from "./navigation";
import { APP_ROUTE_SEGMENTS } from "@/lib/routes";
import { MESSAGE_KEYS } from "@/i18n/messages";

describe("app navigation information architecture", () => {
  it("keeps exactly three stable mobile destinations", () => {
    const signedOut = mobilePrimaryNavigation().map((item) => item.id);
    const signedIn = mobilePrimaryNavigation().map((item) => item.id);

    expect(signedOut).toEqual(["home", "wallet", "more"]);
    expect(signedIn).toEqual(signedOut);
  });

  /**
   * #904 phase 4 deleted the content routes from `App.tsx`. A navigation entry
   * that outlives its route renders a NotFound at runtime and typechecks
   * cleanly — the exact defect #920 hit — so the two are pinned together here
   * rather than left to a rendered-copy assertion in Playwright.
   */
  it("points every destination at a route this app still mounts", () => {
    const targets = NAVIGATION.filter(
      (item): item is Extract<typeof item, { kind: "route" }> =>
        item.kind === "route",
    ).map((item) => item.to);

    expect(targets.length).toBeGreaterThan(0);
    for (const to of targets) {
      expect(to.startsWith("/")).toBe(true);
      expect(APP_ROUTE_SEGMENTS.has(to.split("/")[1] ?? "")).toBe(true);
    }
    // The negative control: the segments this app stopped mounting are gone,
    // so the check above would actually catch a nav entry that kept one.
    for (const removed of [
      "live",
      "articles",
      "ai",
      "search",
      "creator",
      "profile",
      "kyc",
    ]) {
      expect(APP_ROUTE_SEGMENTS.has(removed)).toBe(false);
    }
  });

  it("keeps funding inside Wallet and hosts no discovery entry", () => {
    expect(NAVIGATION.some((item) => item.id === "buy")).toBe(false);
    expect(NAVIGATION.some((item) => item.id === "search")).toBe(false);
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
        "wallet",
        MESSAGE_KEYS.navWallet,
        MESSAGE_KEYS.navWalletAccessible,
        MESSAGE_KEYS.navWallet,
      ],
      ["about", MESSAGE_KEYS.navAbout, MESSAGE_KEYS.navAboutAccessible, null],
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
    // Messaging moved to the e2e2z application in #904 phase 3, and the
    // content destinations to free2z in phase 4, so "More" now carries the
    // account routes only.
    expect(mobileMoreNavigation(false).map((item) => item.id)).toEqual([
      "sign-in",
      "about",
    ]);
    expect(mobileMoreNavigation(true).map((item) => item.id)).toEqual([
      "about",
    ]);
  });

  it("drives grouped desktop routes from the same config", () => {
    expect(desktopNavigation(false).map((item) => item.id)).toEqual([
      "home",
      "wallet",
      "about",
      "sign-in",
    ]);
    expect(desktopNavigation(true).map((item) => item.id)).toEqual([
      "home",
      "wallet",
      "about",
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
