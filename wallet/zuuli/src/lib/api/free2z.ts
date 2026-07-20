// The free2z API surface ZUULI uses, mapping the REAL production endpoints
// (tuzi/f2z.yaml / free2z.cash) into stable internal types the features
// depend on. Field names here match production; the returned objects match
// src/lib/api/types.ts so features never need to change when the wire format does.
//
// This module is the CONTRACT every feature imports. Keep the return types stable.

import { useMock } from "../platform";
import { MOCK_OTP } from "../env";
import { usdToTuzis } from "../format";
import { captureOAuthCode } from "../oauth/transport";
import { ApiError, basicLogin, mediaUrl, request, setToken } from "./http";
import {
  mockAiReply,
  mockArticleFeed,
  mockArticles,
  mockAssociateZcash,
  mockConversationReply,
  mockCreatePersonality,
  mockCreatorDetail,
  mockCreators,
  mockDeletePersonality,
  mockKycIdentityDocuments,
  mockKycProfile,
  mockKycTaxForm,
  mockLivestreams,
  mockModels,
  mockPersonalities,
  mockSearchCreators,
  mockSearchPages,
  mockSubscribe,
  mockSubscriptions,
  mockTransactions,
  mockUnsubscribe,
  mockUpdatePersonality,
  mockUser,
} from "./mock-data";
import type {
  AIConversation,
  AIModel,
  Article,
  ArticleFeedPage,
  ArticleFeedParams,
  AuthUser,
  CreatorDetail,
  DyteJoinTicket,
  KycIdentityDocType,
  KycIdentityDocuments,
  KycProfile,
  KycProfileInput,
  KycTaxFormFile,
  KycTaxFormSignature,
  KycTaxFormUploadResult,
  Livestream,
  LoginResult,
  OtpStatus,
  Paginated,
  Personality,
  PersonalityInput,
  PricingQuote,
  PricingSnapshot,
  ProfileUpdateInput,
  PromptResponse,
  SimpleCreator,
  SocialProvider,
  SocialProvidersStatus,
  StreamKind,
  Subscription,
  TuziTransaction,
} from "./types";

const delay = (ms = 260) => new Promise((r) => setTimeout(r, ms));

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
}
interface RawZPage {
  free2zaddr: string;
  vanity?: string | null;
  title: string;
  description?: string;
  content?: string;
  category?: string;
  featured_image?: RawImage | null;
  f2z_score?: string;
  created_at?: string;
  publish_at?: string | null;
  creator: RawCreator;
  tags?: string[];
  is_subscriber_only?: boolean;
  get_url?: string;
}
interface RawDyteMeeting {
  id: number;
  creator: RawCreator;
  meeting_id: string;
  meeting_type: string; // broadcast | ppv | subscribers-only | private
  live_now: boolean;
  price_per_minute?: string;
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
  };
}

/** GET /api/creator/{username}/ → the full public CreatorDetail. */
function mapCreatorDetail(c: RawCreator): CreatorDetail {
  return {
    username: c.username,
    free2zaddr: c.username,
    display_name: c.full_name || c.username,
    bio: c.description ?? null,
    image: mediaUrl(c.avatar_image?.card || c.avatar_image?.url) ?? null,
    banner:
      mediaUrl(
        c.banner_image?.banner || c.banner_image?.card || c.banner_image?.url,
      ) ?? null,
    is_verified: c.is_verified ?? false,
    can_stream: c.can_stream ?? false,
    member_price: parsePrice(c.member_price),
    zpages: typeof c.zpages === "number" ? c.zpages : 0,
    total: c.total != null ? Math.round(Number(c.total)) || 0 : 0,
    p2paddr: c.p2paddr ?? null,
  };
}

function readingMinutes(text: string | undefined): number {
  const words = (text || "").split(/\s+/).length;
  return Math.max(1, Math.round(words / 200));
}

function mapArticle(z: RawZPage): Article {
  return {
    id: z.free2zaddr,
    slug: z.vanity || z.free2zaddr,
    free2zaddr: z.free2zaddr,
    title: z.title || "Untitled",
    subtitle: z.description,
    content: z.content || z.description || "",
    image: mediaUrl(z.featured_image?.card || z.featured_image?.url) ?? null,
    category: z.category || undefined,
    author: mapCreator(z.creator),
    votes: z.f2z_score ? Math.round(Number(z.f2z_score)) : 0,
    published_at: z.publish_at || z.created_at,
    reading_minutes: readingMinutes(z.content),
    tags: z.tags ?? [],
  };
}

/** free2z meeting_type → ZUULI StreamKind (and back). */
const KIND_FROM_TYPE: Record<string, StreamKind> = {
  broadcast: "broadcast",
  ppv: "ppv",
  "pay-per-view": "ppv",
  "subscribers-only": "subscriber",
  subscriber: "subscriber",
  private: "private",
};
const TYPE_FROM_KIND: Record<StreamKind, string> = {
  broadcast: "broadcast",
  ppv: "pay-per-view",
  subscriber: "subscribers-only",
  private: "private",
};

