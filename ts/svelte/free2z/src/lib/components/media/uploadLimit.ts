/**
 * How large a file this creator may upload — asked of the SERVER, never
 * restated here.
 *
 * The ceiling is a monetization tier (`py/dj/apps/uploads/limits.py`): a rung
 * per whole-2Z threshold, biggest balance, biggest file. That table used to
 * exist twice — once in Python and once as `maxUploadBytesFor()` in
 * `$lib/api/uploads.ts` — with nothing comparing them, so raising a tier
 * server-side would have left the browser refusing files the server was happy
 * to take, silently, with every test still green. There are deliberately NO
 * byte counts and NO balance thresholds in this file.
 *
 * `GET /api/uploads/limits/` answers with the caller's own `max_bytes` plus
 * every rung of the ladder, which is what lets the UI say both "request cap X"
 * and "Y raises it to Z" without knowing what X, Y or Z are.
 *
 * ## Why the limit is fetched again on a 403
 *
 * The enforcement point cannot tell us anything. nginx runs an `auth_request`
 * against `/uploads/limit` and, on refusal, hands the browser its own
 * `@deny_upload` response: `return 403` with no body (`k8s/free2z/nginx.conf`).
 * So a 403 carries no reason, and it is not exclusively a quota refusal —
 * Django answers a failed CSRF check with a 403 too. Re-reading the
 * authoritative limit and comparing it to the file we just tried to send is
 * what separates the two, and it closes the race the client-side check cannot:
 * a balance that dropped between page load and upload.
 *
 * ## Not an authorization decision
 *
 * Everything here is advisory. The client check exists to save the creator a
 * pointless wait and to explain the tier, not to enforce it; the server
 * refuses an oversize body before proxying it either way. When the limit
 * cannot be read — the request failed, the caller is anonymous, the payload is
 * unrecognisable — this module answers "unknown" and callers must let the
 * upload proceed. Guessing a ceiling would resurrect the copied table with
 * extra steps.
 */

import type { UploadLimit, UploadSizeTier } from "../../api/f2z.schemas";

export type { UploadLimit, UploadSizeTier };

/** The disclosure endpoint. Path only; callers prefix their own API base. */
export const UPLOAD_LIMIT_PATH = "/api/uploads/limits/";

/** Injected so this module has no SvelteKit imports and tests can stub it. */
export type UploadLimitRequest = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * A payload is usable only if every number we would show or compare against is
 * actually a number. A partial one is treated as no answer at all: rendering
 * "files up to NaN" or comparing a size against `undefined` are both worse
 * than saying nothing.
 */
export function isUploadLimit(value: unknown): value is UploadLimit {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<UploadLimit>;
  if (!Number.isFinite(candidate.max_bytes)) return false;
  if (!Number.isFinite(candidate.tuzis)) return false;
  if (!Array.isArray(candidate.tiers)) return false;
  return candidate.tiers.every(
    (tier) =>
      tier &&
      typeof tier === "object" &&
      Number.isFinite(tier.min_tuzis) &&
      Number.isFinite(tier.max_bytes),
  );
}

/**
 * The cheapest rung that would let this caller upload something bigger, or
 * null when they are already on the top one.
 *
 * Derived from the ladder the server sent rather than from a threshold of our
 * own: "what raises it" is the actionable half of the message, and it is the
 * half that goes stale first when pricing changes.
 */
export function nextUploadTier(limit: UploadLimit): UploadSizeTier | null {
  let best: UploadSizeTier | null = null;
  for (const tier of limit.tiers) {
    if (tier.max_bytes <= limit.max_bytes) continue;
    // Cheapest first: among the rungs that actually raise the ceiling, the one
    // needing the smallest balance.
    if (!best || tier.min_tuzis < best.min_tuzis) best = tier;
  }
  return best;
}

/** Why a file cannot be sent, with everything a message needs to say so. */
export interface OversizeUpload {
  fileName: string;
  /** The file's own size — what the creator sees in their file manager. */
  fileBytes: number;
  /**
   * The number that actually exceeded the ceiling. Equal to `fileBytes` in the
   * ordinary case; larger when the caller knew the request size (see
   * `comparedBytes` on `checkUploadSize`).
   */
  comparedBytes: number;
  maxBytes: number;
  /** What would raise the ceiling, or null at the top of the ladder. */
  nextTier: UploadSizeTier | null;
}

