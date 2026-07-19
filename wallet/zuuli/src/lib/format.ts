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

/** Format zatoshis as a plain ZEC string (8dp). */
export function formatZec(zatoshis: number): string {
  return (zatoshis / ZATOSHIS_PER_ZEC).toFixed(8);
}

/** Format zatoshis as ZEC, trimming trailing zeros but keeping >= 2 dp. */
export function formatZecTrim(zatoshis: number): string {
  const zec = zatoshis / ZATOSHIS_PER_ZEC;
  const s = zec.toFixed(8).replace(/0+$/, "").replace(/\.$/, ".0");
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
