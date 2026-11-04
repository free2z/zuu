export const ACCOUNT_BALANCE_DEPENDENCY = "account:balance";

export type BalanceOwner = {
  username: string;
  id?: number;
  tuzis?: string | number;
  balance_snapshot?: string;
};

/** PostgreSQL visibility metadata is independent of process and browser clocks. */
export function balanceSnapshot(
  value: unknown,
): readonly [bigint, bigint] | undefined {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^(0|[1-9]\d*):(0|[1-9]\d*)$/.test(value)
  )
    return;
  const [maximum, active] = value.split(":").map(BigInt);
  return [maximum, active];
}

export function compareBalanceSnapshots(
  left: unknown,
  right: unknown,
): number | undefined {
  const a = balanceSnapshot(left),
    b = balanceSnapshot(right);
  if (!a || !b) return;
  return a[0] === b[0]
    ? a[1] === b[1]
      ? 0
      : a[1] < b[1]
        ? 1
        : -1
    : a[0] > b[0]
      ? 1
      : -1;
}

const readRevisions = new WeakMap<object, number>();
const networkReads = new WeakSet<object>();
const authReadOrders = new WeakMap<object, number>();
let nextReadRevision = 0;

export function beginAccountBalanceRead() {
  return ++nextReadRevision;
}

export function recordAccountBalanceRead(
  owner: BalanceOwner,
  order = beginAccountBalanceRead(),
  network = true,
  authRead = false,
) {
  readRevisions.set(owner, order);
  if (network) networkReads.add(owner);
  if (network && authRead) authReadOrders.set(owner, order);
}

const SNAPSHOT_READ_ORDER = Symbol("balance snapshot read order");
export function recordQuotedBalanceRead<T extends object>(
  quote: T,
  order: number,
): T {
  if (!Object.prototype.hasOwnProperty.call(quote, SNAPSHOT_READ_ORDER))
    Object.defineProperty(quote, SNAPSHOT_READ_ORDER, {
      value: order,
      configurable: true,
    });
  return quote;
}

export function snapshotReadOrder(quote: object): number | undefined {
  return (quote as { [SNAPSHOT_READ_ORDER]?: number })[SNAPSHOT_READ_ORDER];
}

/** Metadata-only auth updates must not become new balance reads. */
export function inheritAccountBalanceRead(
  owner: BalanceOwner,
  previous?: BalanceOwner | null,
) {
  if (readRevisions.has(owner)) return;
  const previousRevision = previous && readRevisions.get(previous);
  if (
    typeof previousRevision === "number" &&
    previous &&
    owner.username === previous.username &&
    owner.id === previous.id &&
    owner.tuzis === previous.tuzis &&
    owner.balance_snapshot === previous.balance_snapshot
  ) {
    readRevisions.set(owner, previousRevision);
    if (networkReads.has(previous)) networkReads.add(owner);
    const authOrder = authReadOrders.get(previous);
    if (authOrder !== undefined) authReadOrders.set(owner, authOrder);
  } else {
    recordAccountBalanceRead(owner, undefined, true, false);
  }
}

/** Only the original dispatch of a real auth read proves post-arrival freshness. */
export function hasAccountAuthReadAfter(
  owner: BalanceOwner | null | undefined,
  order: number,
): boolean {
  const authOrder = owner && authReadOrders.get(owner);
  return typeof authOrder === "number" && authOrder > order;
}

function balanceReadKey(owner: BalanceOwner | null | undefined) {
  return owner ? (readRevisions.get(owner) ?? owner) : owner;
}

/** Overlay only a balance; refreshing an account must preserve unsaved forms. */
export function liveAccountBalance(
  owner: BalanceOwner | null | undefined,
  current: BalanceOwner | null | undefined,
): string | number {
  const matches =
    owner &&
    current &&
    owner.username === current.username &&
    (owner.id === undefined ||
      current.id === undefined ||
      owner.id === current.id);
  return (matches ? current.tuzis : undefined) ?? owner?.tuzis ?? "0";
}

/** DB observations outrank render order; legacy routes request a fresh read. */
export function createAccountBalanceDisplay(
  onSnapshot?: (owner: BalanceOwner) => void,
) {
  const baselines = new WeakMap<object, ReturnType<typeof balanceReadKey>>();
  return (
    owner: BalanceOwner | null | undefined,
    current: BalanceOwner | null | undefined,
  ): string | number => {
    if (!owner) return "0";
    if (!baselines.has(owner)) {
      baselines.set(owner, balanceReadKey(current));
      onSnapshot?.(owner);
    }
    const freshness = compareBalanceSnapshots(
      current?.balance_snapshot,
      owner.balance_snapshot,
    );
    if (freshness !== undefined)
      return freshness > 0
        ? liveAccountBalance(owner, current)
        : (owner.tuzis ?? "0");
    // Unknown ordering cannot demote a real account read. Cached/session state
    // still yields to the SSR snapshot until a new authoritative read succeeds.
    return current && networkReads.has(current)
      ? liveAccountBalance(owner, current)
      : (owner.tuzis ?? "0");
  };
}

/** A fresh server quote wins over cached auth; later account reads update its display. */
export function createQuotedBalanceDisplay(
  onSnapshot?: (
    owner?: { username: string; id?: number },
    order?: number,
    balance?: string | number,
  ) => void,
) {
  const baselines = new WeakMap<object, ReturnType<typeof balanceReadKey>>();
  return (
    quote: { balance: string | number } | null,
    owner: { username: string; id?: number } | undefined,
    current: BalanceOwner | null | undefined,
  ): string | number => {
    if (!quote) return "0";
    if (!baselines.has(quote)) {
      baselines.set(quote, snapshotReadOrder(quote) ?? balanceReadKey(current));
      onSnapshot?.(owner, snapshotReadOrder(quote), quote.balance);
    }
    const snapshotOrder = snapshotReadOrder(quote);
    const currentOrder = balanceReadKey(current);
    if (
      snapshotOrder !== undefined &&
      (typeof currentOrder !== "number" || currentOrder <= snapshotOrder)
    )
      return quote.balance;
    if (baselines.get(quote) === currentOrder) return quote.balance;
    return liveAccountBalance(
      { ...owner, username: owner?.username ?? "", tuzis: quote.balance },
      current,
    );
  };
}

/** Keep each refusal tied to the account that saw it, across later balance reads. */
export function createInsufficientFundsBalanceDisplay(
  onSnapshot?: (
    owner?: { username: string; id?: number },
    order?: number,
    balance?: string | number,
  ) => void,
) {
  const owners = new WeakMap<
    object,
    { username: string; id?: number } | undefined
  >();
  const quotedBalance = createQuotedBalanceDisplay(onSnapshot);
  return (
    funds: { balance: string | number },
    current: BalanceOwner | null | undefined,
    owner?: { username: string; id?: number },
  ): string | number => {
    if (!owners.has(funds)) {
      const origin = owner ?? current;
      owners.set(
        funds,
        origin ? { username: origin.username, id: origin.id } : undefined,
      );
    }
    return quotedBalance(funds, owners.get(funds), current);
  };
}
