/**
 * The membership price a creator types on Settings, checked against the rules
 * the server enforces — so the page refuses what the server would refuse, and
 * says why, before a save is attempted.
 *
 * ## The contract (`py/dj/apps/g12f/models/creator.py`, `member_price`)
 *
 *   `DecimalField(max_digits=6, decimal_places=0, default=10,
 *                 validators=[MinValueValidator(0)])`   -- NOT NULL
 *
 * so the server accepts exactly one thing: a whole number of 2Z from
 * `MEMBER_PRICE_MIN` (0) to `MEMBER_PRICE_MAX`, charged every 30 days
 * (`Subscription.extend` -> `ledger.transfer`). `0` is a FREE membership: a
 * free follow that still grants member access and moves no 2Z. Every creator
 * offers a membership; there is no "none" any more, so an empty field is
 * refused (`null` is a 400) instead of meaning "no membership". 2Z are
 * platform credits; the price was mislabelled ZEC until.
 *
 * Before  the server refused `0` (`MinValueValidator(1)`) and `null`
 * meant "no membership offered"; the owner made 0 free on 2026-10-06 and
 * backfilled every NULL to 0.
 *
 * ## Value, not spelling
 *
 * DRF's `DecimalField` judges the STRING it is sent: `"1.0"` is refused
 * ("no more than 0 decimal places") though it is the integer 1. So the client
 * never forwards what was typed. It reads the typed text as a number, applies
 * the server's rules to that number, and sends the canonical whole-number
 * string (`"1"`). The accepted *values* are then exactly the server's, and the
 * body on the wire is always one the server takes.
 *
 * `tests/fixtures/member-price-contract.json` is the shared table of cases:
 * `tests/member-price.test.mjs` runs it through this module and
 * `py/dj/apps/g12f/test_member_price_contract.py` PATCHes the SAME table
 * through the real serializer. If either side's rules move, one of them fails.
 */

/** `MinValueValidator(0)` -- 0 is a free membership. */
export const MEMBER_PRICE_MIN = 0;

/** `max_digits=6, decimal_places=0`: six whole digits. */
export const MEMBER_PRICE_MAX = 999_999;

export type MemberPriceProblem =
  /** Nothing typed. The price is NOT NULL (0 = free). */
  | "empty"
  /** Not a number at all ("abc", "0x10", "1,000"). */
  | "not-a-number"
  /** A number, but not a whole one ("1.5"). */
  | "not-whole"
  /** Negative. */
  | "too-small"
  /** More than six digits. */
  | "too-large";

export type MemberPriceResult =
  /** `value` is exactly what goes in the PATCH body. */
  { ok: true; value: string } | { ok: false; problem: MemberPriceProblem };

/**
 * A plain decimal numeral: optional sign, digits with an optional fraction,
 * optional exponent. Deliberately narrower than `Number()`, which also takes
 * `0x10`, `0b1`, `Infinity` and `""` (as 0) — spellings Python's `Decimal`
 * refuses, so accepting them would send a value the creator never typed.
 */
const DECIMAL_NUMERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Parse what the creator typed into the value the PATCH should carry.
 *
 * `raw` is the input's text. `null`/`undefined` and whitespace are refused as
 * `empty`: there is no "no membership" any more -- 0 is the free one.
 */
export function parseMemberPrice(
  raw: string | number | null | undefined,
): MemberPriceResult {
  if (raw === null || raw === undefined) return { ok: false, problem: "empty" };
  const text = String(raw).trim();
  if (text === "") return { ok: false, problem: "empty" };
  if (!DECIMAL_NUMERAL.test(text))
    return { ok: false, problem: "not-a-number" };

  const value = Number(text);
  // `1e400` parses to Infinity; it is also more than six digits.
  if (!Number.isFinite(value)) return { ok: false, problem: "too-large" };
  if (!Number.isInteger(value)) return { ok: false, problem: "not-whole" };
  if (value < MEMBER_PRICE_MIN) return { ok: false, problem: "too-small" };
  if (value > MEMBER_PRICE_MAX) return { ok: false, problem: "too-large" };
  // `String(-0)` is "0": "-0" is the free price, sent canonically.
  return { ok: true, value: String(value) };
}

type Translate = (
  key: string,
  fallback: string,
  params?: Record<string, string | number>,
) => string;

/** One sentence per problem, each naming the rule AND the way out. */
export function memberPriceProblemMessage(
  problem: MemberPriceProblem,
  t: Translate,
  locale = "en",
): string {
  const params = {
    min: MEMBER_PRICE_MIN.toLocaleString(locale),
    max: MEMBER_PRICE_MAX.toLocaleString(locale),
  };
  switch (problem) {
    case "empty":
      return t(
        "dashboard.settings.errors.memberPriceEmpty",
        "Enter a membership price. Use 0 for a free membership (a free follow).",
        params,
      );
    case "too-small":
      return t(
        "dashboard.settings.errors.memberPriceNegative",
        "The membership price can't be negative. Use 0 for a free membership.",
        params,
      );
    case "too-large":
      return t(
        "dashboard.settings.errors.memberPriceTooLarge",
        "The membership price can be at most {max} 2Z.",
        params,
      );
    case "not-whole":
    case "not-a-number":
    default:
      return t(
        "dashboard.settings.errors.memberPriceNotWhole",
        "The membership price must be a whole number of 2Z, from {min} to {max}.",
        params,
      );
  }
}
