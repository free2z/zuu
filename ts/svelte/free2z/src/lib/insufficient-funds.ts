import { ApiError } from "$lib/api/mutator";
import {
  recordQuotedBalanceRead,
  snapshotReadOrder,
} from "$lib/account-balance";

export type DecimalLike = string | number | bigint;

export interface InsufficientFundsDetails {
  code: "insufficient_funds";
  cost: string;
  balance: string;
  shortfall: string;
  action: string;
}

type DecimalParts = {
  negative: boolean;
  integer: string;
  fraction: string;
};

const DECIMAL_TEXT = /^([+-]?)(\d+)(?:\.(\d+))?$/;

function decimalParts(value: DecimalLike): DecimalParts | null {
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  const match = DECIMAL_TEXT.exec(String(value).trim());
  if (!match) return null;

  return {
    negative: match[1] === "-",
    integer: match[2].replace(/^0+(?=\d)/, ""),
    fraction: match[3] ?? "",
  };
}

function canonicalDecimal(value: DecimalLike): string | null {
  const parts = decimalParts(value);
  if (!parts) return null;
  const fraction = parts.fraction.replace(/0+$/, "");
  const isZero = parts.integer === "0" && fraction === "";
  return `${parts.negative && !isZero ? "-" : ""}${parts.integer}${fraction ? `.${fraction}` : ""}`;
}

function scaledInteger(value: DecimalLike, scale: number): bigint | null {
  const parts = decimalParts(value);
  if (!parts || parts.fraction.length > scale) return null;
  const digits = `${parts.integer}${parts.fraction.padEnd(scale, "0")}`;
  const coefficient = BigInt(digits || "0");
  return parts.negative ? -coefficient : coefficient;
}

