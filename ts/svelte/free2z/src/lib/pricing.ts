/**
 * Live 2Z pricing (issue #579).
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
	/** Spread applied to ZEC purchases, e.g. "0.10". */
	spread: string;
	/** 2Z received per 1 ZEC after the spread, decimal string. */
	tuzis_per_zec: string;
	/** Face-value 2Z per USD (100; 2Z == $0.01). */
	tuzi_per_usd: number;
	usd_per_tuzi: string;
	num_sources: number;
	sources: Record<string, string>;
	updated_at: string;
	stale: boolean;
	/** True when the value is a cold-start estimate (no live/cached price yet). */
	bootstrap?: boolean;
	card: {
		percent_fee: string;
		flat_fee_cents: number;
	};
}

/**
 * Cold-start ZEC/USD guess, used only when there is no live and no cached
 * price. Keep roughly in the right ballpark (mirrors the backend's
 * PRICING_BOOTSTRAP_ZEC_USD). The derived 2Z/ZEC is a sane estimate rather
 * than the old $25-implied 2500.
 */
export const BOOTSTRAP_ZEC_USD = 500;
export const FALLBACK_TUZI_PER_ZEC = Math.round(BOOTSTRAP_ZEC_USD * 0.9 * 100); // 45000

const CACHE_KEY = 'f2z_pricing_v1';

/** Seconds after which a snapshot is considered stale (matches the backend). */
const STALE_AFTER_MS = 120_000;

/** Parse `tuzis_per_zec` from a Pricing payload, guarding against bad values. */
export function tuziPerZec(pricing: Pricing | null | undefined): number {
	const raw = Number(pricing?.tuzis_per_zec);
	return Number.isFinite(raw) && raw > 0 ? raw : FALLBACK_TUZI_PER_ZEC;
}

/**
 * Whether a rate should be shown as an estimate rather than "live": no data, a
 * bootstrap guess, or a snapshot whose age exceeds the freshness window
 * (recomputed from `updated_at`, so a cache-seeded value doesn't stay labeled
 * "live" forever on the strength of a `stale:false` frozen at cache time).
 */
export function isEstimate(pricing: Pricing | null | undefined): boolean {
	if (!pricing || pricing.bootstrap) return true;
	const updated = Date.parse(pricing.updated_at);
	if (Number.isNaN(updated)) return pricing.stale;
	return Date.now() - updated > STALE_AFTER_MS;
}

/** Read the last successfully-fetched pricing from localStorage (browser only). */
export function readCachedPricing(): Pricing | null {
	if (typeof localStorage === 'undefined') return null;
	try {
		const raw = localStorage.getItem(CACHE_KEY);
		return raw ? (JSON.parse(raw) as Pricing) : null;
	} catch {
		return null;
	}
}

function writeCachedPricing(pricing: Pricing): void {
	if (typeof localStorage === 'undefined') return;
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
export async function fetchPricing(fetchFn: FetchFn, apiBase = ''): Promise<Pricing | null> {
	try {
		const res = await fetchFn(`${apiBase}/api/pricing/`);
		if (!res.ok) return null;
		const pricing = (await res.json()) as Pricing;
		if (!pricing?.bootstrap) writeCachedPricing(pricing);
		return pricing;
	} catch {
		return null;
	}
}
