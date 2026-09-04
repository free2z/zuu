// The free2z API surface ZUULI uses, mapping the REAL production endpoints
// (tuzi/f2z.yaml / free2z.cash) into stable internal types the features
// depend on. Field names here match production; the returned objects match
// src/lib/api/types.ts so features never need to change when the wire format does.
//
// This module is the CONTRACT every feature imports. Keep the return types stable.

import { useMock } from "../platform";
import { MOCK_OTP } from "../env";
import { usdToTuzis } from "../format";
import { normalizeArticleTags, sanitizeArticleTags } from "../article-tags";
import { normalizePrivateSecret } from "../private-live";
import {
  normalizeParticipantCount,
  sumParticipantCounts,
} from "../participant-count";
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
  mockAiReply,
  mockArticleFeed,
  mockArticles,
  mockAssociateZcash,
  mockConversationReply,
  mockCommentCreate,
  mockCommentReplies,
  mockCommentReplyCreate,
  mockCommentVote,
  mockComments,
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
  ArticleTagSuggestion,
  AuthUser,
  Comment,
  CommentContentType,
  CommentInput,
  CommentVote,
  CreatorDetail,
  CreatorPagesPage,
  DyteJoinTicket,
  KycIdentityDocType,
  KycIdentityDocuments,
  KycProfile,
  KycProfileInput,
  KycTaxFormFile,
  KycTaxFormSignature,
  KycTaxFormUploadResult,
  Livestream,
  LiveStartResult,
  LoginResult,
  AuthenticatedSession,
  OtpStatus,
  Paginated,
  Personality,
  PersonalityInput,
  PricingQuote,
  PricingSnapshot,
  ProfileUpdateInput,
  PromptResponse,
  SearchResultPage,
  SimpleCreator,
  SocialProvider,
  SocialAuthResult,
  SocialProvidersStatus,
  StreamKind,
  SubscribeResult,
  Subscription,
  SubscriptionStatus,
  TuziTransaction,
} from "./types";
import { validateStripeCheckoutUrl } from "./checkout";
import { parseJoinTicketResponse } from "./live-ticket";
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
  meeting_type: unknown;
  live_now: boolean;
  price_per_minute?: unknown;
}

// ─── Mappers ────────────────────────────────────────────────────────────────

/** Decimal money fields arrive as strings; parse to a whole 2Z or null. */
function parsePrice(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDecimalString(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`Malformed membership response: ${field}.`);
  }
  return value;
}

function parseNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`Malformed membership response: ${field}.`);
  }
  return value;
}

function parseSubscription(value: unknown): Subscription {
  if (!isRecord(value) || !isRecord(value.fan) || !isRecord(value.star)) {
    throw new Error("Malformed membership response: subscription.");
  }
  const fanUsername = value.fan.username;
  const starUsername = value.star.username;
  if (typeof fanUsername !== "string" || typeof starUsername !== "string") {
    throw new Error("Malformed membership response: subscriber identity.");
  }
  const expires = value.expires;
  const maxPrice = value.max_price;
  if (expires !== undefined && typeof expires !== "string") {
    throw new Error("Malformed membership response: expires.");
  }
  if (maxPrice !== undefined && typeof maxPrice !== "string") {
    throw new Error("Malformed membership response: max_price.");
  }
  return {
    fan: {
      ...(value.fan as unknown as SimpleCreator),
      username: fanUsername,
      free2zaddr:
        typeof value.fan.p2paddr === "string" && value.fan.p2paddr
          ? value.fan.p2paddr
          : fanUsername,
    },
    star: {
      ...(value.star as unknown as SimpleCreator),
      username: starUsername,
      free2zaddr:
        typeof value.star.p2paddr === "string" && value.star.p2paddr
          ? value.star.p2paddr
          : starUsername,
    },
    expires,
    max_price: maxPrice,
  };
}

/** Runtime validator used before trusting any paginated entitlement data. */
export function parseSubscriptionPage(
  value: unknown,
): Paginated<Subscription> {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new Error("Malformed membership pagination response.");
  }
  if (!Number.isSafeInteger(value.count) || Number(value.count) < 0) {
    throw new Error("Malformed membership pagination count.");
  }
  const next = value.next;
  const previous = value.previous;
  if (next !== null && typeof next !== "string") {
    throw new Error("Malformed membership pagination next link.");
  }
  if (previous !== null && typeof previous !== "string") {
    throw new Error("Malformed membership pagination previous link.");
  }
  return {
    count: Number(value.count),
    next,
    previous,
    results: value.results.map(parseSubscription),
  };
}

/**
 * Collect a validated management-list snapshot. Money decisions use the
 * target-specific status endpoint instead, so offset pagination can never
 * authorize a purchase.
 */
