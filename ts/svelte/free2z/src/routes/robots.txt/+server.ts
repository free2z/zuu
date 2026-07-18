import { env } from '$env/dynamic/public';
import { CANONICAL_ORIGIN } from '$lib/seo';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
  const canonicalOrigin =
    env.PUBLIC_CANONICAL_BASE_URL?.replace(/\/$/, '') || CANONICAL_ORIGIN;

  return new Response(
    `User-agent: *
Allow: /
Disallow: /api/
Disallow: /edit
Disallow: /buy-2z
Disallow: /*/dashboard/
Disallow: /*/private/
Disallow: /checkout/

Sitemap: ${canonicalOrigin}/sitemap.xml
`,
    {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    },
  );
};