/** PPV entry cost the backend enforces: ceil(price_per_minute*30) + 15 fee. */
function ppvPrice(pricePerMinute?: string): number {
  const ppm = Number(pricePerMinute || 0);
  return Math.ceil(ppm * 30) + 15;
}

function mapLivestream(m: RawDyteMeeting): Livestream {
  const kind = KIND_FROM_TYPE[m.meeting_type] ?? "broadcast";
  const creator = mapCreator(m.creator);
  return {
    id: String(m.id),
    username: m.creator.username,
    creator,
    title: `${creator.display_name} is live`,
    kind,
    live: !!m.live_now,
    participants: 0,
    price_tuzis: kind === "ppv" ? ppvPrice(m.price_per_minute) : 0,
    thumbnail: creator.image ?? null,
    started_at: undefined,
    category: undefined,
  };
}

function inferProvider(model: string): AIModel["provider"] {
  const m = model.toLowerCase();
  if (m.includes("gpt") || m.startsWith("o1") || m.startsWith("o3")) return "openai";
  if (m.includes("claude")) return "anthropic";
  if (m.includes("grok")) return "xai";
  if (m.includes("kimi")) return "kimi";
  if (m.includes("gemini")) return "google";
  if (m.includes("llama") || m.includes("mistral") || m.includes("qwen")) return "local";
  return "other";
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
   *   1. `basicLogin` → Knox Basic-auth login (`/api/token/login/`) mints a token.
   *   2. `otpStatus()` (authenticated with that token) reports whether the
   *      account has TOTP 2FA enabled.
   *   3. If 2FA is ON we DROP the token and return `otp_required`, so an
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
      setToken("mock-knox-token");
      return { status: "complete", user: { ...mockUser, username } };
    }
    await basicLogin(username, password); // sets the Knox token
    const { enabled } = await auth.otpStatus();
    if (enabled) {
      setToken(null); // don't persist a session behind an unfinished 2FA prompt
      return { status: "otp_required", username };
    }
    return { status: "complete", user: await auth.me() };
  },

  /** Whether the currently-authenticated account has TOTP 2FA enabled. */
  async otpStatus(): Promise<OtpStatus> {
    if (useMock()) {
      await delay(120);
      return { enabled: false };
    }
    return request<OtpStatus>("/api/otp/status/");
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
  ): Promise<AuthUser> {
    if (useMock()) {
      await delay();
      if (code !== MOCK_OTP_CODE) {
        throw new Error("That code didn't match. (Mock mode expects 123456.)");
      }
      setToken("mock-knox-token");
      return { ...mockUser, username };
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
    await basicLogin(username, password); // establish the real session token
    return auth.me();
  },

  async me(): Promise<AuthUser> {
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
    }>("/api/auth/user/");
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
    if (!useMock()) {
      try {
        await request("/api/token/logout/", { method: "POST" });
      } catch {
        /* best-effort */
      }
    }
    setToken(null);
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
  }): Promise<AuthUser> {
    if (useMock()) {
      await delay(400);
      setToken("mock-knox-token-zcash");
      return { ...mockUser, zcashLinked: true };
    }
    const tok = await request<{ token: string }>("/api/auth/zcash/login/", {
      method: "POST",
      body: params,
      anonymous: true,
    });
    setToken(tok.token);
    const me = await auth.me();
    return { ...me, zcashLinked: true };
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
   * Which social providers (X / Google / GitHub) the backend currently has
   * OAuth client credentials configured for — GET /api/auth/social/providers/
   * (`dj.apps.social`, AllowAny). A provider with no client id/secret set
   * reports `false` and its `/start` and `/{provider}/` endpoints 503.
   *
   * Callers (SocialButtons, LinkedAccounts) render a button ONLY for
   * providers this reports `true` — with nothing configured (the default,
   * and the only state today), every key is `false` and nothing renders.
   * Mock mode mirrors that (all-false) rather than fake a social login.
   */
  async socialProviders(): Promise<SocialProvidersStatus> {
    if (useMock()) {
      await delay(100);
      return { x: false, google: false, github: false };
    }
    return request<SocialProvidersStatus>("/api/auth/social/providers/", {
      anonymous: true,
    });
  },

  /**
   * Ask the backend to build the provider's `authorize_url` (it constructs
   * the PKCE challenge and validates `redirectUri` against its allowlist,
   * which includes `http://127.0.0.1:*` / `http://localhost:*` for the
   * desktop loopback transport) — GET /api/auth/social/{provider}/start.
   * 503s if the provider isn't configured; callers should already have
   * gated the entry point on `socialProviders()`, so that should only ever
   * fire on a race with the backend config changing mid-session.
   */
  async socialStart(
    provider: SocialProvider,
    redirectUri: string,
  ): Promise<{ authorize_url: string; state: string }> {
    return request<{ authorize_url: string; state: string }>(
      `/api/auth/social/${provider}/start`,
      { query: { redirect_uri: redirectUri }, anonymous: true },
    );
  },

  /**
   * Social login / link with a provider (X / Google / GitHub). Runs the
   * OAuth authorization-code round trip over the desktop loopback transport
   * (Tauri) or a web popup fallback (`../oauth/transport.ts`) — the caller
   * never sees which transport ran, only the resolved `AuthUser`.
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
   * NEVER exercised with real credentials yet: `socialProviders()` reports
   * every provider unconfigured, so no button in the app can reach this
   * without the backend owner turning a provider on first.
   */
  async socialLogin(
    provider: SocialProvider,
    opts: { associate?: boolean } = {},
  ): Promise<AuthUser> {
    if (useMock()) {
      throw new Error(
        "Social login isn't available in mock mode — no provider is configured yet.",
      );
    }
    const { code, state, redirectUri } = await captureOAuthCode((redirect) =>
      auth.socialStart(provider, redirect).then((r) => r.authorize_url),
    );
    const body = { code, state, redirect_uri: redirectUri };

    if (opts.associate) {
      try {
        // Deliberately NOT `anonymous: true` — the point is that the request
        // carries `Authorization: Token <knox token>`.
        await request<unknown>(`/api/auth/social/${provider}/`, {
          method: "POST",
          body,
        });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          throw new Error(
            "That account is already linked — either to a different free2z account, or this account already has a linked identity for this provider. Unlink it there first, or use a different account.",
          );
        }
        throw e;
      }
      const me = await auth.me();
      return {
        ...me,
        social_identities: { ...me.social_identities, [provider]: true },
      };
    }

    const tok = await request<{ token: string }>(
      `/api/auth/social/${provider}/`,
      { method: "POST", body, anonymous: true },
    );
    setToken(tok.token);
    const me = await auth.me();
    return {
      ...me,
      social_identities: { ...me.social_identities, [provider]: true },
    };
  },
};

