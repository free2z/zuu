/**
 * Display formatting for 2Z credit balances (issues, ).
 *
 * Two defects put this in one shared module instead of two page-local copies:
 *
 *  1. DRF serializes `DecimalField` as a STRING, and
 *     `String.prototype.toLocaleString()` ignores its arguments and returns the
 *     string unchanged. `(creator.tuzis).toLocaleString($locale)` therefore
 *     rendered the raw payload — "64672.234" — and TypeScript never saw it
 *     because the loader's `creator` is `any`.
 *  2. The profile dashboard fixed (1) with a truncate-then-`Number()` helper,
 *     and the `Number()` round-trip re-rounds: a value near 1e14 with two
 *     decimals needs ~16 significant digits and a double carries ~15.95, so
 *     `Number("99999999999999.01")` is `99999999999999.02` — the one thing a
 *     balance formatter exists to prevent.
 *
 * So the rule, and the reason every function below works on text: **truncate
 * the decimal text and keep it text all the way through formatting.** A
 * balance is never rounded up. `tuzis` is `decimal_places=3`, so a plain
 * `maximumFractionDigits: 2` renders 4.996 as "5" — more than the creator
 * holds, sitting next to actions priced at 5 that will then fail.
 * `Math.trunc(n * 100) / 100` is not a fix either: it overflows 2^53 and turns
 * 99999999999999.999 into 100000000000000, overstating by the largest possible
 * margin exactly where precision matters most.
 *
 * 2Z are platform credits — not money, not crypto. Nothing here formats a
 * currency, and it must not start.
 */

/** What a stat tile shows when there is no readable value at all. */
const NO_VALUE = "—";

/**
 * Renders any finite double as plain decimal text — never exponent notation,
 * which `String(1e21)` produces and the parser below would reject. `Intl` is
 * used purely as a serializer here, hence the fixed locale and grouping off.
 */
const PLAIN_DECIMAL = new Intl.NumberFormat("en-US", {
  useGrouping: false,
  maximumFractionDigits: 20,
});

/**
 * Coerce a DRF decimal string (or a number) to a finite number, or null.
 * Exported because whole-number stats still format through `Intl` normally —
 * only balances need the text path.
 */
export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The decimal text as DRF writes it: optional sign, digits, optional fraction. */
const DECIMAL_TEXT = /^([+-]?)(\d*)(?:\.(\d*))?$/;

type DecimalParts = { negativeSign: boolean; whole: string; fraction: string };

function parseDecimalText(text: string): DecimalParts | null {
  const match = DECIMAL_TEXT.exec(text);
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  // "", ".", "-" and "+." all match the pattern but are not numbers.
  if (!whole && !fraction) return null;
  return { negativeSign: sign === "-", whole: whole || "0", fraction };
}

/** The locale's decimal separator, discovered rather than assumed. */
function decimalSeparator(locale?: string): string {
  return (
    new Intl.NumberFormat(locale, { minimumFractionDigits: 1 })
      .formatToParts(0.1)
      .find((part) => part.type === "decimal")?.value ?? "."
  );
}

function minusSign(locale?: string): string {
  return (
    new Intl.NumberFormat(locale)
      .formatToParts(-1)
      .find((part) => part.type === "minusSign")?.value ?? "-"
  );
}

/**
 * Group an arbitrarily long run of digits. `BigInt`, not `Number`: the whole
 * point of this module is that the integer part of a `max_digits=17` value
 * does not survive a double.
 */
function groupInteger(
  digits: string,
  negative: boolean,
  locale?: string,
): string {
  const magnitude = BigInt(digits);
  const formatter = new Intl.NumberFormat(locale, {
    useGrouping: true,
    maximumFractionDigits: 0,
  });
  if (!negative) return formatter.format(magnitude);
  if (magnitude !== 0n) return formatter.format(-magnitude);
  // "-0.50": the integer part is zero, so the sign lives only in the fraction
  // and `Intl` would print a bare "0" and drop it.
  return `${minusSign(locale)}${formatter.format(magnitude)}`;
}

/**
 * A 2Z balance: grouped, TRUNCATED toward zero at 2 decimals, no padding — so
 * "3454.000" reads as "3,454", "64672.234" as "64,672.23", and
 * "99999999999999.010" as "99,999,999,999,999.01" rather than the ".02" a
 * double round-trip produces.
 *
 * `locale` is the app's `$locale`; omitted, `Intl` uses the runtime default.
 *
 * **Pass the DRF string, never a `Number()` of it.** A `number` is accepted so
 * a literal fallback and an `any`-typed payload cannot crash the tile, but by
 * the time a balance is a double the precision is already gone — this function
 * cannot recover it, and `formatTuzis(Number("99999999999999.010"))` really
 * does print ".02". That limit is pinned by a test rather than left to be
 * rediscovered. It is not enforced at runtime because refusing to render is a
 * worse answer than rendering, and because the callers here all pass strings.
 */
export function formatTuzis(value: unknown, locale?: string): string {
  let text: string | null = null;
  if (typeof value === "number") {
    text = Number.isFinite(value) ? PLAIN_DECIMAL.format(value) : null;
  } else if (typeof value === "string") {
    text = value.trim();
  }
  if (!text) return NO_VALUE;

  const parts = parseDecimalText(text);
  if (!parts) return NO_VALUE;

  // Truncate, then drop trailing zeros: three decimals of padding is noise in
  // a stat tile, and nothing here may ever round the last digit up.
  const cents = parts.fraction.slice(0, 2).replace(/0+$/, "");
  // A value whose digits are all zero is not negative, whatever the sign said.
  const negative = parts.negativeSign && /[1-9]/.test(parts.whole + cents);
  const whole = groupInteger(parts.whole, negative, locale);
  return cents ? `${whole}${decimalSeparator(locale)}${cents}` : whole;
}

/**
 * A DEFICIT, formatted as the whole number of 2Z that clears it.
 *
 * `formatTuzis` truncates toward zero, which is right for a balance — never
 * claim the holder has more than they do — and exactly wrong for an amount
 * somebody must add: a real shortfall of `0.001` truncates to "0", telling a
 * fan to do nothing about a renewal the worker will still reject. So this
 * rounds AWAY from zero to a whole credit, which is also the only unit
 * checkout sells. Text in, text out, `BigInt` for the carry: the module's
 * whole reason for existing is that a `max_digits=17` value does not survive
 * a double, and `Math.ceil` would reintroduce exactly that.
 *
 * Negative and unparseable inputs fall back to `formatTuzis`, which renders
 * the em dash; a shortfall is never negative in practice.
 */
export function formatTuzisDeficit(value: unknown, locale?: string): string {
  const text =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number" && Number.isFinite(value)
        ? PLAIN_DECIMAL.format(value)
        : "";
  const parts = text ? parseDecimalText(text) : null;
  if (!parts || parts.negativeSign) return formatTuzis(value, locale);

  const carry = /[1-9]/.test(parts.fraction) ? 1n : 0n;
  return groupInteger(String(BigInt(parts.whole) + carry), false, locale);
}
