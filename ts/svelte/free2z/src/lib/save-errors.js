/**
 * Reading a DRF validation body without silently dropping the fields nobody
 * remembered to enumerate.
 *
 * The editor used to hard-code three keys — `vanity`, `title`,
 * `canonical_url` — and let every other rejected field fall through to
 * "Failed to save article". That is a bug factory rather than a single bug:
 * `publish_at` inherited it the day scheduling shipped, and so would
 * `p2paddr`, `tags`, `source_language` and whatever the serializer grows next.
 * The creator sees an autosave that fails forever, with no field named and no
 * action to take, while the server was in fact saying exactly what was wrong.
 *
 * So the enumeration is inverted: read whatever the body actually contains,
 * use the product's own copy for the fields we have written copy for, and fall
 * back to the server's own sentence for the rest. An unmapped field now costs
 * a slightly less polished message, never a lost one.
 */

/**
 * Keys a DRF error body uses for the request as a whole rather than a field.
 * `detail` is what permission and throttle failures return; `non_field_errors`
 * is `serializers.ValidationError("…")` raised without a field.
 */
const REQUEST_LEVEL_KEYS = new Set(["detail", "non_field_errors"]);

/**
 * How long a server-authored sentence may be before the editor stops treating
 * it as prose fit for a toast. Passing an unbounded server string to the UI is
 * the price of not enumerating fields; capping it is the price of that price.
 * Real DRF messages are one short sentence — anything past this is a dumped
 * object, a stack fragment or a proxy's HTML-in-JSON, and the generic copy is
 * a better thing to show than a wall of it.
 */
export const SERVER_MESSAGE_MAX_LENGTH = 200;

/**
 * Statuses whose body is the API explaining a refusal, field by field.
 *
 * 400 is DRF's `ValidationError`. 409 is this API's deliberate second refusal
 * shape — the translation routes answer a stale editor with
 * `{"source_language": "Reload the editor before saving a translation for
 * this legacy article."}` and nothing retries a 409, so a body ignored here is
 * a creator stuck with no stated remedy. Every other status is a failure the
 * body does not get to describe as a form error.
 */
const REFUSAL_STATUSES = new Set([400, 409]);

/**
 * The first human sentence inside one DRF error value.
 *
 * DRF is not consistent about the shape: a field error is `["message"]`, a
 * `detail` is a bare string, a nested serializer is an object of the same,
 * and `ErrorDetail` instances serialize to strings. Anything else (a number,
 * null, an empty list) is not a message and must not be treated as one — the
 * old `result.title` truthiness check happily reported `{"title": []}` as an
 * error the user could never find.
 *
 * @param {unknown} value
 * @returns {string} the message, or `""` when the value carries none
 */
export function flattenApiErrorMessage(value) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const message = flattenApiErrorMessage(entry);
      if (message) return message;
    }
    return "";
  }

  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      const message = flattenApiErrorMessage(entry);
      if (message) return message;
    }
    return "";
  }

  return "";
}

/**
 * Every field the API rejected, in body order, one sentence each.
 *
 * Body order matters: it is the serializer's field order, so the first entry
 * is the most natural thing to put in front of the creator when several
 * fields failed at once.
 *
 * @param {unknown} result parsed JSON body of a failed save
 * @returns {{field: string, message: string}[]}
 */
export function apiFieldErrors(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return [];
  }

  return Object.entries(result)
    .filter(([field]) => !REQUEST_LEVEL_KEYS.has(field))
    .map(([field, value]) => ({
      field,
      message: flattenApiErrorMessage(value),
    }))
    .filter(({ message }) => Boolean(message));
}

/**
 * A server sentence short enough to put in front of a person, or `""`.
 *
 * @param {string} message
 * @returns {string}
 */
function usableServerMessage(message) {
  return message.length <= SERVER_MESSAGE_MAX_LENGTH ? message : "";
}