// ─── Profile (self-edit) ─────────────────────────────────────────────────────
export const profile = {
  /**
   * Update the signed-in user's own profile — PATCH /api/auth/user/, backed by
   * `CustomUserDetailsView` → `CreatorProfileUpdateSerializer`
   * (tuzi/py/dj/apps/g12f/{views,serializers}/creator.py). Writable fields used
   * here: `full_name` (display name), `description` (bio, markdown ≤1024
   * chars), `p2paddr` (Zcash tip address), `member_price` (2Z / 30 days, `null`
   * clears the paid tier).
   *
   * Avatar/banner aren't wired yet: the backend takes a `GenericFile` primary
   * key, not a raw image — a creator must first `POST /uploads/single-public`
   * (multipart) and then reference the returned id here as `avatar_image` /
   * `banner_image` (this is what the Svelte web app's settings page does). A
   * follow-up once ZUULI has a general upload flow.
   *
   * Returns the refreshed `AuthUser` (a plain refetch via `auth.me()`, since
   * the PATCH response shape doesn't carry the same mapped fields).
   */
  async update(input: ProfileUpdateInput): Promise<AuthUser> {
    if (useMock()) {
      await delay(400);
      Object.assign(mockUser, {
        ...(input.display_name !== undefined
          ? { display_name: input.display_name }
          : {}),
        ...(input.bio !== undefined ? { bio: input.bio } : {}),
        ...(input.p2paddr !== undefined ? { p2paddr: input.p2paddr } : {}),
        ...(input.member_price !== undefined
          ? { member_price: input.member_price }
          : {}),
      });
      return { ...mockUser };
    }
    const body: Record<string, unknown> = {};
    if (input.display_name !== undefined) body.full_name = input.display_name;
    if (input.bio !== undefined) body.description = input.bio;
    if (input.p2paddr !== undefined) body.p2paddr = input.p2paddr;
    if (input.member_price !== undefined) {
      body.member_price =
        input.member_price === null ? null : String(input.member_price);
    }
    await request("/api/auth/user/", { method: "PATCH", body });
    return auth.me();
  },
};

// ─── AI ─────────────────────────────────────────────────────────────────────

/** Raw shape of PromptResponseSerializer (`__all__` on the PromptResponse model). */
interface RawConversationPromptResponse {
  id: string;
  user_input: string;
  response: string;
  created_at?: string;
  ai_model?: { display_name?: string } | null;
  personality?: { display_name?: string } | null;
}

function normalizeConversationReply(
  raw: RawConversationPromptResponse,
  fallbackModelName: string,
): PromptResponse {
  return {
    id: raw.id,
    prompt: raw.user_input,
    response: raw.response,
    model: raw.ai_model?.display_name ?? fallbackModelName,
    personality: raw.personality?.display_name,
    created_at: raw.created_at,
    // The backend doesn't return per-message token/cost breakdown on this
    // endpoint — callers sync the real charge from the account balance
    // (`auth.me().tuzis`) instead of guessing it here.
  };
}

