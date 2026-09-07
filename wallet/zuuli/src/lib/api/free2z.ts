// The free2z API surface ZUULI uses, mapping the REAL production endpoints
// (tuzi/f2z.yaml / free2z.cash) into stable internal types the features
// depend on. Field names here match production; the returned objects match
// src/lib/api/types.ts so features never need to change when the wire format does.
//
// This module is the CONTRACT every feature imports. Keep the return types stable.

import { useMock } from "../platform";
import { MOCK_OTP } from "../env";
import {
  cancelMobileOAuth,
  captureOAuthCode,
  finishMobileOAuth,
  oauthCallbackTransport,
  withOAuthSession,
  type OAuthCapture,
} from "../oauth/transport";
import type { OAuthStartResponse } from "../oauth/protocol";
import { ApiError, basicLogin, getToken, mediaUrl, request, setToken } from "./http";
import {
  DonationContractError,
  IDEMPOTENT_DONATION_ROUTE,
  isDonationIdempotencyKey,
  normalizeDonationResult,
  type DonationResult,
} from "./donation";
import {
  mockAssociateZcash,
  mockSearchCreators,
  mockTransactions,
  mockUser,
} from "./mock-data";
import type {
  AuthUser,
  LoginResult,
  AuthenticatedSession,
  OtpStatus,
  Paginated,
  PricingQuote,
  SimpleCreator,
  SocialProvider,
  SocialAuthResult,
  SocialProvidersStatus,
  TuziTransaction,
} from "./types";
import { validateStripeCheckoutUrl } from "./checkout";
import { parseSocialProvidersStatus } from "./social-providers";
import {
  parseCheckoutPaymentStatus,
  parseCheckoutReturnClaim,
  type CheckoutPaymentStatus,
  type CheckoutReturnClaim,
  type CheckoutReturnMode,
} from "@/lib/checkout/native-return";

const delay = (ms = 260) => new Promise((r) => setTimeout(r, ms));

/** Per-request deadline for the two native checkout return calls. */
const NATIVE_RETURN_TIMEOUT_MS = 15_000;

const SOCIAL_PROVIDER_PATH = "/api/auth/social/providers/";
const MOBILE_SOCIAL_PROVIDER_PATH = "/api/auth/social/mobile/providers/";

function mockSocialProvidersWire(): unknown {
  const scenario =
    typeof window === "undefined"
      ? null
      : window.sessionStorage.getItem("zuuli.mock.social-providers");
  if (scenario === "x") {
    return {
      providers: [
        { provider: "x", configured: true },
        { provider: "google", configured: false },
        { provider: "github", configured: false },
      ],
    };
  }
  if (scenario === "contract-error") {
    return { providers: [{ provider: "x", configured: true }] };
  }
  return {
    providers: [
      { provider: "x", configured: false },
      { provider: "google", configured: false },
      { provider: "github", configured: false },
    ],
  };
}

const mockDonationResults = new Map<
  string,
  { username: string; amount: number; result: DonationResult }
>();

// ─── Raw production shapes (only the fields we read) ────────────────────────
interface RawImage {
  url?: string;
  card?: string;
  thumbnail?: string;
  banner?: string;
}
interface RawCreator {
  username: string;
  full_name?: string;
  p2paddr?: string;
  avatar_image?: RawImage | null;
  banner_image?: RawImage | null;
  member_price?: string | null;
  description?: string | null;
  is_verified?: boolean;
  can_stream?: boolean;
  total?: string | number | null;
  zpages?: number;
  /** Server-computed "is this creator live right now" (Dyte room state). */
  is_live?: boolean;
}

// ─── Mappers ────────────────────────────────────────────────────────────────

