/**
 * Camera capability + capture helpers for the KYC live-photo step.
 *
 * SSR is the whole reason this file exists. `ts/svelte/free2z` is genuinely
 * server-rendered through `@sveltejs/adapter-node`, so every module in a page's
 * import graph is evaluated in Node, where `navigator` does not exist. The
 * classic React step reached straight for `react-webcam`; the equivalent here
 * would throw during render and 500 the page, not degrade.
 *
 * So: nothing in this module touches a browser global at import time. Every
 * entry point checks first and returns a value the caller can render, and the
 * page always offers the file-upload fallback — which is not just a
 * permission-denied path, it is the only path on a desktop with no camera at
 * all.
 *
 * @typedef {"unsupported"|"denied"|"notFound"|"inUse"|"insecureContext"|"unknown"} CameraProblem
 */

/**
 * Is a live camera even conceivable here?
 *
 * False during SSR, in a browser without `mediaDevices` (which includes any
 * page served over plain HTTP — `getUserMedia` is gated on a secure context),
 * and in a locked-down embedded webview. The caller renders the upload
 * fallback instead; it never renders a dead "Enable camera" button.
 *
 * @param {{navigator?: any, isSecureContext?: boolean}} [scope] injectable for tests
 */
export function cameraSupported(scope) {
  const target =
    scope ?? (typeof globalThis === "undefined" ? undefined : globalThis);
  if (!target) return false;

  const nav = target.navigator;
  if (!nav || typeof nav !== "object") return false;
  if (!nav.mediaDevices) return false;

  return typeof nav.mediaDevices.getUserMedia === "function";
}

/**
 * Classify a `getUserMedia` rejection into something we have copy for.
 *
 * The distinction matters: "you denied camera access" is fixed in browser
 * settings, "no camera found" is not fixable at all and the applicant should
 * be pushed straight at the upload fallback, and "already in use" usually
 * means a video call is running. Lumping them into one "camera error" leaves
 * the applicant with no idea which of the three they are in.
 *
 * @param {unknown} error
 * @returns {CameraProblem}
 */
export function classifyCameraError(error) {
  const name =
    error && typeof error === "object" && "name" in error
      ? String(/** @type {{name: unknown}} */ (error).name)
      : "";

  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "notFound";
    case "NotReadableError":
    case "TrackStartError":
      return "inUse";
    default:
      return "unknown";
  }
}

/**
 * i18n key for a camera problem, so the copy lives in the catalogs.
 * @param {CameraProblem} problem
 */
export function cameraProblemKey(problem) {
  return `dashboard.kyc.livePhoto.problems.${problem}`;
}

/**
 * Constraints for the live photo: the front ("user") camera at a size big
 * enough for a face to be reviewable, but capped so we are not shipping a 4K
 * frame through a single synchronous worker. `ideal`, never `exact`, so a
 * webcam that cannot do 720p still opens instead of throwing
 * OverconstrainedError.
 */
export const LIVE_PHOTO_CONSTRAINTS = {
  audio: false,
  video: {
    facingMode: "user",
    width: { ideal: 1280 },
    height: { ideal: 720 },
  },
};

/**
 * Stop every track on a stream. Safe to call with null/undefined.
 * @param {{getTracks?: () => {stop: () => void}[]}|null|undefined} stream
 */
export function stopStream(stream) {
  if (!stream || typeof stream.getTracks !== "function") return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // A track already ended by the browser throws on stop in some engines;
      // there is nothing to recover and nothing to tell the applicant.
    }
  }
}

/** JPEG quality for the captured frame — good enough to read a face, ~200KB. */
export const CAPTURE_QUALITY = 0.92;

/**
 * The filename a captured frame is stored under.
 *
 * Deliberately boring and free of anything derived from user input: the
 * server slugifies and re-extensions it anyway (`normalize_stored_name`),
 * and the stored extension is what decides the Content-Type these documents
 * are later served with.
 */
export function livePhotoFilename(now = new Date()) {
  return `live-photo-${now.toISOString().replace(/[:.]/g, "-")}.jpg`;
}

/**
 * Turn a canvas `toBlob` result into the `File` the upload expects.
 *
 * The type we set here is a *hint*; `validate_kyc_upload` sniffs the bytes
 * server-side and would reject this if the canvas somehow produced something
 * else. Never treat a client-declared MIME type as a check — that was.
 *
 * @param {Blob} blob
 * @param {string} [filename]
 */
export function blobToLivePhotoFile(blob, filename = livePhotoFilename()) {
  return new File([blob], filename, { type: "image/jpeg" });
}