export const ai = {
  async models(): Promise<AIModel[]> {
    if (useMock()) {
      await delay();
      return mockModels;
    }
    const page = await request<Paginated<AIModel>>("/api/ai/models/", {
      query: { page_size: 48 },
      anonymous: true,
    });
    return (page.results ?? []).map((m) => ({
      ...m,
      provider: inferProvider(m.model),
    }));
  },

  /**
   * Send a prompt through the free2z proxy — the provider never sees the user.
   * Uses /api/openai/prompt (flat 1-2Z charge, real answer). Full multi-model
   * token metering runs over the conversation websocket (a follow-up).
   */
  async prompt(args: {
    model: AIModel;
    prompt: string;
    conversationId?: string;
    signal?: AbortSignal;
  }): Promise<PromptResponse> {
    if (useMock()) {
      await delay(700);
      return mockAiReply(args.prompt, args.model.display_name);
    }
    const answer = await request<string>("/api/openai/prompt", {
      method: "POST",
      body: { prompt: args.prompt, model: args.model.model },
      signal: args.signal,
    });
    return {
      id: `pr-${Date.now()}`,
      prompt: args.prompt,
      response: typeof answer === "string" ? answer : String(answer),
      model: args.model.display_name,
      created_at: new Date().toISOString(),
      tuzis_charged: 1,
    };
  },

  /**
   * Custom system messages a user can create, edit, share (`is_public`) and
   * select to prime the AI. Full CRUD over `/api/ai/personalities/`
   * (DRF ModelViewSet, `IsAuthenticatedOrReadOnly`): GET lists your own plus
   * public personalities; POST/PATCH/DELETE only ever touch your own.
   */
  personalities: {
    async list(): Promise<Personality[]> {
      if (useMock()) {
        await delay();
        return [...mockPersonalities];
      }
      const page = await request<Paginated<Personality>>(
        "/api/ai/personalities/",
        { query: { page_size: 100 }, anonymous: true },
      );
      return page.results ?? [];
    },

    async create(input: PersonalityInput): Promise<Personality> {
      if (useMock()) {
        await delay();
        return mockCreatePersonality(input);
      }
      return request<Personality>("/api/ai/personalities/", {
        method: "POST",
        body: input,
      });
    },

    async update(
      id: string,
      input: Partial<PersonalityInput>,
    ): Promise<Personality> {
      if (useMock()) {
        await delay();
        return mockUpdatePersonality(id, input);
      }
      return request<Personality>(`/api/ai/personalities/${id}/`, {
        method: "PATCH",
        body: input,
      });
    },

    async delete(id: string): Promise<void> {
      if (useMock()) {
        await delay();
        mockDeletePersonality(id);
        return;
      }
      await request<void>(`/api/ai/personalities/${id}/`, {
        method: "DELETE",
      });
    },
  },

  /**
   * Stateful chat threads (`/api/ai/conversations/`). This is the path that
   * actually applies a personality's `system_message` to the model: the
   * flat `ai.prompt()` above (`/api/openai/prompt`) is a fixed legacy
   * endpoint that ignores both the model and any personality. A
   * conversation pins one `ai_model` + optional `personality` for its
   * lifetime; the backend replays every prior turn as history, so real
   * multi-turn memory is a side benefit of wiring this up.
   */
  conversations: {
    async create(args: {
      displayName: string;
      model: AIModel;
      personality?: Personality | null;
    }): Promise<AIConversation> {
      if (useMock()) {
        await delay(200);
        return {
          id: `conv-mock-${Date.now()}`,
          display_name: args.displayName,
          ai_model: args.model.id,
          personality: args.personality?.id ?? null,
          model_name: args.model.display_name,
        };
      }
      const body: Record<string, unknown> = {
        display_name: args.displayName,
        ai_model: args.model.id,
      };
      if (args.personality) body.personality = args.personality.id;
      return request<AIConversation>("/api/ai/conversations/", {
        method: "POST",
        body,
      });
    },

    /**
     * Post a turn to an existing conversation. Streams over a websocket on
     * the backend, but this also resolves synchronously with the full
     * reply, so callers that don't need live word-by-word streaming (e.g.
     * this PR's chat UI) can just await it.
     */
    async sendMessage(args: {
      conversationId: string;
      userInput: string;
      model: AIModel;
      personality?: Personality | null;
      signal?: AbortSignal;
    }): Promise<PromptResponse> {
      if (useMock()) {
        await delay(700);
        return mockConversationReply(
          args.userInput,
          args.model.display_name,
          args.personality ?? null,
        );
      }
      const raw = await request<RawConversationPromptResponse>(
        `/api/ai/conversations/${args.conversationId}/promptresponses/`,
        {
          method: "POST",
          body: { user_input: args.userInput },
          signal: args.signal,
        },
      );
      return normalizeConversationReply(raw, args.model.display_name);
    },
  },
};

/** Estimate the 2Z cost of an exchange, cost-plus and rounded up. */
export function estimateTuzis(
  model: AIModel,
  inputTokens: number,
  outputTokens: number,
): number {
  const markup = Number(model.markup) || 1;
  const usd =
    (Number(model.input_price) * inputTokens +
      Number(model.output_price) * outputTokens) *
    markup;
  return usdToTuzis(usd);
}

