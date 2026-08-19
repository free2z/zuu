import { describe, expect, it } from "vitest";
import {
  consumePendingSocialLoginDestination,
  loginDestinationFromState,
  rememberPendingSocialLoginDestination,
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
  it("accepts the exact Wallet funding route", () => {
    expect(loginDestinationFromState({ returnTo: "/wallet/fund" })).toBe(
      "/wallet/fund",
    );
  });

  it("normalizes the legacy exact Buy route for in-flight logins", () => {
    expect(loginDestinationFromState({ returnTo: "/buy" })).toBe(
      "/wallet/fund",
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
