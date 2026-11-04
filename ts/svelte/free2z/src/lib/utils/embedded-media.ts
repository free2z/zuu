/**
 * The uploads a zPage body embeds, as reported by the API's `media` field
 * (`py/dj/apps/g12f/embedded_media.py`), and the two things we do with them:
 * a `poster=` attribute on the rendered `<video>`, and `VideoObject`
 * structured data.
 *
 * Both need the SAME join key, and the two sides spell the URL differently:
 * the API returns the canonical served path, while the body contains whatever
 * the author wrote (a root-relative `/uploadz/...`, an absolute
 * `https://free2z.cash/uploadz/...`, percent-encoded or not) and the renderer
 * then prefixes `PUBLIC_API_BASE_URL` — empty in production, non-empty in
 * dev. `uploadPathKey` reduces all of those to one canonical
 * `/uploadz/<name>` string so the lookup cannot miss on spelling.
 */

export type EmbeddedMediaItem = {
  embed_url: string;
  url: string;
  kind: string;
  mime_type: string;
  access: string;
  is_public: boolean;
  poster: string | null;
  title: string;
  description: string;
  uploaded_at: string;
};

const UPLOAD_PREFIX = "/uploadz/";
const PUBLIC_UPLOAD_PREFIX = "/uploadz/public/";

function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A lone `%` is legal in a filename and illegal in a URI escape; the
    // raw string is still a perfectly good key, it just has to be the same
    // raw string on both sides.
    return value;
  }
}

/**
 * Canonical `/uploadz/<name>` key for any spelling of an upload URL, or
 * `null` if the URL does not address an upload at all.
 *
 * The `public/` segment is deliberately folded away: it is derived from the
 * upload's access level (`GenericFile._get_prefix`), so the same asset can
 * legitimately be written both ways, and an access change rewrites every URL
 * for it. Keying on the storage name rather than the served
 * prefix means the map still resolves either way.
 */
export function uploadPathKey(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;

  // Root-relative: the production spelling, and the one `getApiUploadUrl`
  // produces when PUBLIC_API_BASE_URL is empty. `//host` and `/\host` are
  // NOT paths, so they must not take this branch.
  if (url.startsWith("/") && !/^\/[/\\]/.test(url)) {
    return normalizeUploadPath(url.split("?")[0].split("#")[0]);
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      // A `javascript:`/`data:` URL is not an upload and must never key
      // into the poster map.
      return null;
    }
    // Any http(s) host is accepted here on purpose: this only reduces a URL
    // to a lookup key, and the key must resolve for the dev/staging
    // PUBLIC_API_BASE_URL host as well as for free2z.cash. Nothing is
    // FETCHED from the key, and the poster it maps to comes from our own
    // API, so a foreign host that happens to serve `/uploadz/...` can at
    // worst collide with itself.
    return normalizeUploadPath(parsed.pathname);
  } catch {
    return null;
  }
}

function normalizeUploadPath(path: string): string | null {
  if (!path.startsWith(UPLOAD_PREFIX)) return null;
  const name = path.startsWith(PUBLIC_UPLOAD_PREFIX)
    ? path.slice(PUBLIC_UPLOAD_PREFIX.length)
    : path.slice(UPLOAD_PREFIX.length);
  if (!name) return null;
  return `${UPLOAD_PREFIX}${decodeOnce(name)}`;
}

function mediaItems(media: unknown): EmbeddedMediaItem[] {
  if (!Array.isArray(media)) return [];
  return media.filter(
    (item): item is EmbeddedMediaItem =>
      Boolean(item) && typeof item === "object",
  );
}

/**
 * `uploadPathKey` -> poster URL, for every embedded video that has one.
 *
 * Both spellings the API knows about are indexed (`url`, the served path,
 * and `embed_url`, what the author literally wrote) because they can differ
 * and the renderer may present either.
 */
export function buildVideoPosterMap(media: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  for (const item of mediaItems(media)) {
    if (item.kind !== "video" || !item.poster) continue;
    for (const candidate of [item.url, item.embed_url]) {
      const key = uploadPathKey(candidate);
      if (key) map[key] = item.poster;
    }
  }
  return map;
}

function absolute(url: string, base: string): string | null {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/") && !/^\/[/\\]/.test(url)) return `${base}${url}`;
  return null;
}

export type VideoObjectNode = {
  "@type": "VideoObject";
  "@id": string;
  name: string;
  description?: string;
  thumbnailUrl: string[];
  uploadDate: string;
  contentUrl: string;
};

/**
 * `VideoObject` nodes for the videos on a page, or `[]`.
 *
 * The rules are all "omit rather than invent", because  is a report of
 * missing structured data and a page that answers it with *wrong* structured
 * data is worse off than one that stays silent:
 *
 *  - **Gated video: no node at all.** `contentUrl` is a promise that the
 *    bytes are fetchable. Only `is_public` (public access AND an active
 *    owner — the exact predicate the anonymous `/uploadz/public/` tier
 *    enforces) can keep it.
 *  - **No poster: no node.** `thumbnailUrl` is REQUIRED, and the page's own
 *    OG card is not a frame of the video.
 *  - **No `uploadDate`, no absolute URL, no name: no node.**
 *
 * `name`/`description` fall back to the page's own title/description when the
 * upload carries none of its own — the honest reading of "the video
 * published on this page", and the only page-derived values here. Everything
 * else comes from the upload row.
 */
export function buildVideoObjects(
  media: unknown,
  options: {
    canonicalBaseUrl: string;
    canonicalUrl?: string;
    pageTitle?: string;
    pageDescription?: string;
  },
): VideoObjectNode[] {
  const { canonicalBaseUrl, canonicalUrl, pageTitle, pageDescription } =
    options;
  const nodes: VideoObjectNode[] = [];

  mediaItems(media).forEach((item) => {
    if (item.kind !== "video") return;
    if (!item.is_public) return;
    if (!item.poster) return;
    if (!item.uploaded_at) return;

    const contentUrl = absolute(item.url, canonicalBaseUrl);
    const thumbnailUrl = absolute(item.poster, canonicalBaseUrl);
    if (!contentUrl || !thumbnailUrl) return;

    const name = (item.title || pageTitle || "").trim();
    if (!name) return;
    const description = (item.description || pageDescription || "").trim();

    const node: VideoObjectNode = {
      "@type": "VideoObject",
      "@id": `${canonicalUrl || contentUrl}#video-${nodes.length + 1}`,
      name,
      thumbnailUrl: [thumbnailUrl],
      uploadDate: item.uploaded_at,
      contentUrl,
    };
    if (description) node.description = description;
    nodes.push(node);
  });

  return nodes;
}