// ─── Articles (zpage) ────────────────────────────────────────────────────────
export const articles = {
  /**
   * A page of the article feed (zpages). Supports the full backend contract on
   * GET /api/zpage/: DRF PageNumber pagination (`?page=&page_size=`), ranking
   * (`?homeSort=`, default **`popular`** = recency-decayed "fresh"), AND-filtered
   * tags (`?tags=a,b`), semantic vector search (`?search=`) and `?category=`.
   *
   * Returns `{ items, next, count }` where `next` is the next page number (or
   * `null` at the end), so callers can drive infinite scroll without touching
   * the raw `next` URL. Mock mode paginates/filters the fixtures the same way.
   */
  async feed(params: ArticleFeedParams = {}): Promise<ArticleFeedPage> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 24;
    const sort = params.sort ?? "popular";
    const tags = params.tags?.filter(Boolean) ?? [];
    const search = params.search?.trim() || undefined;

    if (useMock()) {
      await delay();
      return mockArticleFeed({
        sort,
        tags,
        search,
        category: params.category,
        page,
        pageSize,
      });
    }
    const res = await request<Paginated<RawZPage>>("/api/zpage/", {
      query: {
        page,
        page_size: pageSize,
        homeSort: sort,
        tags: tags.length ? tags.join(",") : undefined,
        search,
        category: params.category,
      },
      anonymous: true,
    });
    return {
      items: (res.results ?? []).map(mapArticle),
      next: res.next ? page + 1 : null,
      count: res.count ?? 0,
    };
  },

  async get(idOrSlug: string | number): Promise<Article> {
    if (useMock()) {
      await delay(150);
      const a = mockArticles.find(
        (x) => x.slug === idOrSlug || String(x.id) === String(idOrSlug),
      );
      if (!a) throw new Error("Article not found");
      return a;
    }
    const z = await request<RawZPage>(`/api/zpage/${idOrSlug}/`, {
      anonymous: true,
    });
    return mapArticle(z);
  },

  async publish(input: {
    title: string;
    subtitle?: string;
    content: string;
    category?: string;
  }): Promise<Article> {
    if (useMock()) {
      await delay(500);
      return { ...mockArticles[0], ...input, id: `${Date.now()}`, slug: undefined };
    }
    const z = await request<RawZPage>("/api/zpage/", {
      method: "POST",
      body: {
        title: input.title,
        description: input.subtitle || "",
        content: input.content,
        category: input.category || "",
        is_published: true,
      },
    });
    return mapArticle(z);
  },
};

// ─── Livestreams (dyte) ──────────────────────────────────────────────────────

// Client-side cache for the public livestream listing. Discovery polls every
// 15s, and the Room + home LiveRail each read the listing on entry — without a
// cache, every visit re-hammers the API. A short TTL keeps the grid fresh while
// collapsing bursts, and a shared in-flight promise dedupes concurrent callers
// so simultaneous mounts issue a single request instead of a fanout.
const LISTING_TTL_MS = 10_000;
let listingCache: { at: number; data: Livestream[] } | null = null;
let listingInFlight: Promise<Livestream[]> | null = null;

