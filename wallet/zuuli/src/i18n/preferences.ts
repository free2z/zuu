import { LOCALE_STORAGE_KEY, normalizeLocale, type SupportedLocale } from "./locale";

export const PREFERENCES_KEY = "zuuli-device-preferences";

export function readPreferenceLocale(): unknown {
  try {
    const raw = localStorage.getItem(PREFERENCES_KEY);
    if (raw !== null) {
      try {
        const preferences: unknown = JSON.parse(raw);
        if (preferences && typeof preferences === "object" && !Array.isArray(preferences) &&
            "locale" in preferences && normalizeLocale(preferences.locale)) {
          return preferences.locale;
        }
      } catch { /* Invalid preferences must not hide the legacy choice. */ }
    }
    return localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function savePreferenceLocale(locale: SupportedLocale): void {
  try {
    const raw = localStorage.getItem(PREFERENCES_KEY);
    let preferences: Record<string, unknown> = {};
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) preferences = parsed as Record<string, unknown>;
      } catch { /* Replace malformed preferences. */ }
    }
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ ...preferences, locale: normalizeLocale(locale) }));
  } catch {
    // The active language still changes when storage is unavailable.
  }
}
