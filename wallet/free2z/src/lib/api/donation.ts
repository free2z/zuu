export const IDEMPOTENT_DONATION_ROUTE = "/api/tuzis/donate-idempotent";

export interface DonationResult {
  /** Authoritative whole-2Z balance after the original keyed operation. */
  balance: number;
  /** Whole-2Z amount charged by the original keyed operation. */
  charged: number;
  /** True when the server replayed the stored result for this key. */
  replayed: boolean;
}

export class DonationContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DonationContractError";
  }
}

const DONATION_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isDonationIdempotencyKey(key: string): boolean {
  return DONATION_KEY_PATTERN.test(key);
}

/** Parse an exact, non-negative, whole-2Z wire value without rounding. */
export function parseWholeTuzis(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.0+)?$/.test(value)) {
    return null;
  }
  const integer = value.split(".", 1)[0];
  if (integer.length > String(Number.MAX_SAFE_INTEGER).length) return null;
  const parsed = BigInt(integer);
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null;
}

/**
 * Parse the backend's Decimal(17,3) balance without rounding away milli-2Z.
 * Restrict the accepted range to exactly representable integer milli-2Z in
 * the client's number model; larger values must not silently lose money.
 */
export function parseBalanceTuzis(value: unknown): number | null {
  if (typeof value === "number") {
    const milliTuzis = value * 1_000;
    return value >= 0 && Number.isSafeInteger(milliTuzis) ? value : null;
  }
  if (typeof value !== "string") return null;
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,3}))?$/.exec(value);
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fractional = BigInt((match[2] ?? "").padEnd(3, "0") || "0");
  const milliTuzis = whole * 1_000n + fractional;
  if (milliTuzis > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(milliTuzis) / 1_000;
}

/**
 * Validate the idempotent backend response before it can replace local money
 * state. A charged amount different from the reviewed request is a contract
 * failure, never something to round or accept optimistically.
 */
export function normalizeDonationResult(
  response: unknown,
  requestedAmount: number,
): DonationResult {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new DonationContractError("Donation response must be an object");
  }
  const raw = response as Record<string, unknown>;
  const balance = parseBalanceTuzis(raw.balance);
  const charged = parseWholeTuzis(raw.charged);
  if (balance === null) {
    throw new DonationContractError("Donation response balance is invalid");
  }
  if (charged === null || charged !== requestedAmount) {
    throw new DonationContractError("Donation response charge does not match");
  }
  if (typeof raw.replayed !== "boolean") {
    throw new DonationContractError("Donation replay status is invalid");
  }
  return { balance, charged, replayed: raw.replayed };
}

export function authoritativeBalanceFromErrorBody(body: unknown): number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return parseBalanceTuzis((body as Record<string, unknown>).balance);
}