/** Decimal money fields arrive as strings; parse to a whole 2Z or null. */
function parsePrice(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function mapCreator(c: RawCreator): SimpleCreator {
  return {
    username: c.username,
    free2zaddr: c.username,
    display_name: c.full_name || c.username,
    image: mediaUrl(c.avatar_image?.thumbnail || c.avatar_image?.url) ?? null,
    bio: c.description ?? null,
    is_verified: c.is_verified ?? false,
    zpages: typeof c.zpages === "number" ? c.zpages : undefined,
    member_price: parsePrice(c.member_price),
    // Pass through as-is: `undefined` (field absent) is meaningful — it lets
    // consumers distinguish "backend doesn't report live state" from "not live".
    is_live: c.is_live,
  };
}

// ─── Auth / session ─────────────────────────────────────────────────────────

/** Mock: which usernames should exercise the 2FA (OTP) step, and the code that clears it. */
const MOCK_OTP_CODE = "123456";
function mockOtpEnabled(username: string): boolean {
  return MOCK_OTP || username.toLowerCase().includes("otp");
}

export const auth = {
  /**
   * Classic username/password sign-in (a first-class login method, peer to
   * Login with Zcash).
   *
   * Real flow:
   *   1. `basicLogin` → Knox Basic-auth login (`/api/token/login/`) mints a token
   *      without storing it.
   *   2. `otpStatus()` (authenticated with that token) reports whether the
   *      account has TOTP 2FA enabled.
   *   3. If 2FA is ON we WITHHOLD the token and return `otp_required`, so an
   *      abandoned code prompt never leaves a live session behind; the caller
   *      finishes via `completeOtp`. If 2FA is OFF, the login is complete.
   *
   * (Knox's own login endpoint does not enforce OTP, so the second factor is
   * gated here on the client — see the follow-up note about a token-upgrading
   * OTP endpoint on the backend.)
   */
  async login(username: string, password: string): Promise<LoginResult> {
    if (useMock()) {
      await delay();
      if (mockOtpEnabled(username)) return { status: "otp_required", username };
      return {
        status: "complete",
        session: { token: "mock-knox-token", user: { ...mockUser, username } },
      };
    }
    const token = await basicLogin(username, password);
    const { enabled } = await auth.otpStatus(token);
    if (enabled) {
      return { status: "otp_required", username };
    }
    return {
      status: "complete",
      session: { token, user: await auth.me(token) },
    };
  },

  /** Whether the currently-authenticated account has TOTP 2FA enabled. */
  async otpStatus(authToken?: string): Promise<OtpStatus> {
    if (useMock()) {
      await delay(120);
      return { enabled: false };
    }
    return request<OtpStatus>("/api/otp/status/", { authToken });
  },

  /**
   * Finish a username/password login that requires 2FA. The backend's
   * `/api/otp/login/` verifies the 6-digit TOTP `code` (it re-checks the
   * password too); a wrong code throws. On success we mint a fresh Knox token
   * via Basic-auth login and load the profile.
   */
  async completeOtp(
    username: string,
    password: string,
    code: string,
  ): Promise<AuthenticatedSession> {
    if (useMock()) {
      await delay();
      if (code !== MOCK_OTP_CODE) {
        throw new Error("That code didn't match. (Mock mode expects 123456.)");
      }
      return {
        token: "mock-knox-token",
        user: { ...mockUser, username },
      };
    }
    try {
      await request("/api/otp/login/", {
        method: "POST",
        anonymous: true,
        body: { username, password, token: code },
      });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 400 || e.status === 401)) {
        throw new Error(
          "That code didn't match. Check your authenticator app and try again.",
        );
      }
      throw e;
    }
    const token = await basicLogin(username, password);
    return { token, user: await auth.me(token) };
  },

  async me(authToken?: string, signal?: AbortSignal): Promise<AuthUser> {
    if (useMock()) {
      await delay(120);
      return { ...mockUser };
    }
    const u = await request<{
      username: string;
      email?: string;
      full_name?: string;
      description?: string | null;
      p2paddr?: string | null;
      member_price?: string | null;
      can_stream?: boolean;
      is_verified?: boolean;
      tuzis?: string;
      avatar_image?: RawImage | null;
      banner_image?: RawImage | null;
    }>("/api/auth/user/", { cache: "no-store", authToken, signal });
    return {
      username: u.username,
      email: u.email,
      free2zaddr: u.username,
      display_name: u.full_name || u.username,
      image: mediaUrl(u.avatar_image?.thumbnail || u.avatar_image?.url) ?? null,
      banner:
        mediaUrl(
          u.banner_image?.banner || u.banner_image?.card || u.banner_image?.url,
        ) ?? null,
      bio: u.description ?? null,
      p2paddr: u.p2paddr ?? null,
      member_price: parsePrice(u.member_price),
      can_stream: u.can_stream ?? false,
      is_verified: u.is_verified ?? false,
      tuzis: u.tuzis ? Math.floor(Number(u.tuzis)) : 0,
    };
  },

  async logout(): Promise<void> {
    // Invalidate the renderer session synchronously so every outstanding OAuth
    // transport aborts before the revocation request crosses the network.
    // The request is pinned to the captured token and never re-reads global
    // state after the account transition.
    const token = getToken();
    setToken(null);
    if (!useMock()) {
      try {
        await request("/api/token/logout/", {
          method: "POST",
          authToken: token ?? undefined,
        });
      } catch {
        /* best-effort */
      }
    }
  },

  /**
   * Login with Zcash: the wallet signs a server challenge; the backend verifies
   * the signature against the address, mints a Knox token, and derives a DID.
   * (Backend endpoint: POST /api/auth/zcash/login/ — see the zcash-login work.)
   */
  async zcashLogin(params: {
    address: string;
    challenge: string;
    signature: string;
    pubkey?: string;
  }): Promise<AuthenticatedSession> {
    if (useMock()) {
      await delay(400);
      return {
        token: "mock-knox-token-zcash",
        user: { ...mockUser, zcashLinked: true },
      };
    }
    const tok = await request<{ token: string }>("/api/auth/zcash/login/", {
      method: "POST",
      body: params,
      anonymous: true,
    });
    const me = await auth.me(tok.token);
    return { token: tok.token, user: { ...me, zcashLinked: true } };
  },

  /** Ask the backend for a login challenge to sign. */
  async zcashChallenge(address: string): Promise<{ challenge: string }> {
    if (useMock()) {
      await delay(150);
      return { challenge: `zuuli-login:${address}:${Math.random().toString(36).slice(2)}` };
    }
    return request<{ challenge: string }>("/api/auth/zcash/challenge/", {
      method: "POST",
      body: { address },
      anonymous: true,
    });
  },

  /**
   * Link a Zcash key to the CURRENTLY SIGNED-IN account ("Linked identities"
   * in the profile). This hits the exact same dual-mode endpoint as
   * `zcashLogin` — `POST /api/auth/zcash/login/` — but WITHOUT
   * `anonymous: true`, so `request()` attaches the stored knox token. Seeing
   * that token, the backend associates the verified address with the current
   * account instead of logging in/creating one (`ZcashLoginView` in
   * `tuzi/py/dj/apps/zauth/views.py`).
   *
   * The backend returns 409 for either conflict case: the address is already
   * linked to a DIFFERENT account, or this account already has a linked
   * Zcash identity. We can't (and don't need to) distinguish the two for the
   * user — both mean "pick a different key, or unlink the existing one
   * first" — so we surface one clear message for any 409.
   */
  async zcashAssociate(params: {
    address: string;
    challenge: string;
    signature: string;
    pubkey?: string;
  }): Promise<AuthUser> {
    if (useMock()) {
      await delay(400);
      return mockAssociateZcash(params.address);
    }
    try {
      // Deliberately NOT `anonymous: true` — the point of this call is that
      // the request carries `Authorization: Token <knox token>`.
      await request<unknown>("/api/auth/zcash/login/", {
        method: "POST",
        body: params,
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        throw new Error(
          "That Zcash key is already linked — either to a different free2z account, or this account already has a linked Zcash identity. Unlink it there first, or sign with a different key.",
        );
      }
      throw e;
    }
    const me = await auth.me();
    return { ...me, zcash_identity: params.address };
  },

  /**
   * Which social providers (X / Google / GitHub) are available for this exact
   * callback transport. Web and Tauri desktop consume credential truth from
   * GET /api/auth/social/providers/. Tauri iOS/Android consume the stricter
   * GET /api/auth/social/mobile/providers/ readiness contract (credentials,
   * PKCE, exact relay policy and rollout activation).
   *
   * The wire response is an object containing a `providers` array. Treat it as
   * unknown until every entry is validated, then normalize it to the stable
   * internal all-provider map consumed by the UI. Mock mode exercises the same
   * wire contract rather than maintaining a second response shape.
   */
  async socialProviders(): Promise<SocialProvidersStatus> {
    if (useMock()) {
      await delay(100);
      return parseSocialProvidersStatus(mockSocialProvidersWire());
    }
    // If the native discriminator is unavailable, reject discovery. Falling
    // back to the generic endpoint could advertise a desktop-ready provider
    // whose mobile relay is deliberately disabled.
    const transport = await oauthCallbackTransport();
    const path =
      transport === "mobile"
        ? MOBILE_SOCIAL_PROVIDER_PATH
        : SOCIAL_PROVIDER_PATH;
    const response = await request<unknown>(path, {
      anonymous: true,
    });
    return parseSocialProvidersStatus(response);
  },

  /**
   * Ask the backend to build the provider's `authorize_url`. Desktop uses its
   * backend-generated PKCE pair and exact `127.0.0.1:<ephemeral>/<nonce>`
   * callback. Mobile sends only its app-generated S256 challenge; providers
   * return to free2z's fixed HTTPS relay before the exact private app URI.
   * 503s if the provider isn't configured; callers should already have
   * gated the entry point on `socialProviders()`, so that should only ever
   * fire on a race with the backend config changing mid-session.
   */
  async socialStart(
    provider: SocialProvider,
    redirectUri: string,
    codeChallenge?: string,
  ): Promise<OAuthStartResponse> {
    return request<OAuthStartResponse>(
      `/api/auth/social/${provider}/start`,
      {
        query: { redirect_uri: redirectUri, code_challenge: codeChallenge },
        anonymous: true,
      },
    );
  },

  /**
   * Social login / link with a provider (X / Google / GitHub). Runs the
   * OAuth authorization-code round trip over the desktop loopback transport,
   * the mobile free2z-HTTPS-to-app relay, or a web popup fallback
   * (`../oauth/transport.ts`) — callers receive an uncommitted result and own
   * the final current-attempt session publication.
   *
   * Dual-mode, mirroring `zcashLogin`/`zcashAssociate`:
   *   - `associate: false` (default) — POSTs anonymously; the backend logs
   *     in (or creates) the account for that provider identity.
   *   - `associate: true` — POSTs WITH the current session's knox token
   *     attached (not anonymous), so the backend links the identity to the
   *     signed-in account instead. A 409 means the identity is already
   *     linked elsewhere, or this account already has one for this
   *     provider — surfaced as one clear message, same as `zcashAssociate`.
   *
   * Availability is discovered at runtime through the strictly validated
   * `socialProviders()` contract. A configured discovery result gates the
   * affordance but does not weaken start/callback validation if deployment
   * configuration drifts afterward.
   */
  async socialLogin(
    provider: SocialProvider,
    opts: { associate?: boolean } = {},
  ): Promise<SocialAuthResult> {
    if (useMock()) {
      throw new Error(
        "Social login isn't available in mock mode — no provider is configured yet.",
      );
    }
    const associate = opts.associate === true;
    const capture = await captureOAuthCode(provider, associate, (redirect, challenge) =>
      auth.socialStart(provider, redirect, challenge),
    );
    return auth.completeSocialOAuth(capture);
  },

  /**
   * Exchange a callback already validated and one-shot claimed by the native
   * transport. Public so App startup can finish a crash-recovered cold-start
   * callback through exactly the same backend path as the live button flow.
   */
  async completeSocialOAuth(capture: OAuthCapture): Promise<SocialAuthResult> {
    return withOAuthSession<SocialAuthResult>(capture, async (lease) => {
      const { provider, associate, code, state, redirectUri, codeVerifier } = capture;
      const body = {
        code,
        state,
        redirect_uri: redirectUri,
        ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
      };

      if (associate) {
        try {
          // Deliberately NOT `anonymous: true` — the request is pinned to the
          // exact token whose one-way binding preceded provider navigation.
          await request<unknown>(`/api/auth/social/${provider}/`, {
            method: "POST",
            body,
            authToken: lease.initiatingToken ?? undefined,
            signal: lease.signal,
          });
          lease.assertCurrent();
          // The backend mutation already succeeded. Local scratch-file cleanup
          // must not turn a completed link into a user-visible auth failure.
          await finishMobileOAuth(state).catch(() => undefined);
          lease.assertCurrent();
        } catch (e) {
          if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
            await cancelMobileOAuth(state).catch(() => undefined);
          }
          if (e instanceof ApiError && e.status === 409) {
            throw new Error(
              "That account is already linked — either to a different free2z account, or this account already has a linked identity for this provider. Unlink it there first, or use a different account.",
            );
          }
          throw e;
        }
        const me = await auth.me(lease.initiatingToken ?? undefined, lease.signal);
        lease.assertCurrent();
        return {
          status: "associated",
          sessionGeneration: lease.sessionGeneration,
          user: {
            ...me,
            social_identities: { ...me.social_identities, [provider]: true },
          },
        };
      }

      const tok = await request<{ token: string }>(`/api/auth/social/${provider}/`, {
        method: "POST",
        body,
        anonymous: true,
        signal: lease.signal,
      }).catch(async (error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          await cancelMobileOAuth(state).catch(() => undefined);
        }
        throw error;
      });
      lease.assertCurrent();
      await finishMobileOAuth(state).catch(() => undefined);
      lease.assertCurrent();
      const me = await auth.me(tok.token, lease.signal);
      lease.assertCurrent();
      return {
        status: "authenticated",
        sessionGeneration: lease.sessionGeneration,
        session: {
          token: tok.token,
          user: {
            ...me,
            social_identities: { ...me.social_identities, [provider]: true },
          },
        },
      };
    });
  },
};

