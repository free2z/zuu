/**
 * Client-side upload hints for the KYC steps.
 *
 * READ THIS BEFORE CHANGING ANYTHING HERE: none of this is a security control.
 * The `accept` attributes and the size pre-flight exist so an applicant gets
 * an instant "that's a.docx" instead of a round trip, and so the file picker
 * shows sensible files. The actual decision is made server-side by
 * `dj/apps/kyc/validation.py`, which **sniffs the bytes** — a client-declared
 * MIME type is attacker-chosen and checking it is no check at all.
 *
 * Keep these lists a mirror of the server allowlist, and keep them an
 * ALLOWLIST. If the two drift, the failure mode is a confusing rejection after
 * upload, not a hole — but a confusing rejection in an identity-verification
 * flow is its own kind of harm.
 */

/** `MAX_FILE_SIZE` in `dj/apps/kyc/views.py`. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_LABEL = "10MB";

/**
 * `IDENTITY_PHOTO_TYPES` in `dj/apps/kyc/validation.py`.
 * HEIC is here because it is what an unmodified iPhone produces. The
 * `-sequence` spellings  are the HEIF/AVIF image-sequence types; the
 * server normalizes all of them to `image/heic` / `image/avif`, so they are
 * one more spelling of an already-accepted type, not a wider set.
 */
export const IDENTITY_PHOTO_ACCEPT =
  "image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif," +
  "image/heic-sequence,image/heif-sequence,image/avif,image/avif-sequence";

/** `SUPPORTING_DOCUMENT_TYPES` — the photo types plus PDF. */
export const SUPPORTING_DOCUMENT_ACCEPT = `${IDENTITY_PHOTO_ACCEPT},application/pdf`;

/** `TAX_FORM_TYPES` — the blank forms we hand out are IRS PDFs. */
export const TAX_FORM_ACCEPT = "application/pdf";

/**
 * Pre-flight a chosen file. Returns an i18n key when the file is obviously
 * wrong, or null to let the server have the final say.
 *
 * Extension-based, not `file.type`-based, on purpose: `file.type` is whatever
 * the OS guessed and is empty for plenty of legitimate files (notably HEIC on
 * some Android builds), so rejecting on it would block real applicants. An
 * extension we do not recognize is passed through to the server, which sniffs
 * it properly.
 *
 * Each result carries its own English fallback so a call site can pass the
 * whole thing to `$t(key, fallback, params)` — a missing catalog entry then
 * renders a sentence rather than the raw dotted key, which in an
 * identity-verification flow is the difference between an error and a puzzle.
 *
 * @param {{name?: string, size?: number}} file
 * @param {readonly string[]} allowedExtensions
 * @returns {{key: string, fallback: string, params?: Record<string, string|number>}|null}
 */
export function preflightUpload(file, allowedExtensions) {
  if (!file) {
    return {
      key: "dashboard.kyc.errors.noFileChosen",
      fallback: "Choose a file first.",
    };
  }

  if (typeof file.size === "number" && file.size > MAX_UPLOAD_BYTES) {
    return {
      key: "dashboard.kyc.errors.fileTooLarge",
      fallback:
        "That file is larger than {limit}. Please upload a smaller one.",
      params: { limit: MAX_UPLOAD_LABEL },
    };
  }

  const name = typeof file.name === "string" ? file.name : "";
  const dot = name.lastIndexOf(".");
  const extension = dot === -1 ? "" : name.slice(dot).toLowerCase();

  // No extension at all: let the server sniff it. Being strict here would
  // reject files that are perfectly valid.
  if (!extension) return null;

  if (!allowedExtensions.includes(extension)) {
    return {
      key: "dashboard.kyc.errors.unsupportedFileType",
      fallback: "That file type is not accepted here. Accepted: {types}.",
      params: { types: allowedExtensions.join(", ") },
    };
  }

  return null;
}

/** Extensions matching `KYC_IMAGE_EXTENSIONS` on the server. */
export const IDENTITY_PHOTO_EXTENSIONS = Object.freeze([
  ".jpg",
  ".jpeg",
  ".jpe",
  ".png",
  ".gif",
  ".webp",
  ".heic",
  ".heif",
  // HEIF/AVIF image sequences. Rare, but this list is a *gate* on the
  // client — `preflightUpload` rejects an extension it does not recognize —
  // so leaving them out here would reproduce the exact rejection the server
  // fix removed, one layer up.
  ".heics",
  ".heifs",
  ".avif",
  ".avifs",
]);

/** Extensions matching `KYC_DOCUMENT_EXTENSIONS`. */
export const SUPPORTING_DOCUMENT_EXTENSIONS = Object.freeze([
  ...IDENTITY_PHOTO_EXTENSIONS,
  ".pdf",
]);

/** Extensions matching `KYC_TAX_FORM_EXTENSIONS`. */
export const TAX_FORM_EXTENSIONS = Object.freeze([".pdf"]);

/**
 * Pull a human-usable message out of a KYC error body.
 *
 * The API answers `{"error":...}` for a rejected file and `{"message":...}`
 * for "your application is no longer editable" — see `KYCIdentityError` in the
 * generated schema. A client that reads only one of them shows a blank error
 * for the other, which is how an applicant ends up staring at a form that
 * silently refuses to save.
 *
 * @param {unknown} body
 * @returns {string} empty when there is nothing quotable
 */
export function readErrorDetail(body) {
  if (!body || typeof body !== "object") return "";
  const candidate =
    /** @type {{error?: unknown, message?: unknown, detail?: unknown}} */ (
      body
    );
  for (const value of [candidate.error, candidate.message, candidate.detail]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
