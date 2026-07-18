import { error, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, request, fetch, url }) => {
  const { vanity, username } = params;

  let article;
  try {
    console.log('Fetching article by vanity:', vanity);
    const cookie = request?.headers?.get('cookie');
    const apiBase = env.PRIVATE_API_BASE_URL || '';

    // Use the direct vanity endpoint to get the full article content
    const response = await fetch(
      `${apiBase}/api/zpage/${vanity}/`,
      {
        headers: cookie ? { cookie } : undefined,
      }
    );

    if (!response.ok) {
      throw error(404, { message: 'Article not found', code: 404 });
    }

    article = await response.json();

    console.log(
      'Full article loaded with content length:',
      article.content?.length || 0
    );
  } catch (err) {
    console.error('Failed to load article', err);
    throw error(404, { message: 'Article not found', code: 404 });
  }

  // Canonicalize the username segment (#567 item 3). The vanity is globally
  // unique, so /{any-username}/{vanity} resolves the same article; 301-redirect
  // to the owner's canonical URL so there is one indexable URL per article.
  // NOTE: this runs OUTSIDE the try/catch above on purpose — redirect() throws,
  // and the catch would otherwise swallow it into a 404. The compare is
  // case-insensitive so a correct-but-differently-cased username does not loop.
  // Only this new pretty [vanity] route is affected: the legacy
  // /{username}/zpage/{slug} route and the classic React UI are untouched.
  const canonicalUsername = article?.creator?.username;
  if (
    canonicalUsername &&
    canonicalUsername.toLowerCase() !== username.toLowerCase()
  ) {
    throw redirect(301, `/${canonicalUsername}/${vanity}${url.search}`);
  }

  return {
    article,
    username,
    vanity,
  };
};
