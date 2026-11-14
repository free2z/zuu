import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/lib/api/http";
import { MESSAGE_KEYS, type MessageKey } from "./messages";
import { translate } from "./translate";

export class UiError extends Error {
  constructor(readonly key: MessageKey) {
    super("ZUULI_UI_ERROR");
  }
}

/** Only structured status has display authority. Never render an error body,
 * native diagnostic, message, stack, token, or arbitrary thrown string. */
export function localizedError(
  error: unknown,
  fallback = translate(MESSAGE_KEYS.errorRequest),
): string {
  if (error instanceof UiError) return translate(error.key);
  if (error instanceof ApiError) {
    if (error.status === 401) return translate(MESSAGE_KEYS.errorSession);
    if (error.status === 403) return translate(MESSAGE_KEYS.errorPermission);
    if (error.status === 429) return translate(MESSAGE_KEYS.errorRateLimit);
  }
  return fallback;
}

/** Keep safe message identity in component state, never an error body or a
 * translated snapshot. A language change then retranslates an existing error. */
export function errorKey(
  error: unknown,
  fallback: MessageKey = MESSAGE_KEYS.errorRequest,
): MessageKey {
  if (error instanceof UiError) return error.key;
  if (error instanceof ApiError) {
    if (error.status === 401) return MESSAGE_KEYS.errorSession;
    if (error.status === 403) return MESSAGE_KEYS.errorPermission;
    if (error.status === 429) return MESSAGE_KEYS.errorRateLimit;
  }
  return fallback;
}

export function useMessageError() {
  const [key, setKey] = useState<MessageKey | null>(null);
  const { t } = useTranslation();
  return [key === null ? null : t(key), setKey] as const;
}
