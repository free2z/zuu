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
    "/ai",
    "/wallet/fund",
    "/wallet/fund/activity",
    "/wallet/fund/send",
    "/articles/post-1",
    "/articles/-private_notes",
    "/creator/alice",
    "/creator/@alice+news",
    `/creator/${"a".repeat(150)}`,
    "/creator/%C3%A9lodie",
    "/creator/%C3%A9lodie+news",
    "/live/%F0%90%90%80@news",
    "/live/alice",
    "/live/_alice",
  ] as const)("accepts the exact paid destination %s", (returnTo) => {
    expect(loginDestinationFromState({ returnTo })).toBe(returnTo);
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
    { returnTo: "/articles/a/b" },
    { returnTo: "/articles/privacy~today" },
    { returnTo: "/creator/alice?admin=1" },
    { returnTo: "/creator/élodie" },
    { returnTo: "/creator/%C3%A9lodie%2Bnews" },
    { returnTo: "/live/%F0%90%90%80%40news" },
    { returnTo: `/creator/${"a".repeat(151)}` },
    { returnTo: "/live/%61lice" },
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
    expect(safeLoginDestination("/articles/-privacy_today")).toBe(
      "/articles/-privacy_today",
    );
    expect(safeLoginDestination("//evil.example/articles/privacy")).toBe("/");
  });

  it.each([
    ["/articles/privacy/", "/articles/privacy"],
    ["/creator/alice/", "/creator/alice"],
    ["/live/alice/", "/live/alice"],
  ] as const)(
    "canonicalizes the valid trailing-slash route %s",
    (input, expected) => {
      expect(safeLoginDestination(input)).toBe(expected);
    },
  );

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
