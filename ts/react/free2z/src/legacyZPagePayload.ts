import type { PageInterface } from "./components/PageRenderer";

const languageResponseFields = [
  "source_language",
  "requested_language",
  "actual_language",
  "fallback_used",
  "available_languages",
  "variant_is_published",
] as const;

export function buildLegacyZPagePayload(
  page: PageInterface,
  featuredImageId?: number | null
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...page,
    tags: page.tags.map((tag) => tag.name),
    featured_image: featuredImageId || null,
    publish_at: page.publish_at?.toISOString() || null,
  };

  languageResponseFields.forEach((field) => delete payload[field]);

  return payload;
}
