import {
  getCurrentLocale,
  resolveSupportedLocale,
  type SupportedLocale,
} from "$lib/i18n";

/**
 * The ONE place the UI turns an API timestamp into a `Date` and a `Date` into
 * text. Parse with `parseApiDate`, then render with
 * `formatRelativeTime`, `formatDate` or `formatDateTime`; do not call
 * `new Date(apiString)` or `toLocaleDateString` in a component.
 *
 * Why it exists: the events API used to send `created_at` as
 * `"2026-09-28 18:00:00"` -- a UTC wall-clock time with no offset. The
 * ECMAScript date-time string format reads an offset-less date-time as the
 * viewer's LOCAL time, so for a viewer in EDT (UTC-4) a platform fee charged a
 * second ago rendered "in 4 hours". The backend now always sends an offset,
 * but a parser that silently depends on that is one serializer away from the
 * same bug, so this one does not: an offset-less date-time from the API is UTC.
 *
 * Absolute times render in the viewer's own time zone (Intl's default). A
 * date-only value (`"2026-09-28"`) is a calendar date, not an instant, and is
 * rendered as that same date everywhere rather than shifted a day west of UTC.
 */

export type DateInput = string | number | Date | null | undefined;

// `YYYY-MM-DD` followed by `T` or a space and a time, with no `Z`/`±hh:mm`.
const OFFSETLESS_DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A future timestamp this close to "now" is clock skew between the viewer's
 * device and the server, not a scheduled event: render it as "now" instead of
 * "in 2 minutes". Anything further out is shown honestly, so a real bug like
 * 's four hours can never be hidden by this.
 */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

function isDateOnly(value: DateInput): value is string {
  return typeof value === "string" && DATE_ONLY.test(value.trim());
}

/**
 * Parse an API timestamp. Returns `null` for empty or unparseable input.
 * Offset-less ISO-like date-times (`"2026-09-28 18:00:00"`,
 * `"2026-09-28T18:00:00.123456"`) are interpreted as UTC, never local time.
 */
export function parseApiDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;

  let date: Date;
  if (value instanceof Date) {
    date = new Date(value.getTime());
  } else if (typeof value === "number") {
    date = new Date(value);
  } else {
    const text = value.trim();
    const offsetless = OFFSETLESS_DATE_TIME.exec(text);
    // JavaScript Dates carry milliseconds; Django sends microseconds. Trim the
    // fraction to three digits so every engine accepts the string.
    date = offsetless
      ? new Date(
          `${offsetless[1]}T${offsetless[2].replace(/(\.\d{3})\d+$/, "$1")}Z`,
        )
      : new Date(text);
  }

  return Number.isNaN(date.getTime()) ? null : date;
}

/** Epoch milliseconds for sorting and comparison; `NaN` when unparseable. */
export function toTimestamp(value: DateInput): number {
  return parseApiDate(value)?.getTime() ?? Number.NaN;
}

function resolveLocale(requestedLocale?: string): SupportedLocale | string {
  return resolveSupportedLocale(requestedLocale) ?? getCurrentLocale();
}

function fallbackText(value: DateInput): string {
  return typeof value === "string" ? value : "";
}

export interface RelativeTimeOptions {
  /** Reference instant; defaults to the current time. */
  now?: Date | number;
  /** Text for |difference| under a minute (defaults to Intl's "now"). */
  justNow?: string;
  /**
   * Past this many seconds, render the absolute date instead of a relative
   * phrase, using `absoluteOptions`.
   */
  absoluteAfterSeconds?: number;
  absoluteOptions?: Intl.DateTimeFormatOptions;
}

/**
 * Relative time ("5 minutes ago", "now"). Unparseable input is returned as-is.
 */
export function formatRelativeTime(
  value: DateInput,
  requestedLocale?: string,
  options: RelativeTimeOptions = {},
): string {
  const date = parseApiDate(value);
  if (!date) return fallbackText(value);

  try {
    const now =
      options.now instanceof Date
        ? options.now.getTime()
        : (options.now ?? Date.now());
    let diffMs = date.getTime() - now;
    if (diffMs > 0 && diffMs <= CLOCK_SKEW_TOLERANCE_MS) diffMs = 0;
    const diffInSeconds = Math.round(diffMs / 1000);
    const absoluteDiff = Math.abs(diffInSeconds);
    const locale = resolveLocale(requestedLocale);

    if (absoluteDiff < 60 && options.justNow !== undefined) {
      return options.justNow;
    }
    if (
      options.absoluteAfterSeconds !== undefined &&
      absoluteDiff >= options.absoluteAfterSeconds
    ) {
      return formatDateTime(value, locale, options.absoluteOptions);
    }

    const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

    if (absoluteDiff < 60) return formatter.format(0, "second");
    if (absoluteDiff < 3600) {
      return formatter.format(Math.round(diffInSeconds / 60), "minute");
    }
    if (absoluteDiff < 86400) {
      return formatter.format(Math.round(diffInSeconds / 3600), "hour");
    }
    if (absoluteDiff < 604800) {
      return formatter.format(Math.round(diffInSeconds / 86400), "day");
    }
    if (absoluteDiff < 2592000) {
      return formatter.format(Math.round(diffInSeconds / 604800), "week");
    }
    if (absoluteDiff < 31536000) {
      return formatter.format(Math.round(diffInSeconds / 2592000), "month");
    }

    return formatter.format(Math.round(diffInSeconds / 31536000), "year");
  } catch {
    return fallbackText(value);
  }
}

/**
 * Absolute date and/or time in the viewer's time zone. `options` are
 * `Intl.DateTimeFormat` options; a date-only input is pinned to its calendar
 * date. Returns `invalid` (default: the input string, or "") when unparseable.
 */
export function formatDateTime(
  value: DateInput,
  requestedLocale?: string,
  options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
  },
  invalid?: string,
): string {
  const date = parseApiDate(value);
  if (!date) return invalid ?? fallbackText(value);

  const resolved: Intl.DateTimeFormatOptions = isDateOnly(value)
    ? { ...options, timeZone: "UTC" }
    : options;
  try {
    return new Intl.DateTimeFormat(
      resolveLocale(requestedLocale),
      resolved,
    ).format(date);
  } catch {
    return date.toISOString();
  }
}

/** Absolute calendar date in the viewer's time zone ("Sep 28, 2026"). */
export function formatDate(
  value: DateInput,
  requestedLocale?: string,
  options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
  },
  invalid?: string,
): string {
  return formatDateTime(value, requestedLocale, options, invalid);
}

/**
 * Absolute scheduled-publication time, in the viewer's time zone with the
 * zone named ("Sep 28, 2026, 2:00 PM EDT"). The editor's datetime-local input
 * is in the creator's local zone too, so the two now agree. The zone name keeps
 * the server-rendered text (UTC, before hydration) true rather than ambiguous.
 */
export function formatScheduledTime(
  value: DateInput,
  requestedLocale?: string,
): string {
  return formatDateTime(value, requestedLocale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
