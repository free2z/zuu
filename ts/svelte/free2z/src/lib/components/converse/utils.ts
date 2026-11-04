import type { ConversePostData } from "./types";
import { zpageCanonicalPath } from "$lib/zpage-path.js";
import { formatDateTime, formatRelativeTime } from "$lib/utils/date";

const PLACEHOLDER_HEADLINES = new Set(["n/a", "re"]);
const sourceTitleRequests = new Map<string, Promise<string | null>>();

/**
 * Grapheme segmentation for title truncation. A "character" a reader would
 * count is a grapheme cluster, not a code unit and not a code point: cutting
 * `👨‍👩‍👧‍👦` by code point yields two loose people and a dangling ZWJ, and cutting
 * by code UNIT yields half a surrogate, which is U+FFFD in a browser tab.
 *
 * Built once — constructing an `Intl.Segmenter` is not cheap and this runs per
 * rendered thread. Undefined locale on purpose: grapheme boundaries are
 * defined by UAX, not by the reader's language, so a per-locale instance
 * would buy nothing and cost a cache miss.
 *
 * `Intl.Segmenter` is in every browser we target (Chrome 87, Safari 14.1,
 * Firefox 125) and in Node 16+, but this is a title, not a feature worth
 * throwing over: fall back to code points where it is missing.
 */
const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function toCharacters(value: string): string[] {
  if (!graphemeSegmenter) return Array.from(value);
  return Array.from(graphemeSegmenter.segment(value), (part) => part.segment);
}

export function getVisibleHeadline(post: ConversePostData): string {
  const headline = post.headline?.trim() || "";
  return PLACEHOLDER_HEADLINES.has(headline.toLowerCase()) ? "" : headline;
}

/**
 * The best short name for a post: its headline if it has a usable one,
 * otherwise the opening of its body.
 *
 * The composer no longer asks for a title  — a microblog post is a
 * body and nothing else — so `headline` is empty on everything written from
 * now on, while historic rows still carry real ones. Every place that needs a
 * *name* rather than a *body* (the browser tab, `og:title`) used to fall back
 * to the literal word "Conversation", which is the same string for every
 * untitled post on the platform: identical tabs, identical share cards,
 * nothing for a search engine to tell two threads apart.
 *
 * This mirrors what the backend already does for the RSS `<title>` and the
 * social card (`Comment.social_description`, `py/dj/apps/comments/models.py`)
 * so a post is named the same way wherever it is named.
 *
 * Returns "" when there is nothing to derive from; the caller supplies the
 * generic fallback.
 */
export function deriveConverseTitle(
  post: Pick<ConversePostData, "headline" | "content"> | null | undefined,
  maxChars = 60,
): string {
  if (!post) return "";

  const headline = getVisibleHeadline(post as ConversePostData);
  if (headline) return headline;

  const firstLine =
    (post.content || "")
      .split("\n")
      // Markdown leaders carry no meaning in a plain-text title: `# `, `> `,
      // `- `, `* `, `1. `. Strip them rather than shipping "## gm".
      .map((line) => line.replace(/^\s*(?:[#>*-]+|\d+\.)\s*/, "").trim())
      .find((line) => line.length > 0) || "";
  const normalized = firstLine.replace(/\s+/g, " ").trim();

  // Count and cut in GRAPHEMES, not UTF-16 code units: `String#slice` at an
  // arbitrary index splits an emoji apart, and half a surrogate renders as
  // U+FFFD in the browser tab and in `og:title`. A microblog's first line is
  // exactly where emoji live.
  const characters = toCharacters(normalized);
  if (characters.length <= maxChars) return normalized;

  // Truncate on a word boundary when there is one worth using, so a title
  // does not end mid-word.
  const head = characters.slice(0, maxChars);
  const lastSpace = head.lastIndexOf(" ");
  const stem = (lastSpace > maxChars * 0.6 ? head.slice(0, lastSpace) : head)
    .join("")
    .replace(/[\s,;:.!?-]+$/, "");
  return `${stem}…`;
}

export function getSourceUrl(post: ConversePostData): string | null {
  if (!post.content_url) return null;
  const normalized = post.content_url.replace(
    /^\/([^/?#]+)\/zpage\/([^/?#]+)(?=\/?(?:[?#]|$))/,
    "/$1/$2",
  );
  return `${normalized.replace(/#.*$/, "")}#comment-${post.uuid}`;
}

export function getSourceIdentifier(post: ConversePostData): string | null {
  if (!post.content_url) return null;

  try {
    const pathname = new URL(post.content_url, "https://free2z.local").pathname;
    const segments = pathname.split("/").filter(Boolean);
    const zpageIndex = segments.indexOf("zpage");
    // Accept the permanent legacy redirect shape during rolling deploys, but
    // prefer the canonical /<creator>/<identifier> value emitted after.
    // A collision-safe canonical uses /article/<immutable-address>; it remains
    // a zPage source even though `article` is (correctly) not a creator root.
    let prettyIdentifier: string | null = null;
    if (segments.length === 2) {
      const username = decodeURIComponent(segments[0]);
      const candidate = decodeURIComponent(segments[1]);
      const canonicalPath = zpageCanonicalPath({
        creator: { username },
        vanity: candidate,
        free2zaddr: candidate,
      });
      if (canonicalPath === pathname.replace(/\/$/, "")) {
        prettyIdentifier = candidate;
      }
    }
    const identifier =
      segments.length === 2 && segments[0].toLowerCase() === "article"
        ? segments[1]
        : zpageIndex >= 0
          ? segments[zpageIndex + 1]
          : prettyIdentifier;
    return identifier ? decodeURIComponent(identifier) : null;
  } catch {
    return null;
  }
}

export function resolveSourceTitle(
  identifier: string,
  apiBase: string,
): Promise<string | null> {
  const key = `${apiBase}:${identifier}`;
  const cached = sourceTitleRequests.get(key);
  if (cached) return cached;

  const request = fetch(
    `${apiBase}/api/zpage/${encodeURIComponent(identifier)}/`,
  )
    .then(async (response) => {
      if (!response.ok) return null;
      const zpage: { title?: string } = await response.json();
      return zpage.title?.trim() || null;
    })
    .catch(() => null);

  sourceTitleRequests.set(key, request);
  return request;
}

export function getAvatarUrl(
  post: ConversePostData,
  apiBase: string,
): string | undefined {
  const avatar =
    post.author.avatar_image?.thumbnail || post.author.avatar_image?.url;
  if (!avatar) return undefined;
  if (avatar.startsWith("http")) return avatar;
  return `${apiBase}${avatar.startsWith("/") ? "" : "/"}${avatar}`;
}

const POST_DATE_TIME: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

export function formatPostDate(value: string, locale: string): string {
  return formatDateTime(value, locale, POST_DATE_TIME);
}

export function formatRelativePostDate(value: string, locale: string): string {
  return formatRelativeTime(value, locale, {
    absoluteAfterSeconds: 7 * 86400,
    absoluteOptions: POST_DATE_TIME,
  });
}