export async function collectSubscriptionPages(
  loadPage: (page: number, pageSize: number) => Promise<unknown>,
): Promise<Subscription[]> {
  const endpoint = "/api/tuzis/my-subscriptions";
  const pageSize = 48;
  const subscriptions: Subscription[] = [];
  const seenPages = new Set<number>();
  const seenMemberships = new Set<string>();
  let expectedCount: number | null = null;
  let pageNumber = 1;

  for (;;) {
    if (seenPages.has(pageNumber)) {
      throw new Error("Membership pagination repeated a page.");
    }
    seenPages.add(pageNumber);

    const page = parseSubscriptionPage(await loadPage(pageNumber, pageSize));
    if (pageNumber === 1) expectedCount = page.count;
    if (page.count !== expectedCount) {
      throw new Error("Membership pagination changed during the read.");
    }
    for (const subscription of page.results) {
      const identity = subscription.star.username.toLowerCase();
      if (seenMemberships.has(identity)) {
        throw new Error("Membership pagination returned a duplicate row.");
      }
      seenMemberships.add(identity);
      subscriptions.push(subscription);
    }
    if (!page.next) {
      if (subscriptions.length !== expectedCount) {
        throw new Error("Membership pagination returned an incomplete snapshot.");
      }
      return subscriptions;
    }

    const nextUrl = new URL(page.next, "http://localhost");
    if (nextUrl.pathname !== endpoint) {
      throw new Error("Membership pagination left its endpoint.");
    }
    const nextPage = Number(nextUrl.searchParams.get("page"));
    if (!Number.isSafeInteger(nextPage) || nextPage <= pageNumber) {
      throw new Error("Membership pagination returned an invalid next page.");
    }
    pageNumber = nextPage;
  }
}

export function parseSubscriptionStatus(value: unknown): SubscriptionStatus {
  if (
    !isRecord(value) ||
    typeof value.username !== "string" ||
    typeof value.active !== "boolean"
  ) {
    throw new Error("Malformed membership status response.");
  }
  return {
    username: value.username,
    active: value.active,
    expires: parseNullableString(value.expires, "expires"),
    max_price:
      value.max_price === null
        ? null
        : parseDecimalString(value.max_price, "max_price"),
    current_price:
      value.current_price === null
        ? null
        : parseDecimalString(value.current_price, "current_price"),
  };
}

export function parseSubscribeResult(value: unknown): SubscribeResult {
  if (
    !isRecord(value) ||
    typeof value.charged !== "boolean" ||
    typeof value.replayed !== "boolean" ||
    typeof value.expires !== "string"
  ) {
    throw new Error("Malformed confirmed membership response.");
  }
  return {
    balance: parseDecimalString(value.balance, "balance"),
    charged: value.charged,
    replayed: value.replayed,
    expires: value.expires,
    subscription: parseSubscription(value.subscription),
  };
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
    // Preserve `undefined` (older backend) vs `false` (confirmed offline) so
    // the creator screen can fall back to a live-status probe only when the
    // payload genuinely can't tell it.
    is_live: c.is_live,
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
    tags: sanitizeArticleTags(Array.isArray(z.tags) ? z.tags : []),
  };
}

function parseSearchCursor(
  value: unknown,
  endpoint: "/api/creator/" | "/api/zpage/",
  query: string,
  currentPage: number,
  pageSize: number,
  ordering?: string,
): number | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error("Malformed search pagination next link.");
  }

  const nextUrl = new URL(value, "http://localhost");
  if (nextUrl.pathname !== endpoint) {
    throw new Error("Search pagination left its endpoint.");
  }
  if (nextUrl.searchParams.get("search") !== query) {
    throw new Error("Search pagination changed its query.");
  }
  if (nextUrl.searchParams.get("page_size") !== String(pageSize)) {
    throw new Error("Search pagination changed its page size.");
  }
  if (ordering && nextUrl.searchParams.get("ordering") !== ordering) {
    throw new Error("Search pagination changed its ordering.");
  }
  const next = Number(nextUrl.searchParams.get("page"));
  if (!Number.isSafeInteger(next) || next !== currentPage + 1) {
    throw new Error("Search pagination returned an invalid next page.");
  }
  return next;
}

function parseSearchEnvelope(value: unknown): {
  count: number;
  next: unknown;
  results: unknown[];
} {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new Error("Malformed search pagination response.");
  }
  if (!Number.isSafeInteger(value.count) || Number(value.count) < 0) {
    throw new Error("Malformed search pagination count.");
  }
  if (value.previous !== null && typeof value.previous !== "string") {
    throw new Error("Malformed search pagination previous link.");
  }
  return {
    count: Number(value.count),
    next: value.next,
    results: value.results,
  };
}

/** Runtime validator for the creator half of global Search. */
export function parseCreatorSearchPage(
  value: unknown,
  query: string,
  currentPage: number,
  pageSize: number,
): SearchResultPage<SimpleCreator> {
  const envelope = parseSearchEnvelope(value);
  const items = envelope.results.map((row) => {
    if (!isRecord(row) || typeof row.username !== "string" || !row.username) {
      throw new Error("Malformed creator search result identity.");
    }
    return mapCreator(row as unknown as RawCreator);
  });
  return {
    count: envelope.count,
    next: parseSearchCursor(
      envelope.next,
      "/api/creator/",
      query,
      currentPage,
      pageSize,
      "-total",
    ),
    items,
  };
}

