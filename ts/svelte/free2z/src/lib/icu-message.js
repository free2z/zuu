import { IntlMessageFormat } from "intl-messageformat";

// Explicit migration: legacy strings retain their historical brace and quote rules.
// Every locale's pattern for a listed key must be valid ICU before it is added.
/** @type {readonly ["trending.pageOf", "tag.pageOf"]} */
export const ICU_MESSAGE_KEYS = Object.freeze([
  "trending.pageOf",
  "tag.pageOf",
]);

/**
 * Format plain text only. Invalid patterns and missing arguments throw.
 * @param {string} pattern
 * @param {string} locale
 * @param {Record<string, string | number>} values
 * @returns {string}
 */
export function formatIcuMessage(pattern, locale, values = {}) {
  const message = new IntlMessageFormat(pattern, locale, undefined, {
    ignoreTag: true,
  });
  const result = message.format(values);
  if (typeof result !== "string") throw new TypeError("Expected plain text");
  return result;
}