export const live = {
  /**
   * Public livestream listing. Served from a short-lived client cache (TTL) so
   * navigating to/around Livestreams doesn't re-hammer the backend.
   *
   * The `/api/dyte/public/` list endpoint already carries `live_now` per
   * meeting, so a single request answers "who is available" — we trust that
   * flag instead of fanning out one `/live-status` probe per creator, which was
   * an O(creators) N+1 that made the tab spin. Pass `{ force: true }` to bypass
   * the cache (e.g. a manual refresh).
   */
  async listPublic(opts?: { force?: boolean }): Promise<Livestream[]> {
    if (useMock()) {
      await delay();
      return mockLivestreams;
    }
    const fresh =
      !opts?.force &&
      listingCache &&
      Date.now() - listingCache.at < LISTING_TTL_MS;
    if (fresh) return listingCache!.data;
    // Coalesce concurrent callers onto one request.
    if (listingInFlight) return listingInFlight;

    listingInFlight = (async () => {
      const page = await request<Paginated<RawDyteMeeting>>(
        "/api/dyte/public/",
        { query: { page_size: 48 }, anonymous: true, cache: "no-store" },
      );
      const streams = (page.results ?? [])
        .map(mapLivestream)
        .filter((stream) => stream.live);
      listingCache = { at: Date.now(), data: streams };
      return streams;
    })();
    try {
      return await listingInFlight;
    } finally {
      listingInFlight = null;
    }
  },

  async status(
    username: string,
    kind?: StreamKind,
  ): Promise<{ live: boolean; participants: number }> {
    if (useMock()) {
      await delay(120);
      const s = mockLivestreams.find((l) => l.username === username);
      return { live: s?.live ?? false, participants: s?.participants ?? 0 };
    }
    try {
      const s = await request<
        Record<string, { meeting_type?: string; participants?: number }>
      >(
        `/api/dyte/${username}/live-status`,
        { anonymous: true, cache: "no-store" },
      );
      const expectedType = kind ? TYPE_FROM_KIND[kind] : undefined;
      const entries = Object.entries(s || {})
        .filter(
          ([key, entry]) =>
            !expectedType ||
            key === expectedType ||
            entry.meeting_type === expectedType,
        )
        .map(([, entry]) => entry);
      const participants = entries.reduce((n, e) => n + (e.participants ?? 0), 0);
      return { live: entries.length > 0, participants };
    } catch {
      return { live: false, participants: 0 };
    }
  },

  /** Creator starts/ensures their stream; returns the Dyte host join ticket. */
  async start(kind: StreamKind): Promise<DyteJoinTicket> {
    if (useMock()) {
      await delay(500);
      return { authToken: "mock-host", meetingId: "mock", roomName: "zuuli-live", as: "host" };
    }
    const me = await auth.me();
    const r = await request<{ meeting_id: string; auth_token: string }>(
      `/api/dyte/${me.username}/${TYPE_FROM_KIND[kind]}`,
      { method: "POST" },
    );
    // A new live meeting just changed the availability set; drop the cached
    // listing so the next Discovery/LiveRail read reflects it.
    listingCache = null;
    return { authToken: r.auth_token, meetingId: r.meeting_id, as: "host" };
  },

  /**
   * Join a stream. For PPV/subscriber streams the backend debits 2Zs / checks
   * entitlement before returning a ticket; a 402 means "buy more 2Zs / subscribe".
   *
   * Private streams are gated by a server-issued secret that the viewer must
   * supply. They join at a DISTINCT endpoint — POST /api/dyte/{username}/private/{secret}
   * (a UUID path segment) — where the backend 404s a wrong/absent secret; the
   * plain POST /api/dyte/{username}/private route only lets the creator manage
   * their room. All other kinds go to POST /api/dyte/{username}/{type}.
   */
  async join(
    username: string,
    kind: StreamKind,
    secret?: string,
  ): Promise<DyteJoinTicket> {
    if (useMock()) {
      await delay(600);
      if (kind === "private" && !mockSecretUnlocks(secret)) {
        throw new Error(
          `That secret didn't unlock the room. (Mock mode expects "${MOCK_ROOM_SECRET}".)`,
        );
      }
      return { authToken: "mock-part", meetingId: "mock", roomName: "zuuli-live", as: "participant" };
    }
    const path =
      kind === "private"
        ? `/api/dyte/${username}/private/${encodeURIComponent((secret ?? "").trim())}`
        : `/api/dyte/${username}/${TYPE_FROM_KIND[kind]}`;
    // The private-join response omits meeting_id (returns { e2ee, auth_token }).
    const r = await request<{ meeting_id?: string; auth_token: string }>(path, {
      method: "POST",
    });
    return { authToken: r.auth_token, meetingId: r.meeting_id ?? "", as: "participant" };
  },
};

/** Mock private-room secret so the private-join gate is demoable offline. */
const MOCK_ROOM_SECRET = "let-me-in";
function mockSecretUnlocks(secret?: string): boolean {
  return (secret ?? "").trim().toLowerCase() === MOCK_ROOM_SECRET;
}

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
   * URL to open. The backend must return the session `url` (a one-line add to
   * ztripe's create_checkout_session, which today returns only the session id).
   */
  async buyCheckout(tuzis: number): Promise<{ url: string }> {
    if (useMock()) {
      await delay(400);
      return { url: `https://checkout.stripe.com/mock?q=${tuzis}` };
    }
    const r = await request<{ id: string; url?: string }>(
      "/api/stripe/create-checkout-session/",
      { method: "POST", body: { quantity: tuzis, currentPath: "/buy" } },
    );
    if (!r.url) {
      throw new Error(
        "Checkout URL unavailable — have the backend return session.url from create_checkout_session.",
      );
    }
    return { url: r.url };
  },

  async donate(username: string, tuzis: number): Promise<void> {
    if (useMock()) {
      await delay(400);
      return;
    }
    await request(`/api/tuzis/donate/${username}`, {
      method: "POST",
      body: { amount: tuzis },
    });
  },

  async subscribe(username: string): Promise<void> {
    if (useMock()) {
      await delay(400);
      mockSubscribe(username);
      return;
    }
    await request(`/api/tuzis/subscribe/${username}`, { method: "POST" });
  },

  /**
   * The CURRENT user's active memberships — GET /api/tuzis/my-subscriptions.
   * The backend has no "am I subscribed to creator X" flag on
   * `GET /api/creator/{username}/` (CreatorDetailSerializer carries only
   * `member_price`, not a per-viewer status), and `/api/tuzis/my-subscribers`
   * is the inverse (who subscribes to the SIGNED-IN creator, not who the
   * signed-in user subscribes to). This is the one real endpoint that answers
   * "am I subscribed, and to whom": it's already scoped to `fan=request.user`
   * and filtered server-side to `expires__gt=now`, so every row here is a
   * live membership. Callers match on `star.username` to find the status for
   * a specific creator.
   */
  async mySubscriptions(): Promise<Subscription[]> {
    if (useMock()) {
      await delay(150);
      return [...mockSubscriptions];
    }
    const page = await request<Paginated<Subscription>>(
      "/api/tuzis/my-subscriptions",
    );
    return page.results ?? [];
  },

  /**
   * Cancel auto-renewal — DELETE /api/tuzis/subscribe/{username}. Mirrors the
   * backend exactly: this sets `max_price` to 0 so the membership won't
   * recur, it does NOT revoke access already paid for. The membership stays
   * active (and keeps showing in `mySubscriptions`) until `expires`.
   */
  async unsubscribe(username: string): Promise<void> {
    if (useMock()) {
      await delay(300);
      mockUnsubscribe(username);
      return;
    }
    await request(`/api/tuzis/subscribe/${username}`, { method: "DELETE" });
  },
};