/** Runtime validator for the zpage half of global Search. */
export function parsePageSearchPage(
  value: unknown,
  query: string,
  currentPage: number,
  pageSize: number,
): SearchResultPage<Article> {
  const envelope = parseSearchEnvelope(value);
  const items = envelope.results.map((row) => {
    if (
      !isRecord(row) ||
      typeof row.free2zaddr !== "string" ||
      !row.free2zaddr ||
      typeof row.title !== "string" ||
      !isRecord(row.creator) ||
      typeof row.creator.username !== "string" ||
      !row.creator.username
    ) {
      throw new Error("Malformed page search result identity.");
    }
    return mapArticle(row as unknown as RawZPage);
  });
  return {
    count: envelope.count,
    next: parseSearchCursor(
      envelope.next,
      "/api/zpage/",
      query,
      currentPage,
      pageSize,
    ),
    items,
  };
}

function parseCreatorZPage(value: unknown): RawZPage {
  if (
    !isRecord(value) ||
    typeof value.free2zaddr !== "string" ||
    value.free2zaddr.length === 0 ||
    typeof value.title !== "string" ||
    !isRecord(value.creator) ||
    typeof value.creator.username !== "string" ||
    value.creator.username.length === 0
  ) {
    throw new Error("Malformed creator page response: page identity.");
  }
  return value as unknown as RawZPage;
}

/** Runtime validator for the creator catalog's DRF pagination contract. */
export function parseCreatorPagesPage(
  value: unknown,
  username: string,
  currentPage: number,
): CreatorPagesPage {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new Error("Malformed creator pagination response.");
  }
  if (!Number.isSafeInteger(value.count) || Number(value.count) < 0) {
    throw new Error("Malformed creator pagination count.");
  }
  if (value.next !== null && typeof value.next !== "string") {
    throw new Error("Malformed creator pagination next link.");
  }
  if (value.previous !== null && typeof value.previous !== "string") {
    throw new Error("Malformed creator pagination previous link.");
  }

  let next: number | null = null;
  if (typeof value.next === "string") {
    const nextUrl = new URL(value.next, "http://localhost");
    if (nextUrl.pathname !== "/api/zpage/") {
      throw new Error("Creator pagination left its endpoint.");
    }
    if (nextUrl.searchParams.get("username") !== username) {
      throw new Error("Creator pagination changed its creator filter.");
    }
    next = Number(nextUrl.searchParams.get("page"));
    if (!Number.isSafeInteger(next) || next !== currentPage + 1) {
      throw new Error("Creator pagination returned an invalid next page.");
    }
  }

  return {
    count: Number(value.count),
    next,
    items: value.results.map((row) => mapArticle(parseCreatorZPage(row))),
  };
}

/** The exact free2z `meeting_type` wire enum. Never add client aliases here. */
type DyteMeetingType = "broadcast" | "ppv" | "subscribers-only" | "private";

const KIND_FROM_TYPE = {
  broadcast: "broadcast",
  ppv: "ppv",
  "subscribers-only": "subscriber",
  private: "private",
} as const satisfies Record<DyteMeetingType, StreamKind>;

const TYPE_FROM_KIND = {
  broadcast: "broadcast",
  ppv: "ppv",
  subscriber: "subscribers-only",
  private: "private",
} as const satisfies Record<StreamKind, DyteMeetingType>;

export class LivestreamKindContractError extends Error {
  constructor() {
    super("Unsupported livestream kind in the free2z API contract.");
    this.name = "LivestreamKindContractError";
  }
}

export class LivestreamPriceContractError extends Error {
  constructor() {
    super("Invalid PPV price in the free2z API contract.");
    this.name = "LivestreamPriceContractError";
  }
}

/** Parse an untrusted wire value without silently making a stream free or paid. */
function streamKindFromType(value: unknown): StreamKind {
  if (
    typeof value !== "string" ||
    !Object.prototype.hasOwnProperty.call(KIND_FROM_TYPE, value)
  ) {
    throw new LivestreamKindContractError();
  }
  return KIND_FROM_TYPE[value as DyteMeetingType];
}

/** Serialize a runtime value through the same strict contract boundary. */
function typeFromStreamKind(value: StreamKind): DyteMeetingType {
  if (
    typeof value !== "string" ||
    !Object.prototype.hasOwnProperty.call(TYPE_FROM_KIND, value)
  ) {
    throw new LivestreamKindContractError();
  }
  return TYPE_FROM_KIND[value];
}

