/**
 * Live 2Z pricing (issue ).
 *
 * A 2Z is worth $0.01. Zcash purchases are priced off an aggregated,
 * spread-adjusted ZEC/USD rate served by the backend at `/api/pricing/`.
 *
 * Fallback order when the endpoint is unreachable:
 *   1. the last price we successfully fetched (cached in localStorage), then
 *   2. a bootstrap estimate derived from a sane ZEC/USD guess.
 * We never fall back to a magic 2Z/ZEC constant that implies a nonsense ZEC
 * price.
 */

export interface Pricing {
  /** Aggregated ZEC/USD spot price, decimal string. */
  zec_usd: string;
  /** Settlement spread applied when a confirmed payment is processed. */
  spread: string;
  /** 2Z received per 1 ZEC after the spread, decimal string. */
  tuzis_per_zec: string;
  /** Conservative display buffer; distinct from the settlement spread. */
  estimate_buffer?: string;
  /** Estimated 2Z per ZEC used to prepare a payment request. */
  estimated_tuzis_per_zec?: string;
  /** Current server-selected offer; eligibility is evaluated again at settlement. */
  zec_promotion?: {
    code_status: "none" | "active" | "unavailable";
    requested_code: string | null;
    multiplier: string;
    title: string | null;
    ends_at: string | null;
    code: string | null;
  };
  /** Face-value 2Z per USD (100; 2Z == $0.01). */
  tuzi_per_usd: number;
  usd_per_tuzi: string;
  num_sources: number;
  sources: Record<string, string>;
  updated_at: string;
  stale: boolean;
  /** True when the value is a cold-start estimate (no live/cached price yet). */
  bootstrap?: boolean;
  /**
   * Informational card fee shape: `max(min_fee_cents, ceil(base * percent_fee))`.
   * Never compute a charge from this — display the authoritative `amount_cents`
   * the server returns with the checkout quote.
   */
  card: {
    percent_fee: string;
    min_fee_cents: number;
  };
}

/**
 * Cold-start ZEC/USD guess, used only when there is no live and no cached
 * price. Keep roughly in the right ballpark (mirrors the backend's
 * PRICING_BOOTSTRAP_ZEC_USD). The derived 2Z/ZEC is a sane estimate rather
 * than the old $25-implied 2500.
 */
export const BOOTSTRAP_ZEC_USD = 500;
/** Display-only fallback for a cached payload predating estimate metadata. */
export const ZEC_ESTIMATE_BUFFER = 0.1;
/** Mirrors `dj.apps.pricing.constants.TUZI_PER_USD` (a 2Z is $0.01). */
export const TUZI_PER_USD = 100;
/**
 * Bootstrap 2Z/ZEC for display on a cold start. Derived, never a rate literal:
 * this is what `` was about, where a standalone constant that once meant
 * "$25/ZEC" survived into a $750/ZEC world and credited buyers 1/30th of what
 * they paid. Nothing here ever credits anything -- crediting reads
 * `current_tuzis_per_zec()` server-side and defers if it is unavailable.
 */
export const BOOTSTRAP_TUZIS_PER_ZEC = Math.round(
  BOOTSTRAP_ZEC_USD * (1 - ZEC_ESTIMATE_BUFFER) * TUZI_PER_USD,
); // 45000

const CACHE_KEY = "f2z_pricing_v1";

/** Seconds after which a snapshot is considered stale (matches the backend). */
const STALE_AFTER_MS = 120_000;

/**
 * Card fee shape used ONLY for the pre-checkout estimate, when there is no
 * server payload yet. Mirrors dj.apps.pricing.constants (card-v3):
 * `fee = max($0.50, ceil(10% of base))`.
 */
export const FALLBACK_CARD_PERCENT_FEE = 0.1;
export const FALLBACK_CARD_MIN_FEE_CENTS = 50;

/**
 * The card fee in USD cents for `quantity` 2Z, read from the live pricing
 * payload so the disclosed estimate cannot drift from the backend formula.
 *
 * This is an ESTIMATE. The authoritative charge is always the `amount_cents`
 * the server returns with the checkout quote — show that before sending a
 * buyer to Stripe.
 */
