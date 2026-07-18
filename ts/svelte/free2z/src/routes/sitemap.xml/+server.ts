import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { CANONICAL_ORIGIN } from '$lib/seo';
import type { RequestHandler } from './$types';

type SitemapEntry = { path: string; lastmod?: string | null; priority: string; changefreq: string };

const canonicalOrigin =
  publicEnv.PUBLIC_CANONICAL_BASE_URL?.replace(/\/$/, '') || CANONICAL_ORIGIN;

const staticEntries: SitemapEntry[] = [
  { path: '/', priority: '1.0', changefreq: 'daily' },
  { path: '/creators', priority: '0.8', changefreq: 'daily' },
];

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function isoDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

async function loadDynamicEntries(fetch: typeof globalThis.fetch): Promise<SitemapEntry[]> {
  const apiBase = env.PRIVATE_API_BASE_URL?.replace(/\/$/, '') || '';
  if (!apiBase) return [];

  try {
    const apiOrigin = new URL(apiBase).origin;
    const fetchAll = async (initialUrl: string) => {
      const results: unknown[] = [];
      let next: string | null = initialUrl;
      let pageCount = 0;
      const allowedPathname = new URL(initialUrl).pathname;

      while (next && pageCount < 100) {
        const nextUrl = new URL(next, apiBase);
        if (nextUrl.origin !== apiOrigin || nextUrl.pathname !== allowedPathname) break;
        const response: Response = await fetch(nextUrl);
        if (!response.ok) break;
        const payload: { results?: unknown[]; next?: unknown } = await response.json();
        results.push(...(Array.isArray(payload.results) ? payload.results : []));
        next = typeof payload.next === 'string' ? payload.next : null;
        pageCount += 1;
      }

      return results;
    };

    const [zpages, creators] = await Promise.all([
      fetchAll(`${apiBase}/api/zpage/?page=1&page_size=100&ordering=-updated_at&is_published=true`),
      fetchAll(`${apiBase}/api/creator/?page=1&page_size=100`),
    ]);

    return [
      ...creators
        .filter((value): value is { username: string } =>
          typeof value === 'object' && value !== null && 'username' in value && typeof value.username === 'string',
        )
        .map((creator) => ({
          path: `/${encodeURIComponent(creator.username)}`,
          priority: '0.7',
          changefreq: 'weekly',
        })),
      ...zpages
        .filter((value): value is {
          creator: { username: string };
          vanity?: string;
          free2zaddr?: string;
          updated_at?: string;
          is_published?: boolean;
        } =>
          typeof value === 'object' && value !== null &&
          'creator' in value && typeof value.creator === 'object' && value.creator !== null &&
          'username' in value.creator && typeof value.creator.username === 'string' &&
          (!('is_published' in value) || value.is_published !== false) &&
          (('vanity' in value && typeof value.vanity === 'string' && Boolean(value.vanity)) ||
            ('free2zaddr' in value && typeof value.free2zaddr === 'string' && Boolean(value.free2zaddr))),
        )
        .map((article) => ({
          path: `/${encodeURIComponent(article.creator.username)}/${encodeURIComponent(article.vanity || article.free2zaddr || '')}`,
          lastmod: article.updated_at,
          priority: '0.8',
          changefreq: 'weekly',
        })),
    ];
  } catch (cause) {
    console.error('Unable to build dynamic sitemap entries.', cause);
    return [];
  }
}

export const GET: RequestHandler = async ({ fetch }) => {
  const entries = [...staticEntries, ...(await loadDynamicEntries(fetch))];
  const uniqueEntries = [...new Map(entries.map((entry) => [entry.path, entry])).values()];
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${uniqueEntries.map((entry) => {
    const lastmod = isoDate(entry.lastmod);
    return `  <url>
    <loc>${escapeXml(`${canonicalOrigin}${entry.path}`)}</loc>
${lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : ''}    <changefreq>${entry.changefreq}</changefreq>
    <priority>${entry.priority}</priority>
  </url>`;
  }).join('\n')}
</urlset>
`;

  return new Response(body, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
};
