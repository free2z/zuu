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

const DATE_TIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};
const CALENDAR_DATE_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
};

let formattingLocale: string | undefined;
let pendingDateLabel: string | undefined;

/** Bind human date/time output to the locale selected during app bootstrap. */
export function configureFormattingLocale(
  locale: string,
  pendingLabel: string,
): void {
  formattingLocale = locale;
  pendingDateLabel = pendingLabel;
}

export type TuziInputError = "invalid" | "tooSmall" | "tooLarge";

export interface TuziInputResult {
  value: number | null;
  error: TuziInputError | null;
}

/** Digits 0-9 in `locale`'s numbering system, mapped back to ASCII. */
function localeDigits(locale?: string): Map<string, string> {
  const fmt = new Intl.NumberFormat(locale, { useGrouping: false });
  const map = new Map<string, string>();
  for (let d = 0; d <= 9; d++) map.set(fmt.format(d), String(d));
  return map;
}

/** `locale`'s grouping separator glyph, read off a real formatted number instead of hardcoded. */
function localeGroupSeparator(locale?: string): string {
  const part = new Intl.NumberFormat(locale)
    .formatToParts(1234567)
    .find((p) => p.type === "group");
  return part?.value ?? ",";
}

/** Max raw input length for a whole 2Z amount, per `locale`'s own grouping (hi-IN groups in 2s, not just 3s). */
export function tuziInputMaxLength(maximum: number, locale?: string): number {
  return maximum.toLocaleString(locale).length;
}

/**
 * Parse a whole-2Z amount using `locale`'s grouping separator and digits
 * (default: runtime locale, same as `formatTuzis`). Mirrors display, so
 * whatever the app shows parses back — see #324. `null` on anything
 * malformed rather than a best-effort guess.
 */
export function parseTuzis(raw: string, locale?: string): number | null {
  if (!raw) return null;

  const group = localeGroupSeparator(locale);
  const digits = localeDigits(locale);
  const hasGroupSeparator = group !== "" && raw.includes(group);
  const stripped = hasGroupSeparator ? raw.split(group).join("") : raw;

  let ascii = "";
  for (const glyph of stripped) {
    const digit = digits.get(glyph);
    if (digit === undefined) return null;
    ascii += digit;
  }
  if (!/^(?:0|[1-9]\d*)$/.test(ascii)) return null;

  // Bound work before BigInt construction, even when called outside an input
  // with maxLength (for example, from pasted/programmatic values).
  if (ascii.length > MAX_SAFE_INTEGER_DIGITS) return null;

  const value = BigInt(ascii);
  if (value > MAX_SAFE_INTEGER_BIGINT) return null;
  const num = Number(value);

  // Ungrouped digits are fine as-is. If a separator is present it has to
  // match the locale's canonical grouping for this value, or malformed
  // shapes like "1,00" would silently parse as 100.
  if (hasGroupSeparator && num.toLocaleString(locale) !== raw) return null;

  return num;
}

/** Example grouped-integer string for input hints, in `locale` (e.g. "3,000", "3.000", "३,०००"). */
export function tuziInputExample(value = 3000, locale?: string): string {
  return value.toLocaleString(locale);
}

/** Parse a whole-2Z input and retain why a syntactically valid value failed. */
export function validateTuzis(
  raw: string,
  { minimum, maximum, locale }: { minimum: number; maximum: number; locale?: string },
): TuziInputResult {
  const value = parseTuzis(raw, locale);
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
 *
 * NOTE: stays ASCII-only and locale-independent on purpose, unlike the 2Z
 * (Tuzi) parsing above — ZEC is a consensus amount, not a display number.
 * Don't make this locale-aware too. See #324.
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

/**
 * Product bound for a user-entered ZEC tip: 1,000 ZEC, in zatoshis.
 *
 * Not a consensus limit — the protocol carries far more — but a tip form is not
 * where anybody means to move a fortune, and an unbounded amount field is one
 * fat finger away from a confirmation the payer waves through. ZUULI still
 * re-derives and shows its own review; this only keeps an obvious mistake from
 * reaching it.
 */
export const MAX_TIP_ZEC = 1_000;
export const MAX_TIP_ZATOSHIS = MAX_TIP_ZEC * ZATOSHIS_PER_ZEC;

export type ZecInputError = "invalid" | "tooLarge";

export interface ZecInputResult {
  /** Exact zatoshis, or `null` when the input is not a positive ZEC amount. */
  zatoshis: number | null;
  error: ZecInputError | null;
}

/**
 * Validate a user-entered ZEC amount and retain why a parsed value failed.
 *
 * The 2Z counterpart is `validateTuzis`, and this is deliberately a separate
 * function rather than a generalisation of it, because the two disagree on
 * purpose: 2Z parsing follows the display locale (#324) and ZEC parsing never
 * does. A consensus amount that changed meaning with a device's locale would be
 * a different payment on a different phone.
 *
 * Zero, negative, non-numeric, grouped, exponential and more-than-eight-decimal
 * inputs are all `"invalid"`: `parseZecToZatoshis` refuses each outright rather
 * than rounding, so nothing here has to decide what a ninth decimal place
 * "meant".
 */
export function validateZec(
  raw: string,
  { maximum = MAX_TIP_ZATOSHIS }: { maximum?: number } = {},
): ZecInputResult {
  const zatoshis = parseZecToZatoshis(raw);
  if (zatoshis === null) return { zatoshis: null, error: "invalid" };
  if (zatoshis > maximum) return { zatoshis, error: "tooLarge" };
  return { zatoshis, error: null };
}

/**
 * Format zatoshis as a plain ZEC string (8dp).
 *
 * NOTE: same as `parseZecToZatoshis` — hard `.` decimal, Western digits, no
 * locale grouping, on purpose.
 */
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

export function formatDate(
  timestamp: number | null,
  locale = formattingLocale,
): string {
  if (!timestamp) {
    if (!pendingDateLabel) {
      throw new Error("date formatting used before locale bootstrap");
    }
    return pendingDateLabel;
  }
  return new Intl.DateTimeFormat(locale, DATE_TIME_FORMAT_OPTIONS).format(
    timestamp * 1000,
  );
}

/** Locale-aware relative time from an ISO string or epoch-seconds. */
export function timeAgo(
  input: string | number,
  locale = formattingLocale,
): string {
  const ms = typeof input === "number" ? input * 1000 : Date.parse(input);
  const diff = Date.now() - ms;
  const absolute = Math.abs(diff);
  const mins = Math.round(diff / 60000);
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (absolute < 60000) return relative.format(0, "second");
  if (absolute < 60 * 60000) return relative.format(-mins, "minute");
  const hrs = Math.round(mins / 60);
  if (absolute < 24 * 60 * 60000) return relative.format(-hrs, "hour");
  const days = Math.round(hrs / 24);
  if (absolute < 30 * 24 * 60 * 60000) return relative.format(-days, "day");
  return new Intl.DateTimeFormat(locale, CALENDAR_DATE_FORMAT_OPTIONS).format(ms);
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