export function cardFeeCents(
  quantity: number,
  pricing?: Pricing | null,
): number {
  const base = Number.isFinite(quantity)
    ? Math.max(0, Math.trunc(quantity))
    : 0;
  const rawPercent = Number(pricing?.card?.percent_fee);
  const rawMin = Number(pricing?.card?.min_fee_cents);
  // BOTH fields or NEITHER. Validating them independently silently builds a
  // fee shape no server ever served: `f2z_pricing_v1` is the same localStorage
  // key card-v2 used, so a returning buyer can hold
  // `{percent_fee:"0.05", flat_fee_cents:100}` — a percentage that parses,
  // beside a minimum that does not. Taking 5% with the new 50c floor would
  // disclose $10.50 for 1,000 2Z against a real charge of $11.00.
  const usable =
    Number.isFinite(rawPercent) &&
    rawPercent >= 0 &&
    Number.isInteger(rawMin) &&
    rawMin >= 0;
  const percent = usable ? rawPercent : FALLBACK_CARD_PERCENT_FEE;
  const minimum = usable ? rawMin : FALLBACK_CARD_MIN_FEE_CENTS;
  // Basis points keep this integer arithmetic: 0.1 is not exact in binary, and
  // a fee that is one cent off the server's is a disclosure defect.
  const basisPoints = Math.round(percent * 10_000);
  return Math.max(minimum, Math.ceil((base * basisPoints) / 10_000));
}

/** Estimated total card charge in USD cents: base (1 2Z == 1c) plus the fee. */
export function estimatedCardCents(
  quantity: number,
  pricing?: Pricing | null,
): number {
  const base = Number.isFinite(quantity)
    ? Math.max(0, Math.trunc(quantity))
    : 0;
  return base + cardFeeCents(base, pricing);
}

/** Use the server's conservative estimate, independently of its settlement rate. */
export function estimatedTuziPerZec(
  pricing: Pricing | null | undefined,
): number {
  const supplied = Number(pricing?.estimated_tuzis_per_zec);
  if (Number.isFinite(supplied) && supplied > 0) return supplied;
  // Cached payloads without separate estimate metadata used their spread for
  // the display buffer. They stay display-only and cannot fix the credit rate.
  const buffer = Number(pricing?.estimate_buffer ?? pricing?.spread);
  const spot = Number(pricing?.zec_usd);
  const faceValue = Number(pricing?.tuzi_per_usd);
  if (
    Number.isFinite(buffer) &&
    buffer >= 0 &&
    buffer < 1 &&
    Number.isFinite(spot) &&
    spot > 0 &&
    Number.isFinite(faceValue) &&
    faceValue > 0
  )
    return spot * (1 - buffer) * faceValue;
  return BOOTSTRAP_TUZIS_PER_ZEC;
}

/**
 * Whether a rate should be shown as an estimate rather than "live": no data, a
 * bootstrap guess, or a snapshot whose age exceeds the freshness window
 * (recomputed from `updated_at`, so a cache-seeded value doesn't stay labeled
 * "live" forever on the strength of a `stale:false` frozen at cache time).
 */
export function isEstimate(
  pricing: Pricing | null | undefined,
  now = Date.now(),
): boolean {
  if (!pricing || pricing.bootstrap || pricing.stale || !Number.isFinite(now))
    return true;
  const updated = Date.parse(pricing.updated_at);
  if (Number.isNaN(updated) || now < updated) return true;
  return now - updated > STALE_AFTER_MS;
}

/** Read the last successfully-fetched pricing from localStorage (browser only). */
export function readCachedPricing(): Pricing | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Pricing) : null;
  } catch {
    return null;
  }
}

function writeCachedPricing(pricing: Pricing): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(pricing));
  } catch {
    /* storage full / disabled — non-fatal */
  }
}

type FetchFn = typeof fetch;

/**
 * Fetch the current pricing payload, caching it on success. Returns `null` on
 * failure so callers fall back to the cached value (or a bootstrap estimate).
 */
