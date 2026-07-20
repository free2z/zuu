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
export type SocialProvider = "x" | "google" | "github";

export const SOCIAL_PROVIDERS: SocialProvider[] = ["x", "google", "github"];

/**
 * GET /api/auth/social/providers/ (AllowAny) — which providers the backend
 * currently has OAuth client credentials configured for. A provider with no
 * `client_id`/`client_secret` set reports `false` and its `/start` and
 * `/{provider}/` endpoints 503. Buttons render ONLY for providers reported
 * `true` here — with nothing configured (today: everything), this returns
 * all-false and the UI shows no social buttons at all.
 */
export type SocialProvidersStatus = Partial<Record<SocialProvider, boolean>>;

/**
 * Editable fields for the signed-in user's own profile —
 * PATCH /api/auth/user/ (CreatorProfileUpdateSerializer). Avatar/banner
 * uploads aren't included yet: the backend takes a `GenericFile` PK from a
 * separate upload endpoint, not a raw image, so that's a follow-up.
 */
export interface ProfileUpdateInput {
  /** → `full_name`, ≤128 chars. */
  display_name?: string;
  /** → `description`, markdown, ≤1024 chars. */
  bio?: string;
  /** → `p2paddr`, ≤255 chars. Empty string clears it. */
  p2paddr?: string;
  /** → `member_price`. `null` clears the paid tier. */
  member_price?: number | null;
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
  /** Display name of the personality that primed this reply, if any. */
  personality?: string;
  created_at?: string;
  /** 2Zs charged for this exchange (cost-plus, rounded up). */
  tuzis_charged?: number;
  input_tokens?: number;
  output_tokens?: number;
}

/**
 * A custom system message a user can create, edit and select to prime the AI
 * (`/api/ai/personalities/`, DRF ModelViewSet). Anyone can read public
 * personalities (plus their own private ones); only the creator can edit or
 * delete theirs. `creator` is omitted/undefined for built-in, creator-less
 * public personalities.
 */
export interface Personality {
  id: string;
  display_name: string;
  system_message: string;
  is_public: boolean;
  /** Username of the creator; absent for built-in personalities. */
  creator?: string | null;
}

/** Body for creating/editing a personality — everything but the server-set fields. */
export interface PersonalityInput {
  display_name: string;
  system_message: string;
  is_public: boolean;
}

/**
 * A stateful chat thread (`/api/ai/conversations/`). Pairs one `ai_model`
 * with an optional `personality` for the lifetime of the thread — the
 * backend replays `prompt_response_set` as history on every turn, so
 * switching model or personality starts a new conversation.
 */
export interface AIConversation {
  id: string;
  display_name: string;
  ai_model: string;
  personality?: string | null;
  model_name?: string;
  is_public?: boolean;
  is_subscriber_only?: boolean;
  created_at?: string;
  updated_at?: string;
  tags?: string[];
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

// ── Comments (threaded, on zpages / AI conversations) ───────────────────────
// Backend: `/api/comments/` (confirmed against tuzi f2z.yaml). Comments are
// TITLED (`headline` required, ≤100 chars) and cost `tuzis` to post (≥1, spent
// from the author's balance; also the vote weight/score). Threading is a
// self-FK `parent` (to_field uuid): roots via `?parent__isnull=True`, replies
// via `/api/comments/{parent}/replies/`. Nesting is unbounded.

/** The content object a thread of comments hangs off of. */
export type CommentContentType = "zpage" | "ai_conversation";

/** Author of a comment (CommentListSerializer.author). */
export interface CommentAuthor {
  username: string;
  /** Avatar URL (mapped from `avatar_image.thumbnail`/`url`), if any. */
  avatar_image?: string | null;
}

/** One comment — shape from `CommentListSerializer`. */
export interface Comment {
  uuid: string;
  author: CommentAuthor;
  /** Parent comment uuid (self-FK), or `null` for a top-level comment. */
  parent: string | null;
  /** Required title, ≤100 chars. */
  headline: string;
  /** Markdown body, ≤1000 chars. */
  content: string;
  /** Weight spent to post (≥1); doubles as the vote score. */
  tuzis: number;
  created_at: string;
  updated_at: string;
  tags?: string[];
  /** Number of direct replies. */
  num_children: number;
  /** Link back to the content object the comment lives on, if any. */
  content_url?: string | null;
}

/** Body for creating a comment / reply (POST). */
export interface CommentInput {
  headline: string;
  content: string;
  tuzis: number;
}

/** Vote direction — POST /api/comments/{uuid}/vote/ (costs 1 2Z). */
export type CommentVote = "up" | "down";

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

// ── KYC / creator revenue-share application ─────────────────────────────────
// Backend: `dj.apps.kyc` (tuzi/py/dj/apps/kyc, mounted at /api/kyc/ per
// tuzi/py/dj/free2z/settings.py + tuzi/py/dj/free2z/openapi/f2z.yaml). The
// generated OpenAPI schema for this app carries no request/response bodies
// (every operation documents only `200`/`204` with no schema), so these
// shapes are instead confirmed against the working reference client at
// ts/react/free2z/src/components/KYC*.tsx (KYCBasicInfoStep, KYCTaxFormStep,
// KYCTaxForm, KYCElectronicSignature, KYCIdentity, KYCLivePhotoCapture,
// KYCPage) and ts/react/free2z/src/components/RevenueShareLink.tsx, which
// talk to this same live backend.

/**
 * Workflow status returned by `application_status` on the KYC profile.
 * NEW → PENDING (via change-status) → APPROVED (reviewer decision), or
 * REJECTED. An APPROVED creator can revise + resubmit, which POSTs
 * change-status again to flip APPROVED back to NEW.
 */
export type KycApplicationStatus = "NEW" | "PENDING" | "APPROVED" | "REJECTED";

/** GET/POST /api/kyc/user-profile. */
export interface KycProfile {
  is_us: boolean | null;
  is_individual: boolean | null;
  application_status: KycApplicationStatus;
}

/** Fields the applicant sets in the "basic info" step — POST /api/kyc/user-profile. */
export interface KycProfileInput {
  is_us: boolean;
  is_individual: boolean;
}

/** Which US tax form applies, derived from `is_us` + `is_individual`. */
export type KycTaxFormKind = "W-9" | "W-8BEN" | "W-8BEN-E";

/** The four identity-document upload slots /api/kyc/identity-documents accepts. */
export type KycIdentityDocType =
  | "id_front"
  | "id_back"
  | "additional_document"
  | "live_photo";

/** GET /api/kyc/identity-documents → `{ <doctype>_url }` per uploaded slot. */
export type KycIdentityDocuments = Partial<
  Record<`${KycIdentityDocType}_url`, string | null>
>;

/** GET /api/kyc/get-tax-form-file → `{ file }` (null until a form is uploaded). */
export interface KycTaxFormFile {
  file: string | null;
}

/** POST /api/kyc/upload-tax-form (multipart, field `file`) response. */
export interface KycTaxFormUploadResult {
  file_url: string;
}

/** GET/POST /api/kyc/tax-form-signature. */
export interface KycTaxFormSignature {
  tax_form_signature: string | null;
}
