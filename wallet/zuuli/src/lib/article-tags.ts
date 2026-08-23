export const MAX_ARTICLE_TAGS = 8;
export const MAX_ARTICLE_TAG_LENGTH = 32;

const TAG_CONTROL_PATTERN = /[\p{Cc}\p{Cf}]/u;

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
  if (tag.includes(",") || TAG_CONTROL_PATTERN.test(tag)) {
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
 * Normalize untrusted tags for display/filtering without letting one legacy
 * or malformed backend value break an otherwise valid article.
 */
export function sanitizeArticleTags(values: readonly unknown[]): string[] {
  const tags: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const { tag, error } = validateArticleTag(value);
    if (tag && !error && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/** Parse an untrusted shareable filter without letting a malformed URL break the feed. */
export function parseArticleTagsParam(value: string | null): string[] {
  if (!value) return [];
  return sanitizeArticleTags(value.split(",")).slice(0, MAX_ARTICLE_TAGS);
}

export function articleTagHref(tag: string): string {
  const [normalized] = normalizeArticleTags([tag]);
  return `/articles?tags=${encodeURIComponent(normalized)}`;
}
