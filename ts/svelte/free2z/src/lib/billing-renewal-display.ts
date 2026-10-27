import {
  beginAccountBalanceRead,
  hasAccountAuthReadAfter,
  type BalanceOwner,
} from "./account-balance";
import {
  compareDecimalText,
  makeInsufficientFunds,
} from "./insufficient-funds";

export type RenewalDisplayStatus = "none" | "ok" | "shortfall" | "unknown";

type RenewalSummary = {
  status?: unknown;
  balance?: unknown;
  total_upcoming?: unknown;
  shortfall?: unknown;
  horizon_days?: unknown;
};

function amount(value: unknown): string | null {
  const raw = typeof value === "number" ? String(value) : value;
  return typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw) ? raw : null;
}

/** Refresh balance-dependent display only; the server still owns the renewal total. */
export function renewalDisplay(
  summary: RenewalSummary | null | undefined,
  liveBalance: unknown,
) {
  const horizon = summary?.horizon_days;
  const horizonDays =
    typeof horizon === "number" && Number.isFinite(horizon) ? horizon : 29;
  const balance = amount(summary?.balance);
  const total = amount(summary?.total_upcoming);
  const shortfall = amount(summary?.shortfall);
  const unknown = {
    status: "unknown" as RenewalDisplayStatus,
    horizonDays,
    balance,
    total,
    shortfall,
  };
  if (
    balance === null ||
    total === null ||
    shortfall === null ||
    typeof horizon !== "number" ||
    !Number.isInteger(horizon) ||
    horizon <= 0
  )
    return unknown;
  // Never convert malformed or unavailable aggregate data into a coverage claim.
  const original = makeInsufficientFunds(total, balance, "renewals");
  if (compareDecimalText(original.shortfall, shortfall) !== 0) return unknown;
  if (summary?.status === "none") {
    return compareDecimalText(total, "0") === 0 &&
      compareDecimalText(shortfall, "0") === 0
      ? { ...unknown, status: "none" as RenewalDisplayStatus }
      : unknown;
  }
  if (
    compareDecimalText(total, "0") <= 0 ||
    (summary?.status !== "ok" && summary?.status !== "shortfall") ||
    (summary.status === "ok"
      ? compareDecimalText(shortfall, "0") !== 0
      : compareDecimalText(shortfall, "0") <= 0)
  )
    return unknown;
  const current = amount(liveBalance);
  if (current === null) return unknown;
  const updated = makeInsufficientFunds(total, current, "renewals");
  return {
    ...unknown,
    status: (compareDecimalText(updated.shortfall, "0") > 0
      ? "shortfall"
      : "ok") as RenewalDisplayStatus,
    balance: current,
    shortfall: updated.shortfall,
  };
}

/** A summary's consistent SQL balance remains authoritative until a later auth read. */
export function createRenewalDisplay(
  onSnapshot?: (owner: BalanceOwner, order: number) => void,
) {
  const arrivals = new WeakMap<
    object,
    { order: number; owner: BalanceOwner }
  >();
  return (
    summary: RenewalSummary | null | undefined,
    owner: BalanceOwner | null | undefined,
    current: BalanceOwner | null | undefined,
  ) => {
    const original = renewalDisplay(summary, summary?.balance);
    if (
      !summary ||
      !owner ||
      original.status === "unknown" ||
      original.status === "none"
    )
      return original;
    if (!arrivals.has(summary)) {
      const origin = {
        username: owner.username,
        id: owner.id,
        tuzis: original.balance!,
      };
      const order = beginAccountBalanceRead();
      arrivals.set(summary, { order, owner: origin });
      onSnapshot?.(origin, order);
    }
    const arrival = arrivals.get(summary)!;
    return current &&
      current.username === arrival.owner.username &&
      (arrival.owner.id === undefined || current.id === arrival.owner.id) &&
      hasAccountAuthReadAfter(current, arrival.order)
      ? renewalDisplay(summary, current.tuzis)
      : original;
  };
}