// ─── Tuzi (2Z) economy ───────────────────────────────────────────────────────
export const tuzi = {
  async transactions(): Promise<TuziTransaction[]> {
    if (useMock()) {
      await delay();
      return mockTransactions;
    }
    // /api/stripe/transactions/ is the card-purchase ledger: every row is a
    // BUY that credits 2Zs (tuzis_credited is a PositiveIntegerField, so it is
    // never a debit). Preserve any kind the payload carries and default to
    // "buy" for these purchases rather than blanket-overwriting every row.
    // (The full spend mix — tips/AI/PPV/subscriptions — lives in the /api/events/
    // ledger; ActivityTab scopes its "Total spent" to whatever spend it sees.)
    const page = await request<Paginated<TuziTransaction>>(
      "/api/stripe/transactions/",
    );
    return (page.results ?? []).map((t) => ({ ...t, kind: t.kind ?? "buy" }));
  },

  /**
   * Start a Stripe checkout to buy `tuzis` 2Zs and return the hosted checkout
   * URL to open. The returned URL is treated as untrusted input even though the
   * backend validates it too: only the configured exact Stripe host may leave
   * the app.
   */
  async buyCheckout(
    tuzis: number,
    returnMode: CheckoutReturnMode = "web",
  ): Promise<{ url: string }> {
    if (useMock()) {
      await delay(400);
      return {
        url: validateStripeCheckoutUrl(
          `https://checkout.stripe.com/mock?q=${tuzis}`,
        ),
      };
    }
    const r = await request<{ id?: unknown; url?: unknown }>(
      "/api/stripe/create-checkout-session/",
      {
        method: "POST",
        body: { quantity: tuzis, currentPath: "/wallet/fund", returnMode },
      },
    );
    return { url: validateStripeCheckoutUrl(r?.url) };
  },

  // The recovery loop is only bounded if each request is. Without a deadline a
  // callback host that accepts the connection and then stalls (a deploy, a
  // dependency flap) leaves one status request pending forever: the poll never
  // reaches its final refresh, the code stays deduplicated, and the payer gets
  // no outcome at all until the app restarts.
  async claimCheckoutReturn(code: string): Promise<CheckoutReturnClaim> {
    const value = await request<unknown>("/api/stripe/native-return/claim/", {
      method: "POST",
      body: { code },
      signal: AbortSignal.timeout(NATIVE_RETURN_TIMEOUT_MS),
    });
    return parseCheckoutReturnClaim(value);
  },

  async checkoutReturnStatus(
    statusToken: string,
  ): Promise<CheckoutPaymentStatus> {
    const value = await request<unknown>("/api/stripe/native-return/status/", {
      method: "POST",
      body: { status_token: statusToken },
      signal: AbortSignal.timeout(NATIVE_RETURN_TIMEOUT_MS),
    });
    return parseCheckoutPaymentStatus(value);
  },

  async donateIdempotent(
    username: string,
    tuzis: number,
    idempotencyKey: string,
  ): Promise<DonationResult> {
    if (!isDonationIdempotencyKey(idempotencyKey)) {
      throw new DonationContractError("Donation idempotency key is invalid");
    }
    if (useMock()) {
      await delay(400);
      const prior = mockDonationResults.get(idempotencyKey);
      if (prior) {
        if (prior.username !== username || prior.amount !== tuzis) {
          throw new ApiError(409, "Idempotency key request mismatch", {
            code: "idempotency_mismatch",
          });
        }
        return { ...prior.result, replayed: true };
      }
      if (tuzis > mockUser.tuzis) {
        throw new ApiError(400, "Insufficient funds", {
          code: "insufficient_funds",
          balance: String(mockUser.tuzis),
        });
      }
      mockUser.tuzis -= tuzis;
      const result = { balance: mockUser.tuzis, charged: tuzis, replayed: false };
      mockDonationResults.set(idempotencyKey, { username, amount: tuzis, result });
      return result;
    }
    const response = await request(
      `${IDEMPOTENT_DONATION_ROUTE}/${encodeURIComponent(username)}`,
      {
        method: "POST",
        body: { amount: tuzis },
        headers: { "Idempotency-Key": idempotencyKey },
      },
    );
    return normalizeDonationResult(response, tuzis);
  },
};

