import { beforeAll, describe, expect, it } from "vitest";
import {
  MOBILE_REDIRECT_URI,
  validateAuthorizationStart,
  type OAuthStartResponse,
} from "../oauth/protocol";
import { parseSocialProvidersStatus } from "./social-providers";
import type { SocialProvidersStatus } from "./types";

declare const process: {
  env: Record<string, string | undefined>;
};

const ENABLED = process.env.ZUULI_VERIFY_LIVE_SOCIAL_START === "1";
const PRODUCTION_BASE = "https://free2z.cash";
const PRODUCTION_RELAY =
  "https://free2z.cash/api/auth/social/mobile/callback";
const PROVIDER = "x" as const;
const MOBILE_CODE_CHALLENGE = "A".repeat(43);
const X_REQUIRED_SCOPES = new Set(["tweet.read", "users.read"]);

function validateProductionDiscovery(
  genericStatus: SocialProvidersStatus,
  mobileStatus: SocialProvidersStatus,
): void {
  if (!genericStatus.x) {
    throw new Error("Production does not advertise desktop-ready X.");
  }
  if (!mobileStatus.x) {
    throw new Error("Production does not advertise native-ready X.");
  }
  if (mobileStatus.github) {
    throw new Error("Production unexpectedly advertises GitHub on mobile.");
  }
}

function exactQuery(url: URL, name: string): string {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || !values[0]) {
    throw new Error(`Production X authorization is missing one exact ${name}.`);
  }
  return values[0];
}

function validateProductionMobileXStart(start: OAuthStartResponse): void {
  if (start.provider_redirect_uri !== PRODUCTION_RELAY) {
    throw new Error("Production X authorization selected the wrong relay.");
  }
  const authorizeUrl = validateAuthorizationStart(
    PROVIDER,
    start,
    MOBILE_REDIRECT_URI,
    true,
    MOBILE_CODE_CHALLENGE,
  );
  const parsed = new URL(authorizeUrl);
  if (exactQuery(parsed, "redirect_uri") !== PRODUCTION_RELAY) {
    throw new Error("Production X authorization changed the exact relay.");
  }
  if (!exactQuery(parsed, "client_id").trim()) {
    throw new Error("Production X authorization has no client identifier.");
  }
  const scopes = new Set(exactQuery(parsed, "scope").split(/\s+/).filter(Boolean));
  if (
    scopes.size !== X_REQUIRED_SCOPES.size ||
    ![...X_REQUIRED_SCOPES].every((scope) => scopes.has(scope))
  ) {
    throw new Error("Production X authorization scopes are not identity-only.");
  }
}

function sampleMobileXStart(): OAuthStartResponse {
  const state = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  const authorizationState = "ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210zyxwvut";
  const url = new URL("https://twitter.com/i/oauth2/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", "public-x-client");
  url.searchParams.set("redirect_uri", PRODUCTION_RELAY);
  url.searchParams.set("scope", "tweet.read users.read");
  url.searchParams.set("state", authorizationState);
  url.searchParams.set("code_challenge", MOBILE_CODE_CHALLENGE);
  url.searchParams.set("code_challenge_method", "S256");
  return {
    authorize_url: url.toString(),
    state,
    authorization_state: authorizationState,
    provider_redirect_uri: PRODUCTION_RELAY,
  };
}

async function productionJson(path: string): Promise<unknown> {
  const response = await fetch(`${PRODUCTION_BASE}${path}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Production returned HTTP ${response.status} for ${path}.`);
  }
  return response.json() as Promise<unknown>;
}

async function productionStart(
  redirectUri: string,
  codeChallenge?: string,
): Promise<OAuthStartResponse> {
  const query = new URLSearchParams({ redirect_uri: redirectUri });
  if (codeChallenge) query.set("code_challenge", codeChallenge);
  return (await productionJson(
    `/api/auth/social/${PROVIDER}/start?${query.toString()}`,
  )) as OAuthStartResponse;
}

describe("production social-provider preflight validator", () => {
  const readyStatus: SocialProvidersStatus = {
    x: true,
    google: false,
    github: false,
  };

  it("accepts matching desktop and native discovery before probing starts", () => {
    expect(() =>
      validateProductionDiscovery(readyStatus, readyStatus),
    ).not.toThrow();
  });

  it.each([
    ["desktop", { ...readyStatus, x: false }, readyStatus],
    ["native", readyStatus, { ...readyStatus, x: false }],
    ["mobile GitHub", readyStatus, { ...readyStatus, github: true }],
  ] as const)(
    "rejects unavailable %s discovery before probing starts",
    (_, generic, mobile) => {
      expect(() => validateProductionDiscovery(generic, mobile)).toThrow(
        /Production/,
      );
    },
  );

  it("accepts exact production X relay, client and scope truth", () => {
    expect(() => validateProductionMobileXStart(sampleMobileXStart())).not.toThrow();
  });

  it.each(["relay", "client", "scope", "extra scope"] as const)(
    "rejects unusable production X %s configuration without exposing values",
    (fault) => {
      const start = sampleMobileXStart();
      const url = new URL(start.authorize_url);
      if (fault === "relay") {
        const stageRelay =
          "https://stage.free2z.cash/api/auth/social/mobile/callback";
        start.provider_redirect_uri = stageRelay;
        url.searchParams.set("redirect_uri", stageRelay);
      } else if (fault === "client") {
        url.searchParams.delete("client_id");
      } else if (fault === "scope") {
        url.searchParams.set("scope", "tweet.read");
      } else {
        url.searchParams.set("scope", "tweet.read users.read tweet.write");
      }
      start.authorize_url = url.toString();

      expect(() => validateProductionMobileXStart(start)).toThrow(/Production X/);
    },
  );
});

/**
 * Explicit live smoke test. It performs anonymous GETs only, validates the
 * returned authorization URL in memory, and never opens it or calls the OAuth
 * completion endpoint, so it cannot sign in, link, or mutate an account.
 */
describe.runIf(ENABLED)("production social-provider native start", () => {
  let genericStatus: SocialProvidersStatus;
  let mobileStatus: SocialProvidersStatus;

  beforeAll(async () => {
    genericStatus = parseSocialProvidersStatus(
      await productionJson("/api/auth/social/providers/"),
    );
    mobileStatus = parseSocialProvidersStatus(
      await productionJson("/api/auth/social/mobile/providers/"),
    );
    // A discovery failure aborts this suite before any start request can mint
    // OAuth state. Individual tests below retain focused failure reporting for
    // a successful discovery run.
    validateProductionDiscovery(genericStatus, mobileStatus);
  });

  it("discovers desktop-ready X through the generic contract", () => {
    expect(genericStatus.x).toBe(true);
  });

  it("requires native-ready X through the stricter mobile contract", () => {
    expect(mobileStatus.x).toBe(true);
    expect(mobileStatus.github).toBe(false);
  });

  it.each(["iOS", "Android"])(
    "validates the configured X start for %s without opening it",
    async () => {
      const start = await productionStart(
        MOBILE_REDIRECT_URI,
        MOBILE_CODE_CHALLENGE,
      );
      expect(() => validateProductionMobileXStart(start)).not.toThrow();
    },
  );

  it("validates the configured X desktop-loopback start without opening it", async () => {
    const redirectUri =
      "http://127.0.0.1:49152/0123456789abcdef0123456789abcdef";
    const start = await productionStart(redirectUri);
    expect(
      validateAuthorizationStart(PROVIDER, start, redirectUri, false),
    ).toMatch(/^https:\/\/twitter\.com\/i\/oauth2\/authorize\?/);
  });
});
