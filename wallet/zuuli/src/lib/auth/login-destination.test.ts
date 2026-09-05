import { describe, expect, it } from "vitest";
import {
  consumePendingSocialLoginDestination,
  loginDestinationFromState,
  rememberPendingSocialLoginDestination,
  safeLoginDestination,
} from "./login-destination";

class MemoryStorage {
  private readonly entries = new Map<string, string>();

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }
}

describe("post-login destination", () => {
  it.each([
    "/wallet/fund",
    "/wallet/fund/activity",
    "/wallet/fund/send",
  ] as const)("accepts the exact paid destination %s", (returnTo) => {
    expect(loginDestinationFromState({ returnTo })).toBe(returnTo);
  });

  /**
   * #904 phase 4 deleted these routes from this app. A `returnTo` naming one
   * outlives the deletion in `localStorage` and would land a *successful*
   * sign-in on a NotFound, so the allowlist has to shrink with the router.
   */
  it.each([
    "/ai",
    "/articles/post-1",
    "/articles/-private_notes",
    "/creator/alice",
    "/creator/@alice+news",
    `/creator/${"a".repeat(150)}`,
    "/creator/%C3%A9lodie",
    "/live/alice",
    "/live/_alice",
    "/search",
    "/profile",
    "/kyc",
  ] as const)("refuses the removed content destination %s", (returnTo) => {
    expect(loginDestinationFromState({ returnTo })).toBe("/");
    expect(safeLoginDestination(returnTo)).toBe("/");
  });

  it("normalizes the legacy exact Buy route for in-flight logins", () => {
    expect(loginDestinationFromState({ returnTo: "/buy" })).toBe(
      "/wallet/fund",
    );
    expect(loginDestinationFromState({ returnTo: "/buy/send" })).toBe(
      "/wallet/fund/send",
    );
  });

  it.each([
    undefined,
    null,
    {},
    { returnTo: "/" },
    { returnTo: "/buy/" },
    { returnTo: "https://evil.example/wallet/fund" },
    { returnTo: "//evil.example/wallet/fund" },
    { returnTo: "/wallet/fund?next=https://evil.example" },
    { returnTo: "/wallet/fund#checkout" },
    { returnTo: "%2Fwallet%2Ffund" },
    { returnTo: "/wallet/%66und" },
    { returnTo: { pathname: "/wallet/fund" } },
  ])("falls back home for absent, hostile, or encoded state: %j", (state) => {
    expect(loginDestinationFromState(state)).toBe("/");
  });

  it("fails closed when hostile state throws during inspection", () => {
    const state = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile getter");
        },
      },
    );
    expect(loginDestinationFromState(state)).toBe("/");
  });

  it("round-trips an allowlisted mobile social-login destination once", () => {
    const storage = new MemoryStorage();
    rememberPendingSocialLoginDestination("/wallet/fund", storage);
    expect(consumePendingSocialLoginDestination(storage)).toBe("/wallet/fund");
    expect(consumePendingSocialLoginDestination(storage)).toBe("/");
  });

  it("uses the same allowlist for direct and persisted redirect input", () => {
    expect(safeLoginDestination("/wallet/fund/activity")).toBe(
      "/wallet/fund/activity",
    );
    expect(safeLoginDestination("//evil.example/wallet/fund")).toBe("/");
    expect(safeLoginDestination("/wallet/fund/")).toBe("/");
  });

  it("migrates a pending legacy Buy destination once", () => {
    const storage = new MemoryStorage();
    storage.setItem("zuuli.auth.pending-social-login-destination", "/buy");
    expect(consumePendingSocialLoginDestination(storage)).toBe("/wallet/fund");
    expect(consumePendingSocialLoginDestination(storage)).toBe("/");
  });

  it("does not persist the default destination", () => {
    const storage = new MemoryStorage();
    rememberPendingSocialLoginDestination("/wallet/fund", storage);
    rememberPendingSocialLoginDestination("/", storage);
    expect(consumePendingSocialLoginDestination(storage)).toBe("/");
  });

  it("revalidates tampered persisted state", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "zuuli.auth.pending-social-login-destination",
      "https://evil.example/wallet/fund",
    );
    expect(consumePendingSocialLoginDestination(storage)).toBe("/");
  });
});