/**
 * The request-level message, when the body carries one instead of a field map.
 *
 * A bare JSON string is one of those shapes, not a malformed body: until
 *  the create endpoint answered the "you need at least 1 2Z for a second
 * page" refusal with a bare-string 400, which the editor used to replace with
 * "Failed to save article". It is a `402 insufficient_funds` with a `detail`
 * now, and the editor renders it as such; a bare string from an older backend
 * or another endpoint still reads here.
 *
 * @param {unknown} result
 * @returns {string} the message, or `""`
 */
export function apiRequestErrorMessage(result) {
  if (typeof result === "string" || Array.isArray(result)) {
    return flattenApiErrorMessage(result);
  }

  if (!result || typeof result !== "object") {
    return "";
  }

  for (const key of REQUEST_LEVEL_KEYS) {
    const message = flattenApiErrorMessage(
      /** @type {Record<string, unknown>} */ (result)[key],
    );
    if (message) return message;
  }

  return "";
}

/**
 * Does this payload carry the schedule the backend refuses?
 *
 * `zPageUpdateSerializer.validate` rejects `publish_at <= now()` on a page
 * that is not published, and that is the whole rule — so the client can tell
 * the "your schedule went past due" case apart from every other reason
 * `publish_at` might be rejected (a malformed datetime, a rule added later)
 * without pattern-matching English against the server's sentence.
 *
 * Evaluated against the payload that was actually sent, not the editor's live
 * state: a publish or a schedule change made while the request was in flight
 * must not relabel the response to the request before it.
 *
 * @param {{is_published?: boolean, publish_at?: string | null}} payload
 * @param {number} [now] epoch ms, for tests
 * @returns {boolean}
 */
export function isScheduleInThePast(payload, now = Date.now()) {
  if (!payload || payload.is_published || !payload.publish_at) {
    return false;
  }

  const scheduled = new Date(payload.publish_at).getTime();
  return Number.isFinite(scheduled) && scheduled <= now;
}

/**
 * Turn a failed save's body into what the editor renders: a message per field,
 * and the one sentence that goes in the save notice and the toast.
 *
 * `curated` is how the product keeps its voice for the failures it has
 * written copy for ("Choose a different vanity URL."). A field absent from it
 * keeps the server's sentence — less polished, still actionable, and above all
 * still *shown*.
 *
 * `extra` carries field errors the client decided on its own, so they merge
 * with the server's rather than being clobbered by an assignment: the
 * canonical-URL autosave fallback strips the field and retries, so the second
 * response cannot mention it even though it is what failed.
 *
 * `saveError` spells out every reason. `summaryMessage` survives only for the
 * case where nothing renderable came back at all: pointing a creator at
 * "validation errors" they cannot see is the failure this module exists to
 * end, and the per-field text lives inside a publish sheet that is closed
 * almost all the time.
 *
 * `status` gates all of it: only a refusal the API chose to explain
 * (`REFUSAL_STATUSES`) gets its body read as form errors. The editor does not
 * only talk to DRF — an ingress, a service worker or an unhandled exception
 * can return whatever JSON it likes, and `503 {"error": "upstream
 * unavailable"}` must read as an outage worth retrying rather than as a
 * rejected field named `error` that no form has.
 *
 * @param {{
 *   result: unknown,
 *   status: number,
 *   curated?: Record<string, string | undefined>,
 *   extra?: Record<string, string | undefined>,
 *   genericMessage: string,
 *   summaryMessage: string,
 * }} options
 * @returns {{
 *   fieldErrors: Record<string, string>,
 *   saveError: string,
 *   isValidationFailure: boolean,
 * }}
 */
