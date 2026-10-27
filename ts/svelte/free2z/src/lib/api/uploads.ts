import { apiFetch, ensureCSRFToken } from "$lib/api/config";
import {
  UploadRequestError,
  preflightUpload,
  sendUploadRequest,
} from "$lib/components/media/uploadRequest";

export interface PublicUploadResult {
  id: number;
  url: string;
  thumbnail?: string | null;
  mime_type?: string;
  name?: string;
  title?: string;
}

/**
 * Upload a file straight to the `public` tier.
 *
 * The hardcoded `access` is the slot rule, not laziness: this is what every
 * editor upload path uses — the cropped cover, an inline paste, a drag onto
 * the writing area — and both of those slots need at least `public` reach.
 * A cover especially: `_redact_content` leaves `featured_image` in the
 * anonymous response of even a subscribers-only page, so a non-public cover
 * is broken by construction. See `$lib/components/media/mediaAccess.ts`.
 *
 * Uploads made from the media dashboard go through `/uploads/handle` instead
 * and carry the tier the creator picked; they default to `private`.
 */
export async function uploadPublicFile(
  file: File,
  title: string,
  options: {
    /**
     * The caller already gated a whole batch on ONE authoritative read (the
     * inline pipeline does, to avoid a per-file fan-out of limit reads), so
     * doing it again per file would only add requests.
     */
    limitChecked?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<PublicUploadResult> {
  // Refuse locally, naming the limit, before a byte goes up.
  if (!options.limitChecked) {
    await preflightUpload(file, { request: apiFetch });
  }

  const formData = new FormData();
  formData.append("file", file);
  formData.append("title", title.slice(0, 128));
  formData.append("access", "public");

  const csrfToken = await ensureCSRFToken();

  // XHR with a stall bound rather than `fetch`: when nginx answered 500
  // mid-body during, `fetch` never settled and every caller spun
  // forever. See `$lib/components/media/uploadRequest.ts`.
  const response = await sendUploadRequest({
    url: "/uploads/single-public",
    body: formData,
    file,
    headers: csrfToken ? { "X-CSRFToken": csrfToken } : {},
    signal: options.signal,
  });

  try {
    return JSON.parse(response.responseText) as PublicUploadResult;
  } catch {
    throw new UploadRequestError(
      "Unreadable upload response",
      response.status,
      {
        kind: "http",
        fileName: file.name,
        fileBytes: file.size,
      },
    );
  }
}

/**
 * `UploadRequestError` and `isUploadRejection` live with the transport now —
 * every upload path (this one, Settings, the media uploader) throws the same
 * error, carrying the status, the kind of failure, and the file's name and
 * size. Re-exported so existing imports keep working.
 */
export {
  UploadRequestError,
  isUploadRejection,
  explainUploadRejection,
  uploadErrorMessage,
} from "$lib/components/media/uploadRequest";

/*
 * The upload SIZE limit used to live here, as `maxUploadBytesFor(tuzis)` — a
 * hand-copy of the tier table in `py/dj/apps/uploads/limits.py` with nothing
 * comparing the two. It moved to `$lib/components/media/uploadLimit.ts`, which
 * asks the server (`GET /api/uploads/limits/`) instead of restating the
 * numbers. Do not reintroduce a copy here: a client that knows the ceiling
 * only by having memorised it goes wrong silently the day the ceiling moves.
 */
