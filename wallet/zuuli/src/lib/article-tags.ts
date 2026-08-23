export const MAX_ARTICLE_TAGS = 8;
export const MAX_ARTICLE_TAG_LENGTH = 32;
export const MAX_STORED_ARTICLE_TAG_LENGTH = 100;

const AUTHORING_TAG_CONTROL_PATTERN = /[\p{Cc}\p{Cf}]/u;
const STORED_TAG_CONTROL_PATTERN = /\p{Cc}/u;

export interface ArticleTagValidation {
  tag: string | null;
  error: string | null;
}

/**
 * Canonicalize one user-entered topic.
 *
 * free2z tags are an open vocabulary, so punctuation, spaces, emoji, and
 * non-Latin scripts are all meaningful (`c++`, `privacy & policy`, `零知识`).
 * Commas remain reserved for the backend's multi-tag query parameter, and
 * invisible control/format characters are never useful topic content.
 */
export function validateArticleTag(raw: string): ArticleTagValidation {
  const tag = raw
    .normalize("NFKC")
    .trim()
    .replace(/^#+/, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");

  if (!tag) return { tag: null, error: "Enter a tag first." };
  if (Array.from(tag).length > MAX_ARTICLE_TAG_LENGTH) {
    return {
      tag: null,
      error: `Tags must be ${MAX_ARTICLE_TAG_LENGTH} characters or fewer.`,
    };
  }
  if (tag.includes(",") || AUTHORING_TAG_CONTROL_PATTERN.test(tag)) {
    return {
      tag: null,
      error: "Tags cannot contain commas or invisible control characters.",
    };
  }
  return { tag, error: null };
}

/** Validate, normalize, deduplicate, and bound a publish payload. */
export function normalizeArticleTags(values: string[]): string[] {
  const tags: string[] = [];
  for (const value of values) {
    const result = validateArticleTag(value);
    if (!result.tag || result.error) {
      throw new Error(result.error ?? "Invalid article tag.");
    }
    if (!tags.includes(result.tag)) tags.push(result.tag);
  }
  if (tags.length > MAX_ARTICLE_TAGS) {
    throw new Error(`Articles can have at most ${MAX_ARTICLE_TAGS} tags.`);
  }
  return tags;
}

/**
 * Preserve server-owned tags for display/filtering without applying this
 * client's stricter authoring policy to already-published data.
 *
 * Django-taggit's stored vocabulary permits 100 characters. Format code
 * points are meaningful in emoji and bidirectional scripts, so only empty,
 * over-server-limit, or actual control-character values are discarded here.
 */
export function sanitizeArticleTags(values: readonly unknown[]): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const tag = value.trim();
    if (
      !tag ||
      Array.from(tag).length > MAX_STORED_ARTICLE_TAG_LENGTH ||
      STORED_TAG_CONTROL_PATTERN.test(tag)
    ) {
      continue;
    }
    const comparisonKey = tag.toLocaleLowerCase("en-US");
    if (!seen.has(comparisonKey)) {
      seen.add(comparisonKey);
      tags.push(tag);
    }
  }
  return tags;
}

/** Parse an untrusted shareable filter without letting a malformed URL break the feed. */
export function parseArticleTagsParam(value: string | null): string[] {
  if (!value) return [];
  return sanitizeArticleTags(value.split(",")).slice(0, MAX_ARTICLE_TAGS);
}

/** The backend's comma-delimited filter has no escaping for comma-bearing tags. */
export function isArticleTagFilterable(tag: string): boolean {
  const [stored] = sanitizeArticleTags([tag]);
  return Boolean(stored && !stored.includes(","));
}

export function articleTagHref(tag: string): string | null {
  const [stored] = sanitizeArticleTags([tag]);
  if (!stored || !isArticleTagFilterable(stored)) return null;
  return `/articles?tags=${encodeURIComponent(stored)}`;
}
