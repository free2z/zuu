// ─────────────────────────────────────────────────────────────────────────
// Money & units for ZUULI.
//
// ZEC is the on-chain asset here (amounts are zatoshis, 1 ZEC = 1e8 zatoshis).
//
// 2Z ("Tuzi") is a free2z **platform credit** — not a currency, token, or
// investment. It has a *purchase price* (you buy it for a fiat/ZEC amount,
// same as any other prepaid credit) but no cash-out, redemption, or exchange
// value: 2Z only ever spends on platform features (AI, tips, PPV,
// subscriptions). `TUZIS_PER_USD` below is an internal cost-plus accounting
// constant used to price purchases and meter AI usage — it is not a
// user-facing exchange rate and must never be displayed as one (no "1 2Z =
// $X" / "worth $X" next to a balance).
//
// The 2Z pricing model is cost-plus: whatever an upstream service costs us
// in USD, we round *up* to a whole number of 2Zs. Example from the spec:
//   a prompt that costs us $0.0323478  →  ceil(3.23478¢)  →  4 2Zs.
// ─────────────────────────────────────────────────────────────────────────

export const ZATOSHIS_PER_ZEC = 100_000_000;
export const TUZIS_PER_USD = 100; // internal cost-plus accounting constant, not a displayed exchange rate

/** Product/API bounds for user-entered whole-2Z amounts. */
export const MAX_TUZIS = 1_000_000;
export const MAX_MEMBER_PRICE_TUZIS = 999_999;
export const MAX_COMMENT_TUZIS = 2_147_483_647;
// free2z CreatorMeeting.price_per_minute is Decimal(6, 2), capped at 9999.99.
// ZUULI's PPV input is whole 2Z, so 9,999 is the largest representable value.
export const MAX_PPV_PRICE_TUZIS = 9_999;

export const MAX_ZEC_INPUT_LENGTH = "90071992.54740991".length;

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_SAFE_INTEGER_DIGITS = String(Number.MAX_SAFE_INTEGER).length;

export type TuziInputError = "invalid" | "tooSmall" | "tooLarge";

export interface TuziInputResult {
  value: number | null;
  error: TuziInputError | null;
}

/** Maximum raw length for an integer that may contain canonical ASCII commas. */
export function tuziInputMaxLength(maximum: number): number {
  const digits = String(maximum).length;
  return digits + Math.floor((digits - 1) / 3);
}

/**
 * Parse an exact, non-negative whole-2Z amount.
 *
 * ASCII commas are the only supported grouping separator, and when present
 * they must delimit groups of three digits. Returning `null` (instead of a
 * fallback number) keeps malformed input from being silently changed before
 * it is displayed or submitted.
 */
export function parseTuzis(raw: string): number | null {
  if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(raw)) return null;

  const normalized = raw.replace(/,/g, "");
  // Bound work before BigInt construction, even when called outside an input
  // with maxLength (for example, from pasted/programmatic values).
  if (normalized.length > MAX_SAFE_INTEGER_DIGITS) return null;

  const value = BigInt(normalized);
  if (value > MAX_SAFE_INTEGER_BIGINT) return null;
  return Number(value);
}

/** Parse a whole-2Z input and retain why a syntactically valid value failed. */
export function validateTuzis(
  raw: string,
  { minimum, maximum }: { minimum: number; maximum: number },
): TuziInputResult {
  const value = parseTuzis(raw);
  if (value === null) return { value: null, error: "invalid" };
  if (value < minimum) return { value, error: "tooSmall" };
  if (value > maximum) return { value, error: "tooLarge" };
  return { value, error: null };
}

/**
 * Parse a positive ZEC amount to an exact integer number of zatoshis.
 *
 * ZEC input deliberately supports no grouping separators and at most eight
 * decimal places. Integer arithmetic avoids the rounding that comes from
 * multiplying a JavaScript floating-point value by 1e8.
 */
