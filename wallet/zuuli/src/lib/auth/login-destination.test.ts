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
  it("accepts only the exact Buy route", () => {
    expect(loginDestinationFromState({ returnTo: "/buy" })).toBe("/buy");
  });

  it.each([
    undefined,
    null,
    {},
    { returnTo: "/" },
    { returnTo: "https://evil.example/buy" },
    { returnTo: "//evil.example/buy" },
    { returnTo: "/buy?next=https://evil.example" },
    { returnTo: "/buy#checkout" },
    { returnTo: "%2Fbuy" },
    { returnTo: "/%62uy" },
    { returnTo: { pathname: "/buy" } },
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
    rememberPendingSocialLoginDestination("/buy", storage);
    expect(consumePendingSocialLoginDestination(storage)).toBe("/buy");
    expect(consumePendingSocialLoginDestination(storage)).toBe("/");
  });

  it("does not persist the default destination", () => {
    const storage = new MemoryStorage();
    rememberPendingSocialLoginDestination("/buy", storage);
    rememberPendingSocialLoginDestination("/", storage);
    expect(consumePendingSocialLoginDestination(storage)).toBe("/");
  });

  it("revalidates tampered persisted state", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "zuuli.auth.pending-social-login-destination",
      "https://evil.example/buy",
    );
    expect(consumePendingSocialLoginDestination(storage)).toBe("/");
  });
});
