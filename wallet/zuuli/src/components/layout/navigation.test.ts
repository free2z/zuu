import { describe, expect, it } from "vitest";
import {
  desktopNavigation,
  isNavigationRouteActive,
  mobileMoreNavigation,
  mobilePrimaryNavigation,
  NAVIGATION,
} from "./navigation";

describe("app navigation information architecture", () => {
  it("keeps exactly five stable mobile destinations", () => {
    const signedOut = mobilePrimaryNavigation().map((item) => item.id);
    const signedIn = mobilePrimaryNavigation().map((item) => item.id);

    expect(signedOut).toEqual(["home", "live", "ai", "wallet", "more"]);
    expect(signedIn).toEqual(signedOut);
  });

  it("keeps search in TopBar and funding inside Wallet", () => {
    expect(NAVIGATION.some((item) => item.label === "Search")).toBe(false);
    expect(NAVIGATION.some((item) => item.id === "buy")).toBe(false);
    const wallet = NAVIGATION.find((item) => item.id === "wallet");
    expect(wallet?.kind).toBe("route");
    expect(wallet?.kind === "route" ? wallet.to : null).toBe("/wallet");
  });

  it("exposes secondary and account routes coherently", () => {
    expect(mobileMoreNavigation(false).map((item) => item.id)).toEqual([
      "articles",
      "sign-in",
    ]);
    expect(mobileMoreNavigation(true).map((item) => item.id)).toEqual([
      "articles",
      "profile",
      "revenue-share",
    ]);
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
    expect(desktopNavigation(true).map((item) => item.id)).toEqual([
      "home",
      "live",
      "articles",
      "ai",
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
