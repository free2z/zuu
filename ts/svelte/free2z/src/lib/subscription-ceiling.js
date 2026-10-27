/**
 * Subscription price-ceiling classification (issues, ).
 *
 * A fan's subscription card shows a "Maximum 2Z per month" ceiling, which is
 * only meaningful next to the creator's current price. These helpers decide
 * what the card is allowed to claim about the next renewal.
 *
 * Everything here mirrors backend behaviour rather than field names. The four
 * invariants encoded below all live in `py/dj/apps/`:
 *
 *   1. `member_price` is NOT NULL since; a null here is a REDACTED
 *      (deactivated) creator, whose subscription cannot renew.
 *   2. A price of 0 is a FREE membership: `Subscription.extend()`
 *      grants the 30 days without calling `ledger.transfer()`, so a free
 *      subscription with a positive ceiling renews at no cost. A negative
 *      price is refused (`extend()` raises before any transfer).
 *   3. Cancellation is modelled as `max_price = 0`
 *      (`CreatorSubscribeView.delete`), and `MySubscriptionsListView` filters
 *      only on `expires__gt=now` — so a cancelled row keeps listing, and keeps
 *      looking live, for up to 30 days. A deactivated creator's existing row
 *      also remains visible so the fan can revoke future billing.
 *   4. `CreatorSubscribeView.patch` compares `max_price >= star.member_price`
 *      as raw `Decimal`s, so a null `member_price` raises `TypeError` (500).
 *
 * Invariant 4 is why `unpriced` MUST be checked before `cancelled`: the
 * cancelled notice tells the fan to raise their maximum to restart, and with a
 * null price that PATCH 500s (now 400s; either way, advice it cannot honour).
 * A free membership with no ceiling (`max_price = 0`, which is what a free
 * follow records) is `free`, not `cancelled`: the fan never cancelled it. `+page.server.ts` floors a missing `memberPrice`
 * to 1 and Svelte drops a `null` value attribute, so such a request sails past
 * every client-side check. Never hand out advice the backend cannot honour.
 *
 * The table test in `tests/subscription-ceiling.test.mjs` pins this ordering.
 */

/**
 * Warn when the remaining headroom is this fraction of the ceiling or less.
 * @type {number}
 */
export const SUBSCRIPTION_HEADROOM_WARN_RATIO = 0.1;

/**
 * `member_price` is `decimal_places=0`, so the smallest possible price rise is
 * 1 2Z. A pure percentage threshold misses small numbers entirely — with a 10%
 * rule, `max=5, price=4` and `max=2, price=1` both look comfortable while
 * being exactly one increment from not renewing. Floor the warning band at one
 * whole unit so "one raise away" always warns (issue ).
 * @param {number} max
 * @returns {number}
 */
export function headroomWarnThreshold(max) {
  return Math.max(1, max * SUBSCRIPTION_HEADROOM_WARN_RATIO);
}

/**
 * Prices arrive from DRF as decimal strings ("50.00") or null; the server
 * action parses them with parseInt, so compare on the same numeric footing.
 * @param {unknown} value
 * @returns {number | null}
 */
export function parsePrice(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (
    typeof value !== "string" ||
    !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @typedef {"unknown" | "unpriced" | "free" | "cancelled" | "ok" | "near" | "at" | "over"} PriceCeiling
 * `unknown`   — unparseable; say nothing rather than something wrong.
 * `unpriced`  — no usable `member_price` (redacted/negative): cannot renew.
 * `free`      — price 0 and no ceiling: a free follow that will not renew on
 *               its own (follow again when it ends).
 * `cancelled` — `max_price <= 0` on a paid membership.
 * `over`      — price above the ceiling: renewal is impossible.
 * `at`        — price exactly at the ceiling: any rise ends it.
 * `near`      — within one raise of the ceiling.
 * `ok`        — comfortable headroom.
 */

/**
 * @param {unknown} memberPrice the creator's current price
 * @param {unknown} maxPrice the fan's ceiling
 * @returns {PriceCeiling}
 */
export function priceCeiling(memberPrice, maxPrice) {
  const price = parsePrice(memberPrice);
  const max = parsePrice(maxPrice);
  if (max === null) return "unknown";
  // A null (redacted) or negative price cannot renew (invariants 1 and 2).
  // Checked BEFORE cancellation on purpose — see the module comment.
  if (price === null || price < 0) return "unpriced";
  // 0 IS free. With a positive ceiling it renews at no cost and falls
  // through to the headroom arithmetic below (a later price rise is still
  // bounded by that ceiling).
  if (max <= 0) return price === 0 ? "free" : "cancelled";
  if (price > max) return "over";
  if (price === max) return "at";
  if (max - price <= headroomWarnThreshold(max)) return "near";
  return "ok";
}

/**
 * States in which the next renewal cannot happen, so the card must not claim a
 * renewal date. `at` and `near` still renew today — they are warnings about a
 * future price rise, not about this cycle.
 * @type {ReadonlySet<PriceCeiling>}
 */
export const RENEWAL_BLOCKING_CEILINGS = new Set(
  /** @type {PriceCeiling[]} */ (["unpriced", "free", "cancelled", "over"]),
);

/**
 * @param {PriceCeiling} ceiling
 * @returns {boolean}
 */
export function ceilingBlocksRenewal(ceiling) {
  return RENEWAL_BLOCKING_CEILINGS.has(ceiling);
}

/**
 * @param {string | null | undefined} expiresAt
 * @param {Date} [now]
 * @returns {"active" | "expired" | "unknown"}
 */
export function subscriptionState(expiresAt, now = new Date()) {
  const expires = new Date(String(expiresAt));
  if (Number.isNaN(expires.getTime())) return "unknown";
  return expires < now ? "expired" : "active";
}

/**
 * @typedef {"active" | "ending" | "expired" | "unknown"} SubscriptionCardState
 * `ending` — still inside the paid period, but nothing will renew it, so the
 * card says when access *ends* instead of when it renews (issue ).
 * `unknown` — the card claims nothing at all.
 */

/**
 * What the card as a whole should claim: the expiry clock alone is not enough,
 * because a subscription can be paid-through-Sep-3 and simultaneously doomed.
 *
 * Note this deliberately fails CLOSED on an `unknown` ceiling. `max_price` is
 * `default=0, null=False`, so an unparseable one means the payload is not what
 * we think it is — serializer drift, a partial rollout, a proxy mangling the
 * response. Printing "Renews Sep 3" off data we could not read is a money
 * promise made on an unverified premise; "Unknown" with no date is not.
 * (Raised by the codex adversarial review on PR for.)
 * @param {string | null | undefined} expiresAt
 * @param {PriceCeiling} ceiling
 * @param {Date} [now]
 * @returns {SubscriptionCardState}
 */
export function subscriptionCardState(expiresAt, ceiling, now = new Date()) {
  const state = subscriptionState(expiresAt, now);
  if (state !== "active") return state;
  if (ceiling === "unknown") return "unknown";
  return ceilingBlocksRenewal(ceiling) ? "ending" : "active";
}