export function describeSaveFailure({
  result,
  status,
  curated = {},
  extra = {},
  genericMessage,
  summaryMessage,
}) {
  if (!REFUSAL_STATUSES.has(status)) {
    return {
      fieldErrors: {},
      saveError:
        usableServerMessage(apiRequestErrorMessage(result)) || genericMessage,
      isValidationFailure: false,
    };
  }

  /** @type {{field: string, message: string}[]} */
  const problems = [];
  /** @type {Record<string, string>} */
  const fieldErrors = {};
  /** A field the API rejected whose message is not fit to render. */
  let hasUnpresentableFailure = false;
  const seen = new Set();

  const record = (
    /** @type {string} */ field,
    /** @type {string} */ message,
  ) => {
    if (seen.has(field)) return;
    seen.add(field);

    if (!message) {
      hasUnpresentableFailure = true;
      return;
    }

    fieldErrors[field] = message;
    problems.push({ field, message });
  };

  for (const { field, message } of apiFieldErrors(result)) {
    record(field, curated[field] || usableServerMessage(message));
  }

  for (const [field, message] of Object.entries(extra)) {
    if (message) record(field, message);
  }

  // A request-level reason is a second refusal, not a substitute for the
  // field ones — dropping it because some field also failed leaves the
  // creator fixing the field and hitting the same wall again.
  const rawRequestMessage = apiRequestErrorMessage(result);
  const sentences = [
    ...new Set([
      usableServerMessage(rawRequestMessage),
      ...problems.map(({ message }) => message),
    ]),
  ].filter(Boolean);

  if (sentences.length === 0) {
    // Nothing renderable came back — but the status already settled what this
    // is. A refusal is never a transport failure, and reporting one as
    // "The server could not be reached." sends the creator to retry a save
    // that will be refused identically forever.
    return {
      fieldErrors,
      saveError:
        hasUnpresentableFailure || rawRequestMessage
          ? summaryMessage
          : genericMessage,
      isValidationFailure: true,
    };
  }

  // Every reason, spelled out — never "Please fix the validation errors."
  //
  // An earlier draft summarized whenever each rejected field had an inline
  // message beside its input. That test is a lie about *visibility*: `vanity`,
  // `canonical_url` and `publish_at` are rendered inside a publish sheet that
  // is closed almost all the time, so "some component can show it" and "the
  // creator can see it" are different claims. Two publish-sheet fields failing
  // at once would have reproduced  exactly — a save that never succeeds
  // and a notice that names nothing. The messages are short and the notice is
  // a paragraph; there is no reason to make the creator hunt.
  return {
    fieldErrors,
    saveError: sentences.join(" "),
    isValidationFailure: true,
  };
}

/**
 * Block reasons whose server-authored sentence beats the generic copy.
 *
 * `validation` is a 400 the serializer explained field by field; `conflict` is
 * the 412 the `If-Match` precondition returns. Both mean "the server
 * was reached, understood the request, refused it, and said exactly why" — so
 * substituting the reason's one-line label throws away the only actionable
 * thing the creator was told.
 */
export const SAVE_ERROR_REASONS = new Set(["validation", "conflict"]);

/**
 * Which sentence the persistent "Not saved yet — …" notice carries.
 *
 * Mapping the field error is only half of: the message has to land
 * somewhere the creator will actually see it. An autosave shows no toast by
 * design, the topbar chip has room for a label rather than a sentence, and the
 * per-field text sits inside a publish sheet that is closed — so this notice
 * is the only always-visible surface a failed autosave ever reaches. Leaving
 * it on "Some fields still need fixing." reproduces the original bug one layer
 * up: true, unactionable, and identical whether the offending input is on
 * screen or hidden behind the sheet.
 *
 * Only the validation and conflict cases are overridden. "The server could not
 * be reached." and the other blocked-save reasons already describe a situation
 * that no field message improves on.
 *
 * `conflict` is a 412 from the `If-Match` precondition, and it belongs
 * here for the same reason `validation` does: the server sent one specific,
 * actionable sentence ("someone else saved this; your changes are still here;
 * reload") and the generic copy for the reason is a strictly worse version of
 * it. The autosave that hits this shows no toast of its own, so this notice is
 * the surface the creator actually reads.
 *
 * @param {string | null} blockReason
 * @param {string | null} saveError the sentence `describeSaveFailure` produced
 * @param {string | null} blockMessage the generic copy for `blockReason`
 * @returns {string | null}
 */
export function saveNoticeReason(blockReason, saveError, blockMessage) {
  if (blockReason && SAVE_ERROR_REASONS.has(blockReason) && saveError) {
    return saveError;
  }

  return blockMessage;
}
