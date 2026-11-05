/** Centralized CLDR display-name construction. Locale fallback lists are
 * retained: content-language tags are not restricted to product UI locales.
 * @param {string | string[]} locales
 * @param {Intl.DisplayNamesOptions} options
 */
export function createDisplayNames(locales, options) {
  return new Intl.DisplayNames(locales, options);
}

/** @param {string | string[] | undefined} locales
 * @param {Intl.CollatorOptions} [options]
 */
export function createCollator(locales, options) {
  return new Intl.Collator(locales, options);
}

/** Format a numeric value without changing its units or scaling.
 * @param {number | bigint | Intl.StringNumericLiteral} value
 * @param {string | string[] | undefined} locales
 * @param {Intl.NumberFormatOptions} [options]
 */
export function formatDisplayNumber(value, locales, options) {
  return new Intl.NumberFormat(locales, options).format(value);
}

/** @param {Date | number} value
 * @param {string | string[] | undefined} locales
 * @param {Intl.DateTimeFormatOptions} [options]
 */
export function formatDisplayDate(value, locales, options) {
  return new Intl.DateTimeFormat(locales, options).format(value);
}
