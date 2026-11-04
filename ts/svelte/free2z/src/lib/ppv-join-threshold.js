// The PPV admission gate mirrors py/dj/apps/dyte/views.py:
// ceil(price_per_minute * 30) + 15 2Z.
//
// CreatorMeeting.price_per_minute is a DecimalField(decimal_places=2). Work
// in integer cents rather than binary floating point so rates such as 0.29
// cannot drift across the ceil boundary. Invalid input is intentionally
// represented as null; the UI should not show a made-up threshold while the
// input is empty or malformed.
const DECIMAL_PRICE = /^(?:\d+)(?:\.\d{1,2})?$/;
const MAX_PRICE_CENTS = 999999;

/**
 * Return the 2Z balance required to join a PPV stream, or null for input that
 * cannot be represented by the backend's two-decimal, six-digit price field.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function ppvJoinThreshold(value) {
  let text;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    text = String(value);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    return null;
  }

  if (!DECIMAL_PRICE.test(text)) return null;

  const [whole, fraction = ""] = text.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents <= 0n || cents > BigInt(MAX_PRICE_CENTS)) return null;

  // ceil(cents / 100 * 30) == ceil(cents * 3 / 10). BigInt keeps this exact
  // even for a large value typed into the number input.
  const threshold = (cents * 3n + 9n) / 10n + 15n;
  const numericThreshold = Number(threshold);
  return Number.isSafeInteger(numericThreshold) ? numericThreshold : null;
}
