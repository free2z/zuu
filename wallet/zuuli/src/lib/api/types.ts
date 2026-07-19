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
}

/**
 * Full public creator profile — GET /api/creator/{username__iexact}/ →
 * CreatorDetail (anonymous OK). This is the data-driven native creator screen
 * (issue #163, Option 2): everything below is server-owned, so new creators and
 * content changes need no app release.
 */
export interface CreatorDetail {
  username: string;
  free2zaddr: string; // public page slug (== username)
  display_name: string; // full_name, falling back to username
  bio?: string | null; // `description` (markdown, ≤1024 chars)
  image?: string | null; // avatar_image
  banner?: string | null; // banner_image
  is_verified: boolean;
  can_stream: boolean;
  /** 2Z price for 30 days of membership / livestream access (null = free). */
  member_price?: number | null;
  /** Count of published zpages. */
  zpages: number;
  /** Follower / score total. */
  total: number;
  /** Zcash payment address for direct tips. */
  p2paddr?: string | null;
}

export interface AuthUser {
  id?: number;
  username: string;
  email?: string;
  free2zaddr?: string;
  display_name?: string;
  image?: string | null;
  /** 2Z (Tuzi) credit balance. */
  tuzis: number;
  /** True when this session authenticated via a Zcash address (no password). */
  zcashLinked?: boolean;
}

/** Knox token returned by /api/token/login/. */
export interface SessionToken {
  key: string;
  expiry?: string;
}

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
  | { status: "complete"; user: AuthUser }
  | { status: "otp_required"; username: string };

// ── AI ────────────────────────────────────────────────────────────────────
export interface AIModel {
  id: string;
  model: string; // provider model name, e.g. "gpt-4o", "claude-sonnet-5"
  display_name: string;
  system_message: string;
  max_tokens: number;
  is_ga: boolean;
  order: number;
  input_price: string; // USD per token
  output_price: string; // USD per token
  markup: string; // multiplier above cost
  /** Convenience: provider family inferred from the model name. */
  provider?: "openai" | "anthropic" | "xai" | "kimi" | "google" | "local" | "other";
}

export interface PromptResponse {
  id: string;
  prompt: string;
  response: string;
  model?: string;
  created_at?: string;
  /** 2Zs charged for this exchange (cost-plus, rounded up). */
  tuzis_charged?: number;
  input_tokens?: number;
  output_tokens?: number;
}

export interface AIConversation {
  id: string;
  title?: string;
  model?: string;
  created_at?: string;
  updated_at?: string;
  is_public?: boolean;
  promptresponses?: PromptResponse[];
}

// ── Articles (zpage / storytime) ────────────────────────────────────────────
export interface Article {
  id: number | string;
  slug?: string;
  free2zaddr?: string;
  title: string;
  subtitle?: string;
  content: string; // markdown
  image?: string | null;
  category?: string;
  author: SimpleCreator;
  votes?: number;
  published_at?: string;
  reading_minutes?: number;
  /** Free-form topic tags (zpage `tags`), used for AND-filtering the feed. */
  tags?: string[];
}

/**
 * How the article feed is ranked (`?homeSort=` on /api/zpage/):
 * - `popular` — recency-decayed "fresh" ranking (the ZUULI default).
 * - `score`   — all-time `-f2z_score`.
 * - `updated` — most-recently-updated first.
 * - `random`  — shuffled.
 */
export type ArticleSort = "popular" | "score" | "updated" | "random";

/** Query for a page of the article feed. */
export interface ArticleFeedParams {
  sort?: ArticleSort;
  /** AND-filtered topic tags. */
  tags?: string[];
  /** Semantic/vector search query (`?search=`). */
  search?: string;
  category?: string;
  /** 1-based page number (DRF PageNumber pagination). */
  page?: number;
  pageSize?: number;
}

/**
 * One page of the article feed. `next` is the next page number to request, or
 * `null` at the end of the corpus — so infinite scroll never needs the raw
 * `next` URL (which can point at a CORS-disallowed host).
 */
export interface ArticleFeedPage {
  items: Article[];
  next: number | null;
  count: number;
}

// ── Livestreams (dyte) ──────────────────────────────────────────────────────
export type StreamKind = "broadcast" | "subscriber" | "ppv" | "private";

export interface LiveStatus {
  username: string;
  live: boolean;
  participants: number;
  kind: StreamKind;
}

export interface Livestream {
  id: string;
  username: string;
  creator: SimpleCreator;
  title: string;
  kind: StreamKind;
  live: boolean;
  participants: number;
  /** 2Z price to join (0 for free broadcast). */
  price_tuzis: number;
  thumbnail?: string | null;
  started_at?: string;
  category?: string;
}

/** Everything the client needs to actually join a Dyte meeting. */
export interface DyteJoinTicket {
  authToken: string;
  meetingId: string;
  roomName?: string;
  as: "host" | "participant";
}

// ── Tuzi (2Z) subscriptions & transactions ──────────────────────────────────
export interface Subscription {
  fan: SimpleCreator;
  star: SimpleCreator;
  expires?: string;
  max_price?: string;
}

export interface TuziTransaction {
  id: number;
  amount: number; // cents paid
  tuzis_credited: number;
  timestamp: string;
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

/** Card processing fees applied to the USD path (PricingSnapshot.card). */
export interface CardFees {
  percent_fee: string; // e.g. "0.05" (5%)
  flat_fee_cents: number;
}

/** Current live pricing snapshot — GET /api/pricing/. */
export interface PricingSnapshot {
  zec_usd: string; // aggregated ZEC/USD spot
  spread: string; // e.g. "0.10"
  tuzis_per_zec: string; // 2Z per 1 ZEC after the spread
  tuzi_per_usd: number; // 100 (2Z == $0.01)
  usd_per_tuzi: string; // e.g. "0.01"
  num_sources: number; // exchanges in the average
  sources: Record<string, string>; // per-exchange ZEC/USD quotes
  updated_at: string; // ISO datetime
  stale: boolean; // older than the freshness window
  bootstrap: boolean; // cold-start estimate — present as an estimate only
  card: CardFees;
}

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
