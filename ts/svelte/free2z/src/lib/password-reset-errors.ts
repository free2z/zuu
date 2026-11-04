/**
 * What the reset-password page tells a reader when
 * `POST /api/emails/do-reset-password` refuses.
 *
 * The page used to pick between two FALLBACK strings and hand both to the
 * same i18n key, `auth.passwordReset.errors.expired`. `translate()` returns
 * a key's catalog entry whenever one exists, and that one exists in every
 * locale, so every failure — a weak password, a mistyped authenticator
 * code, a rate limit — read "the link may have expired, request a new one".
 * For the fixable cases the link was still good and the next link failed
 * the same way: a loop of reset emails that could never succeed, on the one
 * recovery path most accounts have.
 *
 * So: classify the refusal from the server's own reason (its `code`, or for
 * a backend that predates the code, its `message` and status), give each
 * reason its own catalog key, and say what to do next. Only a
 * link the server called expired or invalid is ever described as such.
 *
 * Pure — no `$lib` imports — so the node suite can drive it with the real
 * catalogs. The page passes `$t` in.
 */

export type ResetTranslate = (
  key: string,
  fallback: string,
  params?: Record<string, string | number>,
) => string;

export type ResetFailureReason =
  | "token_expired"
  | "token_invalid"
  | "invalid_otp"
  | "otp_attempts_exhausted"
  | "password_invalid"
  | "throttled"
  | "unavailable"
  | "reset_but_not_signed_in"
  | "missing_fields"
  | "unknown";

export interface ResetFailure {
  reason: ResetFailureReason;
  message: string;
}

export interface ResetFailureInput {
  status: number;
  /** The parsed JSON body, or null when there was none / it wasn't JSON. */
  body: unknown;
  /** The `Retry-After` header, when the refusal is a rate limit. */
  retryAfter?: string | null;
  /** The minimum the page enforces; Django's MinimumLengthValidator agrees. */
  minLength: number;
}

const SERVER_CODES: ReadonlySet<string> = new Set([
  "token_expired",
  "token_invalid",
  "invalid_otp",
  "otp_attempts_exhausted",
  "password_invalid",
  "unavailable",
  "reset_but_not_signed_in",
  "missing_fields",
]);

// The English sentences a backend without `code` sends. Keep until every
// backend that can answer this page emits `code`; a rollout where the new UI
// reaches a pod still on the old image must not regress to "expired".
const LEGACY_MESSAGES: Readonly<Record<string, ResetFailureReason>> = {
  "Token has expired.": "token_expired",
  "Invalid token.": "token_invalid",
  "Too many password reset attempts. Start again.": "otp_attempts_exhausted",
  "Password reset is temporarily unavailable.": "unavailable",
  "Token and new password are required.": "missing_fields",
};
const LEGACY_INVALID_OTP = "Invalid OTP token.";
const LEGACY_SIGN_IN_FAILED = "Password reset failed.";

interface PasswordError {
  code: string;
  message: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * `str(ValidationError)` on the old backend: a Python list repr such as
 * `['This password is too common.', "It's too short."]`. Recover the
 * sentences rather than show brackets and quotes.
 */
function sentencesFromPythonList(message: string): string[] {
  if (!(message.startsWith("[") && message.endsWith("]"))) return [];
  return [...message.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)]
    .map((match) => (match[1] ?? match[2] ?? "").replace(/\\(.)/g, "$1"))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function passwordErrors(body: Record<string, unknown> | null): PasswordError[] {
  const raw = body?.password_errors;
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => record(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .map((entry) => ({
        code: text(entry.code),
        message: text(entry.message),
      }))
      .filter((entry) => entry.code || entry.message);
  }
  const message = text(body?.message);
  const legacy = sentencesFromPythonList(message);
  if (legacy.length) return legacy.map((m) => ({ code: "", message: m }));
  return message ? [{ code: "", message }] : [];
}

export function classifyResetFailure(
  status: number,
  body: unknown,
): ResetFailureReason {
  const data = record(body);
  const code = text(data?.code);
  if (SERVER_CODES.has(code)) return code as ResetFailureReason;

  const message = text(data?.message);
  if (message === LEGACY_INVALID_OTP) {
    // The old backend sent the same sentence for the last allowed wrong
    // code, with a 429: that attempt spent the link's MFA budget.
    return status === 429 ? "otp_attempts_exhausted" : "invalid_otp";
  }
  if (message && LEGACY_MESSAGES[message]) return LEGACY_MESSAGES[message];
  if (status === 500 && message === LEGACY_SIGN_IN_FAILED) {
    return "reset_but_not_signed_in";
  }
  // DRF's own throttle answers `{detail: "Request was throttled..."}`.
  if (status === 429) return "throttled";
  if (status === 503) return "unavailable";
  // Any other 400 carrying a sentence is `validate_password` on a backend
  // that predates `code` — the only remaining 400 that sends free text.
  if (status === 400 && message) return "password_invalid";
  return "unknown";
}

function retryAfterSeconds(value: string | null | undefined): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  const delta = Math.ceil((at - Date.now()) / 1000);
  return delta > 0 ? delta : null;
}