/** PPV entry cost the backend enforces: ceil(price_per_minute*30) + 15 fee. */
function ppvPrice(pricePerMinute: unknown): number {
  // CreatorMeeting.price_per_minute is Decimal(6, 2). Parse its wire form into
  // hundredths so values such as 8.30 do not become 8.300000000000001 in JS
  // and incorrectly round the 30-minute charge up by one.
  if (typeof pricePerMinute !== "string") {
    throw new LivestreamPriceContractError();
  }
  const match = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(pricePerMinute);
  if (!match) throw new LivestreamPriceContractError();

  const hundredths =
    BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  if (hundredths <= 0n) throw new LivestreamPriceContractError();

  return Number((hundredths * 30n + 99n) / 100n + 15n);
}

function mapLivestream(m: RawDyteMeeting): Livestream {
  const kind = streamKindFromType(m.meeting_type);
  const creator = mapCreator(m.creator);
  return {
    id: String(m.id),
    meetingId: m.meeting_id,
    username: m.creator.username,
    creator,
    title: `${creator.display_name} is live`,
    kind,
    live: !!m.live_now,
    // The public meeting listing does not carry an authoritative count. #265
    // will hydrate one; until then the only truthful client value is unknown.
    participants: null,
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
      // Mock mode must preserve the same absence contract as production so the
      // reader can distinguish an authoritative 404 from a transport failure.
      if (!a) throw new ApiError(404, "Article not found");
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
    tags?: string[];
  }): Promise<Article> {
    const tags = normalizeArticleTags(input.tags ?? []);
    if (useMock()) {
      await delay(500);
      const timestamp = Date.now();
      const author: SimpleCreator = {
        username: mockUser.username,
        free2zaddr: mockUser.free2zaddr ?? mockUser.username,
        display_name: mockUser.display_name,
        image: mockUser.image,
        bio: mockUser.bio,
        is_verified: mockUser.is_verified,
        member_price: mockUser.member_price,
      };
      const created: Article = {
        ...mockArticles[0],
        ...input,
        tags,
        id: `${timestamp}`,
        slug: undefined,
        free2zaddr: `mock-${timestamp}`,
        author,
        published_at: new Date().toISOString(),
      };
      mockArticles.unshift(created);
      return created;
    }
    const created = await request<unknown>("/api/zpage/", {
      method: "POST",
      body: {
        title: input.title,
        description: input.subtitle || "",
        content: input.content,
        category: input.category || "",
        tags,
        is_published: true,
      },
    });
    if (
      !isRecord(created) ||
      typeof created.free2zaddr !== "string" ||
      !created.free2zaddr
    ) {
      throw new Error("Malformed published article identity.");
    }

    // POST uses zPageUpdateSerializer, whose documented response contains the
    // saved tags but not the creator object required by `Article`. Retrieve the
    // canonical detail so real mode returns the same complete shape as mock
    // mode and proves the tags survived persistence rather than echoing input.
    try {
      return await articles.get(created.free2zaddr);
    } catch {
      // The mutation is already committed. Preserve that success boundary so
      // the composer can navigate to the canonical id and let the reader retry
      // hydration instead of inviting a second POST and a duplicate article.
      throw new ArticlePublishedHydrationError(created.free2zaddr);
    }
  },

  /** Existing public zpage tags, ordered by platform usage for autocomplete. */
  async suggestTags(
    query: string,
    selected: string[] = [],
  ): Promise<ArticleTagSuggestion[]> {
    const selectedTags = normalizeArticleTags(selected);
    if (useMock()) {
      await delay(80);
      const scenario =
        typeof window === "undefined"
          ? null
          : window.sessionStorage.getItem("zuuli.mock.article-topics");
      if (scenario === "unavailable" || scenario === "unavailable-once") {
        if (scenario === "unavailable-once") {
          window.sessionStorage.removeItem("zuuli.mock.article-topics");
        }
        throw new Error("Mock topic autocomplete unavailable");
      }
      const counts = new Map<string, number>();
      for (const article of mockArticles) {
        for (const tag of sanitizeArticleTags(article.tags ?? [])) {
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      }
      const needle = query.normalize("NFKC").trim().toLocaleLowerCase("en-US");
      return [...counts]
        .filter(
          ([name]) =>
            !selectedTags.includes(name) && (!needle || name.includes(needle)),
        )
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 10)
        .map(([name, count]) => ({ name, count }));
    }
    const response = await request<unknown>("/api/tagging/autocomplete", {
      query: {
        query: query.trim(),
        type: "zpage",
        selected_tags: selectedTags.join(","),
        num_results: 10,
      },
      anonymous: true,
    });
    if (!Array.isArray(response)) {
      throw new Error("Malformed topic autocomplete response.");
    }
    const suggestions = response.map((value): ArticleTagSuggestion => {
      if (!isRecord(value) || typeof value.name !== "string") {
        throw new Error("Malformed topic autocomplete suggestion.");
      }
      const [name] = sanitizeArticleTags([value.name]);
      if (!name) throw new Error("Malformed topic autocomplete name.");
      const count = Number(value.count);
      if (!Number.isFinite(count)) {
        throw new Error("Malformed topic autocomplete count.");
      }
      return { name, count: Math.max(0, Math.round(count)) };
    });
    return suggestions
      .filter(
        (suggestion, index, all) =>
          !selectedTags.includes(suggestion.name) &&
          all.findIndex((candidate) => candidate.name === suggestion.name) ===
            index,
      )
      .slice(0, 10);
  },
};

