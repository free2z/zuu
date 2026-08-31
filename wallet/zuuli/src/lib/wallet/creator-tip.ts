const CREATOR_TIP_VERSION = 1;
const MAX_PENDING_INTENTS = 32;

export interface CreatorTipIntent {
  readonly username: string;
  readonly label: string;
  readonly recipient: string;
}

export interface CreatorTipRouteState {
  readonly creatorTip: {
    readonly version: typeof CREATOR_TIP_VERSION;
    readonly nonce: string;
    readonly username: string;
    readonly label: string;
    readonly recipient: string;
  };
}

interface PendingCreatorTip extends CreatorTipIntent {
  readonly nonce: string;
}

// A route state is renderer-controlled and therefore cannot authenticate
// itself. Keep the source snapshot in module memory and use the route nonce
// only as a lookup capability. Reloads and fresh deep links intentionally lose
// this map and fail closed; creator payment details never enter web storage.
const pendingCreatorTips = new Map<string, PendingCreatorTip>();
const claimedCreatorTips = new WeakMap<object, string>();

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    codePointLength(value) <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isCreatorTipSource(value: CreatorTipIntent): boolean {
  return (
    isBoundedText(value.username, 150) &&
    isBoundedText(value.label, 128) &&
    isBoundedText(value.recipient, 255) &&
    !/\s/u.test(value.recipient)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function nonce(): string {
  return crypto.randomUUID();
}

/**
 * Issue a non-persisted, alteration-detecting handoff to Wallet Send.
 * Address syntax and network remain exclusively authoritative in the native
 * wallet's validateAddress/proposeSend boundaries.
 */
export function createCreatorTipRouteState(
  source: CreatorTipIntent,
): CreatorTipRouteState {
  if (!isCreatorTipSource(source)) {
    throw new Error("Creator ZEC tip details are missing or malformed");
  }

  const issued = Object.freeze({
    nonce: nonce(),
    username: source.username,
    label: source.label,
    recipient: source.recipient,
  });
  pendingCreatorTips.set(issued.nonce, issued);
  while (pendingCreatorTips.size > MAX_PENDING_INTENTS) {
    const oldest = pendingCreatorTips.keys().next().value;
    if (typeof oldest !== "string") break;
    pendingCreatorTips.delete(oldest);
  }

  return Object.freeze({
    creatorTip: Object.freeze({
      version: CREATOR_TIP_VERSION,
      ...issued,
    }),
  });
}

/** Return an immutable source snapshot only when every route field is exact. */
export function readCreatorTipRouteState(
  state: unknown,
): CreatorTipIntent | null {
  if (
    typeof state !== "object" ||
    state === null ||
    Array.isArray(state) ||
    !hasExactKeys(state as Record<string, unknown>, ["creatorTip"])
  ) {
    return null;
  }

  const candidate = (state as { creatorTip?: unknown }).creatorTip;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    !hasExactKeys(candidate as Record<string, unknown>, [
      "version",
      "nonce",
      "username",
      "label",
      "recipient",
    ])
  ) {
    return null;
  }

  const route = candidate as Record<string, unknown>;
  if (
    route.version !== CREATOR_TIP_VERSION ||
    typeof route.nonce !== "string" ||
    typeof route.username !== "string" ||
    typeof route.label !== "string" ||
    typeof route.recipient !== "string"
  ) {
    return null;
  }

  const issued = pendingCreatorTips.get(route.nonce);
  if (
    !issued ||
    route.username !== issued.username ||
    route.label !== issued.label ||
    route.recipient !== issued.recipient
  ) {
    return null;
  }

  const intent = Object.freeze({
    username: issued.username,
    label: issued.label,
    recipient: issued.recipient,
  });
  claimedCreatorTips.set(intent, issued.nonce);
  return intent;
}

/** Retire an accepted payment intent so browser Back cannot offer it again. */
export function retireCreatorTipIntent(intent: CreatorTipIntent): void {
  const issuedNonce = claimedCreatorTips.get(intent);
  if (!issuedNonce) return;
  pendingCreatorTips.delete(issuedNonce);
  claimedCreatorTips.delete(intent);
}
