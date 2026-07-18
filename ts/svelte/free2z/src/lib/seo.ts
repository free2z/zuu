export const SITE_NAME = 'Free2Z';
export const CANONICAL_ORIGIN = 'https://free2z.cash';
export const SITE_DESCRIPTION =
  'A publishing platform where independent creators share stories, build communities, and earn support directly from their audience.';
export const DEFAULT_SOCIAL_IMAGE = '/brand/free2z-og.png';
export const DEFAULT_SOCIAL_IMAGE_ALT =
  'Free2Z — independent publishing, discovery, and direct creator support';
export const DEFAULT_SOCIAL_IMAGE_WIDTH = 1200;
export const DEFAULT_SOCIAL_IMAGE_HEIGHT = 630;
export const DEFAULT_ROBOTS =
  'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1';
export const NOINDEX_ROBOTS = 'noindex, nofollow, noarchive';

export type JsonLd = Record<string, unknown>;
export function buildSeoTitle(title: string) {
  return title.includes(SITE_NAME) ? title : `${title} | ${SITE_NAME}`;
}

export function compactText(
  value: string | null | undefined,
  fallback = SITE_DESCRIPTION,
  maxLength = 200,
) {
  const text = (value ?? fallback)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[#*_>`~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength - 1).trimEnd();
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 80 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function toAbsoluteUrl(value: string, origin: string) {
  if (/^https?:\/\//i.test(value)) return value;
  const path = value.startsWith('/') ? value : `/${value}`;
  return `${origin.replace(/\/$/, '')}${path}`;
}

export function canonicalPath(pathname: string) {
  const normalized = pathname.replace(/\/+$/, '');
  return normalized || '/';
}

export function escapeJsonForHtml(json: string) {
  return json
    .replace(/</g, '\\u003C')
    .replace(/>/g, '\\u003E')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function createOrganizationJsonLd(origin: string): JsonLd {
  return {
    '@type': 'Organization',
    '@id': `${origin}/#organization`,
    name: SITE_NAME,
    url: origin,
    description: SITE_DESCRIPTION,
  };
}

export function createWebsiteJsonLd(origin: string): JsonLd {
  return {
    '@type': 'WebSite',
    '@id': `${origin}/#website`,
    name: SITE_NAME,
    url: origin,
    description: SITE_DESCRIPTION,
    inLanguage: 'en',
    publisher: { '@id': `${origin}/#organization` },
    potentialAction: {
      '@type': 'SearchAction',
      target: `${origin}/search?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  };
}

export function createBreadcrumbJsonLd(
  origin: string,
  items: { name: string; path: string }[],
): JsonLd {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: toAbsoluteUrl(item.path, origin),
    })),
  };
}