export class ArticlePublishedHydrationError extends Error {
  readonly articleId: string;

  constructor(articleId: string) {
    super("Article published, but its canonical detail is not available yet.");
    this.name = "ArticlePublishedHydrationError";
    this.articleId = articleId;
  }
}

// ─── Comments (threaded, on zpages) ──────────────────────────────────────────

/** Raw wire shape of a comment (CommentListSerializer). */
interface RawComment {
  uuid: string;
  author: { username: string; avatar_image?: RawImage | null };
  parent: string | null;
  headline: string;
  content: string;
  tuzis: number | string;
  created_at: string;
  updated_at: string;
  tags?: string[];
  num_children?: number;
  content_url?: string | null;
}

function mapComment(c: RawComment): Comment {
  return {
    uuid: c.uuid,
    author: {
      username: c.author.username,
      avatar_image:
        mediaUrl(
          c.author.avatar_image?.thumbnail || c.author.avatar_image?.url,
        ) ?? null,
    },
    parent: c.parent ?? null,
    headline: c.headline,
    content: c.content,
    tuzis: Math.round(Number(c.tuzis)) || 0,
    created_at: c.created_at,
    updated_at: c.updated_at,
    tags: c.tags ?? [],
    num_children: c.num_children ?? 0,
    content_url: c.content_url ?? null,
  };
}

/** One page of comments — `next` is the next page number (or null at the end). */
export interface CommentPage {
  items: Comment[];
  next: number | null;
  count: number;
}

