/** Exact fixed-point fallback for engines that coerce decimal strings to Number.
 * Unsupported advanced rounding/notation returns null rather than an inaccurate value.
 * @param {string} value
 * @param {string} locale
 * @param {Intl.NumberFormatOptions} options
 * @returns {string | null}
 */
export function formatExactDecimalFallback(value, locale, options = {}) {
  if (
    options.maximumSignificantDigits !== undefined ||
    options.minimumSignificantDigits !== undefined ||
    (options.notation && options.notation !== "standard") ||
    options.style === "percent" ||
    options.currencyDisplay === "name" ||
    options.roundingIncrement !== undefined ||
    (options.roundingMode && options.roundingMode !== "halfExpand")
  )
    return null;
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  try {
    const formatter = new Intl.NumberFormat(locale, options);
    const { minimumFractionDigits: min, maximumFractionDigits: max } =
      formatter.resolvedOptions();
    if (max === undefined || min === undefined || max > 100) return null;
    const fraction = match[3] || "";
    const digits = BigInt(match[2] + fraction);
    const scale = fraction.length;
    let rounded;
    if (scale > max) {
      const divisor = 10n ** BigInt(scale - max);
      rounded = digits / divisor;
      if ((digits % divisor) * 2n >= divisor) rounded++;
    } else rounded = digits * 10n ** BigInt(max - scale);
    const factor = 10n ** BigInt(max);
    const integer = rounded / factor;
    let tail = max ? (rounded % factor).toString().padStart(max, "0") : "";
    while (tail.length > min && tail.endsWith("0")) tail = tail.slice(0, -1);
    const negative = match[1] === "-";
    const parts = formatter.formatToParts(
      negative ? (integer === 0n ? -0 : -integer) : integer,
    );
    const numberDigits = new Intl.NumberFormat(locale, {
      useGrouping: false,
      maximumFractionDigits: 0,
    });
    const localized = [...tail]
      .map((digit) => numberDigits.format(Number(digit)))
      .join("");
    const decimal = new Intl.NumberFormat(locale, {
      useGrouping: false,
      minimumFractionDigits: 1,
    })
      .formatToParts(1.1)
      .find((part) => part.type === "decimal")?.value;
    if (tail && !decimal) return null;
    const result = [];
    let inserted = false;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.type === "decimal" || part.type === "fraction") continue;
      result.push(part.value);
      if (part.type === "integer" && parts[i + 1]?.type !== "group") {
        if (tail) result.push(decimal, localized);
        inserted = true;
      }
    }
    return inserted ? result.join("") : null;
  } catch {
    return null;
  }
}