function describePasswordError(
  error: PasswordError,
  t: ResetTranslate,
  minLength: number,
): string {
  switch (error.code) {
    case "password_too_common":
      return t(
        "auth.passwordReset.errors.passwordTooCommon",
        "This password is too common.",
      );
    case "password_entirely_numeric":
      return t(
        "auth.passwordReset.errors.passwordEntirelyNumeric",
        "This password is entirely numeric.",
      );
    case "password_too_similar":
      return t(
        "auth.passwordReset.errors.passwordTooSimilar",
        "This password is too similar to your username or email address.",
      );
    case "password_too_short":
      return t(
        "auth.passwordReset.errors.passwordTooShort",
        "This password is too short. It must contain at least {count} characters.",
        { count: minLength },
      );
    default:
      // A validator this page has no copy for: the server's own sentence is
      // still the true reason, even if it is in English.
      return error.message;
  }
}

export function describeResetPasswordFailure(
  input: ResetFailureInput,
  t: ResetTranslate,
): ResetFailure {
  const reason = classifyResetFailure(input.status, input.body);
  const data = record(input.body);

  switch (reason) {
    case "token_expired":
      return {
        reason,
        message: t(
          "auth.passwordReset.errors.expired",
          "This reset link has expired. Request a new password reset email.",
        ),
      };
    case "token_invalid":
      return {
        reason,
        message: t(
          "auth.passwordReset.errors.invalidToken",
          "This reset link is invalid or has already been used. Request a new password reset email.",
        ),
      };
    case "invalid_otp":
      return {
        reason,
        message: t(
          "auth.passwordReset.errors.invalidOtp",
          "That authenticator code wasn't accepted. Enter the current code from your authenticator app and try again.",
        ),
      };
    case "otp_attempts_exhausted":
      return {
        reason,
        message: t(
          "auth.passwordReset.errors.otpAttemptsExhausted",
          "Too many incorrect authenticator codes for this link. Request a new password reset email to try again.",
        ),
      };
    case "password_invalid": {
      const reasons = passwordErrors(data)
        .map((error) => describePasswordError(error, t, input.minLength))
        .filter(Boolean)
        .join(" ");
      return {
        reason,
        message: reasons
          ? t(
              "auth.passwordReset.errors.passwordRejected",
              "{reasons} Choose a different password and try again.",
              { reasons },
            )
          : t(
              "auth.passwordReset.errors.passwordRejectedGeneric",
              "That password isn't allowed. Choose a different password and try again.",
            ),
      };
    }
    case "throttled": {
      const seconds = retryAfterSeconds(input.retryAfter);
      return {
        reason,
        message:
          seconds !== null
            ? t(
                "auth.passwordReset.errors.throttled",
                "Too many attempts. Wait {seconds} seconds and try again — your reset link still works.",
                { seconds },
              )
            : t(
                "auth.passwordReset.errors.throttledNoWait",
                "Too many attempts. Wait a few minutes and try again — your reset link still works.",
              ),
      };
    }
    case "unavailable":
      return {
        reason,
        message: t(
          "auth.passwordReset.errors.unavailable",
          "Password reset is temporarily unavailable. Try again in a few minutes — your reset link still works.",
        ),
      };
    case "reset_but_not_signed_in":
      return {
        reason,
        message: t(
          "auth.passwordReset.errors.resetButNotSignedIn",
          "Your password was changed, but we couldn't sign you in. Log in with your new password.",
        ),
      };
    case "missing_fields":
      return {
        reason,
        message: t(
          "auth.passwordReset.errors.missingFields",
          "Enter a new password and try again.",
        ),
      };
    default:
      return {
        reason: "unknown",
        message: t(
          "auth.passwordReset.errors.generic",
          "Something went wrong resetting your password. Please try again.",
        ),
      };
  }
}