export async function fetchPricing(
  fetchFn: FetchFn,
  apiBase = "",
  promoCode = "",
): Promise<Pricing | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const query = promoCode ? `?promo=${encodeURIComponent(promoCode)}` : "";
    const res = await fetchFn(`${apiBase}/api/pricing/${query}`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const pricing = (await res.json()) as Pricing;
    if (
      !promoCode &&
      !pricing?.zec_promotion?.requested_code &&
      !pricing?.bootstrap
    )
      writeCachedPricing(pricing);
    return pricing;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Owner-scoped advisory limits; no funding capacity or rate is reserved. */
export interface ZecFundingCapacity {
  as_of: string;
  remaining_m2z: string;
  remaining_sale_nusd: string;
}

export function validZecFundingCapacity(
  value: unknown,
): value is ZecFundingCapacity {
  if (!value || typeof value !== "object") return false;
  const capacity = value as ZecFundingCapacity;
  return (
    typeof capacity.as_of === "string" &&
    Number.isFinite(Date.parse(capacity.as_of)) &&
    typeof capacity.remaining_m2z === "string" &&
    /^\d+$/.test(capacity.remaining_m2z) &&
    typeof capacity.remaining_sale_nusd === "string" &&
    /^\d+$/.test(capacity.remaining_sale_nusd)
  );
}

export function exhaustedZecFundingCapacity(value: unknown): boolean {
  return (
    validZecFundingCapacity(value) &&
    (BigInt(value.remaining_m2z) === 0n ||
      BigInt(value.remaining_sale_nusd) === 0n)
  );
}

/** Forecast the selected rounded ZEC amount using server rates, without float money arithmetic. */
export function zecFundingCapacityPreview(
  amount: number,
  pricing: Pricing | null | undefined,
  capacity: ZecFundingCapacity | null | undefined,
  now = Date.now(),
) {
  const decimal = (value: unknown) => {
    if (typeof value !== "string" || !/^\d{1,20}(?:\.\d{1,18})?$/.test(value))
      return null;
    const [whole, fraction = ""] = value.split(".");
    return {
      value: BigInt(whole + fraction),
      scale: 10n ** BigInt(fraction.length),
    };
  };
  const rate = decimal(pricing?.tuzis_per_zec);
  const spot = decimal(pricing?.zec_usd);
  const buffer = decimal(pricing?.estimate_buffer);
  const estimate = decimal(pricing?.estimated_tuzis_per_zec);
  if (
    isEstimate(pricing, now) ||
    !buffer ||
    buffer.value >= buffer.scale ||
    !estimate ||
    estimate.value <= 0 ||
    !validZecFundingCapacity(capacity) ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount >= 1e21 ||
    !rate ||
    !spot ||
    rate.value <= 0 ||
    spot.value <= 0
  )
    return null;
  const zatoshi = BigInt(amount.toFixed(8).replace(".", ""));
  const ceil = (value: bigint, divisor: bigint) =>
    (value + divisor - 1n) / divisor;
  // Advisory projections round upward: do not authorize a boundary overflow.
  const credits = ceil(zatoshi * rate.value * 1000n, 100_000_000n * rate.scale);
  const sale = ceil(
    zatoshi * spot.value * 1_000_000_000n,
    100_000_000n * spot.scale,
  );
  return {
    projected_m2z: String(credits),
    projected_sale_nusd: String(sale),
    exceeds_credit_limit: credits > BigInt(capacity.remaining_m2z),
    exceeds_sale_limit: sale > BigInt(capacity.remaining_sale_nusd),
  };
}

/** UTC from an authenticated server read, advanced using elapsed monotonic time. */
export interface ServerTimeAnchor {
  server_ms: number;
  monotonic_ms: number;
}
export function serverTimeNow(
  anchor: ServerTimeAnchor | null,
  monotonic: number,
): number {
  return anchor && Number.isFinite(monotonic)
    ? anchor.server_ms + Math.max(0, monotonic - anchor.monotonic_ms)
    : NaN;
}
export function anchorServerTime(
  asOf: string,
  requestStarted: number,
  received: number,
  previous: ServerTimeAnchor | null = null,
): ServerTimeAnchor | null {
  const observed = Date.parse(asOf);
  if (
    !Number.isFinite(observed) ||
    !Number.isFinite(requestStarted) ||
    !Number.isFinite(received) ||
    received < requestStarted
  )
    return null;
  // Count the complete read's round trip conservatively; subsequent responses
  // must not rewind the account's elapsed freshness clock.
  const previousNow = serverTimeNow(previous, received);
  return {
    server_ms: Math.max(
      observed + received - requestStarted,
      Number.isFinite(previousNow) ? previousNow : -Infinity,
    ),
    monotonic_ms: received,
  };
}

/** Compare elapsed durations only: fixed device UTC skew cancels out. */
export function serverClockUncertain(
  anchor: Pick<ServerTimeAnchor, "monotonic_ms"> | null,
  wallBaseline: number | null,
  wall: number,
  monotonic: number,
): boolean {
  if (!anchor || wallBaseline === null) return false;
  const monotonicElapsed = monotonic - anchor.monotonic_ms;
  const wallElapsed = wall - wallBaseline;
  return (
    !Number.isFinite(monotonicElapsed) ||
    !Number.isFinite(wallElapsed) ||
    monotonicElapsed < 0 ||
    Math.abs(wallElapsed - monotonicElapsed) > 1000
  );
}