export const comments = {
  /**
   * Top-level comments on a content object — GET
   * /api/comments/{type}/{uuid}/?parent__isnull=True. `uuid` is the zpage's
   * `free2zaddr` (a canonical UUID). DRF PageNumber pagination.
   *
   * NB: the backend's zpage list/create view 404s unless the target zpage has a
   * truthy vanity slug OR is addressed by its `free2zaddr` — always pass
   * `article.free2zaddr` here, never the vanity slug.
   */
  async list(
    type: CommentContentType,
    uuid: string,
    opts: { rootsOnly?: boolean; page?: number } = {},
  ): Promise<CommentPage> {
    const page = opts.page ?? 1;
    if (useMock()) {
      await delay(180);
      return mockComments(uuid, { rootsOnly: opts.rootsOnly ?? true, page });
    }
    const res = await request<Paginated<RawComment>>(
      `/api/comments/${type}/${encodeURIComponent(uuid)}/`,
      {
        query: {
          page,
          ...(opts.rootsOnly ? { parent__isnull: "True" } : {}),
        },
        anonymous: true,
      },
    );
    return {
      items: (res.results ?? []).map(mapComment),
      next: res.next ? page + 1 : null,
      count: res.count ?? 0,
    };
  },

  /** Replies to a parent comment — GET /api/comments/{uuid}/replies/. */
  async listReplies(
    parentUuid: string,
    opts: { page?: number } = {},
  ): Promise<CommentPage> {
    const page = opts.page ?? 1;
    if (useMock()) {
      await delay(150);
      return mockCommentReplies(parentUuid, { page });
    }
    const res = await request<Paginated<RawComment>>(
      `/api/comments/${encodeURIComponent(parentUuid)}/replies/`,
      { query: { page }, anonymous: true },
    );
    return {
      items: (res.results ?? []).map(mapComment),
      next: res.next ? page + 1 : null,
      count: res.count ?? 0,
    };
  },

  /**
   * Create a top-level comment — POST /api/comments/{type}/{uuid}/. Requires
   * Knox auth and costs `tuzis` (≥1), deducted from the author's balance.
   */
  async create(
    type: CommentContentType,
    uuid: string,
    body: CommentInput,
  ): Promise<Comment> {
    if (useMock()) {
      await delay(300);
      return mockCommentCreate(uuid, body);
    }
    const c = await request<RawComment>(
      `/api/comments/${type}/${encodeURIComponent(uuid)}/`,
      { method: "POST", body: { ...body, parent: null } },
    );
    return mapComment(c);
  },

  /**
   * Reply to a comment — POST /api/comments/{uuid}/replies/. Inherits the
   * parent's content object. Requires auth and costs `tuzis`.
   */
  async createReply(parentUuid: string, body: CommentInput): Promise<Comment> {
    if (useMock()) {
      await delay(300);
      return mockCommentReplyCreate(parentUuid, body);
    }
    const c = await request<RawComment>(
      `/api/comments/${encodeURIComponent(parentUuid)}/replies/`,
      { method: "POST", body },
    );
    return mapComment(c);
  },

  /** Vote on a comment — POST /api/comments/{uuid}/vote/ (costs 1 2Z). */
  async vote(uuid: string, dir: CommentVote): Promise<void> {
    if (useMock()) {
      await delay(150);
      mockCommentVote(uuid, dir);
      return;
    }
    await request(`/api/comments/${encodeURIComponent(uuid)}/vote/`, {
      method: "POST",
      body: { vote: dir },
    });
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
        // The backend contract excludes private rooms. Keep the client cache
        // fail-closed too so a server regression cannot publish an invite-only
        // room through Discovery or the home rail.
        .filter((stream) => stream.live && stream.kind !== "private");
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
  ): Promise<{ live: boolean; participants: number | null }> {
    const expectedType = kind ? typeFromStreamKind(kind) : undefined;
    if (useMock()) {
      await delay(120);
      const s = mockLivestreams.find((l) => l.username === username);
      return {
        live: s?.live ?? false,
        participants: normalizeParticipantCount(s?.participants),
      };
    }
    try {
      const s = await request<
        Record<string, { meeting_type?: unknown; participants?: number }>
      >(`/api/dyte/${username}/live-status`, {
        anonymous: true,
        cache: "no-store",
      });
      const entries = Object.entries(s || {})
        .map(([key, entry]) => {
          const keyKind = streamKindFromType(key);
          const entryKind = streamKindFromType(entry?.meeting_type);
          if (keyKind !== entryKind) throw new LivestreamKindContractError();
          return { key, entry };
        })
        .filter(({ key }) => !expectedType || key === expectedType)
        .map(({ entry }) => entry);
      const participants = sumParticipantCounts(
        entries.map((entry) => entry.participants),
      );
      return { live: entries.length > 0, participants };
    } catch (error) {
      if (error instanceof LivestreamKindContractError) throw error;
      return { live: false, participants: null };
    }
  },

  /** Creator starts/ensures their stream and receives its host ticket. */
  async start(kind: StreamKind): Promise<LiveStartResult> {
    const meetingType = typeFromStreamKind(kind);
    if (useMock()) {
      await delay(500);
      return {
        ticket: {
          authToken: "mock-host",
          meetingId: "mock",
          roomName: "zuuli-live",
          as: "host",
        },
        ...(kind === "private" ? { inviteSecret: MOCK_ROOM_SECRET } : {}),
      };
    }
    const me = await auth.me();
    if (kind === "private") {
      const created = await request<unknown>(
        `/api/dyte/${encodeURIComponent(me.username)}/private`,
        { method: "POST" },
      );
      const secret = normalizePrivateSecret(
        created && typeof created === "object"
          ? String((created as Record<string, unknown>).secret ?? "")
          : "",
      );
      if (!secret)
        throw new Error("Private room creation returned no safe invite");
      const ticket = await live.join(me.username, "private", secret, "host");
      return { ticket, inviteSecret: secret };
    }
    const r = await request<unknown>(
      `/api/dyte/${me.username}/${meetingType}`,
      { method: "POST" },
    );
    // A new public meeting changed discovery; private rooms never touch it.
    listingCache = null;
    return {
      ticket: parseJoinTicketResponse(r, {
        as: "host",
        responseMeetingIdRequired: true,
      }),
    };
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
    as: "host" | "participant" = "participant",
    constraints: {
      expectedMeetingId?: string;
      expectedEnvironmentId?: string;
      previousAuthToken?: string;
    } = {},
  ): Promise<DyteJoinTicket> {
    const meetingType = typeFromStreamKind(kind);
    if (useMock()) {
      await delay(600);
      if (kind === "private" && !mockSecretUnlocks(secret)) {
        throw new PrivateRoomUnavailableError();
      }
      return {
        authToken: as === "host" ? "mock-host" : "mock-part",
        meetingId: "mock",
        roomName: "zuuli-live",
        as,
      };
    }
    const privateSecret =
      kind === "private" ? normalizePrivateSecret(secret ?? "") : null;
    if (kind === "private" && !privateSecret) {
      throw new PrivateRoomUnavailableError();
    }
    const path =
      kind === "private"
        ? `/api/dyte/${encodeURIComponent(username)}/private/${encodeURIComponent(privateSecret!)}`
        : `/api/dyte/${encodeURIComponent(username)}/${meetingType}`;
    // The private-join response omits meeting_id (returns { e2ee, auth_token }).
    try {
      const r = await request<unknown>(path, {
        method: "POST",
      });
      return parseJoinTicketResponse(r, {
        as,
        responseMeetingIdRequired: kind !== "private",
        ...constraints,
      });
    } catch (error) {
      if (
        kind === "private" &&
        error instanceof ApiError &&
        [400, 403, 404, 410, 412].includes(error.status)
      ) {
        throw new PrivateRoomUnavailableError();
      }
      throw error;
    }
  },

  /**
   * Refresh a viewer credential by repeating only the authoritative join
   * operation. This never calls `start` or either creator management endpoint,
   * remains bound to the selected meeting/environment, and rejects a replay.
   */
  async refreshParticipant(
    username: string,
    kind: StreamKind,
    previous: DyteJoinTicket,
    secret?: string,
  ): Promise<DyteJoinTicket> {
    if (previous.as !== "participant") {
      throw new Error("Only participant join tickets can be refreshed here.");
    }
    return live.join(username, kind, secret, "participant", {
      expectedMeetingId: previous.meetingId,
      expectedEnvironmentId: previous.environmentId,
      previousAuthToken: previous.authToken,
    });
  },
};

