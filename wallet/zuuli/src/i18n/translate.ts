import { getI18n } from "react-i18next";
import type { MessageKey } from "./messages";

/**
 * Imperative event handlers and non-React presenters only: each call reads the
 * active locale. React render owners must subscribe with useTranslation and
 * use its bound t function (uiT). Static descriptor getters are re-read by a
 * subscribed parent. Never cache translated text or errors in component state;
 * store message keys or domain states and translate them during render.
 */
export function translate(
  key: MessageKey,
  values: Record<string, unknown> = {},
): string {
  const instance = getI18n();
  if (!instance?.isInitialized)
    throw new Error("translation used before locale bootstrap");
  return instance.t(key, values) as string;
}
