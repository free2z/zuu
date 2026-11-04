/**
 * ZIP 321 payment URIs for DIRECT creator support.
 *
 * The ZEC product boundary is deliberately two-sided:
 *
 *   1. Send ZEC directly to a creator or page address. Free2Z is not a party
 *      to the payment and never reads the memo.
 *   2. Send ZEC to a Free2Z-controlled address ONLY to buy 2Z. That flow lives
 *      in the billing dashboard and carries the required `buy_2z` attribution.
 *
 * Boosts, comments and every other platform action are 2Z actions. The
 * legacy `{"act": "page_fund", "id":...}` memo protocol was an instruction
 * to a Free2Z-controlled wallet; attaching it to a direct creator payment was
 * meaningless at best and a routing bug at worst. So this module knows
 * nothing about pages, ids, intents or JSON: it takes an address, an amount
 * and a supporter-authored memo, and nothing else can reach the URI.
 */

/** ZIP 302: a memo field is exactly 512 bytes. */
export const ZCASH_MEMO_MAX_BYTES = 512;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** UTF-8 byte length -- the limit is bytes on the wire, not JS characters. */
export function memoByteLength(memo: string): number {
  return encoder.encode(memo).length;
}

/**
 * Transparent (`t1...`/`t3...`) and TEX (`tex1...`) addresses cannot carry a
 * memo; a URI that attaches one to them is invalid and wallets refuse it.
 */
export function isTransparentAddress(address: string): boolean {
  return /^t/i.test(address.trim());
}

/** Whether `address` can carry a memo at all. */
export function addressAcceptsMemo(address: string): boolean {
  return address.trim().length > 0 && !isTransparentAddress(address);
}

/**
 * Truncate `value` to at most `maxBytes` of UTF-8 without splitting a code
 * point (a surrogate pair is one code point, so it is kept or dropped whole).
 */
export function truncateToBytes(value: string, maxBytes: number): string {
  if (memoByteLength(value) <= maxBytes) return value;
  let out = "";
  let used = 0;
  for (const codePoint of value) {
    const size = encoder.encode(codePoint).length;
    if (used + size > maxBytes) break;
    out += codePoint;
    used += size;
  }
  return out;
}

const DEFAULT_MEMO_MAX_BYTES = 200;

/**
 * The default direct-support memo for a zPage: short, human-readable, and
 * based on the LOCALIZED page title the supporter is looking at. No id, no
 * JSON, no routing command -- it is a note to the creator, nothing more.
 */