/** Mock private-room secret so the private-join gate is demoable offline. */
const MOCK_ROOM_SECRET = "123e4567-e89b-42d3-a456-426614174000";
function mockSecretUnlocks(secret?: string): boolean {
  return normalizePrivateSecret(secret ?? "") === MOCK_ROOM_SECRET;
}

export class PrivateRoomUnavailableError extends Error {
  constructor() {
    super("This private room is unavailable. The invite may be wrong or expired.");
    this.name = "PrivateRoomUnavailableError";
  }
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
        // The backend builds the Stripe return URL from this, so it must be a
        // route this app mounts. ZUULI's `/wallet/fund` would have returned a
        // paying customer to NotFound (#904).
        body: { quantity: tuzis, currentPath: "/fund", returnMode },
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

  async donate(username: string, tuzis: number): Promise<void> {
    if (useMock()) {
      await delay(400);
      return;
    }
    await request(`/api/tuzis/donate/${encodeURIComponent(username)}`, {
      method: "POST",
      body: { amount: tuzis },
    });
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

  async subscribe(
    username: string,
    idempotencyKey?: string,
  ): Promise<void> {
    if (useMock()) {
      await delay(400);
      const creator = mockCreators.find(
        (candidate) =>
          candidate.username.toLowerCase() === username.toLowerCase(),
      );
      mockSubscribe(
        username,
        idempotencyKey ?? crypto.randomUUID(),
        creator?.member_price ?? 0,
      );
      return;
    }
    await request(`/api/tuzis/subscribe/${username}`, {
      method: "POST",
      headers: idempotencyKey
        ? { "Idempotency-Key": idempotencyKey }
        : undefined,
    });
  },

  async subscribeConfirmed(
    username: string,
    idempotencyKey: string,
    expectedPrice: number,
  ): Promise<SubscribeResult> {
    if (useMock()) {
      await delay(400);
      return mockSubscribe(username, idempotencyKey, expectedPrice);
    }
    const response = await request<unknown>(
      `/api/tuzis/subscribe-confirmed/${username}`,
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: { expected_price: expectedPrice },
      },
    );
    return parseSubscribeResult(response);
  },

  /** Target-specific entitlement fact; safe for purchase decisions. */
  async subscriptionStatus(username: string): Promise<SubscriptionStatus> {
    if (useMock()) {
      await delay(150);
      const subscription = mockSubscriptions.find(
        (candidate) =>
          candidate.star.username.toLowerCase() === username.toLowerCase(),
      );
      const creator = mockCreators.find(
        (candidate) =>
          candidate.username.toLowerCase() === username.toLowerCase(),
      );
      const expires = subscription?.expires ?? null;
      return {
        username: creator?.username ?? username,
        active: Boolean(expires && Date.parse(expires) > Date.now()),
        expires,
        max_price: subscription?.max_price ?? null,
        current_price:
          creator?.member_price === null || creator?.member_price === undefined
            ? null
            : String(creator.member_price),
      };
    }
    const response = await request<unknown>(
      `/api/tuzis/subscription-status/${username}`,
      { cache: "no-store" },
    );
    const parsed = parseSubscriptionStatus(response);
    if (parsed.username.toLowerCase() !== username.toLowerCase()) {
      throw new Error("Membership status referred to a different creator.");
    }
    return parsed;
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
      return mockSubscriptions.filter(
        (subscription) =>
          !subscription.expires || Date.parse(subscription.expires) > Date.now(),
      );
    }
    // This endpoint is paginated (12 rows by default). Looking at only the
    // first page can misclassify a real active member as a nonmember and make
    // the money path extend them another month. Walk every page and fail the
    // whole read on malformed pagination; callers must not purchase from an
    // incomplete entitlement view.
    return collectSubscriptionPages((page, pageSize) =>
      request<unknown>("/api/tuzis/my-subscriptions", {
        query: { page, page_size: pageSize },
        cache: "no-store",
      }),
    );
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
function mockSearchResultPage<T>(
  allItems: T[],
  page: number,
  pageSize: number,
  scenarioKey: string,
): SearchResultPage<T> {
  const scenario =
    typeof window === "undefined"
      ? null
      : window.sessionStorage.getItem(scenarioKey);
  if (scenario === "unavailable") {
    throw new Error("Mock search corpus unavailable");
  }
  const effectivePageSize =
    scenario === "small-pages" ||
    scenario === "overlap" ||
    scenario === "count-drift" ||
    scenario === "skip-row" ||
    scenario === "duplicate-page"
      ? 2
      : pageSize;
  const nominalStart = (page - 1) * effectivePageSize;
  if (scenario === "duplicate-page" && page === 2) {
    return {
      items: allItems.slice(0, effectivePageSize),
      next: 3,
      count: allItems.length,
    };
  }
  const start =
    scenario === "duplicate-page" && page > 2
      ? nominalStart - effectivePageSize
      : scenario === "overlap" && page > 1
      ? nominalStart - 1
      : scenario === "skip-row" && page > 1
        ? nominalStart + 1
        : nominalStart;
  const items = allItems.slice(start, start + effectivePageSize);
  return {
    items,
    next: start + effectivePageSize < allItems.length ? page + 1 : null,
    count:
      scenario === "count-drift" && page > 1
        ? allItems.length + 1
        : allItems.length,
  };
}

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
  async searchCreatorPage(
    query: string,
    page = 1,
    pageSize = 24,
  ): Promise<SearchResultPage<SimpleCreator>> {
    const q = query.trim();
    if (useMock()) {
      await delay(200);
      return mockSearchResultPage(
        mockSearchCreators(q),
        page,
        pageSize,
        "zuuli.mock.search-creators",
      );
    }
    if (!q) return { items: [], next: null, count: 0 };
    const response = await request<unknown>("/api/creator/", {
      query: { search: q, page, page_size: pageSize, ordering: "-total" },
      anonymous: true,
    });
    return parseCreatorSearchPage(response, q, page, pageSize);
  },

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

