import { env } from '$env/dynamic/public';
import type { ZPageDetail } from '$lib/api/f2z.schemas';

const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, '') || '';
const configuredCanonicalBaseUrl =
    env.PUBLIC_CANONICAL_BASE_URL?.replace(/\/$/, '') || '';
const canonicalBaseUrl = configuredCanonicalBaseUrl || 'https://free2z.cash';

const descriptionFallback = 'Read this article on Free2Z';
const defaultImageUrl = configuredCanonicalBaseUrl ? `${configuredCanonicalBaseUrl}/logo512.png` : '/logo512.png';
const titleSuffix = 'Free2Z';

type MetaTag = {
    tag: 'meta';
    props: {
        name?: string;
        property?: string;
        content: string;
    };
};

export interface ZPageMetaResult {
    title: string;
    canonical?: string;
    tags: MetaTag[];
    jsonLd?: Record<string, unknown>;
    // pre-escaped JSON-LD string safe for direct inclusion in the DOM
    // (escaped for HTML/script contexts to prevent XSS vectors in user-provided fields)
    jsonLdString?: string | null;
}

// Characters to escape when embedding JSON inside HTML/script contexts.
// We intentionally escape <, >, &, and the unicode line/paragraph separators
// to avoid breaking out of a script block or creating XSS vectors.
export function escapeJsonForHtml(json: string) {
    return json
        .replace(/</g, '\\u003C')
        .replace(/>/g, '\\u003E')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

function buildAbsoluteApiUrl(path?: string | null) {
    if (!path) return null;
    if (/^https?:\/\//i.test(path)) return path;
    const normalized = path.startsWith('/') ? path : `/${path}`;
    if (apiBase) {
        return `${apiBase}${normalized}`;
    }
    if (configuredCanonicalBaseUrl) {
        return `${configuredCanonicalBaseUrl}${normalized}`;
    }
    return normalized;
}

function buildCanonicalPath(article?: ZPageDetail | null) {
    if (!article) return null;
    const username = article.creator?.username;
    if (username && article.vanity) {
        // Prefer vanity URL if possible
        return `/${username}/${article.vanity}`;
    }
    if (article.get_url) {
        return article.get_url;
    }
    // Fallback to ID-based URL if possible
    const slug = article.free2zaddr;
    if (username && slug) {
        return `/${username}/${slug}`;
    }
    return null;
}

function buildCanonicalUrl(path?: string | null) {
    if (!path) return undefined;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${canonicalBaseUrl}${normalizedPath}`;
}

function buildDescription(article?: ZPageDetail | null) {
    if (article?.description?.trim()) return article.description.trim();
    if (article?.content?.trim()) {
        let snippet = article.content
            .replace(/\s+/g, ' ')
            .trim();
        if (snippet.length > 200) {
            const cut = snippet.slice(0, 200);
            const lastSpace = cut.lastIndexOf(' ');
            snippet = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim() + '...';
        }
        return snippet || descriptionFallback;
    }
    return descriptionFallback;
}

function buildImage(article?: ZPageDetail | null) {
    if (!article) return defaultImageUrl;
    const imagePath =
        article.featured_image?.url || article.featured_image?.thumbnail;
    const absolute = buildAbsoluteApiUrl(imagePath) || null;
    return absolute || defaultImageUrl;
}

function buildAuthorName(article?: ZPageDetail | null) {
    if (!article) return 'Unknown Author';
    return article.creator?.username || 'Unknown Author';
}

function buildAuthorUrl(article?: ZPageDetail | null) {
    const username = article?.creator?.username;
    if (!username) return undefined;
    return `${canonicalBaseUrl}/${username}`;
}

function buildJsonLd(
    article: ZPageDetail | null | undefined,
    canonicalUrl?: string,
    description?: string,
    imageUrl?: string,
    authorName?: string
) {
    if (!article || !article.title || !authorName || !article.created_at) {
        return undefined;
    }

    const datePublished = article.publish_at || article.created_at;
    const dateModified = article.updated_at || article.created_at;
    const jsonLd: Record<string, unknown> = {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: article.title,
        description,
        image: imageUrl ? [imageUrl] : undefined,
        author: {
            '@type': 'Person',
            name: authorName,
            url: buildAuthorUrl(article),
        },
        publisher: {
            '@type': 'Organization',
            name: 'Free2Z',
            logo: {
                '@type': 'ImageObject',
                url: defaultImageUrl,
            },
        },
        datePublished,
        dateModified,
        url: canonicalUrl,
    };

    if (canonicalUrl) {
        jsonLd.mainEntityOfPage = {
            '@type': 'WebPage',
            '@id': canonicalUrl,
        };
    }

    return jsonLd;
}

export function buildZPageMeta(article?: ZPageDetail | null): ZPageMetaResult {
    const title = article?.title
        ? `${article.title} | ${titleSuffix}`
        : `${titleSuffix}`;
    const description = buildDescription(article);
    const canonicalPath = buildCanonicalPath(article);
    const canonicalUrl = buildCanonicalUrl(canonicalPath);
    const imageUrl = buildImage(article);
    const authorName = buildAuthorName(article);

    const tags: MetaTag[] = [
        { tag: 'meta', props: { name: 'description', content: description } },
        { tag: 'meta', props: { property: 'og:title', content: title } },
        { tag: 'meta', props: { property: 'og:description', content: description } },
        {
            tag: 'meta',
            props: { property: 'og:url', content: canonicalUrl || canonicalBaseUrl },
        },
        { tag: 'meta', props: { property: 'og:image', content: imageUrl } },
        { tag: 'meta', props: { property: 'og:type', content: 'article' } },
        { tag: 'meta', props: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', props: { name: 'twitter:title', content: title } },
        { tag: 'meta', props: { name: 'twitter:description', content: description } },
        { tag: 'meta', props: { name: 'twitter:image', content: imageUrl } },
    ];

    const jsonLd = buildJsonLd(article, canonicalUrl, description, imageUrl, authorName);

    // Build a pre-escaped JSON-LD string safe for embedding directly in HTML.
    // We stringify the object and then escape characters that could otherwise
    // break out of the <script> context or be interpreted as HTML entities.
    const jsonLdString = jsonLd
        ? escapeJsonForHtml(JSON.stringify(jsonLd))
        : null;

    return {
        title,
        canonical: canonicalUrl,
        tags,
        jsonLd,
        jsonLdString,
    };
}
