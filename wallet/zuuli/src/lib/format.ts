// ─────────────────────────────────────────────────────────────────────────
// Money & units for ZUULI.
//
// Two currencies live here:
//   • ZEC — the on-chain asset. Amounts are zatoshis (1 ZEC = 1e8 zatoshis).
//   • 2Z  ("Tuzi") — free2z platform credits. 1 Tuzi = 1 US cent ($0.01).
//
// The 2Z model is cost-plus: whatever an upstream service costs us in USD,
// we round *up* to a whole number of 2Zs. Example from the spec:
//   a prompt that costs us $0.0323478  →  ceil(3.23478¢)  →  4 2Zs.
// ─────────────────────────────────────────────────────────────────────────

export const ZATOSHIS_PER_ZEC = 100_000_000;
export const TUZIS_PER_USD = 100; // 1 Tuzi === 1 cent

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

/** Convert 2Zs back to a USD number (exact, for display). */
export function tuzisToUsd(tuzis: number): number {
  return tuzis / TUZIS_PER_USD;
}

/** Human 2Z amount, grouped with commas. */
export function formatTuzis(tuzis: number): string {
  return `${Math.round(tuzis).toLocaleString()} 2Z`;
}

/** USD display for a 2Z balance/price. */
export function formatUsd(usd: number): string {
  return usd.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: usd < 0.01 ? 6 : 2,
  });
}

export function truncateAddress(address: string, chars = 8): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
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