  /** GET /api/creator/{username}/ → the data-driven public creator profile. */
  async creator(username: string): Promise<CreatorDetail> {
    if (useMock()) {
      await delay(180);
      const detail = mockCreatorDetail(username);
      const scenario =
        typeof window === "undefined"
          ? null
          : window.sessionStorage.getItem("zuuli.mock.creator-pages");
      return scenario === "zero-count-hint" ? { ...detail, zpages: 0 } : detail;
    }
    const c = await request<RawCreator>(
      `/api/creator/${encodeURIComponent(username)}/`,
      { anonymous: true, cache: "no-store" },
    );
    return mapCreatorDetail(c);
  },

  /** A validated page of a creator's published zpages. */
  async creatorPages(
    username: string,
    page = 1,
    pageSize = 12,
  ): Promise<CreatorPagesPage> {
    if (useMock()) {
      await delay(160);
      const scenario =
        typeof window === "undefined"
          ? null
          : window.sessionStorage.getItem("zuuli.mock.creator-pages");
      if (scenario === "fail" || scenario === "fail-once") {
        if (scenario === "fail-once") {
          window.sessionStorage.removeItem("zuuli.mock.creator-pages");
        }
        throw new Error("Mock creator catalog unavailable");
      }
      const items = mockArticles.filter(
        (a) => a.author.username.toLowerCase() === username.toLowerCase(),
      );
      if (scenario === "empty-once") {
        window.sessionStorage.removeItem("zuuli.mock.creator-pages");
        return { items: [], next: page + 1, count: items.length };
      }
      const start = (page - 1) * pageSize;
      return {
        items: items.slice(start, start + pageSize),
        next: start + pageSize < items.length ? page + 1 : null,
        count: items.length,
      };
    }
    const response = await request<unknown>("/api/zpage/", {
      query: { username, page, page_size: pageSize, ordering: "-created_at" },
      anonymous: true,
    });
    return parseCreatorPagesPage(response, username, page);
  },

  /**
   * Full-corpus page (zpage) search — GET /api/zpage/?search=<q>. The backend's
   * VectorSearchFilter does semantic ranking (OpenAI embeddings + pgvector)
   * when a key is present, and falls back to Postgres full-text search
   * otherwise. Public, no auth.
   */
  async searchPagePage(
    query: string,
    page = 1,
    pageSize = 24,
  ): Promise<SearchResultPage<Article>> {
    const q = query.trim();
    if (useMock()) {
      await delay(220);
      return mockSearchResultPage(
        mockSearchPages(q),
        page,
        pageSize,
        "zuuli.mock.search-pages",
      );
    }
    if (!q) return { items: [], next: null, count: 0 };
    const response = await request<unknown>("/api/zpage/", {
      query: { search: q, page, page_size: pageSize },
      anonymous: true,
    });
    return parsePageSearchPage(response, q, page, pageSize);
  },

  /** Legacy one-page page search; global Search uses `searchPagePage`. */
  async searchPages(query: string): Promise<Article[]> {
    return (await discover.searchPagePage(query)).items;
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
