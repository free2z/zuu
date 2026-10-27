/**
 * What the media dashboard is allowed to hand to `/uploads/handle`.
 *
 * Why this file exists
 * --------------------
 * `MediaUploader.svelte` used to carry its own literal set — `jpeg, png, gif,
 * webp, mp4` — and reject everything else in the browser *before any request
 * was made*. The server had accepted ~15 types since, PDF among them, so
 * a creator dropping a PDF into their own document manager got
 * "not a supported image or MP4 video" and the backend never even saw it
 *. Two hand-maintained allowlists that disagree is the entire
 * bug, so this module does not maintain a second one.
 *
 * The derivation chain, every link of which CI already enforces
 * ------------------------------------------------------------
 *   py/dj/apps/uploads/validation.py  ALLOWED_TYPE_EXTENSIONS   (source of truth)
 *     -> uploads/models.py            MIME_TYPE_CHOICES         (a comprehension over it)
 *     -> f2z.yaml                     MimeTypeEnum              (`backend` job fails on drift)
 *     -> src/lib/api/f2z.schemas.ts   MimeTypeEnum              (`api-client` job fails on drift)
 *     -> here
 *
 * So adding a type to the Python allowlist and *not* regenerating is already a
 * red build; regenerating widens this list automatically. There is nothing left
 * to hand-edit and therefore nothing left to drift.
 *
 * The two small tables below (aliases, neutral types) have no OpenAPI
 * representation — they describe how a *browser* spells a `Content-Type`, not
 * anything the API returns — so they are copies. They are pinned by
 * `tests/media-upload-types.test.mjs`, which parses `validation.py` and fails
 * the build the moment either side changes. Copy where we must, contract-test
 * what we copy.
 *
 * Policy note: this gate is deliberately *looser* than the server's. Its only
 * job is to spare the user a doomed upload; a false reject breaks the product
 * (that is ) while a false accept costs one wasted request and a clear
 * 400. So anything the server might plausibly accept gets through, and the
 * server — which sniffs the actual bytes, the one thing a client cannot do —
 * makes the real decision.
 */
import { MimeTypeEnum } from "$lib/api/f2z.schemas";

/** Canonical types the server accepts, straight from the generated schema. */
export const SUPPORTED_UPLOAD_MIME_TYPES: readonly string[] =
  Object.values(MimeTypeEnum);

const SUPPORTED = new Set<string>(SUPPORTED_UPLOAD_MIME_TYPES);

/**
 * Mirror of `validation.DECLARED_TYPE_ALIASES`. A browser spells the same
 * format several ways (`audio/mp3` for an MP3, `image/heif` for an iPhone
 * photo); the server normalizes them, so rejecting them here would resurrect
 * the bug in miniature.
 */
export const DECLARED_TYPE_ALIASES: Readonly<Record<string, string>> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-png": "image/png",
  "image/heif": "image/heic",
  "image/x-heic": "image/heic",
  "image/x-heif": "image/heic",
  "image/heic-sequence": "image/heic",
  "image/heif-sequence": "image/heic",
  "image/avif-sequence": "image/avif",
  "video/x-m4v": "video/mp4",
  "video/x-quicktime": "video/quicktime",
  "audio/mp3": "audio/mpeg",
  "audio/x-mpeg": "audio/mpeg",
  "audio/mpeg3": "audio/mpeg",
  "audio/x-mpeg-3": "audio/mpeg",
  "audio/x-m4a": "audio/mp4",
  "audio/mp4a-latm": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/opus": "audio/ogg",
  "application/x-pdf": "application/pdf",
  "application/acrobat": "application/pdf",
};

/**
 * Mirror of `validation.NEUTRAL_DECLARED_TYPES`. A browser that cannot
 * identify a file makes no claim — and the empty string is the common one,
 * because Chrome on Windows reports `""` for `.heic`. The server sniffs the
 * bytes in that case, so the client must not pre-empt it.
 */
export const NEUTRAL_DECLARED_TYPES: ReadonlySet<string> = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/unknown",
  "application/force-download",
]);

