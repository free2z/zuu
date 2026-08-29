import { describe, expect, it } from "vitest";
import type { SocialProvider } from "../api/types";
import {
  MOBILE_REDIRECT_URI,
  assertSessionBinding,
  buildSessionBinding,
  canResumeMobileOAuth,
  generatePkcePair,
  validateAuthorizationStart,
} from "./protocol";

const STATE = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const AUTHORIZATION_STATE = "ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210zyxwvut";
const CHALLENGE = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const PROVIDER_REDIRECT_URI = "https://free2z.cash/api/auth/social/mobile/callback";

function start(
  provider: SocialProvider = "google",
  redirectUri = MOBILE_REDIRECT_URI,
) {
  const endpoint = {
    x: "https://twitter.com/i/oauth2/authorize",
    google: "https://accounts.google.com/o/oauth2/v2/auth",
    github: "https://github.com/login/oauth/authorize",
  }[provider];
  const url = new URL(endpoint);
  url.searchParams.set("response_type", "code");
  const mobile = redirectUri === MOBILE_REDIRECT_URI;
  url.searchParams.set("state", mobile ? AUTHORIZATION_STATE : STATE);
  url.searchParams.set("redirect_uri", mobile ? PROVIDER_REDIRECT_URI : redirectUri);
  if (provider !== "github") {
    url.searchParams.set("code_challenge", CHALLENGE);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return {
    authorize_url: url.toString(),
    state: STATE,
    ...(mobile
      ? {
          authorization_state: AUTHORIZATION_STATE,
          provider_redirect_uri: PROVIDER_REDIRECT_URI,
        }
      : {}),
  };
}

describe("validateAuthorizationStart", () => {
  it("accepts the exact Google endpoint, callback, state and S256 challenge", () => {
    expect(
      validateAuthorizationStart("google", start(), MOBILE_REDIRECT_URI, true),
    ).toContain("accounts.google.com");
  });

  it.each([
    ["wrong host", (url: URL) => (url.hostname = "evil.example")],
    ["wrong path", (url: URL) => (url.pathname = "/not-oauth")],
    ["wrong callback", (url: URL) => url.searchParams.set("redirect_uri", "evil://callback")],
    ["wrong state", (url: URL) => url.searchParams.set("state", `${AUTHORIZATION_STATE}x`)],
    ["missing PKCE", (url: URL) => url.searchParams.delete("code_challenge")],
    ["downgraded PKCE", (url: URL) => url.searchParams.set("code_challenge_method", "plain")],
  ])("rejects %s", (_name, mutate) => {
    const value = start();
    const url = new URL(value.authorize_url);
    mutate(url);
    value.authorize_url = url.toString();
    expect(() =>
      validateAuthorizationStart("google", value, MOBILE_REDIRECT_URI, true),
    ).toThrow();
  });

  it("rejects duplicate security parameters", () => {
    const value = start();
    value.authorize_url += `&state=${AUTHORIZATION_STATE}`;
    expect(() =>
      validateAuthorizationStart("google", value, MOBILE_REDIRECT_URI, true),
    ).toThrow(/repeated/);
  });

  it("keeps non-PKCE GitHub off mobile while preserving desktop", () => {
    expect(() =>
      validateAuthorizationStart("github", start("github"), MOBILE_REDIRECT_URI, true),
    ).toThrow(/PKCE-capable/);
    const desktop = "http://127.0.0.1:49152/0123456789abcdef0123456789abcdef";
    expect(() => validateAuthorizationStart("github", start("github", desktop), desktop, false))
      .not.toThrow();
  });

  it.each([
    "http://free2z.cash/api/auth/social/mobile/callback",
    "https://evil.example/api/auth/social/mobile/callback",
    "https://api.free2z.cash/api/auth/social/mobile/callback",
    "https://free2z.cash/api/auth/social/mobile/callback?next=evil",
    "https://free2z.cash/other",
  ])("rejects unsafe provider relay %s", (relay) => {
    const value = start();
    value.provider_redirect_uri = relay;
    expect(() =>
      validateAuthorizationStart("google", value, MOBILE_REDIRECT_URI, true),
    ).toThrow(/relay/);
  });

  it("allows a staging relay only in a development build", () => {
    const value = start();
    const stagingRelay =
      "https://stage.free2z.cash/api/auth/social/mobile/callback";
    value.provider_redirect_uri = stagingRelay;
    const authorizationUrl = new URL(value.authorize_url);
    authorizationUrl.searchParams.set("redirect_uri", stagingRelay);
    value.authorize_url = authorizationUrl.toString();
    expect(() =>
      validateAuthorizationStart("google", value, MOBILE_REDIRECT_URI, true),
    ).not.toThrow();
  });
});

describe("buildSessionBinding", () => {
  it("binds anonymous login to an empty session", async () => {
    await expect(buildSessionBinding(false, null)).resolves.toBe("login:none");
    await expect(buildSessionBinding(false, "existing-token")).rejects.toThrow(/Sign out/);
  });

  it("binds association to a one-way digest of the current token", async () => {
    const binding = await buildSessionBinding(true, "secret-token");
    expect(binding).toMatch(/^associate:[0-9a-f]{64}$/);
    expect(binding).not.toContain("secret-token");
    await expect(buildSessionBinding(true, null)).rejects.toThrow(/expired/);
  });
});

describe("assertSessionBinding", () => {
  it("returns only the exact initiating association token", async () => {
    const binding = await buildSessionBinding(true, "account-a-token");
    await expect(
      assertSessionBinding(binding, true, "account-a-token"),
    ).resolves.toBe("account-a-token");
    await expect(
      assertSessionBinding(binding, true, "account-b-token"),
    ).rejects.toThrow(/session changed/);
  });

  it("fails closed across logout, relogin, and authenticated login transitions", async () => {
    const association = await buildSessionBinding(true, "first-token");
    await expect(assertSessionBinding(association, true, null)).rejects.toThrow();
    await expect(
      assertSessionBinding(association, true, "replacement-token"),
    ).rejects.toThrow();

    await expect(assertSessionBinding("login:none", false, null)).resolves.toBeNull();
    await expect(
      assertSessionBinding("login:none", false, "unexpected-session"),
    ).rejects.toThrow();
  });
});

describe("canResumeMobileOAuth", () => {
  it("only resumes a login while signed out", () => {
    expect(canResumeMobileOAuth(false, null)).toBe(true);
    expect(canResumeMobileOAuth(false, "new-session")).toBe(false);
  });

  it("only resumes account association while signed in", () => {
    expect(canResumeMobileOAuth(true, "existing-session")).toBe(true);
    expect(canResumeMobileOAuth(true, null)).toBe(false);
  });
});

describe("generatePkcePair", () => {
  it("creates fresh RFC 7636 base64url verifier/challenge pairs", async () => {
    const first = await generatePkcePair();
    const second = await generatePkcePair();
    expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.verifier).not.toBe(first.verifier);
    expect(() =>
      validateAuthorizationStart(
        "google",
        start(),
        MOBILE_REDIRECT_URI,
        true,
        `${CHALLENGE}x`,
      ),
    ).toThrow(/changed the app's PKCE challenge/);
  });
});
