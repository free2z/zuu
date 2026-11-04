import { useQuery } from 'react-query';
import axios from 'axios';

/**
 * Live 2Z pricing (issue ).
 *
 * The current retail service price is $0.01 per 2Z usage credit. This is not a redemption rate. Zcash purchases are priced off an aggregated,
 * spread-adjusted ZEC/USD rate served by the backend at `/api/pricing/`.
 *
 * Fallback order when the endpoint is unreachable:
 *   1. the last price we successfully fetched (cached in localStorage), then
 *   2. a bootstrap estimate derived from a sane ZEC/USD guess.
 * We never fall back to a magic 2Z/ZEC constant implying a nonsense ZEC price.
 */

export interface Pricing {
    zec_usd: string;
    spread: string;
    tuzis_per_zec: string;
    tuzi_per_usd: number;
    usd_per_tuzi: string;
    num_sources: number;
    sources: Record<string, string>;
    updated_at: string;
    stale: boolean;
    bootstrap?: boolean;
    // Informational only: max(min_fee_cents, ceil(base * percent_fee)).
    // Display the server's authoritative `amount_cents`, never a local recompute.
    card: {
        percent_fee: string;
        min_fee_cents: number;
    };
}

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
 * ESTIMATE ONLY. The authoritative charge is the `amount_cents` the server
 * returns with the checkout quote; show that before sending a buyer to Stripe.
 */
export function cardFeeCents(
    quantity: number,
    pricing?: Pricing | null,
): number {
    const base = Number.isFinite(quantity) ? Math.max(0, Math.trunc(quantity)) : 0;
    const rawPercent = Number(pricing?.card?.percent_fee);
    const rawMin = Number(pricing?.card?.min_fee_cents);
    // BOTH fields or NEITHER -- `f2z_pricing_v1` is the same localStorage key
    // card-v2 used, so a returning buyer can hold a payload whose percentage
    // parses beside a minimum that does not. Mixing them builds a fee shape no
    // server ever served.
    const usable =
        Number.isFinite(rawPercent) &&
        rawPercent >= 0 &&
        Number.isInteger(rawMin) &&
        rawMin >= 0;
    const percent = usable ? rawPercent : FALLBACK_CARD_PERCENT_FEE;
    const minimum = usable ? rawMin : FALLBACK_CARD_MIN_FEE_CENTS;
    // Basis points keep this integer arithmetic: 0.1 is not exact in binary,
    // and a fee one cent off the server's is a disclosure defect.
    const basisPoints = Math.round(percent * 10_000);
    return Math.max(minimum, Math.ceil((base * basisPoints) / 10_000));
}

/** Estimated total card charge in USD cents: base (1 2Z == 1c) plus the fee. */
export function estimatedCardCents(
    quantity: number,
    pricing?: Pricing | null,
): number {
    const base = Number.isFinite(quantity) ? Math.max(0, Math.trunc(quantity)) : 0;
    return base + cardFeeCents(base, pricing);
}

// Cold-start ZEC/USD guess (mirrors the backend's PRICING_BOOTSTRAP_ZEC_USD).
export const BOOTSTRAP_ZEC_USD = 500;
// Mirrors dj.apps.pricing.constants.ZEC_SPREAD / TUZI_PER_USD.
export const ZEC_SPREAD = 0.1;
export const TUZI_PER_USD = 100;
// Bootstrap 2Z/ZEC for DISPLAY on a cold start. Derived, never a rate
// literal:  was a standalone constant that once meant "$25/ZEC" and
// survived into a $750/ZEC world, crediting buyers 1/30th of what they paid.
// Nothing in the browser ever credits anything -- crediting reads
// current_tuzis_per_zec() server-side and defers when it is unavailable.
export const BOOTSTRAP_TUZIS_PER_ZEC = Math.round(
    BOOTSTRAP_ZEC_USD * (1 - ZEC_SPREAD) * TUZI_PER_USD,
); // 45000

const CACHE_KEY = 'f2z_pricing_v1';

function readCache(): Pricing | undefined {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        return raw ? (JSON.parse(raw) as Pricing) : undefined;
    } catch {
        return undefined;
    }
}

function writeCache(pricing: Pricing): void {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(pricing));
    } catch {
        /* storage full / disabled — non-fatal */
    }
}

export default function useTuziPricing() {
    const cached = readCache();

    const { data } = useQuery<Pricing>(
        'tuzi-pricing',
        async () => {
            const res = await axios.get('/api/pricing/');
            return res.data;
        },
        {
            // Keep it live while the dialog is open, but don't hammer the API.
            refetchInterval: 45_000,
            refetchOnWindowFocus: true,
            staleTime: 30_000,
            retry: 1,
            // Seed instantly from the last cached price, but treat it as stale
            // so a fresh fetch still kicks off.
            initialData: cached,
            initialDataUpdatedAt: 0,
            onSuccess: (pricing) => {
                if (pricing && !pricing.bootstrap) writeCache(pricing);
            },
        }
    );

    const parsed = Number(data?.tuzis_per_zec);
    const tuziPerZec =
        Number.isFinite(parsed) && parsed > 0 ? parsed : BOOTSTRAP_TUZIS_PER_ZEC;

    // Show as an estimate rather than "live" when there's no data, it's a
    // bootstrap guess, or the snapshot's age (from updated_at, not the frozen
    // cached `stale`) exceeds the freshness window.
    let isEstimate = !data || !!data.bootstrap;
    if (data && !data.bootstrap) {
        const updated = Date.parse(data.updated_at);
        isEstimate = Number.isNaN(updated)
            ? !!data.stale
            : Date.now() - updated > 120_000;
    }

    return {
        pricing: data ?? null,
        tuziPerZec,
        zecUsd: data ? Number(data.zec_usd) : null,
        isEstimate,
        bootstrap: data?.bootstrap ?? false,
    };
}
