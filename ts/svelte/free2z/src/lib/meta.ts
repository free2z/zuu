import { env } from '$env/dynamic/public';
import type { ZPageDetail } from '$lib/api/f2z.schemas';
import {
  DEFAULT_ROBOTS,
  DEFAULT_SOCIAL_IMAGE,
  DEFAULT_SOCIAL_IMAGE_ALT,
  DEFAULT_SOCIAL_IMAGE_HEIGHT,
  DEFAULT_SOCIAL_IMAGE_WIDTH,
  CANONICAL_ORIGIN,
  SITE_NAME,
  compactText,
  escapeJsonForHtml,
  toAbsoluteUrl,
} from '$lib/seo';

const configuredCanonicalBaseUrl =
  env.PUBLIC_CANONICAL_BASE_URL?.replace(/\/$/, '') || '';
const canonicalBaseUrl = configuredCanonicalBaseUrl || CANONICAL_ORIGIN;

type MetaTag = {
  tag: 'meta';
  props: { name?: string; property?: string; content: string };
};

export interface ZPageMetaResult {
  title: string;
  canonical?: string;
  tags: MetaTag[];
  jsonLd?: Record<string, unknown>;
  jsonLdString?: string | null;
}

function buildCanonicalPath(article?: ZPageDetail | null) {
  if (!article) return null;
  const username = article.creator?.username;
  if (username && article.vanity) {
    return `/${encodeURIComponent(username)}/${encodeURIComponent(article.vanity)}`;
  }
  if (article.get_url) {
    try {
      return new URL(article.get_url, canonicalBaseUrl).pathname.replace(/^\/zpage\//, '/');
    } catch {
      return null;
    }
  }
  if (username && article.free2zaddr) {
    return `/${encodeURIComponent(username)}/${encodeURIComponent(article.free2zaddr)}`;
  }
  return null;
}

function buildCanonicalUrl(path?: string | null) {
  if (!path) return undefined;
  return toAbsoluteUrl(path, canonicalBaseUrl);
}

function buildDescription(article?: ZPageDetail | null) {
  return compactText(
    article?.description || article?.content,
    'Read this article and discover more independent creators on Free2Z.',
  );
}

function buildImage(article?: ZPageDetail | null) {
  const identifier = article?.vanity || article?.free2zaddr;
  if (!identifier) return toAbsoluteUrl(DEFAULT_SOCIAL_IMAGE, canonicalBaseUrl);
  const version = encodeURIComponent(article.updated_at || '1');
  return toAbsoluteUrl(
    `/og/zpage/${encodeURIComponent(identifier)}.png?v=${version}`,
    canonicalBaseUrl,
  );
}

function buildJsonLd(
  article: ZPageDetail | null | undefined,
  canonicalUrl: string | undefined,
  description: string,
  imageUrl: string,
) {
  if (!article?.title || !article.creator?.username || !article.created_at) return undefined;

  const authorName = article.creator.username;
  const authorUrl = `${canonicalBaseUrl}/${encodeURIComponent(authorName)}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    '@id': `${canonicalUrl}#article`,
    headline: article.title,
    description,
    image: [imageUrl],
    author: { '@type': 'Person', name: authorName, url: authorUrl },
    publisher: {
      '@type': 'Organization',
      '@id': `${canonicalBaseUrl}/#organization`,
      name: SITE_NAME,
    },
    datePublished: article.publish_at || article.created_at,
    dateModified: article.updated_at || article.created_at,
    url: canonicalUrl,
    mainEntityOfPage: canonicalUrl
      ? { '@type': 'WebPage', '@id': canonicalUrl }
      : undefined,
    keywords: article.tags?.join(', ') || undefined,
    articleSection: article.category || undefined,
    isAccessibleForFree: !article.is_subscriber_only,
  };
}

export { escapeJsonForHtml };

export function buildZPageMeta(article?: ZPageDetail | null): ZPageMetaResult {
  const title = article?.title ? `${article.title} | ${SITE_NAME}` : SITE_NAME;
  const description = buildDescription(article);
  const canonicalUrl = buildCanonicalUrl(buildCanonicalPath(article));
  const imageUrl = buildImage(article);
  const imageAlt = article?.title
    ? `Featured image for ${article.title}`
    : DEFAULT_SOCIAL_IMAGE_ALT;
  const publishedTime = article?.publish_at || article?.created_at;
  const modifiedTime = article?.updated_at || article?.created_at;

  const tags: MetaTag[] = [
    { tag: 'meta', props: { name: 'description', content: description } },
    { tag: 'meta', props: { name: 'robots', content: DEFAULT_ROBOTS } },
    { tag: 'meta', props: { property: 'og:title', content: title } },
    { tag: 'meta', props: { property: 'og:description', content: description } },
    { tag: 'meta', props: { property: 'og:url', content: canonicalUrl || canonicalBaseUrl } },
    { tag: 'meta', props: { property: 'og:image', content: imageUrl } },
    { tag: 'meta', props: { property: 'og:image:secure_url', content: imageUrl } },
    { tag: 'meta', props: { property: 'og:image:type', content: 'image/png' } },
    { tag: 'meta', props: { property: 'og:image:width', content: DEFAULT_SOCIAL_IMAGE_WIDTH.toString() } },
    { tag: 'meta', props: { property: 'og:image:height', content: DEFAULT_SOCIAL_IMAGE_HEIGHT.toString() } },
    { tag: 'meta', props: { property: 'og:image:alt', content: imageAlt } },
    { tag: 'meta', props: { property: 'og:type', content: 'article' } },
    { tag: 'meta', props: { property: 'og:site_name', content: SITE_NAME } },
    { tag: 'meta', props: { property: 'og:locale', content: 'en_US' } },
    { tag: 'meta', props: { name: 'twitter:card', content: 'summary_large_image' } },
    { tag: 'meta', props: { name: 'twitter:title', content: title } },
    { tag: 'meta', props: { name: 'twitter:description', content: description } },
    { tag: 'meta', props: { name: 'twitter:url', content: canonicalUrl || canonicalBaseUrl } },
    { tag: 'meta', props: { name: 'twitter:image', content: imageUrl } },
    { tag: 'meta', props: { name: 'twitter:image:alt', content: imageAlt } },
  ];

  if (publishedTime) {
    tags.push({ tag: 'meta', props: { property: 'article:published_time', content: publishedTime } });
  }
  if (modifiedTime) {
    tags.push({ tag: 'meta', props: { property: 'article:modified_time', content: modifiedTime } });
  }
  if (article?.creator?.username) {
    tags.push({ tag: 'meta', props: { name: 'author', content: article.creator.username } });
  }

  const jsonLd = buildJsonLd(article, canonicalUrl, description, imageUrl);
  return {
    title,
    canonical: canonicalUrl,
    tags,
    jsonLd,
    jsonLdString: jsonLd ? escapeJsonForHtml(JSON.stringify(jsonLd)) : null,
  };
}