/**
 * Is this over the ceiling? `null` means "send it" — including when the limit
 * is unknown, which is the whole point: an unread limit must never become a
 * refusal we invented.
 *
 * `comparedBytes` exists because the server does not compare the file. nginx's
 * `auth_request` is handed `X-Original-Content-Length`, which is the size of
 * the whole multipart request — the file PLUS the boundaries, the part
 * headers, the filename and the JSON metadata field. So a file of exactly
 * `max_bytes` is refused, and telling that creator "your session may have
 * expired" is the wrong answer twice over.
 *
 * Before the request goes out that figure is not knowable without serializing
 * the body, so the pre-flight check passes the file's own size and errs on the
 * side of sending: refusing a file the server would have taken is the worse
 * mistake. Afterwards it IS knowable — `xhr.upload`'s progress events carry
 * `total`, the exact byte count the browser is sending — and the 403 path
 * passes that, so the explanation is exact rather than approximated.
 */
export function checkUploadSize(
  file: { name?: string; size?: number },
  limit: UploadLimit | null | undefined,
  comparedBytes?: number,
): OversizeUpload | null {
  if (!limit) return null;
  const size = file?.size;
  if (!Number.isFinite(size)) return null;
  const compared = Number.isFinite(comparedBytes)
    ? Math.max(comparedBytes as number, size as number)
    : (size as number);
  if (compared <= limit.max_bytes) return null;
  return {
    fileName: file?.name ?? "",
    fileBytes: size as number,
    comparedBytes: compared,
    maxBytes: limit.max_bytes,
    nextTier: nextUploadTier(limit),
  };
}

/**
 * True when the file itself fits and only the request envelope pushed it over.
 *
 * Its own message: "your 5 MB file is over your 5 MB limit" reads as a bug,
 * and the fix ("make it a little smaller") is different from the fix for a
 * file that is genuinely too big ("hold more 2Z").
 */
export function isEnvelopeOverage(oversize: OversizeUpload): boolean {
  return oversize.fileBytes <= oversize.maxBytes;
}

const KB = 1024;

/**
 * Bytes as a person would say them.
 *
 * Rounded for display ONLY — never fed back into a comparison. The tier sizes
 * are exact binary multiples, so they land on whole units; an arbitrary file
 * gets one decimal place below 10 units so a 5.4MB file is not reported as
 * "5 MB" next to a 5 MB limit it just failed.
 */
export function formatByteLimit(bytes: number, locale = "en"): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];
  let value = Number(bytes) || 0;
  let unitIndex = 0;
  while (Math.abs(value) >= KB && unitIndex < units.length - 1) {
    value /= KB;
    unitIndex += 1;
  }
  const fractionDigits = unitIndex === 0 || Math.abs(value) >= 10 ? 0 : 1;
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units[unitIndex],
    // `short` renders raw bytes as the word "byte" ("900 byte"); `narrow` is
    // the symbol form ("900B"). Every other unit reads better with the space,
    // and both stay localized — `narrow` is "900o" in French, not "900B".
    unitDisplay: unitIndex === 0 ? "narrow" : "short",
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

/**
 * How long to wait for the limit before giving up and answering "unknown".
 *
 * Not a product boundary — a UI one. Both callers AWAIT this read on a path
 * the creator is standing in front of: dropping files blocks on it, and so
 * does explaining a 403, which in turn blocks the sequential upload queue. An
 * unbounded read means a wedged Django (or the ~200s nginx proxy timeout in
 * front of it) turns "I dropped a file" into a UI that does nothing at all,
 * with no error and no way to tell. Answering "unknown" after a few seconds
 * degrades to exactly the behaviour of a limit we never read: send it, and
 * let the server decide. (Raised by the codex review of this PR.)
 */
export const UPLOAD_LIMIT_TIMEOUT_MS = 8_000;