export function parseZecToZatoshis(raw: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(raw);
  if (!match) return null;

  const fraction = (match[2] ?? "").padEnd(8, "0");
  const normalized = `${match[1]}${fraction}`.replace(/^0+/, "") || "0";
  // Number.MAX_SAFE_INTEGER is 16 digits; reject longer zatoshi values before
  // asking BigInt to allocate for an untrusted string.
  if (normalized.length > MAX_SAFE_INTEGER_DIGITS) return null;

  const value = BigInt(normalized);
  if (value <= 0n || value > MAX_SAFE_INTEGER_BIGINT) return null;
  return Number(value);
}

/** Format zatoshis as a plain ZEC string (8dp). */
export function formatZec(zatoshis: number): string {
  if (!Number.isSafeInteger(zatoshis)) {
    throw new RangeError("Zatoshi amount must be a safe integer");
  }

  const sign = zatoshis < 0 ? "-" : "";
  const absolute = BigInt(Math.abs(zatoshis));
  const whole = absolute / BigInt(ZATOSHIS_PER_ZEC);
  const fraction = absolute % BigInt(ZATOSHIS_PER_ZEC);
  return `${sign}${whole}.${fraction.toString().padStart(8, "0")}`;
}

/** Format zatoshis as ZEC, trimming trailing zeros but keeping >= 2 dp. */
export function formatZecTrim(zatoshis: number): string {
  const s = formatZec(zatoshis).replace(/0+$/, "").replace(/\.$/, ".0");
  const [w, d = ""] = s.split(".");
  return `${w}.${d.padEnd(2, "0")}`;
}

export function formatZecDisplay(zatoshis: number): string {
  return `${formatZecTrim(zatoshis)} ZEC`;
}

export function splitZec(zatoshis: number): { whole: string; decimal: string } {
  const [whole, decimal] = formatZec(zatoshis).split(".");
  return { whole, decimal: `.${decimal}` };
}

/** Convert a USD cost to a whole number of 2Zs, always rounding up (cost-plus). */
export function usdToTuzis(usd: number): number {
  return Math.max(0, Math.ceil(usd * TUZIS_PER_USD));
}

/**
 * Convert a 2Z amount to a USD number, exact. Use ONLY to show the fiat
 * *purchase price* of a 2Z pack/top-up (e.g. "2,000 2Z for $20") — never
 * to show the "value" of an existing balance or a spend, which would imply
 * 2Z is redeemable for cash.
 */
export function tuzisToUsd(tuzis: number): number {
  return tuzis / TUZIS_PER_USD;
}

/** Human 2Z amount, grouped with commas. */
export function formatTuzis(tuzis: number): string {
  return `${Math.round(tuzis).toLocaleString()} 2Z`;
}

/** USD display for a 2Z purchase price. Do not use for balances or spends. */
export function formatUsd(usd: number): string {
  return usd.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: usd < 0.01 ? 6 : 2,
  });
}

/**
 * Shorten a long value (Zcash address, txid) for display while keeping the
 * security-relevant *trailing* characters visible — those are what a human
 * checks when verifying an address.
 *
 * Renders the first `head` and last `tail` characters joined by a single
 * middle ellipsis (e.g. `u1st8hhxjv…q7x9gge4kd`). It never emits more than one
 * ellipsis and always preserves the last `tail` characters. Only the rendered
 * string is shortened — the full value is untouched, so callers keep it intact
 * for copying/QR.
 *
 * NOTE: render the result WITHOUT a CSS `truncate`/`text-ellipsis` class. That
 * clips the already-shortened string and clobbers the trailing digits with a
 * second ellipsis. Use `break-all` if wrapping is a concern.
 */
export function truncateAddress(value: string, head = 8, tail = 10): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function formatDate(timestamp: number | null): string {
  if (!timestamp) return "Pending";
  return new Date(timestamp * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Relative "3m ago" style time from an ISO string or epoch-seconds. */
export function timeAgo(input: string | number): string {
  const ms = typeof input === "number" ? input * 1000 : Date.parse(input);
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function formatHeight(height: number): string {
  return height.toLocaleString();
}

/** Initials for an avatar fallback. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}
