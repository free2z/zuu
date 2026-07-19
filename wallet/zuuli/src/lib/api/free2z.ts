// The free2z API surface ZUULI uses, mapping the REAL production endpoints
// (tuzi/f2z.yaml / free2z.cash) into stable internal types the features
// depend on. Field names here match production; the returned objects match
// src/lib/api/types.ts so features never need to change when the wire format does.
//
// This module is the CONTRACT every feature imports. Keep the return types stable.

import { useMock } from "../platform";
import { MOCK_OTP } from "../env";
import { usdToTuzis } from "../format";
import { ApiError, basicLogin, mediaUrl, request, setToken } from "./http";
import {
  mockAiReply,
  mockArticleFeed,
  mockArticles,
  mockCreatorDetail,
  mockCreators,
  mockLivestreams,
  mockModels,
  mockSearchCreators,
  mockSearchPages,
  mockTransactions,
  mockUser,
} from "./mock-data";
import type {
  AIModel,
  Article,
  ArticleFeedPage,
  ArticleFeedParams,
  AuthUser,
  CreatorDetail,
  DyteJoinTicket,
  Livestream,
  LoginResult,
  OtpStatus,
  Paginated,
  PricingQuote,
  PricingSnapshot,
  PromptResponse,
  SimpleCreator,
  StreamKind,
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
      return mockUser;
    }
    const u = await request<{
      username: string;
      email?: string;
      full_name?: string;
      p2paddr?: string;
      tuzis?: string;
      avatar_image?: RawImage | null;
    }>("/api/auth/user/");
    return {
      username: u.username,
      email: u.email,
      free2zaddr: u.username,
      display_name: u.full_name || u.username,
      image: mediaUrl(u.avatar_image?.thumbnail || u.avatar_image?.url) ?? null,
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
};

// ─── AI ─────────────────────────────────────────────────────────────────────
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
      return;
    }
    await request(`/api/tuzis/subscribe/${username}`, { method: "POST" });
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
