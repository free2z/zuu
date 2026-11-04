/**
 * The server's own reason for a failed request, as one sentence.
 *
 * Every non-2xx through the orval mutator used to become
 * `ApiError("HTTP error! status: 400")`, and the call sites that toast
 * `error.message` — donate among them — showed exactly that, while the body
 * said precisely what was wrong (`{"error": "Insufficient 2Z balance"}`,
 * `{"old_password": ["Incorrect password."]}`). Users retried blind; it is the
 * mechanism that hid  behind 32 identical failed saves.
 *
 * {@link serverErrorMessage} reads the shapes this API actually returns, in
 * this order: `detail` (DRF permission/throttle/`APIException`), `error` (the
 * tuzis/ztripe views), `message`, `non_field_errors`, then the first field
 * error in serializer order. The field walk reuses `save-errors.js` so the
 * editor and everything else read DRF the same way.
 *
 * Plain JS with relative imports: `tests/api-errors.test.mjs` imports it
 * straight into node.
 */

import {
  SERVER_MESSAGE_MAX_LENGTH,
  apiFieldErrors,
  flattenApiErrorMessage,
} from "../save-errors.js";

/** Request-level keys, in the order a sentence is looked for. */
const REQUEST_LEVEL_KEYS = ["detail", "error", "message", "non_field_errors"];

/** Keys that are request-level rather than a field, for the field walk. */
const NOT_FIELDS = new Set(REQUEST_LEVEL_KEYS.concat(["code", "status"]));

/**
 * `old_password` -> `Old password`.
 *
 * @param {string} field
 */
function humanizeField(field) {
  const words = field.replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : field;
}

/**
 * A DRF message that does not say which field it is about ("This field is
 * required.", "Ensure this value has at most 32 characters.") needs the
 * field's name in front of it to mean anything in a toast.
 *
 * @param {string} message
 */
function needsFieldName(message) {
  return /\bthis (field|value)\b/i.test(message);
}

/**
 * @param {string} message
 * @returns {string}
 */
function presentable(message) {
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > SERVER_MESSAGE_MAX_LENGTH) return "";
  // A proxy's HTML error page is not a sentence.
  if (/^<(!doctype|html|\?xml)/i.test(trimmed)) return "";
  return trimmed;
}

/**
 * Every field the server rejected, `{field: sentence}`, in body order.
 *
 * @param {unknown} body parsed JSON body
 * @returns {Record<string, string>}
 */
export function serverFieldErrors(body) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!body || typeof body !== "object" || Array.isArray(body)) return out;
  const fieldsOnly = Object.fromEntries(
    Object.entries(body).filter(([key]) => !NOT_FIELDS.has(key)),
  );
  for (const { field, message } of apiFieldErrors(fieldsOnly)) {
    const usable = presentable(message);
    if (usable) out[field] = usable;
  }
  return out;
}

/**
 * The best one-sentence reason in a parsed error body, or `""`.
 *
 * `""` means "the server gave no usable reason" — the caller supplies its own
 * copy. It never invents one: an unparseable body, an HTML error page, a
 * dumped object longer than {@link SERVER_MESSAGE_MAX_LENGTH} and an empty
 * field list all return `""`.
 *
 * @param {unknown} body parsed JSON body (a bare JSON string counts: the zPage
 *   create endpoint answers its "need 1 2Z" refusal with one)
 * @returns {string}
 */
export function serverErrorMessage(body) {
  if (typeof body === "string" || Array.isArray(body)) {
    return presentable(flattenApiErrorMessage(body));
  }
  if (!body || typeof body !== "object") return "";

  const record = /** @type {Record<string, unknown>} */ (body);
  for (const key of REQUEST_LEVEL_KEYS) {
    const message = presentable(flattenApiErrorMessage(record[key]));
    if (message) return message;
  }

  for (const [field, message] of Object.entries(serverFieldErrors(body))) {
    return needsFieldName(message)
      ? `${humanizeField(field)}: ${message}`
      : message;
  }
  return "";
}

/**
 * The fallback when the server gave no reason. Deliberately not the old
 * "HTTP error! status: N": it is a sentence, and it keeps the status for
 * whoever reads the bug report.
 *
 * @param {number} status
 */
export function genericHttpErrorMessage(status) {
  return `The request failed (HTTP ${status}). Please try again.`;
}

/**
 * Read a failed `Response` once and describe it.
 *
 * For `apiFetch` callers, which get a raw `Response` rather than an
 * `ApiError`. Never throws: a body that cannot be read or parsed yields
 * `message: ""` and `data: null`, and the caller's own copy is shown.
 *
 * @param {Response} response
 * @returns {Promise<{
 *   status: number,
 *   message: string,
 *   fieldErrors: Record<string, string>,
 *   data: unknown,
 * }>}
 */
export async function readApiError(response) {
  let data = null;
  try {
    const text = await response.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  } catch {
    data = null;
  }
  return {
    status: response.status,
    message: serverErrorMessage(data),
    fieldErrors: serverFieldErrors(data),
    data,
  };
}