/** Read the caller's limit once. Resolves to null on ANY failure. */
export async function fetchUploadLimit({
  request,
  apiBase = "",
  timeoutMs = UPLOAD_LIMIT_TIMEOUT_MS,
}: {
  request: UploadLimitRequest;
  apiBase?: string;
  timeoutMs?: number;
}): Promise<UploadLimit | null> {
  // `AbortController` + `setTimeout` rather than `AbortSignal.timeout`: the
  // static is newer than this app's browser baseline (`.browserslistrc`), and
  // `eslint-plugin-compat` polices exactly that.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request(`${apiBase}${UPLOAD_LIMIT_PATH}`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json();
    return isUploadLimit(body) ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Process-wide cache. The limit changes only when the creator's balance
 * crosses a rung, so every uploader on the page shares one request rather than
 * each mounting its own.
 *
 * The in-flight promise is cached too, not just the result: the media
 * dashboard and the editor can both mount in the same tick.
 */
let cached: Promise<UploadLimit | null> | null = null;

/**
 * Cache the ANSWER, never the failure.
 *
 * A `null` means "we could not find out", and pinning that for the life of
 * the page would turn one timed-out request into an uploader that shows no
 * limit and explains no 403 until a reload — the same dead end the timeout
 * above exists to avoid.
 */
function remember(
  pending: Promise<UploadLimit | null>,
): Promise<UploadLimit | null> {
  cached = pending;
  void pending.then((limit) => {
    if (!limit && cached === pending) cached = null;
  });
  return pending;
}

export function loadUploadLimit(options: {
  request: UploadLimitRequest;
  apiBase?: string;
}): Promise<UploadLimit | null> {
  return cached ?? remember(fetchUploadLimit(options));
}

/**
 * Re-read the limit, bypassing the cache.
 *
 * Called on a 403, where a stale cache is exactly the thing that would produce
 * the wrong explanation: if the balance dropped a rung since the page loaded,
 * the cached ceiling says the file should have fit.
 */
export function refreshUploadLimit(options: {
  request: UploadLimitRequest;
  apiBase?: string;
}): Promise<UploadLimit | null> {
  return remember(fetchUploadLimit(options));
}

/**
 * Confirm a batch against a FRESH limit before refusing any of it.
 *
 * The cache has no expiry, and a client-side refusal is the one thing that can
 * make a stale cache permanent: a balance that goes UP — credits received, a
 * purchase settling, a ZEC payment crediting — raises the real ceiling, but the
 * cached one still refuses the file locally, so no request is made, so nothing
 * ever discovers the new limit. The creator's newly bought entitlement is
 * unusable until they reload the page, and there is no error to explain it
 * because the upload never happened. (Raised by the codex review of this PR;
 * the 403 path alone cannot cover it — a refusal that never leaves the browser
 * never gets a 403.)
 *
 * So: a snapshot may say "send it", but only a fresh read may say "refuse it".
 * The extra request costs one round trip on the rare path where we were about
 * to refuse anyway, and it is unconditionally cheaper than the upload it
 * replaces.
 *
 * Returns the limit it decided against — refreshed when it had to be — so the
 * caller can update whatever it is displaying.
 */
export async function confirmOversize<
  T extends { name?: string; size?: number },
>(
  files: readonly T[],
  options: {
    request: UploadLimitRequest;
    apiBase?: string;
    /** The caller's current snapshot; may be stale, may be null. */
    limit: UploadLimit | null;
  },
): Promise<{ limit: UploadLimit | null; oversize: OversizeUpload[] }> {
  const read = { request: options.request, apiBase: options.apiBase };

  // A missing snapshot means "we have not been told yet", NOT "there is no
  // limit". One 502 or one timed-out mount-time read would otherwise disable
  // the pre-flight and the standing hint for the life of the page, with only
  // a later 403 able to repair it — and a 403 only happens after the doomed
  // upload the pre-flight exists to avoid. `loadUploadLimit` returns the
  // cached answer when there is one, so this costs a request only when there
  // is genuinely nothing to go on. (Raised by the codex review of this PR.)
  const known = options.limit ?? (await loadUploadLimit(read));

  const limit = files.some((file) => checkUploadSize(file, known))
    ? await refreshUploadLimit(read)
    : known;

  const oversize = files
    .map((file) => checkUploadSize(file, limit))
    .filter((result): result is OversizeUpload => result !== null);

  return { limit, oversize };
}

/** Test seam. Not called by the app. */
export function resetUploadLimitCache(): void {
  cached = null;
}