// ─── Discovery ───────────────────────────────────────────────────────────────
export const discover = {
  /** Legacy one-page creator lookup used by compact recipient suggestions. */
  async searchCreators(query: string): Promise<SimpleCreator[]> {
    const q = query.trim();
    if (useMock()) {
      await delay(200);
      return mockSearchCreators(q);
    }
    if (!q) return [];
    const page = await request<Paginated<RawCreator>>("/api/creator/", {
      query: { search: q, page_size: 24, ordering: "-total" },
      anonymous: true,
    });
    return (page.results ?? []).map(mapCreator);
  },
};

// ─── Pricing (live 2Z ↔ ZEC) ──────────────────────────────────────
// Live price discovery for the "pay with ZEC" buy path. The backend aggregates
// ZEC/USD across exchanges and computes the exact ZEC to send; the client just
// displays it and NEVER recomputes ZEC from a hardcoded rate. Both endpoints
// are public (AllowAny) — hence `anonymous: true`. On no price the backend
// returns 503; callers must show "unavailable", not a fabricated number.

// A plausible current ZEC/USD used ONLY by mock mode (browser / VITE_MOCK=1) so
// the buy screen renders offline. Deliberately not the old hardcoded $42; the
// real number always comes from /api/pricing.
const MOCK_ZEC_USD = 55;
const MOCK_SPREAD = 0.1;
const MOCK_TUZIS_PER_ZEC = MOCK_ZEC_USD * (1 - MOCK_SPREAD) * 100; // 4950

export const pricing = {
  /**
   * Exact ZEC/card amounts to buy `tuzis` 2Z (GET /api/pricing/quote/?tuzis=N).
   * The backend returns the precise `zec_amount` to send — display it directly.
   */
  async quote(tuzis: number, signal?: AbortSignal): Promise<PricingQuote> {
    if (useMock()) {
      await delay(180);
      const zecAmount = Math.ceil((tuzis / MOCK_TUZIS_PER_ZEC) * 1e8) / 1e8;
      return {
        tuzis,
        zec_amount: zecAmount.toFixed(8),
        card_cents: Math.floor(tuzis * 1.05) + 100,
        tuzis_per_zec: MOCK_TUZIS_PER_ZEC.toFixed(4),
        zec_usd: MOCK_ZEC_USD.toFixed(2),
        updated_at: new Date().toISOString(),
        stale: false,
        bootstrap: false,
      };
    }
    return request<PricingQuote>("/api/pricing/quote/", {
      query: { tuzis },
      anonymous: true,
      signal,
    });
  },
};