// ─── Discovery ───────────────────────────────────────────────────────────────
export const discover = {
  async creators(): Promise<SimpleCreator[]> {
    if (useMock()) {
      await delay(120);
      return mockCreators;
    }
    const page = await request<Paginated<RawCreator>>("/api/creator/", {
      query: { page_size: 24, homeSort: "random" },
      anonymous: true,
    });
    return (page.results ?? []).map(mapCreator);
  },

  /**
   * Full-corpus creator search — GET /api/creator/?search=<q>. The backend
   * matches `username` + `full_name` (DRF SearchFilter) and (for the list
   * action) only surfaces creators that have both an avatar and a banner.
   * Public, no auth. Ordered by popularity (`-total`) by default.
   */
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

  /** GET /api/creator/{username}/ → the data-driven public creator profile. */
  async creator(username: string): Promise<CreatorDetail> {
    if (useMock()) {
      await delay(180);
      return mockCreatorDetail(username);
    }
    const c = await request<RawCreator>(
      `/api/creator/${encodeURIComponent(username)}/`,
      { anonymous: true },
    );
    return mapCreatorDetail(c);
  },

  /** A creator's published zpages — GET /api/zpage/?username=<username>. */
  async creatorPages(username: string): Promise<Article[]> {
    if (useMock()) {
      await delay(160);
      return mockArticles.filter(
        (a) => a.author.username.toLowerCase() === username.toLowerCase(),
      );
    }
    const page = await request<Paginated<RawZPage>>("/api/zpage/", {
      query: { username, page_size: 12, ordering: "-created_at" },
      anonymous: true,
    });
    return (page.results ?? []).map(mapArticle);
  },

  /**
   * Full-corpus page (zpage) search — GET /api/zpage/?search=<q>. The backend's
   * VectorSearchFilter does semantic ranking (OpenAI embeddings + pgvector)
   * when a key is present, and falls back to Postgres full-text search
   * otherwise. Public, no auth.
   */
  async searchPages(query: string): Promise<Article[]> {
    const q = query.trim();
    if (useMock()) {
      await delay(220);
      return mockSearchPages(q);
    }
    if (!q) return [];
    const page = await request<Paginated<RawZPage>>("/api/zpage/", {
      query: { search: q, page_size: 24 },
      anonymous: true,
    });
    return (page.results ?? []).map(mapArticle);
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
  /** Current pricing snapshot (GET /api/pricing/). Public, no auth. */
  async current(): Promise<PricingSnapshot> {
    if (useMock()) {
      await delay(120);
      return {
        zec_usd: MOCK_ZEC_USD.toFixed(2),
        spread: MOCK_SPREAD.toFixed(2),
        tuzis_per_zec: MOCK_TUZIS_PER_ZEC.toFixed(4),
        tuzi_per_usd: 100,
        usd_per_tuzi: "0.01",
        num_sources: 4,
        sources: {
          kraken: (MOCK_ZEC_USD - 0.12).toFixed(2),
          coinbase: (MOCK_ZEC_USD + 0.08).toFixed(2),
          binance: (MOCK_ZEC_USD - 0.05).toFixed(2),
          gemini: (MOCK_ZEC_USD + 0.11).toFixed(2),
        },
        updated_at: new Date().toISOString(),
        stale: false,
        bootstrap: false,
        card: { percent_fee: "0.05", flat_fee_cents: 100 },
      };
    }
    return request<PricingSnapshot>("/api/pricing/", { anonymous: true });
  },

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

// ─── KYC / creator revenue-share application ─────────────────────────────────
// `dj.apps.kyc` (tuzi/py/dj/apps/kyc), mounted at /api/kyc/. This is the
// APPLICATION flow only — an applicant supplies basic tax-residency info,
// identity documents, and an e-signed tax form, then advances
// application_status from NEW to PENDING for review. There is no payout /
// cash-out surface yet (that backend doesn't exist); APPROVED only unlocks
// whatever the platform wires up later.
//
// The generated OpenAPI schema (tuzi/py/dj/free2z/openapi/f2z.yaml) documents
// every /api/kyc/* operation with only a bare 200/204 and no request/response
// body — so every shape below is confirmed instead against the working
// reference client already talking to this backend:
// ts/react/free2z/src/components/KYC{BasicInfoStep,TaxFormStep,TaxForm,
// ElectronicSignature,Identity,LivePhotoCapture,Page}.tsx and
// RevenueShareLink.tsx.
export const kyc = {
  /** GET /api/kyc/user-profile → `{ is_us, is_individual, application_status }`. */
  async getProfile(): Promise<KycProfile> {
    if (useMock()) {
      await delay(150);
      return { ...mockKycProfile };
    }
    return request<KycProfile>("/api/kyc/user-profile");
  },

  /** POST /api/kyc/user-profile — the "basic info" step (tax residency / entity type). */
  async saveProfile(input: KycProfileInput): Promise<KycProfile> {
    if (useMock()) {
      await delay(300);
      Object.assign(mockKycProfile, input);
      return { ...mockKycProfile };
    }
    return request<KycProfile>("/api/kyc/user-profile", {
      method: "POST",
      body: input,
    });
  },

  /** GET /api/kyc/identity-documents → `{ id_front_url, id_back_url, additional_document_url, live_photo_url }`. */
  async getIdentityDocuments(): Promise<KycIdentityDocuments> {
    if (useMock()) {
      await delay(150);
      return { ...mockKycIdentityDocuments };
    }
    return request<KycIdentityDocuments>("/api/kyc/identity-documents");
  },

  /**
   * POST /api/kyc/identity-documents (multipart) — the file field name IS the
   * doc type (`id_front` / `id_back` / `additional_document` / `live_photo`).
   * Refetches the full set afterward since the endpoint doesn't echo it back.
   */
  async uploadIdentityDocument(
    docType: KycIdentityDocType,
    file: File,
  ): Promise<KycIdentityDocuments> {
    if (useMock()) {
      await delay(500);
      mockKycIdentityDocuments[`${docType}_url`] = URL.createObjectURL(file);
      return { ...mockKycIdentityDocuments };
    }
    const form = new FormData();
    form.append(docType, file);
    await request("/api/kyc/identity-documents", {
      method: "POST",
      body: form,
    });
    return kyc.getIdentityDocuments();
  },

  /** DELETE /api/kyc/identity-documents — body `{ doc_type }`. */
  async deleteIdentityDocument(docType: KycIdentityDocType): Promise<void> {
    if (useMock()) {
      await delay(200);
      delete mockKycIdentityDocuments[`${docType}_url`];
      return;
    }
    await request("/api/kyc/identity-documents", {
      method: "DELETE",
      body: { doc_type: docType },
    });
  },

  /** GET /api/kyc/get-tax-form-file → `{ file }` (null until one is uploaded). */
  async getTaxFormFile(): Promise<KycTaxFormFile> {
    if (useMock()) {
      await delay(150);
      return { file: mockKycTaxForm.file_url };
    }
    return request<KycTaxFormFile>("/api/kyc/get-tax-form-file");
  },

  /** POST /api/kyc/upload-tax-form (multipart, field `file`) → `{ file_url }`. */
  async uploadTaxForm(file: File): Promise<KycTaxFormUploadResult> {
    if (useMock()) {
      await delay(500);
      const url = URL.createObjectURL(file);
      mockKycTaxForm.file_url = url;
      return { file_url: url };
    }
    const form = new FormData();
    form.append("file", file);
    return request<KycTaxFormUploadResult>("/api/kyc/upload-tax-form", {
      method: "POST",
      body: form,
    });
  },

  /** DELETE /api/kyc/delete-tax-form — no body. */
  async deleteTaxForm(): Promise<void> {
    if (useMock()) {
      await delay(200);
      mockKycTaxForm.file_url = null;
      return;
    }
    await request("/api/kyc/delete-tax-form", { method: "DELETE" });
  },

  /** GET /api/kyc/tax-form-signature → `{ tax_form_signature }`. */
  async getTaxFormSignature(): Promise<KycTaxFormSignature> {
    if (useMock()) {
      await delay(150);
      return { tax_form_signature: mockKycTaxForm.tax_form_signature };
    }
    return request<KycTaxFormSignature>("/api/kyc/tax-form-signature");
  },

  /** POST /api/kyc/tax-form-signature — body `{ tax_form_signature }` (the typed full legal name). */
  async signTaxForm(signature: string): Promise<void> {
    if (useMock()) {
      await delay(300);
      mockKycTaxForm.tax_form_signature = signature;
      return;
    }
    await request("/api/kyc/tax-form-signature", {
      method: "POST",
      body: { tax_form_signature: signature },
    });
  },

  /**
   * POST /api/kyc/change-status — no body; the backend advances the workflow
   * itself (NEW → PENDING on submit; APPROVED → NEW if a creator reopens their
   * application to revise + resubmit — mirrors RevenueShareLink.tsx).
   */
  async submit(): Promise<void> {
    if (useMock()) {
      await delay(400);
      mockKycProfile.application_status =
        mockKycProfile.application_status === "APPROVED" ? "NEW" : "PENDING";
      return;
    }
    await request("/api/kyc/change-status", { method: "POST" });
  },
};