/** Exact comparison for decimal text; no monetary string is converted to Number. */
export function compareDecimalText(a: DecimalLike, b: DecimalLike): number {
  const left = decimalParts(a);
  const right = decimalParts(b);
  if (!left || !right) return NaN;
  const scale = Math.max(left.fraction.length, right.fraction.length);
  const leftValue = scaledInteger(a, scale);
  const rightValue = scaledInteger(b, scale);
  if (leftValue === null || rightValue === null) return NaN;
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function subtractDecimalText(a: DecimalLike, b: DecimalLike): string | null {
  const left = decimalParts(a);
  const right = decimalParts(b);
  if (!left || !right) return null;
  const scale = Math.max(left.fraction.length, right.fraction.length);
  const difference =
    (scaledInteger(a, scale) ?? 0n) - (scaledInteger(b, scale) ?? 0n);
  const negative = difference < 0n;
  const absolute = (negative ? -difference : difference)
    .toString()
    .padStart(scale + 1, "0");
  const integer = scale ? absolute.slice(0, -scale) : absolute;
  const fraction = scale ? absolute.slice(-scale).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${integer || "0"}${fraction ? `.${fraction}` : ""}`;
}

/**
 * Format an exact decimal string with locale grouping and decimal symbols.
 * `Intl.NumberFormat.format()` is deliberately not used: it coerces strings
 * to Number and rounds large values before formatting them.
 */
export function formatDecimalText(
  value: DecimalLike,
  localeCode: string,
  maximumFractionDigits = 3,
): string {
  const canonical = canonicalDecimal(value);
  if (canonical === null) return String(value);
  const parts = decimalParts(canonical);
  if (!parts) return String(value);

  const fractionDigits = Math.max(0, Math.floor(maximumFractionDigits));
  let integerText = parts.integer;
  let fraction = parts.fraction;
  if (fraction.length > fractionDigits) {
    const kept = fraction.slice(0, fractionDigits).padEnd(fractionDigits, "0");
    const coefficient =
      BigInt(`${integerText}${kept}` || "0") +
      (fraction[fractionDigits] >= "5" ? 1n : 0n);
    const rounded = coefficient.toString().padStart(fractionDigits + 1, "0");
    integerText = fractionDigits ? rounded.slice(0, -fractionDigits) : rounded;
    fraction = fractionDigits
      ? rounded.slice(-fractionDigits).replace(/0+$/, "")
      : "";
  }
  const formatter = new Intl.NumberFormat(localeCode, {
    useGrouping: true,
    minimumFractionDigits: 1,
    maximumFractionDigits: Math.max(1, fractionDigits),
  });
  const sample = formatter.formatToParts(123456789.123);
  const group = sample.find((part) => part.type === "group")?.value ?? ",";
  const decimal = sample.find((part) => part.type === "decimal")?.value ?? ".";
  const minus =
    formatter.formatToParts(-1).find((part) => part.type === "minusSign")
      ?.value ?? "-";
  const localizedDigits = Array.from(
    { length: 10 },
    (_, digit) =>
      new Intl.NumberFormat(localeCode, { useGrouping: false })
        .formatToParts(digit)
        .find((part) => part.type === "integer")?.value ?? String(digit),
  );

  // Derive the locale's grouping pattern from a safe, small sample. This
  // preserves non-western patterns such as hi-IN's 12,34,56,789 grouping.
  const sampleGroups = sample
    .filter((part) => part.type === "integer")
    .map((part) => part.value.length);
  const rightToLeftSizes = sampleGroups.reverse();
  const integerChunks: string[] = [];
  let end = integerText.length;
  let groupIndex = 0;
  while (end > 0) {
    const size =
      rightToLeftSizes[Math.min(groupIndex, rightToLeftSizes.length - 1)] || 3;
    const start = Math.max(0, end - size);
    integerChunks.unshift(integerText.slice(start, end));
    end = start;
    groupIndex += 1;
  }
  const localized = (text: string) =>
    Array.from(text, (digit) => {
      const index = "0123456789".indexOf(digit);
      return index >= 0 ? localizedDigits[index] : digit;
    }).join("");
  const integer = integerChunks.map(localized).join(group);
  const suffix = fraction ? `${decimal}${localized(fraction)}` : "";
  return `${parts.negative ? minus : ""}${integer}${suffix}`;
}

function decimalField(value: unknown): string | null {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "bigint"
  ) {
    return null;
  }
  return canonicalDecimal(value);
}

/**
 * The smallest stake a post or reply can carry: the composers' `min={1}`, and
 * the server's floor (`CommentCreateSerializer.tuzis`, `min_value=1`). 1 2Z is
 * $0.01 (`USD_PER_TUZI`), which is the whole anti-spam mechanism.
 */
export const MINIMUM_POST_STAKE = "1";

/**
 * True only when the balance is KNOWN and cannot cover the smallest post.
 *
 * A missing or unreadable balance is "unknown", never "zero": telling a funded
 * creator they have nothing is worse than saying nothing, and the 402 the
 * server answers with is still there to catch a stale balance at submit.
 */
export function cannotCoverMinimumPost(balance: unknown): boolean {
  const known = decimalField(balance);
  return known !== null && compareDecimalText(known, MINIMUM_POST_STAKE) < 0;
}

export interface IntroPath {
  /** Where the "introduce yourself" door leads. */
  href: string;
  /** The creator already has a zPage, so the door is to it, not a new one. */
  written: boolean;
}

/**
 * Where to send a creator who cannot cover a post to introduce themselves.
 *
 * `/edit` creates a NEW page, and the server refuses a second page while the
 * balance is below 1 2Z (`_create_page`, `zpage_set.count() > 0`). So a
 * creator who already has one — `zpages` on the session is the owner's count,
 * drafts included, the same set the server counts — is sent to the page they
 * have, not into a save that will be refused. An unknown count keeps `/edit`.
 */
export function introPath(
  user: { username?: string; zpages?: number } | null | undefined,
): IntroPath {
  const written =
    typeof user?.zpages === "number" && user.zpages > 0 && !!user.username;
  return written
    ? {
        href: `/${encodeURIComponent(user!.username!)}/dashboard/pages`,
        written,
      }
    : { href: "/edit", written: false };
}

export function parseInsufficientFunds(
  value: unknown,
): InsufficientFundsDetails | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (data.code !== "insufficient_funds") return null;

  const cost = decimalField(data.cost);
  const balance = decimalField(data.balance);
  const shortfall = decimalField(data.shortfall);
  if (cost === null || balance === null || shortfall === null) return null;

  return {
    code: "insufficient_funds",
    cost,
    balance,
    shortfall,
    action: typeof data.action === "string" ? data.action : "unknown",
  };
}

const SERVER_BALANCE_SNAPSHOT = Symbol("server balance snapshot");

export function isServerFundsSnapshot(
  funds: InsufficientFundsDetails,
): boolean {
  return Boolean(
    (
      funds as InsufficientFundsDetails & {
        [SERVER_BALANCE_SNAPSHOT]?: boolean;
      }
    )[SERVER_BALANCE_SNAPSHOT],
  );
}

function markServerFundsSnapshot(
  funds: InsufficientFundsDetails | null,
  order?: number,
) {
  if (funds)
    Object.defineProperty(funds, SERVER_BALANCE_SNAPSHOT, {
      value: true,
      configurable: true,
    });
  if (funds && order !== undefined) recordQuotedBalanceRead(funds, order);
  return funds;
}

export function insufficientFundsFromError(
  error: unknown,
): InsufficientFundsDetails | null {
  return error instanceof ApiError
    ? markServerFundsSnapshot(
        parseInsufficientFunds(error.data),
        snapshotReadOrder(error),
      )
    : null;
}

export function makeInsufficientFunds(
  cost: DecimalLike,
  balance: DecimalLike,
  action: string,
): InsufficientFundsDetails {
  const normalizedCost = canonicalDecimal(cost) ?? "0";
  const normalizedBalance = canonicalDecimal(balance) ?? "0";
  const difference =
    subtractDecimalText(normalizedCost, normalizedBalance) ?? "0";
  return {
    code: "insufficient_funds",
    cost: normalizedCost,
    balance: normalizedBalance,
    shortfall: compareDecimalText(difference, "0") > 0 ? difference : "0",
    action,
  };
}

export async function insufficientFundsFromResponse(
  response: Response,
): Promise<InsufficientFundsDetails | null> {
  if (response.status !== 402) return null;
  const order = snapshotReadOrder(response);
  try {
    return markServerFundsSnapshot(
      parseInsufficientFunds(await response.clone().json()),
      order,
    );
  } catch {
    return null;
  }
}