export function defaultSupportMemo(
  pageTitle: string | null | undefined,
): string {
  const title = (pageTitle ?? "").replace(/\s+/g, " ").trim();
  if (!title) return "";
  return truncateToBytes(title, DEFAULT_MEMO_MAX_BYTES).trim();
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("=", "")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Normalise a supporter-typed ZEC amount to ZIP 321 decimal text, or `null`
 * when it is not a positive amount. Kept as TEXT on purpose: `String(1e-8)`
 * is `"1e-8"`, which is not a valid ZIP 321 amount, and `Number` cannot hold
 * eight decimal places of a large amount exactly.
 */
export function normalizeZecAmount(
  amount: string | number | null | undefined,
): string | null {
  if (amount === null || amount === undefined) return null;
  // A number can only arrive from a `type="number"` binding; render it with
  // all eight places so `1e-8` never reaches the regex as exponent text.
  const text =
    typeof amount === "number"
      ? Number.isFinite(amount)
        ? amount.toFixed(8)
        : ""
      : String(amount).trim();
  // The ZIP 321 shape, plus what a supporter is mid-way through typing:
  // `.5` and `1.` are canonicalised (`0.5`, `1`) rather than flagged on the
  // keystroke that ends in a dot. A lone `.` has no digits and is rejected.
  const match = /^(\d*)(?:\.(\d{0,8}))?$/.exec(text);
  if (!match || (match[1] === "" && !match[2])) return null;
  const whole = (match[1] || "0").replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (/^0*$/.test(whole) && fraction === "") return null;
  return fraction ? `${whole}.${fraction}` : whole;
}

export type DirectSupportRequest = {
  /** The effective recipient: the page's `p2paddr`, else the creator's. */
  address: string;
  /** Optional ZEC amount as typed by the supporter. */
  amount?: string | number | null;
  /** Optional supporter-authored memo. Empty means "no memo parameter". */
  memo?: string | null;
};

export type DirectSupportUri = {
  uri: string;
  address: string;
  amount: string | null;
  /**
   * The supporter typed an amount that is not a ZIP 321 amount (e.g. `abc`,
   * `-1`, nine decimals). Distinct from an intentionally empty amount: no URI
   * is produced, so a populated field can never become an unspecified-amount
   * wallet handoff (codex adversarial review).
   */
  amountInvalid: boolean;
  /** The memo actually attached, or `null` when the URI carries none. */
  memo: string | null;
  memoBytes: number;
  /** The memo was dropped because the address cannot carry one. */
  memoUnsupported: boolean;
  /** The memo exceeds ZIP 302's 512 bytes; no URI is produced. */
  memoTooLong: boolean;
};

/**
 * Build the one reviewed URI that QR, "Open wallet" and "Copy link" share.
 *
 * Returns an empty `uri` when there is no address, the memo is too long or
 * the amount is present but invalid, so a caller cannot half-render an
 * invalid payment request.
 */
export function buildDirectSupportUri(
  request: DirectSupportRequest,
): DirectSupportUri {
  const address = (request.address ?? "").trim();
  const amount = normalizeZecAmount(request.amount);
  const amountText =
    request.amount === null || request.amount === undefined
      ? ""
      : String(request.amount).trim();
  const amountInvalid = amountText.length > 0 && amount === null;
  const rawMemo = request.memo ?? "";
  const memoUnsupported = rawMemo.length > 0 && !addressAcceptsMemo(address);
  const memo = memoUnsupported || rawMemo.length === 0 ? null : rawMemo;
  const memoBytes = memo === null ? 0 : memoByteLength(memo);
  const memoTooLong = memoBytes > ZCASH_MEMO_MAX_BYTES;

  const empty: DirectSupportUri = {
    uri: "",
    address,
    amount,
    amountInvalid,
    memo,
    memoBytes,
    memoUnsupported,
    memoTooLong,
  };
  if (!address || memoTooLong || amountInvalid) return empty;

  const params: string[] = [];
  if (amount !== null) params.push(`amount=${amount}`);
  if (memo !== null) {
    params.push(`memo=${base64UrlEncode(encoder.encode(memo))}`);
  }
  const query = params.length ? `?${params.join("&")}` : "";
  return { ...empty, uri: `zcash:${address}${query}` };
}

export type ParsedZcashUri = {
  address: string;
  amount: string | null;
  memo: string | null;
  params: Record<string, string>;
};

/**
 * Decode a `zcash:` URI back into its parts. Used by tests to verify that the
 * recipient, amount and memo a wallet would see are exactly what the dialog
 * showed -- and that nothing else rode along.
 */
export function parseZcashUri(uri: string): ParsedZcashUri {
  if (!uri.startsWith("zcash:")) {
    throw new Error(`not a zcash: URI: ${uri}`);
  }
  const rest = uri.slice("zcash:".length);
  const queryAt = rest.indexOf("?");
  const address = queryAt === -1 ? rest : rest.slice(0, queryAt);
  const params: Record<string, string> = {};
  if (queryAt !== -1) {
    for (const pair of rest.slice(queryAt + 1).split("&")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const key = eq === -1 ? pair : pair.slice(0, eq);
      const value = eq === -1 ? "" : pair.slice(eq + 1);
      params[key] = value;
    }
  }
  return {
    address,
    amount: params.amount ?? null,
    memo:
      params.memo === undefined
        ? null
        : decoder.decode(base64UrlDecode(params.memo)),
    params,
  };
}
