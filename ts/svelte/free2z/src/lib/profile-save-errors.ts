/**
 * What the Settings page shows when `PATCH /api/auth/user/` refuses a save.
 *
 * It used to show "Failed to save settings." for every failure and never read
 * the body, while the server was answering
 * `400 {"member_price": ["Ensure this value is greater than or equal to 1."]}`
 * 32 times in 30 days, to 6 creators retrying blind. The fix is not
 * a `member_price` special case: any field the serializer rejects (`p2paddr`,
 * `full_name`, `avatar_image`, one added next year) must reach the creator,
 * named, next to its input where there is one.
 *
 * The body is read by `describeSaveFailure` (`save-errors.js`), the editor's
 * reader, which already refuses to drop a field nobody enumerated and caps
 * server prose. This adds the one thing a settings form needs that the editor
 * does not: DRF's sentences do not say WHICH field they are about ("Ensure
 * this value is greater than or equal to 1."), so the summary line prefixes
 * each with the field's label.
 */
import {
  SERVER_MESSAGE_MAX_LENGTH,
  apiRequestErrorMessage,
  describeSaveFailure,
} from "./save-errors.js";

export interface ProfileSaveFailure {
  /** Field name → the sentence to render beside that field's input. */
  fieldErrors: Record<string, string>;
  /** The one line for the page's error banner. Never empty. */
  saveError: string;
}

/**
 * Read a failed save's response. Never throws: a body that is not JSON (an
 * nginx 502 page) is simply a body with nothing to say.
 */
export async function readProfileSaveFailure(
  response: Pick<Response, "status" | "json">,
  options: {
    labels: Record<string, string>;
    curated?: Record<string, string | undefined>;
    genericMessage: string;
    summaryMessage: string;
  },
): Promise<ProfileSaveFailure> {
  let result: unknown = null;
  try {
    result = await response.json();
  } catch {
    result = null;
  }
  return describeProfileSaveFailure({
    result,
    status: response.status,
    ...options,
  });
}

export function describeProfileSaveFailure({
  result,
  status,
  labels,
  curated = {},
  genericMessage,
  summaryMessage,
}: {
  result: unknown;
  status: number;
  labels: Record<string, string>;
  curated?: Record<string, string | undefined>;
  genericMessage: string;
  summaryMessage: string;
}): ProfileSaveFailure {
  const described = describeSaveFailure({
    result,
    status,
    curated,
    genericMessage,
    summaryMessage,
  });
  const fields = Object.entries(described.fieldErrors);
  if (!described.isValidationFailure || fields.length === 0) {
    return {
      fieldErrors: described.fieldErrors,
      saveError: described.saveError,
    };
  }

  // Same capping rule as the reader it wraps: a request-level sentence past
  // the cap is a dumped object, not prose.
  const request = apiRequestErrorMessage(result);
  const sentences = [
    request.length <= SERVER_MESSAGE_MAX_LENGTH ? request : "",
    // An unlabelled field (one this page has no input for) keeps its raw
    // name: `username: A user with that username already exists!` is still
    // actionable; dropping the name is what made the old copy useless.
    ...fields.map(
      ([field, message]) => `${labels[field] || field}: ${message}`,
    ),
  ].filter(Boolean);

  return {
    fieldErrors: described.fieldErrors,
    saveError: [...new Set(sentences)].join(" "),
  };
}
