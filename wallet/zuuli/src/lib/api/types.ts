// Domain types for the free2z API, distilled from tuzi/f2z.yaml (the
// generated OpenAPI schema). We hand-model the slice ZUULI uses rather than
// codegen the whole surface, so the types stay small and readable.

export interface SimpleCreator {
  username: string;
  free2zaddr: string; // public page slug
  display_name?: string;
  image?: string | null;
  bio?: string | null;
  /** Optional enrichment the creator list/search returns (CreatorList). */
  is_verified?: boolean;
  /** Number of zpages the creator has published. */
  zpages?: number;
  /** 2Z price for 30 days of membership (null = no paid tier). */
  member_price?: number | null;
  /**
   * Whether this creator is broadcasting a livestream RIGHT NOW — computed
   * server-side from the Dyte live-room state and returned on the creator
   * list/search payload. `undefined` when talking to a backend that predates
   * the field (callers fall back to the live-status probe).
   */
  is_live?: boolean;
}

export interface AuthUser {
  id?: number;
  username: string;
  email?: string;
  free2zaddr?: string;
  display_name?: string;
  image?: string | null;
  /** Own-profile enrichment from GET /api/auth/user/ (owner-only fields). */
  banner?: string | null;
  bio?: string | null; // `description` (markdown, ≤1024 chars)
  /** Zcash address for direct tips (falls back to the account address server-side). */
  p2paddr?: string | null;
  /** 2Z price for 30 days of membership (null = no paid tier). */
  member_price?: number | null;
  can_stream?: boolean;
  is_verified?: boolean;
  /** 2Z (Tuzi) credit balance. */
  tuzis: number;
  /** True when this session authenticated via a Zcash address (no password). */
  zcashLinked?: boolean;
  /**
   * The Zcash t-address linked to this account for authentication (as a DID,
   * `did:zcash:<address>`), if any — set locally after a successful
   * `auth.zcashAssociate()` call. Not yet exposed by GET /api/auth/user/, so
   * this reflects only what THIS session has observed (a fresh login on
   * another device won't see it until the backend surfaces it too).
   */
  zcash_identity?: string | null;
  /**
   * Which social providers this session has observed as linked, set locally
   * after a successful `auth.socialLogin(provider, { associate: true })` —
   * same caveat as `zcash_identity`: GET /api/auth/user/ doesn't echo this
   * back yet, so it only reflects what THIS session has seen.
   */
  social_identities?: Partial<Record<SocialProvider, boolean>>;
}

// ── Social login (X / Google / GitHub) ──────────────────────────────────────
// `dj.apps.social` (knox-native, dual-mode like Login with Zcash): anonymous
// POST logs in/creates an account, POST with a knox token attached links the
// provider identity to the signed-in account instead. See
// `src/lib/oauth/transport.ts` for the desktop loopback transport and
// `auth.socialProviders` / `auth.socialLogin` in `./free2z.ts` for the client.
export const SOCIAL_PROVIDERS = ["x", "google", "github"] as const;

export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

/**
 * The generic AllowAny discovery endpoint reports provider credential truth
 * for web/desktop. Its mobile counterpart additionally requires the exact
 * relay, PKCE support and rollout activation. Buttons render only from the
 * endpoint matching the app's callback transport. Both wire responses are
 * validated and normalized before they reach callers.
 */
export type SocialProvidersStatus = Record<SocialProvider, boolean>;

export type SocialAuthResult =
  | {
      status: "authenticated";
      session: AuthenticatedSession;
      sessionGeneration: number;
    }
  | { status: "associated"; user: AuthUser; sessionGeneration: number };

/** GET /api/otp/status/ — whether the signed-in account has TOTP 2FA enabled. */
export interface OtpStatus {
  enabled: boolean;
}

/**
 * Result of a username/password sign-in. Either the session is fully
 * established, or a second factor (a 6-digit TOTP code) is still required and
 * the caller must finish via `auth.completeOtp`.
 */
export type LoginResult =
  | { status: "complete"; session: AuthenticatedSession }
  | { status: "otp_required"; username: string };

export interface AuthenticatedSession {
  token: string;
  user: AuthUser;
}

// ── Tuzi (2Z) transactions ───────────────────────────────────────────────────
export interface TuziTransaction {
  id: number;
  amount: number; // cents paid
  tuzis_credited: number;
  timestamp: string;
  /**
   * Historical ledger kinds. "subscribe" / "ai" / "ppv" can still appear on
   * past rows even though ZUULI no longer initiates those spends — see
   * `kindMeta` in `src/features/wallet/funding/lib.ts`.
   */
  kind?: "buy" | "donate" | "subscribe" | "ai" | "ppv";
  counterparty?: string;
}

export interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

// ── Pricing (live 2Z ↔ ZEC / card) ───────────────────────────────
// The backend does live ZEC/USD price discovery (tuzi py/dj/apps/pricing) and
// derives every conversion from "1 2Z = $0.01". Decimal money fields come over
// the wire as strings; parse them at the point of use, never store a rate.

/** Exact amounts to buy N 2Z — GET /api/pricing/quote/?tuzis=N. */
export interface PricingQuote {
  tuzis: number;
  zec_amount: string; // ZEC to send (8dp) — display directly, don't recompute
  card_cents: number; // USD cents Stripe would charge
  tuzis_per_zec: string;
  zec_usd: string;
  updated_at: string; // ISO datetime
  stale: boolean;
  bootstrap: boolean;
}