/** `image/JPEG; charset=x` -> `image/jpeg`. */
export const normalizeDeclaredType = (type?: string | null): string =>
  (type || "").split(";", 1)[0].trim().toLowerCase();

/**
 * Would the server plausibly take this? Everything else — `text/html`,
 * `image/svg+xml`, `application/zip` — is a certain 400, so we say so
 * immediately instead of uploading it first.
 */
export const isSupportedUploadType = (type?: string | null): boolean => {
  const normalized = normalizeDeclaredType(type);
  if (NEUTRAL_DECLARED_TYPES.has(normalized)) return true;
  return SUPPORTED.has(DECLARED_TYPE_ALIASES[normalized] || normalized);
};

export const isSupportedUploadFile = (file: { type?: string }): boolean =>
  isSupportedUploadType(file?.type);

/**
 * Families whose picker hint is widened to `<family>/*`. `accept` is matched
 * by the OS against ITS OWN extension->MIME table, and that table disagrees
 * with ours often enough to matter: `.heif` is `image/heif` on Linux/Android
 * but `image/heic` to us, `.opus` is `audio/opus` but `audio/ogg` to us, and
 * on Windows a `.heic` maps to nothing at all. A canonical-types-only
 * `accept` therefore HIDES files the server would accept — the same class of
 * false rejection as  itself, just moved into the file picker where it
 * is even quieter.
 *
 * Widening only these three: they are where the extension tables disagree,
 * and their contents are passive media either way. `application/*` is
 * deliberately NOT widened — it would mean "any file" — so `application/pdf`
 * stays listed exactly.
 */
const WIDENED_FAMILIES = new Set(["image", "video", "audio"]);

/**
 * The `accept=` attribute for the file input, derived from the same list.
 * A picker hint, never the gate: `isSupportedUploadType` still runs on
 * whatever comes back, and the server still sniffs the bytes.
 */
export const UPLOAD_ACCEPT_ATTRIBUTE = [
  ...new Set(
    SUPPORTED_UPLOAD_MIME_TYPES.map((type) => {
      const family = type.split("/")[0];
      return WIDENED_FAMILIES.has(family) ? `${family}/*` : type;
    }),
  ),
].join(",");

export type MediaKind = "image" | "video" | "audio" | "document";

/**
 * How the manager should render a stored file. `document` is everything with
 * no visual thumbnail — today that is PDF — and it is a first-class card, not
 * a failed image.
 */
export const mediaKind = (
  mimeType?: string | null,
  name?: string | null,
): MediaKind => {
  const type = normalizeDeclaredType(mimeType);
  const canonical = DECLARED_TYPE_ALIASES[type] || type;
  if (canonical.startsWith("image/")) return "image";
  if (canonical.startsWith("video/")) return "video";
  if (canonical.startsWith("audio/")) return "audio";
  if (canonical) return "document";

  // No `mime_type` at all (legacy rows predate the column being populated):
  // fall back to the extension of the stored name rather than assuming image
  // and rendering a broken <img>.
  const ext = fileExtension(name);
  if (
    [
      "jpg",
      "jpeg",
      "jpe",
      "png",
      "gif",
      "webp",
      "heic",
      "heif",
      "avif",
    ].includes(ext)
  )
    return "image";
  if (["mp4", "m4v", "webm", "mov", "qt"].includes(ext)) return "video";
  if (["mp3", "m4a", "m4b", "ogg", "oga", "opus", "wav"].includes(ext))
    return "audio";
  return "document";
};

/** Lowercase extension without the dot, query string and fragment stripped. */
export const fileExtension = (name?: string | null): string => {
  const path = (name || "").split(/[?#]/, 1)[0];
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

/**
 * The short badge a document card shows in place of a thumbnail: `PDF`.
 * Falls back to the type's subtype so an unlabelled row still says something.
 */
export const documentLabel = (
  mimeType?: string | null,
  name?: string | null,
): string => {
  const ext = fileExtension(name);
  if (ext) return ext.slice(0, 5).toUpperCase();
  const type = normalizeDeclaredType(mimeType);
  const subtype = type.split("/")[1] || "";
  return (subtype.replace(/^x-/, "").slice(0, 5) || "FILE").toUpperCase();
};
